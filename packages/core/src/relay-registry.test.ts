import { describe, expect, it } from "vitest";

import {
  DEFAULT_RELAY_HEARTBEAT_INTERVAL_SECONDS,
  DEFAULT_RELAY_INGRESS_CAPACITY_PER_SESSION,
  DEFAULT_RELAY_LEASE_TTL_SECONDS,
  RelayRegistry,
  RelayRegistryError,
  type RelayIngressEvent,
  type RelayOwnerFence,
  type RelayRegistryErrorCode,
} from "./relay-registry.js";

function expectRelayError(run: () => unknown, code: RelayRegistryErrorCode): void {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(RelayRegistryError);
    expect((error as RelayRegistryError).code).toBe(code);
    return;
  }
  throw new Error(`RelayRegistryError(${code}) が送出されませんでした`);
}

function makeEvent(
  owner: RelayOwnerFence,
  sequence: number,
  kind: RelayIngressEvent["kind"] = "text_delta",
): RelayIngressEvent {
  return {
    sessionId: owner.sessionId,
    handoverGeneration: owner.handoverGeneration,
    turnId: "turn-1",
    toolId: null,
    sequence,
    eventId: `event-${sequence}`,
    kind,
    payload: { text: `payload-${sequence}` },
  };
}

describe("RelayRegistry", () => {
  function createFixture(options: {
    now?: number;
    leaseTtlSeconds?: number;
    heartbeatIntervalSeconds?: number;
    ingressCapacityPerSession?: number;
  } = {}): {
    registry: RelayRegistry;
    owner: RelayOwnerFence;
    setNow: (value: number) => void;
  } {
    let currentTime = options.now ?? 1_000;
    const registry = new RelayRegistry({
      host: "host-a",
      evenTerminalBootEpoch: "boot-a",
      ...(options.leaseTtlSeconds === undefined ? {} : { leaseTtlSeconds: options.leaseTtlSeconds }),
      ...(options.heartbeatIntervalSeconds === undefined
        ? {}
        : { heartbeatIntervalSeconds: options.heartbeatIntervalSeconds }),
      ...(options.ingressCapacityPerSession === undefined
        ? {}
        : { ingressCapacityPerSession: options.ingressCapacityPerSession }),
      now: () => currentTime,
    });
    const owner = registry.register({
      sessionId: "session-a",
      providerSessionId: "provider-session-a",
      provider: "codex",
      serverUrl: "http://127.0.0.1:3456",
      host: "host-a",
      evenTerminalBootEpoch: "boot-a",
      handoverGeneration: 7,
      relayId: "relay-a",
    });
    return {
      registry,
      owner,
      setNow(value: number): void {
        currentTime = value;
      },
    };
  }

  it("同一 registration key への二重登録を conflict で拒否する", () => {
    const { registry } = createFixture();

    expectRelayError(
      () => registry.register({
        sessionId: "session-a",
        providerSessionId: "provider-session-b",
        provider: "codex",
        serverUrl: "http://127.0.0.1:3456",
        host: "host-a",
        evenTerminalBootEpoch: "boot-a",
        handoverGeneration: 7,
        relayId: "relay-b",
      }),
      "ACTIVE_OWNER_CONFLICT",
    );
  });

  it("同一 session の active owner は provider / server を変えても分岐しない", () => {
    const { registry, owner, setNow } = createFixture();
    setNow(1_090);
    const currentOwner = registry.register({
      ...owner,
      providerSessionId: "provider-session-current",
      handoverGeneration: 8,
      relayId: "relay-current",
    });

    expectRelayError(
      () => registry.register({
        ...owner,
        providerSessionId: "provider-session-claude",
        provider: "claude",
        handoverGeneration: 7,
        relayId: "relay-claude",
      }),
      "ACTIVE_OWNER_CONFLICT",
    );
    expectRelayError(
      () => registry.register({
        ...owner,
        providerSessionId: "provider-session-other-server",
        serverUrl: "http://127.0.0.1:3457/",
        handoverGeneration: 7,
        relayId: "relay-other-server",
      }),
      "ACTIVE_OWNER_CONFLICT",
    );

    expect(registry.activeRegistration(owner)).toBeNull();
    expect(registry.activeRegistration(currentOwner)).toMatchObject({
      relayId: "relay-current",
      fencingToken: 2,
    });
  });

  it("server URL の表記ゆれを canonical identity に収束させる", () => {
    const registry = new RelayRegistry({
      host: "host-a",
      evenTerminalBootEpoch: "boot-a",
    });
    const owner = registry.register({
      sessionId: "session-a",
      providerSessionId: "provider-session-a",
      provider: "codex",
      serverUrl: "HTTP://LOCALHOST:80/relay///?ignored=true#fragment",
      host: "host-a",
      evenTerminalBootEpoch: "boot-a",
      handoverGeneration: 7,
      relayId: "relay-a",
    });

    expect(owner.serverUrl).toBe("http://localhost/relay");
    expect(registry.activeRegistration({
      ...owner,
      serverUrl: "http://localhost/relay/",
    })).toMatchObject({ serverUrl: "http://localhost/relay" });
  });

  it("lease 失効後は active から外し、heartbeat は既定 TTL だけ延長する", () => {
    const { registry, owner, setNow } = createFixture();

    expect(registry.leaseTtlSeconds).toBe(DEFAULT_RELAY_LEASE_TTL_SECONDS);
    expect(registry.heartbeatIntervalSeconds).toBe(DEFAULT_RELAY_HEARTBEAT_INTERVAL_SECONDS);
    expect(registry.ingressCapacityPerSession).toBe(DEFAULT_RELAY_INGRESS_CAPACITY_PER_SESSION);
    setNow(1_089);
    expect(registry.heartbeat(owner).leaseExpiresAt).toBe(1_179);
    setNow(1_178);
    expect(registry.activeRegistration(owner)).toMatchObject({ relayId: "relay-a", fencingToken: 1 });
    setNow(1_179);
    expect(registry.activeRegistration(owner)).toBeNull();
    expectRelayError(() => registry.heartbeat(owner), "LEASE_EXPIRED");

    const custom = new RelayRegistry({
      host: "host-a",
      evenTerminalBootEpoch: "boot-a",
      leaseTtlSeconds: 180,
      heartbeatIntervalSeconds: 60,
      ingressCapacityPerSession: 25,
    });
    expect(custom.leaseTtlSeconds).toBe(180);
    expect(custom.heartbeatIntervalSeconds).toBe(60);
    expect(custom.ingressCapacityPerSession).toBe(25);
  });

  it("takeover 後は単調な新 fencing token を発行し、旧 token の write と ack を拒否する", () => {
    const { registry, owner: staleOwner, setNow } = createFixture();
    expect(registry.ingest(staleOwner, makeEvent(staleOwner, 1))).toMatchObject({ status: "accepted" });

    setNow(1_090);
    const currentOwner = registry.register({
      sessionId: staleOwner.sessionId,
      providerSessionId: "provider-session-b",
      provider: staleOwner.provider,
      serverUrl: staleOwner.serverUrl,
      host: staleOwner.host,
      evenTerminalBootEpoch: staleOwner.evenTerminalBootEpoch,
      handoverGeneration: staleOwner.handoverGeneration,
      relayId: "relay-b",
    });

    expect(currentOwner.fencingToken).toBe(2);
    expectRelayError(() => registry.ingest(staleOwner, makeEvent(staleOwner, 2)), "FENCING_TOKEN_MISMATCH");
    expectRelayError(() => registry.acknowledge(staleOwner, "event-1"), "FENCING_TOKEN_MISMATCH");
    expect(registry.ingest(currentOwner, makeEvent(currentOwner, 1))).toMatchObject({ status: "accepted" });
  });

  it("even-terminal boot epoch と handover generation の不一致を拒否する", () => {
    const { registry, owner, setNow } = createFixture();
    const foreignBootOwner: RelayOwnerFence = { ...owner, evenTerminalBootEpoch: "boot-old" };
    const foreignGenerationOwner: RelayOwnerFence = { ...owner, handoverGeneration: owner.handoverGeneration + 1 };

    expectRelayError(() => registry.ingest(foreignBootOwner, makeEvent(foreignBootOwner, 1)), "BOOT_EPOCH_MISMATCH");
    expectRelayError(
      () => registry.ingest(foreignGenerationOwner, makeEvent(foreignGenerationOwner, 1)),
      "GENERATION_MISMATCH",
    );

    setNow(1_090);
    const nextGenerationOwner = registry.register({
      sessionId: owner.sessionId,
      providerSessionId: "provider-session-b",
      provider: owner.provider,
      serverUrl: owner.serverUrl,
      host: owner.host,
      evenTerminalBootEpoch: owner.evenTerminalBootEpoch,
      handoverGeneration: owner.handoverGeneration + 1,
      relayId: "relay-b",
    });
    expect(nextGenerationOwner.fencingToken).toBe(2);
    expectRelayError(() => registry.ingest(owner, makeEvent(owner, 1)), "GENERATION_MISMATCH");
  });

  it("同じ event id の再送を idempotent に落とす", () => {
    const { registry, owner } = createFixture();
    const event = makeEvent(owner, 1);

    expect(registry.ingest(owner, event)).toEqual({ status: "accepted", evictedEventId: null });
    expect(registry.ingest(owner, event)).toEqual({ status: "duplicate" });
    expect(registry.ingressEvents(owner).map((entry) => entry.eventId)).toEqual(["event-1"]);
  });

  it("bounded queue は最古を落とさず status / error / permission を通常 event より優先する", () => {
    const { registry, owner } = createFixture({ ingressCapacityPerSession: 5 });
    const initialKinds: RelayIngressEvent["kind"][] = [
      "text_delta",
      "status",
      "error",
      "text",
      "text_delta",
    ];
    initialKinds.forEach((kind, index) => {
      expect(registry.ingest(owner, makeEvent(owner, index + 1, kind))).toMatchObject({ status: "accepted" });
    });

    expect(registry.ingest(owner, makeEvent(owner, 6, "text"))).toEqual({
      status: "dropped",
      reason: "queue_full",
    });
    expect(registry.ingest(owner, makeEvent(owner, 7, "permission_request"))).toEqual({
      status: "accepted",
      evictedEventId: "event-5",
    });

    const retained = registry.ingressEvents(owner);
    expect(retained.map((event) => event.eventId)).toEqual([
      "event-1",
      "event-2",
      "event-3",
      "event-4",
      "event-7",
    ]);
    expect(retained.map((event) => event.kind)).toEqual([
      "text_delta",
      "status",
      "error",
      "text",
      "permission_request",
    ]);
  });

  it("generation と fencing token を provider / server をまたいで共有する", () => {
    const { registry, owner, setNow } = createFixture();

    setNow(1_090);
    const nextGenerationOwner = registry.register({
      sessionId: owner.sessionId,
      providerSessionId: "provider-session-b",
      provider: owner.provider,
      serverUrl: owner.serverUrl,
      host: owner.host,
      evenTerminalBootEpoch: owner.evenTerminalBootEpoch,
      handoverGeneration: 8,
      relayId: "relay-b",
    });

    setNow(1_180);
    expectRelayError(
      () => registry.register({
        sessionId: owner.sessionId,
        providerSessionId: "provider-session-c",
        provider: "claude",
        serverUrl: "http://127.0.0.1:3457/",
        host: owner.host,
        evenTerminalBootEpoch: owner.evenTerminalBootEpoch,
        handoverGeneration: 7,
        relayId: "relay-c",
      }),
      "HANDOVER_GENERATION_ROLLBACK",
    );

    expect(registry.register({
      sessionId: nextGenerationOwner.sessionId,
      providerSessionId: "provider-session-c",
      provider: "claude",
      serverUrl: "http://127.0.0.1:3457/",
      host: nextGenerationOwner.host,
      evenTerminalBootEpoch: nextGenerationOwner.evenTerminalBootEpoch,
      handoverGeneration: nextGenerationOwner.handoverGeneration,
      relayId: "relay-c",
    })).toMatchObject({
      provider: "claude",
      serverUrl: "http://127.0.0.1:3457",
      handoverGeneration: 8,
      fencingToken: 3,
    });
  });

  it("dedupe 窓の縮小後もキュー内に残る event id の再送を duplicate にする", () => {
    const { registry, owner } = createFixture({ ingressCapacityPerSession: 2 });

    expect(registry.ingest(owner, makeEvent(owner, 1))).toMatchObject({ status: "accepted" });
    expect(registry.ingest(owner, makeEvent(owner, 2))).toMatchObject({ status: "accepted" });
    expect(registry.ingest(owner, makeEvent(owner, 3))).toMatchObject({ status: "dropped" });
    expect(registry.ingest(owner, makeEvent(owner, 4))).toMatchObject({ status: "dropped" });
    expect(registry.ingest(owner, makeEvent(owner, 5))).toMatchObject({ status: "dropped" });

    expect(registry.ingest(owner, makeEvent(owner, 1))).toEqual({ status: "duplicate" });
    expect(registry.ingressEvents(owner).map((event) => event.eventId)).toEqual(["event-1", "event-2"]);
  });

  it("重要 event の置換後も ingressEvents を sequence 昇順で返す", () => {
    const { registry, owner } = createFixture({ ingressCapacityPerSession: 5 });
    const initialKinds: RelayIngressEvent["kind"][] = [
      "text_delta",
      "status",
      "text",
      "error",
      "permission_request",
    ];
    initialKinds.forEach((kind, index) => {
      expect(registry.ingest(owner, makeEvent(owner, index + 1, kind))).toMatchObject({ status: "accepted" });
    });

    expect(registry.ingest(owner, makeEvent(owner, 6, "status"))).toEqual({
      status: "accepted",
      evictedEventId: "event-3",
    });
    expect(registry.ingressEvents(owner).map((event) => event.sequence)).toEqual([1, 2, 4, 5, 6]);
  });
});

// 以下は §78.10.3 の publishAuthorizedRegistration / retireAuthorizedRegistration を対象とする。
// Registry の public API だけを黒箱で駆動する。DB/receipt/D1/production hostは対象外であり、
// ここでの検証は Registry 単体の契約に閉じる（DB rollback そのものの検証ではない）。
describe("RelayRegistry authority port (publish/retire)", () => {
  function createAuthorityRegistry(now: { value: number }): RelayRegistry {
    return new RelayRegistry({
      host: "host-a",
      evenTerminalBootEpoch: "boot-a",
      now: () => now.value,
    });
  }

  function baseInput(overrides: Partial<RelayOwnerFence> = {}): RelayOwnerFence {
    return {
      sessionId: "session-a",
      providerSessionId: "provider-session-a",
      provider: "codex",
      serverUrl: "http://127.0.0.1:3456",
      host: "host-a",
      evenTerminalBootEpoch: "boot-a",
      handoverGeneration: 7,
      relayId: "relay-a",
      fencingToken: 42,
      ...overrides,
    };
  }

  it("DB確定 token をそのまま採用し、既存の heartbeat/active/read/ingest/ack を通す", () => {
    const now = { value: 1_000 };
    const registry = createAuthorityRegistry(now);

    const published = registry.publishAuthorizedRegistration(baseInput());
    expect(published).toMatchObject({ fencingToken: 42, leaseExpiresAt: 1_090 });
    expect(registry.activeRegistration(published)).toMatchObject({ fencingToken: 42 });

    now.value = 1_050;
    expect(registry.heartbeat(published).leaseExpiresAt).toBe(1_140);

    expect(registry.ingest(published, makeEvent(published, 1))).toMatchObject({ status: "accepted" });
    expect(registry.ingressEvents(published).map((event) => event.eventId)).toEqual(["event-1"]);
    expect(registry.acknowledge(published, "event-1")).toMatchObject({ eventId: "event-1" });
    expect(registry.ingressEvents(published)).toEqual([]);
  });

  it("生存中 lease の active registration への publish 拒否は ingress/active/heartbeat を一切破壊しない", () => {
    const now = { value: 1_000 };
    const registry = createAuthorityRegistry(now);
    const published = registry.publishAuthorizedRegistration(baseInput());
    expect(registry.ingest(published, makeEvent(published, 1))).toMatchObject({ status: "accepted" });

    expectRelayError(
      () => registry.publishAuthorizedRegistration(baseInput({ fencingToken: 50 })),
      "ACTIVE_OWNER_CONFLICT",
    );

    // 拒否後も現 owner の read/ingress/heartbeat が無傷であることを直接観測する。
    expect(registry.activeRegistration(published)).toMatchObject({ fencingToken: 42 });
    expect(registry.ingressEvents(published).map((event) => event.eventId)).toEqual(["event-1"]);
    expect(registry.heartbeat(published)).toMatchObject({ fencingToken: 42 });
  });

  it("active registration が lease 失効後も残る間は publish を conflict で拒否し、Map/HWM を変えない", () => {
    const now = { value: 1_000 };
    const registry = createAuthorityRegistry(now);
    const published = registry.publishAuthorizedRegistration(baseInput());

    now.value = 1_200; // lease (90s) を越えて失効させるが retire はまだ呼ばない
    expect(registry.activeRegistration(published)).toBeNull();

    expectRelayError(
      () => registry.publishAuthorizedRegistration(baseInput({ fencingToken: 50 })),
      "ACTIVE_OWNER_CONFLICT",
    );

    // 拒否が HWM を書き換えていれば次の正規 retire→publish(43) が壊れるはずなので、
    // 成功することで局所状態が不変だったことを確認する。
    registry.retireAuthorizedRegistration(published);
    const republished = registry.publishAuthorizedRegistration(baseInput({ fencingToken: 43 }));
    expect(republished.fencingToken).toBe(43);
  });

  it("exact retire は lease 失効後も成功し local HWM を維持し、再 publish 後の ingress は新規状態で機能する", () => {
    const now = { value: 1_000 };
    const registry = createAuthorityRegistry(now);
    const published = registry.publishAuthorizedRegistration(baseInput());
    expect(registry.ingest(published, makeEvent(published, 1))).toMatchObject({ status: "accepted" });

    now.value = 1_200; // lease 失効後
    registry.retireAuthorizedRegistration(published);

    expectRelayError(() => registry.ingressEvents(published), "OWNER_NOT_FOUND");
    expectRelayError(() => registry.retireAuthorizedRegistration(published), "OWNER_NOT_FOUND");

    const next = registry.publishAuthorizedRegistration(baseInput({ fencingToken: 43 }));
    expect(next.fencingToken).toBe(43);

    // 同じ eventId/sequence を再 ingest しても duplicate ではなく accepted になることで、
    // 新しい registration の ingress state が旧 dedupe/sequence を引きずっていないことを確認する。
    // installRegistration は publish のたびに ingressBySession を無条件で上書きするため、
    // この挙動は「retire が ingressBySession を直接削除したこと」自体を公開 API から
    // 単独で切り分ける証拠にはならない（削除しなくても republish 側の上書きで同じ結果になる）。
    // ここでは republish 後の ingress が正しく機能する新規状態であることまでを検証範囲とする。
    expect(registry.ingest(next, makeEvent(next, 1))).toEqual({ status: "accepted", evictedEventId: null });
    expect(registry.ingressEvents(next).map((event) => event.eventId)).toEqual(["event-1"]);

    expectRelayError(
      () => registry.publishAuthorizedRegistration(baseInput({ fencingToken: 42, handoverGeneration: 8 })),
      "FENCING_TOKEN_MISMATCH",
    );
  });

  it("retire は lastFencingTokens を消さず、同一 token の再利用を republish なしでも拒否する", () => {
    const now = { value: 1_000 };
    const registry = createAuthorityRegistry(now);
    registry.publishAuthorizedRegistration(baseInput({ fencingToken: 42 }));

    const published = registry.activeRegistration(baseInput({ fencingToken: 42 }));
    expect(published).not.toBeNull();
    registry.retireAuthorizedRegistration(baseInput({ fencingToken: 42 }));

    // retire が lastFencingTokens を落としていれば token42 の再利用が通ってしまう。
    // HWM が保持されていることを、republish を挟まずこの一回の呼び出しだけで確認する。
    expectRelayError(
      () => registry.publishAuthorizedRegistration(baseInput({ fencingToken: 42 })),
      "FENCING_TOKEN_MISMATCH",
    );
  });

  it("publishAuthorizedRegistration と register() は同一 session の HWM/generation を共有する", () => {
    const now = { value: 1_000 };
    const registry = createAuthorityRegistry(now);

    // publish → retire → register の順で、install helper 共有により HWM が引き継がれることを確認する。
    registry.publishAuthorizedRegistration(baseInput({ fencingToken: 42, handoverGeneration: 7 }));
    registry.retireAuthorizedRegistration(baseInput({ fencingToken: 42, handoverGeneration: 7 }));
    const registered = registry.register({
      sessionId: "session-a",
      providerSessionId: "provider-session-a",
      provider: "codex",
      serverUrl: "http://127.0.0.1:3456",
      host: "host-a",
      evenTerminalBootEpoch: "boot-a",
      handoverGeneration: 7,
      relayId: "relay-a",
    });
    expect(registered.fencingToken).toBe(43);

    // register → retire → publish の逆方向でも HWM/generation を共有し、
    // register() が返した owner をそのまま authority port へ渡せることを確認する。
    registry.retireAuthorizedRegistration(registered);
    expectRelayError(
      () => registry.publishAuthorizedRegistration(baseInput({ fencingToken: 1 })),
      "FENCING_TOKEN_MISMATCH",
    );
    const republished = registry.publishAuthorizedRegistration(baseInput({ fencingToken: 44 }));
    expect(republished.fencingToken).toBe(44);
  });

  it("local max 未満の handoverGeneration を rollback として拒否する", () => {
    const now = { value: 1_000 };
    const registry = createAuthorityRegistry(now);
    const published = registry.publishAuthorizedRegistration(baseInput({ handoverGeneration: 8 }));
    registry.retireAuthorizedRegistration(published);

    expectRelayError(
      () => registry.publishAuthorizedRegistration(baseInput({ fencingToken: 43, handoverGeneration: 7 })),
      "HANDOVER_GENERATION_ROLLBACK",
    );

    const next = registry.publishAuthorizedRegistration(baseInput({ fencingToken: 43, handoverGeneration: 8 }));
    expect(next).toMatchObject({ fencingToken: 43, handoverGeneration: 8 });
  });

  it("provider / server が変わっても同一 session の HWM を共有する", () => {
    const now = { value: 1_000 };
    const registry = createAuthorityRegistry(now);
    const published = registry.publishAuthorizedRegistration(baseInput());
    registry.retireAuthorizedRegistration(published);

    const next = registry.publishAuthorizedRegistration(
      baseInput({
        fencingToken: 43,
        provider: "claude",
        serverUrl: "http://127.0.0.1:3457",
        providerSessionId: "provider-session-claude",
        relayId: "relay-claude",
      }),
    );
    expect(next).toMatchObject({ fencingToken: 43, provider: "claude", serverUrl: "http://127.0.0.1:3457" });

    expectRelayError(
      () => registry.publishAuthorizedRegistration(
        baseInput({ fencingToken: 44, provider: "claude", serverUrl: "http://127.0.0.1:3457" }),
      ),
      "ACTIVE_OWNER_CONFLICT",
    );
  });

  it("別 session は独立して token/generation を発行できる", () => {
    const now = { value: 1_000 };
    const registry = createAuthorityRegistry(now);
    registry.publishAuthorizedRegistration(baseInput({ fencingToken: 100, handoverGeneration: 20 }));

    const other = registry.publishAuthorizedRegistration(
      baseInput({
        sessionId: "session-b",
        providerSessionId: "provider-session-b",
        relayId: "relay-b",
        fencingToken: 1,
        handoverGeneration: 1,
      }),
    );
    expect(other).toMatchObject({ sessionId: "session-b", fencingToken: 1, handoverGeneration: 1 });
    expect(registry.activeRegistration(baseInput({ fencingToken: 100, handoverGeneration: 20 }))).toMatchObject({
      fencingToken: 100,
    });
  });

  it("retire は別 session を消さない", () => {
    const now = { value: 1_000 };
    const registry = createAuthorityRegistry(now);
    const ownerA = registry.publishAuthorizedRegistration(baseInput({ fencingToken: 100, handoverGeneration: 20 }));
    expect(registry.ingest(ownerA, makeEvent(ownerA, 1))).toMatchObject({ status: "accepted" });

    const ownerB = registry.publishAuthorizedRegistration(
      baseInput({
        sessionId: "session-b",
        providerSessionId: "provider-session-b",
        relayId: "relay-b",
        fencingToken: 1,
        handoverGeneration: 1,
      }),
    );

    registry.retireAuthorizedRegistration(ownerB);

    // session-b の retire が session-a の registration/ingress/heartbeat に影響しないことを確認する。
    expect(registry.activeRegistration(ownerA)).toMatchObject({ fencingToken: 100 });
    expect(registry.ingressEvents(ownerA).map((event) => event.eventId)).toEqual(["event-1"]);
    expect(registry.heartbeat(ownerA)).toMatchObject({ fencingToken: 100 });
    expectRelayError(() => registry.ingressEvents(ownerB), "OWNER_NOT_FOUND");
  });

  it("retire は identity/fence/epoch/host 不一致を拒否して現 owner を保持し、二度目は OWNER_NOT_FOUND", () => {
    const now = { value: 1_000 };
    const registry = createAuthorityRegistry(now);
    const published = registry.publishAuthorizedRegistration(baseInput());

    expectRelayError(
      () => registry.retireAuthorizedRegistration({ ...published, providerSessionId: "provider-session-x" }),
      "OWNER_MISMATCH",
    );
    expectRelayError(
      () => registry.retireAuthorizedRegistration({ ...published, relayId: "relay-x" }),
      "OWNER_MISMATCH",
    );
    expectRelayError(
      () => registry.retireAuthorizedRegistration({ ...published, fencingToken: 999 }),
      "FENCING_TOKEN_MISMATCH",
    );
    expectRelayError(
      () => registry.retireAuthorizedRegistration({ ...published, handoverGeneration: 8 }),
      "GENERATION_MISMATCH",
    );
    expectRelayError(
      () => registry.retireAuthorizedRegistration({ ...published, evenTerminalBootEpoch: "boot-old" }),
      "BOOT_EPOCH_MISMATCH",
    );
    expectRelayError(
      () => registry.retireAuthorizedRegistration({ ...published, host: "host-b" }),
      "HOST_MISMATCH",
    );

    // 全ての拒否後も現 owner はそのまま残っている。
    expect(registry.activeRegistration(published)).toMatchObject({ fencingToken: 42 });

    registry.retireAuthorizedRegistration(published);
    expectRelayError(() => registry.retireAuthorizedRegistration(published), "OWNER_NOT_FOUND");
  });
});
