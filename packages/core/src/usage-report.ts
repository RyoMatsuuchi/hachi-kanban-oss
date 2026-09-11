// =============================================================================
// task_runs.meta.usage を task / tenant / model / effort 軸で比較するための read model
// （契約 §14.5.1、設計 docs/plans/direct-run-usage-cost-audit.md §4.2-4.3 / R4-R7）。
//
// 設計上ここが守る不変条件は3つ。
//  1. `measured` と `estimated` を**決して合算しない**。別フィールドに分けて持ち、表示も別列にする
//  2. 集計から外した run は必ず**件数として残す**。総額だけを見せると欠落が観測できず誤読される
//  3. 同一 (provider, sessionId) の usage は**一度しか数えない**。ネイティブログは累積値のため、
//     同じセッションを2行から数えると桁が狂う
//
// 生 SQL はこのモジュール（と metrics.ts）に閉じる。CLI / Web は集計結果だけを受け取る（§4.3）。
// =============================================================================

import Database from "better-sqlite3";
import type { MetricProvenance, MetricValue, RunStatus, RunUsage } from "./types.js";

// ---------------------------------------------------------------------------
// 集計軸と入力レコード
// ---------------------------------------------------------------------------

/** 集計軸。task は worker / reviewer / rework の全 run を1タスクへ合算する。 */
export type UsageGroupBy = "task" | "tenant" | "model" | "effort" | "provider" | "role";

export const USAGE_GROUP_BY_VALUES: readonly UsageGroupBy[] = [
  "task",
  "tenant",
  "model",
  "effort",
  "provider",
  "role",
];

/** 未設定の軸値に使うラベル。空文字のまま並べると「値が無い」ことが読めないため明示する。 */
export const UNSPECIFIED_GROUP_LABEL = "(未指定)";

/**
 * 集計対象の run 1件。DB 行から**非 secret のフィールドだけ**を取り出したもの
 * （allowlist 抽出。設計 §3.3。prompt 本文 / raw payload はここに入れない）。
 */
export interface UsageRunRecord {
  runId: number;
  taskId: string;
  taskTitle: string;
  tenant: string;
  provider: string;
  sessionId: string;
  status: RunStatus;
  startedAt: number;
  /** run.meta.model（launch 時に解決したモデル＝評価対象の routing 判断） */
  model: string;
  /** run.meta.effort */
  effort: string;
  /** run.meta.role（worker / reviewer） */
  role: string;
  /** meta.usage。壊れていた / 無い場合は null */
  usage: RunUsage | null;
  /** usage は無いが旧 meta.lastResult を持つか（legacy-unverified として件数だけ数える） */
  hasLegacyLastResult: boolean;
}

// ---------------------------------------------------------------------------
// 集計結果
// ---------------------------------------------------------------------------

/** 実測値の集計。`estimated` は絶対にここへ入らない。 */
export interface MeasuredAggregate {
  total: number;
  runCount: number;
  /** 寄与した provenance の集合（監査用。§4.3） */
  provenances: MetricProvenance[];
}

/** 推定値の集計。`measured` は絶対にここへ入らない。 */
export interface EstimatedAggregate {
  total: number;
  runCount: number;
  /** 寄与した価格表の版。2つ以上あれば版跨ぎの合算になっている（表示側で注意喚起する） */
  priceTableRefs: string[];
}

/** 既定集計から外した run の内訳。値は一切合算せず件数だけを持つ。 */
export interface ExcludedCounts {
  notProvided: number;
  unavailableByDesign: number;
  unknown: number;
  legacyUnverified: number;
  /** 上4つの合計（表示側で毎回足させないための便宜フィールド） */
  total: number;
}

/** metric 1つぶんの集計。measured / estimated / 除外を構造的に分ける。 */
export interface MetricAggregate {
  measured: MeasuredAggregate;
  estimated: EstimatedAggregate;
  excluded: ExcludedCounts;
}

/** 集計軸1グループぶんの行。 */
export interface UsageReportRow {
  /** グループキー（task なら taskId、model ならモデル id） */
  key: string;
  /** 表示名。task のみ title を併記する */
  label: string;
  /** このグループに属する run 数（重複排除後） */
  runCount: number;
  costUsd: MetricAggregate;
  inputTokens: MetricAggregate;
  outputTokens: MetricAggregate;
  cacheCreationTokens: MetricAggregate;
  cacheReadTokens: MetricAggregate;
  turns: MetricAggregate;
  durationMs: MetricAggregate;
  /** 実際にトークンを消費したモデル id。subagent / advisor 分を含むため launch model と一致しない */
  models: string[];
  /** cost を unavailable-by-design にした原因モデル。1つでもあると run 全体の cost が出ない */
  unpricedModels: string[];
}

/** どれだけの run を実際に集計できたかの内訳。総額の読み方はこれとセットでしか決まらない。 */
export interface UsageCoverage {
  /** 期間内の run 行数（running を含む全件） */
  totalRuns: number;
  /** 実際に集計へ入った run 数（終端済み・重複排除後） */
  aggregatedRuns: number;
  /** そのうち meta.usage を持っていた run 数 */
  withUsageRuns: number;
  /** usage が無く旧 lastResult だけある run 数（legacy-unverified。値は使わない） */
  legacyOnlyRuns: number;
  /** usage も lastResult も無い run 数 */
  noUsageRuns: number;
  /** 同一 (provider, sessionId) の重複として落とした run 数 */
  duplicateRuns: number;
  /** 未終端（status='running'）のため対象外にした run 数 */
  runningRuns: number;
}

export interface UsageReport {
  period: { from: number; to: number };
  groupBy: UsageGroupBy;
  rows: UsageReportRow[];
  /** 全グループを合算した総計行（key='(total)'） */
  total: UsageReportRow;
  coverage: UsageCoverage;
  /** 推定 cost に寄与した価格表の版 */
  priceTableRefs: string[];
  /** 版が2つ以上混ざっているか。true なら推定額は単一版での再計算結果ではない */
  priceTableMixed: boolean;
}

export interface AggregateUsageOptions {
  groupBy: UsageGroupBy;
  period: { from: number; to: number };
}

// ---------------------------------------------------------------------------
// metric の畳み込み
// ---------------------------------------------------------------------------

function emptyMetricAggregate(): MetricAggregate {
  return {
    measured: { total: 0, runCount: 0, provenances: [] },
    estimated: { total: 0, runCount: 0, priceTableRefs: [] },
    excluded: { notProvided: 0, unavailableByDesign: 0, unknown: 0, legacyUnverified: 0, total: 0 },
  };
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}

/**
 * MetricValue を集計へ畳み込む。
 *
 * `switch (metric.state)` の網羅性検査がこの関数の要で、将来 state が増えたときに
 * 「どのバケツに入れるか」を書き忘れたままコンパイルが通ることを防ぐ。
 * `legacy-unverified` は value を持つが**意図的に読まない**（§R5）。
 */
function foldMetric(agg: MetricAggregate, metric: MetricValue): void {
  switch (metric.state) {
    case "measured":
      agg.measured.total += metric.value;
      agg.measured.runCount += 1;
      pushUnique(agg.measured.provenances, metric.provenance);
      return;
    case "estimated":
      agg.estimated.total += metric.value;
      agg.estimated.runCount += 1;
      pushUnique(agg.estimated.priceTableRefs, metric.priceTableRef);
      return;
    case "not-provided":
      agg.excluded.notProvided += 1;
      agg.excluded.total += 1;
      return;
    case "unavailable-by-design":
      agg.excluded.unavailableByDesign += 1;
      agg.excluded.total += 1;
      return;
    case "unknown":
      agg.excluded.unknown += 1;
      agg.excluded.total += 1;
      return;
    case "legacy-unverified":
      agg.excluded.legacyUnverified += 1;
      agg.excluded.total += 1;
      return;
  }
}

/** usage を持たない run を除外バケツへ数える。値を持たないので合算経路自体が無い。 */
function foldMissingUsage(agg: MetricAggregate, hasLegacyLastResult: boolean): void {
  if (hasLegacyLastResult) {
    agg.excluded.legacyUnverified += 1;
  } else {
    agg.excluded.unknown += 1;
  }
  agg.excluded.total += 1;
}

/** MetricAggregate をもう一方へ足し込む（総計行の組み立て用）。 */
function mergeMetric(target: MetricAggregate, source: MetricAggregate): void {
  target.measured.total += source.measured.total;
  target.measured.runCount += source.measured.runCount;
  for (const p of source.measured.provenances) {
    pushUnique(target.measured.provenances, p);
  }
  target.estimated.total += source.estimated.total;
  target.estimated.runCount += source.estimated.runCount;
  for (const ref of source.estimated.priceTableRefs) {
    pushUnique(target.estimated.priceTableRefs, ref);
  }
  target.excluded.notProvided += source.excluded.notProvided;
  target.excluded.unavailableByDesign += source.excluded.unavailableByDesign;
  target.excluded.unknown += source.excluded.unknown;
  target.excluded.legacyUnverified += source.excluded.legacyUnverified;
  target.excluded.total += source.excluded.total;
}

/** UsageReportRow の全 metric に対して同じ操作を適用するための metric キー一覧。 */
const METRIC_KEYS = [
  "costUsd",
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "turns",
  "durationMs",
] as const;

type MetricKey = (typeof METRIC_KEYS)[number];

function emptyRow(key: string, label: string): UsageReportRow {
  return {
    key,
    label,
    runCount: 0,
    costUsd: emptyMetricAggregate(),
    inputTokens: emptyMetricAggregate(),
    outputTokens: emptyMetricAggregate(),
    cacheCreationTokens: emptyMetricAggregate(),
    cacheReadTokens: emptyMetricAggregate(),
    turns: emptyMetricAggregate(),
    durationMs: emptyMetricAggregate(),
    models: [],
    unpricedModels: [],
  };
}

// ---------------------------------------------------------------------------
// 重複排除（§4.3）
// ---------------------------------------------------------------------------

/**
 * provenance の優先順位。同一セッションが複数経路から記録された場合にどれを採るか。
 * ネイティブログが最優先なのは、契約 §14.5.1 がそれを正本と定めているため
 * （bridge の result イベントは codex で全項目0の偽ゼロを出した実績がある）。
 */
const PROVENANCE_RANK: Record<MetricProvenance, number> = {
  "cli-native-session-log": 3,
  "cli-json-result": 2,
  "bridge-result-event": 1,
};

/** run の usage 全体を代表する provenance（最初に見つかった measured のもの）。 */
export function runUsageProvenance(usage: RunUsage): MetricProvenance | null {
  for (const key of METRIC_KEYS) {
    const metric = usage[key];
    if (metric.state === "measured") {
      return metric.provenance;
    }
  }
  return null;
}

function dedupeRank(record: UsageRunRecord): number {
  if (record.usage === null) {
    return 0;
  }
  const provenance = runUsageProvenance(record.usage);
  // usage はあるが measured が1つも無い（全項目 unavailable 等）場合も、無記録より優先する。
  return provenance === null ? 1 : PROVENANCE_RANK[provenance] + 1;
}

/**
 * 同一 (provider, sessionId) の run を1件へ畳む。
 *
 * ネイティブログは `total_token_usage` のような**累積値**を持つため、同じセッションを指す行を
 * 2つ数えると単純に倍になる。bridge result 由来と native log 由来が同じセッションについて
 * 両方記録された場合も、ここで provenance の優先順位により1件だけが残る。
 * sessionId が空の run は同一性を判定できないため畳まない（run ごとに一意なキーを与える）。
 */
export function dedupeUsageRuns(records: readonly UsageRunRecord[]): {
  kept: UsageRunRecord[];
  duplicateRuns: number;
} {
  const winners = new Map<string, UsageRunRecord>();
  const order: string[] = [];
  let duplicateRuns = 0;

  for (const record of records) {
    const key = record.sessionId === ""
      ? `run:${record.runId}`
      : `session:${record.provider} ${record.sessionId}`;
    const current = winners.get(key);
    if (current === undefined) {
      winners.set(key, record);
      order.push(key);
      continue;
    }
    duplicateRuns += 1;
    const currentRank = dedupeRank(current);
    const candidateRank = dedupeRank(record);
    // 同順位なら run id が大きい（後から書かれた）方を採る。
    if (candidateRank > currentRank || (candidateRank === currentRank && record.runId > current.runId)) {
      winners.set(key, record);
    }
  }

  return { kept: order.map((key) => winners.get(key) as UsageRunRecord), duplicateRuns };
}

// ---------------------------------------------------------------------------
// 集計本体
// ---------------------------------------------------------------------------

function truncateTitle(title: string, max = 48): string {
  return title.length <= max ? title : title.slice(0, max);
}

function groupKeyOf(record: UsageRunRecord, groupBy: UsageGroupBy): { key: string; label: string } {
  switch (groupBy) {
    case "task":
      return {
        key: record.taskId,
        label: record.taskTitle === "" ? record.taskId : `${record.taskId} ${truncateTitle(record.taskTitle)}`,
      };
    case "tenant":
      return { key: record.tenant, label: record.tenant === "" ? UNSPECIFIED_GROUP_LABEL : record.tenant };
    case "model":
      return { key: record.model, label: record.model === "" ? UNSPECIFIED_GROUP_LABEL : record.model };
    case "effort":
      return { key: record.effort, label: record.effort === "" ? UNSPECIFIED_GROUP_LABEL : record.effort };
    case "provider":
      return { key: record.provider, label: record.provider === "" ? UNSPECIFIED_GROUP_LABEL : record.provider };
    case "role":
      return { key: record.role, label: record.role === "" ? UNSPECIFIED_GROUP_LABEL : record.role };
  }
}

function foldRecordInto(row: UsageReportRow, record: UsageRunRecord): void {
  row.runCount += 1;
  const usage = record.usage;
  if (usage === null) {
    for (const key of METRIC_KEYS) {
      foldMissingUsage(row[key], record.hasLegacyLastResult);
    }
    return;
  }
  for (const key of METRIC_KEYS) {
    foldMetric(row[key], usage[key]);
  }
  for (const model of usage.models ?? []) {
    pushUnique(row.models, model);
  }
  for (const model of usage.unpricedModels ?? []) {
    pushUnique(row.unpricedModels, model);
  }
}

/**
 * 行の並び順。推定コストの大きい順（＝金額の比較がしたくてこの表を見るため）。
 * 同額なら実測トークン、run 数、キーの順で決定的に並べる。
 */
function compareRows(a: UsageReportRow, b: UsageReportRow): number {
  if (b.costUsd.estimated.total !== a.costUsd.estimated.total) {
    return b.costUsd.estimated.total - a.costUsd.estimated.total;
  }
  if (b.costUsd.measured.total !== a.costUsd.measured.total) {
    return b.costUsd.measured.total - a.costUsd.measured.total;
  }
  const aTokens = a.inputTokens.measured.total + a.outputTokens.measured.total;
  const bTokens = b.inputTokens.measured.total + b.outputTokens.measured.total;
  if (bTokens !== aTokens) {
    return bTokens - aTokens;
  }
  if (b.runCount !== a.runCount) {
    return b.runCount - a.runCount;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * run レコード列を集計する（純関数。DB へは触れない）。
 *
 * - `status='running'` の run は集計へ入れない（usage は endRun 時にしか書かれないため、
 *   混ぜると in-flight 分がそのまま「取得失敗」に見える）。件数は coverage に残す
 * - 同一 (provider, sessionId) は1件に畳む（重複排除）
 * - `measured` と `estimated` は別フィールドへ積み、合算しない
 */
export function aggregateUsage(
  records: readonly UsageRunRecord[],
  options: AggregateUsageOptions,
): UsageReport {
  const running = records.filter((r) => r.status === "running");
  const terminal = records.filter((r) => r.status !== "running");
  const { kept, duplicateRuns } = dedupeUsageRuns(terminal);

  const rowsByKey = new Map<string, UsageReportRow>();
  const total = emptyRow("(total)", "(total)");
  let withUsageRuns = 0;
  let legacyOnlyRuns = 0;
  let noUsageRuns = 0;

  for (const record of kept) {
    const { key, label } = groupKeyOf(record, options.groupBy);
    let row = rowsByKey.get(key);
    if (row === undefined) {
      row = emptyRow(key, label);
      rowsByKey.set(key, row);
    }
    foldRecordInto(row, record);

    if (record.usage !== null) {
      withUsageRuns += 1;
    } else if (record.hasLegacyLastResult) {
      legacyOnlyRuns += 1;
    } else {
      noUsageRuns += 1;
    }
  }

  const rows = [...rowsByKey.values()].sort(compareRows);
  for (const row of rows) {
    total.runCount += row.runCount;
    for (const key of METRIC_KEYS) {
      mergeMetric(total[key], row[key]);
    }
    for (const model of row.models) {
      pushUnique(total.models, model);
    }
    for (const model of row.unpricedModels) {
      pushUnique(total.unpricedModels, model);
    }
  }
  total.models.sort();
  total.unpricedModels.sort();
  for (const row of rows) {
    row.models.sort();
    row.unpricedModels.sort();
  }

  const priceTableRefs = [...total.costUsd.estimated.priceTableRefs].sort();

  return {
    period: options.period,
    groupBy: options.groupBy,
    rows,
    total,
    coverage: {
      totalRuns: records.length,
      aggregatedRuns: kept.length,
      withUsageRuns,
      legacyOnlyRuns,
      noUsageRuns,
      duplicateRuns,
      runningRuns: running.length,
    },
    priceTableRefs,
    priceTableMixed: priceTableRefs.length > 1,
  };
}

// ---------------------------------------------------------------------------
// meta のパース（fail-closed）
// ---------------------------------------------------------------------------

const PROVENANCE_VALUES: readonly MetricProvenance[] = [
  "bridge-result-event",
  "cli-json-result",
  "cli-native-session-log",
];

function isProvenance(value: unknown): value is MetricProvenance {
  return typeof value === "string" && (PROVENANCE_VALUES as readonly string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * MetricValue を検証しながら復元する。想定外の形は null（＝usage 全体を無効扱い）にする。
 * 「値らしきものがあるから採る」方式にすると、今回の根因である偽ゼロを再び通してしまう。
 */
export function parseMetricValue(raw: unknown): MetricValue | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  switch (record.state) {
    case "measured":
      return isFiniteNumber(record.value) && isProvenance(record.provenance)
        ? { state: "measured", value: record.value, provenance: record.provenance }
        : null;
    case "estimated":
      return isFiniteNumber(record.value) && record.basis === "price-table" && typeof record.priceTableRef === "string"
        ? { state: "estimated", value: record.value, basis: "price-table", priceTableRef: record.priceTableRef }
        : null;
    case "not-provided":
      return { state: "not-provided" };
    case "unavailable-by-design":
      return { state: "unavailable-by-design" };
    case "unknown":
      return { state: "unknown" };
    case "legacy-unverified":
      return isFiniteNumber(record.value) ? { state: "legacy-unverified", value: record.value } : null;
    default:
      return null;
  }
}

function parseStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const values = raw.filter((v): v is string => typeof v === "string");
  return values.length === 0 ? undefined : values;
}

/**
 * `task_runs.meta.usage` を復元する。7つの metric が1つでも壊れていれば usage 全体を null にする
 * （部分的に読めた値だけを集計へ入れると、欠落が見えないまま総額が小さく出る）。
 */
export function parseRunUsage(raw: unknown): RunUsage | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.collectedBy !== "string") {
    return null;
  }
  const metrics: Partial<Record<MetricKey, MetricValue>> = {};
  for (const key of METRIC_KEYS) {
    const parsed = parseMetricValue(record[key]);
    if (parsed === null) {
      return null;
    }
    metrics[key] = parsed;
  }
  const models = parseStringArray(record.models);
  const unpricedModels = parseStringArray(record.unpricedModels);
  return {
    costUsd: metrics.costUsd as MetricValue,
    inputTokens: metrics.inputTokens as MetricValue,
    outputTokens: metrics.outputTokens as MetricValue,
    cacheCreationTokens: metrics.cacheCreationTokens as MetricValue,
    cacheReadTokens: metrics.cacheReadTokens as MetricValue,
    turns: metrics.turns as MetricValue,
    durationMs: metrics.durationMs as MetricValue,
    collectedBy: record.collectedBy,
    ...(models === undefined ? {} : { models }),
    ...(unpricedModels === undefined ? {} : { unpricedModels }),
  };
}

/** run.meta（JSON 文字列）から集計に必要な非 secret フィールドだけを取り出す。 */
export function parseUsageRunMeta(meta: string): {
  model: string;
  effort: string;
  role: string;
  usage: RunUsage | null;
  hasLegacyLastResult: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(meta);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { model: "", effort: "", role: "", usage: null, hasLegacyLastResult: false };
  }
  const record = parsed as Record<string, unknown>;
  return {
    model: typeof record.model === "string" ? record.model : "",
    effort: typeof record.effort === "string" ? record.effort : "",
    role: typeof record.role === "string" ? record.role : "",
    usage: parseRunUsage(record.usage),
    hasLegacyLastResult: typeof record.lastResult === "object" && record.lastResult !== null,
  };
}

// ---------------------------------------------------------------------------
// readonly リーダー
// ---------------------------------------------------------------------------

export interface UsageReportQueryOptions {
  from: number;
  to: number;
  groupBy: UsageGroupBy;
  /** 指定時はこの tenant のタスクに属する run だけを対象にする */
  tenant?: string;
  /** 指定時はこのタスクの run だけを対象にする */
  taskId?: string;
}

interface RawUsageRunRow {
  id: number;
  task_id: string;
  provider: string;
  session_id: string;
  status: string;
  meta: string;
  started_at: number;
  tenant: string;
  title: string;
}

const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["done", "failed", "released"];

function normalizeRunStatus(status: string): RunStatus {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status) ? (status as RunStatus) : "running";
}

/**
 * usage 集計の readonly リーダー（MetricsReader と同型）。
 * 書き込み・migration は一切行わない。
 */
export class UsageReportReader {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.db.pragma("busy_timeout = 5000");
  }

  /** 期間内の run を読み出し、集計済みレポートを返す。 */
  query(options: UsageReportQueryOptions): UsageReport {
    return aggregateUsage(this.records(options), {
      groupBy: options.groupBy,
      period: { from: options.from, to: options.to },
    });
  }

  /** 集計前の run レコード（テストと診断用に公開する）。 */
  records(options: UsageReportQueryOptions): UsageRunRecord[] {
    const filters: string[] = ["r.started_at >= ?", "r.started_at <= ?"];
    const params: Array<string | number> = [options.from, options.to];
    if (options.tenant !== undefined) {
      filters.push("t.tenant = ?");
      params.push(options.tenant);
    }
    if (options.taskId !== undefined) {
      filters.push("r.task_id = ?");
      params.push(options.taskId);
    }
    const rows = this.db
      .prepare(
        `SELECT r.id, r.task_id, r.provider, r.session_id, r.status, r.meta, r.started_at,
                COALESCE(t.tenant, '') AS tenant, COALESCE(t.title, '') AS title
         FROM task_runs r
         JOIN tasks t ON t.id = r.task_id
         WHERE ${filters.join(" AND ")}
         ORDER BY r.id`,
      )
      .all(...params) as RawUsageRunRow[];

    return rows.map((row) => {
      const meta = parseUsageRunMeta(row.meta);
      return {
        runId: row.id,
        taskId: row.task_id,
        taskTitle: row.title,
        tenant: row.tenant,
        provider: row.provider,
        sessionId: row.session_id,
        status: normalizeRunStatus(row.status),
        startedAt: row.started_at,
        model: meta.model,
        effort: meta.effort,
        role: meta.role,
        usage: meta.usage,
        hasLegacyLastResult: meta.hasLegacyLastResult,
      };
    });
  }

  close(): void {
    this.db.close();
  }
}
