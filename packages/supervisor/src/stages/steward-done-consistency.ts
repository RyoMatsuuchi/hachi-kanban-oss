import {
  ALLOWED_TRANSITIONS,
  classifyDoneSignal,
  deriveDoneOrigin,
} from "@hachi/core";
import type { DoneOrigin, EventRow, TaskRow, TaskStatus } from "@hachi/core";

const STALE_FENCE_EVENT_TYPES = new Set([
  "late_result_rejected",
  "stale_finalize_skipped",
  "stale_max_runtime_skip",
  "stale_review_skipped",
]);

const TASK_STATUSES = new Set<TaskStatus>([
  "triage",
  "todo",
  "ready",
  "blocked",
  "review",
  "needs-integration",
  "done",
  "archived",
]);

export type DoneConsistencyCode =
  | "not-done"
  | "consistent"
  | "impossible-transition"
  | "evidence-missing"
  | "stale-fence-only";

export interface DoneConsistencyDecision {
  verdict: "not-applicable" | "consistent" | "escalate";
  code: DoneConsistencyCode;
  origin: DoneOrigin;
  reason: string;
}

interface ParsedDonePayload {
  from: string | null;
  toDone: boolean;
}

function parseDonePayload(event: EventRow): ParsedDonePayload {
  let value: unknown;
  try {
    value = JSON.parse(event.payload);
  } catch {
    return { from: null, toDone: false };
  }
  if (typeof value !== "object" || value === null) {
    return { from: null, toDone: false };
  }
  const record = value as Record<string, unknown>;
  return {
    from: typeof record.from === "string" && record.from !== "" ? record.from : null,
    toDone: record.to === "done",
  };
}

function isImpossibleDoneTransition(event: EventRow): boolean {
  const payload = parseDonePayload(event);
  if (!payload.toDone || payload.from === null) {
    return false;
  }
  if (!TASK_STATUSES.has(payload.from as TaskStatus)) {
    return true;
  }
  return !ALLOWED_TRANSITIONS[payload.from as TaskStatus].includes("done");
}

/**
 * done taskのevent全履歴をpureに検査する。
 *
 * failure eventは「その時点の試行が失敗した」証拠であり、後続する正当なgate/human/
 * orchestrator host-finalizeを否定しない。反対に、状態機械上不可能なdone、確定done signalの
 * 欠落・曖昧性、stale fenceだけが残るdoneはfail-closedで一意のescalateへ倒す。
 */
export function decideDoneConsistency(
  task: Pick<TaskRow, "status">,
  events: readonly EventRow[],
): DoneConsistencyDecision {
  if (task.status !== "done") {
    return {
      verdict: "not-applicable",
      code: "not-done",
      origin: "unknown",
      reason: "status=doneではないため整合検査対象外です",
    };
  }

  const impossible = events.find(isImpossibleDoneTransition);
  if (impossible !== undefined) {
    const from = parseDonePayload(impossible).from ?? "unknown";
    return {
      verdict: "escalate",
      code: "impossible-transition",
      origin: "unknown",
      reason: `状態機械上不可能なdone遷移です (event=${impossible.eventType}, from=${from})`,
    };
  }

  const origin = deriveDoneOrigin(events);
  const doneSignals = events.map((event) => classifyDoneSignal(event));
  const validDoneCount = doneSignals.filter((kind) => kind === "valid-done").length;
  const invalidDoneCount = doneSignals.filter((kind) => kind === "invalid-done-signal").length;
  // §62のunknownは正式な観測カテゴリである。exactly-oneの完全なdone signalがあるlegacy/service
  // provenanceを「証拠欠落」へ格上げせず、表示actorから主体を推測しないまま整合扱いにする。
  if (validDoneCount === 1 && invalidDoneCount === 0) {
    return {
      verdict: "consistent",
      code: "consistent",
      origin,
      reason: `確定done signalと構造化provenanceが整合しています (origin=${origin})`,
    };
  }

  const staleFenceCount = events.filter((event) => STALE_FENCE_EVENT_TYPES.has(event.eventType)).length;
  if (validDoneCount === 0 && invalidDoneCount === 0 && staleFenceCount > 0) {
    return {
      verdict: "escalate",
      code: "stale-fence-only",
      origin,
      reason: "旧run/fenceのlate result拒否証拠だけがあり、確定done signalがありません",
    };
  }

  return {
    verdict: "escalate",
    code: "evidence-missing",
    origin,
    reason: "確定done signalが欠落・破損・重複、または監査provenanceが不明です",
  };
}
