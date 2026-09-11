// =============================================================================
// @hachi/web の Hono アプリケーション構築（docs/contract.md §20, §23）。
// v0.4 で SSR（hono/jsx）から JSON API + 静的配信（React SPA）へ転換した。
// DI: KanbanReadView と artifactsDir のみに依存し、DB 実装(sqlite 等)には依存しない。
// 原則 readonly。限定 write 例外は POST /api/supervisor/killswitch（kill-switch ファイルの touch/rm。§23.2）、
// /api/schedules の schedule CRUD（KanbanStore 経由。§29.4）、/api/tasks/:id/watch（§46.3）、
// /api/human-decisions/:id/answer（専用Store経由。§80）に限る。
// セキュリティ不変条件は §14 から完全継承する。
// =============================================================================

import { timingSafeEqual } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { BridgeError, bridgeFetch, resolveClaudeProjectsRoot, resolveCodexSessionsRoot } from "@hachi/adapters";
import { Hono, type Context } from "hono";
import {
  computeNextFire,
  deriveDoneOrigin,
  hachiConfigSchema,
  HUMAN_DECISION_STATUSES,
  HumanDecisionError,
  humanQueueLaneOfReason,
  MetricsReader,
  UsageReportReader,
  USAGE_GROUP_BY_VALUES,
  parseAgentMessages,
  redactCancelEvent,
  redactMaybeJsonText,
  redactRuntimeObservationText,
  redactText,
  runtimeMembersHash,
  sha256Hex,
  sortCancelRequestsDescending,
  summarizeCancelRequest,
  summarizeDoneOrigins,
  validateConfigSemantics,
  type BridgeConfig,
  type HachiConfig,
  type HumanDecisionAnswer,
  type HumanDecisionReadView,
  type HumanDecisionRequestStore,
  type HumanDecisionStatus,
  type ListHumanDecisionRequestsOptions,
  type KanbanStore,
  type KanbanReadView,
  type KnowledgeListOptions,
  type KnowledgeRow,
  type Provider,
  type RunningSession,
  type RuntimeResourceReadView,
  type ScheduleCadence,
  type ScheduleCreateInput,
  type ScheduleRow,
  type TaskRow,
  type TaskStatus,
  type UsageGroupBy,
  type EventRow,
  type DurableSteerReadView,
  type SteerDeliveryReadModel,
} from "@hachi/core";
import type {
  BoardResponse,
  BoardStatusLaneKey,
  CommentMessages,
  ConfigGetResponse,
  ConfigPutRequest,
  ConfigPutResponse,
  HumanDecisionAnswerRequest,
  HumanDecisionListResponse,
  HumanDecisionResponse,
  KnowledgeListResponse,
  KillSwitchRequest,
  LinkWithTitle,
  SchedulePatchRequest,
  ScheduleFormOptionsResponse,
  ScheduleWithNextFire,
  ScheduleWriteRequest,
  SchedulesResponse,
  SessionLiveResponse,
  SessionResponse,
  SupervisorStatus,
  SessionTranscriptResponse,
  SessionTranscriptRawEntry,
  SessionTranscriptRawFoundResponse,
  SessionTranscriptRawLimitReason,
  SessionTranscriptRawResponse,
  SessionsResponse,
  RuntimeCleanupRequestResponse,
  RuntimeResourceEligibilityEvidence,
  RuntimeResourceLeaseResponse,
  RuntimeResourceMemberResponse,
  RuntimeResourcesResponse,
  TaskDependency,
  TaskDetailResponse,
  TaskWatchResponse,
  WebRunningSession,
} from "./shared/api-types.js";
import { resolveArtifactAttribution, type ArtifactStat } from "./artifact-attribution.js";
import { isStageName, readLastTick, readLaunchd, readStages } from "./supervisor-status.js";
import {
  readTranscriptRawRange,
  resolveNativeTranscriptPath,
  TRANSCRIPT_RAW_REASON_TEXT,
  type NativeLogRoots,
  type TranscriptRawRangeOptions,
} from "./transcript-raw.js";

/** @hachi/web が動作するために必要な依存関係（DI 用のローカル interface） */
export interface WebDeps {
  /** 読み取り専用クエリ面。core の DB 実装(sqlite readonly 等)には依存しない */
  view: KanbanReadView;
  /** schedule 書き込みは必ず KanbanStore 実装経由に限定する（docs/contract.md §29.4） */
  store: Pick<KanbanStore, "createSchedule" | "updateSchedule" | "setScheduleEnabled" | "deleteSchedule"> & {
    setWatched(taskId: string, watched: boolean, actor: string): TaskRow;
    getActiveOrchestratorRequestByTask?(taskId: string): ReturnType<KanbanStore["getActiveOrchestratorRequestByTask"]>;
    listTaskOrchestratorBindings?(taskId: string): ReturnType<KanbanStore["listTaskOrchestratorBindings"]>;
  };
  /** artifacts のルートディレクトリ（$HACHI_KANBAN_HOME/artifacts） */
  artifactsDir: string;
  /** kill-switch ファイルの配置ディレクトリ（= env.home。docs/contract.md §23.1/§23.2） */
  home: string;
  /** launchctl のジョブラベル（既定 com.hachi-kanban.supervisor。docs/contract.md §23.1） */
  launchdLabel: string;
  /** bridge proxy 用の既知 bridge URL と token ファイル。token 生値は保持しない */
  bridges: Record<Provider, BridgeConfig>;
  /** profile 候補と schedule 作成時検証に使う config（docs/contract.md §29.5） */
  config: HachiConfig;
  /** web write API の Bearer token。生値はレスポンス・ログに含めない（docs/contract.md §31） */
  writeToken: string;
  /**
   * ビルド済みクライアント（dist/）の絶対パス。指定時のみ静的配信 + SPA fallback ルートを
   * 登録する（省略時はテストで API のみを検証できるよう無効化される）。
   */
  staticDir?: string;
  /** メトリクス集計の readonly リーダー（docs/contract.md §43.2。省略時は /api/metrics が 503 で degrade） */
  metricsDbPath?: string;
  /** runtime resource の唯一の readonly 面。未注入時は API を 503 で degrade する。 */
  runtimeResourceView?: RuntimeResourceReadView;
  /** §80のhuman decision専用readonly面。未注入時は専用APIだけを503へdegradeする。 */
  humanDecisionView?: HumanDecisionReadView;
  /** §80の回答だけに絞ったwrite面。既存store capabilityとは分離する。 */
  humanDecisionAnswerStore?: Pick<HumanDecisionRequestStore, "answerHumanDecisionRequest">;
  /** ネイティブログのルート差し替え（テスト用）。省略時は resolveClaudeProjectsRoot()/resolveCodexSessionsRoot() */
  nativeLogRoots?: { claudeProjectsRoot?: string; codexSessionsRoot?: string };
}

const RUNTIME_PENDING_REQUEST_STATES = new Set([
  "queued",
  "delivered",
  "claimed",
  "waiting_human",
  "approved",
  "executing",
  "retry_wait",
]);

const MODEL_TRANSPORT_EVENT_TYPES = new Set([
  "incompatible_model_transport",
  "model_transport_compatibility_unknown",
  "model_transport_compatibility_checked",
]);

function redactCompatibilityEvent(event: EventRow): EventRow {
  if (!MODEL_TRANSPORT_EVENT_TYPES.has(event.eventType)) {
    return event;
  }
  return {
    ...event,
    payload: redactMaybeJsonText(event.payload, redactRuntimeObservationText),
  };
}

const RUNTIME_LEASE_STATES = [
  "requested",
  "provisioning",
  "active",
  "cleanup_pending",
  "expired",
  "releasing",
  "released",
  "quarantined",
  "failed",
  "cancelled",
] as const;

function redactRuntimeString(value: unknown): string {
  return redactText(typeof value === "string" ? value : "unknown");
}

function safeRuntimeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function safeRuntimeTimestamp(value: unknown): number | null {
  return value === null ? null : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function runtimeEvidence(
  lease: ReturnType<RuntimeResourceReadView["leases"]>[number],
  member: ReturnType<RuntimeResourceReadView["members"]>[number],
  leaseFence: RuntimeResourceEligibilityEvidence["leaseFence"],
  memberSnapshot: RuntimeResourceEligibilityEvidence["memberSnapshot"],
  now: number,
): RuntimeResourceEligibilityEvidence {
  const terminalOrExpired =
    lease.terminalReason === "owner_terminal" ||
    lease.terminalReason === "lease_expired" ||
    lease.terminalReason === "provision_failed" ||
    (lease.expiresAt !== null && lease.expiresAt <= now);
  const provenanceRecorded = typeof member.provenance === "string" && member.provenance.trim() !== "";
  const provenance = !provenanceRecorded ? "fail" : member.provenanceVerifiedAt === null ? "unknown" : "pass";
  const evidence: RuntimeResourceEligibilityEvidence = {
    managed: lease.managed && member.managed ? "pass" : "fail",
    ephemeral: lease.ephemeral && member.ephemeral ? "pass" : "fail",
    cleanupPolicy: lease.cleanupPolicy === "auto" && member.cleanupPolicy === "auto" ? "pass" : "fail",
    provenance,
    terminalOrExpired: terminalOrExpired ? "pass" : "fail",
    leaseFence,
    memberSnapshot,
    unused: "unknown",
    freshInspect: "unknown",
    objectFence: "unknown",
    enforceMode: "unknown",
    killSwitch: "unknown",
    budget: "unknown",
    autoEligible: false,
    failedConditions: [],
  };
  evidence.failedConditions = Object.entries(evidence)
    .filter(([key, value]) => key !== "autoEligible" && key !== "failedConditions" && value !== "pass")
    .map(([key, value]) => redactRuntimeString(`${key}:${String(value)}`));
  return evidence;
}

function runtimeRequestResponse(
  request: ReturnType<RuntimeResourceReadView["cleanupRequests"]>[number],
  leaseFence: number,
  membersHash: string,
): RuntimeCleanupRequestResponse {
  return {
    id: redactRuntimeString(request.id),
    decisionClass: redactRuntimeString(request.decisionClass),
    status: redactRuntimeString(request.status),
    reason: redactRuntimeString(request.reason),
    expectedLeaseFence: safeRuntimeInteger(request.expectedLeaseFence),
    expectedMembersHash: redactRuntimeString(request.expectedMembersHash),
    leaseFenceMatches: request.expectedLeaseFence === leaseFence,
    memberSnapshotMatches: request.expectedMembersHash === membersHash,
    claimantSessionId: redactRuntimeString(request.claimantSessionId),
    claimantGeneration: safeRuntimeTimestamp(request.claimantGeneration),
    claimLeaseUntil: safeRuntimeTimestamp(request.claimLeaseUntil),
    approvedBy: redactRuntimeString(request.approvedBy),
    approvalGeneration: safeRuntimeTimestamp(request.approvalGeneration),
    executorId: redactRuntimeString(request.executorId),
    executorGeneration: safeRuntimeInteger(request.executorGeneration),
    executorLeaseUntil: safeRuntimeTimestamp(request.executorLeaseUntil),
    attempts: safeRuntimeInteger(request.attempts),
    nextAttemptAt: safeRuntimeTimestamp(request.nextAttemptAt),
    lastError: redactRuntimeString(request.lastError),
    escalationGeneration: safeRuntimeInteger(request.escalationGeneration),
    createdAt: safeRuntimeInteger(request.createdAt),
    updatedAt: safeRuntimeInteger(request.updatedAt),
    resolvedAt: safeRuntimeTimestamp(request.resolvedAt),
  };
}

function runtimeMemberResponse(
  member: ReturnType<RuntimeResourceReadView["members"]>[number],
  evidence: RuntimeResourceEligibilityEvidence,
): RuntimeResourceMemberResponse {
  const hasPort = member.kind === "tcp_port" || member.hostPort !== null || member.containerPort !== null;
  return {
    id: redactRuntimeString(member.id),
    kind: redactRuntimeString(member.kind),
    state: redactRuntimeString(member.state),
    objectFence: safeRuntimeInteger(member.objectFence),
    display: redactRuntimeString(member.displayName),
    port: hasPort
      ? {
          hostIp: redactRuntimeString(member.hostIp),
          hostPort: safeRuntimeTimestamp(member.hostPort),
          containerPort: safeRuntimeTimestamp(member.containerPort),
        }
      : null,
    managed: member.managed === true,
    ephemeral: member.ephemeral === true,
    cleanupPolicy: redactRuntimeString(member.cleanupPolicy),
    provenanceRecorded: typeof member.provenance === "string" && member.provenance.trim() !== "",
    provenanceVerifiedAt: safeRuntimeTimestamp(member.provenanceVerifiedAt),
    lastObservedAt: safeRuntimeTimestamp(member.lastObservedAt),
    eligibility: evidence,
  };
}

function buildRuntimeResourcesResponse(runtimeResourceView: RuntimeResourceReadView, now: number): RuntimeResourcesResponse {
  const leases = runtimeResourceView.leases().map((lease): RuntimeResourceLeaseResponse => {
    const members = runtimeResourceView.members(lease.id);
    const requests = runtimeResourceView.cleanupRequests(lease.id);
    const membersHash = runtimeMembersHash(members);
    const leaseFenceEvidence: RuntimeResourceEligibilityEvidence["leaseFence"] =
      requests.length === 0 ? "unknown" : requests.some((request) => request.expectedLeaseFence === lease.fence) ? "pass" : "fail";
    const memberSnapshotEvidence: RuntimeResourceEligibilityEvidence["memberSnapshot"] =
      requests.length === 0 ? "unknown" : requests.some((request) => request.expectedMembersHash === membersHash) ? "pass" : "fail";
    const expiryExceeded = lease.expiresAt !== null && lease.expiresAt <= now;
    // expiresAt と heartbeatAt だけでは heartbeat の許容間隔を復元できない。
    // expiry 超過を heartbeat deadline 超過と断定せず、証拠不足を明示する。
    const staleReasons = expiryExceeded
      ? ["expiry_exceeded", ...(lease.heartbeatAt === null ? [] : ["heartbeat_deadline_unknown"])]
      : [];
    return {
      id: redactRuntimeString(lease.id),
      bundleKind: redactRuntimeString(lease.bundleKind),
      state: redactRuntimeString(lease.state),
      ownerTaskId: lease.ownerTaskId === null ? null : redactRuntimeString(lease.ownerTaskId),
      ownerRunId: safeRuntimeTimestamp(lease.ownerRunId),
      controllerOrchestratorId:
        lease.controllerOrchestratorId === null ? null : redactRuntimeString(lease.controllerOrchestratorId),
      fence: safeRuntimeInteger(lease.fence),
      heartbeatAt: safeRuntimeTimestamp(lease.heartbeatAt),
      expiresAt: safeRuntimeTimestamp(lease.expiresAt),
      stale: staleReasons.length > 0 && ["active", "cleanup_pending"].includes(lease.state),
      staleReasons: staleReasons.map(redactRuntimeString),
      cleanupPolicy: redactRuntimeString(lease.cleanupPolicy),
      managed: lease.managed === true,
      ephemeral: lease.ephemeral === true,
      terminalReason: redactRuntimeString(lease.terminalReason),
      members: members.map((member) =>
        runtimeMemberResponse(
          member,
          runtimeEvidence(lease, member, leaseFenceEvidence, memberSnapshotEvidence, now),
        ),
      ),
      cleanupRequests: requests.map((request) => runtimeRequestResponse(request, lease.fence, membersHash)),
    };
  });
  const byState: RuntimeResourcesResponse["summary"]["byState"] = {
    requested: 0,
    provisioning: 0,
    active: 0,
    cleanup_pending: 0,
    expired: 0,
    releasing: 0,
    released: 0,
    quarantined: 0,
    failed: 0,
    cancelled: 0,
    unknown: 0,
  };
  for (const lease of leases) {
    if ((RUNTIME_LEASE_STATES as readonly string[]).includes(lease.state)) {
      byState[lease.state as (typeof RUNTIME_LEASE_STATES)[number]] += 1;
    } else {
      byState.unknown += 1;
    }
  }
  return {
    generatedAt: now,
    summary: {
      total: leases.length,
      byState,
      active: leases.filter((lease) => lease.state === "active" && !lease.stale).length,
      stale: leases.filter((lease) => lease.stale).length,
      expired: leases.filter((lease) => lease.state === "expired").length,
      cleanupPending: leases.filter(
        (lease) =>
          lease.state === "cleanup_pending" || lease.cleanupRequests.some((request) => RUNTIME_PENDING_REQUEST_STATES.has(request.status)),
      ).length,
      quarantined: leases.filter((lease) => lease.state === "quarantined").length,
      legacyNever: leases.filter(
        (lease) => lease.bundleKind === "legacy_observation" || !lease.managed || lease.cleanupPolicy === "never",
      ).length,
    },
    leases,
  };
}

/** done レーンの表示上限（docs/contract.md §14.3） */
const DONE_LANE_LIMIT = 20;

/** 以前のセッション一覧の表示上限（docs/contract.md §28.2） */
const RECENT_SESSIONS_LIMIT = 50;

/** direct live の既定 tail 行数（docs/contract.md §54.4） */
const DIRECT_LIVE_DEFAULT_TAIL = 200;

/** direct live の tail 上限（docs/contract.md §54.4） */
const DIRECT_LIVE_MAX_TAIL = 2_000;

/** taskId の形状（db.ts の生成規則 `t_` + hex 8〜16 桁に合わせた検証。fail-closed の入口） */
const TASK_ID_PATTERN = /^t_[0-9a-f]{8,16}$/;

/** scheduleId の形状（db.ts の生成規則 `s_` + 16 hex に合わせた検証。fail-closed の入口） */
const SCHEDULE_ID_PATTERN = /^s_[0-9a-f]{16}$/;

const SCHEDULE_CADENCES: readonly ScheduleCadence[] = ["daily", "weekly", "monthly", "once"];

const CONFIG_FILE_NAME = "config.json";

const CONFIG_BACKUP_DIR_NAME = "backups";

const configWriteLocks = new Map<string, Promise<void>>();

/** 状態レーンのキー一覧（docs/contract.md §14.3 の順序を維持） */
const STATE_LANE_KEYS: readonly BoardStatusLaneKey[] = [
  "triage",
  "todo",
  "ready",
  "review",
  "needs-integration",
  "done",
];

function compareHumanQueueLaneTasks(a: TaskRow, b: TaskRow): number {
  return b.priority - a.priority || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id);
}

function isHumanQueueLaneCandidate(view: KanbanReadView, task: TaskRow): boolean {
  const bucket = view.bucketOf(task);
  return bucket === "human_queue" || bucket === "retry_pending" || bucket === "blocked_other";
}

function splitHumanQueueLanes(
  view: KanbanReadView,
  tenant: string | undefined,
  query: string,
): Pick<BoardResponse["lanes"], "humanQueue" | "humanDecisionQueue" | "orchestratorRecoveryQueue"> {
  const blocked = view
    .byStatus("blocked", tenant)
    .filter((task) => isHumanQueueLaneCandidate(view, task))
    .filter((task) => matchesQuery(task, query))
    .sort(compareHumanQueueLaneTasks);
  const humanDecisionQueue = blocked.filter((task) => humanQueueLaneOfReason(task.blockReason) === "human_decision");
  const orchestratorRecoveryQueue = blocked.filter(
    (task) => humanQueueLaneOfReason(task.blockReason) === "orchestrator_recovery",
  );
  return {
    humanQueue: blocked,
    humanDecisionQueue,
    orchestratorRecoveryQueue,
  };
}

/** 拡張子から Content-Type を決める（静的配信用の最小限マップ） */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
}

// public/ 由来の静的アセットの固定allowlist。staticDir からの相対pathで、サブディレクトリも含む。
// ここに列挙したpathだけを配信し、dist内のそれ以外のfileは公開しない。
const PUBLIC_STATIC_ASSETS = [
  "favicon.svg",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "manifest.webmanifest",
  "icons/shiba.svg",
] as const;

/** query の tenant パラメータを正規化する（空文字は「絞り込み無し」= undefined として扱う） */
function normalizeTenant(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  return raw;
}

/** query の q パラメータ（検索語）を正規化する（前後空白を除去。未指定は空文字＝絞り込み無し） */
function normalizeQuery(raw: string | undefined): string {
  return raw === undefined ? "" : raw.trim();
}

function normalizeOptionalQuery(raw: string | undefined): string | undefined {
  const normalized = normalizeQuery(raw);
  return normalized === "" ? undefined : normalized;
}

function parseKnowledgeLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error("limit は 1 以上の整数で指定してください");
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 1) {
    throw new Error("limit は 1 以上の整数で指定してください");
  }
  return parsed;
}

interface KnowledgeReadView {
  listKnowledge(options?: KnowledgeListOptions): KnowledgeRow[];
}

function isKnowledgeReadView(view: KanbanReadView): view is KanbanReadView & KnowledgeReadView {
  return "listKnowledge" in view && typeof (view as { listKnowledge?: unknown }).listKnowledge === "function";
}

function isDurableSteerReadView(view: KanbanReadView): view is KanbanReadView & DurableSteerReadView {
  return "steerDeliveries" in view &&
    typeof (view as { steerDeliveries?: unknown }).steerDeliveries === "function";
}

function readSteerDeliveries(view: KanbanReadView, taskId?: string): SteerDeliveryReadModel[] {
  if (!isDurableSteerReadView(view)) {
    return [];
  }
  return view.steerDeliveries(taskId);
}

/** タスクが検索語に一致するか判定する（title/ID 部分一致・大小無視。§20.2） */
function matchesQuery(task: TaskRow, query: string): boolean {
  if (query === "") {
    return true;
  }
  const needle = query.toLowerCase();
  return task.title.toLowerCase().includes(needle) || task.id.toLowerCase().includes(needle);
}

function normalizeProvider(raw: string | undefined): Provider | null {
  if (raw === "codex" || raw === "claude") {
    return raw;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`未知のフィールドです: ${key}`);
    }
  }
}

function requireBodyRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new Error("不正な body です");
  }
  return body;
}

function requireHumanDecisionBodyRecord(body: unknown, label: string): Record<string, unknown> {
  if (!isRecord(body) || Array.isArray(body)) {
    throw new Error(`${label} はobjectが必須です`);
  }
  return body;
}

function parseHumanDecisionStatuses(raw: string | undefined): HumanDecisionStatus[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const statuses = raw.split(",");
  if (statuses.some((status) => status === "" || !HUMAN_DECISION_STATUSES.includes(status as HumanDecisionStatus))) {
    throw new Error("statusesには既知statusのcomma区切りが必須です");
  }
  return statuses as HumanDecisionStatus[];
}

function parseHumanDecisionAnswer(body: unknown): HumanDecisionAnswerRequest {
  const record = requireHumanDecisionBodyRecord(body, "body");
  assertKnownKeys(record, ["expectedRevision", "answerIdempotencyKey", "answer", "comment"]);
  if (record.expectedRevision !== 0) {
    throw new Error("expectedRevisionは0が必須です");
  }
  if (typeof record.answerIdempotencyKey !== "string") {
    throw new Error("answerIdempotencyKeyは文字列が必須です");
  }
  if (hasOwn(record, "comment") && record.comment !== null && typeof record.comment !== "string") {
    throw new Error("commentは文字列またはnullが必須です");
  }

  const answerRecord = requireHumanDecisionBodyRecord(record.answer, "answer");
  let answer: HumanDecisionAnswer;
  if (answerRecord.kind === "approval") {
    assertKnownKeys(answerRecord, ["kind", "outcome"]);
    if (answerRecord.outcome !== "approve" && answerRecord.outcome !== "reject") {
      throw new Error("approval answerが不正です");
    }
    answer = { kind: "approval", outcome: answerRecord.outcome };
  } else if (answerRecord.kind === "review") {
    assertKnownKeys(answerRecord, ["kind", "outcome"]);
    if (answerRecord.outcome !== "accepted" && answerRecord.outcome !== "changes_requested") {
      throw new Error("review answerが不正です");
    }
    answer = { kind: "review", outcome: answerRecord.outcome };
  } else if (answerRecord.kind === "decision") {
    assertKnownKeys(answerRecord, ["kind", "choiceId", "text"]);
    const hasChoiceId = hasOwn(answerRecord, "choiceId");
    const hasText = hasOwn(answerRecord, "text");
    if (hasChoiceId === hasText) {
      throw new Error("decision answerはchoiceIdまたはtextの片方だけが必須です");
    }
    if (hasChoiceId) {
      if (typeof answerRecord.choiceId !== "string") {
        throw new Error("choiceIdは文字列が必須です");
      }
      answer = { kind: "decision", choiceId: answerRecord.choiceId };
    } else {
      if (typeof answerRecord.text !== "string") {
        throw new Error("textは文字列が必須です");
      }
      answer = { kind: "decision", text: answerRecord.text };
    }
  } else {
    throw new Error("answer.kindが不正です");
  }

  return {
    expectedRevision: 0,
    answerIdempotencyKey: record.answerIdempotencyKey,
    answer,
    ...(hasOwn(record, "comment") ? { comment: record.comment as string | null } : {}),
  };
}

function requireNonEmptyStringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} は空でない文字列が必須です`);
  }
  return value;
}

function requireOptionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} は文字列が必須です`);
  }
  return value;
}

function requireIntegerField(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} は ${min}〜${max} の整数が必須です`);
  }
  return value;
}

function requireCadenceField(value: unknown): ScheduleCadence {
  if (typeof value === "string" && (SCHEDULE_CADENCES as readonly string[]).includes(value)) {
    return value as ScheduleCadence;
  }
  throw new Error("cadenceKind は daily / weekly / monthly / once のいずれかが必須です");
}

function parseAtField(value: unknown): { atHour: number; atMinute: number } {
  if (typeof value !== "string") {
    throw new Error("at は HH:MM 形式の文字列が必須です");
  }
  const match = /^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`at は HH:MM 形式が必須です: ${value}`);
  }
  return { atHour: Number.parseInt(match[1], 10), atMinute: Number.parseInt(match[2], 10) };
}

function requireRunDateField(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("date は YYYY-MM-DD 形式の文字列が必須です");
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error(`date は YYYY-MM-DD 形式が必須です: ${value}`);
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > lastDay) {
    throw new Error(`date の日付が不正です: ${value}`);
  }
  return value;
}

function assertAbsoluteCwd(cwd: string): void {
  if (!isAbsolute(cwd)) {
    throw new Error(`cwd は絶対パスが必須です: ${cwd}`);
  }
}

function parseMetricsDays(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    return 30;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error("days は 1〜90 の整数で指定してください");
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 1) {
    throw new Error("days は 1 以上で指定してください");
  }
  return Math.min(parsed, 90);
}

/** 集計軸を検証する。未知の値は 400 にする（既定へ黙って倒すと別の軸の数字を見せてしまう）。 */
function parseUsageGroupBy(raw: string | undefined): UsageGroupBy {
  if (raw === undefined || raw === "") {
    return "task";
  }
  if (!(USAGE_GROUP_BY_VALUES as readonly string[]).includes(raw)) {
    throw new Error(`by は ${USAGE_GROUP_BY_VALUES.join(" / ")} のいずれかで指定してください`);
  }
  return raw as UsageGroupBy;
}

function parseScheduleCreateBody(body: unknown): ScheduleCreateInput {
  const record = requireBodyRecord(body);
  assertKnownKeys(record, ["name", "cadenceKind", "at", "weekday", "day", "date", "cwd", "profile", "tenant", "prompt"]);
  const request = record as Partial<ScheduleWriteRequest>;
  const cadenceKind = requireCadenceField(request.cadenceKind);
  const at = parseAtField(request.at);
  const cwd = requireNonEmptyStringField(request.cwd, "cwd");
  assertAbsoluteCwd(cwd);

  const input: ScheduleCreateInput = {
    name: requireNonEmptyStringField(request.name, "name"),
    cadenceKind,
    atHour: at.atHour,
    atMinute: at.atMinute,
    cwd,
    prompt: requireNonEmptyStringField(request.prompt, "prompt"),
  };

  const tenant = requireOptionalStringField(record, "tenant");
  if (tenant !== undefined) {
    input.tenant = tenant;
  }
  const profile = requireOptionalStringField(record, "profile");
  if (profile !== undefined) {
    input.profile = profile;
  }

  if (cadenceKind === "weekly") {
    input.weekday = requireIntegerField(request.weekday, "weekday", 0, 6);
  }
  if (cadenceKind === "monthly") {
    input.dayOfMonth = requireIntegerField(request.day, "day", 1, 31);
  }
  if (cadenceKind === "once") {
    input.runDate = requireRunDateField(request.date);
  }

  return input;
}

function parseSchedulePatchBody(body: unknown): {
  patch: Partial<ScheduleCreateInput>;
  enabled: boolean | undefined;
} {
  const record = requireBodyRecord(body);
  assertKnownKeys(record, [
    "name",
    "cadenceKind",
    "at",
    "weekday",
    "day",
    "date",
    "cwd",
    "profile",
    "tenant",
    "prompt",
    "enabled",
  ]);
  const request = record as Partial<SchedulePatchRequest>;
  const patch: Partial<ScheduleCreateInput> = {};

  if (hasOwn(record, "name")) {
    patch.name = requireNonEmptyStringField(request.name, "name");
  }
  let cadenceKind: ScheduleCadence | undefined;
  if (hasOwn(record, "cadenceKind")) {
    cadenceKind = requireCadenceField(request.cadenceKind);
    patch.cadenceKind = cadenceKind;
  }
  if (hasOwn(record, "at")) {
    const at = parseAtField(request.at);
    patch.atHour = at.atHour;
    patch.atMinute = at.atMinute;
  }
  if (hasOwn(record, "cwd")) {
    const cwd = requireNonEmptyStringField(request.cwd, "cwd");
    assertAbsoluteCwd(cwd);
    patch.cwd = cwd;
  }
  if (hasOwn(record, "prompt")) {
    patch.prompt = requireNonEmptyStringField(request.prompt, "prompt");
  }

  const tenant = requireOptionalStringField(record, "tenant");
  if (tenant !== undefined) {
    patch.tenant = tenant;
  }
  const profile = requireOptionalStringField(record, "profile");
  if (profile !== undefined) {
    patch.profile = profile;
  }

  if (hasOwn(record, "weekday")) {
    patch.weekday = requireIntegerField(request.weekday, "weekday", 0, 6);
  }
  if (hasOwn(record, "day")) {
    patch.dayOfMonth = requireIntegerField(request.day, "day", 1, 31);
  }
  if (hasOwn(record, "date")) {
    patch.runDate = requireRunDateField(request.date);
  }

  if (cadenceKind === "weekly" && !hasOwn(record, "weekday")) {
    throw new Error("weekly schedule には weekday が必須です");
  }
  if (cadenceKind === "monthly" && !hasOwn(record, "day")) {
    throw new Error("monthly schedule には day が必須です");
  }
  if (cadenceKind === "once" && !hasOwn(record, "date")) {
    throw new Error("once schedule には date が必須です");
  }

  let enabled: boolean | undefined;
  if (hasOwn(record, "enabled")) {
    if (typeof request.enabled !== "boolean") {
      throw new Error("enabled は boolean が必須です");
    }
    enabled = request.enabled;
  }

  return { patch, enabled };
}

function parseJsonBodyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scheduleNotFoundStatus(error: unknown): 400 | 404 {
  const message = parseJsonBodyError(error);
  return message.includes("スケジュールが見つかりません") ? 404 : 400;
}

function taskNotFoundStatus(error: unknown): 400 | 404 {
  const message = parseJsonBodyError(error);
  return message.includes("タスクが見つかりません") ? 404 : 400;
}

function humanDecisionErrorStatus(error: HumanDecisionError): 400 | 403 | 404 | 409 | 503 {
  switch (error.code) {
    case "INVALID_INPUT":
      return 400;
    case "TASK_NOT_FOUND":
    case "REQUEST_NOT_FOUND":
    case "REFERENCE_NOT_FOUND":
      return 404;
    case "ACTOR_UNAUTHORIZED":
    case "SESSION_SUPERSEDED":
    case "OWNER_MISMATCH":
      return 403;
    case "IDEMPOTENCY_CONFLICT":
    case "REVISION_CONFLICT":
    case "STATE_CONFLICT":
    case "CLAIM_CONFLICT":
      return 409;
    case "SCHEMA_UNAVAILABLE":
      return 503;
  }
}

function humanDecisionErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof HumanDecisionError) {
    return c.json({ error: error.message }, humanDecisionErrorStatus(error));
  }
  return c.json({ error: "human decision APIの処理に失敗しました" }, 500);
}

function withNextFire(schedule: ScheduleRow, nowMs: number): ScheduleWithNextFire {
  const nextMs = computeNextFire(schedule, nowMs);
  return { ...schedule, nextFireAt: nextMs === null ? null : Math.floor(nextMs / 1000) };
}

function hasConfigProfile(config: HachiConfig, profile: string): boolean {
  return Object.prototype.hasOwnProperty.call(config.profiles, profile);
}

function assertScheduleProfileAllowed(config: HachiConfig, profile: string | undefined): void {
  if (profile === undefined || profile === "") {
    return;
  }
  if (!hasConfigProfile(config, profile)) {
    throw new Error(`未知の profile です: ${profile}`);
  }
}

function buildScheduleOptionsResponse(view: KanbanReadView, config: HachiConfig): ScheduleFormOptionsResponse {
  const options = view.scheduleFormOptions();
  return {
    ...options,
    profiles: Object.entries(config.profiles).map(([name, profile]) => ({
      name,
      provider: profile.provider,
      model: profile.model,
      isDefault: name === config.defaultProfile,
    })),
  };
}

interface ConfigFileState {
  exists: boolean;
  config: unknown | null;
  etag: string | null;
  raw: string | null;
}

function configPath(home: string): string {
  return resolve(home, CONFIG_FILE_NAME);
}

function backupDirPath(home: string): string {
  return resolve(home, CONFIG_BACKUP_DIR_NAME);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function parseConfigJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`config.json の JSON パースに失敗しました: ${parseJsonBodyError(error)}`);
  }
}

async function readConfigFile(home: string): Promise<ConfigFileState> {
  const filePath = configPath(home);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { exists: false, config: null, etag: null, raw: null };
    }
    throw error;
  }

  const raw = await readFile(filePath, "utf-8");
  return {
    exists: true,
    config: parseConfigJson(raw),
    etag: String(stats.mtimeMs),
    raw,
  };
}

function requireConfigPutBody(body: unknown): ConfigPutRequest {
  const record = requireBodyRecord(body);
  assertKnownKeys(record, ["config", "baseEtag"]);
  if (!hasOwn(record, "config")) {
    throw new Error("config は必須です");
  }
  if (!hasOwn(record, "baseEtag")) {
    throw new Error("baseEtag は必須です");
  }
  const baseEtag = record.baseEtag;
  if (baseEtag !== null && typeof baseEtag !== "string") {
    throw new Error("baseEtag は string または null が必須です");
  }
  return { config: record.config, baseEtag };
}

function formatZodPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "(root)";
  }
  return path.map((part) => String(part)).join(".");
}

function summarizeZodIssues(issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>): string[] {
  return issues.map((issue) => `${formatZodPath(issue.path)}: ${issue.message}`);
}

function topLevelKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function sectionValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function changedConfigSections(previous: unknown | null, next: unknown): string[] {
  const keys = new Set<string>([...topLevelKeys(previous), ...topLevelKeys(next)]);
  return [...keys]
    .filter((key) => JSON.stringify(sectionValue(previous, key)) !== JSON.stringify(sectionValue(next, key)))
    .sort();
}

function utcTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

async function backupConfigFile(home: string, current: ConfigFileState): Promise<void> {
  if (!current.exists) {
    return;
  }
  const dir = backupDirPath(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const backupPath = resolve(dir, `config-${utcTimestamp(new Date())}.json`);
  await copyFile(configPath(home), backupPath);
}

async function atomicWriteConfig(home: string, config: unknown): Promise<string> {
  const filePath = configPath(home);
  const tmpPath = resolve(home, `.config.${process.pid}.${Date.now()}.tmp`);
  const content = `${JSON.stringify(config, null, 2)}\n`;
  try {
    await writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    await rename(tmpPath, filePath);
  } catch (error) {
    try {
      await unlink(tmpPath);
    } catch {
      // tmp が作成される前の失敗や rename 済みの場合は何もしない。
    }
    throw error;
  }
  const stats = await stat(filePath);
  return String(stats.mtimeMs);
}

async function withConfigWriteLock<T>(home: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(home);
  const previous = configWriteLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const chained = previous.then(
    () => current,
    () => current,
  );
  configWriteLocks.set(key, chained);

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (configWriteLocks.get(key) === chained) {
      configWriteLocks.delete(key);
    }
  }
}

function writeConfigUpdateLog(changedSections: readonly string[]): void {
  process.stdout.write(`${JSON.stringify({ event: "web.config.updated", changedSections })}\n`);
}

function rejectNonSameOrigin(c: Context): Response | null {
  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite !== undefined && fetchSite !== "same-origin") {
    return c.json({ error: "same-origin request のみ許可されています" }, 403);
  }
  return null;
}

function tokenEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length) {
    return false;
  }
  return timingSafeEqual(actualBytes, expectedBytes);
}

export function requireWriteAuth(c: Context, writeToken: string): Response | null {
  const authorization = c.req.header("authorization");
  const bearerPrefix = "Bearer ";
  if (authorization === undefined || !authorization.startsWith(bearerPrefix)) {
    return c.json({ error: "write authorization required" }, 401);
  }
  const suppliedToken = authorization.slice(bearerPrefix.length);
  if (!tokenEquals(suppliedToken, writeToken)) {
    return c.json({ error: "write authorization required" }, 401);
  }
  return rejectNonSameOrigin(c);
}

/** シェル用単一引用符エスケープ。curl コマンド文字列に token 生値は入れない */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildBridgeMessagesUrl(serverUrl: string, sessionId: string, provider: Provider): string {
  const url = new URL("/api/messages", serverUrl);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("provider", provider);
  return url.toString();
}

function sessionIsLiveSupported(session: RunningSession, bridges: Record<Provider, BridgeConfig>): boolean {
  return session.serverUrl !== "direct" && session.serverUrl === bridges[session.provider].url;
}

function buildCurlCommand(session: RunningSession, bridges: Record<Provider, BridgeConfig>): string | null {
  if (!sessionIsLiveSupported(session, bridges)) {
    return null;
  }
  const bridge = bridges[session.provider];
  const url = buildBridgeMessagesUrl(session.serverUrl, session.sessionId, session.provider);
  return [
    "curl",
    "-sS",
    "-H",
    `"Authorization: Bearer $(cat ${shellSingleQuote(bridge.tokenFile)})"`,
    shellSingleQuote(url),
  ].join(" ");
}

function toWebSession(session: RunningSession, bridges: Record<Provider, BridgeConfig>): WebRunningSession {
  return {
    ...session,
    liveSupported: sessionIsLiveSupported(session, bridges),
    curlCommand: buildCurlCommand(session, bridges),
  };
}

/** supervisor の artifact 命名と同じサニタイズを使う（docs/contract.md §12.19-1） */
function sanitizeForFilename(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function buildTranscriptArtifactName(
  prefix: "transcript-full" | "transcript" | "transcript-review",
  sessionId: string,
): string {
  const safe = sanitizeForFilename(sessionId);
  const digest = sha256Hex(sessionId).slice(0, 8);
  return `${prefix}-${safe}-${digest}.txt`;
}

function buildTranscriptArtifactCandidates(sessionId: string): readonly string[] {
  return [
    buildTranscriptArtifactName("transcript-full", sessionId),
    buildTranscriptArtifactName("transcript", sessionId),
    buildTranscriptArtifactName("transcript-review", sessionId),
  ];
}

function parseDirectLiveTail(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") {
    return DIRECT_LIVE_DEFAULT_TAIL;
  }
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return null;
  }
  return Math.min(parsed, DIRECT_LIVE_MAX_TAIL);
}

/** transcript-raw の既定 limit（未指定時）と上限。 */
const TRANSCRIPT_RAW_DEFAULT_LIMIT = 200;
const TRANSCRIPT_RAW_MAX_LIMIT = 1000;
export const TRANSCRIPT_RAW_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** limitedByを契約順・重複無しへ正規化する。 */
function canonicalTranscriptRawLimits(
  reasons: readonly SessionTranscriptRawLimitReason[],
): SessionTranscriptRawLimitReason[] {
  const present = new Set(reasons);
  return (["response-bytes", "raw-line-bytes"] as const).filter((reason) => present.has(reason));
}

function serializedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * found responseを最終JSON envelope全体で8MiBへ収める。afterは古い側からのprefix、
 * before/tailは境界に近い新しい側からのsuffixだけを採用し、物理行cursorを未返却entryの先へ進めない。
 */
function fitTranscriptRawResponse(
  body: SessionTranscriptRawFoundResponse,
  direction: "forward" | "backward",
): SessionTranscriptRawFoundResponse {
  const canonicalBody: SessionTranscriptRawFoundResponse = {
    ...body,
    limitedBy: canonicalTranscriptRawLimits(body.limitedBy ?? []),
  };
  if (serializedJsonBytes(canonicalBody) <= TRANSCRIPT_RAW_MAX_RESPONSE_BYTES) {
    return canonicalBody;
  }

  const limitedBy = canonicalTranscriptRawLimits([...(canonicalBody.limitedBy ?? []), "response-bytes"]);
  const candidates =
    direction === "forward" ? canonicalBody.entries : [...canonicalBody.entries].reverse();
  const selected: SessionTranscriptRawEntry[] = [];
  let selectedEntryBytes = 0;

  for (const entry of candidates) {
    const nextStartLine = direction === "forward" ? canonicalBody.startLine : entry.line;
    const nextEndLine = direction === "forward" ? entry.line : canonicalBody.endLine;
    const metadataOnly: SessionTranscriptRawFoundResponse = {
      ...canonicalBody,
      startLine: nextStartLine,
      endLine: nextEndLine,
      hasMoreBefore: nextStartLine > 1,
      hasMoreAfter: nextEndLine < canonicalBody.totalLines,
      limitedBy,
      entries: [],
    };
    const entryBytes = serializedJsonBytes(entry);
    const separatorBytes = selected.length === 0 ? 0 : 1;
    const nextEntryBytes = selectedEntryBytes + separatorBytes + entryBytes;
    // metadataOnlyには空配列の `[]` が既に含まれるため、entry本体と区切りだけを加えれば最終値と一致する。
    if (serializedJsonBytes(metadataOnly) + nextEntryBytes > TRANSCRIPT_RAW_MAX_RESPONSE_BYTES) {
      break;
    }
    selected.push(entry);
    selectedEntryBytes = nextEntryBytes;
  }

  const entries = direction === "forward" ? selected : selected.reverse();
  const startLine =
    entries.length === 0
      ? direction === "forward"
        ? canonicalBody.startLine
        : canonicalBody.endLine + 1
      : direction === "forward"
        ? canonicalBody.startLine
        : (entries[0]?.line ?? canonicalBody.startLine);
  const endLine =
    entries.length === 0
      ? direction === "forward"
        ? canonicalBody.startLine - 1
        : canonicalBody.endLine
      : direction === "forward"
        ? (entries[entries.length - 1]?.line ?? canonicalBody.endLine)
        : canonicalBody.endLine;

  return {
    ...canonicalBody,
    startLine,
    endLine,
    hasMoreBefore: startLine > 1,
    hasMoreAfter: endLine < canonicalBody.totalLines,
    limitedBy,
    entries,
  };
}

/** 0以上の整数クエリパラメータをパースする。未指定は undefined、不正な値は null を返す（after/before 用）。 */
function parseOptionalNonNegativeInt(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** transcript-raw の limit クエリパラメータをパースする（未指定は既定値、1〜1000 の範囲外・不正値は null）。 */
function parseTranscriptRawLimit(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") {
    return TRANSCRIPT_RAW_DEFAULT_LIMIT;
  }
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > TRANSCRIPT_RAW_MAX_LIMIT) {
    return null;
  }
  return parsed;
}

function splitLogLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function selectDirectLiveTail(raw: string, tail: number): { text: string; truncated: boolean } {
  const lines = splitLogLines(raw);
  const truncated = lines.length > tail;
  const selected = truncated ? lines.slice(lines.length - tail) : lines;
  const prefix = truncated ? `…${lines.length - tail}行省略…\n` : "";
  return {
    text: `${prefix}${selected.join("\n")}${selected.length > 0 ? "\n" : ""}`,
    truncated,
  };
}

function directLiveOutputPath(home: string, sessionId: string): string | null {
  const base = resolve(home, "state", "direct-sessions");
  const safeSessionId = sanitizeForFilename(sessionId);
  const filePath = resolve(base, `${safeSessionId}.out`);
  if (!filePath.startsWith(`${base}${sep}`)) {
    return null;
  }
  return filePath;
}

function imageContentType(name: string): string | null {
  const extension = extname(name).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return null;
  }
}

/**
 * artifacts/<taskId> 配下のファイル名一覧を返す。
 * resolve 済み dir が artifactsDir 配下に収まっていることを readdir 前に検証し（containment）、
 * 逸脱時・ディレクトリが無い場合は空配列を返す（fail-closed。§14.3）。
 * taskId の形状検証・task 存在検証は呼び出し側（各ルート）の責務。
 */
async function listArtifactNames(artifactsDir: string, taskId: string): Promise<string[]> {
  const base = resolve(artifactsDir);
  const dir = resolve(base, taskId);
  if (dir !== base && !dir.startsWith(`${base}${sep}`)) {
    return [];
  }
  try {
    const names = await readdir(dir);
    return [...names].sort();
  } catch {
    return [];
  }
}

/** stat 失敗は名前単位で無視し、task detail 全体を失敗させない（docs/contract.md §32.5）。 */
async function listArtifactStats(
  artifactsDir: string,
  taskId: string,
  names: readonly string[],
): Promise<ReadonlyMap<string, ArtifactStat>> {
  const base = resolve(artifactsDir);
  const dir = resolve(base, taskId);
  const stats = new Map<string, ArtifactStat>();
  if (dir !== base && !dir.startsWith(`${base}${sep}`)) {
    return stats;
  }
  await Promise.all(names.map(async (name) => {
    const filePath = resolve(dir, name);
    if (!filePath.startsWith(`${dir}${sep}`)) {
      return;
    }
    try {
      const fileStat = await stat(filePath);
      stats.set(name, { sizeBytes: fileStat.size, mtimeMs: fileStat.mtimeMs });
    } catch {
      // 個別ファイルの消失・stat 失敗は attributionSource=none へ縮退させる。
    }
  }));
  return stats;
}

/** @hachi/web の Hono アプリケーションを構築する */
export function buildApp(deps: WebDeps): Hono {
  const { view, store, artifactsDir, home, launchdLabel, bridges, config, writeToken, staticDir, metricsDbPath } = deps;
  const app = new Hono();

  // ネイティブログのルート。テストでは deps.nativeLogRoots で差し替え、本番は CLI と同じ規則で解決する。
  const nativeLogRoots: NativeLogRoots = {
    home,
    claudeProjectsRoot: deps.nativeLogRoots?.claudeProjectsRoot ?? resolveClaudeProjectsRoot(),
    codexSessionsRoot: deps.nativeLogRoots?.codexSessionsRoot ?? resolveCodexSessionsRoot(),
  };

  app.get("/api/runtime-resources", (c) => {
    if (deps.runtimeResourceView === undefined) {
      return c.json({ error: "runtime resource read view は未注入です" }, 503);
    }
    try {
      return c.json(buildRuntimeResourcesResponse(deps.runtimeResourceView, Math.floor(Date.now() / 1000)));
    } catch (error) {
      return c.json({ error: `runtime resource の取得に失敗しました: ${redactText(parseJsonBodyError(error))}` }, 500);
    }
  });

  app.get("/api/config", async (c) => {
    const rejected = requireWriteAuth(c, writeToken);
    if (rejected !== null) {
      return rejected;
    }

    try {
      const current = await readConfigFile(home);
      const body: ConfigGetResponse = {
        exists: current.exists,
        config: current.config,
        etag: current.etag,
      };
      return c.json(body);
    } catch (error) {
      return c.json({ error: redactText(parseJsonBodyError(error)) }, 500);
    }
  });

  app.put("/api/config", async (c) => {
    const rejected = requireWriteAuth(c, writeToken);
    if (rejected !== null) {
      return rejected;
    }

    let request: ConfigPutRequest;
    try {
      request = requireConfigPutBody(await c.req.json());
    } catch (error) {
      return c.json({ error: `不正な JSON body です: ${parseJsonBodyError(error)}` }, 400);
    }

    const parsed = hachiConfigSchema.safeParse(request.config);
    if (!parsed.success) {
      return c.json(
        {
          error: "config.json の検証に失敗しました",
          issues: summarizeZodIssues(parsed.error.issues),
        },
        400,
      );
    }

    try {
      validateConfigSemantics(parsed.data as HachiConfig);
    } catch (error) {
      return c.json(
        {
          error: "config.json の検証に失敗しました",
          issues: [redactText(parseJsonBodyError(error))],
        },
        400,
      );
    }

    try {
      return await withConfigWriteLock(home, async () => {
        const current = await readConfigFile(home);

        if (current.etag !== request.baseEtag) {
          return c.json(
            {
              error: "baseEtag が現在の config.json と一致しません",
              currentEtag: current.etag,
            },
            409,
          );
        }

        const changedSections = changedConfigSections(current.config, request.config);
        await backupConfigFile(home, current);
        const etag = await atomicWriteConfig(home, request.config);
        writeConfigUpdateLog(changedSections);
        const body: ConfigPutResponse = {
          etag,
          meta: { applies: "next-tick" },
          changedSections,
        };
        return c.json(body);
      });
    } catch (error) {
      return c.json({ error: redactText(parseJsonBodyError(error)) }, 500);
    }
  });

  app.get("/api/board", (c) => {
    const tenant = normalizeTenant(c.req.query("tenant"));
    const query = normalizeQuery(c.req.query("q"));

    const tenants = view.tenants();
    const counts = view.counts(tenant);
    const doneOrigins = summarizeDoneOrigins(
      view.byStatus("done", tenant).map((task) => deriveDoneOrigin(view.events(task.id))),
    );
    const humanQueueLanes = splitHumanQueueLanes(view, tenant, query);
    const inProgress = view.inProgress(tenant).filter((task) => matchesQuery(task, query));

    const byStatus = {} as Record<BoardStatusLaneKey, TaskRow[]>;
    for (const key of STATE_LANE_KEYS) {
      const limit = key === "done" ? DONE_LANE_LIMIT : undefined;
      byStatus[key] = view
        .byStatus(key as TaskStatus, tenant, limit)
        .filter((task) => matchesQuery(task, query));
    }

    // retry_pending には専用の view メソッドが無いため、blocked 全件を bucketOf で絞り込む
    // （生 SQL は発行せず KanbanReadView のメソッドのみを組み合わせる）。
    const retryPending = view
      .byStatus("blocked", tenant)
      .filter((task) => view.bucketOf(task) === "retry_pending")
      .filter((task) => matchesQuery(task, query)).length;

    const visibleTaskIds = new Set<string>();
    for (const task of [
      ...humanQueueLanes.humanQueue,
      ...inProgress,
      ...Object.values(byStatus).flat(),
    ]) {
      visibleTaskIds.add(task.id);
    }
    const steerDeliveriesByTask: Record<string, SteerDeliveryReadModel[]> = {};
    for (const delivery of readSteerDeliveries(view)) {
      if (!visibleTaskIds.has(delivery.taskId)) {
        continue;
      }
      (steerDeliveriesByTask[delivery.taskId] ??= []).push(delivery);
    }

    const body: BoardResponse = {
      tenants,
      currentTenant: tenant ?? null,
      counts,
      doneOrigins,
      retryPending,
      steerDeliveriesByTask,
      lanes: { ...humanQueueLanes, inProgress, byStatus },
    };
    return c.json(body);
  });

  // ---------- 人間判断依頼（docs/contract.md §80） ----------

  app.get("/api/human-decisions", (c) => {
    if (deps.humanDecisionView === undefined) {
      return c.json({ error: "human decision read viewは未注入です" }, 503);
    }

    let statuses: HumanDecisionStatus[] | undefined;
    try {
      statuses = parseHumanDecisionStatuses(c.req.query("statuses"));
    } catch {
      return c.json({ error: "statusesが不正です" }, 400);
    }

    const taskId = c.req.query("taskId");
    const tenant = normalizeTenant(c.req.query("tenant"));
    try {
      // taskId指定時は一覧queryより先に存在とtenant scopeを確定する。
      if (taskId !== undefined) {
        const task = view.task(taskId);
        if (task === null || (tenant !== undefined && task.tenant !== tenant)) {
          return c.notFound();
        }
      }
      const options: ListHumanDecisionRequestsOptions = {
        ...(taskId === undefined ? {} : { taskId }),
        ...(tenant === undefined ? {} : { tenant }),
        ...(statuses === undefined ? {} : { statuses }),
      };
      const body: HumanDecisionListResponse = {
        requests: deps.humanDecisionView.listHumanDecisionRequests(options),
      };
      return c.json(body);
    } catch (error) {
      return humanDecisionErrorResponse(c, error);
    }
  });

  app.get("/api/human-decisions/:id", (c) => {
    if (deps.humanDecisionView === undefined) {
      return c.json({ error: "human decision read viewは未注入です" }, 503);
    }

    const tenant = normalizeTenant(c.req.query("tenant"));
    try {
      const request = deps.humanDecisionView.getHumanDecisionRequest(c.req.param("id"));
      if (request === null) {
        return c.notFound();
      }
      const task = view.task(request.taskId);
      if (task === null || (tenant !== undefined && task.tenant !== tenant)) {
        return c.notFound();
      }
      const body: HumanDecisionResponse = { request };
      return c.json(body);
    } catch (error) {
      return humanDecisionErrorResponse(c, error);
    }
  });

  app.post("/api/human-decisions/:id/answer", async (c) => {
    // write authはJSON parse、read、mutationのすべてより先に検証する。
    const rejected = requireWriteAuth(c, writeToken);
    if (rejected !== null) {
      return rejected;
    }
    if (deps.humanDecisionView === undefined || deps.humanDecisionAnswerStore === undefined) {
      return c.json({ error: "human decision API依存は未注入です" }, 503);
    }

    let input: HumanDecisionAnswerRequest;
    try {
      input = parseHumanDecisionAnswer(await c.req.json());
    } catch {
      return c.json({ error: "不正なJSON bodyです" }, 400);
    }

    const tenant = normalizeTenant(c.req.query("tenant"));
    const requestId = c.req.param("id");
    try {
      const current = deps.humanDecisionView.getHumanDecisionRequest(requestId);
      if (current === null) {
        return c.notFound();
      }
      const task = view.task(current.taskId);
      if (task === null || (tenant !== undefined && task.tenant !== tenant)) {
        return c.notFound();
      }
      const request = deps.humanDecisionAnswerStore.answerHumanDecisionRequest({
        requestId,
        expectedRevision: 0,
        answerIdempotencyKey: input.answerIdempotencyKey,
        answer: input.answer,
        ...(input.comment === undefined ? {} : { comment: input.comment }),
        provenance: {
          kind: "human",
          actorId: "web-human",
          actorSessionId: "",
          actorGeneration: null,
        },
        now: Math.floor(Date.now() / 1000),
      });
      const body: HumanDecisionResponse = { request };
      return c.json(body);
    } catch (error) {
      return humanDecisionErrorResponse(c, error);
    }
  });

  app.get("/api/knowledge", (c) => {
    if (!isKnowledgeReadView(view)) {
      return c.json({ error: "knowledge read view は未対応です" }, 500);
    }

    let limit: number | undefined;
    try {
      limit = parseKnowledgeLimit(c.req.query("limit"));
    } catch (error) {
      return c.json({ error: parseJsonBodyError(error) }, 400);
    }

    const options: KnowledgeListOptions = {};
    const tag = normalizeOptionalQuery(c.req.query("tag"));
    if (tag !== undefined) {
      options.tag = tag;
    }
    const source = normalizeOptionalQuery(c.req.query("source"));
    if (source !== undefined) {
      options.source = source;
    }
    const search = normalizeOptionalQuery(c.req.query("q"));
    if (search !== undefined) {
      options.search = search;
    }
    if (limit !== undefined) {
      options.limit = limit;
    }

    const body: KnowledgeListResponse = {
      knowledge: view.listKnowledge(options),
    };
    return c.json(body);
  });

  app.get("/api/sessions", (c) => {
    const scope = c.req.query("scope") ?? "running";
    if (scope !== "running" && scope !== "recent") {
      return c.json({ error: "scope は running または recent を指定してください" }, 400);
    }
    const sessions =
      scope === "running" ? view.runningSessions() : view.recentSessions(RECENT_SESSIONS_LIMIT);
    const body: SessionsResponse = {
      sessions: sessions.map((session) => toWebSession(session, bridges)),
    };
    return c.json(body);
  });

  app.get("/api/session/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    const session = view.runningSession(sessionId);
    if (session === null) {
      return c.notFound();
    }
    const body: SessionResponse = {
      session: toWebSession(session, bridges),
    };
    return c.json(body);
  });

  app.get("/api/session/:sessionId/transcript", async (c) => {
    const sessionId = c.req.param("sessionId");
    const taskId = c.req.query("taskId");
    if (sessionId === "" || taskId === undefined || !TASK_ID_PATTERN.test(taskId)) {
      return c.notFound();
    }
    if (view.task(taskId) === null) {
      return c.notFound();
    }
    const session = view.runningSession(sessionId);
    if (session === null || session.taskId !== taskId) {
      return c.notFound();
    }

    const expectedNames = buildTranscriptArtifactCandidates(sessionId);
    const names = await listArtifactNames(artifactsDir, taskId);
    const artifactName = expectedNames.find((name) => names.includes(name));
    if (artifactName === undefined) {
      return c.notFound();
    }

    const dir = resolve(artifactsDir, taskId);
    const filePath = resolve(dir, artifactName);
    if (!filePath.startsWith(`${dir}${sep}`)) {
      return c.notFound();
    }

    try {
      const raw = await readFile(filePath, "utf-8");
      const body: SessionTranscriptResponse = {
        taskId,
        sessionId,
        source: "artifact",
        text: redactText(raw),
      };
      return c.json(body);
    } catch {
      return c.notFound();
    }
  });

  app.get("/api/session/:sessionId/live", async (c) => {
    const sessionId = c.req.param("sessionId");
    const taskId = c.req.query("taskId");
    const tail = parseDirectLiveTail(c.req.query("tail"));
    if (sessionId === "" || taskId === undefined || !TASK_ID_PATTERN.test(taskId)) {
      return c.notFound();
    }
    if (tail === null) {
      return c.json({ error: "tail は 1 以上の整数を指定してください" }, 400);
    }
    if (view.task(taskId) === null) {
      return c.notFound();
    }
    const session = view.runningSession(sessionId);
    if (session === null || session.taskId !== taskId || session.transport !== "direct") {
      return c.notFound();
    }

    const filePath = directLiveOutputPath(home, sessionId);
    if (filePath === null) {
      return c.notFound();
    }

    try {
      const raw = await readFile(filePath, "utf-8");
      const selected = selectDirectLiveTail(raw, tail);
      const body: SessionLiveResponse = {
        taskId,
        sessionId,
        source: "direct-live",
        text: redactText(selected.text),
        truncated: selected.truncated,
      };
      return c.json(body);
    } catch {
      return c.notFound();
    }
  });

  app.get("/api/session/:sessionId/transcript-raw", async (c) => {
    const sessionId = c.req.param("sessionId");
    const taskId = c.req.query("taskId");
    if (sessionId === "" || taskId === undefined || !TASK_ID_PATTERN.test(taskId)) {
      return c.notFound();
    }
    if (view.task(taskId) === null) {
      return c.notFound();
    }
    const session = view.runningSession(sessionId);
    if (session === null || session.taskId !== taskId) {
      return c.notFound();
    }

    const after = parseOptionalNonNegativeInt(c.req.query("after"));
    const before = parseOptionalNonNegativeInt(c.req.query("before"));
    const limit = parseTranscriptRawLimit(c.req.query("limit"));
    if (after === null || before === null || before === 0 || limit === null) {
      return c.json({ error: "after は 0 以上、before は 1 以上、limit は 1〜1000 の整数で指定してください" }, 400);
    }
    if (after !== undefined && before !== undefined) {
      return c.json({ error: "after と before は同時に指定できません" }, 400);
    }

    // artifact ではなくディスク上のネイティブ JSONL を正本として読む。走行中でも finalize を待たない。
    const resolved = await resolveNativeTranscriptPath(session, nativeLogRoots);
    if ("reason" in resolved) {
      const body: SessionTranscriptRawResponse = {
        taskId,
        sessionId,
        provider: session.provider,
        found: false,
        reason: resolved.reason,
        reasonText: TRANSCRIPT_RAW_REASON_TEXT[resolved.reason],
      };
      return c.json(body);
    }

    const rangeOpts: TranscriptRawRangeOptions = {
      limit,
      ...(after !== undefined ? { after } : {}),
      ...(before !== undefined ? { before } : {}),
    };
    const range = await readTranscriptRawRange(resolved.path, session.provider, rangeOpts);
    if ("reason" in range) {
      const body: SessionTranscriptRawResponse = {
        taskId,
        sessionId,
        provider: session.provider,
        found: false,
        reason: range.reason,
        reasonText: TRANSCRIPT_RAW_REASON_TEXT[range.reason],
      };
      return c.json(body);
    }

    const unboundedBody: SessionTranscriptRawFoundResponse = {
      taskId,
      sessionId,
      provider: session.provider,
      found: true,
      startLine: range.startLine,
      endLine: range.endLine,
      totalLines: range.totalLines,
      hasMoreAfter: range.hasMoreAfter,
      hasMoreBefore: range.hasMoreBefore,
      limitedBy: range.limitedBy,
      entries: range.entries,
    };
    const body: SessionTranscriptRawResponse = fitTranscriptRawResponse(
      unboundedBody,
      after !== undefined ? "forward" : "backward",
    );
    return c.json(body);
  });

  app.get("/api/session/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId");
    const provider = normalizeProvider(c.req.query("provider"));
    const server = c.req.query("server");
    if (sessionId === "" || provider === null || server === undefined || server === "") {
      return c.json({ error: "sessionId/provider/server が不正です" }, 400);
    }

    if (server === "direct") {
      return c.json(
        {
          error: "live-view-unsupported",
          message: "direct transport のライブ閲覧は非対応です。transcript artifact を参照してください。",
        },
        501,
      );
    }

    const bridge = bridges[provider];
    // SSRF 防止: 指定 provider の既知 bridge URL と完全一致する場合のみ token を送る。
    if (server !== bridge.url) {
      return c.json({ error: "許可されていない bridge server です" }, 400);
    }

    const upstreamPath = `/api/messages?sessionId=${encodeURIComponent(sessionId)}&provider=${provider}`;
    let response: Response;
    try {
      response = await bridgeFetch(bridge, upstreamPath);
    } catch (error) {
      if (error instanceof BridgeError) {
        const body: { error: string; kind: string; status?: number } = {
          error: "bridge proxy に失敗しました",
          kind: error.kind,
        };
        if (error.status !== null) {
          body.status = error.status;
        }
        return c.json(body, 502);
      }
      return c.json({ error: "bridge token を読み込めません" }, 502);
    }

    const raw = await response.text();
    return c.body(raw, 200, {
      "Content-Type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    });
  });

  app.get("/api/task/:id", async (c) => {
    const id = c.req.param("id");
    // fail-closed: taskId 形状検証 → task 存在検証の順で行う（§14.3。artifacts 一覧生成の前段）
    if (!TASK_ID_PATTERN.test(id)) {
      return c.notFound();
    }
    const task = view.task(id);
    if (task === null) {
      return c.notFound();
    }

    const comments = view.comments(id);
    const rawEvents = view.events(id);
    const events = rawEvents.map(redactCancelEvent).map(redactCompatibilityEvent);
    const runs = view.runs(id);
    const cancelRequests = sortCancelRequestsDescending(view.cancelRequests(id)).map(summarizeCancelRequest);
    const steerDeliveries = readSteerDeliveries(view, id);
    const links = view.links(id);
    const parents: LinkWithTitle[] = links.parents.map((link) => ({
      link,
      title: view.task(link.parentId)?.title ?? link.parentId,
    }));
    const childLinks: LinkWithTitle[] = links.children.map((link) => ({
      link,
      title: view.task(link.childId)?.title ?? link.childId,
    }));
    const dependencies: TaskDependency[] = links.parents
      .filter((link) => link.linkType === "depends-on")
      .map((link) => view.task(link.parentId))
      .filter((dependency): dependency is TaskRow => dependency !== null)
      .map((dependency) => ({
        id: dependency.id,
        title: dependency.title,
        status: dependency.status,
      }));
    const artifacts = await listArtifactNames(artifactsDir, id);
    const artifactStats = await listArtifactStats(artifactsDir, id, artifacts);
    const artifactDetails = resolveArtifactAttribution({
      names: artifacts,
      stats: artifactStats,
      events: rawEvents.filter((event) => event.eventType === "artifact_attached"),
      runs,
      now: Math.floor(Date.now() / 1000),
    });

    // agent.message.v1 フェンスドブロックはコメント単位でパースし、comment.id をキーに束ねる
    // （該当ブロックが無いコメントはキーを作らない。§20.2）
    const messages: Record<number, CommentMessages> = {};
    for (const comment of comments) {
      const parsed = parseAgentMessages(comment.body);
      if (parsed.messages.length > 0 || parsed.errors.length > 0) {
        messages[comment.id] = parsed;
      }
    }

    const body: TaskDetailResponse = {
      task,
      comments,
      events,
      runs,
      cancelRequests,
      steerDeliveries,
      links: { parents, children: childLinks },
      dependencies,
      artifacts,
      artifactDetails,
      messages,
      orchestratorRequest: store.getActiveOrchestratorRequestByTask?.(id) ?? null,
      orchestratorBindings: store.listTaskOrchestratorBindings?.(id) ?? [],
    };
    return c.json(body);
  });

  async function setTaskWatch(c: Context, watched: boolean): Promise<Response> {
    const rejected = requireWriteAuth(c, writeToken);
    if (rejected !== null) {
      return rejected;
    }

    const id = c.req.param("id");
    if (id === undefined || !TASK_ID_PATTERN.test(id)) {
      return c.notFound();
    }

    try {
      const task = store.setWatched(id, watched, "human");
      const body: TaskWatchResponse = { task };
      return c.json(body);
    } catch (error) {
      return c.json({ error: parseJsonBodyError(error) }, taskNotFoundStatus(error));
    }
  }

  app.post("/api/tasks/:id/watch", (c) => setTaskWatch(c, true));
  app.delete("/api/tasks/:id/watch", (c) => setTaskWatch(c, false));

  app.get("/task/:id/artifact/:name", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");

    // fail-closed: taskId 形状検証 → task 存在検証を readdir より前に行う（§14.3。P0対応）。
    // エンコード済み ".." 等が id に入っても形状不一致で先に弾く。
    if (!TASK_ID_PATTERN.test(id)) {
      return c.notFound();
    }
    if (view.task(id) === null) {
      return c.notFound();
    }

    // fail-closed: readdir 結果と name が完全一致した場合のみ許可する（パス結合前検証）
    const names = await listArtifactNames(artifactsDir, id);
    if (!names.includes(name)) {
      return c.notFound();
    }

    // resolve 後 containment 検証（defense in depth。§14.3）
    const dir = resolve(artifactsDir, id);
    const filePath = resolve(dir, name);
    if (!filePath.startsWith(`${dir}${sep}`)) {
      return c.notFound();
    }

    try {
      const contentType = imageContentType(name);
      if (contentType !== null) {
        const raw = await readFile(filePath);
        return c.body(raw, 200, {
          "Content-Type": contentType,
          "X-Content-Type-Options": "nosniff",
        });
      }

      const raw = await readFile(filePath, "utf-8");
      return c.text(redactText(raw));
    } catch {
      return c.notFound();
    }
  });

  app.get("/api/schedules", (c) => {
    const nowMs = Date.now();
    const body: SchedulesResponse = {
      schedules: view.schedules().map((schedule) => withNextFire(schedule, nowMs)),
      now: Math.floor(nowMs / 1000),
    };
    return c.json(body);
  });

  app.get("/api/schedule-options", (c) => c.json(buildScheduleOptionsResponse(view, config)));

  app.post("/api/schedules", async (c) => {
    const rejected = requireWriteAuth(c, writeToken);
    if (rejected !== null) {
      return rejected;
    }

    let body: unknown;
    try {
      body = await c.req.json();
      const input = parseScheduleCreateBody(body);
      assertScheduleProfileAllowed(config, input.profile);
      const schedule = store.createSchedule(input, "human");
      return c.json({ schedule: withNextFire(schedule, Date.now()) }, 201);
    } catch (error) {
      return c.json({ error: parseJsonBodyError(error) }, 400);
    }
  });

  app.patch("/api/schedules/:id", async (c) => {
    const rejected = requireWriteAuth(c, writeToken);
    if (rejected !== null) {
      return rejected;
    }

    const id = c.req.param("id");
    if (!SCHEDULE_ID_PATTERN.test(id)) {
      return c.notFound();
    }

    try {
      const parsed = parseSchedulePatchBody(await c.req.json());
      assertScheduleProfileAllowed(config, parsed.patch.profile);
      const hasPatch = Object.keys(parsed.patch).length > 0;
      if (!hasPatch && parsed.enabled === undefined) {
        return c.json({ error: "更新フィールドがありません" }, 400);
      }

      let schedule: ScheduleRow | null = null;
      if (hasPatch) {
        schedule = store.updateSchedule(id, parsed.patch, "human");
      }
      if (parsed.enabled !== undefined) {
        schedule = store.setScheduleEnabled(id, parsed.enabled, "human");
      }
      if (schedule === null) {
        return c.json({ error: "更新フィールドがありません" }, 400);
      }
      return c.json({ schedule: withNextFire(schedule, Date.now()) });
    } catch (error) {
      return c.json({ error: parseJsonBodyError(error) }, scheduleNotFoundStatus(error));
    }
  });

  app.delete("/api/schedules/:id", async (c) => {
    const rejected = requireWriteAuth(c, writeToken);
    if (rejected !== null) {
      return rejected;
    }

    const id = c.req.param("id");
    if (!SCHEDULE_ID_PATTERN.test(id)) {
      return c.notFound();
    }
    try {
      store.deleteSchedule(id, "human");
      return c.json({ deleted: true, id });
    } catch (error) {
      return c.json({ error: parseJsonBodyError(error) }, scheduleNotFoundStatus(error));
    }
  });

  // ---------- メトリクス（docs/contract.md §43.2） ----------

  // §43.2: メトリクス集計用の readonly リーダー（起動時に1回だけ開く）
  let metricsReader: MetricsReader | null = null;
  if (metricsDbPath !== undefined) {
    try {
      metricsReader = new MetricsReader(metricsDbPath);
    } catch {
      // メトリクス DB が開けない場合は degrade（読み取り専用なので起動を止めない）
    }
  }

  app.get("/api/metrics", (c) => {
    if (metricsReader === null) {
      return c.json({ error: "メトリクスは未設定です" }, 503);
    }

    let periodDays: number;
    try {
      periodDays = parseMetricsDays(c.req.query("days"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const from = now - periodDays * 24 * 60 * 60;

    try {
      const data = metricsReader.query(from, now);
      return c.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `メトリクス集計に失敗しました: ${redactText(message)}` }, 500);
    }
  });

  // ---------- usage 集計（契約 §14.5.1・設計 R4/R7） ----------

  // task_runs.meta.usage の readonly リーダー（metrics と同じく起動時に1回だけ開く）。
  let usageReader: UsageReportReader | null = null;
  if (metricsDbPath !== undefined) {
    try {
      usageReader = new UsageReportReader(metricsDbPath);
    } catch {
      // DB が開けない場合は degrade（読み取り専用なので起動を止めない）
    }
  }

  app.get("/api/usage", (c) => {
    if (usageReader === null) {
      return c.json({ error: "usage 集計は未設定です" }, 503);
    }

    let periodDays: number;
    let groupBy: UsageGroupBy;
    try {
      periodDays = parseMetricsDays(c.req.query("days"));
      groupBy = parseUsageGroupBy(c.req.query("by"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const from = now - periodDays * 24 * 60 * 60;
    const tenant = c.req.query("tenant");

    try {
      const data = usageReader.query({
        from,
        to: now,
        groupBy,
        ...(tenant === undefined || tenant === "" ? {} : { tenant }),
      });
      return c.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `usage 集計に失敗しました: ${redactText(message)}` }, 500);
    }
  });

  app.get("/healthz", (c) => {
    const counts = view.counts();
    const taskCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return c.json({ ok: true, taskCount });
  });

  // ---------- supervisor 状態パネル（docs/contract.md §23。readonly 設計の唯一の例外） ----------

  app.get("/api/supervisor", (c) => {
    const body: SupervisorStatus = {
      launchd: readLaunchd(launchdLabel),
      stages: readStages(home),
      lastTick: readLastTick(home),
      killSwitchDir: home,
    };
    return c.json(body);
  });

  app.post("/api/supervisor/killswitch", async (c) => {
    const rejected = requireWriteAuth(c, writeToken);
    if (rejected !== null) {
      return rejected;
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "不正な JSON body です" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "不正な body です" }, 400);
    }
    const { stage, disabled } = body as Partial<KillSwitchRequest>;

    // fail-closed: stage は許可リスト（STAGE_NAMES）と完全一致必須（§23.2）
    if (typeof stage !== "string" || !isStageName(stage) || typeof disabled !== "boolean") {
      return c.json({ error: "stage または disabled が不正です" }, 400);
    }

    // 二重防御: path.join 後に resolve し、home 配下 containment を検証する（許可リスト一致と合わせて多重防御）
    const resolvedHome = resolve(home);
    const filePath = resolve(home, `${stage}.disabled`);
    if (filePath !== resolvedHome && !filePath.startsWith(`${resolvedHome}${sep}`)) {
      return c.json({ error: "不正なパスです" }, 400);
    }

    if (disabled) {
      writeFileSync(filePath, "", { mode: 0o600 });
    } else {
      try {
        unlinkSync(filePath);
      } catch (err: unknown) {
        // ENOENT（既に無効状態）は許容する。それ以外は想定外のためそのまま投げる
        const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
        if (code !== "ENOENT") {
          throw err;
        }
      }
    }

    const updated = readStages(home).find((s) => s.name === stage);
    return c.json(updated ?? { name: stage, disabled });
  });

  if (staticDir !== undefined) {
    const resolvedStaticDir = resolve(staticDir);

    // Vite public/ 由来の静的アセットは固定allowlistだけを配信する（サブディレクトリを含む）。
    // literal pathでのみrouteを登録し動的pathを受けないため、dist内の任意file公開やpath traversalは起こらない。
    for (const assetPath of PUBLIC_STATIC_ASSETS) {
      app.get(`/${assetPath}`, async (c) => {
        const filePath = resolve(resolvedStaticDir, assetPath);
        try {
          const data = await readFile(filePath);
          return c.body(new Uint8Array(data), 200, { "Content-Type": contentTypeFor(filePath) });
        } catch {
          return c.notFound();
        }
      });
    }

    // ビルド済みアセット（dist/assets/*）の配信。containment 検証は artifact ルートと同型
    app.get("/assets/*", async (c) => {
      const relPath = c.req.path.replace(/^\/+/, "");
      const filePath = resolve(resolvedStaticDir, relPath);
      if (filePath !== resolvedStaticDir && !filePath.startsWith(`${resolvedStaticDir}${sep}`)) {
        return c.notFound();
      }
      try {
        const data = await readFile(filePath);
        return c.body(new Uint8Array(data), 200, { "Content-Type": contentTypeFor(filePath) });
      } catch {
        return c.notFound();
      }
    });

    // SPA fallback: `/` と `/task/:id` と `/schedules` と `/sessions` と `/session/:id` と `/metrics` と `/usage` と `/settings` と `/knowledge` は index.html を返す。
    // /api・/task/:id/artifact は上で個別ルート登録済みのため、ここには到達しない。
    const serveIndexHtml = async (c: Context): Promise<Response> => {
      try {
        const html = await readFile(resolve(resolvedStaticDir, "index.html"), "utf-8");
        return c.html(html);
      } catch {
        return c.notFound();
      }
    };
    app.get("/", serveIndexHtml);
    app.get("/task/:id", serveIndexHtml);
    app.get("/schedules", serveIndexHtml);
    app.get("/sessions", serveIndexHtml);
    app.get("/session/:sessionId", serveIndexHtml);
    app.get("/metrics", serveIndexHtml);
    app.get("/usage", serveIndexHtml);
    app.get("/settings", serveIndexHtml);
    app.get("/knowledge", serveIndexHtml);
  }

  return app;
}
