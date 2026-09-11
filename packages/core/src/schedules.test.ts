import { describe, expect, it } from "vitest";
import { computeNextFire } from "./schedules.js";
import type { ScheduleRow } from "./types.js";

function jstMs(value: string): number {
  return Date.parse(value);
}

function fixtureSchedule(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: "s_fixture00000000",
    name: "fixture",
    enabled: true,
    cadenceKind: "daily",
    atMinute: 0,
    atHour: 9,
    weekday: null,
    dayOfMonth: null,
    runDate: null,
    tenant: "dev",
    profile: "implement",
    cwd: "/tmp/hk-scheduler",
    prompt: "run",
    priority: 0,
    lastRunAt: null,
    lastTaskId: null,
    consecutiveFailures: 0,
    autoDisabledReason: "",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("computeNextFire", () => {
  it("daily は JST 当日予定が未来なら当日、過ぎていれば翌日を返す", () => {
    const schedule = fixtureSchedule({ cadenceKind: "daily", atHour: 9, atMinute: 30 });

    expect(computeNextFire(schedule, jstMs("2026-07-04T08:00:00+09:00"))).toBe(
      jstMs("2026-07-04T09:30:00+09:00"),
    );
    expect(computeNextFire(schedule, jstMs("2026-07-04T09:31:00+09:00"))).toBe(
      jstMs("2026-07-05T09:30:00+09:00"),
    );
  });

  it("weekly は weekday（0=Sunday）に一致する次回 JST 時刻を返す", () => {
    const schedule = fixtureSchedule({ cadenceKind: "weekly", weekday: 1, atHour: 10, atMinute: 0 });

    expect(computeNextFire(schedule, jstMs("2026-07-04T12:00:00+09:00"))).toBe(
      jstMs("2026-07-06T10:00:00+09:00"),
    );
    expect(computeNextFire(schedule, jstMs("2026-07-06T10:01:00+09:00"))).toBe(
      jstMs("2026-07-13T10:00:00+09:00"),
    );
  });

  it("monthly は dayOfMonth を月末にクランプする", () => {
    const schedule = fixtureSchedule({ cadenceKind: "monthly", dayOfMonth: 31, atHour: 8, atMinute: 45 });

    expect(computeNextFire(schedule, jstMs("2026-02-10T00:00:00+09:00"))).toBe(
      jstMs("2026-02-28T08:45:00+09:00"),
    );
    expect(computeNextFire(schedule, jstMs("2026-02-28T08:46:00+09:00"))).toBe(
      jstMs("2026-03-31T08:45:00+09:00"),
    );
  });

  it("once は未来または現在なら発火時刻、過去なら null を返す", () => {
    const schedule = fixtureSchedule({ cadenceKind: "once", runDate: "2026-07-04", atHour: 9, atMinute: 0 });

    expect(computeNextFire(schedule, jstMs("2026-07-04T08:59:00+09:00"))).toBe(
      jstMs("2026-07-04T09:00:00+09:00"),
    );
    expect(computeNextFire(schedule, jstMs("2026-07-04T09:00:00+09:00"))).toBe(
      jstMs("2026-07-04T09:00:00+09:00"),
    );
    expect(computeNextFire(schedule, jstMs("2026-07-04T09:01:00+09:00"))).toBeNull();
  });

  it("disabled な schedule は cadence に関わらず null を返す", () => {
    const schedule = fixtureSchedule({ enabled: false, cadenceKind: "daily", atHour: 9, atMinute: 0 });

    expect(computeNextFire(schedule, jstMs("2026-07-04T08:00:00+09:00"))).toBeNull();
  });

  it("cadence 必須フィールドが壊れていれば throw する", () => {
    const schedule = fixtureSchedule({ cadenceKind: "weekly", weekday: null });

    expect(() => computeNextFire(schedule, jstMs("2026-07-04T08:00:00+09:00"))).toThrow(/weekday/);
  });
});
