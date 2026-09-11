import type { ScheduleRow } from "./types.js";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

interface JstParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

interface RunDateParts {
  year: number;
  month: number;
  day: number;
}

function toJstParts(ms: number): JstParts {
  const shifted = new Date(ms + JST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

function jstDateTimeToMs(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0) - JST_OFFSET_MS;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseRunDate(runDate: string): RunDateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(runDate);
  if (match === null) {
    throw new Error(`runDate は YYYY-MM-DD 形式が必須です: ${runDate}`);
  }

  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  if (yearText === undefined || monthText === undefined || dayText === undefined) {
    throw new Error(`runDate は YYYY-MM-DD 形式が必須です: ${runDate}`);
  }

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`runDate の日付が不正です: ${runDate}`);
  }

  return { year, month, day };
}

function assertIntegerInRange(value: number | null, label: string, min: number, max: number): number {
  if (value === null || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} は ${min}〜${max} の整数が必須です`);
  }
  return value;
}

function nextMonth(year: number, month: number): { year: number; month: number } {
  if (month === 12) {
    return { year: year + 1, month: 1 };
  }
  return { year, month: month + 1 };
}

function monthlyCandidate(schedule: ScheduleRow, year: number, month: number): number {
  const dayOfMonth = assertIntegerInRange(schedule.dayOfMonth, "dayOfMonth", 1, 31);
  const day = Math.min(dayOfMonth, daysInMonth(year, month));
  return jstDateTimeToMs(year, month, day, schedule.atHour, schedule.atMinute);
}

/**
 * JST 基準で次回発火予定の epoch ms を返す。
 * 無効化済み schedule と過去の once は次回予定なしとして null を返す。
 */
export function computeNextFire(schedule: ScheduleRow, nowMs: number): number | null {
  if (!Number.isFinite(nowMs)) {
    throw new Error(`nowMs は有限の数値が必須です: ${nowMs}`);
  }
  if (!schedule.enabled) {
    return null;
  }

  const atHour = assertIntegerInRange(schedule.atHour, "atHour", 0, 23);
  const atMinute = assertIntegerInRange(schedule.atMinute, "atMinute", 0, 59);
  const now = toJstParts(nowMs);

  if (schedule.cadenceKind === "daily") {
    const today = jstDateTimeToMs(now.year, now.month, now.day, atHour, atMinute);
    return today >= nowMs ? today : jstDateTimeToMs(now.year, now.month, now.day + 1, atHour, atMinute);
  }

  if (schedule.cadenceKind === "weekly") {
    const weekday = assertIntegerInRange(schedule.weekday, "weekday", 0, 6);
    let daysUntil = (weekday - now.weekday + 7) % 7;
    let candidate = jstDateTimeToMs(now.year, now.month, now.day + daysUntil, atHour, atMinute);
    if (candidate < nowMs) {
      daysUntil += 7;
      candidate = jstDateTimeToMs(now.year, now.month, now.day + daysUntil, atHour, atMinute);
    }
    return candidate;
  }

  if (schedule.cadenceKind === "monthly") {
    const thisMonth = monthlyCandidate(schedule, now.year, now.month);
    if (thisMonth >= nowMs) {
      return thisMonth;
    }
    const next = nextMonth(now.year, now.month);
    return monthlyCandidate(schedule, next.year, next.month);
  }

  if (schedule.cadenceKind === "once") {
    if (schedule.runDate === null) {
      throw new Error("once の schedule には runDate が必須です");
    }
    const runDate = parseRunDate(schedule.runDate);
    const candidate = jstDateTimeToMs(runDate.year, runDate.month, runDate.day, atHour, atMinute);
    return candidate >= nowMs ? candidate : null;
  }

  const never: never = schedule.cadenceKind;
  throw new Error(`未知の cadenceKind です: ${never}`);
}
