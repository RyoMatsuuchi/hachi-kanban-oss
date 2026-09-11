import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeCommunicationDeliveryRequest, TaskRow } from "@hachi/core";
import {
  CLAUDE_CROSS_SESSION_INBOUND_CAPABILITY,
  CLAUDE_RELAY_RECEIPT_SCHEMA,
  ClaudeCrossSessionWorkerAdapter,
  computeClaudeCrossSessionCapabilityHash,
  createClaudeRelayEnvelope,
  buildClaudeRelayPrompt,
  parseClaudeAgentsJson,
  parseClaudeRelayReceipt,
  verifyClaudeRelayExecutionEvidence,
  type ClaudeCrossSessionCommandRunner,
  type ClaudeCrossSessionSpawnRequest,
  type ClaudeCrossSessionSpawnResult,
  type ClaudeRelaySourcePrincipal,
} from "./claude-cross-session.js";
import {
  captureClaudeStopHookInput,
  claudeTranscriptHookPaths,
} from "./claude-transcript-hook.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ORCHESTRATOR_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_REF = "claude-agent-ref-1";
const RUNTIME_VERSION = "2.1.226";
const CAPABILITY_HASH = computeClaudeCrossSessionCapabilityHash(RUNTIME_VERSION);

function fakeTask(): TaskRow {
  return {
    id: "t_claude_native",
    title: "Claude native worker",
    body: "",
    status: "ready",
    priority: 0,
    tenant: "dev",
    assignee: "",
    provider: "claude",
    profile: "implement",
    modelOverride: "",
    effortOverride: "",
    speedOverride: "",
    reviewProfileOverride: "",
    reviewProviderOverride: "",
    reviewModelOverride: "",
    reviewEffortOverride: "",
    reviewSpeedOverride: "",
    blockReason: "",
    claimLock: "",
    watched: false,
    consecutiveFailures: 0,
    lastFailureError: "",
    lastHeartbeatAt: null,
    maxRetries: 3,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
  };
}

function agentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([{
    sessionId: SESSION_ID,
    name: "hachi-worker",
    agentRef: AGENT_REF,
    status: "working",
    state: "working",
    runtimeVersion: RUNTIME_VERSION,
    capabilities: [CLAUDE_CROSS_SESSION_INBOUND_CAPABILITY],
    capabilityHash: CAPABILITY_HASH,
    ...overrides,
  }]);
}

function realAgentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([{
    id: AGENT_REF,
    cwd: "/tmp/claude-worker",
    kind: "background",
    startedAt: "2026-08-18T10:00:00.000Z",
    sessionId: SESSION_ID,
    name: "hachi-worker",
    state: "working",
    ...overrides,
  }]);
}

function fakeRunner(rawAgents = agentJson()): ClaudeCrossSessionCommandRunner {
  return async (_executable, args) => {
    if (args.length === 1 && args[0] === "--version") {
      return { exitCode: 0, stdout: `Claude Code ${RUNTIME_VERSION}\n`, stderr: "" };
    }
    if (args[0] === "agents" && args[1] === "--json" && args[2] === "--all") {
      return { exitCode: 0, stdout: rawAgents, stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected command" };
  };
}

function fakeSpawner(calls: ClaudeCrossSessionSpawnRequest[]): (request: ClaudeCrossSessionSpawnRequest) => Promise<ClaudeCrossSessionSpawnResult> {
  return async (request) => {
    calls.push(request);
    return { pid: 4321 };
  };
}

function relaySource(): ClaudeRelaySourcePrincipal {
  return {
    orchestratorId: "orchestrator-1",
    orchestratorSessionId: ORCHESTRATOR_SESSION_ID,
    orchestratorGeneration: 3,
    providerSessionId: ORCHESTRATOR_SESSION_ID,
  };
}

function createProviderTranscriptRoot(root: string): string {
  const path = join(root, "provider-transcripts");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

describe("Claude cross-session public CLI helpers", () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it("agents JSON は exact session/ref を正規化し、duplicate name/ref は拒否する", () => {
    const parsed = parseClaudeAgentsJson(agentJson());
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]).toMatchObject({ sessionId: SESSION_ID, agentRef: AGENT_REF, inboundAccepted: true });

    expect(() => parseClaudeAgentsJson(JSON.stringify([
      JSON.parse(agentJson())[0],
      { ...JSON.parse(agentJson())[0], sessionId: "33333333-3333-4333-8333-333333333333" },
    ]))).toThrow(/duplicate agent name/);
    expect(() => parseClaudeAgentsJson(JSON.stringify([
      JSON.parse(agentJson())[0],
      { ...JSON.parse(agentJson())[0], sessionId: "33333333-3333-4333-8333-333333333333", name: "other" },
    ]))).toThrow(/duplicate agent ref/);
    expect(() => parseClaudeAgentsJson(agentJson({ agentRef: SESSION_ID })))
      .toThrow(/sessionId の代用/);
  });

  it("実機の agents --json --all 形状（id/sessionId/name/state）を status から正規化する", () => {
    const parsed = parseClaudeAgentsJson(realAgentJson());
    expect(parsed.agents[0]).toMatchObject({
      sessionId: SESSION_ID,
      agentRef: AGENT_REF,
      status: "working",
      state: "working",
      inboundAccepted: null,
    });
  });

  it("missing crossSessionInbound runtime evidence は missing のままとし、明示refusalと区別する", () => {
    const parsed = parseClaudeAgentsJson(agentJson({ capabilities: undefined }));
    expect(parsed.agents[0]?.inboundAccepted).toBeNull();
    expect(parseClaudeAgentsJson(agentJson({ capabilities: undefined, crossSessionInbound: "deny" })).agents[0]?.inboundAccepted)
      .toBe(false);
    expect(() => parseClaudeAgentsJson(agentJson({ agentRef: undefined }))).toThrow(/exact agentRef/);
  });

  it("non-bare --bg worker を process-local settings で起動し SessionRef.nativeCommunication に exact binding を格納する", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-claude-cross-session-"));
    const calls: ClaudeCrossSessionSpawnRequest[] = [];
    const adapter = new ClaudeCrossSessionWorkerAdapter({
      stateDir: join(tempRoot, "state"),
      providerTranscriptRoot: createProviderTranscriptRoot(tempRoot),
      commandRunner: fakeRunner(realAgentJson()),
      spawner: fakeSpawner(calls),
      sessionIdFactory: () => SESSION_ID,
      nameFactory: () => "hachi-worker",
      clock: { nowSeconds: () => 100, sleep: async () => {} },
    });

    const ref = await adapter.launch(fakeTask(), {
      model: "claude-opus-5",
      cwd: tempRoot,
      promptText: "wait for Hachi relay",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain("--bg");
    expect(calls[0]?.args).toContain("--session-id");
    expect(calls[0]?.args).toContain(SESSION_ID);
    expect(calls[0]?.args).not.toContain("--bare");
    const settingsIndex = calls[0]?.args.indexOf("--settings") ?? -1;
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(JSON.parse(calls[0]?.args[settingsIndex + 1] ?? "{}"))
      .toMatchObject({ crossSessionInbound: "accept", hooks: { Stop: expect.any(Array), StopFailure: expect.any(Array) } });
    expect(ref.nativeCommunication).toMatchObject({
      route: "claude-cross-session",
      providerSessionId: SESSION_ID,
      agentRef: AGENT_REF,
      runtimeVersion: RUNTIME_VERSION,
      capabilityHash: CAPABILITY_HASH,
      observedAt: 100,
      expiresAt: 3700,
    });
  });

  it("version drift と explicit inbound refusal は launch を fail-closed にする", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-claude-cross-session-"));
    const calls: ClaudeCrossSessionSpawnRequest[] = [];
    const oldRunner: ClaudeCrossSessionCommandRunner = async (_executable, args) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "Claude Code 2.1.225\n", stderr: "" };
      return { exitCode: 0, stdout: agentJson(), stderr: "" };
    };
    const oldAdapter = new ClaudeCrossSessionWorkerAdapter({
      stateDir: join(tempRoot, "old-state"),
      providerTranscriptRoot: createProviderTranscriptRoot(tempRoot),
      commandRunner: oldRunner,
      spawner: fakeSpawner(calls),
      sessionIdFactory: () => SESSION_ID,
    });
    await expect(oldAdapter.launch(fakeTask(), { model: "claude-opus-5", cwd: tempRoot, promptText: "x" }))
      .rejects.toThrow(/最低要件未満/);

    const refusedAdapter = new ClaudeCrossSessionWorkerAdapter({
      stateDir: join(tempRoot, "refused-state"),
      providerTranscriptRoot: createProviderTranscriptRoot(tempRoot),
      commandRunner: fakeRunner(agentJson({ capabilities: undefined, capabilityHash: undefined, crossSessionInbound: "deny" })),
      spawner: fakeSpawner(calls),
      sessionIdFactory: () => SESSION_ID,
      nameFactory: () => "hachi-worker",
      discoveryTimeoutMs: 0,
    });
    await expect(refusedAdapter.launch(fakeTask(), { model: "claude-opus-5", cwd: tempRoot, promptText: "x" }))
      .rejects.toThrow(/configured launch settings/);
  });

  it("detached --bg 後の discovery failure は exact spawned worker を回収してから throw する", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-claude-cross-session-"));
    const calls: ClaudeCrossSessionSpawnRequest[] = [];
    const stopped: number[] = [];
    const adapter = new ClaudeCrossSessionWorkerAdapter({
      stateDir: join(tempRoot, "state"),
      providerTranscriptRoot: createProviderTranscriptRoot(tempRoot),
      commandRunner: fakeRunner(JSON.stringify([])),
      spawner: fakeSpawner(calls),
      stopSpawnedWorker: async (pid) => { stopped.push(pid); },
      sessionIdFactory: () => SESSION_ID,
      nameFactory: () => "hachi-worker",
      discoveryTimeoutMs: 0,
      clock: { nowSeconds: () => 100, sleep: async () => {} },
    });

    await expect(adapter.launch(fakeTask(), { model: "claude-opus-5", cwd: tempRoot, promptText: "x" }))
      .rejects.toThrow(/exact target/);
    expect(calls).toHaveLength(1);
    expect(stopped).toEqual([4321]);
  });

  it("provider transcript root が無い場合は external spawn 前に fail-closed する", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-claude-cross-session-"));
    const calls: ClaudeCrossSessionSpawnRequest[] = [];
    const adapter = new ClaudeCrossSessionWorkerAdapter({
      stateDir: join(tempRoot, "state"),
      commandRunner: fakeRunner(),
      spawner: fakeSpawner(calls),
      sessionIdFactory: () => SESSION_ID,
      nameFactory: () => "hachi-worker",
    });

    await expect(adapter.launch(fakeTask(), { model: "claude-opus-5", cwd: tempRoot, promptText: "x" }))
      .rejects.toThrow(/external spawn 前/);
    expect(calls).toHaveLength(0);
  });

  it("status/transcript/stop はowned Stop hookと公開面の限界を隠さない", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-claude-cross-session-"));
    const adapter = new ClaudeCrossSessionWorkerAdapter({
      stateDir: join(tempRoot, "state"),
      providerTranscriptRoot: createProviderTranscriptRoot(tempRoot),
      commandRunner: fakeRunner(),
      spawner: fakeSpawner([]),
      sessionIdFactory: () => SESSION_ID,
      nameFactory: () => "hachi-worker",
      clock: { nowSeconds: () => 100, sleep: async () => {} },
    });
    const ref = await adapter.launch(fakeTask(), { model: "claude-opus-5", cwd: tempRoot, promptText: "x" });
    await expect(adapter.status(ref)).resolves.toMatchObject({ state: "active" });
    await expect(adapter.fetchTranscript(ref)).rejects.toThrow(/未取得/);
    const providerTranscript = join(createProviderTranscriptRoot(tempRoot), "provider-transcript.jsonl");
    writeFileSync(providerTranscript, "captured transcript", "utf8");
    chmodSync(providerTranscript, 0o600);
    captureClaudeStopHookInput(claudeTranscriptHookPaths(
      join(tempRoot, "state"),
      SESSION_ID,
      createProviderTranscriptRoot(tempRoot),
    ), {
      session_id: SESSION_ID,
      transcript_path: providerTranscript,
      hook_event_name: "Stop",
      last_assistant_message: "done",
    }, 101);
    await expect(adapter.fetchTranscript(ref)).resolves.toBe("captured transcript");
    await expect(adapter.stop(ref)).resolves.toEqual({ stopped: false, reason: "unsupported" });
  });

  it("relay envelope/prompt/receipt parser は model call なしで exact nonce/binding を検証する", () => {
    const input: NativeCommunicationDeliveryRequest = {
      attemptId: "attempt-1",
      attemptNonce: "nonce-1",
      deliveryId: "delivery-1",
      messageKey: "message-1",
      taskId: "t_claude_native",
      runId: 7,
      hachiSessionId: "hachi-session-1",
      expectedCancelFence: 2,
      message: "redacted payload",
      target: {
        route: "claude-cross-session",
        providerSessionId: SESSION_ID,
        agentRef: AGENT_REF,
        runtimeVersion: RUNTIME_VERSION,
        capabilityHash: CAPABILITY_HASH,
        hostId: "host-local",
        observedAt: 100,
        expiresAt: 3700,
      },
    };
    const envelope = createClaudeRelayEnvelope(input, relaySource(), 3700);
    const prompt = buildClaudeRelayPrompt(envelope);
    expect(prompt).toContain("ListAgents");
    expect(prompt).toContain("SendMessage");
    expect(prompt).toContain("attempt-1");
    const rawReceipt = JSON.stringify({
      schemaVersion: CLAUDE_RELAY_RECEIPT_SCHEMA,
      outcome: "acknowledged",
      receiptId: "receipt-1",
      attemptId: input.attemptId,
      attemptNonce: input.attemptNonce,
      deliveryId: input.deliveryId,
      messageKey: input.messageKey,
      taskId: input.taskId,
      runId: input.runId,
      hachiSessionId: input.hachiSessionId,
      expectedCancelFence: input.expectedCancelFence,
      target: { providerSessionId: SESSION_ID, agentRef: AGENT_REF },
      source: relaySource(),
      observedMessageKey: input.messageKey,
      ack: envelope.ack,
    });
    expect(parseClaudeRelayReceipt(rawReceipt, {
      attemptId: input.attemptId,
      attemptNonce: input.attemptNonce,
      deliveryId: input.deliveryId,
      messageKey: input.messageKey,
      taskId: input.taskId,
      runId: input.runId,
      hachiSessionId: input.hachiSessionId,
      expectedCancelFence: input.expectedCancelFence,
      target: { providerSessionId: SESSION_ID, agentRef: AGENT_REF },
      source: relaySource(),
    })).toMatchObject({ ok: true, delivery: { outcome: "acknowledged", receiptId: "receipt-1" } });
    expect(parseClaudeRelayReceipt(rawReceipt.replace("nonce-1", "wrong"), {
      attemptId: input.attemptId,
      attemptNonce: input.attemptNonce,
      deliveryId: input.deliveryId,
      messageKey: input.messageKey,
      taskId: input.taskId,
      runId: input.runId,
      hachiSessionId: input.hachiSessionId,
      expectedCancelFence: input.expectedCancelFence,
      target: { providerSessionId: SESSION_ID, agentRef: AGENT_REF },
      source: relaySource(),
    })).toMatchObject({ ok: false });

    const verified = verifyClaudeRelayExecutionEvidence({
      toolUses: [
        { toolUseId: "list-1", name: "ListAgents", input: {} },
        { toolUseId: "send-1", name: "SendMessage", input: { agentRef: AGENT_REF, message: JSON.stringify(envelope) } },
      ],
      toolResults: [
        { toolUseId: "list-1", name: "ListAgents", result: JSON.parse(agentJson()) },
        { toolUseId: "send-1", name: "SendMessage", result: { ok: true } },
      ],
      receiverObservation: { source: "receiver", agentRef: AGENT_REF, messageKey: input.messageKey },
    }, envelope);
    expect(verified).toMatchObject({ ok: true, delivery: { outcome: "session_observed" } });
    const forged = verifyClaudeRelayExecutionEvidence({
      toolUses: [
        { toolUseId: "list-1", name: "ListAgents", input: {} },
        { toolUseId: "send-1", name: "SendMessage", input: { agentRef: "wrong-ref", message: JSON.stringify(envelope) } },
      ],
      toolResults: [
        { toolUseId: "list-1", name: "ListAgents", result: JSON.parse(agentJson()) },
        { toolUseId: "send-1", name: "SendMessage", result: { ok: true } },
      ],
    }, envelope);
    expect(forged).toMatchObject({ ok: false });
  });

  it("prompt-generated receipt だけでは native delivery を成功扱いしない", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-claude-cross-session-"));
    mkdirSync(join(tempRoot, "state"), { recursive: true });
    const prompts: string[] = [];
    let allowedTools: readonly string[] = [];
    const adapter = new ClaudeCrossSessionWorkerAdapter({
      stateDir: join(tempRoot, "state"),
      providerTranscriptRoot: createProviderTranscriptRoot(tempRoot),
      commandRunner: fakeRunner(),
      spawner: fakeSpawner([]),
      sessionIdFactory: () => SESSION_ID,
      nameFactory: () => "hachi-worker",
      clock: { nowSeconds: () => 100, sleep: async () => {} },
      relaySource: relaySource(),
      relayExecutor: {
        execute: async (prompt, envelope, options) => {
          prompts.push(prompt);
          allowedTools = options?.allowedTools ?? [];
          return JSON.stringify({
            schemaVersion: CLAUDE_RELAY_RECEIPT_SCHEMA,
            outcome: "transport-accepted",
            receiptId: "receipt-fake",
            attemptId: envelope.attemptId,
            attemptNonce: envelope.attemptNonce,
            deliveryId: envelope.deliveryId,
            messageKey: envelope.messageKey,
            taskId: envelope.taskId,
            runId: envelope.runId,
            hachiSessionId: envelope.hachiSessionId,
            expectedCancelFence: envelope.expectedCancelFence,
            target: envelope.target,
            source: envelope.source,
          });
        },
      },
    });
    const ref = await adapter.launch(fakeTask(), { model: "claude-opus-5", cwd: tempRoot, promptText: "x" });
    const target = ref.nativeCommunication;
    if (target === undefined || target.route !== "claude-cross-session") throw new Error("native target missing");
    const result = await adapter.deliver({
      attemptId: "attempt-fake",
      attemptNonce: "nonce-fake",
      deliveryId: "delivery-fake",
      messageKey: "message-fake",
      taskId: "t_claude_native",
      runId: 1,
      hachiSessionId: "hachi-session-fake",
      expectedCancelFence: 0,
      message: "payload",
      target,
    });
    expect(result).toMatchObject({ outcome: "uncertain" });
    expect(result.detail).toMatch(/prompt-generated receipt|実 tool-use|receiver observation/);
    expect(prompts[0]).toContain("SendMessage");
    expect(allowedTools).toEqual(["ListAgents", "SendMessage"]);
  });
});
