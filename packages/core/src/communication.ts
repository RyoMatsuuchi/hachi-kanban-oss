// Provider 純正 session 間通信の control-plane 契約（docs/contract.md §68）。
// 実行 transport とは分離し、steer_deliveries を durable authority のまま維持する。

import { createHash } from "node:crypto";

import type {
  ActorProvenance,
  CommunicationPreference,
  CommunicationRolloutState,
  CommunicationRoute,
  NativeCommunicationSocketSnapshot,
  Provider,
} from "./types.js";

export type { NativeCommunicationSocketSnapshot } from "./types.js";

export type CommunicationCapabilityState = "supported" | "unsupported" | "unknown";

export interface ResolveCommunicationRouteInput {
  sourceProvider: Provider;
  targetProvider: Provider;
  rollout: CommunicationRolloutState;
  preference: CommunicationPreference;
  sameHost: boolean;
  exactSourceBinding: boolean;
  exactTargetBinding: boolean;
  capability: CommunicationCapabilityState;
  /** canary の決定論的な選出結果。on では参照しない。 */
  canaryEligible?: boolean;
}

export type CommunicationRouteDecisionReason =
  | "explicit-hachi"
  | "same-provider-hachi-refused"
  | "cross-provider"
  | "native-cross-provider-refused"
  | "rollout-off"
  | "rollout-draining"
  | "observe-only"
  | "canary-not-selected"
  | "exact-source-binding-missing"
  | "exact-target-binding-missing"
  | "cross-host-refused"
  | "native-capability-unsupported"
  | "native-capability-unknown"
  | "native-selected";

export type CommunicationRouteDecision =
  | {
      status: "deliver";
      route: CommunicationRoute;
      nativeCandidate: Exclude<CommunicationRoute, "hachi"> | null;
      reason: CommunicationRouteDecisionReason;
    }
  | {
      status: "refused";
      route: null;
      nativeCandidate: Exclude<CommunicationRoute, "hachi"> | null;
      reason: CommunicationRouteDecisionReason;
    };

function nativeRouteFor(provider: Provider): Exclude<CommunicationRoute, "hachi"> {
  return provider === "claude" ? "claude-cross-session" : "codex-app-server";
}

/**
 * 通信routeを副作用なしで決める。off/observe/draining はnativeをclaimせず、
 * cross-providerは常にHachiへ送る。canary/onの不明・非対応はsilent fallbackしない。
 */
export function resolveCommunicationRoute(input: ResolveCommunicationRouteInput): CommunicationRouteDecision {
  if (input.sourceProvider !== input.targetProvider) {
    if (input.preference === "native") {
      return { status: "refused", route: null, nativeCandidate: null, reason: "native-cross-provider-refused" };
    }
    return { status: "deliver", route: "hachi", nativeCandidate: null, reason: "cross-provider" };
  }

  const nativeCandidate = nativeRouteFor(input.targetProvider);
  if (input.preference === "hachi") {
    if (input.rollout === "on" || (input.rollout === "canary" && input.canaryEligible === true)) {
      return { status: "refused", route: null, nativeCandidate, reason: "same-provider-hachi-refused" };
    }
    return { status: "deliver", route: "hachi", nativeCandidate, reason: "explicit-hachi" };
  }
  const requirementFailure = (): CommunicationRouteDecisionReason | null => {
    if (!input.exactSourceBinding) return "exact-source-binding-missing";
    if (!input.exactTargetBinding) return "exact-target-binding-missing";
    if (!input.sameHost) return "cross-host-refused";
    if (input.capability === "unsupported") return "native-capability-unsupported";
    if (input.capability === "unknown") return "native-capability-unknown";
    return null;
  };
  const failure = requirementFailure();

  if (input.rollout === "off" || input.rollout === "draining") {
    if (input.preference === "native") {
      return {
        status: "refused",
        route: null,
        nativeCandidate,
        reason: input.rollout === "off" ? "rollout-off" : "rollout-draining",
      };
    }
    return {
      status: "deliver",
      route: "hachi",
      nativeCandidate: failure === null ? nativeCandidate : null,
      reason: input.rollout === "off" ? "rollout-off" : "rollout-draining",
    };
  }

  if (input.rollout === "observe") {
    if (input.preference === "native") {
      return { status: "refused", route: null, nativeCandidate, reason: failure ?? "observe-only" };
    }
    return {
      status: "deliver",
      route: "hachi",
      nativeCandidate: failure === null ? nativeCandidate : null,
      reason: failure ?? "observe-only",
    };
  }

  if (failure !== null) {
    return { status: "refused", route: null, nativeCandidate, reason: failure };
  }

  if (input.rollout === "canary" && input.canaryEligible !== true) {
    if (input.preference === "native") {
      return { status: "refused", route: null, nativeCandidate, reason: "canary-not-selected" };
    }
    return { status: "deliver", route: "hachi", nativeCandidate, reason: "canary-not-selected" };
  }

  return { status: "deliver", route: nativeCandidate, nativeCandidate, reason: "native-selected" };
}

export type NativeSessionBindingKind = "source" | "target";
export type NativeSessionBindingStatus = "active" | "released";
export type NativeTargetRole = "worker" | "reviewer";

/**
 * Core 内部の native delivery host supervisor が使う固定 service identity。
 * service provenance の actorId を呼び出し側の表示名として任意に受けないため、
 * native mutation の service 経路はこの値へ束縛する。
 */
export const NATIVE_SUPERVISOR_SERVICE_ACTOR = "supervisor";

/** provider runtimeが返した再接続可能なexact address。Codexはsocket identityも必須。 */
export type NativeCommunicationAddress =
  | {
      route: "codex-app-server";
      threadId: string;
      activeTurnId: string;
      socketSnapshot: NativeCommunicationSocketSnapshot;
    }
  | { route: "claude-cross-session"; agentRef: string };

/** source/target のexact authorityを一つのread modelとして公開する。kind別の空列はDB CHECKで固定する。 */
export interface NativeSessionBindingRow {
  id: string;
  bindingKey: string;
  kind: NativeSessionBindingKind;
  provider: Provider;
  hostId: string;
  providerSessionId: string;
  /** v20 additive native_address。旧v19 observe bindingは空文字。 */
  nativeAddress: string;
  runtimeVersion: string;
  capabilityHash: string;
  observedAt: number;
  expiresAt: number;
  taskId: string;
  runId: number | null;
  hachiSessionId: string;
  targetRole: NativeTargetRole | "";
  expectedCancelFence: number | null;
  orchestratorId: string;
  orchestratorSessionId: string;
  orchestratorGeneration: number | null;
  status: NativeSessionBindingStatus;
  createdAt: number;
  updatedAt: number;
  releasedAt: number | null;
}

export interface CreateNativeSourceBindingInput {
  bindingKey: string;
  provider: Provider;
  hostId: string;
  providerSessionId: string;
  nativeAddress?: NativeCommunicationAddress | string;
  runtimeVersion: string;
  capabilityHash: string;
  observedAt: number;
  expiresAt: number;
  /** 通信対象task。source authorityとtargetを曖昧に組み替えないため束縛する。 */
  taskId: string;
  provenance: ActorProvenance;
}

export interface CreateNativeTargetBindingInput {
  bindingKey: string;
  provider: Provider;
  hostId: string;
  providerSessionId: string;
  nativeAddress?: NativeCommunicationAddress | string;
  runtimeVersion: string;
  capabilityHash: string;
  observedAt: number;
  expiresAt: number;
  taskId: string;
  runId: number;
  hachiSessionId: string;
  targetRole: NativeTargetRole;
  expectedCancelFence: number;
}

export type CommunicationDeliveryAttemptStatus =
  | "recorded"
  | "claimed"
  | "dispatching"
  | "transport_accepted"
  | "session_observed"
  | "acknowledged"
  | "uncertain"
  | "rejected";

export interface CommunicationDeliveryAttemptRow {
  id: string;
  attemptKey: string;
  steerDeliveryId: string;
  sourceBindingId: string | null;
  targetBindingId: string | null;
  preference: CommunicationPreference;
  route: CommunicationRoute | "";
  nativeCandidate: Exclude<CommunicationRoute, "hachi"> | "";
  decisionReason: CommunicationRouteDecisionReason;
  status: CommunicationDeliveryAttemptStatus;
  /** v20で永続化するredact済み配送本文。v0.17 attemptでは空文字。 */
  payload: string;
  /** route選択に使ったtrusted configのsha256。v0.17 attemptでは空文字。 */
  configHash: string;
  /** claim時にcaller値へ依存しないためpromotion時に固定するtrusted config snapshot。 */
  configRollout: CommunicationRolloutState | "";
  configMinimumRuntimeVersion: string;
  configSameHostOnly: boolean | null;
  configCanaryPercent: number | null;
  /** source/target runtime capability snapshotのsha256。v0.17 attemptでは空文字。 */
  capabilityHash: string;
  /** attempt作成時点のsource/target binding snapshot hash。 */
  sourceBindingHash: string;
  targetBindingHash: string;
  claimantOrchestratorId: string;
  claimantSessionId: string;
  claimantGeneration: number | null;
  claimLeaseUntil: number | null;
  /** claim responseで一度だけ返す平文nonce。再読出しではnull。 */
  attemptNonce: string | null;
  dispatchingAt: number | null;
  receiptId: string;
  lastError: string;
  provenance: ActorProvenance;
  createdAt: number;
  updatedAt: number;
  observedAt: number | null;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
}

export interface CreateCommunicationAttemptInput {
  attemptKey: string;
  steerDeliveryId: string;
  preference: CommunicationPreference;
  /** StoreがDB上のsource/targetと再照合して同じdecisionを再計算する。 */
  routing: ResolveCommunicationRouteInput;
  decision: CommunicationRouteDecision;
  actor: string;
  provenance: ActorProvenance;
  /** structured steer本文。Store境界でredactしてv20 payload列へ保存する。 */
  payload?: unknown;
  /** intentの将来拡張を許すが、現時点でnative routeを選ぶ証拠にはしない。 */
  intent?: "steer";
  /** source authorityの明示値。provenanceと一致する場合のみ受理する。 */
  sourcePrincipal?: ActorProvenance;
}

export type NativeCommunicationRoute = Exclude<CommunicationRoute, "hachi">;

export interface NativeCommunicationConfigSnapshot {
  rollout: CommunicationRolloutState;
  minimumRuntimeVersion: string;
  sameHostOnly: true;
  canaryPercent?: number;
}

/**
 * 既存のneutral route intentを、fresh probe済みbindingへ同じattempt行のまま昇格する入力。
 * 新しいattemptを作らず、service provenanceだけがqueued/recorded CASを実行できる。
 */
export interface PromoteCommunicationAttemptToNativeInput {
  attemptId: string;
  sourceBindingId: string;
  targetBindingId: string;
  route: NativeCommunicationRoute;
  configHash: string;
  configSnapshot: NativeCommunicationConfigSnapshot;
  capabilityHash: string;
  sourceBindingHash?: string;
  targetBindingHash?: string;
  nativeCandidate?: NativeCommunicationRoute;
  decisionReason?: string;
  decision?: CommunicationRouteDecision;
  routing?: ResolveCommunicationRouteInput;
  actor?: string;
  provenance: ActorProvenance;
}

export interface ClaimNativeCommunicationAttemptInput {
  attemptId: string;
  configHash: string;
  capabilityHash: string;
  rollout: CommunicationRolloutState;
  minimumRuntimeVersion?: string;
  sameHostOnly?: boolean;
  /** canary rollout時のtrusted割合。task/delivery keyからStoreが再計算する。 */
  canaryPercent?: number;
  canaryEligible?: boolean;
  leaseSeconds?: number;
  now?: number;
  actor?: string;
  provenance: ActorProvenance;
}

export interface BeginNativeCommunicationDispatchInput {
  attemptId: string;
  attemptNonce: string;
  now?: number;
  actor?: string;
  provenance: ActorProvenance;
}

export type NativeCommunicationReceiptOutcome =
  | "transport_accepted"
  | "session_observed"
  | "acknowledged"
  | "rejected"
  | "uncertain";

export interface RecordNativeCommunicationReceiptInput {
  attemptId: string;
  attemptNonce: string;
  outcome: NativeCommunicationReceiptOutcome;
  receiptId?: string;
  observedMessageId?: string;
  detail?: string;
  now?: number;
  actor?: string;
  provenance: ActorProvenance;
}

export interface NativeCommunicationRecoveryResult {
  requeuedClaimed: number;
  uncertainDispatching: number;
}

/**
 * 外部I/O前の recorded native attempt を、fresh probe 済み target binding へ
 * 付け替える入力。旧 target は attempt 行から読み取り、同じ行の snapshot を
 * CAS で更新するため、呼び出し側が旧行を別の値へ差し替えることはできない。
 */
export interface RebindRecordedNativeCommunicationAttemptInput {
  attemptId: string;
  taskId: string;
  runId: number;
  sessionId: string;
  expectedCancelFence: number;
  targetBindingId: string;
  targetBindingHash: string;
  now?: number;
  actor?: string;
  provenance: ActorProvenance;
}

/** types.ts の凍結KanbanStoreを変更しないadditive capability。 */
export interface NativeCommunicationStore {
  createOrGetNativeSourceBinding(input: CreateNativeSourceBindingInput): NativeSessionBindingRow;
  createOrGetNativeTargetBinding(
    input: CreateNativeTargetBindingInput,
    actor: string,
    provenance: ActorProvenance,
  ): NativeSessionBindingRow;
  getNativeSessionBinding(id: string): NativeSessionBindingRow | null;
  listNativeSessionBindings(taskId?: string): NativeSessionBindingRow[];
  createOrGetCommunicationAttempt(input: CreateCommunicationAttemptInput): CommunicationDeliveryAttemptRow;
  getCommunicationAttempt(id: string): CommunicationDeliveryAttemptRow | null;
  listCommunicationAttempts(steerDeliveryId?: string): CommunicationDeliveryAttemptRow[];
  /**
   * 外部I/O前に lease 回収された native attempt の再配送候補を読む。
   * この read は状態を進めず、Supervisor が fresh binding/config を再検証して
   * claim する入口としてのみ使う。
   */
  listNativeCommunicationRedriveCandidates(): CommunicationDeliveryAttemptRow[];
  rebindRecordedNativeCommunicationAttempt(
    input: RebindRecordedNativeCommunicationAttemptInput,
  ): CommunicationDeliveryAttemptRow;
  promoteCommunicationAttemptToNative(
    input: PromoteCommunicationAttemptToNativeInput,
  ): CommunicationDeliveryAttemptRow;
  claimNativeCommunicationAttempt(
    input: ClaimNativeCommunicationAttemptInput,
  ): CommunicationDeliveryAttemptRow;
  beginNativeCommunicationDispatch(
    input: BeginNativeCommunicationDispatchInput,
  ): CommunicationDeliveryAttemptRow;
  recordNativeCommunicationReceipt(
    input: RecordNativeCommunicationReceiptInput,
  ): CommunicationDeliveryAttemptRow;
  recoverNativeCommunicationAttempts(
    now: number,
    actor: string,
    provenance: ActorProvenance,
  ): NativeCommunicationRecoveryResult;
}

/** binding rowの正規化snapshotをhash化する。attempt再検証とadapter testで共有する。 */
export function nativeSessionBindingHash(binding: NativeSessionBindingRow): string {
  const snapshot = {
    id: binding.id,
    bindingKey: binding.bindingKey,
    kind: binding.kind,
    provider: binding.provider,
    hostId: binding.hostId,
    providerSessionId: binding.providerSessionId,
    nativeAddress: binding.nativeAddress,
    runtimeVersion: binding.runtimeVersion,
    capabilityHash: binding.capabilityHash,
    observedAt: binding.observedAt,
    expiresAt: binding.expiresAt,
    taskId: binding.taskId,
    runId: binding.runId,
    hachiSessionId: binding.hachiSessionId,
    targetRole: binding.targetRole,
    expectedCancelFence: binding.expectedCancelFence,
    orchestratorId: binding.orchestratorId,
    orchestratorSessionId: binding.orchestratorSessionId,
    orchestratorGeneration: binding.orchestratorGeneration,
  };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
