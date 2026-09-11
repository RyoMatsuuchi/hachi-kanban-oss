import { describe, expect, it } from "vitest";

import {
  RELAY_DELIVERY_UNCERTAIN_EVENTS_DEFAULT_LIMIT,
  RELAY_DELIVERY_UNCERTAIN_EVENTS_MAX_LIMIT,
  mapRelayDeliveryUncertainEventRow,
  parseRelaySessionOwnershipRow,
  requireRelayDeliveryUncertainEventsLimit,
  validateRelayDeliveryUncertainRecordInput,
  type RawRelayDeliveryUncertainEventRow,
  type RawTaskRunOwnershipRow,
  type RelayDeliveryUncertainRecordInput,
} from "./relay-control-persistence.js";

function validInput(overrides: Partial<RelayDeliveryUncertainRecordInput> = {}): RelayDeliveryUncertainRecordInput {
  return {
    sessionId: "session-a",
    handoverGeneration: 7,
    relayId: "relay-a",
    fencingToken: 3,
    eventId: "event-a",
    observedAt: 1_700_000_000,
    reason: "sending_remnant",
    provider: "codex",
    host: "host-a",
    evenTerminalBootEpoch: "boot-a",
    canonicalServerUrl: "http://127.0.0.1:3456",
    ...overrides,
  };
}

describe("validateRelayDeliveryUncertainRecordInput", () => {
  it("valid な入力はそのまま返す", () => {
    const input = validInput();
    expect(validateRelayDeliveryUncertainRecordInput(input)).toEqual(input);
  });

  it.each([
    ["sessionId 空", { sessionId: "" }],
    ["sessionId 前後空白", { sessionId: " session-a " }],
    ["handoverGeneration 0", { handoverGeneration: 0 }],
    ["handoverGeneration 非整数", { handoverGeneration: 1.5 }],
    ["relayId 空", { relayId: "" }],
    ["fencingToken 0", { fencingToken: 0 }],
    ["fencingToken 負", { fencingToken: -1 }],
    ["eventId 空", { eventId: "" }],
    ["observedAt 負", { observedAt: -1 }],
    ["observedAt 非整数", { observedAt: 1.5 }],
    ["reason 未知", { reason: "other" as never }],
    ["provider 未知", { provider: "gpt" as never }],
    ["host 空", { host: "" }],
    ["evenTerminalBootEpoch 空", { evenTerminalBootEpoch: "" }],
    ["canonicalServerUrl 非canonical", { canonicalServerUrl: "http://127.0.0.1:3456/" }],
    ["canonicalServerUrl 不正URL", { canonicalServerUrl: "not-a-url" }],
  ])("%s は throw する", (_label, overrides) => {
    expect(() => validateRelayDeliveryUncertainRecordInput(validInput(overrides))).toThrow();
  });
});

describe("requireRelayDeliveryUncertainEventsLimit", () => {
  it("未指定は既定値を返す", () => {
    expect(requireRelayDeliveryUncertainEventsLimit(undefined)).toBe(RELAY_DELIVERY_UNCERTAIN_EVENTS_DEFAULT_LIMIT);
  });

  it("1 と上限値は受理する", () => {
    expect(requireRelayDeliveryUncertainEventsLimit(1)).toBe(1);
    expect(requireRelayDeliveryUncertainEventsLimit(RELAY_DELIVERY_UNCERTAIN_EVENTS_MAX_LIMIT)).toBe(
      RELAY_DELIVERY_UNCERTAIN_EVENTS_MAX_LIMIT,
    );
  });

  it.each([0, -1, 1.5, RELAY_DELIVERY_UNCERTAIN_EVENTS_MAX_LIMIT + 1])("%s は throw する", (limit) => {
    expect(() => requireRelayDeliveryUncertainEventsLimit(limit)).toThrow();
  });
});

function validRow(overrides: Partial<RawRelayDeliveryUncertainEventRow> = {}): RawRelayDeliveryUncertainEventRow {
  return {
    session_id: "session-a",
    event_id: "event-a",
    handover_generation: 7,
    relay_id: "relay-a",
    fencing_token: 3,
    reason: "sending_remnant",
    observed_at: 1_700_000_000,
    provider: "codex",
    host: "host-a",
    even_terminal_boot_epoch: "boot-a",
    canonical_server_url: "http://127.0.0.1:3456",
    recorded_at: 1_700_000_050,
    ...overrides,
  };
}

describe("mapRelayDeliveryUncertainEventRow", () => {
  it("valid な行を record へ変換する", () => {
    const row = validRow();
    expect(mapRelayDeliveryUncertainEventRow(row)).toEqual({
      sessionId: "session-a",
      handoverGeneration: 7,
      relayId: "relay-a",
      fencingToken: 3,
      eventId: "event-a",
      observedAt: 1_700_000_000,
      reason: "sending_remnant",
      provider: "codex",
      host: "host-a",
      evenTerminalBootEpoch: "boot-a",
      canonicalServerUrl: "http://127.0.0.1:3456",
      recordedAt: 1_700_000_050,
    });
  });

  it.each([
    ["recorded_at 負", { recorded_at: -1 }],
    ["reason 未知", { reason: "other" }],
    ["provider 未知", { provider: "gpt" }],
    ["session_id 空", { session_id: "" }],
    ["canonical_server_url 非canonical", { canonical_server_url: "http://127.0.0.1:3456/" }],
  ])("%s は隠さず throw する", (_label, overrides) => {
    expect(() => mapRelayDeliveryUncertainEventRow(validRow(overrides))).toThrow();
  });
});

describe("parseRelaySessionOwnershipRow", () => {
  function bridgeRow(overrides: Partial<RawTaskRunOwnershipRow> = {}): RawTaskRunOwnershipRow {
    return {
      provider: "codex",
      meta: JSON.stringify({ transport: "bridge", serverUrl: "http://127.0.0.1:3456", model: "gpt-5.4" }),
      ...overrides,
    };
  }

  it("valid な bridge 行を投影する", () => {
    expect(parseRelaySessionOwnershipRow(bridgeRow())).toEqual({
      provider: "codex",
      transport: "bridge",
      serverUrl: "http://127.0.0.1:3456",
    });
  });

  it("valid な direct 行を投影する（sentinel serverUrl）", () => {
    const row = bridgeRow({ meta: JSON.stringify({ transport: "direct", serverUrl: "direct" }) });
    expect(parseRelaySessionOwnershipRow(row)).toEqual({
      provider: "codex",
      transport: "direct",
      serverUrl: "direct",
    });
  });

  it("未知の meta field は許容する", () => {
    const row = bridgeRow({
      meta: JSON.stringify({ transport: "bridge", serverUrl: "http://127.0.0.1:3456", unknownField: 123 }),
    });
    expect(parseRelaySessionOwnershipRow(row)).toEqual({
      provider: "codex",
      transport: "bridge",
      serverUrl: "http://127.0.0.1:3456",
    });
  });

  it("provider が未知なら throw する", () => {
    expect(() => parseRelaySessionOwnershipRow(bridgeRow({ provider: "gpt" }))).toThrow();
  });

  it("meta が JSON として不正なら throw する", () => {
    expect(() => parseRelaySessionOwnershipRow(bridgeRow({ meta: "not json" }))).toThrow();
  });

  it("meta が object でないなら throw する", () => {
    expect(() => parseRelaySessionOwnershipRow(bridgeRow({ meta: JSON.stringify([1, 2]) }))).toThrow();
  });

  it("bridge の serverUrl が canonical 化できないなら throw する", () => {
    const row = bridgeRow({ meta: JSON.stringify({ transport: "bridge", serverUrl: "not-a-url" }) });
    expect(() => parseRelaySessionOwnershipRow(row)).toThrow();
  });

  it("direct の serverUrl が sentinel でないなら throw する", () => {
    const row = bridgeRow({ meta: JSON.stringify({ transport: "direct", serverUrl: "http://127.0.0.1:3456" }) });
    expect(() => parseRelaySessionOwnershipRow(row)).toThrow();
  });

  it("未知の transport なら throw する", () => {
    const row = bridgeRow({ meta: JSON.stringify({ transport: "carrier-pigeon", serverUrl: "direct" }) });
    expect(() => parseRelaySessionOwnershipRow(row)).toThrow();
  });

  it("transport 欠落なら throw する", () => {
    const row = bridgeRow({ meta: JSON.stringify({ serverUrl: "http://127.0.0.1:3456" }) });
    expect(() => parseRelaySessionOwnershipRow(row)).toThrow();
  });
});
