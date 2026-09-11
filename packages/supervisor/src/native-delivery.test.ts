import { describe, expect, it } from "vitest";
import {
  communicationCanaryCohortKey,
  isCommunicationCanaryEligible,
  nativeSessionBindingHash,
  SqliteKanbanStore,
} from "@hachi/core";
import type {
  CommunicationDeliveryAttemptRow,
  CreateSteerDeliveryInput,
  CreateNativeTargetBindingInput,
  HachiConfig,
  NativeCommunicationSessionRef,
  NativeSessionBindingRow,
  Provider,
  SessionRef,
  StageDeps,
  SteerDeliveryRow,
  Logger,
} from "@hachi/core";
import { taskInput } from "@hachi/testing";
import {
  deliverNativeCodex,
  nativeCanaryEligible,
  nativeLaunchSelected,
  prepareNativeSteer,
  type NativeSteerInput,
} from "./native-delivery.js";
import { nativeRecoveryStage } from "./stages/native-recovery.js";
import { FakeAdapter, FakeNativeCommunicationAdapter } from "./test-support.js";

const LOGGER: Logger = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
  child: (): Logger => LOGGER,
};

function addressFor(ref: NativeCommunicationSessionRef): string {
  return ref.route === "codex-app-server"
    ? JSON.stringify({
        route: ref.route,
        threadId: ref.threadId,
        activeTurnId: ref.activeTurnId,
        socketSnapshot: ref.socketSnapshot,
      })
    : JSON.stringify({ route: ref.route, agentRef: ref.agentRef });
}

function nativeEvidence(provider: Provider, sessionId: string, now: number): NativeCommunicationSessionRef {
  return provider === "codex"
    ? {
        route: "codex-app-server",
        providerSessionId: sessionId,
        threadId: "thread-1",
        activeTurnId: "turn-1",
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
        runtimeVersion: "1.0.0",
        capabilityHash: "a".repeat(64),
        hostId: "host-1",
        observedAt: now - 10,
        expiresAt: now + 300,
      }
    : {
        route: "claude-cross-session",
        providerSessionId: sessionId,
        agentRef: "agent-ref-1",
        runtimeVersion: "1.0.0",
        capabilityHash: "b".repeat(64),
        hostId: "host-1",
        observedAt: now - 10,
        expiresAt: now + 300,
      };
}

function binding(
  kind: "source" | "target",
  taskId: string,
  runId: number | null,
  sessionId: string,
  provider: Provider,
  evidence: NativeCommunicationSessionRef,
  now: number,
): NativeSessionBindingRow {
  return {
    id: `${kind}-binding`,
    bindingKey: `${kind}:${taskId}:${sessionId}`,
    kind,
    provider,
    hostId: evidence.hostId,
    providerSessionId: evidence.providerSessionId,
    nativeAddress: addressFor(evidence),
    runtimeVersion: evidence.runtimeVersion,
    capabilityHash: evidence.capabilityHash,
    observedAt: evidence.observedAt,
    expiresAt: evidence.expiresAt,
    taskId,
    runId,
    hachiSessionId: runId === null ? "" : `hachi-${runId}`,
    targetRole: runId === null ? "" : "worker",
    expectedCancelFence: runId === null ? null : 0,
    orchestratorId: kind === "source" ? "orch-1" : "",
    orchestratorSessionId: kind === "source" ? "orch-session-1" : "",
    orchestratorGeneration: kind === "source" ? 1 : null,
    status: "active",
    createdAt: now,
    updatedAt: now,
    releasedAt: null,
  };
}

function attempt(id: string, deliveryId: string, provider: Provider, source: NativeSessionBindingRow, target: NativeSessionBindingRow): CommunicationDeliveryAttemptRow {
  const route = provider === "codex" ? "codex-app-server" : "claude-cross-session";
  return {
    id,
    attemptKey: `cli:${deliveryId}`,
    steerDeliveryId: deliveryId,
    sourceBindingId: source.id,
    targetBindingId: target.id,
    preference: "auto",
    route,
    nativeCandidate: route,
    decisionReason: "native-selected",
    status: "recorded",
    payload: JSON.stringify({ message: "continue" }),
    configHash: "c".repeat(64),
    configRollout: "on",
    configMinimumRuntimeVersion: "1.0.0",
    configSameHostOnly: true,
    configCanaryPercent: null,
    capabilityHash: "d".repeat(64),
    sourceBindingHash: "e".repeat(64),
    targetBindingHash: "f".repeat(64),
    claimantOrchestratorId: "",
    claimantSessionId: "",
    claimantGeneration: null,
    claimLeaseUntil: null,
    attemptNonce: null,
    dispatchingAt: null,
    receiptId: "",
    lastError: "",
    provenance: { kind: "service", actorId: "supervisor", actorSessionId: "", actorGeneration: null },
    createdAt: 1000,
    updatedAt: 1000,
    observedAt: null,
    acknowledgedAt: null,
    resolvedAt: null,
  };
}

interface Fixture {
  deps: StageDeps;
  input: NativeSteerInput;
  source: NativeCommunicationSessionRef;
  sourceBinding: NativeSessionBindingRow;
  target: NativeCommunicationSessionRef;
  adapter: FakeNativeCommunicationAdapter;
  state: { attempt: CommunicationDeliveryAttemptRow; promoted: number; rebound: number };
  close: () => void;
}

function fixture(provider: Provider = "codex", rollout: "canary" | "on" = "on"): Fixture {
  const now = 1_000;
  const store = new SqliteKanbanStore(":memory:");
  const task = store.createTask(taskInput({ status: "ready", title: "native delivery", body: "cwd: /tmp" }), "tester");
  store.block(task.id, `${provider}-in-progress: native`, "tester");
  const targetSessionId = `${provider}-target-session`;
  const run = store.startRun(task.id, provider, targetSessionId, {
    role: "worker",
    serverUrl: "native",
    model: "test-model",
    modelDelivery: "native",
  });
  const source = nativeEvidence(provider, `${provider}-source-session`, now);
  const target = nativeEvidence(provider, targetSessionId, now);
  const sourceRow = binding("source", task.id, null, source.providerSessionId, provider, source, now);
  const targetRow = binding("target", task.id, run.id, target.providerSessionId, provider, target, now);
  targetRow.hachiSessionId = run.sessionId;
  const cliAttempt = attempt("cli-attempt", `delivery-${run.id}`, provider, sourceRow, targetRow);
  const state = { attempt: cliAttempt, promoted: 0, rebound: 0 };
  const targetRows = [targetRow];
  const rawStore = store as unknown as Record<string, unknown>;
  rawStore.getNativeSessionBinding = (id: string): NativeSessionBindingRow | null =>
    id === sourceRow.id ? sourceRow : id === targetRow.id ? targetRow : null;
  rawStore.listNativeSessionBindings = (): NativeSessionBindingRow[] => [sourceRow, ...targetRows];
  rawStore.createOrGetNativeTargetBinding = (input: CreateNativeTargetBindingInput): NativeSessionBindingRow => {
    const fresh: NativeSessionBindingRow = {
      ...targetRow,
      id: `target-binding-${targetRows.length + 1}`,
      bindingKey: input.bindingKey,
      hostId: input.hostId,
      providerSessionId: input.providerSessionId,
      nativeAddress: typeof input.nativeAddress === "string"
        ? input.nativeAddress
        : addressFor(target),
      runtimeVersion: input.runtimeVersion,
      capabilityHash: input.capabilityHash,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
    };
    targetRows.push(fresh);
    return fresh;
  };
  rawStore.promoteCommunicationAttemptToNative = (): CommunicationDeliveryAttemptRow => {
    state.promoted += 1;
    return state.attempt;
  };
  rawStore.rebindRecordedNativeCommunicationAttempt = (input: {
    targetBindingId: string;
    targetBindingHash: string;
  }): CommunicationDeliveryAttemptRow => {
    state.rebound += 1;
    state.attempt = {
      ...state.attempt,
      targetBindingId: input.targetBindingId,
      targetBindingHash: input.targetBindingHash,
    };
    return state.attempt;
  };
  rawStore.claimNativeCommunicationAttempt = (): CommunicationDeliveryAttemptRow => {
    state.attempt = { ...state.attempt, status: "claimed", attemptNonce: "nonce-1", claimLeaseUntil: now + 60 };
    return state.attempt;
  };
  rawStore.beginNativeCommunicationDispatch = (): CommunicationDeliveryAttemptRow => {
    state.attempt = { ...state.attempt, status: "dispatching", dispatchingAt: now };
    return state.attempt;
  };
  rawStore.recordNativeCommunicationReceipt = (input: { outcome: CommunicationDeliveryAttemptRow["status"] }): CommunicationDeliveryAttemptRow => {
    state.attempt = { ...state.attempt, status: input.outcome };
    return state.attempt;
  };

  const adapter = new FakeNativeCommunicationAdapter(provider);
  adapter.probeResponse = { state: "supported", detail: "fresh exact probe", target };
  const deps: StageDeps = {
    store,
    config: {
      profiles: {},
      allowlist: { codex: [], claude: [] },
      resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
      defaultProfile: "test",
      communication: {
        [provider]: {
          rollout,
          minimumRuntimeVersion: "1.0.0",
          sameHostOnly: true,
          ...(rollout === "canary" ? { canaryPercent: 100 } : {}),
        },
      },
    } satisfies HachiConfig,
    env: {} as StageDeps["env"],
    adapters: { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude") },
    nativeCommunicationAdapters: { [provider]: adapter },
    logger: LOGGER,
  };
  const ref: SessionRef = {
    provider,
    sessionId: targetSessionId,
    serverUrl: "native",
    model: "test-model",
    modelDelivery: "native",
    nativeCommunication: target,
    startedAt: now - 10,
  };
  const input: NativeSteerInput = {
    deps,
    config: deps.config,
    task,
    run,
    ref,
    deliveryId: `delivery-${run.id}`,
    messageKey: "message-1",
    message: "continue",
    sourceProvider: provider,
    sourceSessionId: source.providerSessionId,
    preference: "auto",
    now,
    communicationAttemptId: "cli-attempt",
  };
  return { deps, input, source, sourceBinding: sourceRow, target, adapter, state, close: () => store.close() };
}

describe("native supervisor delivery", () => {
  it("active on は fresh probe 後に CLI attempt を同一行 promote する", async () => {
    const test = fixture();
    try {
      const prepared = await prepareNativeSteer(test.input, {
        communication: {
          sourceBindingId: "source-binding",
          source: test.source,
        },
      });
      expect(prepared.kind).toBe("native");
      expect(prepared.attempt?.id).toBe("cli-attempt");
      expect(test.state.promoted).toBe(1);
      expect(test.adapter.probeCalls).toHaveLength(1);
    } finally {
      test.close();
    }
  });

  it.each(["codex", "claude"] as const)("CLI-style %s source binding may omit nativeAddress while target stays exact", async (provider) => {
    const test = fixture(provider);
    test.sourceBinding.nativeAddress = "";
    try {
      const prepared = await prepareNativeSteer(test.input, {
        communication: { sourceBindingId: test.sourceBinding.id },
      });
      expect(prepared.kind).toBe(provider === "codex" ? "native" : "relay-wait");
      expect(prepared.sourceBinding?.nativeAddress).toBe("");
      expect(prepared.targetBinding?.nativeAddress).toBe(addressFor(test.target));
      expect(test.state.promoted).toBe(1);
    } finally {
      test.close();
    }
  });

  it("malformed source evidence is not treated as absent evidence", async () => {
    const test = fixture();
    try {
      const prepared = await prepareNativeSteer(test.input, {
        communication: {
          sourceBindingId: test.sourceBinding.id,
          source: { route: "codex-app-server", threadId: "missing-evidence-fields" },
        },
      });
      expect(prepared.kind).toBe("refused");
      expect(test.state.promoted).toBe(0);
    } finally {
      test.close();
    }
  });

  it.each([
    ["transport_accepted", "transport_accepted"],
    ["session_observed", "session_observed"],
    ["acknowledged", "acknowledged"],
    ["rejected", "rejected"],
    ["uncertain", "uncertain"],
  ] as const)("Codex adapter outcome %s is durably recorded", async (outcome, expected) => {
    const test = fixture();
    test.adapter.deliverResponse = outcome === "uncertain" || outcome === "rejected"
      ? { outcome, detail: "provider outcome" }
      : { outcome, receiptId: `receipt-${outcome}` };
    try {
      const prepared = await prepareNativeSteer(test.input, {
        communication: {
          sourceBindingId: "source-binding",
          source: test.source,
        },
      });
      const result = await deliverNativeCodex(test.input, prepared, "continue");
      expect(result.status).toBe(expected);
      expect(test.state.attempt.status).toBe(expected);
      expect(test.adapter.deliverCalls[0]?.target).toEqual(test.target);
    } finally {
      test.close();
    }
  });

  it("probe thread/address drift is refused before native attempt creation", async () => {
    const test = fixture();
    const codexTarget = test.target as Extract<NativeCommunicationSessionRef, { route: "codex-app-server" }>;
    const drifted: NativeCommunicationSessionRef = { ...codexTarget, threadId: "thread-after-restart" };
    test.adapter.probeResponse = { state: "supported", detail: "restart changed turn", target: drifted };
    try {
      const prepared = await prepareNativeSteer(test.input, {
        communication: {
          sourceBindingId: "source-binding",
          source: test.source,
        },
      });
      expect(prepared.kind).toBe("refused");
      expect(test.state.promoted).toBe(0);
    } finally {
      test.close();
    }
  });

  it("probe turn rotation is durably refreshed and accepted for the same Codex thread", async () => {
    const test = fixture();
    const codexTarget = test.target as Extract<NativeCommunicationSessionRef, { route: "codex-app-server" }>;
    const refreshed: NativeCommunicationSessionRef = {
      ...codexTarget,
      activeTurnId: "turn-after-steer",
      observedAt: 1_001,
      expiresAt: 1_601,
    };
    test.adapter.probeResponse = { state: "supported", detail: "turn rotated", target: refreshed };
    try {
      const prepared = await prepareNativeSteer(test.input, {
        communication: {
          sourceBindingId: "source-binding",
          source: test.source,
        },
      });
      expect(prepared.kind).toBe("native");
      expect(prepared.targetEvidence).toEqual(refreshed);
      expect(prepared.targetBinding?.nativeAddress).toContain("turn-after-steer");
      expect(prepared.targetBinding?.nativeAddress).toBe(addressFor(refreshed));
      expect(prepared.targetBinding?.expiresAt).toBe(1_601);
      expect(test.state.promoted).toBe(1);
    } finally {
      test.close();
    }
  });

  it("expired run-meta evidence renews the durable target TTL from a fresh probe", async () => {
    const test = fixture();
    const stale = test.input.ref.nativeCommunication as Extract<NativeCommunicationSessionRef, { route: "codex-app-server" }>;
    const targetRows = (test.deps.store as unknown as {
      listNativeSessionBindings(taskId?: string): NativeSessionBindingRow[];
    }).listNativeSessionBindings(test.input.task.id);
    const existingTarget = targetRows.find((row) => row.kind === "target");
    expect(existingTarget).toBeDefined();
    existingTarget!.bindingKey = `target:${test.input.task.id}:${String(test.input.run.id)}:worker:${stale.route}:${stale.providerSessionId}:${stale.threadId}:${stale.activeTurnId}:${stale.capabilityHash}`;
    const staleRef: SessionRef = {
      ...test.input.ref,
      nativeCommunication: { ...stale, observedAt: 900, expiresAt: 999 },
    };
    const refreshed: NativeCommunicationSessionRef = {
      ...stale,
      observedAt: 1_002,
      expiresAt: 1_602,
    };
    test.input = { ...test.input, ref: staleRef };
    test.adapter.probeResponse = { state: "supported", detail: "ttl renewed", target: refreshed };
    try {
      const prepared = await prepareNativeSteer(test.input, {
        communication: {
          sourceBindingId: "source-binding",
          source: test.source,
        },
      });
      expect(prepared.kind).toBe("native");
      expect(prepared.targetEvidence).toEqual(refreshed);
      expect(prepared.targetBinding?.observedAt).toBe(1_002);
      expect(prepared.targetBinding?.expiresAt).toBe(1_602);
      expect(test.state.promoted).toBe(1);
    } finally {
      test.close();
    }
  });

  it("recorded native attempt rebinds to a fresh turn/TTL and repeated prepare is idempotent", async () => {
    const test = fixture();
    try {
      const initial = await prepareNativeSteer(test.input, {
        communication: {
          sourceBindingId: "source-binding",
          source: test.source,
        },
      });
      expect(initial.kind).toBe("native");
      const previousTargetBindingId = initial.targetBinding!.id;
      test.state.attempt = {
        ...test.state.attempt,
        status: "recorded",
        route: "codex-app-server",
        nativeCandidate: "codex-app-server",
        sourceBindingId: initial.sourceBinding!.id,
        targetBindingId: previousTargetBindingId,
        configHash: initial.configHash,
        capabilityHash: initial.capabilityHash,
        sourceBindingHash: nativeSessionBindingHash(initial.sourceBinding!),
        targetBindingHash: nativeSessionBindingHash(initial.targetBinding!),
      };
      (test.deps.store as unknown as Record<string, unknown>).getCommunicationAttempt = (id: string): CommunicationDeliveryAttemptRow | null =>
        id === test.state.attempt.id ? test.state.attempt : null;
      const codexTarget = test.target as Extract<NativeCommunicationSessionRef, { route: "codex-app-server" }>;
      const refreshed: NativeCommunicationSessionRef = {
        ...codexTarget,
        activeTurnId: "turn-rebound",
        observedAt: 1_004,
        expiresAt: 1_604,
      };
      test.adapter.probeResponse = { state: "supported", detail: "rebind fresh target", target: refreshed };

      const rebound = await prepareNativeSteer(test.input, {
        communication: {
          sourceBindingId: "source-binding",
          source: test.source,
        },
      });
      expect(rebound.kind).toBe("native");
      expect(rebound.targetEvidence).toEqual(refreshed);
      expect(rebound.targetBinding?.id).not.toBe(previousTargetBindingId);
      expect(test.state.rebound).toBe(1);
      expect(test.state.attempt.targetBindingId).toBe(rebound.targetBinding?.id);

      const repeated = await prepareNativeSteer(test.input, {
        communication: {
          sourceBindingId: "source-binding",
          source: test.source,
        },
      });
      expect(repeated.kind).toBe("native");
      expect(repeated.targetBinding?.id).toBe(rebound.targetBinding?.id);
      expect(test.state.rebound).toBe(1);
    } finally {
      test.close();
    }
  });

  it("delivery uses the fresh prepared target instead of stale run-meta address", async () => {
    const test = fixture();
    const codexTarget = test.target as Extract<NativeCommunicationSessionRef, { route: "codex-app-server" }>;
    const refreshed: NativeCommunicationSessionRef = {
      ...codexTarget,
      activeTurnId: "turn-before-dispatch",
      observedAt: 1_003,
      expiresAt: 1_603,
    };
    test.adapter.probeResponse = { state: "supported", detail: "fresh dispatch target", target: refreshed };
    test.adapter.deliverResponse = { outcome: "transport_accepted", receiptId: "fresh-receipt" };
    try {
      const prepared = await prepareNativeSteer(test.input, {
        communication: {
          sourceBindingId: "source-binding",
          source: test.source,
        },
      });
      const result = await deliverNativeCodex(test.input, prepared, "continue");
      expect(result.status).toBe("transport_accepted");
      expect(test.adapter.deliverCalls[0]?.target).toEqual(refreshed);
      expect((test.adapter.deliverCalls[0]?.target as Extract<NativeCommunicationSessionRef, { route: "codex-app-server" }>).activeTurnId)
        .toBe("turn-before-dispatch");
    } finally {
      test.close();
    }
  });

  it("native recovery redrives a recorded attempt while its processed steer stays queued", async () => {
    const test = fixture();
    const durableSteerStore = test.deps.store as unknown as {
      createOrGetSteerDelivery(input: CreateSteerDeliveryInput): SteerDeliveryRow;
      getSteerDelivery(id: string): SteerDeliveryRow | null;
    };
    const delivery = durableSteerStore.createOrGetSteerDelivery({
      taskId: test.input.task.id,
      runId: test.input.run.id,
      sessionId: test.input.run.sessionId,
      messageKey: "message-redrive-after-claim",
      expectedCancelFence: 0,
      actor: "tester",
    });
    test.adapter.deliverResponse = { outcome: "transport_accepted", receiptId: "redrive-receipt" };
    try {
      // Model Core recovery's claimed-before-begin result: the attempt is recorded
      // again, while the mark-first board message left its durable steer queued.
      const prepared = await prepareNativeSteer(test.input, {
        communication: {
          sourceBindingId: "source-binding",
          source: test.source,
        },
      });
      expect(prepared.kind).toBe("native");
      const recoveredAttempt: CommunicationDeliveryAttemptRow = {
        ...test.state.attempt,
        steerDeliveryId: delivery.id,
        status: "recorded",
        route: "codex-app-server",
        nativeCandidate: "codex-app-server",
        sourceBindingId: test.sourceBinding.id,
        targetBindingId: prepared.targetBinding!.id,
        configHash: prepared.configHash,
        capabilityHash: prepared.capabilityHash,
        sourceBindingHash: nativeSessionBindingHash(prepared.sourceBinding!),
        targetBindingHash: nativeSessionBindingHash(prepared.targetBinding!),
        payload: JSON.stringify({ message: "continue after recovery" }),
      };
      test.state.attempt = recoveredAttempt;
      const rawStore = test.deps.store as unknown as Record<string, unknown>;
      rawStore.getCommunicationAttempt = (id: string): CommunicationDeliveryAttemptRow | null =>
        id === recoveredAttempt.id ? test.state.attempt : null;
      rawStore.listCommunicationAttempts = (): CommunicationDeliveryAttemptRow[] => [test.state.attempt];
      rawStore.listNativeCommunicationRedriveCandidates = (): CommunicationDeliveryAttemptRow[] => [test.state.attempt];
      rawStore.getNativeSessionBinding = (id: string): NativeSessionBindingRow | null =>
        (test.deps.store as unknown as { listNativeSessionBindings(taskId?: string): NativeSessionBindingRow[] })
          .listNativeSessionBindings(test.input.task.id)
          .find((row) => row.id === id) ?? null;
      const codexTarget = test.target as Extract<NativeCommunicationSessionRef, { route: "codex-app-server" }>;
      const refreshed: NativeCommunicationSessionRef = {
        ...codexTarget,
        activeTurnId: "turn-recovery-redrive",
        observedAt: 1_005,
        expiresAt: 1_605,
      };
      test.adapter.probeResponse = { state: "supported", detail: "recovery fresh target", target: refreshed };
      rawStore.recoverNativeCommunicationAttempts = (): { requeuedClaimed: number; uncertainDispatching: number } => ({
        requeuedClaimed: 1,
        uncertainDispatching: 0,
      });

      const result = await nativeRecoveryStage.tick(test.deps, true, test.input.now);

      expect(result.actions).toBe(2);
      expect(result.notes?.some((note) => note.includes("durable native redrive=transport_accepted"))).toBe(true);
      expect(test.adapter.deliverCalls).toHaveLength(1);
      expect(test.adapter.deliverCalls[0]?.message).toBe("continue after recovery");
      expect(test.adapter.deliverCalls[0]?.target).toEqual(refreshed);
      expect(test.state.rebound).toBe(1);
      expect(test.state.attempt.status).toBe("transport_accepted");
      expect(durableSteerStore.getSteerDelivery(delivery.id)?.status).toBe("queued");
    } finally {
      test.close();
    }
  });

  it("probe capability drift is refused before native attempt creation", async () => {
    const test = fixture();
    test.adapter.probeResponse = {
      state: "supported",
      detail: "schema changed",
      target: { ...test.target, capabilityHash: "d".repeat(64) },
    };
    try {
      const prepared = await prepareNativeSteer(test.input, {
        communication: {
          sourceBindingId: "source-binding",
          source: test.source,
        },
      });
      expect(prepared.kind).toBe("refused");
      expect(test.state.promoted).toBe(0);
    } finally {
      test.close();
    }
  });

  it("Claude active route is recorded as relay-wait without Codex delivery", async () => {
    const test = fixture("claude");
    try {
      const prepared = await prepareNativeSteer(test.input, {
        communication: {
          sourceBindingId: "source-binding",
          source: test.source,
        },
      });
      expect(prepared.kind).toBe("relay-wait");
      expect(prepared.attempt?.id).toBe("cli-attempt");
      expect(test.adapter.deliverCalls).toHaveLength(0);
    } finally {
      test.close();
    }
  });

  it.each(["off", "observe", "draining"] as const)("%s rollout stays on Hachi route", async (rollout) => {
    const test = fixture("codex", rollout === "off" ? "on" : "on");
    const config = {
      ...test.input.config,
      communication: { codex: { rollout } },
    } satisfies HachiConfig;
    try {
      const prepared = await prepareNativeSteer({ ...test.input, config }, {});
      expect(prepared.kind).toBe("hachi");
      expect(test.state.promoted).toBe(0);
    } finally {
      test.close();
    }
  });

  it("cross-provider preference auto remains Hachi and native preference refuses", async () => {
    const test = fixture();
    try {
      const auto = await prepareNativeSteer({ ...test.input, sourceProvider: "claude", sourceSessionId: "claude-source" }, {});
      expect(auto.kind).toBe("hachi");
      const native = await prepareNativeSteer({ ...test.input, preference: "native", sourceProvider: "claude", sourceSessionId: "claude-source" }, {});
      expect(native.kind).toBe("refused");
    } finally {
      test.close();
    }
  });

  it("canary non-selected auto route remains Hachi", async () => {
    let test = fixture("codex", "canary");
    for (let attempts = 0; nativeCanaryEligible(test.input.task.id, "codex", 1); attempts += 1) {
      test.close();
      if (attempts >= 100) {
        throw new Error("non-selected canary fixtureを決定論的な上限内で作成できませんでした");
      }
      test = fixture("codex", "canary");
    }
    const config = {
      ...test.input.config,
      communication: {
        codex: {
          rollout: "canary" as const,
          minimumRuntimeVersion: "1.0.0",
          sameHostOnly: true as const,
          canaryPercent: 1,
        },
      },
    } satisfies HachiConfig;
    try {
      const prepared = await prepareNativeSteer({ ...test.input, config }, {});
      expect(prepared.kind).toBe("hachi");
      expect(nativeLaunchSelected(config, "codex", test.input.task.id)).toBe(false);
    } finally {
      test.close();
    }
  });

  it.each([1, 25, 50, 100] as const)("canary selection delegates to Core policy at %d percent", (percent) => {
    const taskId = "task-canary-parity";
    expect(nativeCanaryEligible(taskId, "codex", percent)).toBe(
      isCommunicationCanaryEligible(taskId, communicationCanaryCohortKey("codex"), percent),
    );
  });

  it("canary launchとsteerはtask/providerの同じcohortを使う", async () => {
    const test = fixture("codex", "canary");
    const selected = nativeLaunchSelected(test.input.config, "codex", test.input.task.id);
    try {
      const prepared = await prepareNativeSteer(test.input, {});
      expect(prepared.kind === "native").toBe(selected);
    } finally {
      test.close();
    }
  });
});
