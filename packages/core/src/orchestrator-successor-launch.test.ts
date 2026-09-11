import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import type {
  AttestOrchestratorSuccessorLaunchResult,
  OrchestratorSessionRow,
  ClaimOrchestratorSuccessorAcceptResult,
  OrchestratorSuccessorLaunchKind,
  Provider,
} from "./types.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface LaunchFixture {
  now: number;
  source: OrchestratorSessionRow;
  slotId: string;
  handoffTokenHash: string;
  canonicalCwd: string;
  hostId: string;
  tmuxSession: string;
  tmuxPane: string;
  panePid: number;
  processGroupId: number;
  tmuxSocketPath: string;
  tmuxServerPid: number;
  tmuxServerStartTime: number;
  tmuxServerLifetimeHash: string;
  ownerNonceHash: string;
  hookDefinitionHash: string;
  hookExecutableHash: string;
}

type LaunchRuntimeOverrides = Partial<Pick<LaunchFixture,
  "hostId" | "tmuxPane" | "panePid" | "processGroupId" | "tmuxSocketPath" |
  "tmuxServerPid" | "tmuxServerStartTime" | "tmuxServerLifetimeHash"
>>;

function armAndBind(
  store: SqliteKanbanStore,
  kind: OrchestratorSuccessorLaunchKind,
  provider: Provider = "codex",
  suffix: string = kind,
  runtimeOverrides: LaunchRuntimeOverrides = {},
): LaunchFixture {
  const now = Math.floor(Date.now() / 1000);
  const orchestrator = store.registerOrchestrator({
    label: `successor-${provider}-${suffix}`,
    project: "hachi-kanban",
    repoCommonDir: `/repo/${suffix}/.git`,
  });
  const source = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
  if (kind === "takeover") {
    store.heartbeatOrchestratorSession(source.id, source.generation, now - 100);
  }
  const canonicalCwd = `/repo/${suffix}`;
  const hostId = runtimeOverrides.hostId ?? `host-${suffix}`;
  const tmuxSession = `tmux-${suffix}`;
  const tmuxPane = runtimeOverrides.tmuxPane ?? `%${suffix.length + 10}`;
  const panePid = runtimeOverrides.panePid ?? 20_000 + suffix.length;
  const processGroupId = runtimeOverrides.processGroupId ?? 30_000 + suffix.length;
  const tmuxSocketPath = runtimeOverrides.tmuxSocketPath ?? `/tmp/hachi-${suffix}.sock`;
  const tmuxServerPid = runtimeOverrides.tmuxServerPid ?? 40_000 + suffix.length;
  const tmuxServerStartTime = runtimeOverrides.tmuxServerStartTime ?? 1_700_000_000 + suffix.length;
  const tmuxServerLifetimeHash = runtimeOverrides.tmuxServerLifetimeHash ??
    hash(`tmux-server-lifetime-${suffix}`);
  const ownerNonceHash = hash(`owner-${suffix}`);
  const hookDefinitionHash = hash(`hook-definition-${suffix}`);
  const hookExecutableHash = hash(`hook-executable-${suffix}`);
  const handoffTokenHash = hash(`handoff-${suffix}`);
  const common = {
    orchestratorId: orchestrator.id,
    targetProvider: provider,
    sourceSessionId: source.id,
    sourceGeneration: source.generation,
    canonicalCwd,
    hostId,
    launchNonceHash: hash(`launch-${suffix}`),
    plannedTmuxSession: tmuxSession,
    hookDefinitionHash,
    hookExecutableHash,
    runtimeDeadlineAt: now + 60,
    attestationDeadlineAt: now + 120,
    now,
  };
  const armed = kind === "handoff"
    ? store.armSuccessorLaunch({
      ...common,
      kind,
      handoffTokenFenceHash: handoffTokenHash,
      handoffExpiresAt: now + 120,
    })
    : store.armSuccessorLaunch({ ...common, kind, staleBefore: now - 50 });
  const bound = store.bindSuccessorLaunchRuntime({
    slotId: armed.id,
    expectedRevision: armed.revision,
    observedCanonicalCwd: canonicalCwd,
    observedHostId: hostId,
    tmuxSession,
    tmuxPane,
    panePid,
    processGroupId,
    tmuxSocketPath,
    tmuxServerPid,
    tmuxServerStartTime,
    tmuxServerLifetimeHash,
    ownerNonceHash,
    hookDefinitionHash,
    hookExecutableHash,
    now: now + 1,
  });
  expect(bound).toMatchObject({
    status: "runtime_bound",
    tmuxSocketPath,
    tmuxServerPid,
    tmuxServerStartTime,
    tmuxServerLifetimeHash,
    runtimeOwnershipClaimed: true,
  });
  return {
    now,
    source,
    slotId: armed.id,
    handoffTokenHash,
    canonicalCwd,
    hostId,
    tmuxSession,
    tmuxPane,
    panePid,
    processGroupId,
    tmuxSocketPath,
    tmuxServerPid,
    tmuxServerStartTime,
    tmuxServerLifetimeHash,
    ownerNonceHash,
    hookDefinitionHash,
    hookExecutableHash,
  };
}

function attest(
  store: SqliteKanbanStore,
  fixture: LaunchFixture,
  provider: Provider,
  providerSessionId: string,
  issuedAt: number = fixture.now + 2,
): AttestOrchestratorSuccessorLaunchResult {
  const runtime = {
    providerSessionId,
    canonicalCwd: fixture.canonicalCwd,
    hostId: fixture.hostId,
    tmuxSession: fixture.tmuxSession,
    tmuxPane: fixture.tmuxPane,
    panePid: fixture.panePid,
    processGroupId: fixture.processGroupId,
    tmuxSocketPath: fixture.tmuxSocketPath,
    tmuxServerPid: fixture.tmuxServerPid,
    tmuxServerStartTime: fixture.tmuxServerStartTime,
    tmuxServerLifetimeHash: fixture.tmuxServerLifetimeHash,
    ownerNonceHash: fixture.ownerNonceHash,
    hookDefinitionHash: fixture.hookDefinitionHash,
    hookExecutableHash: fixture.hookExecutableHash,
    now: issuedAt,
  };
  const result = provider === "codex"
    ? store.attestSuccessorLaunch({
      ...runtime,
      providerSessionSource: "codex-session-start",
      source: "startup",
    })
    : store.attestSuccessorLaunch({
      ...runtime,
      providerSessionSource: "claude-delivery",
      source: "delivery",
    });
  if (result === null) throw new Error("attestation fixture の作成に失敗しました");
  return result;
}

function claim(
  store: SqliteKanbanStore,
  fixture: LaunchFixture,
  attestation: AttestOrchestratorSuccessorLaunchResult,
  operation: OrchestratorSuccessorLaunchKind,
): ClaimOrchestratorSuccessorAcceptResult {
  return store.claimSuccessorLaunchAccept({
    slotId: fixture.slotId,
    expectedRevision: attestation.launch.revision,
    attestationHandleHash: hash(attestation.attestationHandle),
    operation,
    now: fixture.now + 3,
  });
}

const completeStopEvidence = {
  ownerMatched: true,
  ownerReadbackAt: 2_000,
  killResult: "succeeded" as const,
  tmuxSessionAbsent: true,
  panePidAbsent: true,
  processGroupAbsent: true,
  observedAt: 2_001,
};

describe("durable orchestrator successor launch contract §70〜§73", () => {
  const stores: SqliteKanbanStore[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const store of stores.splice(0)) store.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function createStore(path = ":memory:"): SqliteKanbanStore {
    const store = new SqliteKanbanStore(path);
    stores.push(store);
    return store;
  }

  it("attestation deadlineの境界秒では発行できTTLは発行時刻から30秒になる", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const store = createStore();
    const fixture = armAndBind(store, "takeover", "codex", "attestation-deadline-boundary");
    const issuedAt = fixture.now + 120;

    const issued = attest(store, fixture, "codex", "codex-deadline-boundary", issuedAt);

    expect(issued.launch).toMatchObject({
      status: "attested",
      attestationIssuedAt: issuedAt,
      attestationExpiresAt: issuedAt + 30,
    });
  });

  it("runtimeとattestationが等値のdeadlineではarmを拒否する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const store = createStore();
    const now = Math.floor(Date.now() / 1_000);
    const orchestrator = store.registerOrchestrator({
      label: "equal-deadline",
      project: "hachi-kanban",
      repoCommonDir: "/repo/equal-deadline/.git",
    });
    const source = store.startOrchestratorSession({ orchestratorId: orchestrator.id });

    expect(() => store.armSuccessorLaunch({
      orchestratorId: orchestrator.id,
      targetProvider: "codex",
      sourceSessionId: source.id,
      sourceGeneration: source.generation,
      canonicalCwd: "/repo/equal-deadline",
      hostId: "host-equal-deadline",
      launchNonceHash: hash("launch-equal-deadline"),
      plannedTmuxSession: "tmux-equal-deadline",
      hookDefinitionHash: hash("hook-definition-equal-deadline"),
      hookExecutableHash: hash("hook-executable-equal-deadline"),
      runtimeDeadlineAt: now + 15,
      attestationDeadlineAt: now + 15,
      kind: "handoff",
      handoffTokenFenceHash: hash("handoff-equal-deadline"),
      handoffExpiresAt: now + 600,
      now,
    })).toThrow("successor launch runtime deadline は attestation deadline より前が必須です");
    expect(store.listSuccessorLaunches(orchestrator.id)).toEqual([]);
    expect(store.getOrchestratorSession(source.id)?.status).toBe("active");
  });

  it("handoff armはslot作成とactive→handoff_pendingを原子的に行いblocking bypassを拒否する", () => {
    const store = createStore();
    const fixture = armAndBind(store, "handoff", "codex", "atomic");

    expect(store.getOrchestratorSession(fixture.source.id)).toMatchObject({
      status: "handoff_pending",
      handoffTokenHash: fixture.handoffTokenHash,
    });
    expect(store.successorReplacementGate(fixture.source.orchestratorId)).toMatchObject({
      allowed: false,
      blockingSlotId: fixture.slotId,
    });
    expect(() => store.acceptOrchestratorHandoff({
      oldSessionId: fixture.source.id,
      tokenHash: fixture.handoffTokenHash,
      provider: "codex",
      providerSessionId: "manual-bypass",
    })).toThrow("SUCCESSOR_REPLACEMENT_BLOCKED");
  });

  it("blocking slotとruntime/provider ID uniquenessをkind・orchestratorを跨いで固定する", () => {
    const store = createStore();
    const first = armAndBind(store, "handoff", "codex", "unique-runtime");
    const firstAttestation = attest(store, first, "codex", "provider-session-unique");
    expect(firstAttestation.launch.status).toBe("attested");

    expect(() => store.armSuccessorLaunch({
      orchestratorId: first.source.orchestratorId,
      targetProvider: "claude",
      sourceSessionId: first.source.id,
      sourceGeneration: first.source.generation,
      canonicalCwd: first.canonicalCwd,
      hostId: first.hostId,
      launchNonceHash: hash("duplicate-blocking"),
      plannedTmuxSession: "other",
      hookDefinitionHash: first.hookDefinitionHash,
      hookExecutableHash: first.hookExecutableHash,
      runtimeDeadlineAt: first.now + 60,
      attestationDeadlineAt: first.now + 120,
      kind: "takeover",
      staleBefore: first.now + 1,
      now: first.now,
    })).toThrow("SUCCESSOR_REPLACEMENT_BLOCKED");

    const runtimeOrchestrator = store.registerOrchestrator({
      label: "runtime-conflict",
      project: "hachi-kanban",
      repoCommonDir: "/repo/runtime-conflict/.git",
    });
    const runtimeSource = store.startOrchestratorSession({ orchestratorId: runtimeOrchestrator.id });
    store.heartbeatOrchestratorSession(runtimeSource.id, runtimeSource.generation, first.now - 100);
    const runtimeSlot = store.armSuccessorLaunch({
      orchestratorId: runtimeOrchestrator.id,
      targetProvider: "codex",
      sourceSessionId: runtimeSource.id,
      sourceGeneration: runtimeSource.generation,
      canonicalCwd: "/repo/runtime-conflict",
      hostId: first.hostId,
      launchNonceHash: hash("runtime-conflict-launch"),
      plannedTmuxSession: "tmux-runtime-conflict",
      hookDefinitionHash: hash("runtime-conflict-definition"),
      hookExecutableHash: hash("runtime-conflict-helper"),
      runtimeDeadlineAt: first.now + 60,
      attestationDeadlineAt: first.now + 120,
      kind: "takeover",
      staleBefore: first.now - 50,
      now: first.now,
    });
    expect(() => store.bindSuccessorLaunchRuntime({
      slotId: runtimeSlot.id,
      expectedRevision: runtimeSlot.revision,
      observedCanonicalCwd: "/repo/runtime-conflict",
      observedHostId: first.hostId,
      tmuxSession: "tmux-runtime-conflict",
      tmuxPane: first.tmuxPane,
      panePid: 45_001,
      processGroupId: 46_001,
      tmuxSocketPath: first.tmuxSocketPath,
      tmuxServerPid: first.tmuxServerPid,
      tmuxServerStartTime: first.tmuxServerStartTime,
      tmuxServerLifetimeHash: first.tmuxServerLifetimeHash,
      ownerNonceHash: hash("runtime-conflict-owner"),
      hookDefinitionHash: hash("runtime-conflict-definition"),
      hookExecutableHash: hash("runtime-conflict-helper"),
      now: first.now + 1,
    })).toThrow();
    const partialRuntime = {
      slotId: runtimeSlot.id,
      expectedRevision: runtimeSlot.revision,
      observedCanonicalCwd: "/repo/runtime-conflict",
      observedHostId: first.hostId,
      tmuxSession: "tmux-runtime-conflict",
      tmuxPane: "%91",
      panePid: 45_001,
      processGroupId: 46_001,
      tmuxSocketPath: first.tmuxSocketPath,
      tmuxServerPid: first.tmuxServerPid,
      tmuxServerStartTime: first.tmuxServerStartTime,
      tmuxServerLifetimeHash: first.tmuxServerLifetimeHash,
      ownerNonceHash: hash("runtime-conflict-owner"),
      observedHookDefinitionHash: hash("runtime-conflict-definition"),
      observedHookExecutableHash: hash("runtime-conflict-helper"),
      error: "invalid partial runtime",
      now: first.now + 2,
    };
    for (const invalid of [
      { observedCanonicalCwd: "relative/path" },
      { observedHostId: "" },
      { tmuxSession: "" },
      { tmuxPane: "garbage" },
      { panePid: -1 },
      { processGroupId: -1 },
      { tmuxSocketPath: "relative/socket" },
      { tmuxServerPid: -1 },
      { tmuxServerStartTime: -1 },
      { tmuxServerLifetimeHash: "bad" },
      { ownerNonceHash: "bad" },
      { observedHookDefinitionHash: "bad" },
      { observedHookExecutableHash: "bad" },
    ]) {
      expect(() => store.markArmedSuccessorLaunchStopPending({ ...partialRuntime, ...invalid })).toThrow();
      expect(store.getSuccessorLaunch(runtimeSlot.id)?.status).toBe("armed");
    }
    const pending = store.markArmedSuccessorLaunchStopPending({
      slotId: runtimeSlot.id,
      expectedRevision: runtimeSlot.revision,
      observedCanonicalCwd: "/repo/runtime-conflict",
      observedHostId: first.hostId,
      tmuxSession: "tmux-runtime-conflict",
      tmuxPane: first.tmuxPane,
      panePid: 45_001,
      processGroupId: 46_001,
      tmuxSocketPath: first.tmuxSocketPath,
      tmuxServerPid: first.tmuxServerPid,
      tmuxServerStartTime: first.tmuxServerStartTime,
      tmuxServerLifetimeHash: first.tmuxServerLifetimeHash,
      ownerNonceHash: hash("runtime-conflict-owner"),
      observedHookDefinitionHash: hash("runtime-conflict-definition"),
      observedHookExecutableHash: hash("runtime-conflict-helper"),
      error: "runtime conflict",
      now: first.now + 2,
    });
    expect(pending.launch).toMatchObject({
      status: "stop_pending",
      observedHostId: first.hostId,
      tmuxPane: first.tmuxPane,
      panePid: 45_001,
      processGroupId: 46_001,
      tmuxSocketPath: first.tmuxSocketPath,
      tmuxServerPid: first.tmuxServerPid,
      tmuxServerStartTime: first.tmuxServerStartTime,
      tmuxServerLifetimeHash: first.tmuxServerLifetimeHash,
      runtimeOwnershipClaimed: false,
    });
    const conflictedStop = store.recordSuccessorLaunchStop({
      slotId: runtimeSlot.id,
      expectedRevision: pending.launch.revision,
      stopFenceHash: hash(pending.stopFence),
      killOwnerReadbackHash: hash("runtime-conflict-owner"),
      evidence: {
        ownerMatched: true,
        ownerReadbackAt: first.now + 3,
        killResult: "succeeded",
        tmuxSessionAbsent: true,
        panePidAbsent: true,
        processGroupAbsent: true,
        observedAt: first.now + 3,
      },
      now: first.now + 3,
    });
    expect(conflictedStop.status).toBe("uncertain");
    expect(store.successorReplacementGate(runtimeOrchestrator.id).allowed).toBe(false);

    const second = armAndBind(store, "takeover", "codex", "provider-replay");
    expect(store.attestSuccessorLaunch({
      providerSessionSource: "codex-session-start",
      source: "startup",
      providerSessionId: "provider-session-unique",
      canonicalCwd: second.canonicalCwd,
      hostId: second.hostId,
      tmuxSession: second.tmuxSession,
      tmuxPane: second.tmuxPane,
      panePid: second.panePid,
      processGroupId: second.processGroupId,
      tmuxSocketPath: second.tmuxSocketPath,
      tmuxServerPid: second.tmuxServerPid,
      tmuxServerStartTime: second.tmuxServerStartTime,
      tmuxServerLifetimeHash: second.tmuxServerLifetimeHash,
      ownerNonceHash: second.ownerNonceHash,
      hookDefinitionHash: second.hookDefinitionHash,
      hookExecutableHash: second.hookExecutableHash,
      now: second.now + 2,
    })).toBeNull();
  });

  it("runtime keyはhost/socket/server lifetime/paneで排他し、別lifetime・別socketとPID再利用を許可する", () => {
    const store = createStore();
    const first = armAndBind(store, "takeover", "codex", "runtime-key-first");
    const differentLifetime = armAndBind(store, "takeover", "codex", "runtime-key-lifetime", {
      hostId: first.hostId,
      tmuxPane: first.tmuxPane,
      panePid: first.panePid,
      processGroupId: first.processGroupId,
      tmuxSocketPath: first.tmuxSocketPath,
      tmuxServerPid: first.tmuxServerPid,
      tmuxServerStartTime: first.tmuxServerStartTime,
      tmuxServerLifetimeHash: hash("different-server-lifetime"),
    });
    const differentSocket = armAndBind(store, "takeover", "codex", "runtime-key-socket", {
      hostId: first.hostId,
      tmuxPane: first.tmuxPane,
      panePid: first.panePid,
      processGroupId: first.processGroupId,
      tmuxSocketPath: "/tmp/hachi-different-server.sock",
      tmuxServerPid: first.tmuxServerPid,
      tmuxServerStartTime: first.tmuxServerStartTime,
      tmuxServerLifetimeHash: first.tmuxServerLifetimeHash,
    });
    expect(store.getSuccessorLaunch(differentLifetime.slotId)?.runtimeOwnershipClaimed).toBe(true);
    expect(store.getSuccessorLaunch(differentSocket.slotId)?.runtimeOwnershipClaimed).toBe(true);

    expect(() => armAndBind(store, "takeover", "codex", "runtime-key-conflict", {
      hostId: first.hostId,
      tmuxPane: first.tmuxPane,
      panePid: first.panePid + 1,
      processGroupId: first.processGroupId + 1,
      tmuxSocketPath: first.tmuxSocketPath,
      tmuxServerPid: first.tmuxServerPid + 1,
      tmuxServerStartTime: first.tmuxServerStartTime + 1,
      tmuxServerLifetimeHash: first.tmuxServerLifetimeHash,
    })).toThrow("SUCCESSOR_RUNTIME_COLLISION");
  });

  it("legacy lifetime空のclaimed blocking rowはauthority 0のまま同host/pane新bindを拒否する", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-successor-legacy-runtime-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "kanban.db");
    const firstStore = new SqliteKanbanStore(dbPath);
    const legacy = armAndBind(firstStore, "takeover", "codex", "legacy-runtime-owner");
    firstStore.close();

    const raw = new Database(dbPath);
    try {
      raw.prepare(
        `UPDATE orchestrator_successor_launches
         SET tmux_socket_path = '', tmux_server_pid = NULL, tmux_server_start_time = NULL,
             tmux_server_lifetime_hash = '', runtime_ownership_claimed = 1
         WHERE id = ?`,
      ).run(legacy.slotId);
    } finally {
      raw.close();
    }

    const reopened = createStore(dbPath);
    expect(reopened.getSuccessorLaunch(legacy.slotId)).toMatchObject({
      status: "runtime_bound",
      tmuxSocketPath: "",
      tmuxServerLifetimeHash: "",
      runtimeOwnershipClaimed: true,
    });
    expect(reopened.attestSuccessorLaunch({
      providerSessionSource: "codex-session-start",
      source: "startup",
      providerSessionId: "legacy-authority-zero",
      canonicalCwd: legacy.canonicalCwd,
      hostId: legacy.hostId,
      tmuxSession: legacy.tmuxSession,
      tmuxPane: legacy.tmuxPane,
      panePid: legacy.panePid,
      processGroupId: legacy.processGroupId,
      tmuxSocketPath: "/tmp/fresh-server.sock",
      tmuxServerPid: legacy.tmuxServerPid,
      tmuxServerStartTime: legacy.tmuxServerStartTime,
      tmuxServerLifetimeHash: hash("fresh-server-lifetime"),
      ownerNonceHash: legacy.ownerNonceHash,
      hookDefinitionHash: legacy.hookDefinitionHash,
      hookExecutableHash: legacy.hookExecutableHash,
      now: legacy.now + 2,
    })).toBeNull();
    expect(() => armAndBind(reopened, "takeover", "codex", "legacy-runtime-collision", {
      hostId: legacy.hostId,
      tmuxPane: legacy.tmuxPane,
      tmuxSocketPath: "/tmp/fresh-server.sock",
      tmuxServerLifetimeHash: hash("fresh-server-lifetime"),
    })).toThrow("SUCCESSOR_RUNTIME_COLLISION");
  });

  it("blocking slotのsource sessionはclose/cancel/fence/stale expiryでdriftさせない", () => {
    const store = createStore();
    const handoff = armAndBind(store, "handoff", "codex", "source-fence-handoff");
    expect(() => store.closeOrchestratorSession(
      handoff.source.id,
      handoff.source.generation,
    )).toThrow("SUCCESSOR_SOURCE_MUTATION_BLOCKED");
    expect(() => store.cancelOrchestratorHandoff(
      handoff.source.id,
      handoff.source.generation,
      handoff.handoffTokenHash,
    )).toThrow("SUCCESSOR_SOURCE_MUTATION_BLOCKED");
    expect(() => store.fenceOrchestratorHandoffToken(
      handoff.source.id,
      handoff.source.generation,
      handoff.handoffTokenHash,
      hash("replacement-source-fence"),
    )).toThrow("SUCCESSOR_SOURCE_MUTATION_BLOCKED");
    expect(store.expireStaleOrchestratorSessions(handoff.now + 100, handoff.now + 200)).toBe(0);
    expect(store.getOrchestratorSession(handoff.source.id)).toMatchObject({
      status: "handoff_pending",
      handoffTokenHash: handoff.handoffTokenHash,
    });

    const takeover = armAndBind(store, "takeover", "codex", "source-fence-takeover");
    expect(store.expireStaleOrchestratorSessions(takeover.now - 50, takeover.now + 1)).toBe(0);
    expect(store.getOrchestratorSession(takeover.source.id)?.status).toBe("active");
  });

  it("succeeded terminal CASはruntime claimを解放し、同一server lifetime/paneの次claimを許可する", () => {
    const store = createStore();
    const first = armAndBind(store, "handoff", "codex", "pane-reuse-source");
    const issued = attest(store, first, "codex", "codex-pane-reuse-source");
    const accepted = claim(store, first, issued, "handoff");
    const successor = store.acceptOrchestratorHandoffWithSuccessorLaunch({
      slotId: first.slotId,
      expectedRevision: accepted.launch.revision,
      acceptFenceHash: hash(accepted.acceptFence),
      attestationHandleHash: hash(issued.attestationHandle),
      handoffTokenHash: first.handoffTokenHash,
      now: first.now + 4,
    });

    const orchestrator = store.registerOrchestrator({
      label: "pane-reuse-target",
      project: "hachi-kanban",
      repoCommonDir: "/repo/pane-reuse-target/.git",
    });
    const source = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    const handoffTokenHash = hash("pane-reuse-target-token");
    const armed = store.armSuccessorLaunch({
      orchestratorId: orchestrator.id,
      targetProvider: "codex",
      sourceSessionId: source.id,
      sourceGeneration: source.generation,
      canonicalCwd: "/repo/pane-reuse-target",
      hostId: first.hostId,
      launchNonceHash: hash("pane-reuse-target-launch"),
      plannedTmuxSession: "tmux-pane-reuse-target",
      hookDefinitionHash: hash("pane-reuse-target-definition"),
      hookExecutableHash: hash("pane-reuse-target-helper"),
      runtimeDeadlineAt: first.now + 60,
      attestationDeadlineAt: first.now + 120,
      kind: "handoff",
      handoffTokenFenceHash: handoffTokenHash,
      handoffExpiresAt: first.now + 120,
      now: first.now + 5,
    });
    const bindInput = {
      slotId: armed.id,
      expectedRevision: armed.revision,
      observedCanonicalCwd: "/repo/pane-reuse-target",
      observedHostId: first.hostId,
      tmuxSession: "tmux-pane-reuse-target",
      tmuxPane: first.tmuxPane,
      panePid: 51_001,
      processGroupId: 52_001,
      tmuxSocketPath: first.tmuxSocketPath,
      tmuxServerPid: first.tmuxServerPid,
      tmuxServerStartTime: first.tmuxServerStartTime,
      tmuxServerLifetimeHash: first.tmuxServerLifetimeHash,
      ownerNonceHash: hash("pane-reuse-target-owner"),
      hookDefinitionHash: hash("pane-reuse-target-definition"),
      hookExecutableHash: hash("pane-reuse-target-helper"),
      now: first.now + 6,
    };
    expect(store.getSuccessorLaunch(first.slotId)).toMatchObject({
      status: "succeeded",
      runtimeOwnershipClaimed: false,
    });
    const rebound = store.bindSuccessorLaunchRuntime(bindInput);
    expect(rebound).toMatchObject({ status: "runtime_bound", runtimeOwnershipClaimed: true });
    store.closeOrchestratorSession(successor.id, successor.generation);
    expect(store.getSuccessorLaunch(armed.id)?.runtimeOwnershipClaimed).toBe(true);
  });

  it("wrong runtime identityはauthority 0で、resumeは同じhandleをTTL延長なしで再提示する", () => {
    const store = createStore();
    const fixture = armAndBind(store, "handoff", "codex", "resume");
    expect(store.attestSuccessorLaunch({
      providerSessionSource: "codex-session-start",
      source: "startup",
      providerSessionId: "codex-resume",
      canonicalCwd: fixture.canonicalCwd,
      hostId: fixture.hostId,
      tmuxSession: fixture.tmuxSession,
      tmuxPane: "%999",
      panePid: fixture.panePid,
      processGroupId: fixture.processGroupId,
      tmuxSocketPath: fixture.tmuxSocketPath,
      tmuxServerPid: fixture.tmuxServerPid,
      tmuxServerStartTime: fixture.tmuxServerStartTime,
      tmuxServerLifetimeHash: fixture.tmuxServerLifetimeHash,
      ownerNonceHash: fixture.ownerNonceHash,
      hookDefinitionHash: fixture.hookDefinitionHash,
      hookExecutableHash: fixture.hookExecutableHash,
      now: fixture.now + 2,
    })).toBeNull();
    const exactRuntime = {
      providerSessionSource: "codex-session-start" as const,
      source: "startup" as const,
      providerSessionId: "codex-resume",
      canonicalCwd: fixture.canonicalCwd,
      hostId: fixture.hostId,
      tmuxSession: fixture.tmuxSession,
      tmuxPane: fixture.tmuxPane,
      panePid: fixture.panePid,
      processGroupId: fixture.processGroupId,
      tmuxSocketPath: fixture.tmuxSocketPath,
      tmuxServerPid: fixture.tmuxServerPid,
      tmuxServerStartTime: fixture.tmuxServerStartTime,
      tmuxServerLifetimeHash: fixture.tmuxServerLifetimeHash,
      ownerNonceHash: fixture.ownerNonceHash,
      hookDefinitionHash: fixture.hookDefinitionHash,
      hookExecutableHash: fixture.hookExecutableHash,
      now: fixture.now + 2,
    };
    for (const drift of [
      { tmuxSocketPath: "/tmp/drifted-server.sock" },
      { tmuxServerPid: fixture.tmuxServerPid + 1 },
      { tmuxServerStartTime: fixture.tmuxServerStartTime + 1 },
      { tmuxServerLifetimeHash: hash("drifted-server-lifetime") },
    ]) {
      expect(store.attestSuccessorLaunch({ ...exactRuntime, ...drift })).toBeNull();
      expect(store.getSuccessorLaunch(fixture.slotId)?.status).toBe("runtime_bound");
    }
    const issued = attest(store, fixture, "codex", "codex-resume");
    const resumed = store.attestSuccessorLaunch({
      providerSessionSource: "codex-session-start",
      source: "resume",
      providerSessionId: "codex-resume",
      canonicalCwd: fixture.canonicalCwd,
      hostId: fixture.hostId,
      tmuxSession: fixture.tmuxSession,
      tmuxPane: fixture.tmuxPane,
      panePid: fixture.panePid,
      processGroupId: fixture.processGroupId,
      tmuxSocketPath: fixture.tmuxSocketPath,
      tmuxServerPid: fixture.tmuxServerPid,
      tmuxServerStartTime: fixture.tmuxServerStartTime,
      tmuxServerLifetimeHash: fixture.tmuxServerLifetimeHash,
      ownerNonceHash: fixture.ownerNonceHash,
      hookDefinitionHash: fixture.hookDefinitionHash,
      hookExecutableHash: fixture.hookExecutableHash,
      now: fixture.now + 10,
    });
    expect(resumed?.attestationHandle).toBe(issued.attestationHandle);
    expect(resumed?.launch.attestationExpiresAt).toBe(issued.launch.attestationExpiresAt);
  });

  it("accept claim retryは同じraw fenceへ収束し、旧revision replayを拒否する", () => {
    const store = createStore();
    const fixture = armAndBind(store, "handoff", "codex", "accept-replay");
    const issued = attest(store, fixture, "codex", "codex-accept-replay");
    const first = claim(store, fixture, issued, "handoff");
    const retried = store.claimSuccessorLaunchAccept({
      slotId: fixture.slotId,
      expectedRevision: first.launch.revision,
      attestationHandleHash: hash(issued.attestationHandle),
      operation: "handoff",
      now: fixture.now + 4,
    });
    expect(retried.acceptFence).toBe(first.acceptFence);
    expect(() => claim(store, fixture, issued, "handoff")).toThrow("revision");
  });

  it("final credential/operation不一致はaccepting slotをmutationせず正しいretryを維持する", () => {
    const store = createStore();
    const handoff = armAndBind(store, "handoff", "codex", "invalid-final-handoff");
    const handoffIssued = attest(store, handoff, "codex", "codex-invalid-final-handoff");
    const handoffAccepted = claim(store, handoff, handoffIssued, "handoff");
    const handoffInput = {
      slotId: handoff.slotId,
      expectedRevision: handoffAccepted.launch.revision,
      acceptFenceHash: hash(handoffAccepted.acceptFence),
      attestationHandleHash: hash(handoffIssued.attestationHandle),
      handoffTokenHash: handoff.handoffTokenHash,
      now: handoff.now + 4,
    };
    for (const invalid of [
      { acceptFenceHash: hash("wrong-final-fence") },
      { attestationHandleHash: hash("wrong-final-handle") },
      { handoffTokenHash: hash("wrong-final-token") },
    ]) {
      expect(() => store.acceptOrchestratorHandoffWithSuccessorLaunch({ ...handoffInput, ...invalid })).toThrow();
      expect(store.getSuccessorLaunch(handoff.slotId)?.status).toBe("accepting");
      expect(store.getOrchestratorSession(handoff.source.id)?.status).toBe("handoff_pending");
    }
    expect(() => store.takeoverStaleOrchestratorSessionWithSuccessorLaunch({
      slotId: handoff.slotId,
      expectedRevision: handoffAccepted.launch.revision,
      acceptFenceHash: hash(handoffAccepted.acceptFence),
      attestationHandleHash: hash(handoffIssued.attestationHandle),
      now: handoff.now + 4,
    })).toThrow("slot kind");
    expect(store.getSuccessorLaunch(handoff.slotId)?.status).toBe("accepting");
    expect(store.acceptOrchestratorHandoffWithSuccessorLaunch(handoffInput).providerSessionId)
      .toBe("codex-invalid-final-handoff");

    const takeover = armAndBind(store, "takeover", "claude", "invalid-final-takeover");
    const takeoverIssued = attest(store, takeover, "claude", "claude-invalid-final-takeover");
    const takeoverAccepted = claim(store, takeover, takeoverIssued, "takeover");
    expect(() => store.takeoverStaleOrchestratorSessionWithSuccessorLaunch({
      slotId: takeover.slotId,
      expectedRevision: takeoverAccepted.launch.revision,
      acceptFenceHash: hash("wrong-takeover-final-fence"),
      attestationHandleHash: hash(takeoverIssued.attestationHandle),
      now: takeover.now + 4,
    })).toThrow();
    expect(() => store.acceptOrchestratorHandoffWithSuccessorLaunch({
      slotId: takeover.slotId,
      expectedRevision: takeoverAccepted.launch.revision,
      acceptFenceHash: hash(takeoverAccepted.acceptFence),
      attestationHandleHash: hash(takeoverIssued.attestationHandle),
      handoffTokenHash: hash("takeover-has-no-handoff-token"),
      now: takeover.now + 4,
    })).toThrow("slot kind");
    expect(store.getSuccessorLaunch(takeover.slotId)?.status).toBe("accepting");
  });

  it("正しいhandoff finalがpost-claimで期限切れならstop_pendingへfenceする", () => {
    const store = createStore();
    const fixture = armAndBind(store, "handoff", "codex", "expired-final");
    const issued = attest(store, fixture, "codex", "codex-expired-final");
    const accepted = claim(store, fixture, issued, "handoff");

    expect(() => store.acceptOrchestratorHandoffWithSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: accepted.launch.revision,
      acceptFenceHash: hash(accepted.acceptFence),
      attestationHandleHash: hash(issued.attestationHandle),
      handoffTokenHash: fixture.handoffTokenHash,
      now: fixture.now + 121,
    })).toThrow("期限切れ");
    expect(store.getSuccessorLaunch(fixture.slotId)).toMatchObject({
      status: "stop_pending",
      stopFenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(store.getOrchestratorSession(fixture.source.id)?.status).toBe("handoff_pending");
  });

  it.each([
    ["codex", "codex-session-start"],
    ["claude", "claude-delivery"],
  ] as const)("%s handoff finalはtrusted sourceとsuccessorを単一Txで確定する", (provider, source) => {
    const store = createStore();
    const fixture = armAndBind(store, "handoff", provider, `final-${provider}`);
    const issued = attest(store, fixture, provider, `${provider}-final-session`);
    const accepted = claim(store, fixture, issued, "handoff");
    const successor = store.acceptOrchestratorHandoffWithSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: accepted.launch.revision,
      acceptFenceHash: hash(accepted.acceptFence),
      attestationHandleHash: hash(issued.attestationHandle),
      handoffTokenHash: fixture.handoffTokenHash,
      now: fixture.now + 4,
    });

    expect(successor).toMatchObject({
      provider,
      providerSessionId: `${provider}-final-session`,
      providerSessionSource: source,
    });
    expect(store.getOrchestratorSession(fixture.source.id)?.status).toBe("superseded");
    expect(store.getSuccessorLaunch(fixture.slotId)).toMatchObject({
      status: "succeeded",
      successorSessionId: successor.id,
      successorGeneration: successor.generation,
    });
    const replay = store.acceptOrchestratorHandoffWithSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: accepted.launch.revision,
      acceptFenceHash: hash(accepted.acceptFence),
      attestationHandleHash: hash(issued.attestationHandle),
      handoffTokenHash: fixture.handoffTokenHash,
      now: fixture.now + 5,
    });
    expect(replay.id).toBe(successor.id);
    expect(() => store.acceptOrchestratorHandoffWithSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: accepted.launch.revision,
      acceptFenceHash: hash(accepted.acceptFence),
      attestationHandleHash: hash(issued.attestationHandle),
      handoffTokenHash: hash("wrong-success-replay-token"),
      now: fixture.now + 6,
    })).toThrow();
  });

  it("takeover finalは保存cutoffで旧sessionをstale化しclaimをrequeueしてtrusted successorを作る", () => {
    const store = createStore();
    const fixture = armAndBind(store, "takeover", "claude", "takeover-final");
    const task = store.createTask({
      title: "takeover claim",
      body: "cwd: /repo/takeover-final",
      tenant: "dev",
    }, "tester");
    store.bindTaskToOrchestrator(task.id, fixture.source.orchestratorId, "primary");
    const request = store.createOrGetOrchestratorRequest({ taskId: task.id, questionId: "q-takeover", question: "確認" });
    store.claimOrchestratorRequest({
      requestId: request.id,
      sessionId: fixture.source.id,
      generation: fixture.source.generation,
      claimToken: "takeover-claim",
      leaseUntil: fixture.now + 60,
    });
    const issued = attest(store, fixture, "claude", "claude-takeover-final");
    const accepted = claim(store, fixture, issued, "takeover");
    const successor = store.takeoverStaleOrchestratorSessionWithSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: accepted.launch.revision,
      acceptFenceHash: hash(accepted.acceptFence),
      attestationHandleHash: hash(issued.attestationHandle),
      now: fixture.now + 4,
    });
    expect(successor).toMatchObject({ provider: "claude", providerSessionSource: "claude-delivery" });
    expect(store.getOrchestratorSession(fixture.source.id)?.status).toBe("stale");
    expect(store.getOrchestratorRequest(request.id)).toMatchObject({
      status: "queued",
      claimantSessionId: "",
      claimantGeneration: null,
    });
  });

  it("別DB connectionのfinal race/replayは同じsuccessorへ収束し二重generationを作らない", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-successor-final-race-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "kanban.db");
    const firstStore = createStore(dbPath);
    const fixture = armAndBind(firstStore, "handoff", "codex", "final-race");
    const issued = attest(firstStore, fixture, "codex", "codex-final-race");
    const accepted = claim(firstStore, fixture, issued, "handoff");
    const secondStore = createStore(dbPath);
    const input = {
      slotId: fixture.slotId,
      expectedRevision: accepted.launch.revision,
      acceptFenceHash: hash(accepted.acceptFence),
      attestationHandleHash: hash(issued.attestationHandle),
      handoffTokenHash: fixture.handoffTokenHash,
      now: fixture.now + 4,
    };

    const first = firstStore.acceptOrchestratorHandoffWithSuccessorLaunch(input);
    const second = secondStore.acceptOrchestratorHandoffWithSuccessorLaunch(input);

    expect(second.id).toBe(first.id);
    expect(firstStore.listOrchestratorSessions(fixture.source.orchestratorId).filter(
      (session) => session.status === "active",
    )).toEqual([expect.objectContaining({ id: first.id })]);
  });

  it("takeoverはarm時cutoffを再検証し、heartbeat revival時は旧session/claimを維持してstop_pendingにする", () => {
    const store = createStore();
    const fixture = armAndBind(store, "takeover", "codex", "cutoff-drift");
    const issued = attest(store, fixture, "codex", "codex-cutoff-drift");
    const accepted = claim(store, fixture, issued, "takeover");
    store.heartbeatOrchestratorSession(fixture.source.id, fixture.source.generation, fixture.now);

    expect(() => store.takeoverStaleOrchestratorSessionWithSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: accepted.launch.revision,
      acceptFenceHash: hash(accepted.acceptFence),
      attestationHandleHash: hash(issued.attestationHandle),
      now: fixture.now + 4,
    })).toThrow("stored stale cutoff");
    expect(store.getOrchestratorSession(fixture.source.id)?.status).toBe("active");
    expect(store.getSuccessorLaunch(fixture.slotId)?.status).toBe("stop_pending");
  });

  it("handoff unbound rollbackはsourceとslotを同一Txで戻し、partial readbackはuncertainを維持する", () => {
    const store = createStore();
    const now = Math.floor(Date.now() / 1000);
    const orchestrator = store.registerOrchestrator({ label: "unbound", project: "hachi", repoCommonDir: "/repo/.git" });
    const source = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    const armInput = {
      orchestratorId: orchestrator.id,
      targetProvider: "codex" as const,
      sourceSessionId: source.id,
      sourceGeneration: source.generation,
      canonicalCwd: "/repo/unbound",
      hostId: "host-unbound",
      launchNonceHash: hash("unbound-launch"),
      plannedTmuxSession: "tmux-unbound",
      hookDefinitionHash: hash("unbound-hook"),
      hookExecutableHash: hash("unbound-helper"),
      runtimeDeadlineAt: now + 60,
      attestationDeadlineAt: now + 120,
      kind: "handoff" as const,
      handoffTokenFenceHash: hash("unbound-token"),
      handoffExpiresAt: now + 120,
      now,
    };
    const rejected = store.armSuccessorLaunch(armInput);
    const terminal = store.resolveUnboundSuccessorLaunch({
      slotId: rejected.id,
      expectedRevision: rejected.revision,
      to: "rejected",
      error: "spawn前失敗",
      now: now + 1,
    });
    expect(terminal.status).toBe("rejected");
    expect(store.getOrchestratorSession(source.id)?.status).toBe("active");

    const partial = store.armSuccessorLaunch({ ...armInput, launchNonceHash: hash("partial-launch"), now: now + 2 });
    const pending = store.markArmedSuccessorLaunchStopPending({
      slotId: partial.id,
      expectedRevision: partial.revision,
      observedCanonicalCwd: "/repo/unbound",
      observedHostId: "host-unbound",
      tmuxSession: "tmux-unbound",
      tmuxPane: null,
      panePid: null,
      processGroupId: null,
      tmuxSocketPath: null,
      tmuxServerPid: null,
      tmuxServerStartTime: null,
      tmuxServerLifetimeHash: null,
      ownerNonceHash: null,
      observedHookDefinitionHash: null,
      observedHookExecutableHash: null,
      error: "partial readback",
      now: now + 3,
    });
    const uncertain = store.recordSuccessorLaunchStop({
      slotId: partial.id,
      expectedRevision: pending.launch.revision,
      stopFenceHash: hash(pending.stopFence),
      killOwnerReadbackHash: "",
      evidence: {
        ownerMatched: null,
        ownerReadbackAt: null,
        killResult: "unknown",
        tmuxSessionAbsent: null,
        panePidAbsent: null,
        processGroupAbsent: null,
        observedAt: now + 4,
      },
      now: now + 4,
    });
    expect(uncertain.status).toBe("uncertain");
    expect(store.successorReplacementGate(orchestrator.id).allowed).toBe(false);
  });

  it("normal stopは三点停止とowner一致だけでstoppedにしhandoffをactiveへ戻す", () => {
    const store = createStore();
    const fixture = armAndBind(store, "handoff", "codex", "normal-stop");
    const bound = store.getSuccessorLaunch(fixture.slotId)!;
    const pending = store.markSuccessorLaunchStopPending({
      slotId: fixture.slotId,
      expectedRevision: bound.revision,
      expectedStatus: "runtime_bound",
      error: "hook timeout",
      now: fixture.now + 2,
    });
    const stopped = store.recordSuccessorLaunchStop({
      slotId: fixture.slotId,
      expectedRevision: pending.launch.revision,
      stopFenceHash: hash(pending.stopFence),
      killOwnerReadbackHash: fixture.ownerNonceHash,
      evidence: { ...completeStopEvidence, ownerReadbackAt: fixture.now + 3, observedAt: fixture.now + 4 },
      now: fixture.now + 4,
    });
    expect(stopped.status).toBe("stopped");
    expect(stopped.runtimeOwnershipClaimed).toBe(false);
    expect(store.getOrchestratorSession(fixture.source.id)?.status).toBe("active");
  });

  it("kill成功後にPGIDだけ残ったuncertainは保存済みowner/kill証拠を維持してfresh三点でstoppedへ収束する", () => {
    const store = createStore();
    const fixture = armAndBind(store, "handoff", "claude", "uncertain-reclaim");
    const bound = store.getSuccessorLaunch(fixture.slotId)!;
    const pending = store.markSuccessorLaunchStopPending({
      slotId: fixture.slotId,
      expectedRevision: bound.revision,
      expectedStatus: "runtime_bound",
      error: "caller crashed",
      now: fixture.now + 2,
    });
    const uncertain = store.recordSuccessorLaunchStop({
      slotId: fixture.slotId,
      expectedRevision: pending.launch.revision,
      stopFenceHash: hash(pending.stopFence),
      killOwnerReadbackHash: fixture.ownerNonceHash,
      evidence: {
        ownerMatched: true,
        ownerReadbackAt: fixture.now + 3,
        killResult: "succeeded",
        tmuxSessionAbsent: true,
        panePidAbsent: true,
        processGroupAbsent: false,
        observedAt: fixture.now + 3,
      },
      now: fixture.now + 3,
    });
    const reclaimed = store.markSuccessorLaunchStopPending({
      slotId: fixture.slotId,
      expectedRevision: uncertain.revision,
      expectedStatus: "uncertain",
      error: "restart recovery",
      now: fixture.now + 4,
    });
    expect(reclaimed.stopFence).toBe(pending.stopFence);

    const stopped = store.recordSuccessorLaunchStop({
      slotId: fixture.slotId,
      expectedRevision: reclaimed.launch.revision,
      stopFenceHash: hash(reclaimed.stopFence),
      // 再起動後は消滅済み tmux から owner を再読込できない。caller の欠落値で保存済み証拠を壊さない。
      killOwnerReadbackHash: "",
      evidence: {
        ownerMatched: null,
        ownerReadbackAt: null,
        killResult: "not-attempted",
        tmuxSessionAbsent: true,
        panePidAbsent: true,
        processGroupAbsent: true,
        observedAt: fixture.now + 5,
      },
      now: fixture.now + 5,
    });
    expect(stopped.status).toBe("stopped");
    expect(stopped.runtimeOwnershipClaimed).toBe(false);
    expect(stopped.killOwnerReadbackHash).toBe(fixture.ownerNonceHash);
    expect(stopped.stopEvidence).toMatchObject({
      ownerMatched: true,
      ownerReadbackAt: fixture.now + 3,
      killResult: "succeeded",
      tmuxSessionAbsent: true,
      panePidAbsent: true,
      processGroupAbsent: true,
    });
    expect(store.getOrchestratorSession(fixture.source.id)?.status).toBe("active");
  });

  it.each([
    {
      label: "owner不一致",
      killOwnerReadbackHash: hash("different-owner"),
      ownerMatched: false,
      killResult: "not-attempted" as const,
      freshProcessGroupAbsent: true,
    },
    {
      label: "kill結果不明",
      killOwnerReadbackHash: "owner",
      ownerMatched: true,
      killResult: "unknown" as const,
      freshProcessGroupAbsent: true,
    },
    {
      label: "fresh PGID残存",
      killOwnerReadbackHash: "owner",
      ownerMatched: true,
      killResult: "succeeded" as const,
      freshProcessGroupAbsent: false,
    },
  ])("uncertain再回復は$labelなら保存済み証拠を推測で補完せずuncertainを維持する", (testCase) => {
    const store = createStore();
    const fixture = armAndBind(store, "takeover", "codex", `uncertain-${testCase.label}`);
    const bound = store.getSuccessorLaunch(fixture.slotId)!;
    const pending = store.markSuccessorLaunchStopPending({
      slotId: fixture.slotId,
      expectedRevision: bound.revision,
      expectedStatus: "runtime_bound",
      error: testCase.label,
      now: fixture.now + 2,
    });
    const savedKillOwnerReadbackHash = testCase.killOwnerReadbackHash === "owner"
      ? fixture.ownerNonceHash
      : testCase.killOwnerReadbackHash;
    const uncertain = store.recordSuccessorLaunchStop({
      slotId: fixture.slotId,
      expectedRevision: pending.launch.revision,
      stopFenceHash: hash(pending.stopFence),
      killOwnerReadbackHash: savedKillOwnerReadbackHash,
      evidence: {
        ownerMatched: testCase.ownerMatched,
        ownerReadbackAt: fixture.now + 3,
        killResult: testCase.killResult,
        tmuxSessionAbsent: true,
        panePidAbsent: true,
        processGroupAbsent: false,
        observedAt: fixture.now + 3,
      },
      now: fixture.now + 3,
    });
    expect(uncertain.status).toBe("uncertain");
    const reclaimed = store.markSuccessorLaunchStopPending({
      slotId: fixture.slotId,
      expectedRevision: uncertain.revision,
      expectedStatus: "uncertain",
      error: "restart recovery",
      now: fixture.now + 4,
    });

    const recovered = store.recordSuccessorLaunchStop({
      slotId: fixture.slotId,
      expectedRevision: reclaimed.launch.revision,
      stopFenceHash: hash(reclaimed.stopFence),
      // caller が成功証拠を提示しても、uncertain row の保存済み owner/kill 証拠だけを正本にする。
      killOwnerReadbackHash: fixture.ownerNonceHash,
      evidence: {
        ...completeStopEvidence,
        processGroupAbsent: testCase.freshProcessGroupAbsent,
        observedAt: fixture.now + 5,
      },
      now: fixture.now + 5,
    });
    expect(recovered.status).toBe("uncertain");
    expect(recovered.killOwnerReadbackHash).toBe(savedKillOwnerReadbackHash);
    expect(recovered.stopEvidence).toMatchObject({
      ownerMatched: testCase.ownerMatched,
      killResult: testCase.killResult,
      processGroupAbsent: testCase.freshProcessGroupAbsent,
    });
  });

  it("public rollback-complete は uncertain の exact fence と完全証拠でだけ解除する", () => {
    const store = createStore();
    const fixture = armAndBind(store, "handoff", "codex", "explicit-stop");
    const bound = store.getSuccessorLaunch(fixture.slotId)!;
    const pending = store.markSuccessorLaunchStopPending({
      slotId: fixture.slotId,
      expectedRevision: bound.revision,
      expectedStatus: "runtime_bound",
      error: "kill result unknown",
      now: fixture.now + 2,
    });
    const uncertain = store.recordSuccessorLaunchStop({
      slotId: fixture.slotId,
      expectedRevision: pending.launch.revision,
      stopFenceHash: hash(pending.stopFence),
      killOwnerReadbackHash: fixture.ownerNonceHash,
      evidence: { ...completeStopEvidence, processGroupAbsent: false },
      now: fixture.now + 3,
    });
    expect(uncertain.status).toBe("uncertain");
    expect(store.rollbackCompleteSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: uncertain.revision,
      stopFenceHash: hash("wrong"),
      evidence: completeStopEvidence,
      apply: true,
      now: fixture.now + 4,
    })).toMatchObject({ applied: false, reason: "fence-mismatch" });
    const preview = store.rollbackCompleteSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: uncertain.revision,
      stopFenceHash: hash(pending.stopFence),
      evidence: completeStopEvidence,
      apply: false,
      now: fixture.now + 4,
    });
    expect(preview).toMatchObject({ applicable: true, applied: false, reason: "complete-stop-evidence" });
    const applied = store.rollbackCompleteSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: uncertain.revision,
      stopFenceHash: hash(pending.stopFence),
      evidence: completeStopEvidence,
      apply: true,
      now: fixture.now + 5,
    });
    expect(applied).toMatchObject({ applicable: true, applied: true, launch: { status: "stopped" } });
    expect(store.getOrchestratorSession(fixture.source.id)?.status).toBe("active");
  });

  it("fenced close は完全な保存済み証拠とfresh三点不在でslotを閉じsourceをactiveへ戻す", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-successor-fenced-close-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "kanban.db");
    const store = createStore(dbPath);
    const fixture = armAndBind(store, "handoff", "codex", "fenced-close");
    const bound = store.getSuccessorLaunch(fixture.slotId)!;
    const pending = store.markSuccessorLaunchStopPending({
      slotId: fixture.slotId,
      expectedRevision: bound.revision,
      expectedStatus: "runtime_bound",
      error: "stop observation was incomplete",
      now: fixture.now + 2,
    });
    const uncertain = store.recordSuccessorLaunchStop({
      slotId: fixture.slotId,
      expectedRevision: pending.launch.revision,
      stopFenceHash: hash(pending.stopFence),
      killOwnerReadbackHash: fixture.ownerNonceHash,
      evidence: { ...completeStopEvidence, processGroupAbsent: false },
      now: fixture.now + 3,
    });
    const raw = new Database(dbPath);
    raw.prepare(
      `UPDATE orchestrator_successor_launches SET stop_process_group_absent = 1 WHERE id = ?`,
    ).run(fixture.slotId);
    raw.close();
    const before = store.getSuccessorLaunch(fixture.slotId)!;
    const result = store.closeUncertainSuccessorLaunchWithOrchestrator({
      slotId: fixture.slotId,
      expectedRevision: uncertain.revision,
      provenance: {
        kind: "orchestrator",
        actorId: fixture.source.orchestratorId,
        actorSessionId: fixture.source.id,
        actorGeneration: fixture.source.generation,
      },
      freshObservation: {
        tmuxSessionAbsent: true,
        panePidAbsent: true,
        processGroupAbsent: true,
        observedAt: fixture.now + 4,
      },
      confirm: true,
      now: fixture.now + 4,
    });
    expect(result).toMatchObject({ applicable: true, applied: true, launch: { status: "stopped" } });
    expect(result.launch.stopEvidence).toEqual(before.stopEvidence);
    expect(store.getOrchestratorSession(fixture.source.id)?.status).toBe("active");
    expect(store.listBoardAuditEvents("successor_launch_stopped")).toHaveLength(1);
  });

  it("fenced close はfresh target生存・保存証拠欠落・generation不一致・非uncertainを拒否する", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-successor-fenced-close-reject-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "kanban.db");
    const store = createStore(dbPath);
    const fixture = armAndBind(store, "handoff", "codex", "fenced-close-reject");
    const bound = store.getSuccessorLaunch(fixture.slotId)!;
    const provenance = {
      kind: "orchestrator" as const,
      actorId: fixture.source.orchestratorId,
      actorSessionId: fixture.source.id,
      actorGeneration: fixture.source.generation,
    };
    expect(() => store.closeUncertainSuccessorLaunchWithOrchestrator({
      slotId: fixture.slotId,
      expectedRevision: bound.revision,
      provenance,
      freshObservation: {
        tmuxSessionAbsent: true, panePidAbsent: true, processGroupAbsent: true,
        observedAt: fixture.now + 2,
      },
      confirm: true,
      now: fixture.now + 2,
    })).toThrow("statusUncertain");

    const pending = store.markSuccessorLaunchStopPending({
      slotId: fixture.slotId,
      expectedRevision: bound.revision,
      expectedStatus: "runtime_bound",
      error: "stop observation was incomplete",
      now: fixture.now + 2,
    });
    const uncertain = store.recordSuccessorLaunchStop({
      slotId: fixture.slotId,
      expectedRevision: pending.launch.revision,
      stopFenceHash: hash(pending.stopFence),
      killOwnerReadbackHash: fixture.ownerNonceHash,
      evidence: { ...completeStopEvidence, processGroupAbsent: false },
      now: fixture.now + 3,
    });
    const base = {
      slotId: fixture.slotId,
      expectedRevision: uncertain.revision,
      provenance,
      confirm: true,
      now: fixture.now + 4,
    };
    expect(() => store.closeUncertainSuccessorLaunchWithOrchestrator({
      ...base,
      freshObservation: {
        tmuxSessionAbsent: true, panePidAbsent: true, processGroupAbsent: true,
        observedAt: fixture.now + 4,
      },
    })).toThrow("storedStopEvidenceComplete");
    const raw = new Database(dbPath);
    raw.prepare(
      `UPDATE orchestrator_successor_launches SET stop_process_group_absent = 1 WHERE id = ?`,
    ).run(fixture.slotId);
    raw.close();
    expect(() => store.closeUncertainSuccessorLaunchWithOrchestrator({
      ...base,
      freshObservation: {
        tmuxSessionAbsent: false, panePidAbsent: true, processGroupAbsent: true,
        observedAt: fixture.now + 4,
      },
    })).toThrow("freshTargetAbsent");
    expect(() => store.closeUncertainSuccessorLaunchWithOrchestrator({
      ...base,
      provenance: { ...provenance, actorGeneration: provenance.actorGeneration + 1 },
      freshObservation: {
        tmuxSessionAbsent: true, panePidAbsent: true, processGroupAbsent: true,
        observedAt: fixture.now + 4,
      },
    })).toThrow("callerSessionGenerationActive");
    expect(store.getSuccessorLaunch(fixture.slotId)?.status).toBe("uncertain");
  });

  it("unknown kill後は保存済みowner/kill履歴を変えずfresh三点不在でrollback-completeできる", () => {
    const store = createStore();
    const fixture = armAndBind(store, "takeover", "codex", "unknown-kill-recovery");
    const bound = store.getSuccessorLaunch(fixture.slotId)!;
    const pending = store.markSuccessorLaunchStopPending({
      slotId: fixture.slotId,
      expectedRevision: bound.revision,
      expectedStatus: "runtime_bound",
      error: "kill result unknown",
      now: fixture.now + 2,
    });
    const ownerReadbackAt = fixture.now + 3;
    const uncertain = store.recordSuccessorLaunchStop({
      slotId: fixture.slotId,
      expectedRevision: pending.launch.revision,
      stopFenceHash: hash(pending.stopFence),
      killOwnerReadbackHash: fixture.ownerNonceHash,
      evidence: {
        ownerMatched: true,
        ownerReadbackAt,
        killResult: "unknown",
        tmuxSessionAbsent: null,
        panePidAbsent: null,
        processGroupAbsent: null,
        observedAt: fixture.now + 3,
      },
      now: fixture.now + 3,
    });
    expect(uncertain.status).toBe("uncertain");
    const recovered = store.rollbackCompleteSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: uncertain.revision,
      stopFenceHash: hash(pending.stopFence),
      evidence: {
        ownerMatched: true,
        ownerReadbackAt,
        killResult: "unknown",
        tmuxSessionAbsent: true,
        panePidAbsent: true,
        processGroupAbsent: true,
        observedAt: fixture.now + 4,
      },
      apply: true,
      now: fixture.now + 4,
    });
    expect(recovered).toMatchObject({ applicable: true, applied: true, launch: { status: "stopped" } });
    expect(recovered.launch.stopEvidence.killResult).toBe("unknown");
  });

  it("owner mismatchでuncertainになったslotはcallerのcomplete booleanだけでは解除しない", () => {
    const store = createStore();
    const fixture = armAndBind(store, "takeover", "codex", "owner-mismatch-recovery");
    const bound = store.getSuccessorLaunch(fixture.slotId)!;
    const pending = store.markSuccessorLaunchStopPending({
      slotId: fixture.slotId,
      expectedRevision: bound.revision,
      expectedStatus: "runtime_bound",
      error: "owner mismatch",
      now: fixture.now + 2,
    });
    const uncertain = store.recordSuccessorLaunchStop({
      slotId: fixture.slotId,
      expectedRevision: pending.launch.revision,
      stopFenceHash: hash(pending.stopFence),
      killOwnerReadbackHash: hash("different-owner"),
      evidence: {
        ...completeStopEvidence,
        ownerMatched: false,
        killResult: "not-attempted",
      },
      now: fixture.now + 3,
    });
    expect(uncertain.status).toBe("uncertain");
    expect(store.rollbackCompleteSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: uncertain.revision,
      stopFenceHash: hash(pending.stopFence),
      evidence: completeStopEvidence,
      apply: true,
      now: fixture.now + 4,
    })).toMatchObject({
      applicable: false,
      applied: false,
      reason: "incomplete-stop-evidence",
      launch: { status: "uncertain" },
    });
  });

  it("claimed=0 legacy uncertainはexplicit rollback-completeのexact fence/owner/source/token/fresh三点だけで回復する", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-successor-legacy-recovery-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "kanban.db");
    const firstStore = new SqliteKanbanStore(dbPath);
    const fixture = armAndBind(firstStore, "handoff", "codex", "legacy-uncertain-recovery");
    const bound = firstStore.getSuccessorLaunch(fixture.slotId)!;
    const pending = firstStore.markSuccessorLaunchStopPending({
      slotId: fixture.slotId,
      expectedRevision: bound.revision,
      expectedStatus: "runtime_bound",
      error: "legacy recovery fixture",
      now: fixture.now + 2,
    });
    const ownerReadbackAt = fixture.now + 3;
    const uncertain = firstStore.recordSuccessorLaunchStop({
      slotId: fixture.slotId,
      expectedRevision: pending.launch.revision,
      stopFenceHash: hash(pending.stopFence),
      killOwnerReadbackHash: fixture.ownerNonceHash,
      evidence: {
        ownerMatched: true,
        ownerReadbackAt,
        killResult: "unknown",
        tmuxSessionAbsent: null,
        panePidAbsent: null,
        processGroupAbsent: null,
        observedAt: fixture.now + 3,
      },
      now: fixture.now + 3,
    });
    firstStore.close();

    const raw = new Database(dbPath);
    try {
      raw.prepare(
        `UPDATE orchestrator_successor_launches
         SET runtime_ownership_claimed = 0, tmux_socket_path = '', tmux_server_pid = NULL,
             tmux_server_start_time = NULL, tmux_server_lifetime_hash = ''
         WHERE id = ?`,
      ).run(fixture.slotId);
    } finally {
      raw.close();
    }

    const reopened = createStore(dbPath);
    expect(reopened.getSuccessorLaunch(fixture.slotId)).toMatchObject({
      status: "uncertain",
      revision: uncertain.revision,
      runtimeOwnershipClaimed: false,
      stopEvidence: { ownerMatched: true, ownerReadbackAt, killResult: "unknown" },
    });
    const exactEvidence = {
      ownerMatched: true,
      ownerReadbackAt,
      killResult: "unknown" as const,
      tmuxSessionAbsent: true,
      panePidAbsent: true,
      processGroupAbsent: true,
      observedAt: fixture.now + 4,
    };
    const fenceHash = hash(pending.stopFence);
    const expectSlotMutationZero = (expectedRevision: number): void => {
      expect(reopened.getSuccessorLaunch(fixture.slotId)).toMatchObject({
        status: "uncertain",
        revision: expectedRevision,
        runtimeOwnershipClaimed: false,
      });
    };

    expect(reopened.rollbackCompleteSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: uncertain.revision,
      stopFenceHash: hash("wrong-legacy-stop-fence"),
      evidence: exactEvidence,
      apply: true,
      now: fixture.now + 4,
    })).toMatchObject({ applicable: false, applied: false, reason: "fence-mismatch" });
    expect(reopened.rollbackCompleteSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: uncertain.revision + 1,
      stopFenceHash: fenceHash,
      evidence: exactEvidence,
      apply: true,
      now: fixture.now + 4,
    })).toMatchObject({ applicable: false, applied: false, reason: "state-mismatch" });
    for (const incomplete of [
      { ownerMatched: false },
      { ownerReadbackAt: ownerReadbackAt + 1 },
      { killResult: "succeeded" as const },
      { tmuxSessionAbsent: false },
      { tmuxSessionAbsent: null },
      { panePidAbsent: false },
      { panePidAbsent: null },
      { processGroupAbsent: false },
      { processGroupAbsent: null },
    ]) {
      expect(reopened.rollbackCompleteSuccessorLaunch({
        slotId: fixture.slotId,
        expectedRevision: uncertain.revision,
        stopFenceHash: fenceHash,
        evidence: { ...exactEvidence, ...incomplete },
        apply: true,
        now: fixture.now + 4,
      })).toMatchObject({ applicable: false, applied: false, reason: "incomplete-stop-evidence" });
      expectSlotMutationZero(uncertain.revision);
    }

    const normalStop = reopened.recordSuccessorLaunchStop({
      slotId: fixture.slotId,
      expectedRevision: uncertain.revision,
      stopFenceHash: fenceHash,
      killOwnerReadbackHash: fixture.ownerNonceHash,
      evidence: exactEvidence,
      now: fixture.now + 4,
    });
    expect(normalStop).toMatchObject({ status: "uncertain", runtimeOwnershipClaimed: false });

    for (const sourceDrift of [
      { status: "active", handoffTokenHash: fixture.handoffTokenHash },
      { status: "handoff_pending", handoffTokenHash: hash("drifted-handoff-token") },
    ]) {
      const drift = new Database(dbPath);
      try {
        drift.prepare(
          `UPDATE orchestrator_sessions SET status = ?, handoff_token_hash = ? WHERE id = ?`,
        ).run(sourceDrift.status, sourceDrift.handoffTokenHash, fixture.source.id);
      } finally {
        drift.close();
      }
      expect(reopened.rollbackCompleteSuccessorLaunch({
        slotId: fixture.slotId,
        expectedRevision: normalStop.revision,
        stopFenceHash: fenceHash,
        evidence: exactEvidence,
        apply: true,
        now: fixture.now + 5,
      })).toMatchObject({ applicable: false, applied: false, reason: "state-mismatch" });
      expectSlotMutationZero(normalStop.revision);
    }
    const restoreSource = new Database(dbPath);
    try {
      restoreSource.prepare(
        `UPDATE orchestrator_sessions SET status = 'handoff_pending', handoff_token_hash = ? WHERE id = ?`,
      ).run(fixture.handoffTokenHash, fixture.source.id);
    } finally {
      restoreSource.close();
    }

    const preview = reopened.rollbackCompleteSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: normalStop.revision,
      stopFenceHash: fenceHash,
      evidence: exactEvidence,
      apply: false,
      now: fixture.now + 5,
    });
    expect(preview).toMatchObject({ applicable: true, applied: false, reason: "complete-stop-evidence" });
    expectSlotMutationZero(normalStop.revision);
    const applied = reopened.rollbackCompleteSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: normalStop.revision,
      stopFenceHash: fenceHash,
      evidence: exactEvidence,
      apply: true,
      now: fixture.now + 6,
    });
    expect(applied).toMatchObject({
      applicable: true,
      applied: true,
      launch: { status: "stopped", runtimeOwnershipClaimed: false },
    });
    expect(reopened.getOrchestratorSession(fixture.source.id)).toMatchObject({
      status: "active",
      handoffTokenHash: "",
    });
  });

  it("attestation TTLとowner-only raw capabilityはDB再読込後もdurableで、公開rowへ露出しない", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-successor-test-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "kanban.db");
    const first = createStore(dbPath);
    const fixture = armAndBind(first, "handoff", "codex", "reload");
    const issued = attest(first, fixture, "codex", "codex-reload");
    expect(JSON.stringify(issued.launch)).not.toContain(issued.attestationHandle);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = createStore(dbPath);
    expect(() => reopened.claimSuccessorLaunchAccept({
      slotId: fixture.slotId,
      expectedRevision: issued.launch.revision,
      attestationHandleHash: hash(issued.attestationHandle),
      operation: "handoff",
      now: fixture.now + 121,
    })).toThrow("TTL");
    expect(reopened.getSuccessorLaunch(fixture.slotId)?.status).toBe("stop_pending");
  });

  it("generic provider/ID pairはmanualを内部導出し、v23以前の空sourceをtrustedへ昇格しない", () => {
    const store = createStore();
    const manual = store.registerOrchestrator({ label: "manual", project: "hachi", repoCommonDir: "/repo/.git" });
    const session = store.startOrchestratorSession({
      orchestratorId: manual.id,
      provider: "codex",
      providerSessionId: "caller-supplied",
    });
    expect(session.providerSessionSource).toBe("manual");

    const legacy = store.registerOrchestrator({ label: "legacy", project: "hachi", repoCommonDir: "/legacy/.git" });
    const legacySession = store.startOrchestratorSession({ orchestratorId: legacy.id });
    expect(legacySession.provider).toBe("");
    expect(legacySession.providerSessionSource).toBe("");
  });

  it("generic start/handoff/takeoverはproviderとsession IDの片側指定をmutation前に拒否する", () => {
    const store = createStore();

    const start = store.registerOrchestrator({ label: "pair-start", project: "hachi", repoCommonDir: "/start/.git" });
    expect(() => store.startOrchestratorSession({ orchestratorId: start.id, provider: "codex" }))
      .toThrow("両方指定または両方省略");
    expect(() => store.startOrchestratorSession({ orchestratorId: start.id, providerSessionId: "codex-start" }))
      .toThrow("両方指定または両方省略");
    expect(store.listOrchestratorSessions(start.id)).toHaveLength(0);

    const handoff = store.registerOrchestrator({
      label: "pair-handoff",
      project: "hachi",
      repoCommonDir: "/handoff/.git",
    });
    const handoffSource = store.startOrchestratorSession({ orchestratorId: handoff.id });
    const handoffTokenHash = hash("pair-handoff-token");
    store.prepareOrchestratorHandoff(
      handoffSource.id,
      handoffSource.generation,
      handoffTokenHash,
      handoffSource.heartbeatAt + 60,
    );
    expect(() => store.acceptOrchestratorHandoff({
      oldSessionId: handoffSource.id,
      tokenHash: handoffTokenHash,
      provider: "codex",
    })).toThrow("両方指定または両方省略");
    expect(() => store.acceptOrchestratorHandoff({
      oldSessionId: handoffSource.id,
      tokenHash: handoffTokenHash,
      providerSessionId: "codex-handoff",
    })).toThrow("両方指定または両方省略");
    expect(store.getOrchestratorSession(handoffSource.id)?.status).toBe("handoff_pending");

    const takeover = store.registerOrchestrator({
      label: "pair-takeover",
      project: "hachi",
      repoCommonDir: "/takeover/.git",
    });
    const takeoverSource = store.startOrchestratorSession({ orchestratorId: takeover.id });
    expect(() => store.takeoverStaleOrchestratorSession({
      orchestratorId: takeover.id,
      staleBefore: takeoverSource.heartbeatAt + 1,
      provider: "codex",
    })).toThrow("両方指定または両方省略");
    expect(() => store.takeoverStaleOrchestratorSession({
      orchestratorId: takeover.id,
      staleBefore: takeoverSource.heartbeatAt + 1,
      providerSessionId: "codex-takeover",
    })).toThrow("両方指定または両方省略");
    expect(store.getOrchestratorSession(takeoverSource.id)?.status).toBe("active");
  });

  it.each(["manual", ""] as const)(
    "%s provider session sourceはnative source binding authorityに使えない",
    (providerSessionSource) => {
      const dir = mkdtempSync(join(tmpdir(), "hachi-successor-legacy-source-"));
      tempDirs.push(dir);
      const dbPath = join(dir, "kanban.db");
      const store = createStore(dbPath);
      const orchestrator = store.registerOrchestrator({
        label: "legacy-native",
        project: "hachi",
        repoCommonDir: "/repo/.git",
      });
      const session = store.startOrchestratorSession({
        orchestratorId: orchestrator.id,
        provider: "codex",
        providerSessionId: "legacy-native-session",
      });
      const provenance = {
        kind: "orchestrator" as const,
        actorId: orchestrator.id,
        actorSessionId: session.id,
        actorGeneration: session.generation,
      };
      const task = store.createTask(
        { title: "legacy native", body: "cwd: /repo/legacy", tenant: "dev", status: "ready" },
        "orchestrator",
        provenance,
      );
      store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
      if (providerSessionSource === "") {
        const raw = new Database(dbPath);
        try {
          raw.prepare(`UPDATE orchestrator_sessions SET provider_session_source = '' WHERE id = ?`).run(session.id);
        } finally {
          raw.close();
        }
      }
      const now = Math.floor(Date.now() / 1000);
      expect(() => store.createOrGetNativeSourceBinding({
        bindingKey: "legacy-native-source",
        provider: "codex",
        hostId: "host-local",
        providerSessionId: "legacy-native-session",
        runtimeVersion: "1.0.0",
        capabilityHash: hash("legacy-native-capability"),
        observedAt: now,
        expiresAt: now + 60,
        taskId: task.id,
        provenance,
      })).toThrow("active provider orchestrator session");
    },
  );

  it("terminal化時はraw handle/fenceをowner-only tableから消去する", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-successor-capability-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "kanban.db");
    const store = createStore(dbPath);
    const fixture = armAndBind(store, "handoff", "codex", "capability-clear");
    const issued = attest(store, fixture, "codex", "codex-capability-clear");
    const accepted = claim(store, fixture, issued, "handoff");
    store.acceptOrchestratorHandoffWithSuccessorLaunch({
      slotId: fixture.slotId,
      expectedRevision: accepted.launch.revision,
      acceptFenceHash: hash(accepted.acceptFence),
      attestationHandleHash: hash(issued.attestationHandle),
      handoffTokenHash: fixture.handoffTokenHash,
      now: fixture.now + 4,
    });
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const raw = new Database(dbPath, { readonly: true });
    try {
      expect(raw.prepare(
        `SELECT attestation_handle, accept_fence, stop_fence
         FROM orchestrator_successor_launch_capabilities WHERE launch_id = ?`,
      ).get(fixture.slotId)).toEqual({ attestation_handle: "", accept_fence: "", stop_fence: "" });
    } finally {
      raw.close();
    }
  });
});
