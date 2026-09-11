// =============================================================================
// DB 行変換ヘルパー（snake_case → camelCase）
// SQLite の生行型（Raw*Row）と、公開型（types.ts の *Row）の変換をここに集約する。
// db.ts（書込パス・KanbanStore）と readview.ts（読取専用・KanbanReadView）の
// 両方から共有し、同じ変換ロジックの重複実装を避ける（docs/contract.md §14.4）。
// =============================================================================

import type {
  ActorKind,
  ActorProvenance,
  CommentRow,
  EventRow,
  KnowledgeRow,
  LinkRow,
  Provider,
  RunCancelRequestRow,
  RunCancelStatus,
  RunRow,
  RunStatus,
  ScheduleCadence,
  ScheduleRow,
  TaskRow,
  TaskStatus,
} from "./types.js";
import type { LessonRow, LessonTrigger } from "./lessons.js";

// ========== DB 行の生型（snake_case のまま。camelCase への変換は map*Row で行う） ==========

export interface RawTaskRow {
  id: string;
  title: string;
  body: string;
  status: string;
  priority: number;
  tenant: string;
  assignee: string;
  provider: string;
  profile: string;
  model_override: string;
  effort_override: string;
  speed_override: string;
  review_profile_override: string;
  review_provider_override: string;
  review_model_override: string;
  review_effort_override: string;
  review_speed_override: string;
  block_reason: string;
  claim_lock: string;
  watched: number;
  consecutive_failures: number;
  last_failure_error: string;
  last_heartbeat_at: number | null;
  max_retries: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface RawCommentRow {
  id: number;
  task_id: string;
  author: string;
  body: string;
  actor_kind?: string;
  actor_id?: string;
  actor_session_id?: string;
  actor_generation?: number | null;
  created_at: number;
}

export interface RawEventRow {
  id: number;
  task_id: string;
  event_type: string;
  actor: string;
  payload: string;
  actor_kind?: string;
  actor_id?: string;
  actor_session_id?: string;
  actor_generation?: number | null;
  created_at: number;
}

export interface RawRunRow {
  id: number;
  task_id: string;
  provider: string;
  session_id: string;
  status: string;
  meta: string;
  started_at: number;
  ended_at: number | null;
}

export interface RawRunCancelRequestRow {
  id: string;
  task_id: string;
  run_id: number;
  session_id: string;
  provider: string;
  status: string;
  request_nonce: string;
  actor: string;
  reason: string;
  orchestrator_id: string | null;
  requester_session_id: string;
  requester_generation: number | null;
  cancel_fence: number;
  deadline_at: number;
  acknowledged_nonce: string;
  capability_snapshot: string;
  stop_evidence: string;
  last_error: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

export interface RawLinkRow {
  id: number;
  parent_id: string;
  child_id: string;
  link_type: string;
  created_at: number;
}

export interface RawScheduleRow {
  id: string;
  name: string;
  enabled: number;
  cadence_kind: string;
  at_minute: number;
  at_hour: number;
  weekday: number | null;
  day_of_month: number | null;
  run_date: string | null;
  tenant: string;
  profile: string;
  cwd: string;
  prompt: string;
  priority: number;
  last_run_at: number | null;
  last_task_id: string | null;
  consecutive_failures: number;
  auto_disabled_reason: string;
  created_at: number;
  updated_at: number;
}

export interface RawLessonRow {
  id: number;
  created_at: number;
  trigger: string;
  tenant: string;
  cwd: string;
  profile: string;
  body: string;
  source_task_id: string;
}

export interface RawKnowledgeRow {
  id: string;
  title: string;
  body: string;
  source: string;
  tags: string;
  importance: number;
  expires_at: number | null;
  origin_path: string;
  content_hash: string;
  actor: string;
  actor_kind?: string;
  actor_id?: string;
  actor_session_id?: string;
  actor_generation?: number | null;
  created_at: number;
  updated_at: number;
}

function parseStringArrayJson(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`JSON 配列文字列が不正です: ${value}`);
  }
  return parsed;
}

export function mapTaskRow(row: RawTaskRow): TaskRow {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status as TaskStatus,
    priority: row.priority,
    tenant: row.tenant,
    assignee: row.assignee,
    provider: row.provider as Provider | "",
    profile: row.profile,
    modelOverride: row.model_override,
    effortOverride: row.effort_override as TaskRow["effortOverride"],
    speedOverride: row.speed_override as TaskRow["speedOverride"],
    reviewProfileOverride: row.review_profile_override,
    reviewProviderOverride: row.review_provider_override as TaskRow["reviewProviderOverride"],
    reviewModelOverride: row.review_model_override,
    reviewEffortOverride: row.review_effort_override as TaskRow["reviewEffortOverride"],
    reviewSpeedOverride: row.review_speed_override as TaskRow["reviewSpeedOverride"],
    blockReason: row.block_reason,
    claimLock: row.claim_lock,
    watched: row.watched === 1,
    consecutiveFailures: row.consecutive_failures,
    lastFailureError: row.last_failure_error,
    lastHeartbeatAt: row.last_heartbeat_at,
    maxRetries: row.max_retries,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapActorProvenance(row: {
  actor_kind?: string;
  actor_id?: string;
  actor_session_id?: string;
  actor_generation?: number | null;
}): ActorProvenance {
  const kind = row.actor_kind ?? "unknown";
  if (!(["human", "orchestrator", "service", "unknown"] as readonly string[]).includes(kind)) {
    throw new Error(`不正な actor_kind です: ${kind}`);
  }
  const provenance: ActorProvenance = {
    kind: kind as ActorKind,
    actorId: row.actor_id ?? "",
    actorSessionId: row.actor_session_id ?? "",
    actorGeneration: row.actor_generation ?? null,
  };
  if (provenance.actorGeneration !== null &&
      (!Number.isInteger(provenance.actorGeneration) || provenance.actorGeneration <= 0)) {
    throw new Error(`不正な actor_generation です: ${String(provenance.actorGeneration)}`);
  }
  if (provenance.kind === "unknown" &&
      (provenance.actorId !== "" || provenance.actorSessionId !== "" || provenance.actorGeneration !== null)) {
    throw new Error("unknown provenance に主体情報が混入しています");
  }
  if (provenance.kind === "human" &&
      (provenance.actorSessionId !== "" || provenance.actorGeneration !== null)) {
    throw new Error("human provenance に session/generation が混入しています");
  }
  if (provenance.kind === "service" &&
      (!/^[A-Za-z0-9._:-]+$/.test(provenance.actorId) || provenance.actorSessionId !== "" ||
       provenance.actorGeneration !== null)) {
    throw new Error("service provenance の組合せが不正です");
  }
  if (provenance.kind === "orchestrator" &&
      (provenance.actorId.trim() === "" || provenance.actorSessionId.trim() === "" ||
       provenance.actorGeneration === null)) {
    throw new Error("orchestrator provenance の組合せが不正です");
  }
  return provenance;
}

export function mapCommentRow(row: RawCommentRow): CommentRow {
  return {
    id: row.id,
    taskId: row.task_id,
    author: row.author,
    body: row.body,
    provenance: mapActorProvenance(row),
    createdAt: row.created_at,
  };
}

export function mapEventRow(row: RawEventRow): EventRow {
  return {
    id: row.id,
    taskId: row.task_id,
    eventType: row.event_type,
    actor: row.actor,
    payload: row.payload,
    provenance: mapActorProvenance(row),
    createdAt: row.created_at,
  };
}

export function mapRunRow(row: RawRunRow): RunRow {
  return {
    id: row.id,
    taskId: row.task_id,
    provider: row.provider as Provider,
    sessionId: row.session_id,
    status: row.status as RunStatus,
    meta: row.meta,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export function mapRunCancelRequestRow(row: RawRunCancelRequestRow): RunCancelRequestRow {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    sessionId: row.session_id,
    provider: row.provider as Provider,
    status: row.status as RunCancelStatus,
    requestNonce: row.request_nonce,
    actor: row.actor,
    reason: row.reason,
    orchestratorId: row.orchestrator_id ?? "",
    requesterSessionId: row.requester_session_id,
    requesterGeneration: row.requester_generation,
    cancelFence: row.cancel_fence,
    deadlineAt: row.deadline_at,
    acknowledgedNonce: row.acknowledged_nonce,
    capabilitySnapshot: row.capability_snapshot,
    stopEvidence: row.stop_evidence,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

export function mapLinkRow(row: RawLinkRow): LinkRow {
  return {
    id: row.id,
    parentId: row.parent_id,
    childId: row.child_id,
    linkType: row.link_type,
    createdAt: row.created_at,
  };
}

export function mapScheduleRow(row: RawScheduleRow): ScheduleRow {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    cadenceKind: row.cadence_kind as ScheduleCadence,
    atMinute: row.at_minute,
    atHour: row.at_hour,
    weekday: row.weekday,
    dayOfMonth: row.day_of_month,
    runDate: row.run_date,
    tenant: row.tenant,
    profile: row.profile,
    cwd: row.cwd,
    prompt: row.prompt,
    priority: row.priority,
    lastRunAt: row.last_run_at,
    lastTaskId: row.last_task_id,
    consecutiveFailures: row.consecutive_failures,
    autoDisabledReason: row.auto_disabled_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapLessonRow(row: RawLessonRow): LessonRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    trigger: row.trigger as LessonTrigger,
    tenant: row.tenant,
    cwd: row.cwd,
    profile: row.profile,
    body: row.body,
    sourceTaskId: row.source_task_id,
  };
}

export function mapKnowledgeRow(row: RawKnowledgeRow): KnowledgeRow {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    source: row.source,
    tags: parseStringArrayJson(row.tags),
    importance: row.importance,
    expiresAt: row.expires_at,
    originPath: row.origin_path,
    contentHash: row.content_hash,
    actor: row.actor,
    provenance: mapActorProvenance(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
