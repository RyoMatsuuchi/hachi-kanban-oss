// =============================================================================
// KanbanReadView（読み取り専用クエリ面。docs/contract.md §14.4）
// @hachi/web 等はこれのみを使い、生 SQL を発行しない（§5 の単一書込パス原則の読み取り版）。
// KanbanStore（書込パス）とは接続を分ける readonly 接続で、journal_mode 変更・migration・
// integrity_check・書き込みは一切行わない。
// =============================================================================

import { isAbsolute } from "node:path";
import Database from "better-sqlite3";
import {
  mapCommentRow,
  mapEventRow,
  mapKnowledgeRow,
  mapLinkRow,
  mapRunCancelRequestRow,
  mapRunRow,
  mapScheduleRow,
  mapTaskRow,
  type RawCommentRow,
  type RawEventRow,
  type RawKnowledgeRow,
  type RawLinkRow,
  type RawRunCancelRequestRow,
  type RawRunRow,
  type RawScheduleRow,
  type RawTaskRow,
} from "./row-mapping.js";
import type { KnowledgeListOptions } from "./db.js";
import {
  HUMAN_DECISION_STATUSES,
  HumanDecisionError,
  assertHumanDecisionInputKeys,
  mapHumanDecisionRequestRow,
  requireHumanDecisionLimit,
  requireHumanDecisionText,
  type HumanDecisionReadView,
  type HumanDecisionRequestRow,
  type HumanDecisionStatus,
  type ListHumanDecisionRequestsOptions,
  type ListHumanDecisionResponsesOptions,
  type RawHumanDecisionRequestRow,
} from "./human-decision.js";
import {
  EXTERNAL_RUNTIME_GENERATION_LANES,
  canonicalJson,
  parseExternalRuntimeGenerationStatus,
  validateExternalRuntimeGenerationIdentity,
  type ExternalRuntimeGenerationBindingV1,
  type ExternalRuntimeGenerationReadView,
  type ExternalRuntimeGenerationStatusRecord,
} from "./external-runtime-generation.js";
import { redactRuntimeObservationText } from "./model-transport-observability.js";
import {
  extractDeliveryWorktreeFromBody,
  resolveOrchestratorDeliveryTargets,
} from "./orchestrator-scope.js";
import {
  mapRelayDeliveryUncertainEventRow,
  requireRelayDeliveryUncertainEventsLimit,
  type RawRelayDeliveryUncertainEventRow,
  type RelayDeliveryUncertainEventsQuery,
  type RelayDeliveryUncertainReadView,
  type RelayDeliveryUncertainRecord,
} from "./relay-control-persistence.js";
import type {
  DurableSteerReadView,
  SteerDeliveryReadModel,
  SteerDeliveryStatus,
  SteerDeliveryTargetState,
} from "./steer.js";
import {
  TASK_STATUSES,
  type CommentRow,
  type EventRow,
  type KanbanReadView,
  type KnowledgeRow,
  type LinkRow,
  type Provider,
  type RunCancelRequestRow,
  type RunRow,
  type RunningSession,
  type ScheduleFormOptions,
  type ScheduleRow,
  type TaskRow,
  type TaskStatus,
  type VisibilityBucket,
} from "./types.js";

/** readonly factory が提供する既存/additive capability の実体型。 */
export interface KanbanReadViewCapabilities extends
  KanbanReadView,
  DurableSteerReadView,
  ExternalRuntimeGenerationReadView,
  RelayDeliveryUncertainReadView,
  HumanDecisionReadView {
  listKnowledge(options?: KnowledgeListOptions): KnowledgeRow[];
  isOrchestratorScopedToTask(orchestratorId: string, taskId: string): boolean;
}

interface RawExternalRuntimeGenerationStatusReadRow {
  provider: string;
  lane: string;
  runtime_key: string;
  revision: number;
  canonical_digest: string;
  canonical_payload: string;
  accepted_at: number;
}

interface RawExternalRuntimeGenerationBindingReadRow {
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

interface RawBoardMetadataRow {
  singleton: number;
  board_instance_id: string;
}

function mapExternalRuntimeGenerationStatusReadRow(
  row: RawExternalRuntimeGenerationStatusReadRow,
): ExternalRuntimeGenerationStatusRecord {
  if (row.provider !== "codex" && row.provider !== "claude") {
    throw new Error("external runtime generation read view provider が不正です");
  }
  const parsed = parseExternalRuntimeGenerationStatus(row.canonical_payload, row.provider);
  if (
    parsed.status.lane !== row.lane || parsed.status.runtimeKey !== row.runtime_key ||
    parsed.status.revision !== row.revision || parsed.canonicalDigest !== row.canonical_digest ||
    !Number.isSafeInteger(row.accepted_at) || row.accepted_at < 0
  ) {
    throw new Error("external runtime generation read view status が不整合です");
  }
  return { ...parsed, acceptedAt: row.accepted_at };
}

function mapExternalRuntimeGenerationBindingReadRow(
  row: RawExternalRuntimeGenerationBindingReadRow,
): ExternalRuntimeGenerationBindingV1 {
  if (
    row.version !== 1 || (row.provider !== "codex" && row.provider !== "claude") ||
    (row.role !== "worker" && row.role !== "reviewer") ||
    (row.transport !== "bridge" && row.transport !== "direct")
  ) {
    throw new Error("external runtime generation read view binding が不正です");
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
    throw new Error("external runtime generation read view identity がcanonicalではありません");
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

interface RawSteerDeliveryReadRow {
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

interface CurrentSteerRunRow {
  id: number;
  task_id: string;
  session_id: string;
}

interface RunCancelFenceRow {
  run_id: number;
  cancel_fence: number;
}

interface SessionEndedEventRow {
  task_id: string;
  payload: string;
}

/** 人間の判断を待つ block_reason prefix（docs/contract.md §14.4, §36）。 */
export const HUMAN_DECISION_QUEUE_PREFIXES = [
  "user-decision:",
  "user-feedback:",
  "user-question:",
] as const;

/** オーケストレーターが回収する block_reason prefix（docs/contract.md §14.4, §36）。 */
export const ORCHESTRATOR_RECOVERY_QUEUE_PREFIXES = [
  "review-required:",
  "needs-manual:",
  "auto-launch-failed:",
  "worker-question:",
] as const;

/**
 * 従来 human_queue を構成する block_reason prefix。
 * auto-launch-failed は retry_pending としても扱うため、互換維持のためこの合算には含めない。
 */
export const HUMAN_QUEUE_PREFIXES = [
  ...HUMAN_DECISION_QUEUE_PREFIXES,
  "review-required:",
  "needs-manual:",
  "worker-question:",
] as const;

export type HumanQueueLane = "human_decision" | "orchestrator_recovery";

/**
 * block_reason を人間確認キュー内の対応主体へ分類する。
 * 未知 prefix はユーザーに判断を求めず、オーケストレーター回収待ちへ倒す（fail-closed）。
 */
export function humanQueueLaneOfReason(reason: string): HumanQueueLane {
  if (HUMAN_DECISION_QUEUE_PREFIXES.some((prefix) => reason.startsWith(prefix))) {
    return "human_decision";
  }
  return "orchestrator_recovery";
}

/** 自律進行中を構成する block_reason prefix（docs/contract.md §14.4） */
const IN_PROGRESS_PREFIXES = ["codex-in-progress:", "claude-in-progress:"] as const;

/** retry_pending を構成する block_reason prefix（docs/contract.md §14.4） */
const RETRY_PENDING_PREFIX = "auto-launch-failed:";

interface RunningSessionRow {
  task_id: string;
  task_title: string;
  task_status: string;
  task_tenant: string;
  provider: string;
  session_id: string;
  status: string;
  meta: string;
  started_at: number;
}

interface RunningSessionMeta {
  model: string;
  transport: string;
  serverUrl: string;
  role: RunningSession["role"];
  /** プロファイル由来の推論エフォート（未指定時 null） */
  effort: string | null;
  /** エフォート配信方式（未指定時 null） */
  effortDelivery: string | null;
  /** runtimeへ要求した処理速度（未指定時 null） */
  speed: string | null;
  /** 処理速度設定の配信方式（未指定時 null） */
  speedDelivery: string | null;
}

interface CwdUsage {
  cwd: string;
  usedAt: number;
  sequence: number;
}

interface ScheduleCwdRow {
  cwd: string;
  used_at: number;
}

interface TaskBodyCwdRow {
  body: string;
  used_at: number;
}

interface TenantOptionRow {
  tenant: string;
}

/** task_runs.meta から Web 表示用の session 由来フィールドを取り出す（壊れた JSON は空扱い） */
function parseRunningSessionMeta(meta: string): RunningSessionMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(meta);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      model: "",
      transport: "",
      serverUrl: "",
      role: "worker",
      effort: null,
      effortDelivery: null,
      speed: null,
      speedDelivery: null,
    };
  }
  const record = parsed as Record<string, unknown>;
  return {
    model: typeof record.model === "string" ? record.model : "",
    transport: typeof record.transport === "string" ? record.transport : "",
    serverUrl: typeof record.serverUrl === "string" ? record.serverUrl : "",
    role: record.role === "reviewer" ? "reviewer" : "worker",
    effort: typeof record.effort === "string" ? record.effort : null,
    effortDelivery: typeof record.effortDelivery === "string" ? record.effortDelivery : null,
    speed: typeof record.speed === "string" ? record.speed : null,
    speedDelivery: typeof record.speedDelivery === "string" ? record.speedDelivery : null,
  };
}

function isProvider(value: string): value is Provider {
  return value === "codex" || value === "claude";
}

function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

function requirePositiveLimit(value: number | undefined): number {
  if (value === undefined) {
    return 20;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("limit は 1 以上の整数が必須です");
  }
  return value;
}

function requireNonEmptyOption(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(`${label} は空でない文字列が必須です`);
  }
  return trimmed;
}

/** SQLite LIKE のワイルドカードをリテラル検索にする */
function escapeLikePattern(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function sessionStateFromStatus(status: string): RunningSession["state"] {
  return status === "running" ? "running" : "ended";
}

function mapRunningSessionRow(row: RunningSessionRow): RunningSession | null {
  if (!isProvider(row.provider) || !isTaskStatus(row.task_status)) {
    return null;
  }
  const meta = parseRunningSessionMeta(row.meta);
  return {
    taskId: row.task_id,
    taskTitle: row.task_title,
    taskStatus: row.task_status,
    tenant: row.task_tenant,
    provider: row.provider,
    model: meta.model,
    transport: meta.transport,
    sessionId: row.session_id,
    serverUrl: meta.serverUrl,
    startedAt: row.started_at,
    state: sessionStateFromStatus(row.status),
    role: meta.role,
    effort: meta.effort,
    effortDelivery: meta.effortDelivery,
    speed: meta.speed,
    speedDelivery: meta.speedDelivery,
  };
}

function parseTaskBodyCwd(body: string): string | null {
  const newlineIndex = body.indexOf("\n");
  const rawFirstLine = newlineIndex === -1 ? body : body.slice(0, newlineIndex);
  const firstLine = rawFirstLine.endsWith("\r") ? rawFirstLine.slice(0, -1) : rawFirstLine;
  const match = /^cwd:\s+(.+)$/.exec(firstLine);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const cwd = match[1].trim();
  if (!isAbsolute(cwd)) {
    return null;
  }
  return cwd;
}

function recordCwdUsage(usages: Map<string, CwdUsage>, cwd: string, usedAt: number, sequence: number): void {
  if (!isAbsolute(cwd)) {
    return;
  }
  const current = usages.get(cwd);
  if (current === undefined || usedAt > current.usedAt || (usedAt === current.usedAt && sequence > current.sequence)) {
    usages.set(cwd, { cwd, usedAt, sequence });
  }
}

class SqliteKanbanReadView implements KanbanReadViewCapabilities {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    // readonly + fileMustExist: 存在しない DB を新規作成してしまわないよう fail-closed にする。
    // journal_mode の変更や migration・integrity_check は行わない（§14.1 の方針）。
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.db.pragma("busy_timeout = 5000");
  }

  isOrchestratorScopedToTask(orchestratorId: string, taskId: string): boolean {
    const orchestrator = this.db.prepare(`SELECT 1 FROM orchestrators WHERE id = ?`).get(orchestratorId);
    if (orchestrator === undefined) {
      throw new Error(`orchestrator が見つかりません: ${orchestratorId}`);
    }
    const task = this.db.prepare(`SELECT id, body, tenant FROM tasks WHERE id = ?`).get(taskId) as
      | Pick<RawTaskRow, "id" | "body" | "tenant">
      | undefined;
    if (task === undefined) {
      throw new Error(`タスクが見つかりません: ${taskId}`);
    }
    return resolveOrchestratorDeliveryTargets(this.db, {
      taskId: task.id,
      worktree: extractDeliveryWorktreeFromBody(task.body),
      project: task.tenant,
    }).has(orchestratorId);
  }

  private assertHumanDecisionSchema(): void {
    const applied = this.db.prepare(`SELECT 1 FROM schema_migrations WHERE version = 32`).get();
    const table = this.db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'human_decision_requests'`,
    ).get();
    if (applied === undefined || table === undefined) {
      throw new HumanDecisionError("SCHEMA_UNAVAILABLE", "migration v32が未適用です");
    }
  }

  getHumanDecisionRequest(id: string): HumanDecisionRequestRow | null {
    this.assertHumanDecisionSchema();
    const requestId = requireHumanDecisionText(id, "requestId", 128);
    const row = this.db.prepare(`SELECT * FROM human_decision_requests WHERE id = ?`).get(requestId) as
      | RawHumanDecisionRequestRow
      | undefined;
    return row === undefined ? null : mapHumanDecisionRequestRow(row);
  }

  listHumanDecisionRequests(options: ListHumanDecisionRequestsOptions = {}): HumanDecisionRequestRow[] {
    this.assertHumanDecisionSchema();
    const record = assertHumanDecisionInputKeys(options, ["taskId", "tenant", "statuses", "limit"], "list options");
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (record.taskId !== undefined) {
      conditions.push("h.task_id = ?");
      parameters.push(requireHumanDecisionText(record.taskId, "taskId", 128));
    }
    if (record.tenant !== undefined) {
      conditions.push("t.tenant = ?");
      parameters.push(requireHumanDecisionText(record.tenant, "tenant", 128));
    }
    if (record.statuses !== undefined) {
      if (!Array.isArray(record.statuses)) {
        throw new HumanDecisionError("INVALID_INPUT", "statusesは配列が必須です");
      }
      const statuses = record.statuses as unknown[];
      for (const status of statuses) {
        if (!HUMAN_DECISION_STATUSES.includes(status as HumanDecisionStatus)) {
          throw new HumanDecisionError("INVALID_INPUT", `未知のstatusです: ${String(status)}`);
        }
      }
      if (statuses.length === 0) {
        conditions.push("0");
      } else {
        conditions.push(`h.status IN (${statuses.map(() => "?").join(", ")})`);
        parameters.push(...(statuses as string[]));
      }
    }
    const limit = requireHumanDecisionLimit(record.limit);
    const sql = `SELECT h.* FROM human_decision_requests h
      INNER JOIN tasks t ON t.id = h.task_id
      ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
      ORDER BY h.created_at ASC, h.id ASC${limit === undefined ? "" : " LIMIT ?"}`;
    if (limit !== undefined) parameters.push(limit);
    const rows = this.db.prepare(sql).all(...parameters) as RawHumanDecisionRequestRow[];
    return rows.map(mapHumanDecisionRequestRow);
  }

  listHumanDecisionResponses(options: ListHumanDecisionResponsesOptions): HumanDecisionRequestRow[] {
    this.assertHumanDecisionSchema();
    const record = assertHumanDecisionInputKeys(options, ["ownerOrchestratorId", "limit"], "response options");
    const ownerId = requireHumanDecisionText(record.ownerOrchestratorId, "ownerOrchestratorId", 128);
    const limit = requireHumanDecisionLimit(record.limit);
    const sql = `SELECT * FROM human_decision_requests
      WHERE owner_orchestrator_id = ? AND status IN ('answered', 'claimed')
      ORDER BY answered_at ASC, id ASC${limit === undefined ? "" : " LIMIT ?"}`;
    const rows = (limit === undefined
      ? this.db.prepare(sql).all(ownerId)
      : this.db.prepare(sql).all(ownerId, limit)) as RawHumanDecisionRequestRow[];
    return rows.map(mapHumanDecisionRequestRow);
  }

  externalRuntimeGenerationStatus(provider: Provider): ExternalRuntimeGenerationStatusRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM external_runtime_generation_statuses WHERE provider = ?`,
    ).get(provider) as RawExternalRuntimeGenerationStatusReadRow | undefined;
    return row === undefined ? null : mapExternalRuntimeGenerationStatusReadRow(row);
  }

  externalRuntimeGenerationBinding(runId: number): ExternalRuntimeGenerationBindingV1 | null {
    const row = this.db.prepare(
      `SELECT * FROM external_runtime_generation_bindings WHERE run_id = ?`,
    ).get(runId) as RawExternalRuntimeGenerationBindingReadRow | undefined;
    return row === undefined ? null : mapExternalRuntimeGenerationBindingReadRow(row);
  }

  relayDeliveryUncertainEvent(sessionId: string, eventId: string): RelayDeliveryUncertainRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM relay_delivery_uncertain_events
       WHERE session_id = ? COLLATE BINARY AND event_id = ? COLLATE BINARY`,
    ).get(sessionId, eventId) as RawRelayDeliveryUncertainEventRow | undefined;
    return row === undefined ? null : mapRelayDeliveryUncertainEventRow(row);
  }

  relayDeliveryUncertainEvents(query: RelayDeliveryUncertainEventsQuery = {}): RelayDeliveryUncertainRecord[] {
    const limit = requireRelayDeliveryUncertainEventsLimit(query.limit);
    const rows = (
      query.sessionId === undefined
        ? this.db.prepare(
            `SELECT * FROM relay_delivery_uncertain_events
             ORDER BY recorded_at DESC, session_id COLLATE BINARY ASC, event_id COLLATE BINARY ASC
             LIMIT ?`,
          ).all(limit)
        : this.db.prepare(
            `SELECT * FROM relay_delivery_uncertain_events
             WHERE session_id = ? COLLATE BINARY
             ORDER BY recorded_at DESC, session_id COLLATE BINARY ASC, event_id COLLATE BINARY ASC
             LIMIT ?`,
          ).all(query.sessionId, limit)
    ) as RawRelayDeliveryUncertainEventRow[];
    return rows.map(mapRelayDeliveryUncertainEventRow);
  }

  tenants(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT tenant FROM tasks ORDER BY tenant ASC`).all() as Array<{
      tenant: string;
    }>;
    return rows.map((row) => row.tenant);
  }

  runningSessions(): RunningSession[] {
    const rows = this.db
      .prepare(
        `SELECT
           r.task_id,
           t.title AS task_title,
           t.status AS task_status,
           t.tenant AS task_tenant,
           r.provider,
           r.session_id,
           r.status,
           r.meta,
           r.started_at
         FROM task_runs r
         INNER JOIN tasks t ON t.id = r.task_id
         WHERE r.status = 'running'
         ORDER BY r.started_at DESC, r.id DESC`,
      )
      .all() as RunningSessionRow[];

    return rows.map(mapRunningSessionRow).filter((session): session is RunningSession => session !== null);
  }

  recentSessions(limit: number): RunningSession[] {
    if (!Number.isFinite(limit) || limit <= 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT
           r.task_id,
           t.title AS task_title,
           t.status AS task_status,
           t.tenant AS task_tenant,
           r.provider,
           r.session_id,
           r.status,
           r.meta,
           r.started_at
         FROM task_runs r
         INNER JOIN tasks t ON t.id = r.task_id
         WHERE r.status IN ('done', 'failed', 'released', 'stopped')
         ORDER BY r.started_at DESC, r.id DESC
         LIMIT ?`,
      )
      .all(Math.trunc(limit)) as RunningSessionRow[];

    return rows.map(mapRunningSessionRow).filter((session): session is RunningSession => session !== null);
  }

  runningSession(sessionId: string): RunningSession | null {
    if (sessionId === "") {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT
           r.task_id,
           t.title AS task_title,
           t.status AS task_status,
           t.tenant AS task_tenant,
           r.provider,
           r.session_id,
           r.status,
           r.meta,
           r.started_at
         FROM task_runs r
         INNER JOIN tasks t ON t.id = r.task_id
         WHERE r.session_id = ?
         ORDER BY CASE WHEN r.status = 'running' THEN 0 ELSE 1 END, r.started_at DESC, r.id DESC
         LIMIT 1`,
      )
      .get(sessionId) as RunningSessionRow | undefined;

    return row === undefined ? null : mapRunningSessionRow(row);
  }

  schedules(): ScheduleRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM schedules ORDER BY created_at ASC, rowid ASC`)
      .all() as RawScheduleRow[];
    return rows.map(mapScheduleRow);
  }

  schedule(id: string): ScheduleRow | null {
    const row = this.db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as RawScheduleRow | undefined;
    return row === undefined ? null : mapScheduleRow(row);
  }

  listKnowledge(options: KnowledgeListOptions = {}): KnowledgeRow[] {
    const limit = requirePositiveLimit(options.limit);
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (options.source !== undefined) {
      clauses.push("source = ?");
      params.push(requireNonEmptyOption(options.source, "source"));
    }
    if (options.tag !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(knowledge.tags) WHERE value = ?)");
      params.push(requireNonEmptyOption(options.tag, "tag"));
    }
    if (options.search !== undefined) {
      const pattern = `%${escapeLikePattern(requireNonEmptyOption(options.search, "search"))}%`;
      clauses.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }
    if (options.includeExpired !== true) {
      clauses.push("(expires_at IS NULL OR expires_at >= ?)");
      params.push(Math.floor(Date.now() / 1000));
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

  scheduleFormOptions(): ScheduleFormOptions {
    const cwdUsages = new Map<string, CwdUsage>();
    let sequence = 0;

    const scheduleRows = this.db
      .prepare(
        `SELECT cwd, updated_at AS used_at
         FROM schedules
         WHERE cwd != ''
         ORDER BY updated_at ASC, rowid ASC`,
      )
      .all() as ScheduleCwdRow[];
    for (const row of scheduleRows) {
      sequence += 1;
      recordCwdUsage(cwdUsages, row.cwd, row.used_at, sequence);
    }

    const taskRows = this.db
      .prepare(
        `SELECT body, updated_at AS used_at
         FROM tasks
         WHERE body LIKE 'cwd:%'
         ORDER BY updated_at ASC, id ASC`,
      )
      .all() as TaskBodyCwdRow[];
    for (const row of taskRows) {
      const cwd = parseTaskBodyCwd(row.body);
      if (cwd === null) {
        continue;
      }
      sequence += 1;
      recordCwdUsage(cwdUsages, cwd, row.used_at, sequence);
    }

    const tenants = this.db
      .prepare(
        `SELECT tenant FROM tasks WHERE tenant != ''
         UNION
         SELECT tenant FROM schedules WHERE tenant != ''
         ORDER BY tenant ASC`,
      )
      .all() as TenantOptionRow[];

    return {
      cwds: [...cwdUsages.values()]
        .sort((a, b) => b.usedAt - a.usedAt || b.sequence - a.sequence)
        .map((usage) => usage.cwd),
      tenants: tenants.map((row) => row.tenant),
    };
  }

  counts(tenant?: string): Record<TaskStatus, number> {
    const base = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<TaskStatus, number>;
    const rows = (
      tenant !== undefined
        ? this.db.prepare(`SELECT status, COUNT(*) AS count FROM tasks WHERE tenant = ? GROUP BY status`).all(tenant)
        : this.db.prepare(`SELECT status, COUNT(*) AS count FROM tasks GROUP BY status`).all()
    ) as Array<{ status: string; count: number }>;
    for (const row of rows) {
      if ((TASK_STATUSES as readonly string[]).includes(row.status)) {
        base[row.status as TaskStatus] = row.count;
      }
    }
    return base;
  }

  humanQueue(tenant?: string): TaskRow[] {
    const prefixConditions = HUMAN_QUEUE_PREFIXES.map(() => `block_reason LIKE ?`).join(" OR ");
    const likeParams: string[] = HUMAN_QUEUE_PREFIXES.map((prefix) => `${prefix}%`);
    const tenantClause = tenant !== undefined ? ` AND tenant = ?` : "";
    const params: string[] = tenant !== undefined ? [...likeParams, tenant] : likeParams;

    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'blocked' AND (${prefixConditions})${tenantClause}
         ORDER BY priority DESC, updated_at ASC`,
      )
      .all(...params) as RawTaskRow[];
    return rows.map(mapTaskRow);
  }

  inProgress(tenant?: string): TaskRow[] {
    const prefixConditions = IN_PROGRESS_PREFIXES.map(() => `block_reason LIKE ?`).join(" OR ");
    const likeParams: string[] = IN_PROGRESS_PREFIXES.map((prefix) => `${prefix}%`);
    const tenantClause = tenant !== undefined ? ` AND tenant = ?` : "";
    const params: string[] = tenant !== undefined ? [...likeParams, tenant] : likeParams;

    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'blocked' AND (${prefixConditions})${tenantClause}
         ORDER BY updated_at DESC`,
      )
      .all(...params) as RawTaskRow[];
    return rows.map(mapTaskRow);
  }

  byStatus(status: TaskStatus, tenant?: string, limit?: number): TaskRow[] {
    const conditions = [`status = ?`];
    const params: Array<string | number> = [status];
    if (tenant !== undefined) {
      conditions.push(`tenant = ?`);
      params.push(tenant);
    }
    const limitClause = limit !== undefined ? ` LIMIT ?` : "";
    if (limit !== undefined) {
      params.push(limit);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE ${conditions.join(" AND ")}
         ORDER BY priority DESC, updated_at DESC${limitClause}`,
      )
      .all(...params) as RawTaskRow[];
    return rows.map(mapTaskRow);
  }

  /**
   * タスク1件の可視性分類（docs/contract.md §14.4）。
   * status='blocked' の場合のみ block_reason の prefix で人間確認キュー / 自律進行中 / retry / その他へ
   * 細分類する。blocked 以外は status をそのまま返す。
   */
  bucketOf(task: TaskRow): VisibilityBucket {
    if (task.status !== "blocked") {
      return task.status;
    }
    const reason = task.blockReason;
    if (HUMAN_QUEUE_PREFIXES.some((prefix) => reason.startsWith(prefix))) {
      return "human_queue";
    }
    if (IN_PROGRESS_PREFIXES.some((prefix) => reason.startsWith(prefix))) {
      return "autonomous_in_progress";
    }
    if (reason.startsWith(RETRY_PENDING_PREFIX)) {
      return "retry_pending";
    }
    return "blocked_other";
  }

  task(id: string): TaskRow | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as RawTaskRow | undefined;
    return row === undefined ? null : mapTaskRow(row);
  }

  /**
   * タスクのコメントを時系列（作成順）で返す（KanbanStore.listComments と同セマンティクス）。
   * limit 省略時は全件を作成順（古い→新しい）で返す。limit 指定時は「新しい方から limit 件」を
   * 意味する。DB からは DESC + LIMIT で新しい順に取得し、返却前に ASC へ反転する。
   */
  comments(taskId: string, limit?: number): CommentRow[] {
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

  /**
   * タスクのイベントを時系列（記録順）で返す（KanbanStore.listEvents と同セマンティクス）。
   * limit 省略時は全件を記録順（古い→新しい）で返す。limit 指定時は「新しい方から limit 件」を
   * 意味する。DB からは DESC + LIMIT で新しい順に取得し、返却前に ASC へ反転する。
   */
  events(taskId: string, limit?: number): EventRow[] {
    if (limit === undefined) {
      const rows = this.db
        .prepare(`SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC, id ASC`)
        .all(taskId) as RawEventRow[];
      return rows.map(mapEventRow);
    }
    const rows = this.db
      .prepare(`SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(taskId, limit) as RawEventRow[];
    return rows.reverse().map(mapEventRow);
  }

  runs(taskId: string): RunRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC, id DESC`)
      .all(taskId) as RawRunRow[];
    return rows.map(mapRunRow);
  }

  cancelRequests(taskId: string): RunCancelRequestRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM run_cancel_requests WHERE task_id = ? ORDER BY created_at ASC, id ASC`)
      .all(taskId) as RawRunCancelRequestRow[];
    return rows.map(mapRunCancelRequestRow);
  }

  steerDeliveries(taskId?: string): SteerDeliveryReadModel[] {
    const rows = (taskId === undefined
      ? this.db.prepare(`SELECT * FROM steer_deliveries ORDER BY run_id, sequence, id`).all()
      : this.db.prepare(
        `SELECT * FROM steer_deliveries WHERE task_id = ? ORDER BY run_id, sequence, id`,
      ).all(taskId)) as RawSteerDeliveryReadRow[];
    if (rows.length === 0) {
      return [];
    }

    const currentRuns = this.db.prepare(
      `SELECT id, task_id, session_id
       FROM task_runs
       WHERE status = 'running'
       ORDER BY task_id ASC, started_at DESC, id DESC`,
    ).all() as CurrentSteerRunRow[];
    const currentRunByTask = new Map<string, CurrentSteerRunRow>();
    for (const run of currentRuns) {
      if (!currentRunByTask.has(run.task_id)) {
        currentRunByTask.set(run.task_id, run);
      }
    }

    const fenceRows = this.db.prepare(
      `SELECT run_id, MAX(cancel_fence) AS cancel_fence
       FROM run_cancel_requests
       GROUP BY run_id`,
    ).all() as RunCancelFenceRow[];
    const fenceByRun = new Map(fenceRows.map((row) => [row.run_id, row.cancel_fence]));

    const endedRows = this.db.prepare(
      `SELECT task_id, payload FROM task_events WHERE event_type = 'session_ended'`,
    ).all() as SessionEndedEventRow[];
    const endedSessions = new Set<string>();
    for (const event of endedRows) {
      try {
        const payload = JSON.parse(event.payload) as unknown;
        if (
          typeof payload === "object" && payload !== null && !Array.isArray(payload) &&
          typeof (payload as Record<string, unknown>)["sessionId"] === "string"
        ) {
          endedSessions.add(`${event.task_id}\u0000${String((payload as Record<string, unknown>)["sessionId"])}`);
        }
      } catch {
        // 壊れた監査payloadからsession終了を推測せず、他の正規行の表示を継続する。
      }
    }

    return rows.map((row): SteerDeliveryReadModel => {
      const currentRun = currentRunByTask.get(row.task_id);
      const runCancelFence = fenceByRun.get(row.run_id) ?? 0;
      let targetState: SteerDeliveryTargetState;
      if (currentRun === undefined || currentRun.id !== row.run_id) {
        targetState = "stale_run";
      } else if (
        currentRun.session_id !== row.session_id ||
        endedSessions.has(`${row.task_id}\u0000${row.session_id}`)
      ) {
        targetState = "stale_session";
      } else if (runCancelFence !== row.expected_cancel_fence) {
        targetState = "stale_cancel_fence";
      } else {
        targetState = "current";
      }
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
        lastError: redactRuntimeObservationText(row.last_error),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        observedAt: row.observed_at,
        acknowledgedAt: row.acknowledged_at,
        resolvedAt: row.resolved_at,
        targetState,
        currentRunId: currentRun?.id ?? null,
        currentSessionId: currentRun?.session_id ?? null,
        runCancelFence,
      };
    });
  }

  /**
   * 親子リンク（docs/contract.md §14.4）。
   * parents: 自分が child の行（task_links.child_id = taskId）。自分の親タスクを指す
   * children: 自分が parent の行（task_links.parent_id = taskId）。自分の子タスクを指す
   */
  links(taskId: string): { parents: LinkRow[]; children: LinkRow[] } {
    const parentRows = this.db
      .prepare(`SELECT * FROM task_links WHERE child_id = ? ORDER BY created_at ASC`)
      .all(taskId) as RawLinkRow[];
    const childRows = this.db
      .prepare(`SELECT * FROM task_links WHERE parent_id = ? ORDER BY created_at ASC`)
      .all(taskId) as RawLinkRow[];
    return { parents: parentRows.map(mapLinkRow), children: childRows.map(mapLinkRow) };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * KanbanReadView の factory（docs/contract.md §14.4）。
 * better-sqlite3 を readonly + fileMustExist で開く（存在しない DB を作成しない fail-closed）。
 * busy_timeout=5000 のみ設定し、journal_mode 変更・migration・integrity_check・書き込みは行わない。
 * この factory 名は @hachi/web 等の他パッケージとの取り決めであり変更しない。
 */
export function createKanbanReadView(dbPath: string): KanbanReadViewCapabilities {
  return new SqliteKanbanReadView(dbPath);
}

/** contract §50.1.1 の board instance 識別子を readonly 接続で返す。 */
export function readBoardInstanceId(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    const rows = db.prepare(
      `SELECT singleton, board_instance_id FROM board_metadata ORDER BY singleton`,
    ).all() as RawBoardMetadataRow[];
    const row = rows[0];
    if (rows.length !== 1 || row === undefined || row.singleton !== 1 || !/^[0-9a-f]{32}$/.test(row.board_instance_id)) {
      throw new Error("board metadata の boardInstanceId が不正または欠落しています");
    }
    return row.board_instance_id;
  } finally {
    db.close();
  }
}
