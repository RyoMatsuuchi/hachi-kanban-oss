// =============================================================================
// hachi-kanban 共有契約型定義（凍結契約）
// このファイルはオーケストレーターのみが変更できる。仕様の正本は docs/contract.md。
// 実装パッケージはこの型に適合するように書く。契約変更が必要な場合は報告する。
// =============================================================================

// ========== 基本列挙 ==========

/** タスク状態。running は意図的に存在しない（進行中は blocked + in-progress prefix で表現） */
export type TaskStatus =
  | "triage"
  | "todo"
  | "ready"
  | "blocked"
  | "review"
  | "needs-integration"
  | "done"
  | "archived";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "triage",
  "todo",
  "ready",
  "blocked",
  "review",
  "needs-integration",
  "done",
  "archived",
] as const;

/** ワーカーの実行プロバイダ */
export type Provider = "codex" | "claude";

export const PROVIDERS: readonly Provider[] = ["codex", "claude"] as const;

/** task_runs.status */
export type RunStatus = "running" | "done" | "failed" | "released";

/** block_reason の先頭 prefix（既存 G2 monitor 互換のため書式厳守。docs/contract.md §4/§6） */
export const REASON_PREFIXES = [
  "codex-in-progress:",
  "claude-in-progress:",
  "user-decision:",
  "user-feedback:",
  "review-required:",
  "needs-manual:",
  "auto-launch-failed:",
  "worker-question:",
  "user-question:",
] as const;

export type ReasonPrefix = (typeof REASON_PREFIXES)[number];

/** 監査用の構造化操作主体（docs/contract.md §60）。表示 actor/author とは独立する。 */
export type ActorKind = "human" | "orchestrator" | "service" | "unknown";

export const ACTOR_KINDS: readonly ActorKind[] = ["human", "orchestrator", "service", "unknown"] as const;

/**
 * task_events / task_comments に原子的に保存する actor provenance。
 * kind ごとの組合せ不変条件と active orchestrator session 照合は Store が強制する。
 */
export interface ActorProvenance {
  kind: ActorKind;
  actorId: string;
  actorSessionId: string;
  actorGeneration: number | null;
}

// ========== DB 行型（列名は snake_case → プロパティは camelCase） ==========

/** knowledge 面の1レコード（docs/contract.md §47） */
export interface KnowledgeRow {
  id: string;
  title: string;
  body: string;
  source: string;
  /** JSON 配列文字列をパースした形で公開する */
  tags: string[];
  importance: number;
  expiresAt: number | null;
  originPath: string;
  contentHash: string;
  actor: string;
  provenance: ActorProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface TaskRow {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  priority: number;
  tenant: string;
  assignee: string;
  provider: Provider | "";
  profile: string;
  modelOverride: string;
  /** タスク単位の effort 指定（§49.3）。空文字は未指定。非空なら direct 強制 */
  effortOverride: EffortLevel | "";
  /** タスク単位の実行速度指定（§67）。空文字は未指定。 */
  speedOverride: ExecutionSpeed | "";
  /** reviewer 専用 profile override。worker/rework へは伝播しない（§67）。 */
  reviewProfileOverride: string;
  /** reviewer 専用 provider override。worker/rework へは伝播しない（§67）。 */
  reviewProviderOverride: Provider | "";
  /** reviewer 専用 model override。worker/rework へは伝播しない（§67）。 */
  reviewModelOverride: string;
  /** reviewer 専用 effort override。worker/rework へは伝播しない（§67）。 */
  reviewEffortOverride: EffortLevel | "";
  /** reviewer 専用 speed override。worker/rework へは伝播しない（§67）。 */
  reviewSpeedOverride: ExecutionSpeed | "";
  blockReason: string;
  claimLock: string;
  /** ウォッチフラグ（§46）。人間/エージェントが進捗を追う要確認マーク */
  watched: boolean;
  consecutiveFailures: number;
  lastFailureError: string;
  lastHeartbeatAt: number | null;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface CommentRow {
  id: number;
  taskId: string;
  author: string;
  body: string;
  provenance: ActorProvenance;
  createdAt: number;
}

export interface EventRow {
  id: number;
  taskId: string;
  eventType: string;
  actor: string;
  /** JSON 文字列（パース済みが欲しい場合は payloadJson() ヘルパーを core が提供） */
  payload: string;
  provenance: ActorProvenance;
  createdAt: number;
}

export interface RunRow {
  id: number;
  taskId: string;
  provider: Provider;
  sessionId: string;
  status: RunStatus;
  meta: string;
  startedAt: number;
  endedAt: number | null;
}

// ========== durable run cancel（contract §57） ==========

export type RunCancelStatus =
  | "cancel_requested"
  | "cooperative_sent"
  | "acknowledged"
  | "forcing"
  | "stopped"
  | "failed"
  | "expired";

export interface RunCancelRequestRow {
  id: string;
  taskId: string;
  runId: number;
  sessionId: string;
  provider: Provider;
  status: RunCancelStatus;
  requestNonce: string;
  actor: string;
  reason: string;
  orchestratorId: string;
  requesterSessionId: string;
  requesterGeneration: number | null;
  cancelFence: number;
  deadlineAt: number;
  acknowledgedNonce: string;
  capabilitySnapshot: string;
  stopEvidence: string;
  lastError: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export interface CreateRunCancelRequestInput {
  taskId: string;
  runId: number;
  sessionId: string;
  provider: Provider;
  requestNonce: string;
  actor: string;
  reason: string;
  orchestratorId?: string;
  requesterSessionId?: string;
  requesterGeneration?: number;
  deadlineAt: number;
}

export interface TransitionRunCancelRequestInput {
  requestId: string;
  expectedStatus: RunCancelStatus;
  to: RunCancelStatus;
  expectedRunId: number;
  expectedSessionId: string;
  expectedCancelFence: number;
  requestNonce: string;
  actor: string;
  acknowledgedNonce?: string;
  capabilitySnapshot?: Record<string, unknown>;
  stopEvidence?: Record<string, unknown>;
  lastError?: string;
  now?: number;
}

export interface RunMutationGate {
  allowed: boolean;
  cancelRequestId: string | null;
  cancelFence: number | null;
  reason: "not-cancelled" | "cancel-fenced" | "run-session-mismatch";
}

export interface LinkRow {
  id: number;
  parentId: string;
  childId: string;
  linkType: string;
  createdAt: number;
}

// ========== オーケストレータールーティング（contract §55） ==========

export type OrchestratorSessionStatus = "active" | "handoff_pending" | "superseded" | "stale" | "closed";
export type OrchestratorWatchScope = "task" | "subtree" | "worktree" | "project";
export type OrchestratorWatchRole = "primary" | "collaborator" | "observer";
export type OrchestratorRequestStatus =
  | "queued"
  | "delivered"
  | "claimed"
  | "answering"
  | "waiting_human"
  | "resolved"
  | "cancelled";
export type OrchestratorDeliveryStatus = "pending" | "delivered" | "acknowledged" | "dismissed";

export interface OrchestratorRow {
  id: string;
  label: string;
  project: string;
  repoCommonDir: string;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestratorSessionRow {
  id: string;
  orchestratorId: string;
  generation: number;
  provider: Provider | "";
  providerSessionId: string;
  /** undefined/空文字は legacy または未証明であり、manual と同様に native eligibility を持たない。 */
  providerSessionSource?: ProviderSessionSource | "";
  status: OrchestratorSessionStatus;
  heartbeatAt: number;
  handoffTokenHash: string;
  handoffExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ========== オーケストレーター後継起動 authority（contract §70〜§73） ==========

/** provider session ID の authority を得た経路。caller の自己申告は trusted source に含めない。 */
export type ProviderSessionSource = "manual" | "codex-session-start" | "claude-delivery";

export type OrchestratorSuccessorLaunchKind = "handoff" | "takeover";

export type OrchestratorSuccessorLaunchStatus =
  | "armed"
  | "runtime_bound"
  | "attested"
  | "accepting"
  | "succeeded"
  | "stop_pending"
  | "stopped"
  | "uncertain"
  | "rejected"
  | "expired";

/** replacement を止める状態。terminal に見えても uncertain は安全確認前なので含める。 */
export const ORCHESTRATOR_SUCCESSOR_LAUNCH_BLOCKING_STATUSES = [
  "armed",
  "runtime_bound",
  "attested",
  "accepting",
  "stop_pending",
  "uncertain",
] as const satisfies readonly OrchestratorSuccessorLaunchStatus[];

export type OrchestratorSuccessorKillResult = "not-attempted" | "succeeded" | "failed" | "unknown";

/** exact runtime の停止証拠。null は未観測であり false と同様に stopped を許可しない。 */
export interface OrchestratorSuccessorStopEvidence {
  ownerMatched: boolean | null;
  ownerReadbackAt: number | null;
  killResult: OrchestratorSuccessorKillResult;
  tmuxSessionAbsent: boolean | null;
  panePidAbsent: boolean | null;
  processGroupAbsent: boolean | null;
  observedAt: number | null;
}

/**
 * durable successor launch slot の非 secret read model。
 * raw launch nonce、owner nonce、attestation handle、accept/stop fence は公開せず hash だけを保持する。
 */
export interface OrchestratorSuccessorLaunchRow {
  id: string;
  orchestratorId: string;
  kind: OrchestratorSuccessorLaunchKind;
  targetProvider: Provider;
  /** armed/runtime_bound では未確定のため空文字。attested 以後は非空。 */
  providerSessionSource: ProviderSessionSource | "";
  sourceSessionId: string;
  sourceGeneration: number;
  /** arm 時に固定した期待値。runtime readback の観測値で上書きしない。 */
  canonicalCwd: string;
  hostId: string;
  launchNonceHash: string;
  plannedTmuxSession: string;
  tmuxSession: string;
  tmuxPane: string;
  panePid: number | null;
  processGroupId: number | null;
  tmuxSocketPath: string;
  tmuxServerPid: number | null;
  tmuxServerStartTime: number | null;
  tmuxServerLifetimeHash: string;
  ownerNonceHash: string;
  runtimeOwnershipClaimed: boolean;
  runtimeBoundAt: number | null;
  /** runtime readback の観測値。未観測は空文字であり、期待値一致の証拠にしない。 */
  observedCanonicalCwd: string;
  observedHostId: string;
  observedHookDefinitionHash: string;
  observedHookExecutableHash: string;
  hookDefinitionHash: string;
  hookExecutableHash: string;
  providerSessionId: string;
  attestationHandleHash: string;
  attestationIssuedAt: number | null;
  attestationExpiresAt: number | null;
  attestationConsumedAt: number | null;
  handoffTokenFenceHash: string;
  handoffExpiresAt: number | null;
  /** takeover arm 時に固定した stale cutoff。handoff では null。 */
  takeoverStaleBefore: number | null;
  cancelFence: number;
  acceptFenceHash: string;
  stopFenceHash: string;
  revision: number;
  barrierReleaseAuthorizedAt: number | null;
  runtimeDeadlineAt: number;
  attestationDeadlineAt: number;
  killOwnerReadbackHash: string;
  stopEvidence: OrchestratorSuccessorStopEvidence;
  successorSessionId: string;
  successorGeneration: number | null;
  status: OrchestratorSuccessorLaunchStatus;
  lastError: string;
  createdAt: number;
  updatedAt: number;
  terminalAt: number | null;
}

export interface ArmOrchestratorSuccessorLaunchCommonInput {
  orchestratorId: string;
  targetProvider: Provider;
  sourceSessionId: string;
  sourceGeneration: number;
  canonicalCwd: string;
  hostId: string;
  launchNonceHash: string;
  plannedTmuxSession: string;
  hookDefinitionHash: string;
  hookExecutableHash: string;
  runtimeDeadlineAt: number;
  attestationDeadlineAt: number;
  now?: number;
}

export type ArmOrchestratorSuccessorLaunchInput = ArmOrchestratorSuccessorLaunchCommonInput & (
  | {
      kind: "handoff";
      handoffTokenFenceHash: string;
      handoffExpiresAt: number;
    }
  | {
      kind: "takeover";
      /** arm transaction と final transaction で同じ stale predicate を再検証する。 */
      staleBefore: number;
    }
);

export interface BindOrchestratorSuccessorRuntimeInput {
  slotId: string;
  expectedRevision: number;
  observedCanonicalCwd: string;
  observedHostId: string;
  tmuxSession: string;
  tmuxPane: string;
  panePid: number;
  processGroupId: number;
  tmuxSocketPath: string;
  tmuxServerPid: number;
  tmuxServerStartTime: number;
  tmuxServerLifetimeHash: string;
  ownerNonceHash: string;
  hookDefinitionHash: string;
  hookExecutableHash: string;
  now?: number;
}

export interface ResolveUnboundOrchestratorSuccessorLaunchInput {
  slotId: string;
  expectedRevision: number;
  to: "rejected" | "expired";
  error: string;
  now?: number;
}

/**
 * process 作成後に得られた runtime 証拠。readback 失敗時も観測済みの値だけを失わず保存する。
 * null は未観測であり、owner 一致や停止完了の証拠へ昇格させない。
 */
export interface PartialOrchestratorSuccessorRuntimeEvidence {
  observedCanonicalCwd: string | null;
  observedHostId: string | null;
  tmuxSession: string | null;
  tmuxPane: string | null;
  panePid: number | null;
  processGroupId: number | null;
  tmuxSocketPath: string | null;
  tmuxServerPid: number | null;
  tmuxServerStartTime: number | null;
  tmuxServerLifetimeHash: string | null;
  ownerNonceHash: string | null;
  observedHookDefinitionHash: string | null;
  observedHookExecutableHash: string | null;
}

/**
 * tmux 作成後・runtime bind 前の失敗を partial runtime evidence とともに durable 化する。
 * barrier release は許可せず、armed から直接 stop_pending へ遷移する。
 */
export interface MarkArmedOrchestratorSuccessorStopPendingInput
  extends PartialOrchestratorSuccessorRuntimeEvidence {
  slotId: string;
  expectedRevision: number;
  error: string;
  now?: number;
}

export type CodexSessionStartSource = "startup" | "resume" | "compact" | "clear";

export interface OrchestratorSuccessorRuntimeIdentity {
  providerSessionId: string;
  canonicalCwd: string;
  hostId: string;
  tmuxSession: string;
  tmuxPane: string;
  panePid: number;
  processGroupId: number;
  tmuxSocketPath: string;
  tmuxServerPid: number;
  tmuxServerStartTime: number;
  tmuxServerLifetimeHash: string;
  ownerNonceHash: string;
  hookDefinitionHash: string;
  hookExecutableHash: string;
  now?: number;
}

export type AttestOrchestratorSuccessorLaunchInput = OrchestratorSuccessorRuntimeIdentity & (
  | {
      providerSessionSource: "codex-session-start";
      source: CodexSessionStartSource;
    }
  | {
      providerSessionSource: "claude-delivery";
      source: "delivery";
    }
);

export interface AttestOrchestratorSuccessorLaunchResult {
  launch: OrchestratorSuccessorLaunchRow;
  /** owner-only の短命 capability。read view、JSON、log へ保存・転記しない。 */
  attestationHandle: string;
}

export interface ClaimOrchestratorSuccessorAcceptInput {
  slotId: string;
  expectedRevision: number;
  attestationHandleHash: string;
  operation: OrchestratorSuccessorLaunchKind;
  now?: number;
}

export interface ClaimOrchestratorSuccessorAcceptResult {
  launch: OrchestratorSuccessorLaunchRow;
  /** final transaction 専用 capability。read view、JSON、log へ保存・転記しない。 */
  acceptFence: string;
}

export interface FinalizeOrchestratorSuccessorHandoffInput {
  slotId: string;
  expectedRevision: number;
  acceptFenceHash: string;
  attestationHandleHash: string;
  handoffTokenHash: string;
  now?: number;
}

export interface FinalizeOrchestratorSuccessorTakeoverInput {
  slotId: string;
  expectedRevision: number;
  acceptFenceHash: string;
  attestationHandleHash: string;
  now?: number;
}

export interface MarkOrchestratorSuccessorStopPendingInput {
  slotId: string;
  expectedRevision: number;
  expectedStatus: "runtime_bound" | "attested" | "accepting" | "stop_pending" | "uncertain";
  error: string;
  replacementHandoffTokenHash?: string;
  now?: number;
}

export interface MarkOrchestratorSuccessorStopPendingResult {
  launch: OrchestratorSuccessorLaunchRow;
  /** exact rollback 専用 capability。read view、JSON、log へ保存・転記しない。 */
  stopFence: string;
}

export interface RecordOrchestratorSuccessorStopInput {
  slotId: string;
  expectedRevision: number;
  stopFenceHash: string;
  killOwnerReadbackHash: string;
  evidence: OrchestratorSuccessorStopEvidence;
  now?: number;
}

export interface RollbackCompleteOrchestratorSuccessorLaunchInput {
  slotId: string;
  expectedRevision: number;
  stopFenceHash: string;
  evidence: OrchestratorSuccessorStopEvidence;
  apply: boolean;
  now?: number;
}

export interface RollbackCompleteOrchestratorSuccessorLaunchResult {
  launch: OrchestratorSuccessorLaunchRow;
  applicable: boolean;
  applied: boolean;
  reason: "complete-stop-evidence" | "incomplete-stop-evidence" | "fence-mismatch" | "state-mismatch";
}

export interface OrchestratorSuccessorReplacementGate {
  allowed: boolean;
  blockingSlotId: string | null;
  reason: "no-blocking-slot" | "blocking-slot-present";
}

/**
 * 後継起動用の狭い capability interface。
 * 既存 KanbanStore へ未実装 method を混ぜず、Task 1 で SqliteKanbanStore がこの面を同時実装する。
 */
export interface OrchestratorSuccessorLaunchStore {
  armSuccessorLaunch(input: ArmOrchestratorSuccessorLaunchInput): OrchestratorSuccessorLaunchRow;
  getSuccessorLaunch(id: string): OrchestratorSuccessorLaunchRow | null;
  listSuccessorLaunches(orchestratorId?: string): OrchestratorSuccessorLaunchRow[];
  successorReplacementGate(orchestratorId: string, excludeSlotId?: string): OrchestratorSuccessorReplacementGate;
  resolveUnboundSuccessorLaunch(
    input: ResolveUnboundOrchestratorSuccessorLaunchInput,
  ): OrchestratorSuccessorLaunchRow;
  markArmedSuccessorLaunchStopPending(
    input: MarkArmedOrchestratorSuccessorStopPendingInput,
  ): MarkOrchestratorSuccessorStopPendingResult;
  bindSuccessorLaunchRuntime(input: BindOrchestratorSuccessorRuntimeInput): OrchestratorSuccessorLaunchRow;
  attestSuccessorLaunch(
    input: AttestOrchestratorSuccessorLaunchInput,
  ): AttestOrchestratorSuccessorLaunchResult | null;
  claimSuccessorLaunchAccept(
    input: ClaimOrchestratorSuccessorAcceptInput,
  ): ClaimOrchestratorSuccessorAcceptResult;
  acceptOrchestratorHandoffWithSuccessorLaunch(
    input: FinalizeOrchestratorSuccessorHandoffInput,
  ): OrchestratorSessionRow;
  takeoverStaleOrchestratorSessionWithSuccessorLaunch(
    input: FinalizeOrchestratorSuccessorTakeoverInput,
  ): OrchestratorSessionRow;
  markSuccessorLaunchStopPending(
    input: MarkOrchestratorSuccessorStopPendingInput,
  ): MarkOrchestratorSuccessorStopPendingResult;
  recordSuccessorLaunchStop(input: RecordOrchestratorSuccessorStopInput): OrchestratorSuccessorLaunchRow;
  rollbackCompleteSuccessorLaunch(
    input: RollbackCompleteOrchestratorSuccessorLaunchInput,
  ): RollbackCompleteOrchestratorSuccessorLaunchResult;
}

export type OrchestratorLivenessIncidentStatus = "pending" | "sent" | "exhausted";

/** heartbeat の stale gap を session 更新・stale 化より先に固定する durable incident。 */
export interface OrchestratorLivenessIncidentRow {
  id: number;
  sessionId: string;
  orchestratorId: string;
  generation: number;
  provider: Provider | "";
  providerSessionId: string;
  gapSeconds: number;
  detectedAt: number;
  status: OrchestratorLivenessIncidentStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
  sentAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestratorWatchRow {
  id: string;
  orchestratorId: string;
  scope: OrchestratorWatchScope;
  selector: string;
  role: OrchestratorWatchRole;
  priority: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TaskOrchestratorBindingRow {
  taskId: string;
  orchestratorId: string;
  role: OrchestratorWatchRole;
  createdAt: number;
  releasedAt: number | null;
}

export interface OrchestratorRequestRow {
  id: string;
  taskId: string;
  questionId: string;
  kind: string;
  status: OrchestratorRequestStatus;
  question: string;
  context: string;
  worktree: string;
  project: string;
  claimantSessionId: string;
  claimantGeneration: number | null;
  claimToken: string;
  leaseUntil: number | null;
  answerKey: string;
  escalationGeneration: number;
  humanAnswer: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export interface OrchestratorDeliveryRow {
  id: number;
  requestId: string;
  orchestratorId: string;
  watchId: string | null;
  status: OrchestratorDeliveryStatus;
  createdAt: number;
  updatedAt: number;
}

export interface NotificationOutboxRow {
  id: number;
  taskId: string;
  requestId: string;
  dedupeKey: string;
  kind: "orchestrator_fyi" | "human_question" | "orchestrator_unavailable";
  transport: string;
  payload: string;
  /** 送信済み（または設定により意図的skip済み）の transport 名 */
  sentTransports: string[];
  status: "pending" | "sent" | "failed";
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
}

/** half-open outbox の stage（契約 §40.1.1）。claim を獲得した処理段ごとに配送予定を分ける */
export type HalfOpenOutboxStage = "steward" | "brief";

/** half-open outbox 行の状態（契約 §40.1.1）。discarded は旧 claim 世代の行を配送せず閉じたもの */
export type HalfOpenOutboxStatus = "pending" | "sent" | "failed" | "discarded";

/**
 * half-open claim の outbox 行（契約 §40.1.1）。
 * 共有 state lock 外でネットワーク配送するための durable な配送予定。
 * payload は OperationalNotifyInput 相当の JSON を自己完結で保持し、claimGeneration で
 * 旧世代の配送予定を fence する。
 */
export interface HalfOpenOutboxRow {
  id: string;
  stage: HalfOpenOutboxStage;
  /** 配送予定を書いた claimant の claim 世代（> 0）。旧世代は discardStaleHalfOpenOutbox で discarded になる */
  claimGeneration: number;
  dedupeKey: string;
  kind: string;
  /** OperationalNotifyInput 相当の JSON 文字列 */
  payload: string;
  /** 送信済み（または設定により意図的 skip 済み）の transport 名 */
  sentTransports: string[];
  status: HalfOpenOutboxStatus;
  attempts: number;
  /** 次回試行可能時刻（epoch 秒）。null は即時配送可 */
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** enqueueHalfOpenOutbox の結果。dedupe_key 衝突時は duplicate として既存行を返す */
export type HalfOpenOutboxEnqueueResult =
  | { outcome: "created"; row: HalfOpenOutboxRow }
  | { outcome: "duplicate"; row: HalfOpenOutboxRow };

export interface CreateOrchestratorRequestInput {
  taskId: string;
  questionId: string;
  question: string;
  context?: string;
  worktree?: string;
  project?: string;
}

export interface OrchestratorRoutingReconcileResult {
  requestId: string;
  addedDeliveries: number;
  cancelled: boolean;
}

// ========== steward 提案の orchestrator inbox ルーティング（contract §69） ==========

/** steward が出せる提案種別（contract §40.3 / §69.1）。 */
export type StewardProposalKind = "promote" | "archive" | "spec-lint" | "escalate";

export const STEWARD_PROPOSAL_KINDS: readonly StewardProposalKind[] = [
  "promote",
  "archive",
  "spec-lint",
  "escalate",
];

/** 提案 request の lifecycle（contract §69.2）。terminal は accepted 以降の 5 種。 */
export type StewardProposalStatus =
  | "queued"
  | "delivered"
  | "claimed"
  | "accepted"
  | "dismissed"
  | "deferred"
  | "superseded"
  | "cancelled";

/** 配送 status。orchestrator_deliveries と同形（contract §69.1）。 */
export type StewardProposalDeliveryStatus = "pending" | "delivered" | "acknowledged" | "dismissed";

export interface StewardProposalRequestRow {
  id: string;
  taskId: string;
  kind: StewardProposalKind;
  reason: string;
  /** contract §69.3.1。tenant 既定で宛先が決まった request だけ非 null。 */
  routedBy: "tenant-default" | null;
  status: StewardProposalStatus;
  claimantSessionId: string;
  claimantGeneration: number | null;
  claimTokenHash: string;
  claimLeaseUntil: number | null;
  /** deferred のときだけ非 null。この時刻まで同一 (kind, taskId) を再提案しない */
  deferUntil: number | null;
  /** §69.4 のバックオフ窓判定に使う唯一の時刻。updated_at は窓判定に使わない */
  dismissedAt: number | null;
  /** (kind, taskId) ごとの却下累計。窓幅の決定に使う */
  dismissCount: number;
  /** accept 時点の task status。以後 status が変わるまで再提案を抑止する（§69.4-4） */
  acceptedTaskStatus: string;
  /** dismiss / defer / supersede / cancel の理由。dismiss では必須 */
  resolutionReason: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export interface StewardProposalDeliveryRow {
  id: number;
  requestId: string;
  orchestratorId: string;
  watchId: string | null;
  status: StewardProposalDeliveryStatus;
  createdAt: number;
  updatedAt: number;
}

/** §69.4 の抑止理由。判定順もこの並びと一致させる */
export type StewardProposalSuppressReason =
  | "active_request"
  | "deferred"
  | "dismiss_backoff"
  | "accepted";

/**
 * 提案発行の結果（contract §69.3 / §69.4）。
 * - `created`: request + 全宛先の delivery を作った
 * - `suppressed`: 再提案抑止に当たったので request を作っていない
 * - `unrouted`: 配送先 0 件なので request を作らず、呼び出し側は従来のコメント/§38 通知へフォールスルーする
 */
export type StewardProposalCreateResult =
  | { outcome: "created"; request: StewardProposalRequestRow; targetCount: number }
  | {
      outcome: "suppressed";
      suppressedBy: StewardProposalSuppressReason;
      /** 再提案が可能になる時刻。active_request / accepted のように時刻で解けないものは null */
      suppressedUntil: number | null;
      blockingRequestId: string;
    }
  | { outcome: "unrouted" };

/** doctor 表示用の提案面サマリ（contract §69.7）。 */
export interface StewardProposalHealth {
  /** 未終端（queued|delivered|claimed）の提案件数 */
  pendingCount: number;
  oldestPendingCreatedAt: number | null;
  /** 最古の未終端提案の滞留秒数。未終端が無ければ 0 */
  oldestPendingAgeSeconds: number;
  /** 配送先ゼロでフォールスルーした件数。NG ではなく情報として扱う */
  unroutedCount: number;
}

/** cadence 種別（contract §29.1） */
export type ScheduleCadence = "daily" | "weekly" | "monthly" | "once";

/** スケジュール定義（contract §29.1） */
export interface ScheduleRow {
  id: string;
  name: string;
  enabled: boolean;
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
  lastRunAt: number | null;
  lastTaskId: string | null;
  consecutiveFailures: number;
  autoDisabledReason: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * スケジュール作成フォームの入力候補（contract §29.5）。
 * 過去に使われた値の distinct を返す（profiles は config 由来のため含めない — API 層で合成する）。
 */
export interface ScheduleFormOptions {
  /** schedules.cwd ∪ task body 先頭の `cwd: <絶対パス>` 行の distinct（新しく使われた順） */
  cwds: string[];
  /** tasks.tenant ∪ schedules.tenant の distinct（昇順・空文字除外） */
  tenants: string[];
}

/** スケジュール作成入力（id/監査列はストアが補完） */
export interface ScheduleCreateInput {
  name: string;
  cadenceKind: ScheduleCadence;
  atMinute: number;
  atHour: number;
  weekday?: number | null;
  dayOfMonth?: number | null;
  runDate?: string | null;
  tenant?: string;
  profile?: string;
  cwd: string;
  prompt: string;
  priority?: number;
}

// ========== 設定・環境 ==========

/**
 * reasoning effort の共通語彙（contract §35.1）。
 * provider/model/runtime ごとの実対応は ModelTransportPolicy と起動前 capability 判定で
 * fail-closed に検証する。語彙に含まれること自体は対応証拠ではない。
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** worker/reviewer の処理速度要求。配送済みと実効速度は別に記録する（§67）。 */
export type ExecutionSpeed = "standard" | "fast";

/** task 上で独立して解決する実行role。reworkは worker を使う。 */
export type ExecutionRole = "worker" | "reviewer";

/** task 単位overrideを一つのtransactionで変更するためのpatch。undefinedは維持、空文字はclear。 */
export interface ExecutionOverridePatch {
  profile?: string;
  provider?: Provider | "";
  model?: string;
  effort?: EffortLevel | "";
  speed?: ExecutionSpeed | "";
}

export interface ProfileEntry {
  provider: Provider;
  model: string;
  /** 実行トランスポート（既定 "bridge"。contract §17.1、§22.1 で codex 限定を撤廃済み） */
  transport?: "bridge" | "direct";
  /** reasoning effort（省略時は各 CLI の既定に任せる = 何も渡さない。contract §35.2） */
  effort?: EffortLevel;
  /** 処理速度（省略時はruntime既定。明示値は配送保証の対象。contract §67） */
  speed?: ExecutionSpeed;
}

/** 実行トランスポート種別 */
export type Transport = "bridge" | "direct";

export interface ResourceGuardConfig {
  /** 進行中（in-progress blocked）の上限 */
  maxInFlight: number;
  /** 1 tick あたりの新規起動上限 */
  maxLaunchesPerTick: number;
  /**
   * 1 run の最大実行秒数（省略時 7200。contract §34.3）。
   * 超過を monitor が検知し、direct は強制停止、bridge は needs-manual 退避で inFlight 枠を解放する。
   */
  maxRunSeconds?: number;
}

/**
 * direct transport の stall 判定閾値（contract §50.2）。provider ごとに上書きでき、
 * 省略した項目は supervisor 側の provider 別既定を使う。
 */
export interface DirectStallProviderConfig {
  /** `.out` の無成長がこの秒数続き、かつプロセスツリーが不在なら停止扱いにする */
  outputStallSeconds?: number;
  /** プロセスが生存していてもこの秒数を超えた run は stall 扱いにする */
  maxRuntimeSeconds?: number;
}

export interface DirectConfig {
  stall?: Partial<Record<Provider, DirectStallProviderConfig>>;
}

export interface HachiConfig {
  profiles: Record<string, ProfileEntry>;
  allowlist: Record<Provider, string[]>;
  /** catalog非広告runtime向けの、設定由来trusted互換policy。 */
  modelTransportPolicies?: ModelTransportPolicy[];
  /** provider純正session間通信の段階的rollout。未指定は全provider off。 */
  communication?: Partial<Record<Provider, CommunicationProviderConfig>>;
  resourceGuard: ResourceGuardConfig;
  defaultProfile: string;
  /** direct transport の stall 判定閾値。未指定は supervisor 既定。 */
  direct?: DirectConfig;
  /** オーケストレーター自己計測の閾値上書き。未指定は playbook §0.7 の既定。 */
  orchestrator?: OrchestratorConfig;
}

/** 1軸の閾値上書き。指定した段階だけを既定へ重ねる（additive）。 */
export interface SessionBudgetThresholdOverride {
  notice?: number;
  recommend?: number;
  urgent?: number;
}

/** 損益分岐ターン数 N を求める cost model の部分上書き。 */
export interface SessionBudgetCostModelOverride {
  /** 起動直後の文脈フロア（トークン）。契約 §77.5: 実測（session_boot_samples）が無い時だけ使う */
  c0?: number;
  /** 起動の実効コスト（USD）。契約 §77.5 で非推奨（設定されていれば S を上書きするが sSource: config-legacy） */
  s?: number;
  /** 係数テーブル（§77.4）で measured と見なす三つ組あたりの最小 turn 数。既定 30。正の整数 */
  minTurns?: number;
  /** usage-profile refresh が読む直近 session 数。既定 50。正の整数 */
  profileSessions?: number;
  /**
   * 起動直後の prefix 再書き込み額（USD）。契約 §77.5: 立ち上げ標本（session_boot_samples）の中央値が
   * 無い時だけ使う既定。既定 0.40（knowledge k_a705c5514d6d の実測 $0.377〜0.483）。推測値へ更新しない
   */
  bootOverheadUsd?: number;
  /** C₀ / bootOverhead の中央値を取る直近世代数 K。契約 §77.5。既定 5。正の整数 */
  generations?: number;
  /** R（残作業見込み）の 1 タスクあたり turn 数。契約 §77.5 / §77.9: 実測が揃うまで config のみ。既定 8。正の整数 */
  turnsPerTask?: number;
  /**
   * prompt cache の TTL（秒）。契約 §77.10: 観測できないので config で与える。既定 3600（Claude の既定 1h）。
   * idle がこれを超えると次の 1 turn で文脈全体が write 単価で書き直される（idleRewriteUsd）。正の整数
   */
  cacheTtlSeconds?: number;
}

/**
 * 契約 §77.4 の係数テーブル 1 行。key は (provider, model, effort)。
 * effort null は「その turn で effort を観測できなかった」を 1 つの三つ組として扱う（既定値で埋めない）。
 * perTurn 系は標本の平均、contextGrowthPerTurn は連続 turn の差分の中央値（負＝compaction は除外）。
 * 手書きの係数を入れてはならない（計算元は turnSeries@v1。computedFromRef に記す）。
 */
export interface SessionUsageProfileRow {
  provider: Provider;
  model: string;
  effort: EffortLevel | null;
  /** 標本 turn 数 */
  turns: number;
  /** turns ≥ minTurns。false の三つ組の係数で推奨を出してはならない（§77.4） */
  measured: boolean;
  cacheReadPerTurn: number;
  cacheWrite5mPerTurn: number;
  cacheWrite1hPerTurn: number;
  outputPerTurn: number;
  /** outputPerTurn の内数。thinking/reasoning を観測できない provider は null */
  reasoningPerTurn: number | null;
  /** 標本が 2 turn 未満で差分を取れない場合は null */
  contextGrowthPerTurn: number | null;
  /** 直近 N 件（既定 20）の provider session id。新しい順 */
  sourceSessionIds: string[];
  /** 計算元の系列とアルゴリズム版（例: turnSeries@v1） */
  computedFromRef: string;
  updatedAt: number;
}

/**
 * 契約 §77.9 の立ち上げ標本 1 行。key は (orchestratorId, sessionId)。
 * C₀ = 直近 K 世代の contextAtTurn15 の中央値、bootOverheadUsd = 起動直後の prefix 再書き込み額の実測。
 * 条件を満たさない標本は null で保存し、既定値で埋めない。
 */
export interface SessionBootSampleRow {
  orchestratorId: string;
  /** board 側 session id（os_*） */
  sessionId: string;
  providerSessionId: string;
  provider: Provider;
  /** 15 turn 目の contextModel。観測できなければ null */
  model: string | null;
  /** main-chain 15 turn 目の contextTokens。15 turn 未満は null */
  contextAtTurn15: number | null;
  /** turn2 が cacheRead=0 のとき turn2 cacheCreation × (p_write1h − p_read)。条件外は null */
  bootOverheadUsd: number | null;
  /** 計算元（例: turnSeries@v1）と単価解決の出所 */
  provenance: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 軸が判定に入らなかった理由。閉じた union（ここが唯一の宣言）。
 * 「値が無い」には2種類あり、区別しないと運用が壊れる:
 *   - missing        : 測る手段が無い。判定が抜けている＝知らせるべき欠測
 *   - not-applicable : 測った結果その軸に意味が無い。良性であり警告してはならない
 * 分類の正本は orchestrator-session-budget.ts の
 * SESSION_BUDGET_AXIS_UNMEASURED_REASON_KIND。
 */
export type SessionBudgetAxisUnmeasuredReason =
  /** context window のサイズが観測（rollout ログ）でも設定でも得られない。missing。 */
  | "context-window-unknown"
  /** 現在の文脈が cost model のフロア C0 以下で、損益分岐点が存在しない。not-applicable。 */
  | "cost-model-floor-not-exceeded"
  /**
   * 使用モデルが価格表に無く、コストを算出できない。missing。
   * 価格表へモデルを追加すれば測れるようになるので「自分で直せる欠測」であり、
   * not-applicable（測った結果その軸に意味が無い）ではない。
   */
  | "cost-model-unpriced"
  /**
   * Codex の台帳が ChatGPT サインイン（credits）で、config `orchestrator.pricing.codexCreditUsdRate` が無く
   * USD へ換算できない。missing（換算率を設定すれば測れる「自分で直せる欠測」。契約 §77.3）。
   * 換算率を推測して埋めてはならない。
   */
  | "codex-credit-ledger-unpriced";

/** SessionBudgetAxisUnmeasuredReason の分類。 */
export type SessionBudgetAxisUnmeasuredKind = "missing" | "not-applicable";

/**
 * オーケストレーター自己計測の閾値上書き（playbook §0.7 2026-08-22 改訂の4軸）。
 * キー名は判定側の軸名（orchestrator-session-budget.ts の SESSION_BUDGET_AXES）と一致させる。
 * 旧3軸（cumulativeInputTokens / contextTokens）は誤った量を測っていたため互換を持たない。
 */
export interface OrchestratorSessionBudgetConfig {
  turns?: SessionBudgetThresholdOverride;
  contextSaturation?: SessionBudgetThresholdOverride;
  handoffValue?: SessionBudgetThresholdOverride;
  effectiveCostUsd?: SessionBudgetThresholdOverride;
  costModel?: SessionBudgetCostModelOverride;
  /**
   * contextSaturation の分母。正の整数のみ受理する。
   * claude の transcript には context window のサイズが無いため、設定で与えられるようにする。
   * **adapters が観測できた場合は観測値を優先する**（codex の挙動を変えない）。
   * モデル名から窓サイズを推測するテーブルは作らない（モデル更改のたびに腐るため）。
   */
  contextWindowTokens?: number;
  /**
   * supervisor stage session-budget-monitor の周期（契約 §77.7）。intervalMinutes 既定 15。正の整数。
   * 軸ではない（orchestrator-session-budget.ts の ConfigAxisKeys から除外する）。
   */
  monitor?: SessionBudgetMonitorConfig;
  /**
   * 自動引き継ぎ（契約 §77.8）。既定 propose（通知まで）。apply は規定のみで実装は別起票 —
   * 実装が無い間に apply を設定しても stage は warn を出して propose 扱いにし、handover を起動しない。
   * 軸ではない（同上）。
   */
  autoHandover?: SessionBudgetAutoHandoverMode;
}

/** 契約 §77.7 の monitor 周期。 */
export interface SessionBudgetMonitorConfig {
  /** 評価間隔（分）。既定 15。正の整数 */
  intervalMinutes?: number;
  /**
   * 契約 §77.10: idle 秒数が cacheTtlSeconds × この比率以上（かつ TTL 未満）で handoff-before-idle を通知する。
   * 既定 0.5。0 より大きく 1 未満
   */
  idleWarnRatio?: number;
}

/** 契約 §77.8 の自動引き継ぎモード。 */
export type SessionBudgetAutoHandoverMode = "off" | "propose" | "apply";

/** 未設定時の autoHandover。通知まで行い、handover は起動しない */
export const DEFAULT_SESSION_BUDGET_AUTO_HANDOVER: SessionBudgetAutoHandoverMode = "propose";

export type CodexSuccessorAttestationMode = "manual" | "enforce";

/** 未設定時も manual と解釈し、host publication 前に enforce へ上げない。 */
export const DEFAULT_CODEX_SUCCESSOR_ATTESTATION_MODE: CodexSuccessorAttestationMode = "manual";

export interface CodexSuccessorAttestationConfig {
  mode: CodexSuccessorAttestationMode;
}

/**
 * 価格表の個別上書き（契約 §77.3）。usage-pricing.ts の ModelPrice と同じ 5 単価（USD / token）に
 * 出所 `source` を必須で添える。cache 系の null は ModelPrice と同じ意味（その系統の単価が存在しない）。
 * types.ts は usage-pricing.ts を import しないため、ここでは 5 項目を展開して宣言する。
 */
export interface ModelPriceOverride {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheCreationCostPerToken: number | null;
  cacheCreation1hCostPerToken: number | null;
  cacheReadCostPerToken: number | null;
  /** 単価の出所（公式価格ページの URL や「公式価格表 2026-09-02」等）。推測値を置かないための必須項目 */
  source: string;
}

/** Codex credits 台帳の 1M トークンあたり credits（契約 §77.3）。USD 換算率とは独立に持つ */
export interface CodexCreditsPerMTok {
  input: number;
  cached: number;
  output: number;
  /** credits 単価の出所。必須 */
  source: string;
}

/** 契約 §77.3 の単価解決に対する config 上書き。 */
export interface OrchestratorPricingConfig {
  /** modelId → 上書き単価。価格表より優先し、priceSource: override として表示する */
  overrides?: Record<string, ModelPriceOverride>;
  /** 1 credit あたり USD。無ければ ChatGPT サインインの Codex 分は unmeasured（codex-credit-ledger-unpriced） */
  codexCreditUsdRate?: number;
  /** modelId → credits per 1M。あれば effectiveCostCredits の表示に使う */
  codexCredits?: Record<string, CodexCreditsPerMTok>;
}

export interface OrchestratorConfig {
  sessionBudget?: OrchestratorSessionBudgetConfig;
  /** Codex provider session ID の受理経路。省略時は manual。contract §73。 */
  codexSuccessorAttestation?: CodexSuccessorAttestationConfig;
  /** 単価の上書きと Codex credits 台帳（契約 §77.3） */
  pricing?: OrchestratorPricingConfig;
}

export interface ModelTransportPolicy {
  id: string;
  provider: Provider;
  model: string;
  transport: Transport;
  minimumRuntimeVersion: string;
  /** このmodel/runtime/transportで明示確認済みのeffort。欠落はunknownとして扱う。 */
  supportedEfforts?: EffortLevel[];
  /** このmodel/runtime/transportで明示確認済みの速度。欠落はunknownとして扱う。 */
  supportedSpeeds?: ExecutionSpeed[];
}

export type CommunicationRolloutState = "off" | "observe" | "canary" | "on" | "draining";
export type CommunicationRoute = "hachi" | "claude-cross-session" | "codex-app-server";
export type CommunicationPreference = "auto" | "hachi" | "native";

export interface CommunicationProviderConfig {
  rollout: CommunicationRolloutState;
  minimumRuntimeVersion?: string;
  /** v1 native routeは同一hostだけを許可する。falseは将来用でありnativeを有効化しない。 */
  sameHostOnly?: boolean;
  /** native attempt のclaim lease。未指定時はSupervisor既定を使う。 */
  claimLeaseSeconds?: number;
  /** runtimeから観測したexact bindingの有効期間。未指定時はSupervisor既定を使う。 */
  bindingTtlSeconds?: number;
  /** rollout=canaryでnative対象にする決定論的割合（1..100）。 */
  canaryPercent?: number;
}

export interface BridgeConfig {
  /** 例: http://127.0.0.1:3456 */
  url: string;
  /** Bearer token を格納したファイルの絶対パス。token の生値を設定に置かない */
  tokenFile: string;
}

export interface Environment {
  /** HACHI_KANBAN_HOME（既定 ~/.hachi-kanban） */
  home: string;
  /** ボード名（既定 dev） */
  board: string;
  /** $home/boards/$board/kanban.db */
  dbPath: string;
  /** $home/artifacts */
  artifactsDir: string;
  bridges: Record<Provider, BridgeConfig>;
}

// ========== ロガー ==========

/** 構造化 JSONL ロガー。console.log 直書き禁止（CLI の表示出力を除く） */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** 固定フィールドを付与した子ロガー */
  child(fields: Record<string, unknown>): Logger;
}

// ========== モデル解決 ==========

/** モデル/プロバイダ解決の結果（fail-closed: 不正は ok=false で返し呼び出し側が block する） */
export type ModelResolution =
  | {
      ok: true;
      provider: Provider;
      model: string;
      source: "override" | "profile" | "default";
      /** profile 由来の実行トランスポート（既定 "bridge"。contract §17.3） */
      transport: Transport;
      /** profile 由来の reasoning effort（未指定 profile では省略。contract §35.2） */
      effort?: EffortLevel;
      /** profile/override由来の処理速度。未指定ならruntime既定へ委譲。 */
      speed?: ExecutionSpeed;
    }
  | {
      ok: false;
      reason:
        | "invalid-model-charset"
        | "model-not-allowlisted"
        | "unknown-profile"
        | "unknown-provider";
      /** 人間向け説明。モデル名の生値は含めてよい（charset 検査済みの場合のみ） */
      detail: string;
    };

// ========== WorkerAdapter（docs/contract.md §9） ==========

/** bridge がモデル指定を運べたか。運べない場合は 'none' を記録し無視を隠さない */
export type ModelDelivery = "native" | "none";

/** effort 指定を実配信できたか（modelDelivery と同型の「無視を隠さない」原則。contract §35.3） */
export type EffortDelivery = "native" | "none";

/** speed 指定をruntimeへ配送できたか。実際の各request速度を証明する値ではない。 */
export type SpeedDelivery = "native" | "none";

/**
 * 実行 runtime が広告・観測した model/transport capability snapshot（contract §59）。
 * `unknown` を空集合と同一視せず、証拠不足と明示的な非対応を分離する。
 */
export type CapabilityKnowledge = "known" | "unknown";

export interface ExecutionRuntimeDescriptor {
  /** runtime の安定識別子（例: codex-cli / chatgpt-app-codex） */
  name: string;
  /** runtime が広告またはローカル probe した version。取得不能時は null */
  version: string | null;
  source: "advertised" | "local-probe" | "unknown";
}

export interface ExecutionCapabilitySnapshot {
  schemaVersion: "execution-capability.v1";
  provider: Provider;
  transport: Transport;
  runtime: ExecutionRuntimeDescriptor;
  /** model/effort/session-stop 等の versioned capability token */
  capabilities: readonly string[];
  /** runtime が明示広告した model ID。広告面自体が無い場合は knowledge=unknown */
  modelCatalog:
    | { knowledge: "known"; models: readonly string[]; source: "advertised" }
    | { knowledge: "unknown"; detail: string };
  delivery: {
    model: ModelDelivery | "unknown";
    effort: EffortDelivery | "unknown";
    /** 旧runtimeの欠落はunknownとして扱う。 */
    speed?: SpeedDelivery | "unknown";
  };
  observedAt: number;
}

/** trusted compatibility policy。snapshot の推測値ではなく、設定/契約由来の要件を表す。 */
export interface ModelTransportRequirement {
  provider: Provider;
  model: string;
  transport: Transport;
  /** runtime version policy を使う場合の安定 policy ID */
  policyId?: string;
  minimumRuntimeVersion?: string;
  requestedEffort?: EffortLevel;
  requestedSpeed?: ExecutionSpeed;
  /** trusted policyが明示した対応effort。undefinedは対応不明。 */
  supportedEfforts?: readonly EffortLevel[];
  /** trusted policyが明示した対応speed。undefinedは対応不明。 */
  supportedSpeeds?: readonly ExecutionSpeed[];
  requiredCapabilities: readonly string[];
  requireNativeModelDelivery: boolean;
  requireNativeEffortDelivery: boolean;
  requireNativeSpeedDelivery: boolean;
}

/** 起動前互換判定。unknown は supported/unsupported のどちらにも丸めない。 */
export type ModelTransportCompatibilityDecision =
  | {
      status: "supported";
      evidence: "advertised-model" | "runtime-version-policy";
      policyId?: string;
    }
  | {
      status: "unsupported";
      reason:
        | "provider-mismatch"
        | "transport-mismatch"
        | "model-not-advertised"
        | "runtime-version-too-old"
        | "required-capability-missing"
        | "effort-not-supported"
        | "speed-not-supported"
        | "native-model-delivery-missing"
        | "native-effort-delivery-missing"
        | "native-speed-delivery-missing";
      policyId?: string;
      detail: string;
    }
  | {
      status: "unknown";
      reason:
        | "runtime-version-unknown"
        | "model-catalog-unknown"
        | "compatibility-policy-missing"
        | "invalid-runtime-version";
      detail: string;
    };

export interface LaunchOptions {
  model: string;
  /** ワーカーの作業ディレクトリ */
  cwd: string;
  /** ワーカーに与えるプロンプト全文 */
  promptText: string;
  /** reasoning effort（省略時は各 CLI の既定に任せる。contract §35.3） */
  effort?: EffortLevel;
  /** 処理速度要求。明示値はadapterがruntimeへ確実に配送する。 */
  speed?: ExecutionSpeed;
}

export interface SessionRef {
  provider: Provider;
  sessionId: string;
  /** bridge の URL（block reason の server= に使う） */
  serverUrl: string;
  model: string;
  modelDelivery: ModelDelivery;
  /** effort の実配信結果（effort 指定があった場合のみ記録。contract §35.3） */
  effortDelivery?: EffortDelivery;
  /** speed の実配信結果。実効speedを意味しない（contract §67）。 */
  speedDelivery?: SpeedDelivery;
  /** provider native communication用の実行時address。Hachi task/run/fence authorityの代替ではない。 */
  nativeCommunication?: NativeCommunicationSessionRef;
  startedAt: number;
}

interface NativeCommunicationSessionEvidence {
  /** provider runtime自身が返したexact session ID。表示名を入れない。 */
  providerSessionId: string;
  runtimeVersion: string;
  /** canonical communication capability snapshotのsha256。 */
  capabilityHash: string;
  hostId: string;
  observedAt: number;
  expiresAt: number;
}

/**
 * Hachi が観測した Codex App Server の local Unix socket identity。
 * provider の peer identity を authority にせず、再起動後も同じ local endpoint を
 * 再検証するための durable evidence として保存する。
 */
export interface NativeCommunicationSocketSnapshot {
  readonly canonicalPath: string;
  readonly parentCanonicalPath: string;
  readonly parentDev: number;
  readonly parentIno: number;
  readonly parentUid: number;
  readonly parentMode: number;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

export type NativeCommunicationSessionRef =
  | (NativeCommunicationSessionEvidence & {
      route: "codex-app-server";
      threadId: string;
      activeTurnId: string;
      socketSnapshot: NativeCommunicationSocketSnapshot;
    })
  | (NativeCommunicationSessionEvidence & {
      route: "claude-cross-session";
      /** ListAgentsが返した衝突しないexact ref。--nameは含めない。 */
      agentRef: string;
    });

export interface NativeCommunicationProbeResult {
  state: "supported" | "unsupported" | "unknown";
  detail: string;
  /** supportedのときだけ、freshなtarget evidenceを返す。 */
  target?: NativeCommunicationSessionRef;
}

export interface NativeCommunicationDeliveryRequest {
  attemptId: string;
  attemptNonce: string;
  deliveryId: string;
  messageKey: string;
  taskId: string;
  runId: number;
  hachiSessionId: string;
  expectedCancelFence: number;
  message: string;
  target: NativeCommunicationSessionRef;
}

export type NativeCommunicationDeliveryResult =
  | {
      outcome: "transport_accepted" | "session_observed" | "acknowledged";
      receiptId: string;
      detail?: string;
    }
  | { outcome: "rejected" | "uncertain"; receiptId?: string; detail: string };

/** provider公開面だけを包むdelivery adapter。DB lifecycleやfallback判断はSupervisor/Coreが所有する。 */
export interface NativeCommunicationAdapter {
  readonly provider: Provider;
  readonly route: Exclude<CommunicationRoute, "hachi">;
  probe(ref: SessionRef, now: number): Promise<NativeCommunicationProbeResult>;
  deliver(input: NativeCommunicationDeliveryRequest): Promise<NativeCommunicationDeliveryResult>;
}

export type SessionState = "active" | "awaiting-input" | "idle" | "ended" | "unknown";

export interface SessionStatus {
  state: SessionState;
  lastActivityAt: number | null;
  /**
   * type:"result" イベント数（bridge 実仕様では /api/status に終端状態が無いため、
   * 「idle かつ resultCount >= 1」を turn 完了として扱う。contract §13.4）
   */
  resultCount?: number;
  /** 最後の type:"result" イベントの統計（コスト永続化用。contract §14.5） */
  lastResult?: SessionResultStats;
  /**
   * run 単位の token/cost 計測（docs/plans/direct-run-usage-cost-audit.md §3.2 + R1〜R7）。
   * lastResult とは別キーで、値の隣に必ず「なぜその値なのか」を持つ。
   */
  usage?: RunUsage;
  /** bridge が返した生ペイロード（デバッグ用、ログには要 redaction） */
  raw?: unknown;
}

/** bridge の result イベントから抽出する実行統計（contract §14.5） */
export interface SessionResultStats {
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

// ---------------------------------------------------------------------------
// run 単位の token/cost 計測（設計: docs/plans/direct-run-usage-cost-audit.md §3.2 / R4）
// ---------------------------------------------------------------------------

/**
 * どの経路が生成した数値か（measured のみが持つ）。監査可能性の核。
 * 二重集計防止（§4.3）の判定にも使う。
 */
export type MetricProvenance =
  /** even-terminal /api/messages の type:"result" イベント */
  | "bridge-result-event"
  /** codex --json / claude --output-format json の直接出力 */
  | "cli-json-result"
  /** ~/.claude/projects/*.jsonl や ~/.codex/sessions/*.jsonl の事後読み取り */
  | "cli-native-session-log";

/**
 * metric 単位のタグ付き値。数値の隣に必ず理由を持たせ、値と理由の drift を防ぐ（§3.2）。
 *
 * state を判別子にしているのは `switch (v.state)` の網羅性検査を効かせるためで、
 * `estimated` / `legacy-unverified` を `measured` と同じ case に紛れ込ませられなくする
 * （既定集計が推定値・旧形式値を暗黙に取り込むことをコンパイラレベルで防ぐ。§R4）。
 */
export type MetricValue =
  /** 実測。provider が出した数値をそのまま採用した */
  | { state: "measured"; value: number; provenance: MetricProvenance }
  /** 推定。トークン×価格表で算出した合成値。measured と合算してはならない（§R4） */
  | { state: "estimated"; value: number; basis: "price-table"; priceTableRef: string }
  /** 経路はあるが今回この run では返らなかった */
  | { state: "not-provided" }
  /** provider の課金モデル上その概念が存在しない、または価格表に無く推定もできない */
  | { state: "unavailable-by-design" }
  /** そもそも取得経路が無い / ログに到達できなかった / 壊れていた */
  | { state: "unknown" }
  /** 旧 lastResult からの読み替え（§5.2）。measured ではない */
  | { state: "legacy-unverified"; value: number };

/**
 * run 1本分の usage 記録（`task_runs.meta.usage`）。
 *
 * トークンは4系統を**互いに素**な内訳として持つ（§R1 の「4系統すべてを足す」の実装形）。
 * どれか1つでも欠けると cache read 144,970 を捨てた今回の根因が再発するため、
 * 型の上で4フィールドを必須にしている。
 */
export interface RunUsage {
  /** 推定 or 実測の USD。provider に概念が無い/価格表に無い場合は unavailable-by-design */
  costUsd: MetricValue;
  /** cache read/creation を含まない純 input トークン */
  inputTokens: MetricValue;
  /** output トークン（codex の reasoning_output_tokens はこの内数） */
  outputTokens: MetricValue;
  /** cache 書き込みトークン */
  cacheCreationTokens: MetricValue;
  /** cache 読み出しトークン */
  cacheReadTokens: MetricValue;
  /** API 往復回数 */
  turns: MetricValue;
  /** ログ上の最初と最後の記録の間隔 */
  durationMs: MetricValue;
  /** この usage を書いた collector（回帰調査用）。例 "direct-claude@native-log-v1" */
  collectedBy: string;
  /** 実際にトークンを消費したモデル id（launch 時の model とは限らない。allowlist 済み非 secret） */
  models?: string[];
  /** 価格表に無く cost 推定から除外したモデル id（costUsd=unavailable-by-design の理由） */
  unpricedModels?: string[];
}

/**
 * worker stop の結果（契約 §34.2 / §34.2.1）。
 * `unsupported` は「経路が無い」ことの正直な報告であり throw しない。
 * `stopped` と `reason` の組合せは型で固定する。「シグナルを送れた」ことを
 * 停止の証拠として扱わないため、`{ stopped: true, reason: "unsignalable" }` のような
 * 組合せは型レベルで作れない。
 */
export type StopResult =
  | {
      /** この呼び出しが実際に停止させた。 */
      stopped: true;
      /**
       * - `terminated`: SIGTERM 後に group の消滅を観測した
       * - `killed`: SIGKILL 後に group の消滅を観測した
       */
      reason: "terminated" | "killed";
    }
  | {
      /** この呼び出しは停止させていない（既に停止していた／できなかった）。 */
      stopped: false;
      /**
       * - `already-exited`: この呼び出しでは停止させていない。
       *   **§34.2.2 完了までは「停止済み」か「不明」かを区別できない多義値**
       *   （現行実装は state ファイルが読めないだけでもこれを返す）。停止の証拠に使わない
       * - `unsupported`: 停止経路そのものが無い（bridge 系）
       * - `unsignalable`: EPERM 等で観測も送信もできなかった（停止したかは不明）
       * - `kill-unconfirmed`: SIGKILL は送れたが group が依然として観測可能で生存している
       */
      reason: "already-exited" | "unsupported" | "unsignalable" | "kill-unconfirmed";
    };

export interface WorkerStopCapabilities {
  protocol: "direct-stop-v1" | "session-stop-v1" | "unsupported";
  exactSession: boolean;
  childProcessTree: boolean;
}

export interface ExactSessionStopInput {
  requestNonce: string;
  expectedRunId: number;
  expectedSessionId: string;
}

export interface ExactSessionStopResult {
  state: "stopped" | "already-stopped" | "unsupported" | "rejected" | "unknown";
  evidenceId: string;
  observedSessionState: SessionState;
  childProcessTreeCovered: boolean;
}

export interface WorkerAdapter {
  readonly provider: Provider;
  /** 新規セッションを起動する。失敗は throw（呼び出し側が auto-launch-failed: 処理） */
  launch(task: TaskRow, options: LaunchOptions): Promise<SessionRef>;
  /** セッション状態を取得する */
  status(ref: SessionRef): Promise<SessionStatus>;
  /** 稼働中セッションへメッセージを注入する（steer） */
  inject(ref: SessionRef, message: string): Promise<void>;
  /** セッションの会話ログ全文を取得する（artifacts 保存用） */
  fetchTranscript(ref: SessionRef): Promise<string>;
  /** bridge の生存確認（token 無し /api/info が 401 を返すこと） */
  healthCheck(): Promise<boolean>;
  /**
   * セッションを強制停止する（contract §34.2）。direct 系は必須実装（SIGTERM→SIGKILL）、
   * bridge 系は停止経路が無いため未実装（省略）または unsupported を返す。
   */
  stop?(ref: SessionRef): Promise<StopResult>;
  /** exact-session stop の広告。未実装・不明は unsupported と同義（contract §57.3） */
  stopCapabilities?(ref: SessionRef): Promise<WorkerStopCapabilities>;
  /** capability が exactSession=true の場合だけ呼べる fenced stop（contract §57.3） */
  stopExact?(ref: SessionRef, input: ExactSessionStopInput): Promise<ExactSessionStopResult>;
}

// ========== agent.message.v1（docs/contract.md §8） ==========

export type MessageIntent = "enqueue" | "steer" | "escalate" | "answer";

export type MessageRole = "worker" | "reviewer" | "orchestrator" | "human";

export interface MessageParty {
  role: MessageRole;
  provider: Provider | "";
  sessionId: string;
}

export interface MessageTarget {
  role: MessageRole;
  /** 対象タスク。enqueue では親タスク、steer では注入先タスク */
  taskId: string;
}

export interface AgentMessageV1 {
  schema: "agent.message.v1";
  from: MessageParty;
  to: MessageTarget;
  intent: MessageIntent;
  payload: Record<string, unknown>;
  /** 送信側が決める冪等キー。同一 key の重複処理は禁止 */
  idempotencyKey: string;
  createdAt: number;
}

/** intent=enqueue の payload 型 */
export interface EnqueuePayload {
  title: string;
  body: string;
  tenant: string;
  profile?: string;
  priority?: number;
}

/** intent=steer の payload 型 */
export interface SteerPayload {
  message: string;
}

// ========== KanbanStore（core の DB 単一書込パス。supervisor/cli はこれのみ使用） ==========

export interface TaskCreateInput {
  title: string;
  body: string;
  tenant: string;
  status?: TaskStatus;
  priority?: number;
  profile?: string;
  provider?: Provider | "";
  assignee?: string;
}

export interface TransitionInput {
  taskId: string;
  to: TaskStatus;
  /** blocked へ遷移する場合の block_reason（prefix 必須） */
  reason?: string;
  actor: string;
  /** 省略時は unknown。actor 表示文字列から推測しない（§60）。 */
  provenance?: ActorProvenance;
  /** task_events に記録する event_type（省略時 'status_changed'） */
  eventType?: string;
  payload?: Record<string, unknown>;
}

export interface KanbanStore {
  createTask(input: TaskCreateInput, actor: string, provenance?: ActorProvenance): TaskRow;
  getTask(id: string): TaskRow | null;
  listByStatus(status: TaskStatus, limit?: number): TaskRow[];
  /** blocked かつ in-progress prefix のタスク */
  listInProgress(): TaskRow[];
  /** subtask リンクの子孫（root 自身を含む）ID。循環リンクがあっても停止する */
  listSubtreeTaskIds(rootTaskId: string): string[];
  /**
   * subtask リンクの子孫（root を除く）を status 別に一括集計する。
   * listSubtreeTaskIds + getTask の N+1 を避けるための単一クエリ版。循環リンクがあっても停止する
   */
  countSubtreeStatuses(rootTaskId: string): { counts: Record<string, number>; total: number };
  /** orchestrator の担当範囲（§69.3 の配送先解決）と subtree でタスクを絞り込む */
  listScopedTasks(input: {
    orchestratorId?: string;
    subtreeRootId?: string;
    status?: TaskStatus;
    limit?: number;
  }): TaskRow[];
  /** 指定 task に対して当該 orchestrator が配送先として適格か（§69.3 の配送先解決と同一判定） */
  isOrchestratorScopedToTask(orchestratorId: string, taskId: string): boolean;
  /** 状態遷移（不正遷移は throw、同一 Tx で task_events 記録） */
  transition(input: TransitionInput): TaskRow;
  /** blocked へ倒す（reason prefix 検証つき） */
  block(
    taskId: string,
    reason: string,
    actor: string,
    assignee?: string,
    provenance?: ActorProvenance,
  ): TaskRow;
  /** blocked から指定状態へ戻す */
  unblock(taskId: string, to: TaskStatus, actor: string, provenance?: ActorProvenance): TaskRow;
  /**
   * status='ready' かつ claim_lock='' の場合のみ、単一 Tx（CAS）で blocked へ遷移する。
   * 条件不一致は何もせず false（他 writer の claim を尊重。contract §12.17-1）。
   */
  blockIfReadyUnclaimed(
    taskId: string,
    reason: string,
    actor: string,
    assignee?: string,
    provenance?: ActorProvenance,
  ): boolean;
  /**
   * status='ready' かつ claim_lock=claimToken の場合のみ、単一 Tx（CAS）で blocked へ遷移する。
   * claim 保持中の fail-closed block 用。不一致は false で no-op（contract §12.19-2）。
   */
  blockClaimedTask(
    taskId: string,
    claimToken: string,
    reason: string,
    actor: string,
    assignee?: string,
    provenance?: ActorProvenance,
  ): boolean;
  /** タスクと sessionId が一致する open run を1件返す（finalize 用。task_runs(task_id,status) index 利用） */
  getOpenRunByTaskSession(taskId: string, sessionId: string): RunRow | null;
  /** タスク body を全置換する（spec 補強・cwd 付与用）。event 'body_updated' を記録 */
  updateBody(taskId: string, body: string, actor: string, provenance?: ActorProvenance): TaskRow;
  addComment(taskId: string, author: string, body: string, provenance?: ActorProvenance): CommentRow;
  listComments(taskId: string, limit?: number): CommentRow[];
  addEvent(
    taskId: string,
    eventType: string,
    actor: string,
    payload: Record<string, unknown>,
    provenance?: ActorProvenance,
  ): EventRow;
  listEvents(taskId: string, eventType?: string, limit?: number): EventRow[];
  /** agent.message.v1 の冪等性照合 */
  hasProcessedMessage(idempotencyKey: string): boolean;
  /**
   * 冪等キーを処理済みとして記録する。新規に記録できた場合 true、既処理（UNIQUE 衝突含む）は false。
   * 呼び出し側は side effect を必ずこの戻り値でゲートする（mark-first。contract §12.10-1）。
   */
  markMessageProcessed(taskId: string, idempotencyKey: string, actor: string): boolean;
  /**
   * ready タスクを CAS で claim する（status='ready' かつ claim_lock='' の場合のみ成功し true）。
   * dispatch の起動前 durable claim 用（contract §12.7-1）。
   */
  claimTask(taskId: string, claimToken: string, actor: string): boolean;
  /** claim を解放する（claim_lock が一致する場合のみ '' に戻し true）。起動不成立時の巻き戻し用 */
  releaseClaim(taskId: string, claimToken: string, actor: string): boolean;
  /**
   * ready のまま残った stale claim を一括解放する（updated_at が now - olderThanSec より古いもの）。
   * 解放した件数を返す。reap ステージの定期清掃用（contract §12.8-2）。
   */
  clearStaleClaims(olderThanSec: number, now: number, actor: string): number;
  startRun(
    taskId: string,
    provider: Provider,
    sessionId: string,
    meta: Record<string, unknown>,
  ): RunRow;
  /** タスクの最新 open run（status='running'、startedAt 最新→id 最大）を1件返す */
  getLatestOpenRun(taskId: string): RunRow | null;
  endRun(runId: number, status: RunStatus, meta?: Record<string, unknown>): void;
  listOpenRuns(): RunRow[];
  /** durable cancel request を作る。open run/session と active orchestrator generation を同一 Tx で検証する。 */
  createOrGetRunCancelRequest(input: CreateRunCancelRequestInput): RunCancelRequestRow;
  getRunCancelRequest(id: string): RunCancelRequestRow | null;
  getActiveRunCancelRequestByTask(taskId: string): RunCancelRequestRow | null;
  listRunCancelRequests(taskId?: string): RunCancelRequestRow[];
  /** 状態・run/session・cancel fence・nonce を CAS 検証して遷移する。 */
  transitionRunCancelRequest(input: TransitionRunCancelRequestInput): RunCancelRequestRow;
  /** finalize/review/replacement が late mutation を拒否するための read gate。 */
  runMutationGate(runId: number, sessionId: string): RunMutationGate;
  link(parentId: string, childId: string, linkType?: string): void;
  listLinks(taskId: string): LinkRow[];
  /**
   * タスクの前提タスク（link_type='depends-on' で child_id=taskId のリンクの parent 群）を返す。
   * 依存ゲート（contract §24）で使う。
   */
  dependencies(taskId: string): TaskRow[];
  /** スケジュール CRUD（contract §29.1） */
  createSchedule(input: ScheduleCreateInput, actor: string): ScheduleRow;
  listSchedules(): ScheduleRow[];
  getSchedule(id: string): ScheduleRow | null;
  updateSchedule(id: string, patch: Partial<ScheduleCreateInput>, actor: string): ScheduleRow;
  setScheduleEnabled(id: string, enabled: boolean, actor: string, autoDisabledReason?: string): ScheduleRow;
  /** 発火記録: last_run_at/last_task_id 更新（createTask と同一 Tx で呼ぶ想定） */
  markScheduleFired(id: string, taskId: string, firedAt: number, actor: string): void;
  /** 連続失敗数の更新 */
  setScheduleFailures(id: string, consecutiveFailures: number, actor: string): void;
  deleteSchedule(id: string, actor: string): void;
  /** model_override の設定（'' でクリア）。charset 検証は行う、allowlist 照合は policy 側 */
  setModelOverride(taskId: string, model: string, actor: string, provenance?: ActorProvenance): TaskRow;
  /** effort_override の設定（'' でクリア）。 */
  setEffortOverride(
    taskId: string,
    effort: EffortLevel | "",
    actor: string,
    provenance?: ActorProvenance,
  ): TaskRow;
  /** worker/reviewerのexecution overrideを一つのtransactionで変更する。 */
  setExecutionOverrides(
    taskId: string,
    role: ExecutionRole,
    patch: ExecutionOverridePatch,
    actor: string,
    provenance?: ActorProvenance,
  ): TaskRow;
  /** ウォッチフラグの更新。 */
  setWatched(taskId: string, watched: boolean, actor: string, provenance?: ActorProvenance): TaskRow;
  /**
   * blocked タスクの block_reason を状態遷移なしで更新する（reason 付替）。
   * status=blocked 以外は throw（fail-closed）。prefix 検証あり。event 'block_reason_updated' を記録。
   */
  updateBlockReason(
    taskId: string,
    reason: string,
    actor: string,
    assignee?: string,
    provenance?: ActorProvenance,
  ): TaskRow;
  /**
   * agent.message.v1 フェンスを含む可能性のあるコメントを id 昇順で増分取得する
   * （supervisor messages ステージのカーソル走査用。afterId より大きい id のみ）。
   */
  listMessageFenceComments(afterId: number, limit?: number): CommentRow[];
  /** 全状態横断で updated_at 降順の直近タスクを返す（CLI の task list 用） */
  listRecent(limit: number): TaskRow[];
  /** contract §55: 論理オーケストレーターを登録する */
  registerOrchestrator(input: { label: string; project: string; repoCommonDir: string }): OrchestratorRow;
  getOrchestrator(id: string): OrchestratorRow | null;
  listOrchestrators(): OrchestratorRow[];
  /** 新規 session を開始する。active session がある場合は拒否する */
  startOrchestratorSession(input: {
    orchestratorId: string;
    provider?: Provider | "";
    providerSessionId?: string;
  }): OrchestratorSessionRow;
  getOrchestratorSession(id: string): OrchestratorSessionRow | null;
  listOrchestratorSessions(orchestratorId?: string): OrchestratorSessionRow[];
  heartbeatOrchestratorSession(sessionId: string, generation: number, now?: number): OrchestratorSessionRow;
  closeOrchestratorSession(sessionId: string, generation: number): OrchestratorSessionRow;
  prepareOrchestratorHandoff(sessionId: string, generation: number, tokenHash: string, expiresAt: number): OrchestratorSessionRow;
  fenceOrchestratorHandoffToken(
    sessionId: string,
    generation: number,
    expectedTokenHash: string,
    replacementTokenHash: string,
  ): { fenced: boolean; session: OrchestratorSessionRow | null };
  cancelOrchestratorHandoff(sessionId: string, generation: number, tokenHash: string): OrchestratorSessionRow;
  previewHandoffTransfers(sessionId: string, generation: number): { orchestratorRequestCount: number; runtimeCleanupClaimCount: number };
  acceptOrchestratorHandoff(input: {
    oldSessionId: string;
    tokenHash: string;
    provider?: Provider | "";
    providerSessionId?: string;
  }): OrchestratorSessionRow;
  takeoverStaleOrchestratorSession(input: {
    orchestratorId: string;
    staleBefore: number;
    provider?: Provider | "";
    providerSessionId?: string;
  }): OrchestratorSessionRow;
  /** heartbeat が期限切れの session を stale 化し、その claim を queued へ戻す */
  expireStaleOrchestratorSessions(staleBefore: number, now: number): number;
  getOrchestratorLivenessIncident(sessionId: string, generation: number): OrchestratorLivenessIncidentRow | null;
  listPendingOrchestratorLivenessIncidents(now?: number, limit?: number): OrchestratorLivenessIncidentRow[];
  markOrchestratorLivenessIncident(
    id: number,
    expectedAttempts: number,
    status: OrchestratorLivenessIncidentStatus,
    nextAttemptAt: number,
    lastError: string,
    now?: number,
  ): OrchestratorLivenessIncidentRow | null;
  addOrchestratorWatch(input: {
    orchestratorId: string;
    scope: OrchestratorWatchScope;
    selector: string;
    role: OrchestratorWatchRole;
    priority?: number;
  }): OrchestratorWatchRow;
  listOrchestratorWatches(orchestratorId?: string): OrchestratorWatchRow[];
  setOrchestratorWatchActive(watchId: string, active: boolean): OrchestratorWatchRow;
  bindTaskToOrchestrator(taskId: string, orchestratorId: string, role: OrchestratorWatchRole): TaskOrchestratorBindingRow;
  listTaskOrchestratorBindings(taskId: string): TaskOrchestratorBindingRow[];
  createOrGetOrchestratorRequest(input: CreateOrchestratorRequestInput): OrchestratorRequestRow;
  getOrchestratorRequest(id: string): OrchestratorRequestRow | null;
  getActiveOrchestratorRequestByTask(taskId: string): OrchestratorRequestRow | null;
  listOrchestratorRequests(orchestratorId?: string): OrchestratorRequestRow[];

  // --- steward 提案の durable request 面（契約 §69） ---
  /** §69.3 / §69.4 の抑止・配送先解決を通して提案を発行する。抑止時と配送先0件時は request を作らない。 */
  createStewardProposalRequest(input: {
    taskId: string;
    kind: StewardProposalKind;
    reason: string;
    worktree?: string;
    project?: string;
    now?: number;
  }): StewardProposalCreateResult;
  getStewardProposalRequest(id: string): StewardProposalRequestRow | null;
  listStewardProposalRequests(orchestratorId?: string): StewardProposalRequestRow[];
  listStewardProposalDeliveries(requestId: string): StewardProposalDeliveryRow[];
  claimStewardProposalRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    leaseUntil: number;
    now?: number;
  }): StewardProposalRequestRow;
  acceptStewardProposalRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    note?: string;
    now?: number;
  }): StewardProposalRequestRow;
  dismissStewardProposalRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    reason: string;
    now?: number;
  }): StewardProposalRequestRow;
  deferStewardProposalRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    deferUntil: number;
    reason?: string;
    now?: number;
  }): StewardProposalRequestRow;
  supersedeStewardProposalRequest(input: {
    requestId: string;
    reason?: string;
    now?: number;
  }): StewardProposalRequestRow;
  cancelStewardProposalRequestsForTerminalTask(taskId: string, now?: number): string[];
  getStewardProposalHealth(input?: { now?: number; unroutedSince?: number }): StewardProposalHealth;
  /** queued/delivered requestを現在のbinding/watchへ冪等再配送し、未claimの終端task requestをcancelする。 */
  reconcileOrchestratorRequestRouting(requestId: string): OrchestratorRoutingReconcileResult;
  /** 対象 orchestrator の pending delivery を durable に delivered へ進める */
  markOrchestratorDeliveriesDelivered(orchestratorId: string): number;
  claimOrchestratorRequest(input: {
    requestId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    leaseUntil: number;
  }): OrchestratorRequestRow;
  releaseOrchestratorRequest(input: {
    requestId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
  }): OrchestratorRequestRow;
  beginOrchestratorRequestAnswer(input: {
    requestId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    answerKey: string;
  }): OrchestratorRequestRow;
  resolveOrchestratorRequestByAnswerKey(taskId: string, answerKey: string): OrchestratorRequestRow | null;
  failOrchestratorRequestAnswer(taskId: string, answerKey: string): OrchestratorRequestRow | null;
  escalateOrchestratorRequest(input: {
    requestId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    question: string;
  }): OrchestratorRequestRow;
  recordHumanAnswerForRequest(taskId: string, answer: string): OrchestratorRequestRow | null;
  listPendingNotificationOutbox(limit?: number, now?: number): NotificationOutboxRow[];
  markNotificationOutbox(
    id: number,
    status: "sent" | "failed",
    nextAttemptAt?: number,
    sentTransports?: readonly string[],
  ): NotificationOutboxRow;
  /** half-open outbox へ配送予定を積む（契約 §40.1.1。同期。dedupe_key 衝突は既存行を duplicate で返す） */
  enqueueHalfOpenOutbox(input: {
    stage: HalfOpenOutboxStage;
    claimGeneration: number;
    dedupeKey: string;
    kind: string;
    payload: string;
    now?: number;
  }): HalfOpenOutboxEnqueueResult;
  /** 配送期限が来た pending|failed 行を created_at, id 昇順で返す（limit 既定 50） */
  listPendingHalfOpenOutbox(input: { stage: HalfOpenOutboxStage; now?: number; limit?: number }): HalfOpenOutboxRow[];
  /**
   * 配送結果を記録する。sent は next_attempt_at=null、failed は attempts+1 と
   * next_attempt_at=now+retryAfterSec（既定 60）。pending|failed 以外の行は変更せず現在行を返す。
   * 行が無ければ null
   */
  markHalfOpenOutbox(input: {
    id: string;
    result: "sent" | "failed";
    sentTransports?: string[];
    retryAfterSec?: number;
    now?: number;
  }): HalfOpenOutboxRow | null;
  /** 同 stage で claim_generation < currentGeneration の pending|failed 行を discarded にし件数を返す */
  discardStaleHalfOpenOutbox(input: { stage: HalfOpenOutboxStage; currentGeneration: number; now?: number }): number;
  /** 契約 §77.4 係数テーブル。key (provider, model, effort) で全置換する */
  upsertSessionUsageProfile(row: SessionUsageProfileRow): void;
  /** 係数テーブルを読む。filter 未指定は全件。provider → model → effort の順で安定ソート */
  listSessionUsageProfiles(filter?: { provider?: Provider; model?: string }): SessionUsageProfileRow[];
  /** 契約 §77.9 立ち上げ標本。key (orchestratorId, sessionId) で全置換する */
  upsertSessionBootSample(row: SessionBootSampleRow): void;
  /** identity の立ち上げ標本を新しい順（createdAt desc, sessionId desc）に読む。limit 既定は無制限 */
  listSessionBootSamples(input: { orchestratorId: string; limit?: number }): SessionBootSampleRow[];
  /** 状態別件数（ダッシュボード/doctor 用） */
  counts(): Record<TaskStatus, number>;
  /**
   * 複数のストア操作を単一トランザクションで実行する（同期 Tx。fn 内で await 不可）。
   * agent.message.v1 の DB-only intent 処理と markMessageProcessed の原子性確保に使う。
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

// ========== 読み取りビュー（web/レポート用の読み取り専用クエリ面。contract §14.4） ==========

/** ボード表示用の可視性分類 */
export type VisibilityBucket =
  | "human_queue"
  | "autonomous_in_progress"
  | "retry_pending"
  | "blocked_other"
  | TaskStatus;

/**
 * 読み取り専用のクエリ面。web パッケージはこれのみを使い、生 SQL を発行しない。
 * 実装は core（readonly 接続の別クラス。KanbanStore とは接続を分ける）。
 */
/** 実行中セッション情報（contract §26.1） */
export interface RunningSession {
  taskId: string;
  taskTitle: string;
  provider: Provider;
  model: string;
  transport: string;
  sessionId: string;
  serverUrl: string;
  startedAt: number;
  /** 実行中か終了済みか（contract §28.2） */
  state: "running" | "ended";
  /** 工程種別: worker（実装・自律進行）か reviewer（二審）か。meta.role="reviewer" のとき reviewer、それ以外は worker（contract §28.5） */
  role: "worker" | "reviewer";
  /** 対象タスクの現在 status（tasks との join で取得。contract §28.5） */
  taskStatus: TaskStatus;
  /** 対象タスクの tenant（tasks との join で取得。contract §28.5） */
  tenant: string;
  /** run meta の effort（profile 指定時のみ記録。無ければ null。contract §28.5/§35.3 */
  effort: string | null;
  /** run meta の effortDelivery（native/none。無ければ null。contract §35.3） */
  effortDelivery: string | null;
  /** run meta の要求速度（無ければ null）。 */
  speed?: string | null;
  /** runtimeへ速度設定を配送した結果（実効速度ではない）。 */
  speedDelivery?: string | null;
}

export interface KanbanReadView {
  /** 存在する tenant の一覧（重複なし・昇順） */
  tenants(): string[];
  /**
   * 実行中セッション一覧（task_runs.status='running' を task と結合）。contract §26.1。
   * meta から model/transport/serverUrl を抽出して返す。
   */
  runningSessions(): RunningSession[];
  /** 直近の終了済みセッション（running 以外、started_at 降順・limit 件）。contract §28.2 */
  recentSessions(limit: number): RunningSession[];
  /** sessionId 単体のセッション情報（running/ended 問わず task_runs から。無ければ null）。contract §27.2/§28 */
  runningSession(sessionId: string): RunningSession | null;
  /** スケジュール一覧（読み取り、contract §29.4） */
  schedules(): ScheduleRow[];
  schedule(id: string): ScheduleRow | null;
  /** スケジュール作成フォームの入力候補（過去に使われた値の distinct。contract §29.5） */
  scheduleFormOptions(): ScheduleFormOptions;
  /** 状態別件数（tenant 指定時はその tenant のみ） */
  counts(tenant?: string): Record<TaskStatus, number>;
  /** 人間確認キュー（user-decision/user-feedback/review-required/needs-manual、priority 降順→古い順） */
  humanQueue(tenant?: string): TaskRow[];
  /** 自律進行中（codex-in-progress/claude-in-progress、更新降順） */
  inProgress(tenant?: string): TaskRow[];
  /** 指定状態のタスク（priority 降順→更新降順、limit 任意） */
  byStatus(status: TaskStatus, tenant?: string, limit?: number): TaskRow[];
  /** タスク1件の可視性分類 */
  bucketOf(task: TaskRow): VisibilityBucket;
  task(id: string): TaskRow | null;
  /** 新しい方から limit 件を時系列順で（KanbanStore と同セマンティクス） */
  comments(taskId: string, limit?: number): CommentRow[];
  events(taskId: string, limit?: number): EventRow[];
  runs(taskId: string): RunRow[];
  cancelRequests(taskId: string): RunCancelRequestRow[];
  links(taskId: string): { parents: LinkRow[]; children: LinkRow[] };
  close(): void;
}

// ========== supervisor ステージ（docs/contract.md §10） ==========

export interface StageDeps {
  store: KanbanStore;
  config: HachiConfig;
  env: Environment;
  adapters: Record<Provider, WorkerAdapter>;
  /** direct transport 用 adapter（contract §17.3。不在時の direct 指定は fail-closed） */
  directAdapters?: Partial<Record<Provider, WorkerAdapter>>;
  /** same-provider native delivery用adapter。未登録routeはfail-closedする。 */
  nativeCommunicationAdapters?: Partial<Record<Provider, NativeCommunicationAdapter>>;
  logger: Logger;
}

export interface StageResult {
  name: string;
  /** 実行(または dry-run で実行予定)のアクション数 */
  actions: number;
  /** kill-switch 等でスキップされたか */
  skipped: boolean;
  notes?: string[];
}

export interface Stage {
  readonly name: string;
  /** 冪等であること。apply=false は dry-run（判定のみ） */
  tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult>;
}
