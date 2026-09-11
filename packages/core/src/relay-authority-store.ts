// G2 relay の production host登録authority（契約 §78.10 / §78.10.3.1）。
// receipt予約と結ぶdurable登録Storeのhost専用port。raw DBやreceipt/FSは扱わず、
// 検証済み型・validator・row mapper・純粋な意味判定だけをこのmoduleへ閉じ込める
// （実SQL/transactionはdb.tsのSqliteKanbanStoreが持つ既存の分離規約を踏襲する）。

import { timingSafeEqual } from "node:crypto";
import {
  RELAY_PROVIDERS,
  canonicalizeRelayServerUrl,
  type RegisterRelayInput,
  type RelayOwnerFence,
  type RelayProvider,
} from "./relay-registry.js";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export const RELAY_AUTHORITY_CLAIM_PURPOSES = ["initial", "restart", "handoff"] as const;
export type RelayRegistrationClaimPurpose = (typeof RELAY_AUTHORITY_CLAIM_PURPOSES)[number];

export const RELAY_AUTHORITY_CLAIM_STATES = ["issued", "active", "retired", "cancelled"] as const;
export type RelayRegistrationClaimState = (typeof RELAY_AUTHORITY_CLAIM_STATES)[number];

export const RELAY_AUTHORITY_TERMINATION_REASONS = [
  "normal_shutdown",
  "handoff_drained",
  "host_restart",
  "expired",
] as const;
export type RelayAuthorityTerminationReason = (typeof RELAY_AUTHORITY_TERMINATION_REASONS)[number];

export const RELAY_AUTHORITY_RETIRE_REASONS = ["normal_shutdown", "handoff_drained"] as const;
export type RelayRetireRegistrationReason = (typeof RELAY_AUTHORITY_RETIRE_REASONS)[number];

/** board/adoption/host の3つのimmutable identity。boardは32lowerhex、他2つは64lowerhex。 */
export interface RelayAuthorityIdentity {
  readonly boardInstanceId: string;
  readonly adoptionId: string;
  readonly hostIdentity: string;
}

/** CAS対象のexpected installation snapshot。読み取り結果RelayAuthorityInstallationと同じ形。 */
export interface RelayExpectedInstallation extends RelayAuthorityIdentity {
  readonly hostEpoch: number;
  readonly authorityRevision: number;
}

export type RelayAuthorityInstallation = RelayExpectedInstallation;

/** durable session authority。HWM/max/latestClaimIdは3つともNULLか3つとも非NULL。 */
export interface RelaySessionAuthority {
  readonly sessionId: string;
  readonly fencingTokenHwm: number | null;
  readonly maxHandoverGeneration: number | null;
  readonly latestClaimId: string | null;
  readonly revision: number;
}

/** durable registration claim。claim secret hashはread結果へ出さない。 */
export interface RelayRegistrationClaim {
  readonly claimId: string;
  readonly sessionId: string;
  readonly relayId: string;
  readonly providerSessionId: string;
  readonly provider: RelayProvider;
  readonly canonicalServerUrl: string;
  readonly host: string;
  readonly evenTerminalBootEpoch: string;
  readonly nativeEvidenceDigest: string;
  readonly handoverGeneration: number;
  readonly hostEpoch: number;
  readonly nativeObservedAt: number;
  readonly purpose: RelayRegistrationClaimPurpose;
  readonly expectedFencingTokenHwm: number | null;
  readonly expectedMaxHandoverGeneration: number | null;
  readonly expectedSessionRevision: number;
  readonly state: RelayRegistrationClaimState;
  readonly assignedFencingToken: number | null;
  readonly claimRevision: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
  readonly retiredAt: number | null;
  readonly cancelledAt: number | null;
  readonly terminationReason: RelayAuthorityTerminationReason | null;
  readonly drainEvidenceDigest: string | null;
  readonly drainedAt: number | null;
}

/** DB commit前、最初のwrite前に一度だけ呼ぶ同期hostcallback。thenableを返してはならない。 */
export type RelayAuthorityBeforeMutation = (previousRevision: number | null, nextRevision: number) => void;

export type RelayAuthorityMutationErrorCode =
  | "INVALID_INPUT"
  | "BOARD_INSTANCE_MISMATCH"
  | "INSTALLATION_ALREADY_ADOPTED"
  | "AUTHORITY_STATE_NOT_EMPTY"
  | "INSTALLATION_NOT_FOUND"
  | "CAS_MISMATCH"
  | "ACTIVE_REGISTRATION_CONFLICT"
  | "ISSUED_CLAIM_CONFLICT"
  | "CLAIM_ID_CONFLICT"
  | "RELAY_ID_CONFLICT"
  | "PREVIOUS_REGISTRATION_MISMATCH"
  | "GENERATION_MISMATCH"
  | "CLAIM_NOT_FOUND"
  | "CLAIM_STATE_MISMATCH"
  | "CLAIM_EXPIRED"
  | "CLAIM_SECRET_MISMATCH"
  | "EXPECTED_SNAPSHOT_MISMATCH"
  | "OWNER_MISMATCH"
  | "CLAIM_REVISION_MISMATCH"
  | "OVERFLOW"
  | "REENTRANT_MUTATION"
  | "MUTATION_UNCERTAIN";

/**
 * callback開始前のreject（副作用0）とcallback開始後の異常（MUTATION_UNCERTAIN）をcodeで区別する。
 * causeはMUTATION_UNCERTAIN時にpost-callback例外を保持する。
 */
export class RelayAuthorityMutationError extends Error {
  readonly code: RelayAuthorityMutationErrorCode;
  override readonly cause?: unknown;

  constructor(code: RelayAuthorityMutationErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "RelayAuthorityMutationError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export interface RelayAdoptInstallationInput {
  readonly identity: RelayAuthorityIdentity;
  readonly now: number;
}

export interface RelayAdvanceHostEpochInput {
  readonly expectedInstallation: RelayExpectedInstallation;
  readonly now: number;
}

export interface RelayAdvanceHostEpochResult {
  readonly installation: RelayAuthorityInstallation;
  readonly retiredOwners: readonly RelayOwnerFence[];
}

export interface RelayIssueRegistrationClaimInput {
  readonly expectedInstallation: RelayExpectedInstallation;
  readonly candidate: RegisterRelayInput;
  readonly purpose: RelayRegistrationClaimPurpose;
  readonly nativeEvidenceDigest: string;
  readonly nativeObservedAt: number;
  readonly claimId: string;
  readonly claimSecretHash: Uint8Array;
  readonly expiresAt: number;
  readonly expectedPreviousRegistration: RelayOwnerFence | null;
  readonly now: number;
}

export interface RelayActivateRegistrationInput {
  readonly expectedInstallation: RelayExpectedInstallation;
  readonly claimId: string;
  readonly claimSecretHash: Uint8Array;
  readonly now: number;
}

export interface RelayActivateRegistrationResult {
  readonly owner: RelayOwnerFence;
  readonly installation: RelayAuthorityInstallation;
}

export interface RelayRetireRegistrationInput {
  readonly expectedInstallation: RelayExpectedInstallation;
  readonly owner: RelayOwnerFence;
  readonly expectedClaimRevision: number;
  readonly reason: RelayRetireRegistrationReason;
  readonly drainEvidenceDigest: string | null;
  readonly drainedAt: number | null;
  readonly now: number;
}

export interface RelayRetireRegistrationResult {
  readonly installation: RelayAuthorityInstallation;
}

/**
 * host内部専用のDB確定登録authority port。rawDBを公開せず、read*はsecret hashを出さない。
 * 実装（SqliteKanbanStore）は各mutationをIMMEDIATE transactionで実行し、
 * 最初のwrite前に一度だけbeforeMutationを呼ぶ契約を守る。
 */
export interface RelayOwnerAuthorityStore {
  readInstallation(): RelayAuthorityInstallation | null;
  readSessionAuthority(sessionId: string): RelaySessionAuthority | null;
  readRegistrationClaim(claimId: string): RelayRegistrationClaim | null;
  adoptInstallation(
    input: RelayAdoptInstallationInput,
    beforeMutation: RelayAuthorityBeforeMutation,
  ): RelayAuthorityInstallation;
  advanceHostEpoch(
    input: RelayAdvanceHostEpochInput,
    beforeMutation: RelayAuthorityBeforeMutation,
  ): RelayAdvanceHostEpochResult;
  issueRegistrationClaim(
    input: RelayIssueRegistrationClaimInput,
    beforeMutation: RelayAuthorityBeforeMutation,
  ): RelayRegistrationClaim;
  activateRegistration(
    input: RelayActivateRegistrationInput,
    beforeMutation: RelayAuthorityBeforeMutation,
  ): RelayActivateRegistrationResult;
  retireRegistration(
    input: RelayRetireRegistrationInput,
    beforeMutation: RelayAuthorityBeforeMutation,
  ): RelayRetireRegistrationResult;
}

// ---------------------------------------------------------------------------
// 生値validator（フォーマット判定。異常はcaller側でRelayAuthorityMutationErrorへ包む）
// ---------------------------------------------------------------------------

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && !value.includes("\0");
}

const HEX_LENGTH_PATTERN = new Map<number, RegExp>();

function isLowerHexOfLength(value: unknown, length: number): value is string {
  if (typeof value !== "string") return false;
  let pattern = HEX_LENGTH_PATTERN.get(length);
  if (pattern === undefined) {
    pattern = new RegExp(`^[0-9a-f]{${length}}$`);
    HEX_LENGTH_PATTERN.set(length, pattern);
  }
  return pattern.test(value);
}

export function isRelayAuthorityCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SAFE;
}

export function isRelayAuthorityNullableCounter(value: unknown): value is number | null {
  return value === null || isRelayAuthorityCounter(value);
}

export function isRelayAuthorityEpochSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE;
}

function isRelayProviderValue(value: unknown): value is RelayProvider {
  return typeof value === "string" && (RELAY_PROVIDERS as readonly string[]).includes(value);
}

export function requireRelayAuthorityCounter(value: unknown, field: string): number {
  if (!isRelayAuthorityCounter(value)) {
    throw new RelayAuthorityMutationError("INVALID_INPUT", `${field} は1以上のsafe integerが必須です`);
  }
  return value;
}

export function requireRelayAuthorityEpochSeconds(value: unknown, field: string): number {
  if (!isRelayAuthorityEpochSeconds(value)) {
    throw new RelayAuthorityMutationError("INVALID_INPUT", `${field} は0以上のsafe integer epoch秒が必須です`);
  }
  return value;
}

function requireRelayAuthorityDigest(value: unknown, field: string): string {
  if (!isLowerHexOfLength(value, 64)) {
    throw new RelayAuthorityMutationError("INVALID_INPUT", `${field} は64lowerhexが必須です`);
  }
  return value;
}

export function validateRelayAuthorityIdentity(identity: RelayAuthorityIdentity): RelayAuthorityIdentity {
  if (
    !isLowerHexOfLength(identity.boardInstanceId, 32) ||
    !isLowerHexOfLength(identity.adoptionId, 64) ||
    !isLowerHexOfLength(identity.hostIdentity, 64)
  ) {
    throw new RelayAuthorityMutationError("INVALID_INPUT", "relay authority identityの形式が不正です");
  }
  return identity;
}

export function validateRelayExpectedInstallation(value: RelayExpectedInstallation): RelayExpectedInstallation {
  validateRelayAuthorityIdentity(value);
  requireRelayAuthorityCounter(value.hostEpoch, "hostEpoch");
  requireRelayAuthorityCounter(value.authorityRevision, "authorityRevision");
  return value;
}

/** serverUrlはcanonicalizeRelayServerUrlで得られるcanonical値だけを受理する。 */
export function validateRegisterRelayCandidate(candidate: RegisterRelayInput): RegisterRelayInput {
  if (
    !isNonEmptyTrimmedString(candidate.sessionId) ||
    !isNonEmptyTrimmedString(candidate.providerSessionId) ||
    !isRelayProviderValue(candidate.provider) ||
    !isNonEmptyTrimmedString(candidate.host) ||
    !isNonEmptyTrimmedString(candidate.evenTerminalBootEpoch) ||
    !isLowerHexOfLength(candidate.relayId, 64) ||
    !isRelayAuthorityCounter(candidate.handoverGeneration) ||
    canonicalizeRelayServerUrl(candidate.serverUrl) !== candidate.serverUrl
  ) {
    throw new RelayAuthorityMutationError("INVALID_INPUT", "relay登録candidateの入力が不正です");
  }
  return candidate;
}

export function validateRelayOwnerFenceValue(fence: RelayOwnerFence): RelayOwnerFence {
  validateRegisterRelayCandidate(fence);
  requireRelayAuthorityCounter(fence.fencingToken, "fencingToken");
  return fence;
}

export function validateRelayAuthorityClaimSecretHash(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new RelayAuthorityMutationError("INVALID_INPUT", "claim secret hashは32byteが必須です");
  }
  return value;
}

/** hash自体は比較以外で使わない。定数時間比較で二値化する。 */
export function relayAuthorityClaimSecretMatches(candidate: Uint8Array, stored: Uint8Array): boolean {
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

// ---------------------------------------------------------------------------
// row mapper（fail-closed。malformed rowは隠さずthrowする）
// ---------------------------------------------------------------------------

export interface RawRelayAuthorityInstallationRow {
  readonly singleton: number;
  readonly board_instance_id: string;
  readonly adoption_id: string;
  readonly host_identity: string;
  readonly host_epoch: number;
  readonly authority_revision: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export function mapRelayAuthorityInstallationRow(row: RawRelayAuthorityInstallationRow): RelayAuthorityInstallation {
  if (
    row.singleton !== 1 ||
    !isLowerHexOfLength(row.board_instance_id, 32) ||
    !isLowerHexOfLength(row.adoption_id, 64) ||
    !isLowerHexOfLength(row.host_identity, 64) ||
    !isRelayAuthorityCounter(row.host_epoch) ||
    !isRelayAuthorityCounter(row.authority_revision) ||
    !isRelayAuthorityEpochSeconds(row.created_at) ||
    !isRelayAuthorityEpochSeconds(row.updated_at)
  ) {
    throw new Error("relay authority installation row が不正です");
  }
  return {
    boardInstanceId: row.board_instance_id,
    adoptionId: row.adoption_id,
    hostIdentity: row.host_identity,
    hostEpoch: row.host_epoch,
    authorityRevision: row.authority_revision,
  };
}

export interface RawRelaySessionAuthorityRow {
  readonly session_id: string;
  readonly fencing_token_hwm: number | null;
  readonly max_handover_generation: number | null;
  readonly latest_claim_id: string | null;
  readonly revision: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export function mapRelaySessionAuthorityRow(row: RawRelaySessionAuthorityRow): RelaySessionAuthority {
  const triadNull =
    row.fencing_token_hwm === null && row.max_handover_generation === null && row.latest_claim_id === null;
  const triadFilled =
    row.fencing_token_hwm !== null && row.max_handover_generation !== null && row.latest_claim_id !== null;
  if (
    !isNonEmptyTrimmedString(row.session_id) ||
    !isRelayAuthorityCounter(row.revision) ||
    !isRelayAuthorityEpochSeconds(row.created_at) ||
    !isRelayAuthorityEpochSeconds(row.updated_at) ||
    !(triadNull || triadFilled) ||
    (row.fencing_token_hwm !== null && !isRelayAuthorityCounter(row.fencing_token_hwm)) ||
    (row.max_handover_generation !== null && !isRelayAuthorityCounter(row.max_handover_generation)) ||
    (row.latest_claim_id !== null && !isLowerHexOfLength(row.latest_claim_id, 64))
  ) {
    throw new Error("relay session authority row が不正です");
  }
  return {
    sessionId: row.session_id,
    fencingTokenHwm: row.fencing_token_hwm,
    maxHandoverGeneration: row.max_handover_generation,
    latestClaimId: row.latest_claim_id,
    revision: row.revision,
  };
}

/**
 * DBのclaim_secret_hash BLOB列の生値を検査する。64lowerhex文字列（digest表現）とは別物で、
 * DB BLOBはraw 32byte（BufferまたはUint8Array）であることだけを要求する。
 */
function isValidClaimSecretHashColumn(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.length === 32;
}

export interface RawRelayRegistrationClaimRow {
  readonly claim_id: string;
  readonly session_id: string;
  readonly relay_id: string;
  readonly provider_session_id: string;
  readonly provider: string;
  readonly canonical_server_url: string;
  readonly host: string;
  readonly even_terminal_boot_epoch: string;
  readonly native_evidence_digest: string;
  readonly handover_generation: number;
  readonly host_epoch: number;
  readonly native_observed_at: number;
  /** DBが返すBufferまたはUint8Arrayの32byte生値。read公開結果へは出さない。 */
  readonly claim_secret_hash: Uint8Array;
  readonly purpose: string;
  readonly expected_fencing_token_hwm: number | null;
  readonly expected_max_handover_generation: number | null;
  readonly expected_session_revision: number;
  readonly state: string;
  readonly assigned_fencing_token: number | null;
  readonly claim_revision: number;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly consumed_at: number | null;
  readonly retired_at: number | null;
  readonly cancelled_at: number | null;
  readonly termination_reason: string | null;
  readonly drain_evidence_digest: string | null;
  readonly drained_at: number | null;
}

/** state別のnullable整合（issued/active/retired/cancelledで許される非NULL組合せ）。 */
function relayRegistrationClaimStateFieldsConsistent(row: RawRelayRegistrationClaimRow): boolean {
  const hasAssigned = row.assigned_fencing_token !== null;
  const hasConsumed = row.consumed_at !== null;
  const hasRetired = row.retired_at !== null;
  const hasCancelled = row.cancelled_at !== null;
  const hasTerminationReason = row.termination_reason !== null;
  switch (row.state) {
    case "issued":
      return !hasAssigned && !hasConsumed && !hasRetired && !hasCancelled && !hasTerminationReason;
    case "active":
      return hasAssigned && hasConsumed && !hasRetired && !hasCancelled && !hasTerminationReason;
    case "retired":
      return hasAssigned && hasConsumed && hasRetired && !hasCancelled && hasTerminationReason;
    case "cancelled":
      return !hasAssigned && !hasConsumed && !hasRetired && hasCancelled && hasTerminationReason;
    default:
      return false;
  }
}

/** drain evidence/drained_atはtermination_reason='handoff_drained'のときだけ両方非NULLが必須。 */
function relayRegistrationClaimDrainFieldsConsistent(row: RawRelayRegistrationClaimRow): boolean {
  const hasDrainDigest = row.drain_evidence_digest !== null;
  const hasDrainedAt = row.drained_at !== null;
  if (row.termination_reason === "handoff_drained") {
    return hasDrainDigest && hasDrainedAt;
  }
  return !hasDrainDigest && !hasDrainedAt;
}

export function mapRelayRegistrationClaimRow(row: RawRelayRegistrationClaimRow): RelayRegistrationClaim {
  if (
    !isLowerHexOfLength(row.claim_id, 64) ||
    !isNonEmptyTrimmedString(row.session_id) ||
    !isLowerHexOfLength(row.relay_id, 64) ||
    !isNonEmptyTrimmedString(row.provider_session_id) ||
    !isRelayProviderValue(row.provider) ||
    !isNonEmptyTrimmedString(row.canonical_server_url) ||
    canonicalizeRelayServerUrl(row.canonical_server_url) !== row.canonical_server_url ||
    !isNonEmptyTrimmedString(row.host) ||
    !isNonEmptyTrimmedString(row.even_terminal_boot_epoch) ||
    !isLowerHexOfLength(row.native_evidence_digest, 64) ||
    !isRelayAuthorityCounter(row.handover_generation) ||
    !isRelayAuthorityCounter(row.host_epoch) ||
    !isRelayAuthorityEpochSeconds(row.native_observed_at) ||
    !isValidClaimSecretHashColumn(row.claim_secret_hash) ||
    !(RELAY_AUTHORITY_CLAIM_PURPOSES as readonly string[]).includes(row.purpose) ||
    !isRelayAuthorityNullableCounter(row.expected_fencing_token_hwm) ||
    !isRelayAuthorityNullableCounter(row.expected_max_handover_generation) ||
    !isRelayAuthorityCounter(row.expected_session_revision) ||
    !(RELAY_AUTHORITY_CLAIM_STATES as readonly string[]).includes(row.state) ||
    !isRelayAuthorityNullableCounter(row.assigned_fencing_token) ||
    !isRelayAuthorityCounter(row.claim_revision) ||
    !isRelayAuthorityEpochSeconds(row.issued_at) ||
    !isRelayAuthorityEpochSeconds(row.expires_at) ||
    row.expires_at <= row.issued_at ||
    (row.consumed_at !== null && !isRelayAuthorityEpochSeconds(row.consumed_at)) ||
    (row.retired_at !== null && !isRelayAuthorityEpochSeconds(row.retired_at)) ||
    (row.cancelled_at !== null && !isRelayAuthorityEpochSeconds(row.cancelled_at)) ||
    (row.termination_reason !== null &&
      !(RELAY_AUTHORITY_TERMINATION_REASONS as readonly string[]).includes(row.termination_reason)) ||
    (row.drain_evidence_digest !== null && !isLowerHexOfLength(row.drain_evidence_digest, 64)) ||
    (row.drained_at !== null && !isRelayAuthorityEpochSeconds(row.drained_at)) ||
    !relayRegistrationClaimStateFieldsConsistent(row) ||
    !relayRegistrationClaimDrainFieldsConsistent(row)
  ) {
    throw new Error("relay registration claim row が不正です");
  }
  return {
    claimId: row.claim_id,
    sessionId: row.session_id,
    relayId: row.relay_id,
    providerSessionId: row.provider_session_id,
    provider: row.provider as RelayProvider,
    canonicalServerUrl: row.canonical_server_url,
    host: row.host,
    evenTerminalBootEpoch: row.even_terminal_boot_epoch,
    nativeEvidenceDigest: row.native_evidence_digest,
    handoverGeneration: row.handover_generation,
    hostEpoch: row.host_epoch,
    nativeObservedAt: row.native_observed_at,
    purpose: row.purpose as RelayRegistrationClaimPurpose,
    expectedFencingTokenHwm: row.expected_fencing_token_hwm,
    expectedMaxHandoverGeneration: row.expected_max_handover_generation,
    expectedSessionRevision: row.expected_session_revision,
    state: row.state as RelayRegistrationClaimState,
    assignedFencingToken: row.assigned_fencing_token,
    claimRevision: row.claim_revision,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    retiredAt: row.retired_at,
    cancelledAt: row.cancelled_at,
    terminationReason: row.termination_reason as RelayAuthorityTerminationReason | null,
    drainEvidenceDigest: row.drain_evidence_digest,
    drainedAt: row.drained_at,
  };
}

// ---------------------------------------------------------------------------
// 純粋な意味判定（DBに触れない。db.ts側のtransactionから呼ぶ）
// ---------------------------------------------------------------------------

export function relayAuthorityInstallationMatches(
  expected: RelayExpectedInstallation,
  current: RelayAuthorityInstallation,
): boolean {
  return (
    expected.boardInstanceId === current.boardInstanceId &&
    expected.adoptionId === current.adoptionId &&
    expected.hostIdentity === current.hostIdentity &&
    expected.hostEpoch === current.hostEpoch &&
    expected.authorityRevision === current.authorityRevision
  );
}

export function relayAuthorityClaimFence(
  claim: Pick<
    RelayRegistrationClaim,
    "sessionId" | "providerSessionId" | "provider" | "canonicalServerUrl" | "host" | "evenTerminalBootEpoch" | "handoverGeneration" | "relayId"
  >,
  fencingToken: number,
): RelayOwnerFence {
  return {
    sessionId: claim.sessionId,
    providerSessionId: claim.providerSessionId,
    provider: claim.provider,
    serverUrl: claim.canonicalServerUrl,
    host: claim.host,
    evenTerminalBootEpoch: claim.evenTerminalBootEpoch,
    handoverGeneration: claim.handoverGeneration,
    relayId: claim.relayId,
    fencingToken,
  };
}

export function relayOwnerFenceEquals(a: RelayOwnerFence, b: RelayOwnerFence): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.providerSessionId === b.providerSessionId &&
    a.provider === b.provider &&
    a.serverUrl === b.serverUrl &&
    a.host === b.host &&
    a.evenTerminalBootEpoch === b.evenTerminalBootEpoch &&
    a.handoverGeneration === b.handoverGeneration &&
    a.relayId === b.relayId &&
    a.fencingToken === b.fencingToken
  );
}

/** current+1（初回はnull->1）をoverflow検査つきで返す。副作用前に呼ぶ。 */
export function relayAuthorityNextCounter(current: number | null): number {
  const next = current === null ? 1 : current + 1;
  if (!Number.isSafeInteger(next) || next < 1 || next > MAX_SAFE) {
    throw new RelayAuthorityMutationError("OVERFLOW", "counterがsafe integer範囲を超えます");
  }
  return next;
}

export interface RelayAuthorityIssuePurposeCheckInput {
  readonly purpose: RelayRegistrationClaimPurpose;
  readonly session: RelaySessionAuthority | null;
  /** session.latestClaimIdが指すclaim。session未成立またはlatestClaimId未成立ならnull。 */
  readonly latestClaim: RelayRegistrationClaim | null;
  readonly candidateHandoverGeneration: number;
  readonly expectedPreviousRegistration: RelayOwnerFence | null;
}

/**
 * initial/restart/handoffのpurpose別事前条件を検査する。旧candidate fieldとの一致は要求しない
 * （expectedPreviousRegistrationとlatestClaimのfull fenceだけを比較する）。
 */
export function relayAuthorityAssertIssuePurpose(input: RelayAuthorityIssuePurposeCheckInput): void {
  const { purpose, session, latestClaim, candidateHandoverGeneration, expectedPreviousRegistration } = input;
  const hasDurableState = session !== null && session.fencingTokenHwm !== null && session.maxHandoverGeneration !== null;

  if (purpose === "initial") {
    if (hasDurableState || expectedPreviousRegistration !== null) {
      throw new RelayAuthorityMutationError(
        "PREVIOUS_REGISTRATION_MISMATCH",
        "initial claimはHWM/max/latest無しかつexpectedPreviousRegistration=nullが必須です",
      );
    }
    return;
  }

  if (!hasDurableState || latestClaim === null || expectedPreviousRegistration === null) {
    throw new RelayAuthorityMutationError(
      "PREVIOUS_REGISTRATION_MISMATCH",
      `${purpose} claimはdurable session状態とexpectedPreviousRegistrationが必須です`,
    );
  }

  if (purpose === "restart") {
    if (latestClaim.state !== "retired") {
      throw new RelayAuthorityMutationError(
        "PREVIOUS_REGISTRATION_MISMATCH",
        "restart claimはlatestがretired状態であることが必須です",
      );
    }
  } else {
    if (
      latestClaim.state !== "retired" ||
      latestClaim.terminationReason !== "handoff_drained" ||
      latestClaim.drainEvidenceDigest === null ||
      latestClaim.drainedAt === null
    ) {
      throw new RelayAuthorityMutationError(
        "PREVIOUS_REGISTRATION_MISMATCH",
        "handoff claimはlatestがhandoff_drained退役済みであることが必須です",
      );
    }
  }

  if (latestClaim.assignedFencingToken === null) {
    throw new RelayAuthorityMutationError(
      "PREVIOUS_REGISTRATION_MISMATCH",
      "retired claimのassignedFencingTokenが欠落しています",
    );
  }
  const latestFence = relayAuthorityClaimFence(latestClaim, latestClaim.assignedFencingToken);
  if (!relayOwnerFenceEquals(latestFence, expectedPreviousRegistration)) {
    throw new RelayAuthorityMutationError(
      "PREVIOUS_REGISTRATION_MISMATCH",
      "expectedPreviousRegistrationがlatest full fenceと一致しません",
    );
  }

  const maxHandoverGeneration = session.maxHandoverGeneration as number;
  if (purpose === "restart") {
    if (candidateHandoverGeneration !== maxHandoverGeneration) {
      throw new RelayAuthorityMutationError(
        "GENERATION_MISMATCH",
        "restart candidateのhandoverGenerationはmaxと完全一致が必須です",
      );
    }
  } else if (candidateHandoverGeneration <= maxHandoverGeneration) {
    throw new RelayAuthorityMutationError(
      "GENERATION_MISMATCH",
      "handoff candidateのhandoverGenerationはmaxより大きいことが必須です",
    );
  }
}

export interface RelayAuthorityIssueConflictCheck {
  readonly conflict: boolean;
  readonly expiredIssuedClaimId: string | null;
}

/**
 * 未期限切れissuedまたはactiveがあれば拒否する。期限切れissuedだけがあれば、
 * それを同mutationでcancelled/expiredにする対象として返す。
 */
export function relayAuthorityCheckIssueConflict(
  existingActiveOrIssued: readonly Pick<RelayRegistrationClaim, "claimId" | "state" | "expiresAt">[],
  now: number,
): RelayAuthorityIssueConflictCheck {
  let expiredIssuedClaimId: string | null = null;
  for (const claim of existingActiveOrIssued) {
    if (claim.state === "active") {
      return { conflict: true, expiredIssuedClaimId: null };
    }
    if (claim.state === "issued") {
      if (claim.expiresAt > now) {
        return { conflict: true, expiredIssuedClaimId: null };
      }
      expiredIssuedClaimId = claim.claimId;
    }
  }
  return { conflict: false, expiredIssuedClaimId };
}

// ---------------------------------------------------------------------------
// mutation input validator（形式検査だけを行う。CAS/意味検査はStore実装のtransaction内で行う）
// ---------------------------------------------------------------------------

export function validateRelayAdoptInstallationInput(input: RelayAdoptInstallationInput): RelayAdoptInstallationInput {
  validateRelayAuthorityIdentity(input.identity);
  requireRelayAuthorityEpochSeconds(input.now, "now");
  return input;
}

export function validateRelayAdvanceHostEpochInput(
  input: RelayAdvanceHostEpochInput,
): RelayAdvanceHostEpochInput {
  validateRelayExpectedInstallation(input.expectedInstallation);
  requireRelayAuthorityEpochSeconds(input.now, "now");
  return input;
}

export function validateRelayIssueRegistrationClaimInput(
  input: RelayIssueRegistrationClaimInput,
): RelayIssueRegistrationClaimInput {
  validateRelayExpectedInstallation(input.expectedInstallation);
  validateRegisterRelayCandidate(input.candidate);
  if (!(RELAY_AUTHORITY_CLAIM_PURPOSES as readonly string[]).includes(input.purpose)) {
    throw new RelayAuthorityMutationError("INVALID_INPUT", "purposeが不正です");
  }
  requireRelayAuthorityDigest(input.nativeEvidenceDigest, "nativeEvidenceDigest");
  requireRelayAuthorityEpochSeconds(input.nativeObservedAt, "nativeObservedAt");
  requireRelayAuthorityDigest(input.claimId, "claimId");
  validateRelayAuthorityClaimSecretHash(input.claimSecretHash);
  requireRelayAuthorityEpochSeconds(input.expiresAt, "expiresAt");
  requireRelayAuthorityEpochSeconds(input.now, "now");
  if (input.nativeObservedAt > input.now) {
    throw new RelayAuthorityMutationError("INVALID_INPUT", "nativeObservedAtはnow以前が必須です");
  }
  if (input.expiresAt <= input.now) {
    throw new RelayAuthorityMutationError("INVALID_INPUT", "expiresAtはnowより後が必須です");
  }
  if (input.expectedPreviousRegistration !== null) {
    validateRelayOwnerFenceValue(input.expectedPreviousRegistration);
  }
  return input;
}

export function validateRelayActivateRegistrationInput(
  input: RelayActivateRegistrationInput,
): RelayActivateRegistrationInput {
  validateRelayExpectedInstallation(input.expectedInstallation);
  requireRelayAuthorityDigest(input.claimId, "claimId");
  validateRelayAuthorityClaimSecretHash(input.claimSecretHash);
  requireRelayAuthorityEpochSeconds(input.now, "now");
  return input;
}

export function validateRelayRetireRegistrationInput(
  input: RelayRetireRegistrationInput,
): RelayRetireRegistrationInput {
  validateRelayExpectedInstallation(input.expectedInstallation);
  validateRelayOwnerFenceValue(input.owner);
  requireRelayAuthorityCounter(input.expectedClaimRevision, "expectedClaimRevision");
  requireRelayAuthorityEpochSeconds(input.now, "now");
  if (!(RELAY_AUTHORITY_RETIRE_REASONS as readonly string[]).includes(input.reason)) {
    throw new RelayAuthorityMutationError("INVALID_INPUT", "reasonが不正です");
  }
  if (input.reason === "handoff_drained") {
    if (input.drainEvidenceDigest === null || input.drainedAt === null) {
      throw new RelayAuthorityMutationError(
        "INVALID_INPUT",
        "handoff_drainedはdrainEvidenceDigest/drainedAtが必須です",
      );
    }
    requireRelayAuthorityDigest(input.drainEvidenceDigest, "drainEvidenceDigest");
    requireRelayAuthorityEpochSeconds(input.drainedAt, "drainedAt");
    if (input.drainedAt > input.now) {
      throw new RelayAuthorityMutationError("INVALID_INPUT", "drainedAtはnow以前が必須です");
    }
  } else if (input.drainEvidenceDigest !== null || input.drainedAt !== null) {
    throw new RelayAuthorityMutationError(
      "INVALID_INPUT",
      "normal_shutdownはdrainEvidenceDigest/drainedAtがNULLである必要があります",
    );
  }
  return input;
}
