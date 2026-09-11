import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskInput } from "@hachi/testing";
import type { ScheduleCadence, ScheduleCreateInput, TaskRow } from "@hachi/core";
import { setupHarness, type TestHarness } from "../test-support.js";
import { schedulerStage } from "./scheduler.js";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const STALE_TASK_SECONDS = 24 * 60 * 60;

interface JstDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function futureMinute(secondsAhead: number = 180): number {
  return Math.floor((Date.now() / 1000 + secondsAhead) / 60) * 60;
}

function toJstParts(epochSec: number): JstDateTimeParts {
  const shifted = new Date(epochSec * 1000 + JST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function runDate(parts: JstDateTimeParts): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function scheduleInput(cadenceKind: ScheduleCadence, fireAt: number): ScheduleCreateInput {
  const parts = toJstParts(fireAt);
  const base: ScheduleCreateInput = {
    name: `${cadenceKind} schedule`,
    cadenceKind,
    atHour: parts.hour,
    atMinute: parts.minute,
    cwd: "/tmp/hk-scheduler",
    prompt: `${cadenceKind} prompt`,
    tenant: "dev",
    profile: "implement",
    priority: 7,
  };

  if (cadenceKind === "weekly") {
    return { ...base, weekday: parts.weekday };
  }
  if (cadenceKind === "monthly") {
    return { ...base, dayOfMonth: parts.day };
  }
  if (cadenceKind === "once") {
    return { ...base, runDate: runDate(parts) };
  }
  return base;
}

function onlyReadyTask(harness: TestHarness): TaskRow {
  const tasks = harness.store.listByStatus("ready");
  expect(tasks).toHaveLength(1);
  const task = tasks[0];
  if (task === undefined) {
    throw new Error("ready task が見つかりません");
  }
  return task;
}

describe("schedulerStage", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("同じ発火時刻では1回だけ ready タスクを作る", async () => {
    const fireAt = futureMinute();
    const schedule = harness.store.createSchedule(scheduleInput("daily", fireAt), "tester");

    const first = await schedulerStage.tick(harness.deps, true, fireAt + 1);
    const second = await schedulerStage.tick(harness.deps, true, fireAt + 1);

    expect(first.actions).toBe(1);
    expect(second.actions).toBe(0);
    const task = onlyReadyTask(harness);
    expect(task.title).toBe("daily schedule");
    expect(task.body).toBe("cwd: /tmp/hk-scheduler\ndaily prompt");
    expect(task.tenant).toBe("dev");
    expect(task.profile).toBe("implement");
    expect(task.priority).toBe(7);

    const updated = harness.store.getSchedule(schedule.id);
    expect(updated?.lastRunAt).toBe(fireAt);
    expect(updated?.lastTaskId).toBe(task.id);
    expect(harness.store.listEvents(task.id, "schedule_fired")).toHaveLength(1);
  });

  it("Tx 内再検証で直前に無効化された schedule は発火しない", async () => {
    const fireAt = futureMinute();
    const schedule = harness.store.createSchedule(scheduleInput("daily", fireAt), "tester");
    const originalTransaction = harness.store.transaction.bind(harness.store) as typeof harness.store.transaction;
    let injected = false;
    harness.store.transaction = (<T>(fn: () => T): T =>
      originalTransaction(() => {
        if (!injected) {
          injected = true;
          harness.store.setScheduleEnabled(schedule.id, false, "tester");
        }
        return fn();
      })) as typeof harness.store.transaction;

    try {
      const result = await schedulerStage.tick(harness.deps, true, fireAt + 1);

      expect(result.actions).toBe(0);
      expect(harness.store.listByStatus("ready")).toHaveLength(0);
      const updated = harness.store.getSchedule(schedule.id);
      expect(updated?.enabled).toBe(false);
      expect(updated?.lastRunAt).toBeNull();
      expect(result.notes?.some((note) => note.includes("Tx 内再検証"))).toBe(true);
    } finally {
      harness.store.transaction = originalTransaction;
    }
  });

  it("発火 claim 競合で負けた側は task 作成を rollback して0件扱いにする", async () => {
    const fireAt = futureMinute();
    const schedule = harness.store.createSchedule(scheduleInput("daily", fireAt), "tester");
    const originalMarkScheduleFired = harness.store.markScheduleFired.bind(
      harness.store,
    ) as typeof harness.store.markScheduleFired;
    harness.store.markScheduleFired = ((): void => {
      throw new Error("スケジュール発火は既に claim 済みです: injected");
    }) as typeof harness.store.markScheduleFired;

    try {
      const result = await schedulerStage.tick(harness.deps, true, fireAt + 1);

      expect(result.actions).toBe(0);
      expect(harness.store.listByStatus("ready")).toHaveLength(0);
      expect(harness.store.getSchedule(schedule.id)?.lastRunAt).toBeNull();
      expect(result.notes?.some((note) => note.includes("既に claim 済み"))).toBe(true);
    } finally {
      harness.store.markScheduleFired = originalMarkScheduleFired;
    }
  });

  it.each(["daily", "weekly", "monthly"] as const)("%s cadence の発火予定を作成する", async (cadenceKind) => {
    const fireAt = futureMinute();
    const schedule = harness.store.createSchedule(scheduleInput(cadenceKind, fireAt), "tester");

    const result = await schedulerStage.tick(harness.deps, true, fireAt + 1);

    expect(result.actions).toBe(1);
    const task = onlyReadyTask(harness);
    const events = harness.store.listEvents(task.id, "schedule_fired");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toContain(`"scheduleId":"${schedule.id}"`);
    expect(events[0]?.payload).toContain(`"cadenceKind":"${cadenceKind}"`);
  });

  it("dry-run では発火予定を notes に出し、DB へ書き込まない", async () => {
    const fireAt = futureMinute();
    const schedule = harness.store.createSchedule(scheduleInput("daily", fireAt), "tester");

    const result = await schedulerStage.tick(harness.deps, false, fireAt + 1);

    expect(result.actions).toBe(1);
    expect(result.notes?.some((note) => note.includes("dry-run") && note.includes(schedule.id))).toBe(true);
    expect(harness.store.listByStatus("ready")).toHaveLength(0);
    expect(harness.store.getSchedule(schedule.id)?.lastRunAt).toBeNull();
  });

  it("once cadence は発火後に schedule を無効化する", async () => {
    const fireAt = futureMinute();
    const schedule = harness.store.createSchedule(scheduleInput("once", fireAt), "tester");

    const result = await schedulerStage.tick(harness.deps, true, fireAt + 1);

    expect(result.actions).toBe(1);
    const updated = harness.store.getSchedule(schedule.id);
    expect(updated?.enabled).toBe(false);
    expect(updated?.lastRunAt).toBe(fireAt);
    expect(updated?.autoDisabledReason).toBe("");
  });

  it("last_task_id が done になったら failures を 0 に戻す", async () => {
    const now = Math.floor(Date.now() / 1000);
    const schedule = harness.store.createSchedule(scheduleInput("daily", futureMinute()), "tester");
    const task = harness.store.createTask(taskInput({ status: "ready", title: "完了済み" }), "tester");
    harness.store.block(task.id, "codex-in-progress: テスト完了", "tester");
    harness.store.transition({ taskId: task.id, to: "done", actor: "tester" });
    harness.store.markScheduleFired(schedule.id, task.id, now, "tester");
    harness.store.setScheduleFailures(schedule.id, 2, "tester");

    const result = await schedulerStage.tick(harness.deps, true, now);
    const second = await schedulerStage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(second.actions).toBe(0);
    expect(harness.store.getSchedule(schedule.id)?.consecutiveFailures).toBe(0);
  });

  it("生成から24h超未doneの last_task_id は失敗を1回だけ加算する", async () => {
    const schedule = harness.store.createSchedule(scheduleInput("daily", futureMinute()), "tester");
    const task = harness.store.createTask(taskInput({ status: "ready", title: "未完了" }), "tester");
    const staleNow = task.createdAt + STALE_TASK_SECONDS + 1;
    harness.store.markScheduleFired(schedule.id, task.id, staleNow, "tester");

    const result = await schedulerStage.tick(harness.deps, true, staleNow);
    const second = await schedulerStage.tick(harness.deps, true, staleNow);

    expect(result.actions).toBe(1);
    expect(second.actions).toBe(0);
    const updated = harness.store.getSchedule(schedule.id);
    expect(updated?.consecutiveFailures).toBe(1);
    expect(updated?.enabled).toBe(true);
  });

  it("未完了 last_task_id は失敗判定前に次回発火で上書きしない", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "未完了" }), "tester");
    const lastFireAt = Math.floor(task.createdAt / 60) * 60;
    const dueAt = lastFireAt + STALE_TASK_SECONDS;
    const schedule = harness.store.createSchedule(scheduleInput("daily", lastFireAt), "tester");
    harness.store.markScheduleFired(schedule.id, task.id, lastFireAt, "tester");

    const held = await schedulerStage.tick(harness.deps, true, dueAt);

    expect(held.actions).toBe(0);
    expect(held.notes?.some((note) => note.includes("保留"))).toBe(true);
    expect(harness.store.listByStatus("ready")).toHaveLength(1);
    const heldSchedule = harness.store.getSchedule(schedule.id);
    expect(heldSchedule?.lastTaskId).toBe(task.id);
    expect(heldSchedule?.lastRunAt).toBe(lastFireAt);
    expect(heldSchedule?.consecutiveFailures).toBe(0);

    const staleNow = task.createdAt + STALE_TASK_SECONDS + 1;
    const fired = await schedulerStage.tick(harness.deps, true, staleNow);

    expect(fired.actions).toBe(2);
    expect(harness.store.listByStatus("ready")).toHaveLength(2);
    const updated = harness.store.getSchedule(schedule.id);
    expect(updated?.consecutiveFailures).toBe(1);
    expect(updated?.lastRunAt).toBe(dueAt);
    expect(updated?.lastTaskId).not.toBe(task.id);
  });

  it("失敗3回で schedule を自動無効化する", async () => {
    const now = Math.floor(Date.now() / 1000);
    const schedule = harness.store.createSchedule(scheduleInput("daily", futureMinute()), "tester");
    const task = harness.store.createTask(taskInput({ status: "ready", title: "手動対応待ち" }), "tester");
    harness.store.block(task.id, "needs-manual: テスト失敗", "tester", "human");
    harness.store.markScheduleFired(schedule.id, task.id, now, "tester");
    harness.store.setScheduleFailures(schedule.id, 2, "tester");

    const result = await schedulerStage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    const updated = harness.store.getSchedule(schedule.id);
    expect(updated?.consecutiveFailures).toBe(3);
    expect(updated?.enabled).toBe(false);
    expect(updated?.autoDisabledReason).toContain("連続失敗 3 回");
  });
});
