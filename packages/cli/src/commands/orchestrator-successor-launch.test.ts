import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OrchestratorSessionRow,
  OrchestratorSuccessorLaunchKind,
  OrchestratorSuccessorLaunchRow,
  Provider,
} from "@hachi/core";
import { buildProgram } from "../program.js";
import { unconfiguredSuccessorAttestationHashProbe } from "../successor-attestation.js";
import { createTestDeps, type TestDeps } from "../test-support.js";
import type { SuccessorTmuxPaneReadback, TmuxLauncher } from "../deps.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface SuccessorFixture {
  source: OrchestratorSessionRow;
  launch: OrchestratorSuccessorLaunchRow;
  token: string;
  cwd: string;
  hostId: string;
  tmuxSession: string;
  tmuxPane: string;
  panePid: number;
  processGroupId: number;
  tmuxSocketPath: string;
  tmuxServerPid: number;
  tmuxServerStartTime: number;
  tmuxServerLifetimeHash: string;
  ownerNonce: string;
  hookDefinitionHash: string;
  hookExecutableHash: string;
}

function registerIdentity(ctx: TestDeps, suffix: string): string {
  return ctx.deps.store.registerOrchestrator({
    label: `successor-${suffix}`,
    project: `project-${suffix}`,
    repoCommonDir: `/repo/${suffix}/.git`,
  }).id;
}

function armAndBind(
  ctx: TestDeps,
  suffix: string,
  kind: OrchestratorSuccessorLaunchKind = "handoff",
  provider: Provider = "codex",
): SuccessorFixture {
  const now = Math.floor(Date.now() / 1000);
  const orchestratorId = registerIdentity(ctx, suffix);
  const source = ctx.deps.store.startOrchestratorSession({ orchestratorId });
  if (kind === "takeover") {
    ctx.deps.store.heartbeatOrchestratorSession(source.id, source.generation, now - 200);
  }
  const token = `token-${suffix}`;
  const cwd = `/repo/${suffix}`;
  const hostId = `host-${suffix}`;
  const tmuxSession = `tmux-${suffix}`;
  const tmuxPane = "%42";
  const panePid = 42_001;
  const processGroupId = 42_101;
  const tmuxSocketPath = `/tmp/tmux-successor/${suffix}`;
  const tmuxServerPid = 42_201;
  const tmuxServerStartTime = 1_800_000_001;
  const tmuxServerLifetimeHash = hash(`server-lifetime-${suffix}`);
  const ownerNonce = `owner-${suffix}`;
  const hookDefinitionHash = hash(`hook-definition-${suffix}`);
  const hookExecutableHash = hash(`hook-executable-${suffix}`);
  const armed = ctx.deps.store.armSuccessorLaunch({
    orchestratorId,
    targetProvider: provider,
    sourceSessionId: source.id,
    sourceGeneration: source.generation,
    canonicalCwd: cwd,
    hostId,
    launchNonceHash: hash(`launch-${suffix}`),
    plannedTmuxSession: tmuxSession,
    hookDefinitionHash,
    hookExecutableHash,
    runtimeDeadlineAt: now + 300,
    attestationDeadlineAt: now + 600,
    ...(kind === "handoff"
      ? {
          kind: "handoff" as const,
          handoffTokenFenceHash: hash(token),
          handoffExpiresAt: now + 600,
        }
      : {
          kind: "takeover" as const,
          staleBefore: now - 100,
        }),
  });
  const launch = ctx.deps.store.bindSuccessorLaunchRuntime({
    slotId: armed.id,
    expectedRevision: armed.revision,
    observedCanonicalCwd: cwd,
    observedHostId: hostId,
    tmuxSession,
    tmuxPane,
    panePid,
    processGroupId,
    tmuxSocketPath,
    tmuxServerPid,
    tmuxServerStartTime,
    tmuxServerLifetimeHash,
    ownerNonceHash: hash(ownerNonce),
    hookDefinitionHash,
    hookExecutableHash,
  });
  return {
    source: ctx.deps.store.getOrchestratorSession(source.id)!,
    launch,
    token,
    cwd,
    hostId,
    tmuxSession,
    tmuxPane,
    panePid,
    processGroupId,
    tmuxSocketPath,
    tmuxServerPid,
    tmuxServerStartTime,
    tmuxServerLifetimeHash,
    ownerNonce,
    hookDefinitionHash,
    hookExecutableHash,
  };
}

function installHookInput(
  ctx: TestDeps,
  fixture: SuccessorFixture,
  source: "startup" | "resume" | "compact" | "clear" = "startup",
  inertFields: {
    transcriptPath?: string | null;
    model?: string;
    permissionMode?: string;
  } = {},
): void {
  ctx.deps.stdin = {
    read: async () => JSON.stringify({
      session_id: `codex-${fixture.tmuxSession}`,
      cwd: fixture.cwd,
      source,
      hook_event_name: "SessionStart",
      transcript_path: inertFields.transcriptPath ?? null,
      model: inertFields.model ?? "gpt-5.6-sol",
      permission_mode: inertFields.permissionMode ?? "default",
    }),
  };
  ctx.deps.processEnv = { TMUX_PANE: fixture.tmuxPane };
  ctx.deps.successorTmuxReadback = {
    readExactPane: () => ({
      ok: true,
      value: {
        tmuxSession: fixture.tmuxSession,
        tmuxPane: fixture.tmuxPane,
        panePid: fixture.panePid,
        processGroupId: fixture.processGroupId,
        cwd: fixture.cwd,
        ownerNonce: fixture.ownerNonce,
        tmuxSocketPath: fixture.tmuxSocketPath,
        tmuxServerPid: fixture.tmuxServerPid,
        tmuxServerStartTime: fixture.tmuxServerStartTime,
        tmuxServerLifetimeHash: fixture.tmuxServerLifetimeHash,
      },
    }),
    initializeServerLifetimeAndReadExactPane: () => ({ ok: false, reason: "unavailable" }),
  };
  ctx.deps.currentHostId = () => fixture.hostId;
  ctx.deps.canonicalizeSuccessorCwd = (path: string) => path;
  ctx.deps.successorAttestationHashProbe = {
    readInstalledHashes: () => ({
      hookDefinitionHash: fixture.hookDefinitionHash,
      hookExecutableHash: fixture.hookExecutableHash,
    }),
  };
}

function transformExactReadback(
  ctx: TestDeps,
  transform: (value: SuccessorTmuxPaneReadback) => SuccessorTmuxPaneReadback,
): void {
  const previous = ctx.deps.successorTmuxReadback;
  ctx.deps.successorTmuxReadback = {
    readExactPane: (pane) => {
      const result = previous.readExactPane(pane);
      return result.ok ? { ok: true, value: transform(result.value) } : result;
    },
    initializeServerLifetimeAndReadExactPane: (pane, candidate) =>
      previous.initializeServerLifetimeAndReadExactPane(pane, candidate),
  };
}

async function runAttest(ctx: TestDeps): Promise<void> {
  await buildProgram(ctx.deps).parseAsync(
    ["orchestrator", "successor-launch", "attest"],
    { from: "user" },
  );
}

function extractAttestationHandle(output: string): string {
  const parsed = JSON.parse(output) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
  const match = parsed.hookSpecificOutput.additionalContext.match(/handle: ([A-Za-z0-9_-]+)/);
  if (match?.[1] === undefined) throw new Error("hook output に handle がありません");
  return match[1];
}

describe("orchestrator successor-launch Gate 2", () => {
  let ctx: TestDeps;

  afterEach(() => {
    vi.useRealTimers();
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  it("close-uncertain は既定dry-runで全条件を表示しstateを変更しない", async () => {
    ctx = createTestDeps();
    const fixture = armAndBind(ctx, "fenced-close-dry-run");
    const pending = ctx.deps.store.markSuccessorLaunchStopPending({
      slotId: fixture.launch.id,
      expectedRevision: fixture.launch.revision,
      expectedStatus: "runtime_bound",
      error: "stop observation was incomplete",
    });
    const uncertain = ctx.deps.store.recordSuccessorLaunchStop({
      slotId: fixture.launch.id,
      expectedRevision: pending.launch.revision,
      stopFenceHash: hash(pending.stopFence),
      killOwnerReadbackHash: hash(fixture.ownerNonce),
      evidence: {
        ownerMatched: true,
        ownerReadbackAt: Math.floor(Date.now() / 1000),
        killResult: "succeeded",
        tmuxSessionAbsent: true,
        panePidAbsent: true,
        processGroupAbsent: false,
        observedAt: Math.floor(Date.now() / 1000),
      },
    });
    const launcher: TmuxLauncher = {
      launch: () => ({ ok: false, reason: "unused" }),
      hasSession: () => false,
      getPaneRootPid: () => null,
      killSession: () => false,
      getProcessGroupId: () => null,
      isProcessGroupAlive: () => false,
      setSessionOwnerNonce: () => false,
      getSessionOwnerNonce: () => null,
      isPaneProcessAlive: () => false,
    };
    ctx.deps.tmuxLauncher = launcher;

    await buildProgram(ctx.deps).parseAsync([
      "orchestrator", "successor-launch", "close-uncertain",
      "--slot", fixture.launch.id,
      "--orchestrator", fixture.source.orchestratorId,
      "--session", fixture.source.id,
      "--generation", String(fixture.source.generation),
      "--json",
    ], { from: "user" });

    const output = JSON.parse(ctx.stdout.text()) as {
      applicable: boolean;
      applied: boolean;
      conditions: Record<string, boolean>;
    };
    expect(output).toMatchObject({
      applicable: false,
      applied: false,
      conditions: {
        statusUncertain: true,
        storedStopEvidenceComplete: false,
        freshTargetAbsent: true,
        callerSessionGenerationActive: true,
        sourceSessionHandoffPending: true,
      },
    });
    expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)).toMatchObject({
      status: "uncertain",
      revision: uncertain.revision,
    });
  });

  describe("contract §73.1 provider 入力行列", () => {
    it("register は provider/ID 全省略を維持し、片pairをmutation前に拒否する", async () => {
      ctx = createTestDeps();
      for (const pair of [
        ["--provider", "claude"],
        ["--provider-session-id", "claude-partial"],
      ]) {
        await buildProgram(ctx.deps).parseAsync([
          "orchestrator", "register",
          "--label", "partial",
          "--project", "partial",
          "--cwd", process.cwd(),
          ...pair,
        ], { from: "user" });
      }
      expect(ctx.exitCodes).toEqual([1, 1]);
      expect(ctx.deps.store.listOrchestrators()).toHaveLength(0);

      ctx.stderr.clear();
      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "register",
        "--label", "placeholder",
        "--project", "placeholder",
        "--cwd", process.cwd(),
        "--json",
      ], { from: "user" });
      const output = JSON.parse(ctx.stdout.text()) as { session: OrchestratorSessionRow };
      expect(output.session).toMatchObject({ provider: "", providerSessionId: "", providerSessionSource: "" });
    });

    it("Claude と manual Codex は non-empty atomic pair を受理し source=manual のままにする", async () => {
      ctx = createTestDeps();
      for (const [suffix, provider] of [["claude", "claude"], ["codex", "codex"]] as const) {
        const orchestratorId = registerIdentity(ctx, suffix);
        ctx.stdout.clear();
        await buildProgram(ctx.deps).parseAsync([
          "orchestrator", "session", "start", orchestratorId,
          "--provider", provider,
          "--provider-session-id", `${provider}-caller-id`,
          "--json",
        ], { from: "user" });
        const output = JSON.parse(ctx.stdout.text()) as { session: OrchestratorSessionRow };
        expect(output.session).toMatchObject({
          provider,
          providerSessionId: `${provider}-caller-id`,
          providerSessionSource: "manual",
        });
      }
    });

    it("enforce mode は manual Codex を拒否するが Claude pair と placeholder は維持する", async () => {
      ctx = createTestDeps();
      ctx.deps.config.orchestrator = { codexSuccessorAttestation: { mode: "enforce" } };
      const codexId = registerIdentity(ctx, "enforce-codex");
      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "start", codexId,
        "--provider", "codex", "--provider-session-id", "codex-unattested",
      ], { from: "user" });
      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.deps.store.listOrchestratorSessions(codexId)).toHaveLength(0);

      const claudeId = registerIdentity(ctx, "enforce-claude");
      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "start", claudeId,
        "--provider", "claude", "--provider-session-id", "claude-manual",
      ], { from: "user" });
      const placeholderId = registerIdentity(ctx, "enforce-placeholder");
      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "start", placeholderId,
      ], { from: "user" });
      expect(ctx.deps.store.listOrchestratorSessions(claudeId)[0]?.providerSessionSource).toBe("manual");
      expect(ctx.deps.store.listOrchestratorSessions(placeholderId)[0]?.provider).toBe("");
    });

    it("既存 Claude manual の handoff-accept/takeover 正常系を維持する", async () => {
      ctx = createTestDeps();
      const now = Math.floor(Date.now() / 1000);
      const handoffId = registerIdentity(ctx, "claude-handoff-normal");
      const handoffSource = ctx.deps.store.startOrchestratorSession({ orchestratorId: handoffId });
      const token = "claude-handoff-token";
      ctx.deps.store.prepareOrchestratorHandoff(
        handoffSource.id,
        handoffSource.generation,
        hash(token),
        now + 600,
      );
      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "handoff-accept", handoffSource.id,
        "--token", token,
        "--provider", "claude",
        "--provider-session-id", "claude-handoff-session",
      ], { from: "user" });
      expect(ctx.deps.store.listOrchestratorSessions(handoffId).at(-1)).toMatchObject({
        provider: "claude",
        providerSessionId: "claude-handoff-session",
        providerSessionSource: "manual",
      });

      const takeoverId = registerIdentity(ctx, "claude-takeover-normal");
      const takeoverSource = ctx.deps.store.startOrchestratorSession({ orchestratorId: takeoverId });
      ctx.deps.store.heartbeatOrchestratorSession(takeoverSource.id, takeoverSource.generation, now - 200);
      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "takeover", takeoverId,
        "--stale-sec", "100",
        "--provider", "claude",
        "--provider-session-id", "claude-takeover-session",
      ], { from: "user" });
      expect(ctx.deps.store.listOrchestratorSessions(takeoverId).at(-1)).toMatchObject({
        provider: "claude",
        providerSessionId: "claude-takeover-session",
        providerSessionSource: "manual",
      });
      expect(ctx.exitCodes).toEqual([]);
    });

    it("manual mode は Codex caller pair の handoff-accept/takeover を source=manual で受理する", async () => {
      ctx = createTestDeps();
      const now = Math.floor(Date.now() / 1000);
      const handoffId = registerIdentity(ctx, "codex-manual-handoff");
      const handoffSource = ctx.deps.store.startOrchestratorSession({ orchestratorId: handoffId });
      const token = "codex-manual-token";
      ctx.deps.store.prepareOrchestratorHandoff(
        handoffSource.id,
        handoffSource.generation,
        hash(token),
        now + 600,
      );
      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "handoff-accept", handoffSource.id,
        "--token", token,
        "--provider", "codex",
        "--provider-session-id", "codex-manual-handoff-session",
      ], { from: "user" });
      expect(ctx.deps.store.listOrchestratorSessions(handoffId).at(-1)?.providerSessionSource).toBe("manual");

      const takeoverId = registerIdentity(ctx, "codex-manual-takeover");
      const takeoverSource = ctx.deps.store.startOrchestratorSession({ orchestratorId: takeoverId });
      ctx.deps.store.heartbeatOrchestratorSession(takeoverSource.id, takeoverSource.generation, now - 200);
      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "takeover", takeoverId,
        "--stale-sec", "100",
        "--provider", "codex",
        "--provider-session-id", "codex-manual-takeover-session",
      ], { from: "user" });
      expect(ctx.deps.store.listOrchestratorSessions(takeoverId).at(-1)?.providerSessionSource).toBe("manual");
      expect(ctx.exitCodes).toEqual([]);
    });

    it("handoff-accept/takeover も provider/ID の片pairをmutation前に拒否する", async () => {
      ctx = createTestDeps();
      const now = Math.floor(Date.now() / 1000);
      const handoffId = registerIdentity(ctx, "partial-handoff");
      const handoffSource = ctx.deps.store.startOrchestratorSession({ orchestratorId: handoffId });
      const token = "partial-handoff-token";
      ctx.deps.store.prepareOrchestratorHandoff(
        handoffSource.id,
        handoffSource.generation,
        hash(token),
        now + 600,
      );
      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "handoff-accept", handoffSource.id,
        "--token", token,
        "--provider", "claude",
      ], { from: "user" });

      const takeoverId = registerIdentity(ctx, "partial-takeover");
      const takeoverSource = ctx.deps.store.startOrchestratorSession({ orchestratorId: takeoverId });
      ctx.deps.store.heartbeatOrchestratorSession(takeoverSource.id, takeoverSource.generation, now - 200);
      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "takeover", takeoverId,
        "--provider-session-id", "claude-partial",
      ], { from: "user" });

      expect(ctx.exitCodes).toEqual([1, 1]);
      expect(ctx.deps.store.getOrchestratorSession(handoffSource.id)?.status).toBe("handoff_pending");
      expect(ctx.deps.store.getOrchestratorSession(takeoverSource.id)?.status).toBe("active");
    });

    it("enforce mode は handoff-accept/takeover の unattested Codex pair を拒否する", async () => {
      ctx = createTestDeps();
      ctx.deps.config.orchestrator = { codexSuccessorAttestation: { mode: "enforce" } };
      const now = Math.floor(Date.now() / 1000);
      const handoffId = registerIdentity(ctx, "enforce-handoff");
      const handoffSource = ctx.deps.store.startOrchestratorSession({ orchestratorId: handoffId });
      const token = "enforce-handoff-token";
      ctx.deps.store.prepareOrchestratorHandoff(
        handoffSource.id,
        handoffSource.generation,
        hash(token),
        now + 600,
      );
      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "handoff-accept", handoffSource.id,
        "--token", token,
        "--provider", "codex",
        "--provider-session-id", "codex-unattested-handoff",
      ], { from: "user" });

      const takeoverId = registerIdentity(ctx, "enforce-takeover");
      const takeoverSource = ctx.deps.store.startOrchestratorSession({ orchestratorId: takeoverId });
      ctx.deps.store.heartbeatOrchestratorSession(takeoverSource.id, takeoverSource.generation, now - 200);
      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "takeover", takeoverId,
        "--provider", "codex",
        "--provider-session-id", "codex-unattested-takeover",
      ], { from: "user" });

      expect(ctx.exitCodes).toEqual([1, 1]);
      expect(ctx.deps.store.getOrchestratorSession(handoffSource.id)?.status).toBe("handoff_pending");
      expect(ctx.deps.store.getOrchestratorSession(takeoverSource.id)?.status).toBe("active");
    });

    it("handle は Codex provider のみ許可し caller session ID 併用をmutation前に拒否する", async () => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, "handle-matrix");
      const issued = ctx.deps.store.attestSuccessorLaunch({
        providerSessionSource: "codex-session-start",
        source: "startup",
        providerSessionId: "codex-handle-matrix",
        canonicalCwd: fixture.cwd,
        hostId: fixture.hostId,
        tmuxSession: fixture.tmuxSession,
        tmuxPane: fixture.tmuxPane,
        panePid: fixture.panePid,
        processGroupId: fixture.processGroupId,
        tmuxSocketPath: fixture.tmuxSocketPath,
        tmuxServerPid: fixture.tmuxServerPid,
        tmuxServerStartTime: fixture.tmuxServerStartTime,
        tmuxServerLifetimeHash: fixture.tmuxServerLifetimeHash,
        ownerNonceHash: hash(fixture.ownerNonce),
        hookDefinitionHash: fixture.hookDefinitionHash,
        hookExecutableHash: fixture.hookExecutableHash,
      })!;
      for (const args of [
        ["--provider", "claude", "--attestation-handle", issued.attestationHandle],
        [
          "--provider", "codex",
          "--provider-session-id", "caller-id",
          "--attestation-handle", issued.attestationHandle,
        ],
      ]) {
        await buildProgram(ctx.deps).parseAsync([
          "orchestrator", "session", "handoff-accept", fixture.source.id,
          "--token", fixture.token,
          ...args,
        ], { from: "user" });
      }
      expect(ctx.exitCodes).toEqual([1, 1]);
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)?.status).toBe("attested");
      expect(ctx.deps.store.getOrchestratorSession(fixture.source.id)?.status).toBe("handoff_pending");
    });

    it("blocking slot を Claude/manual/placeholder handoff-accept で迂回できない", async () => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, "blocking-handoff");
      for (const args of [
        ["--provider", "claude", "--provider-session-id", "claude-bypass"],
        ["--provider", "codex", "--provider-session-id", "codex-bypass"],
        [],
      ]) {
        await buildProgram(ctx.deps).parseAsync([
          "orchestrator", "session", "handoff-accept", fixture.source.id,
          "--token", fixture.token,
          ...args,
        ], { from: "user" });
      }
      expect(ctx.exitCodes).toEqual([1, 1, 1]);
      expect(ctx.stderr.text()).toContain("SUCCESSOR_REPLACEMENT_BLOCKED");
      expect(ctx.deps.store.getOrchestratorSession(fixture.source.id)?.status).toBe("handoff_pending");
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)?.status).toBe("runtime_bound");
    });

    it("blocking slot を generic/manual takeover で迂回できない", async () => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, "blocking-takeover", "takeover");
      for (const args of [
        ["--provider", "claude", "--provider-session-id", "claude-bypass"],
        ["--provider", "codex", "--provider-session-id", "codex-bypass"],
        [],
      ]) {
        await buildProgram(ctx.deps).parseAsync([
          "orchestrator", "session", "takeover", fixture.source.orchestratorId,
          ...args,
        ], { from: "user" });
      }
      expect(ctx.exitCodes).toEqual([1, 1, 1]);
      expect(ctx.deps.store.getOrchestratorSession(fixture.source.id)?.status).toBe("active");
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)?.status).toBe("runtime_bound");
    });
  });

  describe("tmux server lifetime runtime key fixture", () => {
    it("同一server lifetime/paneは拒否し、server restart後の同pane再利用は許可する", () => {
      ctx = createTestDeps();
      const first = armAndBind(ctx, "runtime-key-first");
      const now = Math.floor(Date.now() / 1000);
      const orchestratorId = registerIdentity(ctx, "runtime-key-second");
      const source = ctx.deps.store.startOrchestratorSession({ orchestratorId });
      const armed = ctx.deps.store.armSuccessorLaunch({
        orchestratorId,
        targetProvider: "codex",
        sourceSessionId: source.id,
        sourceGeneration: source.generation,
        canonicalCwd: "/repo/runtime-key-second",
        hostId: first.hostId,
        launchNonceHash: hash("runtime-key-second-launch"),
        plannedTmuxSession: "tmux-runtime-key-second",
        hookDefinitionHash: hash("runtime-key-second-hook"),
        hookExecutableHash: hash("runtime-key-second-helper"),
        runtimeDeadlineAt: now + 300,
        attestationDeadlineAt: now + 600,
        kind: "handoff",
        handoffTokenFenceHash: hash("runtime-key-second-token"),
        handoffExpiresAt: now + 600,
        now,
      });
      const bindInput = {
        slotId: armed.id,
        expectedRevision: armed.revision,
        observedCanonicalCwd: "/repo/runtime-key-second",
        observedHostId: first.hostId,
        tmuxSession: "tmux-runtime-key-second",
        tmuxPane: first.tmuxPane,
        panePid: first.panePid + 1,
        processGroupId: first.processGroupId + 1,
        tmuxSocketPath: first.tmuxSocketPath,
        tmuxServerPid: first.tmuxServerPid,
        tmuxServerStartTime: first.tmuxServerStartTime,
        ownerNonceHash: hash("runtime-key-second-owner"),
        hookDefinitionHash: hash("runtime-key-second-hook"),
        hookExecutableHash: hash("runtime-key-second-helper"),
        now: now + 1,
      };

      expect(() => ctx.deps.store.bindSuccessorLaunchRuntime({
        ...bindInput,
        tmuxServerLifetimeHash: first.tmuxServerLifetimeHash,
      })).toThrow();
      const rebound = ctx.deps.store.bindSuccessorLaunchRuntime({
        ...bindInput,
        tmuxServerPid: first.tmuxServerPid + 1,
        tmuxServerStartTime: first.tmuxServerStartTime + 1,
        tmuxServerLifetimeHash: hash("runtime-key-restarted-server"),
      });
      expect(rebound).toMatchObject({
        status: "runtime_bound",
        tmuxPane: first.tmuxPane,
        tmuxSocketPath: first.tmuxSocketPath,
      });
    });
  });

  describe("trusted claim/final transaction", () => {
    it("handoff-accept は handle から slot を解決して trusted session を作り raw capability を通常出力しない", async () => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, "trusted-handoff");
      installHookInput(ctx, fixture);
      await runAttest(ctx);
      const handle = extractAttestationHandle(ctx.stdout.text());
      ctx.stdout.clear();
      const claim = vi.spyOn(ctx.deps.store, "claimSuccessorLaunchAccept");

      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "handoff-accept", fixture.source.id,
        "--token", fixture.token,
        "--provider", "codex",
        "--attestation-handle", handle,
        "--json",
      ], { from: "user" });

      const output = JSON.parse(ctx.stdout.text()) as { session: OrchestratorSessionRow };
      const acceptFence = claim.mock.results[0]?.value.acceptFence as string;
      expect(output.session).toMatchObject({
        provider: "codex",
        providerSessionId: `codex-${fixture.tmuxSession}`,
        providerSessionSource: "codex-session-start",
      });
      expect(ctx.stdout.text()).not.toContain(handle);
      expect(ctx.stdout.text()).not.toContain(acceptFence);
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)?.status).toBe("succeeded");
    });

    it("takeover は caller stale/provider ID を final API へコピーせず slot の cutoff/session ID を使う", async () => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, "trusted-takeover", "takeover");
      installHookInput(ctx, fixture);
      await runAttest(ctx);
      const handle = extractAttestationHandle(ctx.stdout.text());
      ctx.stdout.clear();

      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "takeover", fixture.source.orchestratorId,
        "--stale-sec", "1",
        "--provider", "codex",
        "--attestation-handle", handle,
        "--json",
      ], { from: "user" });

      const output = JSON.parse(ctx.stdout.text()) as { session: OrchestratorSessionRow };
      expect(output.session).toMatchObject({
        providerSessionId: `codex-${fixture.tmuxSession}`,
        providerSessionSource: "codex-session-start",
      });
      expect(ctx.deps.store.getOrchestratorSession(fixture.source.id)?.status).toBe("stale");
      expect(ctx.stdout.text()).not.toContain(handle);
    });

    it("claim後crashの同一CLI retryは同じaccept fenceでfinalへ収束しgeneric fallbackしない", async () => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, "trusted-claim-crash-retry");
      installHookInput(ctx, fixture);
      await runAttest(ctx);
      const handle = extractAttestationHandle(ctx.stdout.text());
      ctx.stdout.clear();
      const claim = vi.spyOn(ctx.deps.store, "claimSuccessorLaunchAccept");
      const genericFallback = vi.spyOn(ctx.deps.store, "acceptOrchestratorHandoff");
      const final = vi.spyOn(ctx.deps.store, "acceptOrchestratorHandoffWithSuccessorLaunch")
        .mockImplementationOnce(() => { throw new Error("claim後のprocess crashを模擬"); });
      const args = [
        "orchestrator", "session", "handoff-accept", fixture.source.id,
        "--token", fixture.token,
        "--provider", "codex",
        "--attestation-handle", handle,
        "--json",
      ];

      await buildProgram(ctx.deps).parseAsync(args, { from: "user" });
      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)?.status).toBe("accepting");
      const firstFence = claim.mock.results[0]?.value.acceptFence as string;

      final.mockRestore();
      ctx.stderr.clear();
      await buildProgram(ctx.deps).parseAsync(args, { from: "user" });
      const secondFence = claim.mock.results[1]?.value.acceptFence as string;
      const output = JSON.parse(ctx.stdout.text()) as { session: OrchestratorSessionRow };
      expect(secondFence).toBe(firstFence);
      expect(output.session.providerSessionId).toBe(`codex-${fixture.tmuxSession}`);
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)?.status).toBe("succeeded");
      expect(ctx.deps.store.listOrchestratorSessions(fixture.source.orchestratorId)).toHaveLength(2);
      expect(genericFallback).not.toHaveBeenCalled();
    });

    it("handoff final conflictはCLI wiringからstop_pendingへ閉じtokenを回転しgeneric fallbackしない", async () => {
      vi.useFakeTimers();
      const now = Math.floor(Date.now() / 1000);
      vi.setSystemTime(now * 1_000);
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, "trusted-final-conflict");
      installHookInput(ctx, fixture);
      await runAttest(ctx);
      const handle = extractAttestationHandle(ctx.stdout.text());
      ctx.stdout.clear();
      const originalClaim = ctx.deps.store.claimSuccessorLaunchAccept.bind(ctx.deps.store);
      vi.spyOn(ctx.deps.store, "claimSuccessorLaunchAccept").mockImplementation((input) => {
        const claimed = originalClaim(input);
        vi.setSystemTime((now + 700) * 1_000);
        return claimed;
      });
      const genericFallback = vi.spyOn(ctx.deps.store, "acceptOrchestratorHandoff");

      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "handoff-accept", fixture.source.id,
        "--token", fixture.token,
        "--provider", "codex",
        "--attestation-handle", handle,
      ], { from: "user" });

      const launch = ctx.deps.store.getSuccessorLaunch(fixture.launch.id);
      const source = ctx.deps.store.getOrchestratorSession(fixture.source.id);
      expect(ctx.exitCodes).toEqual([1]);
      expect(launch).toMatchObject({
        status: "stop_pending",
        stopFenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(launch?.handoffTokenFenceHash).not.toBe(hash(fixture.token));
      expect(source).toMatchObject({
        status: "handoff_pending",
        handoffTokenHash: launch?.handoffTokenFenceHash,
      });
      expect(genericFallback).not.toHaveBeenCalled();
    });
  });

  describe("contract §71 SessionStart helper", () => {
    it("startup は exact runtime をattestし、成功時だけ Codex additionalContext に raw handle を返す", async () => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, "helper-startup");
      installHookInput(ctx, fixture);
      await runAttest(ctx);

      expect(ctx.exitCodes).toEqual([]);
      const handle = extractAttestationHandle(ctx.stdout.text());
      expect(handle).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)).toMatchObject({
        status: "attested",
        providerSessionId: `codex-${fixture.tmuxSession}`,
        providerSessionSource: "codex-session-start",
      });
    });

    it("resume は同一handleをTTL延長なしで再提示する", async () => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, "helper-resume");
      installHookInput(ctx, fixture, "startup");
      await runAttest(ctx);
      const firstHandle = extractAttestationHandle(ctx.stdout.text());
      const firstExpiry = ctx.deps.store.getSuccessorLaunch(fixture.launch.id)?.attestationExpiresAt;

      ctx.stdout.clear();
      installHookInput(ctx, fixture, "resume");
      await runAttest(ctx);
      expect(extractAttestationHandle(ctx.stdout.text())).toBe(firstHandle);
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)?.attestationExpiresAt).toBe(firstExpiry);
    });

    it("inert 3 fieldの値が変わっても同じexact runtime rowを使いauthority inputへ渡さない", async () => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, "helper-inert-fields");
      const attest = vi.spyOn(ctx.deps.store, "attestSuccessorLaunch");
      installHookInput(ctx, fixture, "startup", {
        transcriptPath: "/first/transcript.jsonl",
        model: "gpt-5.6-sol",
        permissionMode: "default",
      });
      await runAttest(ctx);
      const firstHandle = extractAttestationHandle(ctx.stdout.text());

      ctx.stdout.clear();
      installHookInput(ctx, fixture, "resume", {
        transcriptPath: "/unrelated/changed/transcript.jsonl",
        model: "future-model-name",
        permissionMode: "plan",
      });
      await runAttest(ctx);
      const secondHandle = extractAttestationHandle(ctx.stdout.text());
      const firstInput = attest.mock.calls[0]?.[0];
      const secondInput = attest.mock.calls[1]?.[0];
      if (firstInput === undefined || secondInput === undefined) {
        throw new Error("attestSuccessorLaunch authority input を取得できません");
      }
      const { source: firstSource, ...firstAuthority } = firstInput;
      const { source: secondSource, ...secondAuthority } = secondInput;

      expect([firstSource, secondSource]).toEqual(["startup", "resume"]);
      expect(secondAuthority).toEqual(firstAuthority);
      expect(firstAuthority).not.toHaveProperty("transcriptPath");
      expect(firstAuthority).not.toHaveProperty("model");
      expect(firstAuthority).not.toHaveProperty("permissionMode");
      expect(secondHandle).toBe(firstHandle);
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)?.status).toBe("attested");
    });

    it("consume 後の resume は既存 binding を維持し handle/binding を新規作成しない", async () => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, "helper-consumed-resume");
      installHookInput(ctx, fixture, "startup");
      await runAttest(ctx);
      const handle = extractAttestationHandle(ctx.stdout.text());
      ctx.stdout.clear();
      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "handoff-accept", fixture.source.id,
        "--token", fixture.token,
        "--provider", "codex",
        "--attestation-handle", handle,
      ], { from: "user" });
      const successorId = ctx.deps.store.getSuccessorLaunch(fixture.launch.id)?.successorSessionId;

      ctx.stdout.clear();
      installHookInput(ctx, fixture, "resume");
      await runAttest(ctx);
      expect(ctx.stdout.text()).toBe("");
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)).toMatchObject({
        status: "succeeded",
        successorSessionId: successorId,
      });
      expect(ctx.deps.store.listOrchestratorSessions(fixture.source.orchestratorId)).toHaveLength(2);
    });

    it.each(["compact", "clear"] as const)("%s は tmux/DB authority を作らない正常 no-op", async (source) => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, `helper-${source}`);
      installHookInput(ctx, fixture, source);
      ctx.deps.processEnv = {};
      const readback = vi.fn(() => { throw new Error("呼ばれてはいけません"); });
      ctx.deps.successorTmuxReadback = {
        readExactPane: readback,
        initializeServerLifetimeAndReadExactPane: readback,
      };
      await runAttest(ctx);
      expect(ctx.exitCodes).toEqual([]);
      expect(ctx.stdout.text()).toBe("");
      expect(readback).not.toHaveBeenCalled();
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)?.status).toBe("runtime_bound");
    });

    it.each([
      ["TMUX_PANE 欠落", () => { ctx.deps.processEnv = {}; }],
      ["TMUX_PANE 不正", () => { ctx.deps.processEnv = { TMUX_PANE: "42" }; }],
      ["same-cwd 別pane", () => {
        ctx.deps.processEnv = { TMUX_PANE: "%43" };
        ctx.deps.successorTmuxReadback = {
          readExactPane: () => ({
            ok: true,
            value: {
              tmuxSession: "tmux-helper-drift",
              tmuxPane: "%43",
              panePid: 42_001,
              processGroupId: 42_101,
              cwd: ctx.deps.canonicalizeSuccessorCwd("/repo/helper-drift"),
              ownerNonce: "owner-helper-drift",
              tmuxSocketPath: "/tmp/tmux-successor/helper-drift",
              tmuxServerPid: 42_201,
              tmuxServerStartTime: 1_800_000_001,
              tmuxServerLifetimeHash: hash("server-lifetime-helper-drift"),
            },
          }),
          initializeServerLifetimeAndReadExactPane: () => ({ ok: false, reason: "unavailable" }),
        };
      }],
      ["owner 不一致", () => {
        transformExactReadback(ctx, (value) => ({ ...value, ownerNonce: "wrong-owner" }));
      }],
      ["hook hash 不一致", () => {
        ctx.deps.successorAttestationHashProbe = {
          readInstalledHashes: () => ({
            hookDefinitionHash: hash("wrong-definition"),
            hookExecutableHash: hash("wrong-helper"),
          }),
        };
      }],
      ["cwd 不一致", () => {
        transformExactReadback(ctx, (value) => ({ ...value, cwd: "/repo/other" }));
      }],
      ["host 不一致", () => { ctx.deps.currentHostId = () => "host-other"; }],
      ["PID 不一致", () => {
        transformExactReadback(ctx, (value) => ({ ...value, panePid: 99_001 }));
      }],
      ["PGID 不一致", () => {
        transformExactReadback(ctx, (value) => ({ ...value, processGroupId: 99_101 }));
      }],
    ] as const)("%s は authority 0 で fail-closed", async (_label, mutate) => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, "helper-drift");
      installHookInput(ctx, fixture);
      mutate();
      await runAttest(ctx);
      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.stdout.text()).not.toContain("attestation handle");
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)?.status).toBe("runtime_bound");
    });

    it.each([
      ["startup", "missing"],
      ["startup", "malformed"],
      ["startup", "drift"],
      ["resume", "missing"],
      ["resume", "malformed"],
      ["resume", "drift"],
    ] as const)("%s のserver lifetime %sは初期化せずattestation mutation 0", async (source, reason) => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, `helper-lifetime-${source}-${reason}`);
      installHookInput(ctx, fixture, "startup");
      if (source === "resume") {
        await runAttest(ctx);
        ctx.stdout.clear();
        ctx.stderr.clear();
        ctx.exitCodes.length = 0;
        installHookInput(ctx, fixture, "resume");
      }
      const before = ctx.deps.store.getSuccessorLaunch(fixture.launch.id)!;
      const initialize = vi.fn(() => { throw new Error("attestから呼ばれてはいけません"); });
      ctx.deps.successorTmuxReadback = {
        readExactPane: () => ({ ok: false, reason }),
        initializeServerLifetimeAndReadExactPane: initialize,
      };

      await runAttest(ctx);

      expect(initialize).not.toHaveBeenCalled();
      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.stderr.text()).toContain(
        `SUCCESSOR_SERVER_LIFETIME_MISMATCH: slot=${fixture.launch.id} expected=known observed=${reason}; ` +
        "attestation/final authority=0; exact rollback required",
      );
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)).toMatchObject({
        status: before.status,
        revision: before.revision,
        providerSessionId: before.providerSessionId,
      });
    });

    it("consume後resumeも旧server lifetimeへ戻らずfresh driftをauthority 0にする", async () => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, "helper-consumed-lifetime-drift");
      installHookInput(ctx, fixture, "startup");
      await runAttest(ctx);
      const handle = extractAttestationHandle(ctx.stdout.text());
      ctx.stdout.clear();
      await buildProgram(ctx.deps).parseAsync([
        "orchestrator", "session", "handoff-accept", fixture.source.id,
        "--token", fixture.token,
        "--provider", "codex",
        "--attestation-handle", handle,
      ], { from: "user" });
      const succeeded = ctx.deps.store.getSuccessorLaunch(fixture.launch.id)!;
      ctx.stdout.clear();
      ctx.stderr.clear();
      ctx.exitCodes.length = 0;
      installHookInput(ctx, fixture, "resume");
      transformExactReadback(ctx, (value) => ({
        ...value,
        tmuxServerLifetimeHash: hash("restarted-server-lifetime"),
      }));

      await runAttest(ctx);

      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.stderr.text()).toContain(`slot=${fixture.launch.id} expected=known observed=drift`);
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)).toMatchObject({
        status: "succeeded",
        revision: succeeded.revision,
        successorSessionId: succeeded.successorSessionId,
      });
    });

    it("Store の exactly-one 結果が0/複数相当の nullなら候補を推測選択しない", async () => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, "helper-not-unique");
      installHookInput(ctx, fixture);
      const attest = vi.spyOn(ctx.deps.store, "attestSuccessorLaunch").mockReturnValue(null);
      await runAttest(ctx);
      expect(attest).toHaveBeenCalledOnce();
      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)?.status).toBe("runtime_bound");
    });

    it("Gate 4 publication前のproduction hash probeはhelperを非0でfail-closedにする", async () => {
      ctx = createTestDeps();
      const fixture = armAndBind(ctx, "helper-unconfigured-production-probe");
      installHookInput(ctx, fixture);
      ctx.deps.successorAttestationHashProbe = unconfiguredSuccessorAttestationHashProbe;

      await runAttest(ctx);

      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.stderr.text()).toContain("Gate 4 publication 前のため未構成");
      expect(ctx.stdout.text()).toBe("");
      expect(ctx.deps.store.getSuccessorLaunch(fixture.launch.id)?.status).toBe("runtime_bound");
    });

    it.each([
      ["invalid JSON", "{"],
      ["array", "[]"],
      ["schema欠落", JSON.stringify({ session_id: "s" })],
      ["SubagentStart", JSON.stringify({
        session_id: "s", cwd: "/repo", source: "startup", hook_event_name: "SubagentStart",
      })],
      ["agent_id", JSON.stringify({
        session_id: "s", cwd: "/repo", source: "startup", hook_event_name: "SessionStart", agent_id: "a",
      })],
      ["unknown source", JSON.stringify({
        session_id: "s", cwd: "/repo", source: "fork", hook_event_name: "SessionStart",
      })],
      ["unknown permission mode", JSON.stringify({
        session_id: "s", cwd: "/repo", source: "startup", hook_event_name: "SessionStart",
        permission_mode: "danger-full-access",
      })],
      ["unknown field", JSON.stringify({
        session_id: "s", cwd: "/repo", source: "startup", hook_event_name: "SessionStart", extra: true,
      })],
      ["duplicate root key", '{"session_id":"first","session\\u005fid":"second","cwd":"/repo",' +
        '"source":"startup","hook_event_name":"SessionStart"}'],
      ["oversize", "x".repeat(16_385)],
    ])("stdin %s をsize/schema検証で拒否する", async (_label, raw) => {
      ctx = createTestDeps();
      ctx.deps.stdin = { read: async () => raw };
      await runAttest(ctx);
      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.stdout.text()).toBe("");
    });
  });
});
