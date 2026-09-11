import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { SqliteKanbanStore, type OrchestratorSessionRow } from "@hachi/core";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function startTrustedCodexSession(store: SqliteKanbanStore, orchestratorId: string): OrchestratorSessionRow {
  const now = Math.floor(Date.now() / 1000);
  const providerSessionId = "codex-orchestrator-session";
  const source = store.startOrchestratorSession({ orchestratorId });
  const handoffTokenHash = hash("communication-cli-handoff");
  const canonicalCwd = "/tmp/communication-cli";
  const hostId = hostname();
  const tmuxSession = "tmux-communication-cli";
  const hookDefinitionHash = hash("communication-cli-hook-definition");
  const hookExecutableHash = hash("communication-cli-hook-executable");
  const ownerNonceHash = hash("communication-cli-owner");
  const tmuxSocketPath = "/tmp/tmux-communication-cli/default";
  const tmuxServerPid = 63_001;
  const tmuxServerStartTime = 1_800_000_001;
  const tmuxServerLifetimeHash = hash("communication-cli-server-lifetime");
  const armed = store.armSuccessorLaunch({
    orchestratorId,
    targetProvider: "codex",
    sourceSessionId: source.id,
    sourceGeneration: source.generation,
    canonicalCwd,
    hostId,
    launchNonceHash: hash("communication-cli-launch"),
    plannedTmuxSession: tmuxSession,
    hookDefinitionHash,
    hookExecutableHash,
    runtimeDeadlineAt: now + 60,
    attestationDeadlineAt: now + 120,
    kind: "handoff",
    handoffTokenFenceHash: handoffTokenHash,
    handoffExpiresAt: now + 120,
    now,
  });
  store.bindSuccessorLaunchRuntime({
    slotId: armed.id,
    expectedRevision: armed.revision,
    observedCanonicalCwd: canonicalCwd,
    observedHostId: hostId,
    tmuxSession,
    tmuxPane: "%1",
    panePid: 61_001,
    processGroupId: 62_001,
    tmuxSocketPath,
    tmuxServerPid,
    tmuxServerStartTime,
    tmuxServerLifetimeHash,
    ownerNonceHash,
    hookDefinitionHash,
    hookExecutableHash,
    now: now + 1,
  });
  const attested = store.attestSuccessorLaunch({
    providerSessionSource: "codex-session-start",
    source: "startup",
    providerSessionId,
    canonicalCwd,
    hostId,
    tmuxSession,
    tmuxPane: "%1",
    panePid: 61_001,
    processGroupId: 62_001,
    tmuxSocketPath,
    tmuxServerPid,
    tmuxServerStartTime,
    tmuxServerLifetimeHash,
    ownerNonceHash,
    hookDefinitionHash,
    hookExecutableHash,
    now: now + 2,
  });
  if (attested === null) throw new Error("communication CLI fixture の attestation に失敗しました");
  const claimed = store.claimSuccessorLaunchAccept({
    slotId: armed.id,
    expectedRevision: attested.launch.revision,
    attestationHandleHash: hash(attested.attestationHandle),
    operation: "handoff",
    now: now + 3,
  });
  return store.acceptOrchestratorHandoffWithSuccessorLaunch({
    slotId: armed.id,
    expectedRevision: claimed.launch.revision,
    acceptFenceHash: hash(claimed.acceptFence),
    attestationHandleHash: hash(attested.attestationHandle),
    handoffTokenHash,
    now: now + 4,
  });
}

describe("hachi communication CLI", () => {
  let ctx: TestDeps | undefined;

  afterEach(() => {
    ctx?.cleanup();
    ctx = undefined;
  });

  it("relay/binding read models are JSON and empty lists do not expose secret fields", async () => {
    ctx = createTestDeps();

    await buildProgram(ctx.deps).parseAsync(["communication", "relay", "list", "--json"], { from: "user" });
    expect(JSON.parse(ctx.stdout.text())).toEqual({ attempts: [] });
    expect(ctx.stdout.text()).not.toContain("payload");
    expect(ctx.stdout.text()).not.toContain("attemptNonce");

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["communication", "binding", "list", "--json"], { from: "user" });
    expect(JSON.parse(ctx.stdout.text())).toEqual({ bindings: [] });
    expect(ctx.exitCodes).toEqual([]);
  });

  it("relay mutations require structured exact orchestrator provenance", async () => {
    ctx = createTestDeps();

    await buildProgram(ctx.deps).parseAsync([
      "communication", "relay", "claim", "--attempt", "cda_missing",
    ], { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("actor-kind orchestrator");
  });

  it("register-source derives provider/session/host and rejects caller spoof fields", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask(
      { title: "source binding", body: "cwd: /tmp", tenant: "dev", status: "ready" },
      "tester",
    );
    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "source", project: "dev", repoCommonDir: "" });
    const session = startTrustedCodexSession(ctx.deps.store as SqliteKanbanStore, orchestrator.id);
    ctx.deps.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");

    await buildProgram(ctx.deps).parseAsync([
      "communication", "binding", "register-source", "--task", task.id,
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation), "--json",
    ], { from: "user" });
    expect(ctx.exitCodes, ctx.stderr.text()).toEqual([]);
    const output = JSON.parse(ctx.stdout.text()) as {
      binding: {
        provider: string;
        providerSessionId: string;
        hostId: string;
        nativeAddress: unknown;
      };
    };
    expect(output.binding).toMatchObject({
      provider: "codex",
      providerSessionId: "codex-orchestrator-session",
      hostId: hostname(),
      nativeAddress: null,
    });

    await expect(buildProgram(ctx.deps).parseAsync([
      "communication", "binding", "register-source", "--task", task.id,
      "--provider", "claude",
    ], { from: "user" })).rejects.toThrow(/unknown option/);
    await expect(buildProgram(ctx.deps).parseAsync([
      "communication", "binding", "register-source", "--task", task.id,
      "--host-id", "attacker-host",
    ], { from: "user" })).rejects.toThrow(/unknown option/);
    expect((ctx.deps.store as typeof ctx.deps.store & { listNativeSessionBindings(taskId?: string): unknown[] })
      .listNativeSessionBindings(task.id)).toHaveLength(1);

    const run = ctx.deps.store.startRun(task.id, "codex", "native-target-session", {
      transport: "direct",
      serverUrl: "direct",
    });
    const now = Math.floor(Date.now() / 1000);
    const nativeStore = ctx.deps.store as typeof ctx.deps.store & {
      createOrGetNativeTargetBinding(input: unknown, actor: string, provenance: unknown): {
        id: string;
      };
    };
    nativeStore.createOrGetNativeTargetBinding({
      bindingKey: `target:${task.id}:${run.id}`,
      provider: "codex",
      hostId: hostname(),
      providerSessionId: "native-target-session",
      nativeAddress: {
        route: "codex-app-server",
        threadId: "thread-exact",
        activeTurnId: "turn-exact",
        socketSnapshot: {
          canonicalPath: "/private/tmp/codex-app-server.sock",
          parentCanonicalPath: "/private/tmp",
          parentDev: 1,
          parentIno: 2,
          parentUid: 501,
          parentMode: 0o700,
          dev: 3,
          ino: 4,
          uid: 501,
          gid: 20,
          mode: 0o600,
        },
      },
      runtimeVersion: "0.144.1",
      capabilityHash: "b".repeat(64),
      observedAt: now,
      expiresAt: now + 300,
      taskId: task.id,
      runId: run.id,
      hachiSessionId: run.sessionId,
      targetRole: "worker",
      expectedCancelFence: 0,
    }, "supervisor", { kind: "service", actorId: "supervisor", actorSessionId: "", actorGeneration: null });
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([
      "communication", "binding", "list", "--task", task.id, "--kind", "target", "--json",
    ], { from: "user" });
    const bindings = JSON.parse(ctx.stdout.text()) as { bindings: Array<Record<string, unknown>> };
    expect(bindings.bindings[0]?.nativeAddress).toEqual({
      route: "codex-app-server",
      threadId: "thread-exact",
      activeTurnId: "turn-exact",
    });
  });
});
