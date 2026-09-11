import { describe, expect, it } from "vitest";

import {
  decideRelayAuthorization,
  RELAY_AUTHORIZATION_ROUTES,
  type RelayAuthorizationInput,
  type RelayObserverAuthorizationInput,
  type RelayOwnerAuthorizationInput,
  type RelayAuthorizationRoute,
  type RelaySessionOwnership,
} from "./relay-authorization.js";
import { RelayRegistry } from "./relay-registry.js";

interface Fixture {
  registry: RelayRegistry;
  input: RelayOwnerAuthorizationInput;
  observerInput: RelayObserverAuthorizationInput;
  setNow: (value: number) => void;
}

function createFixture(options: { registered?: boolean } = {}): Fixture {
  let currentTime = 1_000;
  const registry = new RelayRegistry({
    host: "host-a",
    evenTerminalBootEpoch: "boot-a",
    now: () => currentTime,
  });
  if (options.registered !== false) {
    registry.register({
      sessionId: "session-a",
      providerSessionId: "provider-session-a",
      provider: "codex",
      serverUrl: "http://127.0.0.1:3456",
      host: "host-a",
      evenTerminalBootEpoch: "boot-a",
      handoverGeneration: 7,
      relayId: "relay-a",
    });
  }
  const commonInput = {
    route: "history" as const,
    sessionId: "session-a",
    provider: "codex" as const,
    host: "host-a",
    evenTerminalBootEpoch: "boot-a",
    requestingServerUrl: "http://127.0.0.1:3456",
    relayResponsive: true,
    processLiveness: "alive" as const,
    transcriptExists: true,
    ownershipLookup: () => [],
  };
  return {
    registry,
    input: {
      ...commonInput,
      kind: "owner",
      handoverGeneration: 7,
      relayId: "relay-a",
      fencingToken: 1,
    },
    observerInput: {
      ...commonInput,
      kind: "observer",
    },
    setNow(value: number): void {
      currentTime = value;
    },
  };
}

function createOwnership(overrides: Partial<RelaySessionOwnership> = {}): RelaySessionOwnership {
  return {
    provider: "codex",
    transport: "bridge",
    serverUrl: "http://127.0.0.1:3456",
    ...overrides,
  };
}

describe("decideRelayAuthorization", () => {
  it("状態1: active owner の read/interrupt を許可し、prompt だけは明示的に閉じる", () => {
    const { registry, input } = createFixture();
    const allowedRoutes: RelayAuthorizationRoute[] = ["sessions", "history", "events", "interrupt"];

    for (const route of allowedRoutes) {
      expect(decideRelayAuthorization(registry, { ...input, route })).toMatchObject({
        state: "active_owner",
        route,
        allowed: true,
        resumeAllowed: false,
        reason: "active_relay",
        httpStatus: 200,
        excludeFromSessionList: false,
        owner: { relayId: "relay-a", fencingToken: 1 },
      });
    }
    expect(decideRelayAuthorization(registry, { ...input, route: "prompt" })).toMatchObject({
      state: "active_owner",
      allowed: false,
      resumeAllowed: false,
      reason: "prompt_forwarding_disabled",
      httpStatus: 409,
      excludeFromSessionList: false,
    });
  });

  it("状態1: observer は generation / relay ID / fencing token を名乗らず active owner を参照できる", () => {
    const { registry, observerInput } = createFixture();

    expect(decideRelayAuthorization(registry, observerInput)).toMatchObject({
      state: "active_owner",
      allowed: true,
      resumeAllowed: false,
      reason: "active_relay",
      httpStatus: 200,
      owner: { relayId: "relay-a", fencingToken: 1 },
    });
  });

  it("provider 不一致は全 route で stale/foreign として拒否する", () => {
    const { registry, input } = createFixture();

    for (const route of RELAY_AUTHORIZATION_ROUTES) {
      expect(decideRelayAuthorization(registry, { ...input, route, provider: "claude" })).toMatchObject({
        state: "stale_or_foreign",
        route,
        allowed: false,
        resumeAllowed: false,
        reason: "stale_or_foreign_registration",
        httpStatus: 409,
        excludeFromSessionList: true,
        owner: null,
      });
    }
  });

  it("requestingServerUrl 不一致は全 route で stale/foreign として拒否する", () => {
    const { registry, input } = createFixture();

    for (const route of RELAY_AUTHORIZATION_ROUTES) {
      expect(decideRelayAuthorization(registry, {
        ...input,
        route,
        requestingServerUrl: "http://127.0.0.1:3457",
      })).toMatchObject({
        state: "stale_or_foreign",
        route,
        allowed: false,
        resumeAllowed: false,
        reason: "stale_or_foreign_registration",
        httpStatus: 409,
        excludeFromSessionList: true,
        owner: null,
      });
    }
  });

  it("状態2: relay 応答不能と lease 失効を unavailable にして resume へ流さない", () => {
    const { registry, input, setNow } = createFixture();

    expect(decideRelayAuthorization(registry, { ...input, relayResponsive: false })).toMatchObject({
      state: "relay_unavailable",
      allowed: false,
      resumeAllowed: false,
      reason: "relay_unavailable",
      httpStatus: 503,
      excludeFromSessionList: true,
    });

    setNow(1_090);
    expect(decideRelayAuthorization(registry, input)).toMatchObject({
      state: "relay_unavailable",
      allowed: false,
      resumeAllowed: false,
      httpStatus: 503,
    });
  });

  it("状態3: host / boot epoch / generation 不一致を stale/foreign として一覧から外す", () => {
    const { registry, input } = createFixture();
    const mismatches: RelayAuthorizationInput[] = [
      { ...input, host: "host-b" },
      { ...input, evenTerminalBootEpoch: "boot-b" },
      { ...input, handoverGeneration: 8 },
    ];

    for (const mismatch of mismatches) {
      expect(decideRelayAuthorization(registry, mismatch)).toMatchObject({
        state: "stale_or_foreign",
        allowed: false,
        resumeAllowed: false,
        reason: "stale_or_foreign_registration",
        httpStatus: 409,
        excludeFromSessionList: true,
      });
    }
  });

  it("状態4: 生存 owner と異なる後発 relay を conflict で拒否する", () => {
    const { registry, input } = createFixture();

    expect(decideRelayAuthorization(registry, { ...input, relayId: "relay-b" })).toMatchObject({
      state: "owner_conflict",
      allowed: false,
      resumeAllowed: false,
      reason: "active_owner_conflict",
      httpStatus: 409,
      excludeFromSessionList: true,
      owner: null,
    });
  });

  it("R1: 同一 identity の再登録後は旧 fencing token を拒否する", () => {
    const { registry, input, setNow } = createFixture();
    setNow(1_090);
    const replacement = registry.register({
      sessionId: input.sessionId,
      providerSessionId: "provider-session-a",
      provider: input.provider,
      serverUrl: input.requestingServerUrl,
      host: input.host,
      evenTerminalBootEpoch: input.evenTerminalBootEpoch,
      handoverGeneration: input.handoverGeneration,
      relayId: input.relayId,
    });

    expect(replacement.fencingToken).toBe(2);
    expect(decideRelayAuthorization(registry, input)).toMatchObject({
      state: "owner_conflict",
      allowed: false,
      resumeAllowed: false,
      reason: "active_owner_conflict",
      httpStatus: 409,
      owner: null,
    });
    expect(decideRelayAuthorization(registry, {
      ...input,
      fencingToken: replacement.fencingToken,
    })).toMatchObject({
      state: "active_owner",
      allowed: true,
      owner: { fencingToken: 2 },
    });
  });

  it("状態5: 未登録でプロセス生存中の session を allow/resume にしない", () => {
    const { registry, observerInput } = createFixture({ registered: false });

    expect(decideRelayAuthorization(registry, observerInput)).toMatchObject({
      state: "unregistered_process",
      allowed: false,
      resumeAllowed: false,
      reason: "unregistered_process",
      httpStatus: 409,
      excludeFromSessionList: true,
    });
  });

  it("状態6/R4: observer が fence 無しで provider + bridge + server の exact-one transcript だけ読む", () => {
    const { registry, observerInput } = createFixture({ registered: false });
    const transcriptOnly = {
      ...observerInput,
      route: "history" as const,
      processLiveness: "absent" as const,
      transcriptExists: true,
    };

    const readRoutes: RelayAuthorizationRoute[] = ["sessions", "history", "events"];
    for (const route of readRoutes) {
      expect(decideRelayAuthorization(registry, {
        ...transcriptOnly,
        route,
        ownershipLookup: (sessionId) => {
          expect(sessionId).toBe("session-a");
          return [createOwnership()];
        },
      })).toMatchObject({
        state: "transcript_only",
        route,
        allowed: true,
        resumeAllowed: false,
        reason: "owned_transcript",
        httpStatus: 200,
        excludeFromSessionList: false,
      });
    }

    expect(decideRelayAuthorization(registry, {
      ...transcriptOnly,
      ownershipLookup: () => [],
    })).toMatchObject({
      state: "transcript_only",
      allowed: false,
      resumeAllowed: false,
      reason: "transcript_not_owned",
      excludeFromSessionList: true,
    });

    expect(decideRelayAuthorization(registry, {
      ...transcriptOnly,
      ownershipLookup: () => [createOwnership({ serverUrl: "http://127.0.0.1:3457" })],
    })).toMatchObject({
      state: "transcript_only",
      allowed: false,
      resumeAllowed: false,
      reason: "transcript_not_owned",
      excludeFromSessionList: true,
    });

    // 契約 §78.8: 正当な direct 行（sentinel serverUrl）は valid だが bridge 専用の exact-one には
    // 一致しない。invalid 行として lookup 全体を落とすのではなく transcript_not_owned で 409 になる。
    expect(decideRelayAuthorization(registry, {
      ...transcriptOnly,
      ownershipLookup: () => [createOwnership({ transport: "direct", serverUrl: "direct" })],
    })).toMatchObject({
      state: "transcript_only",
      allowed: false,
      resumeAllowed: false,
      reason: "transcript_not_owned",
      excludeFromSessionList: true,
    });

    // valid な direct 行が同時に存在しても、bridge の exact-one match には干渉しない。
    expect(decideRelayAuthorization(registry, {
      ...transcriptOnly,
      ownershipLookup: () => [createOwnership(), createOwnership({ transport: "direct", serverUrl: "direct" })],
    })).toMatchObject({
      state: "transcript_only",
      allowed: true,
      resumeAllowed: false,
      reason: "owned_transcript",
      httpStatus: 200,
      excludeFromSessionList: false,
    });

    // 契約 §78.8: direct transport に非 sentinel serverUrl は invalid。1行でも invalid なら
    // lookup 全体を ownership_lookup_failed として fail-closed にする。
    expect(decideRelayAuthorization(registry, {
      ...transcriptOnly,
      ownershipLookup: () => [createOwnership({ transport: "direct" })],
    })).toMatchObject({
      state: "transcript_only",
      allowed: false,
      resumeAllowed: false,
      reason: "ownership_lookup_failed",
      httpStatus: 503,
      excludeFromSessionList: true,
    });

    // 未知 transport も invalid（fail-closed）。
    expect(decideRelayAuthorization(registry, {
      ...transcriptOnly,
      ownershipLookup: () => [createOwnership({ transport: "unknown" })],
    })).toMatchObject({
      state: "transcript_only",
      allowed: false,
      resumeAllowed: false,
      reason: "ownership_lookup_failed",
      httpStatus: 503,
      excludeFromSessionList: true,
    });

    const foreignOwnerships: RelaySessionOwnership[] = [createOwnership({ provider: "claude" })];
    for (const ownership of foreignOwnerships) {
      expect(decideRelayAuthorization(registry, {
        ...transcriptOnly,
        ownershipLookup: () => [ownership],
      })).toMatchObject({
        state: "transcript_only",
        allowed: false,
        resumeAllowed: false,
        reason: "transcript_not_owned",
        httpStatus: 409,
      });
    }

    expect(decideRelayAuthorization(registry, {
      ...transcriptOnly,
      ownershipLookup: () => [createOwnership(), createOwnership()],
    })).toMatchObject({
      state: "transcript_only",
      allowed: false,
      resumeAllowed: false,
      reason: "ambiguous_transcript_ownership",
      httpStatus: 409,
    });
  });

  it("R3: transcript-only prompt は one-shot claim/fence 導入まで閉じる", () => {
    const { registry, observerInput } = createFixture({ registered: false });

    expect(decideRelayAuthorization(registry, {
      ...observerInput,
      route: "prompt",
      processLiveness: "absent",
      ownershipLookup: () => [createOwnership()],
    })).toMatchObject({
      state: "transcript_only",
      allowed: false,
      resumeAllowed: false,
      reason: "prompt_forwarding_disabled",
      httpStatus: 409,
      excludeFromSessionList: false,
    });
  });

  it("R5: 所有証拠が一致する transcript-only interrupt も 409 で拒否する", () => {
    const { registry, observerInput } = createFixture({ registered: false });

    expect(decideRelayAuthorization(registry, {
      ...observerInput,
      route: "interrupt",
      processLiveness: "absent",
      ownershipLookup: () => [createOwnership()],
    })).toMatchObject({
      state: "transcript_only",
      allowed: false,
      resumeAllowed: false,
      reason: "transcript_has_no_process_to_interrupt",
      httpStatus: 409,
      excludeFromSessionList: false,
    });
  });

  it("状態6: ownership lookup の失敗を unavailable として fail-closed にする", () => {
    const { registry, observerInput } = createFixture({ registered: false });

    expect(decideRelayAuthorization(registry, {
      ...observerInput,
      processLiveness: "absent",
      transcriptExists: true,
      ownershipLookup: () => {
        throw new Error("board unavailable");
      },
    })).toMatchObject({
      state: "transcript_only",
      allowed: false,
      resumeAllowed: false,
      reason: "ownership_lookup_failed",
      httpStatus: 503,
      excludeFromSessionList: true,
    });

    const invalidLookupResults: unknown[] = [
      null,
      [{ transport: "bridge", serverUrl: "http://127.0.0.1:3456" }],
    ];
    for (const invalidLookupResult of invalidLookupResults) {
      expect(decideRelayAuthorization(registry, {
        ...observerInput,
        processLiveness: "absent",
        ownershipLookup: (() => invalidLookupResult) as unknown as RelayAuthorizationInput["ownershipLookup"],
      })).toMatchObject({
        state: "transcript_only",
        allowed: false,
        resumeAllowed: false,
        reason: "ownership_lookup_failed",
        httpStatus: 503,
      });
    }
  });

  it("R2: route・文字列・整数・boolean の不正な実行時入力を allow へ落とさない", () => {
    const { registry, input } = createFixture();
    const invalidInputs: RelayAuthorizationInput[] = [
      { ...input, route: "promt" } as unknown as RelayAuthorizationInput,
      { ...input, provider: "" } as unknown as RelayAuthorizationInput,
      { ...input, requestingServerUrl: "" },
      { ...input, fencingToken: 0 },
      { ...input, handoverGeneration: 0 },
      { ...input, relayResponsive: undefined } as unknown as RelayAuthorizationInput,
      { ...input, transcriptExists: undefined } as unknown as RelayAuthorizationInput,
    ];

    for (const invalidInput of invalidInputs) {
      const decision = decideRelayAuthorization(registry, invalidInput);
      expect(decision).toMatchObject({
        allowed: false,
        resumeAllowed: false,
        owner: null,
      });
      if ((invalidInput as unknown as { route: string }).route === "promt") {
        expect(decision.route).toBeNull();
      }
    }
  });

  it("R2: unknown/取得失敗相当の process liveness を 503 で拒否する", () => {
    const { registry, observerInput } = createFixture({ registered: false });
    const unknownLivenessInputs: RelayAuthorizationInput[] = [
      { ...observerInput, processLiveness: "unknown" },
      { ...observerInput, processLiveness: undefined } as unknown as RelayAuthorizationInput,
    ];

    for (const unknownInput of unknownLivenessInputs) {
      expect(decideRelayAuthorization(registry, unknownInput)).toMatchObject({
        state: "relay_unavailable",
        allowed: false,
        resumeAllowed: false,
        reason: "process_liveness_unknown",
        httpStatus: 503,
        owner: null,
      });
    }
  });

  it("R2: transcript-only の foreign host/boot epoch を拒否する", () => {
    const { registry, observerInput } = createFixture({ registered: false });
    const invalidInputs: RelayAuthorizationInput[] = [
      { ...observerInput, processLiveness: "absent", host: "host-b" },
      { ...observerInput, processLiveness: "absent", evenTerminalBootEpoch: "boot-b" },
    ];

    for (const invalidInput of invalidInputs) {
      expect(decideRelayAuthorization(registry, invalidInput)).toMatchObject({
        allowed: false,
        resumeAllowed: false,
        httpStatus: 409,
        owner: null,
      });
    }
  });

  it("状態7: 不正または不存在の sessionId を 404 とし allow/resume にしない", () => {
    const { registry, observerInput } = createFixture({ registered: false });
    const cases: RelayAuthorizationInput[] = [
      { ...observerInput, sessionId: " bad-session " },
      { ...observerInput, processLiveness: "absent", transcriptExists: false },
    ];

    for (const entry of cases) {
      expect(decideRelayAuthorization(registry, entry)).toMatchObject({
        state: "session_not_found",
        allowed: false,
        resumeAllowed: false,
        httpStatus: 404,
        excludeFromSessionList: true,
      });
    }
  });
});
