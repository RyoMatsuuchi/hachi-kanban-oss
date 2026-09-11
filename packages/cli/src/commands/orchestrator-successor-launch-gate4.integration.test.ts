import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OrchestratorSessionRow,
  OrchestratorSuccessorLaunchKind,
  OrchestratorSuccessorLaunchRow,
} from "@hachi/core";
import type {
  SuccessorAttestationArtifactFileSystem,
  SuccessorAttestationArtifactResolver,
} from "../successor-attestation-artifacts.js";
import {
  CODEX_SUCCESSOR_ATTESTATION_MANIFEST_RELATIVE_PATH,
  CODEX_SUCCESSOR_HOOK_COMMAND,
  CODEX_SUCCESSOR_HOOK_MATCHER,
  CODEX_SUCCESSOR_HOOK_TIMEOUT_SECONDS,
  CODEX_SUCCESSOR_MANIFEST_SCHEMA,
  CODEX_SUCCESSOR_SESSION_START_GROUP,
  SuccessorAttestationArtifactError,
  createSuccessorAttestationArtifactResolver,
  expectedCodexSuccessorHookDefinitionHash,
} from "../successor-attestation-artifacts.js";
import type { SuccessorLaunchClock, TmuxLauncher } from "../deps.js";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

class Gate4Clock implements SuccessorLaunchClock {
  currentMs = 1_800_000_000_000;

  nowMs(): number {
    return this.currentMs;
  }

  sleep(ms: number): Promise<void> {
    this.currentMs += ms;
    return Promise.resolve();
  }

  nowSeconds(): number {
    return Math.floor(this.currentMs / 1_000);
  }
}

interface BoundFixture {
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

function armAndBind(
  ctx: TestDeps,
  clock: Gate4Clock,
  suffix: string,
  kind: OrchestratorSuccessorLaunchKind = "handoff",
): BoundFixture {
  const orchestrator = ctx.deps.store.registerOrchestrator({
    label: `gate4-${suffix}`,
    project: "gate4-offline",
    repoCommonDir: `/repo/${suffix}/.git`,
  });
  const source = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
  if (kind === "takeover") {
    ctx.deps.store.heartbeatOrchestratorSession(
      source.id,
      source.generation,
      clock.nowSeconds() - 200,
    );
  }
  const token = `token-${suffix}`;
  const cwd = `/repo/${suffix}`;
  const hostId = `host-${suffix}`;
  const tmuxSession = `tmux-${suffix}`;
  const tmuxPane = "%74";
  const panePid = 74_001;
  const processGroupId = 74_101;
  const tmuxSocketPath = `/tmp/tmux-gate4/${suffix}`;
  const tmuxServerPid = 74_201;
  const tmuxServerStartTime = 1_800_000_001;
  const tmuxServerLifetimeHash = hash(`server-lifetime-${suffix}`);
  const ownerNonce = `owner-${suffix}`;
  const hookDefinitionHash = hash(`hook-${suffix}`);
  const hookExecutableHash = hash(`helper-${suffix}`);
  const armed = ctx.deps.store.armSuccessorLaunch({
    orchestratorId: orchestrator.id,
    targetProvider: "codex",
    sourceSessionId: source.id,
    sourceGeneration: source.generation,
    canonicalCwd: cwd,
    hostId,
    launchNonceHash: hash(`launch-${suffix}`),
    plannedTmuxSession: tmuxSession,
    hookDefinitionHash,
    hookExecutableHash,
    runtimeDeadlineAt: clock.nowSeconds() + 300,
    attestationDeadlineAt: clock.nowSeconds() + 600,
    ...(kind === "handoff"
      ? {
        kind: "handoff" as const,
        handoffTokenFenceHash: hash(token),
        handoffExpiresAt: clock.nowSeconds() + 600,
      }
      : { kind: "takeover" as const, staleBefore: clock.nowSeconds() - 100 }),
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
    now: clock.nowSeconds(),
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
  fixture: BoundFixture,
  overrides: Partial<{
    tmuxPane: string;
    tmuxSession: string;
    panePid: number;
    processGroupId: number;
    tmuxSocketPath: string;
    tmuxServerPid: number;
    tmuxServerStartTime: number;
    tmuxServerLifetimeHash: string;
  }> = {},
): void {
  const tmuxPane = overrides.tmuxPane ?? fixture.tmuxPane;
  ctx.deps.stdin = {
    read: async () => JSON.stringify({
      session_id: `codex-${fixture.tmuxSession}`,
      cwd: fixture.cwd,
      source: "startup",
      hook_event_name: "SessionStart",
      transcript_path: "/inert/transcript.jsonl",
      model: "gpt-5.6-sol",
      permission_mode: "default",
    }),
  };
  ctx.deps.processEnv = { TMUX_PANE: tmuxPane };
  ctx.deps.successorTmuxReadback = {
    readExactPane: () => ({
      ok: true,
      value: {
        tmuxSession: overrides.tmuxSession ?? fixture.tmuxSession,
        tmuxPane,
        panePid: overrides.panePid ?? fixture.panePid,
        processGroupId: overrides.processGroupId ?? fixture.processGroupId,
        cwd: fixture.cwd,
        ownerNonce: fixture.ownerNonce,
        tmuxSocketPath: overrides.tmuxSocketPath ?? fixture.tmuxSocketPath,
        tmuxServerPid: overrides.tmuxServerPid ?? fixture.tmuxServerPid,
        tmuxServerStartTime: overrides.tmuxServerStartTime ?? fixture.tmuxServerStartTime,
        tmuxServerLifetimeHash: overrides.tmuxServerLifetimeHash ?? fixture.tmuxServerLifetimeHash,
      },
    }),
    initializeServerLifetimeAndReadExactPane: () => ({ ok: false, reason: "unavailable" }),
  };
  ctx.deps.currentHostId = () => fixture.hostId;
  ctx.deps.canonicalizeSuccessorCwd = (path) => path;
  ctx.deps.successorAttestationHashProbe = {
    readInstalledHashes: () => ({
      hookDefinitionHash: fixture.hookDefinitionHash,
      hookExecutableHash: fixture.hookExecutableHash,
    }),
  };
}

async function attest(ctx: TestDeps): Promise<string> {
  await buildProgram(ctx.deps).parseAsync(
    ["orchestrator", "successor-launch", "attest"],
    { from: "user" },
  );
  const parsed = JSON.parse(ctx.stdout.text()) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
  const match = /handle: ([A-Za-z0-9_-]+)/.exec(parsed.hookSpecificOutput.additionalContext);
  if (match?.[1] === undefined) throw new Error("SessionStart output schema にhandleがありません");
  return match[1];
}

function registerIdentity(ctx: TestDeps, suffix: string): string {
  return ctx.deps.store.registerOrchestrator({
    label: `gate4-pair-${suffix}`,
    project: "gate4-offline",
    repoCommonDir: `/repo/pair-${suffix}/.git`,
  }).id;
}

interface PublishedArtifactFixture {
  root: string;
  hachiHome: string;
  codexHome: string;
  hooksPath: string;
  helperPath: string;
  manifestPath: string;
  helperBytes: Buffer;
  resolver: SuccessorAttestationArtifactResolver;
}

const artifactRoots: string[] = [];

function installedHooks(groups: unknown[]): string {
  return `${JSON.stringify({
    hooks: {
      SessionStart: [
        { matcher: "startup|resume", hooks: [{ type: "command", command: "other setup" }] },
        ...groups,
      ],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other guard" }] }],
    },
  }, null, 2)}\n`;
}

function createPublishedArtifacts(): PublishedArtifactFixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hachi-gate4-integration-")));
  artifactRoots.push(root);
  const hachiHome = join(root, "hachi");
  const codexHome = join(root, "codex");
  const hooksPath = join(codexHome, "hooks.json");
  const helperPath = join(root, "bin", "hachi");
  const manifestPath = join(hachiHome, CODEX_SUCCESSOR_ATTESTATION_MANIFEST_RELATIVE_PATH);
  mkdirSync(dirname(manifestPath), { recursive: true });
  mkdirSync(codexHome);
  mkdirSync(dirname(helperPath));
  writeFileSync(hooksPath, installedHooks([CODEX_SUCCESSOR_SESSION_START_GROUP]), { mode: 0o644 });
  chmodSync(hooksPath, 0o644);
  const helperBytes = Buffer.from("#!/bin/sh\nexec node /reviewed/helper.mjs \"$@\"\n");
  writeFileSync(helperPath, helperBytes, { mode: 0o755 });
  chmodSync(helperPath, 0o755);
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: CODEX_SUCCESSOR_MANIFEST_SCHEMA,
    codexHome,
    installedHooksPath: hooksPath,
    helperExecutablePath: helperPath,
    expectedHookDefinitionHash: expectedCodexSuccessorHookDefinitionHash(),
    expectedHelperExecutableHash: hash(helperBytes),
  }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  return {
    root,
    hachiHome,
    codexHome,
    hooksPath,
    helperPath,
    manifestPath,
    helperBytes,
    resolver: createSuccessorAttestationArtifactResolver({
      hachiStateHome: hachiHome,
      processEnv: { CODEX_HOME: codexHome, PATH: dirname(helperPath) },
      osHome: root,
    }),
  };
}

function resolverCode(resolver: SuccessorAttestationArtifactResolver): string {
  try {
    resolver.resolveInstalledArtifacts();
    return "ok";
  } catch (err) {
    if (!(err instanceof SuccessorAttestationArtifactError)) throw err;
    return err.code;
  }
}

describe("Gate 4A offline integration surface", () => {
  let contexts: TestDeps[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const ctx of contexts) ctx.cleanup();
    contexts = [];
    while (artifactRoots.length > 0) {
      rmSync(artifactRoots.pop()!, { recursive: true, force: true });
    }
  });

  function newContext(clock: Gate4Clock): TestDeps {
    const ctx = createTestDeps();
    ctx.deps.successorLaunchClock = clock;
    contexts.push(ctx);
    return ctx;
  }

  it("same-cwd cross-paneを拒否し、takeover arm後のheartbeat revivalをfinalで再拒否する", async () => {
    const clock = new Gate4Clock();
    const crossPaneCtx = newContext(clock);
    const crossPane = armAndBind(crossPaneCtx, clock, "cross-pane");
    installHookInput(crossPaneCtx, crossPane, {
      tmuxPane: "%99",
      tmuxSession: "other-tmux-same-cwd",
    });
    await buildProgram(crossPaneCtx.deps).parseAsync(
      ["orchestrator", "successor-launch", "attest"],
      { from: "user" },
    );
    expect(crossPaneCtx.exitCodes).toEqual([1]);
    expect(crossPaneCtx.stdout.text()).toBe("");
    expect(crossPaneCtx.deps.store.getSuccessorLaunch(crossPane.launch.id)?.status).toBe("runtime_bound");

    const revivalCtx = newContext(clock);
    const revival = armAndBind(revivalCtx, clock, "heartbeat-revival", "takeover");
    revivalCtx.deps.store.heartbeatOrchestratorSession(
      revival.source.id,
      revival.source.generation,
      clock.nowSeconds(),
    );
    installHookInput(revivalCtx, revival);
    const handle = await attest(revivalCtx);
    revivalCtx.stdout.clear();
    await buildProgram(revivalCtx.deps).parseAsync([
      "orchestrator", "session", "takeover", revival.source.orchestratorId,
      "--provider", "codex",
      "--attestation-handle", handle,
    ], { from: "user" });
    expect(revivalCtx.exitCodes).toEqual([1]);
    expect(revivalCtx.deps.store.getSuccessorLaunch(revival.launch.id)?.status).toBe("stop_pending");
    expect(revivalCtx.deps.store.getOrchestratorSession(revival.source.id)?.status).toBe("active");
  });

  it("final transaction crash/replayは同じclaimへ収束し、handoff timeoutはtokenを回転する", async () => {
    const clock = new Gate4Clock();
    const replayCtx = newContext(clock);
    const replay = armAndBind(replayCtx, clock, "final-replay");
    installHookInput(replayCtx, replay);
    const handle = await attest(replayCtx);
    replayCtx.stdout.clear();
    const final = vi.spyOn(replayCtx.deps.store, "acceptOrchestratorHandoffWithSuccessorLaunch")
      .mockImplementationOnce(() => { throw new Error("final transaction crash"); });
    const args = [
      "orchestrator", "session", "handoff-accept", replay.source.id,
      "--token", replay.token,
      "--provider", "codex",
      "--attestation-handle", handle,
      "--json",
    ];
    await buildProgram(replayCtx.deps).parseAsync(args, { from: "user" });
    expect(replayCtx.deps.store.getSuccessorLaunch(replay.launch.id)?.status).toBe("accepting");
    final.mockRestore();
    replayCtx.stdout.clear();
    await buildProgram(replayCtx.deps).parseAsync(args, { from: "user" });
    expect(replayCtx.deps.store.getSuccessorLaunch(replay.launch.id)?.status).toBe("succeeded");
    expect(replayCtx.deps.store.listOrchestratorSessions(replay.source.orchestratorId)).toHaveLength(2);

    vi.useFakeTimers();
    vi.setSystemTime(clock.nowMs());
    const timeoutCtx = newContext(clock);
    const timeout = armAndBind(timeoutCtx, clock, "token-timeout");
    installHookInput(timeoutCtx, timeout);
    const timeoutHandle = await attest(timeoutCtx);
    timeoutCtx.stdout.clear();
    const originalClaim = timeoutCtx.deps.store.claimSuccessorLaunchAccept.bind(timeoutCtx.deps.store);
    vi.spyOn(timeoutCtx.deps.store, "claimSuccessorLaunchAccept").mockImplementation((input) => {
      const claimed = originalClaim(input);
      vi.setSystemTime(clock.nowMs() + 700_000);
      return claimed;
    });
    await buildProgram(timeoutCtx.deps).parseAsync([
      "orchestrator", "session", "handoff-accept", timeout.source.id,
      "--token", timeout.token,
      "--provider", "codex",
      "--attestation-handle", timeoutHandle,
    ], { from: "user" });
    const timedOut = timeoutCtx.deps.store.getSuccessorLaunch(timeout.launch.id);
    expect(timedOut?.status).toBe("stop_pending");
    expect(timedOut?.handoffTokenFenceHash).not.toBe(hash(timeout.token));
    expect(timeoutCtx.deps.store.getOrchestratorSession(timeout.source.id)).toMatchObject({
      status: "handoff_pending",
      handoffTokenHash: timedOut?.handoffTokenFenceHash,
    });
  });

  it("stop_pendingを三点停止でstoppedへ、残存証拠でuncertainへ遷移しexplicit recoveryする", async () => {
    const clock = new Gate4Clock();
    const ctx = newContext(clock);
    const stoppedFixture = armAndBind(ctx, clock, "stop-complete");
    const stoppedPending = ctx.deps.store.markSuccessorLaunchStopPending({
      slotId: stoppedFixture.launch.id,
      expectedRevision: stoppedFixture.launch.revision,
      expectedStatus: "runtime_bound",
      error: "offline stop proof",
      replacementHandoffTokenHash: hash("rotated-stop-complete"),
      now: clock.nowSeconds(),
    });
    const stopped = ctx.deps.store.recordSuccessorLaunchStop({
      slotId: stoppedPending.launch.id,
      expectedRevision: stoppedPending.launch.revision,
      stopFenceHash: hash(stoppedPending.stopFence),
      killOwnerReadbackHash: hash(stoppedFixture.ownerNonce),
      evidence: {
        ownerMatched: true,
        ownerReadbackAt: clock.nowSeconds(),
        killResult: "succeeded",
        tmuxSessionAbsent: true,
        panePidAbsent: true,
        processGroupAbsent: true,
        observedAt: clock.nowSeconds(),
      },
      now: clock.nowSeconds(),
    });
    expect(stopped.status).toBe("stopped");

    const uncertainFixture = armAndBind(ctx, clock, "stop-uncertain");
    const uncertainPending = ctx.deps.store.markSuccessorLaunchStopPending({
      slotId: uncertainFixture.launch.id,
      expectedRevision: uncertainFixture.launch.revision,
      expectedStatus: "runtime_bound",
      error: "offline uncertain proof",
      replacementHandoffTokenHash: hash("rotated-stop-uncertain"),
      now: clock.nowSeconds(),
    });
    const uncertain = ctx.deps.store.recordSuccessorLaunchStop({
      slotId: uncertainPending.launch.id,
      expectedRevision: uncertainPending.launch.revision,
      stopFenceHash: hash(uncertainPending.stopFence),
      killOwnerReadbackHash: hash(uncertainFixture.ownerNonce),
      evidence: {
        ownerMatched: true,
        ownerReadbackAt: clock.nowSeconds(),
        killResult: "unknown",
        tmuxSessionAbsent: false,
        panePidAbsent: null,
        processGroupAbsent: null,
        observedAt: clock.nowSeconds(),
      },
      now: clock.nowSeconds(),
    });
    expect(uncertain.status).toBe("uncertain");

    const absentRuntime: TmuxLauncher = {
      launch: () => ({ ok: false, reason: "offline-only" }),
      hasSession: () => false,
      getPaneRootPid: () => null,
      killSession: () => { throw new Error("rollback-completeはkillしません"); },
      getProcessGroupId: () => uncertainFixture.processGroupId,
      isProcessGroupAlive: () => false,
      setSessionOwnerNonce: () => false,
      getSessionOwnerNonce: () => null,
      isPaneProcessAlive: () => false,
    };
    ctx.deps.tmuxLauncher = absentRuntime;
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([
      "orchestrator", "successor-launch", "rollback-complete",
      "--slot", uncertain.id,
      "--fence", uncertainPending.stopFence,
      "--apply",
      "--json",
    ], { from: "user" });
    expect(ctx.deps.store.getSuccessorLaunch(uncertain.id)?.status).toBe("stopped");
  });

  it("manual/enforce入力行列とClaude pairを維持し、既存handover dry-runを非回帰にする", async () => {
    const clock = new Gate4Clock();
    const ctx = newContext(clock);
    const manualId = registerIdentity(ctx, "manual-codex");
    const manualSource = ctx.deps.store.startOrchestratorSession({ orchestratorId: manualId });
    const manualToken = "manual-token";
    ctx.deps.store.prepareOrchestratorHandoff(
      manualSource.id,
      manualSource.generation,
      hash(manualToken),
      clock.nowSeconds() + 600,
    );
    await buildProgram(ctx.deps).parseAsync([
      "orchestrator", "session", "handoff-accept", manualSource.id,
      "--token", manualToken,
      "--provider", "codex",
      "--provider-session-id", "codex-manual-session",
    ], { from: "user" });
    expect(ctx.deps.store.listOrchestratorSessions(manualId).at(-1)?.providerSessionSource).toBe("manual");

    ctx.deps.config.orchestrator = { codexSuccessorAttestation: { mode: "enforce" } };
    const enforceId = registerIdentity(ctx, "enforce-codex");
    const enforceSource = ctx.deps.store.startOrchestratorSession({ orchestratorId: enforceId });
    const enforceToken = "enforce-token";
    ctx.deps.store.prepareOrchestratorHandoff(
      enforceSource.id,
      enforceSource.generation,
      hash(enforceToken),
      clock.nowSeconds() + 600,
    );
    await buildProgram(ctx.deps).parseAsync([
      "orchestrator", "session", "handoff-accept", enforceSource.id,
      "--token", enforceToken,
      "--provider", "codex",
      "--provider-session-id", "codex-unattested-session",
    ], { from: "user" });
    expect(ctx.deps.store.getOrchestratorSession(enforceSource.id)?.status).toBe("handoff_pending");

    const claudeId = registerIdentity(ctx, "claude-pair");
    const claudeSource = ctx.deps.store.startOrchestratorSession({ orchestratorId: claudeId });
    const claudeToken = "claude-token";
    ctx.deps.store.prepareOrchestratorHandoff(
      claudeSource.id,
      claudeSource.generation,
      hash(claudeToken),
      clock.nowSeconds() + 600,
    );
    await buildProgram(ctx.deps).parseAsync([
      "orchestrator", "session", "handoff-accept", claudeSource.id,
      "--token", claudeToken,
      "--provider", "claude",
      "--provider-session-id", "claude-normal-session",
    ], { from: "user" });
    const claudeSuccessor = ctx.deps.store.listOrchestratorSessions(claudeId).at(-1)!;
    expect(claudeSuccessor).toMatchObject({
      provider: "claude",
      providerSessionId: "claude-normal-session",
      providerSessionSource: "manual",
    });

    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.isDirectory = () => true;
    const mission = ctx.deps.store.createTask({
      title: "Gate 4 Claude handover regression",
      body: "cwd: /repo/gate4-claude-handover\n\noffline fixture",
      tenant: "dev",
      status: "ready",
    }, "gate4-test");
    ctx.deps.store.bindTaskToOrchestrator(mission.id, claudeId, "primary");
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([
      "orchestrator", "handover",
      "--session", claudeSuccessor.id,
      "--generation", String(claudeSuccessor.generation),
      "--mission", mission.id,
      "--json",
    ], { from: "user" });
    const dryRun = JSON.parse(ctx.stdout.text()) as {
      blocked: boolean;
      tmuxArgs: string[];
      handoffPreparePreview: { sessionId: string };
    };
    if (dryRun.blocked === undefined) {
      throw new Error(`handover dry-run outputが不正です: ${JSON.stringify(dryRun)}`);
    }
    expect(dryRun.blocked).toBe(false);
    expect(dryRun.handoffPreparePreview.sessionId).toBe(claudeSuccessor.id);
    expect(dryRun.tmuxArgs.join(" ")).toContain("claude");
    expect(ctx.deps.store.getOrchestratorSession(claudeSuccessor.id)?.status).toBe("active");
  });

  it("static templateとpublication resolverを実file/envで統合し、全driftをfail-closedにする", () => {
    expect(CODEX_SUCCESSOR_HOOK_COMMAND).toBe("hachi orchestrator successor-launch attest");
    expect(CODEX_SUCCESSOR_HOOK_MATCHER).toBe("startup|resume|clear|compact");
    expect(CODEX_SUCCESSOR_HOOK_TIMEOUT_SECONDS).toBeLessThan(15);
    const exact = createPublishedArtifacts();
    expect(exact.resolver.resolveInstalledArtifacts()).toMatchObject({
      hookDefinitionHash: expectedCodexSuccessorHookDefinitionHash(),
      hookExecutableHash: hash(exact.helperBytes),
    });

    const duplicate = createPublishedArtifacts();
    writeFileSync(duplicate.hooksPath, installedHooks([
      CODEX_SUCCESSOR_SESSION_START_GROUP,
      CODEX_SUCCESSOR_SESSION_START_GROUP,
    ]));
    expect(resolverCode(duplicate.resolver)).toBe("hook_definition_duplicate");

    const fieldDrift = createPublishedArtifacts();
    writeFileSync(fieldDrift.hooksPath, installedHooks([{
      ...CODEX_SUCCESSOR_SESSION_START_GROUP,
      unexpected: true,
    }]));
    expect(resolverCode(fieldDrift.resolver)).toBe("hook_definition_drift");

    const hashDrift = createPublishedArtifacts();
    writeFileSync(hashDrift.helperPath, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    chmodSync(hashDrift.helperPath, 0o755);
    expect(resolverCode(hashDrift.resolver)).toBe("helper_hash_mismatch");

    const codexHomeDrift = createPublishedArtifacts();
    const otherHome = join(codexHomeDrift.root, "other-codex");
    mkdirSync(otherHome);
    expect(resolverCode(createSuccessorAttestationArtifactResolver({
      hachiStateHome: codexHomeDrift.hachiHome,
      processEnv: { CODEX_HOME: otherHome, PATH: dirname(codexHomeDrift.helperPath) },
      osHome: codexHomeDrift.root,
    }))).toBe("codex_home_mismatch");

    const helperDrift = createPublishedArtifacts();
    const earlierBin = join(helperDrift.root, "earlier-bin");
    mkdirSync(earlierBin);
    const earlierHelper = join(earlierBin, "hachi");
    writeFileSync(earlierHelper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(earlierHelper, 0o755);
    expect(resolverCode(createSuccessorAttestationArtifactResolver({
      hachiStateHome: helperDrift.hachiHome,
      processEnv: {
        CODEX_HOME: helperDrift.codexHome,
        PATH: `${earlierBin}:${dirname(helperDrift.helperPath)}`,
      },
      osHome: helperDrift.root,
    }))).toBe("helper_path_mismatch");

    const symlinkSwap = createPublishedArtifacts();
    let readCount = 0;
    const swappingFs: SuccessorAttestationArtifactFileSystem = {
      lstat: (path) => lstatSync(path, { bigint: true }),
      realpath: (path) => realpathSync.native(path),
      openNoFollow: (path) => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
      readFile(fd): Buffer {
        const bytes = readFileSync(fd);
        readCount += 1;
        if (readCount === 2) {
          const opened = join(symlinkSwap.codexHome, "hooks.opened.json");
          const replacement = join(symlinkSwap.codexHome, "hooks.replacement.json");
          renameSync(symlinkSwap.hooksPath, opened);
          writeFileSync(replacement, installedHooks([CODEX_SUCCESSOR_SESSION_START_GROUP]), { mode: 0o644 });
          symlinkSync(replacement, symlinkSwap.hooksPath);
        }
        return bytes;
      },
      fstat: (fd) => fstatSync(fd, { bigint: true }),
      close: (fd) => closeSync(fd),
      canExecute(path): boolean {
        try {
          accessSync(path, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
    };
    expect(resolverCode(createSuccessorAttestationArtifactResolver({
      hachiStateHome: symlinkSwap.hachiHome,
      processEnv: { CODEX_HOME: symlinkSwap.codexHome, PATH: dirname(symlinkSwap.helperPath) },
      osHome: symlinkSwap.root,
      fileSystem: swappingFs,
    }))).toBe("artifact_unstable");
  });
});
