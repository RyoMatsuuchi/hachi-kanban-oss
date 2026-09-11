// G2 relay の不確定配送 永続記録と session ownership projection（docs/contract.md §78.5.1 / §78.8）。
// task_runs の生 schema や owner/fence/ownership 判定を D1・adapter 側で再実装しないため、
// 検証済み wire 値の保存・投影だけをこのモジュールへ閉じ込める。

import { canonicalizeRelayServerUrl, type RelayProvider } from "./relay-registry.js";
import type { RelaySessionOwnership } from "./relay-authorization.js";

/** 契約 §78.5 で許可される不確定配送の理由。増やすときは契約を改訂する。 */
export const RELAY_DELIVERY_UNCERTAIN_REASONS = ["sending_remnant"] as const;
export type RelayDeliveryUncertainReason = (typeof RELAY_DELIVERY_UNCERTAIN_REASONS)[number];

export const RELAY_DELIVERY_UNCERTAIN_EVENTS_DEFAULT_LIMIT = 100;
export const RELAY_DELIVERY_UNCERTAIN_EVENTS_MAX_LIMIT = 1000;

/**
 * current fence 認可済み D1 closure から渡される、host 固定値込みの記録入力。
 * host/evenTerminalBootEpoch/canonicalServerUrl は wire から信じず host 側 config から注入する。
 */
export interface RelayDeliveryUncertainRecordInput {
  readonly sessionId: string;
  readonly handoverGeneration: number;
  readonly relayId: string;
  readonly fencingToken: number;
  readonly eventId: string;
  readonly observedAt: number;
  readonly reason: RelayDeliveryUncertainReason;
  readonly provider: RelayProvider;
  readonly host: string;
  readonly evenTerminalBootEpoch: string;
  readonly canonicalServerUrl: string;
}

/** 永続化された不確定配送の1行。初回 authorized report の全値 + DB 受領時刻（recordedAt）。 */
export interface RelayDeliveryUncertainRecord extends RelayDeliveryUncertainRecordInput {
  readonly recordedAt: number;
}

export interface RecordRelayDeliveryUncertainResult {
  readonly recorded: true;
  readonly duplicate: boolean;
}

/**
 * §78.5.1 の永続 write port。current fence 認可済み D1 closure からだけ呼ぶ private port であり、
 * owner/fence/ownership の再判定はここでは行わない（呼び出し側が認可済みの値だけを渡す）。
 */
export interface RelayControlPersistence {
  recordRelayDeliveryUncertain(input: RelayDeliveryUncertainRecordInput): RecordRelayDeliveryUncertainResult;
  /** §78.8 の ownership projection。task_runs.session_id の BINARY 完全一致行を id ASC で全件返す。 */
  lookupRelaySessionOwnership(sessionId: string): readonly RelaySessionOwnership[];
}

export interface RelayDeliveryUncertainEventsQuery {
  readonly sessionId?: string;
  readonly limit?: number;
}

/** §78.5.1 の運用者向け read-only 面。 */
export interface RelayDeliveryUncertainReadView {
  relayDeliveryUncertainEvent(sessionId: string, eventId: string): RelayDeliveryUncertainRecord | null;
  relayDeliveryUncertainEvents(query?: RelayDeliveryUncertainEventsQuery): RelayDeliveryUncertainRecord[];
}

function isNonEmptyIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && !value.includes("\0");
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRelayProvider(value: unknown): value is RelayProvider {
  return value === "codex" || value === "claude";
}

/** wire 値 + host 固定値を検証する。1つでも不正なら throw する（fail-closed）。 */
export function validateRelayDeliveryUncertainRecordInput(
  input: RelayDeliveryUncertainRecordInput,
): RelayDeliveryUncertainRecordInput {
  if (
    !isNonEmptyIdentity(input.sessionId) ||
    !isPositiveSafeInteger(input.handoverGeneration) ||
    !isNonEmptyIdentity(input.relayId) ||
    !isPositiveSafeInteger(input.fencingToken) ||
    !isNonEmptyIdentity(input.eventId) ||
    !isNonNegativeSafeInteger(input.observedAt) ||
    !(RELAY_DELIVERY_UNCERTAIN_REASONS as readonly string[]).includes(input.reason) ||
    !isRelayProvider(input.provider) ||
    !isNonEmptyIdentity(input.host) ||
    !isNonEmptyIdentity(input.evenTerminalBootEpoch) ||
    canonicalizeRelayServerUrl(input.canonicalServerUrl) !== input.canonicalServerUrl
  ) {
    throw new Error("relay delivery uncertain の記録入力が不正です");
  }
  return input;
}

export function requireRelayDeliveryUncertainEventsLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return RELAY_DELIVERY_UNCERTAIN_EVENTS_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > RELAY_DELIVERY_UNCERTAIN_EVENTS_MAX_LIMIT) {
    throw new Error(`limit は 1〜${RELAY_DELIVERY_UNCERTAIN_EVENTS_MAX_LIMIT} の整数が必須です`);
  }
  return limit;
}

/** relay_delivery_uncertain_events の生行（snake_case）。 */
export interface RawRelayDeliveryUncertainEventRow {
  readonly session_id: string;
  readonly event_id: string;
  readonly handover_generation: number;
  readonly relay_id: string;
  readonly fencing_token: number;
  readonly reason: string;
  readonly observed_at: number;
  readonly provider: string;
  readonly host: string;
  readonly even_terminal_boot_epoch: string;
  readonly canonical_server_url: string;
  readonly recorded_at: number;
}

/** DB row → record。malformed 行は隠さず throw する（契約 §78.5.1）。 */
export function mapRelayDeliveryUncertainEventRow(
  row: RawRelayDeliveryUncertainEventRow,
): RelayDeliveryUncertainRecord {
  if (!isNonNegativeSafeInteger(row.recorded_at)) {
    throw new Error("relay delivery uncertain event の recordedAt が不正です");
  }
  const input: RelayDeliveryUncertainRecordInput = {
    sessionId: row.session_id,
    handoverGeneration: row.handover_generation,
    relayId: row.relay_id,
    fencingToken: row.fencing_token,
    eventId: row.event_id,
    observedAt: row.observed_at,
    reason: row.reason as RelayDeliveryUncertainReason,
    provider: row.provider as RelayProvider,
    host: row.host,
    evenTerminalBootEpoch: row.even_terminal_boot_epoch,
    canonicalServerUrl: row.canonical_server_url,
  };
  validateRelayDeliveryUncertainRecordInput(input);
  return { ...input, recordedAt: row.recorded_at };
}

/** task_runs の provider/meta 生行（ownership projection の入力）。 */
export interface RawTaskRunOwnershipRow {
  readonly provider: string;
  readonly meta: string;
}

/**
 * task_runs の1行を RelaySessionOwnership へ投影する（契約 §78.8）。
 * transport ごとに規則が異なる: bridge は canonicalizeRelayServerUrl で canonical 化できる HTTP(S)、
 * direct は既存 writer の sentinel `serverUrl === "direct"` だけを受理する。未知 meta field は許容するが、
 * 必要 field の欠落・型不正・不正 URL/sentinel・未知 transport は1行でも lookup 全体を throw させる。
 */
export function parseRelaySessionOwnershipRow(row: RawTaskRunOwnershipRow): RelaySessionOwnership {
  if (!isRelayProvider(row.provider)) {
    throw new Error("relay session ownership の provider が不正です");
  }
  let meta: unknown;
  try {
    meta = JSON.parse(row.meta);
  } catch {
    throw new Error("relay session ownership の meta が JSON として不正です");
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new Error("relay session ownership の meta は object が必須です");
  }
  const record = meta as Record<string, unknown>;
  const transport = record["transport"];
  if (transport === "bridge") {
    const canonicalServerUrl = canonicalizeRelayServerUrl(record["serverUrl"]);
    if (canonicalServerUrl === null) {
      throw new Error("relay session ownership の bridge serverUrl が不正です");
    }
    return { provider: row.provider, transport: "bridge", serverUrl: canonicalServerUrl };
  }
  if (transport === "direct") {
    if (record["serverUrl"] !== "direct") {
      throw new Error("relay session ownership の direct serverUrl は sentinel が必須です");
    }
    return { provider: row.provider, transport: "direct", serverUrl: "direct" };
  }
  throw new Error("relay session ownership の transport が未知です");
}
