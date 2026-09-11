import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeSessionBindingHash, resolveCommunicationRoute, type CreateCommunicationAttemptInput } from "./communication.js";
import { SqliteKanbanStore } from "./db.js";
import { communicationCanaryCohortKey, isCommunicationCanaryEligible } from "./policy.js";
import type { ActorProvenance, OrchestratorSessionRow, Provider } from "./types.js";

const LAX_NATIVE_BINDING_TABLE_SQL = `
CREATE TABLE native_session_bindings (
  id TEXT,
  binding_key TEXT,
  kind TEXT,
  provider TEXT,
  host_id TEXT,
  provider_session_id TEXT,
  runtime_version TEXT,
  capability_hash TEXT,
  observed_at INTEGER,
  expires_at INTEGER,
  task_id TEXT,
  run_id INTEGER,
  hachi_session_id TEXT,
  target_role TEXT,
  expected_cancel_fence INTEGER,
  orchestrator_id TEXT,
  orchestrator_session_id TEXT,
  orchestrator_generation INTEGER,
  status TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  released_at INTEGER
);
`;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("resolveCommunicationRoute (contract §68)", () => {
  const exact = {
    rollout: "observe" as const,
    preference: "auto" as const,
    sameHost: true,
    exactSourceBinding: true,
    exactTargetBinding: true,
    capability: "supported" as const,
  };

  it("cross-providerは常にHachiを選びexplicit nativeを拒否する", () => {
    expect(resolveCommunicationRoute({ ...exact, sourceProvider: "claude", targetProvider: "codex" }))
      .toEqual({ status: "deliver", route: "hachi", nativeCandidate: null, reason: "cross-provider" });
    expect(resolveCommunicationRoute({
      ...exact,
      sourceProvider: "claude",
      targetProvider: "codex",
      preference: "native",
    })).toMatchObject({ status: "refused", route: null, reason: "native-cross-provider-refused" });
  });

  it("observeはsame-provider native候補を監査するが実配送はHachiのままにする", () => {
    expect(resolveCommunicationRoute({ ...exact, sourceProvider: "claude", targetProvider: "claude" }))
      .toEqual({
        status: "deliver",
        route: "hachi",
        nativeCandidate: "claude-cross-session",
        reason: "observe-only",
      });
  });

  it("onはexact binding/host/capabilityが揃った場合だけprovider nativeを選ぶ", () => {
    expect(resolveCommunicationRoute({
      ...exact,
      rollout: "on",
      sourceProvider: "codex" as const,
      targetProvider: "codex" as const,
    })).toMatchObject({ status: "deliver", route: "codex-app-server", reason: "native-selected" });
    expect(resolveCommunicationRoute({
      ...exact,
      rollout: "on",
      sourceProvider: "codex" as const,
      targetProvider: "codex" as const,
      capability: "unknown",
    })).toMatchObject({ status: "refused", route: null, reason: "native-capability-unknown" });
    expect(resolveCommunicationRoute({
      ...exact,
      rollout: "on",
      sourceProvider: "codex",
      targetProvider: "codex",
      preference: "hachi",
    })).toMatchObject({ status: "refused", route: null, reason: "same-provider-hachi-refused" });
  });

  it("canary非選出だけはsame-providerでもHachiを継続し、選出後はnativeへ切り替える", () => {
    expect(resolveCommunicationRoute({
      ...exact,
      rollout: "canary",
      sourceProvider: "claude",
      targetProvider: "claude",
      canaryEligible: false,
    })).toMatchObject({ status: "deliver", route: "hachi", reason: "canary-not-selected" });
    expect(resolveCommunicationRoute({
      ...exact,
      rollout: "canary",
      sourceProvider: "claude",
      targetProvider: "claude",
      canaryEligible: true,
    })).toMatchObject({ status: "deliver", route: "claude-cross-session", reason: "native-selected" });
    expect(resolveCommunicationRoute({
      ...exact,
      rollout: "canary",
      preference: "native",
      sourceProvider: "claude",
      targetProvider: "claude",
      canaryEligible: false,
    })).toMatchObject({ status: "refused", route: null, reason: "canary-not-selected" });
  });
});

describe("native communication durable control plane", () => {
  let store: SqliteKanbanStore | undefined;
  const bindingEvidence = {
    runtimeVersion: "2.1.226",
    capabilityHash: "a".repeat(64),
    observedAt: 1,
    expiresAt: 4_000_000_000,
  } as const;
  const capabilitySnapshotHash = createHash("sha256")
    .update(JSON.stringify({ source: bindingEvidence.capabilityHash, target: bindingEvidence.capabilityHash }))
    .digest("hex");
  const codexSocketSnapshot = {
    canonicalPath: "/tmp/hachi-codex.sock",
    parentCanonicalPath: "/tmp",
    parentDev: 1,
    parentIno: 2,
    parentUid: 501,
    parentMode: 0o700,
    dev: 3,
    ino: 4,
    uid: 501,
    gid: 20,
    mode: 0o600,
  } as const;
  const serviceProvenance: ActorProvenance = {
    kind: "service",
    actorId: "supervisor",
    actorSessionId: "",
    actorGeneration: null,
  };

  afterEach(() => {
    vi.useRealTimers();
    store?.close();
    store = undefined;
  });

  function startTrustedOrchestratorSession(
    targetStore: SqliteKanbanStore,
    orchestratorId: string,
    provider: Provider,
    providerSessionId: string,
  ): OrchestratorSessionRow {
    const now = Math.floor(Date.now() / 1000);
    const source = targetStore.startOrchestratorSession({ orchestratorId });
    const handoffTokenHash = sha256(`handoff-${providerSessionId}`);
    const canonicalCwd = `/repo/${providerSessionId}`;
    const hostId = `host-${providerSessionId}`;
    const tmuxSession = `tmux-${providerSessionId}`;
    const tmuxPane = "%1";
    const panePid = 21_001;
    const processGroupId = 31_001;
    const tmuxSocketPath = `/tmp/hachi-${providerSessionId}.sock`;
    const tmuxServerPid = 41_001;
    const tmuxServerStartTime = 1_700_000_001;
    const tmuxServerLifetimeHash = sha256(`tmux-server-lifetime-${providerSessionId}`);
    const ownerNonceHash = sha256(`owner-${providerSessionId}`);
    const hookDefinitionHash = sha256(`hook-definition-${providerSessionId}`);
    const hookExecutableHash = sha256(`hook-executable-${providerSessionId}`);
    const armed = targetStore.armSuccessorLaunch({
      orchestratorId,
      targetProvider: provider,
      sourceSessionId: source.id,
      sourceGeneration: source.generation,
      canonicalCwd,
      hostId,
      launchNonceHash: sha256(`launch-${providerSessionId}`),
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
    targetStore.bindSuccessorLaunchRuntime({
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
    const runtime = {
      providerSessionId,
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
      now: now + 2,
    };
    const attested = provider === "codex"
      ? targetStore.attestSuccessorLaunch({
        ...runtime,
        providerSessionSource: "codex-session-start",
        source: "startup",
      })
      : targetStore.attestSuccessorLaunch({
        ...runtime,
        providerSessionSource: "claude-delivery",
        source: "delivery",
      });
    if (attested === null) throw new Error("trusted orchestrator fixture の attestation に失敗しました");
    const claimed = targetStore.claimSuccessorLaunchAccept({
      slotId: armed.id,
      expectedRevision: attested.launch.revision,
      attestationHandleHash: sha256(attested.attestationHandle),
      operation: "handoff",
      now: now + 3,
    });
    return targetStore.acceptOrchestratorHandoffWithSuccessorLaunch({
      slotId: armed.id,
      expectedRevision: claimed.launch.revision,
      acceptFenceHash: sha256(claimed.acceptFence),
      attestationHandleHash: sha256(attested.attestationHandle),
      handoffTokenHash,
      now: now + 4,
    });
  }

  function setup(
    targetProvider: "codex" | "claude" = "codex",
    sourceProvider: "codex" | "claude" = targetProvider,
  ): {
    provenance: ActorProvenance;
    task: ReturnType<SqliteKanbanStore["createTask"]>;
    run: ReturnType<SqliteKanbanStore["startRun"]>;
    delivery: ReturnType<SqliteKanbanStore["createOrGetSteerDelivery"]>;
    source: ReturnType<SqliteKanbanStore["createOrGetNativeSourceBinding"]>;
    target: ReturnType<SqliteKanbanStore["createOrGetNativeTargetBinding"]>;
  } {
    store = new SqliteKanbanStore(":memory:");
    const orchestrator = store.registerOrchestrator({
      label: `communication-${sourceProvider}-${targetProvider}`,
      project: "hachi-kanban",
      repoCommonDir: "/repo/.git",
    });
    const orchestratorSession = startTrustedOrchestratorSession(
      store,
      orchestrator.id,
      sourceProvider,
      `${sourceProvider}-orchestrator-session`,
    );
    const provenance: ActorProvenance = {
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: orchestratorSession.id,
      actorGeneration: orchestratorSession.generation,
    };
    const task = store.createTask(
      { title: "communication", body: "cwd: /tmp/communication", tenant: "dev", status: "ready" },
      "orch",
      provenance,
    );
    store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    const run = store.startRun(task.id, targetProvider, `${targetProvider}-worker-session`, {
      transport: "direct",
      role: "worker",
    });
    const delivery = store.createOrGetSteerDelivery({
      taskId: task.id,
      runId: run.id,
      sessionId: run.sessionId,
      messageKey: `${sourceProvider}-${targetProvider}-message-1`,
      expectedCancelFence: 0,
      actor: "orch",
    });
    const source = store.createOrGetNativeSourceBinding({
      ...bindingEvidence,
      bindingKey: `${sourceProvider}-${targetProvider}-source-1`,
      provider: sourceProvider,
      hostId: "host-local",
      providerSessionId: `${sourceProvider}-orchestrator-session`,
      taskId: task.id,
      provenance,
    });
    const target = store.createOrGetNativeTargetBinding({
      ...bindingEvidence,
      bindingKey: `${sourceProvider}-${targetProvider}-target-1`,
      provider: targetProvider,
      hostId: "host-local",
      providerSessionId: `${targetProvider}-native-worker-session`,
      nativeAddress: targetProvider === "codex"
        ? { route: "codex-app-server", threadId: "target-thread", activeTurnId: "target-turn", socketSnapshot: codexSocketSnapshot }
        : { route: "claude-cross-session", agentRef: "target-agent" },
      taskId: task.id,
      runId: run.id,
      hachiSessionId: run.sessionId,
      targetRole: "worker",
      expectedCancelFence: 0,
    }, "supervisor", { kind: "service", actorId: "supervisor", actorSessionId: "", actorGeneration: null });
    return { provenance, task, run, delivery, source, target };
  }

  function promoteNativeAttempt(
    target: ReturnType<typeof setup>,
    attemptKey: string,
    payload: unknown,
    configHash: string,
  ): ReturnType<SqliteKanbanStore["promoteCommunicationAttemptToNative"]> {
    const routing = {
      sourceProvider: target.source.provider,
      targetProvider: target.target.provider,
      rollout: "observe" as const,
      preference: "auto" as const,
      sameHost: false,
      exactSourceBinding: false,
      exactTargetBinding: false,
      capability: "unknown" as const,
    };
    const neutral = store!.createOrGetCommunicationAttempt({
      attemptKey,
      steerDeliveryId: target.delivery.id,
      preference: "auto",
      routing,
      decision: resolveCommunicationRoute(routing),
      actor: "orch",
      provenance: target.provenance,
      payload,
      intent: "steer",
      sourcePrincipal: target.provenance,
    });
    const route = target.target.provider === "claude" ? "claude-cross-session" : "codex-app-server";
    return store!.promoteCommunicationAttemptToNative({
      attemptId: neutral.id,
      sourceBindingId: target.source.id,
      targetBindingId: target.target.id,
      route,
      configHash,
      configSnapshot: { rollout: "on", minimumRuntimeVersion: "2.0.0", sameHostOnly: true },
      capabilityHash: capabilitySnapshotHash,
      sourceBindingHash: nativeSessionBindingHash(target.source),
      targetBindingHash: nativeSessionBindingHash(target.target),
      provenance: serviceProvenance,
    });
  }

  it("production storeのCodex native addressはsocket snapshot全項目をcanonical roundtripする", () => {
    const target = setup("codex");
    const stored = store!.getNativeSessionBinding(target.target.id)!;
    expect(JSON.parse(stored.nativeAddress)).toEqual({
      route: "codex-app-server",
      threadId: "target-thread",
      activeTurnId: "target-turn",
      socketSnapshot: codexSocketSnapshot,
    });
    expect(() => store!.createOrGetNativeTargetBinding({
      ...bindingEvidence,
      bindingKey: "target-missing-socket-snapshot",
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-native-worker-session",
      nativeAddress: JSON.stringify({ route: "codex-app-server", threadId: "target-thread", activeTurnId: "target-turn" }),
      taskId: target.task.id,
      runId: target.run.id,
      hachiSessionId: target.run.sessionId,
      targetRole: "worker",
      expectedCancelFence: 0,
    }, "supervisor", serviceProvenance)).toThrow(/socketSnapshot/);
  });

  it("同じstable source keyの新しいprobe timestampsは同一rowへ安全にrefreshする", () => {
    const target = setup("codex");
    const base = Math.floor(Date.now() / 1000);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(base * 1000));
    const first = store!.createOrGetNativeSourceBinding({
      ...bindingEvidence,
      bindingKey: "source-stable-refresh",
      observedAt: base,
      expiresAt: 4_000_000_001,
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-orchestrator-session",
      taskId: target.task.id,
      provenance: target.provenance,
    });
    vi.setSystemTime(new Date((base + 1) * 1000));
    const second = store!.createOrGetNativeSourceBinding({
      ...bindingEvidence,
      bindingKey: "source-stable-refresh",
      observedAt: base + 1,
      expiresAt: 4_000_000_002,
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-orchestrator-session",
      taskId: target.task.id,
      provenance: target.provenance,
    });
    expect(second).toMatchObject({ id: first.id, observedAt: base + 1, expiresAt: 4_000_000_002 });

    const dependentRouting = {
      sourceProvider: "codex" as const,
      targetProvider: "codex" as const,
      rollout: "observe" as const,
      preference: "auto" as const,
      sameHost: false,
      exactSourceBinding: false,
      exactTargetBinding: false,
      capability: "unknown" as const,
    };
    const dependent = store!.createOrGetCommunicationAttempt({
      attemptKey: "source-refresh-dependent-attempt",
      steerDeliveryId: target.delivery.id,
      preference: "auto",
      routing: dependentRouting,
      decision: resolveCommunicationRoute(dependentRouting),
      actor: "orch",
      provenance: target.provenance,
      payload: "keep source snapshot",
      intent: "steer",
      sourcePrincipal: target.provenance,
    });
    store!.promoteCommunicationAttemptToNative({
      attemptId: dependent.id,
      sourceBindingId: second.id,
      targetBindingId: target.target.id,
      route: "codex-app-server",
      configHash: "2".repeat(64),
      configSnapshot: { rollout: "on", minimumRuntimeVersion: "2.0.0", sameHostOnly: true },
      capabilityHash: capabilitySnapshotHash,
      sourceBindingHash: nativeSessionBindingHash(second),
      targetBindingHash: nativeSessionBindingHash(target.target),
      provenance: serviceProvenance,
    });
    vi.setSystemTime(new Date((base + 2) * 1000));
    expect(() => store!.createOrGetNativeSourceBinding({
      ...bindingEvidence,
      bindingKey: "source-stable-refresh",
      observedAt: base + 2,
      expiresAt: 4_000_000_003,
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-orchestrator-session",
      taskId: target.task.id,
      provenance: target.provenance,
    })).toThrow(/refreshは未終端attempt/);
  });

  it("observe decisionをbinding非依存でrecordしsteer claimは既存stageへ残す", () => {
    const target = setup("codex");
    const routing = {
      sourceProvider: "codex" as const,
      targetProvider: "codex" as const,
      rollout: "observe" as const,
      preference: "auto" as const,
      sameHost: false,
      exactSourceBinding: false,
      exactTargetBinding: false,
      capability: "unknown" as const,
    };
    const decision = resolveCommunicationRoute(routing);
    const attempt = store!.createOrGetCommunicationAttempt({
      attemptKey: "attempt-observe-1",
      steerDeliveryId: target.delivery.id,
      preference: "auto",
      routing,
      decision,
      actor: "orch",
      provenance: target.provenance,
    });

    expect(attempt).toMatchObject({
      route: "hachi",
      nativeCandidate: "",
      decisionReason: "exact-source-binding-missing",
      status: "recorded",
      provenance: target.provenance,
    });
    expect(store!.getSteerDelivery(target.delivery.id)?.status).toBe("queued");
    expect(store!.listEvents(target.task.id, "communication_route_recorded")).toHaveLength(1);
    expect(store!.createOrGetCommunicationAttempt({
      attemptKey: "attempt-observe-1",
      steerDeliveryId: target.delivery.id,
      preference: "auto",
      routing,
      decision,
      actor: "orch",
      provenance: target.provenance,
    })).toEqual(attempt);
  });

  it("neutral steer intentのredacted payloadを同じattempt行へservice promotionする", () => {
    const target = setup("codex");
    const routing = {
      sourceProvider: "codex" as const,
      targetProvider: "codex" as const,
      rollout: "observe" as const,
      preference: "auto" as const,
      sameHost: false,
      exactSourceBinding: false,
      exactTargetBinding: false,
      capability: "unknown" as const,
    };
    const neutral = store!.createOrGetCommunicationAttempt({
      attemptKey: "route:promotion-1",
      steerDeliveryId: target.delivery.id,
      preference: "auto",
      routing,
      decision: resolveCommunicationRoute(routing),
      actor: "orch",
      provenance: target.provenance,
      payload: { message: "hello", authorization: "Bearer sk-promotion-secret" },
      intent: "steer",
      sourcePrincipal: target.provenance,
    });
    expect(neutral).toMatchObject({
      status: "recorded",
      route: "hachi",
      sourceBindingId: null,
      payload: expect.stringContaining("[REDACTED]"),
    });

    const promoted = store!.promoteCommunicationAttemptToNative({
      attemptId: neutral.id,
      sourceBindingId: target.source.id,
      targetBindingId: target.target.id,
      route: "codex-app-server",
      configHash: "e".repeat(64),
      configSnapshot: { rollout: "on", minimumRuntimeVersion: "2.0.0", sameHostOnly: true },
      capabilityHash: capabilitySnapshotHash,
      sourceBindingHash: nativeSessionBindingHash(target.source),
      targetBindingHash: nativeSessionBindingHash(target.target),
      provenance: serviceProvenance,
    });
    expect(promoted.id).toBe(neutral.id);
    expect(promoted.attemptKey).toBe(neutral.attemptKey);
    expect(promoted).toMatchObject({
      status: "recorded",
      route: "codex-app-server",
      sourceBindingId: target.source.id,
      targetBindingId: target.target.id,
      payload: expect.stringContaining("[REDACTED]"),
    });
    expect(store!.listCommunicationAttempts(target.delivery.id)).toHaveLength(1);
    expect(store!.listEvents(target.task.id, "communication_native_attempt_promoted")).toHaveLength(1);
  });

  it("native promotionのcanary判定はpolicy exportと同じ結果を要求する", () => {
    const target = setup("codex");
    const canaryPercent = 50;
    const canaryEligible = isCommunicationCanaryEligible(
      target.task.id,
      communicationCanaryCohortKey("codex"),
      canaryPercent,
    );
    const neutralRouting = {
      sourceProvider: "codex" as const,
      targetProvider: "codex" as const,
      rollout: "observe" as const,
      preference: "auto" as const,
      sameHost: false,
      exactSourceBinding: false,
      exactTargetBinding: false,
      capability: "unknown" as const,
    };
    const neutral = store!.createOrGetCommunicationAttempt({
      attemptKey: "native-v20-canary-cross-check",
      steerDeliveryId: target.delivery.id,
      preference: "auto",
      routing: neutralRouting,
      decision: resolveCommunicationRoute(neutralRouting),
      actor: "orch",
      provenance: target.provenance,
      payload: "canary",
      intent: "steer",
      sourcePrincipal: target.provenance,
    });
    const promoted = store!.promoteCommunicationAttemptToNative({
      attemptId: neutral.id,
      sourceBindingId: target.source.id,
      targetBindingId: target.target.id,
      route: "codex-app-server",
      configHash: "1".repeat(64),
      configSnapshot: { rollout: "canary", minimumRuntimeVersion: "2.0.0", sameHostOnly: true, canaryPercent },
      capabilityHash: capabilitySnapshotHash,
      sourceBindingHash: nativeSessionBindingHash(target.source),
      targetBindingHash: nativeSessionBindingHash(target.target),
      routing: {
        sourceProvider: "codex",
        targetProvider: "codex",
        rollout: "canary",
        preference: "auto",
        sameHost: true,
        exactSourceBinding: true,
        exactTargetBinding: true,
        capability: "supported",
        canaryEligible,
      },
      provenance: serviceProvenance,
    });
    expect(promoted.configCanaryPercent).toBe(canaryPercent);
  });

  it.each(["codex", "claude"] as const)(
    "%s native promotionはsource addressなしでもtarget exact addressだけで成立する",
    (provider) => {
      const target = setup(provider);
      const promoted = promoteNativeAttempt(target, `native-v20-source-addressless-${provider}`, "hello", "f".repeat(64));
      expect(target.source.nativeAddress).toBe("");
      expect(target.target.nativeAddress).not.toBe("");
      expect(promoted.sourceBindingId).toBe(target.source.id);
      expect(promoted.targetBindingId).toBe(target.target.id);
      expect(promoted.route).toBe(provider === "claude" ? "claude-cross-session" : "codex-app-server");
    },
  );

  it("stale generationとbinding/run/session/fence不一致をfail-closedで拒否する", () => {
    const target = setup("claude");
    const stale = { ...target.provenance, actorGeneration: target.provenance.actorGeneration! + 1 };
    expect(() => store!.createOrGetNativeSourceBinding({
      ...bindingEvidence,
      bindingKey: "stale-source",
      provider: "claude",
      hostId: "host-local",
      providerSessionId: "claude-orchestrator-session",
      taskId: target.task.id,
      provenance: stale,
    })).toThrow(/active orchestrator session generation/);

    const otherRunTask = store!.createTask(
      { title: "other", body: "", tenant: "dev", status: "ready" },
      "orch",
      target.provenance,
    );
    expect(() => store!.createOrGetNativeTargetBinding({
      ...bindingEvidence,
      bindingKey: "wrong-target",
      provider: "claude",
      hostId: "host-local",
      providerSessionId: "native-other",
      taskId: otherRunTask.id,
      runId: target.run.id,
      hachiSessionId: target.run.sessionId,
      targetRole: "worker",
      expectedCancelFence: 0,
    }, "supervisor", {
      kind: "service",
      actorId: "supervisor",
      actorSessionId: "",
      actorGeneration: null,
    })).toThrow(/current open run/);
  });

  it("refused decisionはattempt監査を残すがsteerをclaimしない", () => {
    const target = setup("codex");
    const routing = {
      sourceProvider: "codex" as const,
      targetProvider: "codex" as const,
      rollout: "observe" as const,
      preference: "native" as const,
      sameHost: false,
      exactSourceBinding: false,
      exactTargetBinding: false,
      capability: "unknown" as const,
    };
    const decision = resolveCommunicationRoute(routing);
    const attempt = store!.createOrGetCommunicationAttempt({
      attemptKey: "attempt-refused-1",
      steerDeliveryId: target.delivery.id,
      preference: "native",
      routing,
      decision,
      actor: "orch",
      provenance: target.provenance,
    });
    expect(attempt).toMatchObject({ status: "rejected", route: "", decisionReason: "exact-source-binding-missing" });
    expect(store!.getSteerDelivery(target.delivery.id)?.status).toBe("queued");
  });

  it("binding省略のHachi observeをrecordできるがnative候補をexactと偽装できない", () => {
    const target = setup("claude");
    const routing = {
      sourceProvider: "claude" as const,
      targetProvider: "claude" as const,
      rollout: "observe" as const,
      preference: "auto" as const,
      sameHost: false,
      exactSourceBinding: false,
      exactTargetBinding: false,
      capability: "unknown" as const,
    };
    const attempt = store!.createOrGetCommunicationAttempt({
      attemptKey: "attempt-no-bindings",
      steerDeliveryId: target.delivery.id,
      preference: "auto",
      routing,
      decision: resolveCommunicationRoute(routing),
      actor: "orch",
      provenance: target.provenance,
    });
    expect(attempt).toMatchObject({
      status: "recorded",
      route: "hachi",
      sourceBindingId: null,
      targetBindingId: null,
      decisionReason: "exact-source-binding-missing",
    });
    expect(store!.getSteerDelivery(target.delivery.id)?.status).toBe("queued");
  });

  it("source bindingはtask primary authority必須、target bindingはunknown/human provenanceを拒否する", () => {
    const target = setup("codex");
    const unbound = store!.createTask(
      { title: "unbound", body: "", tenant: "dev", status: "ready" },
      "orch",
      target.provenance,
    );
    expect(() => store!.createOrGetNativeSourceBinding({
      ...bindingEvidence,
      bindingKey: "source-unbound",
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-orchestrator-session",
      taskId: unbound.id,
      provenance: target.provenance,
    })).toThrow(/primary binding\/watch/);

    expect(() => store!.createOrGetNativeTargetBinding({
      ...bindingEvidence,
      bindingKey: "target-unknown",
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-native-worker-session",
      taskId: target.task.id,
      runId: target.run.id,
      hachiSessionId: target.run.sessionId,
      targetRole: "worker",
      expectedCancelFence: 0,
    }, "unknown", { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null })).toThrow(/fixed supervisor service provenance|固定supervisor service provenance/);
    expect(() => store!.createOrGetNativeTargetBinding({
      ...bindingEvidence,
      bindingKey: "target-human",
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-native-worker-session",
      taskId: target.task.id,
      runId: target.run.id,
      hachiSessionId: target.run.sessionId,
      targetRole: "worker",
      expectedCancelFence: 0,
    }, "human", {
      kind: "human",
      actorId: "human",
      actorSessionId: "",
      actorGeneration: null,
    })).toThrow(/fixed supervisor service provenance|固定supervisor service provenance/);
  });

  it("source authorityはtask/subtree/worktree/projectのprimary watchを標準順で解決し曖昧なら拒否する", () => {
    store = new SqliteKanbanStore(":memory:");
    const orchestrator = store.registerOrchestrator({
      label: "watch-owner",
      project: "hachi-kanban",
      repoCommonDir: "/repo/.git",
    });
    const session = startTrustedOrchestratorSession(store, orchestrator.id, "codex", "watch-owner-session");
    const provenance: ActorProvenance = {
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    };
    const taskScoped = store.createTask(
      { title: "task scoped", body: "cwd: /tmp/watch-task", tenant: "watch-task" },
      "orch",
      provenance,
    );
    store.addOrchestratorWatch({
      orchestratorId: orchestrator.id,
      scope: "task",
      selector: taskScoped.id,
      role: "primary",
      priority: 10,
    });

    const subtreeParent = store.createTask(
      { title: "subtree parent", body: "cwd: /tmp/watch-parent", tenant: "watch-subtree" },
      "orch",
      provenance,
    );
    const subtreeChild = store.createTask(
      { title: "subtree child", body: "cwd: /tmp/watch-child", tenant: "watch-subtree-child" },
      "orch",
      provenance,
    );
    store.link(subtreeParent.id, subtreeChild.id, "subtask");
    store.addOrchestratorWatch({
      orchestratorId: orchestrator.id,
      scope: "subtree",
      selector: subtreeParent.id,
      role: "primary",
      priority: 10,
    });

    const worktreeScoped = store.createTask(
      { title: "worktree scoped", body: "cwd: /tmp/watch-worktree", tenant: "watch-worktree" },
      "orch",
      provenance,
    );
    store.addOrchestratorWatch({
      orchestratorId: orchestrator.id,
      scope: "worktree",
      selector: "/tmp/watch-worktree",
      role: "primary",
      priority: 10,
    });

    const projectScoped = store.createTask(
      { title: "project scoped", body: "cwd: /tmp/watch-project", tenant: "watch-project" },
      "orch",
      provenance,
    );
    store.addOrchestratorWatch({
      orchestratorId: orchestrator.id,
      scope: "project",
      selector: "watch-project",
      role: "primary",
      priority: 10,
    });

    for (const [index, task] of [taskScoped, subtreeChild, worktreeScoped, projectScoped].entries()) {
      expect(store.createOrGetNativeSourceBinding({
        ...bindingEvidence,
        bindingKey: `watch-source-${String(index)}`,
        provider: "codex",
        hostId: "host-local",
        providerSessionId: "watch-owner-session",
        taskId: task.id,
        provenance,
      })).toMatchObject({ taskId: task.id, orchestratorId: orchestrator.id });
    }

    const ambiguousTask = store.createTask(
      { title: "ambiguous", body: "cwd: /tmp/watch-ambiguous", tenant: "watch-ambiguous" },
      "orch",
      provenance,
    );
    const other = store.registerOrchestrator({
      label: "watch-other",
      project: "hachi-kanban",
      repoCommonDir: "/repo/.git",
    });
    store.addOrchestratorWatch({
      orchestratorId: orchestrator.id,
      scope: "task",
      selector: ambiguousTask.id,
      role: "primary",
      priority: 5,
    });
    store.addOrchestratorWatch({
      orchestratorId: other.id,
      scope: "task",
      selector: ambiguousTask.id,
      role: "primary",
      priority: 5,
    });
    expect(() => store!.createOrGetNativeSourceBinding({
      ...bindingEvidence,
      bindingKey: "watch-source-ambiguous",
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "watch-owner-session",
      taskId: ambiguousTask.id,
      provenance,
    })).toThrow(/曖昧/);
  });

  it("target bindingは固定supervisor service provenanceだけを受理する", () => {
    const target = setup("codex");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 3_600_000));
    expect(() => store!.createOrGetNativeTargetBinding({
      ...bindingEvidence,
      bindingKey: "target-stale-orchestrator",
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-native-worker-session",
      taskId: target.task.id,
      runId: target.run.id,
      hachiSessionId: target.run.sessionId,
      targetRole: "worker",
      expectedCancelFence: 0,
    }, "orch", target.provenance)).toThrow(/固定supervisor service provenance/);
  });

  it("binding evidenceのsemver/hash/expiryを作成時とattempt時にfail-closed検証する", () => {
    const target = setup("codex");
    expect(() => store!.createOrGetNativeSourceBinding({
      ...bindingEvidence,
      runtimeVersion: "02.1.0",
      bindingKey: "source-invalid-semver",
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-orchestrator-session",
      taskId: target.task.id,
      provenance: target.provenance,
    })).toThrow(/strict semver/);
    expect(() => store!.createOrGetNativeTargetBinding({
      ...bindingEvidence,
      capabilityHash: "ABC",
      bindingKey: "target-invalid-hash",
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-native-worker-session",
      taskId: target.task.id,
      runId: target.run.id,
      hachiSessionId: target.run.sessionId,
      targetRole: "worker",
      expectedCancelFence: 0,
    }, "supervisor", {
      kind: "service",
      actorId: "supervisor",
      actorSessionId: "",
      actorGeneration: null,
    })).toThrow(/sha256/);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2_000_000_000 * 1000));
    const shortEvidence = {
      runtimeVersion: "2.1.226",
      capabilityHash: "b".repeat(64),
      observedAt: 2_000_000_000,
      expiresAt: 2_000_000_010,
    };
    const source = store!.createOrGetNativeSourceBinding({
      ...shortEvidence,
      bindingKey: "source-short-lived",
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-orchestrator-session",
      taskId: target.task.id,
      provenance: target.provenance,
    });
    const binding = store!.createOrGetNativeTargetBinding({
      ...shortEvidence,
      bindingKey: "target-short-lived",
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-native-worker-session",
      taskId: target.task.id,
      runId: target.run.id,
      hachiSessionId: target.run.sessionId,
      targetRole: "worker",
      expectedCancelFence: 0,
    }, "supervisor", {
      kind: "service",
      actorId: "supervisor",
      actorSessionId: "",
      actorGeneration: null,
    });
    vi.setSystemTime(new Date(2_000_000_020 * 1000));
    const renewedEvidence = {
      runtimeVersion: "2.1.226",
      capabilityHash: "c".repeat(64),
      observedAt: 2_000_000_020,
      expiresAt: 2_000_000_030,
    };
    const renewed = store!.createOrGetNativeSourceBinding({
      ...renewedEvidence,
      bindingKey: "source-short-lived",
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-orchestrator-session",
      taskId: target.task.id,
      provenance: target.provenance,
    });
    expect(renewed).toMatchObject({
      id: source.id,
      status: "active",
      capabilityHash: renewedEvidence.capabilityHash,
      observedAt: renewedEvidence.observedAt,
      expiresAt: renewedEvidence.expiresAt,
    });
    expect(() => store!.createOrGetNativeTargetBinding({
      ...shortEvidence,
      bindingKey: "target-short-lived",
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-native-worker-session",
      taskId: target.task.id,
      runId: target.run.id,
      hachiSessionId: target.run.sessionId,
      targetRole: "worker",
      expectedCancelFence: 0,
    }, "supervisor", {
      kind: "service",
      actorId: "supervisor",
      actorSessionId: "",
      actorGeneration: null,
    })).toThrow(/expiresAt/);
    expect(source.expiresAt).toBe(shortEvidence.expiresAt);
    expect(binding.expiresAt).toBe(shortEvidence.expiresAt);
  });

  it("caller supplied provider/host/decisionの偽装とv0.17 native routeをfail-closedで拒否する", () => {
    const target = setup("codex");
    const forgedRouting = {
      sourceProvider: "claude" as const,
      targetProvider: "codex" as const,
      rollout: "observe" as const,
      preference: "auto" as const,
      sameHost: false,
      exactSourceBinding: false,
      exactTargetBinding: false,
      capability: "unknown" as const,
    };
    expect(() => store!.createOrGetCommunicationAttempt({
      attemptKey: "attempt-forged-provider",
      steerDeliveryId: target.delivery.id,
      preference: "auto",
      routing: forgedRouting,
      decision: resolveCommunicationRoute(forgedRouting),
      actor: "orch",
      provenance: target.provenance,
    })).toThrow(/routing provider/);

    const nativeRouting = {
      sourceProvider: "codex" as const,
      targetProvider: "codex" as const,
      rollout: "on" as const,
      preference: "auto" as const,
      sameHost: false,
      exactSourceBinding: false,
      exactTargetBinding: false,
      capability: "unknown" as const,
    };
    expect(() => store!.createOrGetCommunicationAttempt({
      attemptKey: "attempt-native-not-implemented",
      steerDeliveryId: target.delivery.id,
      preference: "auto",
      routing: nativeRouting,
      decision: resolveCommunicationRoute(nativeRouting),
      actor: "orch",
      provenance: target.provenance,
    })).toThrow(/same-provider active rollout/);
    expect(store!.getSteerDelivery(target.delivery.id)?.status).toBe("queued");
    expect(store!.listCommunicationAttempts(target.delivery.id)).toHaveLength(0);
  });

  it("cross-providerはcanary/onでもHachi record-onlyを許可する", () => {
    const target = setup("codex", "claude");
    const routing = {
      sourceProvider: "claude" as const,
      targetProvider: "codex" as const,
      rollout: "on" as const,
      preference: "auto" as const,
      sameHost: false,
      exactSourceBinding: false,
      exactTargetBinding: false,
      capability: "unknown" as const,
    };
    const attempt = store!.createOrGetCommunicationAttempt({
      attemptKey: "attempt-cross-provider-on",
      steerDeliveryId: target.delivery.id,
      preference: "auto",
      routing,
      decision: resolveCommunicationRoute(routing),
      actor: "orch",
      provenance: target.provenance,
    });
    expect(attempt).toMatchObject({
      status: "recorded",
      route: "hachi",
      nativeCandidate: "",
      decisionReason: "cross-provider",
      sourceBindingId: null,
      targetBindingId: null,
    });
    expect(store!.getSteerDelivery(target.delivery.id)?.status).toBe("queued");
  });

  it("v0.17 attemptはbinding ID・capability自己申告・native候補偽装を受理しない", () => {
    const target = setup("codex");
    const routing = {
      sourceProvider: "codex" as const,
      targetProvider: "codex" as const,
      rollout: "observe" as const,
      preference: "auto" as const,
      sameHost: false,
      exactSourceBinding: false,
      exactTargetBinding: false,
      capability: "unknown" as const,
    };
    const unsafeBindingInput = {
      attemptKey: "attempt-binding-not-accepted",
      steerDeliveryId: target.delivery.id,
      sourceBindingId: target.source.id,
      targetBindingId: target.target.id,
      preference: "auto",
      routing,
      decision: resolveCommunicationRoute(routing),
      actor: "orch",
      provenance: target.provenance,
    } as CreateCommunicationAttemptInput;
    expect(() => store!.createOrGetCommunicationAttempt(unsafeBindingInput)).toThrow(/binding IDs/);

    const claimedCapability = { ...routing, capability: "supported" as const };
    expect(() => store!.createOrGetCommunicationAttempt({
      attemptKey: "attempt-capability-not-accepted",
      steerDeliveryId: target.delivery.id,
      preference: "auto",
      routing: claimedCapability,
      decision: resolveCommunicationRoute(claimedCapability),
      actor: "orch",
      provenance: target.provenance,
    })).toThrow(/unknown\/no-binding\/no-host/);

    const honestDecision = resolveCommunicationRoute(routing);
    expect(() => store!.createOrGetCommunicationAttempt({
      attemptKey: "attempt-candidate-not-accepted",
      steerDeliveryId: target.delivery.id,
      preference: "auto",
      routing,
      decision: { ...honestDecision, nativeCandidate: "codex-app-server" },
      actor: "orch",
      provenance: target.provenance,
    })).toThrow(/再計算結果/);
    expect(store!.listCommunicationAttempts(target.delivery.id)).toHaveLength(0);
  });

  it("v19記録済みでも空のlax full-column schemaをconstraint/FK付きへ自己修復する", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-communication-migration-"));
    const path = join(dir, "kanban.db");
    try {
      new SqliteKanbanStore(path).close();
      const raw = new Database(path);
      raw.exec(`
        DROP TABLE communication_delivery_attempts;
        DROP TABLE native_session_bindings;
        ALTER TABLE tasks DROP COLUMN review_speed_override;
        ${LAX_NATIVE_BINDING_TABLE_SQL}
        CREATE TABLE communication_delivery_attempts (id TEXT PRIMARY KEY);
      `);
      raw.close();
      new SqliteKanbanStore(path).close();
      const check = new Database(path, { readonly: true });
      expect(check.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 19`).get())
        .toEqual({ count: 1 });
      expect(check.prepare(`SELECT COUNT(*) AS count FROM native_session_bindings`).get()).toEqual({ count: 0 });
      expect(check.prepare(`SELECT COUNT(*) AS count FROM communication_delivery_attempts`).get()).toEqual({ count: 0 });
      const taskColumns = check.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
      expect(taskColumns.filter((column) => column.name === "review_speed_override")).toHaveLength(1);
      const bindingSql = (check.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'native_session_bindings'`,
      ).get() as { sql: string }).sql;
      expect(bindingSql).toContain("runtime_version TEXT NOT NULL");
      expect(bindingSql).toContain("capability_hash TEXT NOT NULL CHECK");
      expect(bindingSql).toContain("expires_at INTEGER NOT NULL CHECK(expires_at > observed_at)");
      const bindingForeignKeys = check.prepare(`PRAGMA foreign_key_list(native_session_bindings)`).all() as Array<{
        from: string;
        table: string;
        to: string;
      }>;
      expect(bindingForeignKeys).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: "task_id", table: "tasks", to: "id" }),
        expect.objectContaining({ from: "run_id", table: "task_runs", to: "id" }),
      ]));
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("既存行を持つlax full-column binding tableは破棄せずfail-closedにする", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-communication-partial-data-"));
    const path = join(dir, "kanban.db");
    try {
      new SqliteKanbanStore(path).close();
      const raw = new Database(path);
      raw.exec(`
        DROP TABLE communication_delivery_attempts;
        DROP TABLE native_session_bindings;
        ${LAX_NATIVE_BINDING_TABLE_SQL}
        INSERT INTO native_session_bindings (id) VALUES ('legacy-binding');
      `);
      raw.close();
      expect(() => new SqliteKanbanStore(path)).toThrow(/不完全tableに既存行/);
      const check = new Database(path, { readonly: true });
      expect(check.prepare(`SELECT id FROM native_session_bindings`).get()).toEqual({ id: "legacy-binding" });
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binding table欠落中にattempt既存行があれば破棄せずfail-closedにする", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-communication-orphan-attempt-"));
    const path = join(dir, "kanban.db");
    try {
      new SqliteKanbanStore(path).close();
      const raw = new Database(path);
      raw.exec(`
        DROP TABLE communication_delivery_attempts;
        DROP TABLE native_session_bindings;
        CREATE TABLE communication_delivery_attempts (id TEXT PRIMARY KEY);
        INSERT INTO communication_delivery_attempts (id) VALUES ('orphan-attempt');
      `);
      raw.close();
      expect(() => new SqliteKanbanStore(path)).toThrow(/binding table欠落.*attempt既存行/);
      const check = new Database(path, { readonly: true });
      expect(check.prepare(`SELECT id FROM communication_delivery_attempts`).get()).toEqual({ id: "orphan-attempt" });
      expect(check.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'native_session_bindings'`,
      ).get()).toEqual({ count: 0 });
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binding table欠落中でも空のattempt tableなら両tableを安全に再作成する", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-communication-empty-orphan-attempt-"));
    const path = join(dir, "kanban.db");
    try {
      new SqliteKanbanStore(path).close();
      const raw = new Database(path);
      raw.exec(`
        DROP TABLE communication_delivery_attempts;
        DROP TABLE native_session_bindings;
        CREATE TABLE communication_delivery_attempts (id TEXT PRIMARY KEY);
      `);
      raw.close();
      new SqliteKanbanStore(path).close();
      const check = new Database(path, { readonly: true });
      expect(check.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name IN ('native_session_bindings', 'communication_delivery_attempts')`,
      ).get()).toEqual({ count: 2 });
      expect(check.prepare(`PRAGMA foreign_key_list(communication_delivery_attempts)`).all()).toHaveLength(3);
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("空tableのwrong active-delivery indexをunique partial shapeへ自己修復する", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-communication-wrong-index-empty-"));
    const path = join(dir, "kanban.db");
    try {
      new SqliteKanbanStore(path).close();
      const raw = new Database(path);
      raw.pragma("foreign_keys = OFF");
      raw.exec(`
        DROP INDEX idx_communication_attempts_active_delivery;
        CREATE INDEX idx_communication_attempts_active_delivery
          ON communication_delivery_attempts(steer_delivery_id);
      `);
      raw.close();
      new SqliteKanbanStore(path).close();
      const check = new Database(path, { readonly: true });
      const indexes = check.prepare(`PRAGMA index_list(communication_delivery_attempts)`).all() as Array<{
        name: string;
        unique: number;
        partial: number;
      }>;
      expect(indexes.find((index) => index.name === "idx_communication_attempts_active_delivery"))
        .toMatchObject({ unique: 1, partial: 1 });
      const definition = check.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_communication_attempts_active_delivery'`,
      ).get() as { sql: string };
      expect(definition.sql).toContain("WHERE status <> 'rejected'");
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("既存attempt行があるwrong named indexは破棄せずfail-closedにする", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-communication-wrong-index-data-"));
    const path = join(dir, "kanban.db");
    try {
      new SqliteKanbanStore(path).close();
      const raw = new Database(path);
      raw.pragma("foreign_keys = OFF");
      raw.exec(`
        DROP INDEX idx_communication_attempts_active_delivery;
        CREATE INDEX idx_communication_attempts_active_delivery
          ON communication_delivery_attempts(steer_delivery_id);
        INSERT INTO communication_delivery_attempts (
          id, attempt_key, steer_delivery_id, preference, route, native_candidate,
          decision_reason, status, actor_kind, actor_id, actor_session_id,
          actor_generation, created_at, updated_at, resolved_at
        ) VALUES (
          'legacy-attempt', 'legacy-key', 'missing-delivery', 'auto', 'hachi', '',
          'cross-provider', 'recorded', 'orchestrator', 'o_legacy', 'os_legacy',
          1, 1, 1, 1
        );
      `);
      raw.close();
      expect(() => new SqliteKanbanStore(path)).toThrow(/index .*既存行/);
      const check = new Database(path, { readonly: true });
      expect(check.prepare(`SELECT id FROM communication_delivery_attempts`).get()).toEqual({ id: "legacy-attempt" });
      const indexes = check.prepare(`PRAGMA index_list(communication_delivery_attempts)`).all() as Array<{
        name: string;
        unique: number;
        partial: number;
      }>;
      expect(indexes.find((index) => index.name === "idx_communication_attempts_active_delivery"))
        .toMatchObject({ unique: 0, partial: 0 });
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v20 native attemptはclaim→begin→accepted→observed→ackをsteerと同じ順序で確定する", () => {
    const target = setup("codex");
    const configHash = "b".repeat(64);
    const created = promoteNativeAttempt(
      target,
      "native-v20-lifecycle",
      { text: "hello", authorization: "Bearer sk-test-secret" },
      configHash,
    );
    expect(created).toMatchObject({
      status: "recorded",
      payload: expect.stringContaining("[REDACTED]"),
      sourceBindingId: target.source.id,
      targetBindingId: target.target.id,
      configHash,
      capabilityHash: capabilitySnapshotHash,
    });

    const claimed = store!.claimNativeCommunicationAttempt({
      attemptId: created.id,
      configHash,
      capabilityHash: capabilitySnapshotHash,
      rollout: "on",
      minimumRuntimeVersion: "2.0.0",
      sameHostOnly: true,
      provenance: serviceProvenance,
    });
    expect(claimed.status).toBe("claimed");
    expect(claimed.attemptNonce).toMatch(/^[0-9a-f]{64}$/);
    const nonce = claimed.attemptNonce!;
    const begun = store!.beginNativeCommunicationDispatch({ attemptId: created.id, attemptNonce: nonce, provenance: serviceProvenance });
    expect(begun.status).toBe("dispatching");
    expect(store!.getSteerDelivery(target.delivery.id)?.status).toBe("dispatching");

    const accepted = store!.recordNativeCommunicationReceipt({
      attemptId: created.id,
      attemptNonce: nonce,
      outcome: "transport_accepted",
      receiptId: "receipt-accepted",
      provenance: serviceProvenance,
    });
    expect(accepted.status).toBe("transport_accepted");
    const observed = store!.recordNativeCommunicationReceipt({
      attemptId: created.id,
      attemptNonce: nonce,
      outcome: "session_observed",
      receiptId: "receipt-observed",
      observedMessageId: "message-observed",
      provenance: serviceProvenance,
    });
    expect(observed.status).toBe("session_observed");
    const acknowledged = store!.recordNativeCommunicationReceipt({
      attemptId: created.id,
      attemptNonce: nonce,
      outcome: "acknowledged",
      receiptId: "receipt-ack",
      observedMessageId: "message-observed",
      provenance: serviceProvenance,
    });
    expect(acknowledged.status).toBe("acknowledged");
    expect(store!.getSteerDelivery(target.delivery.id)?.status).toBe("acknowledged");
    expect(store!.getCommunicationAttempt(created.id)?.attemptNonce).toBeNull();
  });

  it("v20 claim lease切れは同じattempt keyだけをrequeueし、dispatchingはuncertainへ終端化する", () => {
    const target = setup("claude");
    const configHash = "c".repeat(64);
    const created = promoteNativeAttempt(target, "native-v20-recovery-claim", "recover me", configHash);
    const base = Math.floor(Date.now() / 1000);
    const claimed = store!.claimNativeCommunicationAttempt({
      attemptId: created.id,
      configHash,
      capabilityHash: capabilitySnapshotHash,
      rollout: "on",
      minimumRuntimeVersion: "2.0.0",
      sameHostOnly: true,
      leaseSeconds: 10,
      now: base,
      provenance: target.provenance,
    });
    expect(store!.recoverNativeCommunicationAttempts(base + 11, "supervisor", serviceProvenance)).toEqual({ requeuedClaimed: 1, uncertainDispatching: 0 });
    expect(store!.listNativeCommunicationRedriveCandidates().map((row) => row.id)).toEqual([created.id]);
    const reclaimed = store!.claimNativeCommunicationAttempt({
      attemptId: created.id,
      configHash,
      capabilityHash: capabilitySnapshotHash,
      rollout: "on",
      minimumRuntimeVersion: "2.0.0",
      sameHostOnly: true,
      leaseSeconds: 10,
      now: base + 12,
      provenance: target.provenance,
    });
    expect(reclaimed.attemptNonce).not.toBe(claimed.attemptNonce);
    expect(() => store!.beginNativeCommunicationDispatch({
      attemptId: created.id,
      attemptNonce: claimed.attemptNonce!,
      now: base + 13,
      provenance: target.provenance,
    })).toThrow(/nonceが一致しません/);
    expect(() => store!.recordNativeCommunicationReceipt({
      attemptId: created.id,
      attemptNonce: claimed.attemptNonce!,
      outcome: "rejected",
      now: base + 13,
      provenance: target.provenance,
    })).toThrow(/nonceが一致しません/);
    store!.beginNativeCommunicationDispatch({ attemptId: created.id, attemptNonce: reclaimed.attemptNonce!, now: base + 13, provenance: target.provenance });
    expect(() => store!.beginNativeCommunicationDispatch({
      attemptId: created.id,
      attemptNonce: reclaimed.attemptNonce!,
      now: base + 14,
      provenance: target.provenance,
    })).toThrow(/claimed attempt/);
    expect(store!.getCommunicationAttempt(created.id)?.status).toBe("dispatching");
    expect(store!.listEvents(target.task.id, "communication_native_attempt_dispatching")).toHaveLength(1);
    expect(store!.recoverNativeCommunicationAttempts(base + 24, "supervisor", serviceProvenance)).toEqual({ requeuedClaimed: 0, uncertainDispatching: 1 });
    expect(store!.getCommunicationAttempt(created.id)?.status).toBe("uncertain");
    expect(store!.getSteerDelivery(target.delivery.id)?.status).toBe("uncertain");
    expect(() => store!.claimNativeCommunicationAttempt({
      attemptId: created.id,
      configHash,
      capabilityHash: capabilitySnapshotHash,
      rollout: "on",
      minimumRuntimeVersion: "2.0.0",
      sameHostOnly: true,
      provenance: serviceProvenance,
    })).toThrow(/claim可能/);
  });

  it("recorded native attemptはexact delivery fence付きでfresh target bindingへrebindする", () => {
    const target = setup("codex");
    const created = promoteNativeAttempt(target, "native-v20-rebind", "rebind me", "e".repeat(64));
    const refreshedTarget = store!.createOrGetNativeTargetBinding({
      ...bindingEvidence,
      bindingKey: "target-refresh-for-rebind",
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-native-worker-session",
      nativeAddress: { route: "codex-app-server", threadId: "target-thread", activeTurnId: "target-turn-2", socketSnapshot: codexSocketSnapshot },
      observedAt: 2,
      expiresAt: 4_000_000_000,
      taskId: target.task.id,
      runId: target.run.id,
      hachiSessionId: target.run.sessionId,
      targetRole: "worker",
      expectedCancelFence: 0,
    }, "supervisor", serviceProvenance);

    const rebound = store!.rebindRecordedNativeCommunicationAttempt({
      attemptId: created.id,
      taskId: target.task.id,
      runId: target.run.id,
      sessionId: target.run.sessionId,
      expectedCancelFence: 0,
      targetBindingId: refreshedTarget.id,
      targetBindingHash: nativeSessionBindingHash(refreshedTarget),
      provenance: serviceProvenance,
    });
    expect(rebound).toMatchObject({
      id: created.id,
      status: "recorded",
      targetBindingId: refreshedTarget.id,
      targetBindingHash: nativeSessionBindingHash(refreshedTarget),
    });
    expect(store!.listEvents(target.task.id, "communication_native_attempt_rebound")).toHaveLength(1);
    expect(store!.rebindRecordedNativeCommunicationAttempt({
      attemptId: created.id,
      taskId: target.task.id,
      runId: target.run.id,
      sessionId: target.run.sessionId,
      expectedCancelFence: 0,
      targetBindingId: refreshedTarget.id,
      targetBindingHash: nativeSessionBindingHash(refreshedTarget),
      provenance: serviceProvenance,
    })).toEqual(rebound);
  });

  it("native rebindはdelivery mismatch、target hash mismatch、任意service provenanceを拒否する", () => {
    const target = setup("codex");
    const created = promoteNativeAttempt(target, "native-v20-rebind-mismatch", "rebind mismatch", "f".repeat(64));
    const refreshedTarget = store!.createOrGetNativeTargetBinding({
      ...bindingEvidence,
      bindingKey: "target-refresh-for-mismatch",
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-native-worker-session",
      nativeAddress: { route: "codex-app-server", threadId: "target-thread", activeTurnId: "target-turn-3", socketSnapshot: codexSocketSnapshot },
      observedAt: 3,
      expiresAt: 4_000_000_000,
      taskId: target.task.id,
      runId: target.run.id,
      hachiSessionId: target.run.sessionId,
      targetRole: "worker",
      expectedCancelFence: 0,
    }, "supervisor", serviceProvenance);
    const base = {
      attemptId: created.id,
      taskId: target.task.id,
      runId: target.run.id,
      sessionId: target.run.sessionId,
      expectedCancelFence: 0,
      targetBindingId: refreshedTarget.id,
      targetBindingHash: nativeSessionBindingHash(refreshedTarget),
      provenance: serviceProvenance,
    } as const;

    expect(() => store!.rebindRecordedNativeCommunicationAttempt({ ...base, taskId: "wrong-task" })).toThrow(/taskが一致/);
    expect(() => store!.rebindRecordedNativeCommunicationAttempt({ ...base, targetBindingHash: "0".repeat(64) })).toThrow(/target binding hash/);
    expect(() => store!.rebindRecordedNativeCommunicationAttempt({
      ...base,
      provenance: { kind: "service", actorId: "arbitrary-service", actorSessionId: "", actorGeneration: null },
    })).toThrow(/固定supervisor service provenance/);
  });

  it("native rebindはdispatching以降のattemptを変更しない", () => {
    const target = setup("codex");
    const created = promoteNativeAttempt(target, "native-v20-rebind-dispatching", "do not rebind", "1".repeat(64));
    const refreshedTarget = store!.createOrGetNativeTargetBinding({
      ...bindingEvidence,
      bindingKey: "target-refresh-for-dispatching",
      provider: "codex",
      hostId: "host-local",
      providerSessionId: "codex-native-worker-session",
      nativeAddress: { route: "codex-app-server", threadId: "target-thread", activeTurnId: "target-turn-4", socketSnapshot: codexSocketSnapshot },
      observedAt: 4,
      expiresAt: 4_000_000_000,
      taskId: target.task.id,
      runId: target.run.id,
      hachiSessionId: target.run.sessionId,
      targetRole: "worker",
      expectedCancelFence: 0,
    }, "supervisor", serviceProvenance);
    const claimed = store!.claimNativeCommunicationAttempt({
      attemptId: created.id,
      configHash: "1".repeat(64),
      capabilityHash: capabilitySnapshotHash,
      rollout: "on",
      minimumRuntimeVersion: "2.0.0",
      sameHostOnly: true,
      provenance: serviceProvenance,
    });
    store!.beginNativeCommunicationDispatch({
      attemptId: created.id,
      attemptNonce: claimed.attemptNonce!,
      provenance: serviceProvenance,
    });
    expect(() => store!.rebindRecordedNativeCommunicationAttempt({
      attemptId: created.id,
      taskId: target.task.id,
      runId: target.run.id,
      sessionId: target.run.sessionId,
      expectedCancelFence: 0,
      targetBindingId: refreshedTarget.id,
      targetBindingHash: nativeSessionBindingHash(refreshedTarget),
      provenance: serviceProvenance,
    })).toThrow(/recorded/);
    expect(store!.getCommunicationAttempt(created.id)?.targetBindingId).toBe(target.target.id);
  });

  it("dispatch開始前の明示rejectだけはsteerをqueuedのまま残す", () => {
    const target = setup("codex");
    const configHash = "d".repeat(64);
    const created = promoteNativeAttempt(target, "native-v20-reject-before-io", "reject", configHash);
    const claimed = store!.claimNativeCommunicationAttempt({
      attemptId: created.id,
      configHash,
      capabilityHash: capabilitySnapshotHash,
      rollout: "on",
      minimumRuntimeVersion: "2.0.0",
      sameHostOnly: true,
      provenance: serviceProvenance,
    });
    const rejected = store!.recordNativeCommunicationReceipt({
      attemptId: created.id,
      attemptNonce: claimed.attemptNonce!,
      outcome: "rejected",
      detail: "adapter unavailable",
      provenance: target.provenance,
    });
    expect(rejected.status).toBe("rejected");
    expect(store!.getSteerDelivery(target.delivery.id)?.status).toBe("queued");
  });
});
