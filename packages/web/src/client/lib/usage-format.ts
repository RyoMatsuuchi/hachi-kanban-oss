// =============================================================================
// usage（task_runs.meta.usage）表示用の整形ヘルパー（契約 §14.5.1）。
//
// 既存の formatStat は `number | undefined | null` しか受けられず、
// 「実測ゼロ」と「未取得」を区別できない。usage は state を持つタグ付き値なので、
// state ごとに別の表記へ落とす専用の整形をここに置く。
// =============================================================================

import type { MetricValue } from "@hachi/core";
import type { UsageEstimatedAggregate, UsageMeasuredAggregate, UsageMetricAggregate } from "../../shared/api-types.js";

/** 未取得を表す記号。0 と混同させないため数値表記は使わない。 */
export const NOT_AVAILABLE = "-";

/** 集計値の USD 表記。寄与した run が1件も無ければ 0 ではなく "-"。 */
export function formatUsageUsd(agg: UsageMeasuredAggregate | UsageEstimatedAggregate): string {
  return agg.runCount === 0 ? NOT_AVAILABLE : `$${agg.total.toFixed(4)}`;
}

/** 集計値のトークン表記。寄与した run が1件も無ければ "-"。 */
export function formatUsageTokens(agg: UsageMeasuredAggregate | UsageEstimatedAggregate): string {
  return agg.runCount === 0 ? NOT_AVAILABLE : agg.total.toLocaleString("en-US");
}

/** 除外 run の内訳を1行の日本語にする。0 件なら "0"。 */
export function formatExcluded(agg: UsageMetricAggregate): string {
  const { excluded } = agg;
  if (excluded.total === 0) {
    return "0";
  }
  const parts: string[] = [];
  if (excluded.unavailableByDesign > 0) {
    parts.push(`価格表外 ${excluded.unavailableByDesign}`);
  }
  if (excluded.notProvided > 0) {
    parts.push(`未提供 ${excluded.notProvided}`);
  }
  if (excluded.unknown > 0) {
    parts.push(`不明 ${excluded.unknown}`);
  }
  if (excluded.legacyUnverified > 0) {
    parts.push(`旧形式 ${excluded.legacyUnverified}`);
  }
  return `${excluded.total} (${parts.join(" / ")})`;
}

/** MetricValue 1件の表示。state を見た目に残すのが目的で、値だけを裸で出さない。 */
export interface FormattedMetric {
  text: string;
  /** state を人へ伝える注記（実測値には付けない） */
  note: string | null;
  tone: "measured" | "estimated" | "muted";
}

function formatNumber(value: number, kind: "usd" | "count"): string {
  return kind === "usd" ? `$${value.toFixed(4)}` : value.toLocaleString("en-US");
}

/**
 * MetricValue を表示用に落とす。
 * `switch (metric.state)` の網羅性検査により、state が増えたときに表記の追加漏れを防ぐ。
 */
export function formatMetricValue(metric: MetricValue, kind: "usd" | "count" = "count"): FormattedMetric {
  switch (metric.state) {
    case "measured":
      return { text: formatNumber(metric.value, kind), note: null, tone: "measured" };
    case "estimated":
      return { text: formatNumber(metric.value, kind), note: "推定", tone: "estimated" };
    case "not-provided":
      return { text: NOT_AVAILABLE, note: "未提供", tone: "muted" };
    case "unavailable-by-design":
      return { text: "N/A", note: "対象外", tone: "muted" };
    case "unknown":
      return { text: NOT_AVAILABLE, note: "不明", tone: "muted" };
    case "legacy-unverified":
      return { text: formatNumber(metric.value, kind), note: "旧形式・未検証", tone: "muted" };
  }
}
