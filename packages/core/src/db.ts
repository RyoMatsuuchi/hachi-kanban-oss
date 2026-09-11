// =============================================================================
// SQLite 単一書込パス（docs/contract.md §5）
// KanbanStore の実装。全ての状態遷移は同一トランザクション内で task_events に記録する。
// 生 SQL を発行できるのはこのファイルのみ（他パッケージは KanbanStore 経由で使う）。
// =============================================================================

import { createHash, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { ORCHESTRATOR_SESSION_STALE_SECONDS } from "./orchestrator-session-policy.js";
import {
  extractDeliveryWorktreeFromBody,
  resolveOrchestratorDeliveryTargets,
  type ResolveOrchestratorDeliveryTargetsInput,
} from "./orchestrator-scope.js";
import {
  communicationCanaryCohortKey,
  isCommunicationCanaryEligible,
  isEffortLevel,
  isExecutionSpeed,
  MODEL_CHARSET,
} from "./policy.js";
import {
  mapCommentRow,
  mapEventRow,
  mapKnowledgeRow,
  mapLessonRow,
  mapLinkRow,
  mapRunCancelRequestRow,
  mapRunRow,
  mapScheduleRow,
  mapTaskRow,
  type RawCommentRow,
  type RawEventRow,
  type RawKnowledgeRow,
  type RawLessonRow,
  type RawLinkRow,
  type RawRunCancelRequestRow,
  type RawRunRow,
  type RawScheduleRow,
  type RawTaskRow,
} from "./row-mapping.js";
import { isLessonTrigger, type LessonCreateInput, type LessonRow, type LessonTrigger } from "./lessons.js";
import {
  assertRuntimeLeaseTransition,
  canonicalizeRuntimeOwnerPaths,
  normalizeRuntimeMemberProvenance,
  normalizeRuntimeRequirementSpec,
  runtimeMembersHash,
  sha256RuntimeValue,
  type RuntimeBundleKind,
  type RuntimeCleanupDecisionClass,
  type RuntimeCleanupRequestStatus,
  type RuntimeCleanupPolicy,
  type RuntimeCleanupRequestRow,
  type RuntimeLeaseState,
  type RuntimeMemberKind,
  type RuntimeMemberState,
  type RuntimeResourceEventRow,
  type RuntimeResourceLeaseRow,
  type RuntimeResourceMemberRow,
  type RuntimeResourceRequirementRow,
  type RuntimeTerminalReason,
} from "./runtime-resources.js";
import { assertTransition, hasKnownReasonPrefix, isInProgressReason } from "./statemachine.js";
import { redactJsonStrings, redactMaybeJsonText, redactText } from "./redaction.js";
import { assertVerifyDirectiveAllowed } from "./verify-directive.js";
import type {
  AddBoardAuditEventInput,
  BoardAuditEventRow,
} from "./board-audit.js";
import {
  NATIVE_SUPERVISOR_SERVICE_ACTOR,
  nativeSessionBindingHash,
  resolveCommunicationRoute,
  type BeginNativeCommunicationDispatchInput,
  type ClaimNativeCommunicationAttemptInput,
  type CommunicationDeliveryAttemptRow,
  type CreateCommunicationAttemptInput,
  type CreateNativeSourceBindingInput,
  type CreateNativeTargetBindingInput,
  type NativeCommunicationStore,
  type NativeCommunicationRecoveryResult,
  type NativeCommunicationAddress,
  type NativeCommunicationConfigSnapshot,
  type NativeSessionBindingRow,
  type NativeCommunicationSocketSnapshot,
  type PromoteCommunicationAttemptToNativeInput,
  type RecordNativeCommunicationReceiptInput,
  type RebindRecordedNativeCommunicationAttemptInput,
} from "./communication.js";
import type {
  AssertDirectRestartIntentInput,
  CreateDirectRestartIntentInput,
  DirectRestartAuthorityStore,
  DirectRestartIntentRow,
} from "./execution-control.js";
import {
  EXTERNAL_RUNTIME_GENERATION_LANES,
  canonicalJson,
  externalRuntimeGenerationAttestationIsFresh,
  externalRuntimeGenerationDigest,
  externalRuntimeGenerationStatusIsFresh,
  parseExternalRuntimeGenerationStatus,
  validateExternalRuntimeGenerationAttestation,
  validateExternalRuntimeGenerationIdentity,
  validateExternalRuntimeGenerationStatus,
  type BindExternalRuntimeGenerationLaunchInput,
  type ExternalRuntimeGenerationBindingV1,
  type ExternalRuntimeGenerationIdentityV1,
  type ExternalRuntimeGenerationStatusAcceptance,
  type ExternalRuntimeGenerationStatusRecord,
  type ExternalRuntimeGenerationStore,
  type ValidatedExternalRuntimeGenerationStatus,
} from "./external-runtime-generation.js";
import {
  parseRelaySessionOwnershipRow,
  validateRelayDeliveryUncertainRecordInput,
  type RawTaskRunOwnershipRow,
  type RecordRelayDeliveryUncertainResult,
  type RelayControlPersistence,
  type RelayDeliveryUncertainRecordInput,
} from "./relay-control-persistence.js";
import type { RelaySessionOwnership } from "./relay-authorization.js";
import {
  HumanDecisionError,
  canonicalHumanDecisionJson,
  canonicalizeHumanDecisionAnswer,
  canonicalizeHumanDecisionAsk,
  canonicalizeHumanDecisionResolution,
  humanDecisionAnswerPayloadHash,
  humanDecisionAskPayloadHash,
  humanDecisionSha256,
  mapHumanDecisionRequestRow,
  normalizeHumanDecisionComment,
  requireHumanDecisionText,
  requireHumanDecisionTimestamp,
  assertHumanDecisionInputKeys,
  type AnswerHumanDecisionRequestInput,
  type CancelHumanDecisionRequestInput,
  type ClaimHumanDecisionResponseInput,
  type CreateHumanDecisionRequestInput,
  type HumanDecisionRequestRow,
  type HumanDecisionRequestStore,
  type RawHumanDecisionRequestRow,
  type ReleaseHumanDecisionResponseInput,
  type ResolveHumanDecisionResponseInput,
} from "./human-decision.js";
import {
  RelayAuthorityMutationError,
  mapRelayAuthorityInstallationRow,
  mapRelayRegistrationClaimRow,
  mapRelaySessionAuthorityRow,
  relayAuthorityAssertIssuePurpose,
  relayAuthorityCheckIssueConflict,
  relayAuthorityClaimFence,
  relayAuthorityClaimSecretMatches,
  relayAuthorityInstallationMatches,
  relayAuthorityNextCounter,
  relayOwnerFenceEquals,
  validateRelayActivateRegistrationInput,
  validateRelayAdoptInstallationInput,
  validateRelayAdvanceHostEpochInput,
  validateRelayIssueRegistrationClaimInput,
  validateRelayRetireRegistrationInput,
  type RawRelayAuthorityInstallationRow,
  type RawRelayRegistrationClaimRow,
  type RawRelaySessionAuthorityRow,
  type RelayAdoptInstallationInput,
  type RelayAdvanceHostEpochInput,
  type RelayAdvanceHostEpochResult,
  type RelayActivateRegistrationInput,
  type RelayActivateRegistrationResult,
  type RelayAuthorityBeforeMutation,
  type RelayAuthorityInstallation,
  type RelayIssueRegistrationClaimInput,
  type RelayOwnerAuthorityStore,
  type RelayRegistrationClaim,
  type RelayRetireRegistrationInput,
  type RelayRetireRegistrationResult,
  type RelaySessionAuthority,
} from "./relay-authority-store.js";
import type { RelayOwnerFence } from "./relay-registry.js";
import type {
  CreateSteerDeliveryInput,
  ObserveSteerDeliveryInput,
  SteerDeliveryRow,
  SteerDeliveryStatus,
} from "./steer.js";
import type {
  FencedCloseUncertainSuccessorInput,
  FencedCloseUncertainSuccessorResult,
  OrchestratorSuccessorFencedCloseStore,
} from "./orchestrator-successor-close.js";
import {
  STEWARD_PROPOSAL_KINDS,
  type ArmOrchestratorSuccessorLaunchInput,
  type AttestOrchestratorSuccessorLaunchInput,
  type AttestOrchestratorSuccessorLaunchResult,
  type BindOrchestratorSuccessorRuntimeInput,
  type ClaimOrchestratorSuccessorAcceptInput,
  type ClaimOrchestratorSuccessorAcceptResult,
  TASK_STATUSES,
  type ActorProvenance,
  type CommentRow,
  type EventRow,
  type EffortLevel,
  type ExecutionOverridePatch,
  type ExecutionRole,
  type HalfOpenOutboxEnqueueResult,
  type HalfOpenOutboxRow,
  type SessionBootSampleRow,
  type SessionUsageProfileRow,
  type HalfOpenOutboxStage,
  type KnowledgeRow,
  type KanbanStore,
  type LinkRow,
  type NotificationOutboxRow,
  type OrchestratorLivenessIncidentRow,
  type OrchestratorLivenessIncidentStatus,
  type OrchestratorRequestRow,
  type OrchestratorRoutingReconcileResult,
  type OrchestratorRow,
  type OrchestratorSessionRow,
  type OrchestratorSessionStatus,
  type OrchestratorSuccessorLaunchRow,
  type OrchestratorSuccessorLaunchStatus,
  type OrchestratorSuccessorLaunchStore,
  type OrchestratorSuccessorReplacementGate,
  type OrchestratorSuccessorStopEvidence,
  type OrchestratorWatchRole,
  type OrchestratorWatchRow,
  type OrchestratorWatchScope,
  type Provider,
  type ProviderSessionSource,
  type FinalizeOrchestratorSuccessorHandoffInput,
  type FinalizeOrchestratorSuccessorTakeoverInput,
  type MarkArmedOrchestratorSuccessorStopPendingInput,
  type MarkOrchestratorSuccessorStopPendingInput,
  type MarkOrchestratorSuccessorStopPendingResult,
  type RecordOrchestratorSuccessorStopInput,
  type ResolveUnboundOrchestratorSuccessorLaunchInput,
  type RollbackCompleteOrchestratorSuccessorLaunchInput,
  type RollbackCompleteOrchestratorSuccessorLaunchResult,
  type CreateRunCancelRequestInput,
  type RunCancelRequestRow,
  type RunCancelStatus,
  type RunMutationGate,
  type RunRow,
  type RunStatus,
  type ScheduleCadence,
  type ScheduleCreateInput,
  type ScheduleRow,
  type StewardProposalCreateResult,
  type StewardProposalDeliveryRow,
  type StewardProposalDeliveryStatus,
  type StewardProposalHealth,
  type StewardProposalKind,
  type StewardProposalRequestRow,
  type StewardProposalStatus,
  type TaskCreateInput,
  type TaskOrchestratorBindingRow,
  type TaskRow,
  type TaskStatus,
  type TransitionInput,
  type TransitionRunCancelRequestInput,
} from "./types.js";

export interface CreateFencedRunCancelRequestInput {
  taskId: string;
  expectedRunId?: number;
  expectedSessionId?: string;
  requestNonce: string;
  actor: string;
  reason: string;
  orchestratorId: string;
  requesterSessionId: string;
  requesterGeneration: number;
  deadlineAt: number;
}

export type FencedRunCancelRequestResult =
  | { targetMatched: "yes"; request: RunCancelRequestRow }
  | { targetMatched: "no"; request: null };

export interface FencedRunCancelRequestStore {
  createOrGetFencedRunCancelRequest(input: CreateFencedRunCancelRequestInput): FencedRunCancelRequestResult;
}

interface RawExternalRuntimeGenerationStatusRow {
  provider: string;
  lane: string;
  runtime_key: string;
  revision: number;
  canonical_digest: string;
  canonical_payload: string;
  accepted_at: number;
}

interface RawExternalRuntimeGenerationBindingRow {
  run_id: number;
  version: number;
  task_id: string;
  session_id: string;
  role: string;
  provider: string;
  transport: string;
  runtime_key: string;
  identity_json: string;
  bound_at: number;
}

function isExternalRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapExternalRuntimeGenerationStatusRow(
  row: RawExternalRuntimeGenerationStatusRow,
): ExternalRuntimeGenerationStatusRecord {
  if (row.provider !== "codex" && row.provider !== "claude") {
    throw new Error("external runtime generation status provider が不正です");
  }
  const parsed = parseExternalRuntimeGenerationStatus(row.canonical_payload, row.provider);
  if (
    parsed.status.lane !== row.lane || parsed.status.runtimeKey !== row.runtime_key ||
    parsed.status.revision !== row.revision || parsed.canonicalDigest !== row.canonical_digest ||
    !Number.isSafeInteger(row.accepted_at) || row.accepted_at < 0
  ) {
    throw new Error("external runtime generation status の durable row が不整合です");
  }
  return { ...parsed, acceptedAt: row.accepted_at };
}

function mapExternalRuntimeGenerationBindingRow(
  row: RawExternalRuntimeGenerationBindingRow,
): ExternalRuntimeGenerationBindingV1 {
  if (
    row.version !== 1 || (row.provider !== "codex" && row.provider !== "claude") ||
    (row.role !== "worker" && row.role !== "reviewer") ||
    (row.transport !== "bridge" && row.transport !== "direct")
  ) {
    throw new Error("external runtime generation binding の durable row が不正です");
  }
  const identity = validateExternalRuntimeGenerationIdentity(JSON.parse(row.identity_json) as unknown);
  const spec = EXTERNAL_RUNTIME_GENERATION_LANES[row.provider];
  const expectedSource = row.provider === "codex" ? "codex-applied-model" : "claude-runtime-model";
  if (
    row.runtime_key !== spec.runtimeKey || identity.modelReadbackSource !== expectedSource ||
    (row.provider === "codex" && identity.writerPid === identity.runtimePid) ||
    canonicalJson(identity) !== row.identity_json || !Number.isSafeInteger(row.bound_at) || row.bound_at < 0 ||
    !Number.isSafeInteger(row.run_id) || row.run_id <= 0
  ) {
    throw new Error("external runtime generation binding の durable row が不整合です");
  }
  return {
    version: 1,
    taskId: row.task_id,
    runId: row.run_id,
    sessionId: row.session_id,
    role: row.role,
    provider: row.provider,
    transport: row.transport,
    runtimeKey: row.runtime_key,
    identity,
    boundAt: row.bound_at,
  };
}

interface RawNativeSessionBindingRow {
  id: string;
  binding_key: string;
  kind: string;
  provider: string;
  host_id: string;
  provider_session_id: string;
  native_address: string;
  runtime_version: string;
  capability_hash: string;
  observed_at: number;
  expires_at: number;
  task_id: string;
  run_id: number | null;
  hachi_session_id: string;
  target_role: string;
  expected_cancel_fence: number | null;
  orchestrator_id: string;
  orchestrator_session_id: string;
  orchestrator_generation: number | null;
  status: string;
  created_at: number;
  updated_at: number;
  released_at: number | null;
}

interface RawCommunicationDeliveryAttemptRow {
  id: string;
  attempt_key: string;
  steer_delivery_id: string;
  source_binding_id: string | null;
  target_binding_id: string | null;
  preference: string;
  route: string;
  native_candidate: string;
  decision_reason: string;
  status: string;
  payload: string;
  config_hash: string;
  config_rollout: string;
  config_minimum_runtime_version: string;
  config_same_host_only: number | null;
  config_canary_percent: number | null;
  capability_hash: string;
  source_binding_hash: string;
  target_binding_hash: string;
  claimant_orchestrator_id: string;
  claimant_session_id: string;
  claimant_generation: number | null;
  claim_lease_until: number | null;
  attempt_nonce_hash: string;
  dispatching_at: number | null;
  receipt_id: string;
  last_error: string;
  actor_kind: string;
  actor_id: string;
  actor_session_id: string;
  actor_generation: number | null;
  created_at: number;
  updated_at: number;
  observed_at: number | null;
  acknowledged_at: number | null;
  resolved_at: number | null;
}

function mapNativeSessionBindingRow(row: RawNativeSessionBindingRow): NativeSessionBindingRow {
  return {
    id: row.id,
    bindingKey: row.binding_key,
    kind: row.kind as NativeSessionBindingRow["kind"],
    provider: row.provider as Provider,
    hostId: row.host_id,
    providerSessionId: row.provider_session_id,
    nativeAddress: row.native_address ?? "",
    runtimeVersion: row.runtime_version,
    capabilityHash: row.capability_hash,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
    taskId: row.task_id,
    runId: row.run_id,
    hachiSessionId: row.hachi_session_id,
    targetRole: row.target_role as NativeSessionBindingRow["targetRole"],
    expectedCancelFence: row.expected_cancel_fence,
    orchestratorId: row.orchestrator_id,
    orchestratorSessionId: row.orchestrator_session_id,
    orchestratorGeneration: row.orchestrator_generation,
    status: row.status as NativeSessionBindingRow["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    releasedAt: row.released_at,
  };
}

function mapCommunicationDeliveryAttemptRow(
  row: RawCommunicationDeliveryAttemptRow,
): CommunicationDeliveryAttemptRow {
  return {
    id: row.id,
    attemptKey: row.attempt_key,
    steerDeliveryId: row.steer_delivery_id,
    sourceBindingId: row.source_binding_id,
    targetBindingId: row.target_binding_id,
    preference: row.preference as CommunicationDeliveryAttemptRow["preference"],
    route: row.route as CommunicationDeliveryAttemptRow["route"],
    nativeCandidate: row.native_candidate as CommunicationDeliveryAttemptRow["nativeCandidate"],
    decisionReason: row.decision_reason as CommunicationDeliveryAttemptRow["decisionReason"],
    status: row.status as CommunicationDeliveryAttemptRow["status"],
    payload: row.payload,
    configHash: row.config_hash,
    configRollout: row.config_rollout as CommunicationDeliveryAttemptRow["configRollout"],
    configMinimumRuntimeVersion: row.config_minimum_runtime_version,
    configSameHostOnly: row.config_same_host_only === null ? null : row.config_same_host_only === 1,
    configCanaryPercent: row.config_canary_percent,
    capabilityHash: row.capability_hash,
    sourceBindingHash: row.source_binding_hash,
    targetBindingHash: row.target_binding_hash,
    claimantOrchestratorId: row.claimant_orchestrator_id,
    claimantSessionId: row.claimant_session_id,
    claimantGeneration: row.claimant_generation,
    claimLeaseUntil: row.claim_lease_until,
    attemptNonce: null,
    dispatchingAt: row.dispatching_at,
    receiptId: row.receipt_id,
    lastError: row.last_error,
    provenance: {
      kind: row.actor_kind as ActorProvenance["kind"],
      actorId: row.actor_id,
      actorSessionId: row.actor_session_id,
      actorGeneration: row.actor_generation,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    observedAt: row.observed_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
  };
}

function mapDirectRestartIntentRow(row: RawEventRow): DirectRestartIntentRow {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload) as unknown;
  } catch {
    throw new Error(`direct restart intent payloadが不正です: event=${String(row.id)}`);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`direct restart intent payloadがobjectではありません: event=${String(row.id)}`);
  }
  const value = payload as Record<string, unknown>;
  if (
    typeof value["intentKey"] !== "string" || value["intentKey"] === "" ||
    typeof value["runId"] !== "number" || !Number.isInteger(value["runId"]) || value["runId"] <= 0 ||
    typeof value["sessionId"] !== "string" || value["sessionId"] === "" ||
    typeof value["expectedCancelFence"] !== "number" || !Number.isInteger(value["expectedCancelFence"]) ||
    value["expectedCancelFence"] < 0 || value["transport"] !== "direct" ||
    row.actor_kind !== "orchestrator" || typeof row.actor_id !== "string" || row.actor_id === "" ||
    typeof row.actor_session_id !== "string" || row.actor_session_id === "" ||
    typeof row.actor_generation !== "number" || !Number.isInteger(row.actor_generation) || row.actor_generation <= 0
  ) {
    throw new Error(`direct restart intent eventのshapeが不正です: event=${String(row.id)}`);
  }
  return {
    id: row.id,
    intentKey: value["intentKey"],
    taskId: row.task_id,
    runId: value["runId"],
    sessionId: value["sessionId"],
    expectedCancelFence: value["expectedCancelFence"],
    provenance: {
      kind: "orchestrator",
      actorId: row.actor_id,
      actorSessionId: row.actor_session_id,
      actorGeneration: row.actor_generation,
    },
    createdAt: row.created_at,
  };
}

interface RawOrchestratorRow {
  id: string;
  label: string;
  project: string;
  repo_common_dir: string;
  created_at: number;
  updated_at: number;
}

interface RawBoardAuditEventRow {
  id: number;
  event_type: string;
  actor: string;
  payload: string;
  actor_kind: string;
  actor_id: string;
  actor_session_id: string;
  actor_generation: number | null;
  created_at: number;
}

function mapBoardAuditEventRow(row: RawBoardAuditEventRow): BoardAuditEventRow {
  const parsed = JSON.parse(row.payload) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`board audit payload が object ではありません: id=${row.id}`);
  }
  return {
    id: row.id,
    eventType: row.event_type,
    actor: row.actor,
    payload: parsed as Record<string, unknown>,
    provenance: {
      kind: row.actor_kind as ActorProvenance["kind"],
      actorId: row.actor_id,
      actorSessionId: row.actor_session_id,
      actorGeneration: row.actor_generation,
    },
    createdAt: row.created_at,
  };
}

interface RawSteerDeliveryRow {
  id: string;
  task_id: string;
  run_id: number;
  session_id: string;
  message_key: string;
  sequence: number;
  status: string;
  supersedes_id: string | null;
  expected_cancel_fence: number;
  observed_message_id: string;
  last_error: string;
  created_at: number;
  updated_at: number;
  observed_at: number | null;
  acknowledged_at: number | null;
  resolved_at: number | null;
}

function mapSteerDeliveryRow(row: RawSteerDeliveryRow): SteerDeliveryRow {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    sessionId: row.session_id,
    messageKey: row.message_key,
    sequence: row.sequence,
    status: row.status as SteerDeliveryStatus,
    supersedesId: row.supersedes_id,
    expectedCancelFence: row.expected_cancel_fence,
    observedMessageId: row.observed_message_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    observedAt: row.observed_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
  };
}

interface RawOrchestratorSessionRow {
  id: string;
  orchestrator_id: string;
  generation: number;
  provider: string;
  provider_session_id: string;
  provider_session_source: string;
  status: string;
  heartbeat_at: number;
  handoff_token_hash: string;
  handoff_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RawOrchestratorSuccessorLaunchRow {
  id: string;
  orchestrator_id: string;
  kind: string;
  target_provider: string;
  provider_session_source: string;
  source_session_id: string;
  source_generation: number;
  canonical_cwd: string;
  host_id: string;
  launch_nonce_hash: string;
  planned_tmux_session: string;
  tmux_session: string;
  tmux_pane: string;
  pane_pid: number | null;
  process_group_id: number | null;
  tmux_socket_path: string;
  tmux_server_pid: number | null;
  tmux_server_start_time: number | null;
  tmux_server_lifetime_hash: string;
  owner_nonce_hash: string;
  runtime_ownership_claimed: number;
  runtime_bound_at: number | null;
  observed_canonical_cwd: string;
  observed_host_id: string;
  observed_hook_definition_hash: string;
  observed_hook_executable_hash: string;
  hook_definition_hash: string;
  hook_executable_hash: string;
  provider_session_id: string;
  attestation_handle_hash: string;
  attestation_issued_at: number | null;
  attestation_expires_at: number | null;
  attestation_consumed_at: number | null;
  handoff_token_fence_hash: string;
  handoff_expires_at: number | null;
  takeover_stale_before: number | null;
  cancel_fence: number;
  accept_fence_hash: string;
  stop_fence_hash: string;
  revision: number;
  barrier_release_authorized_at: number | null;
  runtime_deadline_at: number;
  attestation_deadline_at: number;
  kill_owner_readback_hash: string;
  stop_owner_matched: number | null;
  stop_owner_readback_at: number | null;
  stop_kill_result: string;
  stop_tmux_session_absent: number | null;
  stop_pane_pid_absent: number | null;
  stop_process_group_absent: number | null;
  stop_observed_at: number | null;
  successor_session_id: string;
  successor_generation: number | null;
  status: string;
  last_error: string;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

interface RawOrchestratorSuccessorCapabilityRow {
  launch_id: string;
  attestation_handle: string;
  accept_fence: string;
  stop_fence: string;
}

interface RawOrchestratorLivenessIncidentRow {
  id: number;
  session_id: string;
  orchestrator_id: string;
  generation: number;
  provider: string;
  provider_session_id: string;
  gap_seconds: number;
  detected_at: number;
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string;
  sent_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RawOrchestratorWatchRow {
  id: string;
  orchestrator_id: string;
  scope: string;
  selector: string;
  role: string;
  priority: number;
  active: number;
  created_at: number;
  updated_at: number;
}

interface RawTaskOrchestratorBindingRow {
  task_id: string;
  orchestrator_id: string;
  role: string;
  created_at: number;
  released_at: number | null;
}

interface RawOrchestratorRequestRow {
  id: string;
  task_id: string;
  question_id: string;
  kind: string;
  status: string;
  question: string;
  context: string;
  worktree: string;
  project: string;
  claimant_session_id: string;
  claimant_generation: number | null;
  claim_token: string;
  lease_until: number | null;
  answer_key: string;
  escalation_generation: number;
  human_answer: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

interface RawOrchestratorDeliveryRow {
  id: number;
  request_id: string;
  orchestrator_id: string;
  watch_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

interface RawStewardProposalRequestRow {
  id: string;
  task_id: string;
  kind: string;
  reason: string;
  routed_by: string;
  status: string;
  claimant_session_id: string;
  claimant_generation: number | null;
  claim_token_hash: string;
  claim_lease_until: number | null;
  defer_until: number | null;
  dismissed_at: number | null;
  dismiss_count: number;
  accepted_task_status: string;
  resolution_reason: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

interface RawStewardProposalDeliveryRow {
  id: number;
  request_id: string;
  orchestrator_id: string;
  watch_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

interface RawNotificationOutboxRow {
  id: number;
  task_id: string;
  request_id: string;
  dedupe_key: string;
  kind: string;
  transport: string;
  payload: string;
  sent_transports: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
  updated_at: number;
}

interface RawRuntimeResourceOutboxRow {
  id: number;
  lease_id: string;
  request_id: string | null;
  dedupe_key: string;
  kind: string;
  transport: string;
  payload: string;
  sent_transports: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
  updated_at: number;
}

/** half_open_outbox の生行（契約 §40.1.1） */
interface RawHalfOpenOutboxRow {
  id: string;
  stage: string;
  claim_generation: number;
  dedupe_key: string;
  kind: string;
  payload: string;
  sent_transports: string;
  status: string;
  attempts: number;
  next_attempt_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RawRuntimeRequirementRow {
  id: string;
  task_id: string;
  name: string;
  bundle_kind: string;
  spec: string;
  status: string;
  lease_id: string;
  idempotency_key: string;
  created_at: number;
  updated_at: number;
}

interface RawRuntimeLeaseRow {
  id: string;
  bundle_kind: string;
  state: string;
  cleanup_policy: string;
  managed: number;
  ephemeral: number;
  owner_task_id: string | null;
  owner_run_id: number | null;
  controller_orchestrator_id: string | null;
  board: string;
  project: string;
  repo_common_dir: string;
  canonical_worktree: string;
  fence: number;
  heartbeat_at: number | null;
  expires_at: number | null;
  terminal_reason: string;
  provenance_version: number;
  rollout_generation: number;
  created_at: number;
  updated_at: number;
  released_at: number | null;
}

interface RawRuntimeMemberRow {
  id: string;
  lease_id: string;
  kind: string;
  state: string;
  cleanup_policy: string;
  managed: number;
  ephemeral: number;
  object_fence: number;
  scope_key: string;
  native_id: string;
  display_name: string;
  host_ip: string;
  host_port: number | null;
  container_port: number | null;
  compose_project: string;
  labels_hash: string;
  provenance: string;
  provenance_verified_at: number | null;
  last_observed_at: number;
  released_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RawRuntimeCleanupRequestRow {
  id: string;
  lease_id: string;
  decision_class: string;
  reason: string;
  status: string;
  expected_lease_fence: number;
  expected_members_hash: string;
  claimant_session_id: string;
  claimant_generation: number | null;
  claim_token_hash: string;
  claim_lease_until: number | null;
  approved_by: string;
  approval_generation: number | null;
  executor_id: string;
  executor_generation: number;
  executor_lease_until: number | null;
  execution_nonce: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string;
  escalation_generation: number;
  human_answer: string;
  human_answer_nonce_hash: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

/** host supervisor の cleanup executor が保持する durable attempt。共有 types.ts は凍結のため本実装面に置く。 */
export interface RuntimeCleanupExecutionAttempt {
  request: RuntimeCleanupRequestRow;
  lease: RuntimeResourceLeaseRow;
  members: RuntimeResourceMemberRow[];
  executionNonce: string;
  executorGeneration: number;
  recovery: boolean;
  /** 旧 attempt で external effect 開始が durable に確認できた exact member ID。 */
  recoveryMemberIds: string[];
}

interface RuntimeCleanupEffectEvidence {
  memberId: string;
  kind: RuntimeMemberKind;
  nativeId: string;
  objectFence: number;
}

function parseRuntimeCleanupAttemptResult(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function runtimeCleanupEffectEvidence(value: string): RuntimeCleanupEffectEvidence[] {
  const entries = parseRuntimeCleanupAttemptResult(value).effectStartedMembers;
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.filter((entry): entry is RuntimeCleanupEffectEvidence => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return false;
    }
    const candidate = entry as Record<string, unknown>;
    return typeof candidate.memberId === "string" && typeof candidate.kind === "string" &&
      typeof candidate.nativeId === "string" && typeof candidate.objectFence === "number";
  });
}

export interface RuntimeCleanupExecutionFence {
  requestId: string;
  executionNonce: string;
  executorId: string;
  executorGeneration: number;
  expectedLeaseFence: number;
  expectedMembersHash: string;
}

interface RawRuntimeResourceEventRow {
  id: number;
  lease_id: string;
  request_id: string | null;
  event_type: string;
  actor: string;
  payload: string;
  idempotency_key: string;
  created_at: number;
}

export interface WatchedStatusChangedEvent {
  event: EventRow;
  task: TaskRow;
  from: TaskStatus;
  to: TaskStatus;
  reason: string;
}

interface WatchedStatusChangedEventSource {
  listWatchedStatusChangedEventsAfter(afterEventId: number, limit?: number): WatchedStatusChangedEvent[];
}

/**
 * createTask で許可される初期 status（docs/contract.md §12.8-5）。
 * KanbanStore は全パッケージ共有の唯一の書込パスのため、CLI 側の検証だけでなく
 * core 自体でも blocked/done 等の不変条件を満たさない初期状態の作成を fail-closed で拒否する。
 */
const CREATABLE_STATUSES: readonly TaskStatus[] = ["triage", "todo", "ready"];

/** listMessageFenceComments の既定 limit（docs/contract.md §12.6-5） */
const MESSAGE_FENCE_SCAN_DEFAULT_LIMIT = 200;

// DB 行の生型（snake_case）と map*Row（→ camelCase）は row-mapping.ts に集約（readview.ts と共有）

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && TASK_STATUSES.includes(value as TaskStatus);
}

function parseStatusChangedPayload(payload: string): { from: TaskStatus; to: TaskStatus; reason: string } | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (!isTaskStatus(record.from) || !isTaskStatus(record.to)) {
      return null;
    }
    return {
      from: record.from,
      to: record.to,
      reason: typeof record.reason === "string" ? record.reason : "",
    };
  } catch {
    return null;
  }
}

export function listWatchedStatusChangedEventsAfter(
  store: KanbanStore,
  afterEventId: number,
  limit?: number,
): WatchedStatusChangedEvent[] {
  const candidate = store as { listWatchedStatusChangedEventsAfter?: unknown };
  if (typeof candidate.listWatchedStatusChangedEventsAfter !== "function") {
    throw new Error("この store は watched status_changed 走査に対応していません");
  }
  const source = store as unknown as WatchedStatusChangedEventSource;
  return source.listWatchedStatusChangedEventsAfter(afterEventId, limit);
}

/** 't_' + 16 hex（64bit ランダム）。契約 §12.7-5（旧 8 hex から拡張） */
function generateTaskId(): string {
  return `t_${randomBytes(8).toString("hex")}`;
}

/** 's_' + 16 hex（64bit ランダム）。contract §29.1 */
function generateScheduleId(): string {
  return `s_${randomBytes(8).toString("hex")}`;
}

/** 'k_' + 12 hex（48bit ランダム）。docs/contract.md §47.1 */
function generateKnowledgeId(): string {
  return `k_${randomBytes(6).toString("hex")}`;
}

function generateRoutingId(prefix: "o" | "os" | "ow" | "or" | "sp" | "osl"): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function generateRuntimeId(prefix: "rr" | "rl" | "rm" | "rc" | "sd" | "nsb" | "cda" | "hoo"): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function mapOrchestratorRow(row: RawOrchestratorRow): OrchestratorRow {
  return {
    id: row.id,
    label: row.label,
    project: row.project,
    repoCommonDir: row.repo_common_dir,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOrchestratorSessionRow(row: RawOrchestratorSessionRow): OrchestratorSessionRow {
  return {
    id: row.id,
    orchestratorId: row.orchestrator_id,
    generation: row.generation,
    provider: row.provider as Provider | "",
    providerSessionId: row.provider_session_id,
    providerSessionSource: (row.provider_session_source ?? "") as ProviderSessionSource | "",
    status: row.status as OrchestratorSessionStatus,
    heartbeatAt: row.heartbeat_at,
    handoffTokenHash: row.handoff_token_hash,
    handoffExpiresAt: row.handoff_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNullableBoolean(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}

function mapOrchestratorSuccessorLaunchRow(
  row: RawOrchestratorSuccessorLaunchRow,
): OrchestratorSuccessorLaunchRow {
  return {
    id: row.id,
    orchestratorId: row.orchestrator_id,
    kind: row.kind as OrchestratorSuccessorLaunchRow["kind"],
    targetProvider: row.target_provider as Provider,
    providerSessionSource: (row.provider_session_source ?? "") as ProviderSessionSource | "",
    sourceSessionId: row.source_session_id,
    sourceGeneration: row.source_generation,
    canonicalCwd: row.canonical_cwd,
    hostId: row.host_id,
    launchNonceHash: row.launch_nonce_hash,
    plannedTmuxSession: row.planned_tmux_session,
    tmuxSession: row.tmux_session,
    tmuxPane: row.tmux_pane,
    panePid: row.pane_pid,
    processGroupId: row.process_group_id,
    tmuxSocketPath: row.tmux_socket_path,
    tmuxServerPid: row.tmux_server_pid,
    tmuxServerStartTime: row.tmux_server_start_time,
    tmuxServerLifetimeHash: row.tmux_server_lifetime_hash,
    ownerNonceHash: row.owner_nonce_hash,
    runtimeOwnershipClaimed: row.runtime_ownership_claimed === 1,
    runtimeBoundAt: row.runtime_bound_at,
    observedCanonicalCwd: row.observed_canonical_cwd,
    observedHostId: row.observed_host_id,
    observedHookDefinitionHash: row.observed_hook_definition_hash,
    observedHookExecutableHash: row.observed_hook_executable_hash,
    hookDefinitionHash: row.hook_definition_hash,
    hookExecutableHash: row.hook_executable_hash,
    providerSessionId: row.provider_session_id,
    attestationHandleHash: row.attestation_handle_hash,
    attestationIssuedAt: row.attestation_issued_at,
    attestationExpiresAt: row.attestation_expires_at,
    attestationConsumedAt: row.attestation_consumed_at,
    handoffTokenFenceHash: row.handoff_token_fence_hash,
    handoffExpiresAt: row.handoff_expires_at,
    takeoverStaleBefore: row.takeover_stale_before,
    cancelFence: row.cancel_fence,
    acceptFenceHash: row.accept_fence_hash,
    stopFenceHash: row.stop_fence_hash,
    revision: row.revision,
    barrierReleaseAuthorizedAt: row.barrier_release_authorized_at,
    runtimeDeadlineAt: row.runtime_deadline_at,
    attestationDeadlineAt: row.attestation_deadline_at,
    killOwnerReadbackHash: row.kill_owner_readback_hash,
    stopEvidence: {
      ownerMatched: mapNullableBoolean(row.stop_owner_matched),
      ownerReadbackAt: row.stop_owner_readback_at,
      killResult: row.stop_kill_result as OrchestratorSuccessorStopEvidence["killResult"],
      tmuxSessionAbsent: mapNullableBoolean(row.stop_tmux_session_absent),
      panePidAbsent: mapNullableBoolean(row.stop_pane_pid_absent),
      processGroupAbsent: mapNullableBoolean(row.stop_process_group_absent),
      observedAt: row.stop_observed_at,
    },
    successorSessionId: row.successor_session_id,
    successorGeneration: row.successor_generation,
    status: row.status as OrchestratorSuccessorLaunchStatus,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  };
}

function mapOrchestratorLivenessIncidentRow(
  row: RawOrchestratorLivenessIncidentRow,
): OrchestratorLivenessIncidentRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    orchestratorId: row.orchestrator_id,
    generation: row.generation,
    provider: row.provider as Provider | "",
    providerSessionId: row.provider_session_id,
    gapSeconds: row.gap_seconds,
    detectedAt: row.detected_at,
    status: row.status as OrchestratorLivenessIncidentStatus,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    sentAt: row.sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOrchestratorWatchRow(row: RawOrchestratorWatchRow): OrchestratorWatchRow {
  return {
    id: row.id,
    orchestratorId: row.orchestrator_id,
    scope: row.scope as OrchestratorWatchScope,
    selector: row.selector,
    role: row.role as OrchestratorWatchRole,
    priority: row.priority,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskOrchestratorBindingRow(row: RawTaskOrchestratorBindingRow): TaskOrchestratorBindingRow {
  return {
    taskId: row.task_id,
    orchestratorId: row.orchestrator_id,
    role: row.role as OrchestratorWatchRole,
    createdAt: row.created_at,
    releasedAt: row.released_at,
  };
}

function mapOrchestratorRequestRow(row: RawOrchestratorRequestRow): OrchestratorRequestRow {
  return {
    id: row.id,
    taskId: row.task_id,
    questionId: row.question_id,
    kind: row.kind,
    status: row.status as OrchestratorRequestRow["status"],
    question: row.question,
    context: row.context,
    worktree: row.worktree,
    project: row.project,
    claimantSessionId: row.claimant_session_id,
    claimantGeneration: row.claimant_generation,
    claimToken: row.claim_token,
    leaseUntil: row.lease_until,
    answerKey: row.answer_key,
    escalationGeneration: row.escalation_generation,
    humanAnswer: row.human_answer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function mapNotificationOutboxRow(row: RawNotificationOutboxRow): NotificationOutboxRow {
  let sentTransports: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.sent_transports);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
      sentTransports = parsed;
    }
  } catch {
    sentTransports = [];
  }
  return {
    id: row.id,
    taskId: row.task_id,
    requestId: row.request_id,
    dedupeKey: row.dedupe_key,
    kind: row.kind as NotificationOutboxRow["kind"],
    transport: row.transport,
    payload: row.payload,
    sentTransports,
    status: row.status as NotificationOutboxRow["status"],
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** runtime resource outbox 行の公開型 */
export interface RuntimeResourceOutboxRow {
  id: number;
  leaseId: string;
  requestId: string | null;
  dedupeKey: string;
  kind: string;
  transport: string;
  payload: string;
  sentTransports: string[];
  status: "pending" | "sent" | "failed";
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
}

function mapRuntimeResourceOutboxRow(row: RawRuntimeResourceOutboxRow): RuntimeResourceOutboxRow {
  return {
    id: row.id,
    leaseId: row.lease_id,
    requestId: row.request_id,
    dedupeKey: row.dedupe_key,
    kind: row.kind,
    transport: row.transport,
    payload: row.payload,
    sentTransports: JSON.parse(row.sent_transports) as string[],
    status: row.status as RuntimeResourceOutboxRow["status"],
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHalfOpenOutboxRow(row: RawHalfOpenOutboxRow): HalfOpenOutboxRow {
  return {
    id: row.id,
    stage: row.stage as HalfOpenOutboxRow["stage"],
    claimGeneration: row.claim_generation,
    dedupeKey: row.dedupe_key,
    kind: row.kind,
    payload: row.payload,
    sentTransports: JSON.parse(row.sent_transports) as string[],
    status: row.status as HalfOpenOutboxRow["status"],
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRuntimeRequirementRow(row: RawRuntimeRequirementRow): RuntimeResourceRequirementRow {
  return {
    id: row.id,
    taskId: row.task_id,
    name: row.name,
    bundleKind: row.bundle_kind as RuntimeResourceRequirementRow["bundleKind"],
    spec: row.spec,
    status: row.status as RuntimeResourceRequirementRow["status"],
    leaseId: row.lease_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRuntimeLeaseRow(row: RawRuntimeLeaseRow): RuntimeResourceLeaseRow {
  return {
    id: row.id,
    bundleKind: row.bundle_kind as RuntimeBundleKind,
    state: row.state as RuntimeLeaseState,
    cleanupPolicy: row.cleanup_policy as RuntimeCleanupPolicy,
    managed: row.managed === 1,
    ephemeral: row.ephemeral === 1,
    ownerTaskId: row.owner_task_id,
    ownerRunId: row.owner_run_id,
    controllerOrchestratorId: row.controller_orchestrator_id,
    board: row.board,
    project: row.project,
    repoCommonDir: row.repo_common_dir,
    canonicalWorktree: row.canonical_worktree,
    fence: row.fence,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    terminalReason: row.terminal_reason as RuntimeTerminalReason,
    provenanceVersion: row.provenance_version,
    rolloutGeneration: row.rollout_generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    releasedAt: row.released_at,
  };
}

function mapRuntimeMemberRow(row: RawRuntimeMemberRow): RuntimeResourceMemberRow {
  return {
    id: row.id,
    leaseId: row.lease_id,
    kind: row.kind as RuntimeMemberKind,
    state: row.state as RuntimeMemberState,
    cleanupPolicy: row.cleanup_policy as RuntimeCleanupPolicy,
    managed: row.managed === 1,
    ephemeral: row.ephemeral === 1,
    objectFence: row.object_fence,
    scopeKey: row.scope_key,
    nativeId: row.native_id,
    displayName: row.display_name,
    hostIp: row.host_ip,
    hostPort: row.host_port,
    containerPort: row.container_port,
    composeProject: row.compose_project,
    labelsHash: row.labels_hash,
    provenance: row.provenance,
    provenanceVerifiedAt: row.provenance_verified_at,
    lastObservedAt: row.last_observed_at,
    releasedAt: row.released_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRuntimeCleanupRequestRow(row: RawRuntimeCleanupRequestRow): RuntimeCleanupRequestRow {
  return {
    id: row.id,
    leaseId: row.lease_id,
    decisionClass: row.decision_class as RuntimeCleanupDecisionClass,
    reason: row.reason,
    status: row.status as RuntimeCleanupRequestRow["status"],
    expectedLeaseFence: row.expected_lease_fence,
    expectedMembersHash: row.expected_members_hash,
    claimantSessionId: row.claimant_session_id,
    claimantGeneration: row.claimant_generation,
    claimTokenHash: row.claim_token_hash,
    claimLeaseUntil: row.claim_lease_until,
    approvedBy: row.approved_by,
    approvalGeneration: row.approval_generation,
    executorId: row.executor_id,
    executorGeneration: row.executor_generation,
    executorLeaseUntil: row.executor_lease_until,
    executionNonce: row.execution_nonce,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    escalationGeneration: row.escalation_generation,
    humanAnswer: row.human_answer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function mapStewardProposalRequestRow(row: RawStewardProposalRequestRow): StewardProposalRequestRow {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind as StewardProposalKind,
    reason: row.reason,
    routedBy: row.routed_by === "" ? null : "tenant-default",
    status: row.status as StewardProposalStatus,
    claimantSessionId: row.claimant_session_id,
    claimantGeneration: row.claimant_generation,
    claimTokenHash: row.claim_token_hash,
    claimLeaseUntil: row.claim_lease_until,
    deferUntil: row.defer_until,
    dismissedAt: row.dismissed_at,
    dismissCount: row.dismiss_count,
    acceptedTaskStatus: row.accepted_task_status,
    resolutionReason: row.resolution_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function mapStewardProposalDeliveryRow(row: RawStewardProposalDeliveryRow): StewardProposalDeliveryRow {
  return {
    id: row.id,
    requestId: row.request_id,
    orchestratorId: row.orchestrator_id,
    watchId: row.watch_id,
    status: row.status as StewardProposalDeliveryStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRuntimeResourceEventRow(row: RawRuntimeResourceEventRow): RuntimeResourceEventRow {
  return {
    id: row.id,
    leaseId: row.lease_id,
    requestId: row.request_id,
    eventType: row.event_type,
    actor: row.actor,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

/** タスクID採番の PK 衝突時の最大再試行回数（契約 §12.7-5） */
const TASK_ID_COLLISION_MAX_RETRIES = 5;

/** スケジュールID採番の PK 衝突時の最大再試行回数 */
const SCHEDULE_ID_COLLISION_MAX_RETRIES = 5;
const KNOWLEDGE_ID_COLLISION_MAX_RETRIES = 5;
const SCHEDULE_FIRE_CLAIM_LOST_MESSAGE = "スケジュール発火は既に claim 済みです";

/** better-sqlite3 が PRIMARY KEY 制約違反時に投げるエラーかどうかを判定する */
function isPrimaryKeyConstraintError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  );
}

/** better-sqlite3 が UNIQUE 制約違反時に投げるエラーかどうかを判定する（docs/contract.md §12.9-1） */
function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error && "code" in err && (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/** docs/contract.md §5 の DDL（migration version 1） */
const MIGRATION_V1_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'triage',
  priority INTEGER NOT NULL DEFAULT 0,
  tenant TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL DEFAULT '',
  model_override TEXT NOT NULL DEFAULT '',
  block_reason TEXT NOT NULL DEFAULT '',
  claim_lock TEXT NOT NULL DEFAULT '',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_error TEXT NOT NULL DEFAULT '',
  last_heartbeat_at INTEGER,
  max_retries INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  actor_kind TEXT NOT NULL DEFAULT 'unknown' CHECK(actor_kind IN ('human', 'orchestrator', 'service', 'unknown')),
  actor_id TEXT NOT NULL DEFAULT '',
  actor_session_id TEXT NOT NULL DEFAULT '',
  actor_generation INTEGER CHECK(actor_generation IS NULL OR actor_generation > 0),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  actor_kind TEXT NOT NULL DEFAULT 'unknown' CHECK(actor_kind IN ('human', 'orchestrator', 'service', 'unknown')),
  actor_id TEXT NOT NULL DEFAULT '',
  actor_session_id TEXT NOT NULL DEFAULT '',
  actor_generation INTEGER CHECK(actor_generation IS NULL OR actor_generation > 0),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  meta TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS task_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id TEXT NOT NULL REFERENCES tasks(id),
  child_id TEXT NOT NULL REFERENCES tasks(id),
  link_type TEXT NOT NULL DEFAULT 'subtask',
  created_at INTEGER NOT NULL,
  UNIQUE(parent_id, child_id, link_type)
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

/**
 * task_events.payload から idempotencyKey を安全に抽出する式（docs/contract.md §12.16-2）。
 * malformed（不正 JSON）な payload に素の json_extract を使うと SQLite が例外を投げ、
 * その行が式インデックスの対象になった瞬間に INSERT/UPDATE/CREATE INDEX が失敗して DB が
 * 起動不能になる。json_valid で保護し、malformed 行は NULL 扱いにする（フェイルセーフ）。
 * 式インデックス（idx_events_idem / idx_events_idem_unique）とクエリ側の式は完全一致させる
 * 必要がある（SQLite の式インデックスはテキスト一致でのみクエリオプティマイザに使われる）ため、
 * この文字列定数を唯一の定義とし、DDL・クエリの両方で必ずこれを使う。
 */
const IDEMPOTENCY_KEY_EXPR = "CASE WHEN json_valid(payload) THEN json_extract(payload, '$.idempotencyKey') END";

/** docs/contract.md §12.5-4 の追加インデックス（migration version 2）
 * idx_events_idem の式は hasProcessedMessage() のクエリと完全に一致させる
 * （SQLite の式インデックスはクエリオプティマイザに使われるために式のテキスト一致が必要） */
const MIGRATION_V2_SQL = `
CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority);
CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id, id);
CREATE INDEX IF NOT EXISTS idx_events_task_type ON task_events(task_id, event_type, id);
CREATE INDEX IF NOT EXISTS idx_events_idem ON task_events(event_type, ${IDEMPOTENCY_KEY_EXPR});
CREATE INDEX IF NOT EXISTS idx_runs_task_status ON task_runs(task_id, status);
`;

/** docs/contract.md §12.9-1 の部分 UNIQUE 式インデックス（migration version 3）
 * メッセージ冪等キーの DB レベル保証。アプリ層の check-then-mark（hasProcessedMessage → markMessageProcessed）
 * との二重防御として、同一 idempotencyKey の message_processed イベントを DB レベルでも一意に強制する。
 * 非 unique の idx_events_idem（v2）はクエリ最適化用に残す */
const MIGRATION_V3_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem_unique ON task_events(${IDEMPOTENCY_KEY_EXPR}) WHERE event_type = 'message_processed';
`;

/** docs/contract.md §43.1 の tick_metrics テーブル（migration version 6） */
const MIGRATION_V6_SQL = `
CREATE TABLE IF NOT EXISTS tick_metrics (
  ts INTEGER NOT NULL CHECK(ts >= 0),
  stage TEXT NOT NULL CHECK(length(stage) > 0),
  actions INTEGER NOT NULL CHECK(actions >= 0),
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0)
);
CREATE INDEX IF NOT EXISTS idx_tick_metrics_ts_stage ON tick_metrics(ts, stage);
`;

/** docs/contract.md §44.1 の lessons テーブル（migration version 7） */
const MIGRATION_V7_SQL = `
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK(trigger IN ('rework', 'user-decision', 'needs-manual')),
  tenant TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  source_task_id TEXT NOT NULL REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS idx_lessons_tenant_created ON lessons(tenant, created_at DESC, id DESC);
`;

/** docs/contract.md §46.1 の watched 列（migration version 8） */
const MIGRATION_V8_SQL = `
ALTER TABLE tasks ADD COLUMN watched INTEGER NOT NULL DEFAULT 0 CHECK(watched IN (0, 1));
`;

/** docs/contract.md §47.1 の knowledge テーブル（migration version 9） */
const MIGRATION_V9_SQL = `
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY CHECK(id GLOB 'k_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  title TEXT NOT NULL CHECK(length(title) > 0),
  body TEXT NOT NULL CHECK(length(body) > 0),
  source TEXT NOT NULL CHECK(length(source) > 0),
  tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags) AND json_type(tags) = 'array'),
  importance INTEGER NOT NULL DEFAULT 50 CHECK(importance >= 0 AND importance <= 100),
  expires_at INTEGER CHECK(expires_at IS NULL OR expires_at >= 0),
  origin_path TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL UNIQUE CHECK(length(content_hash) = 64),
  actor TEXT NOT NULL DEFAULT '',
  actor_kind TEXT NOT NULL DEFAULT 'unknown' CHECK(actor_kind IN ('human', 'orchestrator', 'service', 'unknown')),
  actor_id TEXT NOT NULL DEFAULT '',
  actor_session_id TEXT NOT NULL DEFAULT '',
  actor_generation INTEGER CHECK(actor_generation IS NULL OR actor_generation > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_source_importance ON knowledge(source, importance DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_expires_importance ON knowledge(expires_at, importance DESC, created_at DESC);
`;

/** docs/contract.md §49.3 の effort_override 列（migration version 10） */
const MIGRATION_V10_SQL = `
ALTER TABLE tasks ADD COLUMN effort_override TEXT NOT NULL DEFAULT '';
`;

/** contract §55 のオーケストレータールーティング（migration version 11） */
const MIGRATION_V11_SQL = `
CREATE TABLE IF NOT EXISTS orchestrators (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK(length(label) > 0),
  project TEXT NOT NULL DEFAULT '',
  repo_common_dir TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orchestrator_sessions (
  id TEXT PRIMARY KEY,
  orchestrator_id TEXT NOT NULL REFERENCES orchestrators(id),
  generation INTEGER NOT NULL CHECK(generation > 0),
  provider TEXT NOT NULL DEFAULT '' CHECK(provider IN ('', 'codex', 'claude')),
  provider_session_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('active', 'handoff_pending', 'superseded', 'stale', 'closed')),
  heartbeat_at INTEGER NOT NULL,
  handoff_token_hash TEXT NOT NULL DEFAULT '',
  handoff_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(orchestrator_id, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestrator_one_live_session
  ON orchestrator_sessions(orchestrator_id)
  WHERE status IN ('active', 'handoff_pending');
CREATE INDEX IF NOT EXISTS idx_orchestrator_sessions_heartbeat ON orchestrator_sessions(status, heartbeat_at);
CREATE TABLE IF NOT EXISTS orchestrator_watches (
  id TEXT PRIMARY KEY,
  orchestrator_id TEXT NOT NULL REFERENCES orchestrators(id),
  scope TEXT NOT NULL CHECK(scope IN ('task', 'subtree', 'worktree', 'project')),
  selector TEXT NOT NULL CHECK(length(selector) > 0),
  role TEXT NOT NULL CHECK(role IN ('primary', 'collaborator', 'observer')),
  priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(orchestrator_id, scope, selector, role)
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_watches_match ON orchestrator_watches(active, scope, selector, priority DESC);
CREATE TABLE IF NOT EXISTS task_orchestrator_bindings (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  orchestrator_id TEXT NOT NULL REFERENCES orchestrators(id),
  role TEXT NOT NULL CHECK(role IN ('primary', 'collaborator', 'observer')),
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY(task_id, orchestrator_id)
);
CREATE INDEX IF NOT EXISTS idx_task_orchestrator_active ON task_orchestrator_bindings(task_id, released_at);
CREATE TABLE IF NOT EXISTS orchestrator_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  question_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'worker_question',
  status TEXT NOT NULL CHECK(status IN ('queued', 'delivered', 'claimed', 'answering', 'waiting_human', 'resolved', 'cancelled')),
  question TEXT NOT NULL CHECK(length(question) > 0),
  context TEXT NOT NULL DEFAULT '',
  worktree TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  claimant_session_id TEXT NOT NULL DEFAULT '',
  claimant_generation INTEGER,
  claim_token TEXT NOT NULL DEFAULT '',
  lease_until INTEGER,
  answer_key TEXT NOT NULL DEFAULT '',
  escalation_generation INTEGER NOT NULL DEFAULT 0,
  human_answer TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_requests_status ON orchestrator_requests(status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_orchestrator_requests_task ON orchestrator_requests(task_id, status, created_at DESC);
CREATE TABLE IF NOT EXISTS orchestrator_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES orchestrator_requests(id),
  orchestrator_id TEXT NOT NULL REFERENCES orchestrators(id),
  watch_id TEXT REFERENCES orchestrator_watches(id),
  status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'acknowledged', 'dismissed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(request_id, orchestrator_id)
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_deliveries_target ON orchestrator_deliveries(orchestrator_id, status, created_at);
CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  request_id TEXT NOT NULL REFERENCES orchestrator_requests(id),
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('orchestrator_fyi', 'human_question', 'orchestrator_unavailable')),
  transport TEXT NOT NULL DEFAULT 'configured',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending ON notification_outbox(status, next_attempt_at, id);
`;

/** contract §55.4 のtransport別outbox再試行 + stable identity重複防止（migration version 12） */
const MIGRATION_V12_SENT_TRANSPORTS_SQL = `
ALTER TABLE notification_outbox ADD COLUMN sent_transports TEXT NOT NULL DEFAULT '[]';
`;
const MIGRATION_V12_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestrators_stable_identity
  ON orchestrators(label, project, repo_common_dir);
`;

/** contract §56 の runtime resource lease 永続面（migration version 13） */
const MIGRATION_V13_SQL = `
CREATE TABLE IF NOT EXISTS runtime_resource_requirements (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  name TEXT NOT NULL CHECK(length(name) > 0),
  bundle_kind TEXT NOT NULL CHECK(bundle_kind IN (
    'worktree_postgres', 'worktree_preview', 'shared_main_db_exception'
  )),
  spec TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK(status IN ('pending', 'provisioning', 'ready', 'failed', 'cancelled')),
  lease_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(task_id, name)
);
CREATE INDEX IF NOT EXISTS idx_runtime_requirements_dispatch
  ON runtime_resource_requirements(status, updated_at, task_id);

CREATE TABLE IF NOT EXISTS runtime_resource_leases (
  id TEXT PRIMARY KEY,
  bundle_kind TEXT NOT NULL CHECK(bundle_kind IN (
    'worktree_postgres', 'worktree_preview', 'shared_main_db_exception', 'legacy_observation'
  )),
  state TEXT NOT NULL CHECK(state IN (
    'requested', 'provisioning', 'active', 'cleanup_pending', 'expired',
    'releasing', 'released', 'quarantined', 'failed', 'cancelled'
  )),
  cleanup_policy TEXT NOT NULL CHECK(cleanup_policy IN ('auto', 'orchestrator', 'human', 'never')),
  managed INTEGER NOT NULL CHECK(managed IN (0, 1)),
  ephemeral INTEGER NOT NULL CHECK(ephemeral IN (0, 1)),
  owner_task_id TEXT REFERENCES tasks(id),
  owner_run_id INTEGER REFERENCES task_runs(id),
  controller_orchestrator_id TEXT REFERENCES orchestrators(id),
  board TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  repo_common_dir TEXT NOT NULL DEFAULT '',
  canonical_worktree TEXT NOT NULL DEFAULT '',
  fence INTEGER NOT NULL CHECK(fence > 0),
  heartbeat_at INTEGER,
  expires_at INTEGER,
  terminal_reason TEXT NOT NULL DEFAULT '',
  provenance_version INTEGER NOT NULL DEFAULT 0,
  rollout_generation INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  released_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runtime_leases_reconcile
  ON runtime_resource_leases(state, expires_at, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_runtime_leases_owner
  ON runtime_resource_leases(owner_task_id, owner_run_id, state);
CREATE INDEX IF NOT EXISTS idx_runtime_leases_controller
  ON runtime_resource_leases(controller_orchestrator_id, state, updated_at);

CREATE TABLE IF NOT EXISTS runtime_resource_members (
  id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL REFERENCES runtime_resource_leases(id),
  kind TEXT NOT NULL CHECK(kind IN (
    'compose_project', 'docker_container', 'docker_network', 'docker_volume',
    'tcp_port', 'postgres_endpoint'
  )),
  state TEXT NOT NULL CHECK(state IN ('observed', 'active', 'releasing', 'released', 'quarantined')),
  cleanup_policy TEXT NOT NULL CHECK(cleanup_policy IN ('auto', 'orchestrator', 'human', 'never')),
  managed INTEGER NOT NULL CHECK(managed IN (0, 1)),
  ephemeral INTEGER NOT NULL CHECK(ephemeral IN (0, 1)),
  object_fence INTEGER NOT NULL CHECK(object_fence > 0),
  scope_key TEXT NOT NULL,
  native_id TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  host_ip TEXT NOT NULL DEFAULT '',
  host_port INTEGER,
  container_port INTEGER,
  compose_project TEXT NOT NULL DEFAULT '',
  labels_hash TEXT NOT NULL DEFAULT '',
  provenance TEXT NOT NULL DEFAULT '{}',
  provenance_verified_at INTEGER,
  last_observed_at INTEGER NOT NULL,
  released_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(lease_id, kind, native_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_member_live_native
  ON runtime_resource_members(scope_key, kind, native_id)
  WHERE native_id <> '' AND state IN ('active', 'releasing', 'quarantined');
CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_member_live_tcp
  ON runtime_resource_members(scope_key, host_ip, host_port)
  WHERE kind = 'tcp_port' AND host_port IS NOT NULL AND state IN ('active', 'releasing');
CREATE INDEX IF NOT EXISTS idx_runtime_members_cleanup
  ON runtime_resource_members(lease_id, state, cleanup_policy, kind);

CREATE TABLE IF NOT EXISTS runtime_cleanup_requests (
  id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL REFERENCES runtime_resource_leases(id),
  decision_class TEXT NOT NULL CHECK(decision_class IN ('auto', 'orchestrator', 'human')),
  reason TEXT NOT NULL CHECK(length(reason) > 0),
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'delivered', 'claimed', 'waiting_human', 'approved',
    'executing', 'retry_wait', 'succeeded', 'rejected', 'quarantined', 'cancelled'
  )),
  expected_lease_fence INTEGER NOT NULL CHECK(expected_lease_fence > 0),
  expected_members_hash TEXT NOT NULL,
  claimant_session_id TEXT NOT NULL DEFAULT '',
  claimant_generation INTEGER,
  claim_token_hash TEXT NOT NULL DEFAULT '',
  claim_lease_until INTEGER,
  approved_by TEXT NOT NULL DEFAULT '',
  approval_generation INTEGER,
  executor_id TEXT NOT NULL DEFAULT '',
  executor_generation INTEGER NOT NULL DEFAULT 0,
  executor_lease_until INTEGER,
  execution_nonce TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  escalation_generation INTEGER NOT NULL DEFAULT 0,
  human_answer TEXT NOT NULL DEFAULT '',
  human_answer_nonce_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE(lease_id, expected_lease_fence, reason)
);
CREATE INDEX IF NOT EXISTS idx_runtime_cleanup_due
  ON runtime_cleanup_requests(status, next_attempt_at, created_at, id);
CREATE INDEX IF NOT EXISTS idx_runtime_cleanup_claim
  ON runtime_cleanup_requests(claimant_session_id, claimant_generation, status);

CREATE TABLE IF NOT EXISTS runtime_cleanup_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES runtime_cleanup_requests(id),
  orchestrator_id TEXT NOT NULL REFERENCES orchestrators(id),
  watch_id TEXT REFERENCES orchestrator_watches(id),
  status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'acknowledged', 'dismissed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(request_id, orchestrator_id)
);
CREATE INDEX IF NOT EXISTS idx_runtime_cleanup_delivery_target
  ON runtime_cleanup_deliveries(orchestrator_id, status, created_at, id);

CREATE TABLE IF NOT EXISTS runtime_cleanup_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES runtime_cleanup_requests(id),
  execution_nonce TEXT NOT NULL UNIQUE,
  executor_id TEXT NOT NULL,
  executor_generation INTEGER NOT NULL CHECK(executor_generation > 0),
  expected_lease_fence INTEGER NOT NULL,
  expected_members_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('intent', 'effect_started', 'verified', 'failed')),
  result TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runtime_cleanup_attempt_open
  ON runtime_cleanup_attempts(state, updated_at, id);

CREATE TABLE IF NOT EXISTS runtime_resource_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id TEXT NOT NULL REFERENCES runtime_resource_leases(id),
  request_id TEXT REFERENCES runtime_cleanup_requests(id),
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_events_idem
  ON runtime_resource_events(idempotency_key)
  WHERE idempotency_key <> '';
CREATE INDEX IF NOT EXISTS idx_runtime_events_lease
  ON runtime_resource_events(lease_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS runtime_resource_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id TEXT NOT NULL REFERENCES runtime_resource_leases(id),
  request_id TEXT REFERENCES runtime_cleanup_requests(id),
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN (
    'cleanup_decision', 'cleanup_quarantined', 'cleanup_exhausted',
    'cleanup_budget_saturated', 'shared_db_exception', 'inventory_summary'
  )),
  transport TEXT NOT NULL DEFAULT 'configured',
  payload TEXT NOT NULL DEFAULT '{}',
  sent_transports TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_resource_outbox_due
  ON runtime_resource_outbox(status, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS runtime_resource_exceptions (
  id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL REFERENCES runtime_resource_leases(id),
  kind TEXT NOT NULL CHECK(kind = 'shared_main_db'),
  access_mode TEXT NOT NULL CHECK(access_mode IN ('read_only', 'isolated_write')),
  server_fingerprint TEXT NOT NULL,
  database_name TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  role_name TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approval_reason TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_exceptions_active
  ON runtime_resource_exceptions(lease_id, expires_at, revoked_at);
`;

/** contract §57 の durable run cancel 永続面（migration version 14）。 */
const MIGRATION_V14_CANCEL_SQL = `
CREATE TABLE IF NOT EXISTS run_cancel_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id INTEGER NOT NULL REFERENCES task_runs(id),
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
  status TEXT NOT NULL CHECK(status IN (
    'cancel_requested', 'cooperative_sent', 'acknowledged', 'forcing',
    'stopped', 'failed', 'expired'
  )),
  request_nonce TEXT NOT NULL UNIQUE CHECK(length(request_nonce) > 0),
  actor TEXT NOT NULL CHECK(length(actor) > 0),
  reason TEXT NOT NULL CHECK(length(reason) > 0),
  orchestrator_id TEXT REFERENCES orchestrators(id),
  requester_session_id TEXT NOT NULL DEFAULT '',
  requester_generation INTEGER,
  cancel_fence INTEGER NOT NULL CHECK(cancel_fence > 0),
  deadline_at INTEGER NOT NULL,
  acknowledged_nonce TEXT NOT NULL DEFAULT '',
  capability_snapshot TEXT NOT NULL DEFAULT '{}',
  stop_evidence TEXT NOT NULL DEFAULT '{}',
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_cancel_active
  ON run_cancel_requests(run_id)
  WHERE status IN ('cancel_requested', 'cooperative_sent', 'acknowledged', 'forcing');
CREATE INDEX IF NOT EXISTS idx_run_cancel_task_status
  ON run_cancel_requests(task_id, status, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_run_cancel_due
  ON run_cancel_requests(status, deadline_at, updated_at, id);
`;

/** contract §58 の durable steer lifecycle（migration version 15）。 */
const MIGRATION_V15_STEER_SQL = `
CREATE TABLE IF NOT EXISTS steer_deliveries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id INTEGER NOT NULL REFERENCES task_runs(id),
  session_id TEXT NOT NULL,
  message_key TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'dispatching', 'transport_accepted', 'session_observed', 'acknowledged',
    'uncertain', 'superseded', 'stale_cancelled', 'failed'
  )),
  supersedes_id TEXT REFERENCES steer_deliveries(id),
  expected_cancel_fence INTEGER NOT NULL DEFAULT 0 CHECK(expected_cancel_fence >= 0),
  observed_message_id TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  observed_at INTEGER,
  acknowledged_at INTEGER,
  resolved_at INTEGER,
  UNIQUE(run_id, session_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_steer_delivery_pending
  ON steer_deliveries(status, run_id, sequence, id);
CREATE INDEX IF NOT EXISTS idx_steer_delivery_task
  ON steer_deliveries(task_id, run_id, sequence, id);
`;

/** contract §60 の actor provenance 列（migration version 16）。 */
const ACTOR_PROVENANCE_COLUMNS = [
  "actor_kind TEXT NOT NULL DEFAULT 'unknown' CHECK(actor_kind IN ('human', 'orchestrator', 'service', 'unknown'))",
  "actor_id TEXT NOT NULL DEFAULT ''",
  "actor_session_id TEXT NOT NULL DEFAULT ''",
  "actor_generation INTEGER CHECK(actor_generation IS NULL OR actor_generation > 0)",
] as const;

/** contract §40.6 の task 非依存 board audit 面（migration version 18）。 */
const MIGRATION_V18_BOARD_AUDIT_SQL = `
CREATE TABLE IF NOT EXISTS board_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'orchestrator', 'service', 'unknown')),
  actor_id TEXT NOT NULL DEFAULT '',
  actor_session_id TEXT NOT NULL DEFAULT '',
  actor_generation INTEGER CHECK(actor_generation IS NULL OR actor_generation > 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_audit_event_type
  ON board_audit_events(event_type, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_audit_operation
  ON board_audit_events(event_type, json_extract(payload, '$.operationId'))
  WHERE json_valid(payload)
    AND json_type(payload) = 'object'
    AND json_extract(payload, '$.operationId') IS NOT NULL;
`;

/** contract §67/§68 のrole別実行overrideとnative communication control-plane（migration version 19）。 */
const MIGRATION_V19_COMMUNICATION_SQL = `
CREATE TABLE IF NOT EXISTS native_session_bindings (
  id TEXT PRIMARY KEY,
  binding_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('source', 'target')),
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
  host_id TEXT NOT NULL CHECK(length(host_id) > 0),
  provider_session_id TEXT NOT NULL CHECK(length(provider_session_id) > 0),
  runtime_version TEXT NOT NULL CHECK(length(runtime_version) > 0),
  capability_hash TEXT NOT NULL CHECK(length(capability_hash) = 64 AND capability_hash NOT GLOB '*[^0-9a-f]*'),
  observed_at INTEGER NOT NULL CHECK(observed_at > 0),
  expires_at INTEGER NOT NULL CHECK(expires_at > observed_at),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id INTEGER REFERENCES task_runs(id),
  hachi_session_id TEXT NOT NULL DEFAULT '',
  target_role TEXT NOT NULL DEFAULT '' CHECK(target_role IN ('', 'worker', 'reviewer')),
  expected_cancel_fence INTEGER CHECK(expected_cancel_fence IS NULL OR expected_cancel_fence >= 0),
  orchestrator_id TEXT NOT NULL DEFAULT '',
  orchestrator_session_id TEXT NOT NULL DEFAULT '',
  orchestrator_generation INTEGER CHECK(orchestrator_generation IS NULL OR orchestrator_generation > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'released')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  released_at INTEGER,
  CHECK(
    (kind = 'source' AND run_id IS NULL AND hachi_session_id = '' AND target_role = ''
      AND expected_cancel_fence IS NULL AND orchestrator_id <> ''
      AND orchestrator_session_id <> '' AND orchestrator_generation IS NOT NULL)
    OR
    (kind = 'target' AND run_id IS NOT NULL AND hachi_session_id <> '' AND target_role <> ''
      AND expected_cancel_fence IS NOT NULL AND orchestrator_id = ''
      AND orchestrator_session_id = '' AND orchestrator_generation IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_native_session_bindings_task_status
  ON native_session_bindings(task_id, status, kind);
CREATE INDEX IF NOT EXISTS idx_native_session_bindings_run_status
  ON native_session_bindings(run_id, status);

CREATE TABLE IF NOT EXISTS communication_delivery_attempts (
  id TEXT PRIMARY KEY,
  attempt_key TEXT NOT NULL UNIQUE,
  steer_delivery_id TEXT NOT NULL REFERENCES steer_deliveries(id),
  source_binding_id TEXT REFERENCES native_session_bindings(id),
  target_binding_id TEXT REFERENCES native_session_bindings(id),
  preference TEXT NOT NULL CHECK(preference IN ('auto', 'hachi', 'native')),
  route TEXT NOT NULL DEFAULT '' CHECK(route IN ('', 'hachi', 'claude-cross-session', 'codex-app-server')),
  native_candidate TEXT NOT NULL DEFAULT '' CHECK(native_candidate IN ('', 'claude-cross-session', 'codex-app-server')),
  decision_reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'recorded', 'claimed', 'transport_accepted', 'session_observed', 'acknowledged', 'uncertain', 'rejected'
  )),
  receipt_id TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'orchestrator', 'service', 'unknown')),
  actor_id TEXT NOT NULL DEFAULT '',
  actor_session_id TEXT NOT NULL DEFAULT '',
  actor_generation INTEGER CHECK(actor_generation IS NULL OR actor_generation > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  observed_at INTEGER,
  acknowledged_at INTEGER,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_communication_attempts_delivery
  ON communication_delivery_attempts(steer_delivery_id, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_communication_attempts_active_delivery
  ON communication_delivery_attempts(steer_delivery_id)
  WHERE status <> 'rejected';
CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_restart_intent_key
  ON task_events(json_extract(payload, '$.intentKey'))
  WHERE event_type = 'direct_restart_intent_created'
    AND json_valid(payload)
    AND json_type(payload) = 'object'
    AND json_type(payload, '$.intentKey') = 'text';
`;

/**
 * v20 native delivery lifecycle。v19のobserve監査行を変更せず、native-only state/claim metadataを
 * 同じattempt表へadditiveに追加する。SQLiteの既存CHECKをALTERできないため、shape不足時は
 * 旧行を全て移送するrebuildを行う（旧statusの意味は変更しない）。
 */
const MIGRATION_V20_COMMUNICATION_SQL = `
CREATE TABLE IF NOT EXISTS communication_delivery_attempts (
  id TEXT PRIMARY KEY,
  attempt_key TEXT NOT NULL UNIQUE,
  steer_delivery_id TEXT NOT NULL REFERENCES steer_deliveries(id),
  source_binding_id TEXT REFERENCES native_session_bindings(id),
  target_binding_id TEXT REFERENCES native_session_bindings(id),
  preference TEXT NOT NULL CHECK(preference IN ('auto', 'hachi', 'native')),
  route TEXT NOT NULL DEFAULT '' CHECK(route IN ('', 'hachi', 'claude-cross-session', 'codex-app-server')),
  native_candidate TEXT NOT NULL DEFAULT '' CHECK(native_candidate IN ('', 'claude-cross-session', 'codex-app-server')),
  decision_reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'recorded', 'claimed', 'dispatching', 'transport_accepted', 'session_observed', 'acknowledged', 'uncertain', 'rejected'
  )),
  payload TEXT NOT NULL DEFAULT '',
  config_hash TEXT NOT NULL DEFAULT '',
  config_rollout TEXT NOT NULL DEFAULT '' CHECK(config_rollout IN ('', 'off', 'observe', 'canary', 'on', 'draining')),
  config_minimum_runtime_version TEXT NOT NULL DEFAULT '',
  config_same_host_only INTEGER CHECK(config_same_host_only IS NULL OR config_same_host_only IN (0, 1)),
  config_canary_percent INTEGER CHECK(config_canary_percent IS NULL OR (config_canary_percent >= 1 AND config_canary_percent <= 100)),
  capability_hash TEXT NOT NULL DEFAULT '',
  source_binding_hash TEXT NOT NULL DEFAULT '',
  target_binding_hash TEXT NOT NULL DEFAULT '',
  claimant_orchestrator_id TEXT NOT NULL DEFAULT '',
  claimant_session_id TEXT NOT NULL DEFAULT '',
  claimant_generation INTEGER CHECK(claimant_generation IS NULL OR claimant_generation > 0),
  claim_lease_until INTEGER,
  attempt_nonce_hash TEXT NOT NULL DEFAULT '',
  dispatching_at INTEGER,
  receipt_id TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'orchestrator', 'service', 'unknown')),
  actor_id TEXT NOT NULL DEFAULT '',
  actor_session_id TEXT NOT NULL DEFAULT '',
  actor_generation INTEGER CHECK(actor_generation IS NULL OR actor_generation > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  observed_at INTEGER,
  acknowledged_at INTEGER,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_communication_attempts_delivery
  ON communication_delivery_attempts(steer_delivery_id, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_communication_attempts_active_delivery
  ON communication_delivery_attempts(steer_delivery_id)
  WHERE status <> 'rejected';
`;

/** contract §69 の steward 提案 request family（migration version 21）。
 * §69.1 のとおり orchestrator_requests へ相乗りせず独立 table を持つ。
 * 相乗りすると getActiveOrchestratorRequestByTask が長期滞留の提案を「active request」として返し、
 * 同一タスクの worker 質問の回答経路を塞いでしまうため。 */
const MIGRATION_V21_STEWARD_PROPOSAL_SQL = `
CREATE TABLE IF NOT EXISTS steward_proposal_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK(kind IN ('promote', 'archive', 'spec-lint', 'escalate')),
  reason TEXT NOT NULL CHECK(length(reason) > 0),
  routed_by TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'delivered', 'claimed', 'accepted',
    'dismissed', 'deferred', 'superseded', 'cancelled'
  )),
  claimant_session_id TEXT NOT NULL DEFAULT '',
  claimant_generation INTEGER CHECK(claimant_generation IS NULL OR claimant_generation > 0),
  claim_token_hash TEXT NOT NULL DEFAULT '',
  claim_lease_until INTEGER,
  defer_until INTEGER,
  dismissed_at INTEGER,
  dismiss_count INTEGER NOT NULL DEFAULT 0,
  accepted_task_status TEXT NOT NULL DEFAULT '',
  resolution_reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_steward_proposal_requests_status
  ON steward_proposal_requests(status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_steward_proposal_requests_task_kind
  ON steward_proposal_requests(task_id, kind, status, created_at DESC);

CREATE TABLE IF NOT EXISTS steward_proposal_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES steward_proposal_requests(id),
  orchestrator_id TEXT NOT NULL REFERENCES orchestrators(id),
  watch_id TEXT REFERENCES orchestrator_watches(id),
  status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'acknowledged', 'dismissed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(request_id, orchestrator_id)
);
CREATE INDEX IF NOT EXISTS idx_steward_proposal_delivery_target
  ON steward_proposal_deliveries(orchestrator_id, status, created_at, id);
`;

/** contract §55.3 の heartbeat stale gap durable incident（migration version 22）。 */
const MIGRATION_V22_ORCHESTRATOR_LIVENESS_SQL = `
CREATE TABLE IF NOT EXISTS orchestrator_liveness_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES orchestrator_sessions(id),
  orchestrator_id TEXT NOT NULL REFERENCES orchestrators(id),
  generation INTEGER NOT NULL CHECK(generation > 0),
  provider TEXT NOT NULL DEFAULT '' CHECK(provider IN ('', 'codex', 'claude')),
  provider_session_id TEXT NOT NULL DEFAULT '',
  gap_seconds INTEGER NOT NULL CHECK(gap_seconds > 0),
  detected_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'exhausted')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, generation)
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_liveness_pending
  ON orchestrator_liveness_incidents(status, next_attempt_at, id);
`;

/** contract §70〜§73 の durable successor slot（migration version 23）。 */
const MIGRATION_V23_ORCHESTRATOR_SUCCESSOR_SQL = `
CREATE TABLE IF NOT EXISTS orchestrator_successor_launches (
  id TEXT PRIMARY KEY,
  orchestrator_id TEXT NOT NULL REFERENCES orchestrators(id),
  kind TEXT NOT NULL CHECK(kind IN ('handoff', 'takeover')),
  target_provider TEXT NOT NULL CHECK(target_provider IN ('codex', 'claude')),
  provider_session_source TEXT NOT NULL DEFAULT ''
    CHECK(provider_session_source IN ('', 'codex-session-start', 'claude-delivery')),
  source_session_id TEXT NOT NULL REFERENCES orchestrator_sessions(id),
  source_generation INTEGER NOT NULL CHECK(source_generation > 0),
  canonical_cwd TEXT NOT NULL,
  host_id TEXT NOT NULL,
  launch_nonce_hash TEXT NOT NULL,
  planned_tmux_session TEXT NOT NULL,
  tmux_session TEXT NOT NULL DEFAULT '',
  tmux_pane TEXT NOT NULL DEFAULT '',
  pane_pid INTEGER,
  process_group_id INTEGER,
  owner_nonce_hash TEXT NOT NULL DEFAULT '',
  runtime_ownership_claimed INTEGER NOT NULL DEFAULT 0 CHECK(runtime_ownership_claimed IN (0, 1)),
  runtime_bound_at INTEGER,
  observed_canonical_cwd TEXT NOT NULL DEFAULT '',
  observed_host_id TEXT NOT NULL DEFAULT '',
  observed_hook_definition_hash TEXT NOT NULL DEFAULT '',
  observed_hook_executable_hash TEXT NOT NULL DEFAULT '',
  hook_definition_hash TEXT NOT NULL,
  hook_executable_hash TEXT NOT NULL,
  provider_session_id TEXT NOT NULL DEFAULT '',
  attestation_handle_hash TEXT NOT NULL DEFAULT '',
  attestation_issued_at INTEGER,
  attestation_expires_at INTEGER,
  attestation_consumed_at INTEGER,
  handoff_token_fence_hash TEXT NOT NULL DEFAULT '',
  handoff_expires_at INTEGER,
  takeover_stale_before INTEGER,
  cancel_fence INTEGER NOT NULL DEFAULT 0 CHECK(cancel_fence >= 0),
  accept_fence_hash TEXT NOT NULL DEFAULT '',
  stop_fence_hash TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  barrier_release_authorized_at INTEGER,
  runtime_deadline_at INTEGER NOT NULL,
  attestation_deadline_at INTEGER NOT NULL,
  kill_owner_readback_hash TEXT NOT NULL DEFAULT '',
  stop_owner_matched INTEGER CHECK(stop_owner_matched IS NULL OR stop_owner_matched IN (0, 1)),
  stop_owner_readback_at INTEGER,
  stop_kill_result TEXT NOT NULL DEFAULT 'not-attempted'
    CHECK(stop_kill_result IN ('not-attempted', 'succeeded', 'failed', 'unknown')),
  stop_tmux_session_absent INTEGER
    CHECK(stop_tmux_session_absent IS NULL OR stop_tmux_session_absent IN (0, 1)),
  stop_pane_pid_absent INTEGER CHECK(stop_pane_pid_absent IS NULL OR stop_pane_pid_absent IN (0, 1)),
  stop_process_group_absent INTEGER
    CHECK(stop_process_group_absent IS NULL OR stop_process_group_absent IN (0, 1)),
  stop_observed_at INTEGER,
  successor_session_id TEXT NOT NULL DEFAULT '',
  successor_generation INTEGER,
  status TEXT NOT NULL DEFAULT 'armed'
    CHECK(status IN ('armed', 'runtime_bound', 'attested', 'accepting', 'succeeded',
                     'stop_pending', 'stopped', 'uncertain', 'rejected', 'expired')),
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER
);

CREATE TABLE IF NOT EXISTS orchestrator_successor_launch_capabilities (
  launch_id TEXT PRIMARY KEY REFERENCES orchestrator_successor_launches(id) ON DELETE CASCADE,
  attestation_handle TEXT NOT NULL DEFAULT '',
  accept_fence TEXT NOT NULL DEFAULT '',
  stop_fence TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestrator_successor_blocking
  ON orchestrator_successor_launches(orchestrator_id)
  WHERE status IN ('armed', 'runtime_bound', 'attested', 'accepting', 'stop_pending', 'uncertain');
CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestrator_successor_runtime
  ON orchestrator_successor_launches(observed_host_id, tmux_pane)
  WHERE runtime_ownership_claimed = 1 AND observed_host_id <> '' AND tmux_pane <> ''
    AND status IN ('runtime_bound', 'attested', 'accepting', 'succeeded', 'stop_pending', 'uncertain');
CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestrator_successor_provider_session
  ON orchestrator_successor_launches(target_provider, provider_session_id)
  WHERE provider_session_id <> '';
CREATE INDEX IF NOT EXISTS idx_orchestrator_successor_source
  ON orchestrator_successor_launches(source_session_id, source_generation, created_at, id);
`;

/** contract §75.11 の external status replay fence と launch binding（migration version 24）。 */
const MIGRATION_V24_EXTERNAL_RUNTIME_GENERATION_SQL = `
CREATE TABLE IF NOT EXISTS external_runtime_generation_statuses (
  provider TEXT PRIMARY KEY CHECK(provider IN ('codex', 'claude')),
  lane TEXT NOT NULL UNIQUE CHECK(lane IN ('even-shared', 'even-claude')),
  runtime_key TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  canonical_digest TEXT NOT NULL,
  canonical_payload TEXT NOT NULL,
  accepted_at INTEGER NOT NULL CHECK(accepted_at >= 0)
);

CREATE TABLE IF NOT EXISTS external_runtime_generation_bindings (
  run_id INTEGER PRIMARY KEY REFERENCES task_runs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version = 1),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('worker', 'reviewer')),
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
  transport TEXT NOT NULL CHECK(transport IN ('bridge', 'direct')),
  runtime_key TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  bound_at INTEGER NOT NULL CHECK(bound_at >= 0),
  UNIQUE(task_id, session_id, role)
);

CREATE INDEX IF NOT EXISTS idx_external_runtime_generation_binding_identity
  ON external_runtime_generation_bindings(provider, runtime_key, identity_json, run_id);
`;

/** contract §70.3 の tmux server lifetime runtime authority（migration version 25）。 */
const ORCHESTRATOR_SUCCESSOR_V25_COLUMN_DEFINITIONS = [
  "tmux_socket_path TEXT NOT NULL DEFAULT ''",
  "tmux_server_pid INTEGER",
  "tmux_server_start_time INTEGER",
  "tmux_server_lifetime_hash TEXT NOT NULL DEFAULT ''",
] as const;

const ORCHESTRATOR_SUCCESSOR_V25_COLUMNS = [
  "tmux_socket_path",
  "tmux_server_pid",
  "tmux_server_start_time",
  "tmux_server_lifetime_hash",
] as const;

const MIGRATION_V25_ORCHESTRATOR_SUCCESSOR_RUNTIME_INDEX_SQL = `
CREATE UNIQUE INDEX idx_orchestrator_successor_runtime
  ON orchestrator_successor_launches(
    observed_host_id, tmux_socket_path, tmux_server_lifetime_hash, tmux_pane
  )
  WHERE runtime_ownership_claimed = 1
    AND observed_host_id <> '' AND tmux_socket_path <> ''
    AND tmux_server_lifetime_hash <> '' AND tmux_pane <> ''
    AND status IN ('runtime_bound', 'attested', 'accepting', 'stop_pending', 'uncertain');
`;

/** contract §50.1.1 の board instance 識別子（migration version 26）。 */
const MIGRATION_V26_BOARD_METADATA_SQL = `
CREATE TABLE IF NOT EXISTS board_metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  board_instance_id TEXT NOT NULL UNIQUE
    CHECK(length(board_instance_id) = 32 AND board_instance_id NOT GLOB '*[^0-9a-f]*')
);
`;

/** contract §69.3.1 の tenant 既定 routing 監査情報（migration version 27）。 */
const STEWARD_PROPOSAL_V27_ROUTED_BY_COLUMN = "routed_by TEXT NOT NULL DEFAULT ''";

/**
 * contract §40.1.1 の half-open claim outbox（migration version 28）。
 * 共有 state lock 外でネットワーク配送するための durable な配送予定。claim_generation で旧世代を fence する。
 */
const MIGRATION_V28_HALF_OPEN_OUTBOX_SQL = `
CREATE TABLE IF NOT EXISTS half_open_outbox (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL CHECK(stage IN ('steward', 'brief')),
  claim_generation INTEGER NOT NULL CHECK(claim_generation > 0),
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  sent_transports TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'failed', 'discarded')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_half_open_outbox_due
  ON half_open_outbox(status, next_attempt_at, created_at, id);
CREATE INDEX IF NOT EXISTS idx_half_open_outbox_stage_generation
  ON half_open_outbox(stage, claim_generation);
`;

// v29: 契約 §77.4 係数テーブルと §77.9 立ち上げ標本。CREATE TABLE IF NOT EXISTS で冪等。
// effort_key は EffortLevel か 'unset'（effort null）。NULL を主キーに含めると SQLite は重複を許すため文字列で固定する。
const MIGRATION_V29_SESSION_USAGE_PROFILES_SQL = `
CREATE TABLE IF NOT EXISTS session_usage_profiles (
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
  model TEXT NOT NULL,
  effort_key TEXT NOT NULL CHECK(effort_key IN ('low', 'medium', 'high', 'xhigh', 'max', 'unset')),
  turns INTEGER NOT NULL CHECK(turns >= 0),
  measured INTEGER NOT NULL CHECK(measured IN (0, 1)),
  cache_read_per_turn REAL NOT NULL,
  cache_write_5m_per_turn REAL NOT NULL,
  cache_write_1h_per_turn REAL NOT NULL,
  output_per_turn REAL NOT NULL,
  reasoning_per_turn REAL,
  context_growth_per_turn REAL,
  source_session_ids TEXT NOT NULL DEFAULT '[]',
  computed_from_ref TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model, effort_key)
);
CREATE TABLE IF NOT EXISTS session_boot_samples (
  orchestrator_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
  model TEXT,
  context_at_turn15 INTEGER,
  boot_overhead_usd REAL,
  provenance TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (orchestrator_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_session_boot_samples_identity_recent
  ON session_boot_samples(orchestrator_id, created_at, session_id);
`;

// v30: 契約 §78.5.1 の不確定配送 append-only 永続面。CREATE TABLE IF NOT EXISTS で冪等。
// key は (session_id, event_id) の BINARY 完全一致。task FK・擬似 task は作らない。
const MIGRATION_V30_RELAY_DELIVERY_UNCERTAIN_EVENTS_SQL = `
CREATE TABLE IF NOT EXISTS relay_delivery_uncertain_events (
  session_id TEXT NOT NULL COLLATE BINARY CHECK(length(session_id) > 0),
  event_id TEXT NOT NULL COLLATE BINARY CHECK(length(event_id) > 0),
  handover_generation INTEGER NOT NULL CHECK(typeof(handover_generation) = 'integer' AND handover_generation > 0 AND handover_generation <= 9007199254740991),
  relay_id TEXT NOT NULL CHECK(length(relay_id) > 0),
  fencing_token INTEGER NOT NULL CHECK(typeof(fencing_token) = 'integer' AND fencing_token > 0 AND fencing_token <= 9007199254740991),
  reason TEXT NOT NULL CHECK(reason = 'sending_remnant'),
  observed_at INTEGER NOT NULL CHECK(typeof(observed_at) = 'integer' AND observed_at >= 0 AND observed_at <= 9007199254740991),
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
  host TEXT NOT NULL CHECK(length(host) > 0),
  even_terminal_boot_epoch TEXT NOT NULL CHECK(length(even_terminal_boot_epoch) > 0),
  canonical_server_url TEXT NOT NULL CHECK(length(canonical_server_url) > 0),
  recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at) = 'integer' AND recorded_at >= 0 AND recorded_at <= 9007199254740991),
  PRIMARY KEY (session_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_relay_delivery_uncertain_events_recorded
  ON relay_delivery_uncertain_events(recorded_at DESC, session_id, event_id);
CREATE INDEX IF NOT EXISTS idx_relay_delivery_uncertain_events_session
  ON relay_delivery_uncertain_events(session_id, recorded_at DESC, event_id);
`;

// v31: 契約 §78.10 のproduction host登録authority durable面。CREATE TABLE IF NOT EXISTSで冪等。
// installation/session authority/registration claimの3テーブルへ分ける。
// session_authorities.latest_claim_idはregistration_claims(session_id, claim_id)への複合FK
// （SQLiteはCREATE TABLE時点でのFK先table存在を要求しないため定義順序は問題にならない）。
const MIGRATION_V31_RELAY_AUTHORITY_SQL = `
CREATE TABLE IF NOT EXISTS relay_authority_installation (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  board_instance_id TEXT NOT NULL COLLATE BINARY
    CHECK(length(board_instance_id) = 32 AND board_instance_id NOT GLOB '*[^0-9a-f]*'),
  adoption_id TEXT NOT NULL COLLATE BINARY
    CHECK(length(adoption_id) = 64 AND adoption_id NOT GLOB '*[^0-9a-f]*'),
  host_identity TEXT NOT NULL COLLATE BINARY
    CHECK(length(host_identity) = 64 AND host_identity NOT GLOB '*[^0-9a-f]*'),
  host_epoch INTEGER NOT NULL
    CHECK(typeof(host_epoch) = 'integer' AND host_epoch >= 1 AND host_epoch <= 9007199254740991),
  authority_revision INTEGER NOT NULL
    CHECK(typeof(authority_revision) = 'integer' AND authority_revision >= 1 AND authority_revision <= 9007199254740991),
  created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0 AND created_at <= 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= 0 AND updated_at <= 9007199254740991)
);
CREATE TABLE IF NOT EXISTS relay_session_authorities (
  session_id TEXT NOT NULL COLLATE BINARY CHECK(length(session_id) > 0),
  fencing_token_hwm INTEGER NULL
    CHECK(fencing_token_hwm IS NULL OR (typeof(fencing_token_hwm) = 'integer' AND fencing_token_hwm >= 1 AND fencing_token_hwm <= 9007199254740991)),
  max_handover_generation INTEGER NULL
    CHECK(max_handover_generation IS NULL OR (typeof(max_handover_generation) = 'integer' AND max_handover_generation >= 1 AND max_handover_generation <= 9007199254740991)),
  latest_claim_id TEXT NULL COLLATE BINARY
    CHECK(latest_claim_id IS NULL OR (length(latest_claim_id) = 64 AND latest_claim_id NOT GLOB '*[^0-9a-f]*')),
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 1 AND revision <= 9007199254740991),
  created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0 AND created_at <= 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= 0 AND updated_at <= 9007199254740991),
  PRIMARY KEY (session_id),
  CHECK (
    (fencing_token_hwm IS NULL AND max_handover_generation IS NULL AND latest_claim_id IS NULL)
    OR
    (fencing_token_hwm IS NOT NULL AND max_handover_generation IS NOT NULL AND latest_claim_id IS NOT NULL)
  ),
  FOREIGN KEY (session_id, latest_claim_id) REFERENCES relay_registration_claims(session_id, claim_id)
);
CREATE TABLE IF NOT EXISTS relay_registration_claims (
  claim_id TEXT NOT NULL COLLATE BINARY
    CHECK(length(claim_id) = 64 AND claim_id NOT GLOB '*[^0-9a-f]*'),
  session_id TEXT NOT NULL COLLATE BINARY CHECK(length(session_id) > 0),
  relay_id TEXT NOT NULL
    CHECK(length(relay_id) = 64 AND relay_id NOT GLOB '*[^0-9a-f]*'),
  provider_session_id TEXT NOT NULL CHECK(length(provider_session_id) > 0),
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
  canonical_server_url TEXT NOT NULL CHECK(length(canonical_server_url) > 0),
  host TEXT NOT NULL CHECK(length(host) > 0),
  even_terminal_boot_epoch TEXT NOT NULL CHECK(length(even_terminal_boot_epoch) > 0),
  native_evidence_digest TEXT NOT NULL
    CHECK(length(native_evidence_digest) = 64 AND native_evidence_digest NOT GLOB '*[^0-9a-f]*'),
  handover_generation INTEGER NOT NULL
    CHECK(typeof(handover_generation) = 'integer' AND handover_generation >= 1 AND handover_generation <= 9007199254740991),
  host_epoch INTEGER NOT NULL
    CHECK(typeof(host_epoch) = 'integer' AND host_epoch >= 1 AND host_epoch <= 9007199254740991),
  native_observed_at INTEGER NOT NULL
    CHECK(typeof(native_observed_at) = 'integer' AND native_observed_at >= 0 AND native_observed_at <= 9007199254740991),
  claim_secret_hash BLOB NOT NULL CHECK(typeof(claim_secret_hash) = 'blob' AND length(claim_secret_hash) = 32),
  purpose TEXT NOT NULL CHECK(purpose IN ('initial', 'restart', 'handoff')),
  expected_fencing_token_hwm INTEGER NULL
    CHECK(expected_fencing_token_hwm IS NULL OR (typeof(expected_fencing_token_hwm) = 'integer' AND expected_fencing_token_hwm >= 1 AND expected_fencing_token_hwm <= 9007199254740991)),
  expected_max_handover_generation INTEGER NULL
    CHECK(expected_max_handover_generation IS NULL OR (typeof(expected_max_handover_generation) = 'integer' AND expected_max_handover_generation >= 1 AND expected_max_handover_generation <= 9007199254740991)),
  expected_session_revision INTEGER NOT NULL
    CHECK(typeof(expected_session_revision) = 'integer' AND expected_session_revision >= 1 AND expected_session_revision <= 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('issued', 'active', 'retired', 'cancelled')),
  assigned_fencing_token INTEGER NULL
    CHECK(assigned_fencing_token IS NULL OR (typeof(assigned_fencing_token) = 'integer' AND assigned_fencing_token >= 1 AND assigned_fencing_token <= 9007199254740991)),
  claim_revision INTEGER NOT NULL
    CHECK(typeof(claim_revision) = 'integer' AND claim_revision >= 1 AND claim_revision <= 9007199254740991),
  issued_at INTEGER NOT NULL CHECK(typeof(issued_at) = 'integer' AND issued_at >= 0 AND issued_at <= 9007199254740991),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at >= 0 AND expires_at <= 9007199254740991),
  consumed_at INTEGER NULL
    CHECK(consumed_at IS NULL OR (typeof(consumed_at) = 'integer' AND consumed_at >= 0 AND consumed_at <= 9007199254740991)),
  retired_at INTEGER NULL
    CHECK(retired_at IS NULL OR (typeof(retired_at) = 'integer' AND retired_at >= 0 AND retired_at <= 9007199254740991)),
  cancelled_at INTEGER NULL
    CHECK(cancelled_at IS NULL OR (typeof(cancelled_at) = 'integer' AND cancelled_at >= 0 AND cancelled_at <= 9007199254740991)),
  termination_reason TEXT NULL
    CHECK(termination_reason IS NULL OR termination_reason IN ('normal_shutdown', 'handoff_drained', 'host_restart', 'expired')),
  drain_evidence_digest TEXT NULL
    CHECK(drain_evidence_digest IS NULL OR (length(drain_evidence_digest) = 64 AND drain_evidence_digest NOT GLOB '*[^0-9a-f]*')),
  drained_at INTEGER NULL
    CHECK(drained_at IS NULL OR (typeof(drained_at) = 'integer' AND drained_at >= 0 AND drained_at <= 9007199254740991)),
  PRIMARY KEY (claim_id),
  FOREIGN KEY (session_id) REFERENCES relay_session_authorities(session_id),
  UNIQUE (session_id, claim_id),
  UNIQUE (session_id, relay_id),
  CHECK (expires_at > issued_at),
  CHECK (
    (state = 'issued' AND assigned_fencing_token IS NULL AND consumed_at IS NULL AND retired_at IS NULL AND cancelled_at IS NULL AND termination_reason IS NULL)
    OR (state = 'active' AND assigned_fencing_token IS NOT NULL AND consumed_at IS NOT NULL AND retired_at IS NULL AND cancelled_at IS NULL AND termination_reason IS NULL)
    OR (state = 'retired' AND assigned_fencing_token IS NOT NULL AND consumed_at IS NOT NULL AND retired_at IS NOT NULL AND cancelled_at IS NULL AND termination_reason IS NOT NULL)
    OR (state = 'cancelled' AND assigned_fencing_token IS NULL AND consumed_at IS NULL AND retired_at IS NULL AND cancelled_at IS NOT NULL AND termination_reason IS NOT NULL)
  ),
  CHECK (
    (termination_reason = 'handoff_drained' AND drain_evidence_digest IS NOT NULL AND drained_at IS NOT NULL)
    OR (termination_reason IS NOT NULL AND termination_reason != 'handoff_drained' AND drain_evidence_digest IS NULL AND drained_at IS NULL)
    OR (termination_reason IS NULL AND drain_evidence_digest IS NULL AND drained_at IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_registration_claims_active_per_session
  ON relay_registration_claims(session_id) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_registration_claims_issued_per_session
  ON relay_registration_claims(session_id) WHERE state = 'issued';
`;

// v32: 契約 §80 のtask状態に依存しない人間判断依頼。既存task/event/commentには触れない。
const MIGRATION_V32_HUMAN_DECISION_SQL = `
CREATE TABLE IF NOT EXISTS human_decision_requests (
  id TEXT PRIMARY KEY COLLATE BINARY
    CHECK(length(id) = 19 AND substr(id, 1, 3) = 'hd_' AND substr(id, 4) NOT GLOB '*[^0-9a-f]*'),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  owner_orchestrator_id TEXT NOT NULL REFERENCES orchestrators(id),
  kind TEXT NOT NULL CHECK(kind IN ('approval', 'decision', 'review')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  question TEXT NOT NULL CHECK(length(question) BETWEEN 1 AND 12000),
  action TEXT,
  target_revision_kind TEXT CHECK(target_revision_kind IS NULL OR target_revision_kind IN ('git_commit', 'sha256')),
  target_revision_value TEXT COLLATE BINARY,
  choices_json TEXT NOT NULL CHECK(json_valid(choices_json) AND json_type(choices_json) = 'array'),
  links_json TEXT NOT NULL CHECK(json_valid(links_json) AND json_type(links_json) = 'array'),
  default_outcome TEXT NOT NULL CHECK(default_outcome IN ('deny', 'retain_current_state', 'not_accepted')),
  related_request_id TEXT REFERENCES human_decision_requests(id),
  deadline_at INTEGER CHECK(deadline_at IS NULL OR (typeof(deadline_at) = 'integer' AND deadline_at >= 0 AND deadline_at <= 9007199254740991)),
  ask_idempotency_key TEXT NOT NULL COLLATE BINARY CHECK(length(ask_idempotency_key) BETWEEN 1 AND 128),
  ask_payload_hash TEXT NOT NULL COLLATE BINARY
    CHECK(length(ask_payload_hash) = 64 AND ask_payload_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK(status IN ('waiting_human', 'answered', 'claimed', 'resolved', 'cancelled')),
  answer_revision INTEGER NOT NULL CHECK(answer_revision IN (0, 1)),
  answer_idempotency_key TEXT COLLATE BINARY,
  answer_payload_hash TEXT COLLATE BINARY,
  answer_payload_json TEXT,
  answer_comment TEXT CHECK(answer_comment IS NULL OR length(answer_comment) <= 12000),
  answered_at INTEGER CHECK(answered_at IS NULL OR (typeof(answered_at) = 'integer' AND answered_at >= 0 AND answered_at <= 9007199254740991)),
  claimant_orchestrator_id TEXT REFERENCES orchestrators(id),
  claimant_session_id TEXT REFERENCES orchestrator_sessions(id),
  claimant_generation INTEGER CHECK(claimant_generation IS NULL OR (typeof(claimant_generation) = 'integer' AND claimant_generation > 0)),
  claim_token_hash TEXT COLLATE BINARY,
  claim_lease_until INTEGER CHECK(claim_lease_until IS NULL OR (typeof(claim_lease_until) = 'integer' AND claim_lease_until >= 0 AND claim_lease_until <= 9007199254740991)),
  resolution_outcome TEXT CHECK(resolution_outcome IS NULL OR resolution_outcome IN ('handled', 'obsolete')),
  resolution_reason TEXT CHECK(resolution_reason IS NULL OR length(resolution_reason) <= 12000),
  resolved_at INTEGER CHECK(resolved_at IS NULL OR (typeof(resolved_at) = 'integer' AND resolved_at >= 0 AND resolved_at <= 9007199254740991)),
  cancel_reason TEXT CHECK(cancel_reason IS NULL OR length(cancel_reason) BETWEEN 1 AND 12000),
  cancelled_at INTEGER CHECK(cancelled_at IS NULL OR (typeof(cancelled_at) = 'integer' AND cancelled_at >= 0 AND cancelled_at <= 9007199254740991)),
  request_actor_kind TEXT NOT NULL CHECK(request_actor_kind = 'orchestrator'),
  request_actor_id TEXT NOT NULL,
  request_actor_session_id TEXT NOT NULL,
  request_actor_generation INTEGER NOT NULL CHECK(request_actor_generation > 0),
  answer_actor_kind TEXT CHECK(answer_actor_kind IS NULL OR answer_actor_kind = 'human'),
  answer_actor_id TEXT,
  answer_actor_session_id TEXT,
  answer_actor_generation INTEGER,
  cancel_actor_kind TEXT CHECK(cancel_actor_kind IS NULL OR cancel_actor_kind = 'orchestrator'),
  cancel_actor_id TEXT,
  cancel_actor_session_id TEXT,
  cancel_actor_generation INTEGER,
  resolve_actor_kind TEXT CHECK(resolve_actor_kind IS NULL OR resolve_actor_kind = 'orchestrator'),
  resolve_actor_id TEXT,
  resolve_actor_session_id TEXT,
  resolve_actor_generation INTEGER,
  created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0 AND created_at <= 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= 0 AND updated_at <= 9007199254740991),
  UNIQUE(owner_orchestrator_id, ask_idempotency_key),
  CHECK (
    (kind = 'approval' AND action IS NOT NULL AND length(action) BETWEEN 1 AND 200
      AND target_revision_kind IS NOT NULL AND target_revision_value IS NOT NULL
      AND choices_json = '[]' AND default_outcome = 'deny')
    OR (kind = 'decision' AND action IS NULL AND target_revision_kind IS NULL AND target_revision_value IS NULL
      AND default_outcome = 'retain_current_state')
    OR (kind = 'review' AND action IS NULL AND target_revision_kind IS NOT NULL AND target_revision_value IS NOT NULL
      AND choices_json = '[]' AND default_outcome = 'not_accepted')
  ),
  CHECK (
    (target_revision_kind IS NULL AND target_revision_value IS NULL)
    OR (target_revision_kind = 'git_commit' AND length(target_revision_value) IN (40, 64)
      AND target_revision_value NOT GLOB '*[^0-9a-f]*')
    OR (target_revision_kind = 'sha256' AND length(target_revision_value) = 64
      AND target_revision_value NOT GLOB '*[^0-9a-f]*')
  ),
  CHECK (
    (answer_revision = 0 AND answer_idempotency_key IS NULL AND answer_payload_hash IS NULL
      AND answer_payload_json IS NULL AND answer_comment IS NULL AND answered_at IS NULL
      AND answer_actor_kind IS NULL AND answer_actor_id IS NULL AND answer_actor_session_id IS NULL
      AND answer_actor_generation IS NULL)
    OR (answer_revision = 1 AND answer_idempotency_key IS NOT NULL AND length(answer_idempotency_key) BETWEEN 1 AND 128
      AND answer_payload_hash IS NOT NULL AND length(answer_payload_hash) = 64
      AND answer_payload_hash NOT GLOB '*[^0-9a-f]*' AND answer_payload_json IS NOT NULL
      AND json_valid(answer_payload_json) AND json_type(answer_payload_json) = 'object'
      AND answered_at IS NOT NULL AND answer_actor_kind = 'human' AND length(answer_actor_id) > 0
      AND answer_actor_session_id = '' AND answer_actor_generation IS NULL)
  ),
  CHECK (
    (status = 'waiting_human' AND answer_revision = 0 AND claimant_session_id IS NULL
      AND resolution_outcome IS NULL AND resolved_at IS NULL AND cancel_reason IS NULL AND cancelled_at IS NULL)
    OR (status = 'answered' AND answer_revision = 1 AND claimant_session_id IS NULL
      AND resolution_outcome IS NULL AND resolved_at IS NULL AND cancel_reason IS NULL AND cancelled_at IS NULL)
    OR (status = 'claimed' AND answer_revision = 1 AND claimant_orchestrator_id = owner_orchestrator_id
      AND claimant_session_id IS NOT NULL AND claimant_generation IS NOT NULL AND claim_token_hash IS NOT NULL
      AND length(claim_token_hash) = 64 AND claim_token_hash NOT GLOB '*[^0-9a-f]*'
      AND claim_lease_until IS NOT NULL AND resolution_outcome IS NULL AND resolved_at IS NULL
      AND cancel_reason IS NULL AND cancelled_at IS NULL)
    OR (status = 'resolved' AND answer_revision = 1 AND claimant_session_id IS NULL
      AND resolution_outcome IS NOT NULL AND resolved_at IS NOT NULL AND cancel_reason IS NULL AND cancelled_at IS NULL
      AND resolve_actor_kind = 'orchestrator' AND resolve_actor_generation > 0)
    OR (status = 'cancelled' AND answer_revision = 0 AND claimant_session_id IS NULL
      AND resolution_outcome IS NULL AND resolved_at IS NULL AND cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL
      AND cancel_actor_kind = 'orchestrator' AND cancel_actor_generation > 0)
  ),
  CHECK (
    (claimant_session_id IS NULL AND claimant_orchestrator_id IS NULL AND claimant_generation IS NULL
      AND claim_token_hash IS NULL AND claim_lease_until IS NULL)
    OR (claimant_session_id IS NOT NULL AND claimant_orchestrator_id IS NOT NULL AND claimant_generation IS NOT NULL
      AND claim_token_hash IS NOT NULL AND claim_lease_until IS NOT NULL)
  ),
  CHECK (
    (resolution_outcome IS NULL AND resolution_reason IS NULL)
    OR (resolution_outcome = 'handled')
    OR (resolution_outcome = 'obsolete' AND resolution_reason IS NOT NULL AND length(resolution_reason) > 0)
  ),
  CHECK (request_actor_id = owner_orchestrator_id AND length(request_actor_session_id) > 0),
  CHECK (
    (cancel_actor_kind IS NULL AND cancel_actor_id IS NULL AND cancel_actor_session_id IS NULL
      AND cancel_actor_generation IS NULL)
    OR (cancel_actor_kind = 'orchestrator' AND cancel_actor_id = owner_orchestrator_id
      AND length(cancel_actor_session_id) > 0 AND cancel_actor_generation > 0)
  ),
  CHECK (
    (resolve_actor_kind IS NULL AND resolve_actor_id IS NULL AND resolve_actor_session_id IS NULL
      AND resolve_actor_generation IS NULL)
    OR (resolve_actor_kind = 'orchestrator' AND resolve_actor_id = owner_orchestrator_id
      AND length(resolve_actor_session_id) > 0 AND resolve_actor_generation > 0)
  )
);
CREATE INDEX IF NOT EXISTS idx_human_decision_status_created
  ON human_decision_requests(status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_human_decision_task_status_created
  ON human_decision_requests(task_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_human_decision_owner_status_answered
  ON human_decision_requests(owner_orchestrator_id, status, answered_at, id);
CREATE INDEX IF NOT EXISTS idx_human_decision_claimant_session
  ON human_decision_requests(claimant_session_id, claimant_generation, status);
`;

/** session_usage_profiles.source_session_ids（JSON 配列）。壊れていれば空配列に閉じる（既定値で埋めない範囲の防御）。 */
function parseSessionIdArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

interface BoardMetadataRow {
  singleton: number;
  board_instance_id: string;
}

function assertBoardMetadataRow(row: BoardMetadataRow): void {
  if (row.singleton !== 1 || !/^[0-9a-f]{32}$/.test(row.board_instance_id)) {
    throw new Error("board metadata の boardInstanceId が不正です");
  }
}

const ORCHESTRATOR_SUCCESSOR_V23_COLUMNS = [
  "id", "orchestrator_id", "kind", "target_provider", "provider_session_source", "source_session_id",
  "source_generation", "canonical_cwd", "host_id", "launch_nonce_hash", "planned_tmux_session",
  "tmux_session", "tmux_pane", "pane_pid", "process_group_id", "owner_nonce_hash",
  "runtime_ownership_claimed", "runtime_bound_at",
  "observed_canonical_cwd", "observed_host_id", "observed_hook_definition_hash",
  "observed_hook_executable_hash", "hook_definition_hash", "hook_executable_hash", "provider_session_id",
  "attestation_handle_hash", "attestation_issued_at", "attestation_expires_at", "attestation_consumed_at",
  "handoff_token_fence_hash", "handoff_expires_at", "takeover_stale_before", "cancel_fence",
  "accept_fence_hash", "stop_fence_hash", "revision", "barrier_release_authorized_at",
  "runtime_deadline_at", "attestation_deadline_at", "kill_owner_readback_hash", "stop_owner_matched",
  "stop_owner_readback_at", "stop_kill_result", "stop_tmux_session_absent", "stop_pane_pid_absent",
  "stop_process_group_absent", "stop_observed_at", "successor_session_id", "successor_generation", "status",
  "last_error", "created_at", "updated_at", "terminal_at",
] as const;

const ORCHESTRATOR_SUCCESSOR_CAPABILITY_V23_COLUMNS = [
  "launch_id", "attestation_handle", "accept_fence", "stop_fence",
] as const;

function normalizeCreateTableSql(sql: string): string {
  return sql
    .replace(/\bif\s+not\s+exists\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function expectedCreateTableDefinition(sql: string, table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table}`;
  const start = sql.indexOf(marker);
  if (start < 0) throw new Error(`migration SQL に table 定義がありません: ${table}`);
  const open = sql.indexOf("(", start + marker.length);
  if (open < 0) throw new Error(`migration SQL の table 定義が不正です: ${table}`);
  let depth = 0;
  for (let index = open; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "(") depth += 1;
    if (character !== ")") continue;
    depth -= 1;
    if (depth === 0) return normalizeCreateTableSql(sql.slice(start, index + 1));
  }
  throw new Error(`migration SQL の table 定義が閉じていません: ${table}`);
}

const ORCHESTRATOR_SUCCESSOR_V23_DEFINITION = expectedCreateTableDefinition(
  MIGRATION_V23_ORCHESTRATOR_SUCCESSOR_SQL,
  "orchestrator_successor_launches",
);
const ORCHESTRATOR_SUCCESSOR_V25_DEFINITION = `${ORCHESTRATOR_SUCCESSOR_V23_DEFINITION.slice(0, -1)}, ${
  ORCHESTRATOR_SUCCESSOR_V25_COLUMN_DEFINITIONS.join(", ").toLowerCase()
})`;
const ORCHESTRATOR_SUCCESSOR_CAPABILITY_V23_DEFINITION = expectedCreateTableDefinition(
  MIGRATION_V23_ORCHESTRATOR_SUCCESSOR_SQL,
  "orchestrator_successor_launch_capabilities",
);

const ORCHESTRATOR_SUCCESSOR_V23_COMPAT_SQL = `
CREATE TABLE IF NOT EXISTS orchestrator_successor_launch_capabilities (
  launch_id TEXT PRIMARY KEY REFERENCES orchestrator_successor_launches(id) ON DELETE CASCADE,
  attestation_handle TEXT NOT NULL DEFAULT '',
  accept_fence TEXT NOT NULL DEFAULT '',
  stop_fence TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestrator_successor_blocking
  ON orchestrator_successor_launches(orchestrator_id)
  WHERE status IN ('armed', 'runtime_bound', 'attested', 'accepting', 'stop_pending', 'uncertain');
CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestrator_successor_provider_session
  ON orchestrator_successor_launches(target_provider, provider_session_id)
  WHERE provider_session_id <> '';
CREATE INDEX IF NOT EXISTS idx_orchestrator_successor_source
  ON orchestrator_successor_launches(source_session_id, source_generation, created_at, id);
`;

const ORCHESTRATOR_SUCCESSOR_RUNTIME_V23_INDEX: ExpectedIndexShape = {
  name: "idx_orchestrator_successor_runtime",
  table: "orchestrator_successor_launches",
  columns: ["observed_host_id", "tmux_pane"],
  unique: true,
  partial: true,
  requiredSqlFragment: "where runtime_ownership_claimed = 1 and observed_host_id <> '' and tmux_pane <> '' and status in ('runtime_bound', 'attested', 'accepting', 'succeeded', 'stop_pending', 'uncertain')",
};

const ORCHESTRATOR_SUCCESSOR_RUNTIME_V25_INDEX: ExpectedIndexShape = {
  name: "idx_orchestrator_successor_runtime",
  table: "orchestrator_successor_launches",
  columns: ["observed_host_id", "tmux_socket_path", "tmux_server_lifetime_hash", "tmux_pane"],
  unique: true,
  partial: true,
  requiredSqlFragment: "where runtime_ownership_claimed = 1 and observed_host_id <> '' and tmux_socket_path <> '' and tmux_server_lifetime_hash <> '' and tmux_pane <> '' and status in ('runtime_bound', 'attested', 'accepting', 'stop_pending', 'uncertain')",
};

function tableHasDefinition(
  db: Database.Database,
  table: string,
  columns: readonly string[],
  expectedDefinition: string,
  foreignKeys: readonly ExpectedForeignKey[],
): boolean {
  return tableHasAllColumns(db, table, columns) &&
    normalizeCreateTableSql(tableDefinition(db, table)) === expectedDefinition &&
    tableHasForeignKeys(db, table, foreignKeys);
}

function migrateOrchestratorSuccessorV23(db: Database.Database): void {
  if (!tableColumnExists(db, "orchestrator_sessions", "provider_session_source")) {
    db.exec(
      `ALTER TABLE orchestrator_sessions ADD COLUMN provider_session_source TEXT NOT NULL DEFAULT ''
       CHECK(provider_session_source IN ('', 'manual', 'codex-session-start', 'claude-delivery'))`,
    );
  }

  const launchExists = tableExists(db, "orchestrator_successor_launches");
  const capabilityExists = tableExists(db, "orchestrator_successor_launch_capabilities");
  const launchRows = tableRowCount(db, "orchestrator_successor_launches");
  const capabilityRows = tableRowCount(db, "orchestrator_successor_launch_capabilities");
  const v25ColumnCount = ORCHESTRATOR_SUCCESSOR_V25_COLUMNS.filter((column) =>
    tableColumnExists(db, "orchestrator_successor_launches", column)
  ).length;
  if (v25ColumnCount > 0 && v25ColumnCount < ORCHESTRATOR_SUCCESSOR_V25_COLUMNS.length) {
    throw new Error("successor launch v25 migrationのruntime identity列が部分適用されています");
  }
  const launchValidV23 = tableHasDefinition(
    db,
    "orchestrator_successor_launches",
    ORCHESTRATOR_SUCCESSOR_V23_COLUMNS,
    ORCHESTRATOR_SUCCESSOR_V23_DEFINITION,
    [
      { from: "orchestrator_id", table: "orchestrators", to: "id" },
      { from: "source_session_id", table: "orchestrator_sessions", to: "id" },
    ],
  );
  const launchValidV25 = v25ColumnCount === ORCHESTRATOR_SUCCESSOR_V25_COLUMNS.length && tableHasDefinition(
    db,
    "orchestrator_successor_launches",
    [...ORCHESTRATOR_SUCCESSOR_V23_COLUMNS, ...ORCHESTRATOR_SUCCESSOR_V25_COLUMNS],
    ORCHESTRATOR_SUCCESSOR_V25_DEFINITION,
    [
      { from: "orchestrator_id", table: "orchestrators", to: "id" },
      { from: "source_session_id", table: "orchestrator_sessions", to: "id" },
    ],
  );
  const launchValid = launchValidV23 || launchValidV25;
  const capabilityValid = tableHasDefinition(
    db,
    "orchestrator_successor_launch_capabilities",
    ORCHESTRATOR_SUCCESSOR_CAPABILITY_V23_COLUMNS,
    ORCHESTRATOR_SUCCESSOR_CAPABILITY_V23_DEFINITION,
    [{ from: "launch_id", table: "orchestrator_successor_launches", to: "id" }],
  );

  let rebuiltLaunch = !launchExists;
  if (!launchExists && capabilityExists) {
    if (capabilityRows > 0) {
      throw new Error("successor launch欠落中のcapability既存行は自動修復できません");
    }
    db.exec(`DROP TABLE orchestrator_successor_launch_capabilities`);
  }
  if (launchExists && !launchValid) {
    if (launchRows > 0 || capabilityRows > 0) {
      throw new Error("successor launch v23 migrationの既存行schemaが不完全なため自動修復できません");
    }
    db.exec(`DROP TABLE IF EXISTS orchestrator_successor_launch_capabilities`);
    db.exec(`DROP TABLE orchestrator_successor_launches`);
    rebuiltLaunch = true;
  }
  if (launchValid && !capabilityExists) {
    if (launchRows > 0) {
      throw new Error("successor capability v23 migrationが既存launchに対して欠落しているため自動修復できません");
    }
  }
  if (launchValid && capabilityExists && !capabilityValid) {
    if (launchRows > 0 || capabilityRows > 0) {
      throw new Error("successor capability v23 migrationの既存行schemaが不完全なため自動修復できません");
    }
    db.exec(`DROP TABLE orchestrator_successor_launch_capabilities`);
  }
  if (rebuiltLaunch) {
    db.prepare(`DELETE FROM schema_migrations WHERE version = 25`).run();
  }
  const v24Applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 24`).get() !== undefined;
  const deferRuntimeIndexToV25 = !rebuiltLaunch && (launchValidV25 || v24Applied);
  const authorityIndexes: readonly ExpectedIndexShape[] = [
    {
      name: "idx_orchestrator_successor_blocking",
      table: "orchestrator_successor_launches",
      columns: ["orchestrator_id"],
      unique: true,
      partial: true,
      requiredSqlFragment: "where status in ('armed', 'runtime_bound', 'attested', 'accepting', 'stop_pending', 'uncertain')",
    },
    ...(deferRuntimeIndexToV25 ? [] : [ORCHESTRATOR_SUCCESSOR_RUNTIME_V23_INDEX]),
    {
      name: "idx_orchestrator_successor_provider_session",
      table: "orchestrator_successor_launches",
      columns: ["target_provider", "provider_session_id"],
      unique: true,
      partial: true,
      requiredSqlFragment: "where provider_session_id <> ''",
    },
  ];
  for (const expected of authorityIndexes) {
    if (namedIndexHasShape(db, expected) !== false) continue;
    const owner = db.prepare(
      `SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?`,
    ).get(expected.name) as { tbl_name: string } | undefined;
    if (owner?.tbl_name !== expected.table) {
      throw new Error(`successor authority index ${expected.name} が別tableを指しているため自動修復できません`);
    }
    db.exec(`DROP INDEX ${expected.name}`);
  }
  db.exec(deferRuntimeIndexToV25
    ? ORCHESTRATOR_SUCCESSOR_V23_COMPAT_SQL
    : MIGRATION_V23_ORCHESTRATOR_SUCCESSOR_SQL);
  const missingCapabilities = (db.prepare(
    `SELECT COUNT(*) AS count
     FROM orchestrator_successor_launches l
     LEFT JOIN orchestrator_successor_launch_capabilities c ON c.launch_id = l.id
     WHERE c.launch_id IS NULL`,
  ).get() as { count: number }).count;
  if (missingCapabilities > 0) {
    throw new Error("successor capability v23 migrationのowner-only rowが欠落しています");
  }
}

function migrateOrchestratorSuccessorV25(db: Database.Database): void {
  const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 25`).get() !== undefined;
  const presentColumns = ORCHESTRATOR_SUCCESSOR_V25_COLUMNS.filter((column) =>
    tableColumnExists(db, "orchestrator_successor_launches", column)
  );
  if (presentColumns.length > 0 && presentColumns.length < ORCHESTRATOR_SUCCESSOR_V25_COLUMNS.length) {
    throw new Error("successor launch v25 migrationのruntime identity列が部分適用されています");
  }

  if (presentColumns.length === ORCHESTRATOR_SUCCESSOR_V25_COLUMNS.length) {
    const definitionValid = tableHasDefinition(
      db,
      "orchestrator_successor_launches",
      [...ORCHESTRATOR_SUCCESSOR_V23_COLUMNS, ...ORCHESTRATOR_SUCCESSOR_V25_COLUMNS],
      ORCHESTRATOR_SUCCESSOR_V25_DEFINITION,
      [
        { from: "orchestrator_id", table: "orchestrators", to: "id" },
        { from: "source_session_id", table: "orchestrator_sessions", to: "id" },
      ],
    );
    if (!definitionValid) {
      throw new Error("successor launch v25 migrationのruntime identity列shapeが不正です");
    }
    if (namedIndexHasShape(db, ORCHESTRATOR_SUCCESSOR_RUNTIME_V25_INDEX) !== true) {
      throw new Error("successor launch v25 migrationのruntime authority indexが欠落または不正です");
    }
    db.prepare(
      `UPDATE orchestrator_successor_launches
       SET runtime_ownership_claimed = 0
       WHERE status IN ('succeeded', 'stopped', 'rejected', 'expired')
         AND runtime_ownership_claimed <> 0`,
    ).run();
    return;
  }

  if (applied) {
    throw new Error("successor launch v25 migration記録済みですがruntime identity列が欠落しています");
  }
  if (namedIndexHasShape(db, ORCHESTRATOR_SUCCESSOR_RUNTIME_V23_INDEX) !== true) {
    throw new Error("successor launch v25 migration前のruntime authority indexが欠落または不正です");
  }

  for (const definition of ORCHESTRATOR_SUCCESSOR_V25_COLUMN_DEFINITIONS) {
    db.exec(`ALTER TABLE orchestrator_successor_launches ADD COLUMN ${definition}`);
  }
  db.exec(`DROP INDEX idx_orchestrator_successor_runtime`);
  db.prepare(
    `UPDATE orchestrator_successor_launches
     SET runtime_ownership_claimed = 0
     WHERE status IN ('succeeded', 'stopped', 'rejected', 'expired')`,
  ).run();
  db.exec(MIGRATION_V25_ORCHESTRATOR_SUCCESSOR_RUNTIME_INDEX_SQL);

  if (normalizedTableDefinition(db, "orchestrator_successor_launches") !== ORCHESTRATOR_SUCCESSOR_V25_DEFINITION ||
      namedIndexHasShape(db, ORCHESTRATOR_SUCCESSOR_RUNTIME_V25_INDEX) !== true) {
    throw new Error("successor launch v25 migration後のschema/index検証に失敗しました");
  }
}

/** §69.4-3 の却下バックオフ窓（秒）。index が却下累計 - 1、末尾が 4 回目以降の上限。 */
const STEWARD_PROPOSAL_DISMISS_WINDOWS: readonly number[] = [86400, 259200, 604800, 2592000];

/** doctor が数える「配送先ゼロでフォールスルーした件数」の既定集計窓（秒）。§40.4 の冪等窓と揃える。 */
const STEWARD_PROPOSAL_UNROUTED_WINDOW_SECONDS = 86400;

/** 却下累計に対応する再提案抑止窓を返す（1 回目 24h → 4 回目以降 720h で頭打ち）。 */
function stewardProposalDismissWindowSeconds(dismissCount: number): number {
  const index = Math.min(Math.max(dismissCount, 1), STEWARD_PROPOSAL_DISMISS_WINDOWS.length) - 1;
  return STEWARD_PROPOSAL_DISMISS_WINDOWS[index] as number;
}

const COMMUNICATION_V20_COLUMNS = [
  "payload", "config_hash", "config_rollout", "config_minimum_runtime_version", "config_same_host_only",
  "config_canary_percent", "capability_hash", "source_binding_hash", "target_binding_hash",
  "claimant_orchestrator_id", "claimant_session_id", "claimant_generation", "claim_lease_until",
  "attempt_nonce_hash", "dispatching_at",
] as const;

const COMMUNICATION_V20_CONFIG_COLUMN_DEFINITIONS = [
  "config_rollout TEXT NOT NULL DEFAULT '' CHECK(config_rollout IN ('', 'off', 'observe', 'canary', 'on', 'draining'))",
  "config_minimum_runtime_version TEXT NOT NULL DEFAULT ''",
  "config_same_host_only INTEGER CHECK(config_same_host_only IS NULL OR config_same_host_only IN (0, 1))",
  "config_canary_percent INTEGER CHECK(config_canary_percent IS NULL OR (config_canary_percent >= 1 AND config_canary_percent <= 100))",
] as const;

/** v20のnative route-specific address。v19のobserve bindingは空文字のまま保持する。 */
function migrateNativeSessionBindingAddressV20(db: Database.Database): void {
  if (tableExists(db, "native_session_bindings") && !tableColumnExists(db, "native_session_bindings", "native_address")) {
    db.exec(`ALTER TABLE native_session_bindings ADD COLUMN native_address TEXT NOT NULL DEFAULT ''`);
  }
}

function communicationAttemptV20Shape(db: Database.Database): boolean {
  if (!tableExists(db, "communication_delivery_attempts")) {
    return false;
  }
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(communication_delivery_attempts)`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const definition = normalizedTableDefinition(db, "communication_delivery_attempts");
  return COMMUNICATION_V20_COLUMNS.every((column) => columns.has(column)) &&
    definition.includes("'dispatching'");
}

/**
 * v19行をv20へ移送する。空の不完全tableは安全に作り直せるが、既存行の不完全schemaは
 * payload/claim証跡を推測補完せずfail-closedにする。
 */
function migrateCommunicationAttemptsV20(db: Database.Database): void {
  // 先行v20実装が既にpayload/hash/leaseを持つ場合は、config snapshot列だけALTERして
  // 既存native行をrebuildで失わない。v19 tableでは後段のrebuildが残りの列を移送する。
  if (tableExists(db, "communication_delivery_attempts")) {
    for (const columnDefinition of COMMUNICATION_V20_CONFIG_COLUMN_DEFINITIONS) {
      const columnName = columnDefinition.slice(0, columnDefinition.indexOf(" "));
      if (!tableColumnExists(db, "communication_delivery_attempts", columnName)) {
        db.exec(`ALTER TABLE communication_delivery_attempts ADD COLUMN ${columnDefinition}`);
      }
    }
  }
  if (communicationAttemptV20Shape(db)) {
    db.exec(MIGRATION_V20_COMMUNICATION_SQL);
    return;
  }
  const attemptExists = tableExists(db, "communication_delivery_attempts");
  const rowCount = tableRowCount(db, "communication_delivery_attempts");
  if (!attemptExists) {
    db.exec(MIGRATION_V20_COMMUNICATION_SQL);
    return;
  }
  const oldColumns = new Set(
    (db.prepare(`PRAGMA table_info(communication_delivery_attempts)`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const requiredV19Columns = [
    "id", "attempt_key", "steer_delivery_id", "source_binding_id", "target_binding_id", "preference", "route",
    "native_candidate", "decision_reason", "status", "receipt_id", "last_error", "actor_kind", "actor_id",
    "actor_session_id", "actor_generation", "created_at", "updated_at", "observed_at", "acknowledged_at", "resolved_at",
  ];
  if (!requiredV19Columns.every((column) => oldColumns.has(column))) {
    if (rowCount > 0) {
      throw new Error("communication attempt v20 migrationの既存行schemaが不完全なため自動修復できません");
    }
    db.exec(`DROP TABLE communication_delivery_attempts`);
    db.exec(MIGRATION_V20_COMMUNICATION_SQL);
    return;
  }

  // 同名indexを一旦落としてからrenameする。データを捨てず、旧status/actor/payloadをそのまま移送する。
  db.exec(`DROP INDEX IF EXISTS idx_communication_attempts_delivery`);
  db.exec(`DROP INDEX IF EXISTS idx_communication_attempts_active_delivery`);
  db.exec(`ALTER TABLE communication_delivery_attempts RENAME TO communication_delivery_attempts_v19`);
  db.exec(MIGRATION_V20_COMMUNICATION_SQL);
  const optionalV20Columns = [
    "payload", "config_hash", "config_rollout", "config_minimum_runtime_version", "config_same_host_only",
    "config_canary_percent", "capability_hash", "source_binding_hash", "target_binding_hash",
    "claimant_orchestrator_id", "claimant_session_id", "claimant_generation", "claim_lease_until",
    "attempt_nonce_hash", "dispatching_at",
  ].filter((column) => oldColumns.has(column));
  const preservedColumns = [...requiredV19Columns, ...optionalV20Columns];
  db.exec(`
    INSERT INTO communication_delivery_attempts (${preservedColumns.join(", ")})
    SELECT ${preservedColumns.join(", ")}
    FROM communication_delivery_attempts_v19
  `);
  db.exec(`DROP TABLE communication_delivery_attempts_v19`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_communication_attempts_delivery
    ON communication_delivery_attempts(steer_delivery_id, created_at, id)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_communication_attempts_active_delivery
    ON communication_delivery_attempts(steer_delivery_id) WHERE status <> 'rejected'`);
}

const TASK_EXECUTION_OVERRIDE_COLUMNS = [
  "speed_override TEXT NOT NULL DEFAULT '' CHECK(speed_override IN ('', 'standard', 'fast'))",
  "review_profile_override TEXT NOT NULL DEFAULT ''",
  "review_provider_override TEXT NOT NULL DEFAULT '' CHECK(review_provider_override IN ('', 'codex', 'claude'))",
  "review_model_override TEXT NOT NULL DEFAULT ''",
  "review_effort_override TEXT NOT NULL DEFAULT '' CHECK(review_effort_override IN ('', 'low', 'medium', 'high', 'xhigh', 'max'))",
  "review_speed_override TEXT NOT NULL DEFAULT '' CHECK(review_speed_override IN ('', 'standard', 'fast'))",
] as const;

/** docs/contract.md §29.1 の schedules テーブル（migration version 5） */
const MIGRATION_V5_SQL = `
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY CHECK(id GLOB 's_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  cadence_kind TEXT NOT NULL CHECK(cadence_kind IN ('daily', 'weekly', 'monthly', 'once')),
  at_minute INTEGER NOT NULL CHECK(at_minute >= 0 AND at_minute <= 59),
  at_hour INTEGER NOT NULL CHECK(at_hour >= 0 AND at_hour <= 23),
  weekday INTEGER CHECK(weekday IS NULL OR (weekday >= 0 AND weekday <= 6)),
  day_of_month INTEGER CHECK(day_of_month IS NULL OR (day_of_month >= 1 AND day_of_month <= 31)),
  run_date TEXT,
  tenant TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL,
  prompt TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_task_id TEXT REFERENCES tasks(id),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
  auto_disabled_reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(
    (cadence_kind = 'daily' AND weekday IS NULL AND day_of_month IS NULL AND run_date IS NULL) OR
    (cadence_kind = 'weekly' AND weekday IS NOT NULL AND day_of_month IS NULL AND run_date IS NULL) OR
    (cadence_kind = 'monthly' AND weekday IS NULL AND day_of_month IS NOT NULL AND run_date IS NULL) OR
    (cadence_kind = 'once' AND weekday IS NULL AND day_of_month IS NULL AND run_date IS NOT NULL)
  )
);
`;

/**
 * migration v3（UNIQUE インデックス作成）の preflight（docs/contract.md §12.11-3）。
 * 既存 DB / import 由来 DB に同一 idempotencyKey を持つ message_processed 行が複数残っていると
 * CREATE UNIQUE INDEX が制約違反で失敗し DB が起動不能になるため、インデックス作成前に
 * 各 idempotencyKey ごと最小 id の行だけを残して重複行を削除する。
 * idempotencyKey を抽出できない行（式が NULL。malformed payload を含む）は対象外とする
 * （SQLite の UNIQUE インデックスは NULL 同士を区別するため、そもそも制約に抵触しない）。
 */
function dedupeMessageProcessedEvents(db: Database.Database): void {
  db.exec(`
    DELETE FROM task_events
    WHERE event_type = 'message_processed'
      AND ${IDEMPOTENCY_KEY_EXPR} IS NOT NULL
      AND id NOT IN (
        SELECT MIN(id)
        FROM task_events
        WHERE event_type = 'message_processed'
          AND ${IDEMPOTENCY_KEY_EXPR} IS NOT NULL
        GROUP BY ${IDEMPOTENCY_KEY_EXPR}
      );
  `);
}

/**
 * malformed（不正 JSON）な message_processed 行を検出し、event_type を
 * 'message_processed_malformed' へ付替して隔離する（docs/contract.md §12.16-2）。
 * 削除はしない（監査を残す）。起動のたびに実行する自己修復ステップで、raw SQL による混入や
 * DB 破損由来の malformed 行を継続的に検知・隔離する（0件ならほぼコスト無しの no-op）。
 */
function isolateMalformedMessageProcessedEvents(db: Database.Database): void {
  db.exec(`
    UPDATE task_events
    SET event_type = 'message_processed_malformed'
    WHERE event_type = 'message_processed' AND NOT json_valid(payload);
  `);
}

/**
 * 指定した index が現在 json_valid ガード付きの式で定義されているかを sqlite_master の SQL 定義
 * 文字列で判定する（docs/contract.md §12.16-2）。CREATE INDEX IF NOT EXISTS は名前が既存なら
 * 定義を更新しないため、記録済みバージョンだけでなく実際の定義を正本として v4 の要否を判定する。
 */
function indexDefinitionIsGuarded(db: Database.Database, indexName: string): boolean {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(indexName) as
    | { sql: string | null }
    | undefined;
  return row !== undefined && row.sql !== null && row.sql.includes("json_valid");
}

function tableColumnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return db.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) !== undefined;
}

function tableHasAllColumns(db: Database.Database, tableName: string, columns: readonly string[]): boolean {
  if (!tableExists(db, tableName)) {
    return false;
  }
  const actual = new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
  return columns.every((column) => actual.has(column));
}

function tableRowCount(db: Database.Database, tableName: string): number {
  if (!tableExists(db, tableName)) {
    return 0;
  }
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count;
}

function tableDefinition(db: Database.Database, tableName: string): string {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) as
    | { sql: string | null }
    | undefined;
  return row?.sql ?? "";
}

function normalizedTableDefinition(db: Database.Database, tableName: string): string {
  return tableDefinition(db, tableName).replace(/\s+/g, " ").trim().toLowerCase();
}

interface ExpectedForeignKey {
  from: string;
  table: string;
  to: string;
}

interface ExpectedIndexShape {
  name: string;
  table: string;
  columns: readonly (string | null)[];
  unique: boolean;
  partial: boolean;
  requiredSqlFragment: string;
}

function tableHasForeignKeys(
  db: Database.Database,
  tableName: string,
  expected: readonly ExpectedForeignKey[],
): boolean {
  if (!tableExists(db, tableName)) {
    return false;
  }
  const actual = db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
    from: string;
    table: string;
    to: string;
  }>;
  return expected.every((foreignKey) => actual.some((row) =>
    row.from === foreignKey.from && row.table === foreignKey.table && row.to === foreignKey.to
  ));
}

function namedIndexHasShape(db: Database.Database, expected: ExpectedIndexShape): boolean | null {
  const definition = db.prepare(
    `SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
  ).get(expected.name) as { tbl_name: string; sql: string | null } | undefined;
  if (definition === undefined) {
    return null;
  }
  if (definition.tbl_name !== expected.table || definition.sql === null) {
    return false;
  }
  const listed = db.prepare(`PRAGMA index_list(${expected.table})`).all() as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;
  const entry = listed.find((row) => row.name === expected.name);
  if (
    entry === undefined || entry.unique !== (expected.unique ? 1 : 0) ||
    entry.partial !== (expected.partial ? 1 : 0)
  ) {
    return false;
  }
  const columns = (db.prepare(`PRAGMA index_info(${expected.name})`).all() as Array<{
    seqno: number;
    name: string | null;
  }>).sort((left, right) => left.seqno - right.seqno).map((row) => row.name);
  if (columns.length !== expected.columns.length || columns.some((column, index) => column !== expected.columns[index])) {
    return false;
  }
  return definition.sql.replace(/\s+/g, " ").trim().toLowerCase().includes(expected.requiredSqlFragment);
}

const NATIVE_SESSION_BINDING_COLUMNS = [
  "id", "binding_key", "kind", "provider", "host_id", "provider_session_id", "runtime_version",
  "capability_hash", "observed_at", "expires_at", "task_id", "run_id", "hachi_session_id", "target_role",
  "expected_cancel_fence", "orchestrator_id", "orchestrator_session_id", "orchestrator_generation", "status",
  "created_at", "updated_at", "released_at",
] as const;

const COMMUNICATION_DELIVERY_ATTEMPT_COLUMNS = [
  "id", "attempt_key", "steer_delivery_id", "source_binding_id", "target_binding_id", "preference", "route",
  "native_candidate", "decision_reason", "status", "receipt_id", "last_error", "actor_kind", "actor_id",
  "actor_session_id", "actor_generation", "created_at", "updated_at", "observed_at", "acknowledged_at", "resolved_at",
] as const;

/**
 * v19記録済みimport/手動復旧DBの空の部分tableだけを安全に再作成する。
 * 行がある不完全tableは情報を捨てず、起動をfail-closedにする。
 */
function repairCommunicationTableShapes(db: Database.Database): void {
  const bindingExists = tableExists(db, "native_session_bindings");
  const attemptExists = tableExists(db, "communication_delivery_attempts");
  const bindingRows = tableRowCount(db, "native_session_bindings");
  const attemptRows = tableRowCount(db, "communication_delivery_attempts");
  const bindingDefinition = normalizedTableDefinition(db, "native_session_bindings");
  const bindingValid = tableHasAllColumns(db, "native_session_bindings", NATIVE_SESSION_BINDING_COLUMNS) && [
    "binding_key text not null unique",
    "kind text not null check(kind in ('source', 'target'))",
    "provider text not null check(provider in ('codex', 'claude'))",
    "host_id text not null check(length(host_id) > 0)",
    "provider_session_id text not null check(length(provider_session_id) > 0)",
    "runtime_version text not null check(length(runtime_version) > 0)",
    "capability_hash text not null check(length(capability_hash) = 64",
    "observed_at integer not null check(observed_at > 0)",
    "expires_at integer not null check(expires_at > observed_at)",
    "task_id text not null references tasks(id)",
    "run_id integer references task_runs(id)",
    "target_role text not null default '' check(target_role in ('', 'worker', 'reviewer'))",
    "expected_cancel_fence integer check(expected_cancel_fence is null or expected_cancel_fence >= 0)",
    "orchestrator_generation integer check(orchestrator_generation is null or orchestrator_generation > 0)",
    "status text not null default 'active' check(status in ('active', 'released'))",
    "kind = 'source' and run_id is null",
    "kind = 'target' and run_id is not null",
  ].every((fragment) => bindingDefinition.includes(fragment)) && tableHasForeignKeys(
    db,
    "native_session_bindings",
    [
      { from: "task_id", table: "tasks", to: "id" },
      { from: "run_id", table: "task_runs", to: "id" },
    ],
  );
  const attemptDefinition = normalizedTableDefinition(db, "communication_delivery_attempts");
  const attemptValid = tableHasAllColumns(
    db,
    "communication_delivery_attempts",
    COMMUNICATION_DELIVERY_ATTEMPT_COLUMNS,
  ) && [
    "attempt_key text not null unique",
    "steer_delivery_id text not null references steer_deliveries(id)",
    "source_binding_id text references native_session_bindings(id)",
    "target_binding_id text references native_session_bindings(id)",
    "preference text not null check(preference in ('auto', 'hachi', 'native'))",
    "route text not null default '' check(route in ('', 'hachi', 'claude-cross-session', 'codex-app-server'))",
    "native_candidate text not null default '' check(native_candidate in ('', 'claude-cross-session', 'codex-app-server'))",
    "status text not null check(status in ( 'recorded'",
    "actor_kind text not null check(actor_kind in ('human', 'orchestrator', 'service', 'unknown'))",
    "actor_generation integer check(actor_generation is null or actor_generation > 0)",
  ].every((fragment) => attemptDefinition.includes(fragment)) &&
    !attemptDefinition.includes("source_binding_id text not null") &&
    !attemptDefinition.includes("target_binding_id text not null") && tableHasForeignKeys(
      db,
      "communication_delivery_attempts",
      [
        { from: "steer_delivery_id", table: "steer_deliveries", to: "id" },
        { from: "source_binding_id", table: "native_session_bindings", to: "id" },
        { from: "target_binding_id", table: "native_session_bindings", to: "id" },
      ],
    );

  if (!bindingExists && attemptRows > 0) {
    throw new Error("native binding table欠落中のcommunication attempt既存行は自動修復できません");
  }
  if (!bindingValid) {
    if (bindingRows > 0 || attemptRows > 0) {
      throw new Error("native communication の不完全tableに既存行があるため自動修復できません");
    }
    if (attemptExists) {
      db.exec(`DROP TABLE communication_delivery_attempts;`);
    }
    if (bindingExists) {
      db.exec(`DROP TABLE native_session_bindings;`);
    }
    return;
  }
  if (!attemptValid && attemptExists) {
    if (attemptRows > 0) {
      throw new Error("communication attempt の不完全tableに既存行があるため自動修復できません");
    }
    db.exec(`DROP TABLE communication_delivery_attempts;`);
  }
}

const COMMUNICATION_INDEX_SHAPES: readonly ExpectedIndexShape[] = [
  {
    name: "idx_native_session_bindings_task_status",
    table: "native_session_bindings",
    columns: ["task_id", "status", "kind"],
    unique: false,
    partial: false,
    requiredSqlFragment: "on native_session_bindings(task_id, status, kind)",
  },
  {
    name: "idx_native_session_bindings_run_status",
    table: "native_session_bindings",
    columns: ["run_id", "status"],
    unique: false,
    partial: false,
    requiredSqlFragment: "on native_session_bindings(run_id, status)",
  },
  {
    name: "idx_communication_attempts_delivery",
    table: "communication_delivery_attempts",
    columns: ["steer_delivery_id", "created_at", "id"],
    unique: false,
    partial: false,
    requiredSqlFragment: "on communication_delivery_attempts(steer_delivery_id, created_at, id)",
  },
  {
    name: "idx_communication_attempts_active_delivery",
    table: "communication_delivery_attempts",
    columns: ["steer_delivery_id"],
    unique: true,
    partial: true,
    requiredSqlFragment: "where status <> 'rejected'",
  },
  {
    name: "idx_direct_restart_intent_key",
    table: "task_events",
    columns: [null],
    unique: true,
    partial: true,
    requiredSqlFragment: "where event_type = 'direct_restart_intent_created' and json_valid(payload) and json_type(payload) = 'object' and json_type(payload, '$.intentkey') = 'text'",
  },
] as const;

/** IF NOT EXISTS が温存する同名wrong indexを、データ破棄なしの境界でだけ自己修復する。 */
function repairCommunicationIndexShapes(db: Database.Database): void {
  for (const expected of COMMUNICATION_INDEX_SHAPES) {
    const shape = namedIndexHasShape(db, expected);
    if (shape === null || shape) {
      continue;
    }
    const owner = db.prepare(
      `SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?`,
    ).get(expected.name) as { tbl_name: string } | undefined;
    if (owner?.tbl_name !== expected.table) {
      throw new Error(`native communication index ${expected.name} が別tableを指しているため自動修復できません`);
    }
    if (tableRowCount(db, expected.table) > 0) {
      throw new Error(`native communication index ${expected.name} の不正shapeに既存行があるため自動修復できません`);
    }
    db.exec(`DROP INDEX ${expected.name}`);
  }
}

function runMigrations(db: Database.Database): void {
  // v1: 基本テーブル一式（schema_migrations 自体もこの DDL に含まれる。CREATE TABLE IF NOT EXISTS で冪等）
  db.exec(MIGRATION_V1_SQL);
  const v1Applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 1`).get();
  if (v1Applied === undefined) {
    db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)`).run(nowSeconds());
  }

  // v2: インデックス追加（docs/contract.md §12.5-4）。CREATE INDEX IF NOT EXISTS で冪等
  db.exec(MIGRATION_V2_SQL);
  const v2Applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 2`).get();
  if (v2Applied === undefined) {
    db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)`).run(nowSeconds());
  }

  // v3: メッセージ冪等キーの部分 UNIQUE インデックス追加（docs/contract.md §12.9-1）。
  const v3Applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 3`).get() !== undefined;
  const v3IndexExists =
    db
      .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_idem_unique'`)
      .get() !== undefined;

  if (!v3Applied || !v3IndexExists) {
    // 契約 §12.11-3: UNIQUE インデックスが未作成の場合は必ず preflight で重複行を解消してから
    // 作成する（同一 Tx。既存 DB / import 由来 DB の起動不能を防ぐ）。
    // schema_migrations に version 3 が記録済みでもインデックス実体が無い import 由来 DB / 手動復旧 DB
    // では、記録の有無だけでなく実際のインデックス存在（v3IndexExists）を正本として preflight を判定する。
    const applyMigrationV3 = db.transaction((): void => {
      dedupeMessageProcessedEvents(db);
      db.exec(MIGRATION_V3_SQL);
      if (!v3Applied) {
        db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)`).run(nowSeconds());
      }
    });
    applyMigrationV3();
  } else {
    // 既に適用済み・インデックスも実在するなら UNIQUE 制約により新たな重複は発生し得ないため
    // preflight は不要。CREATE INDEX IF NOT EXISTS による自己修復チェックのみ毎回行う（冪等・no-op）
    db.exec(MIGRATION_V3_SQL);
  }

  // v4: json_extract の json_valid ガード化（docs/contract.md §12.16-2）。
  // v2/v3 が過去にガード無しの式で作成したインデックスが残る既存 DB では、malformed な payload を
  // 持つ行が式インデックスの評価対象になった瞬間に INSERT/UPDATE/CREATE INDEX が例外化し DB が
  // 起動不能になる。CREATE INDEX IF NOT EXISTS は名前一致で即座に no-op となり定義を更新しないため、
  // 旧インデックスは明示的に DROP してからガード付きの新式で再 CREATE する。
  const v4Applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 4`).get() !== undefined;
  const v4IndexesGuarded =
    indexDefinitionIsGuarded(db, "idx_events_idem") && indexDefinitionIsGuarded(db, "idx_events_idem_unique");

  if (!v4IndexesGuarded) {
    // 旧インデックスが残っている（新規 DB では v2/v3 が既にガード付きで作成済みのためここには来ない）。
    // 旧インデックスを先に落としてから隔離・重複排除・再作成を行う（旧インデックスが生きたままだと
    // malformed payload 行への UPDATE 自体が式評価で例外化するため、この順序が必須）。
    const applyMigrationV4 = db.transaction((): void => {
      db.exec(`DROP INDEX IF EXISTS idx_events_idem;`);
      db.exec(`DROP INDEX IF EXISTS idx_events_idem_unique;`);
      isolateMalformedMessageProcessedEvents(db);
      dedupeMessageProcessedEvents(db);
      db.exec(MIGRATION_V2_SQL);
      db.exec(MIGRATION_V3_SQL);
      if (!v4Applied) {
        db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)`).run(nowSeconds());
      }
    });
    applyMigrationV4();
  } else {
    // 新規 DB は v2/v3 の時点で既にガード付きインデックスが作成されるため、ここでは記録の確定と
    // malformed 行の隔離のみを行う（毎起動で実行し、raw SQL による新規混入も継続的に検知する）。
    if (!v4Applied) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)`).run(nowSeconds());
    }
    isolateMalformedMessageProcessedEvents(db);
  }

  // v5: schedules テーブル追加（docs/contract.md §29.1）。DDL は冪等に毎回実行し、記録だけ未済なら追加する。
  db.exec(MIGRATION_V5_SQL);
  const v5Applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 5`).get();
  if (v5Applied === undefined) {
    db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?)`).run(nowSeconds());
  }

  // v6: tick_metrics テーブル追加（docs/contract.md §43.1）。DDL は冪等に毎回実行し、記録だけ未済なら追加する。
  db.exec(MIGRATION_V6_SQL);
  const v6Applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 6`).get();
  if (v6Applied === undefined) {
    db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)`).run(nowSeconds());
  }

  // v7: lessons テーブル追加（docs/contract.md §44.1）。DDL は冪等に毎回実行し、記録だけ未済なら追加する。
  db.exec(MIGRATION_V7_SQL);
  const v7Applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 7`).get();
  if (v7Applied === undefined) {
    db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (7, ?)`).run(nowSeconds());
  }

  // v8: tasks.watched 列追加（docs/contract.md §46.1）。ALTER TABLE には IF NOT EXISTS が無いため、
  // table_info を正本として列の有無を確認し、記録済みでも列が無ければ自己修復する。
  if (!tableColumnExists(db, "tasks", "watched")) {
    db.exec(MIGRATION_V8_SQL);
  }
  const v8Applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 8`).get();
  if (v8Applied === undefined) {
    db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (8, ?)`).run(nowSeconds());
  }

  // v9: knowledge テーブル追加（docs/contract.md §47.1）。DDL は冪等に毎回実行し、記録だけ未済なら追加する。
  db.exec(MIGRATION_V9_SQL);
  const v9Applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 9`).get();
  if (v9Applied === undefined) {
    db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (9, ?)`).run(nowSeconds());
  }

  // v10: tasks.effort_override 列追加（docs/contract.md §49.3）。v8 と同じく table_info を正本に自己修復する。
  if (!tableColumnExists(db, "tasks", "effort_override")) {
    db.exec(MIGRATION_V10_SQL);
  }
  const v10Applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 10`).get();
  if (v10Applied === undefined) {
    db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (10, ?)`).run(nowSeconds());
  }

  // v11: オーケストレーター identity/session/watch/request/outbox（contract §55）。
  db.exec(MIGRATION_V11_SQL);
  const v11Applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 11`).get();
  if (v11Applied === undefined) {
    db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (11, ?)`).run(nowSeconds());
  }

  // v12: v11先行適用済みDBへtransport別送信記録列を自己修復し、stable identityを一意化する。
  if (!tableColumnExists(db, "notification_outbox", "sent_transports")) {
    db.exec(MIGRATION_V12_SENT_TRANSPORTS_SQL);
  }
  db.exec(MIGRATION_V12_INDEX_SQL);
  const v12Applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 12`).get();
  if (v12Applied === undefined) {
    db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (12, ?)`).run(nowSeconds());
  }

  // v13: runtime resource lease 面。DDL は additive かつ IF NOT EXISTS で、既存DBへ冪等適用する。
  const applyMigrationV13 = db.transaction((): void => {
    db.exec(MIGRATION_V13_SQL);
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 13`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (13, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV13();

  // v14: cleanup escalation generation / human answer nonce を additive に追加する。
  const applyMigrationV14 = db.transaction((): void => {
    // v14 記録済み DB でも cancel DDL の実体を正本として自己修復する。
    db.exec(MIGRATION_V14_CANCEL_SQL);
    if (!tableColumnExists(db, "runtime_cleanup_requests", "escalation_generation")) {
      db.exec(`ALTER TABLE runtime_cleanup_requests ADD COLUMN escalation_generation INTEGER NOT NULL DEFAULT 0`);
    }
    if (!tableColumnExists(db, "runtime_cleanup_requests", "human_answer")) {
      db.exec(`ALTER TABLE runtime_cleanup_requests ADD COLUMN human_answer TEXT NOT NULL DEFAULT ''`);
    }
    if (!tableColumnExists(db, "runtime_cleanup_requests", "human_answer_nonce_hash")) {
      db.exec(`ALTER TABLE runtime_cleanup_requests ADD COLUMN human_answer_nonce_hash TEXT NOT NULL DEFAULT ''`);
    }
    if (!tableColumnExists(db, "runtime_resource_outbox", "transport")) {
      db.exec(`ALTER TABLE runtime_resource_outbox ADD COLUMN transport TEXT NOT NULL DEFAULT 'configured'`);
    }
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 14`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (14, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV14();

  // v15: durable steer lifecycle。記録済み DB でも DDL 実体を冪等に自己修復する。
  const applyMigrationV15 = db.transaction((): void => {
    db.exec(MIGRATION_V15_STEER_SQL);
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 15`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (15, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV15();

  // v16: task event/comment の構造化 actor provenance。version 記録済みでも各列の実体を
  // 正本として部分欠落を自己修復し、4列を同一 transaction で揃える。
  const applyMigrationV16 = db.transaction((): void => {
    for (const tableName of ["task_events", "task_comments"] as const) {
      for (const columnDefinition of ACTOR_PROVENANCE_COLUMNS) {
        const columnName = columnDefinition.slice(0, columnDefinition.indexOf(" "));
        if (!tableColumnExists(db, tableName, columnName)) {
          db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
        }
      }
    }
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 16`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (16, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV16();

  // v17: knowledge の構造化 actor provenance。version記録済みでも列実体を正本に自己修復する。
  const applyMigrationV17 = db.transaction((): void => {
    for (const columnDefinition of ACTOR_PROVENANCE_COLUMNS) {
      const columnName = columnDefinition.slice(0, columnDefinition.indexOf(" "));
      if (!tableColumnExists(db, "knowledge", columnName)) {
        db.exec(`ALTER TABLE knowledge ADD COLUMN ${columnDefinition}`);
      }
    }
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 17`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (17, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV17();

  // v18: task非依存のboard audit面。v17のknowledge provenance後にadditive適用する。
  const applyMigrationV18 = db.transaction((): void => {
    db.exec(MIGRATION_V18_BOARD_AUDIT_SQL);
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 18`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (18, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV18();

  // v19: role別execution overrideとnative communication面。version記録済みでも列/table実体を自己修復する。
  const applyMigrationV19 = db.transaction((): void => {
    for (const columnDefinition of TASK_EXECUTION_OVERRIDE_COLUMNS) {
      const columnName = columnDefinition.slice(0, columnDefinition.indexOf(" "));
      if (!tableColumnExists(db, "tasks", columnName)) {
        db.exec(`ALTER TABLE tasks ADD COLUMN ${columnDefinition}`);
      }
    }
    repairCommunicationTableShapes(db);
    repairCommunicationIndexShapes(db);
    db.exec(MIGRATION_V19_COMMUNICATION_SQL);
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 19`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (19, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV19();

  // v20: native delivery attempt lifecycle。旧v19 observe行はstatus/metadataを保持したまま移送し、
  // partial schemaは空tableだけ自己修復、既存データを推測補完する場合はfail-closedにする。
  const applyMigrationV20 = db.transaction((): void => {
    migrateNativeSessionBindingAddressV20(db);
    migrateCommunicationAttemptsV20(db);
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 20`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (20, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV20();

  // v21: contract §69 の steward 提案 request family。additive な table/index 追加のみで既存行に触れない。
  // version 記録済みでも table 実体が欠けていれば CREATE TABLE IF NOT EXISTS が正本として再作成する。
  const applyMigrationV21 = db.transaction((): void => {
    db.exec(MIGRATION_V21_STEWARD_PROPOSAL_SQL);
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 21`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (21, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV21();

  // v22: heartbeat stale gap を session/generation 単位で固定する additive incident 面。
  const applyMigrationV22 = db.transaction((): void => {
    db.exec(MIGRATION_V22_ORCHESTRATOR_LIVENESS_SQL);
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 22`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (22, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV22();

  // v23: provider session source と durable successor launch authority。
  // version 記録済みでも欠けた additive index/table は再作成し、データ入りpartial schemaはfail-closedにする。
  const applyMigrationV23 = db.transaction((): void => {
    migrateOrchestratorSuccessorV23(db);
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 23`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (23, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV23();

  // v24: external runtime generation のstatus replay fenceとrun launch binding。
  // repository-only consumer の additive table/index であり、既存run/metaは推定変換しない。
  const applyMigrationV24 = db.transaction((): void => {
    db.exec(MIGRATION_V24_EXTERNAL_RUNTIME_GENERATION_SQL);
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 24`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (24, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV24();

  // v25: tmux server lifetimeを含むruntime identityへ移行する。列追加・旧index drop・terminal claim解放・
  // 新index作成・version記録を必ずこの単一transaction内で行い、legacy lifetimeは推測補完しない。
  const applyMigrationV25 = db.transaction((): void => {
    migrateOrchestratorSuccessorV25(db);
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 25`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (25, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV25.immediate();

  // v26: DBを作り直すたびに変わる128bit乱数のboard instance識別子を1回だけ永続化する。
  const applyMigrationV26 = db.transaction((): void => {
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 26`).get();
    if (applied !== undefined) {
      const row = db.prepare(
        `SELECT singleton, board_instance_id FROM board_metadata WHERE singleton = 1`,
      ).get() as BoardMetadataRow | undefined;
      if (row === undefined) {
        throw new Error("migration v26 適用済みですが boardInstanceId が欠落しています");
      }
      assertBoardMetadataRow(row);
      return;
    }

    db.exec(MIGRATION_V26_BOARD_METADATA_SQL);
    const rows = db.prepare(
      `SELECT singleton, board_instance_id FROM board_metadata ORDER BY singleton`,
    ).all() as BoardMetadataRow[];
    if (rows.length > 1) {
      throw new Error("migration v26 適用前の board metadata に複数行があります");
    }
    if (rows.length === 0) {
      db.prepare(
        `INSERT INTO board_metadata (singleton, board_instance_id) VALUES (1, ?)`,
      ).run(randomBytes(16).toString("hex"));
    } else {
      assertBoardMetadataRow(rows[0]!);
    }
    db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (26, ?)`).run(nowSeconds());
  });
  applyMigrationV26();

  // v27: tenant 既定で配送した steward 提案の routing 根拠を request 行にも永続化する。
  const applyMigrationV27 = db.transaction((): void => {
    if (!tableColumnExists(db, "steward_proposal_requests", "routed_by")) {
      db.exec(`ALTER TABLE steward_proposal_requests ADD COLUMN ${STEWARD_PROPOSAL_V27_ROUTED_BY_COLUMN}`);
    }
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 27`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (27, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV27();

  // v28: half-open claim の outbox（契約 §40.1.1）。CREATE TABLE IF NOT EXISTS で冪等。
  const applyMigrationV28 = db.transaction((): void => {
    db.exec(MIGRATION_V28_HALF_OPEN_OUTBOX_SQL);
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 28`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (28, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV28();

  // v29: 契約 §77.4 / §77.9 のテーブル。CREATE TABLE IF NOT EXISTS で冪等。
  const applyMigrationV29 = db.transaction((): void => {
    db.exec(MIGRATION_V29_SESSION_USAGE_PROFILES_SQL);
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 29`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (29, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV29();

  // v30: 契約 §78.5.1 の relay_delivery_uncertain_events。CREATE TABLE IF NOT EXISTS で冪等。
  const applyMigrationV30 = db.transaction((): void => {
    db.exec(MIGRATION_V30_RELAY_DELIVERY_UNCERTAIN_EVENTS_SQL);
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 30`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (30, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV30();

  // v31: 契約 §78.10 のproduction host登録authority durable面。CREATE TABLE IF NOT EXISTSで冪等。
  const applyMigrationV31 = db.transaction((): void => {
    db.exec(MIGRATION_V31_RELAY_AUTHORITY_SQL);
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 31`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (31, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV31();

  // v32: 契約 §80 の独立human decision request family。
  const applyMigrationV32 = db.transaction((): void => {
    db.exec(MIGRATION_V32_HUMAN_DECISION_SQL);
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 32`).get();
    if (applied === undefined) {
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (32, ?)`).run(nowSeconds());
    }
  });
  applyMigrationV32();
}

/** runTransition に渡す遷移オプション。すべてのキーは常に存在させ、値側で optional を表現する
 * （exactOptionalPropertyTypes 対策：optional キーへの明示的 undefined 代入を避けるため） */
interface RunTransitionOptions {
  reason: string | undefined;
  actor: string;
  eventType: string;
  payload: Record<string, unknown>;
  assignee: string | undefined;
  provenance: ActorProvenance | undefined;
}

const RUN_CANCEL_TERMINAL_STATUSES: ReadonlySet<RunCancelStatus> = new Set(["stopped", "failed", "expired"]);
const RUN_CANCEL_TRANSITIONS: Readonly<Record<RunCancelStatus, readonly RunCancelStatus[]>> = {
  cancel_requested: ["cooperative_sent", "forcing", "stopped", "failed", "expired"],
  cooperative_sent: ["acknowledged", "forcing", "stopped", "failed", "expired"],
  acknowledged: ["forcing", "stopped", "failed", "expired"],
  forcing: ["stopped", "failed", "expired"],
  stopped: [],
  failed: [],
  expired: [],
};

const RUN_CANCEL_EVENT_TYPES: Readonly<Record<RunCancelStatus, string>> = {
  cancel_requested: "cancel_requested",
  cooperative_sent: "cancel_injected",
  acknowledged: "cancel_acknowledged",
  forcing: "cancel_force_started",
  stopped: "cancel_stopped",
  failed: "cancel_failed",
  expired: "cancel_expired",
};

function sanitizeRunCancelJson(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRunCancelJson(item));
  }
  if (typeof value === "object" && value !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = /token|secret|password|credential|authorization|environment|transcript|(^|_)env($|_)/i.test(key)
        ? "[REDACTED]"
        : sanitizeRunCancelJson(nested);
    }
    return sanitized;
  }
  return value;
}

function serializeRedactedJson(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(sanitizeRunCancelJson(value ?? {}));
}

interface NormalizedScheduleInput {
  name: string;
  cadenceKind: ScheduleCadence;
  atMinute: number;
  atHour: number;
  weekday: number | null;
  dayOfMonth: number | null;
  runDate: string | null;
  tenant: string;
  profile: string;
  cwd: string;
  prompt: string;
  priority: number;
}

interface ScheduleValidationValues {
  name: unknown;
  cadenceKind: unknown;
  atMinute: unknown;
  atHour: unknown;
  weekday: unknown;
  dayOfMonth: unknown;
  runDate: unknown;
  tenant: unknown;
  profile: unknown;
  cwd: unknown;
  prompt: unknown;
  priority: unknown;
}

interface TickMetricInput {
  stage: string;
  actions: number;
  durationMs: number;
}

export interface KnowledgeAddInput {
  title: string;
  body: string;
  source?: string;
  tags?: string[];
  importance?: number;
  expiresAt?: number | null;
  originPath?: string;
  createdAt?: number;
}

export interface KnowledgeListOptions {
  tag?: string;
  source?: string;
  search?: string;
  includeExpired?: boolean;
  limit?: number;
}

interface NormalizedLessonInput {
  trigger: LessonTrigger;
  tenant: string;
  cwd: string;
  profile: string;
  body: string;
  sourceTaskId: string;
}

interface NormalizedKnowledgeInput {
  title: string;
  body: string;
  source: string;
  tags: string[];
  importance: number;
  expiresAt: number | null;
  originPath: string;
  createdAt: number | null;
}

function assertTickMetricInput(metric: TickMetricInput): void {
  if (metric.stage.trim() === "") {
    throw new Error("tick metric の stage は空にできません");
  }
  if (!Number.isInteger(metric.actions) || metric.actions < 0) {
    throw new Error(`tick metric の actions は 0 以上の整数が必須です: ${metric.actions}`);
  }
  if (!Number.isInteger(metric.durationMs) || metric.durationMs < 0) {
    throw new Error(`tick metric の durationMs は 0 以上の整数が必須です: ${metric.durationMs}`);
  }
}

function acknowledgeActor(actor: string): void {
  if (typeof actor !== "string") {
    throw new Error("actor は文字列が必須です");
  }
}

function normalizeActorProvenance(provenance: ActorProvenance | undefined): ActorProvenance {
  const normalized: ActorProvenance = provenance === undefined
    ? { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null }
    : {
        kind: provenance.kind,
        actorId: requireString(provenance.actorId, "actorId"),
        actorSessionId: requireString(provenance.actorSessionId, "actorSessionId"),
        actorGeneration: provenance.actorGeneration,
      };

  if (normalized.actorGeneration !== null &&
      (!Number.isInteger(normalized.actorGeneration) || normalized.actorGeneration <= 0)) {
    throw new Error("actorGeneration は null または正の整数が必須です");
  }

  switch (normalized.kind) {
    case "unknown":
      if (normalized.actorId !== "" || normalized.actorSessionId !== "" || normalized.actorGeneration !== null) {
        throw new Error("unknown provenance は actorId/session/generation を持てません");
      }
      break;
    case "human":
      if (normalized.actorSessionId !== "" || normalized.actorGeneration !== null) {
        throw new Error("human provenance は session/generation を持てません");
      }
      break;
    case "orchestrator":
      if (normalized.actorId.trim() === "" || normalized.actorSessionId.trim() === "" ||
          normalized.actorGeneration === null) {
        throw new Error("orchestrator provenance は identity/session/正の generation が必須です");
      }
      break;
    case "service":
      if (!/^[A-Za-z0-9._:-]+$/.test(normalized.actorId)) {
        throw new Error("service provenance は安全な非空 actorId が必須です");
      }
      if (normalized.actorSessionId !== "" || normalized.actorGeneration !== null) {
        throw new Error("service provenance は session/generation を持てません");
      }
      break;
    default: {
      const exhaustive: never = normalized.kind;
      throw new Error(`未知の actor kind です: ${String(exhaustive)}`);
    }
  }
  return normalized;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} は文字列が必須です`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (text.trim().length === 0) {
    throw new Error(`${label} は空にできません`);
  }
  return text;
}

function requireIntegerInRange(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} は ${min}〜${max} の整数が必須です`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} は 0 以上の整数が必須です`);
  }
  return value;
}

const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SUCCESSOR_ATTESTATION_TTL_SECONDS = 30;

function normalizeNativeBindingEvidence(input: {
  runtimeVersion: string;
  capabilityHash: string;
  observedAt: number;
  expiresAt: number;
}): { runtimeVersion: string; capabilityHash: string; observedAt: number; expiresAt: number } {
  const runtimeVersion = requireNonEmptyString(input.runtimeVersion, "native binding runtime version").trim();
  const capabilityHash = requireNonEmptyString(input.capabilityHash, "native binding capability hash").trim();
  if (!STRICT_SEMVER.test(runtimeVersion)) {
    throw new Error(`native binding runtime versionはstrict semverが必須です: ${runtimeVersion}`);
  }
  if (!SHA256_HEX.test(capabilityHash)) {
    throw new Error("native binding capability hashはlowercase sha256 hexが必須です");
  }
  if (!Number.isInteger(input.observedAt) || input.observedAt <= 0 || input.observedAt > nowSeconds()) {
    throw new Error("native binding observedAtは現在以前の正のepoch秒が必須です");
  }
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= input.observedAt || input.expiresAt <= nowSeconds()) {
    throw new Error("native binding expiresAtはobservedAtと現在時刻より後のepoch秒が必須です");
  }
  return { runtimeVersion, capabilityHash, observedAt: input.observedAt, expiresAt: input.expiresAt };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeNativeHash(value: unknown, label: string): string {
  const hash = requireNonEmptyString(value, label).trim();
  if (!SHA256_HEX.test(hash)) {
    throw new Error(`${label}はlowercase sha256 hexが必須です`);
  }
  return hash;
}

/**
 * Provider adapterが返す再接続可能なexact addressだけをcanonical JSONとして保存する。
 * provider session名や表示名だけの値、route/providerの取り違えはここで拒否する。
 */
function normalizeNativeAddress(value: NativeCommunicationAddress | string | undefined, provider: Provider): string {
  if (value === undefined || value === "") return "";
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("native addressはcanonical JSON objectが必須です");
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("native addressはobjectが必須です");
  }
  const record = parsed as Record<string, unknown>;
  const expectedRoute = nativeRouteForProvider(provider);
  if (record["route"] !== expectedRoute) {
    throw new Error("native address routeがproviderと一致しません");
  }
  const textField = (key: string): string => {
    const field = record[key];
    if (typeof field !== "string" || field.trim() === "" || field.length > 4096) {
      throw new Error(`native address ${key}は非空文字列が必須です`);
    }
    return field;
  };
  if (expectedRoute === "codex-app-server") {
    const threadId = textField("threadId");
    const activeTurnId = textField("activeTurnId");
    const socketSnapshot = normalizeNativeSocketSnapshot(record["socketSnapshot"]);
    return JSON.stringify({ route: expectedRoute, threadId, activeTurnId, socketSnapshot });
  }
  const agentRef = textField("agentRef");
  return JSON.stringify({ route: expectedRoute, agentRef });
}

function normalizeNativeSocketSnapshot(value: unknown): NativeCommunicationSocketSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("native address socketSnapshotはobjectが必須です");
  }
  const record = value as Record<string, unknown>;
  const pathField = (key: "canonicalPath" | "parentCanonicalPath"): string => {
    const field = record[key];
    if (typeof field !== "string" || field === "" || !field.startsWith("/")) {
      throw new Error(`native address socketSnapshot ${key}はabsolute pathが必須です`);
    }
    return field;
  };
  const numberField = (key: keyof NativeCommunicationSocketSnapshot): number => {
    const field = record[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
      throw new Error(`native address socketSnapshot ${key}は0以上のsafe integerが必須です`);
    }
    return field;
  };
  const canonicalPath = pathField("canonicalPath");
  const parentCanonicalPath = pathField("parentCanonicalPath");
  const parentDev = numberField("parentDev");
  const parentIno = numberField("parentIno");
  const parentUid = numberField("parentUid");
  const parentMode = numberField("parentMode");
  const dev = numberField("dev");
  const ino = numberField("ino");
  const uid = numberField("uid");
  const gid = numberField("gid");
  const mode = numberField("mode");
  if (parentMode > 0o777 || mode > 0o777 || (parentMode & 0o077) !== 0 || (mode & 0o077) !== 0) {
    throw new Error("native address socketSnapshot modeはprivate 0o700以下が必須です");
  }
  return {
    canonicalPath,
    parentCanonicalPath,
    parentDev,
    parentIno,
    parentUid,
    parentMode,
    dev,
    ino,
    uid,
    gid,
    mode,
  };
}

function assertNativeAddressForRoute(value: string, route: "claude-cross-session" | "codex-app-server"): void {
  if (value === "") {
    throw new Error("native communication bindingにroute-specific native addressがありません");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("native communication bindingのnative addressが不正です");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      (parsed as Record<string, unknown>)["route"] !== route) {
    throw new Error("native communication bindingのnative address routeが一致しません");
  }
  // normalizeNativeAddressと同じshapeを通すことで、DB直編集された値もfail-closedにする。
  normalizeNativeAddress(value, route === "claude-cross-session" ? "claude" : "codex");
}

function normalizeNativeConfigSnapshot(value: NativeCommunicationConfigSnapshot): {
  rollout: "canary" | "on";
  minimumRuntimeVersion: string;
  sameHostOnly: true;
  canaryPercent: number | null;
} {
  if (value.rollout !== "canary" && value.rollout !== "on") {
    throw new Error("native config snapshot rolloutはcanary/onが必須です");
  }
  const minimumRuntimeVersion = requireNonEmptyString(
    value.minimumRuntimeVersion,
    "native config snapshot minimum runtime version",
  ).trim();
  if (!STRICT_SEMVER.test(minimumRuntimeVersion)) {
    throw new Error("native config snapshot minimum runtime versionはstrict semverが必須です");
  }
  if (value.sameHostOnly !== true) {
    throw new Error("native config snapshot sameHostOnly=trueが必須です");
  }
  const canaryPercent = value.canaryPercent;
  if (value.rollout === "canary") {
    if (typeof canaryPercent !== "number" || !Number.isInteger(canaryPercent) || canaryPercent < 1 || canaryPercent > 100) {
      throw new Error("native config snapshot canaryPercentは1〜100の整数が必須です");
    }
    return { rollout: value.rollout, minimumRuntimeVersion, sameHostOnly: true, canaryPercent };
  }
  if (canaryPercent !== undefined && (!Number.isInteger(canaryPercent) || canaryPercent < 1 || canaryPercent > 100)) {
    throw new Error("native config snapshot canaryPercentは1〜100の整数が必須です");
  }
  return { rollout: value.rollout, minimumRuntimeVersion, sameHostOnly: true, canaryPercent: null };
}

function normalizeNativePayload(value: unknown, fallback: unknown): string {
  const payload = value === undefined ? fallback : value;
  if (payload === undefined) {
    throw new Error("native communication payloadは必須です");
  }
  if (typeof payload === "string") {
    const redacted = redactMaybeJsonText(payload);
    if (redacted.trim() === "") {
      throw new Error("native communication payloadは空にできません");
    }
    return redacted;
  }
  const redacted = redactJsonStrings(payload);
  const serialized = JSON.stringify(redacted);
  if (serialized === undefined || serialized === "") {
    throw new Error("native communication payloadをJSON化できません");
  }
  return serialized;
}

function semverTuple(value: string): [number, number, number, string] {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(value);
  if (match === null) {
    throw new Error(`runtime versionがstrict semverではありません: ${value}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""];
}

function compareStrictSemver(left: string, right: string): number {
  const a = semverTuple(left);
  const b = semverTuple(right);
  const [aMajor, aMinor, aPatch] = a;
  const [bMajor, bMinor, bPatch] = b;
  if (aMajor !== bMajor) return aMajor > bMajor ? 1 : -1;
  if (aMinor !== bMinor) return aMinor > bMinor ? 1 : -1;
  if (aPatch !== bPatch) return aPatch > bPatch ? 1 : -1;
  // A release is newer than a prerelease. For two prereleases, lexical order is
  // conservative and deterministic; the trusted policy should normally pin exact versions.
  if (a[3] === b[3]) return 0;
  if (a[3] === "") return 1;
  if (b[3] === "") return -1;
  return a[3] > b[3] ? 1 : -1;
}

function requireNativeLeaseSeconds(value: number | undefined): number {
  const lease = value ?? 60;
  if (!Number.isInteger(lease) || lease <= 0 || lease > 86_400) {
    throw new Error("native communication claim leaseは1〜86400秒の整数が必須です");
  }
  return lease;
}

function nativeRouteForProvider(provider: Provider): "claude-cross-session" | "codex-app-server" {
  return provider === "claude" ? "claude-cross-session" : "codex-app-server";
}

function nativeCapabilitySnapshotHash(sourceCapabilityHash: string, targetCapabilityHash: string): string {
  return sha256Hex(JSON.stringify({ source: sourceCapabilityHash, target: targetCapabilityHash }));
}

/** SQLite LIKE のワイルドカードをリテラル検索にする */
function escapeLikePattern(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function requireCadenceKind(value: unknown): ScheduleCadence {
  if (value === "daily" || value === "weekly" || value === "monthly" || value === "once") {
    return value;
  }
  throw new Error(`未知の cadenceKind です: ${String(value)}`);
}

function requireRunDate(value: unknown): string {
  const runDate = requireString(value, "runDate");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(runDate);
  if (match === null) {
    throw new Error(`runDate は YYYY-MM-DD 形式が必須です: ${runDate}`);
  }
  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  if (yearText === undefined || monthText === undefined || dayText === undefined) {
    throw new Error(`runDate は YYYY-MM-DD 形式が必須です: ${runDate}`);
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!Number.isInteger(year) || year < 1 || month < 1 || month > 12 || day < 1 || day > lastDay) {
    throw new Error(`runDate の日付が不正です: ${runDate}`);
  }
  return runDate;
}

function normalizeScheduleValues(values: ScheduleValidationValues): NormalizedScheduleInput {
  const name = requireNonEmptyString(values.name, "name");
  const cadenceKind = requireCadenceKind(values.cadenceKind);
  const atMinute = requireIntegerInRange(values.atMinute, "atMinute", 0, 59);
  const atHour = requireIntegerInRange(values.atHour, "atHour", 0, 23);
  const tenant = requireString(values.tenant, "tenant");
  const profile = requireString(values.profile, "profile");
  const cwd = requireNonEmptyString(values.cwd, "cwd");
  const prompt = requireNonEmptyString(values.prompt, "prompt");
  const priority = requireIntegerInRange(values.priority, "priority", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);

  if (!isAbsolute(cwd)) {
    throw new Error(`cwd は絶対パスが必須です: ${cwd}`);
  }

  if (cadenceKind === "daily") {
    return {
      name,
      cadenceKind,
      atMinute,
      atHour,
      weekday: null,
      dayOfMonth: null,
      runDate: null,
      tenant,
      profile,
      cwd,
      prompt,
      priority,
    };
  }

  if (cadenceKind === "weekly") {
    return {
      name,
      cadenceKind,
      atMinute,
      atHour,
      weekday: requireIntegerInRange(values.weekday, "weekday", 0, 6),
      dayOfMonth: null,
      runDate: null,
      tenant,
      profile,
      cwd,
      prompt,
      priority,
    };
  }

  if (cadenceKind === "monthly") {
    return {
      name,
      cadenceKind,
      atMinute,
      atHour,
      weekday: null,
      dayOfMonth: requireIntegerInRange(values.dayOfMonth, "dayOfMonth", 1, 31),
      runDate: null,
      tenant,
      profile,
      cwd,
      prompt,
      priority,
    };
  }

  return {
    name,
    cadenceKind,
    atMinute,
    atHour,
    weekday: null,
    dayOfMonth: null,
    runDate: requireRunDate(values.runDate),
    tenant,
    profile,
    cwd,
    prompt,
    priority,
  };
}

function normalizeScheduleInput(input: ScheduleCreateInput): NormalizedScheduleInput {
  return normalizeScheduleValues({
    name: input.name,
    cadenceKind: input.cadenceKind,
    atMinute: input.atMinute,
    atHour: input.atHour,
    weekday: input.weekday,
    dayOfMonth: input.dayOfMonth,
    runDate: input.runDate,
    tenant: input.tenant !== undefined ? input.tenant : "",
    profile: input.profile !== undefined ? input.profile : "",
    cwd: input.cwd,
    prompt: input.prompt,
    priority: input.priority !== undefined ? input.priority : 0,
  });
}

function normalizeSchedulePatch(current: ScheduleRow, patch: Partial<ScheduleCreateInput>): NormalizedScheduleInput {
  return normalizeScheduleValues({
    name: patch.name !== undefined ? patch.name : current.name,
    cadenceKind: patch.cadenceKind !== undefined ? patch.cadenceKind : current.cadenceKind,
    atMinute: patch.atMinute !== undefined ? patch.atMinute : current.atMinute,
    atHour: patch.atHour !== undefined ? patch.atHour : current.atHour,
    weekday: patch.weekday !== undefined ? patch.weekday : current.weekday,
    dayOfMonth: patch.dayOfMonth !== undefined ? patch.dayOfMonth : current.dayOfMonth,
    runDate: patch.runDate !== undefined ? patch.runDate : current.runDate,
    tenant: patch.tenant !== undefined ? patch.tenant : current.tenant,
    profile: patch.profile !== undefined ? patch.profile : current.profile,
    cwd: patch.cwd !== undefined ? patch.cwd : current.cwd,
    prompt: patch.prompt !== undefined ? patch.prompt : current.prompt,
    priority: patch.priority !== undefined ? patch.priority : current.priority,
  });
}

function requireLessonTrigger(value: unknown): LessonTrigger {
  if (isLessonTrigger(value)) {
    return value;
  }
  throw new Error(`未知の lesson trigger です: ${String(value)}`);
}

function normalizeCwdValue(value: unknown): string {
  const text = requireString(value, "cwd").trim();
  if (text === "/") {
    return text;
  }
  return text.replace(/\/+$/g, "");
}

function normalizeLessonInput(input: LessonCreateInput): NormalizedLessonInput {
  return {
    trigger: requireLessonTrigger(input.trigger),
    tenant: requireString(input.tenant, "tenant"),
    cwd: normalizeCwdValue(input.cwd),
    profile: requireString(input.profile, "profile"),
    body: requireNonEmptyString(input.body, "body").trim(),
    sourceTaskId: requireNonEmptyString(input.sourceTaskId, "sourceTaskId"),
  };
}

function normalizeKnowledgeTags(tags: string[] | undefined): string[] {
  if (tags === undefined) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const text = requireString(tag, "tag").trim();
    if (text !== "" && !seen.has(text)) {
      seen.add(text);
      normalized.push(text);
    }
  }
  return normalized;
}

function normalizeOptionalEpoch(value: number | null | undefined, label: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireNonNegativeInteger(value, label);
}

function normalizeKnowledgeInput(input: KnowledgeAddInput): NormalizedKnowledgeInput {
  return {
    title: requireNonEmptyString(input.title, "title").trim(),
    body: requireNonEmptyString(input.body, "body"),
    source: requireNonEmptyString(input.source !== undefined ? input.source : "manual", "source").trim(),
    tags: normalizeKnowledgeTags(input.tags),
    importance:
      input.importance !== undefined ? requireIntegerInRange(input.importance, "importance", 0, 100) : 50,
    expiresAt: normalizeOptionalEpoch(input.expiresAt, "expiresAt"),
    originPath: requireString(input.originPath !== undefined ? input.originPath : "", "originPath"),
    createdAt:
      input.createdAt !== undefined ? requireNonNegativeInteger(input.createdAt, "createdAt") : null,
  };
}

function hashKnowledgeBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function extractCwdFromBody(body: string): string {
  const value = extractDeliveryWorktreeFromBody(body);
  return value.length > 0 ? normalizeCwdValue(value) : "";
}

function buildUserDecisionLessonBody(reason: string, to: TaskStatus): string {
  const summary = reason.slice("user-decision:".length).trim();
  const redactedSummary = redactText(summary);
  const cause = redactedSummary.length > 0 ? redactedSummary : "要約なし";
  return `user-decision 解消: ${cause}。解除先: ${to}`;
}

function normalizeManualProviderSessionIdentity(
  provider: Provider | "",
  rawProviderSessionId: string,
): { provider: Provider | ""; providerSessionId: string; providerSessionSource: ProviderSessionSource | "" } {
  const providerSessionId = rawProviderSessionId.trim();
  if ((provider === "") !== (providerSessionId === "")) {
    throw new Error("provider と provider session ID は両方指定または両方省略してください");
  }
  return {
    provider,
    providerSessionId,
    providerSessionSource: provider === "" ? "" : "manual",
  };
}

export class SqliteKanbanStore implements
  KanbanStore,
  FencedRunCancelRequestStore,
  NativeCommunicationStore,
  DirectRestartAuthorityStore,
  OrchestratorSuccessorLaunchStore,
  OrchestratorSuccessorFencedCloseStore,
  ExternalRuntimeGenerationStore,
  RelayControlPersistence,
  RelayOwnerAuthorityStore,
  HumanDecisionRequestStore {
  private readonly db: Database.Database;
  private relayAuthorityMutationInFlight = false;
  private relayAuthorityCallbackStarted = false;
  private relayAuthorityReentrantAttempted = false;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    try {
      if (dbPath !== ":memory:") {
        this.db.pragma("journal_mode = WAL");
      }
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("foreign_keys = ON");
      runMigrations(this.db);
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // close失敗で初期化時の元errorを上書きしない。
      }
      throw error;
    }
  }

  /** 現在の Store transaction 内で provenance を正規化し、orchestrator authority を再照合する。 */
  private authorizeActorProvenance(provenance: ActorProvenance | undefined): ActorProvenance {
    const normalized = normalizeActorProvenance(provenance);
    if (normalized.kind !== "orchestrator") {
      return normalized;
    }
    const matched = this.db
      .prepare(
        `SELECT 1 AS matched
         FROM orchestrator_sessions
         WHERE id = ? AND orchestrator_id = ? AND generation = ? AND status = 'active'`,
      )
      .get(normalized.actorSessionId, normalized.actorId, normalized.actorGeneration);
    if (matched === undefined) {
      throw new Error("active orchestrator session generation が完全一致しません");
    }
    return normalized;
  }

  /** §80 mutation用。表示名ではなくactive exact session/generationをauthorityとする。 */
  private authorizeHumanDecisionOrchestrator(provenance: ActorProvenance): ActorProvenance & {
    kind: "orchestrator";
    actorGeneration: number;
  } {
    let normalized: ActorProvenance;
    try {
      normalized = normalizeActorProvenance(provenance);
    } catch (error) {
      throw new HumanDecisionError("ACTOR_UNAUTHORIZED", error instanceof Error ? error.message : String(error));
    }
    if (normalized.kind !== "orchestrator" || normalized.actorGeneration === null) {
      throw new HumanDecisionError("ACTOR_UNAUTHORIZED", "orchestrator provenanceが必須です");
    }
    const session = this.db.prepare(
      `SELECT orchestrator_id, generation, status FROM orchestrator_sessions WHERE id = ?`,
    ).get(normalized.actorSessionId) as { orchestrator_id: string; generation: number; status: string } | undefined;
    if (session === undefined || session.orchestrator_id !== normalized.actorId) {
      throw new HumanDecisionError("ACTOR_UNAUTHORIZED", "sessionとstable identityが一致しません");
    }
    if (session.generation !== normalized.actorGeneration || session.status !== "active") {
      throw new HumanDecisionError("SESSION_SUPERSEDED", "active exact session generationではありません");
    }
    return {
      kind: "orchestrator",
      actorId: normalized.actorId,
      actorSessionId: normalized.actorSessionId,
      actorGeneration: normalized.actorGeneration,
    };
  }

  /** §80 answer用。認証済みIdPとはみなさないlocal human claimだけを受理する。 */
  private authorizeHumanDecisionHuman(provenance: ActorProvenance): ActorProvenance & { kind: "human" } {
    let normalized: ActorProvenance;
    try {
      normalized = normalizeActorProvenance(provenance);
    } catch (error) {
      throw new HumanDecisionError("ACTOR_UNAUTHORIZED", error instanceof Error ? error.message : String(error));
    }
    if (normalized.kind !== "human" || normalized.actorId.trim() === "" ||
        normalized.actorSessionId !== "" || normalized.actorGeneration !== null) {
      throw new HumanDecisionError("ACTOR_UNAUTHORIZED", "非空actorIdのlocal human provenanceが必須です");
    }
    return { kind: "human", actorId: normalized.actorId, actorSessionId: "", actorGeneration: null };
  }

  /**
   * native delivery の host-owned service mutation を supervisor へ固定する。
   * service provenance は session/generation を持たないため、actorId だけを
   * caller が差し替えられると任意の内部 service として native authority を
   * 取得できてしまう。ここでは構造を検証したうえで固定 identity だけを受理する。
   */
  private authorizeNativeSupervisorService(provenance: ActorProvenance | undefined): ActorProvenance {
    const normalized = this.authorizeActorProvenance(provenance);
    if (normalized.kind !== "service" || normalized.actorId !== NATIVE_SUPERVISOR_SERVICE_ACTOR) {
      throw new Error("native communicationは固定supervisor service provenanceが必須です");
    }
    return normalized;
  }

  /** §40.6 管理操作用。active exact に加えて heartbeat 鮮度も同じ snapshot で検証する。 */
  private authorizeFreshOrchestratorPrincipal(provenance: ActorProvenance): ActorProvenance {
    const normalized = normalizeActorProvenance(provenance);
    if (normalized.kind !== "orchestrator") {
      throw new Error("active orchestrator principal が必須です");
    }
    const matched = this.db.prepare(
      `SELECT 1 AS matched
       FROM orchestrator_sessions
       WHERE id = ? AND orchestrator_id = ? AND generation = ? AND status = 'active'
         AND heartbeat_at >= ?`,
    ).get(
      normalized.actorSessionId,
      normalized.actorId,
      normalized.actorGeneration,
      nowSeconds() - ORCHESTRATOR_SESSION_STALE_SECONDS,
    );
    if (matched === undefined) {
      throw new Error("fresh active orchestrator session generation が完全一致しません");
    }
    return normalized;
  }

  /** 表示 actor と構造化 provenance を単一 INSERT で保存する。呼出し元は transaction 内にいること。 */
  private insertTaskEvent(
    taskId: string,
    eventType: string,
    actor: string,
    payload: Record<string, unknown>,
    now: number,
    provenance?: ActorProvenance,
  ): number | bigint {
    acknowledgeActor(actor);
    const authorized = this.authorizeActorProvenance(provenance);
    const info = this.db
      .prepare(
        `INSERT INTO task_events (
           task_id, event_type, actor, payload,
           actor_kind, actor_id, actor_session_id, actor_generation, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        eventType,
        actor,
        JSON.stringify(payload),
        authorized.kind,
        authorized.actorId,
        authorized.actorSessionId,
        authorized.actorGeneration,
        now,
      );
    return info.lastInsertRowid;
  }

  /** 表示 author と構造化 provenance を単一 INSERT で保存する。呼出し元は transaction 内にいること。 */
  private insertTaskComment(
    taskId: string,
    author: string,
    body: string,
    now: number,
    provenance?: ActorProvenance,
  ): number | bigint {
    acknowledgeActor(author);
    const authorized = this.authorizeActorProvenance(provenance);
    const info = this.db
      .prepare(
        `INSERT INTO task_comments (
           task_id, author, body, actor_kind, actor_id, actor_session_id, actor_generation, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        author,
        body,
        authorized.kind,
        authorized.actorId,
        authorized.actorSessionId,
        authorized.actorGeneration,
        now,
      );
    return info.lastInsertRowid;
  }

  private requireTaskRaw(id: string): RawTaskRow {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as RawTaskRow | undefined;
    if (row === undefined) {
      throw new Error(`タスクが見つかりません: ${id}`);
    }
    return row;
  }

  /** binding > task/subtree > worktree > project の順で単一primary identityを解決する。 */
  private resolveTaskPrimaryOrchestrator(task: RawTaskRow): string {
    const bindings = this.db
      .prepare(
        `SELECT orchestrator_id, role
         FROM task_orchestrator_bindings
         WHERE task_id = ? AND released_at IS NULL`,
      )
      .all(task.id) as Array<{ orchestrator_id: string; role: OrchestratorWatchRole }>;
    if (bindings.length > 0) {
      const primaryIds = new Set(
        bindings.filter((binding) => binding.role === "primary").map((binding) => binding.orchestrator_id),
      );
      if (primaryIds.size !== 1) {
        throw new Error("taskのactive bindingから単一primary orchestratorを解決できません");
      }
      return [...primaryIds][0]!;
    }

    const worktree = extractCwdFromBody(task.body);
    const watches = this.db
      .prepare(
        `WITH RECURSIVE ancestors(id) AS (
           SELECT ?
           UNION
           SELECT l.parent_id FROM task_links l JOIN ancestors a ON l.child_id = a.id
           WHERE l.link_type = 'subtask'
         )
         SELECT w.orchestrator_id, w.scope, w.priority,
                CASE w.scope WHEN 'task' THEN 0 WHEN 'subtree' THEN 1 WHEN 'worktree' THEN 2 ELSE 3 END AS scope_rank
         FROM orchestrator_watches w
         WHERE w.role = 'primary' AND w.active = 1 AND (
           (w.scope = 'task' AND w.selector = ?) OR
           (w.scope = 'subtree' AND w.selector IN (SELECT id FROM ancestors)) OR
           (w.scope = 'worktree' AND w.selector = ?) OR
           (w.scope = 'project' AND w.selector = ?)
         )
         ORDER BY scope_rank, w.priority DESC, w.created_at`,
      )
      .all(task.id, task.id, worktree, task.tenant) as Array<{
        orchestrator_id: string;
        scope: OrchestratorWatchScope;
        priority: number;
        scope_rank: number;
      }>;
    const first = watches[0];
    if (first === undefined) {
      throw new Error("taskにactive primary binding/watchがありません");
    }
    const topIds = new Set(
      watches
        .filter((watch) => watch.scope_rank === first.scope_rank && watch.priority === first.priority)
        .map((watch) => watch.orchestrator_id),
    );
    if (topIds.size !== 1) {
      throw new Error("taskのprimary watch scopeが複数identityへ曖昧に解決されました");
    }
    return [...topIds][0]!;
  }

  private assertTaskPrimaryOrchestrator(task: RawTaskRow, orchestratorId: string): void {
    if (this.resolveTaskPrimaryOrchestrator(task) !== orchestratorId) {
      throw new Error("taskのprimary orchestrator authorityがactor identityと一致しません");
    }
  }

  private requireScheduleRaw(id: string): RawScheduleRow {
    const row = this.db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as RawScheduleRow | undefined;
    if (row === undefined) {
      throw new Error(`スケジュールが見つかりません: ${id}`);
    }
    return row;
  }

  private requireKnowledgeRaw(id: string): RawKnowledgeRow {
    const row = this.db.prepare(`SELECT * FROM knowledge WHERE id = ?`).get(id) as RawKnowledgeRow | undefined;
    if (row === undefined) {
      throw new Error(`knowledge が見つかりません: ${id}`);
    }
    return row;
  }

  private requireRuntimeLeaseRaw(id: string): RawRuntimeLeaseRow {
    const row = this.db.prepare(`SELECT * FROM runtime_resource_leases WHERE id = ?`).get(id) as
      | RawRuntimeLeaseRow
      | undefined;
    if (row === undefined) {
      throw new Error(`runtime resource lease が見つかりません: ${id}`);
    }
    return row;
  }

  private requireRuntimeCleanupRequestRaw(id: string): RawRuntimeCleanupRequestRow {
    const row = this.db.prepare(`SELECT * FROM runtime_cleanup_requests WHERE id = ?`).get(id) as
      | RawRuntimeCleanupRequestRow
      | undefined;
    if (row === undefined) {
      throw new Error(`runtime cleanup request が見つかりません: ${id}`);
    }
    return row;
  }

  private runtimeMembersHash(leaseId: string): string {
    const members = this.db
      .prepare(`SELECT * FROM runtime_resource_members WHERE lease_id = ? ORDER BY id`)
      .all(leaseId) as RawRuntimeMemberRow[];
    return runtimeMembersHash(members.map(mapRuntimeMemberRow));
  }

  private runtimeOwnerIsTerminal(lease: RawRuntimeLeaseRow): boolean {
    if (lease.owner_task_id !== null) {
      const task = this.requireTaskRaw(lease.owner_task_id);
      if (task.status !== "done" && task.status !== "archived") {
        return false;
      }
    }
    if (lease.owner_run_id !== null) {
      const liveRun = this.db
        .prepare(`SELECT 1 FROM task_runs WHERE id = ? AND status = 'running'`)
        .get(lease.owner_run_id);
      if (liveRun !== undefined) {
        return false;
      }
    }
    return true;
  }

  private addRuntimeResourceEvent(
    leaseId: string,
    eventType: string,
    actor: string,
    payload: Record<string, unknown>,
    requestId: string | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO runtime_resource_events
         (lease_id, request_id, event_type, actor, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(leaseId, requestId, eventType, actor, JSON.stringify(payload), nowSeconds());
  }

  /** cleanup 専用 outbox へ transport 別通知を冪等登録する。 */
  private enqueueRuntimeCleanupNotification(input: {
    request: RawRuntimeCleanupRequestRow;
    lease: RawRuntimeLeaseRow;
    route: "orchestrator_fyi" | "human_question";
    question: string;
    nonce?: string;
    now: number;
  }): void {
    const payload = JSON.stringify({
      route: input.route,
      question: input.question,
      taskId: input.lease.owner_task_id,
      expectedLeaseFence: input.request.expected_lease_fence,
      escalationGeneration: input.request.escalation_generation,
      ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
    });
    for (const transport of ["macos", "telegram"] as const) {
      const dedupeKey = `${input.request.id}:${input.request.escalation_generation}:cleanup_decision:${transport}`;
      this.db.prepare(
        `INSERT OR IGNORE INTO runtime_resource_outbox (
           lease_id, request_id, dedupe_key, kind, transport, payload, sent_transports,
           status, next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'cleanup_decision', ?, ?, '[]', 'pending', 0, ?, ?)`,
      ).run(input.lease.id, input.request.id, dedupeKey, transport, payload, input.now, input.now);
    }
  }

  /**
   * task binding → watch の順で durable delivery の宛先 identity を解決する（contract §55.1 / §69.3）。
   * cleanup request と steward 提案が同一の順序・除外規則を共有するための唯一の実装で、
   * 「task binding の非 observer を優先し、binding が 0 件のときだけ scope tier 順に watch を辿る」。
   * 返り値は identity → watch ID（binding 由来は null）。
   */
  private resolveOrchestratorDeliveryTargets(
    input: ResolveOrchestratorDeliveryTargetsInput,
  ): Map<string, string | null> {
    return resolveOrchestratorDeliveryTargets(this.db, input);
  }

  /** cleanup request の task/watch 関心範囲から durable delivery 候補を作る。 */
  private enqueueRuntimeCleanupDeliveries(input: {
    requestId: string;
    lease: RawRuntimeLeaseRow;
    now: number;
  }): void {
    if (input.lease.controller_orchestrator_id === null) {
      throw new Error("orchestrator cleanup request に controller がありません");
    }
    const targets = this.resolveOrchestratorDeliveryTargets({
      taskId: input.lease.owner_task_id,
      worktree: input.lease.canonical_worktree,
      project: input.lease.project,
    });
    // lease controller は watch が無い場合にも残る stable fallback owner。
    if (!targets.has(input.lease.controller_orchestrator_id)) {
      targets.set(input.lease.controller_orchestrator_id, null);
    }
    const insertDelivery = this.db.prepare(
      `INSERT INTO runtime_cleanup_deliveries
       (request_id, orchestrator_id, watch_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(request_id, orchestrator_id)
       DO UPDATE SET watch_id = excluded.watch_id, status = 'pending', updated_at = excluded.updated_at`,
    );
    for (const [orchestratorId, watchId] of targets) {
      insertDelivery.run(input.requestId, orchestratorId, watchId, input.now, input.now);
    }
  }

  /** 初期 human cleanup request に reply nonce と transport 別 outbox を冪等付与する。 */
  private initializeRuntimeCleanupHumanRequest(requestId: string, question: string, now: number): void {
    const request = this.requireRuntimeCleanupRequestRaw(requestId);
    if (request.decision_class !== "human" || request.status !== "waiting_human") {
      return;
    }
    if (request.human_answer_nonce_hash !== "") {
      return;
    }
    const nonce = randomBytes(24).toString("hex");
    const changed = this.db.prepare(
      `UPDATE runtime_cleanup_requests SET human_answer_nonce_hash = ?, updated_at = ?
       WHERE id = ? AND decision_class = 'human' AND status = 'waiting_human'
         AND human_answer_nonce_hash = ''`,
    ).run(sha256RuntimeValue(nonce), now, requestId);
    if (changed.changes !== 1) {
      return;
    }
    const initialized = this.requireRuntimeCleanupRequestRaw(requestId);
    this.enqueueRuntimeCleanupNotification({
      request: initialized,
      lease: this.requireRuntimeLeaseRaw(initialized.lease_id),
      route: "human_question",
      question,
      nonce,
      now,
    });
  }

  private insertLesson(
    input: NormalizedLessonInput,
    actor: string | undefined,
    now: number,
    provenance?: ActorProvenance,
  ): LessonRow {
    this.requireTaskRaw(input.sourceTaskId);
    const info = this.db
      .prepare(
        `INSERT INTO lessons (created_at, trigger, tenant, cwd, profile, body, source_task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(now, input.trigger, input.tenant, input.cwd, input.profile, input.body, input.sourceTaskId);
    const lessonId = Number(info.lastInsertRowid);

    if (actor !== undefined) {
      this.insertTaskEvent(
        input.sourceTaskId,
        "lesson_recorded",
        actor,
        { lessonId, trigger: input.trigger },
        now,
        provenance,
      );
    }

    const row = this.db.prepare(`SELECT * FROM lessons WHERE id = ?`).get(lessonId) as RawLessonRow;
    return mapLessonRow(row);
  }

  /** depends-on グラフで startId から targetId に到達できるかを DFS で判定する */
  private hasDependsOnPath(startId: string, targetId: string): boolean {
    const stack: string[] = [startId];
    const visited = new Set<string>();
    const childrenStatement = this.db.prepare(
      `SELECT child_id FROM task_links WHERE parent_id = ? AND link_type = 'depends-on'`,
    );

    while (stack.length > 0) {
      const currentId = stack.pop();
      if (currentId === undefined) {
        break;
      }
      if (currentId === targetId) {
        return true;
      }
      if (visited.has(currentId)) {
        continue;
      }
      visited.add(currentId);

      const rows = childrenStatement.all(currentId) as Array<{ child_id: string }>;
      for (const row of rows) {
        if (!visited.has(row.child_id)) {
          stack.push(row.child_id);
        }
      }
    }

    return false;
  }

  /** depends-on 追加時の自己依存・循環を fail-closed で拒否する */
  private assertDependsOnLinkAllowed(parentId: string, childId: string): void {
    if (parentId === childId) {
      throw new Error(`depends-on の自己依存はできません: ${parentId}`);
    }
    if (this.hasDependsOnPath(childId, parentId)) {
      throw new Error(`depends-on の循環が生じるためリンクできません: ${parentId} -> ${childId}`);
    }
  }

  /** 状態遷移の共通実装。同一トランザクションで tasks 更新 + task_events insert を行う */
  private runTransition(taskId: string, to: TaskStatus, opts: RunTransitionOptions): TaskRow {
    const exec = this.db.transaction((): TaskRow => {
      const current = this.requireTaskRaw(taskId);
      const from = current.status as TaskStatus;
      assertTransition(from, to);
      if (to === "ready") {
        assertVerifyDirectiveAllowed(current.body);
      }

      let blockReason = "";
      if (to === "blocked") {
        const reason = opts.reason;
        if (reason === undefined || reason.length === 0) {
          throw new Error("blocked への遷移には block_reason が必須です");
        }
        if (!hasKnownReasonPrefix(reason)) {
          throw new Error(`未知の block_reason prefix です: ${reason}`);
        }
        blockReason = reason;
      }

      const now = nowSeconds();

      let startedAt = current.started_at;
      if (
        to === "blocked" &&
        opts.reason !== undefined &&
        isInProgressReason(opts.reason) &&
        startedAt === null
      ) {
        startedAt = now;
      }

      let completedAt = current.completed_at;
      if (to === "done") {
        completedAt = now;
      }

      const assignee = opts.assignee ?? current.assignee;

      // ready からの遷移が成立した時点で claim_lock をクリアする（契約 §12.7-1）。
      // dispatch の起動前 claim は「ready のまま」の間だけ有効であり、ready を抜けた（起動成立/block/他状態への遷移）
      // 時点でロックの意味を持たなくなるため、遷移先を問わず解放する。
      const claimLock = from === "ready" ? "" : current.claim_lock;

      this.db
        .prepare(
          `UPDATE tasks
           SET status = ?, block_reason = ?, assignee = ?, started_at = ?, completed_at = ?, claim_lock = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(to, blockReason, assignee, startedAt, completedAt, claimLock, now, taskId);

      const eventPayload: Record<string, unknown> = {
        from,
        to,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        ...opts.payload,
      };

      this.insertTaskEvent(taskId, opts.eventType, opts.actor, eventPayload, now, opts.provenance);

      if (from === "blocked" && current.block_reason.startsWith("user-decision:")) {
        this.insertLesson(
          {
            trigger: "user-decision",
            tenant: current.tenant,
            cwd: extractCwdFromBody(current.body),
            profile: current.profile,
            body: buildUserDecisionLessonBody(current.block_reason, to),
            sourceTaskId: taskId,
          },
          opts.actor,
          now,
          opts.provenance,
        );
      }

      return mapTaskRow(this.requireTaskRaw(taskId));
    });

    return exec();
  }

  addKnowledge(input: KnowledgeAddInput, actor: string, provenance?: ActorProvenance): KnowledgeRow {
    acknowledgeActor(actor);
    const normalized = normalizeKnowledgeInput(input);
    const contentHash = hashKnowledgeBody(normalized.body);
    const now = nowSeconds();
    const createdAt = normalized.createdAt ?? now;
    const tagsJson = JSON.stringify(normalized.tags);

    const exec = this.db.transaction((): KnowledgeRow => {
      const authorized = this.authorizeActorProvenance(provenance);
      const existing = this.db
        .prepare(`SELECT * FROM knowledge WHERE content_hash = ?`)
        .get(contentHash) as RawKnowledgeRow | undefined;
      if (existing !== undefined) {
        return mapKnowledgeRow(existing);
      }

      for (let attempt = 0; attempt <= KNOWLEDGE_ID_COLLISION_MAX_RETRIES; attempt += 1) {
        const id = generateKnowledgeId();
        try {
          this.db
            .prepare(
              `INSERT INTO knowledge (
                 id, title, body, source, tags, importance, expires_at, origin_path,
                 content_hash, actor, actor_kind, actor_id, actor_session_id, actor_generation,
                 created_at, updated_at
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              normalized.title,
              normalized.body,
              normalized.source,
              tagsJson,
              normalized.importance,
              normalized.expiresAt,
              normalized.originPath,
              contentHash,
              actor,
              authorized.kind,
              authorized.actorId,
              authorized.actorSessionId,
              authorized.actorGeneration,
              createdAt,
              now,
            );
          return mapKnowledgeRow(this.requireKnowledgeRaw(id));
        } catch (err) {
          if (isUniqueConstraintError(err)) {
            const duplicate = this.db
              .prepare(`SELECT * FROM knowledge WHERE content_hash = ?`)
              .get(contentHash) as RawKnowledgeRow | undefined;
            if (duplicate !== undefined) {
              return mapKnowledgeRow(duplicate);
            }
          }
          if (isPrimaryKeyConstraintError(err) && attempt < KNOWLEDGE_ID_COLLISION_MAX_RETRIES) {
            continue;
          }
          if (isPrimaryKeyConstraintError(err)) {
            throw new Error(`knowledge id の PK 衝突が上限を超えました: ${KNOWLEDGE_ID_COLLISION_MAX_RETRIES}`);
          }
          throw err;
        }
      }

      throw new Error(`knowledge id の PK 衝突が上限を超えました: ${KNOWLEDGE_ID_COLLISION_MAX_RETRIES}`);
    });

    return exec();
  }

  listKnowledge(options: KnowledgeListOptions = {}): KnowledgeRow[] {
    const limit = options.limit !== undefined ? requireNonNegativeInteger(options.limit, "limit") : 20;
    if (limit === 0) {
      throw new Error("limit は 1 以上の整数が必須です");
    }
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (options.source !== undefined) {
      clauses.push("source = ?");
      params.push(requireNonEmptyString(options.source, "source").trim());
    }
    if (options.tag !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(knowledge.tags) WHERE value = ?)");
      params.push(requireNonEmptyString(options.tag, "tag").trim());
    }
    if (options.search !== undefined) {
      const search = requireNonEmptyString(options.search, "search").trim();
      const pattern = `%${escapeLikePattern(search)}%`;
      clauses.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }
    if (options.includeExpired !== true) {
      clauses.push("(expires_at IS NULL OR expires_at >= ?)");
      params.push(nowSeconds());
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge
         ${where}
         ORDER BY importance DESC, created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit) as RawKnowledgeRow[];
    return rows.map(mapKnowledgeRow);
  }

  getKnowledge(id: string): KnowledgeRow | null {
    const row = this.db.prepare(`SELECT * FROM knowledge WHERE id = ?`).get(id) as RawKnowledgeRow | undefined;
    return row !== undefined ? mapKnowledgeRow(row) : null;
  }

  createTask(input: TaskCreateInput, actor: string, provenance?: ActorProvenance): TaskRow {
    assertVerifyDirectiveAllowed(input.body);
    const now = nowSeconds();
    const status = input.status ?? "triage";
    if (!CREATABLE_STATUSES.includes(status)) {
      throw new Error(
        `createTask の初期 status は triage / todo / ready のみ許可されます（不変条件を満たさない初期状態は作成できません）: ${status}`,
      );
    }
    const priority = input.priority ?? 0;
    const profile = input.profile ?? "";
    const provider = input.provider ?? "";
    const assignee = input.assignee ?? "";

    const insertOnce = this.db.transaction((id: string): TaskRow => {
      this.db
        .prepare(
          `INSERT INTO tasks (id, title, body, status, priority, tenant, assignee, provider, profile, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.title, input.body, status, priority, input.tenant, assignee, provider, profile, now, now);

      this.insertTaskEvent(id, "task_created", actor, { status, tenant: input.tenant }, now, provenance);

      return mapTaskRow(this.requireTaskRaw(id));
    });

    // id は 64bit ランダムだが PK 衝突は理論上あり得るため、衝突時のみ id を再生成して
    // 最大 TASK_ID_COLLISION_MAX_RETRIES 回リトライする（契約 §12.7-5, fail-closed）
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= TASK_ID_COLLISION_MAX_RETRIES; attempt += 1) {
      const id = generateTaskId();
      try {
        return insertOnce(id);
      } catch (err) {
        if (!isPrimaryKeyConstraintError(err)) {
          throw err;
        }
        lastError = err;
      }
    }
    throw new Error(
      `タスクID採番が PK 衝突により失敗しました（${TASK_ID_COLLISION_MAX_RETRIES}回再試行後も解決せず）: ${String(lastError)}`,
    );
  }

  getTask(id: string): TaskRow | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as RawTaskRow | undefined;
    return row === undefined ? null : mapTaskRow(row);
  }

  listByStatus(status: TaskStatus, limit?: number): TaskRow[] {
    const rows = (
      limit !== undefined
        ? this.db
            .prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC LIMIT ?`)
            .all(status, limit)
        : this.db.prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC`).all(status)
    ) as RawTaskRow[];
    return rows.map(mapTaskRow);
  }

  listInProgress(): TaskRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'blocked'
           AND (block_reason LIKE 'codex-in-progress:%' OR block_reason LIKE 'claude-in-progress:%')
         ORDER BY updated_at ASC`,
      )
      .all() as RawTaskRow[];
    return rows.map(mapTaskRow);
  }

  /**
   * subtask リンクの子孫（root 自身を含む）ID を返す（docs/contract.md §55.1 の subtree scope と同じ辿り方）。
   * 再帰 CTE の UNION が訪問済み ID を畳むため、循環リンクがあっても停止する。
   */
  listSubtreeTaskIds(rootTaskId: string): string[] {
    this.requireTaskRaw(rootTaskId);
    const rows = this.db
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
           SELECT ?
           UNION
           SELECT l.child_id FROM task_links l JOIN descendants d ON l.parent_id = d.id
           WHERE l.link_type = 'subtask'
         )
         SELECT id FROM descendants`,
      )
      .all(rootTaskId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /**
   * subtask リンクの子孫（root を除く）を status 別に一括集計する（docs/contract.md §55.1）。
   * listSubtreeTaskIds と同じ再帰 CTE を使い、GROUP BY で1クエリに畳むことで
   * 呼び出し側が子孫ごとに getTask する N+1 を避ける。UNION が訪問済み ID を畳むため
   * 循環リンクがあっても停止する。
   */
  countSubtreeStatuses(rootTaskId: string): { counts: Record<string, number>; total: number } {
    this.requireTaskRaw(rootTaskId);
    const rows = this.db
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
           SELECT ?
           UNION
           SELECT l.child_id FROM task_links l JOIN descendants d ON l.parent_id = d.id
           WHERE l.link_type = 'subtask'
         )
         SELECT t.status AS status, COUNT(*) AS cnt
         FROM descendants d
         JOIN tasks t ON t.id = d.id
         WHERE d.id <> ?
         GROUP BY t.status`,
      )
      .all(rootTaskId, rootTaskId) as Array<{ status: string; cnt: number }>;
    const counts: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      counts[row.status] = row.cnt;
      total += row.cnt;
    }
    return { counts, total };
  }

  /**
   * orchestrator の担当範囲（binding + active watch）と subtree でタスクを絞り込む（docs/contract.md §69.3）。
   * orchestrator 判定は resolveOrchestratorDeliveryTargets をそのまま通し、配送先解決と別のロジックを作らない。
   * 絞り込みは limit より先に適用するため、`--limit` は「該当タスクの件数」を意味する。
   *
   * worktree の取り出しは normalizeCwdValue を通さない生の cwd 行を使う。
   * watch selector の突合は `w.selector = ?` の完全一致で、実際に配送を起こす
   * packages/supervisor/src/stages/steward.ts の extractCwd も正規化しないため、
   * ここで末尾スラッシュを削ると「本番は配送するのに一覧に出ない」ズレが生じる。
   */
  listScopedTasks(input: {
    orchestratorId?: string;
    subtreeRootId?: string;
    status?: TaskStatus;
    limit?: number;
  }): TaskRow[] {
    if (input.orchestratorId !== undefined && this.getOrchestrator(input.orchestratorId) === null) {
      throw new Error(`orchestrator が見つかりません: ${input.orchestratorId}`);
    }
    const subtreeIds =
      input.subtreeRootId === undefined ? null : new Set(this.listSubtreeTaskIds(input.subtreeRootId));
    const limit = input.limit ?? Number.MAX_SAFE_INTEGER;
    // 既存 task list と同じ並び（--status ありは priority DESC、無しは updated_at DESC）を保つ
    const candidates =
      input.status !== undefined ? this.listByStatus(input.status) : this.listRecent(Number.MAX_SAFE_INTEGER);

    const matched: TaskRow[] = [];
    for (const task of candidates) {
      if (matched.length >= limit) {
        break;
      }
      if (subtreeIds !== null && !subtreeIds.has(task.id)) {
        continue;
      }
      if (input.orchestratorId !== undefined) {
        const targets = this.resolveOrchestratorDeliveryTargets({
          taskId: task.id,
          worktree: extractDeliveryWorktreeFromBody(task.body),
          project: task.tenant,
        });
        if (!targets.has(input.orchestratorId)) {
          continue;
        }
      }
      matched.push(task);
    }
    return matched;
  }

  /**
   * 指定 task に対して当該 orchestrator が配送先として適格かを判定する（docs/contract.md §69.3）。
   * 判定は resolveOrchestratorDeliveryTargets をそのまま通し、配送先解決と別のロジックを作らない
   * （listScopedTasks の orchestrator 絞り込みと同一の 1 task 版）。
   */
  isOrchestratorScopedToTask(orchestratorId: string, taskId: string): boolean {
    if (this.getOrchestrator(orchestratorId) === null) {
      throw new Error(`orchestrator が見つかりません: ${orchestratorId}`);
    }
    const task = this.requireTaskRaw(taskId);
    const targets = this.resolveOrchestratorDeliveryTargets({
      taskId: task.id,
      worktree: extractDeliveryWorktreeFromBody(task.body),
      project: task.tenant,
    });
    return targets.has(orchestratorId);
  }

  transition(input: TransitionInput): TaskRow {
    return this.runTransition(input.taskId, input.to, {
      reason: input.reason,
      actor: input.actor,
      eventType: input.eventType ?? "status_changed",
      payload: input.payload ?? {},
      assignee: undefined,
      provenance: input.provenance,
    });
  }

  block(taskId: string, reason: string, actor: string, assignee?: string, provenance?: ActorProvenance): TaskRow {
    return this.runTransition(taskId, "blocked", {
      reason,
      actor,
      eventType: "status_changed",
      payload: {},
      assignee,
      provenance,
    });
  }

  unblock(taskId: string, to: TaskStatus, actor: string, provenance?: ActorProvenance): TaskRow {
    const current = this.requireTaskRaw(taskId);
    if (current.status !== "blocked") {
      throw new Error(`unblock は blocked 状態のタスクにのみ使用できます（現在の状態: ${current.status}）`);
    }
    return this.runTransition(taskId, to, {
      reason: undefined,
      actor,
      eventType: "status_changed",
      payload: {},
      assignee: undefined,
      provenance,
    });
  }

  /**
   * status='ready' かつ claim_lock='' の場合のみ、単一 Tx（CAS）で blocked へ遷移する
   * （docs/contract.md §12.17-1）。orphan block 等の「getTask で確認してから block する」
   * check-then-block の窓を排除するために使う。UPDATE の WHERE 句に同一条件を含めることで
   * SELECT〜UPDATE 間の割込みを許さない真の CAS にする（changes===1 で成否判定。claimTask と同型）。
   * 条件不一致（タスク不在 / status が ready でない / 既に他 writer が claim 済み）は状態を
   * 変更せず false を返す（他 writer の claim / 遷移を尊重。no-op）。
   */
  blockIfReadyUnclaimed(
    taskId: string,
    reason: string,
    actor: string,
    assignee?: string,
    provenance?: ActorProvenance,
  ): boolean {
    if (!hasKnownReasonPrefix(reason)) {
      throw new Error(`未知の block_reason prefix です: ${reason}`);
    }
    const now = nowSeconds();
    const exec = this.db.transaction((): boolean => {
      const current = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as RawTaskRow | undefined;
      if (current === undefined || current.status !== "ready" || current.claim_lock !== "") {
        return false;
      }

      const startedAt = isInProgressReason(reason) && current.started_at === null ? now : current.started_at;
      const nextAssignee = assignee ?? current.assignee;

      const info = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'blocked', block_reason = ?, assignee = ?, started_at = ?, claim_lock = '', updated_at = ?
           WHERE id = ? AND status = 'ready' AND claim_lock = ''`,
        )
        .run(reason, nextAssignee, startedAt, now, taskId);

      if (info.changes !== 1) {
        return false;
      }

      this.insertTaskEvent(
        taskId,
        "status_changed",
        actor,
        { from: "ready", to: "blocked", reason },
        now,
        provenance,
      );

      return true;
    });
    return exec();
  }

  /**
   * status='ready' かつ claim_lock=claimToken の場合のみ、単一 Tx（CAS）で blocked へ遷移する
   * （docs/contract.md §12.19-2）。claim 保持中の fail-closed block 専用（dispatch の model 解決失敗・
   * cwd 検証失敗・launch 失敗の block はすべてこれに統一する）。「claim 済みタスクの状態を確認してから
   * block する」check-then-block の窓を排除するため、UPDATE の WHERE 句に claim_lock=claimToken を
   * 含めることで SELECT〜UPDATE 間の割込みを許さない真の CAS にする（changes===1 で成否判定。
   * blockIfReadyUnclaimed / claimTask と同型）。
   * 条件不一致（タスク不在 / status が ready でない / claim_lock が claimToken と不一致）は状態を
   * 変更せず false を返す（他 writer の claim / 遷移を尊重。no-op）。
   */
  blockClaimedTask(
    taskId: string,
    claimToken: string,
    reason: string,
    actor: string,
    assignee?: string,
    provenance?: ActorProvenance,
  ): boolean {
    if (!hasKnownReasonPrefix(reason)) {
      throw new Error(`未知の block_reason prefix です: ${reason}`);
    }
    if (claimToken === "") {
      // 空文字は claim_lock の「未 claim」センチネルであり、正規の claim トークンではない。
      // これを許すと claim を保持していない呼び出し元でも未 claim タスク（claim_lock=''）を
      // block できてしまい、「claim 保持者限定」という本 API の安全性が崩れるため、
      // CAS 判定に進む前に fail-closed で拒否する（DB へは一切触れない）。
      return false;
    }
    const now = nowSeconds();
    const exec = this.db.transaction((): boolean => {
      const current = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as RawTaskRow | undefined;
      if (current === undefined || current.status !== "ready" || current.claim_lock !== claimToken) {
        return false;
      }

      const startedAt = isInProgressReason(reason) && current.started_at === null ? now : current.started_at;
      const nextAssignee = assignee ?? current.assignee;

      const info = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'blocked', block_reason = ?, assignee = ?, started_at = ?, claim_lock = '', updated_at = ?
           WHERE id = ? AND status = 'ready' AND claim_lock = ?`,
        )
        .run(reason, nextAssignee, startedAt, now, taskId, claimToken);

      if (info.changes !== 1) {
        return false;
      }

      this.insertTaskEvent(
        taskId,
        "status_changed",
        actor,
        { from: "ready", to: "blocked", reason },
        now,
        provenance,
      );

      return true;
    });
    return exec();
  }

  addComment(taskId: string, author: string, body: string, provenance?: ActorProvenance): CommentRow {
    const exec = this.db.transaction((): CommentRow => {
      this.requireTaskRaw(taskId);
      const rowId = this.insertTaskComment(taskId, author, body, nowSeconds(), provenance);
      const row = this.db.prepare(`SELECT * FROM task_comments WHERE id = ?`).get(rowId) as RawCommentRow;
      return mapCommentRow(row);
    });
    return exec();
  }

  /**
   * タスクのコメントを時系列（作成順）で返す（docs/contract.md §12.9-5）。
   * limit 省略時は全件を作成順（古い→新しい）で返す。
   * limit 指定時は「新しい方から limit 件」を意味する。DB からは DESC + LIMIT で新しい順に取得し、
   * 返却前に ASC へ反転することで、件数を絞りつつ時系列順を維持する（直近 N 件の正しい意味論）。
   */
  listComments(taskId: string, limit?: number): CommentRow[] {
    if (limit === undefined) {
      const rows = this.db
        .prepare(`SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC, id ASC`)
        .all(taskId) as RawCommentRow[];
      return rows.map(mapCommentRow);
    }
    const rows = this.db
      .prepare(`SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(taskId, limit) as RawCommentRow[];
    return rows.reverse().map(mapCommentRow);
  }

  addEvent(
    taskId: string,
    eventType: string,
    actor: string,
    payload: Record<string, unknown>,
    provenance?: ActorProvenance,
  ): EventRow {
    const exec = this.db.transaction((): EventRow => {
      const now = nowSeconds();
      this.requireTaskRaw(taskId);
      const rowId = this.insertTaskEvent(taskId, eventType, actor, payload, now, provenance);
      if (eventType === "session_ended" && typeof payload["sessionId"] === "string") {
        const run = this.db.prepare(
          `SELECT * FROM task_runs WHERE task_id = ? AND session_id = ? ORDER BY id DESC LIMIT 1`,
        ).get(taskId, payload["sessionId"]) as RawRunRow | undefined;
        if (run !== undefined) {
          this.staleCancelSteersForRunAt(run.id, run.session_id, actor, "session-ended", now, provenance);
        }
      }
      const row = this.db.prepare(`SELECT * FROM task_events WHERE id = ?`).get(rowId) as RawEventRow;
      return mapEventRow(row);
    });
    return exec();
  }

  /** task 非依存の管理操作で使う active exact orchestrator authority の read gate。 */
  assertActiveOrchestratorPrincipal(provenance: ActorProvenance): void {
    const exec = this.db.transaction((): void => {
      this.authorizeFreshOrchestratorPrincipal(provenance);
    });
    exec();
  }

  /** task に属さない管理操作の監査 event を provenance 再照合と同一 Tx で追加する。 */
  addBoardAuditEvent(input: AddBoardAuditEventInput): BoardAuditEventRow {
    const exec = this.db.transaction((): BoardAuditEventRow => {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.eventType)) {
        throw new Error(`board audit eventType が不正です: ${input.eventType}`);
      }
      if (!/^[A-Za-z0-9._:-]+$/.test(input.actor)) {
        throw new Error("board audit actor は安全な非空識別子が必須です");
      }
      const authorized = this.authorizeFreshOrchestratorPrincipal(input.provenance);
      const redacted = redactJsonStrings(input.payload);
      if (typeof redacted !== "object" || redacted === null || Array.isArray(redacted)) {
        throw new Error("board audit payload は object が必須です");
      }
      const serialized = JSON.stringify(redacted);
      if (Buffer.byteLength(serialized, "utf8") > 4_096) {
        throw new Error("board audit payload は 4096 bytes 以下が必須です");
      }
      const now = nowSeconds();
      const info = this.db.prepare(
        `INSERT INTO board_audit_events (
           event_type, actor, payload, actor_kind, actor_id, actor_session_id, actor_generation, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.eventType,
        input.actor,
        serialized,
        authorized.kind,
        authorized.actorId,
        authorized.actorSessionId,
        authorized.actorGeneration,
        now,
      );
      const row = this.db.prepare(`SELECT * FROM board_audit_events WHERE id = ?`)
        .get(info.lastInsertRowid) as RawBoardAuditEventRow;
      return mapBoardAuditEventRow(row);
    });
    return exec();
  }

  listBoardAuditEvents(eventType?: string, limit?: number): BoardAuditEventRow[] {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000)) {
      throw new Error("board audit limit は 1〜1000 の整数が必須です");
    }
    const params: Array<string | number> = [];
    const where = eventType === undefined ? "" : " WHERE event_type = ?";
    if (eventType !== undefined) {
      params.push(eventType);
    }
    const limitClause = limit === undefined ? "" : " LIMIT ?";
    if (limit !== undefined) {
      params.push(limit);
    }
    const rows = this.db.prepare(
      `SELECT * FROM board_audit_events${where} ORDER BY id DESC${limitClause}`,
    ).all(...params) as RawBoardAuditEventRow[];
    return rows.reverse().map(mapBoardAuditEventRow);
  }

  /**
   * タスクのイベントを時系列（記録順）で返す（docs/contract.md §12.9-5）。
   * limit 省略時は全件を記録順（古い→新しい）で返す。
   * limit 指定時は「新しい方から limit 件」を意味する。DB からは DESC + LIMIT で新しい順に取得し、
   * 返却前に ASC へ反転することで、件数を絞りつつ時系列順を維持する（直近 N 件の正しい意味論）。
   */
  listEvents(taskId: string, eventType?: string, limit?: number): EventRow[] {
    const whereClause = eventType !== undefined ? ` AND event_type = ?` : "";
    const params: Array<string | number> = eventType !== undefined ? [taskId, eventType] : [taskId];

    if (limit === undefined) {
      const sql = `SELECT * FROM task_events WHERE task_id = ?${whereClause} ORDER BY created_at ASC, id ASC`;
      const rows = this.db.prepare(sql).all(...params) as RawEventRow[];
      return rows.map(mapEventRow);
    }

    const sql = `SELECT * FROM task_events WHERE task_id = ?${whereClause} ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as RawEventRow[];
    return rows.reverse().map(mapEventRow);
  }

  listWatchedStatusChangedEventsAfter(afterEventId: number, limit = 200): WatchedStatusChangedEvent[] {
    if (!Number.isInteger(afterEventId) || afterEventId < 0) {
      throw new Error(`afterEventId が不正です: ${afterEventId}`);
    }
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`limit が不正です: ${limit}`);
    }

    const rows = this.db
      .prepare(
        `SELECT e.*
         FROM task_events e
         JOIN tasks t ON t.id = e.task_id
         WHERE e.id > ? AND e.event_type = 'status_changed' AND t.watched = 1
         ORDER BY e.id ASC
         LIMIT ?`,
      )
      .all(afterEventId, limit) as RawEventRow[];

    const changes: WatchedStatusChangedEvent[] = [];
    for (const row of rows) {
      const event = mapEventRow(row);
      const parsed = parseStatusChangedPayload(event.payload);
      if (parsed === null) {
        continue;
      }
      changes.push({
        event,
        task: mapTaskRow(this.requireTaskRaw(event.taskId)),
        from: parsed.from,
        to: parsed.to,
        reason: parsed.reason,
      });
    }
    return changes;
  }

  hasProcessedMessage(idempotencyKey: string): boolean {
    // 式インデックス（idx_events_idem / idx_events_idem_unique）と完全一致させるため
    // IDEMPOTENCY_KEY_EXPR を共用する（docs/contract.md §12.16-2）。malformed payload は
    // 式が NULL を返すため throw せず単に不一致（false）扱いになる。
    const row = this.db
      .prepare(
        `SELECT 1 AS found FROM task_events
         WHERE event_type = 'message_processed' AND ${IDEMPOTENCY_KEY_EXPR} = ?
         LIMIT 1`,
      )
      .get(idempotencyKey);
    return row !== undefined;
  }

  /**
   * message_processed イベントを記録する（docs/contract.md §12.9-1）。
   * KanbanStore インターフェース上は void 宣言だが（types.ts は凍結のため変更不可）、
   * 実装クラスとしては boolean を返す（void 宣言への boolean 実装代入は TS 的に許容される）。
   * idx_events_idem_unique（migration v3）の UNIQUE 制約衝突時は「既処理」とみなし throw せず false を返す。
   * それ以外のエラーは呼び出し側へそのまま伝播する。
   */
  markMessageProcessed(taskId: string, idempotencyKey: string, actor: string): boolean {
    const now = nowSeconds();
    try {
      this.insertTaskEvent(taskId, "message_processed", actor, { idempotencyKey }, now);
      return true;
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return false;
      }
      throw err;
    }
  }

  /**
   * ready タスクを CAS で claim する（docs/contract.md §12.7-1）。
   * status='ready' かつ claim_lock='' の場合のみ claim_lock=claimToken を設定し true を返す。
   * 並行呼び出しで片方だけ成功する（changes===1 で成否判定）。成功時のみ task_claimed イベントを記録する。
   */
  claimTask(taskId: string, claimToken: string, actor: string): boolean {
    const now = nowSeconds();
    const exec = this.db.transaction((): boolean => {
      const info = this.db
        .prepare(
          `UPDATE tasks SET claim_lock = ?, updated_at = ? WHERE id = ? AND status = 'ready' AND claim_lock = ''`,
        )
        .run(claimToken, now, taskId);
      const claimed = info.changes === 1;
      if (claimed) {
        this.insertTaskEvent(taskId, "task_claimed", actor, { claimToken }, now);
      }
      return claimed;
    });
    return exec();
  }

  /**
   * claim を解放する（docs/contract.md §12.7-1）。
   * claim_lock が claimToken と一致する場合のみ '' に戻し true を返す。起動不成立時の巻き戻しに使う。
   * 成功時のみ claim_released イベントを記録する。
   */
  releaseClaim(taskId: string, claimToken: string, actor: string): boolean {
    const now = nowSeconds();
    const exec = this.db.transaction((): boolean => {
      const info = this.db
        .prepare(`UPDATE tasks SET claim_lock = '', updated_at = ? WHERE id = ? AND claim_lock = ?`)
        .run(now, taskId, claimToken);
      const released = info.changes === 1;
      if (released) {
        this.insertTaskEvent(taskId, "claim_released", actor, { claimToken }, now);
      }
      return released;
    });
    return exec();
  }

  /**
   * ready のまま残った stale claim を一括解放する（docs/contract.md §12.8-2）。
   * status='ready' かつ claim_lock!='' かつ updated_at が now - olderThanSec より古い行を対象に、
   * claim_lock を '' へ戻す。対象 id は SELECT で候補取得後、id ごとに SELECT と同一述語の UPDATE を
   * 実行し、changes===1（実際にクリアできた行）の場合のみ 'stale_claim_cleared' イベントを記録する
   * （docs/contract.md §12.15-4）。SELECT〜UPDATE の間に候補行の条件が崩れていた場合（他 writer による
   * 割込み等）に、クリアしていない行へ監査イベントだけが残る不整合を防ぐ。解放件数を返す
   * （reap ステージの定期清掃用）。
   */
  clearStaleClaims(olderThanSec: number, now: number, actor: string): number {
    const threshold = now - olderThanSec;
    const exec = this.db.transaction((): number => {
      const staleRows = this.db
        .prepare(`SELECT id FROM tasks WHERE status = 'ready' AND claim_lock != '' AND updated_at < ?`)
        .all(threshold) as Array<{ id: string }>;

      if (staleRows.length === 0) {
        return 0;
      }

      const updateStmt = this.db.prepare(
        `UPDATE tasks SET claim_lock = '', updated_at = ?
         WHERE id = ? AND status = 'ready' AND claim_lock != '' AND updated_at < ?`,
      );
      let cleared = 0;
      for (const row of staleRows) {
        const info = updateStmt.run(now, row.id, threshold);
        if (info.changes === 1) {
          cleared += 1;
          this.insertTaskEvent(row.id, "stale_claim_cleared", actor, { olderThanSec }, now);
        }
      }

      return cleared;
    });
    return exec();
  }

  startRun(taskId: string, provider: Provider, sessionId: string, meta: Record<string, unknown>): RunRow {
    const now = nowSeconds();
    const info = this.db
      .prepare(
        `INSERT INTO task_runs (task_id, provider, session_id, status, meta, started_at)
         VALUES (?, ?, ?, 'running', ?, ?)`,
      )
      .run(taskId, provider, sessionId, JSON.stringify(meta), now);
    const row = this.db.prepare(`SELECT * FROM task_runs WHERE id = ?`).get(info.lastInsertRowid) as RawRunRow;
    return mapRunRow(row);
  }

  /**
   * タスクの最新 open run（status='running'、started_at 最新→id 最大）を1件返す（docs/contract.md §12.7-6）。
   * session-ref.ts の「全 open run 走査 + フィルタ」を置き換える正本クエリ。
   */
  getLatestOpenRun(taskId: string): RunRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM task_runs
         WHERE task_id = ? AND status = 'running'
         ORDER BY started_at DESC, id DESC
         LIMIT 1`,
      )
      .get(taskId) as RawRunRow | undefined;
    return row === undefined ? null : mapRunRow(row);
  }

  /** runtime resource の owner run 検証用に、ID が一致する run を状態を問わず返す。 */
  getRun(runId: number): RunRow | null {
    const row = this.db.prepare(`SELECT * FROM task_runs WHERE id = ?`).get(runId) as RawRunRow | undefined;
    return row === undefined ? null : mapRunRow(row);
  }

  endRun(runId: number, status: RunStatus, meta?: Record<string, unknown>): void {
    const exec = this.db.transaction((): void => {
      const run = this.db.prepare(`SELECT * FROM task_runs WHERE id = ?`).get(runId) as RawRunRow | undefined;
      if (run === undefined) {
        return;
      }
      const now = nowSeconds();
      this.staleCancelSteersForRunAt(run.id, run.session_id, "core", "run-closed", now);
      if (meta !== undefined) {
        this.db
          .prepare(`UPDATE task_runs SET status = ?, ended_at = ?, meta = ? WHERE id = ?`)
          .run(status, now, JSON.stringify(meta), runId);
      } else {
        this.db.prepare(`UPDATE task_runs SET status = ?, ended_at = ? WHERE id = ?`).run(status, now, runId);
      }
    });
    exec();
  }

  listOpenRuns(): RunRow[] {
    const rows = this.db.prepare(`SELECT * FROM task_runs WHERE status = 'running'`).all() as RawRunRow[];
    return rows.map(mapRunRow);
  }

  acceptExternalRuntimeGenerationStatus(
    sample: ValidatedExternalRuntimeGenerationStatus,
    acceptedAt: number,
  ): ExternalRuntimeGenerationStatusAcceptance {
    if (!Number.isSafeInteger(acceptedAt) || acceptedAt < 0) {
      throw new Error("external runtime generation acceptedAt が不正です");
    }
    const status = validateExternalRuntimeGenerationStatus(sample.status, sample.status.provider);
    const canonicalPayload = canonicalJson(status);
    const canonicalDigest = externalRuntimeGenerationDigest(canonicalPayload);
    if (sample.canonicalJson !== canonicalPayload || sample.canonicalDigest !== canonicalDigest) {
      throw new Error("external runtime generation sample のcanonical値が不整合です");
    }

    const exec = this.db.transaction((): ExternalRuntimeGenerationStatusAcceptance => {
      const currentRow = this.db
        .prepare(`SELECT * FROM external_runtime_generation_statuses WHERE provider = ?`)
        .get(status.provider) as RawExternalRuntimeGenerationStatusRow | undefined;
      if (currentRow !== undefined) {
        const current = mapExternalRuntimeGenerationStatusRow(currentRow);
        if (status.revision < current.status.revision) return "replay";
        if (status.revision === current.status.revision) {
          return canonicalDigest === current.canonicalDigest ? "idempotent" : "equivocation";
        }
        if (status.observedAt < current.status.observedAt) return "history_missing";

        const nextTransitionPayloads = new Set(status.transitions.map((transition) => canonicalJson(transition)));
        for (const transition of current.status.transitions) {
          if (acceptedAt <= transition.expiresAt && !nextTransitionPayloads.has(canonicalJson(transition))) {
            return "history_missing";
          }
        }

        const nextAttestationIdentities = new Set(
          status.attestations.map((attestation) => canonicalJson(attestation.identity)),
        );
        const nextConsumedIdentities = new Set(
          status.transitions
            .filter((transition) => transition.revision > current.status.revision && transition.oldIdentity !== null)
            .map((transition) => canonicalJson(transition.oldIdentity)),
        );
        for (const attestation of current.status.attestations) {
          const identity = canonicalJson(attestation.identity);
          if (!nextAttestationIdentities.has(identity) && !nextConsumedIdentities.has(identity)) {
            return "history_missing";
          }
        }
      }

      this.db.prepare(
        `INSERT INTO external_runtime_generation_statuses
           (provider, lane, runtime_key, revision, canonical_digest, canonical_payload, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           lane = excluded.lane,
           runtime_key = excluded.runtime_key,
           revision = excluded.revision,
           canonical_digest = excluded.canonical_digest,
           canonical_payload = excluded.canonical_payload,
           accepted_at = excluded.accepted_at`,
      ).run(
        status.provider,
        status.lane,
        status.runtimeKey,
        status.revision,
        canonicalDigest,
        canonicalPayload,
        acceptedAt,
      );
      return "accepted";
    });
    return exec();
  }

  bindExternalRuntimeGenerationLaunch(input: BindExternalRuntimeGenerationLaunchInput): boolean {
    if (!Number.isSafeInteger(input.boundAt) || input.boundAt < 0 || input.transport !== "bridge") return false;
    let attestation: ReturnType<typeof validateExternalRuntimeGenerationAttestation>;
    try {
      attestation = validateExternalRuntimeGenerationAttestation(input.attestation, input.provider);
    } catch {
      return false;
    }
    const exec = this.db.transaction((): boolean => {
      const statusRow = this.db
        .prepare(`SELECT * FROM external_runtime_generation_statuses WHERE provider = ?`)
        .get(input.provider) as RawExternalRuntimeGenerationStatusRow | undefined;
      if (statusRow === undefined) return false;
      const status = mapExternalRuntimeGenerationStatusRow(statusRow);
      if (
        status.status.revision !== input.statusRevision || status.canonicalDigest !== input.statusDigest ||
        status.status.runtimeKey !== attestation.runtimeKey ||
        !externalRuntimeGenerationStatusIsFresh(status.status, input.boundAt) ||
        !externalRuntimeGenerationAttestationIsFresh(attestation, input.boundAt) ||
        attestation.statusRevision > status.status.revision
      ) return false;

      const attestationJson = canonicalJson(attestation);
      const identityJson = canonicalJson(attestation.identity);
      const matchedCurrent = status.status.attestations.some((candidate) => canonicalJson(candidate) === attestationJson);
      const matchedTerminal = status.status.transitions.some((transition) =>
        (transition.kind === "stopped" || transition.kind === "replaced") &&
        transition.oldIdentity !== null && input.boundAt <= transition.expiresAt &&
        canonicalJson(transition.oldIdentity) === identityJson);
      const matchedReplacement = status.status.transitions.some((transition) =>
        transition.kind === "replaced" && transition.newIdentity !== null &&
        input.boundAt <= transition.expiresAt && canonicalJson(transition.newIdentity) === identityJson);
      if (!matchedCurrent && !matchedTerminal && !matchedReplacement) return false;

      const run = this.db.prepare(`SELECT * FROM task_runs WHERE id = ?`).get(input.runId) as RawRunRow | undefined;
      if (
        run === undefined || run.status !== "running" || run.task_id !== input.taskId ||
        run.session_id !== input.sessionId || run.provider !== input.provider
      ) return false;
      let runMeta: unknown;
      try {
        runMeta = JSON.parse(run.meta) as unknown;
      } catch {
        return false;
      }
      if (
        !isExternalRuntimeRecord(runMeta) || runMeta["transport"] !== input.transport ||
        runMeta["appliedModel"] !== attestation.identity.runtimeModelId
      ) {
        return false;
      }
      const runRole = runMeta["role"] === "reviewer"
        ? "reviewer"
        : runMeta["role"] === "worker" || runMeta["role"] === "rework"
          ? "worker"
          : null;
      if (runRole !== input.role) return false;

      const existing = this.db
        .prepare(`SELECT * FROM external_runtime_generation_bindings WHERE run_id = ?`)
        .get(input.runId) as RawExternalRuntimeGenerationBindingRow | undefined;
      if (existing !== undefined) {
        const binding = mapExternalRuntimeGenerationBindingRow(existing);
        return binding.taskId === input.taskId && binding.sessionId === input.sessionId &&
          binding.role === input.role && binding.provider === input.provider &&
          binding.transport === input.transport && binding.runtimeKey === attestation.runtimeKey &&
          canonicalJson(binding.identity) === identityJson;
      }

      this.db.prepare(
        `INSERT INTO external_runtime_generation_bindings
           (run_id, version, task_id, session_id, role, provider, transport, runtime_key, identity_json, bound_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.runId,
        input.taskId,
        input.sessionId,
        input.role,
        input.provider,
        input.transport,
        attestation.runtimeKey,
        identityJson,
        input.boundAt,
      );
      return true;
    });
    return exec();
  }

  getExternalRuntimeGenerationStatus(provider: Provider): ExternalRuntimeGenerationStatusRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM external_runtime_generation_statuses WHERE provider = ?`)
      .get(provider) as RawExternalRuntimeGenerationStatusRow | undefined;
    return row === undefined ? null : mapExternalRuntimeGenerationStatusRow(row);
  }

  getExternalRuntimeGenerationBinding(runId: number): ExternalRuntimeGenerationBindingV1 | null {
    const row = this.db
      .prepare(`SELECT * FROM external_runtime_generation_bindings WHERE run_id = ?`)
      .get(runId) as RawExternalRuntimeGenerationBindingRow | undefined;
    return row === undefined ? null : mapExternalRuntimeGenerationBindingRow(row);
  }

  listExternalRuntimeGenerationBindingsByIdentity(
    provider: Provider,
    runtimeKey: string,
    identity: ExternalRuntimeGenerationIdentityV1,
  ): ExternalRuntimeGenerationBindingV1[] {
    const identityJson = canonicalJson(validateExternalRuntimeGenerationIdentity(identity));
    const rows = this.db.prepare(
      `SELECT * FROM external_runtime_generation_bindings
       WHERE provider = ? AND runtime_key = ? AND identity_json = ?
       ORDER BY run_id ASC`,
    ).all(provider, runtimeKey, identityJson) as RawExternalRuntimeGenerationBindingRow[];
    return rows.map(mapExternalRuntimeGenerationBindingRow);
  }

  /**
   * 契約 §78.5.1: current fence 認可済み D1 closure からだけ呼ぶ private persistence port。
   * INSERT の競合対象を (session_id, event_id) へ限定し、同 key だけ duplicate=true として扱う。
   * 重複時は fence/observedAt/recordedAt を含む既存列を一切更新しない（初回 authorized report を保持する）。
   */
  recordRelayDeliveryUncertain(
    input: RelayDeliveryUncertainRecordInput,
  ): RecordRelayDeliveryUncertainResult {
    const validated = validateRelayDeliveryUncertainRecordInput(input);
    const recordedAt = nowSeconds();
    const info = this.db.prepare(
      `INSERT INTO relay_delivery_uncertain_events
         (session_id, event_id, handover_generation, relay_id, fencing_token, reason,
          observed_at, provider, host, even_terminal_boot_epoch, canonical_server_url, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, event_id) DO NOTHING`,
    ).run(
      validated.sessionId,
      validated.eventId,
      validated.handoverGeneration,
      validated.relayId,
      validated.fencingToken,
      validated.reason,
      validated.observedAt,
      validated.provider,
      validated.host,
      validated.evenTerminalBootEpoch,
      validated.canonicalServerUrl,
      recordedAt,
    );
    return { recorded: true, duplicate: info.changes === 0 };
  }

  /**
   * 契約 §78.8 の ownership projection。task_runs.session_id の BINARY 完全一致行を id ASC で全件返す。
   * status filter / LIMIT / dedupe はしない。1行でも投影不能なら lookup 全体を throw する（fail-closed）。
   */
  lookupRelaySessionOwnership(sessionId: string): readonly RelaySessionOwnership[] {
    const rows = this.db.prepare(
      `SELECT provider, meta FROM task_runs WHERE session_id = ? COLLATE BINARY ORDER BY id ASC`,
    ).all(sessionId) as RawTaskRunOwnershipRow[];
    return rows.map(parseRelaySessionOwnershipRow);
  }

  // -------------------------------------------------------------------------
  // 契約 §78.10 / §78.10.3.1: production host登録authorityのdurable面。
  // 実SQL/transactionはここに閉じ、形式validator・row mapper・純粋な意味判定は
  // relay-authority-store.ts へ委譲する（RelayControlPersistenceと同じ分離規約）。
  // -------------------------------------------------------------------------

  private readRelayAuthorityBoardInstanceId(): string {
    const row = this.db.prepare(`SELECT board_instance_id FROM board_metadata WHERE singleton = 1`).get() as
      | { board_instance_id: string }
      | undefined;
    if (row === undefined) {
      throw new Error("board metadata が未初期化です");
    }
    return row.board_instance_id;
  }

  private readRelayAuthorityInstallationRaw(): RelayAuthorityInstallation | null {
    const row = this.db.prepare(`SELECT * FROM relay_authority_installation WHERE singleton = 1`).get() as
      | RawRelayAuthorityInstallationRow
      | undefined;
    return row === undefined ? null : mapRelayAuthorityInstallationRow(row);
  }

  private readRelaySessionAuthorityRaw(sessionId: string): RelaySessionAuthority | null {
    const row = this.db.prepare(
      `SELECT * FROM relay_session_authorities WHERE session_id = ? COLLATE BINARY`,
    ).get(sessionId) as RawRelaySessionAuthorityRow | undefined;
    return row === undefined ? null : mapRelaySessionAuthorityRow(row);
  }

  private readRelayRegistrationClaimRaw(claimId: string): RelayRegistrationClaim | null {
    const row = this.db.prepare(
      `SELECT * FROM relay_registration_claims WHERE claim_id = ? COLLATE BINARY`,
    ).get(claimId) as RawRelayRegistrationClaimRow | undefined;
    return row === undefined ? null : mapRelayRegistrationClaimRow(row);
  }

  /**
   * 同Storeでのauthority mutation再入を拒否し、IMMEDIATE transactionで実行する。
   * fn（callerのinput読取・snapshot・validation・SQLをすべて含む）はこの再入guardを
   * 通過した後にしか呼ばれないため、caller inputのどのpropertyもguard通過前には読まれない。
   * callback開始後（callRelayAuthorityBeforeMutation呼出後）の再入試行はreentrantAttemptedへlatchし、
   * callbackがその内側例外を握り潰しても、callback復帰直後にMUTATION_UNCERTAINでfatalにする
   * （callRelayAuthorityBeforeMutation側のreentrantAttempted検査）。
   * callback開始後にここへ届く例外はcodeがMUTATION_UNCERTAIN以外なら（RelayAuthorityMutationErrorで
   * あっても）すべてMUTATION_UNCERTAINへ統一し二重wrapしない。callback開始前の例外は通常分類のまま。
   */
  private runRelayAuthorityMutation<T>(fn: () => T): T {
    if (this.relayAuthorityMutationInFlight) {
      if (this.relayAuthorityCallbackStarted) {
        this.relayAuthorityReentrantAttempted = true;
      }
      throw new RelayAuthorityMutationError("REENTRANT_MUTATION", "relay authority mutationの再入は禁止です");
    }
    this.relayAuthorityMutationInFlight = true;
    this.relayAuthorityCallbackStarted = false;
    this.relayAuthorityReentrantAttempted = false;
    try {
      const exec = this.db.transaction(fn);
      try {
        return exec.immediate();
      } catch (error) {
        if (this.relayAuthorityCallbackStarted) {
          if (error instanceof RelayAuthorityMutationError && error.code === "MUTATION_UNCERTAIN") {
            throw error;
          }
          throw new RelayAuthorityMutationError(
            "MUTATION_UNCERTAIN",
            "callback開始後にDB操作またはcommitが失敗しました",
            error,
          );
        }
        throw error;
      }
    } finally {
      this.relayAuthorityMutationInFlight = false;
      this.relayAuthorityCallbackStarted = false;
      this.relayAuthorityReentrantAttempted = false;
    }
  }

  /**
   * 最初のwrite前に一度だけ呼ぶ。thenable返却・throwはどちらもMUTATION_UNCERTAINへ包み、
   * host側へ「callback開始後の不確定」を区別させる（callback開始前のrejectとは別code）。
   * callback中に再入mutationが試行された場合、callbackがその内側例外を握り潰して正常返却しても、
   * reentrantAttemptedのlatchを見て必ずMUTATION_UNCERTAINでfatalにする。
   * thenableチェックのproperty access自体（thenのgetter）が再入を起こして握り潰す場合にも備え、
   * そのアクセス後・戻る直前（＝最初のSQL write前）にlatchを再確認する。
   */
  private callRelayAuthorityBeforeMutation(
    beforeMutation: RelayAuthorityBeforeMutation,
    previousRevision: number | null,
    nextRevision: number,
  ): void {
    this.relayAuthorityCallbackStarted = true;
    let result: unknown;
    try {
      result = beforeMutation(previousRevision, nextRevision);
    } catch (cause) {
      if (cause instanceof RelayAuthorityMutationError && cause.code === "MUTATION_UNCERTAIN") {
        throw cause;
      }
      throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "beforeMutation callbackがthrowしました", cause);
    }
    const isThenable =
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as { then?: unknown }).then === "function";
    if (this.relayAuthorityReentrantAttempted) {
      throw new RelayAuthorityMutationError(
        "MUTATION_UNCERTAIN",
        "callback中に再入mutationが試行されました",
      );
    }
    if (isThenable) {
      throw new RelayAuthorityMutationError(
        "MUTATION_UNCERTAIN",
        "beforeMutation callbackはthenableを返してはいけません",
      );
    }
  }

  readInstallation(): RelayAuthorityInstallation | null {
    return this.readRelayAuthorityInstallationRaw();
  }

  readSessionAuthority(sessionId: string): RelaySessionAuthority | null {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new RelayAuthorityMutationError("INVALID_INPUT", "sessionIdは非空文字列が必須です");
    }
    return this.readRelaySessionAuthorityRaw(sessionId);
  }

  readRegistrationClaim(claimId: string): RelayRegistrationClaim | null {
    if (typeof claimId !== "string" || claimId.length === 0) {
      throw new RelayAuthorityMutationError("INVALID_INPUT", "claimIdは非空文字列が必須です");
    }
    return this.readRelayRegistrationClaimRaw(claimId);
  }

  adoptInstallation(
    input: RelayAdoptInstallationInput,
    beforeMutation: RelayAuthorityBeforeMutation,
  ): RelayAuthorityInstallation {
    // 再入guard（runRelayAuthorityMutation）を通過するまでcaller inputの一切のpropertyを読まない。
    // snapshot/validationはguard通過後のcallback内で行い、以後はcaller inputを一切再読しない
    // （callback中の書換えから隔離する）。
    return this.runRelayAuthorityMutation((): RelayAuthorityInstallation => {
      const snap: RelayAdoptInstallationInput = {
        identity: { ...input.identity },
        now: input.now,
      };
      validateRelayAdoptInstallationInput(snap);
      if (snap.identity.boardInstanceId !== this.readRelayAuthorityBoardInstanceId()) {
        throw new RelayAuthorityMutationError(
          "BOARD_INSTANCE_MISMATCH",
          "identity.boardInstanceIdがこのStoreのboardInstanceIdと一致しません",
        );
      }
      if (this.readRelayAuthorityInstallationRaw() !== null) {
        throw new RelayAuthorityMutationError("INSTALLATION_ALREADY_ADOPTED", "installationは既にadopt済みです");
      }
      const sessionCount = (this.db.prepare(`SELECT COUNT(*) AS n FROM relay_session_authorities`).get() as {
        n: number;
      }).n;
      const claimCount = (this.db.prepare(`SELECT COUNT(*) AS n FROM relay_registration_claims`).get() as {
        n: number;
      }).n;
      if (sessionCount !== 0 || claimCount !== 0) {
        throw new RelayAuthorityMutationError("AUTHORITY_STATE_NOT_EMPTY", "installation/session/claimは全不存在が必須です");
      }

      this.callRelayAuthorityBeforeMutation(beforeMutation, null, 1);

      const info = this.db.prepare(
        `INSERT INTO relay_authority_installation
           (singleton, board_instance_id, adoption_id, host_identity, host_epoch, authority_revision, created_at, updated_at)
         VALUES (1, ?, ?, ?, 1, 1, ?, ?)`,
      ).run(snap.identity.boardInstanceId, snap.identity.adoptionId, snap.identity.hostIdentity, snap.now, snap.now);
      if (info.changes !== 1) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "installationのinsertが期待件数と一致しません");
      }
      const installation = this.readRelayAuthorityInstallationRaw();
      if (installation === null) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "installationのcommit後読取に失敗しました");
      }
      return installation;
    });
  }

  advanceHostEpoch(
    input: RelayAdvanceHostEpochInput,
    beforeMutation: RelayAuthorityBeforeMutation,
  ): RelayAdvanceHostEpochResult {
    return this.runRelayAuthorityMutation((): RelayAdvanceHostEpochResult => {
      const snap: RelayAdvanceHostEpochInput = {
        expectedInstallation: { ...input.expectedInstallation },
        now: input.now,
      };
      validateRelayAdvanceHostEpochInput(snap);
      const current = this.readRelayAuthorityInstallationRaw();
      if (current === null) {
        throw new RelayAuthorityMutationError("INSTALLATION_NOT_FOUND", "installationが未adoptです");
      }
      if (!relayAuthorityInstallationMatches(snap.expectedInstallation, current)) {
        throw new RelayAuthorityMutationError("CAS_MISMATCH", "expectedInstallationがcurrentと一致しません");
      }

      const activeRows = (this.db.prepare(`SELECT * FROM relay_registration_claims WHERE state = 'active'`).all() as
        RawRelayRegistrationClaimRow[]).map(mapRelayRegistrationClaimRow);
      const issuedRows = (this.db.prepare(`SELECT * FROM relay_registration_claims WHERE state = 'issued'`).all() as
        RawRelayRegistrationClaimRow[]).map(mapRelayRegistrationClaimRow);

      const affectedSessionIds = new Set<string>();
      for (const claim of activeRows) affectedSessionIds.add(claim.sessionId);
      for (const claim of issuedRows) affectedSessionIds.add(claim.sessionId);

      for (const sessionId of affectedSessionIds) {
        const session = this.readRelaySessionAuthorityRaw(sessionId);
        if (session === null) {
          throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "claimが参照するsessionが見つかりません");
        }
        relayAuthorityNextCounter(session.revision);
      }
      for (const claim of [...activeRows, ...issuedRows]) {
        relayAuthorityNextCounter(claim.claimRevision);
      }
      const nextHostEpoch = relayAuthorityNextCounter(current.hostEpoch);
      const nextAuthorityRevision = relayAuthorityNextCounter(current.authorityRevision);

      this.callRelayAuthorityBeforeMutation(beforeMutation, current.authorityRevision, nextAuthorityRevision);

      const installationUpdate = this.db.prepare(
        `UPDATE relay_authority_installation SET host_epoch = ?, authority_revision = ?, updated_at = ? WHERE singleton = 1`,
      ).run(nextHostEpoch, nextAuthorityRevision, snap.now);
      if (installationUpdate.changes !== 1) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "installation更新が期待件数と一致しません");
      }

      const retiredOwners: RelayOwnerFence[] = activeRows.map((claim) =>
        relayAuthorityClaimFence(claim, claim.assignedFencingToken as number),
      );

      if (activeRows.length > 0) {
        const retireActive = this.db.prepare(
          `UPDATE relay_registration_claims
             SET state = 'retired', retired_at = ?, termination_reason = 'host_restart', claim_revision = claim_revision + 1
           WHERE state = 'active'`,
        ).run(snap.now);
        if (retireActive.changes !== activeRows.length) {
          throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "active claimのretired更新が期待件数と一致しません");
        }
      }
      if (issuedRows.length > 0) {
        const cancelIssued = this.db.prepare(
          `UPDATE relay_registration_claims
             SET state = 'cancelled', cancelled_at = ?, termination_reason = 'host_restart', claim_revision = claim_revision + 1
           WHERE state = 'issued'`,
        ).run(snap.now);
        if (cancelIssued.changes !== issuedRows.length) {
          throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "issued claimのcancelled更新が期待件数と一致しません");
        }
      }
      for (const sessionId of affectedSessionIds) {
        const sessionUpdate = this.db.prepare(
          `UPDATE relay_session_authorities SET revision = revision + 1, updated_at = ? WHERE session_id = ? COLLATE BINARY`,
        ).run(snap.now, sessionId);
        if (sessionUpdate.changes !== 1) {
          throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "session revision更新が期待件数と一致しません");
        }
      }

      const installation = this.readRelayAuthorityInstallationRaw();
      if (installation === null) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "installationのcommit後読取に失敗しました");
      }
      return { installation, retiredOwners };
    });
  }

  issueRegistrationClaim(
    input: RelayIssueRegistrationClaimInput,
    beforeMutation: RelayAuthorityBeforeMutation,
  ): RelayRegistrationClaim {
    return this.runRelayAuthorityMutation((): RelayRegistrationClaim => {
      const snap: RelayIssueRegistrationClaimInput = {
        expectedInstallation: { ...input.expectedInstallation },
        candidate: { ...input.candidate },
        purpose: input.purpose,
        nativeEvidenceDigest: input.nativeEvidenceDigest,
        nativeObservedAt: input.nativeObservedAt,
        claimId: input.claimId,
        claimSecretHash: Uint8Array.from(input.claimSecretHash),
        expiresAt: input.expiresAt,
        expectedPreviousRegistration:
          input.expectedPreviousRegistration === null ? null : { ...input.expectedPreviousRegistration },
        now: input.now,
      };
      validateRelayIssueRegistrationClaimInput(snap);
      const currentInstallation = this.readRelayAuthorityInstallationRaw();
      if (currentInstallation === null) {
        throw new RelayAuthorityMutationError("INSTALLATION_NOT_FOUND", "installationが未adoptです");
      }
      if (!relayAuthorityInstallationMatches(snap.expectedInstallation, currentInstallation)) {
        throw new RelayAuthorityMutationError("CAS_MISMATCH", "expectedInstallationがcurrentと一致しません");
      }

      if (this.readRelayRegistrationClaimRaw(snap.claimId) !== null) {
        throw new RelayAuthorityMutationError("CLAIM_ID_CONFLICT", "claimIdが既に存在します");
      }
      const existingRelay = this.db.prepare(
        `SELECT 1 FROM relay_registration_claims WHERE session_id = ? COLLATE BINARY AND relay_id = ? COLLATE BINARY`,
      ).get(snap.candidate.sessionId, snap.candidate.relayId);
      if (existingRelay !== undefined) {
        throw new RelayAuthorityMutationError("RELAY_ID_CONFLICT", "(sessionId, relayId)が既に存在します");
      }

      const session = this.readRelaySessionAuthorityRaw(snap.candidate.sessionId);
      const existingActiveOrIssued = (this.db.prepare(
        `SELECT * FROM relay_registration_claims WHERE session_id = ? COLLATE BINARY AND state IN ('issued', 'active')`,
      ).all(snap.candidate.sessionId) as RawRelayRegistrationClaimRow[]).map(mapRelayRegistrationClaimRow);
      const conflictCheck = relayAuthorityCheckIssueConflict(existingActiveOrIssued, snap.now);
      if (conflictCheck.conflict) {
        throw new RelayAuthorityMutationError("ISSUED_CLAIM_CONFLICT", "未期限切れのissuedまたはactive claimが存在します");
      }
      const latestClaim = session !== null && session.latestClaimId !== null
        ? this.readRelayRegistrationClaimRaw(session.latestClaimId)
        : null;
      relayAuthorityAssertIssuePurpose({
        purpose: snap.purpose,
        session,
        latestClaim,
        candidateHandoverGeneration: snap.candidate.handoverGeneration,
        expectedPreviousRegistration: snap.expectedPreviousRegistration,
      });

      const nextSessionRevision = relayAuthorityNextCounter(session === null ? null : session.revision);
      const nextAuthorityRevision = relayAuthorityNextCounter(currentInstallation.authorityRevision);
      let expiredClaimNextRevision: number | null = null;
      if (conflictCheck.expiredIssuedClaimId !== null) {
        const expiredClaim = existingActiveOrIssued.find((c) => c.claimId === conflictCheck.expiredIssuedClaimId);
        if (expiredClaim === undefined) {
          throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "期限切れclaimの再読取に失敗しました");
        }
        expiredClaimNextRevision = relayAuthorityNextCounter(expiredClaim.claimRevision);
      }

      this.callRelayAuthorityBeforeMutation(beforeMutation, currentInstallation.authorityRevision, nextAuthorityRevision);

      const installationUpdate = this.db.prepare(
        `UPDATE relay_authority_installation SET authority_revision = ?, updated_at = ? WHERE singleton = 1`,
      ).run(nextAuthorityRevision, snap.now);
      if (installationUpdate.changes !== 1) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "installation更新が期待件数と一致しません");
      }

      if (session === null) {
        const insertSession = this.db.prepare(
          `INSERT INTO relay_session_authorities
             (session_id, fencing_token_hwm, max_handover_generation, latest_claim_id, revision, created_at, updated_at)
           VALUES (?, NULL, NULL, NULL, ?, ?, ?)`,
        ).run(snap.candidate.sessionId, nextSessionRevision, snap.now, snap.now);
        if (insertSession.changes !== 1) {
          throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "sessionのinsertが期待件数と一致しません");
        }
      } else {
        const updateSession = this.db.prepare(
          `UPDATE relay_session_authorities SET revision = ?, updated_at = ? WHERE session_id = ? COLLATE BINARY`,
        ).run(nextSessionRevision, snap.now, snap.candidate.sessionId);
        if (updateSession.changes !== 1) {
          throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "session更新が期待件数と一致しません");
        }
      }

      if (conflictCheck.expiredIssuedClaimId !== null && expiredClaimNextRevision !== null) {
        const cancelExpired = this.db.prepare(
          `UPDATE relay_registration_claims
             SET state = 'cancelled', cancelled_at = ?, termination_reason = 'expired', claim_revision = ?
           WHERE claim_id = ? COLLATE BINARY AND state = 'issued'`,
        ).run(snap.now, expiredClaimNextRevision, conflictCheck.expiredIssuedClaimId);
        if (cancelExpired.changes !== 1) {
          throw new RelayAuthorityMutationError(
            "MUTATION_UNCERTAIN",
            "期限切れclaimのcancelled更新が期待件数と一致しません",
          );
        }
      }

      const insertClaim = this.db.prepare(
        `INSERT INTO relay_registration_claims
           (claim_id, session_id, relay_id, provider_session_id, provider, canonical_server_url, host,
            even_terminal_boot_epoch, native_evidence_digest, handover_generation, host_epoch, native_observed_at,
            claim_secret_hash, purpose, expected_fencing_token_hwm, expected_max_handover_generation,
            expected_session_revision, state, assigned_fencing_token, claim_revision, issued_at, expires_at,
            consumed_at, retired_at, cancelled_at, termination_reason, drain_evidence_digest, drained_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', NULL, 1, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
      ).run(
        snap.claimId,
        snap.candidate.sessionId,
        snap.candidate.relayId,
        snap.candidate.providerSessionId,
        snap.candidate.provider,
        snap.candidate.serverUrl,
        snap.candidate.host,
        snap.candidate.evenTerminalBootEpoch,
        snap.nativeEvidenceDigest,
        snap.candidate.handoverGeneration,
        currentInstallation.hostEpoch,
        snap.nativeObservedAt,
        Buffer.from(snap.claimSecretHash),
        snap.purpose,
        session === null ? null : session.fencingTokenHwm,
        session === null ? null : session.maxHandoverGeneration,
        nextSessionRevision,
        snap.now,
        snap.expiresAt,
      );
      if (insertClaim.changes !== 1) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "claimのinsertが期待件数と一致しません");
      }

      const claim = this.readRelayRegistrationClaimRaw(snap.claimId);
      if (claim === null) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "claimのcommit後読取に失敗しました");
      }
      return claim;
    });
  }

  activateRegistration(
    input: RelayActivateRegistrationInput,
    beforeMutation: RelayAuthorityBeforeMutation,
  ): RelayActivateRegistrationResult {
    return this.runRelayAuthorityMutation((): RelayActivateRegistrationResult => {
      const snap: RelayActivateRegistrationInput = {
        expectedInstallation: { ...input.expectedInstallation },
        claimId: input.claimId,
        claimSecretHash: Uint8Array.from(input.claimSecretHash),
        now: input.now,
      };
      validateRelayActivateRegistrationInput(snap);
      const currentInstallation = this.readRelayAuthorityInstallationRaw();
      if (currentInstallation === null) {
        throw new RelayAuthorityMutationError("INSTALLATION_NOT_FOUND", "installationが未adoptです");
      }
      if (!relayAuthorityInstallationMatches(snap.expectedInstallation, currentInstallation)) {
        throw new RelayAuthorityMutationError("CAS_MISMATCH", "expectedInstallationがcurrentと一致しません");
      }
      const claim = this.readRelayRegistrationClaimRaw(snap.claimId);
      if (claim === null) {
        throw new RelayAuthorityMutationError("CLAIM_NOT_FOUND", "claimが見つかりません");
      }
      if (claim.state !== "issued") {
        throw new RelayAuthorityMutationError("CLAIM_STATE_MISMATCH", "claimはissued状態が必須です");
      }
      if (claim.hostEpoch !== currentInstallation.hostEpoch) {
        throw new RelayAuthorityMutationError("CAS_MISMATCH", "claimのhostEpochがcurrentと一致しません");
      }
      const secretRow = this.db.prepare(
        `SELECT claim_secret_hash FROM relay_registration_claims WHERE claim_id = ? COLLATE BINARY`,
      ).get(snap.claimId) as { claim_secret_hash: Buffer } | undefined;
      if (
        secretRow === undefined ||
        !relayAuthorityClaimSecretMatches(snap.claimSecretHash, secretRow.claim_secret_hash)
      ) {
        throw new RelayAuthorityMutationError("CLAIM_SECRET_MISMATCH", "claim secretが一致しません");
      }
      if (!(snap.now < claim.expiresAt)) {
        throw new RelayAuthorityMutationError("CLAIM_EXPIRED", "claimは期限切れです");
      }
      const session = this.readRelaySessionAuthorityRaw(claim.sessionId);
      if (session === null) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "claimが参照するsessionが見つかりません");
      }
      if (
        claim.expectedFencingTokenHwm !== session.fencingTokenHwm ||
        claim.expectedMaxHandoverGeneration !== session.maxHandoverGeneration ||
        claim.expectedSessionRevision !== session.revision
      ) {
        throw new RelayAuthorityMutationError(
          "EXPECTED_SNAPSHOT_MISMATCH",
          "claimのexpected snapshotがsessionと一致しません",
        );
      }
      const existingActive = this.db.prepare(
        `SELECT 1 FROM relay_registration_claims WHERE session_id = ? COLLATE BINARY AND state = 'active'`,
      ).get(claim.sessionId);
      if (existingActive !== undefined) {
        throw new RelayAuthorityMutationError("ACTIVE_REGISTRATION_CONFLICT", "sessionに既にactive claimが存在します");
      }

      const nextFencingToken = relayAuthorityNextCounter(session.fencingTokenHwm);
      const nextSessionRevision = relayAuthorityNextCounter(session.revision);
      const nextClaimRevision = relayAuthorityNextCounter(claim.claimRevision);
      const nextAuthorityRevision = relayAuthorityNextCounter(currentInstallation.authorityRevision);

      this.callRelayAuthorityBeforeMutation(beforeMutation, currentInstallation.authorityRevision, nextAuthorityRevision);

      const installationUpdate = this.db.prepare(
        `UPDATE relay_authority_installation SET authority_revision = ?, updated_at = ? WHERE singleton = 1`,
      ).run(nextAuthorityRevision, snap.now);
      if (installationUpdate.changes !== 1) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "installation更新が期待件数と一致しません");
      }
      const claimUpdate = this.db.prepare(
        `UPDATE relay_registration_claims
           SET state = 'active', assigned_fencing_token = ?, consumed_at = ?, claim_revision = ?
         WHERE claim_id = ? COLLATE BINARY AND state = 'issued'`,
      ).run(nextFencingToken, snap.now, nextClaimRevision, snap.claimId);
      if (claimUpdate.changes !== 1) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "claim更新が期待件数と一致しません");
      }
      const sessionUpdate = this.db.prepare(
        `UPDATE relay_session_authorities
           SET fencing_token_hwm = ?, max_handover_generation = ?, latest_claim_id = ?, revision = ?, updated_at = ?
         WHERE session_id = ? COLLATE BINARY`,
      ).run(nextFencingToken, claim.handoverGeneration, claim.claimId, nextSessionRevision, snap.now, claim.sessionId);
      if (sessionUpdate.changes !== 1) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "session更新が期待件数と一致しません");
      }

      const installation = this.readRelayAuthorityInstallationRaw();
      if (installation === null) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "installationのcommit後読取に失敗しました");
      }
      const owner = relayAuthorityClaimFence(claim, nextFencingToken);
      return { owner, installation };
    });
  }

  retireRegistration(
    input: RelayRetireRegistrationInput,
    beforeMutation: RelayAuthorityBeforeMutation,
  ): RelayRetireRegistrationResult {
    return this.runRelayAuthorityMutation((): RelayRetireRegistrationResult => {
      const snap: RelayRetireRegistrationInput = {
        expectedInstallation: { ...input.expectedInstallation },
        owner: { ...input.owner },
        expectedClaimRevision: input.expectedClaimRevision,
        reason: input.reason,
        drainEvidenceDigest: input.drainEvidenceDigest,
        drainedAt: input.drainedAt,
        now: input.now,
      };
      validateRelayRetireRegistrationInput(snap);
      const currentInstallation = this.readRelayAuthorityInstallationRaw();
      if (currentInstallation === null) {
        throw new RelayAuthorityMutationError("INSTALLATION_NOT_FOUND", "installationが未adoptです");
      }
      if (!relayAuthorityInstallationMatches(snap.expectedInstallation, currentInstallation)) {
        throw new RelayAuthorityMutationError("CAS_MISMATCH", "expectedInstallationがcurrentと一致しません");
      }
      const session = this.readRelaySessionAuthorityRaw(snap.owner.sessionId);
      if (session === null || session.latestClaimId === null) {
        throw new RelayAuthorityMutationError("CAS_MISMATCH", "sessionにactive claimがありません");
      }
      const claim = this.readRelayRegistrationClaimRaw(session.latestClaimId);
      if (claim === null || claim.state !== "active") {
        throw new RelayAuthorityMutationError("CLAIM_STATE_MISMATCH", "latest claimがactive状態ではありません");
      }
      if (claim.assignedFencingToken === null) {
        throw new RelayAuthorityMutationError(
          "MUTATION_UNCERTAIN",
          "active claimのassignedFencingTokenが欠落しています",
        );
      }
      const currentFence = relayAuthorityClaimFence(claim, claim.assignedFencingToken);
      if (!relayOwnerFenceEquals(currentFence, snap.owner)) {
        throw new RelayAuthorityMutationError("OWNER_MISMATCH", "ownerがlatest active full fenceと一致しません");
      }
      if (claim.claimRevision !== snap.expectedClaimRevision) {
        throw new RelayAuthorityMutationError("CLAIM_REVISION_MISMATCH", "expectedClaimRevisionがclaimと一致しません");
      }

      const nextClaimRevision = relayAuthorityNextCounter(claim.claimRevision);
      const nextSessionRevision = relayAuthorityNextCounter(session.revision);
      const nextAuthorityRevision = relayAuthorityNextCounter(currentInstallation.authorityRevision);

      this.callRelayAuthorityBeforeMutation(beforeMutation, currentInstallation.authorityRevision, nextAuthorityRevision);

      const installationUpdate = this.db.prepare(
        `UPDATE relay_authority_installation SET authority_revision = ?, updated_at = ? WHERE singleton = 1`,
      ).run(nextAuthorityRevision, snap.now);
      if (installationUpdate.changes !== 1) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "installation更新が期待件数と一致しません");
      }
      const claimUpdate = this.db.prepare(
        `UPDATE relay_registration_claims
           SET state = 'retired', retired_at = ?, termination_reason = ?, drain_evidence_digest = ?, drained_at = ?, claim_revision = ?
         WHERE claim_id = ? COLLATE BINARY AND state = 'active'`,
      ).run(snap.now, snap.reason, snap.drainEvidenceDigest, snap.drainedAt, nextClaimRevision, claim.claimId);
      if (claimUpdate.changes !== 1) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "claim更新が期待件数と一致しません");
      }
      const sessionUpdate = this.db.prepare(
        `UPDATE relay_session_authorities SET revision = ?, updated_at = ? WHERE session_id = ? COLLATE BINARY`,
      ).run(nextSessionRevision, snap.now, session.sessionId);
      if (sessionUpdate.changes !== 1) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "session更新が期待件数と一致しません");
      }

      const installation = this.readRelayAuthorityInstallationRaw();
      if (installation === null) {
        throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "installationのcommit後読取に失敗しました");
      }
      return { installation };
    });
  }

  currentRunCancelFence(runId: number): number {
    const row = this.db
      .prepare(`SELECT cancel_fence FROM run_cancel_requests WHERE run_id = ? ORDER BY cancel_fence DESC LIMIT 1`)
      .get(runId) as { cancel_fence: number } | undefined;
    return row?.cancel_fence ?? 0;
  }

  private hasSessionEnded(taskId: string, sessionId: string): boolean {
    const events = this.db
      .prepare(`SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'session_ended' ORDER BY id DESC`)
      .all(taskId) as Array<{ payload: string }>;
    return events.some((event) => {
      try {
        const payload = JSON.parse(event.payload) as Record<string, unknown>;
        return payload["sessionId"] === sessionId;
      } catch {
        return false;
      }
    });
  }

  private assertCurrentDirectRestartTarget(
    input: { taskId: string; runId: number; sessionId: string; expectedCancelFence: number },
    orchestratorId: string,
  ): void {
    const task = this.requireTaskRaw(input.taskId);
    this.assertTaskPrimaryOrchestrator(task, orchestratorId);
    const run = this.db.prepare(
      `SELECT * FROM task_runs
       WHERE task_id = ? AND status = 'running'
       ORDER BY started_at DESC, id DESC LIMIT 1`,
    ).get(input.taskId) as RawRunRow | undefined;
    if (
      run === undefined || run.id !== input.runId || run.session_id !== input.sessionId ||
      this.hasSessionEnded(input.taskId, input.sessionId)
    ) {
      throw new Error("direct restart authority対象がcurrent open run/sessionと一致しません");
    }
    let transport: unknown;
    try {
      const meta = JSON.parse(run.meta) as unknown;
      transport = typeof meta === "object" && meta !== null && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)["transport"]
        : undefined;
    } catch {
      transport = undefined;
    }
    if (transport !== "direct") {
      throw new Error("direct restart authority対象runのtransportがdirectではありません");
    }
    if (this.currentRunCancelFence(input.runId) !== input.expectedCancelFence) {
      throw new Error("direct restart authorityのcancel fenceがcurrent runと一致しません");
    }
  }

  createOrGetDirectRestartIntent(input: CreateDirectRestartIntentInput): DirectRestartIntentRow {
    const intentKey = requireNonEmptyString(input.intentKey, "direct restart intent key").trim();
    const sessionId = requireNonEmptyString(input.sessionId, "direct restart session ID").trim();
    acknowledgeActor(input.actor);
    if (!Number.isInteger(input.runId) || input.runId <= 0) {
      throw new Error("direct restart run IDは正の整数が必須です");
    }
    if (!Number.isInteger(input.expectedCancelFence) || input.expectedCancelFence < 0) {
      throw new Error("direct restart cancel fenceは0以上の整数が必須です");
    }
    const exec = this.db.transaction((): DirectRestartIntentRow => {
      const authorized = this.authorizeActorProvenance(input.provenance);
      if (authorized.kind !== "orchestrator") {
        throw new Error("direct restart intentはactive exact orchestrator provenanceが必須です");
      }
      this.assertCurrentDirectRestartTarget({
        taskId: input.taskId,
        runId: input.runId,
        sessionId,
        expectedCancelFence: input.expectedCancelFence,
      }, authorized.actorId);

      const matches = (this.db.prepare(
        `SELECT * FROM task_events WHERE event_type = 'direct_restart_intent_created' ORDER BY id`,
      ).all() as RawEventRow[]).map(mapDirectRestartIntentRow).filter((row) => row.intentKey === intentKey);
      if (matches.length > 1) {
        throw new Error("direct restart intent keyが複数eventへ解決されました");
      }
      const existing = matches[0];
      if (existing !== undefined) {
        if (
          existing.taskId !== input.taskId || existing.runId !== input.runId ||
          existing.sessionId !== sessionId || existing.expectedCancelFence !== input.expectedCancelFence ||
          existing.provenance.actorId !== authorized.actorId ||
          existing.provenance.actorSessionId !== authorized.actorSessionId ||
          existing.provenance.actorGeneration !== authorized.actorGeneration
        ) {
          throw new Error("direct restart intent keyが異なるauthority/targetと衝突しました");
        }
        const raw = this.db.prepare(`SELECT actor FROM task_events WHERE id = ?`).get(existing.id) as
          | { actor: string }
          | undefined;
        if (raw?.actor !== input.actor) {
          throw new Error("direct restart intent keyが異なるactorと衝突しました");
        }
        return existing;
      }

      const now = nowSeconds();
      const id = Number(this.insertTaskEvent(input.taskId, "direct_restart_intent_created", input.actor, {
        intentKey,
        runId: input.runId,
        sessionId,
        expectedCancelFence: input.expectedCancelFence,
        transport: "direct",
      }, now, authorized));
      const row = this.db.prepare(`SELECT * FROM task_events WHERE id = ?`).get(id) as RawEventRow | undefined;
      if (row === undefined) {
        throw new Error("direct restart intent eventの永続化確認に失敗しました");
      }
      return mapDirectRestartIntentRow(row);
    });
    return exec();
  }

  assertDirectRestartIntentCurrent(input: AssertDirectRestartIntentInput): DirectRestartIntentRow {
    const sessionId = requireNonEmptyString(input.sessionId, "direct restart session ID").trim();
    acknowledgeActor(input.actor);
    if (!Number.isInteger(input.intentId) || input.intentId <= 0 || !Number.isInteger(input.runId) || input.runId <= 0) {
      throw new Error("direct restart intent/run IDは正の整数が必須です");
    }
    if (!Number.isInteger(input.expectedCancelFence) || input.expectedCancelFence < 0) {
      throw new Error("direct restart cancel fenceは0以上の整数が必須です");
    }
    const exec = this.db.transaction((): DirectRestartIntentRow => {
      const authorized = this.authorizeActorProvenance(input.provenance);
      if (authorized.kind !== "orchestrator") {
        throw new Error("direct restart intent再検証はactive exact orchestrator provenanceが必須です");
      }
      const raw = this.db.prepare(
        `SELECT * FROM task_events WHERE id = ? AND event_type = 'direct_restart_intent_created'`,
      ).get(input.intentId) as RawEventRow | undefined;
      if (raw === undefined) {
        throw new Error("direct restart intent eventが見つかりません");
      }
      const intent = mapDirectRestartIntentRow(raw);
      if (
        raw.actor !== input.actor || intent.taskId !== input.taskId || intent.runId !== input.runId ||
        intent.sessionId !== sessionId || intent.expectedCancelFence !== input.expectedCancelFence ||
        intent.provenance.actorId !== authorized.actorId ||
        intent.provenance.actorSessionId !== authorized.actorSessionId ||
        intent.provenance.actorGeneration !== authorized.actorGeneration
      ) {
        throw new Error("direct restart intent eventがexact authority/targetと一致しません");
      }
      this.assertCurrentDirectRestartTarget({
        taskId: input.taskId,
        runId: input.runId,
        sessionId,
        expectedCancelFence: input.expectedCancelFence,
      }, authorized.actorId);
      return intent;
    });
    return exec();
  }

  createOrGetSteerDelivery(input: CreateSteerDeliveryInput): SteerDeliveryRow {
    const messageKey = input.messageKey.trim();
    const actor = redactText(input.actor.trim());
    const supersedesId = input.supersedesId?.trim() ?? "";
    if (messageKey === "" || actor === "") {
      throw new Error("steer delivery の message key/actor は空にできません");
    }
    if (!Number.isInteger(input.expectedCancelFence) || input.expectedCancelFence < 0) {
      throw new Error("steer delivery の cancel fence は 0 以上の整数が必須です");
    }

    const exec = this.db.transaction((): SteerDeliveryRow => {
      const existing = this.db.prepare(`SELECT * FROM steer_deliveries WHERE message_key = ?`).get(messageKey) as
        | RawSteerDeliveryRow
        | undefined;
      if (existing !== undefined) {
        if (
          existing.task_id !== input.taskId || existing.run_id !== input.runId ||
          existing.session_id !== input.sessionId || existing.expected_cancel_fence !== input.expectedCancelFence ||
          (existing.supersedes_id ?? "") !== supersedesId
        ) {
          throw new Error("steer message key が異なる lifecycle 入力と衝突しました");
        }
        return mapSteerDeliveryRow(existing);
      }

      const run = this.db
        .prepare(`SELECT * FROM task_runs WHERE task_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`)
        .get(input.taskId) as RawRunRow | undefined;
      if (run === undefined || run.id !== input.runId || run.session_id !== input.sessionId) {
        throw new Error("steer 対象が current open run/session と一致しません");
      }
      if (this.hasSessionEnded(input.taskId, input.sessionId)) {
        throw new Error("session終了確定後の通常 steer は拒否されます");
      }
      const cancelFence = this.currentRunCancelFence(input.runId);
      if (cancelFence !== input.expectedCancelFence) {
        throw new Error("steer の cancel fence が current run と一致しません");
      }
      if (cancelFence > 0) {
        throw new Error("cancel 開始後の通常 steer は拒否されます");
      }

      let superseded: RawSteerDeliveryRow | undefined;
      if (supersedesId !== "") {
        superseded = this.db.prepare(`SELECT * FROM steer_deliveries WHERE id = ?`).get(supersedesId) as
          | RawSteerDeliveryRow
          | undefined;
        if (
          superseded === undefined || superseded.task_id !== input.taskId || superseded.run_id !== input.runId ||
          superseded.session_id !== input.sessionId
        ) {
          throw new Error("supersede 対象が同一 task/run/session に属しません");
        }
      }

      const sequenceRow = this.db
        .prepare(`SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM steer_deliveries WHERE run_id = ? AND session_id = ?`)
        .get(input.runId, input.sessionId) as { max_sequence: number };
      const sequence = sequenceRow.max_sequence + 1;
      const now = nowSeconds();
      const id = generateRuntimeId("sd");
      this.db
        .prepare(
          `INSERT INTO steer_deliveries (
             id, task_id, run_id, session_id, message_key, sequence, status, supersedes_id,
             expected_cancel_fence, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'queued', NULLIF(?, ''), ?, ?, ?)`,
        )
        .run(id, input.taskId, input.runId, input.sessionId, messageKey, sequence, supersedesId, cancelFence, now, now);

      if (superseded?.status === "queued") {
        this.db
          .prepare(`UPDATE steer_deliveries SET status = 'superseded', updated_at = ?, resolved_at = ? WHERE id = ?`)
          .run(now, now, superseded.id);
        this.insertSteerEvent(superseded.task_id, "steer_superseded", actor, superseded.id, superseded.run_id,
          superseded.session_id, superseded.expected_cancel_fence, { replacementId: id }, now);
      }
      this.insertSteerEvent(input.taskId, "steer_queued", actor, id, input.runId, input.sessionId, cancelFence, {
        sequence,
        supersedesId: supersedesId === "" ? null : supersedesId,
        superseded: superseded?.status === "queued",
      }, now);
      return this.getSteerDelivery(id)!;
    });
    return exec();
  }

  claimSteerDispatch(deliveryId: string, expectedRunId: number, expectedSessionId: string,
    expectedCancelFence: number, actor: string): SteerDeliveryRow {
    const exec = this.db.transaction((): SteerDeliveryRow => {
      const row = this.db.prepare(`SELECT * FROM steer_deliveries WHERE id = ?`).get(deliveryId) as
        | RawSteerDeliveryRow
        | undefined;
      if (row === undefined || row.status !== "queued") {
        throw new Error("steer dispatch claim の queued CAS に失敗しました");
      }
      this.assertSteerCurrent(row, expectedRunId, expectedSessionId, expectedCancelFence);
      const now = nowSeconds();
      const info = this.db.prepare(
        `UPDATE steer_deliveries SET status = 'dispatching', updated_at = ? WHERE id = ? AND status = 'queued'`,
      ).run(now, deliveryId);
      if (info.changes !== 1) {
        throw new Error("steer dispatch claim CAS に失敗しました");
      }
      this.insertSteerEvent(row.task_id, "steer_dispatching", actor, row.id, row.run_id, row.session_id,
        row.expected_cancel_fence, {}, now);
      return this.getSteerDelivery(deliveryId)!;
    });
    return exec();
  }

  getSteerDelivery(id: string): SteerDeliveryRow | null {
    const row = this.db.prepare(`SELECT * FROM steer_deliveries WHERE id = ?`).get(id) as RawSteerDeliveryRow | undefined;
    return row === undefined ? null : mapSteerDeliveryRow(row);
  }

  getSteerDeliveryByMessageKey(messageKey: string): SteerDeliveryRow | null {
    const row = this.db.prepare(`SELECT * FROM steer_deliveries WHERE message_key = ?`).get(messageKey) as
      | RawSteerDeliveryRow
      | undefined;
    return row === undefined ? null : mapSteerDeliveryRow(row);
  }

  listSteerDeliveries(taskId?: string): SteerDeliveryRow[] {
    const rows = (taskId === undefined
      ? this.db.prepare(`SELECT * FROM steer_deliveries ORDER BY run_id, sequence, id`).all()
      : this.db.prepare(`SELECT * FROM steer_deliveries WHERE task_id = ? ORDER BY run_id, sequence, id`).all(taskId)) as
      RawSteerDeliveryRow[];
    return rows.map(mapSteerDeliveryRow);
  }

  createOrGetNativeSourceBinding(input: CreateNativeSourceBindingInput): NativeSessionBindingRow {
    const bindingKey = requireNonEmptyString(input.bindingKey, "native source binding key").trim();
    const hostId = requireNonEmptyString(input.hostId, "native source host ID").trim();
    const providerSessionId = requireNonEmptyString(
      input.providerSessionId,
      "native source provider session ID",
    ).trim();
    const nativeAddress = normalizeNativeAddress(input.nativeAddress, input.provider);
    const evidence = normalizeNativeBindingEvidence(input);
    const exec = this.db.transaction((): NativeSessionBindingRow => {
      const authorized = this.authorizeActorProvenance(input.provenance);
      if (authorized.kind !== "orchestrator") {
        throw new Error("native source binding はactive exact orchestrator provenanceが必須です");
      }
      const task = this.requireTaskRaw(input.taskId);
      this.assertTaskPrimaryOrchestrator(task, authorized.actorId);
      const session = this.db
        .prepare(`SELECT * FROM orchestrator_sessions WHERE id = ?`)
        .get(authorized.actorSessionId) as RawOrchestratorSessionRow | undefined;
      if (
        session === undefined || session.orchestrator_id !== authorized.actorId ||
        session.generation !== authorized.actorGeneration || session.status !== "active" ||
        session.provider !== input.provider || session.provider_session_id !== providerSessionId ||
        !["codex-session-start", "claude-delivery"].includes(session.provider_session_source) ||
        (session.provider_session_source === "codex-session-start" && input.provider !== "codex") ||
        (session.provider_session_source === "claude-delivery" && input.provider !== "claude")
      ) {
        throw new Error("native source binding がactive provider orchestrator sessionと完全一致しません");
      }

      const existing = this.db
        .prepare(`SELECT * FROM native_session_bindings WHERE binding_key = ?`)
        .get(bindingKey) as RawNativeSessionBindingRow | undefined;
      if (existing !== undefined) {
        const now = nowSeconds();
        // kind/task は stable key の所有境界なので、期限切れ後も別 task/kind への
        // key 再利用は拒否する。一方、provider session/capability/TTL は probe の
        // 新しい証拠で安全に置き換えられる（active attempt の hash drift は許さない）。
        if (existing.kind !== "source" || existing.task_id !== input.taskId) {
          throw new Error("native source binding key が異なるsource/taskと衝突しました");
        }
        const stableIdentity =
          existing.provider === input.provider && existing.host_id === hostId &&
          existing.provider_session_id === providerSessionId && existing.native_address === nativeAddress &&
          existing.runtime_version === evidence.runtimeVersion &&
          existing.capability_hash === evidence.capabilityHash && existing.orchestrator_id === authorized.actorId &&
          existing.orchestrator_session_id === authorized.actorSessionId &&
          existing.orchestrator_generation === authorized.actorGeneration;
        const exact =
          stableIdentity && existing.observed_at === evidence.observedAt && existing.expires_at === evidence.expiresAt;
        if (existing.status === "active" && existing.expires_at > now) {
          if (exact) {
            return mapNativeSessionBindingRow(existing);
          }
          if (stableIdentity && evidence.observedAt >= existing.observed_at && evidence.expiresAt >= existing.expires_at) {
            const liveAttempt = this.db.prepare(
              `SELECT id, status FROM communication_delivery_attempts
               WHERE source_binding_id = ?
                 AND status IN ('recorded', 'claimed', 'dispatching', 'transport_accepted', 'session_observed')
               LIMIT 1`,
            ).get(existing.id) as { id: string; status: string } | undefined;
            if (liveAttempt !== undefined) {
              throw new Error(`native source binding refreshは未終端attemptを保持中のため拒否されました: ${liveAttempt.id}`);
            }
            const refresh = this.db.prepare(
              `UPDATE native_session_bindings
               SET observed_at = ?, expires_at = ?, updated_at = ?
               WHERE id = ? AND binding_key = ? AND status = 'active' AND expires_at > ?
                 AND observed_at = ? AND expires_at = ?`,
            ).run(
              evidence.observedAt,
              evidence.expiresAt,
              now,
              existing.id,
              bindingKey,
              now,
              existing.observed_at,
              existing.expires_at,
            );
            if (refresh.changes !== 1) {
              throw new Error("native source binding refresh CASに失敗しました");
            }
            this.insertTaskEvent(input.taskId, "native_source_binding_renewed", authorized.actorId, {
              bindingId: existing.id,
              bindingKey,
              previousObservedAt: existing.observed_at,
              observedAt: evidence.observedAt,
              previousExpiresAt: existing.expires_at,
              expiresAt: evidence.expiresAt,
              refresh: true,
            }, now, authorized);
            return this.getNativeSessionBinding(existing.id)!;
          }
          throw new Error("native source binding key がactive exact bindingと衝突しました");
        }

        // 期限切れ/released row を同じ id のまま更新する。古い binding id を
        // 参照する未終端 attempt が残っている場合は hash drift と配送の取り違えを
        // 起こすため、先に回収されるまで replacement を拒否する。
        const liveAttempt = this.db.prepare(
          `SELECT id, status FROM communication_delivery_attempts
           WHERE source_binding_id = ?
             AND status IN ('recorded', 'claimed', 'dispatching', 'transport_accepted', 'session_observed')
           LIMIT 1`,
        ).get(existing.id) as { id: string; status: string } | undefined;
        if (liveAttempt !== undefined) {
          throw new Error(`native source binding replacementは未終端attemptを保持中のため拒否されました: ${liveAttempt.id}`);
        }
        const info = this.db.prepare(
          `UPDATE native_session_bindings
           SET provider = ?, host_id = ?, provider_session_id = ?, native_address = ?,
               runtime_version = ?, capability_hash = ?, observed_at = ?, expires_at = ?,
               orchestrator_id = ?, orchestrator_session_id = ?, orchestrator_generation = ?,
               status = 'active', updated_at = ?, released_at = NULL
           WHERE id = ? AND binding_key = ?
             AND (status = 'released' OR (status = 'active' AND expires_at <= ?))`,
        ).run(
          input.provider,
          hostId,
          providerSessionId,
          nativeAddress,
          evidence.runtimeVersion,
          evidence.capabilityHash,
          evidence.observedAt,
          evidence.expiresAt,
          authorized.actorId,
          authorized.actorSessionId,
          authorized.actorGeneration,
          now,
          existing.id,
          bindingKey,
          now,
        );
        if (info.changes !== 1) {
          throw new Error("native source binding replacement CASに失敗しました");
        }
        this.insertTaskEvent(input.taskId, "native_source_binding_renewed", authorized.actorId, {
          bindingId: existing.id,
          bindingKey,
          previousProvider: existing.provider,
          provider: input.provider,
          previousProviderSessionId: existing.provider_session_id,
          providerSessionId,
          previousExpiresAt: existing.expires_at,
          expiresAt: evidence.expiresAt,
        }, now, authorized);
        return this.getNativeSessionBinding(existing.id)!;
      }

      const now = nowSeconds();
      const id = generateRuntimeId("nsb");
      this.db.prepare(
        `INSERT INTO native_session_bindings (
           id, binding_key, kind, provider, host_id, provider_session_id,
           native_address, runtime_version, capability_hash, observed_at, expires_at, task_id,
           orchestrator_id, orchestrator_session_id, orchestrator_generation, created_at, updated_at
         ) VALUES (?, ?, 'source', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        bindingKey,
        input.provider,
        hostId,
        providerSessionId,
        nativeAddress,
        evidence.runtimeVersion,
        evidence.capabilityHash,
        evidence.observedAt,
        evidence.expiresAt,
        input.taskId,
        authorized.actorId,
        authorized.actorSessionId,
        authorized.actorGeneration,
        now,
        now,
      );
      this.insertTaskEvent(input.taskId, "native_source_binding_recorded", authorized.actorId, {
        bindingId: id,
        provider: input.provider,
        hostId,
        providerSessionId,
        runtimeVersion: evidence.runtimeVersion,
        capabilityHash: evidence.capabilityHash,
        observedAt: evidence.observedAt,
        expiresAt: evidence.expiresAt,
      }, now, authorized);
      return this.getNativeSessionBinding(id)!;
    });
    return exec();
  }

  createOrGetNativeTargetBinding(
    input: CreateNativeTargetBindingInput,
    actor: string,
    provenance: ActorProvenance,
  ): NativeSessionBindingRow {
    acknowledgeActor(actor);
    const normalizedActor = redactText(actor.trim());
    const bindingKey = requireNonEmptyString(input.bindingKey, "native target binding key").trim();
    const hostId = requireNonEmptyString(input.hostId, "native target host ID").trim();
    const providerSessionId = requireNonEmptyString(
      input.providerSessionId,
      "native target provider session ID",
    ).trim();
    const nativeAddress = normalizeNativeAddress(input.nativeAddress, input.provider);
    const hachiSessionId = requireNonEmptyString(input.hachiSessionId, "native target Hachi session ID").trim();
    const evidence = normalizeNativeBindingEvidence(input);
    if (!Number.isInteger(input.expectedCancelFence) || input.expectedCancelFence < 0) {
      throw new Error("native target cancel fence は0以上の整数が必須です");
    }

    const exec = this.db.transaction((): NativeSessionBindingRow => {
      const authorized = this.authorizeNativeSupervisorService(provenance);
      if (normalizedActor !== NATIVE_SUPERVISOR_SERVICE_ACTOR) {
        throw new Error("native target binding actorは固定supervisor identityが必須です");
      }
      const run = this.db
        .prepare(`SELECT * FROM task_runs WHERE id = ?`)
        .get(input.runId) as RawRunRow | undefined;
      if (
        run === undefined || run.status !== "running" || run.task_id !== input.taskId ||
        run.session_id !== hachiSessionId || run.provider !== input.provider
      ) {
        throw new Error("native target binding がcurrent open run/session/providerと完全一致しません");
      }
      if (this.currentRunCancelFence(input.runId) !== input.expectedCancelFence) {
        throw new Error("native target binding のcancel fenceがcurrent runと一致しません");
      }
      let runRole: "worker" | "reviewer" = "worker";
      try {
        const meta = JSON.parse(run.meta) as unknown;
        if (typeof meta === "object" && meta !== null && (meta as Record<string, unknown>)["role"] === "reviewer") {
          runRole = "reviewer";
        }
      } catch {
        // legacy/破損metaはworkerとして扱うが、authorityはrun/session/fenceからのみ得る。
      }
      if (runRole !== input.targetRole) {
        throw new Error("native target binding のroleがrun metaと一致しません");
      }

      const existing = this.db
        .prepare(`SELECT * FROM native_session_bindings WHERE binding_key = ?`)
        .get(bindingKey) as RawNativeSessionBindingRow | undefined;
      if (existing !== undefined) {
        if (
          existing.kind !== "target" || existing.provider !== input.provider || existing.host_id !== hostId ||
          existing.provider_session_id !== providerSessionId || existing.task_id !== input.taskId ||
          existing.native_address !== nativeAddress ||
          existing.runtime_version !== evidence.runtimeVersion ||
          existing.capability_hash !== evidence.capabilityHash || existing.observed_at !== evidence.observedAt ||
          existing.expires_at !== evidence.expiresAt ||
          existing.run_id !== input.runId || existing.hachi_session_id !== hachiSessionId ||
          existing.target_role !== input.targetRole || existing.expected_cancel_fence !== input.expectedCancelFence
        ) {
          throw new Error("native target binding key が異なるexact bindingと衝突しました");
        }
        if (existing.status !== "active" || existing.expires_at <= nowSeconds()) {
          throw new Error("native target bindingはreleasedまたはexpiredです");
        }
        return mapNativeSessionBindingRow(existing);
      }

      const now = nowSeconds();
      const id = generateRuntimeId("nsb");
      this.db.prepare(
        `INSERT INTO native_session_bindings (
           id, binding_key, kind, provider, host_id, provider_session_id,
           native_address, runtime_version, capability_hash, observed_at, expires_at, task_id,
           run_id, hachi_session_id, target_role, expected_cancel_fence, created_at, updated_at
         ) VALUES (?, ?, 'target', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        bindingKey,
        input.provider,
        hostId,
        providerSessionId,
        nativeAddress,
        evidence.runtimeVersion,
        evidence.capabilityHash,
        evidence.observedAt,
        evidence.expiresAt,
        input.taskId,
        input.runId,
        hachiSessionId,
        input.targetRole,
        input.expectedCancelFence,
        now,
        now,
      );
      this.insertTaskEvent(input.taskId, "native_target_binding_recorded", normalizedActor, {
        bindingId: id,
        provider: input.provider,
        runtimeVersion: evidence.runtimeVersion,
        capabilityHash: evidence.capabilityHash,
        observedAt: evidence.observedAt,
        expiresAt: evidence.expiresAt,
        runId: input.runId,
        sessionId: hachiSessionId,
        cancelFence: input.expectedCancelFence,
        role: input.targetRole,
      }, now, authorized);
      return this.getNativeSessionBinding(id)!;
    });
    return exec();
  }

  getNativeSessionBinding(id: string): NativeSessionBindingRow | null {
    const row = this.db.prepare(`SELECT * FROM native_session_bindings WHERE id = ?`).get(id) as
      | RawNativeSessionBindingRow
      | undefined;
    return row === undefined ? null : mapNativeSessionBindingRow(row);
  }

  listNativeSessionBindings(taskId?: string): NativeSessionBindingRow[] {
    const rows = (taskId === undefined
      ? this.db.prepare(`SELECT * FROM native_session_bindings ORDER BY created_at, id`).all()
      : this.db
          .prepare(`SELECT * FROM native_session_bindings WHERE task_id = ? ORDER BY created_at, id`)
          .all(taskId)) as RawNativeSessionBindingRow[];
    return rows.map(mapNativeSessionBindingRow);
  }

  createOrGetCommunicationAttempt(input: CreateCommunicationAttemptInput): CommunicationDeliveryAttemptRow {
    acknowledgeActor(input.actor);
    const attemptKey = requireNonEmptyString(input.attemptKey, "communication attempt key").trim();
    const payload = input.payload === undefined ? "" : normalizeNativePayload(input.payload, undefined);
    if (input.intent !== undefined && input.intent !== "steer") {
      throw new Error("communication attempt intentが不正です");
    }
    const rawInput = input as CreateCommunicationAttemptInput & {
      sourceBindingId?: unknown;
      targetBindingId?: unknown;
    };
    if (rawInput.sourceBindingId !== undefined || rawInput.targetBindingId !== undefined) {
      throw new Error("v0.17 communication attemptはnative binding IDsを受理しません");
    }
    if (input.preference !== input.routing.preference) {
      throw new Error("communication preference がrouting inputと一致しません");
    }
    if (
      input.routing.capability !== "unknown" || input.routing.exactSourceBinding ||
      input.routing.exactTargetBinding || input.routing.sameHost
    ) {
      throw new Error("v0.17 communication attemptはunknown/no-binding/no-hostのrecord-only入力が必須です");
    }
    const route = input.decision.status === "deliver" ? input.decision.route : "";
    const nativeCandidate = input.decision.nativeCandidate ?? "";
    // v20 structured task steerはここで最終routeを選ばない。fresh probe前は
    // neutral Hachi routeのrecorded intentとして保持し、service promotionに委ねる。
    const structuredIntent = input.intent === "steer";
    const recordedRoute = structuredIntent ? "hachi" : route;
    const status = structuredIntent || input.decision.status === "deliver" ? "recorded" : "rejected";

    const exec = this.db.transaction((): CommunicationDeliveryAttemptRow => {
      const authorized = this.authorizeActorProvenance(input.provenance);
      if (authorized.kind !== "orchestrator") {
        throw new Error("communication attempt はactive exact orchestrator provenanceが必須です");
      }
      if (input.sourcePrincipal !== undefined) {
        const sourcePrincipal = this.authorizeActorProvenance(input.sourcePrincipal);
        if (
          sourcePrincipal.kind !== authorized.kind || sourcePrincipal.actorId !== authorized.actorId ||
          sourcePrincipal.actorSessionId !== authorized.actorSessionId ||
          sourcePrincipal.actorGeneration !== authorized.actorGeneration
        ) {
          throw new Error("communication attempt source principalがrecord actorと一致しません");
        }
      }
      const delivery = this.db
        .prepare(`SELECT * FROM steer_deliveries WHERE id = ?`)
        .get(input.steerDeliveryId) as RawSteerDeliveryRow | undefined;
      if (delivery === undefined) {
        throw new Error("communication attempt のsteer deliveryが見つかりません");
      }
      const task = this.requireTaskRaw(delivery.task_id);
      this.assertTaskPrimaryOrchestrator(task, authorized.actorId);
      const orchestratorSession = this.db
        .prepare(`SELECT * FROM orchestrator_sessions WHERE id = ?`)
        .get(authorized.actorSessionId) as RawOrchestratorSessionRow | undefined;
      const run = this.db.prepare(`SELECT * FROM task_runs WHERE id = ?`).get(delivery.run_id) as
        | RawRunRow
        | undefined;
      if (
        orchestratorSession === undefined || orchestratorSession.provider === "" ||
        run === undefined || run.provider !== input.routing.targetProvider ||
        orchestratorSession.provider !== input.routing.sourceProvider
      ) {
        throw new Error("communication routing provider がactive source/target providerと一致しません");
      }
      if (
        !structuredIntent && orchestratorSession.provider === run.provider &&
        (input.routing.rollout === "canary" || input.routing.rollout === "on")
      ) {
        throw new Error("v0.17 same-provider active rolloutはnative未実装のためrecordしません");
      }
      const recomputedDecision = resolveCommunicationRoute({
        ...input.routing,
        sourceProvider: orchestratorSession.provider,
        targetProvider: run.provider as Provider,
        capability: "unknown",
        exactSourceBinding: false,
        exactTargetBinding: false,
        sameHost: false,
      });
      if (
        recomputedDecision.status !== input.decision.status || recomputedDecision.route !== input.decision.route ||
        recomputedDecision.nativeCandidate !== input.decision.nativeCandidate ||
        recomputedDecision.reason !== input.decision.reason
      ) {
        throw new Error("communication route decision がStore再計算結果と一致しません");
      }
      if (!structuredIntent && recomputedDecision.status === "deliver" && recomputedDecision.route !== "hachi") {
        throw new Error("v0.17 communication control-planeはnative routeをclaimしません");
      }

      const existing = this.db
        .prepare(`SELECT * FROM communication_delivery_attempts WHERE attempt_key = ?`)
        .get(attemptKey) as RawCommunicationDeliveryAttemptRow | undefined;
      if (existing !== undefined) {
        if (
          existing.steer_delivery_id !== input.steerDeliveryId ||
          existing.source_binding_id !== null || existing.target_binding_id !== null ||
          existing.preference !== input.preference || existing.route !== recordedRoute ||
          existing.native_candidate !== nativeCandidate || existing.decision_reason !== input.decision.reason ||
          existing.payload !== payload ||
          existing.status !== status || existing.actor_kind !== authorized.kind ||
          existing.actor_id !== authorized.actorId || existing.actor_session_id !== authorized.actorSessionId ||
          existing.actor_generation !== authorized.actorGeneration
        ) {
          throw new Error("communication attempt key が異なるclaim入力と衝突しました");
        }
        return mapCommunicationDeliveryAttemptRow(existing);
      }
      if (delivery.status !== "queued") {
        throw new Error("communication route recordはqueued steer deliveryに対してのみ作成できます");
      }
      this.assertSteerCurrent(
        delivery,
        delivery.run_id,
        delivery.session_id,
        delivery.expected_cancel_fence,
      );

      const now = nowSeconds();
      const id = generateRuntimeId("cda");
      this.db.prepare(
        `INSERT INTO communication_delivery_attempts (
           id, attempt_key, steer_delivery_id, source_binding_id, target_binding_id,
           preference, route, native_candidate, decision_reason, status,
           payload,
           actor_kind, actor_id, actor_session_id, actor_generation,
           created_at, updated_at, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        attemptKey,
        delivery.id,
        null,
        null,
        input.preference,
        recordedRoute,
        nativeCandidate,
        input.decision.reason,
        status,
        payload,
        authorized.kind,
        authorized.actorId,
        authorized.actorSessionId,
        authorized.actorGeneration,
        now,
        now,
        now,
      );
      this.insertSteerEvent(
        delivery.task_id,
        status === "recorded" ? "communication_route_recorded" : "communication_route_refused",
        input.actor,
        delivery.id,
        delivery.run_id,
        delivery.session_id,
        delivery.expected_cancel_fence,
        {
          communicationAttemptId: id,
          sourceBindingId: null,
          targetBindingId: null,
          preference: input.preference,
          route: recordedRoute === "" ? null : recordedRoute,
          nativeCandidate: nativeCandidate === "" ? null : nativeCandidate,
          reason: input.decision.reason,
          payloadHash: payload === "" ? null : sha256Hex(payload),
        },
        now,
        authorized,
      );
      return this.getCommunicationAttempt(id)!;
    });
    return exec();
  }

  getCommunicationAttempt(id: string): CommunicationDeliveryAttemptRow | null {
    const row = this.db.prepare(`SELECT * FROM communication_delivery_attempts WHERE id = ?`).get(id) as
      | RawCommunicationDeliveryAttemptRow
      | undefined;
    return row === undefined ? null : mapCommunicationDeliveryAttemptRow(row);
  }

  listCommunicationAttempts(steerDeliveryId?: string): CommunicationDeliveryAttemptRow[] {
    const rows = (steerDeliveryId === undefined
      ? this.db.prepare(`SELECT * FROM communication_delivery_attempts ORDER BY created_at, id`).all()
      : this.db
          .prepare(`SELECT * FROM communication_delivery_attempts WHERE steer_delivery_id = ? ORDER BY created_at, id`)
          .all(steerDeliveryId)) as RawCommunicationDeliveryAttemptRow[];
    return rows.map(mapCommunicationDeliveryAttemptRow);
  }

  /**
   * claimed-before-begin の lease 回収後に Supervisor が再評価する候補を返す。
   * recorded はまだ外部I/Oを開始していないため再claim可能だが、route/bindingの
   * freshnessやconfig driftはここで判断せず、通常のpromotion/claim CASへ委ねる。
   */
  listNativeCommunicationRedriveCandidates(): CommunicationDeliveryAttemptRow[] {
    const rows = this.db.prepare(
      `SELECT a.*
       FROM communication_delivery_attempts a
       JOIN steer_deliveries d ON d.id = a.steer_delivery_id
       WHERE a.status = 'recorded'
         AND a.route IN ('claude-cross-session', 'codex-app-server')
         AND a.source_binding_id IS NOT NULL
         AND a.target_binding_id IS NOT NULL
         AND d.status = 'queued'
       ORDER BY a.created_at, a.id`,
    ).all() as RawCommunicationDeliveryAttemptRow[];
    return rows.map(mapCommunicationDeliveryAttemptRow);
  }

  /**
   * 外部I/Oをまだ開始していない recorded attempt の target snapshot だけを
   * fresh probe の結果へ付け替える。claim/dispatch後の行は、配送先を変更して
   * 二重配送を隠すことになるため、状態を進めず fail-closed にする。
   */
  rebindRecordedNativeCommunicationAttempt(
    input: RebindRecordedNativeCommunicationAttemptInput,
  ): CommunicationDeliveryAttemptRow {
    const attemptId = requireNonEmptyString(input.attemptId, "native communication attempt ID").trim();
    const taskId = requireNonEmptyString(input.taskId, "native communication task ID").trim();
    const sessionId = requireNonEmptyString(input.sessionId, "native communication session ID").trim();
    const targetBindingId = requireNonEmptyString(input.targetBindingId, "native target binding ID").trim();
    const targetBindingHash = normalizeNativeHash(input.targetBindingHash, "native target binding hash");
    if (!Number.isInteger(input.runId) || input.runId <= 0) {
      throw new Error("native communication run IDは正の整数が必須です");
    }
    if (!Number.isInteger(input.expectedCancelFence) || input.expectedCancelFence < 0) {
      throw new Error("native communication cancel fenceは0以上の整数が必須です");
    }
    const rebindNow = input.now ?? nowSeconds();
    if (!Number.isInteger(rebindNow) || rebindNow <= 0) {
      throw new Error("native communication rebind nowは正のepoch秒が必須です");
    }
    const suppliedActor = input.actor === undefined ? "" : redactText(input.actor.trim());
    if (input.actor !== undefined && suppliedActor === "") {
      throw new Error("native communication rebind actorは空にできません");
    }
    const actor = suppliedActor === "" ? NATIVE_SUPERVISOR_SERVICE_ACTOR : suppliedActor;
    if (actor !== NATIVE_SUPERVISOR_SERVICE_ACTOR) {
      throw new Error("native communication rebind actorは固定supervisor identityが必須です");
    }

    const exec = this.db.transaction((): CommunicationDeliveryAttemptRow => {
      const authorized = this.authorizeNativeSupervisorService(input.provenance);
      const raw = this.db
        .prepare(`SELECT * FROM communication_delivery_attempts WHERE id = ?`)
        .get(attemptId) as RawCommunicationDeliveryAttemptRow | undefined;
      if (raw === undefined) {
        throw new Error("native communication attemptが見つかりません");
      }
      if (raw.status !== "recorded") {
        throw new Error("native communication rebindはrecorded attemptに対してのみ可能です");
      }
      if (raw.route !== "codex-app-server" && raw.route !== "claude-cross-session") {
        throw new Error("native communication rebindはnative routeに対してのみ可能です");
      }
      if (raw.source_binding_id === null || raw.target_binding_id === null || raw.target_binding_hash === "") {
        throw new Error("native communication rebindのsource/target snapshotがありません");
      }

      const delivery = this.db
        .prepare(`SELECT * FROM steer_deliveries WHERE id = ?`)
        .get(raw.steer_delivery_id) as RawSteerDeliveryRow | undefined;
      if (delivery === undefined) {
        throw new Error("native communication rebindのsteer deliveryが見つかりません");
      }
      if (delivery.status !== "queued") {
        throw new Error("native communication rebindはqueued steer deliveryに対してのみ可能です");
      }
      if (delivery.task_id !== taskId) {
        throw new Error("native communication rebindのtaskが一致しません");
      }
      this.assertNativeDeliveryTarget(delivery, input.runId, sessionId, input.expectedCancelFence);

      const source = this.db
        .prepare(`SELECT * FROM native_session_bindings WHERE id = ?`)
        .get(raw.source_binding_id) as RawNativeSessionBindingRow | undefined;
      const target = this.db
        .prepare(`SELECT * FROM native_session_bindings WHERE id = ?`)
        .get(targetBindingId) as RawNativeSessionBindingRow | undefined;
      const previousTarget = this.db
        .prepare(`SELECT * FROM native_session_bindings WHERE id = ?`)
        .get(raw.target_binding_id) as RawNativeSessionBindingRow | undefined;
      if (source === undefined || target === undefined || previousTarget === undefined) {
        throw new Error("native communication rebindのbinding rowが見つかりません");
      }
      const sourceRow = mapNativeSessionBindingRow(source);
      const targetRow = mapNativeSessionBindingRow(target);
      const previousTargetRow = mapNativeSessionBindingRow(previousTarget);
      if (previousTargetRow.kind !== "target" || nativeSessionBindingHash(previousTargetRow) !== raw.target_binding_hash) {
        throw new Error("native communication rebindのprevious target binding snapshot hashがdriftしました");
      }
      const sourcePrincipal: ActorProvenance = {
        kind: "orchestrator",
        actorId: source.orchestrator_id,
        actorSessionId: source.orchestrator_session_id,
        actorGeneration: source.orchestrator_generation,
      };
      const sourceAuthorized = this.authorizeFreshOrchestratorPrincipal(sourcePrincipal);
      this.assertNativeBindingPair(sourceRow, targetRow, delivery, sourceAuthorized, rebindNow);
      if (nativeSessionBindingHash(sourceRow) !== raw.source_binding_hash) {
        throw new Error("native communication rebindのsource binding snapshot hashがdriftしました");
      }
      if (nativeCapabilitySnapshotHash(source.capability_hash, target.capability_hash) !== raw.capability_hash) {
        throw new Error("native communication rebindのcapability snapshotがdriftしました");
      }
      if (raw.route !== nativeRouteForProvider(targetRow.provider)) {
        throw new Error("native communication rebindのprovider/routeが一致しません");
      }
      if (nativeSessionBindingHash(targetRow) !== targetBindingHash) {
        throw new Error("native communication rebindのtarget binding hashが一致しません");
      }

      // 同じ fresh target への再実行は監査イベントを増やさない idempotent read。
      if (raw.target_binding_id === targetBindingId && raw.target_binding_hash === targetBindingHash) {
        return mapCommunicationDeliveryAttemptRow(raw);
      }

      const info = this.db.prepare(
        `UPDATE communication_delivery_attempts
         SET target_binding_id = ?, target_binding_hash = ?, updated_at = ?
         WHERE id = ? AND steer_delivery_id = ? AND status = 'recorded'
           AND target_binding_id = ? AND target_binding_hash = ?`,
      ).run(
        targetBindingId,
        targetBindingHash,
        rebindNow,
        attemptId,
        delivery.id,
        raw.target_binding_id,
        raw.target_binding_hash,
      );
      if (info.changes !== 1) {
        throw new Error("native communication rebind CASに失敗しました");
      }
      this.insertSteerEvent(
        delivery.task_id,
        "communication_native_attempt_rebound",
        actor,
        delivery.id,
        delivery.run_id,
        delivery.session_id,
        delivery.expected_cancel_fence,
        {
          communicationAttemptId: attemptId,
          previousTargetBindingId: raw.target_binding_id,
          targetBindingId,
          previousTargetBindingHash: raw.target_binding_hash,
          targetBindingHash,
        },
        rebindNow,
        authorized,
      );
      return this.getCommunicationAttempt(attemptId)!;
    });
    return exec();
  }

  /**
   * v0.17/v0.18でrecord済みのneutral intentを、同じattempt行のままnativeへ昇格する。
   * supervisorのfresh probe結果をservice provenanceで受け、queued steerに対するCASを一度だけ行う。
   */
  promoteCommunicationAttemptToNative(
    input: PromoteCommunicationAttemptToNativeInput,
  ): CommunicationDeliveryAttemptRow {
    const attemptId = requireNonEmptyString(input.attemptId, "communication attempt ID").trim();
    const sourceBindingId = requireNonEmptyString(input.sourceBindingId, "native source binding ID").trim();
    const targetBindingId = requireNonEmptyString(input.targetBindingId, "native target binding ID").trim();
    const configHash = normalizeNativeHash(input.configHash, "native config hash");
    const configSnapshot = normalizeNativeConfigSnapshot(input.configSnapshot);
    const capabilityHash = normalizeNativeHash(input.capabilityHash, "native capability hash");
    const nativeCandidate = input.nativeCandidate ?? input.route;
    if (nativeCandidate !== input.route) {
      throw new Error("native candidateとrouteが一致しません");
    }
    const decisionReason = requireNonEmptyString(
      input.decisionReason ?? input.decision?.reason ?? "native-selected",
      "native communication decision reason",
    ).trim();
    const actor = redactText((input.actor ?? NATIVE_SUPERVISOR_SERVICE_ACTOR).trim());
    if (actor === "") throw new Error("native communication actorは空にできません");
    if (actor !== NATIVE_SUPERVISOR_SERVICE_ACTOR) {
      throw new Error("native communication promotion actorは固定supervisor identityが必須です");
    }

    const exec = this.db.transaction((): CommunicationDeliveryAttemptRow => {
      const authorized = this.authorizeNativeSupervisorService(input.provenance);
      const raw = this.db
        .prepare(`SELECT * FROM communication_delivery_attempts WHERE id = ?`)
        .get(attemptId) as RawCommunicationDeliveryAttemptRow | undefined;
      if (raw === undefined) throw new Error("communication attemptが見つかりません");

      // 既に同じnative値へ昇格済みならidempotent readを返す。異なる再昇格は拒否する。
      if (raw.source_binding_id !== null || raw.target_binding_id !== null || raw.route !== "hachi") {
        if (
          raw.status === "recorded" && raw.source_binding_id === sourceBindingId &&
          raw.target_binding_id === targetBindingId && raw.route === input.route &&
          raw.native_candidate === nativeCandidate && raw.config_hash === configHash &&
          raw.config_rollout === configSnapshot.rollout &&
          raw.config_minimum_runtime_version === configSnapshot.minimumRuntimeVersion &&
          raw.config_same_host_only === 1 && raw.config_canary_percent === configSnapshot.canaryPercent &&
          raw.capability_hash === capabilityHash &&
          (input.sourceBindingHash === undefined || raw.source_binding_hash === input.sourceBindingHash) &&
          (input.targetBindingHash === undefined || raw.target_binding_hash === input.targetBindingHash)
        ) {
          return mapCommunicationDeliveryAttemptRow(raw);
        }
        throw new Error("communication attemptはneutral recorded stateではありません");
      }
      if (raw.status !== "recorded") {
        throw new Error("communication attempt promotionはrecorded stateに対してのみ可能です");
      }
      if (raw.payload === "") {
        throw new Error("native communication promotionにはredacted payloadが必須です");
      }
      if (raw.preference === "hachi") {
        throw new Error("hachi preferenceのcommunication attemptはnativeへ昇格できません");
      }
      if (raw.native_candidate !== "" && raw.native_candidate !== input.route) {
        throw new Error("neutral native candidateとpromotion routeが一致しません");
      }

      const delivery = this.db
        .prepare(`SELECT * FROM steer_deliveries WHERE id = ?`)
        .get(raw.steer_delivery_id) as RawSteerDeliveryRow | undefined;
      if (delivery === undefined) throw new Error("communication attemptのsteer deliveryが見つかりません");
      if (delivery.status !== "queued") {
        throw new Error("native communication promotionはqueued steer deliveryに対してのみ可能です");
      }
      this.assertNativeDeliveryTarget(delivery, delivery.run_id, delivery.session_id, delivery.expected_cancel_fence);

      const source = this.db
        .prepare(`SELECT * FROM native_session_bindings WHERE id = ?`)
        .get(sourceBindingId) as RawNativeSessionBindingRow | undefined;
      const target = this.db
        .prepare(`SELECT * FROM native_session_bindings WHERE id = ?`)
        .get(targetBindingId) as RawNativeSessionBindingRow | undefined;
      if (source === undefined || target === undefined) {
        throw new Error("native communication promotionのsource/target bindingが見つかりません");
      }
      const sourceRow = mapNativeSessionBindingRow(source);
      const targetRow = mapNativeSessionBindingRow(target);
      const sourceHash = nativeSessionBindingHash(sourceRow);
      const targetHash = nativeSessionBindingHash(targetRow);
      if (input.sourceBindingHash !== undefined && input.sourceBindingHash !== sourceHash) {
        throw new Error("native source binding hashが一致しません");
      }
      if (input.targetBindingHash !== undefined && input.targetBindingHash !== targetHash) {
        throw new Error("native target binding hashが一致しません");
      }
      const now = nowSeconds();
      const sourcePrincipal: ActorProvenance = {
        kind: "orchestrator",
        actorId: sourceRow.orchestratorId,
        actorSessionId: sourceRow.orchestratorSessionId,
        actorGeneration: sourceRow.orchestratorGeneration,
      };
      this.assertTaskPrimaryOrchestrator(this.requireTaskRaw(delivery.task_id), sourceRow.orchestratorId);
      const freshSourcePrincipal = this.authorizeFreshOrchestratorPrincipal(sourcePrincipal);
      this.assertNativeBindingPair(sourceRow, targetRow, delivery, freshSourcePrincipal, now);
      const run = this.db.prepare(`SELECT provider FROM task_runs WHERE id = ?`).get(delivery.run_id) as
        | { provider: string }
        | undefined;
      if (run === undefined || run.provider !== targetRow.provider || sourceRow.provider !== targetRow.provider ||
          input.route !== nativeRouteForProvider(targetRow.provider)) {
        throw new Error("native communication promotionのprovider/routeがbindingと一致しません");
      }
      const expectedCapabilityHash = nativeCapabilitySnapshotHash(sourceRow.capabilityHash, targetRow.capabilityHash);
      if (capabilityHash !== expectedCapabilityHash) {
        throw new Error("native communication promotion capability hashがfresh bindingと一致しません");
      }
      if (input.decision !== undefined && (
        input.decision.status !== "deliver" || input.decision.route !== input.route ||
        input.decision.nativeCandidate !== input.route
      )) {
        throw new Error("native communication promotion route decisionがnative routeと一致しません");
      }
      if (input.routing !== undefined && (
        input.routing.sourceProvider !== sourceRow.provider || input.routing.targetProvider !== targetRow.provider ||
        input.routing.rollout !== configSnapshot.rollout || input.routing.preference !== raw.preference ||
        input.routing.capability !== "supported" || !input.routing.exactSourceBinding ||
        !input.routing.exactTargetBinding || !input.routing.sameHost
      )) {
        throw new Error("native communication promotion routingはfresh exact binding入力が必須です");
      }
      if (input.routing !== undefined && configSnapshot.rollout === "canary") {
        if (configSnapshot.canaryPercent === null) {
          throw new Error("native communication promotionのstored canaryPercentがありません");
        }
        const eligible = isCommunicationCanaryEligible(
          delivery.task_id,
          communicationCanaryCohortKey(targetRow.provider),
          configSnapshot.canaryPercent,
        );
        if (input.routing.canaryEligible !== eligible) {
          throw new Error("native communication promotion canary選出結果がstored configと一致しません");
        }
      }

      const info = this.db.prepare(
        `UPDATE communication_delivery_attempts
         SET source_binding_id = ?, target_binding_id = ?, route = ?, native_candidate = ?, decision_reason = ?,
             config_hash = ?, config_rollout = ?, config_minimum_runtime_version = ?, config_same_host_only = ?,
             config_canary_percent = ?, capability_hash = ?, source_binding_hash = ?, target_binding_hash = ?, updated_at = ?
         WHERE id = ? AND status = 'recorded' AND source_binding_id IS NULL AND target_binding_id IS NULL AND route = 'hachi'`,
      ).run(
        sourceBindingId,
        targetBindingId,
        input.route,
        nativeCandidate,
        decisionReason,
        configHash,
        configSnapshot.rollout,
        configSnapshot.minimumRuntimeVersion,
        1,
        configSnapshot.canaryPercent,
        expectedCapabilityHash,
        sourceHash,
        targetHash,
        now,
        attemptId,
      );
      if (info.changes !== 1) {
        throw new Error("communication native promotion CASに失敗しました");
      }
      this.insertSteerEvent(
        delivery.task_id,
        "communication_native_attempt_promoted",
        actor,
        delivery.id,
        delivery.run_id,
        delivery.session_id,
        delivery.expected_cancel_fence,
        {
          communicationAttemptId: attemptId,
          sourceBindingId,
          targetBindingId,
          sourceBindingHash: sourceHash,
          targetBindingHash: targetHash,
          configHash,
          capabilityHash: expectedCapabilityHash,
          route: input.route,
          payloadHash: sha256Hex(raw.payload),
        },
        now,
        authorized,
      );
      return this.getCommunicationAttempt(attemptId)!;
    });
    return exec();
  }

  claimNativeCommunicationAttempt(input: ClaimNativeCommunicationAttemptInput): CommunicationDeliveryAttemptRow {
    const attemptId = requireNonEmptyString(input.attemptId, "native communication attempt ID").trim();
    const configHash = normalizeNativeHash(input.configHash, "native config hash");
    const capabilityHash = normalizeNativeHash(input.capabilityHash, "native capability hash");
    if (input.rollout !== "canary" && input.rollout !== "on") {
      throw new Error("native communication claimはcanary/on rolloutでのみ許可されます");
    }
    const minimumRuntimeVersion = input.minimumRuntimeVersion === undefined
      ? ""
      : requireNonEmptyString(input.minimumRuntimeVersion, "native minimum runtime version").trim();
    if (minimumRuntimeVersion !== "" && !STRICT_SEMVER.test(minimumRuntimeVersion)) {
      throw new Error("native minimum runtime versionはstrict semverが必須です");
    }
    if (minimumRuntimeVersion === "") {
      throw new Error("native communication claimはminimum runtime versionが必須です");
    }
    if (input.sameHostOnly !== true) {
      throw new Error("native communication claimはsame-host制約が必須です");
    }
    if (input.rollout === "canary" && input.canaryPercent === undefined) {
      throw new Error("native communication claimはcanaryPercentが必須です");
    }
    const leaseSeconds = requireNativeLeaseSeconds(input.leaseSeconds);
    const claimNow = input.now ?? nowSeconds();
    if (!Number.isInteger(claimNow) || claimNow <= 0) {
      throw new Error("native communication claim nowは正のepoch秒が必須です");
    }
    const suppliedActor = input.actor === undefined ? "" : redactText(input.actor.trim());
    if (input.actor !== undefined && suppliedActor === "") {
      throw new Error("native communication claim actorは空にできません");
    }

    const exec = this.db.transaction((): CommunicationDeliveryAttemptRow => {
      const raw = this.db
        .prepare(`SELECT * FROM communication_delivery_attempts WHERE id = ?`)
        .get(attemptId) as RawCommunicationDeliveryAttemptRow | undefined;
      if (raw === undefined) {
        throw new Error("native communication attemptが見つかりません");
      }
      if (raw.status !== "recorded" && !(raw.status === "claimed" && (raw.claim_lease_until ?? 0) <= claimNow)) {
        throw new Error("native communication attemptはclaim可能なrecorded/expired claimedではありません");
      }
      if (raw.config_hash !== configHash || raw.capability_hash !== capabilityHash) {
        throw new Error("native communication claimのconfig/capability hashがattemptと一致しません");
      }
      if (
        raw.config_rollout !== input.rollout ||
        raw.config_minimum_runtime_version !== minimumRuntimeVersion ||
        raw.config_same_host_only !== 1 ||
        (raw.config_rollout === "canary" && raw.config_canary_percent !== input.canaryPercent)
      ) {
        throw new Error("native communication claimのrollout/config assertionがstored snapshotと一致しません");
      }
      const trustedRollout = raw.config_rollout;
      const trustedMinimumRuntimeVersion = raw.config_minimum_runtime_version;
      const trustedCanaryPercent = raw.config_canary_percent;
      if (trustedRollout !== "canary" && trustedRollout !== "on") {
        throw new Error("native communication claimのstored config rolloutがnativeではありません");
      }
      const caller = this.authorizeActorProvenance(input.provenance);
      if (raw.source_binding_id === null) {
        throw new Error("native communication claimのsource bindingがありません");
      }
      const source = this.db
        .prepare(`SELECT * FROM native_session_bindings WHERE id = ?`)
        .get(raw.source_binding_id) as RawNativeSessionBindingRow | undefined;
      if (source === undefined || source.orchestrator_generation === null) {
        throw new Error("native communication claimのsource principalがありません");
      }
      const sourcePrincipal: ActorProvenance = {
        kind: "orchestrator",
        actorId: source.orchestrator_id,
        actorSessionId: source.orchestrator_session_id,
        actorGeneration: source.orchestrator_generation,
      };
      const sourceAuthorized = this.authorizeFreshOrchestratorPrincipal(sourcePrincipal);
      const claimant = raw.route === "codex-app-server"
        ? this.authorizeNativeSupervisorService(caller)
        : sourceAuthorized;
      const actor = suppliedActor === ""
        ? (raw.route === "codex-app-server" ? NATIVE_SUPERVISOR_SERVICE_ACTOR : "orchestrator")
        : suppliedActor;
      if (raw.route === "codex-app-server" && actor !== NATIVE_SUPERVISOR_SERVICE_ACTOR) {
        throw new Error("native communication claim actorは固定supervisor identityが必須です");
      }
      if (raw.route !== "codex-app-server" && (
        caller.kind !== "orchestrator" || caller.actorId !== sourceAuthorized.actorId ||
        caller.actorSessionId !== sourceAuthorized.actorSessionId || caller.actorGeneration !== sourceAuthorized.actorGeneration
      )) {
        throw new Error("Claude native claimはsource orchestrator provenanceが必須です");
      }
      const context = this.assertNativeAttemptAuthority(raw, sourceAuthorized, claimNow, trustedMinimumRuntimeVersion);
      if (nativeCapabilitySnapshotHash(context.source.capability_hash, context.target.capability_hash) !== capabilityHash) {
        throw new Error("native communication claim capability hashがfresh bindingと一致しません");
      }
      if (trustedRollout === "canary") {
        if (trustedCanaryPercent === null) {
          throw new Error("native communication claimのstored canaryPercentがありません");
        }
        const eligible = isCommunicationCanaryEligible(
          context.delivery.task_id,
          communicationCanaryCohortKey(context.target.provider as Provider),
          trustedCanaryPercent,
        );
        if (input.canaryEligible !== undefined && input.canaryEligible !== eligible) {
          throw new Error("native communication canary選出結果がtrusted計算と一致しません");
        }
        if (!eligible) {
          throw new Error("native communication claimはcanary非選出です");
        }
      }
      if (compareStrictSemver(context.source.runtime_version, trustedMinimumRuntimeVersion) < 0 ||
          compareStrictSemver(context.target.runtime_version, trustedMinimumRuntimeVersion) < 0) {
        throw new Error("native communication runtime versionがminimum未満です");
      }

      const attemptNonce = randomBytes(32).toString("hex");
      const info = this.db.prepare(
        `UPDATE communication_delivery_attempts
         SET status = 'claimed', claimant_orchestrator_id = ?, claimant_session_id = ?, claimant_generation = ?,
             claim_lease_until = ?, attempt_nonce_hash = ?, updated_at = ?
         WHERE id = ? AND status IN ('recorded', 'claimed')
           AND (status = 'recorded' OR claim_lease_until <= ?)`
      ).run(
        claimant.actorId,
        claimant.actorSessionId,
        claimant.actorGeneration,
        claimNow + leaseSeconds,
        sha256Hex(attemptNonce),
        claimNow,
        attemptId,
        claimNow,
      );
      if (info.changes !== 1) {
        throw new Error("native communication claim CASに失敗しました");
      }
      this.insertSteerEvent(
        context.delivery.task_id,
        "communication_native_attempt_claimed",
        actor,
        context.delivery.id,
        context.delivery.run_id,
        context.delivery.session_id,
        context.delivery.expected_cancel_fence,
        { communicationAttemptId: attemptId, leaseUntil: claimNow + leaseSeconds },
        claimNow,
        caller,
      );
      const result = this.getCommunicationAttempt(attemptId)!;
      return { ...result, attemptNonce };
    });
    return exec();
  }

  beginNativeCommunicationDispatch(
    input: BeginNativeCommunicationDispatchInput,
  ): CommunicationDeliveryAttemptRow {
    const attemptId = requireNonEmptyString(input.attemptId, "native communication attempt ID").trim();
    const attemptNonce = requireNonEmptyString(input.attemptNonce, "native communication attempt nonce").trim();
    const beginNow = input.now ?? nowSeconds();
    if (!Number.isInteger(beginNow) || beginNow <= 0) {
      throw new Error("native communication begin nowは正のepoch秒が必須です");
    }
    const suppliedActor = input.actor === undefined ? "" : redactText(input.actor.trim());
    if (input.actor !== undefined && suppliedActor === "") {
      throw new Error("native communication begin actorは空にできません");
    }
    const exec = this.db.transaction((): CommunicationDeliveryAttemptRow => {
      const raw = this.db
        .prepare(`SELECT * FROM communication_delivery_attempts WHERE id = ?`)
        .get(attemptId) as RawCommunicationDeliveryAttemptRow | undefined;
      if (raw === undefined || raw.status !== "claimed") {
        throw new Error("native communication beginはclaimed attemptに対してのみ可能です");
      }
      if (raw.attempt_nonce_hash !== sha256Hex(attemptNonce)) {
        throw new Error("native communication begin nonceが一致しません");
      }
      if ((raw.claim_lease_until ?? 0) <= beginNow) {
        throw new Error("native communication claim leaseが期限切れです");
      }
      const caller = this.authorizeActorProvenance(input.provenance);
      if (raw.source_binding_id === null) {
        throw new Error("native communication beginのsource bindingがありません");
      }
      const source = this.db
        .prepare(`SELECT * FROM native_session_bindings WHERE id = ?`)
        .get(raw.source_binding_id) as RawNativeSessionBindingRow | undefined;
      if (source === undefined || source.orchestrator_generation === null) {
        throw new Error("native communication beginのsource principalがありません");
      }
      const sourcePrincipal: ActorProvenance = {
        kind: "orchestrator",
        actorId: source.orchestrator_id,
        actorSessionId: source.orchestrator_session_id,
        actorGeneration: source.orchestrator_generation,
      };
      const sourceAuthorized = this.authorizeFreshOrchestratorPrincipal(sourcePrincipal);
      const actor = suppliedActor === ""
        ? (raw.route === "codex-app-server" ? NATIVE_SUPERVISOR_SERVICE_ACTOR : "orchestrator")
        : suppliedActor;
      if (raw.route === "codex-app-server") {
        const supervisor = this.authorizeNativeSupervisorService(caller);
        if (actor !== NATIVE_SUPERVISOR_SERVICE_ACTOR) {
          throw new Error("native communication begin actorは固定supervisor identityが必須です");
        }
        if (raw.claimant_orchestrator_id !== supervisor.actorId ||
            raw.claimant_session_id !== "" || raw.claimant_generation !== null) {
          throw new Error("Codex native beginはclaim service provenanceと一致しません");
        }
      } else if (
        caller.kind !== "orchestrator" || caller.actorId !== sourceAuthorized.actorId ||
        caller.actorSessionId !== sourceAuthorized.actorSessionId || caller.actorGeneration !== sourceAuthorized.actorGeneration ||
        raw.claimant_orchestrator_id !== caller.actorId || raw.claimant_session_id !== caller.actorSessionId ||
        raw.claimant_generation !== caller.actorGeneration
      ) {
        throw new Error("Claude native beginはclaim source orchestrator provenanceと一致しません");
      }
      const context = this.assertNativeAttemptAuthority(raw, sourceAuthorized, beginNow, "");
      const steerInfo = this.db.prepare(
        `UPDATE steer_deliveries SET status = 'dispatching', updated_at = ?
         WHERE id = ? AND status = 'queued' AND run_id = ? AND session_id = ? AND expected_cancel_fence = ?`,
      ).run(
        beginNow,
        context.delivery.id,
        context.delivery.run_id,
        context.delivery.session_id,
        context.delivery.expected_cancel_fence,
      );
      if (steerInfo.changes !== 1) {
        throw new Error("native communication beginとsteer dispatchingのatomic CASに失敗しました");
      }
      const attemptInfo = this.db.prepare(
        `UPDATE communication_delivery_attempts SET status = 'dispatching', dispatching_at = ?, updated_at = ?
         WHERE id = ? AND status = 'claimed' AND attempt_nonce_hash = ? AND claim_lease_until > ?`,
      ).run(beginNow, beginNow, attemptId, sha256Hex(attemptNonce), beginNow);
      if (attemptInfo.changes !== 1) {
        throw new Error("native communication attempt dispatching CASに失敗しました");
      }
      this.insertSteerEvent(
        context.delivery.task_id,
        "communication_native_attempt_dispatching",
        actor,
        context.delivery.id,
        context.delivery.run_id,
        context.delivery.session_id,
        context.delivery.expected_cancel_fence,
        { communicationAttemptId: attemptId },
        beginNow,
        caller,
      );
      return this.getCommunicationAttempt(attemptId)!;
    });
    return exec();
  }

  recordNativeCommunicationReceipt(
    input: RecordNativeCommunicationReceiptInput,
  ): CommunicationDeliveryAttemptRow {
    const attemptId = requireNonEmptyString(input.attemptId, "native communication attempt ID").trim();
    const attemptNonce = requireNonEmptyString(input.attemptNonce, "native communication attempt nonce").trim();
    const receiptId = input.receiptId === undefined ? "" : redactText(input.receiptId.trim());
    let observedMessageId = input.observedMessageId === undefined ? "" : redactText(input.observedMessageId.trim());
    if (["transport_accepted", "session_observed", "acknowledged"].includes(input.outcome) && receiptId === "") {
      throw new Error("native communication receipt IDは受理/観測/ackに必須です");
    }
    const receiptNow = input.now ?? nowSeconds();
    if (!Number.isInteger(receiptNow) || receiptNow <= 0) {
      throw new Error("native communication receipt nowは正のepoch秒が必須です");
    }
    const actor = redactText((input.actor ?? NATIVE_SUPERVISOR_SERVICE_ACTOR).trim());
    const exec = this.db.transaction((): CommunicationDeliveryAttemptRow => {
      const raw = this.db
        .prepare(`SELECT * FROM communication_delivery_attempts WHERE id = ?`)
        .get(attemptId) as RawCommunicationDeliveryAttemptRow | undefined;
      if (raw === undefined) {
        throw new Error("native communication attemptが見つかりません");
      }
      if (raw.attempt_nonce_hash !== sha256Hex(attemptNonce)) {
        throw new Error("native communication receipt nonceが一致しません");
      }
      if (raw.status === "claimed" && (raw.claim_lease_until ?? 0) <= receiptNow) {
        throw new Error("native communication claim leaseが期限切れです");
      }
      const authorized = this.authorizeActorProvenance(input.provenance);
      const source = raw.source_binding_id === null ? undefined : this.db
        .prepare(`SELECT * FROM native_session_bindings WHERE id = ?`)
        .get(raw.source_binding_id) as RawNativeSessionBindingRow | undefined;
      const serviceAuthorized = authorized.kind === "service"
        ? this.authorizeNativeSupervisorService(authorized)
        : null;
      if (serviceAuthorized !== null && actor !== NATIVE_SUPERVISOR_SERVICE_ACTOR) {
        throw new Error("native communication receipt actorは固定supervisor identityが必須です");
      }
      const claimantMatches = serviceAuthorized !== null
        ? raw.claimant_orchestrator_id === serviceAuthorized.actorId && raw.claimant_session_id === "" && raw.claimant_generation === null
        : raw.claimant_orchestrator_id === authorized.actorId && raw.claimant_session_id === authorized.actorSessionId &&
          raw.claimant_generation === authorized.actorGeneration;
      const sourceMatches = authorized.kind === "orchestrator" && source !== undefined &&
        source.orchestrator_id === authorized.actorId && source.orchestrator_session_id === authorized.actorSessionId &&
        source.orchestrator_generation === authorized.actorGeneration;
      if (!claimantMatches && !sourceMatches) {
        throw new Error("native communication receipt provenanceがclaim/source principalと一致しません");
      }
      const allowed: Readonly<Record<string, readonly string[]>> = {
        claimed: ["rejected"],
        dispatching: ["transport_accepted", "session_observed", "acknowledged", "rejected", "uncertain"],
        transport_accepted: ["session_observed", "acknowledged", "uncertain"],
        session_observed: ["acknowledged", "uncertain"],
      };
      const nextAllowed = allowed[raw.status] ?? [];
      if (!nextAllowed.includes(input.outcome)) {
        if (raw.status === input.outcome && raw.receipt_id === receiptId) {
          return this.getCommunicationAttempt(attemptId)!;
        }
        throw new Error("native communication receipt lifecycle CASに失敗しました");
      }
      const delivery = this.db
        .prepare(`SELECT * FROM steer_deliveries WHERE id = ?`)
        .get(raw.steer_delivery_id) as RawSteerDeliveryRow | undefined;
      if (delivery === undefined) {
        throw new Error("native communication receiptのsteer deliveryが見つかりません");
      }
      if (["session_observed", "acknowledged"].includes(input.outcome) && observedMessageId === "") {
        // Adapter resultはdelivery keyに束縛されたobserved/ack outcomeとして返るため、
        // omitted IDはdurable message keyへ正規化する（任意の本文や表示名は受理しない）。
        observedMessageId = delivery.message_key;
      }
      if (["session_observed", "acknowledged"].includes(input.outcome) && observedMessageId === "") {
        throw new Error("native communication observed message IDは観測/ackに必須です");
      }
      const status = input.outcome;
      const observed = input.outcome === "session_observed" || input.outcome === "acknowledged";
      const terminal = input.outcome === "acknowledged" || input.outcome === "rejected" || input.outcome === "uncertain";
      const error = input.detail === undefined ? "" : redactText(input.detail);
      const info = this.db.prepare(
        `UPDATE communication_delivery_attempts
         SET status = ?, receipt_id = ?, last_error = ?, observed_at = CASE WHEN ? THEN COALESCE(observed_at, ?) ELSE observed_at END,
             acknowledged_at = CASE WHEN ? THEN COALESCE(acknowledged_at, ?) ELSE acknowledged_at END,
             resolved_at = CASE WHEN ? THEN COALESCE(resolved_at, ?) ELSE resolved_at END, updated_at = ?
         WHERE id = ? AND status = ? AND attempt_nonce_hash = ?`,
      ).run(
        status,
        receiptId,
        error,
        observed ? 1 : 0,
        receiptNow,
        input.outcome === "acknowledged" ? 1 : 0,
        receiptNow,
        terminal ? 1 : 0,
        receiptNow,
        receiptNow,
        attemptId,
        raw.status,
        sha256Hex(attemptNonce),
      );
      if (info.changes !== 1) {
        throw new Error("native communication receipt CASに失敗しました");
      }
      if (input.outcome === "transport_accepted") {
        const steerInfo = this.db.prepare(
          `UPDATE steer_deliveries SET status = 'transport_accepted', updated_at = ?
           WHERE id = ? AND status = 'dispatching'`,
        ).run(receiptNow, delivery.id);
        if (steerInfo.changes !== 1) throw new Error("steer transport accepted CASに失敗しました");
      } else if (input.outcome === "session_observed") {
        const steerInfo = this.db.prepare(
          `UPDATE steer_deliveries SET status = 'session_observed', observed_message_id = ?,
             observed_at = COALESCE(observed_at, ?), updated_at = ? WHERE id = ? AND status IN ('dispatching', 'transport_accepted')`,
        ).run(observedMessageId, receiptNow, receiptNow, delivery.id);
        if (steerInfo.changes !== 1) throw new Error("steer session observed CASに失敗しました");
      } else if (input.outcome === "acknowledged") {
        const steerInfo = this.db.prepare(
          `UPDATE steer_deliveries SET status = 'acknowledged', observed_message_id = ?,
             observed_at = COALESCE(observed_at, ?), acknowledged_at = COALESCE(acknowledged_at, ?),
             resolved_at = COALESCE(resolved_at, ?), updated_at = ?
           WHERE id = ? AND status IN ('dispatching', 'transport_accepted', 'session_observed')`,
        ).run(observedMessageId, receiptNow, receiptNow, receiptNow, receiptNow, delivery.id);
        if (steerInfo.changes !== 1) throw new Error("steer acknowledged CASに失敗しました");
      } else if (input.outcome === "uncertain") {
        const steerInfo = this.db.prepare(
          `UPDATE steer_deliveries SET status = 'uncertain', last_error = ?, updated_at = ?, resolved_at = ?
           WHERE id = ? AND status IN ('dispatching', 'transport_accepted', 'session_observed')`,
        ).run(error, receiptNow, receiptNow, delivery.id);
        if (steerInfo.changes !== 1) throw new Error("steer uncertain CASに失敗しました");
      } else if (input.outcome === "rejected" && raw.status === "claimed") {
        // 外部I/O前の明示rejectだけはsteerをqueuedのまま残し、同一delivery keyの
        // Hachi fallback判断へ返せる。claim後dispatching以降のrejectは下のfailedへ進む。
      } else {
        const steerInfo = this.db.prepare(
          `UPDATE steer_deliveries SET status = 'failed', last_error = ?, updated_at = ?, resolved_at = ?
           WHERE id = ? AND status = 'dispatching'`,
        ).run(error, receiptNow, receiptNow, delivery.id);
        if (steerInfo.changes !== 1) throw new Error("steer rejected CASに失敗しました");
      }
      this.insertSteerEvent(
        delivery.task_id,
        `communication_native_receipt_${input.outcome}`,
        actor,
        delivery.id,
        delivery.run_id,
        delivery.session_id,
        delivery.expected_cancel_fence,
        { communicationAttemptId: attemptId, receiptId: receiptId === "" ? null : receiptId, observedMessageId: observedMessageId === "" ? null : observedMessageId, detail: error },
        receiptNow,
        authorized,
      );
      return this.getCommunicationAttempt(attemptId)!;
    });
    return exec();
  }

  recoverNativeCommunicationAttempts(
    recoveryNow: number,
    actor: string,
    provenance: ActorProvenance,
  ): NativeCommunicationRecoveryResult {
    if (!Number.isInteger(recoveryNow) || recoveryNow <= 0) {
      throw new Error("native communication recovery nowは正のepoch秒が必須です");
    }
    const suppliedActor = redactText(actor.trim());
    if (suppliedActor !== NATIVE_SUPERVISOR_SERVICE_ACTOR) {
      throw new Error("native communication recovery actorは固定supervisor identityが必須です");
    }
    const safeActor = NATIVE_SUPERVISOR_SERVICE_ACTOR;
    const exec = this.db.transaction((): NativeCommunicationRecoveryResult => {
      const authorized = this.authorizeNativeSupervisorService(provenance);
      let requeuedClaimed = 0;
      let uncertainDispatching = 0;
      const claimed = this.db.prepare(
        `SELECT * FROM communication_delivery_attempts WHERE status = 'claimed' AND claim_lease_until IS NOT NULL AND claim_lease_until <= ? ORDER BY id`,
      ).all(recoveryNow) as RawCommunicationDeliveryAttemptRow[];
      for (const row of claimed) {
        const info = this.db.prepare(
          `UPDATE communication_delivery_attempts
           SET status = 'recorded', claimant_orchestrator_id = '', claimant_session_id = '', claimant_generation = NULL,
               claim_lease_until = NULL, attempt_nonce_hash = '', updated_at = ?
           WHERE id = ? AND status = 'claimed' AND claim_lease_until <= ?`,
        ).run(recoveryNow, row.id, recoveryNow);
        if (info.changes !== 1) continue;
        requeuedClaimed += 1;
        const delivery = this.db.prepare(`SELECT * FROM steer_deliveries WHERE id = ?`).get(row.steer_delivery_id) as RawSteerDeliveryRow | undefined;
        if (delivery !== undefined) {
          this.insertSteerEvent(delivery.task_id, "communication_native_claim_requeued", safeActor, delivery.id,
            delivery.run_id, delivery.session_id, delivery.expected_cancel_fence,
            { communicationAttemptId: row.id, reason: "claim-lease-expired" }, recoveryNow, authorized);
        }
      }
      const dispatching = this.db.prepare(
        `SELECT * FROM communication_delivery_attempts WHERE status = 'dispatching' AND claim_lease_until IS NOT NULL AND claim_lease_until <= ? ORDER BY id`,
      ).all(recoveryNow) as RawCommunicationDeliveryAttemptRow[];
      for (const row of dispatching) {
        const error = "native dispatch lease expired; delivery outcome is uncertain";
        const info = this.db.prepare(
          `UPDATE communication_delivery_attempts SET status = 'uncertain', last_error = ?, resolved_at = ?, updated_at = ?
           WHERE id = ? AND status = 'dispatching' AND claim_lease_until <= ?`,
        ).run(error, recoveryNow, recoveryNow, row.id, recoveryNow);
        if (info.changes !== 1) continue;
        uncertainDispatching += 1;
        const delivery = this.db.prepare(`SELECT * FROM steer_deliveries WHERE id = ?`).get(row.steer_delivery_id) as RawSteerDeliveryRow | undefined;
        if (delivery !== undefined) {
          this.db.prepare(
            `UPDATE steer_deliveries SET status = 'uncertain', last_error = ?, resolved_at = ?, updated_at = ?
             WHERE id = ? AND status = 'dispatching'`,
          ).run(error, recoveryNow, recoveryNow, delivery.id);
          this.insertSteerEvent(delivery.task_id, "communication_native_dispatch_uncertain", safeActor, delivery.id,
            delivery.run_id, delivery.session_id, delivery.expected_cancel_fence,
            { communicationAttemptId: row.id, reason: "dispatch-lease-expired" }, recoveryNow, authorized);
        }
      }
      return { requeuedClaimed, uncertainDispatching };
    });
    return exec();
  }

  private assertNativeDeliveryTarget(
    delivery: RawSteerDeliveryRow,
    expectedRunId: number,
    expectedSessionId: string,
    expectedCancelFence: number,
  ): void {
    if (delivery.run_id !== expectedRunId || delivery.session_id !== expectedSessionId ||
        delivery.expected_cancel_fence !== expectedCancelFence) {
      throw new Error("native communication delivery run/session/fenceが一致しません");
    }
    const run = this.db.prepare(`SELECT * FROM task_runs WHERE id = ?`).get(delivery.run_id) as RawRunRow | undefined;
    if (run === undefined || run.status !== "running" || run.task_id !== delivery.task_id || run.session_id !== delivery.session_id) {
      throw new Error("native communication deliveryはcurrent open run/sessionではありません");
    }
    if (this.hasSessionEnded(delivery.task_id, delivery.session_id)) {
      throw new Error("native communication deliveryのsessionは終了済みです");
    }
    if (this.currentRunCancelFence(delivery.run_id) !== expectedCancelFence || expectedCancelFence > 0) {
      throw new Error("native communication deliveryはcancel fenceを越えられません");
    }
  }

  private assertNativeBindingPair(
    source: NativeSessionBindingRow,
    target: NativeSessionBindingRow,
    delivery: RawSteerDeliveryRow,
    principal: ActorProvenance,
    at: number,
  ): void {
    if (source.kind !== "source" || target.kind !== "target" || source.status !== "active" || target.status !== "active") {
      throw new Error("native communication source/target bindingはactive exact rowが必須です");
    }
    if (source.expiresAt <= at || target.expiresAt <= at) {
      throw new Error("native communication source/target bindingが期限切れです");
    }
    if (source.taskId !== delivery.task_id || target.taskId !== delivery.task_id || target.runId !== delivery.run_id ||
        target.hachiSessionId !== delivery.session_id || target.expectedCancelFence !== delivery.expected_cancel_fence) {
      throw new Error("native communication bindingがdelivery targetと一致しません");
    }
    if (source.provider !== target.provider || source.hostId !== target.hostId) {
      throw new Error("native communication bindingはsame-provider/same-hostが必須です");
    }
    // sourceはproviderのactive orchestrator principal/sessionがdelivery authorityであり、
    // adapterが返すroute-specific addressを持たない登録経路も正当とする。配送先だけは
    // providerの再接続可能なexact addressを必須にする。
    const route = nativeRouteForProvider(target.provider);
    assertNativeAddressForRoute(target.nativeAddress, route);
    if (source.orchestratorId !== principal.actorId || source.orchestratorSessionId !== principal.actorSessionId ||
        source.orchestratorGeneration !== principal.actorGeneration) {
      throw new Error("native communication source binding principalが一致しません");
    }
  }

  private assertNativeAttemptAuthority(
    attempt: RawCommunicationDeliveryAttemptRow,
    principal: ActorProvenance,
    at: number,
    minimumRuntimeVersion: string,
  ): { delivery: RawSteerDeliveryRow; source: RawNativeSessionBindingRow; target: RawNativeSessionBindingRow } {
    if (attempt.source_binding_id === null || attempt.target_binding_id === null || attempt.route === "") {
      throw new Error("native communication attemptはsource/target bindingとnative routeが必須です");
    }
    const delivery = this.db.prepare(`SELECT * FROM steer_deliveries WHERE id = ?`).get(attempt.steer_delivery_id) as RawSteerDeliveryRow | undefined;
    const source = this.db.prepare(`SELECT * FROM native_session_bindings WHERE id = ?`).get(attempt.source_binding_id) as RawNativeSessionBindingRow | undefined;
    const target = this.db.prepare(`SELECT * FROM native_session_bindings WHERE id = ?`).get(attempt.target_binding_id) as RawNativeSessionBindingRow | undefined;
    if (delivery === undefined || source === undefined || target === undefined) {
      throw new Error("native communication attempt authority rowが欠落しています");
    }
    this.assertNativeDeliveryTarget(delivery, delivery.run_id, delivery.session_id, delivery.expected_cancel_fence);
    const sourceRow = mapNativeSessionBindingRow(source);
    const targetRow = mapNativeSessionBindingRow(target);
    this.assertNativeBindingPair(sourceRow, targetRow, delivery, principal, at);
    if (nativeSessionBindingHash(sourceRow) !== attempt.source_binding_hash ||
        nativeSessionBindingHash(targetRow) !== attempt.target_binding_hash) {
      throw new Error("native communication binding snapshot hashがdriftしました");
    }
    if (nativeCapabilitySnapshotHash(source.capability_hash, target.capability_hash) !== attempt.capability_hash) {
      throw new Error("native communication capability snapshotがdriftしました");
    }
    const run = this.db.prepare(`SELECT provider FROM task_runs WHERE id = ?`).get(delivery.run_id) as { provider: string } | undefined;
    if (run === undefined || run.provider !== target.provider || attempt.route !== nativeRouteForProvider(target.provider as Provider)) {
      throw new Error("native communication provider/routeがdriftしました");
    }
    const sourceSession = this.db.prepare(
      `SELECT provider, provider_session_id, provider_session_source
       FROM orchestrator_sessions WHERE id = ? AND status = 'active'`,
    ).get(source.orchestrator_session_id) as {
      provider: string;
      provider_session_id: string;
      provider_session_source: string;
    } | undefined;
    if (sourceSession === undefined || sourceSession.provider !== source.provider ||
        sourceSession.provider_session_id !== source.provider_session_id ||
        !["codex-session-start", "claude-delivery"].includes(sourceSession.provider_session_source)) {
      throw new Error("native communication source provider sessionが登録済みactive rowと一致しません");
    }
    if (minimumRuntimeVersion !== "" && (
      compareStrictSemver(source.runtime_version, minimumRuntimeVersion) < 0 ||
      compareStrictSemver(target.runtime_version, minimumRuntimeVersion) < 0
    )) {
      throw new Error("native communication runtime versionがminimum未満です");
    }
    this.assertTaskPrimaryOrchestrator(this.requireTaskRaw(delivery.task_id), principal.actorId);
    return { delivery, source, target };
  }

  private assertSteerCurrent(row: RawSteerDeliveryRow, expectedRunId: number, expectedSessionId: string,
    expectedCancelFence: number): void {
    if (
      row.run_id !== expectedRunId || row.session_id !== expectedSessionId ||
      row.expected_cancel_fence !== expectedCancelFence
    ) {
      throw new Error("steer delivery の run/session/fence CAS に失敗しました");
    }
    const run = this.db.prepare(`SELECT * FROM task_runs WHERE id = ?`).get(row.run_id) as RawRunRow | undefined;
    if (run === undefined || run.status !== "running" || run.task_id !== row.task_id || run.session_id !== row.session_id) {
      throw new Error("steer delivery は current open run/session ではありません");
    }
    if (this.hasSessionEnded(row.task_id, row.session_id)) {
      throw new Error("steer delivery の session は終了済みです");
    }
    if (this.currentRunCancelFence(row.run_id) !== expectedCancelFence || expectedCancelFence > 0) {
      throw new Error("steer delivery は cancel fence を越えられません");
    }
  }

  markSteerTransportAccepted(deliveryId: string, expectedRunId: number, expectedSessionId: string,
    expectedCancelFence: number, actor: string): SteerDeliveryRow {
    const exec = this.db.transaction((): SteerDeliveryRow => {
      const row = this.db.prepare(`SELECT * FROM steer_deliveries WHERE id = ?`).get(deliveryId) as
        | RawSteerDeliveryRow
        | undefined;
      if (row === undefined || row.status !== "dispatching") {
        throw new Error("steer transport accepted の dispatching CAS に失敗しました");
      }
      if (
        row.run_id !== expectedRunId || row.session_id !== expectedSessionId ||
        row.expected_cancel_fence !== expectedCancelFence
      ) {
        throw new Error("steer transport accepted の run/session/fence CAS に失敗しました");
      }
      const now = nowSeconds();
      const info = this.db.prepare(
        `UPDATE steer_deliveries SET status = 'transport_accepted', updated_at = ? WHERE id = ? AND status = 'dispatching'`,
      ).run(now, deliveryId);
      if (info.changes !== 1) {
        throw new Error("steer transport accepted CAS に失敗しました");
      }
      this.insertSteerEvent(row.task_id, "steer_transport_accepted", actor, row.id, row.run_id, row.session_id,
        row.expected_cancel_fence, {
          fenceStillCurrent: this.currentRunCancelFence(row.run_id) === row.expected_cancel_fence,
        }, now);
      return this.getSteerDelivery(deliveryId)!;
    });
    return exec();
  }

  observeSteerDelivery(input: ObserveSteerDeliveryInput): SteerDeliveryRow {
    const exec = this.db.transaction((): SteerDeliveryRow => {
      const row = this.db.prepare(`SELECT * FROM steer_deliveries WHERE id = ?`).get(input.deliveryId) as
        | RawSteerDeliveryRow
        | undefined;
      if (row === undefined || !["transport_accepted", "session_observed", "uncertain"].includes(row.status)) {
        throw new Error("steer observation の lifecycle CAS に失敗しました");
      }
      if (
        row.run_id !== input.expectedRunId || row.session_id !== input.expectedSessionId ||
        row.expected_cancel_fence !== input.expectedCancelFence
      ) {
        throw new Error("steer observation の run/session/fence CAS に失敗しました");
      }
      const observedMessageId = input.observedMessageId.trim();
      if (observedMessageId === "") {
        throw new Error("steer observation message ID は空にできません");
      }
      if (row.observed_message_id !== "" && row.observed_message_id !== observedMessageId) {
        throw new Error("steer observation message ID は初回観測値と一致しません");
      }
      const now = nowSeconds();
      const status = input.acknowledged ? "acknowledged" : "session_observed";
      const info = this.db.prepare(
        `UPDATE steer_deliveries
         SET status = ?, observed_message_id = ?, observed_at = COALESCE(observed_at, ?),
             acknowledged_at = ?, resolved_at = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
      ).run(status, observedMessageId, now, input.acknowledged ? now : null, input.acknowledged ? now : null,
        now, row.id, row.status);
      if (info.changes !== 1) {
        throw new Error("steer observation CAS に失敗しました");
      }
      this.insertSteerEvent(row.task_id, input.acknowledged ? "steer_acknowledged" : "steer_session_observed",
        input.actor, row.id, row.run_id, row.session_id, row.expected_cancel_fence, { observedMessageId }, now);
      return this.getSteerDelivery(row.id)!;
    });
    return exec();
  }

  markSteerDispatchUncertain(deliveryId: string, error: string, actor: string): SteerDeliveryRow {
    const exec = this.db.transaction((): SteerDeliveryRow => {
      const row = this.db.prepare(`SELECT * FROM steer_deliveries WHERE id = ?`).get(deliveryId) as
        | RawSteerDeliveryRow
        | undefined;
      if (row === undefined || row.status !== "dispatching") {
        throw new Error("steer uncertain の dispatching CAS に失敗しました");
      }
      const now = nowSeconds();
      const redactedError = redactText(error);
      this.db.prepare(
        `UPDATE steer_deliveries SET status = 'uncertain', last_error = ?, updated_at = ? WHERE id = ?`,
      ).run(redactedError, now, row.id);
      this.insertSteerEvent(row.task_id, "steer_delivery_uncertain", actor, row.id, row.run_id, row.session_id,
        row.expected_cancel_fence, { error: redactedError }, now);
      return this.getSteerDelivery(row.id)!;
    });
    return exec();
  }

  failSteerDelivery(deliveryId: string, error: string, actor: string): SteerDeliveryRow {
    const exec = this.db.transaction((): SteerDeliveryRow => {
      const row = this.db.prepare(`SELECT * FROM steer_deliveries WHERE id = ?`).get(deliveryId) as
        | RawSteerDeliveryRow
        | undefined;
      if (row === undefined || row.status !== "queued") {
        throw new Error("steer failure の queued CAS に失敗しました");
      }
      const now = nowSeconds();
      const redactedError = redactText(error);
      this.db.prepare(
        `UPDATE steer_deliveries SET status = 'failed', last_error = ?, updated_at = ?, resolved_at = ? WHERE id = ?`,
      ).run(redactedError, now, now, row.id);
      this.insertSteerEvent(row.task_id, "steer_failed", actor, row.id, row.run_id, row.session_id,
        row.expected_cancel_fence, { error: redactedError }, now);
      return this.getSteerDelivery(row.id)!;
    });
    return exec();
  }

  private insertSteerEvent(taskId: string, eventType: string, actor: string, deliveryId: string, runId: number,
    sessionId: string, cancelFence: number, extra: Record<string, unknown>, now: number,
    provenance?: ActorProvenance): void {
    this.insertTaskEvent(
      taskId,
      eventType,
      actor,
      { deliveryId, runId, sessionId, cancelFence, ...extra },
      now,
      provenance,
    );
  }

  private staleCancelSteersForRunAt(
    runId: number,
    sessionId: string,
    actor: string,
    reason: string,
    now: number,
    provenance?: ActorProvenance,
  ): number {
    const rows = this.db.prepare(
      `SELECT * FROM steer_deliveries WHERE run_id = ? AND session_id = ? AND status = 'queued'
       ORDER BY sequence, id`,
    ).all(runId, sessionId) as RawSteerDeliveryRow[];
    for (const row of rows) {
      this.db.prepare(
        `UPDATE steer_deliveries SET status = 'stale_cancelled', updated_at = ?, resolved_at = ?
         WHERE id = ? AND status = 'queued'`,
      ).run(now, now, row.id);
      this.insertSteerEvent(row.task_id, "steer_stale_cancelled", actor, row.id, row.run_id, row.session_id,
        row.expected_cancel_fence, { reason }, now, provenance);
    }
    return rows.length;
  }

  staleCancelSteersForRun(runId: number, sessionId: string, actor: string, reason: string): number {
    const exec = this.db.transaction((): number =>
      this.staleCancelSteersForRunAt(runId, sessionId, actor, redactText(reason), nowSeconds()));
    return exec();
  }

  /** orchestrator 起点の cancel request が task の primary authority を持つことを検証する。 */
  private assertRunCancelRequesterAuthority(input: {
    task: RawTaskRow;
    orchestratorId: string;
    sessionId: string;
    generation: number;
  }): void {
    const session = this.db
      .prepare(
        `SELECT 1 AS found FROM orchestrator_sessions
         WHERE id = ? AND orchestrator_id = ? AND generation = ? AND status = 'active'`,
      )
      .get(input.sessionId, input.orchestratorId, input.generation);
    if (session === undefined) {
      throw new Error("cancel requester の active session generation が stale です");
    }

    this.assertTaskPrimaryOrchestrator(input.task, input.orchestratorId);
  }

  createOrGetRunCancelRequest(input: CreateRunCancelRequestInput): RunCancelRequestRow {
    const requestNonce = input.requestNonce.trim();
    const actor = redactText(input.actor.trim());
    const reason = redactText(input.reason.trim());
    if (requestNonce === "" || actor === "" || reason === "") {
      throw new Error("cancel request の nonce/actor/reason は空にできません");
    }
    if (!Number.isInteger(input.deadlineAt) || input.deadlineAt < 0) {
      throw new Error("cancel deadline は 0 以上の整数 epoch 秒が必須です");
    }
    const orchestratorId = input.orchestratorId?.trim() ?? "";
    const requesterSessionId = input.requesterSessionId?.trim() ?? "";
    const requesterGeneration = input.requesterGeneration ?? null;
    const hasRequester = orchestratorId !== "" || requesterSessionId !== "" || requesterGeneration !== null;
    if (
      hasRequester &&
      (orchestratorId === "" || requesterSessionId === "" || requesterGeneration === null ||
        !Number.isInteger(requesterGeneration) || requesterGeneration <= 0)
    ) {
      throw new Error("orchestrator cancel は identity/session/正の generation の完全指定が必須です");
    }

    const exec = this.db.transaction((): RunCancelRequestRow => {
      const existingNonce = this.db
        .prepare(`SELECT * FROM run_cancel_requests WHERE request_nonce = ?`)
        .get(requestNonce) as RawRunCancelRequestRow | undefined;
      if (existingNonce !== undefined) {
        const same =
          existingNonce.task_id === input.taskId &&
          existingNonce.run_id === input.runId &&
          existingNonce.session_id === input.sessionId &&
          existingNonce.provider === input.provider &&
          existingNonce.actor === actor &&
          existingNonce.reason === reason &&
          (existingNonce.orchestrator_id ?? "") === orchestratorId &&
          existingNonce.requester_session_id === requesterSessionId &&
          existingNonce.requester_generation === requesterGeneration &&
          existingNonce.deadline_at === input.deadlineAt;
        if (!same) {
          throw new Error("cancel request nonce が異なる入力と衝突しました");
        }
        return mapRunCancelRequestRow(existingNonce);
      }

      const task = this.requireTaskRaw(input.taskId);
      const openRun = this.db
        .prepare(
          `SELECT * FROM task_runs WHERE task_id = ? AND status = 'running'
           ORDER BY started_at DESC, id DESC LIMIT 1`,
        )
        .get(input.taskId) as RawRunRow | undefined;
      if (
        openRun === undefined || openRun.id !== input.runId || openRun.session_id !== input.sessionId ||
        openRun.provider !== input.provider
      ) {
        throw new Error("cancel 対象が current open run/session/provider と一致しません");
      }
      if (hasRequester) {
        this.assertRunCancelRequesterAuthority({
          task,
          orchestratorId,
          sessionId: requesterSessionId,
          generation: requesterGeneration!,
        });
      }

      const previous = this.db
        .prepare(`SELECT * FROM run_cancel_requests WHERE run_id = ? ORDER BY cancel_fence DESC LIMIT 1`)
        .get(input.runId) as RawRunCancelRequestRow | undefined;
      if (previous !== undefined && !["failed", "expired"].includes(previous.status)) {
        throw new Error("同一 run の cancel は既に進行中または停止済みです");
      }
      const cancelFence = (previous?.cancel_fence ?? 0) + 1;
      const now = nowSeconds();
      const id = generateRuntimeId("rc");
      this.db
        .prepare(
          `INSERT INTO run_cancel_requests (
             id, task_id, run_id, session_id, provider, status, request_nonce, actor, reason,
             orchestrator_id, requester_session_id, requester_generation, cancel_fence, deadline_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'cancel_requested', ?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.taskId,
          input.runId,
          input.sessionId,
          input.provider,
          requestNonce,
          actor,
          reason,
          orchestratorId,
          requesterSessionId,
          requesterGeneration,
          cancelFence,
          input.deadlineAt,
          now,
          now,
        );
      this.insertTaskEvent(
        input.taskId,
        "cancel_requested",
        actor,
        {
          requestId: id,
          runId: input.runId,
          sessionId: input.sessionId,
          provider: input.provider,
          reason,
          deadlineAt: input.deadlineAt,
          cancelFence,
          orchestratorId,
          requesterSessionId,
          requesterGeneration,
        },
        now,
      );
      // cancel intent は通常 steer より高優先。同じ Tx で未観測配送を無効化する。
      this.staleCancelSteersForRunAt(input.runId, input.sessionId, actor, "cancel-requested", now);
      return this.getRunCancelRequest(id)!;
    });
    return exec();
  }

  /**
   * expected run/session を current open run と同一 transaction 内で照合して cancel request を作る。
   * 不一致は request/event/steer の mutation を一切行わず、既存 tri-state 語彙の no を返す。
   */
  createOrGetFencedRunCancelRequest(input: CreateFencedRunCancelRequestInput): FencedRunCancelRequestResult {
    const expectedRunId = input.expectedRunId;
    if (expectedRunId !== undefined && (!Number.isSafeInteger(expectedRunId) || expectedRunId <= 0)) {
      throw new Error("expected run ID は正の安全な整数が必須です");
    }
    const expectedSessionId = input.expectedSessionId?.trim();
    if (input.expectedSessionId !== undefined && expectedSessionId === "") {
      throw new Error("expected worker session ID は空にできません");
    }
    if (expectedRunId === undefined && expectedSessionId === undefined) {
      throw new Error("fenced cancel は expected run/session の少なくとも一方が必須です");
    }

    const exec = this.db.transaction((): FencedRunCancelRequestResult => {
      this.requireTaskRaw(input.taskId);
      const openRun = this.db
        .prepare(
          `SELECT * FROM task_runs WHERE task_id = ? AND status = 'running'
           ORDER BY started_at DESC, id DESC LIMIT 1`,
        )
        .get(input.taskId) as RawRunRow | undefined;
      if (
        openRun === undefined ||
        (expectedRunId !== undefined && openRun.id !== expectedRunId) ||
        (expectedSessionId !== undefined && openRun.session_id !== expectedSessionId)
      ) {
        return { targetMatched: "no", request: null };
      }

      const request = this.createOrGetRunCancelRequest({
        taskId: input.taskId,
        runId: openRun.id,
        sessionId: openRun.session_id,
        provider: openRun.provider as Provider,
        requestNonce: input.requestNonce,
        actor: input.actor,
        reason: input.reason,
        orchestratorId: input.orchestratorId,
        requesterSessionId: input.requesterSessionId,
        requesterGeneration: input.requesterGeneration,
        deadlineAt: input.deadlineAt,
      });
      return { targetMatched: "yes", request };
    });
    return exec();
  }

  getRunCancelRequest(id: string): RunCancelRequestRow | null {
    const row = this.db.prepare(`SELECT * FROM run_cancel_requests WHERE id = ?`).get(id) as
      | RawRunCancelRequestRow
      | undefined;
    return row === undefined ? null : mapRunCancelRequestRow(row);
  }

  getActiveRunCancelRequestByTask(taskId: string): RunCancelRequestRow | null {
    const row = this.db
      .prepare(
        `SELECT c.* FROM run_cancel_requests c
         JOIN task_runs r ON r.id = c.run_id
         WHERE c.task_id = ? AND r.status = 'running'
           AND c.status IN ('cancel_requested', 'cooperative_sent', 'acknowledged', 'forcing')
         ORDER BY c.cancel_fence DESC, c.created_at DESC, c.id DESC LIMIT 1`,
      )
      .get(taskId) as RawRunCancelRequestRow | undefined;
    return row === undefined ? null : mapRunCancelRequestRow(row);
  }

  listRunCancelRequests(taskId?: string): RunCancelRequestRow[] {
    const rows = (taskId === undefined
      ? this.db.prepare(`SELECT * FROM run_cancel_requests ORDER BY created_at, id`).all()
      : this.db
          .prepare(`SELECT * FROM run_cancel_requests WHERE task_id = ? ORDER BY created_at, id`)
          .all(taskId)) as RawRunCancelRequestRow[];
    return rows.map(mapRunCancelRequestRow);
  }

  transitionRunCancelRequest(input: TransitionRunCancelRequestInput): RunCancelRequestRow {
    const actor = redactText(input.actor.trim());
    if (actor === "") {
      throw new Error("cancel transition actor は空にできません");
    }
    const now = input.now ?? nowSeconds();
    if (!Number.isInteger(now) || now < 0) {
      throw new Error("cancel transition now は 0 以上の整数 epoch 秒が必須です");
    }
    const exec = this.db.transaction((): RunCancelRequestRow => {
      const currentRaw = this.db.prepare(`SELECT * FROM run_cancel_requests WHERE id = ?`).get(input.requestId) as
        | RawRunCancelRequestRow
        | undefined;
      if (currentRaw === undefined) {
        throw new Error(`cancel request が見つかりません: ${input.requestId}`);
      }
      if (
        currentRaw.status !== input.expectedStatus || currentRaw.run_id !== input.expectedRunId ||
        currentRaw.session_id !== input.expectedSessionId || currentRaw.cancel_fence !== input.expectedCancelFence ||
        currentRaw.request_nonce !== input.requestNonce
      ) {
        throw new Error("cancel transition の status/run/session/fence/nonce CAS に失敗しました");
      }
      if (!RUN_CANCEL_TRANSITIONS[input.expectedStatus].includes(input.to)) {
        throw new Error(`許可されていない cancel 遷移です: ${input.expectedStatus} -> ${input.to}`);
      }
      const openRun = this.db
        .prepare(
          `SELECT * FROM task_runs WHERE task_id = ? AND status = 'running'
           ORDER BY started_at DESC, id DESC LIMIT 1`,
        )
        .get(currentRaw.task_id) as RawRunRow | undefined;
      if (
        openRun === undefined || openRun.id !== currentRaw.run_id || openRun.session_id !== currentRaw.session_id ||
        openRun.provider !== currentRaw.provider
      ) {
        throw new Error("cancel transition 対象が current open run/session/provider ではありません");
      }
      if ((input.to === "forcing" || input.to === "expired") && now < currentRaw.deadline_at) {
        throw new Error(`${input.to} は deadline 到達前には遷移できません`);
      }
      if (input.to === "acknowledged" && input.acknowledgedNonce !== currentRaw.request_nonce) {
        throw new Error("cancel acknowledgement nonce が request nonce と一致しません");
      }

      const acknowledgedNonce = input.to === "acknowledged"
        ? input.acknowledgedNonce!
        : currentRaw.acknowledged_nonce;
      const capabilitySnapshot = input.capabilitySnapshot === undefined
        ? currentRaw.capability_snapshot
        : serializeRedactedJson(input.capabilitySnapshot);
      const stopEvidence = input.stopEvidence === undefined
        ? currentRaw.stop_evidence
        : serializeRedactedJson(input.stopEvidence);
      const lastError = input.lastError === undefined ? currentRaw.last_error : redactText(input.lastError);
      const resolvedAt = RUN_CANCEL_TERMINAL_STATUSES.has(input.to) ? now : null;
      const info = this.db
        .prepare(
          `UPDATE run_cancel_requests
           SET status = ?, acknowledged_nonce = ?, capability_snapshot = ?, stop_evidence = ?,
               last_error = ?, updated_at = ?, resolved_at = ?
           WHERE id = ? AND status = ? AND run_id = ? AND session_id = ?
             AND cancel_fence = ? AND request_nonce = ?`,
        )
        .run(
          input.to,
          acknowledgedNonce,
          capabilitySnapshot,
          stopEvidence,
          lastError,
          now,
          resolvedAt,
          input.requestId,
          input.expectedStatus,
          input.expectedRunId,
          input.expectedSessionId,
          input.expectedCancelFence,
          input.requestNonce,
        );
      if (info.changes !== 1) {
        throw new Error("cancel transition CAS に失敗しました");
      }
      this.insertTaskEvent(
        currentRaw.task_id,
        RUN_CANCEL_EVENT_TYPES[input.to],
        actor,
        {
          requestId: currentRaw.id,
          runId: currentRaw.run_id,
          sessionId: currentRaw.session_id,
          cancelFence: currentRaw.cancel_fence,
          from: input.expectedStatus,
          to: input.to,
          acknowledged: input.to === "acknowledged",
          capabilitySnapshot: JSON.parse(capabilitySnapshot) as unknown,
          stopEvidence: JSON.parse(stopEvidence) as unknown,
          error: lastError,
        },
        now,
      );
      return this.getRunCancelRequest(input.requestId)!;
    });
    return exec();
  }

  runMutationGate(runId: number, sessionId: string): RunMutationGate {
    const exec = this.db.transaction((): RunMutationGate => {
      const run = this.db.prepare(`SELECT * FROM task_runs WHERE id = ?`).get(runId) as RawRunRow | undefined;
      if (run === undefined || run.session_id !== sessionId) {
        if (run !== undefined) {
          const cancel = this.db
            .prepare(`SELECT * FROM run_cancel_requests WHERE run_id = ? ORDER BY cancel_fence DESC LIMIT 1`)
            .get(runId) as RawRunCancelRequestRow | undefined;
          if (cancel !== undefined) {
            this.insertTaskEvent(run.task_id, "late_result_rejected", "core", {
              requestId: cancel.id,
              runId,
              expectedSessionId: run.session_id,
              observedSessionId: sessionId,
              cancelFence: cancel.cancel_fence,
              reason: "run-session-mismatch",
            }, nowSeconds());
          }
        }
        return { allowed: false, cancelRequestId: null, cancelFence: null, reason: "run-session-mismatch" };
      }
      const cancel = this.db
        .prepare(`SELECT * FROM run_cancel_requests WHERE run_id = ? ORDER BY cancel_fence DESC LIMIT 1`)
        .get(runId) as RawRunCancelRequestRow | undefined;
      if (cancel === undefined) {
        return { allowed: true, cancelRequestId: null, cancelFence: null, reason: "not-cancelled" };
      }
      this.insertTaskEvent(run.task_id, "late_result_rejected", "core", {
        requestId: cancel.id,
        runId,
        sessionId,
        cancelFence: cancel.cancel_fence,
        reason: "cancel-fenced",
      }, nowSeconds());
      return {
        allowed: false,
        cancelRequestId: cancel.id,
        cancelFence: cancel.cancel_fence,
        reason: "cancel-fenced",
      };
    });
    return exec();
  }

  /**
   * タスクと sessionId が一致する open run を1件返す（docs/contract.md §12.17-4）。
   * finalize の open run 解決用の専用クエリ（listOpenRuns の全走査 + フィルタを置き換える）。
   * task_runs(task_id, status) index（idx_runs_task_status）を利用する。
   * 同一 sessionId の running 行が複数存在することは通常無いが、防御的に id 最大（最新）を返す。
   */
  getOpenRunByTaskSession(taskId: string, sessionId: string): RunRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM task_runs
         WHERE task_id = ? AND session_id = ? AND status = 'running'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(taskId, sessionId) as RawRunRow | undefined;
    return row === undefined ? null : mapRunRow(row);
  }

  link(parentId: string, childId: string, linkType?: string): void {
    const now = nowSeconds();
    const effectiveLinkType = linkType ?? "subtask";
    const exec = this.db.transaction((): void => {
      if (effectiveLinkType === "depends-on") {
        this.assertDependsOnLinkAllowed(parentId, childId);
      }
      this.db
        .prepare(`INSERT OR IGNORE INTO task_links (parent_id, child_id, link_type, created_at) VALUES (?, ?, ?, ?)`)
        .run(parentId, childId, effectiveLinkType, now);
    });
    exec();
  }

  listLinks(taskId: string): LinkRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM task_links WHERE parent_id = ? OR child_id = ? ORDER BY created_at ASC`)
      .all(taskId, taskId) as RawLinkRow[];
    return rows.map(mapLinkRow);
  }

  dependencies(taskId: string): TaskRow[] {
    const rows = this.db
      .prepare(
        `SELECT t.*
         FROM task_links AS l
         JOIN tasks AS t ON t.id = l.parent_id
         WHERE l.child_id = ? AND l.link_type = 'depends-on'
         ORDER BY l.created_at ASC, l.id ASC`,
      )
      .all(taskId) as RawTaskRow[];
    return rows.map(mapTaskRow);
  }

  createSchedule(input: ScheduleCreateInput, actor: string): ScheduleRow {
    acknowledgeActor(actor);
    const normalized = normalizeScheduleInput(input);
    const now = nowSeconds();
    const insertOnce = this.db.transaction((id: string): ScheduleRow => {
      this.db
        .prepare(
          `INSERT INTO schedules (
             id, name, enabled, cadence_kind, at_minute, at_hour, weekday, day_of_month, run_date,
             tenant, profile, cwd, prompt, priority, created_at, updated_at
           )
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          normalized.name,
          normalized.cadenceKind,
          normalized.atMinute,
          normalized.atHour,
          normalized.weekday,
          normalized.dayOfMonth,
          normalized.runDate,
          normalized.tenant,
          normalized.profile,
          normalized.cwd,
          normalized.prompt,
          normalized.priority,
          now,
          now,
        );
      return mapScheduleRow(this.requireScheduleRaw(id));
    });

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= SCHEDULE_ID_COLLISION_MAX_RETRIES; attempt += 1) {
      const id = generateScheduleId();
      try {
        return insertOnce(id);
      } catch (err) {
        if (!isPrimaryKeyConstraintError(err)) {
          throw err;
        }
        lastError = err;
      }
    }
    throw new Error(
      `スケジュールID採番が PK 衝突により失敗しました（${SCHEDULE_ID_COLLISION_MAX_RETRIES}回再試行後も解決せず）: ${String(lastError)}`,
    );
  }

  listSchedules(): ScheduleRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM schedules ORDER BY created_at ASC, rowid ASC`)
      .all() as RawScheduleRow[];
    return rows.map(mapScheduleRow);
  }

  getSchedule(id: string): ScheduleRow | null {
    const row = this.db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as RawScheduleRow | undefined;
    return row === undefined ? null : mapScheduleRow(row);
  }

  updateSchedule(id: string, patch: Partial<ScheduleCreateInput>, actor: string): ScheduleRow {
    acknowledgeActor(actor);
    const now = nowSeconds();
    const exec = this.db.transaction((): ScheduleRow => {
      const current = mapScheduleRow(this.requireScheduleRaw(id));
      const normalized = normalizeSchedulePatch(current, patch);
      this.db
        .prepare(
          `UPDATE schedules
           SET name = ?, cadence_kind = ?, at_minute = ?, at_hour = ?, weekday = ?, day_of_month = ?,
               run_date = ?, tenant = ?, profile = ?, cwd = ?, prompt = ?, priority = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          normalized.name,
          normalized.cadenceKind,
          normalized.atMinute,
          normalized.atHour,
          normalized.weekday,
          normalized.dayOfMonth,
          normalized.runDate,
          normalized.tenant,
          normalized.profile,
          normalized.cwd,
          normalized.prompt,
          normalized.priority,
          now,
          id,
        );
      return mapScheduleRow(this.requireScheduleRaw(id));
    });
    return exec();
  }

  setScheduleEnabled(id: string, enabled: boolean, actor: string, autoDisabledReason?: string): ScheduleRow {
    acknowledgeActor(actor);
    const now = nowSeconds();
    const exec = this.db.transaction((): ScheduleRow => {
      this.requireScheduleRaw(id);
      const reason = enabled ? "" : autoDisabledReason !== undefined ? requireString(autoDisabledReason, "autoDisabledReason") : "";
      this.db
        .prepare(`UPDATE schedules SET enabled = ?, auto_disabled_reason = ?, updated_at = ? WHERE id = ?`)
        .run(enabled ? 1 : 0, reason, now, id);
      return mapScheduleRow(this.requireScheduleRaw(id));
    });
    return exec();
  }

  markScheduleFired(id: string, taskId: string, firedAt: number, actor: string): void {
    acknowledgeActor(actor);
    const normalizedFiredAt = requireNonNegativeInteger(firedAt, "firedAt");
    const exec = this.db.transaction((): void => {
      this.requireScheduleRaw(id);
      this.requireTaskRaw(taskId);
      const result = this.db
        .prepare(
          `UPDATE schedules
           SET last_run_at = ?, last_task_id = ?, updated_at = ?
           WHERE id = ?
             AND enabled = 1
             AND (last_run_at IS NULL OR last_run_at < ?)`,
        )
        .run(normalizedFiredAt, taskId, nowSeconds(), id, normalizedFiredAt);
      if (result.changes !== 1) {
        throw new Error(`${SCHEDULE_FIRE_CLAIM_LOST_MESSAGE}: ${id} firedAt=${normalizedFiredAt}`);
      }
    });
    exec();
  }

  setScheduleFailures(id: string, consecutiveFailures: number, actor: string): void {
    acknowledgeActor(actor);
    const normalizedFailures = requireNonNegativeInteger(consecutiveFailures, "consecutiveFailures");
    const exec = this.db.transaction((): void => {
      this.requireScheduleRaw(id);
      this.db
        .prepare(`UPDATE schedules SET consecutive_failures = ?, updated_at = ? WHERE id = ?`)
        .run(normalizedFailures, nowSeconds(), id);
    });
    exec();
  }

  deleteSchedule(id: string, actor: string): void {
    acknowledgeActor(actor);
    const exec = this.db.transaction((): void => {
      this.requireScheduleRaw(id);
      this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
    });
    exec();
  }

  recordLesson(input: LessonCreateInput, actor?: string): LessonRow {
    const normalized = normalizeLessonInput(input);
    const now = nowSeconds();
    const exec = this.db.transaction((): LessonRow => this.insertLesson(normalized, actor, now));
    return exec();
  }

  listRecentLessons(tenant: string, cwd: string, limit: number): LessonRow[] {
    const normalizedTenant = requireString(tenant, "tenant");
    const normalizedCwd = normalizeCwdValue(cwd);
    const normalizedLimit = requireIntegerInRange(limit, "limit", 1, Number.MAX_SAFE_INTEGER);
    const rows = this.db
      .prepare(
        `SELECT * FROM lessons
         WHERE tenant = ?
         ORDER BY
           CASE
             WHEN ? != ''
              AND cwd != ''
              AND (
                cwd = ?
                OR substr(cwd, 1, length(?) + 1) = ? || '/'
                OR substr(?, 1, length(cwd) + 1) = cwd || '/'
              )
             THEN 0
             ELSE 1
           END ASC,
           created_at DESC,
           id DESC
         LIMIT ?`,
      )
      .all(
        normalizedTenant,
        normalizedCwd,
        normalizedCwd,
        normalizedCwd,
        normalizedCwd,
        normalizedCwd,
        normalizedLimit,
      ) as RawLessonRow[];
    return rows.map(mapLessonRow);
  }

  setModelOverride(taskId: string, model: string, actor: string, provenance?: ActorProvenance): TaskRow {
    return this.setExecutionOverrides(taskId, "worker", { model }, actor, provenance);
  }

  setEffortOverride(
    taskId: string,
    effort: EffortLevel | "",
    actor: string,
    provenance?: ActorProvenance,
  ): TaskRow {
    return this.setExecutionOverrides(taskId, "worker", { effort }, actor, provenance);
  }

  setExecutionOverrides(
    taskId: string,
    role: ExecutionRole,
    patch: ExecutionOverridePatch,
    actor: string,
    provenance?: ActorProvenance,
  ): TaskRow {
    acknowledgeActor(actor);
    if (role !== "worker" && role !== "reviewer") {
      throw new Error(`execution role が不正です: ${String(role)}`);
    }
    if (patch.profile !== undefined && typeof patch.profile !== "string") {
      throw new Error("profile override は文字列が必須です");
    }
    if (patch.provider !== undefined && !["", "codex", "claude"].includes(patch.provider)) {
      throw new Error(`provider override が不正です: ${String(patch.provider)}`);
    }
    if (patch.model !== undefined && patch.model !== "" && !MODEL_CHARSET.test(patch.model)) {
      throw new Error(`model override の charset が不正です（^[A-Za-z0-9._-]+$ 必須）: ${patch.model}`);
    }
    if (patch.effort !== undefined && patch.effort !== "" && !isEffortLevel(patch.effort)) {
      throw new Error(`effort override が不正です: ${String(patch.effort)}`);
    }
    if (patch.speed !== undefined && patch.speed !== "" && !isExecutionSpeed(patch.speed)) {
      throw new Error(`speed override が不正です: ${String(patch.speed)}`);
    }

    const exec = this.db.transaction((): TaskRow => {
      const authorized = this.authorizeActorProvenance(provenance);
      if (authorized.kind !== "orchestrator") {
        throw new Error("execution override変更はactive exact orchestrator provenanceが必須です");
      }
      const current = this.requireTaskRaw(taskId);
      this.assertTaskPrimaryOrchestrator(current, authorized.actorId);
      const columns = role === "worker"
        ? {
            profile: "profile",
            provider: "provider",
            model: "model_override",
            effort: "effort_override",
            speed: "speed_override",
          }
        : {
            profile: "review_profile_override",
            provider: "review_provider_override",
            model: "review_model_override",
            effort: "review_effort_override",
            speed: "review_speed_override",
          };
      const currentValues: Record<keyof ExecutionOverridePatch, string> = role === "worker"
        ? {
            profile: current.profile,
            provider: current.provider,
            model: current.model_override,
            effort: current.effort_override,
            speed: current.speed_override,
          }
        : {
            profile: current.review_profile_override,
            provider: current.review_provider_override,
            model: current.review_model_override,
            effort: current.review_effort_override,
            speed: current.review_speed_override,
          };

      const assignments: string[] = [];
      const values: string[] = [];
      const changes: Record<string, { field: string; previous: string; value: string }> = {};
      for (const key of ["profile", "provider", "model", "effort", "speed"] as const) {
        const value = patch[key];
        if (value === undefined || currentValues[key] === value) {
          continue;
        }
        assignments.push(`${columns[key]} = ?`);
        values.push(value);
        changes[key] = { field: columns[key], previous: currentValues[key], value };
      }
      if (assignments.length === 0) {
        return mapTaskRow(current);
      }

      const running = this.db
        .prepare(`SELECT 1 AS found FROM task_runs WHERE task_id = ? AND status = 'running' LIMIT 1`)
        .get(taskId);
      if (running !== undefined || current.claim_lock !== "") {
        throw new Error("実行開始済みまたはlaunch claim中のtaskはexecution overrideを変更できません");
      }

      const now = nowSeconds();
      this.db
        .prepare(`UPDATE tasks SET ${assignments.join(", ")}, updated_at = ? WHERE id = ?`)
        .run(...values, now, taskId);
      this.insertTaskEvent(taskId, "execution_overrides_changed", actor, { role, changes }, now, authorized);
      return mapTaskRow(this.requireTaskRaw(taskId));
    });
    return exec();
  }

  setWatched(taskId: string, watched: boolean, actor: string, provenance?: ActorProvenance): TaskRow {
    acknowledgeActor(actor);
    const nextWatched = watched ? 1 : 0;
    const eventType = watched ? "watch_set" : "watch_cleared";
    const now = nowSeconds();
    const exec = this.db.transaction((): TaskRow => {
      const authorized = this.authorizeActorProvenance(provenance);
      const current = this.requireTaskRaw(taskId);
      const currentWatched = current.watched === 1;
      if (currentWatched === watched) {
        return mapTaskRow(current);
      }

      this.db.prepare(`UPDATE tasks SET watched = ?, updated_at = ? WHERE id = ?`).run(nextWatched, now, taskId);
      this.insertTaskEvent(
        taskId,
        eventType,
        actor,
        { previous: currentWatched, watched },
        now,
        authorized,
      );

      return mapTaskRow(this.requireTaskRaw(taskId));
    });

    return exec();
  }

  /**
   * blocked タスクの block_reason を状態遷移なしで更新する（docs/contract.md §12.6-2）。
   * status=blocked 以外は throw（fail-closed）。prefix 検証あり。event 'block_reason_updated' を記録する。
   * finalize の handoff 欠落救済（needs-manual への付替）等、reason だけを差し替えたい場合に使う。
   */
  updateBlockReason(
    taskId: string,
    reason: string,
    actor: string,
    assignee?: string,
    provenance?: ActorProvenance,
  ): TaskRow {
    const now = nowSeconds();
    const exec = this.db.transaction((): TaskRow => {
      const current = this.requireTaskRaw(taskId);
      if (current.status !== "blocked") {
        throw new Error(`updateBlockReason は blocked 状態のタスクにのみ使用できます（現在の状態: ${current.status}）`);
      }
      if (!hasKnownReasonPrefix(reason)) {
        throw new Error(`未知の block_reason prefix です: ${reason}`);
      }

      const nextAssignee = assignee ?? current.assignee;

      this.db
        .prepare(`UPDATE tasks SET block_reason = ?, assignee = ?, updated_at = ? WHERE id = ?`)
        .run(reason, nextAssignee, now, taskId);

      this.insertTaskEvent(
        taskId,
        "block_reason_updated",
        actor,
        { previous: current.block_reason, reason, assignee: nextAssignee },
        now,
        provenance,
      );

      return mapTaskRow(this.requireTaskRaw(taskId));
    });

    return exec();
  }

  /**
   * タスク body を全置換する（spec 補強・cwd 付与用）。fail-closed でタスク存在確認を行う。
   * event 'body_updated' を記録するが、本文はイベントに残さず bodyLength のみ記録する
   * （task_events は監査ログとして残り続けるため、body の生値を重複保持しない）。
   */
  updateBody(taskId: string, body: string, actor: string, provenance?: ActorProvenance): TaskRow {
    const now = nowSeconds();
    const exec = this.db.transaction((): TaskRow => {
      this.requireTaskRaw(taskId);
      assertVerifyDirectiveAllowed(body);
      this.db.prepare(`UPDATE tasks SET body = ?, updated_at = ? WHERE id = ?`).run(body, now, taskId);
      this.insertTaskEvent(taskId, "body_updated", actor, { bodyLength: body.length }, now, provenance);
      return mapTaskRow(this.requireTaskRaw(taskId));
    });

    return exec();
  }

  /**
   * agent.message.v1 フェンスを含む可能性のあるコメントを id 昇順で増分取得する（docs/contract.md §12.6-5）。
   * supervisor messages ステージのカーソル走査用。afterId より大きい id のみを対象にする。
   * LIKE '%agent-message-v1%' は messages.ts の FENCE_LANG と完全に一致させる（フェンス言語名の変更時は要追随）。
   */
  listMessageFenceComments(afterId: number, limit?: number): CommentRow[] {
    const effectiveLimit = limit ?? MESSAGE_FENCE_SCAN_DEFAULT_LIMIT;
    const rows = this.db
      .prepare(
        `SELECT * FROM task_comments
         WHERE id > ? AND body LIKE '%agent-message-v1%'
         ORDER BY id ASC LIMIT ?`,
      )
      .all(afterId, effectiveLimit) as RawCommentRow[];
    return rows.map(mapCommentRow);
  }

  /**
   * 全状態横断で updated_at 降順の直近タスクを返す（docs/contract.md §12.12-4）。
   * CLI の `task list`（--status 無し）が全 status 走査を行わずにこれを使う。
   */
  listRecent(limit: number): TaskRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(limit) as RawTaskRow[];
    return rows.map(mapTaskRow);
  }

  registerOrchestrator(input: { label: string; project: string; repoCommonDir: string }): OrchestratorRow {
    const label = input.label.trim();
    if (label.length === 0) {
      throw new Error("orchestrator label は空にできません");
    }
    const project = input.project.trim();
    const repoCommonDir = input.repoCommonDir.trim();
    const now = nowSeconds();
    const id = generateRoutingId("o");
    this.db
      .prepare(
        `INSERT INTO orchestrators (id, label, project, repo_common_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(label, project, repo_common_dir) DO NOTHING`,
      )
      .run(id, label, project, repoCommonDir, now, now);
    const registered = this.db
      .prepare(`SELECT * FROM orchestrators WHERE label = ? AND project = ? AND repo_common_dir = ?`)
      .get(label, project, repoCommonDir) as RawOrchestratorRow | undefined;
    if (registered === undefined) {
      throw new Error("orchestrator stable identity の登録結果を取得できません");
    }
    return mapOrchestratorRow(registered);
  }

  getOrchestrator(id: string): OrchestratorRow | null {
    const row = this.db.prepare(`SELECT * FROM orchestrators WHERE id = ?`).get(id) as RawOrchestratorRow | undefined;
    return row === undefined ? null : mapOrchestratorRow(row);
  }

  listOrchestrators(): OrchestratorRow[] {
    return (this.db.prepare(`SELECT * FROM orchestrators ORDER BY created_at, id`).all() as RawOrchestratorRow[]).map(mapOrchestratorRow);
  }

  private requireSuccessorLaunchRaw(id: string): RawOrchestratorSuccessorLaunchRow {
    const row = this.db.prepare(`SELECT * FROM orchestrator_successor_launches WHERE id = ?`).get(id) as
      | RawOrchestratorSuccessorLaunchRow
      | undefined;
    if (row === undefined) {
      throw new Error(`successor launch slot が見つかりません: ${id}`);
    }
    return row;
  }

  private requireSuccessorCapabilityRaw(id: string): RawOrchestratorSuccessorCapabilityRow {
    const row = this.db.prepare(`SELECT * FROM orchestrator_successor_launch_capabilities WHERE launch_id = ?`).get(id) as
      | RawOrchestratorSuccessorCapabilityRow
      | undefined;
    if (row === undefined) {
      throw new Error(`successor launch capability が見つかりません: ${id}`);
    }
    return row;
  }

  private clearSuccessorCapabilities(id: string): void {
    this.db.prepare(
      `UPDATE orchestrator_successor_launch_capabilities
       SET attestation_handle = '', accept_fence = '', stop_fence = '' WHERE launch_id = ?`,
    ).run(id);
  }

  successorReplacementGate(orchestratorId: string, excludeSlotId?: string): OrchestratorSuccessorReplacementGate {
    const row = this.db.prepare(
      `SELECT id FROM orchestrator_successor_launches
       WHERE orchestrator_id = ?
         AND status IN ('armed', 'runtime_bound', 'attested', 'accepting', 'stop_pending', 'uncertain')
         AND (? = '' OR id <> ?)
       ORDER BY created_at, id LIMIT 1`,
    ).get(orchestratorId, excludeSlotId ?? "", excludeSlotId ?? "") as { id: string } | undefined;
    return row === undefined
      ? { allowed: true, blockingSlotId: null, reason: "no-blocking-slot" }
      : { allowed: false, blockingSlotId: row.id, reason: "blocking-slot-present" };
  }

  private assertSuccessorReplacementAllowed(orchestratorId: string, excludeSlotId?: string): void {
    const gate = this.successorReplacementGate(orchestratorId, excludeSlotId);
    if (!gate.allowed) {
      throw new Error(`SUCCESSOR_REPLACEMENT_BLOCKED: blocking slot=${gate.blockingSlotId ?? "unknown"}`);
    }
  }

  private assertSuccessorSourceMutationAllowed(sessionId: string, generation: number): void {
    const blocking = this.db.prepare(
      `SELECT id FROM orchestrator_successor_launches
       WHERE source_session_id = ? AND source_generation = ?
         AND status IN ('armed', 'runtime_bound', 'attested', 'accepting', 'stop_pending', 'uncertain')
       ORDER BY created_at, id LIMIT 1`,
    ).get(sessionId, generation) as { id: string } | undefined;
    if (blocking !== undefined) {
      throw new Error(`SUCCESSOR_SOURCE_MUTATION_BLOCKED: blocking slot=${blocking.id}`);
    }
  }

  getSuccessorLaunch(id: string): OrchestratorSuccessorLaunchRow | null {
    const row = this.db.prepare(`SELECT * FROM orchestrator_successor_launches WHERE id = ?`).get(id) as
      | RawOrchestratorSuccessorLaunchRow
      | undefined;
    return row === undefined ? null : mapOrchestratorSuccessorLaunchRow(row);
  }

  listSuccessorLaunches(orchestratorId?: string): OrchestratorSuccessorLaunchRow[] {
    const rows = (orchestratorId === undefined
      ? this.db.prepare(`SELECT * FROM orchestrator_successor_launches ORDER BY created_at, id`).all()
      : this.db.prepare(
        `SELECT * FROM orchestrator_successor_launches WHERE orchestrator_id = ? ORDER BY created_at, id`,
      ).all(orchestratorId)) as RawOrchestratorSuccessorLaunchRow[];
    return rows.map(mapOrchestratorSuccessorLaunchRow);
  }

  armSuccessorLaunch(input: ArmOrchestratorSuccessorLaunchInput): OrchestratorSuccessorLaunchRow {
    const now = input.now ?? nowSeconds();
    const canonicalCwd = input.canonicalCwd.trim();
    const hostId = input.hostId.trim();
    const plannedTmuxSession = input.plannedTmuxSession.trim();
    if (!isAbsolute(canonicalCwd) || hostId === "" || plannedTmuxSession === "") {
      throw new Error("successor launch の canonical cwd/host/planned tmux session が不正です");
    }
    for (const [value, label] of [
      [input.launchNonceHash, "launch nonce hash"],
      [input.hookDefinitionHash, "hook definition hash"],
      [input.hookExecutableHash, "hook executable hash"],
    ] as const) {
      if (!SHA256_HEX.test(value)) throw new Error(`${label} は SHA-256 hex が必須です`);
    }
    if (!Number.isInteger(input.runtimeDeadlineAt) || !Number.isInteger(input.attestationDeadlineAt) ||
        input.runtimeDeadlineAt <= now || input.attestationDeadlineAt <= now) {
      throw new Error("successor launch deadline は現在より後のepoch秒が必須です");
    }
    if (input.runtimeDeadlineAt >= input.attestationDeadlineAt) {
      throw new Error("successor launch runtime deadline は attestation deadline より前が必須です");
    }
    if (input.kind === "handoff" &&
        (!SHA256_HEX.test(input.handoffTokenFenceHash) || input.handoffExpiresAt <= now)) {
      throw new Error("handoff token fence/expiry が不正です");
    }
    if (input.kind === "takeover" && !Number.isInteger(input.staleBefore)) {
      throw new Error("takeover stale cutoff は整数epoch秒が必須です");
    }

    const exec = this.db.transaction((): OrchestratorSuccessorLaunchRow => {
      if (this.getOrchestrator(input.orchestratorId) === null) {
        throw new Error(`orchestrator が見つかりません: ${input.orchestratorId}`);
      }
      this.assertSuccessorReplacementAllowed(input.orchestratorId);
      const source = this.db.prepare(
        `SELECT * FROM orchestrator_sessions WHERE id = ? AND orchestrator_id = ? AND generation = ?`,
      ).get(input.sourceSessionId, input.orchestratorId, input.sourceGeneration) as
        | RawOrchestratorSessionRow
        | undefined;
      if (source === undefined) {
        throw new Error("successor launch source session/generation/stable identity が一致しません");
      }
      if (input.kind === "handoff" && source.status !== "active") {
        throw new Error("handoff successor launch source は active session が必須です");
      }
      if (input.kind === "takeover" &&
          (!["active", "handoff_pending"].includes(source.status) || source.heartbeat_at >= input.staleBefore)) {
        throw new Error("takeover successor launch source は保存cutoffより前の stale session が必須です");
      }

      const id = generateRoutingId("osl");
      this.db.prepare(
        `INSERT INTO orchestrator_successor_launches (
           id, orchestrator_id, kind, target_provider, source_session_id, source_generation,
           canonical_cwd, host_id, launch_nonce_hash, planned_tmux_session,
           hook_definition_hash, hook_executable_hash, handoff_token_fence_hash, handoff_expires_at,
           takeover_stale_before, runtime_deadline_at, attestation_deadline_at,
           status, revision, created_at, updated_at
         ) VALUES (
           @id, @orchestratorId, @kind, @targetProvider, @sourceSessionId, @sourceGeneration,
           @canonicalCwd, @hostId, @launchNonceHash, @plannedTmuxSession,
           @hookDefinitionHash, @hookExecutableHash, @handoffTokenFenceHash, @handoffExpiresAt,
           @takeoverStaleBefore, @runtimeDeadlineAt, @attestationDeadlineAt,
           'armed', 1, @now, @now
         )`,
      ).run({
        id,
        orchestratorId: input.orchestratorId,
        kind: input.kind,
        targetProvider: input.targetProvider,
        sourceSessionId: input.sourceSessionId,
        sourceGeneration: input.sourceGeneration,
        canonicalCwd,
        hostId,
        launchNonceHash: input.launchNonceHash,
        plannedTmuxSession,
        hookDefinitionHash: input.hookDefinitionHash,
        hookExecutableHash: input.hookExecutableHash,
        handoffTokenFenceHash: input.kind === "handoff" ? input.handoffTokenFenceHash : "",
        handoffExpiresAt: input.kind === "handoff" ? input.handoffExpiresAt : null,
        takeoverStaleBefore: input.kind === "takeover" ? input.staleBefore : null,
        runtimeDeadlineAt: input.runtimeDeadlineAt,
        attestationDeadlineAt: input.attestationDeadlineAt,
        now,
      });
      this.db.prepare(
        `INSERT INTO orchestrator_successor_launch_capabilities (launch_id) VALUES (?)`,
      ).run(id);
      if (input.kind === "handoff") {
        const handoff = this.db.prepare(
          `UPDATE orchestrator_sessions
           SET status = 'handoff_pending', handoff_token_hash = ?, handoff_expires_at = ?, updated_at = ?
           WHERE id = ? AND orchestrator_id = ? AND generation = ? AND status = 'active'`,
        ).run(
          input.handoffTokenFenceHash,
          input.handoffExpiresAt,
          now,
          input.sourceSessionId,
          input.orchestratorId,
          input.sourceGeneration,
        );
        if (handoff.changes !== 1) {
          throw new Error("handoff successor launch の source transition CAS に失敗しました");
        }
      }
      return mapOrchestratorSuccessorLaunchRow(this.requireSuccessorLaunchRaw(id));
    });
    return exec();
  }

  resolveUnboundSuccessorLaunch(
    input: ResolveUnboundOrchestratorSuccessorLaunchInput,
  ): OrchestratorSuccessorLaunchRow {
    const now = input.now ?? nowSeconds();
    const error = redactText(input.error.trim());
    if (error === "") throw new Error("unbound successor launch の error は必須です");
    const exec = this.db.transaction((): OrchestratorSuccessorLaunchRow => {
      const row = this.requireSuccessorLaunchRaw(input.slotId);
      if (row.status !== "armed" || row.revision !== input.expectedRevision ||
          row.barrier_release_authorized_at !== null) {
        throw new Error("unbound successor launch の armed/revision/barrier CAS に失敗しました");
      }
      if (input.to === "expired" && row.runtime_deadline_at >= now) {
        throw new Error("unbound successor launch は runtime deadline 前に expired 化できません");
      }
      if (row.kind === "handoff") {
        const restored = this.db.prepare(
          `UPDATE orchestrator_sessions
           SET status = 'active', handoff_token_hash = '', handoff_expires_at = NULL,
               heartbeat_at = ?, updated_at = ?
           WHERE id = ? AND orchestrator_id = ? AND generation = ? AND status = 'handoff_pending'
             AND handoff_token_hash = ?`,
        ).run(
          now,
          now,
          row.source_session_id,
          row.orchestrator_id,
          row.source_generation,
          row.handoff_token_fence_hash,
        );
        if (restored.changes !== 1) {
          throw new Error("unbound handoff rollback の source/token fence CAS に失敗しました");
        }
      }
      const info = this.db.prepare(
        `UPDATE orchestrator_successor_launches
         SET status = ?, runtime_ownership_claimed = 0, last_error = ?,
             revision = revision + 1, updated_at = ?, terminal_at = ?
         WHERE id = ? AND status = 'armed' AND revision = ? AND barrier_release_authorized_at IS NULL`,
      ).run(input.to, error, now, now, row.id, input.expectedRevision);
      if (info.changes !== 1) throw new Error("unbound successor launch terminal CAS に失敗しました");
      this.clearSuccessorCapabilities(row.id);
      return mapOrchestratorSuccessorLaunchRow(this.requireSuccessorLaunchRaw(row.id));
    });
    return exec();
  }

  markArmedSuccessorLaunchStopPending(
    input: MarkArmedOrchestratorSuccessorStopPendingInput,
  ): MarkOrchestratorSuccessorStopPendingResult {
    const now = input.now ?? nowSeconds();
    const error = redactText(input.error.trim());
    if (error === "") throw new Error("armed successor stop pending の error は必須です");
    if ((input.observedCanonicalCwd !== null && !isAbsolute(input.observedCanonicalCwd)) ||
        (input.observedHostId !== null && input.observedHostId.trim() === "") ||
        (input.tmuxSession !== null && input.tmuxSession.trim() === "") ||
        (input.tmuxPane !== null && !/^%[0-9]+$/.test(input.tmuxPane)) ||
        (input.panePid !== null && (!Number.isInteger(input.panePid) || input.panePid <= 0)) ||
        (input.processGroupId !== null &&
          (!Number.isInteger(input.processGroupId) || input.processGroupId <= 0)) ||
        (input.tmuxSocketPath !== null &&
          (!isAbsolute(input.tmuxSocketPath) || input.tmuxSocketPath.trim() !== input.tmuxSocketPath)) ||
        (input.tmuxServerPid !== null &&
          (!Number.isInteger(input.tmuxServerPid) || input.tmuxServerPid <= 0)) ||
        (input.tmuxServerStartTime !== null &&
          (!Number.isInteger(input.tmuxServerStartTime) || input.tmuxServerStartTime <= 0))) {
      throw new Error("armed successor partial runtime identity が不正です");
    }
    for (const [value, label] of [
      [input.tmuxServerLifetimeHash, "partial tmux server lifetime hash"],
      [input.ownerNonceHash, "partial owner nonce hash"],
      [input.observedHookDefinitionHash, "partial hook definition hash"],
      [input.observedHookExecutableHash, "partial hook executable hash"],
    ] as const) {
      if (value !== null && !SHA256_HEX.test(value)) {
        throw new Error(`${label} は SHA-256 hex が必須です`);
      }
    }
    const stopFence = randomBytes(32).toString("base64url");
    const stopFenceHash = sha256Hex(stopFence);
    const exec = this.db.transaction((): MarkOrchestratorSuccessorStopPendingResult => {
      const row = this.requireSuccessorLaunchRaw(input.slotId);
      if (row.status !== "armed" || row.revision !== input.expectedRevision ||
          row.barrier_release_authorized_at !== null) {
        throw new Error("armed successor stop pending の status/revision/barrier CAS に失敗しました");
      }
      const observedHostId = input.observedHostId ?? "";
      const tmuxPane = input.tmuxPane ?? "";
      const tmuxSocketPath = input.tmuxSocketPath ?? "";
      const tmuxServerLifetimeHash = input.tmuxServerLifetimeHash ?? "";
      const hasRuntimeAuthority = observedHostId !== "" && tmuxSocketPath !== "" &&
        tmuxServerLifetimeHash !== "" && tmuxPane !== "";
      const conflictingOwner = !hasRuntimeAuthority
        ? undefined
        : this.db.prepare(
          `SELECT id FROM orchestrator_successor_launches
           WHERE id <> ? AND runtime_ownership_claimed = 1
             AND observed_host_id = ? AND tmux_socket_path = ?
             AND tmux_server_lifetime_hash = ? AND tmux_pane = ?
             AND status IN ('runtime_bound', 'attested', 'accepting', 'stop_pending', 'uncertain')
           LIMIT 1`,
        ).get(row.id, observedHostId, tmuxSocketPath, tmuxServerLifetimeHash, tmuxPane) as
          | { id: string }
          | undefined;
      const legacyConflictingOwner = observedHostId === "" || tmuxPane === ""
        ? undefined
        : this.db.prepare(
          `SELECT id FROM orchestrator_successor_launches
           WHERE id <> ? AND runtime_ownership_claimed = 1
             AND observed_host_id = ? AND tmux_pane = ? AND tmux_server_lifetime_hash = ''
             AND status IN ('runtime_bound', 'attested', 'accepting', 'stop_pending', 'uncertain')
           LIMIT 1`,
        ).get(row.id, observedHostId, tmuxPane) as { id: string } | undefined;
      // 衝突 readback は証拠として保持するが、既存 owner の reservation を奪わない。
      const runtimeOwnershipClaimed = hasRuntimeAuthority && conflictingOwner === undefined &&
        legacyConflictingOwner === undefined ? 1 : 0;
      const info = this.db.prepare(
        `UPDATE orchestrator_successor_launches
         SET observed_canonical_cwd = ?, observed_host_id = ?, tmux_session = ?, tmux_pane = ?,
             pane_pid = ?, process_group_id = ?, tmux_socket_path = ?, tmux_server_pid = ?,
             tmux_server_start_time = ?, tmux_server_lifetime_hash = ?, owner_nonce_hash = ?,
             runtime_ownership_claimed = ?,
             observed_hook_definition_hash = ?, observed_hook_executable_hash = ?,
             stop_fence_hash = ?, status = 'stop_pending', last_error = ?,
             revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'armed' AND revision = ? AND barrier_release_authorized_at IS NULL`,
      ).run(
        input.observedCanonicalCwd ?? "",
        observedHostId,
        input.tmuxSession ?? "",
        tmuxPane,
        input.panePid,
        input.processGroupId,
        tmuxSocketPath,
        input.tmuxServerPid,
        input.tmuxServerStartTime,
        tmuxServerLifetimeHash,
        input.ownerNonceHash ?? "",
        runtimeOwnershipClaimed,
        input.observedHookDefinitionHash ?? "",
        input.observedHookExecutableHash ?? "",
        stopFenceHash,
        error,
        now,
        row.id,
        input.expectedRevision,
      );
      if (info.changes !== 1) throw new Error("armed successor stop pending CAS に失敗しました");
      this.db.prepare(
        `UPDATE orchestrator_successor_launch_capabilities SET stop_fence = ? WHERE launch_id = ?`,
      ).run(stopFence, row.id);
      return { launch: mapOrchestratorSuccessorLaunchRow(this.requireSuccessorLaunchRaw(row.id)), stopFence };
    });
    return exec();
  }

  bindSuccessorLaunchRuntime(input: BindOrchestratorSuccessorRuntimeInput): OrchestratorSuccessorLaunchRow {
    const now = input.now ?? nowSeconds();
    if (!Number.isInteger(input.panePid) || input.panePid <= 0 ||
        !Number.isInteger(input.processGroupId) || input.processGroupId <= 0 ||
        !isAbsolute(input.tmuxSocketPath) || input.tmuxSocketPath.trim() !== input.tmuxSocketPath ||
        !Number.isInteger(input.tmuxServerPid) || input.tmuxServerPid <= 0 ||
        !Number.isInteger(input.tmuxServerStartTime) || input.tmuxServerStartTime <= 0 ||
        !/^%[0-9]+$/.test(input.tmuxPane)) {
      throw new Error("successor runtime tmux identity/PID/PGID が不正です");
    }
    for (const [value, label] of [
      [input.tmuxServerLifetimeHash, "tmux server lifetime hash"],
      [input.ownerNonceHash, "owner nonce hash"],
      [input.hookDefinitionHash, "observed hook definition hash"],
      [input.hookExecutableHash, "observed hook executable hash"],
    ] as const) {
      if (!SHA256_HEX.test(value)) throw new Error(`${label} は SHA-256 hex が必須です`);
    }
    const exec = this.db.transaction((): OrchestratorSuccessorLaunchRow => {
      const row = this.requireSuccessorLaunchRaw(input.slotId);
      if (row.status !== "armed" || row.revision !== input.expectedRevision ||
          row.barrier_release_authorized_at !== null || row.runtime_deadline_at < now) {
        throw new Error("successor runtime bind の status/revision/deadline CAS に失敗しました");
      }
      if (input.observedCanonicalCwd !== row.canonical_cwd || input.observedHostId !== row.host_id ||
          input.tmuxSession !== row.planned_tmux_session ||
          input.hookDefinitionHash !== row.hook_definition_hash ||
          input.hookExecutableHash !== row.hook_executable_hash) {
        throw new Error("successor runtime bind の expected/observed identity が一致しません");
      }
      const conflictingOwner = this.db.prepare(
        `SELECT id FROM orchestrator_successor_launches
         WHERE id <> ? AND runtime_ownership_claimed = 1 AND observed_host_id = ? AND tmux_pane = ?
           AND status IN ('runtime_bound', 'attested', 'accepting', 'stop_pending', 'uncertain')
           AND (
             tmux_server_lifetime_hash = '' OR
             (tmux_socket_path = ? AND tmux_server_lifetime_hash = ?)
           )
         LIMIT 1`,
      ).get(
        row.id,
        input.observedHostId,
        input.tmuxPane,
        input.tmuxSocketPath,
        input.tmuxServerLifetimeHash,
      );
      if (conflictingOwner !== undefined) {
        throw new Error("SUCCESSOR_RUNTIME_COLLISION: exactまたはlegacy runtime ownerが存在します");
      }
      const info = this.db.prepare(
        `UPDATE orchestrator_successor_launches
         SET observed_canonical_cwd = ?, observed_host_id = ?, tmux_session = ?, tmux_pane = ?,
             pane_pid = ?, process_group_id = ?, tmux_socket_path = ?, tmux_server_pid = ?,
             tmux_server_start_time = ?, tmux_server_lifetime_hash = ?, owner_nonce_hash = ?,
             runtime_ownership_claimed = 1,
             observed_hook_definition_hash = ?, observed_hook_executable_hash = ?, runtime_bound_at = ?,
             barrier_release_authorized_at = ?, status = 'runtime_bound', revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'armed' AND revision = ? AND barrier_release_authorized_at IS NULL
           AND runtime_deadline_at >= ?`,
      ).run(
        input.observedCanonicalCwd,
        input.observedHostId,
        input.tmuxSession,
        input.tmuxPane,
        input.panePid,
        input.processGroupId,
        input.tmuxSocketPath,
        input.tmuxServerPid,
        input.tmuxServerStartTime,
        input.tmuxServerLifetimeHash,
        input.ownerNonceHash,
        input.hookDefinitionHash,
        input.hookExecutableHash,
        now,
        now,
        now,
        row.id,
        input.expectedRevision,
        now,
      );
      if (info.changes !== 1) throw new Error("successor runtime bind CAS に失敗しました");
      return mapOrchestratorSuccessorLaunchRow(this.requireSuccessorLaunchRaw(row.id));
    });
    return exec();
  }

  private successorRuntimeIdentityMatches(
    row: RawOrchestratorSuccessorLaunchRow,
    input: AttestOrchestratorSuccessorLaunchInput,
  ): boolean {
    return row.canonical_cwd === input.canonicalCwd && row.observed_canonical_cwd === input.canonicalCwd &&
      row.host_id === input.hostId && row.observed_host_id === input.hostId &&
      row.tmux_session === input.tmuxSession && row.tmux_session === row.planned_tmux_session &&
      row.tmux_pane === input.tmuxPane && row.pane_pid === input.panePid &&
      row.process_group_id === input.processGroupId && row.tmux_socket_path === input.tmuxSocketPath &&
      row.tmux_server_pid === input.tmuxServerPid &&
      row.tmux_server_start_time === input.tmuxServerStartTime &&
      row.tmux_server_lifetime_hash === input.tmuxServerLifetimeHash &&
      row.owner_nonce_hash === input.ownerNonceHash &&
      row.hook_definition_hash === input.hookDefinitionHash &&
      row.observed_hook_definition_hash === input.hookDefinitionHash &&
      row.hook_executable_hash === input.hookExecutableHash &&
      row.observed_hook_executable_hash === input.hookExecutableHash;
  }

  private successorTrustedProviderPair(row: RawOrchestratorSuccessorLaunchRow): boolean {
    return (row.target_provider === "codex" && row.provider_session_source === "codex-session-start") ||
      (row.target_provider === "claude" && row.provider_session_source === "claude-delivery");
  }

  attestSuccessorLaunch(
    input: AttestOrchestratorSuccessorLaunchInput,
  ): AttestOrchestratorSuccessorLaunchResult | null {
    const now = input.now ?? nowSeconds();
    if (input.providerSessionId.trim() === "" || !isAbsolute(input.canonicalCwd) ||
        input.hostId.trim() === "" || !/^%[0-9]+$/.test(input.tmuxPane) ||
        !Number.isInteger(input.panePid) || input.panePid <= 0 ||
        !Number.isInteger(input.processGroupId) || input.processGroupId <= 0 ||
        !isAbsolute(input.tmuxSocketPath) || input.tmuxSocketPath.trim() !== input.tmuxSocketPath ||
        !Number.isInteger(input.tmuxServerPid) || input.tmuxServerPid <= 0 ||
        !Number.isInteger(input.tmuxServerStartTime) || input.tmuxServerStartTime <= 0 ||
        !SHA256_HEX.test(input.tmuxServerLifetimeHash)) {
      return null;
    }
    if (input.providerSessionSource === "codex-session-start" &&
        (input.source === "compact" || input.source === "clear")) {
      return null;
    }
    const expectedProvider: Provider = input.providerSessionSource === "codex-session-start" ? "codex" : "claude";
    const exec = this.db.transaction((): AttestOrchestratorSuccessorLaunchResult | null => {
      if (input.providerSessionSource === "codex-session-start" && input.source === "resume") {
        const candidates = this.db.prepare(
          `SELECT * FROM orchestrator_successor_launches
           WHERE target_provider = 'codex' AND provider_session_source = 'codex-session-start'
             AND provider_session_id = ? AND status IN ('attested', 'accepting')`,
        ).all(input.providerSessionId) as RawOrchestratorSuccessorLaunchRow[];
        const exact = candidates.filter((row) => this.successorRuntimeIdentityMatches(row, input));
        if (exact.length !== 1) return null;
        const row = exact[0]!;
        if (row.attestation_consumed_at !== null || row.attestation_expires_at === null ||
            row.attestation_expires_at < now) return null;
        const capability = this.requireSuccessorCapabilityRaw(row.id);
        if (capability.attestation_handle === "" ||
            sha256Hex(capability.attestation_handle) !== row.attestation_handle_hash) return null;
        return { launch: mapOrchestratorSuccessorLaunchRow(row), attestationHandle: capability.attestation_handle };
      }

      const candidates = this.db.prepare(
        `SELECT * FROM orchestrator_successor_launches
         WHERE target_provider = ? AND status = 'runtime_bound' AND attestation_deadline_at >= ?`,
      ).all(expectedProvider, now) as RawOrchestratorSuccessorLaunchRow[];
      const exact = candidates.filter((row) => this.successorRuntimeIdentityMatches(row, input));
      if (exact.length !== 1) return null;
      const row = exact[0]!;
      if ((input.providerSessionSource === "codex-session-start" && input.source !== "startup") ||
          (input.providerSessionSource === "claude-delivery" && input.source !== "delivery")) return null;
      const usedSession = this.db.prepare(
        `SELECT id FROM orchestrator_sessions WHERE provider = ? AND provider_session_id = ? LIMIT 1`,
      ).get(expectedProvider, input.providerSessionId);
      const usedLaunch = this.db.prepare(
        `SELECT id FROM orchestrator_successor_launches
         WHERE target_provider = ? AND provider_session_id = ? AND id <> ? LIMIT 1`,
      ).get(expectedProvider, input.providerSessionId, row.id);
      if (usedSession !== undefined || usedLaunch !== undefined) return null;

      const attestationHandle = randomBytes(32).toString("base64url");
      const handleHash = sha256Hex(attestationHandle);
      const info = this.db.prepare(
        `UPDATE orchestrator_successor_launches
         SET provider_session_source = ?, provider_session_id = ?, attestation_handle_hash = ?,
             attestation_issued_at = ?, attestation_expires_at = ?,
             status = 'attested', revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'runtime_bound' AND revision = ? AND attestation_deadline_at >= ?`,
      ).run(
        input.providerSessionSource,
        input.providerSessionId,
        handleHash,
        now,
        now + SUCCESSOR_ATTESTATION_TTL_SECONDS,
        now,
        row.id,
        row.revision,
        now,
      );
      if (info.changes !== 1) return null;
      this.db.prepare(
        `UPDATE orchestrator_successor_launch_capabilities SET attestation_handle = ? WHERE launch_id = ?`,
      ).run(attestationHandle, row.id);
      return {
        launch: mapOrchestratorSuccessorLaunchRow(this.requireSuccessorLaunchRaw(row.id)),
        attestationHandle,
      };
    });
    try {
      return exec();
    } catch (error) {
      if (error instanceof Database.SqliteError && error.code.startsWith("SQLITE_CONSTRAINT")) return null;
      throw error;
    }
  }

  private transitionSuccessorToStopPendingRaw(input: {
    row: RawOrchestratorSuccessorLaunchRow;
    now: number;
    error: string;
    replacementHandoffTokenHash?: string;
  }): MarkOrchestratorSuccessorStopPendingResult {
    if (input.row.status === "stop_pending" || input.row.status === "uncertain") {
      const capability = this.requireSuccessorCapabilityRaw(input.row.id);
      if (capability.stop_fence === "" || sha256Hex(capability.stop_fence) !== input.row.stop_fence_hash) {
        throw new Error("successor stop fence capability が欠落または不一致です");
      }
      return { launch: mapOrchestratorSuccessorLaunchRow(input.row), stopFence: capability.stop_fence };
    }
    const stopFence = randomBytes(32).toString("base64url");
    const stopFenceHash = sha256Hex(stopFence);
    let handoffTokenFenceHash = input.row.handoff_token_fence_hash;
    if (input.row.kind === "handoff" && input.replacementHandoffTokenHash !== undefined) {
      if (!SHA256_HEX.test(input.replacementHandoffTokenHash)) {
        throw new Error("replacement handoff token hash は SHA-256 hex が必須です");
      }
      const fenced = this.db.prepare(
        `UPDATE orchestrator_sessions SET handoff_token_hash = ?, updated_at = ?
         WHERE id = ? AND orchestrator_id = ? AND generation = ? AND status = 'handoff_pending'
           AND handoff_token_hash = ?`,
      ).run(
        input.replacementHandoffTokenHash,
        input.now,
        input.row.source_session_id,
        input.row.orchestrator_id,
        input.row.source_generation,
        input.row.handoff_token_fence_hash,
      );
      if (fenced.changes !== 1) {
        throw new Error("successor stop pending の handoff token fence CAS に失敗しました");
      }
      handoffTokenFenceHash = input.replacementHandoffTokenHash;
    }
    const info = this.db.prepare(
      `UPDATE orchestrator_successor_launches
       SET status = 'stop_pending', stop_fence_hash = ?, handoff_token_fence_hash = ?,
           last_error = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND status = ? AND revision = ?`,
    ).run(
      stopFenceHash,
      handoffTokenFenceHash,
      input.error,
      input.now,
      input.row.id,
      input.row.status,
      input.row.revision,
    );
    if (info.changes !== 1) throw new Error("successor stop pending CAS に失敗しました");
    this.db.prepare(
      `UPDATE orchestrator_successor_launch_capabilities SET stop_fence = ? WHERE launch_id = ?`,
    ).run(stopFence, input.row.id);
    return {
      launch: mapOrchestratorSuccessorLaunchRow(this.requireSuccessorLaunchRaw(input.row.id)),
      stopFence,
    };
  }

  claimSuccessorLaunchAccept(
    input: ClaimOrchestratorSuccessorAcceptInput,
  ): ClaimOrchestratorSuccessorAcceptResult {
    const now = input.now ?? nowSeconds();
    if (!SHA256_HEX.test(input.attestationHandleHash)) {
      throw new Error("attestation handle hash は SHA-256 hex が必須です");
    }
    const exec = this.db.transaction((): { result: ClaimOrchestratorSuccessorAcceptResult | null; error: string } => {
      const row = this.requireSuccessorLaunchRaw(input.slotId);
      if (row.revision !== input.expectedRevision || row.kind !== input.operation ||
          row.attestation_handle_hash !== input.attestationHandleHash) {
        throw new Error("successor accept claim の slot/revision/handle/operation が一致しません");
      }
      const capability = this.requireSuccessorCapabilityRaw(row.id);
      if (capability.attestation_handle === "" ||
          sha256Hex(capability.attestation_handle) !== input.attestationHandleHash) {
        throw new Error("successor accept claim の raw attestation capability が一致しません");
      }
      if (row.status === "accepting") {
        if (capability.accept_fence === "" || sha256Hex(capability.accept_fence) !== row.accept_fence_hash) {
          throw new Error("successor accept fence capability が欠落または不一致です");
        }
        return {
          result: { launch: mapOrchestratorSuccessorLaunchRow(row), acceptFence: capability.accept_fence },
          error: "",
        };
      }
      if (row.status !== "attested" || !this.successorTrustedProviderPair(row)) {
        throw new Error("successor accept claim は trusted attested slot が必須です");
      }
      if (row.attestation_expires_at === null || row.attestation_expires_at < now) {
        this.transitionSuccessorToStopPendingRaw({
          row,
          now,
          error: "attestation TTL が期限切れです",
          ...(row.kind === "handoff" ? { replacementHandoffTokenHash: sha256Hex(randomBytes(32).toString("base64url")) } : {}),
        });
        return { result: null, error: "attestation TTL が期限切れです" };
      }
      const acceptFence = randomBytes(32).toString("base64url");
      const acceptFenceHash = sha256Hex(acceptFence);
      const info = this.db.prepare(
        `UPDATE orchestrator_successor_launches
         SET status = 'accepting', accept_fence_hash = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'attested' AND revision = ? AND attestation_handle_hash = ?
           AND attestation_expires_at >= ?`,
      ).run(acceptFenceHash, now, row.id, row.revision, input.attestationHandleHash, now);
      if (info.changes !== 1) throw new Error("successor accept claim CAS に失敗しました");
      this.db.prepare(
        `UPDATE orchestrator_successor_launch_capabilities SET accept_fence = ? WHERE launch_id = ?`,
      ).run(acceptFence, row.id);
      return {
        result: {
          launch: mapOrchestratorSuccessorLaunchRow(this.requireSuccessorLaunchRaw(row.id)),
          acceptFence,
        },
        error: "",
      };
    });
    const outcome = exec();
    if (outcome.result === null) throw new Error(outcome.error);
    return outcome.result;
  }

  private assertSuccessorFinalCommon(input: {
    row: RawOrchestratorSuccessorLaunchRow;
    expectedRevision: number;
    acceptFenceHash: string;
    attestationHandleHash: string;
    now: number;
  }): RawOrchestratorSuccessorCapabilityRow {
    const row = input.row;
    this.assertSuccessorFinalRequest(input);
    if (row.attestation_consumed_at !== null || row.attestation_expires_at === null ||
        row.attestation_expires_at < input.now || !this.successorTrustedProviderPair(row)) {
      throw new Error("successor final の attestation/provider state が一致しません");
    }
    const capability = this.requireSuccessorCapabilityRaw(row.id);
    if (capability.attestation_handle === "" || capability.accept_fence === "" ||
        sha256Hex(capability.attestation_handle) !== input.attestationHandleHash ||
        sha256Hex(capability.accept_fence) !== input.acceptFenceHash) {
      throw new Error("successor final の owner-only capability が一致しません");
    }
    if (row.canonical_cwd === "" || row.canonical_cwd !== row.observed_canonical_cwd ||
        row.host_id === "" || row.host_id !== row.observed_host_id ||
        row.tmux_session === "" || row.tmux_session !== row.planned_tmux_session || row.tmux_pane === "" ||
        row.pane_pid === null || row.process_group_id === null || row.owner_nonce_hash === "" ||
        row.runtime_ownership_claimed !== 1 || !isAbsolute(row.tmux_socket_path) ||
        row.tmux_server_pid === null || row.tmux_server_pid <= 0 ||
        row.tmux_server_start_time === null || row.tmux_server_start_time <= 0 ||
        !SHA256_HEX.test(row.tmux_server_lifetime_hash) ||
        row.hook_definition_hash !== row.observed_hook_definition_hash ||
        row.hook_executable_hash !== row.observed_hook_executable_hash || row.provider_session_id === "") {
      throw new Error("successor final の exact runtime identity が不完全またはdriftしています");
    }
    const source = this.db.prepare(
      `SELECT id FROM orchestrator_sessions
       WHERE id = ? AND orchestrator_id = ? AND generation = ?`,
    ).get(row.source_session_id, row.orchestrator_id, row.source_generation);
    if (source === undefined) throw new Error("successor final の source identity が一致しません");
    this.assertSuccessorReplacementAllowed(row.orchestrator_id, row.id);
    const alreadyUsed = this.db.prepare(
      `SELECT id FROM orchestrator_sessions WHERE provider = ? AND provider_session_id = ? LIMIT 1`,
    ).get(row.target_provider, row.provider_session_id);
    if (alreadyUsed !== undefined) throw new Error("successor final の provider session ID は使用済みです");
    return capability;
  }

  private assertSuccessorFinalRequest(input: {
    row: RawOrchestratorSuccessorLaunchRow;
    expectedRevision: number;
    acceptFenceHash: string;
    attestationHandleHash: string;
    now: number;
  }): void {
    const row = input.row;
    if (row.status !== "accepting" || row.revision !== input.expectedRevision ||
        row.accept_fence_hash !== input.acceptFenceHash ||
        row.attestation_handle_hash !== input.attestationHandleHash) {
      throw new Error("successor final request の status/revision/fence/attestation が一致しません");
    }
  }

  private finalizeSuccessorFailure(row: RawOrchestratorSuccessorLaunchRow, now: number, error: unknown): void {
    const message = redactText(error instanceof Error ? error.message : String(error));
    const replacement = row.kind === "handoff" ? sha256Hex(randomBytes(32).toString("base64url")) : undefined;
    try {
      this.transitionSuccessorToStopPendingRaw({
        row,
        now,
        error: message === "" ? "successor final に失敗しました" : message,
        ...(replacement === undefined ? {} : { replacementHandoffTokenHash: replacement }),
      });
    } catch {
      // source token が既にdriftした場合でも slot 自体は blocking の stop_pending へ固定する。
      const stopFence = randomBytes(32).toString("base64url");
      const info = this.db.prepare(
        `UPDATE orchestrator_successor_launches
         SET status = 'stop_pending', stop_fence_hash = ?, last_error = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'accepting' AND revision = ?`,
      ).run(sha256Hex(stopFence), message, now, row.id, row.revision);
      if (info.changes !== 1) throw error;
      this.db.prepare(
        `UPDATE orchestrator_successor_launch_capabilities SET stop_fence = ? WHERE launch_id = ?`,
      ).run(stopFence, row.id);
    }
  }

  acceptOrchestratorHandoffWithSuccessorLaunch(
    input: FinalizeOrchestratorSuccessorHandoffInput,
  ): OrchestratorSessionRow {
    const now = input.now ?? nowSeconds();
    if (!SHA256_HEX.test(input.acceptFenceHash) || !SHA256_HEX.test(input.attestationHandleHash) ||
        !SHA256_HEX.test(input.handoffTokenHash)) {
      throw new Error("successor handoff final の fence/hash は SHA-256 hex が必須です");
    }
    const exec = this.db.transaction((): { session: OrchestratorSessionRow | null; error: string } => {
      const row = this.requireSuccessorLaunchRaw(input.slotId);
      if (row.status === "succeeded" && row.successor_session_id !== "" && row.kind === "handoff" &&
          row.revision === input.expectedRevision + 1 && row.accept_fence_hash === input.acceptFenceHash &&
          row.attestation_handle_hash === input.attestationHandleHash &&
          row.handoff_token_fence_hash === input.handoffTokenHash) {
        const succeeded = this.getOrchestratorSession(row.successor_session_id);
        if (succeeded !== null) return { session: succeeded, error: "" };
      }
      if (row.kind !== "handoff") throw new Error("successor handoff final の slot kind が一致しません");
      this.assertSuccessorFinalRequest({
        row,
        expectedRevision: input.expectedRevision,
        acceptFenceHash: input.acceptFenceHash,
        attestationHandleHash: input.attestationHandleHash,
        now,
      });
      if (row.handoff_token_fence_hash !== input.handoffTokenHash) {
        throw new Error("successor handoff final の token fence が不一致です");
      }
      try {
        const apply = this.db.transaction((): OrchestratorSessionRow => {
          if (row.handoff_expires_at === null || row.handoff_expires_at < now) {
            throw new Error("successor handoff final の token fence が期限切れです");
          }
          this.assertSuccessorFinalCommon({
          row,
          expectedRevision: input.expectedRevision,
          acceptFenceHash: input.acceptFenceHash,
          attestationHandleHash: input.attestationHandleHash,
          now,
        });
        const old = this.db.prepare(
          `SELECT * FROM orchestrator_sessions
           WHERE id = ? AND orchestrator_id = ? AND generation = ? AND status = 'handoff_pending'
             AND handoff_token_hash = ? AND handoff_expires_at >= ?`,
        ).get(
          row.source_session_id,
          row.orchestrator_id,
          row.source_generation,
          input.handoffTokenHash,
          now,
        ) as RawOrchestratorSessionRow | undefined;
        if (old === undefined) throw new Error("successor handoff final の source/token/generation がdriftしました");

        const superseded = this.db.prepare(
          `UPDATE orchestrator_sessions SET status = 'superseded', updated_at = ?
           WHERE id = ? AND orchestrator_id = ? AND generation = ? AND status = 'handoff_pending'
             AND handoff_token_hash = ? AND handoff_expires_at >= ?`,
        ).run(now, old.id, old.orchestrator_id, old.generation, input.handoffTokenHash, now);
        if (superseded.changes !== 1) throw new Error("successor handoff final の source CAS に失敗しました");
        const next = this.insertOrchestratorSession({
          orchestratorId: old.orchestrator_id,
          provider: row.target_provider as Provider,
          providerSessionId: row.provider_session_id,
          providerSessionSource: row.provider_session_source as ProviderSessionSource,
          now,
        });
        this.db.prepare(
          `UPDATE orchestrator_requests
           SET claimant_session_id = ?, claimant_generation = ?, updated_at = ?
           WHERE claimant_session_id = ? AND claimant_generation = ? AND status IN ('claimed', 'answering')`,
        ).run(next.id, next.generation, now, old.id, old.generation);
        this.transferRuntimeCleanupClaims({
          previousSessionId: old.id,
          previousGeneration: old.generation,
          nextSessionId: next.id,
          nextGeneration: next.generation,
          actor: old.orchestrator_id,
          now,
        });
        this.transferHumanDecisionClaims({
          orchestratorId: old.orchestrator_id,
          previousSessionId: old.id,
          previousGeneration: old.generation,
          nextSessionId: next.id,
          nextGeneration: next.generation,
          now,
        });
        this.db.prepare(
          `UPDATE runtime_cleanup_deliveries
           SET status = 'dismissed', updated_at = ?
           WHERE orchestrator_id <> ? AND status = 'pending' AND request_id IN (
             SELECT r.id FROM runtime_cleanup_requests r
             JOIN runtime_resource_leases l ON l.id = r.lease_id
             WHERE l.controller_orchestrator_id = ? AND r.decision_class = 'orchestrator'
               AND r.status IN ('queued', 'delivered')
           )`,
        ).run(now, old.orchestrator_id, old.orchestrator_id);
        const completed = this.db.prepare(
          `UPDATE orchestrator_successor_launches
           SET attestation_consumed_at = ?, successor_session_id = ?, successor_generation = ?,
               status = 'succeeded', runtime_ownership_claimed = 0,
               revision = revision + 1, updated_at = ?, terminal_at = ?
           WHERE id = ? AND status = 'accepting' AND revision = ? AND accept_fence_hash = ?
             AND attestation_handle_hash = ?`,
        ).run(
          now,
          next.id,
          next.generation,
          now,
          now,
          row.id,
          input.expectedRevision,
          input.acceptFenceHash,
          input.attestationHandleHash,
        );
        if (completed.changes !== 1) throw new Error("successor handoff final の slot CAS に失敗しました");
          this.clearSuccessorCapabilities(row.id);
          return next;
        });
        return { session: apply(), error: "" };
      } catch (error) {
        const current = this.requireSuccessorLaunchRaw(row.id);
        if (current.status === "succeeded" && current.successor_session_id !== "" && current.kind === "handoff" &&
            current.revision === input.expectedRevision + 1 && current.accept_fence_hash === input.acceptFenceHash &&
            current.attestation_handle_hash === input.attestationHandleHash &&
            current.handoff_token_fence_hash === input.handoffTokenHash) {
          const succeeded = this.getOrchestratorSession(current.successor_session_id);
          if (succeeded !== null) return { session: succeeded, error: "" };
        }
        if (current.status === "accepting" && current.revision === input.expectedRevision) {
          this.finalizeSuccessorFailure(current, now, error);
        }
        return { session: null, error: error instanceof Error ? error.message : String(error) };
      }
    });
    let result: { session: OrchestratorSessionRow | null; error: string };
    try {
      result = exec();
    } catch (error) {
      // busy/timeout で commit 成否が不明な場合は exact slot を再読込し、成功済みだけを収束させる。
      const current = this.getSuccessorLaunch(input.slotId);
      if (current?.status === "succeeded" && current.kind === "handoff" &&
          current.revision === input.expectedRevision + 1 && current.acceptFenceHash === input.acceptFenceHash &&
          current.attestationHandleHash === input.attestationHandleHash &&
          current.handoffTokenFenceHash === input.handoffTokenHash && current.successorSessionId !== "") {
        const succeeded = this.getOrchestratorSession(current.successorSessionId);
        if (succeeded !== null) return succeeded;
      }
      throw error;
    }
    if (result.session === null) throw new Error(result.error);
    return result.session;
  }

  takeoverStaleOrchestratorSessionWithSuccessorLaunch(
    input: FinalizeOrchestratorSuccessorTakeoverInput,
  ): OrchestratorSessionRow {
    const now = input.now ?? nowSeconds();
    if (!SHA256_HEX.test(input.acceptFenceHash) || !SHA256_HEX.test(input.attestationHandleHash)) {
      throw new Error("successor takeover final の fence/hash は SHA-256 hex が必須です");
    }
    const exec = this.db.transaction((): { session: OrchestratorSessionRow | null; error: string } => {
      const row = this.requireSuccessorLaunchRaw(input.slotId);
      if (row.status === "succeeded" && row.successor_session_id !== "" && row.kind === "takeover" &&
          row.revision === input.expectedRevision + 1 && row.accept_fence_hash === input.acceptFenceHash &&
          row.attestation_handle_hash === input.attestationHandleHash) {
        const succeeded = this.getOrchestratorSession(row.successor_session_id);
        if (succeeded !== null) return { session: succeeded, error: "" };
      }
      if (row.kind !== "takeover" || row.takeover_stale_before === null) {
        throw new Error("successor takeover final の slot kind/cutoff が一致しません");
      }
      this.assertSuccessorFinalRequest({
        row,
        expectedRevision: input.expectedRevision,
        acceptFenceHash: input.acceptFenceHash,
        attestationHandleHash: input.attestationHandleHash,
        now,
      });
      try {
        const apply = this.db.transaction((): OrchestratorSessionRow => {
          this.assertSuccessorFinalCommon({
          row,
          expectedRevision: input.expectedRevision,
          acceptFenceHash: input.acceptFenceHash,
          attestationHandleHash: input.attestationHandleHash,
          now,
        });
        const old = this.db.prepare(
          `SELECT * FROM orchestrator_sessions
           WHERE id = ? AND orchestrator_id = ? AND generation = ?
             AND status IN ('active', 'handoff_pending') AND heartbeat_at < ?`,
        ).get(
          row.source_session_id,
          row.orchestrator_id,
          row.source_generation,
          row.takeover_stale_before,
        ) as RawOrchestratorSessionRow | undefined;
        if (old === undefined) throw new Error("successor takeover final の stored stale cutoff がdriftしました");
        const stale = this.db.prepare(
          `UPDATE orchestrator_sessions SET status = 'stale', updated_at = ?
           WHERE id = ? AND orchestrator_id = ? AND generation = ?
             AND status IN ('active', 'handoff_pending') AND heartbeat_at < ?`,
        ).run(now, old.id, old.orchestrator_id, old.generation, row.takeover_stale_before);
        if (stale.changes !== 1) throw new Error("successor takeover final の source CAS に失敗しました");
        this.db.prepare(
          `UPDATE orchestrator_requests
           SET status = 'queued', claimant_session_id = '', claimant_generation = NULL,
               claim_token = '', lease_until = NULL, answer_key = '', updated_at = ?
           WHERE claimant_session_id = ? AND status IN ('claimed', 'answering')`,
        ).run(now, old.id);
        this.requeueRuntimeCleanupClaims({
          sessionId: old.id,
          generation: old.generation,
          actor: "orchestrator-successor-takeover",
          now,
        });
        this.requeueHumanDecisionClaims(old.id, old.generation, now);
        const next = this.insertOrchestratorSession({
          orchestratorId: old.orchestrator_id,
          provider: row.target_provider as Provider,
          providerSessionId: row.provider_session_id,
          providerSessionSource: row.provider_session_source as ProviderSessionSource,
          now,
        });
        const completed = this.db.prepare(
          `UPDATE orchestrator_successor_launches
           SET attestation_consumed_at = ?, successor_session_id = ?, successor_generation = ?,
               status = 'succeeded', runtime_ownership_claimed = 0,
               revision = revision + 1, updated_at = ?, terminal_at = ?
           WHERE id = ? AND status = 'accepting' AND revision = ? AND accept_fence_hash = ?
             AND attestation_handle_hash = ? AND takeover_stale_before = ?`,
        ).run(
          now,
          next.id,
          next.generation,
          now,
          now,
          row.id,
          input.expectedRevision,
          input.acceptFenceHash,
          input.attestationHandleHash,
          row.takeover_stale_before,
        );
        if (completed.changes !== 1) throw new Error("successor takeover final の slot CAS に失敗しました");
          this.clearSuccessorCapabilities(row.id);
          return next;
        });
        return { session: apply(), error: "" };
      } catch (error) {
        const current = this.requireSuccessorLaunchRaw(row.id);
        if (current.status === "succeeded" && current.successor_session_id !== "" && current.kind === "takeover" &&
            current.revision === input.expectedRevision + 1 && current.accept_fence_hash === input.acceptFenceHash &&
            current.attestation_handle_hash === input.attestationHandleHash) {
          const succeeded = this.getOrchestratorSession(current.successor_session_id);
          if (succeeded !== null) return { session: succeeded, error: "" };
        }
        if (current.status === "accepting" && current.revision === input.expectedRevision) {
          this.finalizeSuccessorFailure(current, now, error);
        }
        return { session: null, error: error instanceof Error ? error.message : String(error) };
      }
    });
    let result: { session: OrchestratorSessionRow | null; error: string };
    try {
      result = exec();
    } catch (error) {
      const current = this.getSuccessorLaunch(input.slotId);
      if (current?.status === "succeeded" && current.kind === "takeover" &&
          current.revision === input.expectedRevision + 1 && current.acceptFenceHash === input.acceptFenceHash &&
          current.attestationHandleHash === input.attestationHandleHash && current.successorSessionId !== "") {
        const succeeded = this.getOrchestratorSession(current.successorSessionId);
        if (succeeded !== null) return succeeded;
      }
      throw error;
    }
    if (result.session === null) throw new Error(result.error);
    return result.session;
  }

  markSuccessorLaunchStopPending(
    input: MarkOrchestratorSuccessorStopPendingInput,
  ): MarkOrchestratorSuccessorStopPendingResult {
    const now = input.now ?? nowSeconds();
    const error = redactText(input.error.trim());
    if (error === "") throw new Error("successor stop pending の error は必須です");
    const exec = this.db.transaction((): MarkOrchestratorSuccessorStopPendingResult => {
      const row = this.requireSuccessorLaunchRaw(input.slotId);
      if (row.revision !== input.expectedRevision || row.status !== input.expectedStatus ||
          !["runtime_bound", "attested", "accepting", "stop_pending", "uncertain"].includes(row.status)) {
        throw new Error("successor stop pending の status/revision CAS に失敗しました");
      }
      return this.transitionSuccessorToStopPendingRaw({
        row,
        now,
        error,
        ...(input.replacementHandoffTokenHash === undefined
          ? {}
          : { replacementHandoffTokenHash: input.replacementHandoffTokenHash }),
      });
    });
    return exec();
  }

  private completeSuccessorStopEvidence(
    row: RawOrchestratorSuccessorLaunchRow,
    evidence: OrchestratorSuccessorStopEvidence,
  ): boolean {
    return row.runtime_ownership_claimed === 1 &&
      row.tmux_session !== "" && row.tmux_pane !== "" && row.pane_pid !== null &&
      row.process_group_id !== null && row.owner_nonce_hash !== "" && evidence.ownerMatched === true &&
      evidence.ownerReadbackAt !== null && evidence.killResult === "succeeded" &&
      evidence.tmuxSessionAbsent === true && evidence.panePidAbsent === true &&
      evidence.processGroupAbsent === true && evidence.observedAt !== null;
  }

  private completeSuccessorRecoveryEvidence(
    row: RawOrchestratorSuccessorLaunchRow,
    evidence: OrchestratorSuccessorStopEvidence,
  ): boolean {
    return row.tmux_session !== "" && row.tmux_pane !== "" && row.pane_pid !== null &&
      row.process_group_id !== null && row.owner_nonce_hash !== "" &&
      evidence.ownerMatched === (row.stop_owner_matched === 1) &&
      evidence.ownerReadbackAt === row.stop_owner_readback_at &&
      evidence.killResult === row.stop_kill_result &&
      evidence.tmuxSessionAbsent === true && evidence.panePidAbsent === true &&
      evidence.processGroupAbsent === true && evidence.observedAt !== null;
  }

  private restoreSuccessorHandoffSource(row: RawOrchestratorSuccessorLaunchRow, now: number): boolean {
    if (row.kind !== "handoff") return true;
    const restored = this.db.prepare(
      `UPDATE orchestrator_sessions
       SET status = 'active', handoff_token_hash = '', handoff_expires_at = NULL,
           heartbeat_at = ?, updated_at = ?
       WHERE id = ? AND orchestrator_id = ? AND generation = ? AND status = 'handoff_pending'
         AND handoff_token_hash = ?`,
    ).run(
      now,
      now,
      row.source_session_id,
      row.orchestrator_id,
      row.source_generation,
      row.handoff_token_fence_hash,
    );
    return restored.changes === 1;
  }

  private writeSuccessorStopEvidence(input: {
    row: RawOrchestratorSuccessorLaunchRow;
    evidence: OrchestratorSuccessorStopEvidence;
    killOwnerReadbackHash: string;
    status: "stopped" | "uncertain";
    now: number;
  }): OrchestratorSuccessorLaunchRow {
    const info = this.db.prepare(
      `UPDATE orchestrator_successor_launches
       SET kill_owner_readback_hash = ?, stop_owner_matched = ?, stop_owner_readback_at = ?,
           stop_kill_result = ?, stop_tmux_session_absent = ?, stop_pane_pid_absent = ?,
           stop_process_group_absent = ?, stop_observed_at = ?, status = ?,
           runtime_ownership_claimed = ?,
           revision = revision + 1, updated_at = ?, terminal_at = ?
       WHERE id = ? AND status = ? AND revision = ?`,
    ).run(
      input.killOwnerReadbackHash,
      input.evidence.ownerMatched === null ? null : Number(input.evidence.ownerMatched),
      input.evidence.ownerReadbackAt,
      input.evidence.killResult,
      input.evidence.tmuxSessionAbsent === null ? null : Number(input.evidence.tmuxSessionAbsent),
      input.evidence.panePidAbsent === null ? null : Number(input.evidence.panePidAbsent),
      input.evidence.processGroupAbsent === null ? null : Number(input.evidence.processGroupAbsent),
      input.evidence.observedAt,
      input.status,
      input.status === "stopped" ? 0 : input.row.runtime_ownership_claimed,
      input.now,
      input.status === "stopped" ? input.now : null,
      input.row.id,
      input.row.status,
      input.row.revision,
    );
    if (info.changes !== 1) throw new Error("successor stop evidence CAS に失敗しました");
    if (input.status === "stopped") this.clearSuccessorCapabilities(input.row.id);
    return mapOrchestratorSuccessorLaunchRow(this.requireSuccessorLaunchRaw(input.row.id));
  }

  recordSuccessorLaunchStop(input: RecordOrchestratorSuccessorStopInput): OrchestratorSuccessorLaunchRow {
    const now = input.now ?? nowSeconds();
    if (!SHA256_HEX.test(input.stopFenceHash) ||
        (input.killOwnerReadbackHash !== "" && !SHA256_HEX.test(input.killOwnerReadbackHash))) {
      throw new Error("successor stop fence/owner readback hash が不正です");
    }
    const exec = this.db.transaction((): OrchestratorSuccessorLaunchRow => {
      const row = this.requireSuccessorLaunchRaw(input.slotId);
      if (!["stop_pending", "uncertain"].includes(row.status) || row.revision !== input.expectedRevision ||
          row.stop_fence_hash !== input.stopFenceHash) {
        throw new Error("successor stop record の status/revision/fence CAS に失敗しました");
      }
      const capability = this.requireSuccessorCapabilityRaw(row.id);
      if (capability.stop_fence === "" || sha256Hex(capability.stop_fence) !== input.stopFenceHash) {
        throw new Error("successor stop record の raw stop fence が一致しません");
      }
      // uncertain の再回復では、owner/kill の保存済み証拠を caller 入力で補完・否定・上書きしない。
      // row 固定 target の fresh 三点観測と観測時刻だけを更新する。
      const recoveringUncertain = row.status === "uncertain";
      const killOwnerReadbackHash = recoveringUncertain
        ? row.kill_owner_readback_hash
        : input.killOwnerReadbackHash;
      const evidence: OrchestratorSuccessorStopEvidence = recoveringUncertain
        ? {
            ownerMatched: mapNullableBoolean(row.stop_owner_matched),
            ownerReadbackAt: row.stop_owner_readback_at,
            killResult: row.stop_kill_result as OrchestratorSuccessorStopEvidence["killResult"],
            tmuxSessionAbsent: input.evidence.tmuxSessionAbsent,
            panePidAbsent: input.evidence.panePidAbsent,
            processGroupAbsent: input.evidence.processGroupAbsent,
            observedAt: input.evidence.observedAt,
          }
        : input.evidence;
      let complete = killOwnerReadbackHash === row.owner_nonce_hash &&
        this.completeSuccessorStopEvidence(row, evidence);
      if (complete && !this.restoreSuccessorHandoffSource(row, now)) complete = false;
      return this.writeSuccessorStopEvidence({
        row,
        evidence,
        killOwnerReadbackHash,
        status: complete ? "stopped" : "uncertain",
        now,
      });
    });
    return exec();
  }

  rollbackCompleteSuccessorLaunch(
    input: RollbackCompleteOrchestratorSuccessorLaunchInput,
  ): RollbackCompleteOrchestratorSuccessorLaunchResult {
    const now = input.now ?? nowSeconds();
    if (!SHA256_HEX.test(input.stopFenceHash)) {
      throw new Error("rollback complete stop fence hash は SHA-256 hex が必須です");
    }
    const exec = this.db.transaction((): RollbackCompleteOrchestratorSuccessorLaunchResult => {
      const row = this.requireSuccessorLaunchRaw(input.slotId);
      if (row.status !== "uncertain" || row.revision !== input.expectedRevision) {
        return {
          launch: mapOrchestratorSuccessorLaunchRow(row),
          applicable: false,
          applied: false,
          reason: "state-mismatch",
        };
      }
      const capability = this.requireSuccessorCapabilityRaw(row.id);
      if (row.stop_fence_hash !== input.stopFenceHash || capability.stop_fence === "" ||
          sha256Hex(capability.stop_fence) !== input.stopFenceHash) {
        return {
          launch: mapOrchestratorSuccessorLaunchRow(row),
          applicable: false,
          applied: false,
          reason: "fence-mismatch",
        };
      }
      if (!this.completeSuccessorRecoveryEvidence(row, input.evidence)) {
        return {
          launch: mapOrchestratorSuccessorLaunchRow(row),
          applicable: false,
          applied: false,
          reason: "incomplete-stop-evidence",
        };
      }
      // 現行 recovery input は fresh owner hash を運ばない。初回 stop 記録で exact owner が
      // 一致済みの場合だけ、不足していた停止三点の再観測を受理する。
      if (row.kill_owner_readback_hash !== row.owner_nonce_hash || row.stop_owner_matched !== 1 ||
          row.stop_owner_readback_at === null) {
        return {
          launch: mapOrchestratorSuccessorLaunchRow(row),
          applicable: false,
          applied: false,
          reason: "incomplete-stop-evidence",
        };
      }
      if (row.kind === "handoff") {
        const source = this.db.prepare(
          `SELECT id FROM orchestrator_sessions
           WHERE id = ? AND orchestrator_id = ? AND generation = ? AND status = 'handoff_pending'
             AND handoff_token_hash = ?`,
        ).get(row.source_session_id, row.orchestrator_id, row.source_generation, row.handoff_token_fence_hash);
        if (source === undefined) {
          return {
            launch: mapOrchestratorSuccessorLaunchRow(row),
            applicable: false,
            applied: false,
            reason: "state-mismatch",
          };
        }
      }
      if (!input.apply) {
        return {
          launch: mapOrchestratorSuccessorLaunchRow(row),
          applicable: true,
          applied: false,
          reason: "complete-stop-evidence",
        };
      }
      if (!this.restoreSuccessorHandoffSource(row, now)) {
        return {
          launch: mapOrchestratorSuccessorLaunchRow(row),
          applicable: false,
          applied: false,
          reason: "state-mismatch",
        };
      }
      const launch = this.writeSuccessorStopEvidence({
        row,
        evidence: input.evidence,
        killOwnerReadbackHash: row.kill_owner_readback_hash,
        status: "stopped",
        now,
      });
      return { launch, applicable: true, applied: true, reason: "complete-stop-evidence" };
    });
    return exec();
  }

  closeUncertainSuccessorLaunchWithOrchestrator(
    input: FencedCloseUncertainSuccessorInput,
  ): FencedCloseUncertainSuccessorResult {
    const now = input.now ?? nowSeconds();
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error("uncertain successor close の expectedRevision が不正です");
    }
    if (!Number.isSafeInteger(input.freshObservation.observedAt) || input.freshObservation.observedAt <= 0) {
      throw new Error("uncertain successor close の fresh observedAt が不正です");
    }
    const exec = this.db.transaction((): FencedCloseUncertainSuccessorResult => {
      const row = this.requireSuccessorLaunchRaw(input.slotId);
      if (row.revision !== input.expectedRevision) {
        throw new Error("uncertain successor close の slot revision が変化しました");
      }
      const provenance = normalizeActorProvenance(input.provenance);
      const caller = provenance.kind === "orchestrator"
        ? this.db.prepare(
          `SELECT 1 AS matched FROM orchestrator_sessions
           WHERE id = ? AND orchestrator_id = ? AND generation = ?
             AND status IN ('active', 'handoff_pending')`,
        ).get(
          provenance.actorSessionId,
          provenance.actorId,
          provenance.actorGeneration,
        )
        : undefined;
      const source = row.kind === "handoff"
        ? this.db.prepare(
          `SELECT 1 AS matched FROM orchestrator_sessions
           WHERE id = ? AND orchestrator_id = ? AND generation = ? AND status = 'handoff_pending'
             AND handoff_token_hash = ?`,
        ).get(
          row.source_session_id,
          row.orchestrator_id,
          row.source_generation,
          row.handoff_token_fence_hash,
        )
        : undefined;
      const conditions = {
        statusUncertain: row.status === "uncertain",
        storedStopEvidenceComplete: row.stop_owner_matched === 1 &&
          row.stop_tmux_session_absent === 1 && row.stop_pane_pid_absent === 1 &&
          row.stop_process_group_absent === 1,
        freshTargetAbsent: row.tmux_session !== "" && row.pane_pid !== null &&
          row.process_group_id !== null && input.freshObservation.observedAt === now &&
          input.freshObservation.tmuxSessionAbsent === true &&
          input.freshObservation.panePidAbsent === true &&
          input.freshObservation.processGroupAbsent === true,
        callerSessionGenerationActive: caller !== undefined && provenance.kind === "orchestrator" &&
          provenance.actorId === row.orchestrator_id,
        sourceSessionHandoffPending: source !== undefined,
      } satisfies FencedCloseUncertainSuccessorResult["conditions"];
      const applicable = Object.values(conditions).every((value) => value);
      if (!input.confirm) {
        return {
          launch: mapOrchestratorSuccessorLaunchRow(row),
          conditions,
          applicable,
          applied: false,
        };
      }
      if (!applicable) {
        const missing = Object.entries(conditions)
          .filter(([, value]) => !value)
          .map(([name]) => name)
          .join(",");
        throw new Error(`uncertain successor close の条件が不足しています: ${missing}`);
      }
      const restored = this.db.prepare(
        `UPDATE orchestrator_sessions
         SET status = 'active', handoff_token_hash = '', handoff_expires_at = NULL,
             heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND orchestrator_id = ? AND generation = ? AND status = 'handoff_pending'
           AND handoff_token_hash = ?`,
      ).run(
        now,
        now,
        row.source_session_id,
        row.orchestrator_id,
        row.source_generation,
        row.handoff_token_fence_hash,
      );
      if (restored.changes !== 1) {
        throw new Error("uncertain successor close の source session CAS に失敗しました");
      }
      const closed = this.db.prepare(
        `UPDATE orchestrator_successor_launches
         SET status = 'stopped', runtime_ownership_claimed = 0,
             revision = revision + 1, updated_at = ?, terminal_at = ?
         WHERE id = ? AND status = 'uncertain' AND revision = ?`,
      ).run(now, now, row.id, row.revision);
      if (closed.changes !== 1) {
        throw new Error("uncertain successor close の slot CAS に失敗しました");
      }
      this.clearSuccessorCapabilities(row.id);
      const payload = JSON.stringify({
        version: "successor-launch-stopped.v1",
        slotId: row.id,
        orchestratorId: row.orchestrator_id,
        sourceSessionId: row.source_session_id,
        sourceGeneration: row.source_generation,
        from: "uncertain",
        to: "stopped",
        recovery: "fenced-orchestrator-close",
      });
      this.db.prepare(
        `INSERT INTO board_audit_events (
           event_type, actor, payload, actor_kind, actor_id, actor_session_id, actor_generation, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "successor_launch_stopped",
        "orchestrator",
        payload,
        provenance.kind,
        provenance.actorId,
        provenance.actorSessionId,
        provenance.actorGeneration,
        now,
      );
      return {
        launch: mapOrchestratorSuccessorLaunchRow(this.requireSuccessorLaunchRaw(row.id)),
        conditions,
        applicable: true,
        applied: true,
      };
    });
    return exec();
  }

  private insertOrchestratorSession(input: {
    orchestratorId: string;
    provider: Provider | "";
    providerSessionId: string;
    providerSessionSource: ProviderSessionSource | "";
    now: number;
  }): OrchestratorSessionRow {
    const generationRow = this.db
      .prepare(`SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM orchestrator_sessions WHERE orchestrator_id = ?`)
      .get(input.orchestratorId) as { generation: number };
    const id = generateRoutingId("os");
    this.db
      .prepare(
        `INSERT INTO orchestrator_sessions (
           id, orchestrator_id, generation, provider, provider_session_id, provider_session_source, status,
           heartbeat_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        input.orchestratorId,
        generationRow.generation,
        input.provider,
        input.providerSessionId,
        input.providerSessionSource,
        input.now,
        input.now,
        input.now,
      );
    return mapOrchestratorSessionRow(
      this.db.prepare(`SELECT * FROM orchestrator_sessions WHERE id = ?`).get(id) as RawOrchestratorSessionRow,
    );
  }

  startOrchestratorSession(input: {
    orchestratorId: string;
    provider?: Provider | "";
    providerSessionId?: string;
  }): OrchestratorSessionRow {
    const identity = normalizeManualProviderSessionIdentity(input.provider ?? "", input.providerSessionId ?? "");
    const exec = this.db.transaction((): OrchestratorSessionRow => {
      if (this.getOrchestrator(input.orchestratorId) === null) {
        throw new Error(`orchestrator が見つかりません: ${input.orchestratorId}`);
      }
      const live = this.db
        .prepare(`SELECT id FROM orchestrator_sessions WHERE orchestrator_id = ? AND status IN ('active', 'handoff_pending')`)
        .get(input.orchestratorId);
      if (live !== undefined) {
        throw new Error("active session が存在します。並行分業は別 orchestrator を register してください");
      }
      this.assertSuccessorReplacementAllowed(input.orchestratorId);
      return this.insertOrchestratorSession({
        orchestratorId: input.orchestratorId,
        ...identity,
        now: nowSeconds(),
      });
    });
    return exec();
  }

  getOrchestratorSession(id: string): OrchestratorSessionRow | null {
    const row = this.db.prepare(`SELECT * FROM orchestrator_sessions WHERE id = ?`).get(id) as RawOrchestratorSessionRow | undefined;
    return row === undefined ? null : mapOrchestratorSessionRow(row);
  }

  listOrchestratorSessions(orchestratorId?: string): OrchestratorSessionRow[] {
    const rows = (orchestratorId === undefined
      ? this.db.prepare(`SELECT * FROM orchestrator_sessions ORDER BY created_at, id`).all()
      : this.db.prepare(`SELECT * FROM orchestrator_sessions WHERE orchestrator_id = ? ORDER BY generation`).all(orchestratorId)) as RawOrchestratorSessionRow[];
    return rows.map(mapOrchestratorSessionRow);
  }

  private recordOrchestratorLivenessIncident(row: RawOrchestratorSessionRow, detectedAt: number): void {
    const gapSeconds = detectedAt - row.heartbeat_at;
    if (row.status !== "active" || gapSeconds <= ORCHESTRATOR_SESSION_STALE_SECONDS) {
      return;
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO orchestrator_liveness_incidents (
           session_id, orchestrator_id, generation, provider, provider_session_id,
           gap_seconds, detected_at, status, attempts, next_attempt_at,
           last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, '', ?, ?)`,
      )
      .run(
        row.id,
        row.orchestrator_id,
        row.generation,
        row.provider,
        row.provider_session_id,
        gapSeconds,
        detectedAt,
        detectedAt,
        detectedAt,
        detectedAt,
      );
  }

  heartbeatOrchestratorSession(sessionId: string, generation: number, now = nowSeconds()): OrchestratorSessionRow {
    const exec = this.db.transaction((): OrchestratorSessionRow => {
      const row = this.db
        .prepare(`SELECT * FROM orchestrator_sessions WHERE id = ? AND generation = ? AND status = 'active'`)
        .get(sessionId, generation) as RawOrchestratorSessionRow | undefined;
      if (row === undefined) {
        throw new Error("SESSION_SUPERSEDED: active generation と一致しません");
      }
      this.recordOrchestratorLivenessIncident(row, now);
      this.db
        .prepare(`UPDATE orchestrator_sessions SET heartbeat_at = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, sessionId);
      return this.getOrchestratorSession(sessionId)!;
    });
    return exec();
  }

  /**
   * 計画済み handoff で、未承認の cleanup claim だけを新 generation に引き継ぐ。
   * claim token の平文は保存しないため、既存 hash と lease を維持したまま claimant fence だけを更新する。
   */
  private transferRuntimeCleanupClaims(input: {
    previousSessionId: string;
    previousGeneration: number;
    nextSessionId: string;
    nextGeneration: number;
    actor: string;
    now: number;
  }): void {
    const requests = this.db
      .prepare(
        `SELECT id, lease_id FROM runtime_cleanup_requests
         WHERE claimant_session_id = ? AND claimant_generation = ? AND status = 'claimed'`,
      )
      .all(input.previousSessionId, input.previousGeneration) as Array<{ id: string; lease_id: string }>;
    if (requests.length === 0) {
      return;
    }
    this.db
      .prepare(
        `UPDATE runtime_cleanup_requests
         SET claimant_session_id = ?, claimant_generation = ?, updated_at = ?
         WHERE claimant_session_id = ? AND claimant_generation = ? AND status = 'claimed'`,
      )
      .run(
        input.nextSessionId,
        input.nextGeneration,
        input.now,
        input.previousSessionId,
        input.previousGeneration,
      );
    for (const request of requests) {
      this.addRuntimeResourceEvent(request.lease_id, "cleanup_claim_transferred", input.actor, {
        requestId: request.id,
        previousSessionId: input.previousSessionId,
        previousGeneration: input.previousGeneration,
        nextSessionId: input.nextSessionId,
        nextGeneration: input.nextGeneration,
      }, request.id);
    }
  }

  /** 突然死・close 時は未実行 cleanup claim/approval を同一 Tx で安全に再queueする。 */
  private requeueRuntimeCleanupClaims(input: {
    sessionId: string;
    generation: number;
    actor: string;
    now: number;
  }): void {
    const requests = this.db
      .prepare(
        `SELECT id, lease_id FROM runtime_cleanup_requests
         WHERE claimant_session_id = ? AND claimant_generation = ? AND status IN ('claimed', 'approved')`,
      )
      .all(input.sessionId, input.generation) as Array<{ id: string; lease_id: string }>;
    if (requests.length === 0) {
      return;
    }
    this.db
      .prepare(
        `UPDATE runtime_cleanup_requests
         SET status = 'queued', claimant_session_id = '', claimant_generation = NULL,
             claim_token_hash = '', claim_lease_until = NULL, approved_by = '', approval_generation = NULL,
             updated_at = ?
         WHERE claimant_session_id = ? AND claimant_generation = ? AND status IN ('claimed', 'approved')`,
      )
      .run(input.now, input.sessionId, input.generation);
    for (const request of requests) {
      this.db
        .prepare(`UPDATE runtime_cleanup_deliveries SET status = 'pending', updated_at = ? WHERE request_id = ?`)
        .run(input.now, request.id);
      this.addRuntimeResourceEvent(request.lease_id, "cleanup_claim_requeued", input.actor, {
        requestId: request.id,
        sessionId: input.sessionId,
        generation: input.generation,
      }, request.id);
    }
  }

  private requireHumanDecisionRaw(requestId: string): RawHumanDecisionRequestRow {
    const row = this.db.prepare(`SELECT * FROM human_decision_requests WHERE id = ?`).get(requestId) as
      | RawHumanDecisionRequestRow
      | undefined;
    if (row === undefined) {
      throw new HumanDecisionError("REQUEST_NOT_FOUND", `human decision requestがありません: ${requestId}`);
    }
    return row;
  }

  private transferHumanDecisionClaims(input: {
    orchestratorId: string;
    previousSessionId: string;
    previousGeneration: number;
    nextSessionId: string;
    nextGeneration: number;
    now: number;
  }): void {
    this.db.prepare(
      `UPDATE human_decision_requests
       SET claimant_session_id = ?, claimant_generation = ?, updated_at = ?
       WHERE owner_orchestrator_id = ? AND claimant_orchestrator_id = ?
         AND claimant_session_id = ? AND claimant_generation = ? AND status = 'claimed'`,
    ).run(
      input.nextSessionId,
      input.nextGeneration,
      input.now,
      input.orchestratorId,
      input.orchestratorId,
      input.previousSessionId,
      input.previousGeneration,
    );
  }

  private requeueHumanDecisionClaims(sessionId: string, generation: number, now: number): void {
    this.db.prepare(
      `UPDATE human_decision_requests
       SET status = 'answered', claimant_orchestrator_id = NULL, claimant_session_id = NULL,
           claimant_generation = NULL, claim_token_hash = NULL, claim_lease_until = NULL, updated_at = ?
       WHERE claimant_session_id = ? AND claimant_generation = ? AND status = 'claimed'`,
    ).run(now, sessionId, generation);
  }

  createHumanDecisionRequest(input: CreateHumanDecisionRequestInput): HumanDecisionRequestRow {
    const ask = canonicalizeHumanDecisionAsk(input);
    const now = requireHumanDecisionTimestamp(input.now ?? nowSeconds(), "now");
    const exec = this.db.transaction((): HumanDecisionRequestRow => {
      const actor = this.authorizeHumanDecisionOrchestrator(input.provenance);
      if (this.db.prepare(`SELECT 1 FROM tasks WHERE id = ?`).get(ask.taskId) === undefined) {
        throw new HumanDecisionError("TASK_NOT_FOUND", `taskがありません: ${ask.taskId}`);
      }
      const payloadHash = humanDecisionAskPayloadHash(ask, actor.actorId);
      const existing = this.db.prepare(
        `SELECT * FROM human_decision_requests
         WHERE owner_orchestrator_id = ? AND ask_idempotency_key = ? COLLATE BINARY`,
      ).get(actor.actorId, ask.idempotencyKey) as RawHumanDecisionRequestRow | undefined;
      if (existing !== undefined) {
        if (existing.ask_payload_hash !== payloadHash) {
          throw new HumanDecisionError("IDEMPOTENCY_CONFLICT", "同じask keyに異なるpayloadがあります");
        }
        return mapHumanDecisionRequestRow(existing);
      }
      if (ask.relatedRequestId !== null) {
        const related = this.db.prepare(
          `SELECT task_id, owner_orchestrator_id FROM human_decision_requests WHERE id = ?`,
        ).get(ask.relatedRequestId) as { task_id: string; owner_orchestrator_id: string } | undefined;
        if (related === undefined) {
          throw new HumanDecisionError("REFERENCE_NOT_FOUND", "related requestがありません");
        }
        if (related.task_id !== ask.taskId || related.owner_orchestrator_id !== actor.actorId) {
          throw new HumanDecisionError("OWNER_MISMATCH", "related requestのowner/taskが一致しません");
        }
      }
      for (const link of ask.links) {
        if (link.type === "task" && this.db.prepare(`SELECT 1 FROM tasks WHERE id = ?`).get(link.taskId) === undefined) {
          throw new HumanDecisionError("REFERENCE_NOT_FOUND", `参照taskがありません: ${link.taskId}`);
        }
        if (link.type === "artifact") {
          const attached = this.db.prepare(
            `SELECT 1 FROM task_events
             WHERE task_id = ? AND event_type = 'artifact_attached' AND json_valid(payload)
               AND json_extract(payload, '$.name') = ? COLLATE BINARY
             LIMIT 1`,
          ).get(ask.taskId, link.artifactName);
          if (attached === undefined) {
            throw new HumanDecisionError("REFERENCE_NOT_FOUND", `同taskのartifact登録がありません: ${link.artifactName}`);
          }
        }
      }
      let lastError: unknown;
      for (let attempt = 0; attempt < TASK_ID_COLLISION_MAX_RETRIES; attempt += 1) {
        const id = `hd_${randomBytes(8).toString("hex")}`;
        try {
          this.db.prepare(
            `INSERT INTO human_decision_requests (
               id, task_id, owner_orchestrator_id, kind, title, question, action,
               target_revision_kind, target_revision_value, choices_json, links_json, default_outcome,
               related_request_id, deadline_at, ask_idempotency_key, ask_payload_hash,
               status, answer_revision,
               request_actor_kind, request_actor_id, request_actor_session_id, request_actor_generation,
               created_at, updated_at
             ) VALUES (
               @id, @taskId, @ownerId, @kind, @title, @question, @action,
               @targetRevisionKind, @targetRevisionValue, @choicesJson, @linksJson, @defaultOutcome,
               @relatedRequestId, @deadlineAt, @idempotencyKey, @payloadHash,
               'waiting_human', 0,
               @actorKind, @actorId, @actorSessionId, @actorGeneration,
               @now, @now
             )`,
          ).run({
            id,
            taskId: ask.taskId,
            ownerId: actor.actorId,
            kind: ask.kind,
            title: ask.title,
            question: ask.question,
            action: ask.action,
            targetRevisionKind: ask.targetRevision?.kind ?? null,
            targetRevisionValue: ask.targetRevision?.value ?? null,
            choicesJson: canonicalHumanDecisionJson(ask.choices),
            linksJson: canonicalHumanDecisionJson(ask.links),
            defaultOutcome: ask.defaultOutcome,
            relatedRequestId: ask.relatedRequestId,
            deadlineAt: ask.deadlineAt,
            idempotencyKey: ask.idempotencyKey,
            payloadHash,
            actorKind: actor.kind,
            actorId: actor.actorId,
            actorSessionId: actor.actorSessionId,
            actorGeneration: actor.actorGeneration,
            now,
          });
          return mapHumanDecisionRequestRow(this.requireHumanDecisionRaw(id));
        } catch (error) {
          if (!isPrimaryKeyConstraintError(error)) throw error;
          lastError = error;
        }
      }
      throw new HumanDecisionError("STATE_CONFLICT", `request id採番に失敗しました: ${String(lastError)}`);
    });
    return exec();
  }

  answerHumanDecisionRequest(input: AnswerHumanDecisionRequestInput): HumanDecisionRequestRow {
    const record = assertHumanDecisionInputKeys(input, [
      "requestId", "expectedRevision", "answerIdempotencyKey", "answer", "comment", "provenance", "now",
    ], "answer input");
    const requestId = requireHumanDecisionText(record.requestId, "requestId", 128);
    if (record.expectedRevision !== 0) throw new HumanDecisionError("REVISION_CONFLICT", "expectedRevisionは0が必須です");
    const answerKey = requireHumanDecisionText(record.answerIdempotencyKey, "answerIdempotencyKey", 128);
    const comment = normalizeHumanDecisionComment(record.comment);
    const now = requireHumanDecisionTimestamp(record.now ?? nowSeconds(), "now");
    const exec = this.db.transaction((): HumanDecisionRequestRow => {
      const actor = this.authorizeHumanDecisionHuman(input.provenance);
      const before = this.requireHumanDecisionRaw(requestId);
      const mapped = mapHumanDecisionRequestRow(before);
      const answer = canonicalizeHumanDecisionAnswer(mapped.kind, mapped.choices, record.answer);
      const payloadHash = humanDecisionAnswerPayloadHash({
        requestId,
        answer,
        comment,
        humanActorId: actor.actorId,
      });
      // 保存済みkey/hash/actor照合はstatus/CASより先に行い、claim/resolved後のexact retryも収束させる。
      if (before.answer_revision === 1) {
        if (before.answer_idempotency_key === answerKey && before.answer_payload_hash === payloadHash &&
            before.answer_actor_id === actor.actorId) {
          return mapped;
        }
        throw new HumanDecisionError("IDEMPOTENCY_CONFLICT", "保存済みanswer key/hash/actorと一致しません");
      }
      if (before.status !== "waiting_human") {
        throw new HumanDecisionError("STATE_CONFLICT", `回答できないstatusです: ${before.status}`);
      }
      const info = this.db.prepare(
        `UPDATE human_decision_requests
         SET status = 'answered', answer_revision = 1, answer_idempotency_key = ?, answer_payload_hash = ?,
             answer_payload_json = ?, answer_comment = ?, answered_at = ?,
             answer_actor_kind = 'human', answer_actor_id = ?, answer_actor_session_id = '',
             answer_actor_generation = NULL, updated_at = ?
         WHERE id = ? AND status = 'waiting_human' AND answer_revision = 0`,
      ).run(answerKey, payloadHash, canonicalHumanDecisionJson(answer), comment, now, actor.actorId, now, requestId);
      if (info.changes !== 1) throw new HumanDecisionError("STATE_CONFLICT", "answer CASに失敗しました");
      return mapHumanDecisionRequestRow(this.requireHumanDecisionRaw(requestId));
    });
    return exec();
  }

  cancelHumanDecisionRequest(input: CancelHumanDecisionRequestInput): HumanDecisionRequestRow {
    const record = assertHumanDecisionInputKeys(
      input,
      ["requestId", "expectedRevision", "reason", "provenance", "now"],
      "cancel input",
    );
    const requestId = requireHumanDecisionText(record.requestId, "requestId", 128);
    if (record.expectedRevision !== 0) throw new HumanDecisionError("REVISION_CONFLICT", "expectedRevisionは0が必須です");
    const reason = requireHumanDecisionText(record.reason, "reason");
    const now = requireHumanDecisionTimestamp(record.now ?? nowSeconds(), "now");
    const exec = this.db.transaction((): HumanDecisionRequestRow => {
      const actor = this.authorizeHumanDecisionOrchestrator(input.provenance);
      const before = this.requireHumanDecisionRaw(requestId);
      if (before.owner_orchestrator_id !== actor.actorId) {
        throw new HumanDecisionError("OWNER_MISMATCH", "request ownerではありません");
      }
      if (before.answer_revision !== 0) throw new HumanDecisionError("REVISION_CONFLICT", "既に回答済みです");
      if (before.status !== "waiting_human") throw new HumanDecisionError("STATE_CONFLICT", "cancel可能な状態ではありません");
      const info = this.db.prepare(
        `UPDATE human_decision_requests
         SET status = 'cancelled', cancel_reason = ?, cancelled_at = ?,
             cancel_actor_kind = 'orchestrator', cancel_actor_id = ?, cancel_actor_session_id = ?,
             cancel_actor_generation = ?, updated_at = ?
         WHERE id = ? AND status = 'waiting_human' AND answer_revision = 0`,
      ).run(reason, now, actor.actorId, actor.actorSessionId, actor.actorGeneration, now, requestId);
      if (info.changes !== 1) throw new HumanDecisionError("STATE_CONFLICT", "cancel CASに失敗しました");
      return mapHumanDecisionRequestRow(this.requireHumanDecisionRaw(requestId));
    });
    return exec();
  }

  claimHumanDecisionResponse(input: ClaimHumanDecisionResponseInput): HumanDecisionRequestRow {
    const record = assertHumanDecisionInputKeys(
      input,
      ["requestId", "expectedRevision", "claimToken", "leaseUntil", "provenance", "now"],
      "claim input",
    );
    const requestId = requireHumanDecisionText(record.requestId, "requestId", 128);
    if (record.expectedRevision !== 1) throw new HumanDecisionError("REVISION_CONFLICT", "expectedRevisionは1が必須です");
    const claimToken = requireHumanDecisionText(record.claimToken, "claimToken", 12000);
    const now = requireHumanDecisionTimestamp(record.now ?? nowSeconds(), "now");
    const leaseUntil = requireHumanDecisionTimestamp(record.leaseUntil, "leaseUntil");
    if (leaseUntil <= now) throw new HumanDecisionError("INVALID_INPUT", "leaseUntilはnowより後が必須です");
    const exec = this.db.transaction((): HumanDecisionRequestRow => {
      const actor = this.authorizeHumanDecisionOrchestrator(input.provenance);
      const before = this.requireHumanDecisionRaw(requestId);
      if (before.owner_orchestrator_id !== actor.actorId) throw new HumanDecisionError("OWNER_MISMATCH", "request ownerではありません");
      if (before.answer_revision !== 1) throw new HumanDecisionError("REVISION_CONFLICT", "answer revision 1ではありません");
      if (before.status !== "answered" && !(before.status === "claimed" && before.claim_lease_until !== null &&
          before.claim_lease_until <= now)) {
        throw new HumanDecisionError("CLAIM_CONFLICT", "responseはclaim可能ではありません");
      }
      const info = this.db.prepare(
        `UPDATE human_decision_requests
         SET status = 'claimed', claimant_orchestrator_id = ?, claimant_session_id = ?, claimant_generation = ?,
             claim_token_hash = ?, claim_lease_until = ?, updated_at = ?
         WHERE id = ? AND answer_revision = 1
           AND (status = 'answered' OR (status = 'claimed' AND claim_lease_until <= ?))`,
      ).run(
        actor.actorId,
        actor.actorSessionId,
        actor.actorGeneration,
        humanDecisionSha256(claimToken),
        leaseUntil,
        now,
        requestId,
        now,
      );
      if (info.changes !== 1) throw new HumanDecisionError("CLAIM_CONFLICT", "claim CASに失敗しました");
      return mapHumanDecisionRequestRow(this.requireHumanDecisionRaw(requestId));
    });
    return exec();
  }

  releaseHumanDecisionResponse(input: ReleaseHumanDecisionResponseInput): HumanDecisionRequestRow {
    const record = assertHumanDecisionInputKeys(
      input,
      ["requestId", "expectedRevision", "claimToken", "provenance", "now"],
      "release input",
    );
    const requestId = requireHumanDecisionText(record.requestId, "requestId", 128);
    if (record.expectedRevision !== 1) throw new HumanDecisionError("REVISION_CONFLICT", "expectedRevisionは1が必須です");
    const tokenHash = humanDecisionSha256(requireHumanDecisionText(record.claimToken, "claimToken", 12000));
    const now = requireHumanDecisionTimestamp(record.now ?? nowSeconds(), "now");
    const exec = this.db.transaction((): HumanDecisionRequestRow => {
      const actor = this.authorizeHumanDecisionOrchestrator(input.provenance);
      const before = this.requireHumanDecisionRaw(requestId);
      if (before.owner_orchestrator_id !== actor.actorId) throw new HumanDecisionError("OWNER_MISMATCH", "request ownerではありません");
      if (before.answer_revision !== 1) throw new HumanDecisionError("REVISION_CONFLICT", "answer revision 1ではありません");
      if (before.status !== "claimed" || before.claimant_orchestrator_id !== actor.actorId ||
          before.claimant_session_id !== actor.actorSessionId || before.claimant_generation !== actor.actorGeneration ||
          before.claim_token_hash !== tokenHash) {
        throw new HumanDecisionError("CLAIM_CONFLICT", "claim fenceが一致しません");
      }
      const info = this.db.prepare(
        `UPDATE human_decision_requests
         SET status = 'answered', claimant_orchestrator_id = NULL, claimant_session_id = NULL,
             claimant_generation = NULL, claim_token_hash = NULL, claim_lease_until = NULL, updated_at = ?
         WHERE id = ? AND status = 'claimed' AND claimant_orchestrator_id = ?
           AND claimant_session_id = ? AND claimant_generation = ? AND claim_token_hash = ?`,
      ).run(now, requestId, actor.actorId, actor.actorSessionId, actor.actorGeneration, tokenHash);
      if (info.changes !== 1) throw new HumanDecisionError("CLAIM_CONFLICT", "release CASに失敗しました");
      return mapHumanDecisionRequestRow(this.requireHumanDecisionRaw(requestId));
    });
    return exec();
  }

  resolveHumanDecisionResponse(input: ResolveHumanDecisionResponseInput): HumanDecisionRequestRow {
    const record = assertHumanDecisionInputKeys(
      input,
      ["requestId", "expectedRevision", "claimToken", "resolution", "provenance", "now"],
      "resolve input",
    );
    const requestId = requireHumanDecisionText(record.requestId, "requestId", 128);
    if (record.expectedRevision !== 1) throw new HumanDecisionError("REVISION_CONFLICT", "expectedRevisionは1が必須です");
    const tokenHash = humanDecisionSha256(requireHumanDecisionText(record.claimToken, "claimToken", 12000));
    const resolution = canonicalizeHumanDecisionResolution(record.resolution);
    const now = requireHumanDecisionTimestamp(record.now ?? nowSeconds(), "now");
    const exec = this.db.transaction((): HumanDecisionRequestRow => {
      const actor = this.authorizeHumanDecisionOrchestrator(input.provenance);
      const before = this.requireHumanDecisionRaw(requestId);
      if (before.owner_orchestrator_id !== actor.actorId) throw new HumanDecisionError("OWNER_MISMATCH", "request ownerではありません");
      if (before.answer_revision !== 1) throw new HumanDecisionError("REVISION_CONFLICT", "answer revision 1ではありません");
      if (before.status !== "claimed" || before.claimant_orchestrator_id !== actor.actorId ||
          before.claimant_session_id !== actor.actorSessionId || before.claimant_generation !== actor.actorGeneration ||
          before.claim_token_hash !== tokenHash || before.claim_lease_until === null || before.claim_lease_until <= now) {
        throw new HumanDecisionError("CLAIM_CONFLICT", "active claim fence/leaseが一致しません");
      }
      const reason = resolution.outcome === "handled" ? (resolution.note ?? null) : resolution.reason;
      const info = this.db.prepare(
        `UPDATE human_decision_requests
         SET status = 'resolved', claimant_orchestrator_id = NULL, claimant_session_id = NULL,
             claimant_generation = NULL, claim_token_hash = NULL, claim_lease_until = NULL,
             resolution_outcome = ?, resolution_reason = ?, resolved_at = ?,
             resolve_actor_kind = 'orchestrator', resolve_actor_id = ?, resolve_actor_session_id = ?,
             resolve_actor_generation = ?, updated_at = ?
         WHERE id = ? AND status = 'claimed' AND claimant_orchestrator_id = ?
           AND claimant_session_id = ? AND claimant_generation = ? AND claim_token_hash = ? AND claim_lease_until > ?`,
      ).run(
        resolution.outcome,
        reason,
        now,
        actor.actorId,
        actor.actorSessionId,
        actor.actorGeneration,
        now,
        requestId,
        actor.actorId,
        actor.actorSessionId,
        actor.actorGeneration,
        tokenHash,
        now,
      );
      if (info.changes !== 1) throw new HumanDecisionError("CLAIM_CONFLICT", "resolve CASに失敗しました");
      return mapHumanDecisionRequestRow(this.requireHumanDecisionRaw(requestId));
    });
    return exec();
  }

  closeOrchestratorSession(sessionId: string, generation: number): OrchestratorSessionRow {
    const now = nowSeconds();
    const exec = this.db.transaction((): OrchestratorSessionRow => {
      const current = this.getOrchestratorSession(sessionId);
      if (current === null || current.generation !== generation || !["active", "handoff_pending"].includes(current.status)) {
        throw new Error("SESSION_SUPERSEDED: close 対象が active generation ではありません");
      }
      this.assertSuccessorSourceMutationAllowed(sessionId, generation);
      this.db.prepare(`UPDATE orchestrator_sessions SET status = 'closed', updated_at = ? WHERE id = ?`).run(now, sessionId);
      this.db
        .prepare(
          `UPDATE orchestrator_requests
           SET status = 'queued', claimant_session_id = '', claimant_generation = NULL,
               claim_token = '', lease_until = NULL, answer_key = '', updated_at = ?
           WHERE claimant_session_id = ? AND status IN ('claimed', 'answering')`,
        )
        .run(now, sessionId);
      this.requeueRuntimeCleanupClaims({
        sessionId,
        generation,
        actor: "orchestrator-session-close",
        now,
      });
      this.requeueHumanDecisionClaims(sessionId, generation, now);
      return this.getOrchestratorSession(sessionId)!;
    });
    return exec();
  }

  prepareOrchestratorHandoff(sessionId: string, generation: number, tokenHash: string, expiresAt: number): OrchestratorSessionRow {
    if (!SHA256_HEX.test(tokenHash)) {
      throw new Error("handoff token hash は SHA-256 hex が必須です");
    }
    const now = nowSeconds();
    const exec = this.db.transaction((): OrchestratorSessionRow => {
      const source = this.getOrchestratorSession(sessionId);
      if (source === null || source.generation !== generation) {
        throw new Error("SESSION_SUPERSEDED: handoff prepare 対象が active generation ではありません");
      }
      this.assertSuccessorReplacementAllowed(source.orchestratorId);
      const info = this.db
        .prepare(
          `UPDATE orchestrator_sessions
           SET status = 'handoff_pending', handoff_token_hash = ?, handoff_expires_at = ?, updated_at = ?
           WHERE id = ? AND generation = ? AND status = 'active'`,
        )
        .run(tokenHash, expiresAt, now, sessionId, generation);
      if (info.changes !== 1) {
        throw new Error("SESSION_SUPERSEDED: handoff prepare 対象が active generation ではありません");
      }
      return this.getOrchestratorSession(sessionId)!;
    });
    return exec();
  }

  fenceOrchestratorHandoffToken(
    sessionId: string,
    generation: number,
    expectedTokenHash: string,
    replacementTokenHash: string,
  ): { fenced: boolean; session: OrchestratorSessionRow | null } {
    if (!/^[0-9a-f]{64}$/i.test(expectedTokenHash) || !/^[0-9a-f]{64}$/i.test(replacementTokenHash)) {
      throw new Error("handoff token hash は SHA-256 hex が必須です");
    }
    const now = nowSeconds();
    const exec = this.db.transaction((): { fenced: boolean; session: OrchestratorSessionRow | null } => {
      this.assertSuccessorSourceMutationAllowed(sessionId, generation);
      const info = this.db.prepare(
        `UPDATE orchestrator_sessions
         SET handoff_token_hash = ?, updated_at = ?
         WHERE id = ? AND generation = ? AND status = 'handoff_pending' AND handoff_token_hash = ?`,
      )
      .run(replacementTokenHash, now, sessionId, generation, expectedTokenHash);
      return {
        fenced: info.changes === 1,
        session: this.getOrchestratorSession(sessionId),
      };
    });
    return exec();
  }

  cancelOrchestratorHandoff(sessionId: string, generation: number, tokenHash: string): OrchestratorSessionRow {
    // handoff_pending → active に戻す。tokenHash 一致を要求して race を弾く。
    // heartbeat_at も同時に更新し、ロールバック直後に stale 判定されて二重に失効扱いされるのを防ぐ。
    if (tokenHash.length !== 64) {
      throw new Error("handoff token hash は SHA-256 hex が必須です");
    }
    const now = nowSeconds();
    const exec = this.db.transaction((): OrchestratorSessionRow => {
      this.assertSuccessorSourceMutationAllowed(sessionId, generation);
      const info = this.db.prepare(
        `UPDATE orchestrator_sessions
         SET status = 'active', handoff_token_hash = '', handoff_expires_at = NULL,
             heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND generation = ? AND status = 'handoff_pending' AND handoff_token_hash = ?`,
      )
      .run(now, now, sessionId, generation, tokenHash);
      if (info.changes !== 1) {
        throw new Error("CANCEL_FAILED: handoff cancel 対象が handoff_pending ではないか、token が一致しません");
      }
      return this.getOrchestratorSession(sessionId)!;
    });
    return exec();
  }

  previewHandoffTransfers(sessionId: string, generation: number): { orchestratorRequestCount: number; runtimeCleanupClaimCount: number } {
    // acceptOrchestratorHandoff と同じ predicate で移管対象を集計する（読み取り専用）。
    // orchestrator requests: claimed/answering のうち当該セッションが claimant のもの
    const orchReqCount = (this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM orchestrator_requests
         WHERE claimant_session_id = ? AND claimant_generation = ? AND status IN ('claimed', 'answering')`,
      )
      .get(sessionId, generation) as { cnt: number }).cnt;
    // runtime cleanup claims: claimed のうち当該セッションが claimant のもの
    const cleanupCount = (this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM runtime_cleanup_requests
         WHERE claimant_session_id = ? AND claimant_generation = ? AND status = 'claimed'`,
      )
      .get(sessionId, generation) as { cnt: number }).cnt;
    return { orchestratorRequestCount: orchReqCount, runtimeCleanupClaimCount: cleanupCount };
  }

  acceptOrchestratorHandoff(input: {
    oldSessionId: string;
    tokenHash: string;
    provider?: Provider | "";
    providerSessionId?: string;
  }): OrchestratorSessionRow {
    const identity = normalizeManualProviderSessionIdentity(input.provider ?? "", input.providerSessionId ?? "");
    const now = nowSeconds();
    const exec = this.db.transaction((): OrchestratorSessionRow => {
      const old = this.getOrchestratorSession(input.oldSessionId);
      if (
        old === null ||
        old.status !== "handoff_pending" ||
        old.handoffTokenHash !== input.tokenHash ||
        old.handoffExpiresAt === null ||
        old.handoffExpiresAt < now
      ) {
        throw new Error("handoff token が無効・期限切れ・既処理です");
      }
      this.assertSuccessorReplacementAllowed(old.orchestratorId);
      this.db.prepare(`UPDATE orchestrator_sessions SET status = 'superseded', updated_at = ? WHERE id = ?`).run(now, old.id);
      const next = this.insertOrchestratorSession({
        orchestratorId: old.orchestratorId,
        ...identity,
        now,
      });
      this.db
        .prepare(
          `UPDATE orchestrator_requests
           SET claimant_session_id = ?, claimant_generation = ?, updated_at = ?
           WHERE claimant_session_id = ? AND claimant_generation = ? AND status IN ('claimed', 'answering')`,
        )
        .run(next.id, next.generation, now, old.id, old.generation);
      this.transferRuntimeCleanupClaims({
        previousSessionId: old.id,
        previousGeneration: old.generation,
        nextSessionId: next.id,
        nextGeneration: next.generation,
        actor: old.orchestratorId,
        now,
      });
      this.transferHumanDecisionClaims({
        orchestratorId: old.orchestratorId,
        previousSessionId: old.id,
        previousGeneration: old.generation,
        nextSessionId: next.id,
        nextGeneration: next.generation,
        now,
      });
      // prepare 中に保留した未claim requestは、新generationのcontrollerへだけ配送する。
      this.db.prepare(
        `UPDATE runtime_cleanup_deliveries
         SET status = 'dismissed', updated_at = ?
         WHERE orchestrator_id <> ? AND status = 'pending' AND request_id IN (
           SELECT r.id
           FROM runtime_cleanup_requests r
           JOIN runtime_resource_leases l ON l.id = r.lease_id
           WHERE l.controller_orchestrator_id = ?
             AND r.decision_class = 'orchestrator'
             AND r.status IN ('queued', 'delivered')
         )`,
      ).run(now, old.orchestratorId, old.orchestratorId);
      return next;
    });
    return exec();
  }

  takeoverStaleOrchestratorSession(input: {
    orchestratorId: string;
    staleBefore: number;
    provider?: Provider | "";
    providerSessionId?: string;
  }): OrchestratorSessionRow {
    const identity = normalizeManualProviderSessionIdentity(input.provider ?? "", input.providerSessionId ?? "");
    const now = nowSeconds();
    const exec = this.db.transaction((): OrchestratorSessionRow => {
      this.assertSuccessorReplacementAllowed(input.orchestratorId);
      const liveRows = this.db
        .prepare(`SELECT * FROM orchestrator_sessions WHERE orchestrator_id = ? AND status IN ('active', 'handoff_pending')`)
        .all(input.orchestratorId) as RawOrchestratorSessionRow[];
      if (liveRows.some((row) => row.heartbeat_at >= input.staleBefore)) {
        throw new Error("active session は stale ではないため takeover できません");
      }
      for (const row of liveRows) {
        this.db.prepare(`UPDATE orchestrator_sessions SET status = 'stale', updated_at = ? WHERE id = ?`).run(now, row.id);
        this.db
          .prepare(
            `UPDATE orchestrator_requests
             SET status = 'queued', claimant_session_id = '', claimant_generation = NULL,
                 claim_token = '', lease_until = NULL, answer_key = '', updated_at = ?
             WHERE claimant_session_id = ? AND status IN ('claimed', 'answering')`,
          )
          .run(now, row.id);
        this.requeueRuntimeCleanupClaims({
          sessionId: row.id,
          generation: row.generation,
          actor: "orchestrator-stale-takeover",
          now,
        });
        this.requeueHumanDecisionClaims(row.id, row.generation, now);
      }
      return this.insertOrchestratorSession({
        orchestratorId: input.orchestratorId,
        ...identity,
        now,
      });
    });
    return exec();
  }

  expireStaleOrchestratorSessions(staleBefore: number, now: number): number {
    const exec = this.db.transaction((): number => {
      const rows = this.db
        .prepare(
          `SELECT * FROM orchestrator_sessions
           WHERE heartbeat_at < ? AND NOT EXISTS (
             SELECT 1 FROM orchestrator_successor_launches l
             WHERE l.source_session_id = orchestrator_sessions.id
               AND l.source_generation = orchestrator_sessions.generation
               AND l.status IN ('armed', 'runtime_bound', 'attested', 'accepting', 'stop_pending', 'uncertain')
           ) AND (
             status = 'active' OR
             (status = 'handoff_pending' AND (handoff_expires_at IS NULL OR handoff_expires_at < ?))
           )
           ORDER BY created_at, id`,
        )
        .all(staleBefore, now) as RawOrchestratorSessionRow[];
      for (const row of rows) {
        this.recordOrchestratorLivenessIncident(row, now);
        this.db
          .prepare(`UPDATE orchestrator_sessions SET status = 'stale', updated_at = ? WHERE id = ?`)
          .run(now, row.id);
        this.db
          .prepare(
            `UPDATE orchestrator_requests
             SET status = 'queued', claimant_session_id = '', claimant_generation = NULL,
                 claim_token = '', lease_until = NULL, answer_key = '', updated_at = ?
             WHERE claimant_session_id = ? AND status IN ('claimed', 'answering')`,
          )
          .run(now, row.id);
        this.requeueRuntimeCleanupClaims({
          sessionId: row.id,
          generation: row.generation,
          actor: "orchestrator-stale-expiry",
          now,
        });
        this.requeueHumanDecisionClaims(row.id, row.generation, now);
      }
      return rows.length;
    });
    return exec();
  }

  getOrchestratorLivenessIncident(
    sessionId: string,
    generation: number,
  ): OrchestratorLivenessIncidentRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM orchestrator_liveness_incidents
         WHERE session_id = ? AND generation = ?`,
      )
      .get(sessionId, generation) as RawOrchestratorLivenessIncidentRow | undefined;
    return row === undefined ? null : mapOrchestratorLivenessIncidentRow(row);
  }

  listPendingOrchestratorLivenessIncidents(
    now = nowSeconds(),
    limit = 100,
  ): OrchestratorLivenessIncidentRow[] {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("orchestrator liveness incident の limit は正の整数が必須です");
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM orchestrator_liveness_incidents
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY id LIMIT ?`,
      )
      .all(now, limit) as RawOrchestratorLivenessIncidentRow[];
    return rows.map(mapOrchestratorLivenessIncidentRow);
  }

  markOrchestratorLivenessIncident(
    id: number,
    expectedAttempts: number,
    status: OrchestratorLivenessIncidentStatus,
    nextAttemptAt: number,
    lastError: string,
    now = nowSeconds(),
  ): OrchestratorLivenessIncidentRow | null {
    const safeError = redactText(lastError).slice(0, 1_000);
    const info = this.db
      .prepare(
        `UPDATE orchestrator_liveness_incidents
         SET status = ?, attempts = attempts + 1, next_attempt_at = ?, last_error = ?,
             sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END, updated_at = ?
         WHERE id = ? AND status = 'pending' AND attempts = ?`,
      )
      .run(status, nextAttemptAt, safeError, status, now, now, id, expectedAttempts);
    if (info.changes !== 1) {
      return null;
    }
    return mapOrchestratorLivenessIncidentRow(
      this.db
        .prepare(`SELECT * FROM orchestrator_liveness_incidents WHERE id = ?`)
        .get(id) as RawOrchestratorLivenessIncidentRow,
    );
  }

  addOrchestratorWatch(input: {
    orchestratorId: string;
    scope: OrchestratorWatchScope;
    selector: string;
    role: OrchestratorWatchRole;
    priority?: number;
  }): OrchestratorWatchRow {
    if (this.getOrchestrator(input.orchestratorId) === null) {
      throw new Error(`orchestrator が見つかりません: ${input.orchestratorId}`);
    }
    const selector = input.selector.trim();
    if (selector.length === 0) {
      throw new Error("watch selector は空にできません");
    }
    const now = nowSeconds();
    const id = generateRoutingId("ow");
    this.db
      .prepare(
        `INSERT INTO orchestrator_watches (id, orchestrator_id, scope, selector, role, priority, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(orchestrator_id, scope, selector, role)
         DO UPDATE SET priority = excluded.priority, active = 1, updated_at = excluded.updated_at`,
      )
      .run(id, input.orchestratorId, input.scope, selector, input.role, input.priority ?? 0, now, now);
    const row = this.db
      .prepare(`SELECT * FROM orchestrator_watches WHERE orchestrator_id = ? AND scope = ? AND selector = ? AND role = ?`)
      .get(input.orchestratorId, input.scope, selector, input.role) as RawOrchestratorWatchRow;
    return mapOrchestratorWatchRow(row);
  }

  listOrchestratorWatches(orchestratorId?: string): OrchestratorWatchRow[] {
    const rows = (orchestratorId === undefined
      ? this.db.prepare(`SELECT * FROM orchestrator_watches ORDER BY priority DESC, created_at, id`).all()
      : this.db.prepare(`SELECT * FROM orchestrator_watches WHERE orchestrator_id = ? ORDER BY priority DESC, created_at, id`).all(orchestratorId)) as RawOrchestratorWatchRow[];
    return rows.map(mapOrchestratorWatchRow);
  }

  setOrchestratorWatchActive(watchId: string, active: boolean): OrchestratorWatchRow {
    const now = nowSeconds();
    const info = this.db.prepare(`UPDATE orchestrator_watches SET active = ?, updated_at = ? WHERE id = ?`).run(active ? 1 : 0, now, watchId);
    if (info.changes !== 1) {
      throw new Error(`watch が見つかりません: ${watchId}`);
    }
    return mapOrchestratorWatchRow(this.db.prepare(`SELECT * FROM orchestrator_watches WHERE id = ?`).get(watchId) as RawOrchestratorWatchRow);
  }

  bindTaskToOrchestrator(taskId: string, orchestratorId: string, role: OrchestratorWatchRole): TaskOrchestratorBindingRow {
    this.requireTaskRaw(taskId);
    if (this.getOrchestrator(orchestratorId) === null) {
      throw new Error(`orchestrator が見つかりません: ${orchestratorId}`);
    }
    const now = nowSeconds();
    this.db
      .prepare(
        `INSERT INTO task_orchestrator_bindings (task_id, orchestrator_id, role, created_at, released_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(task_id, orchestrator_id)
         DO UPDATE SET role = excluded.role, released_at = NULL`,
      )
      .run(taskId, orchestratorId, role, now);
    return mapTaskOrchestratorBindingRow(
      this.db.prepare(`SELECT * FROM task_orchestrator_bindings WHERE task_id = ? AND orchestrator_id = ?`).get(taskId, orchestratorId) as RawTaskOrchestratorBindingRow,
    );
  }

  listTaskOrchestratorBindings(taskId: string): TaskOrchestratorBindingRow[] {
    return (this.db
      .prepare(`SELECT * FROM task_orchestrator_bindings WHERE task_id = ? AND released_at IS NULL ORDER BY created_at`)
      .all(taskId) as RawTaskOrchestratorBindingRow[]).map(mapTaskOrchestratorBindingRow);
  }

  private ensureOrchestratorRequestDeliveries(
    requestId: string,
    taskId: string,
    worktree: string,
    project: string,
    now: number,
  ): { addedDeliveries: number; targetCount: number } {
    const targets = this.resolveOrchestratorDeliveryTargets({ taskId, worktree, project });
    let addedDeliveries = 0;
    for (const [orchestratorId, watchId] of targets) {
      const info = this.db
        .prepare(
          `INSERT OR IGNORE INTO orchestrator_deliveries (
             request_id, orchestrator_id, watch_id, status, created_at, updated_at
           ) VALUES (?, ?, ?, 'pending', ?, ?)`,
        )
        .run(requestId, orchestratorId, watchId, now, now);
      addedDeliveries += info.changes;
    }
    return { addedDeliveries, targetCount: targets.size };
  }

  createOrGetOrchestratorRequest(input: {
    taskId: string;
    questionId: string;
    question: string;
    context?: string;
    worktree?: string;
    project?: string;
  }): OrchestratorRequestRow {
    const question = input.question.trim();
    if (question.length === 0) {
      throw new Error("orchestrator request question は空にできません");
    }
    const exec = this.db.transaction((): OrchestratorRequestRow => {
      this.requireTaskRaw(input.taskId);
      const existing = this.db.prepare(`SELECT * FROM orchestrator_requests WHERE question_id = ?`).get(input.questionId) as RawOrchestratorRequestRow | undefined;
      if (existing !== undefined) {
        return mapOrchestratorRequestRow(existing);
      }
      const now = nowSeconds();
      const requestId = generateRoutingId("or");
      // stall 警告は worker_question と同じ durable request family を使うが、回答経路は共有しない。
      // 凍結済み Store input を広げず、互いに衝突しない exact-run 冪等キーを kind の判定根拠にする。
      const requestKind = input.questionId.startsWith("run-stall-suspected:")
        ? "run_stall_suspected"
        : input.questionId.startsWith("run-stalled:")
          ? "run_stalled"
          : input.questionId.startsWith("session-budget:")
            ? "session_budget"
            : "worker_question";
      this.db
        .prepare(
          `INSERT INTO orchestrator_requests (
             id, task_id, question_id, kind, status, question, context, worktree, project, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          requestId,
          input.taskId,
          input.questionId,
          requestKind,
          question,
          input.context ?? "",
          input.worktree ?? "",
          input.project ?? "",
          now,
          now,
        );

      const routing = this.ensureOrchestratorRequestDeliveries(
        requestId,
        input.taskId,
        input.worktree ?? "",
        input.project ?? "",
        now,
      );
      // session budget は monitor stage が §38 通知を直接送るため、通常 request の outbox を重ねない。
      if (requestKind !== "session_budget") {
        const kind = routing.targetCount > 0 ? "orchestrator_fyi" : "orchestrator_unavailable";
        const dedupeKey = `${requestId}:0:${kind}:configured`;
        this.db
          .prepare(
            `INSERT INTO notification_outbox (
               task_id, request_id, dedupe_key, kind, transport, payload, status, next_attempt_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'configured', ?, 'pending', 0, ?, ?)`,
          )
          .run(input.taskId, requestId, dedupeKey, kind, JSON.stringify({ question, targetCount: routing.targetCount }), now, now);
      }
      return mapOrchestratorRequestRow(this.db.prepare(`SELECT * FROM orchestrator_requests WHERE id = ?`).get(requestId) as RawOrchestratorRequestRow);
    });
    return exec();
  }

  getOrchestratorRequest(id: string): OrchestratorRequestRow | null {
    const row = this.db.prepare(`SELECT * FROM orchestrator_requests WHERE id = ?`).get(id) as RawOrchestratorRequestRow | undefined;
    return row === undefined ? null : mapOrchestratorRequestRow(row);
  }

  getActiveOrchestratorRequestByTask(taskId: string): OrchestratorRequestRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM orchestrator_requests
         WHERE task_id = ? AND kind = 'worker_question' AND status NOT IN ('resolved', 'cancelled')
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(taskId) as RawOrchestratorRequestRow | undefined;
    return row === undefined ? null : mapOrchestratorRequestRow(row);
  }

  listOrchestratorRequests(orchestratorId?: string): OrchestratorRequestRow[] {
    const rows = (orchestratorId === undefined
      ? this.db.prepare(`SELECT * FROM orchestrator_requests WHERE status NOT IN ('resolved', 'cancelled') ORDER BY created_at, id`).all()
      : this.db
          .prepare(
            `SELECT r.* FROM orchestrator_requests r
             JOIN orchestrator_deliveries d ON d.request_id = r.id
             WHERE d.orchestrator_id = ? AND r.status NOT IN ('resolved', 'cancelled')
             ORDER BY r.created_at, r.id`,
          )
          .all(orchestratorId)) as RawOrchestratorRequestRow[];
    return rows.map(mapOrchestratorRequestRow);
  }

  reconcileOrchestratorRequestRouting(requestId: string): OrchestratorRoutingReconcileResult {
    const normalizedRequestId = requireNonEmptyString(requestId, "orchestrator request ID").trim();
    const exec = this.db.transaction((): OrchestratorRoutingReconcileResult => {
      const request = this.db
        .prepare(`SELECT * FROM orchestrator_requests WHERE id = ?`)
        .get(normalizedRequestId) as RawOrchestratorRequestRow | undefined;
      if (request === undefined) {
        throw new Error(`orchestrator request が見つかりません: ${normalizedRequestId}`);
      }
      if (request.status === "resolved" || request.status === "cancelled") {
        return { requestId: normalizedRequestId, addedDeliveries: 0, cancelled: false };
      }
      const task = this.requireTaskRaw(request.task_id);
      const now = nowSeconds();
      if ((task.status === "done" || task.status === "archived") &&
          (request.status === "queued" || request.status === "delivered")) {
        const info = this.db.prepare(
          `UPDATE orchestrator_requests
           SET status = 'cancelled', resolved_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('queued', 'delivered')`,
        ).run(now, now, normalizedRequestId);
        if (info.changes === 1) {
          this.addEvent(task.id, "orchestrator_request_terminal_cancelled", "supervisor", {
            requestId: normalizedRequestId,
            taskStatus: task.status,
          });
          return { requestId: normalizedRequestId, addedDeliveries: 0, cancelled: true };
        }
        return { requestId: normalizedRequestId, addedDeliveries: 0, cancelled: false };
      }
      if (request.status !== "queued" && request.status !== "delivered") {
        return { requestId: normalizedRequestId, addedDeliveries: 0, cancelled: false };
      }
      const routing = this.ensureOrchestratorRequestDeliveries(
        normalizedRequestId,
        request.task_id,
        request.worktree,
        request.project,
        now,
      );
      if (routing.addedDeliveries > 0) {
        if (request.kind !== "session_budget") {
          this.db.prepare(
            `INSERT OR IGNORE INTO notification_outbox (
               task_id, request_id, dedupe_key, kind, transport, payload, status, next_attempt_at, created_at, updated_at
             ) VALUES (?, ?, ?, 'orchestrator_fyi', 'configured', ?, 'pending', 0, ?, ?)`,
          ).run(
            request.task_id,
            normalizedRequestId,
            `${normalizedRequestId}:0:orchestrator_fyi:rerouted`,
            JSON.stringify({ question: request.question, targetCount: routing.targetCount, rerouted: true }),
            now,
            now,
          );
        }
        this.db.prepare(`UPDATE orchestrator_requests SET updated_at = ? WHERE id = ?`).run(now, normalizedRequestId);
        this.addEvent(request.task_id, "orchestrator_request_rerouted", "supervisor", {
          requestId: normalizedRequestId,
          addedDeliveries: routing.addedDeliveries,
          targetCount: routing.targetCount,
        });
      }
      return {
        requestId: normalizedRequestId,
        addedDeliveries: routing.addedDeliveries,
        cancelled: false,
      };
    });
    return exec();
  }

  markOrchestratorDeliveriesDelivered(orchestratorId: string): number {
    if (this.getOrchestrator(orchestratorId) === null) {
      throw new Error(`orchestrator が見つかりません: ${orchestratorId}`);
    }
    const now = nowSeconds();
    const exec = this.db.transaction((): number => {
      const requestRows = this.db
        .prepare(
          `SELECT request_id FROM orchestrator_deliveries
           WHERE orchestrator_id = ? AND status = 'pending' ORDER BY id`,
        )
        .all(orchestratorId) as Array<{ request_id: string }>;
      if (requestRows.length === 0) {
        return 0;
      }
      this.db
        .prepare(
          `UPDATE orchestrator_deliveries SET status = 'delivered', updated_at = ?
           WHERE orchestrator_id = ? AND status = 'pending'`,
        )
        .run(now, orchestratorId);
      const updateRequest = this.db.prepare(
        `UPDATE orchestrator_requests SET status = 'delivered', updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      );
      for (const row of requestRows) {
        updateRequest.run(now, row.request_id);
      }
      return requestRows.length;
    });
    return exec();
  }

  // ===== contract §69: steward 提案の orchestrator inbox ルーティング =====

  private requireStewardProposalRaw(id: string): RawStewardProposalRequestRow {
    const row = this.db.prepare(`SELECT * FROM steward_proposal_requests WHERE id = ?`).get(id) as
      | RawStewardProposalRequestRow
      | undefined;
    if (row === undefined) {
      throw new Error(`steward 提案 request が見つかりません: ${id}`);
    }
    return row;
  }

  /** claim 保持者の exact (orchestrator, session, generation) を active session 表で再照合する。 */
  private requireActiveStewardProposalPrincipal(
    orchestratorId: string,
    sessionId: string,
    generation: number,
  ): RawOrchestratorSessionRow {
    const session = this.db
      .prepare(
        `SELECT * FROM orchestrator_sessions
         WHERE id = ? AND generation = ? AND status = 'active' AND orchestrator_id = ?`,
      )
      .get(sessionId, generation, orchestratorId) as RawOrchestratorSessionRow | undefined;
    if (session === undefined) {
      throw new Error("steward 提案の session generation/identity が不正です");
    }
    return session;
  }

  /** claimed 保持者だけが通せる CAS。lease 期限切れ・別 session・token 不一致は 0 行更新で弾く。 */
  private resolveClaimedStewardProposal(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    status: StewardProposalStatus;
    now: number;
    extraSet: string;
    extraParams: readonly (string | number | null)[];
  }): StewardProposalRequestRow {
    this.requireActiveStewardProposalPrincipal(input.orchestratorId, input.sessionId, input.generation);
    this.requireStewardProposalRaw(input.requestId);
    const info = this.db
      .prepare(
        `UPDATE steward_proposal_requests
         SET status = ?${input.extraSet}, resolved_at = ?, updated_at = ?
         WHERE id = ? AND status = 'claimed' AND claimant_session_id = ? AND claimant_generation = ?
           AND claim_token_hash = ? AND claim_lease_until > ?`,
      )
      .run(
        input.status,
        ...input.extraParams,
        input.now,
        input.now,
        input.requestId,
        input.sessionId,
        input.generation,
        sha256RuntimeValue(input.claimToken),
        input.now,
      );
    if (info.changes !== 1) {
      throw new Error("steward 提案の claim CAS に失敗しました（claim 保持者/lease を確認してください）");
    }
    // resolver が決着させたので、他 identity への未処理 delivery は inbox に残さず閉じる。
    this.db
      .prepare(
        `UPDATE steward_proposal_deliveries SET status = 'dismissed', updated_at = ?
         WHERE request_id = ? AND status IN ('pending', 'delivered')`,
      )
      .run(input.now, input.requestId);
    return mapStewardProposalRequestRow(this.requireStewardProposalRaw(input.requestId));
  }

  /** 未 claim の request を終端化し、その delivery も同時に閉じる。claimed 以降は対象外（§69.2）。 */
  private closeUnclaimedStewardProposals(input: {
    where: string;
    params: readonly (string | number)[];
    status: "superseded" | "cancelled";
    reason: string;
    now: number;
  }): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM steward_proposal_requests
         WHERE ${input.where} AND status IN ('queued', 'delivered')`,
      )
      .all(...input.params) as Array<{ id: string }>;
    if (rows.length === 0) {
      return [];
    }
    const updateRequest = this.db.prepare(
      `UPDATE steward_proposal_requests
       SET status = ?, resolution_reason = ?, resolved_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'delivered')`,
    );
    const updateDeliveries = this.db.prepare(
      `UPDATE steward_proposal_deliveries SET status = 'dismissed', updated_at = ?
       WHERE request_id = ? AND status IN ('pending', 'delivered')`,
    );
    const closed: string[] = [];
    for (const row of rows) {
      if (updateRequest.run(input.status, input.reason, input.now, input.now, row.id).changes === 1) {
        updateDeliveries.run(input.now, row.id);
        closed.push(row.id);
      }
    }
    return closed;
  }

  /**
   * steward 提案を durable request 面へ登録する（contract §69.3 / §69.4）。
   * 抑止判定 → 配送先解決 → request + 全 delivery 作成、までを単一 Tx で行う。
   * 抑止時と配送先 0 件時は request も delivery も作らない（後者は呼び出し側が §38 通知へフォールスルーする）。
   */
  createStewardProposalRequest(input: {
    taskId: string;
    kind: StewardProposalKind;
    reason: string;
    worktree?: string;
    project?: string;
    tenantDefaults?: Record<string, string>;
    now?: number;
  }): StewardProposalCreateResult {
    const reason = redactText(input.reason.trim());
    if (reason === "") {
      throw new Error("steward 提案の reason は必須です");
    }
    if (!STEWARD_PROPOSAL_KINDS.includes(input.kind)) {
      throw new Error(`steward 提案の kind が不正です: ${input.kind}`);
    }
    const now = input.now ?? nowSeconds();
    const exec = this.db.transaction((): StewardProposalCreateResult => {
      const task = this.requireTaskRaw(input.taskId);

      // 1. 未終端（queued|delivered|claimed）が居る間は再提案しない
      const active = this.db
        .prepare(
          `SELECT id FROM steward_proposal_requests
           WHERE task_id = ? AND kind = ? AND status IN ('queued', 'delivered', 'claimed')
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(input.taskId, input.kind) as { id: string } | undefined;
      if (active !== undefined) {
        return { outcome: "suppressed", suppressedBy: "active_request", suppressedUntil: null, blockingRequestId: active.id };
      }

      // 2. deferred は defer_until まで抑止する
      const deferred = this.db
        .prepare(
          `SELECT id, defer_until FROM steward_proposal_requests
           WHERE task_id = ? AND kind = ? AND status = 'deferred' AND defer_until IS NOT NULL AND defer_until > ?
           ORDER BY defer_until DESC, id DESC LIMIT 1`,
        )
        .get(input.taskId, input.kind, now) as { id: string; defer_until: number } | undefined;
      if (deferred !== undefined) {
        return { outcome: "suppressed", suppressedBy: "deferred", suppressedUntil: deferred.defer_until, blockingRequestId: deferred.id };
      }

      // 3. dismissed は却下累計に応じたバックオフ窓の間だけ抑止する。窓の起点は dismissed_at のみ
      const dismissed = this.db
        .prepare(
          `SELECT id, dismissed_at, dismiss_count FROM steward_proposal_requests
           WHERE task_id = ? AND kind = ? AND status = 'dismissed' AND dismissed_at IS NOT NULL
           ORDER BY dismissed_at DESC, dismiss_count DESC, id DESC LIMIT 1`,
        )
        .get(input.taskId, input.kind) as { id: string; dismissed_at: number; dismiss_count: number } | undefined;
      if (dismissed !== undefined) {
        const until = dismissed.dismissed_at + stewardProposalDismissWindowSeconds(dismissed.dismiss_count);
        if (until > now) {
          return { outcome: "suppressed", suppressedBy: "dismiss_backoff", suppressedUntil: until, blockingRequestId: dismissed.id };
        }
      }

      // 4. accepted 済みは、その後 task status が動くまで役目を終えたものとして抑止する
      const accepted = this.db
        .prepare(
          `SELECT id, accepted_task_status FROM steward_proposal_requests
           WHERE task_id = ? AND kind = ? AND status = 'accepted'
           ORDER BY resolved_at DESC, updated_at DESC, id DESC LIMIT 1`,
        )
        .get(input.taskId, input.kind) as { id: string; accepted_task_status: string } | undefined;
      if (accepted !== undefined && accepted.accepted_task_status === task.status) {
        return { outcome: "suppressed", suppressedBy: "accepted", suppressedUntil: null, blockingRequestId: accepted.id };
      }

      // 配送先 0 件は fail-closed。§55.6 の「配送先のない active request は doctor NG」を踏まない
      const targets = this.resolveOrchestratorDeliveryTargets({
        taskId: input.taskId,
        worktree: input.worktree ?? "",
        project: input.project ?? "",
      });
      const hasActiveBinding = this.db
        .prepare(
          `SELECT 1 FROM task_orchestrator_bindings
           WHERE task_id = ? AND released_at IS NULL LIMIT 1`,
        )
        .get(input.taskId) !== undefined;
      let routedByTenantDefault = false;
      if (targets.size === 0 && !hasActiveBinding) {
        const tenantDefault = input.tenantDefaults?.[task.tenant];
        if (tenantDefault !== undefined) {
          const liveSession = this.db
            .prepare(
              `SELECT 1 FROM orchestrator_sessions
               WHERE orchestrator_id = ? AND status = 'active' AND heartbeat_at >= ? LIMIT 1`,
            )
            .get(tenantDefault, now - ORCHESTRATOR_SESSION_STALE_SECONDS);
          if (liveSession !== undefined) {
            targets.set(tenantDefault, null);
            routedByTenantDefault = true;
          }
        }
      }
      if (targets.size === 0) {
        this.insertTaskEvent(input.taskId, "steward_proposal_unrouted", "steward", { kind: input.kind, reason }, now);
        return { outcome: "unrouted" };
      }

      const requestId = generateRoutingId("sp");
      this.db
        .prepare(
          `INSERT INTO steward_proposal_requests (
             id, task_id, kind, reason, routed_by, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(requestId, input.taskId, input.kind, reason, routedByTenantDefault ? "tenant-default" : "", now, now);
      const insertDelivery = this.db.prepare(
        `INSERT INTO steward_proposal_deliveries (
           request_id, orchestrator_id, watch_id, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', ?, ?)`,
      );
      for (const [orchestratorId, watchId] of targets) {
        insertDelivery.run(requestId, orchestratorId, watchId, now, now);
      }
      this.insertTaskEvent(input.taskId, "steward_proposal_requested", "steward", {
        requestId,
        kind: input.kind,
        targetCount: targets.size,
        ...(routedByTenantDefault ? { routedBy: "tenant-default" } : {}),
      }, now);
      return {
        outcome: "created",
        request: mapStewardProposalRequestRow(this.requireStewardProposalRaw(requestId)),
        targetCount: targets.size,
      };
    });
    return exec();
  }

  getStewardProposalRequest(id: string): StewardProposalRequestRow | null {
    const row = this.db.prepare(`SELECT * FROM steward_proposal_requests WHERE id = ?`).get(id) as
      | RawStewardProposalRequestRow
      | undefined;
    return row === undefined ? null : mapStewardProposalRequestRow(row);
  }

  /** orchestrator inbox（§69.7）が使う未終端提案一覧。orchestratorId 省略時は board 全体。 */
  listStewardProposalRequests(orchestratorId?: string): StewardProposalRequestRow[] {
    const rows = (orchestratorId === undefined
      ? this.db
          .prepare(
            `SELECT * FROM steward_proposal_requests
             WHERE status IN ('queued', 'delivered', 'claimed')
             ORDER BY created_at, id`,
          )
          .all()
      : this.db
          .prepare(
            `SELECT r.* FROM steward_proposal_requests r
             JOIN steward_proposal_deliveries d ON d.request_id = r.id
             WHERE d.orchestrator_id = ? AND r.status IN ('queued', 'delivered', 'claimed')
             ORDER BY r.created_at, r.id`,
          )
          .all(orchestratorId)) as RawStewardProposalRequestRow[];
    return rows.map(mapStewardProposalRequestRow);
  }

  listStewardProposalDeliveries(requestId: string): StewardProposalDeliveryRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM steward_proposal_deliveries WHERE request_id = ? ORDER BY id`)
      .all(requestId) as RawStewardProposalDeliveryRow[];
    return rows.map(mapStewardProposalDeliveryRow);
  }

  /** inbox/await が配送を観測した時点で pending→delivered、request も queued→delivered へ進める（§69.2）。 */
  markStewardProposalDeliveriesDelivered(orchestratorId: string, now = nowSeconds()): number {
    if (this.getOrchestrator(orchestratorId) === null) {
      throw new Error(`orchestrator が見つかりません: ${orchestratorId}`);
    }
    const exec = this.db.transaction((): number => {
      const requestRows = this.db
        .prepare(
          `SELECT request_id FROM steward_proposal_deliveries
           WHERE orchestrator_id = ? AND status = 'pending' ORDER BY id`,
        )
        .all(orchestratorId) as Array<{ request_id: string }>;
      if (requestRows.length === 0) {
        return 0;
      }
      this.db
        .prepare(
          `UPDATE steward_proposal_deliveries SET status = 'delivered', updated_at = ?
           WHERE orchestrator_id = ? AND status = 'pending'`,
        )
        .run(now, orchestratorId);
      const updateRequest = this.db.prepare(
        `UPDATE steward_proposal_requests SET status = 'delivered', updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      );
      for (const row of requestRows) {
        updateRequest.run(now, row.request_id);
      }
      return requestRows.length;
    });
    return exec();
  }

  /** CAS + lease で resolver を 1 つに絞る（§69.2）。lease 切れの claimed だけ再 claim できる。 */
  claimStewardProposalRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    leaseUntil: number;
    now?: number;
  }): StewardProposalRequestRow {
    const now = input.now ?? nowSeconds();
    if (input.claimToken === "" || input.leaseUntil <= now) {
      throw new Error("steward 提案 claim の token/leaseUntil が不正です");
    }
    const exec = this.db.transaction((): StewardProposalRequestRow => {
      this.requireStewardProposalRaw(input.requestId);
      this.requireActiveStewardProposalPrincipal(input.orchestratorId, input.sessionId, input.generation);
      const delivery = this.db
        .prepare(
          `SELECT 1 FROM steward_proposal_deliveries
           WHERE request_id = ? AND orchestrator_id = ? AND status IN ('pending', 'delivered', 'acknowledged')`,
        )
        .get(input.requestId, input.orchestratorId);
      if (delivery === undefined) {
        throw new Error("steward 提案が当該 orchestrator へ配送されていません");
      }
      const info = this.db
        .prepare(
          `UPDATE steward_proposal_requests
           SET status = 'claimed', claimant_session_id = ?, claimant_generation = ?,
               claim_token_hash = ?, claim_lease_until = ?, updated_at = ?
           WHERE id = ?
             AND (status IN ('queued', 'delivered') OR
                  (status = 'claimed' AND claim_lease_until IS NOT NULL AND claim_lease_until <= ?))`,
        )
        .run(
          input.sessionId,
          input.generation,
          sha256RuntimeValue(input.claimToken),
          input.leaseUntil,
          now,
          input.requestId,
          now,
        );
      if (info.changes !== 1) {
        throw new Error("steward 提案は既に claim 済みです");
      }
      // claim 成功を acknowledge とする（§55.2 と同型）
      this.db
        .prepare(
          `UPDATE steward_proposal_deliveries SET status = 'acknowledged', updated_at = ?
           WHERE request_id = ? AND orchestrator_id = ?`,
        )
        .run(now, input.requestId, input.orchestratorId);
      const claimed = this.requireStewardProposalRaw(input.requestId);
      this.insertTaskEvent(claimed.task_id, "steward_proposal_claimed", "orchestrator", {
        requestId: input.requestId,
        kind: claimed.kind,
        orchestratorId: input.orchestratorId,
        generation: input.generation,
      }, now);
      return mapStewardProposalRequestRow(claimed);
    });
    return exec();
  }

  /**
   * 提案を採用した記録を残す（§69.2）。accept は採用の監査点であって status 遷移の実行ではないため、
   * ここで task を promote/archive したりはしない。accept 時点の task status を保持し、§69.4-4 の抑止に使う。
   */
  acceptStewardProposalRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    note?: string;
    now?: number;
  }): StewardProposalRequestRow {
    const now = input.now ?? nowSeconds();
    const note = redactText((input.note ?? "").trim());
    const exec = this.db.transaction((): StewardProposalRequestRow => {
      const before = this.requireStewardProposalRaw(input.requestId);
      const task = this.requireTaskRaw(before.task_id);
      const accepted = this.resolveClaimedStewardProposal({
        requestId: input.requestId,
        orchestratorId: input.orchestratorId,
        sessionId: input.sessionId,
        generation: input.generation,
        claimToken: input.claimToken,
        status: "accepted",
        now,
        extraSet: ", accepted_task_status = ?, resolution_reason = ?",
        extraParams: [task.status, note],
      });
      this.insertTaskEvent(before.task_id, "steward_proposal_accepted", "orchestrator", {
        requestId: input.requestId,
        kind: before.kind,
        orchestratorId: input.orchestratorId,
        taskStatus: task.status,
      }, now);
      return accepted;
    });
    return exec();
  }

  /** 「今回は採らない」。理由必須で、(kind, taskId) の却下累計を進めてバックオフ窓を伸ばす（§69.4-3）。 */
  dismissStewardProposalRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    reason: string;
    now?: number;
  }): StewardProposalRequestRow {
    const now = input.now ?? nowSeconds();
    const reason = redactText(input.reason.trim());
    if (reason === "") {
      throw new Error("steward 提案 dismiss の reason は必須です");
    }
    const exec = this.db.transaction((): StewardProposalRequestRow => {
      const before = this.requireStewardProposalRaw(input.requestId);
      const previous = this.db
        .prepare(
          `SELECT COALESCE(MAX(dismiss_count), 0) AS max_count FROM steward_proposal_requests
           WHERE task_id = ? AND kind = ?`,
        )
        .get(before.task_id, before.kind) as { max_count: number };
      const dismissCount = previous.max_count + 1;
      const dismissed = this.resolveClaimedStewardProposal({
        requestId: input.requestId,
        orchestratorId: input.orchestratorId,
        sessionId: input.sessionId,
        generation: input.generation,
        claimToken: input.claimToken,
        status: "dismissed",
        now,
        // 窓の起点は dismissed_at のみ。updated_at は他の更新でも動くので判定には使わない
        extraSet: ", resolution_reason = ?, dismissed_at = ?, dismiss_count = ?",
        extraParams: [reason, now, dismissCount],
      });
      this.insertTaskEvent(before.task_id, "steward_proposal_dismissed", "orchestrator", {
        requestId: input.requestId,
        kind: before.kind,
        orchestratorId: input.orchestratorId,
        dismissCount,
        backoffSeconds: stewardProposalDismissWindowSeconds(dismissCount),
      }, now);
      return dismissed;
    });
    return exec();
  }

  /** defer_until まで同一 (kind, taskId) の再提案を止める（§69.2 / §69.4-2）。 */
  deferStewardProposalRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    deferUntil: number;
    reason?: string;
    now?: number;
  }): StewardProposalRequestRow {
    const now = input.now ?? nowSeconds();
    if (!Number.isInteger(input.deferUntil) || input.deferUntil <= now) {
      throw new Error("steward 提案 defer の deferUntil は未来の秒指定が必須です");
    }
    const reason = redactText((input.reason ?? "").trim());
    const exec = this.db.transaction((): StewardProposalRequestRow => {
      const before = this.requireStewardProposalRaw(input.requestId);
      const deferred = this.resolveClaimedStewardProposal({
        requestId: input.requestId,
        orchestratorId: input.orchestratorId,
        sessionId: input.sessionId,
        generation: input.generation,
        claimToken: input.claimToken,
        status: "deferred",
        now,
        extraSet: ", resolution_reason = ?, defer_until = ?",
        extraParams: [reason, input.deferUntil],
      });
      this.insertTaskEvent(before.task_id, "steward_proposal_deferred", "orchestrator", {
        requestId: input.requestId,
        kind: before.kind,
        orchestratorId: input.orchestratorId,
        deferUntil: input.deferUntil,
      }, now);
      return deferred;
    });
    return exec();
  }

  /** steward がより新しい reason で再評価したときの差し替え。未 claim（queued|delivered）だけが対象（§69.2）。 */
  supersedeStewardProposalRequest(input: {
    requestId: string;
    reason?: string;
    now?: number;
  }): StewardProposalRequestRow {
    const now = input.now ?? nowSeconds();
    const reason = redactText((input.reason ?? "").trim());
    const exec = this.db.transaction((): StewardProposalRequestRow => {
      const before = this.requireStewardProposalRaw(input.requestId);
      const closed = this.closeUnclaimedStewardProposals({
        where: "id = ?",
        params: [input.requestId],
        status: "superseded",
        reason,
        now,
      });
      if (closed.length !== 1) {
        throw new Error("steward 提案 supersede は未 claim（queued|delivered）だけが対象です");
      }
      this.insertTaskEvent(before.task_id, "steward_proposal_superseded", "steward", {
        requestId: input.requestId,
        kind: before.kind,
      }, now);
      return mapStewardProposalRequestRow(this.requireStewardProposalRaw(input.requestId));
    });
    return exec();
  }

  /**
   * task が done/archived へ先行したときの回収（§69.2）。未 claim の queued|delivered だけを cancelled にし、
   * claimed 以降は既存 claim を維持する。終端でない task では何もしない。
   */
  cancelStewardProposalRequestsForTerminalTask(taskId: string, now = nowSeconds()): string[] {
    const exec = this.db.transaction((): string[] => {
      const task = this.requireTaskRaw(taskId);
      if (task.status !== "done" && task.status !== "archived") {
        return [];
      }
      const closed = this.closeUnclaimedStewardProposals({
        where: "task_id = ?",
        params: [taskId],
        status: "cancelled",
        reason: `task status = ${task.status}`,
        now,
      });
      if (closed.length > 0) {
        this.insertTaskEvent(taskId, "steward_proposal_terminal_cancelled", "supervisor", {
          requestIds: closed,
          taskStatus: task.status,
        }, now);
      }
      return closed;
    });
    return exec();
  }

  /** doctor 表示用（§69.7）。配送先ゼロのフォールスルーは NG ではなく情報として数える。 */
  getStewardProposalHealth(input?: { now?: number; unroutedSince?: number }): StewardProposalHealth {
    const now = input?.now ?? nowSeconds();
    // 既定は §40.4 の 24h 冪等窓に合わせる。累計にすると doctor の数字が単調増加して健全性の信号にならない
    const unroutedSince = input?.unroutedSince ?? now - STEWARD_PROPOSAL_UNROUTED_WINDOW_SECONDS;
    const pending = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM steward_proposal_requests
         WHERE status IN ('queued', 'delivered', 'claimed')`,
      )
      .get() as { count: number; oldest: number | null };
    const unrouted = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM task_events
         WHERE event_type = 'steward_proposal_unrouted' AND created_at >= ?`,
      )
      .get(unroutedSince) as { count: number };
    return {
      pendingCount: pending.count,
      oldestPendingCreatedAt: pending.oldest,
      oldestPendingAgeSeconds: pending.oldest === null ? 0 : Math.max(0, now - pending.oldest),
      unroutedCount: unrouted.count,
    };
  }

  private requireActiveOrchestratorSession(sessionId: string, generation: number): OrchestratorSessionRow {
    const session = this.getOrchestratorSession(sessionId);
    if (session === null || session.status !== "active" || session.generation !== generation) {
      throw new Error("SESSION_SUPERSEDED: active generation と一致しません");
    }
    return session;
  }

  claimOrchestratorRequest(input: {
    requestId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    leaseUntil: number;
  }): OrchestratorRequestRow {
    const now = nowSeconds();
    const exec = this.db.transaction((): OrchestratorRequestRow => {
      const session = this.requireActiveOrchestratorSession(input.sessionId, input.generation);
      const delivery = this.db
        .prepare(`SELECT * FROM orchestrator_deliveries WHERE request_id = ? AND orchestrator_id = ?`)
        .get(input.requestId, session.orchestratorId) as RawOrchestratorDeliveryRow | undefined;
      if (delivery === undefined) {
        throw new Error("この session は request の配送対象ではありません");
      }
      const roleRow = delivery.watch_id === null
        ? this.db
            .prepare(`SELECT role FROM task_orchestrator_bindings WHERE task_id = (SELECT task_id FROM orchestrator_requests WHERE id = ?) AND orchestrator_id = ? AND released_at IS NULL`)
            .get(input.requestId, session.orchestratorId) as { role: string } | undefined
        : this.db.prepare(`SELECT role FROM orchestrator_watches WHERE id = ? AND active = 1`).get(delivery.watch_id) as { role: string } | undefined;
      if (roleRow === undefined || roleRow.role === "observer") {
        throw new Error("observer または無効な watch は request を claim できません");
      }
      if (roleRow.role === "collaborator") {
        const siblingDeliveries = this.db
          .prepare(`SELECT * FROM orchestrator_deliveries WHERE request_id = ? AND orchestrator_id <> ?`)
          .all(input.requestId, session.orchestratorId) as RawOrchestratorDeliveryRow[];
        const primaryIsLive = siblingDeliveries.some((sibling): boolean => {
          const siblingRole = sibling.watch_id === null
            ? this.db
                .prepare(
                  `SELECT role FROM task_orchestrator_bindings
                   WHERE task_id = (SELECT task_id FROM orchestrator_requests WHERE id = ?)
                     AND orchestrator_id = ? AND released_at IS NULL`,
                )
                .get(input.requestId, sibling.orchestrator_id) as { role: string } | undefined
            : this.db
                .prepare(`SELECT role FROM orchestrator_watches WHERE id = ? AND active = 1`)
                .get(sibling.watch_id) as { role: string } | undefined;
          if (siblingRole?.role !== "primary") {
            return false;
          }
          const liveSession = this.db
            .prepare(
              `SELECT 1 FROM orchestrator_sessions
               WHERE orchestrator_id = ? AND status = 'active' AND heartbeat_at >= ? LIMIT 1`,
            )
            .get(sibling.orchestrator_id, now - ORCHESTRATOR_SESSION_STALE_SECONDS);
          return liveSession !== undefined;
        });
        if (primaryIsLive) {
          throw new Error("生存中の primary orchestrator があるため collaborator は claim できません");
        }
      }
      const info = this.db
        .prepare(
          `UPDATE orchestrator_requests
           SET status = 'claimed', claimant_session_id = ?, claimant_generation = ?, claim_token = ?,
               lease_until = ?, answer_key = '', updated_at = ?
           WHERE id = ? AND (
             status IN ('queued', 'delivered') OR
             (status = 'claimed' AND lease_until IS NOT NULL AND lease_until < ?)
           )`,
        )
        .run(input.sessionId, input.generation, input.claimToken, input.leaseUntil, now, input.requestId, now);
      if (info.changes !== 1) {
        throw new Error("request は他の session が claim 済みです");
      }
      this.db.prepare(`UPDATE orchestrator_deliveries SET status = 'acknowledged', updated_at = ? WHERE id = ?`).run(now, delivery.id);
      return this.getOrchestratorRequest(input.requestId)!;
    });
    return exec();
  }

  releaseOrchestratorRequest(input: {
    requestId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
  }): OrchestratorRequestRow {
    this.requireActiveOrchestratorSession(input.sessionId, input.generation);
    const now = nowSeconds();
    const info = this.db
      .prepare(
        `UPDATE orchestrator_requests
         SET status = 'queued', claimant_session_id = '', claimant_generation = NULL,
             claim_token = '', lease_until = NULL, answer_key = '', updated_at = ?
         WHERE id = ? AND claimant_session_id = ? AND claimant_generation = ? AND claim_token = ? AND status = 'claimed'`,
      )
      .run(now, input.requestId, input.sessionId, input.generation, input.claimToken);
    if (info.changes !== 1) {
      throw new Error("request claim が一致しません");
    }
    return this.getOrchestratorRequest(input.requestId)!;
  }

  beginOrchestratorRequestAnswer(input: {
    requestId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    answerKey: string;
  }): OrchestratorRequestRow {
    this.requireActiveOrchestratorSession(input.sessionId, input.generation);
    const now = nowSeconds();
    const info = this.db
      .prepare(
        `UPDATE orchestrator_requests SET status = 'answering', answer_key = ?, updated_at = ?
         WHERE id = ? AND status = 'claimed' AND claimant_session_id = ? AND claimant_generation = ?
           AND claim_token = ? AND lease_until >= ?`,
      )
      .run(input.answerKey, now, input.requestId, input.sessionId, input.generation, input.claimToken, now);
    if (info.changes !== 1) {
      throw new Error("request answer の fencing 検証に失敗しました");
    }
    return this.getOrchestratorRequest(input.requestId)!;
  }

  resolveOrchestratorRequestByAnswerKey(taskId: string, answerKey: string): OrchestratorRequestRow | null {
    const now = nowSeconds();
    const row = this.db
      .prepare(`SELECT * FROM orchestrator_requests WHERE task_id = ? AND status = 'answering' AND answer_key = ?`)
      .get(taskId, answerKey) as RawOrchestratorRequestRow | undefined;
    if (row === undefined) {
      return null;
    }
    this.db
      .prepare(`UPDATE orchestrator_requests SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, row.id);
    return this.getOrchestratorRequest(row.id);
  }

  failOrchestratorRequestAnswer(taskId: string, answerKey: string): OrchestratorRequestRow | null {
    const now = nowSeconds();
    const row = this.db
      .prepare(`SELECT * FROM orchestrator_requests WHERE task_id = ? AND status = 'answering' AND answer_key = ?`)
      .get(taskId, answerKey) as RawOrchestratorRequestRow | undefined;
    if (row === undefined) {
      return null;
    }
    this.db
      .prepare(`UPDATE orchestrator_requests SET status = 'claimed', answer_key = '', updated_at = ? WHERE id = ?`)
      .run(now, row.id);
    return this.getOrchestratorRequest(row.id);
  }

  escalateOrchestratorRequest(input: {
    requestId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    question: string;
  }): OrchestratorRequestRow {
    const question = input.question.trim();
    if (question.length === 0) {
      throw new Error("human escalation question は空にできません");
    }
    const exec = this.db.transaction((): OrchestratorRequestRow => {
      const session = this.requireActiveOrchestratorSession(input.sessionId, input.generation);
      const provenance: ActorProvenance = {
        kind: "orchestrator",
        actorId: session.orchestratorId,
        actorSessionId: session.id,
        actorGeneration: session.generation,
      };
      const now = nowSeconds();
      const info = this.db
        .prepare(
          `UPDATE orchestrator_requests
           SET status = 'waiting_human', question = ?, escalation_generation = escalation_generation + 1,
               claimant_session_id = '', claimant_generation = NULL, claim_token = '', lease_until = NULL,
               answer_key = '', updated_at = ?
           WHERE id = ? AND status = 'claimed' AND claimant_session_id = ? AND claimant_generation = ?
             AND claim_token = ? AND lease_until >= ?`,
        )
        .run(question, now, input.requestId, input.sessionId, input.generation, input.claimToken, now);
      if (info.changes !== 1) {
        throw new Error("request escalation の fencing 検証に失敗しました");
      }
      const request = this.getOrchestratorRequest(input.requestId)!;
      this.updateBlockReason(
        request.taskId,
        `user-question: ${question.slice(0, 120)}`,
        "orchestrator",
        "human",
        provenance,
      );
      const dedupeKey = `${request.id}:${request.escalationGeneration}:human_question:configured`;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO notification_outbox (
             task_id, request_id, dedupe_key, kind, transport, payload, status, next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, ?, 'human_question', 'configured', ?, 'pending', 0, ?, ?)`,
        )
        .run(request.taskId, request.id, dedupeKey, JSON.stringify({ question }), now, now);
      return request;
    });
    return exec();
  }

  recordHumanAnswerForRequest(taskId: string, answer: string): OrchestratorRequestRow | null {
    const text = answer.trim();
    if (text.length === 0) {
      throw new Error("human answer は空にできません");
    }
    const exec = this.db.transaction((): OrchestratorRequestRow | null => {
      const request = this.db
        .prepare(`SELECT * FROM orchestrator_requests WHERE task_id = ? AND status = 'waiting_human' ORDER BY created_at DESC LIMIT 1`)
        .get(taskId) as RawOrchestratorRequestRow | undefined;
      if (request === undefined) {
        return null;
      }
      const now = nowSeconds();
      this.db
        .prepare(
          `UPDATE orchestrator_requests
           SET status = 'queued', human_answer = ?, claimant_session_id = '', claimant_generation = NULL,
               claim_token = '', lease_until = NULL, answer_key = '', updated_at = ? WHERE id = ?`,
        )
        .run(text, now, request.id);
      this.db.prepare(`UPDATE orchestrator_deliveries SET status = 'pending', updated_at = ? WHERE request_id = ?`).run(now, request.id);
      this.updateBlockReason(taskId, `worker-question: ${request.question.slice(0, 120)}`, "supervisor", "");
      this.addEvent(taskId, "human_answer_routed_to_orchestrator", "supervisor", { requestId: request.id });
      return this.getOrchestratorRequest(request.id);
    });
    return exec();
  }

  createOrGetRuntimeResourceRequirement(input: {
    taskId: string;
    name: string;
    bundleKind: Exclude<RuntimeBundleKind, "legacy_observation">;
    spec: unknown;
    idempotencyKey: string;
  }): RuntimeResourceRequirementRow {
    this.requireTaskRaw(input.taskId);
    const name = input.name.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (name === "" || idempotencyKey === "") {
      throw new Error("runtime resource requirement の name/idempotencyKey は必須です");
    }
    const spec = normalizeRuntimeRequirementSpec(input.spec);
    const exec = this.db.transaction((): RuntimeResourceRequirementRow => {
      const existing = this.db
        .prepare(`SELECT * FROM runtime_resource_requirements WHERE idempotency_key = ?`)
        .get(idempotencyKey) as RawRuntimeRequirementRow | undefined;
      if (existing !== undefined) {
        if (
          existing.task_id !== input.taskId ||
          existing.name !== name ||
          existing.bundle_kind !== input.bundleKind ||
          existing.spec !== spec
        ) {
          throw new Error("runtime resource requirement の idempotencyKey が異なる要求に再利用されました");
        }
        return mapRuntimeRequirementRow(existing);
      }
      const now = nowSeconds();
      const id = generateRuntimeId("rr");
      this.db
        .prepare(
          `INSERT INTO runtime_resource_requirements
           (id, task_id, name, bundle_kind, spec, status, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(id, input.taskId, name, input.bundleKind, spec, idempotencyKey, now, now);
      return mapRuntimeRequirementRow(
        this.db.prepare(`SELECT * FROM runtime_resource_requirements WHERE id = ?`).get(id) as RawRuntimeRequirementRow,
      );
    });
    return exec();
  }

  getRuntimeResourceRequirement(id: string): RuntimeResourceRequirementRow | null {
    const row = this.db.prepare(`SELECT * FROM runtime_resource_requirements WHERE id = ?`).get(id) as
      | RawRuntimeRequirementRow
      | undefined;
    return row === undefined ? null : mapRuntimeRequirementRow(row);
  }

  reserveRuntimeResourceLease(input: {
    requirementId: string;
    controllerOrchestratorId: string;
    board: string;
    project?: string;
    repoCommonDir: string;
    worktree: string;
    cleanupPolicy: RuntimeCleanupPolicy;
    managed: boolean;
    ephemeral: boolean;
    expiresAt: number | null;
    provenanceVersion: number;
    rolloutGeneration: number;
    actor: string;
  }): RuntimeResourceLeaseRow {
    if (!input.managed) {
      throw new Error("requirement から予約する lease は managed=true が必須です");
    }
    if (input.board.trim() === "" || input.controllerOrchestratorId.trim() === "") {
      throw new Error("runtime resource lease の board/controller は必須です");
    }
    if (input.expiresAt !== null && (!Number.isInteger(input.expiresAt) || input.expiresAt <= nowSeconds())) {
      throw new Error("runtime resource lease の expiresAt は現在より後の整数が必須です");
    }
    if (!Number.isInteger(input.provenanceVersion) || input.provenanceVersion < 1) {
      throw new Error("managed runtime resource lease は provenanceVersion >= 1 が必須です");
    }
    if (!Number.isInteger(input.rolloutGeneration) || input.rolloutGeneration < 0) {
      throw new Error("rolloutGeneration は 0 以上の整数が必須です");
    }
    const paths = canonicalizeRuntimeOwnerPaths(input.repoCommonDir, input.worktree);
    const exec = this.db.transaction((): RuntimeResourceLeaseRow => {
      const requirement = this.db
        .prepare(`SELECT * FROM runtime_resource_requirements WHERE id = ?`)
        .get(input.requirementId) as RawRuntimeRequirementRow | undefined;
      if (requirement === undefined) {
        throw new Error(`runtime resource requirement が見つかりません: ${input.requirementId}`);
      }
      if (requirement.status !== "pending" || requirement.lease_id !== "") {
        throw new Error("runtime resource requirement は既に reserve 済みです");
      }
      const orchestrator = this.db
        .prepare(`SELECT 1 FROM orchestrators WHERE id = ?`)
        .get(input.controllerOrchestratorId);
      if (orchestrator === undefined) {
        throw new Error(`controller orchestrator が見つかりません: ${input.controllerOrchestratorId}`);
      }
      const now = nowSeconds();
      const leaseId = generateRuntimeId("rl");
      this.db
        .prepare(
          `INSERT INTO runtime_resource_leases
           (id, bundle_kind, state, cleanup_policy, managed, ephemeral, owner_task_id,
            controller_orchestrator_id, board, project, repo_common_dir, canonical_worktree,
            fence, expires_at, provenance_version, rollout_generation, created_at, updated_at)
           VALUES (?, ?, 'requested', ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          leaseId,
          requirement.bundle_kind,
          input.cleanupPolicy,
          input.ephemeral ? 1 : 0,
          requirement.task_id,
          input.controllerOrchestratorId,
          input.board.trim(),
          input.project?.trim() ?? "",
          paths.repoCommonDir,
          paths.canonicalWorktree,
          input.expiresAt,
          input.provenanceVersion,
          input.rolloutGeneration,
          now,
          now,
        );
      const claimed = this.db
        .prepare(
          `UPDATE runtime_resource_requirements
           SET status = 'provisioning', lease_id = ?, updated_at = ?
           WHERE id = ? AND status = 'pending' AND lease_id = ''`,
        )
        .run(leaseId, now, input.requirementId);
      if (claimed.changes !== 1) {
        throw new Error("runtime resource requirement の reserve CAS に失敗しました");
      }
      this.addRuntimeResourceEvent(leaseId, "lease_reserved", input.actor, {
        requirementId: input.requirementId,
        fence: 1,
      });
      return mapRuntimeLeaseRow(this.requireRuntimeLeaseRaw(leaseId));
    });
    return exec();
  }

  getRuntimeResourceLease(id: string): RuntimeResourceLeaseRow | null {
    const row = this.db.prepare(`SELECT * FROM runtime_resource_leases WHERE id = ?`).get(id) as
      | RawRuntimeLeaseRow
      | undefined;
    return row === undefined ? null : mapRuntimeLeaseRow(row);
  }

  claimRuntimeResourceLease(leaseId: string, expectedFence: number, actor: string): RuntimeResourceLeaseRow {
    const exec = this.db.transaction((): RuntimeResourceLeaseRow => {
      const now = nowSeconds();
      const info = this.db
        .prepare(
          `UPDATE runtime_resource_leases
           SET state = 'provisioning', fence = fence + 1, updated_at = ?
           WHERE id = ? AND state = 'requested' AND fence = ?`,
        )
        .run(now, leaseId, expectedFence);
      if (info.changes !== 1) {
        throw new Error("runtime resource lease の provision claim CAS に失敗しました");
      }
      const lease = mapRuntimeLeaseRow(this.requireRuntimeLeaseRaw(leaseId));
      this.addRuntimeResourceEvent(leaseId, "lease_provision_claimed", actor, {
        previousFence: expectedFence,
        fence: lease.fence,
      });
      return lease;
    });
    return exec();
  }

  renewRuntimeResourceLease(input: {
    leaseId: string;
    expectedFence: number;
    controllerOrchestratorId: string;
    repoCommonDir: string;
    worktree: string;
    heartbeatAt: number;
    expiresAt: number;
    actor: string;
  }): RuntimeResourceLeaseRow {
    const paths = canonicalizeRuntimeOwnerPaths(input.repoCommonDir, input.worktree);
    if (!Number.isInteger(input.heartbeatAt) || !Number.isInteger(input.expiresAt) || input.expiresAt <= input.heartbeatAt) {
      throw new Error("runtime resource lease の heartbeat/expiry が不正です");
    }
    const exec = this.db.transaction((): RuntimeResourceLeaseRow => {
      const info = this.db
        .prepare(
          `UPDATE runtime_resource_leases
           SET heartbeat_at = ?, expires_at = ?, fence = fence + 1, updated_at = ?
           WHERE id = ? AND fence = ? AND state IN ('provisioning', 'active')
             AND controller_orchestrator_id = ? AND repo_common_dir = ? AND canonical_worktree = ?`,
        )
        .run(
          input.heartbeatAt,
          input.expiresAt,
          input.heartbeatAt,
          input.leaseId,
          input.expectedFence,
          input.controllerOrchestratorId,
          paths.repoCommonDir,
          paths.canonicalWorktree,
        );
      if (info.changes !== 1) {
        throw new Error("runtime resource lease の renew CAS/owner 検証に失敗しました");
      }
      const lease = mapRuntimeLeaseRow(this.requireRuntimeLeaseRaw(input.leaseId));
      this.addRuntimeResourceEvent(input.leaseId, "lease_renewed", input.actor, {
        previousFence: input.expectedFence,
        fence: lease.fence,
        expiresAt: input.expiresAt,
      });
      return lease;
    });
    return exec();
  }

  transitionRuntimeResourceLease(input: {
    leaseId: string;
    expectedFence: number;
    from: RuntimeLeaseState;
    to: RuntimeLeaseState;
    terminalReason?: RuntimeTerminalReason;
    actor: string;
  }): RuntimeResourceLeaseRow {
    if (input.to === "cleanup_pending") {
      throw new Error(
        "cleanup_pending 遷移には transitionRuntimeResourceLeaseWithCleanupRequest を使用してください",
      );
    }
    return this.transitionRuntimeResourceLeaseInternal(input);
  }

  private transitionRuntimeResourceLeaseInternal(input: {
    leaseId: string;
    expectedFence: number;
    from: RuntimeLeaseState;
    to: RuntimeLeaseState;
    terminalReason?: RuntimeTerminalReason;
    actor: string;
  }): RuntimeResourceLeaseRow {
    assertRuntimeLeaseTransition(input.from, input.to);
    const terminalReason = input.terminalReason ?? "";
    if (["cleanup_pending", "expired"].includes(input.to) && terminalReason === "") {
      throw new Error("cleanup/expired 遷移には terminalReason が必須です");
    }
    if (input.to === "expired") {
      throw new Error("expired 遷移には expireRuntimeResourceLease を使用してください");
    }
    const exec = this.db.transaction((): RuntimeResourceLeaseRow => {
      const current = this.requireRuntimeLeaseRaw(input.leaseId);
      if (terminalReason === "owner_terminal" && !this.runtimeOwnerIsTerminal(current)) {
        throw new Error("runtime resource lease の owner task/run は terminal ではありません");
      }
      if (terminalReason === "provision_failed" && input.from !== "provisioning") {
        throw new Error("provision_failed は provisioning からのみ記録できます");
      }
      const now = nowSeconds();
      const releasedAt = input.to === "released" ? now : null;
      const info = this.db
        .prepare(
          `UPDATE runtime_resource_leases
           SET state = ?, terminal_reason = ?, released_at = ?, fence = fence + 1, updated_at = ?
           WHERE id = ? AND state = ? AND fence = ?`,
        )
        .run(input.to, terminalReason, releasedAt, now, input.leaseId, input.from, input.expectedFence);
      if (info.changes !== 1) {
        throw new Error("runtime resource lease の transition CAS に失敗しました");
      }
      if (input.from === "provisioning" && input.to === "active") {
        const requirement = this.db
          .prepare(
            `UPDATE runtime_resource_requirements
             SET status = 'ready', updated_at = ?
             WHERE lease_id = ? AND status = 'provisioning'`,
          )
          .run(now, input.leaseId);
        if (current.managed === 1 && current.bundle_kind !== "legacy_observation" && requirement.changes !== 1) {
          throw new Error("active lease に対応する provisioning requirement がありません");
        }
      } else if (input.from === "provisioning" && ["failed", "quarantined"].includes(input.to)) {
        this.db
          .prepare(
            `UPDATE runtime_resource_requirements
             SET status = 'failed', updated_at = ?
             WHERE lease_id = ? AND status = 'provisioning'`,
          )
          .run(now, input.leaseId);
      } else if (input.to === "cancelled") {
        this.db
          .prepare(
            `UPDATE runtime_resource_requirements
             SET status = 'cancelled', updated_at = ?
             WHERE lease_id = ? AND status IN ('pending', 'provisioning')`,
          )
          .run(now, input.leaseId);
      }
      const lease = mapRuntimeLeaseRow(this.requireRuntimeLeaseRaw(input.leaseId));
      this.addRuntimeResourceEvent(input.leaseId, "lease_state_changed", input.actor, {
        from: input.from,
        to: input.to,
        previousFence: input.expectedFence,
        fence: lease.fence,
        terminalReason,
      });
      return lease;
    });
    return exec();
  }

  bindRuntimeResourceLeaseRun(input: {
    leaseId: string;
    expectedFence: number;
    runId: number;
    actor: string;
  }): RuntimeResourceLeaseRow {
    const exec = this.db.transaction((): RuntimeResourceLeaseRow => {
      const lease = this.requireRuntimeLeaseRaw(input.leaseId);
      const run = this.db.prepare(`SELECT * FROM task_runs WHERE id = ?`).get(input.runId) as RawRunRow | undefined;
      if (run === undefined || run.task_id !== lease.owner_task_id || run.status !== "running") {
        throw new Error("runtime resource lease の run owner が task/live run と一致しません");
      }
      const info = this.db
        .prepare(
          `UPDATE runtime_resource_leases
           SET owner_run_id = ?, fence = fence + 1, updated_at = ?
           WHERE id = ? AND fence = ? AND owner_run_id IS NULL AND state = 'active'`,
        )
        .run(input.runId, nowSeconds(), input.leaseId, input.expectedFence);
      if (info.changes !== 1) {
        throw new Error("runtime resource lease の run bind CAS に失敗しました");
      }
      const updated = mapRuntimeLeaseRow(this.requireRuntimeLeaseRaw(input.leaseId));
      this.addRuntimeResourceEvent(input.leaseId, "lease_run_bound", input.actor, {
        runId: input.runId,
        previousFence: input.expectedFence,
        fence: updated.fence,
      });
      return updated;
    });
    return exec();
  }

  /** 終了済み旧 run の lease を、同一 task の新しい live run へ fence 付きで付け替える。 */
  rebindRuntimeResourceLeaseRun(input: {
    leaseId: string;
    expectedFence: number;
    expectedOwnerRunId: number | null;
    runId: number;
    actor: string;
  }): RuntimeResourceLeaseRow {
    const exec = this.db.transaction((): RuntimeResourceLeaseRow => {
      const lease = this.requireRuntimeLeaseRaw(input.leaseId);
      const newRun = this.db.prepare(`SELECT * FROM task_runs WHERE id = ?`).get(input.runId) as RawRunRow | undefined;
      if (newRun === undefined || newRun.task_id !== lease.owner_task_id || newRun.status !== "running") {
        throw new Error("runtime resource lease の新 run owner が task/live run と一致しません");
      }
      if (input.expectedOwnerRunId !== null) {
        const oldRun = this.db
          .prepare(`SELECT * FROM task_runs WHERE id = ?`)
          .get(input.expectedOwnerRunId) as RawRunRow | undefined;
        if (oldRun === undefined || oldRun.task_id !== lease.owner_task_id || oldRun.status === "running") {
          throw new Error("runtime resource lease の旧 run が終了済み owner と一致しません");
        }
      }
      const info = this.db
        .prepare(
          `UPDATE runtime_resource_leases
           SET owner_run_id = ?, fence = fence + 1, updated_at = ?
           WHERE id = ? AND fence = ? AND owner_run_id IS ? AND state = 'active'`,
        )
        .run(input.runId, nowSeconds(), input.leaseId, input.expectedFence, input.expectedOwnerRunId);
      if (info.changes !== 1) {
        throw new Error("runtime resource lease の rework run rebind CAS に失敗しました");
      }
      const updated = mapRuntimeLeaseRow(this.requireRuntimeLeaseRaw(input.leaseId));
      this.addRuntimeResourceEvent(input.leaseId, "lease_run_rebound", input.actor, {
        previousRunId: input.expectedOwnerRunId,
        runId: input.runId,
        previousFence: input.expectedFence,
        fence: updated.fence,
      });
      return updated;
    });
    return exec();
  }

  addRuntimeResourceMember(input: {
    leaseId: string;
    expectedLeaseFence: number;
    kind: RuntimeMemberKind;
    state: RuntimeMemberState;
    cleanupPolicy: RuntimeCleanupPolicy;
    managed: boolean;
    ephemeral: boolean;
    scopeKey: string;
    nativeId?: string;
    displayName?: string;
    hostIp?: string;
    hostPort?: number | null;
    containerPort?: number | null;
    composeProject?: string;
    labelsHash: string;
    provenance: unknown;
    observedAt: number;
    actor: string;
  }): RuntimeResourceMemberRow {
    if (input.scopeKey.trim() === "" || !/^[0-9a-f]{64}$/.test(input.labelsHash)) {
      throw new Error("runtime resource member の scopeKey/labelsHash は必須です");
    }
    if (!Number.isInteger(input.observedAt) || input.observedAt < 0) {
      throw new Error("runtime resource member の observedAt が不正です");
    }
    if (input.kind === "docker_volume" && input.cleanupPolicy === "auto") {
      throw new Error("docker_volume は auto cleanup policy にできません");
    }
    if (
      ["docker_container", "docker_network", "docker_volume"].includes(input.kind) &&
      (input.nativeId?.trim() ?? "") === ""
    ) {
      throw new Error("managed Docker member は exact nativeId が必須です");
    }
    const provenance = normalizeRuntimeMemberProvenance(input.provenance);
    const exec = this.db.transaction((): RuntimeResourceMemberRow => {
      const lease = this.requireRuntimeLeaseRaw(input.leaseId);
      if (lease.fence !== input.expectedLeaseFence || !["provisioning", "active"].includes(lease.state)) {
        throw new Error("runtime resource member 追加時の lease fence/state が一致しません");
      }
      if (input.managed && (!lease.managed || input.ephemeral !== (lease.ephemeral === 1))) {
        throw new Error("runtime resource member の managed/ephemeral が lease と一致しません");
      }
      const id = generateRuntimeId("rm");
      const now = nowSeconds();
      this.db
        .prepare(
          `INSERT INTO runtime_resource_members
           (id, lease_id, kind, state, cleanup_policy, managed, ephemeral, object_fence,
            scope_key, native_id, display_name, host_ip, host_port, container_port,
            compose_project, labels_hash, provenance, last_observed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.leaseId,
          input.kind,
          input.state,
          input.cleanupPolicy,
          input.managed ? 1 : 0,
          input.ephemeral ? 1 : 0,
          input.expectedLeaseFence,
          input.scopeKey.trim(),
          input.nativeId?.trim() ?? "",
          input.displayName?.trim() ?? "",
          input.hostIp?.trim() ?? "",
          input.hostPort ?? null,
          input.containerPort ?? null,
          input.composeProject?.trim() ?? "",
          input.labelsHash.trim(),
          provenance,
          input.observedAt,
          now,
          now,
        );
      this.addRuntimeResourceEvent(input.leaseId, "member_recorded", input.actor, {
        memberId: id,
        kind: input.kind,
        objectFence: input.expectedLeaseFence,
      });
      return mapRuntimeMemberRow(
        this.db.prepare(`SELECT * FROM runtime_resource_members WHERE id = ?`).get(id) as RawRuntimeMemberRow,
      );
    });
    return exec();
  }

  listRuntimeResourceMembers(leaseId: string): RuntimeResourceMemberRow[] {
    return (
      this.db.prepare(`SELECT * FROM runtime_resource_members WHERE lease_id = ? ORDER BY created_at, id`).all(leaseId) as
        RawRuntimeMemberRow[]
    ).map(mapRuntimeMemberRow);
  }

  expireRuntimeResourceLease(leaseId: string, expectedFence: number, now: number, actor: string): RuntimeResourceLeaseRow {
    const exec = this.db.transaction((): RuntimeResourceLeaseRow => {
      const lease = this.requireRuntimeLeaseRaw(leaseId);
      if (lease.state !== "active" || lease.fence !== expectedFence || lease.expires_at === null || lease.expires_at > now) {
        throw new Error("runtime resource lease は expiry CAS 条件を満たしません");
      }
      const task = lease.owner_task_id === null ? undefined : this.requireTaskRaw(lease.owner_task_id);
      if (task !== undefined && task.status !== "done" && task.status !== "archived") {
        throw new Error("live task を所有する runtime resource lease は期限切れにできません");
      }
      if (lease.owner_run_id !== null) {
        const liveRun = this.db
          .prepare(`SELECT 1 FROM task_runs WHERE id = ? AND status = 'running'`)
          .get(lease.owner_run_id);
        if (liveRun !== undefined) {
          throw new Error("live run を所有する runtime resource lease は期限切れにできません");
        }
      }
      const info = this.db
        .prepare(
          `UPDATE runtime_resource_leases
           SET state = 'expired', terminal_reason = 'lease_expired', fence = fence + 1, updated_at = ?
           WHERE id = ? AND state = 'active' AND fence = ? AND expires_at <= ?`,
        )
        .run(now, leaseId, expectedFence, now);
      if (info.changes !== 1) {
        throw new Error("runtime resource lease の expiry CAS に失敗しました");
      }
      const updated = mapRuntimeLeaseRow(this.requireRuntimeLeaseRaw(leaseId));
      this.addRuntimeResourceEvent(leaseId, "lease_expired", actor, {
        previousFence: expectedFence,
        fence: updated.fence,
      });
      return updated;
    });
    return exec();
  }

  createOrGetRuntimeCleanupRequest(input: {
    leaseId: string;
    expectedLeaseFence: number;
    decisionClass: RuntimeCleanupDecisionClass;
    reason: string;
    actor: string;
  }): RuntimeCleanupRequestRow {
    const reason = input.reason.trim();
    if (reason === "") {
      throw new Error("runtime cleanup request の reason は必須です");
    }
    const exec = this.db.transaction((): RuntimeCleanupRequestRow => {
      const lease = this.requireRuntimeLeaseRaw(input.leaseId);
      if (lease.fence !== input.expectedLeaseFence || !["cleanup_pending", "expired"].includes(lease.state)) {
        throw new Error("runtime cleanup request の lease fence/state が一致しません");
      }
      const members = this.listRuntimeResourceMembers(input.leaseId);
      if (members.length === 0) {
        throw new Error("member の無い lease に cleanup request は作成できません");
      }
      if (input.decisionClass === "auto" && members.some((member) => member.kind === "docker_volume")) {
        throw new Error("docker_volume を含む lease は auto cleanup request にできません");
      }
      if (
        input.decisionClass === "auto" &&
        (lease.cleanup_policy !== "auto" || members.some((member) => member.cleanupPolicy !== "auto"))
      ) {
        throw new Error("auto cleanup request は lease/member の cleanupPolicy=auto が必須です");
      }
      const membersHash = runtimeMembersHash(members);
      const existing = this.db
        .prepare(
          `SELECT * FROM runtime_cleanup_requests
           WHERE lease_id = ? AND expected_lease_fence = ? AND reason = ?`,
        )
        .get(input.leaseId, input.expectedLeaseFence, reason) as RawRuntimeCleanupRequestRow | undefined;
      if (existing !== undefined) {
        if (existing.expected_members_hash !== membersHash || existing.decision_class !== input.decisionClass) {
          throw new Error("runtime cleanup request の冪等 snapshot が一致しません");
        }
        if (existing.decision_class === "human") {
          this.initializeRuntimeCleanupHumanRequest(existing.id, reason, nowSeconds());
        }
        return mapRuntimeCleanupRequestRow(existing);
      }
      const id = generateRuntimeId("rc");
      const now = nowSeconds();
      const status = input.decisionClass === "human" ? "waiting_human" : "queued";
      this.db
        .prepare(
          `INSERT INTO runtime_cleanup_requests
           (id, lease_id, decision_class, reason, status, expected_lease_fence,
            expected_members_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.leaseId, input.decisionClass, reason, status, input.expectedLeaseFence, membersHash, now, now);
      if (input.decisionClass === "orchestrator") {
        this.enqueueRuntimeCleanupDeliveries({ requestId: id, lease, now });
      } else if (input.decisionClass === "human") {
        this.initializeRuntimeCleanupHumanRequest(id, reason, now);
      }
      this.addRuntimeResourceEvent(input.leaseId, "cleanup_requested", input.actor, {
        decisionClass: input.decisionClass,
        expectedLeaseFence: input.expectedLeaseFence,
        expectedMembersHash: membersHash,
      }, id);
      return mapRuntimeCleanupRequestRow(this.requireRuntimeCleanupRequestRaw(id));
    });
    return exec();
  }

  /**
   * cleanup_pending 遷移と durable cleanup request 作成を同一 Tx で行う。
   * partial provision では create 済み exact identity の member も同じ Tx で回復記録する。
   */
  transitionRuntimeResourceLeaseWithCleanupRequest(input: {
    leaseId: string;
    expectedFence: number;
    from: "provisioning" | "active";
    terminalReason: RuntimeTerminalReason;
    decisionClass: RuntimeCleanupDecisionClass;
    reason: string;
    actor: string;
    member?: {
      kind: RuntimeMemberKind;
      state: RuntimeMemberState;
      cleanupPolicy: RuntimeCleanupPolicy;
      managed: boolean;
      ephemeral: boolean;
      scopeKey: string;
      nativeId?: string;
      displayName?: string;
      hostIp?: string;
      hostPort?: number | null;
      containerPort?: number | null;
      composeProject?: string;
      labelsHash: string;
      provenance: unknown;
      observedAt: number;
    };
  }): { lease: RuntimeResourceLeaseRow; request: RuntimeCleanupRequestRow } {
    const exec = this.db.transaction((): { lease: RuntimeResourceLeaseRow; request: RuntimeCleanupRequestRow } => {
      if (input.member !== undefined) {
        const exists = this.listRuntimeResourceMembers(input.leaseId).some(
          (member) =>
            member.kind === input.member!.kind &&
            member.nativeId !== "" &&
            member.nativeId === (input.member!.nativeId?.trim() ?? ""),
        );
        if (!exists) {
          this.addRuntimeResourceMember({
            leaseId: input.leaseId,
            expectedLeaseFence: input.expectedFence,
            ...input.member,
            actor: input.actor,
          });
        }
      }
      const lease = this.transitionRuntimeResourceLeaseInternal({
        leaseId: input.leaseId,
        expectedFence: input.expectedFence,
        from: input.from,
        to: "cleanup_pending",
        terminalReason: input.terminalReason,
        actor: input.actor,
      });
      const request = this.createOrGetRuntimeCleanupRequest({
        leaseId: lease.id,
        expectedLeaseFence: lease.fence,
        decisionClass: input.decisionClass,
        reason: input.reason,
        actor: input.actor,
      });
      return { lease, request };
    });
    return exec();
  }

  getRuntimeCleanupRequest(id: string): RuntimeCleanupRequestRow | null {
    const row = this.db.prepare(`SELECT * FROM runtime_cleanup_requests WHERE id = ?`).get(id) as
      | RawRuntimeCleanupRequestRow
      | undefined;
    return row === undefined ? null : mapRuntimeCleanupRequestRow(row);
  }

  /** 旧 attempt の member 単位 effect_started 証拠を、現行 exact identity と照合する。 */
  private runtimeCleanupRecoveryMemberIds(
    requestId: string,
    members: RuntimeResourceMemberRow[],
  ): string[] {
    const rows = this.db.prepare(
      `SELECT result FROM runtime_cleanup_attempts
       WHERE request_id = ? AND state IN ('effect_started', 'failed')
       ORDER BY id`,
    ).all(requestId) as Array<{ result: string }>;
    const evidence = rows.flatMap((row) => runtimeCleanupEffectEvidence(row.result));
    return members.filter((member) => evidence.some((entry) =>
      entry.memberId === member.id && entry.kind === member.kind && entry.nativeId === member.nativeId &&
      entry.objectFence === member.objectFence,
    )).map((member) => member.id);
  }

  /** auto/approved/retry/crash-recovery の due request を決定順で取得する。 */
  listDueRuntimeCleanupRequests(limit: number, now = nowSeconds()): RuntimeCleanupRequestRow[] {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("runtime cleanup request limit は正の整数が必須です");
    }
    const rows = this.db.prepare(
      `SELECT * FROM runtime_cleanup_requests
       WHERE (status = 'queued' AND decision_class = 'auto')
          OR status = 'approved'
          OR (status = 'retry_wait' AND next_attempt_at <= ?)
          OR (status = 'executing' AND executor_lease_until IS NOT NULL AND executor_lease_until <= ?)
       ORDER BY created_at, id
       LIMIT ?`,
    ).all(now, now, limit) as RawRuntimeCleanupRequestRow[];
    return rows.map(mapRuntimeCleanupRequestRow);
  }

  /** request/lease/member を同一 Tx で fence し、外部 effect より先に durable intent を作る。 */
  beginRuntimeCleanupAttempt(input: {
    requestId: string;
    executorId: string;
    executorLeaseSeconds: number;
    now?: number;
  }): RuntimeCleanupExecutionAttempt {
    const now = input.now ?? nowSeconds();
    if (input.executorId.trim() === "" || !Number.isInteger(input.executorLeaseSeconds) || input.executorLeaseSeconds <= 0) {
      throw new Error("runtime cleanup executor id/lease が不正です");
    }
    const exec = this.db.transaction((): RuntimeCleanupExecutionAttempt => {
      const request = this.requireRuntimeCleanupRequestRaw(input.requestId);
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      const currentMembersHash = this.runtimeMembersHash(lease.id);
      const recovery = request.status === "executing";
      const due =
        (request.status === "queued" && request.decision_class === "auto") ||
        request.status === "approved" ||
        (request.status === "retry_wait" && request.next_attempt_at <= now) ||
        (recovery && request.executor_lease_until !== null && request.executor_lease_until <= now);
      if (!due) {
        throw new Error("runtime cleanup request は execution CAS 条件を満たしません");
      }
      if (
        lease.fence !== request.expected_lease_fence ||
        currentMembersHash !== request.expected_members_hash ||
        !["active", "cleanup_pending", "expired", "releasing"].includes(lease.state)
      ) {
        throw new Error("runtime cleanup execution の lease/member fence が一致しません");
      }
      if (request.decision_class !== "auto" && request.status !== "approved" && !recovery && request.status !== "retry_wait") {
        throw new Error("runtime cleanup execution に fenced approval がありません");
      }

      let expectedLeaseFence = lease.fence;
      if (lease.state !== "releasing") {
        const leaseUpdate = this.db.prepare(
          `UPDATE runtime_resource_leases
           SET state = 'releasing', fence = fence + 1, updated_at = ?
           WHERE id = ? AND fence = ? AND state IN ('active', 'cleanup_pending', 'expired')`,
        ).run(now, lease.id, lease.fence);
        if (leaseUpdate.changes !== 1) {
          throw new Error("runtime cleanup lease execution claim CAS に失敗しました");
        }
        expectedLeaseFence += 1;
      }
      this.db.prepare(
        `UPDATE runtime_resource_members
         SET state = 'releasing', updated_at = ?
         WHERE lease_id = ? AND state IN ('active', 'observed')`,
      ).run(now, lease.id);
      const expectedMembersHash = this.runtimeMembersHash(lease.id);
      const executionNonce = randomBytes(24).toString("base64url");
      const executorGeneration = request.executor_generation + 1;
      const requestUpdate = this.db.prepare(
        `UPDATE runtime_cleanup_requests
         SET status = 'executing', expected_lease_fence = ?, expected_members_hash = ?,
             executor_id = ?, executor_generation = ?, executor_lease_until = ?, execution_nonce = ?,
             attempts = attempts + 1, next_attempt_at = 0, last_error = '', updated_at = ?
         WHERE id = ? AND status = ? AND expected_lease_fence = ? AND expected_members_hash = ?`,
      ).run(
        expectedLeaseFence,
        expectedMembersHash,
        input.executorId,
        executorGeneration,
        now + input.executorLeaseSeconds,
        executionNonce,
        now,
        request.id,
        request.status,
        request.expected_lease_fence,
        request.expected_members_hash,
      );
      if (requestUpdate.changes !== 1) {
        throw new Error("runtime cleanup request execution claim CAS に失敗しました");
      }
      this.db.prepare(
        `INSERT INTO runtime_cleanup_attempts
         (request_id, execution_nonce, executor_id, executor_generation, expected_lease_fence,
          expected_members_hash, state, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'intent', ?, ?)`,
      ).run(
        request.id,
        executionNonce,
        input.executorId,
        executorGeneration,
        expectedLeaseFence,
        expectedMembersHash,
        now,
        now,
      );
      const members = this.listRuntimeResourceMembers(lease.id);
      const recoveryMemberIds = this.runtimeCleanupRecoveryMemberIds(request.id, members);
      this.addRuntimeResourceEvent(lease.id, "cleanup_execution_started", input.executorId, {
        executionNonceHash: sha256RuntimeValue(executionNonce),
        executorGeneration,
        recovery: recoveryMemberIds.length > 0,
        recoveryMemberIds,
        expectedLeaseFence,
        expectedMembersHash,
      }, request.id);
      return {
        request: mapRuntimeCleanupRequestRow(this.requireRuntimeCleanupRequestRaw(request.id)),
        lease: mapRuntimeLeaseRow(this.requireRuntimeLeaseRaw(lease.id)),
        members,
        executionNonce,
        executorGeneration,
        recovery: recoveryMemberIds.length > 0,
        recoveryMemberIds,
      };
    });
    return exec();
  }

  /** external effect 直前の durable fence を再検証し、attempt を effect_started に進める。 */
  markRuntimeCleanupEffectStarted(input: RuntimeCleanupExecutionFence & { memberId: string; now?: number }): void {
    const now = input.now ?? nowSeconds();
    const exec = this.db.transaction((): void => {
      const request = this.requireRuntimeCleanupRequestRaw(input.requestId);
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      const member = this.listRuntimeResourceMembers(lease.id).find(
        (candidate) => candidate.id === input.memberId && candidate.state === "releasing",
      );
      if (
        member === undefined || request.status !== "executing" || request.execution_nonce !== input.executionNonce ||
        request.executor_id !== input.executorId || request.executor_generation !== input.executorGeneration ||
        request.expected_lease_fence !== input.expectedLeaseFence ||
        request.expected_members_hash !== input.expectedMembersHash ||
        lease.state !== "releasing" || lease.fence !== input.expectedLeaseFence ||
        this.runtimeMembersHash(lease.id) !== input.expectedMembersHash
      ) {
        throw new Error("runtime cleanup effect 直前 fence が一致しません");
      }
      const attemptRow = this.db.prepare(
        `SELECT result FROM runtime_cleanup_attempts
         WHERE request_id = ? AND execution_nonce = ? AND executor_generation = ?`,
      ).get(input.requestId, input.executionNonce, input.executorGeneration) as { result: string } | undefined;
      if (attemptRow === undefined) {
        throw new Error("runtime cleanup attempt が見つかりません");
      }
      const result = parseRuntimeCleanupAttemptResult(attemptRow.result);
      const existingEvidence = runtimeCleanupEffectEvidence(attemptRow.result);
      const nextEvidence = existingEvidence.some((entry) => entry.memberId === member.id)
        ? existingEvidence
        : [...existingEvidence, {
          memberId: member.id,
          kind: member.kind,
          nativeId: member.nativeId,
          objectFence: member.objectFence,
        }];
      const attempt = this.db.prepare(
        `UPDATE runtime_cleanup_attempts SET state = 'effect_started', result = ?, updated_at = ?
         WHERE request_id = ? AND execution_nonce = ? AND executor_generation = ? AND state IN ('intent', 'effect_started')`,
      ).run(
        JSON.stringify({ ...result, effectStartedMembers: nextEvidence }),
        now,
        input.requestId,
        input.executionNonce,
        input.executorGeneration,
      );
      if (attempt.changes !== 1) {
        throw new Error("runtime cleanup attempt effect_started CAS に失敗しました");
      }
    });
    exec();
  }

  /** exact object の absent 検証後だけ member を released にし、request snapshot を更新する。 */
  markRuntimeCleanupMemberReleased(input: RuntimeCleanupExecutionFence & {
    memberId: string;
    result: Record<string, unknown>;
    now?: number;
  }): RuntimeCleanupExecutionAttempt {
    const now = input.now ?? nowSeconds();
    const exec = this.db.transaction((): RuntimeCleanupExecutionAttempt => {
      const request = this.requireRuntimeCleanupRequestRaw(input.requestId);
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      if (
        request.status !== "executing" || request.execution_nonce !== input.executionNonce ||
        request.executor_id !== input.executorId || request.executor_generation !== input.executorGeneration ||
        request.expected_lease_fence !== input.expectedLeaseFence || request.expected_members_hash !== input.expectedMembersHash ||
        lease.state !== "releasing" || lease.fence !== input.expectedLeaseFence ||
        this.runtimeMembersHash(lease.id) !== input.expectedMembersHash
      ) {
        throw new Error("runtime cleanup member release fence が一致しません");
      }
      const released = this.db.prepare(
        `UPDATE runtime_resource_members SET state = 'released', released_at = ?, updated_at = ?
         WHERE id = ? AND lease_id = ? AND state = 'releasing'`,
      ).run(now, now, input.memberId, lease.id);
      if (released.changes !== 1) {
        throw new Error("runtime cleanup member release CAS に失敗しました");
      }
      const nextMembersHash = this.runtimeMembersHash(lease.id);
      this.db.prepare(
        `UPDATE runtime_cleanup_requests SET expected_members_hash = ?, updated_at = ?
         WHERE id = ? AND execution_nonce = ? AND executor_generation = ?`,
      ).run(nextMembersHash, now, request.id, input.executionNonce, input.executorGeneration);
      const attemptRow = this.db.prepare(
        `SELECT result FROM runtime_cleanup_attempts WHERE request_id = ? AND execution_nonce = ?`,
      ).get(request.id, input.executionNonce) as { result: string } | undefined;
      const attemptResult = parseRuntimeCleanupAttemptResult(attemptRow?.result ?? "{}");
      this.db.prepare(
        `UPDATE runtime_cleanup_attempts SET expected_members_hash = ?, result = ?, updated_at = ?
         WHERE request_id = ? AND execution_nonce = ?`,
      ).run(
        nextMembersHash,
        JSON.stringify({ ...attemptResult, memberResult: input.result }),
        now,
        request.id,
        input.executionNonce,
      );
      this.addRuntimeResourceEvent(lease.id, "cleanup_member_released", input.executorId, {
        memberId: input.memberId,
        result: input.result,
      }, request.id);
      return {
        request: mapRuntimeCleanupRequestRow(this.requireRuntimeCleanupRequestRaw(request.id)),
        lease: mapRuntimeLeaseRow(this.requireRuntimeLeaseRaw(lease.id)),
        members: this.listRuntimeResourceMembers(lease.id),
        executionNonce: input.executionNonce,
        executorGeneration: input.executorGeneration,
        recovery: false,
        recoveryMemberIds: [],
      };
    });
    return exec();
  }

  /** 全 member 解放を同一 Tx で検証し、lease/request/attempt を終端化する。 */
  completeRuntimeCleanupAttempt(input: RuntimeCleanupExecutionFence & { now?: number }): void {
    const now = input.now ?? nowSeconds();
    const exec = this.db.transaction((): void => {
      const request = this.requireRuntimeCleanupRequestRaw(input.requestId);
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      const remaining = this.db.prepare(
        `SELECT 1 FROM runtime_resource_members WHERE lease_id = ? AND state <> 'released' LIMIT 1`,
      ).get(lease.id);
      if (
        remaining !== undefined || request.status !== "executing" || request.execution_nonce !== input.executionNonce ||
        request.executor_id !== input.executorId || request.executor_generation !== input.executorGeneration ||
        request.expected_lease_fence !== input.expectedLeaseFence || request.expected_members_hash !== input.expectedMembersHash ||
        lease.state !== "releasing" || lease.fence !== input.expectedLeaseFence ||
        this.runtimeMembersHash(lease.id) !== input.expectedMembersHash
      ) {
        throw new Error("runtime cleanup completion fence/member 条件が一致しません");
      }
      const nextFence = lease.fence + 1;
      this.db.prepare(
        `UPDATE runtime_resource_leases SET state = 'released', fence = ?, released_at = ?, updated_at = ?
         WHERE id = ? AND state = 'releasing' AND fence = ?`,
      ).run(nextFence, now, now, lease.id, lease.fence);
      this.db.prepare(
        `UPDATE runtime_cleanup_requests
         SET status = 'succeeded', expected_lease_fence = ?, executor_lease_until = NULL,
             resolved_at = ?, updated_at = ?
         WHERE id = ? AND execution_nonce = ? AND executor_generation = ?`,
      ).run(nextFence, now, now, request.id, input.executionNonce, input.executorGeneration);
      this.db.prepare(
        `UPDATE runtime_cleanup_attempts SET state = 'verified', completed_at = ?, updated_at = ?
         WHERE request_id = ? AND execution_nonce = ?`,
      ).run(now, now, request.id, input.executionNonce);
      this.addRuntimeResourceEvent(lease.id, "cleanup_succeeded", input.executorId, {
        executorGeneration: input.executorGeneration,
        fence: nextFence,
      }, request.id);
    });
    exec();
  }

  /** retryable failure を backoff 待ちへ戻す。 */
  retryRuntimeCleanupAttempt(input: RuntimeCleanupExecutionFence & {
    error: string;
    nextAttemptAt: number;
    now?: number;
  }): void {
    const now = input.now ?? nowSeconds();
    const exec = this.db.transaction((): void => {
      const request = this.requireRuntimeCleanupRequestRaw(input.requestId);
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      if (
        request.status !== "executing" || request.execution_nonce !== input.executionNonce ||
        request.executor_id !== input.executorId || request.executor_generation !== input.executorGeneration ||
        request.expected_lease_fence !== input.expectedLeaseFence || request.expected_members_hash !== input.expectedMembersHash ||
        lease.state !== "releasing" || lease.fence !== input.expectedLeaseFence ||
        this.runtimeMembersHash(lease.id) !== input.expectedMembersHash
      ) {
        throw new Error("runtime cleanup retry fence が一致しません");
      }
      this.db.prepare(
        `UPDATE runtime_resource_members SET state = 'active', updated_at = ?
         WHERE lease_id = ? AND state = 'releasing'`,
      ).run(now, lease.id);
      const nextFence = lease.fence + 1;
      this.db.prepare(
        `UPDATE runtime_resource_leases SET state = 'cleanup_pending', fence = ?, updated_at = ?
         WHERE id = ? AND state = 'releasing' AND fence = ?`,
      ).run(nextFence, now, lease.id, lease.fence);
      const nextMembersHash = this.runtimeMembersHash(lease.id);
      this.db.prepare(
        `UPDATE runtime_cleanup_requests
         SET status = 'retry_wait', expected_lease_fence = ?, expected_members_hash = ?,
             executor_lease_until = NULL, next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND execution_nonce = ? AND executor_generation = ?`,
      ).run(nextFence, nextMembersHash, input.nextAttemptAt, redactText(input.error), now, request.id, input.executionNonce, input.executorGeneration);
      const attemptRow = this.db.prepare(
        `SELECT result FROM runtime_cleanup_attempts WHERE request_id = ? AND execution_nonce = ?`,
      ).get(request.id, input.executionNonce) as { result: string } | undefined;
      const attemptResult = parseRuntimeCleanupAttemptResult(attemptRow?.result ?? "{}");
      this.db.prepare(
        `UPDATE runtime_cleanup_attempts SET state = 'failed', result = ?, completed_at = ?, updated_at = ?
         WHERE request_id = ? AND execution_nonce = ?`,
      ).run(
        JSON.stringify({ ...attemptResult, error: redactText(input.error), retryAt: input.nextAttemptAt }),
        now,
        now,
        request.id,
        input.executionNonce,
      );
      this.addRuntimeResourceEvent(lease.id, "cleanup_retry_scheduled", input.executorId, {
        nextAttemptAt: input.nextAttemptAt,
        error: redactText(input.error),
        fence: nextFence,
      }, request.id);
    });
    exec();
  }

  /** budget/kill-switch による延期。失敗ではないため attempt 回数を消費せず due queue へ戻す。 */
  deferRuntimeCleanupAttempt(input: RuntimeCleanupExecutionFence & {
    reason: string;
    now?: number;
  }): void {
    const now = input.now ?? nowSeconds();
    const exec = this.db.transaction((): void => {
      const request = this.requireRuntimeCleanupRequestRaw(input.requestId);
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      if (
        request.status !== "executing" || request.execution_nonce !== input.executionNonce ||
        request.executor_id !== input.executorId || request.executor_generation !== input.executorGeneration ||
        request.expected_lease_fence !== input.expectedLeaseFence || request.expected_members_hash !== input.expectedMembersHash ||
        lease.state !== "releasing" || lease.fence !== input.expectedLeaseFence ||
        this.runtimeMembersHash(lease.id) !== input.expectedMembersHash || request.attempts <= 0
      ) {
        throw new Error("runtime cleanup defer fence が一致しません");
      }
      this.db.prepare(
        `UPDATE runtime_resource_members SET state = 'active', updated_at = ?
         WHERE lease_id = ? AND state = 'releasing'`,
      ).run(now, lease.id);
      const nextFence = lease.fence + 1;
      this.db.prepare(
        `UPDATE runtime_resource_leases SET state = 'cleanup_pending', fence = ?, updated_at = ?
         WHERE id = ? AND state = 'releasing' AND fence = ?`,
      ).run(nextFence, now, lease.id, lease.fence);
      const nextMembersHash = this.runtimeMembersHash(lease.id);
      this.db.prepare(
        `UPDATE runtime_cleanup_requests
         SET status = 'retry_wait', expected_lease_fence = ?, expected_members_hash = ?,
             executor_lease_until = NULL, attempts = attempts - 1, next_attempt_at = ?,
             last_error = '', updated_at = ?
         WHERE id = ? AND execution_nonce = ? AND executor_generation = ?`,
      ).run(nextFence, nextMembersHash, now, now, request.id, input.executionNonce, input.executorGeneration);
      this.db.prepare(
        `UPDATE runtime_cleanup_attempts SET state = 'failed', result = ?, completed_at = ?, updated_at = ?
         WHERE request_id = ? AND execution_nonce = ?`,
      ).run(
        JSON.stringify({ deferred: true, reason: redactText(input.reason) }),
        now,
        now,
        request.id,
        input.executionNonce,
      );
      this.addRuntimeResourceEvent(lease.id, "cleanup_deferred", input.executorId, {
        reason: redactText(input.reason),
        fence: nextFence,
      }, request.id);
    });
    exec();
  }

  /** ownership/provenance 不整合または retry 枯渇を quarantine し、orchestrator 通知へ接続する。 */
  quarantineRuntimeCleanupRequest(input: {
    requestId: string;
    reason: string;
    actor: string;
    exhausted?: boolean;
    executionNonce?: string;
    executorGeneration?: number;
    now?: number;
  }): void {
    const now = input.now ?? nowSeconds();
    const exec = this.db.transaction((): void => {
      const request = this.requireRuntimeCleanupRequestRaw(input.requestId);
      if (["succeeded", "rejected", "quarantined", "cancelled"].includes(request.status)) {
        return;
      }
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      if (
        input.executionNonce !== undefined &&
        (request.status !== "executing" || request.execution_nonce !== input.executionNonce ||
          request.executor_generation !== input.executorGeneration ||
          request.expected_lease_fence !== lease.fence ||
          request.expected_members_hash !== this.runtimeMembersHash(lease.id))
      ) {
        throw new Error("runtime cleanup quarantine execution fence が一致しません");
      }
      const requestFenceIsFresh =
        request.expected_lease_fence === lease.fence &&
        request.expected_members_hash === this.runtimeMembersHash(lease.id);
      if (input.executionNonce === undefined && !requestFenceIsFresh) {
        // stale request を根拠に現行 lease/member を変更しない。request と通知だけを終端化する。
        this.db.prepare(
          `UPDATE runtime_cleanup_requests
           SET status = 'quarantined', executor_lease_until = NULL, last_error = ?, resolved_at = ?, updated_at = ?
           WHERE id = ? AND status NOT IN ('succeeded', 'rejected', 'quarantined', 'cancelled')`,
        ).run(redactText(input.reason), now, now, request.id);
        const kind = input.exhausted === true ? "cleanup_exhausted" : "cleanup_quarantined";
        const dedupeKey = `${request.id}:${request.expected_lease_fence}:${kind}:configured`;
        this.db.prepare(
          `INSERT OR IGNORE INTO runtime_resource_outbox
           (lease_id, request_id, dedupe_key, kind, transport, payload, sent_transports,
            status, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'configured', ?, '[]', 'pending', 0, ?, ?)`,
        ).run(lease.id, request.id, dedupeKey, kind, JSON.stringify({ reason: redactText(input.reason) }), now, now);
        this.addRuntimeResourceEvent(lease.id, "cleanup_quarantined", input.actor, {
          reason: redactText(input.reason),
          requestOnly: true,
        }, request.id);
        return;
      }
      this.db.prepare(
        `UPDATE runtime_resource_members SET state = 'quarantined', updated_at = ?
         WHERE lease_id = ? AND state <> 'released'`,
      ).run(now, lease.id);
      const nextFence = lease.state === "quarantined" ? lease.fence : lease.fence + 1;
      if (lease.state !== "quarantined") {
        this.db.prepare(
          `UPDATE runtime_resource_leases SET state = 'quarantined', fence = ?, updated_at = ? WHERE id = ? AND fence = ?`,
        ).run(nextFence, now, lease.id, lease.fence);
      }
      const nextMembersHash = this.runtimeMembersHash(lease.id);
      this.db.prepare(
        `UPDATE runtime_cleanup_requests
         SET status = 'quarantined', expected_lease_fence = ?, expected_members_hash = ?,
             executor_lease_until = NULL, last_error = ?, resolved_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(nextFence, nextMembersHash, redactText(input.reason), now, now, request.id);
      if (input.executionNonce !== undefined) {
        this.db.prepare(
          `UPDATE runtime_cleanup_attempts SET state = 'failed', result = ?, completed_at = ?, updated_at = ?
           WHERE request_id = ? AND execution_nonce = ?`,
        ).run(JSON.stringify({ error: redactText(input.reason), quarantined: true }), now, now, request.id, input.executionNonce);
      }
      const kind = input.exhausted === true ? "cleanup_exhausted" : "cleanup_quarantined";
      const dedupeKey = `${request.id}:${nextFence}:${kind}:configured`;
      this.db.prepare(
        `INSERT OR IGNORE INTO runtime_resource_outbox
         (lease_id, request_id, dedupe_key, kind, transport, payload, sent_transports,
          status, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'configured', ?, '[]', 'pending', 0, ?, ?)`,
      ).run(lease.id, request.id, dedupeKey, kind, JSON.stringify({ reason: redactText(input.reason) }), now, now);
      this.addRuntimeResourceEvent(lease.id, input.exhausted === true ? "cleanup_exhausted" : "cleanup_quarantined", input.actor, {
        reason: redactText(input.reason),
        fence: nextFence,
      }, request.id);
    });
    exec();
  }

  /**
   * 明示的な解放希望を durable cleanup request へ変換する。
   * request 作成は live lease の state/fence を変更せず、担当者の fenced 判断へ渡すだけにする。
   */
  requestRuntimeResourceRelease(input: {
    leaseId: string;
    expectedLeaseFence: number;
    reason: string;
    actor: string;
  }): RuntimeCleanupRequestRow {
    const reason = redactText(input.reason.trim());
    if (reason === "") {
      throw new Error("runtime resource release request の reason は必須です");
    }
    const exec = this.db.transaction((): RuntimeCleanupRequestRow => {
      const current = this.requireRuntimeLeaseRaw(input.leaseId);
      if (current.fence !== input.expectedLeaseFence || !["active", "cleanup_pending", "expired"].includes(current.state)) {
        throw new Error("runtime resource release request の lease fence/state が一致しません");
      }

      const now = nowSeconds();
      const lease = current;
      const members = this.listRuntimeResourceMembers(input.leaseId);
      if (members.length === 0) {
        throw new Error("member の無い lease に release request は作成できません");
      }

      // 明示的な解放は auto policy でも必ず担当オーケストレーターの判断へ送る。
      // legacy / volume / human/never policy は所有権を推測せず人間判断へ倒す。
      const requiresHuman =
        lease.managed === 0 ||
        lease.controller_orchestrator_id === null ||
        lease.cleanup_policy === "human" ||
        lease.cleanup_policy === "never" ||
        members.some((member) => member.kind === "docker_volume" || !member.managed || member.cleanupPolicy === "human" || member.cleanupPolicy === "never");
      const decisionClass: RuntimeCleanupDecisionClass = requiresHuman ? "human" : "orchestrator";
      const membersHash = runtimeMembersHash(members);
      const existing = this.db
        .prepare(
          `SELECT * FROM runtime_cleanup_requests
           WHERE lease_id = ? AND expected_lease_fence = ? AND reason = ?`,
        )
        .get(input.leaseId, lease.fence, reason) as RawRuntimeCleanupRequestRow | undefined;
      if (existing !== undefined) {
        if (existing.decision_class !== decisionClass || existing.expected_members_hash !== membersHash) {
          throw new Error("runtime resource release request の冪等 snapshot が一致しません");
        }
        if (existing.decision_class === "human") {
          this.initializeRuntimeCleanupHumanRequest(existing.id, reason, now);
        }
        return mapRuntimeCleanupRequestRow(existing);
      }

      const id = generateRuntimeId("rc");
      const status = decisionClass === "human" ? "waiting_human" : "queued";
      this.db
        .prepare(
          `INSERT INTO runtime_cleanup_requests
           (id, lease_id, decision_class, reason, status, expected_lease_fence,
            expected_members_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.leaseId, decisionClass, reason, status, lease.fence, membersHash, now, now);
      if (decisionClass === "orchestrator") {
        this.enqueueRuntimeCleanupDeliveries({ requestId: id, lease, now });
      } else {
        this.initializeRuntimeCleanupHumanRequest(id, reason, now);
      }
      this.addRuntimeResourceEvent(input.leaseId, "cleanup_release_requested", input.actor, {
        decisionClass,
        expectedLeaseFence: lease.fence,
      }, id);
      return mapRuntimeCleanupRequestRow(this.requireRuntimeCleanupRequestRaw(id));
    });
    return exec();
  }

  claimRuntimeCleanupRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    expectedLeaseFence: number;
    leaseUntil: number;
    now?: number;
  }): RuntimeCleanupRequestRow {
    const now = input.now ?? nowSeconds();
    if (input.claimToken === "" || input.leaseUntil <= now) {
      throw new Error("runtime cleanup claim の token/leaseUntil が不正です");
    }
    const exec = this.db.transaction((): RuntimeCleanupRequestRow => {
      const request = this.requireRuntimeCleanupRequestRaw(input.requestId);
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      const session = this.db
        .prepare(
          `SELECT * FROM orchestrator_sessions
           WHERE id = ? AND generation = ? AND status = 'active' AND orchestrator_id = ?`,
        )
        .get(input.sessionId, input.generation, input.orchestratorId) as RawOrchestratorSessionRow | undefined;
      if (
        session === undefined ||
        request.decision_class !== "orchestrator" ||
        lease.controller_orchestrator_id !== input.orchestratorId
      ) {
        throw new Error("runtime cleanup claim の session generation/controller が不正です");
      }
      if (
        request.expected_lease_fence !== input.expectedLeaseFence ||
        lease.fence !== input.expectedLeaseFence ||
        this.runtimeMembersHash(lease.id) !== request.expected_members_hash ||
        this.db.prepare(
          `SELECT 1 FROM runtime_cleanup_deliveries
           WHERE request_id = ? AND orchestrator_id = ? AND status IN ('pending', 'delivered', 'acknowledged')`,
        ).get(input.requestId, session.orchestrator_id) === undefined
      ) {
        throw new Error("runtime cleanup claim の lease/member fence が stale です");
      }
      const info = this.db
        .prepare(
          `UPDATE runtime_cleanup_requests
           SET status = 'claimed', claimant_session_id = ?, claimant_generation = ?,
               claim_token_hash = ?, claim_lease_until = ?, updated_at = ?
           WHERE id = ? AND decision_class = 'orchestrator'
             AND (status IN ('queued', 'delivered') OR
                  (status = 'claimed' AND claim_lease_until IS NOT NULL AND claim_lease_until <= ?))`,
        )
        .run(
          input.sessionId,
          input.generation,
          sha256RuntimeValue(input.claimToken),
          input.leaseUntil,
          now,
          input.requestId,
          now,
        );
      if (info.changes !== 1) {
        throw new Error("runtime cleanup request は既に claim 済みです");
      }
      this.db
        .prepare(
          `UPDATE runtime_cleanup_deliveries
           SET status = 'acknowledged', updated_at = ?
           WHERE request_id = ? AND orchestrator_id = ?`,
        )
        .run(now, input.requestId, lease.controller_orchestrator_id);
      // poll delivery は claim 自体が receipt/ack なので、この時点で初めて FYI を enqueue する。
      const claimed = this.requireRuntimeCleanupRequestRaw(input.requestId);
      this.enqueueRuntimeCleanupNotification({
        request: claimed,
        lease,
        route: "orchestrator_fyi",
        question: `cleanup request ${input.requestId} をオーケストレーターが claim しました。返信は不要です。`,
        now,
      });
      this.addRuntimeResourceEvent(lease.id, "cleanup_claimed", session.orchestrator_id, {
        requestId: input.requestId,
        sessionId: input.sessionId,
        generation: input.generation,
      }, input.requestId);
      return mapRuntimeCleanupRequestRow(this.requireRuntimeCleanupRequestRaw(input.requestId));
    });
    return exec();
  }

  approveRuntimeCleanupRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    expectedLeaseFence: number;
    now?: number;
  }): RuntimeCleanupRequestRow {
    const now = input.now ?? nowSeconds();
    const exec = this.db.transaction((): RuntimeCleanupRequestRow => {
      const request = this.requireRuntimeCleanupRequestRaw(input.requestId);
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      const session = this.db
        .prepare(
          `SELECT * FROM orchestrator_sessions
           WHERE id = ? AND generation = ? AND status = 'active' AND orchestrator_id = ?`,
        )
        .get(input.sessionId, input.generation, input.orchestratorId) as RawOrchestratorSessionRow | undefined;
      if (session === undefined || lease.controller_orchestrator_id !== input.orchestratorId) {
        throw new Error("runtime cleanup approval の session generation/controller が不正です");
      }
      const tokenHash = sha256RuntimeValue(input.claimToken);
      const info = this.db
        .prepare(
          `UPDATE runtime_cleanup_requests
           SET status = 'approved', approved_by = ?, approval_generation = ?, updated_at = ?
           WHERE id = ? AND status = 'claimed' AND claimant_session_id = ? AND claimant_generation = ?
             AND claim_token_hash = ? AND claim_lease_until > ? AND expected_lease_fence = ?
             AND expected_members_hash = ?`,
        )
        .run(
          session.orchestrator_id,
          input.generation,
          now,
          input.requestId,
          input.sessionId,
          input.generation,
          tokenHash,
          now,
          input.expectedLeaseFence,
          this.runtimeMembersHash(lease.id),
        );
      if (info.changes !== 1 || lease.fence !== input.expectedLeaseFence) {
        throw new Error("runtime cleanup approval の claim/fence CAS に失敗しました");
      }
      this.addRuntimeResourceEvent(lease.id, "cleanup_approved", session.orchestrator_id, {
        requestId: input.requestId,
        generation: input.generation,
        expectedLeaseFence: input.expectedLeaseFence,
      }, input.requestId);
      return mapRuntimeCleanupRequestRow(this.requireRuntimeCleanupRequestRaw(input.requestId));
    });
    return exec();
  }

  rejectRuntimeCleanupRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    expectedLeaseFence: number;
    reason: string;
    now?: number;
  }): RuntimeCleanupRequestRow {
    const now = input.now ?? nowSeconds();
    const reason = redactText(input.reason.trim());
    if (reason === "") {
      throw new Error("runtime cleanup reject の reason は必須です");
    }
    const exec = this.db.transaction((): RuntimeCleanupRequestRow => {
      const request = this.requireRuntimeCleanupRequestRaw(input.requestId);
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      const session = this.db
        .prepare(
          `SELECT * FROM orchestrator_sessions
           WHERE id = ? AND generation = ? AND status = 'active' AND orchestrator_id = ?`,
        )
        .get(input.sessionId, input.generation, input.orchestratorId) as RawOrchestratorSessionRow | undefined;
      if (
        session === undefined ||
        lease.controller_orchestrator_id !== input.orchestratorId ||
        request.decision_class !== "orchestrator"
      ) {
        throw new Error("runtime cleanup reject の session generation/controller が不正です");
      }
      if (lease.fence !== input.expectedLeaseFence || this.runtimeMembersHash(lease.id) !== request.expected_members_hash) {
        throw new Error("runtime cleanup reject の lease/member fence が stale です");
      }
      const info = this.db
        .prepare(
          `UPDATE runtime_cleanup_requests
           SET status = 'rejected', last_error = ?, resolved_at = ?, updated_at = ?
           WHERE id = ? AND status = 'claimed' AND claimant_session_id = ? AND claimant_generation = ?
             AND claim_token_hash = ? AND claim_lease_until > ? AND expected_lease_fence = ?
             AND expected_members_hash = ?`,
        )
        .run(
          reason,
          now,
          now,
          input.requestId,
          input.sessionId,
          input.generation,
          sha256RuntimeValue(input.claimToken),
          now,
          input.expectedLeaseFence,
          request.expected_members_hash,
        );
      if (info.changes !== 1) {
        throw new Error("runtime cleanup reject の claim/fence CAS に失敗しました");
      }
      this.addRuntimeResourceEvent(lease.id, "cleanup_rejected", session.orchestrator_id, {
        requestId: input.requestId,
        generation: input.generation,
        expectedLeaseFence: input.expectedLeaseFence,
        reason,
      }, input.requestId);
      return mapRuntimeCleanupRequestRow(this.requireRuntimeCleanupRequestRaw(input.requestId));
    });
    return exec();
  }

  releaseRuntimeCleanupRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    expectedLeaseFence: number;
    now?: number;
  }): RuntimeCleanupRequestRow {
    const now = input.now ?? nowSeconds();
    const exec = this.db.transaction((): RuntimeCleanupRequestRow => {
      const request = this.requireRuntimeCleanupRequestRaw(input.requestId);
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      const session = this.db
        .prepare(
          `SELECT * FROM orchestrator_sessions
           WHERE id = ? AND generation = ? AND status = 'active' AND orchestrator_id = ?`,
        )
        .get(input.sessionId, input.generation, input.orchestratorId) as RawOrchestratorSessionRow | undefined;
      if (
        session === undefined ||
        lease.controller_orchestrator_id !== input.orchestratorId ||
        request.decision_class !== "orchestrator"
      ) {
        throw new Error("runtime cleanup release の session generation/controller が不正です");
      }
      if (lease.fence !== input.expectedLeaseFence || this.runtimeMembersHash(lease.id) !== request.expected_members_hash) {
        throw new Error("runtime cleanup release の lease/member fence が stale です");
      }
      const info = this.db
        .prepare(
          `UPDATE runtime_cleanup_requests
           SET status = 'queued', claimant_session_id = '', claimant_generation = NULL,
               claim_token_hash = '', claim_lease_until = NULL, updated_at = ?
           WHERE id = ? AND status = 'claimed' AND claimant_session_id = ? AND claimant_generation = ?
             AND claim_token_hash = ? AND claim_lease_until > ? AND expected_lease_fence = ?
             AND expected_members_hash = ?`,
        )
        .run(
          now,
          input.requestId,
          input.sessionId,
          input.generation,
          sha256RuntimeValue(input.claimToken),
          now,
          input.expectedLeaseFence,
          request.expected_members_hash,
        );
      if (info.changes !== 1) {
        throw new Error("runtime cleanup release の claim/fence CAS に失敗しました");
      }
      this.db
        .prepare(
          `UPDATE runtime_cleanup_deliveries SET status = 'pending', updated_at = ?
           WHERE request_id = ? AND orchestrator_id = ?`,
        )
        .run(now, input.requestId, session.orchestrator_id);
      this.addRuntimeResourceEvent(lease.id, "cleanup_claim_released", session.orchestrator_id, {
        requestId: input.requestId,
        generation: input.generation,
        expectedLeaseFence: input.expectedLeaseFence,
      }, input.requestId);
      return mapRuntimeCleanupRequestRow(this.requireRuntimeCleanupRequestRaw(input.requestId));
    });
    return exec();
  }

  // 配送待ちの cleanup delivery を request/lease 情報付きで返す（supervisor routing 用）
  listPendingRuntimeCleanupDeliveries(limit = 50): Array<{
    deliveryId: number;
    requestId: string;
    orchestratorId: string;
    watchId: string | null;
    leaseId: string;
    decisionClass: RuntimeCleanupDecisionClass;
    reason: string;
    requestStatus: RuntimeCleanupRequestStatus;
    expectedLeaseFence: number;
    ownerTaskId: string | null;
    humanAnswer: string;
  }> {
    const rows = this.db.prepare(`
      WITH pending_requests AS (
        SELECT r.id
        FROM runtime_cleanup_requests r
        WHERE r.status IN ('queued', 'delivered')
          AND r.decision_class = 'orchestrator'
          AND EXISTS (
            SELECT 1 FROM runtime_cleanup_deliveries pending
            WHERE pending.request_id = r.id AND pending.status = 'pending'
          )
        ORDER BY r.created_at, r.id
        LIMIT ?
      )
      SELECT d.id AS delivery_id, d.request_id, d.orchestrator_id, d.watch_id,
             r.lease_id, r.decision_class, r.reason, r.status AS request_status,
             r.expected_lease_fence, r.human_answer,
             l.owner_task_id
      FROM pending_requests selected
      JOIN runtime_cleanup_requests r ON r.id = selected.id
      JOIN runtime_cleanup_deliveries d ON d.request_id = selected.id
      JOIN runtime_resource_leases l ON l.id = r.lease_id
      WHERE d.status = 'pending'
      ORDER BY r.created_at, r.id, d.created_at, d.id
    `).all(limit) as Array<{
      delivery_id: number;
      request_id: string;
      orchestrator_id: string;
      watch_id: string | null;
      lease_id: string;
      decision_class: RuntimeCleanupDecisionClass;
      reason: string;
      request_status: RuntimeCleanupRequestStatus;
      expected_lease_fence: number;
      owner_task_id: string | null;
      human_answer: string;
    }>;
    return rows.map((row) => ({
      deliveryId: row.delivery_id,
      requestId: row.request_id,
      orchestratorId: row.orchestrator_id,
      watchId: row.watch_id,
      leaseId: row.lease_id,
      decisionClass: row.decision_class as RuntimeCleanupDecisionClass,
      reason: row.reason,
      requestStatus: row.request_status as RuntimeCleanupRequestStatus,
      expectedLeaseFence: row.expected_lease_fence,
      ownerTaskId: row.owner_task_id,
      humanAnswer: row.human_answer,
    }));
  }

  /** orchestrator inbox/await が poll・inject・app-wakeup 共通で取得する cleanup request。 */
  listRuntimeCleanupInboxDeliveries(orchestratorId: string, limit = 50, now = nowSeconds()): Array<{
    deliveryId: number;
    requestId: string;
    orchestratorId: string;
    watchId: string | null;
    leaseId: string;
    decisionClass: RuntimeCleanupDecisionClass;
    reason: string;
    requestStatus: RuntimeCleanupRequestStatus;
    expectedLeaseFence: number;
    ownerTaskId: string | null;
    humanAnswer: string;
  }> {
    const rows = this.db.prepare(`
      SELECT d.id AS delivery_id, d.request_id, d.orchestrator_id, d.watch_id,
             r.lease_id, r.decision_class, r.reason, r.status AS request_status,
             r.expected_lease_fence, r.human_answer, l.owner_task_id
      FROM runtime_cleanup_deliveries d
      JOIN runtime_cleanup_requests r ON r.id = d.request_id
      JOIN runtime_resource_leases l ON l.id = r.lease_id
      WHERE d.orchestrator_id = ?
        AND l.controller_orchestrator_id = ?
        AND r.decision_class = 'orchestrator'
        AND (
          (d.status IN ('pending', 'delivered') AND r.status IN ('queued', 'delivered')) OR
          (d.status = 'acknowledged' AND r.status = 'claimed'
            AND r.claim_lease_until IS NOT NULL AND r.claim_lease_until <= ?)
        )
      ORDER BY d.created_at, d.id
      LIMIT ?
    `).all(orchestratorId, orchestratorId, now, limit) as Array<{
      delivery_id: number;
      request_id: string;
      orchestrator_id: string;
      watch_id: string | null;
      lease_id: string;
      decision_class: RuntimeCleanupDecisionClass;
      reason: string;
      request_status: RuntimeCleanupRequestStatus;
      expected_lease_fence: number;
      owner_task_id: string | null;
      human_answer: string;
    }>;
    return rows.map((row) => ({
      deliveryId: row.delivery_id,
      requestId: row.request_id,
      orchestratorId: row.orchestrator_id,
      watchId: row.watch_id,
      leaseId: row.lease_id,
      decisionClass: row.decision_class,
      reason: row.reason,
      requestStatus: row.request_status,
      expectedLeaseFence: row.expected_lease_fence,
      ownerTaskId: row.owner_task_id,
      humanAnswer: row.human_answer,
    }));
  }

  /** await が family 間比較に使う、元 request 時刻基準の credential 無し cleanup 候補。 */
  peekRuntimeCleanupAwaitCandidate(orchestratorId: string, now = nowSeconds()): {
    requestId: string;
    claimableAt: number;
    expectedLeaseFence: number;
    leaseId: string;
    reason: string;
    ownerTaskId: string | null;
    humanAnswer: string;
  } | null {
    const row = this.db.prepare(`
      SELECT r.id AS request_id, r.created_at AS claimable_at,
             r.expected_lease_fence, r.lease_id, r.reason,
             l.owner_task_id, r.human_answer
      FROM runtime_cleanup_deliveries d
      JOIN runtime_cleanup_requests r ON r.id = d.request_id
      JOIN runtime_resource_leases l ON l.id = r.lease_id
      WHERE d.orchestrator_id = ?
        AND l.controller_orchestrator_id = ?
        AND r.decision_class = 'orchestrator'
        AND (
          (d.status IN ('pending', 'delivered') AND r.status IN ('queued', 'delivered')) OR
          (d.status = 'acknowledged' AND r.status = 'claimed'
            AND r.claim_lease_until IS NOT NULL AND r.claim_lease_until <= ?)
        )
      ORDER BY r.created_at, r.id, d.id
      LIMIT 1
    `).get(orchestratorId, orchestratorId, now) as {
      request_id: string;
      claimable_at: number;
      expected_lease_fence: number;
      lease_id: string;
      reason: string;
      owner_task_id: string | null;
      human_answer: string;
    } | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      requestId: row.request_id,
      claimableAt: row.claimable_at,
      expectedLeaseFence: row.expected_lease_fence,
      leaseId: row.lease_id,
      reason: row.reason,
      ownerTaskId: row.owner_task_id,
      humanAnswer: row.human_answer,
    };
  }

  /**
   * provider adapter の receipt 確認後だけ delivery を delivered にする。
   * session generation/controller/fence を同じ Tx で検証し、永続 inbox 行があるだけでは進めない。
   */
  markRuntimeCleanupDeliveryDelivered(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    receipt: string;
    now?: number;
  }): void {
    const now = input.now ?? nowSeconds();
    if (input.receipt.trim() === "") {
      throw new Error("runtime cleanup delivery receipt は必須です");
    }
    const exec = this.db.transaction((): void => {
      const request = this.requireRuntimeCleanupRequestRaw(input.requestId);
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      const session = this.db.prepare(
        `SELECT 1 FROM orchestrator_sessions
         WHERE id = ? AND orchestrator_id = ? AND generation = ? AND status = 'active'`,
      ).get(input.sessionId, input.orchestratorId, input.generation);
      if (
        session === undefined ||
        lease.controller_orchestrator_id !== input.orchestratorId ||
        lease.fence !== request.expected_lease_fence ||
        request.decision_class !== "orchestrator"
      ) {
        throw new Error("runtime cleanup delivery の session/controller/fence が stale です");
      }
      const info = this.db.prepare(
        `UPDATE runtime_cleanup_deliveries SET status = 'delivered', updated_at = ?
         WHERE request_id = ? AND orchestrator_id = ? AND status = 'pending'`
      ).run(now, input.requestId, input.orchestratorId);
      if (info.changes !== 1) {
        return;
      }
      this.db.prepare(
        `UPDATE runtime_cleanup_requests SET status = 'delivered', updated_at = ?
         WHERE id = ? AND status = 'queued'`
      ).run(now, input.requestId);
      const deliveredRequest = this.requireRuntimeCleanupRequestRaw(input.requestId);
      this.enqueueRuntimeCleanupNotification({
        request: deliveredRequest,
        lease,
        route: "orchestrator_fyi",
        question: `cleanup request ${input.requestId} をオーケストレーターへ配送しました。返信は不要です。`,
        now,
      });
      this.addRuntimeResourceEvent(request.lease_id, "cleanup_delivery_delivered", "supervisor", {
        requestId: input.requestId,
        orchestratorId: input.orchestratorId,
        sessionId: input.sessionId,
        generation: input.generation,
        receipt: input.receipt,
      }, input.requestId);
    });
    exec();
  }

  /** cascade delivery 作成と controller 変更を単一 CAS Tx で行う。 */
  routeRuntimeCleanupDelivery(input: {
    requestId: string;
    expectedControllerId: string;
    targetOrchestratorId: string;
    targetWatchId?: string;
    expectedLeaseFence: number;
    now?: number;
  }): void {
    const now = input.now ?? nowSeconds();
    const exec = this.db.transaction((): void => {
      const request = this.requireRuntimeCleanupRequestRaw(input.requestId);
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      if (
        request.decision_class !== "orchestrator" ||
        !["queued", "delivered"].includes(request.status) ||
        request.expected_lease_fence !== input.expectedLeaseFence ||
        lease.fence !== input.expectedLeaseFence
      ) {
        throw new Error("runtime cleanup route の request/fence が stale です");
      }
      if (this.getOrchestrator(input.targetOrchestratorId) === null) {
        throw new Error("runtime cleanup route の target orchestrator が存在しません");
      }
      const controllerChanged = lease.controller_orchestrator_id !== input.targetOrchestratorId;
      if (controllerChanged) {
        const changed = this.db.prepare(
          `UPDATE runtime_resource_leases
           SET controller_orchestrator_id = ?, updated_at = ?
           WHERE id = ? AND controller_orchestrator_id = ? AND fence = ?`,
        ).run(
          input.targetOrchestratorId,
          now,
          lease.id,
          input.expectedControllerId,
          input.expectedLeaseFence,
        );
        if (changed.changes !== 1) {
          throw new Error("runtime cleanup route の controller CAS に失敗しました");
        }
      }
      this.db.prepare(
        `UPDATE runtime_cleanup_deliveries SET status = 'dismissed', updated_at = ?
         WHERE request_id = ? AND orchestrator_id <> ? AND status <> 'acknowledged'`,
      ).run(now, input.requestId, input.targetOrchestratorId);
      this.db.prepare(
        `INSERT INTO runtime_cleanup_deliveries
         (request_id, orchestrator_id, watch_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(request_id, orchestrator_id)
         DO UPDATE SET watch_id = excluded.watch_id, status = 'pending', updated_at = excluded.updated_at`,
      ).run(input.requestId, input.targetOrchestratorId, input.targetWatchId ?? null, now, now);
      this.db.prepare(
        `UPDATE runtime_cleanup_requests SET status = 'queued', updated_at = ?
         WHERE id = ? AND status IN ('queued', 'delivered')`,
      ).run(now, input.requestId);
      if (controllerChanged) {
        this.addRuntimeResourceEvent(lease.id, "controller_transferred", "supervisor", {
          requestId: input.requestId,
          previousControllerId: input.expectedControllerId,
          newControllerId: input.targetOrchestratorId,
          expectedLeaseFence: input.expectedLeaseFence,
        }, input.requestId);
      }
    });
    exec();
  }

  // オーケストレーター不在時に supervisor が cleanup request を human 判断へ昇格する。
  markRuntimeCleanupOrchestratorUnavailable(requestId: string, reason: string, actor: string, now = nowSeconds()): void {
    const exec = this.db.transaction((): void => {
      const request = this.requireRuntimeCleanupRequestRaw(requestId);
      if (!["queued", "delivered"].includes(request.status)) {
        return; // 既に claim 済み等 → 冪等に no-op
      }
      const nonce = randomBytes(24).toString("hex");
      const changed = this.db.prepare(
        `UPDATE runtime_cleanup_requests
         SET status = 'waiting_human', decision_class = 'human',
             escalation_generation = escalation_generation + 1,
             human_answer_nonce_hash = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'delivered')`
      ).run(sha256RuntimeValue(nonce), now, requestId);
      if (changed.changes !== 1) {
        return;
      }
      this.db.prepare(
        `UPDATE runtime_cleanup_deliveries SET status = 'dismissed', updated_at = ?
         WHERE request_id = ?`
      ).run(now, requestId);
      const escalated = this.requireRuntimeCleanupRequestRaw(requestId);
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      this.enqueueRuntimeCleanupNotification({
        request: escalated,
        lease,
        route: "human_question",
        question: reason,
        nonce,
        now,
      });
      this.addRuntimeResourceEvent(request.lease_id, "cleanup_escalated_to_human", actor, {
        requestId,
        reason,
        escalationGeneration: escalated.escalation_generation,
      }, requestId);
    });
    exec();
  }

  /** claim 中の orchestrator が fenced CAS を通して明示的に人間へ escalation する。 */
  escalateRuntimeCleanupRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    expectedLeaseFence: number;
    question: string;
    now?: number;
  }): RuntimeCleanupRequestRow {
    const now = input.now ?? nowSeconds();
    const question = redactText(input.question.trim());
    if (question === "") {
      throw new Error("runtime cleanup escalation question は必須です");
    }
    const exec = this.db.transaction((): RuntimeCleanupRequestRow => {
      const request = this.requireRuntimeCleanupRequestRaw(input.requestId);
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      const session = this.db
        .prepare(
          `SELECT 1 FROM orchestrator_sessions
           WHERE id = ? AND orchestrator_id = ? AND generation = ? AND status = 'active'`,
        )
        .get(input.sessionId, input.orchestratorId, input.generation);
      if (
        session === undefined ||
        lease.controller_orchestrator_id !== input.orchestratorId ||
        lease.fence !== input.expectedLeaseFence ||
        request.expected_lease_fence !== input.expectedLeaseFence ||
        this.runtimeMembersHash(lease.id) !== request.expected_members_hash
      ) {
        throw new Error("runtime cleanup escalation の session/controller/fence が不正です");
      }
      const nonce = randomBytes(24).toString("hex");
      const changed = this.db
        .prepare(
          `UPDATE runtime_cleanup_requests
           SET status = 'waiting_human', decision_class = 'human',
               escalation_generation = escalation_generation + 1,
               human_answer_nonce_hash = ?, claimant_session_id = '', claimant_generation = NULL,
               claim_token_hash = '', claim_lease_until = NULL, updated_at = ?
           WHERE id = ? AND status = 'claimed' AND claimant_session_id = ? AND claimant_generation = ?
             AND claim_token_hash = ? AND claim_lease_until > ?`,
        )
        .run(
          sha256RuntimeValue(nonce),
          now,
          input.requestId,
          input.sessionId,
          input.generation,
          sha256RuntimeValue(input.claimToken),
          now,
        );
      if (changed.changes !== 1) {
        throw new Error("runtime cleanup escalation の claim CAS に失敗しました");
      }
      const escalated = this.requireRuntimeCleanupRequestRaw(input.requestId);
      this.enqueueRuntimeCleanupNotification({
        request: escalated,
        lease,
        route: "human_question",
        question,
        nonce,
        now,
      });
      this.addRuntimeResourceEvent(lease.id, "cleanup_escalated_to_human", input.orchestratorId, {
        requestId: input.requestId,
        generation: input.generation,
        expectedLeaseFence: input.expectedLeaseFence,
        escalationGeneration: escalated.escalation_generation,
      }, input.requestId);
      return mapRuntimeCleanupRequestRow(escalated);
    });
    return exec();
  }

  /** Telegram 等の人間回答を nonce で request に保存し、orchestrator 再 claim 待ちへ戻す。 */
  recordHumanAnswerForRuntimeCleanupRequest(
    requestId: string,
    nonce: string,
    answer: string,
    now = nowSeconds(),
  ): RuntimeCleanupRequestRow | null {
    const redacted = redactText(answer.trim());
    if (redacted === "" || nonce === "") {
      return null;
    }
    const exec = this.db.transaction((): RuntimeCleanupRequestRow | null => {
      const request = this.requireRuntimeCleanupRequestRaw(requestId);
      const lease = this.requireRuntimeLeaseRaw(request.lease_id);
      if (lease.controller_orchestrator_id === null) {
        return null;
      }
      const changed = this.db.prepare(
        `UPDATE runtime_cleanup_requests
         SET status = 'queued', decision_class = 'orchestrator', human_answer = ?,
             human_answer_nonce_hash = '', updated_at = ?
         WHERE id = ? AND status = 'waiting_human' AND decision_class = 'human'
           AND human_answer_nonce_hash = ?`,
      ).run(redacted, now, requestId, sha256RuntimeValue(nonce));
      if (changed.changes !== 1) {
        return null;
      }
      this.db
        .prepare(`UPDATE runtime_cleanup_deliveries SET status = 'pending', updated_at = ? WHERE request_id = ?`)
        .run(now, requestId);
      this.enqueueRuntimeCleanupDeliveries({ requestId, lease, now });
      this.addRuntimeResourceEvent(lease.id, "cleanup_human_answer_recorded", "human", {
        requestId,
        escalationGeneration: request.escalation_generation,
        answerLength: redacted.length,
      }, requestId);
      return mapRuntimeCleanupRequestRow(this.requireRuntimeCleanupRequestRaw(requestId));
    });
    return exec();
  }

  listRuntimeResourceEvents(leaseId: string): RuntimeResourceEventRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM runtime_resource_events WHERE lease_id = ? ORDER BY created_at, id`)
        .all(leaseId) as RawRuntimeResourceEventRow[]
    ).map(mapRuntimeResourceEventRow);
  }

  listPendingNotificationOutbox(limit = 100, now = nowSeconds()): NotificationOutboxRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM notification_outbox WHERE status IN ('pending', 'failed') AND next_attempt_at <= ? ORDER BY id LIMIT ?`)
      .all(now, limit) as RawNotificationOutboxRow[];
    return rows.map(mapNotificationOutboxRow);
  }

  listPendingRuntimeResourceOutbox(limit = 100, now = nowSeconds()): RuntimeResourceOutboxRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM runtime_resource_outbox WHERE status IN ('pending', 'failed') AND next_attempt_at <= ? ORDER BY id LIMIT ?`)
      .all(now, limit) as RawRuntimeResourceOutboxRow[];
    return rows.map(mapRuntimeResourceOutboxRow);
  }

  markRuntimeResourceOutbox(
    id: number,
    status: "sent" | "failed",
    nextAttemptAt = 0,
    sentTransports: readonly string[] = [],
  ): RuntimeResourceOutboxRow {
    const now = nowSeconds();
    const info = this.db.prepare(
      `UPDATE runtime_resource_outbox
       SET status = ?, attempts = attempts + 1, next_attempt_at = ?,
           sent_transports = ?, updated_at = ?
       WHERE id = ?`,
    ).run(status, nextAttemptAt, JSON.stringify([...new Set(sentTransports)]), now, id);
    if (info.changes !== 1) {
      throw new Error(`runtime resource outbox が見つかりません: ${id}`);
    }
    return mapRuntimeResourceOutboxRow(
      this.db.prepare(`SELECT * FROM runtime_resource_outbox WHERE id = ?`).get(id) as RawRuntimeResourceOutboxRow,
    );
  }

  enqueueHalfOpenOutbox(input: {
    stage: HalfOpenOutboxStage;
    claimGeneration: number;
    dedupeKey: string;
    kind: string;
    payload: string;
    now?: number;
  }): HalfOpenOutboxEnqueueResult {
    const now = input.now ?? nowSeconds();
    // INSERT OR IGNORE は CHECK 違反も黙って捨てるので、dedupe_key 衝突だけを無視する ON CONFLICT で書く
    const info = this.db.prepare(
      `INSERT INTO half_open_outbox (
         id, stage, claim_generation, dedupe_key, kind, payload,
         sent_transports, status, attempts, next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, '[]', 'pending', 0, NULL, ?, ?)
       ON CONFLICT(dedupe_key) DO NOTHING`,
    ).run(generateRuntimeId("hoo"), input.stage, input.claimGeneration, input.dedupeKey, input.kind, input.payload, now, now);
    const raw = this.db
      .prepare(`SELECT * FROM half_open_outbox WHERE dedupe_key = ?`)
      .get(input.dedupeKey) as RawHalfOpenOutboxRow | undefined;
    if (raw === undefined) {
      throw new Error(`half-open outbox の行が見つかりません: dedupe_key=${input.dedupeKey}`);
    }
    const row = mapHalfOpenOutboxRow(raw);
    return info.changes === 1 ? { outcome: "created", row } : { outcome: "duplicate", row };
  }

  listPendingHalfOpenOutbox(input: { stage: HalfOpenOutboxStage; now?: number; limit?: number }): HalfOpenOutboxRow[] {
    const now = input.now ?? nowSeconds();
    const limit = input.limit ?? 50;
    const rows = this.db
      .prepare(
        `SELECT * FROM half_open_outbox
         WHERE stage = ? AND status IN ('pending', 'failed')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at, id LIMIT ?`,
      )
      .all(input.stage, now, limit) as RawHalfOpenOutboxRow[];
    return rows.map(mapHalfOpenOutboxRow);
  }

  markHalfOpenOutbox(input: {
    id: string;
    result: "sent" | "failed";
    sentTransports?: string[];
    retryAfterSec?: number;
    now?: number;
  }): HalfOpenOutboxRow | null {
    const now = input.now ?? nowSeconds();
    const retryAfterSec = input.retryAfterSec ?? 60;
    const readRow = (): RawHalfOpenOutboxRow | undefined =>
      this.db.prepare(`SELECT * FROM half_open_outbox WHERE id = ?`).get(input.id) as RawHalfOpenOutboxRow | undefined;
    const current = readRow();
    if (current === undefined) {
      return null;
    }
    // pending|failed 以外（sent / discarded）は終端なので変更せず現在行を返す
    if (current.status !== "pending" && current.status !== "failed") {
      return mapHalfOpenOutboxRow(current);
    }
    const sentTransports =
      input.sentTransports === undefined ? current.sent_transports : JSON.stringify([...new Set(input.sentTransports)]);
    if (input.result === "sent") {
      this.db.prepare(
        `UPDATE half_open_outbox
         SET status = 'sent', next_attempt_at = NULL, sent_transports = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'failed')`,
      ).run(sentTransports, now, input.id);
    } else {
      this.db.prepare(
        `UPDATE half_open_outbox
         SET status = 'failed', attempts = attempts + 1, next_attempt_at = ?, sent_transports = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'failed')`,
      ).run(now + retryAfterSec, sentTransports, now, input.id);
    }
    const updated = readRow();
    return updated === undefined ? null : mapHalfOpenOutboxRow(updated);
  }

  discardStaleHalfOpenOutbox(input: { stage: HalfOpenOutboxStage; currentGeneration: number; now?: number }): number {
    const now = input.now ?? nowSeconds();
    const info = this.db.prepare(
      `UPDATE half_open_outbox
       SET status = 'discarded', updated_at = ?
       WHERE stage = ? AND claim_generation < ? AND status IN ('pending', 'failed')`,
    ).run(now, input.stage, input.currentGeneration);
    return info.changes;
  }

  markNotificationOutbox(
    id: number,
    status: "sent" | "failed",
    nextAttemptAt = 0,
    sentTransports: readonly string[] = [],
  ): NotificationOutboxRow {
    const now = nowSeconds();
    const info = this.db
      .prepare(
        `UPDATE notification_outbox
         SET status = ?, attempts = attempts + 1, next_attempt_at = ?, sent_transports = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, nextAttemptAt, JSON.stringify([...new Set(sentTransports)]), now, id);
    if (info.changes !== 1) {
      throw new Error(`notification outbox が見つかりません: ${id}`);
    }
    return mapNotificationOutboxRow(this.db.prepare(`SELECT * FROM notification_outbox WHERE id = ?`).get(id) as RawNotificationOutboxRow);
  }

  /**
   * 複数のストア操作を単一トランザクションで実行する（docs/contract.md §12.4-4）。
   * better-sqlite3 の transaction() へ委譲する（同期のみ。fn 内で await は不可）。
   * ネストした呼び出しは better-sqlite3 が savepoint で自動的に扱う。
   */
  // ===== 契約 §77.4 係数テーブル / §77.9 立ち上げ標本 =====

  upsertSessionUsageProfile(row: SessionUsageProfileRow): void {
    this.db.prepare(`
      INSERT INTO session_usage_profiles (
        provider, model, effort_key, turns, measured,
        cache_read_per_turn, cache_write_5m_per_turn, cache_write_1h_per_turn, output_per_turn,
        reasoning_per_turn, context_growth_per_turn, source_session_ids, computed_from_ref, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, model, effort_key) DO UPDATE SET
        turns = excluded.turns,
        measured = excluded.measured,
        cache_read_per_turn = excluded.cache_read_per_turn,
        cache_write_5m_per_turn = excluded.cache_write_5m_per_turn,
        cache_write_1h_per_turn = excluded.cache_write_1h_per_turn,
        output_per_turn = excluded.output_per_turn,
        reasoning_per_turn = excluded.reasoning_per_turn,
        context_growth_per_turn = excluded.context_growth_per_turn,
        source_session_ids = excluded.source_session_ids,
        computed_from_ref = excluded.computed_from_ref,
        updated_at = excluded.updated_at
    `).run(
      row.provider,
      row.model,
      row.effort ?? "unset",
      row.turns,
      row.measured ? 1 : 0,
      row.cacheReadPerTurn,
      row.cacheWrite5mPerTurn,
      row.cacheWrite1hPerTurn,
      row.outputPerTurn,
      row.reasoningPerTurn,
      row.contextGrowthPerTurn,
      JSON.stringify(row.sourceSessionIds),
      row.computedFromRef,
      row.updatedAt,
    );
  }

  listSessionUsageProfiles(filter?: { provider?: Provider; model?: string }): SessionUsageProfileRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.provider !== undefined) {
      where.push("provider = ?");
      params.push(filter.provider);
    }
    if (filter?.model !== undefined) {
      where.push("model = ?");
      params.push(filter.model);
    }
    const rows = this.db.prepare(`
      SELECT provider, model, effort_key, turns, measured,
        cache_read_per_turn, cache_write_5m_per_turn, cache_write_1h_per_turn, output_per_turn,
        reasoning_per_turn, context_growth_per_turn, source_session_ids, computed_from_ref, updated_at
      FROM session_usage_profiles
      ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
      ORDER BY provider, model, effort_key
    `).all(...params) as Array<{
      provider: Provider;
      model: string;
      effort_key: string;
      turns: number;
      measured: number;
      cache_read_per_turn: number;
      cache_write_5m_per_turn: number;
      cache_write_1h_per_turn: number;
      output_per_turn: number;
      reasoning_per_turn: number | null;
      context_growth_per_turn: number | null;
      source_session_ids: string;
      computed_from_ref: string;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      effort: r.effort_key === "unset" ? null : (r.effort_key as EffortLevel),
      turns: r.turns,
      measured: r.measured === 1,
      cacheReadPerTurn: r.cache_read_per_turn,
      cacheWrite5mPerTurn: r.cache_write_5m_per_turn,
      cacheWrite1hPerTurn: r.cache_write_1h_per_turn,
      outputPerTurn: r.output_per_turn,
      reasoningPerTurn: r.reasoning_per_turn,
      contextGrowthPerTurn: r.context_growth_per_turn,
      sourceSessionIds: parseSessionIdArray(r.source_session_ids),
      computedFromRef: r.computed_from_ref,
      updatedAt: r.updated_at,
    }));
  }

  upsertSessionBootSample(row: SessionBootSampleRow): void {
    this.db.prepare(`
      INSERT INTO session_boot_samples (
        orchestrator_id, session_id, provider_session_id, provider, model,
        context_at_turn15, boot_overhead_usd, provenance, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(orchestrator_id, session_id) DO UPDATE SET
        provider_session_id = excluded.provider_session_id,
        provider = excluded.provider,
        model = excluded.model,
        context_at_turn15 = excluded.context_at_turn15,
        boot_overhead_usd = excluded.boot_overhead_usd,
        provenance = excluded.provenance,
        updated_at = excluded.updated_at
    `).run(
      row.orchestratorId,
      row.sessionId,
      row.providerSessionId,
      row.provider,
      row.model,
      row.contextAtTurn15,
      row.bootOverheadUsd,
      row.provenance,
      row.createdAt,
      row.updatedAt,
    );
  }

  listSessionBootSamples(input: { orchestratorId: string; limit?: number }): SessionBootSampleRow[] {
    const limitClause = input.limit === undefined ? "" : "LIMIT ?";
    const params: unknown[] = [input.orchestratorId];
    if (input.limit !== undefined) {
      params.push(input.limit);
    }
    const rows = this.db.prepare(`
      SELECT orchestrator_id, session_id, provider_session_id, provider, model,
        context_at_turn15, boot_overhead_usd, provenance, created_at, updated_at
      FROM session_boot_samples
      WHERE orchestrator_id = ?
      ORDER BY created_at DESC, session_id DESC
      ${limitClause}
    `).all(...params) as Array<{
      orchestrator_id: string;
      session_id: string;
      provider_session_id: string;
      provider: Provider;
      model: string | null;
      context_at_turn15: number | null;
      boot_overhead_usd: number | null;
      provenance: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      orchestratorId: r.orchestrator_id,
      sessionId: r.session_id,
      providerSessionId: r.provider_session_id,
      provider: r.provider,
      model: r.model,
      contextAtTurn15: r.context_at_turn15,
      bootOverheadUsd: r.boot_overhead_usd,
      provenance: r.provenance,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  transaction<T>(fn: () => T): T {
    const exec = this.db.transaction(fn);
    return exec();
  }

  counts(): Record<TaskStatus, number> {
    const base = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<TaskStatus, number>;
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS count FROM tasks GROUP BY status`).all() as Array<{
      status: string;
      count: number;
    }>;
    for (const row of rows) {
      if ((TASK_STATUSES as readonly string[]).includes(row.status)) {
        base[row.status as TaskStatus] = row.count;
      }
    }
    return base;
  }

  /**
   * tick の各ステージ結果を tick_metrics へ記録する（docs/contract.md §43.1）。
   * 1行/ステージで INSERT し、同一秒の複数 tick も落とさず保持する。
   * 合わせて 90 日超過の古いレコードを間引き削除する。
   */
  recordTickMetrics(
    metrics: ReadonlyArray<TickMetricInput>,
    tickTs: number,
  ): void {
    if (!Number.isInteger(tickTs) || tickTs < 0) {
      throw new Error(`tickTs は 0 以上の整数が必須です: ${tickTs}`);
    }
    const insert = this.db.prepare(
      `INSERT INTO tick_metrics (ts, stage, actions, duration_ms) VALUES (?, ?, ?, ?)`,
    );
    const prune = this.db.prepare(
      `DELETE FROM tick_metrics WHERE ts < ?`,
    );
    const cutoff = tickTs - 90 * 24 * 60 * 60; // 90日前
    const run = this.db.transaction(() => {
      for (const m of metrics) {
        assertTickMetricInput(m);
        insert.run(tickTs, m.stage, m.actions, m.durationMs);
      }
      prune.run(cutoff);
    });
    run();
  }

  close(): void {
    this.db.close();
  }
}

/**
 * stall / session budget request を claim fence の内側で解決し、判定と理由を監査 event に残す。
 * worker への answer enqueue、task 本文、worker session は変更しない。
 */
export function resolveRunStalledOrchestratorRequest(
  store: KanbanStore,
  input: {
    requestId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    resolution: "handled" | "false_positive";
    reason: string;
  },
): OrchestratorRequestRow {
  const reason = redactText(input.reason.trim());
  if (reason.length === 0) {
    throw new Error("orchestrator resolve の理由は空にできません");
  }
  return store.transaction((): OrchestratorRequestRow => {
    const request = store.getOrchestratorRequest(input.requestId);
    if (request === null) {
      throw new Error(`orchestrator request が見つかりません: ${input.requestId}`);
    }
    if (
      request.kind !== "run_stalled" &&
      request.kind !== "run_stall_suspected" &&
      request.kind !== "session_budget"
    ) {
      throw new Error(
        `orchestrator resolve は kind=run_stalled|run_stall_suspected|session_budget 専用です: kind=${request.kind}`,
      );
    }
    const session = store.getOrchestratorSession(input.sessionId);
    if (session === null) {
      throw new Error(`orchestrator session が見つかりません: ${input.sessionId}`);
    }
    const requestKey = request.kind === "run_stall_suspected"
      ? "run-stall-suspected"
      : request.kind === "session_budget"
        ? "session-budget"
        : "run-stalled";
    const answerKey = `${requestKey}-resolve:${request.id}:${input.sessionId}:${input.generation}`;
    store.beginOrchestratorRequestAnswer({
      requestId: request.id,
      sessionId: input.sessionId,
      generation: input.generation,
      claimToken: input.claimToken,
      answerKey,
    });
    store.addEvent(
      request.taskId,
      request.kind === "run_stall_suspected"
        ? "orchestrator_run_stall_suspected_resolved"
        : request.kind === "session_budget"
          ? "orchestrator_session_budget_resolved"
          : "orchestrator_run_stalled_resolved",
      "orchestrator",
      { requestId: request.id, resolution: input.resolution, reason },
      {
        kind: "orchestrator",
        actorId: session.orchestratorId,
        actorSessionId: session.id,
        actorGeneration: input.generation,
      },
    );
    const resolved = store.resolveOrchestratorRequestByAnswerKey(request.taskId, answerKey);
    if (resolved === null) {
      throw new Error(`${request.kind} request の resolve に失敗しました`);
    }
    return resolved;
  });
}
