// =============================================================================
// hachi usage: task_runs.meta.usage を task / tenant / model / effort 軸で比較する
// read-only な集計コマンド（契約 §14.5.1、設計 docs/plans/direct-run-usage-cost-audit.md R4/R7）。
//
// 表示の規律は契約が決めている。
//  - `measured`（実測）と `estimated`（推定）は**別列**にする。合算した数字を1つも出さない
//  - 集計から外した run は必ず件数として見せる。総額だけを出すと欠落が観測できない
//  - 値が無い欄は 0 ではなく "-" にする（0 と未取得を混同させない）
// =============================================================================

import { InvalidArgumentError, type Command } from "commander";
import {
  UsageReportReader,
  USAGE_GROUP_BY_VALUES,
  type MetricAggregate,
  type UsageGroupBy,
  type UsageReport,
  type UsageReportRow,
} from "@hachi/core";
import type { CliDeps } from "../deps.js";
import { withErrorHandling } from "../errors.js";
import { emit } from "../output.js";

const DEFAULT_DAYS = 30;
const DEFAULT_LIMIT = 20;
const JST_OFFSET_SEC = 9 * 3600;

interface UsageOptions {
  by?: UsageGroupBy;
  days?: number;
  from?: string;
  to?: string;
  tenant?: string;
  task?: string;
  limit?: number;
  json?: boolean;
}

// ---------------------------------------------------------------------------
// 引数のパース（fail-closed）
// ---------------------------------------------------------------------------

function parseGroupBy(value: string): UsageGroupBy {
  if (!(USAGE_GROUP_BY_VALUES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`集計軸は ${USAGE_GROUP_BY_VALUES.join(" / ")} のいずれかです: ${value}`);
  }
  return value as UsageGroupBy;
}

function parsePositiveIntArg(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new InvalidArgumentError(`正の整数を指定してください: ${value}`);
  }
  return Number.parseInt(value, 10);
}

/** YYYY-MM-DD を JST の 00:00:00 として epoch 秒へ変換する。 */
function parseDateArg(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new InvalidArgumentError(`日付は YYYY-MM-DD 形式で指定してください: ${value}`);
  }
  const utcMidnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(utcMidnight)) {
    throw new InvalidArgumentError(`日付として解釈できません: ${value}`);
  }
  return Math.floor(utcMidnight / 1000) - JST_OFFSET_SEC;
}

/** 期間を決める。--from/--to があればそちらが優先で、無ければ --days で遡る。 */
export function resolvePeriod(options: UsageOptions, now: number): { from: number; to: number } {
  const to = options.to === undefined ? now : parseDateArg(options.to) + 24 * 3600 - 1;
  const from = options.from === undefined ? to - (options.days ?? DEFAULT_DAYS) * 24 * 3600 : parseDateArg(options.from);
  if (from > to) {
    throw new Error(`期間の指定が逆転しています（from=${from} > to=${to}）`);
  }
  return { from, to };
}

// ---------------------------------------------------------------------------
// 表示整形
// ---------------------------------------------------------------------------

/** 全角文字を2桁として数える表示幅。日本語のタスク title が混ざる列で桁がずれないようにする。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function padCell(text: string, width: number, align: "left" | "right"): string {
  const pad = " ".repeat(Math.max(0, width - displayWidth(text)));
  return align === "right" ? `${pad}${text}` : `${text}${pad}`;
}

/** ヘッダ + 行から桁揃えしたテキスト表を作る（列区切りは2スペース）。 */
export function formatTable(headers: string[], rows: string[][], aligns: Array<"left" | "right">): string[] {
  const widths = headers.map((header, i) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[i] ?? ""))),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => padCell(cell, widths[i] ?? 0, aligns[i] ?? "left"))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

/** 値が1件も無い欄は 0 ではなく "-"。実測ゼロと未取得を見た目で区別する。 */
function formatUsd(agg: { total: number; runCount: number }): string {
  return agg.runCount === 0 ? "-" : `$${agg.total.toFixed(4)}`;
}

function formatTokens(agg: { total: number; runCount: number }): string {
  return agg.runCount === 0 ? "-" : agg.total.toLocaleString("en-US");
}

function formatDate(epochSec: number): string {
  return new Date((epochSec + JST_OFFSET_SEC) * 1000).toISOString().slice(0, 10);
}

const AXIS_LABEL: Record<UsageGroupBy, string> = {
  task: "task",
  tenant: "tenant",
  model: "model",
  effort: "effort",
  provider: "provider",
  role: "role",
};

function excludedSummary(agg: MetricAggregate): string {
  if (agg.excluded.total === 0) {
    return "0";
  }
  const parts: string[] = [];
  if (agg.excluded.unavailableByDesign > 0) {
    parts.push(`価格表外 ${agg.excluded.unavailableByDesign}`);
  }
  if (agg.excluded.notProvided > 0) {
    parts.push(`未提供 ${agg.excluded.notProvided}`);
  }
  if (agg.excluded.unknown > 0) {
    parts.push(`不明 ${agg.excluded.unknown}`);
  }
  if (agg.excluded.legacyUnverified > 0) {
    parts.push(`旧形式 ${agg.excluded.legacyUnverified}`);
  }
  return `${agg.excluded.total} (${parts.join(" / ")})`;
}

function costRows(rows: UsageReportRow[], total: UsageReportRow): string[][] {
  const body = rows.map((row) => [
    row.label,
    String(row.runCount),
    formatUsd(row.costUsd.estimated),
    formatUsd(row.costUsd.measured),
    excludedSummary(row.costUsd),
  ]);
  body.push([
    "(合計)",
    String(total.runCount),
    formatUsd(total.costUsd.estimated),
    formatUsd(total.costUsd.measured),
    excludedSummary(total.costUsd),
  ]);
  return body;
}

function tokenRows(rows: UsageReportRow[], total: UsageReportRow): string[][] {
  const toRow = (row: UsageReportRow): string[] => [
    row.label,
    formatTokens(row.inputTokens.measured),
    formatTokens(row.outputTokens.measured),
    formatTokens(row.cacheCreationTokens.measured),
    formatTokens(row.cacheReadTokens.measured),
    formatTokens(row.turns.measured),
  ];
  return [...rows.map(toRow), toRow({ ...total, label: "(合計)" })];
}

/** レポートを人が読める行列へ整形する。 */
export function renderUsageReport(report: UsageReport, shownRows: UsageReportRow[], truncated: number): string[] {
  const axis = AXIS_LABEL[report.groupBy];
  const lines: string[] = [
    `=== usage: ${axis} 別 (${formatDate(report.period.from)} 〜 ${formatDate(report.period.to)} JST) ===`,
  ];

  if (report.coverage.aggregatedRuns === 0) {
    lines.push("(集計対象の run はありません)");
  } else {
    lines.push(
      ...formatTable(
        [axis, "runs", "推定コスト", "実測コスト", "除外run"],
        costRows(shownRows, report.total),
        ["left", "right", "right", "right", "left"],
      ),
    );
    if (truncated > 0) {
      lines.push(`(残り ${truncated} 行は --limit で表示できます。(合計) 行は全行を含みます)`);
    }
    lines.push("");
    lines.push("=== トークン内訳（すべて実測） ===");
    lines.push(
      ...formatTable(
        [axis, "input", "output", "cache write", "cache read", "turns"],
        tokenRows(shownRows, report.total),
        ["left", "right", "right", "right", "right", "right"],
      ),
    );
  }

  lines.push("");
  lines.push("=== カバレッジ ===");
  const c = report.coverage;
  lines.push(`期間内 run: ${c.totalRuns}（集計対象 ${c.aggregatedRuns} / 未終端 ${c.runningRuns} / 重複除外 ${c.duplicateRuns}）`);
  lines.push(
    `内訳: usage 記録あり ${c.withUsageRuns} / 旧 lastResult のみ ${c.legacyOnlyRuns}（legacy-unverified・値は未使用） / 記録なし ${c.noUsageRuns}`,
  );

  lines.push("");
  lines.push("=== 注記 ===");
  lines.push("推定コストは価格表からの合成値です（provider のログに USD は存在しません）。実測コストとは合算していません。");
  lines.push("集計は task_runs.meta.usage の保存値をそのまま合算します。価格表を引き直した再計算は行いません。");
  if (report.total.models.length > 0) {
    lines.push(
      `各 run のコストには subagent / advisor が使った他モデル分も含みます（launch 時の model と一致するとは限りません）。実際に消費したモデル: ${report.total.models.join(", ")}`,
    );
  }
  if (report.priceTableRefs.length > 0) {
    lines.push(`価格表: ${report.priceTableRefs.join(", ")}`);
  }
  if (report.priceTableMixed) {
    lines.push("警告: 複数版の価格表が混在しています。推定コストは単一版で再計算した値ではありません。");
  }
  if (report.total.unpricedModels.length > 0) {
    lines.push(
      `価格表に無いモデルを含む run は cost 全体が unavailable-by-design になります（部分合計を出さない設計）: ${report.total.unpricedModels.join(", ")}`,
    );
  }

  return lines;
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

function runUsage(deps: CliDeps, options: UsageOptions): void {
  const now = Math.floor(Date.now() / 1000);
  const period = resolvePeriod(options, now);
  const groupBy = options.by ?? "task";

  const reader = new UsageReportReader(deps.env.dbPath);
  let report: UsageReport;
  try {
    report = reader.query({
      from: period.from,
      to: period.to,
      groupBy,
      ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
      ...(options.task === undefined ? {} : { taskId: options.task }),
    });
  } finally {
    reader.close();
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  const shownRows = report.rows.slice(0, limit);
  const truncated = report.rows.length - shownRows.length;

  // JSON は集計結果をそのまま出す（state / provenance / 価格表版を落とさない）。
  // 表示都合の limit は JSON へ適用しない——機械可読面で行が黙って消えるのを避ける。
  emit(deps, options.json === true, report, renderUsageReport(report, shownRows, truncated));
}

export function registerUsageCommand(program: Command, deps: CliDeps): void {
  program
    .command("usage")
    .description("run の token/cost を task/tenant/model/effort 別に集計する（read-only）")
    .option(
      `--by <axis>`,
      `集計軸（${USAGE_GROUP_BY_VALUES.join(" / ")}、既定 task）`,
      parseGroupBy,
    )
    .option("--days <n>", `遡る日数（既定 ${DEFAULT_DAYS}）`, parsePositiveIntArg)
    .option("--from <YYYY-MM-DD>", "集計開始日（JST）。指定時は --days より優先する")
    .option("--to <YYYY-MM-DD>", "集計終了日（JST、当日を含む）")
    .option("--tenant <tenant>", "指定 tenant のタスクのみに絞り込む")
    .option("--task <taskId>", "指定タスクの run のみに絞り込む")
    .option("--limit <n>", `テキスト表示の行数上限（既定 ${DEFAULT_LIMIT}。--json には適用しない）`, parsePositiveIntArg)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(deps, (options: UsageOptions): void => {
        runUsage(deps, options);
      }),
    );
}
