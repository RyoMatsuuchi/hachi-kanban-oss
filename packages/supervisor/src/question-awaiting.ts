// worker question のライブ待機状態を task_events から判定するヘルパー（docs/contract.md §52.4）。
import type { EventRow, KanbanStore, RunRow, TaskRow } from "@hachi/core";
import { extractSessionEndedResultWatermark } from "./session-ref.js";

export const QUESTION_AWAITING_EVENT_TYPE = "question_awaiting";
export const QUESTION_EXPIRED_EVENT_TYPE = "question_expired";
export const QUESTION_ANSWERING_EVENT_TYPE = "question_answering";
export const QUESTION_ANSWERING_RELEASED_EVENT_TYPE = "question_answering_released";

export interface QuestionAwaitingPayload {
  sessionId: string;
  baselineResultCount: number;
  baselineResultWatermark?: number;
  baselineLastResultId?: number;
  deadline: number;
  questionId: string;
}

export interface QuestionAnsweringLeasePayload {
  sessionId: string;
  runId: number;
  questionId: string;
  idempotencyKey: string;
  leaseUntil: number;
}

function parsePayload(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) ? value : null;
}

export function parseQuestionAwaitingPayload(payload: string): QuestionAwaitingPayload | null {
  const record = parsePayload(payload);
  if (record === null) {
    return null;
  }
  const sessionId = record.sessionId;
  const baselineResultCount = finiteInteger(record.baselineResultCount);
  const baselineResultWatermark = finiteInteger(record.baselineResultWatermark);
  const baselineLastResultId = finiteInteger(record.baselineLastResultId);
  const deadline = finiteInteger(record.deadline);
  const questionId = record.questionId;
  if (
    typeof sessionId !== "string" ||
    sessionId === "" ||
    baselineResultCount === null ||
    baselineResultCount < 0 ||
    (baselineResultWatermark !== null && baselineResultWatermark < 0) ||
    (baselineLastResultId !== null && baselineLastResultId <= 0) ||
    deadline === null ||
    typeof questionId !== "string" ||
    questionId === ""
  ) {
    return null;
  }
  return {
    sessionId,
    baselineResultCount,
    ...(baselineResultWatermark !== null ? { baselineResultWatermark } : {}),
    ...(baselineLastResultId !== null ? { baselineLastResultId } : {}),
    deadline,
    questionId,
  };
}

export function parseQuestionAnsweringLeasePayload(payload: string): QuestionAnsweringLeasePayload | null {
  const record = parsePayload(payload);
  if (record === null) {
    return null;
  }
  const sessionId = record.sessionId;
  const runId = finiteInteger(record.runId);
  const questionId = record.questionId;
  const idempotencyKey = record.idempotencyKey;
  const leaseUntil = finiteInteger(record.leaseUntil);
  if (
    typeof sessionId !== "string" ||
    sessionId === "" ||
    runId === null ||
    runId <= 0 ||
    typeof questionId !== "string" ||
    questionId === "" ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey === "" ||
    leaseUntil === null
  ) {
    return null;
  }
  return { sessionId, runId, questionId, idempotencyKey, leaseUntil };
}

export function sessionEndedResultCount(event: EventRow): number | null {
  const record = parsePayload(event.payload);
  if (record === null) {
    return null;
  }
  const resultCount = record.resultCount;
  if (typeof resultCount === "number" && Number.isInteger(resultCount) && resultCount >= 0) {
    return resultCount;
  }
  // resultCount 導入前の legacy session_ended は 1 相当として扱う（§52.4）。
  return 1;
}

export function sessionEndedResultWatermark(event: EventRow): number | null {
  const record = parsePayload(event.payload);
  if (record === null) {
    return null;
  }
  return extractSessionEndedResultWatermark(event.payload);
}

export function maxSessionEndedResultCount(events: readonly EventRow[], sessionId: string): number {
  let maxResultCount = 0;
  for (const event of events) {
    const record = parsePayload(event.payload);
    if (record?.sessionId !== sessionId) {
      continue;
    }
    const resultCount = sessionEndedResultCount(event);
    if (resultCount !== null && resultCount > maxResultCount) {
      maxResultCount = resultCount;
    }
  }
  return maxResultCount;
}

export function maxSessionEndedResultWatermark(events: readonly EventRow[], sessionId: string): number {
  let maxResultWatermark = 0;
  for (const event of events) {
    const record = parsePayload(event.payload);
    if (record?.sessionId !== sessionId) {
      continue;
    }
    const resultWatermark = sessionEndedResultWatermark(event);
    if (resultWatermark !== null && resultWatermark > maxResultWatermark) {
      maxResultWatermark = resultWatermark;
    }
  }
  return maxResultWatermark;
}

export function latestQuestionAwaitingPayload(
  events: readonly EventRow[],
  sessionId: string,
): QuestionAwaitingPayload | null {
  let latest: QuestionAwaitingPayload | null = null;
  for (const event of events) {
    const payload = parseQuestionAwaitingPayload(event.payload);
    if (payload !== null && payload.sessionId === sessionId) {
      latest = payload;
    }
  }
  return latest;
}

export function hasQuestionAwaitingRecord(
  events: readonly EventRow[],
  expected: QuestionAwaitingPayload,
): boolean {
  return events.some((event) => {
    const payload = parseQuestionAwaitingPayload(event.payload);
    return (
      payload !== null &&
      payload.sessionId === expected.sessionId &&
      payload.baselineResultCount === expected.baselineResultCount &&
      payload.baselineResultWatermark === expected.baselineResultWatermark &&
      payload.questionId === expected.questionId
    );
  });
}

export function isLiveQuestionAwaiting(
  task: TaskRow | null,
  openRun: RunRow,
  questionEvents: readonly EventRow[],
  now: number,
): boolean {
  if (task === null || task.status !== "blocked" || !task.blockReason.startsWith("worker-question:")) {
    return false;
  }
  const payload = latestQuestionAwaitingPayload(questionEvents, openRun.sessionId);
  return payload !== null && payload.deadline > now;
}

export function activeAnswerLease(
  events: readonly EventRow[],
  sessionId: string,
  now: number,
): QuestionAnsweringLeasePayload | null {
  let latestLease: QuestionAnsweringLeasePayload | null = null;
  for (const event of events) {
    if (event.eventType === QUESTION_ANSWERING_RELEASED_EVENT_TYPE) {
      const record = parsePayload(event.payload);
      const idempotencyKey = record?.idempotencyKey;
      if (
        typeof idempotencyKey === "string" &&
        latestLease !== null &&
        latestLease.idempotencyKey === idempotencyKey
      ) {
        latestLease = null;
      }
      continue;
    }
    if (event.eventType !== QUESTION_ANSWERING_EVENT_TYPE) {
      continue;
    }
    const lease = parseQuestionAnsweringLeasePayload(event.payload);
    if (lease !== null && lease.sessionId === sessionId) {
      latestLease = lease;
    }
  }
  if (latestLease === null || latestLease.leaseUntil <= now) {
    return null;
  }
  return latestLease;
}

export function countOpenQuestionAwaitingRuns(store: KanbanStore, now: number): number {
  let count = 0;
  for (const run of store.listOpenRuns()) {
    const task = store.getTask(run.taskId);
    const events = store.listEvents(run.taskId, QUESTION_AWAITING_EVENT_TYPE);
    if (isLiveQuestionAwaiting(task, run, events, now)) {
      count += 1;
    }
  }
  return count;
}
