// G2 relay の process-local registry / fencing / bounded ingress core。
// even-terminal や hook transport には依存せず、全 mutation を current boot epoch と owner fence へ束縛する。

export const DEFAULT_RELAY_LEASE_TTL_SECONDS = 90;
export const DEFAULT_RELAY_HEARTBEAT_INTERVAL_SECONDS = 30;
export const DEFAULT_RELAY_INGRESS_CAPACITY_PER_SESSION = 500;

export const RELAY_PROVIDERS = ["codex", "claude"] as const;

export type RelayProvider = (typeof RELAY_PROVIDERS)[number];

export const RELAY_INGRESS_EVENT_KINDS = [
  "text_delta",
  "text",
  "result",
  "tool_start",
  "tool_end",
  "permission_request",
  "status",
  "error",
] as const;

export type RelayIngressEventKind = (typeof RELAY_INGRESS_EVENT_KINDS)[number];
export type RelayJsonValue = null | boolean | number | string | RelayJsonValue[] | { [key: string]: RelayJsonValue };

export interface RelayRegistryOptions {
  host: string;
  evenTerminalBootEpoch: string;
  leaseTtlSeconds?: number;
  heartbeatIntervalSeconds?: number;
  ingressCapacityPerSession?: number;
  now?: () => number;
}

export interface RegisterRelayInput {
  sessionId: string;
  providerSessionId: string;
  provider: RelayProvider;
  serverUrl: string;
  host: string;
  evenTerminalBootEpoch: string;
  handoverGeneration: number;
  relayId: string;
}

export interface RelayOwnerFence extends RegisterRelayInput {
  fencingToken: number;
}

export interface RelayRegistration extends RelayOwnerFence {
  leaseExpiresAt: number;
}

/**
 * host内部専用のDB確定authority操作だけをRegistryへ公開するport。
 * raw register()等の互換APIは含めず、DB commit/receipt一致後のhostだけが呼ぶ想定。
 */
export interface RelayRegistryAuthorityPort {
  publishAuthorizedRegistration(input: RelayOwnerFence): RelayRegistration;
  retireAuthorizedRegistration(owner: RelayOwnerFence): void;
}

export interface RelayIngressEvent {
  sessionId: string;
  handoverGeneration: number;
  turnId: string | null;
  toolId: string | null;
  sequence: number;
  eventId: string;
  kind: RelayIngressEventKind;
  payload: RelayJsonValue;
}

export type RelayIngressResult =
  | { status: "accepted"; evictedEventId: string | null }
  | { status: "duplicate" }
  | { status: "dropped"; reason: "queue_full" };

export type RelayRegistryErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_INPUT"
  | "HOST_MISMATCH"
  | "BOOT_EPOCH_MISMATCH"
  | "ACTIVE_OWNER_CONFLICT"
  | "OWNER_NOT_FOUND"
  | "OWNER_MISMATCH"
  | "GENERATION_MISMATCH"
  | "HANDOVER_GENERATION_ROLLBACK"
  | "FENCING_TOKEN_MISMATCH"
  | "LEASE_EXPIRED"
  | "NON_MONOTONIC_SEQUENCE"
  | "EVENT_NOT_FOUND"
  | "FENCING_TOKEN_EXHAUSTED";

export class RelayRegistryError extends Error {
  readonly code: RelayRegistryErrorCode;

  constructor(code: RelayRegistryErrorCode, message: string) {
    super(message);
    this.name = "RelayRegistryError";
    this.code = code;
  }
}

interface IngressState {
  fencingToken: number;
  lastSequence: number;
  events: RelayIngressEvent[];
  recentEventIds: Map<string, number>;
}

const RELAY_INGRESS_EVENT_KIND_SET = new Set<string>(RELAY_INGRESS_EVENT_KINDS);
const RELAY_PROVIDER_SET = new Set<string>(RELAY_PROVIDERS);
const IMPORTANT_EVENT_KINDS = new Set<RelayIngressEventKind>(["status", "error", "permission_request"]);

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0 || value !== value.trim() || value.includes("\0")) {
    throw new RelayRegistryError("INVALID_INPUT", `${field} は前後空白・NULを含まない非空文字列が必須です`);
  }
}

function assertPositiveInteger(value: number, field: string, code: RelayRegistryErrorCode = "INVALID_INPUT"): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RelayRegistryError(code, `${field} は正の安全な整数が必須です`);
  }
}

function assertRelayProvider(value: unknown, field: string): asserts value is RelayProvider {
  if (typeof value !== "string" || !RELAY_PROVIDER_SET.has(value)) {
    throw new RelayRegistryError("INVALID_INPUT", `${field} は codex または claude が必須です`);
  }
}

/** relay registration と認可要求が共有する canonical server identity。 */
export function canonicalizeRelayServerUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\0")) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username !== "" || parsed.password !== "") {
      return null;
    }
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function requireCanonicalServerUrl(value: unknown, field: string): string {
  const canonicalServerUrl = canonicalizeRelayServerUrl(value);
  if (canonicalServerUrl === null) {
    throw new RelayRegistryError("INVALID_INPUT", `${field} は canonical 化可能な HTTP(S) URL が必須です`);
  }
  return canonicalServerUrl;
}

function cloneJsonValue(value: RelayJsonValue, ancestors: Set<object> = new Set<object>()): RelayJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RelayRegistryError("INVALID_INPUT", "payload の数値は有限値が必須です");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new RelayRegistryError("INVALID_INPUT", "payload は JSON value が必須です");
  }
  if (ancestors.has(value)) {
    throw new RelayRegistryError("INVALID_INPUT", "payload に循環参照は指定できません");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => cloneJsonValue(entry, ancestors));
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new RelayRegistryError("INVALID_INPUT", "payload の object は plain object が必須です");
    }
    const clone: { [key: string]: RelayJsonValue } = {};
    for (const [key, entry] of Object.entries(value)) {
      clone[key] = cloneJsonValue(entry, ancestors);
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function cloneEvent(event: RelayIngressEvent): RelayIngressEvent {
  return {
    sessionId: event.sessionId,
    handoverGeneration: event.handoverGeneration,
    turnId: event.turnId,
    toolId: event.toolId,
    sequence: event.sequence,
    eventId: event.eventId,
    kind: event.kind,
    payload: cloneJsonValue(event.payload),
  };
}

function registrationKey(
  sessionId: string,
  provider: RelayProvider,
  serverUrl: string,
  host: string,
  handoverGeneration: number,
): string {
  return JSON.stringify([sessionId, provider, serverUrl, host, handoverGeneration]);
}

function sessionKey(sessionId: string): string {
  return sessionId;
}

/**
 * relay daemon が所有する process-local state。
 * 永続 snapshot の暗黙復元経路を持たず、current boot epoch と異なる登録・mutation は常に拒否する。
 */
export class RelayRegistry implements RelayRegistryAuthorityPort {
  readonly host: string;
  readonly evenTerminalBootEpoch: string;
  readonly leaseTtlSeconds: number;
  readonly heartbeatIntervalSeconds: number;
  readonly ingressCapacityPerSession: number;

  private readonly now: () => number;
  private readonly registrations = new Map<string, RelayRegistration>();
  private readonly activeRegistrationKeys = new Map<string, string>();
  private readonly lastFencingTokens = new Map<string, number>();
  private readonly maxHandoverGenerations = new Map<string, number>();
  private readonly ingressBySession = new Map<string, IngressState>();

  constructor(options: RelayRegistryOptions) {
    assertNonEmpty(options.host, "host");
    assertNonEmpty(options.evenTerminalBootEpoch, "evenTerminalBootEpoch");
    const leaseTtlSeconds = options.leaseTtlSeconds ?? DEFAULT_RELAY_LEASE_TTL_SECONDS;
    const heartbeatIntervalSeconds =
      options.heartbeatIntervalSeconds ?? DEFAULT_RELAY_HEARTBEAT_INTERVAL_SECONDS;
    const ingressCapacityPerSession =
      options.ingressCapacityPerSession ?? DEFAULT_RELAY_INGRESS_CAPACITY_PER_SESSION;
    assertPositiveInteger(leaseTtlSeconds, "leaseTtlSeconds", "INVALID_CONFIGURATION");
    assertPositiveInteger(heartbeatIntervalSeconds, "heartbeatIntervalSeconds", "INVALID_CONFIGURATION");
    assertPositiveInteger(ingressCapacityPerSession, "ingressCapacityPerSession", "INVALID_CONFIGURATION");
    if (heartbeatIntervalSeconds >= leaseTtlSeconds) {
      throw new RelayRegistryError(
        "INVALID_CONFIGURATION",
        "heartbeatIntervalSeconds は leaseTtlSeconds より小さい値が必須です",
      );
    }

    this.host = options.host;
    this.evenTerminalBootEpoch = options.evenTerminalBootEpoch;
    this.leaseTtlSeconds = leaseTtlSeconds;
    this.heartbeatIntervalSeconds = heartbeatIntervalSeconds;
    this.ingressCapacityPerSession = ingressCapacityPerSession;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  register(input: RegisterRelayInput): RelayRegistration {
    const normalizedInput = this.normalizeRegistrationInput(input);
    const now = this.currentTime();
    const scopeKey = sessionKey(normalizedInput.sessionId);
    const activeKey = this.activeRegistrationKeys.get(scopeKey);
    const current = activeKey === undefined ? undefined : this.registrations.get(activeKey);
    if (current !== undefined && current.leaseExpiresAt > now) {
      throw new RelayRegistryError("ACTIVE_OWNER_CONFLICT", "同一 session に生存中の owner が存在します");
    }
    const maxHandoverGeneration = this.maxHandoverGenerations.get(scopeKey);
    if (maxHandoverGeneration !== undefined && normalizedInput.handoverGeneration < maxHandoverGeneration) {
      throw new RelayRegistryError(
        "HANDOVER_GENERATION_ROLLBACK",
        "観測済みの最大 handover generation より古い登録は受理できません",
      );
    }

    const previousFencingToken = this.lastFencingTokens.get(scopeKey) ?? 0;
    if (previousFencingToken >= Number.MAX_SAFE_INTEGER) {
      throw new RelayRegistryError("FENCING_TOKEN_EXHAUSTED", "fencing token を安全に発行できません");
    }
    const fencingToken = previousFencingToken + 1;
    const leaseExpiresAt = this.leaseDeadline(now);
    return this.installRegistration(normalizedInput, fencingToken, leaseExpiresAt, activeKey);
  }

  /**
   * DB commit/receipt一致後のhostだけが呼ぶ想定のauthority port実装。
   * DB確定 input.fencingToken をそのまま採用し、Registry側で再採番しない。
   * local に active な key/registration が残っている間（lease失効済みでも）は
   * ACTIVE_OWNER_CONFLICT とし、host は先に retireAuthorizedRegistration で
   * exact owner を retire してから publish を呼ぶ。
   */
  publishAuthorizedRegistration(input: RelayOwnerFence): RelayRegistration {
    const normalizedInput = this.normalizeRegistrationInput(input);
    assertPositiveInteger(input.fencingToken, "fencingToken");
    const now = this.currentTime();
    const scopeKey = sessionKey(normalizedInput.sessionId);

    const previousFencingToken = this.lastFencingTokens.get(scopeKey);
    if (previousFencingToken !== undefined && input.fencingToken <= previousFencingToken) {
      throw new RelayRegistryError(
        "FENCING_TOKEN_MISMATCH",
        "DB確定 fencing token が local の既知値以下です",
      );
    }

    const maxHandoverGeneration = this.maxHandoverGenerations.get(scopeKey);
    if (maxHandoverGeneration !== undefined && normalizedInput.handoverGeneration < maxHandoverGeneration) {
      throw new RelayRegistryError(
        "HANDOVER_GENERATION_ROLLBACK",
        "観測済みの最大 handover generation より古い登録は受理できません",
      );
    }

    if (this.activeRegistrationKeys.get(scopeKey) !== undefined) {
      throw new RelayRegistryError(
        "ACTIVE_OWNER_CONFLICT",
        "同一 session に active な registration が残存しています",
      );
    }

    const leaseExpiresAt = this.leaseDeadline(now);
    return this.installRegistration(normalizedInput, input.fencingToken, leaseExpiresAt, undefined);
  }

  /**
   * exact identity/fenceが現registrationと一致する場合だけ registration/ingress を消す。
   * lease失効後も呼べる（lease時刻では拒否しない）。local の lastFencingTokens /
   * maxHandoverGenerations は保持し、次の publish/register が正しい HWM を継続する。
   */
  retireAuthorizedRegistration(owner: RelayOwnerFence): void {
    const { scopeKey, activeKey, registration } = this.resolveActiveRegistration(owner);
    if (registration.fencingToken !== owner.fencingToken) {
      throw new RelayRegistryError("FENCING_TOKEN_MISMATCH", "relay owner の fencing token が一致しません");
    }
    if (
      registration.providerSessionId !== owner.providerSessionId ||
      registration.relayId !== owner.relayId
    ) {
      throw new RelayRegistryError("OWNER_MISMATCH", "relay owner identity が一致しません");
    }
    this.registrations.delete(activeKey);
    this.activeRegistrationKeys.delete(scopeKey);
    this.ingressBySession.delete(scopeKey);
  }

  heartbeat(owner: RelayOwnerFence): RelayRegistration {
    const now = this.currentTime();
    const registration = this.requireActiveOwner(owner, now);
    const refreshed: RelayRegistration = { ...registration, leaseExpiresAt: this.leaseDeadline(now) };
    this.registrations.set(registrationKey(
      registration.sessionId,
      registration.provider,
      registration.serverUrl,
      registration.host,
      registration.handoverGeneration,
    ), refreshed);
    return { ...refreshed };
  }

  activeRegistration(
    input: Pick<
      RegisterRelayInput,
      "sessionId" | "provider" | "serverUrl" | "host" | "evenTerminalBootEpoch" | "handoverGeneration"
    >,
  ): RelayRegistration | null {
    assertNonEmpty(input.sessionId, "sessionId");
    assertRelayProvider(input.provider, "provider");
    const serverUrl = requireCanonicalServerUrl(input.serverUrl, "serverUrl");
    assertNonEmpty(input.host, "host");
    assertNonEmpty(input.evenTerminalBootEpoch, "evenTerminalBootEpoch");
    assertPositiveInteger(input.handoverGeneration, "handoverGeneration");
    this.assertRuntimeIdentity(input.host, input.evenTerminalBootEpoch);
    const key = registrationKey(input.sessionId, input.provider, serverUrl, input.host, input.handoverGeneration);
    const scopeKey = sessionKey(input.sessionId);
    if (this.activeRegistrationKeys.get(scopeKey) !== key) return null;
    const registration = this.registrations.get(key);
    if (registration === undefined || registration.leaseExpiresAt <= this.currentTime()) {
      return null;
    }
    return { ...registration };
  }

  /**
   * session に対して最後に追跡している registration を lease 状態にかかわらず返す。
   * 認可判定が未登録と失効済み owner を区別するための read-only snapshot である。
   */
  registrationForSession(
    input: Pick<RegisterRelayInput, "sessionId" | "provider" | "serverUrl" | "host">,
  ): RelayRegistration | null {
    assertNonEmpty(input.sessionId, "sessionId");
    assertRelayProvider(input.provider, "provider");
    requireCanonicalServerUrl(input.serverUrl, "serverUrl");
    assertNonEmpty(input.host, "host");
    if (input.host !== this.host) return null;
    const key = this.activeRegistrationKeys.get(sessionKey(input.sessionId));
    if (key === undefined) return null;
    const registration = this.registrations.get(key);
    return registration === undefined ? null : { ...registration };
  }

  /**
   * canonical session に対して最後に追跡している registration を返す。
   * relay control socket の owner 照合では request に serverUrl が無いため、
   * daemon が caller の自称値で lookup key を組み立てずに済む read-only 面を使う。
   */
  registrationSnapshotForSession(sessionId: string): RelayRegistration | null {
    assertNonEmpty(sessionId, "sessionId");
    const key = this.activeRegistrationKeys.get(sessionKey(sessionId));
    if (key === undefined) return null;
    const registration = this.registrations.get(key);
    return registration === undefined ? null : { ...registration };
  }

  hasRegistrationForSession(sessionId: string): boolean {
    assertNonEmpty(sessionId, "sessionId");
    for (const registration of this.registrations.values()) {
      if (registration.sessionId === sessionId) return true;
    }
    return false;
  }

  ingest(owner: RelayOwnerFence, event: RelayIngressEvent): RelayIngressResult {
    const now = this.currentTime();
    const registration = this.requireActiveOwner(owner, now);
    this.assertIngressEvent(owner, event);
    const key = sessionKey(registration.sessionId);
    const state = this.ingressBySession.get(key);
    if (state === undefined || state.fencingToken !== owner.fencingToken) {
      throw new RelayRegistryError("FENCING_TOKEN_MISMATCH", "ingress state の fencing token が一致しません");
    }

    if (state.recentEventIds.has(event.eventId)) {
      return { status: "duplicate" };
    }
    if (event.sequence <= state.lastSequence) {
      throw new RelayRegistryError("NON_MONOTONIC_SEQUENCE", "event sequence は現在値より大きい必要があります");
    }

    state.lastSequence = event.sequence;
    state.recentEventIds.set(event.eventId, event.sequence);

    const storedEvent = cloneEvent(event);
    if (state.events.length < this.ingressCapacityPerSession) {
      state.events.push(storedEvent);
      this.trimRecentEventIds(state);
      return { status: "accepted", evictedEventId: null };
    }

    if (!IMPORTANT_EVENT_KINDS.has(event.kind)) {
      this.trimRecentEventIds(state);
      return { status: "dropped", reason: "queue_full" };
    }

    // FIFO のように最古を捨てない。重要でない新しい event から置換し、既存の重要 event を保護する。
    let replaceIndex = -1;
    for (let index = state.events.length - 1; index > 0; index -= 1) {
      const queued = state.events[index];
      if (queued !== undefined && !IMPORTANT_EVENT_KINDS.has(queued.kind)) {
        replaceIndex = index;
        break;
      }
    }
    if (replaceIndex < 0) {
      this.trimRecentEventIds(state);
      return { status: "dropped", reason: "queue_full" };
    }

    const replaced = state.events[replaceIndex];
    state.events.splice(replaceIndex, 1);
    state.events.push(storedEvent);
    this.trimRecentEventIds(state);
    return { status: "accepted", evictedEventId: replaced?.eventId ?? null };
  }

  acknowledge(owner: RelayOwnerFence, eventId: string): RelayIngressEvent {
    const now = this.currentTime();
    const registration = this.requireActiveOwner(owner, now);
    assertNonEmpty(eventId, "eventId");
    const key = sessionKey(registration.sessionId);
    const state = this.ingressBySession.get(key);
    if (state === undefined || state.fencingToken !== owner.fencingToken) {
      throw new RelayRegistryError("FENCING_TOKEN_MISMATCH", "ingress state の fencing token が一致しません");
    }
    const index = state.events.findIndex((event) => event.eventId === eventId);
    if (index < 0) {
      throw new RelayRegistryError("EVENT_NOT_FOUND", "ack 対象 event が見つかりません");
    }
    const [acknowledged] = state.events.splice(index, 1);
    if (acknowledged === undefined) {
      throw new RelayRegistryError("EVENT_NOT_FOUND", "ack 対象 event が見つかりません");
    }
    return cloneEvent(acknowledged);
  }

  ingressEvents(owner: RelayOwnerFence): RelayIngressEvent[] {
    const now = this.currentTime();
    const registration = this.requireActiveOwner(owner, now);
    const state = this.ingressBySession.get(sessionKey(registration.sessionId));
    if (state === undefined || state.fencingToken !== owner.fencingToken) {
      throw new RelayRegistryError("FENCING_TOKEN_MISMATCH", "ingress state の fencing token が一致しません");
    }
    return state.events.map(cloneEvent);
  }

  private normalizeRegistrationInput(input: RegisterRelayInput): RegisterRelayInput {
    assertNonEmpty(input.sessionId, "sessionId");
    assertNonEmpty(input.providerSessionId, "providerSessionId");
    assertRelayProvider(input.provider, "provider");
    const serverUrl = requireCanonicalServerUrl(input.serverUrl, "serverUrl");
    assertNonEmpty(input.host, "host");
    assertNonEmpty(input.evenTerminalBootEpoch, "evenTerminalBootEpoch");
    assertPositiveInteger(input.handoverGeneration, "handoverGeneration");
    assertNonEmpty(input.relayId, "relayId");
    this.assertRuntimeIdentity(input.host, input.evenTerminalBootEpoch);
    return { ...input, serverUrl };
  }

  private assertRuntimeIdentity(host: string, evenTerminalBootEpoch: string): void {
    if (host !== this.host) {
      throw new RelayRegistryError("HOST_MISMATCH", "registry の host と要求 host が一致しません");
    }
    if (evenTerminalBootEpoch !== this.evenTerminalBootEpoch) {
      throw new RelayRegistryError(
        "BOOT_EPOCH_MISMATCH",
        "registry の even-terminal boot epoch と要求値が一致しません",
      );
    }
  }

  /**
   * register() と publishAuthorizedRegistration() が共有する registration install 処理。
   * Maps 更新（registrations/activeRegistrationKeys/lastFencingTokens/
   * maxHandoverGenerations/ingressBySession）を単一箇所に閉じ、二重実装を避ける。
   */
  private installRegistration(
    normalizedInput: RegisterRelayInput,
    fencingToken: number,
    leaseExpiresAt: number,
    activeKeyToReplace: string | undefined,
  ): RelayRegistration {
    const key = registrationKey(
      normalizedInput.sessionId,
      normalizedInput.provider,
      normalizedInput.serverUrl,
      normalizedInput.host,
      normalizedInput.handoverGeneration,
    );
    const scopeKey = sessionKey(normalizedInput.sessionId);
    const registration: RelayRegistration = { ...normalizedInput, fencingToken, leaseExpiresAt };
    if (activeKeyToReplace !== undefined) this.registrations.delete(activeKeyToReplace);
    this.registrations.set(key, registration);
    this.activeRegistrationKeys.set(scopeKey, key);
    this.lastFencingTokens.set(scopeKey, fencingToken);
    this.maxHandoverGenerations.set(scopeKey, normalizedInput.handoverGeneration);
    this.ingressBySession.set(scopeKey, {
      fencingToken,
      lastSequence: 0,
      events: [],
      recentEventIds: new Map<string, number>(),
    });
    return { ...registration };
  }

  /**
   * owner が指す registration key の active registration を lease 状態にかかわらず解決する。
   * requireActiveOwner（lease 検査あり）と retireAuthorizedRegistration（lease 検査なし）が共有する。
   */
  private resolveActiveRegistration(
    owner: RelayOwnerFence,
  ): { scopeKey: string; activeKey: string; registration: RelayRegistration } {
    const normalizedOwner = this.normalizeRegistrationInput(owner);
    assertPositiveInteger(owner.fencingToken, "fencingToken");
    const key = registrationKey(
      normalizedOwner.sessionId,
      normalizedOwner.provider,
      normalizedOwner.serverUrl,
      normalizedOwner.host,
      normalizedOwner.handoverGeneration,
    );
    const scopeKey = sessionKey(normalizedOwner.sessionId);
    const activeKey = this.activeRegistrationKeys.get(scopeKey);
    if (activeKey === undefined) {
      throw new RelayRegistryError("OWNER_NOT_FOUND", "active owner が存在しません");
    }
    if (activeKey !== key) {
      throw new RelayRegistryError(
        "GENERATION_MISMATCH",
        "active owner の handover generation が一致しません",
      );
    }
    const registration = this.registrations.get(activeKey);
    if (registration === undefined) {
      throw new RelayRegistryError("OWNER_NOT_FOUND", "active owner が存在しません");
    }
    return { scopeKey, activeKey, registration };
  }

  private requireActiveOwner(owner: RelayOwnerFence, now: number): RelayRegistration {
    const { registration } = this.resolveActiveRegistration(owner);
    if (registration.leaseExpiresAt <= now) {
      throw new RelayRegistryError("LEASE_EXPIRED", "relay owner の lease は失効しています");
    }
    if (registration.fencingToken !== owner.fencingToken) {
      throw new RelayRegistryError("FENCING_TOKEN_MISMATCH", "relay owner の fencing token が一致しません");
    }
    if (
      registration.providerSessionId !== owner.providerSessionId ||
      registration.relayId !== owner.relayId
    ) {
      throw new RelayRegistryError("OWNER_MISMATCH", "relay owner identity が一致しません");
    }
    return registration;
  }

  private assertIngressEvent(owner: RelayOwnerFence, event: RelayIngressEvent): void {
    assertNonEmpty(event.sessionId, "event.sessionId");
    assertPositiveInteger(event.handoverGeneration, "event.handoverGeneration");
    if (event.sessionId !== owner.sessionId) {
      throw new RelayRegistryError("OWNER_MISMATCH", "event の sessionId が owner と一致しません");
    }
    if (event.handoverGeneration !== owner.handoverGeneration) {
      throw new RelayRegistryError("GENERATION_MISMATCH", "event の handover generation が owner と一致しません");
    }
    if (event.turnId !== null) assertNonEmpty(event.turnId, "event.turnId");
    if (event.toolId !== null) assertNonEmpty(event.toolId, "event.toolId");
    assertPositiveInteger(event.sequence, "event.sequence");
    assertNonEmpty(event.eventId, "event.eventId");
    if (!RELAY_INGRESS_EVENT_KIND_SET.has(event.kind)) {
      throw new RelayRegistryError("INVALID_INPUT", "未知の relay ingress event kind です");
    }
    cloneJsonValue(event.payload);
  }

  private trimRecentEventIds(state: IngressState): void {
    const recentEventIdCapacity = this.ingressCapacityPerSession * 2;
    if (state.recentEventIds.size <= recentEventIdCapacity) return;

    const queuedEventIds = new Set(state.events.map((event) => event.eventId));
    for (const eventId of state.recentEventIds.keys()) {
      if (state.recentEventIds.size <= recentEventIdCapacity) break;
      if (!queuedEventIds.has(eventId)) {
        state.recentEventIds.delete(eventId);
      }
    }
  }

  private currentTime(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RelayRegistryError("INVALID_CONFIGURATION", "now は非負の epoch 秒整数を返す必要があります");
    }
    return now;
  }

  private leaseDeadline(now: number): number {
    const deadline = now + this.leaseTtlSeconds;
    if (!Number.isSafeInteger(deadline)) {
      throw new RelayRegistryError("INVALID_CONFIGURATION", "lease deadline を安全に算出できません");
    }
    return deadline;
  }
}
