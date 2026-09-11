// =============================================================================
// /api/board・/api/task/:id のレスポンス形状（docs/contract.md §20.2）。
// サーバ（app.ts）とクライアント（client/）の双方が import type のみで参照する共有契約。
// 実行時コードは一切持たない（型のみ）。@hachi/core からの import も type-only に限定し、
// クライアントバンドルへ better-sqlite3 等の Node 専用依存を持ち込まないようにする。
// =============================================================================

import type {
  AgentMessageParseError,
  AgentMessageV1,
  CancelLifecycleSummary,
  CommentRow,
  DoneOriginStats,
  SteerDeliveryReadModel,
  EventRow,
  HumanDecisionAnswer,
  HumanDecisionRequestRow,
  KnowledgeRow,
  LinkRow,
  OrchestratorRequestRow,
  Provider,
  RunRow,
  RunningSession,
  ScheduleCadence,
  ScheduleFormOptions,
  ScheduleRow,
  TaskRow,
  TaskOrchestratorBindingRow,
  TaskStatus,
  RuntimeBundleKind,
  RuntimeCleanupDecisionClass,
  RuntimeCleanupPolicy,
  RuntimeCleanupRequestStatus,
  RuntimeLeaseState,
  RuntimeMemberKind,
  RuntimeMemberState,
  RuntimeTerminalReason,
} from "@hachi/core";
// supervisor-status.ts は fs/child_process へ依存する Node 専用実装だが、ここでは型のみを
// import type で取り込む（verbatimModuleSyntax によりビルド時に完全に消去され、
// クライアントバンドルへは一切持ち込まれない。docs/contract.md §23.1）。
import type { LastTick, LaunchdState, StageDisabledState } from "../supervisor-status.js";

/** 状態レーン（triage/todo/ready/review/needs-integration/done。docs/contract.md §14.3）のキー */
export type BoardStatusLaneKey = "triage" | "todo" | "ready" | "review" | "needs-integration" | "done";

export interface BoardResponse {
  tenants: string[];
  /** query の tenant（未指定は null） */
  currentTenant: string | null;
  counts: Record<TaskStatus, number>;
  /** 現在done状態のtaskを確定event列から分類した集計。 */
  doneOrigins: DoneOriginStats;
  /** auto-launch-failed の retry_pending 件数 */
  retryPending: number;
  /** 表示中taskごとのdurable steer read model。 */
  steerDeliveriesByTask: Record<string, SteerDeliveryReadModel[]>;
  lanes: {
    /** 人間確認キュー合算（後方互換用） */
    humanQueue: TaskRow[];
    /** あなたの判断待ち（user-decision/user-feedback） */
    humanDecisionQueue: TaskRow[];
    /** オーケストレーター回収待ち（review-required/needs-manual/auto-launch-failed/未知 prefix） */
    orchestratorRecoveryQueue: TaskRow[];
    /** 自律進行中（codex-in-progress/claude-in-progress） */
    inProgress: TaskRow[];
    /** 状態レーン。done は直近20件（docs/contract.md §14.3） */
    byStatus: Record<BoardStatusLaneKey, TaskRow[]>;
  };
}

/** GET /api/human-decisions のレスポンス。依頼は省略・task単位dedupeせず全件返す。 */
export interface HumanDecisionListResponse {
  requests: HumanDecisionRequestRow[];
}

/** GET /api/human-decisions/:id と回答POSTのレスポンス。 */
export interface HumanDecisionResponse {
  request: HumanDecisionRequestRow;
}

/** POST /api/human-decisions/:id/answer のJSON入力。provenance/now/requestIdはserver固定。 */
export interface HumanDecisionAnswerRequest {
  expectedRevision: 0;
  answerIdempotencyKey: string;
  answer: HumanDecisionAnswer;
  comment?: string | null;
}

/** GET /api/knowledge のレスポンス形状（docs/contract.md §47.5） */
export interface KnowledgeListResponse {
  knowledge: KnowledgeRow[];
}

export interface LinkWithTitle {
  link: LinkRow;
  title: string;
}

export interface TaskDependency {
  id: string;
  title: string;
  status: TaskStatus;
}

/** 1コメントに紐づく agent.message.v1 のパース結果 */
export interface CommentMessages {
  messages: AgentMessageV1[];
  errors: AgentMessageParseError[];
}

/** Webへ公開するdurable cancel読み取りモデル。authority nonceは意図的に含めない。 */
export type CancelRequestResponse = CancelLifecycleSummary;

/** artifact の stat と既存 event/run から解決した帰属（docs/contract.md §32.5）。 */
export interface ArtifactEntry {
  name: string;
  kind: "image" | "text";
  sizeBytes: number | null;
  /** epoch 秒。stat 失敗時は null。 */
  attachedAt: number | null;
  attachedAtSource: "event" | "mtime";
  runId: number | null;
  sessionId: string | null;
  role: "worker" | "reviewer" | "rework" | "orchestrator" | "human" | "unknown";
  attributionSource: "event-run" | "filename-session" | "interval" | "none";
}

export interface TaskDetailResponse {
  task: TaskRow;
  comments: CommentRow[];
  events: EventRow[];
  runs: RunRow[];
  /** contract §57.5 のreadonly lifecycle。request/ack nonceは非公開。 */
  cancelRequests: CancelRequestResponse[];
  /** contract §65.4 のreadonly durable steer lifecycle。 */
  steerDeliveries: SteerDeliveryReadModel[];
  links: {
    parents: LinkWithTitle[];
    children: LinkWithTitle[];
  };
  /** link_type='depends-on' の前提タスク（child_id=task.id の parent 群） */
  dependencies: TaskDependency[];
  artifacts: string[];
  artifactDetails: ArtifactEntry[];
  /** comment.id をキーとした agent.message.v1 の解析結果（該当ブロックが無いコメントはキー無し） */
  messages: Record<number, CommentMessages>;
  /** contract §55 の active worker-question request。解決済み/未作成なら null */
  orchestratorRequest: OrchestratorRequestRow | null;
  /** task に明示された担当オーケストレーター binding */
  orchestratorBindings: TaskOrchestratorBindingRow[];
}

/** 旧serverはadditive lifecycleを返さないため、clientのwire境界だけoptionalで受理する。 */
export type TaskDetailWireResponse = Omit<TaskDetailResponse, "cancelRequests" | "steerDeliveries"> & {
  cancelRequests?: CancelRequestResponse[];
  steerDeliveries?: SteerDeliveryReadModel[];
};

export type NormalizedTaskDetailResponse = TaskDetailResponse;

/** POST/DELETE /api/tasks/:id/watch のレスポンス形状（docs/contract.md §46.3） */
export interface TaskWatchResponse {
  task: TaskRow;
}

/**
 * Web 表示用のセッション。RunningSession の role/taskStatus/tenant（contract §28.5）をそのまま通し、
 * curlCommand は token 生値を含まず `$(cat <tokenfile>)` 形式にする。
 */
export interface WebRunningSession extends RunningSession {
  liveSupported: boolean;
  curlCommand: string | null;
}

/** GET /api/sessions のレスポンス形状（docs/contract.md §26.1） */
export interface SessionsResponse {
  sessions: WebRunningSession[];
}

/** GET /api/session/:sessionId のレスポンス形状（docs/contract.md §27.2/§28.2） */
export interface SessionResponse {
  session: WebRunningSession;
}

/** GET /api/session/:sessionId/transcript の artifact フォールバックレスポンス */
export interface SessionTranscriptResponse {
  taskId: string;
  sessionId: string;
  source: "artifact";
  text: string;
}

/** GET /api/session/:sessionId/live の direct 実行中ログレスポンス */
export interface SessionLiveResponse {
  taskId: string;
  sessionId: string;
  source: "direct-live";
  text: string;
  truncated: boolean;
}

/**
 * GET /api/session/:sessionId/transcript-raw の1エントリ（ネイティブ JSONL 1行を表示用に正規化）。
 * kind は JSONL の生 type/payload.type を粗く分類したもの。claude は行レベルで tool_use/tool_result を
 * 判別しない（user/assistant 行の中の1ブロックのため）。codex は response_item/event_msg の payload.type から
 * 判別する（実データで確認済み。tool 系: function_call、function_call_output、exec_command_*、mcp_tool_call_* 等、
 * other: session_meta/turn_context/reasoning/token_count 等）。
 */
export interface SessionTranscriptRawEntry {
  /** 1始まりの物理行番号（JSONL 上） */
  line: number;
  /** 表示・フィルタ用の粗い分類 */
  kind: "user" | "assistant" | "tool" | "other";
  /** 行の生 type（claude: user/assistant/summary 等、codex: response_item/event_msg 等）。取れなければ null */
  rawType: string | null;
  /** 行の timestamp を ISO8601 文字列化したもの。取れなければ null */
  timestamp: string | null;
  /** redact 済みの表示用テキスト（内容ブロックを平坦化・要約したもの） */
  text: string;
  /** JSON.parse に失敗した行（書き込み中の途中行等）。true のとき text は生の行をそのまま redact したもの */
  unparsed: boolean;
}

/** found=false のときの理由コード。UsageUnavailableReason（契約 §14.5.1）の語彙をこのAPI向けに再利用する */
export type SessionTranscriptRawUnavailableReason =
  | "log-not-found"
  | "log-unreadable"
  | "log-not-persisted"
  | "log-too-large"
  | "session-id-unknown"
  // 形式検証（^[A-Za-z0-9_-]{1,128}$）に適合しない session id。「見つからない」ではなく明示的な拒否
  // として log-not-found と区別する（契約 §28.6-2）
  | "session-id-invalid"
  // 解決後の絶対パスが対応する root 配下に無い。形式検証をすり抜けた場合の最終防壁（契約 §28.6-2）
  | "path-outside-root";

interface SessionTranscriptRawBase {
  taskId: string;
  sessionId: string;
  provider: Provider;
}

/**
 * transcript-raw の found response が安全上限に到達した理由（契約 §28.6-9〜12）。
 * scan 上限超過は found:false / log-too-large なので、この語彙には含めない。
 */
export type SessionTranscriptRawLimitReason = "response-bytes" | "raw-line-bytes";

export interface SessionTranscriptRawFoundResponse extends SessionTranscriptRawBase {
  found: true;
  /** レスポンスに含まれる行番号の範囲（1始まり、両端含む）。行が0件のときは startLine > endLine */
  startLine: number;
  endLine: number;
  /** 取得時点でファイルに存在する行の総数 */
  totalLines: number;
  /** endLine より後ろにまだ行があるか */
  hasMoreAfter: boolean;
  /** startLine より前にまだ行があるか */
  hasMoreBefore: boolean;
  /**
   * 到達した安全上限。新serverは常に配列を返す。optional はrolling compatibility用で、
   * fieldが無い旧responseをclientが空配列として扱えるようにするため。
   */
  limitedBy?: SessionTranscriptRawLimitReason[];
  entries: SessionTranscriptRawEntry[];
}

export interface SessionTranscriptRawUnavailableResponse extends SessionTranscriptRawBase {
  found: false;
  reason: SessionTranscriptRawUnavailableReason;
  /** UNKNOWN_REASON_TEXT（orchestrator-usage.ts）と同種の人間向け文言 */
  reasonText: string;
}

export type SessionTranscriptRawResponse = SessionTranscriptRawFoundResponse | SessionTranscriptRawUnavailableResponse;

/** bridge /api/messages の Entry。type 判別ユニオンは実 bridge 拡張に備えて緩く受ける */
export interface SessionMessageEntry {
  id?: string | number;
  type?: string;
  text?: string;
  state?: string;
  success?: boolean;
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  [key: string]: unknown;
}

/** GET /api/session/:sessionId/messages の bridge 正常レスポンス */
export interface SessionMessagesResponse {
  messages: SessionMessageEntry[];
  state: string;
  sessionId: string;
  provider: string;
}

/** GET /api/supervisor のレスポンス形状（docs/contract.md §23.1） */
export interface SupervisorStatus {
  /** launchctl print の解析結果。取得失敗（未ロード等）は null で degrade */
  launchd: LaunchdState | null;
  /** 許可ステージ（supervisor=全体 + 各ステージ）ごとの kill-switch 有無 */
  stages: StageDisabledState[];
  /** supervisor.jsonl 末尾から復元した直近1 tick。ログが無ければ null */
  lastTick: LastTick | null;
  /** kill-switch ファイルの配置ディレクトリ（= env.home） */
  killSwitchDir: string;
}

// ========== Runtime resource inventory（docs/contract.md §56.6） ==========

export type RuntimeEvidenceValue = "pass" | "fail" | "unknown";

export interface RuntimeResourceEligibilityEvidence {
  managed: RuntimeEvidenceValue;
  ephemeral: RuntimeEvidenceValue;
  cleanupPolicy: RuntimeEvidenceValue;
  provenance: RuntimeEvidenceValue;
  terminalOrExpired: RuntimeEvidenceValue;
  leaseFence: RuntimeEvidenceValue;
  memberSnapshot: RuntimeEvidenceValue;
  unused: RuntimeEvidenceValue;
  freshInspect: RuntimeEvidenceValue;
  objectFence: RuntimeEvidenceValue;
  enforceMode: RuntimeEvidenceValue;
  killSwitch: RuntimeEvidenceValue;
  budget: RuntimeEvidenceValue;
  autoEligible: boolean;
  failedConditions: string[];
}

export interface RuntimeResourceMemberResponse {
  id: string;
  kind: RuntimeMemberKind | string;
  state: RuntimeMemberState | string;
  objectFence: number;
  display: string;
  port: { hostIp: string; hostPort: number | null; containerPort: number | null } | null;
  managed: boolean;
  ephemeral: boolean;
  cleanupPolicy: RuntimeCleanupPolicy | string;
  provenanceRecorded: boolean;
  provenanceVerifiedAt: number | null;
  lastObservedAt: number | null;
  eligibility: RuntimeResourceEligibilityEvidence;
}

export interface RuntimeCleanupRequestResponse {
  id: string;
  decisionClass: RuntimeCleanupDecisionClass | string;
  status: RuntimeCleanupRequestStatus | string;
  reason: string;
  expectedLeaseFence: number;
  expectedMembersHash: string;
  leaseFenceMatches: boolean;
  memberSnapshotMatches: boolean;
  claimantSessionId: string;
  claimantGeneration: number | null;
  claimLeaseUntil: number | null;
  approvedBy: string;
  approvalGeneration: number | null;
  executorId: string;
  executorGeneration: number;
  executorLeaseUntil: number | null;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string;
  escalationGeneration: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export interface RuntimeResourceLeaseResponse {
  id: string;
  bundleKind: RuntimeBundleKind | string;
  state: RuntimeLeaseState | string;
  ownerTaskId: string | null;
  ownerRunId: number | null;
  controllerOrchestratorId: string | null;
  fence: number;
  heartbeatAt: number | null;
  expiresAt: number | null;
  stale: boolean;
  staleReasons: string[];
  cleanupPolicy: RuntimeCleanupPolicy | string;
  managed: boolean;
  ephemeral: boolean;
  terminalReason: RuntimeTerminalReason | string;
  members: RuntimeResourceMemberResponse[];
  cleanupRequests: RuntimeCleanupRequestResponse[];
}

export interface RuntimeResourceSummary {
  total: number;
  byState: Record<RuntimeLeaseState, number> & { unknown: number };
  active: number;
  stale: number;
  expired: number;
  cleanupPending: number;
  quarantined: number;
  legacyNever: number;
}

/** GET /api/runtime-resources の readonly response。secret/provenance 本文は含めない。 */
export interface RuntimeResourcesResponse {
  generatedAt: number;
  summary: RuntimeResourceSummary;
  leases: RuntimeResourceLeaseResponse[];
}

/** POST /api/supervisor/killswitch のリクエスト body（docs/contract.md §23.2） */
export interface KillSwitchRequest {
  stage: string;
  disabled: boolean;
}

/** Web/API 表示用 schedule。nextFireAt は epoch 秒（JST 表示はクライアント側で行う） */
export interface ScheduleWithNextFire extends ScheduleRow {
  nextFireAt: number | null;
}

/** GET /api/schedules のレスポンス形状（docs/contract.md §29.4） */
export interface SchedulesResponse {
  schedules: ScheduleWithNextFire[];
  now: number;
}

/** schedule 作成フォームの profile 候補（config.profiles 由来。docs/contract.md §29.5） */
export interface ScheduleProfileOption {
  name: string;
  provider: Provider;
  model: string;
  isDefault: boolean;
}

/** GET /api/schedule-options のレスポンス形状（docs/contract.md §29.5） */
export interface ScheduleFormOptionsResponse extends ScheduleFormOptions {
  profiles: ScheduleProfileOption[];
}

/** POST /api/schedules のリクエスト body。CLI の schedule create と同型の入力名に揃える */
export interface ScheduleWriteRequest {
  name: string;
  cadenceKind: ScheduleCadence;
  at: string;
  weekday?: number;
  day?: number;
  date?: string;
  cwd: string;
  profile?: string;
  tenant?: string;
  prompt: string;
}

/** PATCH /api/schedules/:id のリクエスト body */
export interface SchedulePatchRequest extends Partial<ScheduleWriteRequest> {
  enabled?: boolean;
}

// ========== 設定編集（docs/contract.md §45） ==========

/** GET /api/config のレスポンス形状。config は Raw JSON 保全のため unknown として扱う */
export interface ConfigGetResponse {
  exists: boolean;
  config: unknown | null;
  etag: string | null;
}

/** PUT /api/config のリクエスト body。config は完全形 JSON を要求する */
export interface ConfigPutRequest {
  config: unknown;
  baseEtag: string | null;
}

/** PUT /api/config のレスポンス形状 */
export interface ConfigPutResponse {
  etag: string;
  meta: {
    applies: "next-tick";
  };
  changedSections: string[];
}

// ========== メトリクス（docs/contract.md §43.2） ==========

/** 日別スループット（done 数） */
export interface MetricsDailyThroughput {
  /** YYYY-MM-DD（JST） */
  date: string;
  count: number;
}

/** run 成功率 */
export interface MetricsRunSuccess {
  total: number;
  succeeded: number;
  failed: number;
  rate: number;
}

/** rework 率 */
export interface MetricsRework {
  totalDone: number;
  reworked: number;
  rate: number;
}

/** human_queue 滞留時間の分布バケット */
export interface MetricsHumanQueueDwell {
  bucket: string;
  count: number;
}

/** profile × provider 別の件数とコスト */
export interface MetricsProfileProviderStat {
  profile: string;
  provider: string;
  runCount: number;
  totalCostUsd: number;
}

/** tick_metrics の1レコード */
export interface MetricsTickRow {
  ts: number;
  stage: string;
  actions: number;
  durationMs: number;
}

/** GET /api/metrics のレスポンス形状（docs/contract.md §43.2） */
export interface MetricsResponse {
  period: { from: number; to: number };
  throughput: MetricsDailyThroughput[];
  runSuccess: MetricsRunSuccess;
  rework: MetricsRework;
  humanQueueDwell: MetricsHumanQueueDwell[];
  profileProviderStats: MetricsProfileProviderStat[];
  tickMetrics: MetricsTickRow[];
  doneOrigins: DoneOriginStats;
}

// ---------------------------------------------------------------------------
// GET /api/usage（契約 §14.5.1・設計 R4/R7）
// core の UsageReport と構造的に同型。client バンドルへ better-sqlite3 を持ち込まないため、
// core からの import ではなくここで再宣言する（MetricsResponse と同じ流儀）。
// ---------------------------------------------------------------------------

export type UsageGroupByAxis = "task" | "tenant" | "model" | "effort" | "provider" | "role";

export type UsageMetricProvenance = "bridge-result-event" | "cli-json-result" | "cli-native-session-log";

/** 実測値の集計。推定値は絶対にここへ入らない。 */
export interface UsageMeasuredAggregate {
  total: number;
  runCount: number;
  provenances: UsageMetricProvenance[];
}

/** 推定値の集計。実測値は絶対にここへ入らない。 */
export interface UsageEstimatedAggregate {
  total: number;
  runCount: number;
  priceTableRefs: string[];
}

/** 既定集計から外した run の内訳。件数だけを持ち、値は合算しない。 */
export interface UsageExcludedCounts {
  notProvided: number;
  unavailableByDesign: number;
  unknown: number;
  legacyUnverified: number;
  total: number;
}

export interface UsageMetricAggregate {
  measured: UsageMeasuredAggregate;
  estimated: UsageEstimatedAggregate;
  excluded: UsageExcludedCounts;
}

export interface UsageReportRowResponse {
  key: string;
  label: string;
  runCount: number;
  costUsd: UsageMetricAggregate;
  inputTokens: UsageMetricAggregate;
  outputTokens: UsageMetricAggregate;
  cacheCreationTokens: UsageMetricAggregate;
  cacheReadTokens: UsageMetricAggregate;
  turns: UsageMetricAggregate;
  durationMs: UsageMetricAggregate;
  models: string[];
  unpricedModels: string[];
}

export interface UsageCoverageResponse {
  totalRuns: number;
  aggregatedRuns: number;
  withUsageRuns: number;
  legacyOnlyRuns: number;
  noUsageRuns: number;
  duplicateRuns: number;
  runningRuns: number;
}

export interface UsageResponse {
  period: { from: number; to: number };
  groupBy: UsageGroupByAxis;
  rows: UsageReportRowResponse[];
  total: UsageReportRowResponse;
  coverage: UsageCoverageResponse;
  priceTableRefs: string[];
  priceTableMixed: boolean;
}
