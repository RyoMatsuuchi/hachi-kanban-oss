// =============================================================================
// メトリクス画面（docs/contract.md §43.2）。
// スループット / run 成功率 / rework 率 / human_queue 滞留分布 /
// profile×provider コストを §37 トーンで表示する。外部チャートライブラリ不使用。
// =============================================================================

import type { JSX } from "react";
import { useMetrics } from "../hooks/use-metrics.js";
import { Card } from "./Card.js";
import { TH_CLASS, TD_CLASS, TR_CLASS, THEAD_ROW_CLASS } from "../lib/table-styles.js";
import type {
  MetricsDailyThroughput,
  MetricsHumanQueueDwell,
  MetricsProfileProviderStat,
} from "../../shared/api-types.js";

/** 期間選択ボタン */
const PERIOD_OPTIONS = [
  { label: "7日", days: 7 },
  { label: "14日", days: 14 },
  { label: "30日", days: 30 },
  { label: "90日", days: 90 },
] as const;

type KpiTone = "ok" | "warn" | "danger" | "neutral";

function PeriodSelector(props: {
  current: number;
  onChange: (days: number) => void;
}): JSX.Element {
  return (
    <div className="flex gap-1">
      {PERIOD_OPTIONS.map((opt) => (
        <button
          key={opt.days}
          type="button"
          onClick={() => props.onChange(opt.days)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
            props.current === opt.days
              ? "bg-accent text-on-accent"
              : "bg-surface-muted text-ink-muted hover:bg-surface hover:text-ink"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** パーセンテージ表示ヘルパー */
function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** コスト表示ヘルパー */
function usd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

/** CSS-only 横棒グラフ（スループット用） */
function ThroughputChart(props: { data: MetricsDailyThroughput[] }): JSX.Element {
  const { data } = props;
  if (data.length === 0) {
    return <p className="py-4 text-center text-sm text-ink-muted">データなし</p>;
  }
  const maxCount = Math.max(...data.map((d) => d.count), 1);

  return (
    <div className="space-y-1">
      {data.map((d) => (
        <div key={d.date} className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 text-right font-mono text-ink-muted">
            {d.date.slice(5)}
          </span>
          <div className="relative h-5 flex-1 rounded bg-surface-muted">
            <div
              className="absolute inset-y-0 left-0 rounded bg-ok-soft"
              style={{ width: `${(d.count / maxCount) * 100}%` }}
            />
            <span className="relative z-10 flex h-full items-center px-1.5 text-ok-strong font-medium">
              {d.count > 0 ? d.count : ""}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** サマリーカード（KPI 1つ分） */
function KpiCard(props: {
  title: string;
  value: string;
  sub?: string;
  tone?: KpiTone;
}): JSX.Element {
  const toneClass = {
    ok: "text-ok-strong",
    warn: "text-warn-strong",
    danger: "text-danger-strong",
    neutral: "text-ink",
  }[props.tone ?? "neutral"];

  return (
    <div className="rounded-md border border-line bg-surface p-3">
      <p className="text-xs font-medium text-ink-muted">{props.title}</p>
      <p className={`mt-1 text-2xl font-semibold ${toneClass}`}>{props.value}</p>
      {props.sub !== undefined && (
        <p className="mt-0.5 text-xs text-ink-muted">{props.sub}</p>
      )}
    </div>
  );
}

function runSuccessTone(total: number, rate: number): KpiTone {
  if (total === 0) {
    return "neutral";
  }
  if (rate >= 0.9) {
    return "ok";
  }
  if (rate >= 0.7) {
    return "warn";
  }
  return "danger";
}

function reworkTone(totalDone: number, rate: number): KpiTone {
  if (totalDone === 0) {
    return "neutral";
  }
  if (rate <= 0.1) {
    return "ok";
  }
  if (rate <= 0.3) {
    return "warn";
  }
  return "danger";
}

function unknownTone(total: number, rate: number): KpiTone {
  if (total === 0 || rate === 0) {
    return total === 0 ? "neutral" : "ok";
  }
  return rate <= 0.1 ? "warn" : "danger";
}

/** human_queue 滞留分布バー */
function DwellDistribution(props: { data: MetricsHumanQueueDwell[] }): JSX.Element {
  const { data } = props;
  const total = data.reduce((sum, d) => sum + d.count, 0);
  if (total === 0) {
    return <p className="py-4 text-center text-sm text-ink-muted">データなし</p>;
  }

  return (
    <div className="space-y-1.5">
      {data.map((d) => (
        <div key={d.bucket} className="flex items-center gap-2 text-xs">
          <span className="w-14 shrink-0 text-right font-mono text-ink-muted">{d.bucket}</span>
          <div className="relative h-5 flex-1 rounded bg-surface-muted">
            <div
              className="absolute inset-y-0 left-0 rounded bg-accent-soft"
              style={{ width: `${(d.count / total) * 100}%` }}
            />
            <span className="relative z-10 flex h-full items-center px-1.5 text-accent-strong font-medium">
              {d.count > 0 ? d.count : ""}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** profile × provider テーブル */
function ProfileProviderTable(props: { data: MetricsProfileProviderStat[] }): JSX.Element {
  const { data } = props;
  if (data.length === 0) {
    return <p className="py-4 text-center text-sm text-ink-muted">データなし</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={THEAD_ROW_CLASS}>
            <th className={TH_CLASS}>Profile</th>
            <th className={TH_CLASS}>Provider</th>
            <th className={`${TH_CLASS} text-right`}>Run 数</th>
            <th className={`${TH_CLASS} text-right`}>コスト</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={`${row.profile}-${row.provider}-${i}`} className={TR_CLASS}>
              <td className={TD_CLASS}>
                <span className="rounded bg-surface-muted px-1.5 py-0.5 text-xs font-mono">
                  {row.profile || "(default)"}
                </span>
              </td>
              <td className={TD_CLASS}>
                <span className="text-xs">{row.provider}</span>
              </td>
              <td className={`${TD_CLASS} text-right font-mono`}>{row.runCount}</td>
              <td className={`${TD_CLASS} text-right font-mono`}>{usd(row.totalCostUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** メトリクスページ本体 */
export function MetricsView(): JSX.Element {
  const { data, loading, error, days, setDays } = useMetrics(30);

  if (loading && data === null) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-ink-muted">
        メトリクスを読み込み中…
      </div>
    );
  }

  if (error !== null && data === null) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-danger-strong">
        {error}
      </div>
    );
  }

  if (data === null) {
    return <div />;
  }

  // run 成功率に応じたトーン
  const successTone = runSuccessTone(data.runSuccess.total, data.runSuccess.rate);
  const reworkKpiTone = reworkTone(data.rework.totalDone, data.rework.rate);
  const doneUnknownTone = unknownTone(data.doneOrigins.total, data.doneOrigins.unknownRate);

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-2 py-4 sm:px-4">
      {/* ヘッダー + 期間セレクタ */}
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold text-ink">メトリクス</h1>
        <PeriodSelector current={days} onChange={setDays} />
      </div>

      {/* KPI サマリー */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard
          title="完了タスク"
          value={String(data.throughput.reduce((s, d) => s + d.count, 0))}
          sub={`直近 ${days} 日`}
        />
        <KpiCard
          title="Run 成功率"
          value={pct(data.runSuccess.rate)}
          sub={`${data.runSuccess.succeeded} / ${data.runSuccess.total}`}
          tone={successTone}
        />
        <KpiCard
          title="Rework 率"
          value={pct(data.rework.rate)}
          sub={`${data.rework.reworked} / ${data.rework.totalDone}`}
          tone={reworkKpiTone}
        />
        <KpiCard
          title="Run 総数"
          value={String(data.runSuccess.total)}
          sub={`failed: ${data.runSuccess.failed}`}
        />
      </div>

      {/* done到達由来。unknownは楽観分類せず独立KPIとして残す。 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiCard
          title="Gate 自動完走率"
          value={pct(data.doneOrigins.automaticCompletionRate)}
          sub={`${data.doneOrigins.counts.gatePassed} / ${data.doneOrigins.total}`}
          tone={data.doneOrigins.total === 0 ? "neutral" : "ok"}
        />
        <KpiCard
          title="Manual recovery率"
          value={pct(data.doneOrigins.manualRecoveryRate)}
          sub={`orchestrator ${data.doneOrigins.counts.orchestratorHostFinalize} / human ${data.doneOrigins.counts.humanDecision}`}
          tone="neutral"
        />
        <KpiCard
          title="Done origin unknown"
          value={pct(data.doneOrigins.unknownRate)}
          sub={`${data.doneOrigins.counts.unknown} / ${data.doneOrigins.total}`}
          tone={doneUnknownTone}
        />
      </div>

      {/* スループット（日別 done 数） */}
      <Card title="日別スループット（完了数）">
        <ThroughputChart data={data.throughput} />
      </Card>

      {/* human_queue 滞留分布 */}
      <Card title="人間確認キュー滞留時間">
        <DwellDistribution data={data.humanQueueDwell} />
      </Card>

      {/* profile × provider コスト */}
      <Card title="Profile × Provider">
        <ProfileProviderTable data={data.profileProviderStats} />
      </Card>
    </div>
  );
}
