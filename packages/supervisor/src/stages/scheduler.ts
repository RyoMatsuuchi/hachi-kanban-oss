// schedules 定義から ready タスクを生成し、直近タスクの結果に応じて自動無効化するステージ（docs/contract.md §29）
import { computeNextFire } from "@hachi/core";
import type { ScheduleRow, Stage, StageDeps, StageResult, TaskRow } from "@hachi/core";
import { SUPERVISOR_ACTOR } from "../constants.js";

const ONE_MS = 1;
const SEC_TO_MS = 1000;
const STALE_TASK_SECONDS = 24 * 60 * 60;
const FAILURE_DISABLE_THRESHOLD = 3;
const RESULT_EVENT_TYPE = "schedule_task_result_counted";
const SCHEDULE_FIRE_CLAIM_LOST_MESSAGE = "スケジュール発火は既に claim 済みです";

type ScheduleTaskOutcome = "done" | "failure";

interface ScheduleTaskResultPayload {
  scheduleId: string;
  outcome: ScheduleTaskOutcome;
}

interface DueFire {
  schedule: ScheduleRow;
  fireAt: number;
}

interface LastTaskEvaluation {
  actions: number;
  fireAllowed: boolean;
}

function bodyForSchedule(schedule: ScheduleRow): string {
  return `cwd: ${schedule.cwd}\n${schedule.prompt}`;
}

function nextUnfiredAt(schedule: ScheduleRow): number | null {
  const baseMs =
    schedule.lastRunAt === null ? schedule.createdAt * SEC_TO_MS : schedule.lastRunAt * SEC_TO_MS + ONE_MS;
  const nextMs = computeNextFire(schedule, baseMs);
  return nextMs === null ? null : Math.floor(nextMs / SEC_TO_MS);
}

function dueFire(schedule: ScheduleRow, now: number): DueFire | null {
  const fireAt = nextUnfiredAt(schedule);
  if (fireAt === null || fireAt > now) {
    return null;
  }
  return { schedule, fireAt };
}

function parseScheduleTaskResultPayload(payload: string): ScheduleTaskResultPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const scheduleId = record.scheduleId;
  const outcome = record.outcome;
  if (typeof scheduleId !== "string") {
    return null;
  }
  if (outcome !== "done" && outcome !== "failure") {
    return null;
  }
  return { scheduleId, outcome };
}

function hasCountedOutcome(task: TaskRow, scheduleId: string, outcome: ScheduleTaskOutcome, deps: StageDeps): boolean {
  return deps.store.listEvents(task.id, RESULT_EVENT_TYPE).some((event) => {
    const payload = parseScheduleTaskResultPayload(event.payload);
    return payload !== null && payload.scheduleId === scheduleId && payload.outcome === outcome;
  });
}

function isImmediateFailure(task: TaskRow): boolean {
  if (task.status !== "blocked") {
    return false;
  }
  return (
    task.blockReason.startsWith("review-required:") ||
    task.blockReason.startsWith("needs-manual:") ||
    task.blockReason.startsWith("auto-launch-failed:")
  );
}

function isStaleNotDone(task: TaskRow, now: number): boolean {
  return task.status !== "done" && now - task.createdAt > STALE_TASK_SECONDS;
}

function failureReason(task: TaskRow, now: number): string | null {
  if (isImmediateFailure(task)) {
    return `blocked:${task.blockReason.split(":", 1)[0] ?? "unknown"}`;
  }
  if (isStaleNotDone(task, now)) {
    return "not-done-after-24h";
  }
  return null;
}

function autoDisabledReason(schedule: ScheduleRow, task: TaskRow, failures: number): string {
  return `連続失敗 ${failures} 回により自動無効化 (schedule=${schedule.id}, lastTask=${task.id})`;
}

function isScheduleFireClaimLost(err: unknown): boolean {
  return err instanceof Error && err.message.includes(SCHEDULE_FIRE_CLAIM_LOST_MESSAGE);
}

function evaluateLastTask(
  schedule: ScheduleRow,
  deps: StageDeps,
  apply: boolean,
  now: number,
  notes: string[],
): LastTaskEvaluation {
  if (schedule.lastTaskId === null) {
    return { actions: 0, fireAllowed: true };
  }

  const task = deps.store.getTask(schedule.lastTaskId);
  if (task === null) {
    notes.push(`${schedule.id}: last_task_id のタスクが見つからないため結果評価をスキップします`);
    return { actions: 0, fireAllowed: false };
  }

  if (task.status === "done") {
    if (hasCountedOutcome(task, schedule.id, "done", deps)) {
      return { actions: 0, fireAllowed: true };
    }
    if (!apply) {
      notes.push(`${schedule.id}: dry-run: ${task.id} done により failures を 0 にリセット予定`);
      return { actions: 1, fireAllowed: true };
    }

    deps.store.transaction(() => {
      deps.store.setScheduleFailures(schedule.id, 0, SUPERVISOR_ACTOR);
      deps.store.addEvent(task.id, RESULT_EVENT_TYPE, SUPERVISOR_ACTOR, {
        scheduleId: schedule.id,
        outcome: "done",
        countedAt: now,
      });
    });
    notes.push(`${schedule.id}: ${task.id} done により failures を 0 にリセットしました`);
    return { actions: 1, fireAllowed: true };
  }

  const reason = failureReason(task, now);
  if (hasCountedOutcome(task, schedule.id, "failure", deps)) {
    return { actions: 0, fireAllowed: true };
  }
  if (reason === null) {
    notes.push(`${schedule.id}: ${task.id} が未完了かつ失敗判定前のため次回発火を保留します`);
    return { actions: 0, fireAllowed: false };
  }

  const nextFailures = schedule.consecutiveFailures + 1;
  const fireAllowed = nextFailures < FAILURE_DISABLE_THRESHOLD;
  if (!apply) {
    const disableNote = nextFailures >= FAILURE_DISABLE_THRESHOLD ? "、自動無効化予定" : "";
    notes.push(`${schedule.id}: dry-run: ${task.id} ${reason} により failures=${nextFailures} へ加算予定${disableNote}`);
    return { actions: 1, fireAllowed };
  }

  deps.store.transaction(() => {
    deps.store.setScheduleFailures(schedule.id, nextFailures, SUPERVISOR_ACTOR);
    if (nextFailures >= FAILURE_DISABLE_THRESHOLD) {
      deps.store.setScheduleEnabled(schedule.id, false, SUPERVISOR_ACTOR, autoDisabledReason(schedule, task, nextFailures));
    }
    deps.store.addEvent(task.id, RESULT_EVENT_TYPE, SUPERVISOR_ACTOR, {
      scheduleId: schedule.id,
      outcome: "failure",
      reason,
      failures: nextFailures,
      countedAt: now,
    });
  });

  if (nextFailures >= FAILURE_DISABLE_THRESHOLD) {
    notes.push(`${schedule.id}: ${task.id} ${reason} により failures=${nextFailures}、自動無効化しました`);
  } else {
    notes.push(`${schedule.id}: ${task.id} ${reason} により failures=${nextFailures} へ加算しました`);
  }
  return { actions: 1, fireAllowed };
}

function fireSchedule(deps: StageDeps, due: DueFire, apply: boolean, now: number, notes: string[]): number {
  const { schedule, fireAt } = due;
  if (!apply) {
    notes.push(`${schedule.id}: dry-run: ${schedule.name} を発火予定 (fireAt=${fireAt})`);
    return 1;
  }

  let task: TaskRow | null;
  try {
    task = deps.store.transaction(() => {
      const latest = deps.store.getSchedule(schedule.id);
      if (latest === null || !latest.enabled) {
        return null;
      }

      const latestDue = dueFire(latest, now);
      if (latestDue === null || latestDue.fireAt !== fireAt) {
        return null;
      }

      const created = deps.store.createTask(
        {
          title: latest.name,
          body: bodyForSchedule(latest),
          tenant: latest.tenant,
          status: "ready",
          priority: latest.priority,
          profile: latest.profile,
        },
        SUPERVISOR_ACTOR,
      );
      deps.store.markScheduleFired(latest.id, created.id, fireAt, SUPERVISOR_ACTOR);
      deps.store.addEvent(created.id, "schedule_fired", SUPERVISOR_ACTOR, {
        scheduleId: latest.id,
        scheduleName: latest.name,
        cadenceKind: latest.cadenceKind,
        firedAt: fireAt,
      });
      if (latest.cadenceKind === "once") {
        deps.store.setScheduleEnabled(latest.id, false, SUPERVISOR_ACTOR);
      }
      return created;
    });
  } catch (err) {
    if (isScheduleFireClaimLost(err)) {
      notes.push(`${schedule.id}: fireAt=${fireAt} は既に claim 済みのためスキップしました`);
      return 0;
    }
    throw err;
  }

  if (task === null) {
    notes.push(`${schedule.id}: fireAt=${fireAt} は Tx 内再検証で対象外のためスキップしました`);
    return 0;
  }

  notes.push(`${schedule.id}: ${task.id} を ready で作成しました (fireAt=${fireAt})`);
  return 1;
}

export const schedulerStage: Stage = {
  name: "scheduler",

  async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
    const notes: string[] = [];
    let actions = 0;

    for (const schedule of deps.store.listSchedules()) {
      if (!schedule.enabled) {
        continue;
      }

      const evaluation = evaluateLastTask(schedule, deps, apply, now, notes);
      actions += evaluation.actions;
      if (!evaluation.fireAllowed) {
        continue;
      }

      const refreshed = deps.store.getSchedule(schedule.id);
      if (refreshed === null || !refreshed.enabled) {
        continue;
      }

      const due = dueFire(refreshed, now);
      if (due === null) {
        continue;
      }

      actions += fireSchedule(deps, due, apply, now, notes);
    }

    return { name: "scheduler", actions, skipped: false, notes };
  },
};
