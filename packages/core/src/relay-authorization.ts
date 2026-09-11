// G2 の全 session route が共有する relay 認可判定。
// 外部 I/O や task_runs の schema には依存せず、観測済みの事実と注入 port だけから fail-closed に決める。

import {
  canonicalizeRelayServerUrl,
  RELAY_PROVIDERS,
  RelayRegistry,
  type RelayProvider,
  type RelayRegistration,
} from "./relay-registry.js";

export const RELAY_AUTHORIZATION_ROUTES = [
  "sessions",
  "history",
  "events",
  "prompt",
  "interrupt",
] as const;

export type RelayAuthorizationRoute = (typeof RELAY_AUTHORIZATION_ROUTES)[number];

export const RELAY_AUTHORIZATION_PROVIDERS = RELAY_PROVIDERS;

export type RelayAuthorizationProvider = RelayProvider;

export const RELAY_PROCESS_LIVENESS_VALUES = ["alive", "absent", "unknown"] as const;

export type RelayProcessLiveness = (typeof RELAY_PROCESS_LIVENESS_VALUES)[number];

export type RelayAuthorizationState =
  | "active_owner"
  | "relay_unavailable"
  | "stale_or_foreign"
  | "owner_conflict"
  | "unregistered_process"
  | "transcript_only"
  | "session_not_found";

export type RelayAuthorizationReason =
  | "active_relay"
  | "prompt_forwarding_disabled"
  | "relay_unavailable"
  | "stale_or_foreign_registration"
  | "active_owner_conflict"
  | "unregistered_process"
  | "owned_transcript"
  | "transcript_not_owned"
  | "ownership_lookup_failed"
  | "transcript_has_no_process_to_interrupt"
  | "session_not_found"
  | "invalid_session_id"
  | "invalid_input"
  | "process_liveness_unknown"
  | "ambiguous_transcript_ownership";

export type RelayAuthorizationHttpStatus = 200 | 404 | 409 | 503;

/** task_runs.session_id の完全一致行から adapter が取り出す既存列と meta の最小 projection。 */
export interface RelaySessionOwnership {
  provider: RelayAuthorizationProvider;
  transport: string;
  serverUrl: string;
}

/**
 * board adapter が実装する port。指定 sessionId と完全一致する task_runs 行をすべて返す。
 * 行が無い場合は空配列、取得不能時は throw とし、判定側はいずれも fail-closed に扱う。
 */
export type RelaySessionOwnershipLookup = (sessionId: string) => readonly RelaySessionOwnership[];

interface RelayAuthorizationInputBase {
  route: RelayAuthorizationRoute;
  sessionId: string;
  provider: RelayAuthorizationProvider;
  host: string;
  evenTerminalBootEpoch: string;
  requestingServerUrl: string;
  relayResponsive: boolean;
  processLiveness: RelayProcessLiveness;
  transcriptExists: boolean;
  ownershipLookup: RelaySessionOwnershipLookup;
}

/** active owner が自身の fence を照合する経路。 */
export interface RelayOwnerAuthorizationInput extends RelayAuthorizationInputBase {
  kind: "owner";
  handoverGeneration: number;
  relayId: string;
  fencingToken: number;
}

/** route guard が owner fence を名乗らず、registry と task_runs の観測結果だけを渡す経路。 */
export interface RelayObserverAuthorizationInput extends RelayAuthorizationInputBase {
  kind: "observer";
  handoverGeneration?: never;
  relayId?: never;
  fencingToken?: never;
}

export type RelayAuthorizationInput =
  | RelayOwnerAuthorizationInput
  | RelayObserverAuthorizationInput;

interface RelayAuthorizationDecisionBase {
  state: RelayAuthorizationState;
  route: RelayAuthorizationRoute | null;
  reason: RelayAuthorizationReason;
  excludeFromSessionList: boolean;
}

export interface RelayAuthorizationAllowedDecision extends RelayAuthorizationDecisionBase {
  allowed: true;
  resumeAllowed: boolean;
  httpStatus: 200;
  owner: RelayRegistration | null;
}

export interface RelayAuthorizationDeniedDecision extends RelayAuthorizationDecisionBase {
  allowed: false;
  resumeAllowed: false;
  httpStatus: Exclude<RelayAuthorizationHttpStatus, 200>;
  /** deny 時に owner を渡さず、route が判定を無視して転送できない形にする。 */
  owner: null;
}

/** 各 route が allowed で絞り込み、そのまま enforcement に利用する判定結果。 */
export type RelayAuthorizationDecision =
  | RelayAuthorizationAllowedDecision
  | RelayAuthorizationDeniedDecision;

function deny(
  input: RelayAuthorizationInput,
  state: RelayAuthorizationState,
  reason: RelayAuthorizationReason,
  httpStatus: Exclude<RelayAuthorizationHttpStatus, 200>,
  excludeFromSessionList: boolean,
): RelayAuthorizationDeniedDecision {
  return {
    state,
    route: isAuthorizationRoute(input.route) ? input.route : null,
    allowed: false,
    resumeAllowed: false,
    reason,
    httpStatus,
    excludeFromSessionList,
    owner: null,
  };
}

function allow(
  input: RelayAuthorizationInput,
  state: RelayAuthorizationState,
  reason: RelayAuthorizationReason,
  resumeAllowed: boolean,
  owner: RelayRegistration | null,
): RelayAuthorizationAllowedDecision {
  return {
    state,
    route: input.route,
    allowed: true,
    resumeAllowed,
    reason,
    httpStatus: 200,
    excludeFromSessionList: false,
    owner,
  };
}

function isValidIdentityPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && !value.includes("\0");
}

function isAuthorizationRoute(value: unknown): value is RelayAuthorizationRoute {
  return typeof value === "string" && (RELAY_AUTHORIZATION_ROUTES as readonly string[]).includes(value);
}

function isAuthorizationProvider(value: unknown): value is RelayAuthorizationProvider {
  return typeof value === "string" && (RELAY_AUTHORIZATION_PROVIDERS as readonly string[]).includes(value);
}

function isProcessLiveness(value: unknown): value is RelayProcessLiveness {
  return typeof value === "string" && (RELAY_PROCESS_LIVENESS_VALUES as readonly string[]).includes(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * 契約 §78.8: transport ごとに serverUrl の規則が異なる。bridge は canonicalizeRelayServerUrl で
 * canonical 化できる HTTP(S) URL、direct は既存 writer の sentinel `serverUrl === "direct"` だけを
 * 受理する。未知 transport は無条件で invalid とする（fail-closed）。
 */
function isValidOwnership(value: unknown): value is RelaySessionOwnership {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!isAuthorizationProvider(record["provider"])) return false;
  if (record["transport"] === "bridge") {
    return canonicalizeRelayServerUrl(record["serverUrl"]) !== null;
  }
  if (record["transport"] === "direct") {
    return record["serverUrl"] === "direct";
  }
  return false;
}

function hasMatchingRuntimeIdentity(
  registration: RelayRegistration,
  input: RelayAuthorizationInput,
  requestingServerUrl: string,
): boolean {
  return (
    isValidIdentityPart(input.host) &&
    isValidIdentityPart(input.evenTerminalBootEpoch) &&
    registration.provider === input.provider &&
    registration.serverUrl === requestingServerUrl &&
    registration.host === input.host &&
    registration.evenTerminalBootEpoch === input.evenTerminalBootEpoch &&
    (input.kind === "observer" || registration.handoverGeneration === input.handoverGeneration)
  );
}

/**
 * RelayRegistry と呼び出し側が既に観測した事実から、G2 session route の認可を 7 状態へ分類する。
 * state 1 の prompt は P3-2b まで閉じ、state 6 は所有証拠が exact-one の read だけを許す。
 * transcript-only の resume は one-shot claim/fence が入るまで許可しない。
 */
export function decideRelayAuthorization(
  registry: RelayRegistry,
  input: RelayAuthorizationInput,
): RelayAuthorizationDecision {
  if (!isAuthorizationRoute(input.route)) {
    return deny(input, "stale_or_foreign", "invalid_input", 409, true);
  }
  if (!isValidIdentityPart(input.sessionId)) {
    return deny(input, "session_not_found", "invalid_session_id", 404, true);
  }
  const requestingServerUrl = canonicalizeRelayServerUrl(input.requestingServerUrl);
  if (
    (input.kind !== "owner" && input.kind !== "observer") ||
    !isAuthorizationProvider(input.provider) ||
    !isValidIdentityPart(input.host) ||
    !isValidIdentityPart(input.evenTerminalBootEpoch) ||
    requestingServerUrl === null ||
    typeof input.ownershipLookup !== "function"
  ) {
    return deny(input, "stale_or_foreign", "invalid_input", 409, true);
  }
  if (
    input.kind === "owner" && (
      !isPositiveSafeInteger(input.handoverGeneration) ||
      !isValidIdentityPart(input.relayId) ||
      !isPositiveSafeInteger(input.fencingToken)
    )
  ) {
    return deny(input, "stale_or_foreign", "invalid_input", 409, true);
  }
  if (
    !isProcessLiveness(input.processLiveness) ||
    input.processLiveness === "unknown"
  ) {
    return deny(input, "relay_unavailable", "process_liveness_unknown", 503, true);
  }
  if (typeof input.relayResponsive !== "boolean" || typeof input.transcriptExists !== "boolean") {
    return deny(input, "relay_unavailable", "invalid_input", 503, true);
  }
  if (input.host !== registry.host || input.evenTerminalBootEpoch !== registry.evenTerminalBootEpoch) {
    return deny(input, "stale_or_foreign", "stale_or_foreign_registration", 409, true);
  }

  let registration: RelayRegistration | null;
  let hasRegistrationForSession: boolean;
  try {
    registration = registry.registrationForSession({
      sessionId: input.sessionId,
      provider: input.provider,
      serverUrl: requestingServerUrl,
      host: input.host,
    });
    hasRegistrationForSession = registration !== null || registry.hasRegistrationForSession(input.sessionId);
  } catch {
    return deny(input, "relay_unavailable", "relay_unavailable", 503, true);
  }
  if (registration !== null) {
    if (!hasMatchingRuntimeIdentity(registration, input, requestingServerUrl)) {
      return deny(input, "stale_or_foreign", "stale_or_foreign_registration", 409, true);
    }

    let activeRegistration: RelayRegistration | null;
    try {
      activeRegistration = registry.activeRegistration({
        sessionId: input.sessionId,
        provider: input.provider,
        serverUrl: requestingServerUrl,
        host: input.host,
        evenTerminalBootEpoch: input.evenTerminalBootEpoch,
        handoverGeneration: registration.handoverGeneration,
      });
    } catch {
      return deny(input, "relay_unavailable", "relay_unavailable", 503, true);
    }
    if (activeRegistration === null || input.relayResponsive !== true) {
      return deny(input, "relay_unavailable", "relay_unavailable", 503, true);
    }
    if (input.kind === "owner" && (
      activeRegistration.relayId !== input.relayId ||
      activeRegistration.fencingToken !== input.fencingToken
    )) {
      return deny(input, "owner_conflict", "active_owner_conflict", 409, true);
    }
    if (input.route === "prompt") {
      return deny(input, "active_owner", "prompt_forwarding_disabled", 409, false);
    }
    return allow(input, "active_owner", "active_relay", false, activeRegistration);
  }

  if (hasRegistrationForSession) {
    return deny(input, "stale_or_foreign", "stale_or_foreign_registration", 409, true);
  }

  if (input.processLiveness === "alive") {
    return deny(input, "unregistered_process", "unregistered_process", 409, true);
  }

  if (input.transcriptExists === true) {
    // 判定後の relay 登録や並行 prompt と競合するため、one-shot resume claim/fence が入るまで閉じる。
    if (input.route === "prompt") {
      return deny(input, "transcript_only", "prompt_forwarding_disabled", 409, false);
    }

    let ownershipRows: readonly RelaySessionOwnership[];
    try {
      const lookupResult: unknown = input.ownershipLookup(input.sessionId);
      if (!Array.isArray(lookupResult) || !lookupResult.every(isValidOwnership)) {
        return deny(input, "transcript_only", "ownership_lookup_failed", 503, true);
      }
      ownershipRows = lookupResult;
    } catch {
      return deny(input, "transcript_only", "ownership_lookup_failed", 503, true);
    }
    const matchingOwnershipRows = ownershipRows.filter((ownership) => (
      ownership.provider === input.provider &&
      ownership.transport === "bridge" &&
      canonicalizeRelayServerUrl(ownership.serverUrl) === requestingServerUrl
    ));
    if (matchingOwnershipRows.length > 1) {
      return deny(input, "transcript_only", "ambiguous_transcript_ownership", 409, true);
    }
    if (matchingOwnershipRows.length !== 1) {
      return deny(input, "transcript_only", "transcript_not_owned", 409, true);
    }
    if (input.route === "interrupt") {
      return deny(input, "transcript_only", "transcript_has_no_process_to_interrupt", 409, false);
    }
    return allow(input, "transcript_only", "owned_transcript", false, null);
  }

  return deny(input, "session_not_found", "session_not_found", 404, true);
}
