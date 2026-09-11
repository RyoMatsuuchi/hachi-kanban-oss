// =============================================================================
// hachi schedule: create / list / show / enable / disable / delete サブコマンド群
// =============================================================================

import { isAbsolute } from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import type { HachiConfig, ScheduleCadence, ScheduleCreateInput, ScheduleRow } from "@hachi/core";
import type { CliDeps } from "../deps.js";
import { withErrorHandling } from "../errors.js";
import { emit, singularResourceEnvelope } from "../output.js";

const DEFAULT_ACTOR = "human";
const SCHEDULE_CADENCES: readonly ScheduleCadence[] = ["daily", "weekly", "monthly", "once"];

interface ParsedAt {
  atHour: number;
  atMinute: number;
}

interface ScheduleCreateOptions {
  name: string;
  cadence: ScheduleCadence;
  at: ParsedAt;
  weekday?: number;
  day?: number;
  date?: string;
  cwd: string;
  profile?: string;
  tenant?: string;
  prompt: string;
  json?: boolean;
}

interface ScheduleJsonOption {
  json?: boolean;
}

function parseAtArg(value: string): ParsedAt {
  const match = /^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new InvalidArgumentError(`--at は HH:MM 形式で指定してください: ${value}`);
  }
  return { atHour: Number.parseInt(match[1], 10), atMinute: Number.parseInt(match[2], 10) };
}

function parseWeekdayArg(value: string): number {
  if (!/^[0-6]$/.test(value)) {
    throw new InvalidArgumentError(`--weekday は 0〜6 の整数で指定してください（0=Sunday）: ${value}`);
  }
  return Number.parseInt(value, 10);
}

function parseDayArg(value: string): number {
  if (!/^([1-9]|[12][0-9]|3[01])$/.test(value)) {
    throw new InvalidArgumentError(`--day は 1〜31 の整数で指定してください: ${value}`);
  }
  return Number.parseInt(value, 10);
}

function parseDateArg(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new InvalidArgumentError(`--date は YYYY-MM-DD 形式で指定してください: ${value}`);
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > lastDay) {
    throw new InvalidArgumentError(`--date の日付が不正です: ${value}`);
  }
  return value;
}

function requireAbsoluteCwd(cwdPath: string): void {
  if (!isAbsolute(cwdPath)) {
    throw new Error(`cwd は絶対パスのみ指定できます（相対パスは拒否します。fail-closed）: ${cwdPath}`);
  }
}

function hasConfigProfile(profiles: HachiConfig["profiles"], profile: string): boolean {
  return Object.prototype.hasOwnProperty.call(profiles, profile);
}

function assertScheduleProfileAllowed(config: HachiConfig, profile: string | undefined): void {
  if (profile === undefined || profile === "") {
    return;
  }
  if (!hasConfigProfile(config.profiles, profile)) {
    throw new Error(`未知の profile です: ${profile}`);
  }
}

function toCreateInput(options: ScheduleCreateOptions): ScheduleCreateInput {
  requireAbsoluteCwd(options.cwd);
  const input: ScheduleCreateInput = {
    name: options.name,
    cadenceKind: options.cadence,
    atHour: options.at.atHour,
    atMinute: options.at.atMinute,
    cwd: options.cwd,
    prompt: options.prompt,
  };
  if (options.tenant !== undefined) {
    input.tenant = options.tenant;
  }
  if (options.profile !== undefined) {
    input.profile = options.profile;
  }

  if (options.cadence === "weekly") {
    if (options.weekday === undefined) {
      throw new Error("weekly schedule には --weekday が必須です");
    }
    input.weekday = options.weekday;
  }
  if (options.cadence === "monthly") {
    if (options.day === undefined) {
      throw new Error("monthly schedule には --day が必須です");
    }
    input.dayOfMonth = options.day;
  }
  if (options.cadence === "once") {
    if (options.date === undefined) {
      throw new Error("once schedule には --date が必須です");
    }
    input.runDate = options.date;
  }

  return input;
}

function formatAt(schedule: ScheduleRow): string {
  return `${String(schedule.atHour).padStart(2, "0")}:${String(schedule.atMinute).padStart(2, "0")}`;
}

function formatCadence(schedule: ScheduleRow): string {
  if (schedule.cadenceKind === "weekly") {
    return `weekly weekday=${schedule.weekday ?? "-"}`;
  }
  if (schedule.cadenceKind === "monthly") {
    return `monthly day=${schedule.dayOfMonth ?? "-"}`;
  }
  if (schedule.cadenceKind === "once") {
    return `once date=${schedule.runDate ?? "-"}`;
  }
  return "daily";
}

function formatScheduleLine(schedule: ScheduleRow): string {
  const enabled = schedule.enabled ? "enabled" : "disabled";
  const tenant = schedule.tenant === "" ? "-" : schedule.tenant;
  const profile = schedule.profile === "" ? "-" : schedule.profile;
  return `${schedule.id} [${enabled}] ${formatCadence(schedule)} at=${formatAt(schedule)} tenant=${tenant} profile=${profile} ${schedule.name}`;
}

function formatScheduleDetail(schedule: ScheduleRow): string[] {
  return [
    formatScheduleLine(schedule),
    `cwd: ${schedule.cwd}`,
    `prompt: ${schedule.prompt}`,
    `last_run_at: ${schedule.lastRunAt ?? "-"}`,
    `last_task_id: ${schedule.lastTaskId ?? "-"}`,
    `consecutive_failures: ${schedule.consecutiveFailures}`,
    `auto_disabled_reason: ${schedule.autoDisabledReason === "" ? "-" : schedule.autoDisabledReason}`,
    `created_at: ${schedule.createdAt}`,
    `updated_at: ${schedule.updatedAt}`,
  ];
}

function requireSchedule(deps: CliDeps, id: string): ScheduleRow {
  const schedule = deps.store.getSchedule(id);
  if (schedule === null) {
    throw new Error(`スケジュールが見つかりません: ${id}`);
  }
  return schedule;
}

function runCreate(deps: CliDeps, options: ScheduleCreateOptions): void {
  assertScheduleProfileAllowed(deps.config, options.profile);
  const schedule = deps.store.createSchedule(toCreateInput(options), DEFAULT_ACTOR);
  const json = options.json === true;
  emit(
    deps,
    json,
    singularResourceEnvelope(schedule, { schedule }),
    [`スケジュールを作成しました: ${schedule.id}`],
  );
}

function runList(deps: CliDeps, options: ScheduleJsonOption): void {
  const schedules = deps.store.listSchedules();
  const json = options.json === true;
  const textLines = schedules.length === 0 ? ["(スケジュールはありません)"] : schedules.map(formatScheduleLine);
  emit(deps, json, { schedules }, textLines);
}

function runShow(deps: CliDeps, id: string, options: ScheduleJsonOption): void {
  const schedule = requireSchedule(deps, id);
  const json = options.json === true;
  emit(deps, json, singularResourceEnvelope(schedule, { schedule }), formatScheduleDetail(schedule));
}

function runSetEnabled(deps: CliDeps, id: string, enabled: boolean, options: ScheduleJsonOption): void {
  const schedule = deps.store.setScheduleEnabled(id, enabled, DEFAULT_ACTOR);
  const json = options.json === true;
  const state = enabled ? "有効化" : "無効化";
  emit(
    deps,
    json,
    singularResourceEnvelope(schedule, { schedule }),
    [`スケジュールを${state}しました: ${schedule.id}`],
  );
}

function runDelete(deps: CliDeps, id: string, options: ScheduleJsonOption): void {
  requireSchedule(deps, id);
  deps.store.deleteSchedule(id, DEFAULT_ACTOR);
  const json = options.json === true;
  emit(deps, json, { deleted: true, id }, [`スケジュールを削除しました: ${id}`]);
}

/** hachi schedule サブコマンド群を登録する */
export function registerScheduleCommand(program: Command, deps: CliDeps): void {
  const schedule = program.command("schedule").description("スケジュール操作");

  schedule
    .command("create")
    .description("スケジュールを作成する")
    .requiredOption("--name <name>", "名前")
    .addOption(new Option("--cadence <cadence>", "cadence（daily / weekly / monthly / once）").choices(SCHEDULE_CADENCES).makeOptionMandatory())
    .requiredOption("--at <HH:MM>", "JST の発火時刻（HH:MM）", parseAtArg)
    .option("--weekday <n>", "weekly 用曜日（0=Sunday, 6=Saturday）", parseWeekdayArg)
    .option("--day <n>", "monthly 用日付（1〜31。短い月は月末に丸める）", parseDayArg)
    .option("--date <YYYY-MM-DD>", "once 用日付（JST）", parseDateArg)
    .requiredOption("--cwd <path>", "作業ディレクトリの絶対パス")
    .option("--profile <profile>", "profile 名")
    .option("--tenant <tenant>", "テナント")
    .requiredOption("--prompt <text>", "プロンプト本文")
    .option("--json", "JSON 形式で出力する")
    .action(withErrorHandling(deps, (options: ScheduleCreateOptions): void => runCreate(deps, options)));

  schedule
    .command("list")
    .description("スケジュール一覧を表示する")
    .option("--json", "JSON 形式で出力する")
    .action(withErrorHandling(deps, (options: ScheduleJsonOption): void => runList(deps, options)));

  schedule
    .command("show")
    .description("スケジュール詳細を表示する")
    .argument("<id>", "スケジュール ID")
    .option("--json", "JSON 形式で出力する")
    .action(withErrorHandling(deps, (id: string, options: ScheduleJsonOption): void => runShow(deps, id, options)));

  schedule
    .command("enable")
    .description("スケジュールを有効化する")
    .argument("<id>", "スケジュール ID")
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(deps, (id: string, options: ScheduleJsonOption): void =>
        runSetEnabled(deps, id, true, options),
      ),
    );

  schedule
    .command("disable")
    .description("スケジュールを無効化する")
    .argument("<id>", "スケジュール ID")
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(deps, (id: string, options: ScheduleJsonOption): void =>
        runSetEnabled(deps, id, false, options),
      ),
    );

  schedule
    .command("delete")
    .description("スケジュールを削除する")
    .argument("<id>", "スケジュール ID")
    .option("--json", "JSON 形式で出力する")
    .action(withErrorHandling(deps, (id: string, options: ScheduleJsonOption): void => runDelete(deps, id, options)));
}
