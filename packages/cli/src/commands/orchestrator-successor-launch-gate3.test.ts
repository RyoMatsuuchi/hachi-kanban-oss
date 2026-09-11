import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OrchestratorSessionRow,
  OrchestratorSuccessorLaunchKind,
  OrchestratorSuccessorLaunchRow,
} from "@hachi/core";
import type {
  SuccessorLaunchClock,
  SuccessorLaunchRuntimeReadback,
  SuccessorTmuxReadback,
  SuccessorTmuxReadbackFailureReason,
  SuccessorTmuxReadbackResult,
  TmuxLauncher,
} from "../deps.js";
import { buildProgram } from "../program.js";
import { unconfiguredSuccessorAttestationHashProbe } from "../successor-attestation.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

const CWD = "/repo/gate3";
const HOST = "host-gate3";
const OWNER = "owner-gate3";
const LAUNCH = "launch-gate3";
const BARRIER = "barrier-gate3";
const TOKEN = "handoff-token-gate3";
const PANE = "%73";
const PANE_PID = 73_001;
const PGID = 73_101;
const TMUX_SOCKET_PATH = "/tmp/tmux-gate3/default";
const TMUX_SERVER_PID = 73_201;
const TMUX_SERVER_START_TIME = 1_800_000_001;
const SERVER_LIFETIME_NONCE = "l".repeat(43);
const TMUX_SERVER_LIFETIME_HASH = hash(
  `hachi-tmux-server-lifetime-v1\0${TMUX_SOCKET_PATH}\0${SERVER_LIFETIME_NONCE}`,
);
const HOOK_DEFINITION_HASH = hash("gate3-hook-definition");
const HOOK_EXECUTABLE_HASH = hash("gate3-hook-executable");

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class FakeClock implements SuccessorLaunchClock {
  currentMs = Math.floor(Date.now() / 1000) * 1000;
  sleptMs = 0;

  nowMs(): number {
    return this.currentMs;
  }

  sleep(ms: number): Promise<void> {
    this.currentMs += ms;
    this.sleptMs += ms;
    return Promise.resolve();
  }
}

class Gate3TmuxFake implements TmuxLauncher, SuccessorTmuxReadback {
  launchCalls: string[][] = [];
  releaseCalls: string[] = [];
  killCalls: string[] = [];
  ownerSetCalls: Array<{ sessionName: string; nonce: string }> = [];
  ownerReadCalls: string[] = [];
  statusAtLaunch = "";
  statusAtRelease = "";
  sessionName = "";
  ownerNonce: string | null = null;
  sessionAlive = false;
  paneAlive = false;
  groupAlive = false;
  ownerSetSucceeds = true;
  releaseSucceeds = true;
  launchFailure: string | null = null;
  launchThrows = false;
  killThrows = false;
  killSucceeds = true;
  stopRemaining = new Set<"session" | "pane" | "group">();
  runtimeTransform?: (runtime: SuccessorLaunchRuntimeReadback) => SuccessorLaunchRuntimeReadback;
  serverReadbackFailure: SuccessorTmuxReadbackFailureReason | null = null;
  tmuxServerLifetimeHash = TMUX_SERVER_LIFETIME_HASH;
  lifetimeInitializeCalls: string[] = [];
  onLaunch?: () => void;
  onRelease?: () => void;

  launch(args: string[]): { ok: true; pid: number } | { ok: false; reason: string } {
    this.launchCalls.push([...args]);
    this.onLaunch?.();
    if (this.launchThrows) throw new Error("spawn result unknown");
    if (this.launchFailure !== null) return { ok: false, reason: this.launchFailure };
    const sessionIndex = args.indexOf("-s");
    this.sessionName = args[sessionIndex + 1] ?? "";
    this.sessionAlive = true;
    this.paneAlive = true;
    this.groupAlive = true;
    return { ok: true, pid: 9001 };
  }

  hasSession(name: string): boolean {
    return name === this.sessionName && this.sessionAlive;
  }

  getPaneRootPid(name: string): number | null {
    return name === this.sessionName && this.paneAlive ? PANE_PID : null;
  }

  killSession(sessionName: string): boolean {
    this.killCalls.push(sessionName);
    if (this.killThrows) throw new Error("kill result unknown");
    if (!this.killSucceeds) return false;
    if (!this.stopRemaining.has("session")) this.sessionAlive = false;
    if (!this.stopRemaining.has("pane")) this.paneAlive = false;
    if (!this.stopRemaining.has("group")) this.groupAlive = false;
    return true;
  }

  getProcessGroupId(pid: number): number | null {
    return pid === PANE_PID ? PGID : null;
  }

  isProcessGroupAlive(pgid: number): boolean {
    return pgid === PGID && this.groupAlive;
  }

  setSessionOwnerNonce(name: string, nonce: string): boolean {
    this.ownerSetCalls.push({ sessionName: name, nonce });
    if (this.ownerSetSucceeds) this.ownerNonce = nonce;
    return this.ownerSetSucceeds;
  }

  getSessionOwnerNonce(name: string): string | null {
    this.ownerReadCalls.push(name);
    return name === this.sessionName && this.sessionAlive ? this.ownerNonce : null;
  }

  readSuccessorRuntime(sessionName: string): SuccessorLaunchRuntimeReadback {
    const runtime: SuccessorLaunchRuntimeReadback = {
      stable: true,
      tmuxSession: sessionName,
      tmuxPane: PANE,
      panePid: PANE_PID,
      processGroupId: PGID,
      cwd: CWD,
      ownerNonce: this.ownerNonce,
    };
    return this.runtimeTransform?.(runtime) ?? runtime;
  }

  readExactPane(tmuxPane: string): SuccessorTmuxReadbackResult {
    if (this.serverReadbackFailure !== null) {
      return { ok: false, reason: this.serverReadbackFailure };
    }
    const runtime = this.readSuccessorRuntime(this.sessionName);
    if (!runtime.stable || runtime.tmuxSession === null || runtime.tmuxPane !== tmuxPane ||
        runtime.panePid === null || runtime.processGroupId === null || runtime.cwd === null ||
        runtime.ownerNonce === null) {
      return { ok: false, reason: "unavailable" };
    }
    return {
      ok: true,
      value: {
        tmuxSession: runtime.tmuxSession,
        tmuxPane: runtime.tmuxPane,
        panePid: runtime.panePid,
        processGroupId: runtime.processGroupId,
        cwd: runtime.cwd,
        ownerNonce: runtime.ownerNonce,
        tmuxSocketPath: TMUX_SOCKET_PATH,
        tmuxServerPid: TMUX_SERVER_PID,
        tmuxServerStartTime: TMUX_SERVER_START_TIME,
        tmuxServerLifetimeHash: this.tmuxServerLifetimeHash,
      },
    };
  }

  initializeServerLifetimeAndReadExactPane(
    tmuxPane: string,
    nonceCandidate: string,
  ): SuccessorTmuxReadbackResult {
    this.lifetimeInitializeCalls.push(nonceCandidate);
    return this.readExactPane(tmuxPane);
  }

  releaseSuccessorBarrier(barrier: string): boolean {
    this.releaseCalls.push(barrier);
    this.onRelease?.();
    return this.releaseSucceeds;
  }

  isPaneProcessAlive(pid: number): boolean {
    return pid === PANE_PID && this.paneAlive;
  }
}

interface Fixture {
  ctx: TestDeps;
  clock: FakeClock;
  launcher: Gate3TmuxFake;
  source: OrchestratorSessionRow;
}

function createFixture(kind: OrchestratorSuccessorLaunchKind = "handoff"): Fixture {
  const ctx = createTestDeps();
  const clock = new FakeClock();
  const launcher = new Gate3TmuxFake();
  const orchestrator = ctx.deps.store.registerOrchestrator({
    label: `gate3-${kind}`,
    project: "gate3",
    repoCommonDir: "/repo/.git",
  });
  const source = ctx.deps.store.startOrchestratorSession({
    orchestratorId: orchestrator.id,
    provider: "codex",
    providerSessionId: `codex-source-${kind}`,
  });
  if (kind === "takeover") {
    ctx.deps.store.heartbeatOrchestratorSession(
      source.id,
      source.generation,
      Math.floor(clock.nowMs() / 1000) - 200,
    );
  }
  ctx.deps.tmuxLauncher = launcher;
  ctx.deps.successorTmuxReadback = launcher;
  ctx.deps.successorLaunchClock = clock;
  ctx.deps.successorLaunchStopPoll = { intervalMs: 10, timeoutMs: 30 };
  ctx.deps.canonicalizeSuccessorCwd = (path) => path;
  ctx.deps.currentHostId = () => HOST;
  ctx.deps.successorAttestationHashProbe = {
    readInstalledHashes: () => ({
      hookDefinitionHash: HOOK_DEFINITION_HASH,
      hookExecutableHash: HOOK_EXECUTABLE_HASH,
    }),
  };
  ctx.deps.newSuccessorLaunchNonce = () => LAUNCH;
  ctx.deps.newSuccessorOwnerNonce = () => OWNER;
  ctx.deps.newSuccessorBarrierNonce = () => BARRIER;
  ctx.deps.newSuccessorServerLifetimeNonce = () => SERVER_LIFETIME_NONCE;
  ctx.deps.newHandoffToken = () => TOKEN;
  return { ctx, clock, launcher, source };
}

function launchRow(fixture: Fixture): OrchestratorSuccessorLaunchRow {
  const rows = fixture.ctx.deps.store.listSuccessorLaunches();
  if (rows.length !== 1) throw new Error(`successor slot は1件の想定です: ${rows.length}`);
  return rows[0]!;
}

function finalizeFromRuntime(fixture: Fixture, kind: OrchestratorSuccessorLaunchKind): void {
  const row = launchRow(fixture);
  const attested = fixture.ctx.deps.store.attestSuccessorLaunch({
    providerSessionSource: "codex-session-start",
    source: "startup",
    providerSessionId: `codex-generated-${kind}`,
    canonicalCwd: row.canonicalCwd,
    hostId: row.hostId,
    tmuxSession: row.tmuxSession,
    tmuxPane: row.tmuxPane,
    panePid: row.panePid!,
    processGroupId: row.processGroupId!,
    tmuxSocketPath: row.tmuxSocketPath,
    tmuxServerPid: row.tmuxServerPid!,
    tmuxServerStartTime: row.tmuxServerStartTime!,
    tmuxServerLifetimeHash: row.tmuxServerLifetimeHash,
    ownerNonceHash: row.ownerNonceHash,
    hookDefinitionHash: row.hookDefinitionHash,
    hookExecutableHash: row.hookExecutableHash,
    now: row.createdAt + 1,
  });
  if (attested === null) throw new Error("test attestation に失敗しました");
  const claimed = fixture.ctx.deps.store.claimSuccessorLaunchAccept({
    slotId: row.id,
    expectedRevision: attested.launch.revision,
    attestationHandleHash: hash(attested.attestationHandle),
    operation: kind,
    now: row.createdAt + 2,
  });
  if (kind === "handoff") {
    fixture.ctx.deps.store.acceptOrchestratorHandoffWithSuccessorLaunch({
      slotId: row.id,
      expectedRevision: claimed.launch.revision,
      acceptFenceHash: hash(claimed.acceptFence),
      attestationHandleHash: hash(attested.attestationHandle),
      handoffTokenHash: hash(TOKEN),
      now: row.createdAt + 3,
    });
  } else {
    fixture.ctx.deps.store.takeoverStaleOrchestratorSessionWithSuccessorLaunch({
      slotId: row.id,
      expectedRevision: claimed.launch.revision,
      acceptFenceHash: hash(claimed.acceptFence),
      attestationHandleHash: hash(attested.attestationHandle),
      now: row.createdAt + 3,
    });
  }
}

async function runStart(fixture: Fixture, kind: OrchestratorSuccessorLaunchKind, json = true): Promise<void> {
  await buildProgram(fixture.ctx.deps).parseAsync([
    "orchestrator", "successor-launch", "start",
    "--kind", kind,
    "--source-session", fixture.source.id,
    "--generation", String(fixture.source.generation),
    "--cwd", CWD,
    "--stale-sec", "100",
    ...(json ? ["--json"] : []),
  ], { from: "user" });
}

describe("orchestrator successor-launch Gate 3", () => {
  let fixture: Fixture | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    fixture?.ctx.cleanup();
    fixture = null;
  });

  it("arm後だけspawnし、owner再readbackをbindしてからbarrierを一度releaseする", async () => {
    fixture = createFixture("handoff");
    fixture.launcher.onLaunch = () => {
      const row = launchRow(fixture!);
      fixture!.launcher.statusAtLaunch = row.status;
      expect(fixture!.ctx.deps.store.getOrchestratorSession(fixture!.source.id)?.status).toBe("handoff_pending");
    };
    fixture.launcher.onRelease = () => {
      fixture!.launcher.statusAtRelease = launchRow(fixture!).status;
      finalizeFromRuntime(fixture!, "handoff");
    };

    await runStart(fixture, "handoff");

    const row = launchRow(fixture);
    expect(fixture.launcher.statusAtLaunch).toBe("armed");
    expect(fixture.launcher.statusAtRelease).toBe("runtime_bound");
    expect(fixture.launcher.releaseCalls).toHaveLength(1);
    expect(fixture.launcher.ownerSetCalls).toEqual([
      { sessionName: row.plannedTmuxSession, nonce: OWNER },
    ]);
    expect(row).toMatchObject({
      status: "succeeded",
      targetProvider: "codex",
      launchNonceHash: hash(LAUNCH),
      ownerNonceHash: hash(OWNER),
      tmuxSocketPath: TMUX_SOCKET_PATH,
      tmuxServerPid: TMUX_SERVER_PID,
      tmuxServerStartTime: TMUX_SERVER_START_TIME,
      tmuxServerLifetimeHash: TMUX_SERVER_LIFETIME_HASH,
      handoffTokenFenceHash: hash(TOKEN),
    });
    expect(fixture.launcher.lifetimeInitializeCalls).toEqual([SERVER_LIFETIME_NONCE]);
    expect(row.runtimeDeadlineAt - row.createdAt).toBe(15);
    expect(row.attestationDeadlineAt - row.createdAt).toBe(30);
    const tmuxArgs = fixture.launcher.launchCalls[0]!;
    const prompt = tmuxArgs.at(-1)!;
    expect(prompt).toContain(`--token ${TOKEN}`);
    expect(prompt).toContain("--attestation-handle <additionalContextのhandle>");
    expect(prompt).not.toContain("--provider-session-id");
    expect(tmuxArgs.filter((value) => value.includes("exec codex"))).toHaveLength(1);
    const output = fixture.ctx.stdout.text();
    expect(output).not.toContain(OWNER);
    expect(output).not.toContain(LAUNCH);
    expect(output).not.toContain(BARRIER);
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(SERVER_LIFETIME_NONCE);
    expect(fixture.ctx.exitCodes).toEqual([]);
  });

  it("takeoverはarm時のstale cutoffを保存しtrusted finalで新しいcutoffを渡さない", async () => {
    fixture = createFixture("takeover");
    fixture.launcher.onRelease = () => finalizeFromRuntime(fixture!, "takeover");

    await runStart(fixture, "takeover");

    const row = launchRow(fixture);
    expect(row.status).toBe("succeeded");
    expect(row.takeoverStaleBefore).toBe(row.createdAt - 100);
    const prompt = fixture.launcher.launchCalls[0]!.at(-1)!;
    expect(prompt).toContain(`session takeover ${row.orchestratorId}`);
    expect(prompt).not.toContain("--stale-sec");
    expect(prompt).not.toContain(TOKEN);
  });

  it("保存済みattestation deadlineまでにsucceededしなければtokenを回転してexact三点停止をstoppedへ記録する", async () => {
    fixture = createFixture("handoff");

    await runStart(fixture, "handoff");

    const row = launchRow(fixture);
    expect(fixture.clock.sleptMs).toBeGreaterThanOrEqual(30_000);
    expect(fixture.launcher.releaseCalls).toHaveLength(1);
    expect(fixture.launcher.killCalls).toEqual([row.plannedTmuxSession]);
    expect(row.status).toBe("stopped");
    expect(row.stopEvidence).toMatchObject({
      ownerMatched: true,
      killResult: "succeeded",
      tmuxSessionAbsent: true,
      panePidAbsent: true,
      processGroupAbsent: true,
    });
    expect(fixture.ctx.deps.store.getOrchestratorSession(fixture.source.id)?.status).toBe("active");
    expect(fixture.ctx.exitCodes).toEqual([1]);
  });

  it("Gate 4 hash probe未構成はarm/spawn前にfail-closedする", async () => {
    fixture = createFixture("handoff");
    fixture.ctx.deps.successorAttestationHashProbe = unconfiguredSuccessorAttestationHashProbe;

    await runStart(fixture, "handoff");

    expect(fixture.ctx.deps.store.listSuccessorLaunches()).toEqual([]);
    expect(fixture.launcher.launchCalls).toEqual([]);
    expect(fixture.ctx.deps.store.getOrchestratorSession(fixture.source.id)?.status).toBe("active");
    expect(fixture.ctx.exitCodes).toEqual([1]);
  });

  it("spawnが未作成を返した場合はexact unbound rejectedでsourceを復元する", async () => {
    fixture = createFixture("handoff");
    fixture.launcher.launchFailure = "os error 35";

    await runStart(fixture, "handoff");

    expect(launchRow(fixture).status).toBe("rejected");
    expect(fixture.ctx.deps.store.getOrchestratorSession(fixture.source.id)?.status).toBe("active");
    expect(fixture.launcher.killCalls).toEqual([]);
  });

  it("spawn前にruntime deadlineを越えた未作成attemptはexpiredでsourceを復元する", async () => {
    fixture = createFixture("handoff");
    fixture.launcher.launchFailure = "spawn timeout";
    fixture.launcher.onLaunch = () => {
      fixture!.clock.currentMs += 16_000;
    };

    await runStart(fixture, "handoff");

    expect(launchRow(fixture).status).toBe("expired");
    expect(fixture.ctx.deps.store.getOrchestratorSession(fixture.source.id)?.status).toBe("active");
    expect(fixture.launcher.killCalls).toEqual([]);
  });

  it("spawn failureでもsession存在を観測したらunbound化せずstop_pending経由のuncertainにする", async () => {
    fixture = createFixture("handoff");
    fixture.launcher.launchFailure = "ambiguous spawn failure";
    fixture.launcher.onLaunch = () => {
      const args = fixture!.launcher.launchCalls[0]!;
      const sessionIndex = args.indexOf("-s");
      fixture!.launcher.sessionName = args[sessionIndex + 1] ?? "";
      fixture!.launcher.sessionAlive = true;
      fixture!.launcher.paneAlive = true;
      fixture!.launcher.groupAlive = true;
    };

    await runStart(fixture, "handoff");

    expect(launchRow(fixture).status).toBe("uncertain");
    expect(fixture.ctx.deps.store.getOrchestratorSession(fixture.source.id)?.status).toBe("handoff_pending");
    expect(fixture.launcher.killCalls).toEqual([]);
  });

  it("bind CAS失敗はbarrierをreleaseせずspawn済みexact targetをrollbackする", async () => {
    fixture = createFixture("handoff");
    vi.spyOn(fixture.ctx.deps.store, "bindSuccessorLaunchRuntime").mockImplementation(() => {
      throw new Error("bind conflict");
    });

    await runStart(fixture, "handoff");

    const row = launchRow(fixture);
    expect(row.status).toBe("stopped");
    expect(fixture.launcher.releaseCalls).toEqual([]);
    expect(fixture.launcher.killCalls).toEqual([row.plannedTmuxSession]);
  });

  it("bind commit後のbarrier release失敗はreleaseを再試行せずexact rollbackする", async () => {
    fixture = createFixture("handoff");
    fixture.launcher.releaseSucceeds = false;

    await runStart(fixture, "handoff");

    const row = launchRow(fixture);
    expect(row.status).toBe("stopped");
    expect(fixture.launcher.releaseCalls).toHaveLength(1);
    expect(fixture.launcher.killCalls).toEqual([row.plannedTmuxSession]);
  });

  it.each(["missing", "malformed", "drift"] as const)(
    "bind producerのserver lifetime %sはbind/release/provider mutation 0でuncertainへ凍結する",
    async (reason) => {
      fixture = createFixture("handoff");
      fixture.launcher.serverReadbackFailure = reason;

      await runStart(fixture, "handoff");

      const row = launchRow(fixture);
      expect(row.status).toBe("uncertain");
      expect(row.providerSessionId).toBe("");
      expect(row.runtimeBoundAt).toBeNull();
      expect(row.lastError).toBe(
        `SUCCESSOR_SERVER_LIFETIME_MISMATCH: slot=${row.id} expected=known observed=${reason}; ` +
        "attestation/final authority=0; exact rollback required",
      );
      expect(fixture.launcher.releaseCalls).toEqual([]);
      expect(fixture.launcher.killCalls).toEqual([]);
      expect(fixture.ctx.deps.store.getOrchestratorSession(fixture.source.id)?.status)
        .toBe("handoff_pending");
    },
  );

  const partialFields = [
    "stable",
    "tmuxSession",
    "tmuxPane",
    "panePid",
    "processGroupId",
    "cwd",
    "hostId",
    "ownerNonce",
    "hookDefinitionHash",
    "hookExecutableHash",
  ] as const;

  it.each(partialFields)("partial readback %s はbind/releaseせずuncertainへ固定する", async (field) => {
    fixture = createFixture("handoff");
    if (field === "hostId") {
      let calls = 0;
      fixture.ctx.deps.currentHostId = () => (++calls === 1 ? HOST : "");
    } else if (field === "hookDefinitionHash" || field === "hookExecutableHash") {
      let calls = 0;
      fixture.ctx.deps.successorAttestationHashProbe = {
        readInstalledHashes: () => {
          calls += 1;
          return {
            hookDefinitionHash: field === "hookDefinitionHash" && calls > 1 ? "bad" : HOOK_DEFINITION_HASH,
            hookExecutableHash: field === "hookExecutableHash" && calls > 1 ? "bad" : HOOK_EXECUTABLE_HASH,
          };
        },
      };
    } else {
      fixture.launcher.runtimeTransform = (runtime) => ({
        ...runtime,
        ...(field === "stable" ? { stable: false } : {}),
        ...(field === "tmuxSession" ? { tmuxSession: null } : {}),
        ...(field === "tmuxPane" ? { tmuxPane: null } : {}),
        ...(field === "panePid" ? { panePid: null } : {}),
        ...(field === "processGroupId" ? { processGroupId: null } : {}),
        ...(field === "cwd" ? { cwd: null } : {}),
        ...(field === "ownerNonce" ? { ownerNonce: null } : {}),
      });
    }

    await runStart(fixture, "handoff");

    expect(launchRow(fixture).status).toBe("uncertain");
    expect(fixture.launcher.releaseCalls).toEqual([]);
    expect(fixture.launcher.killCalls).toEqual([]);
    expect(fixture.ctx.exitCodes).toEqual([1]);
  });

  it("owner mismatchはkillせずuncertainにする", async () => {
    fixture = createFixture("handoff");
    fixture.launcher.runtimeTransform = (runtime) => ({ ...runtime, ownerNonce: "intruder-owner" });
    fixture.launcher.ownerNonce = "intruder-owner";

    await runStart(fixture, "handoff");

    const row = launchRow(fixture);
    expect(row.status).toBe("uncertain");
    expect(row.stopEvidence.ownerMatched).toBeNull();
    expect(row.stopEvidence.killResult).toBe("not-attempted");
    expect(fixture.launcher.killCalls).toEqual([]);
  });

  it("kill result unknownは三点を推測せずuncertainにする", async () => {
    fixture = createFixture("handoff");
    fixture.launcher.killThrows = true;

    await runStart(fixture, "handoff");

    const row = launchRow(fixture);
    expect(row.status).toBe("uncertain");
    expect(row.stopEvidence).toMatchObject({ ownerMatched: true, killResult: "unknown" });
  });

  it.each(["session", "pane", "group"] as const)(
    "三点停止のうち%sが残存すればuncertainにする",
    async (remaining) => {
      fixture = createFixture("handoff");
      fixture.launcher.stopRemaining.add(remaining);

      await runStart(fixture, "handoff");

      const row = launchRow(fixture);
      expect(row.status).toBe("uncertain");
      expect(row.stopEvidence.tmuxSessionAbsent).toBe(remaining === "session" ? false : true);
      expect(row.stopEvidence.panePidAbsent).toBe(remaining === "pane" ? false : true);
      expect(row.stopEvidence.processGroupAbsent).toBe(remaining === "group" ? false : true);
    },
  );

  it("blocking slot retryはreplacementをspawnせず、succeeded retryは同じsuccessorを返す", async () => {
    fixture = createFixture("handoff");
    fixture.launcher.runtimeTransform = (runtime) => ({ ...runtime, cwd: null });
    await runStart(fixture, "handoff");
    const blockedSlot = launchRow(fixture);
    expect(blockedSlot.status).toBe("uncertain");
    const launchCount = fixture.launcher.launchCalls.length;
    fixture.ctx.exitCodes.length = 0;
    await runStart(fixture, "handoff");
    expect(fixture.launcher.launchCalls).toHaveLength(launchCount);
    expect(fixture.ctx.exitCodes).toEqual([1]);

    fixture.ctx.cleanup();
    fixture = createFixture("handoff");
    fixture.launcher.onRelease = () => finalizeFromRuntime(fixture!, "handoff");
    await runStart(fixture, "handoff");
    const succeeded = launchRow(fixture);
    const succeededLaunchCount = fixture.launcher.launchCalls.length;
    fixture.ctx.stdout.clear();
    await runStart(fixture, "handoff");
    const retry = JSON.parse(fixture.ctx.stdout.text()) as {
      slotId: string;
      successorSessionId: string;
      idempotent: boolean;
    };
    expect(fixture.launcher.launchCalls).toHaveLength(succeededLaunchCount);
    expect(retry).toMatchObject({
      slotId: succeeded.id,
      successorSessionId: succeeded.successorSessionId,
      idempotent: true,
    });
  });

  it("rollback-completeはdry-run副作用0、applyもfenceとowner/三点一致時だけstoppedにする", async () => {
    fixture = createFixture("handoff");
    fixture.launcher.stopRemaining.add("group");
    let stopFence = "";
    const original = fixture.ctx.deps.store.markSuccessorLaunchStopPending.bind(fixture.ctx.deps.store);
    vi.spyOn(fixture.ctx.deps.store, "markSuccessorLaunchStopPending").mockImplementation((input) => {
      const result = original(input);
      stopFence = result.stopFence;
      return result;
    });
    await runStart(fixture, "handoff");
    const uncertain = launchRow(fixture);
    expect(uncertain.status).toBe("uncertain");
    expect(stopFence).not.toBe("");
    fixture.launcher.groupAlive = false;
    fixture.ctx.stdout.clear();
    fixture.ctx.exitCodes.length = 0;

    await buildProgram(fixture.ctx.deps).parseAsync([
      "orchestrator", "successor-launch", "rollback-complete",
      "--slot", uncertain.id,
      "--fence", stopFence,
      "--json",
    ], { from: "user" });
    const dryRun = JSON.parse(fixture.ctx.stdout.text()) as { applicable: boolean; applied: boolean };
    expect(dryRun).toEqual(expect.objectContaining({ applicable: true, applied: false }));
    expect(launchRow(fixture)).toMatchObject({ status: "uncertain", revision: uncertain.revision });

    fixture.launcher.sessionAlive = true;
    fixture.launcher.ownerNonce = "reappeared-owner";
    fixture.ctx.stdout.clear();
    await buildProgram(fixture.ctx.deps).parseAsync([
      "orchestrator", "successor-launch", "rollback-complete",
      "--slot", uncertain.id,
      "--fence", stopFence,
      "--apply",
      "--json",
    ], { from: "user" });
    const reappeared = JSON.parse(fixture.ctx.stdout.text()) as { applicable: boolean; applied: boolean };
    expect(reappeared).toEqual(expect.objectContaining({ applicable: false, applied: false }));
    expect(launchRow(fixture)).toMatchObject({ status: "uncertain", revision: uncertain.revision });

    fixture.launcher.sessionAlive = false;
    fixture.ctx.stdout.clear();
    await buildProgram(fixture.ctx.deps).parseAsync([
      "orchestrator", "successor-launch", "rollback-complete",
      "--slot", uncertain.id,
      "--fence", stopFence,
      "--apply",
      "--json",
    ], { from: "user" });
    const applied = JSON.parse(fixture.ctx.stdout.text()) as { applicable: boolean; applied: boolean; status: string };
    expect(applied).toEqual(expect.objectContaining({ applicable: true, applied: true, status: "stopped" }));
    expect(fixture.ctx.deps.store.getOrchestratorSession(fixture.source.id)?.status).toBe("active");
    expect(fixture.ctx.exitCodes).toEqual([]);
  });

  it("rollback-completeのwrong fenceはapply mutation 0にする", async () => {
    fixture = createFixture("handoff");
    fixture.launcher.stopRemaining.add("group");
    await runStart(fixture, "handoff");
    const uncertain = launchRow(fixture);
    fixture.ctx.exitCodes.length = 0;
    fixture.ctx.stdout.clear();
    fixture.launcher.groupAlive = false;

    await buildProgram(fixture.ctx.deps).parseAsync([
      "orchestrator", "successor-launch", "rollback-complete",
      "--slot", uncertain.id,
      "--fence", "wrong-fence",
      "--apply",
      "--json",
    ], { from: "user" });
    expect(JSON.parse(fixture.ctx.stdout.text())).toEqual(expect.objectContaining({
      applicable: false,
      applied: false,
      reason: "fence-mismatch",
    }));
    expect(launchRow(fixture)).toMatchObject({ status: "uncertain", revision: uncertain.revision });
  });
});
