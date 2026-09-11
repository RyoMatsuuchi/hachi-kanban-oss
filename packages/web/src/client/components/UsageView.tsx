// =============================================================================
// usage 画面（契約 §14.5.1、設計 docs/plans/direct-run-usage-cost-audit.md R4/R7）。
// task_runs.meta.usage を task / tenant / model / effort 別に比較する。
//
// 表示の規律:
//  - 推定コストと実測コストは**別列**。合算した数字を1つも出さない
//  - 集計から外した run の件数を必ず併記する（総額だけを出すと欠落が観測できない）
//  - 値が無い欄は 0 ではなく "-"（実測ゼロと未取得を混同させない）
// =============================================================================

import type { JSX } from "react";
import { useUsage } from "../hooks/use-usage.js";
import { Card } from "./Card.js";
import { TD_CLASS, TH_CLASS, THEAD_ROW_CLASS, TR_CLASS } from "../lib/table-styles.js";
import { formatExcluded, formatUsageTokens, formatUsageUsd } from "../lib/usage-format.js";
import type { UsageGroupByAxis, UsageReportRowResponse, UsageResponse } from "../../shared/api-types.js";

const PERIOD_OPTIONS = [
  { label: "7日", days: 7 },
  { label: "14日", days: 14 },
  { label: "30日", days: 30 },
  { label: "90日", days: 90 },
] as const;

const AXIS_OPTIONS: ReadonlyArray<{ label: string; value: UsageGroupByAxis }> = [
  { label: "task", value: "task" },
  { label: "tenant", value: "tenant" },
  { label: "model", value: "model" },
  { label: "effort", value: "effort" },
  { label: "provider", value: "provider" },
  { label: "role", value: "role" },
];

function ToggleGroup<T extends string | number>(props: {
  options: ReadonlyArray<{ label: string; value: T }>;
  current: T;
  onChange: (value: T) => void;
  testId: string;
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1" data-testid={props.testId}>
      {props.options.map((opt) => (
        <button
          key={String(opt.value)}
          type="button"
          onClick={() => props.onChange(opt.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
            props.current === opt.value
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

function KpiCard(props: { title: string; value: string; sub: string; tone?: "ok" | "warn" | "neutral" }): JSX.Element {
  const tone = props.tone ?? "neutral";
  const valueClass =
    tone === "ok" ? "text-ok-strong" : tone === "warn" ? "text-warn-strong" : "text-ink";
  return (
    <div className="rounded-md border border-line bg-surface p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{props.title}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${valueClass}`}>{props.value}</div>
      <div className="mt-0.5 text-xs text-ink-muted">{props.sub}</div>
    </div>
  );
}

function CostTable(props: { axis: UsageGroupByAxis; rows: UsageReportRowResponse[]; total: UsageReportRowResponse }): JSX.Element {
  if (props.rows.length === 0) {
    return <p className="py-4 text-center text-sm text-ink-muted">集計対象の run はありません</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="usage-cost-table">
        <thead>
          <tr className={THEAD_ROW_CLASS}>
            <th className={TH_CLASS}>{props.axis}</th>
            <th className={`${TH_CLASS} text-right`}>Run 数</th>
            <th className={`${TH_CLASS} text-right`}>推定コスト</th>
            <th className={`${TH_CLASS} text-right`}>実測コスト</th>
            <th className={TH_CLASS}>除外 run</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={row.key} className={TR_CLASS}>
              <td className={TD_CLASS}>
                <span className="font-mono text-xs">{row.label}</span>
              </td>
              <td className={`${TD_CLASS} text-right font-mono`}>{row.runCount}</td>
              <td className={`${TD_CLASS} text-right font-mono text-warn-strong`}>{formatUsageUsd(row.costUsd.estimated)}</td>
              <td className={`${TD_CLASS} text-right font-mono`}>{formatUsageUsd(row.costUsd.measured)}</td>
              <td className={`${TD_CLASS} text-xs text-ink-muted`}>{formatExcluded(row.costUsd)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-line bg-surface-muted">
            <td className={`${TD_CLASS} font-semibold`}>合計</td>
            <td className={`${TD_CLASS} text-right font-mono font-semibold`}>{props.total.runCount}</td>
            <td className={`${TD_CLASS} text-right font-mono font-semibold text-warn-strong`}>
              {formatUsageUsd(props.total.costUsd.estimated)}
            </td>
            <td className={`${TD_CLASS} text-right font-mono font-semibold`}>{formatUsageUsd(props.total.costUsd.measured)}</td>
            <td className={`${TD_CLASS} text-xs text-ink-muted`}>{formatExcluded(props.total.costUsd)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function TokenTable(props: { axis: UsageGroupByAxis; rows: UsageReportRowResponse[]; total: UsageReportRowResponse }): JSX.Element {
  if (props.rows.length === 0) {
    return <p className="py-4 text-center text-sm text-ink-muted">集計対象の run はありません</p>;
  }
  const cells = (row: UsageReportRowResponse): string[] => [
    formatUsageTokens(row.inputTokens.measured),
    formatUsageTokens(row.outputTokens.measured),
    formatUsageTokens(row.cacheCreationTokens.measured),
    formatUsageTokens(row.cacheReadTokens.measured),
    formatUsageTokens(row.turns.measured),
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="usage-token-table">
        <thead>
          <tr className={THEAD_ROW_CLASS}>
            <th className={TH_CLASS}>{props.axis}</th>
            <th className={`${TH_CLASS} text-right`}>input</th>
            <th className={`${TH_CLASS} text-right`}>output</th>
            <th className={`${TH_CLASS} text-right`}>cache write</th>
            <th className={`${TH_CLASS} text-right`}>cache read</th>
            <th className={`${TH_CLASS} text-right`}>turns</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={row.key} className={TR_CLASS}>
              <td className={TD_CLASS}>
                <span className="font-mono text-xs">{row.label}</span>
              </td>
              {cells(row).map((value, i) => (
                <td key={i} className={`${TD_CLASS} text-right font-mono`}>
                  {value}
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t-2 border-line bg-surface-muted">
            <td className={`${TD_CLASS} font-semibold`}>合計</td>
            {cells(props.total).map((value, i) => (
              <td key={i} className={`${TD_CLASS} text-right font-mono font-semibold`}>
                {value}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Coverage(props: { data: UsageResponse }): JSX.Element {
  const c = props.data.coverage;
  return (
    <div className="space-y-2 text-sm text-ink">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <CoverageStat label="期間内 run" value={c.totalRuns} />
        <CoverageStat label="集計対象" value={c.aggregatedRuns} />
        <CoverageStat label="未終端（対象外）" value={c.runningRuns} />
        <CoverageStat label="重複除外" value={c.duplicateRuns} />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <CoverageStat label="usage 記録あり" value={c.withUsageRuns} />
        <CoverageStat label="旧 lastResult のみ" value={c.legacyOnlyRuns} />
        <CoverageStat label="記録なし" value={c.noUsageRuns} />
      </div>
      <p className="text-xs text-ink-muted">
        旧 lastResult は legacy-unverified として件数だけ数え、値は集計へ入れていません（codex の偽ゼロ・claude の
        cache 欠落が確認されているため）。
      </p>
    </div>
  );
}

function CoverageStat(props: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-md bg-surface-muted px-2.5 py-1.5">
      <div className="text-[11px] text-ink-muted">{props.label}</div>
      <div className="font-mono text-sm tabular-nums text-ink">{props.value}</div>
    </div>
  );
}

function Notes(props: { data: UsageResponse }): JSX.Element {
  const { data } = props;
  return (
    <div className="space-y-1.5 text-xs text-ink-muted">
      <p>
        推定コストは価格表からの合成値です（provider のログに USD は記録されません）。実測コストとは合算していません。
      </p>
      <p>集計は保存済みの usage をそのまま合算します。価格表を引き直した再計算は行いません。</p>
      {data.total.models.length > 0 && (
        <p data-testid="usage-models">
          各 run のコストには subagent / advisor が使った<strong>他モデル分</strong>も含みます（launch
          時の model と一致するとは限りません）。実際にトークンを消費したモデル:{" "}
          {data.total.models.join(", ")}
        </p>
      )}
      {data.priceTableRefs.length > 0 && <p>価格表: {data.priceTableRefs.join(", ")}</p>}
      {data.priceTableMixed && (
        <p className="text-warn-strong">
          警告: 複数版の価格表が混在しています。推定コストは単一版で再計算した値ではありません。
        </p>
      )}
      {data.total.unpricedModels.length > 0 && (
        <p className="text-warn-strong" data-testid="usage-unpriced-models">
          価格表に無いモデルを含む run は cost 全体が unavailable-by-design になります（部分合計を出さない設計）:{" "}
          {data.total.unpricedModels.join(", ")}
        </p>
      )}
    </div>
  );
}

export function UsageView(): JSX.Element {
  const { data, loading, error, days, setDays, groupBy, setGroupBy } = useUsage(30, "task");

  if (loading && data === null) {
    return <div className="flex items-center justify-center py-16 text-sm text-ink-muted">usage を読み込み中…</div>;
  }
  if (error !== null && data === null) {
    return <div className="flex items-center justify-center py-16 text-sm text-danger-strong">{error}</div>;
  }
  if (data === null) {
    return <div />;
  }

  const estimatedTotal = data.total.costUsd.estimated;
  const measuredTotal = data.total.costUsd.measured;
  const excludedTotal = data.total.costUsd.excluded.total;

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-2 py-4 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-sm font-semibold text-ink">usage（コスト比較）</h1>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup options={AXIS_OPTIONS} current={groupBy} onChange={setGroupBy} testId="usage-axis-selector" />
          <ToggleGroup
            options={PERIOD_OPTIONS.map((o) => ({ label: o.label, value: o.days }))}
            current={days}
            onChange={setDays}
            testId="usage-period-selector"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard
          title="推定コスト合計"
          value={formatUsageUsd(estimatedTotal)}
          sub={`${estimatedTotal.runCount} run（価格表由来）`}
          tone="warn"
        />
        <KpiCard
          title="実測コスト合計"
          value={formatUsageUsd(measuredTotal)}
          sub={measuredTotal.runCount === 0 ? "実測 cost を持つ run なし" : `${measuredTotal.runCount} run`}
          tone={measuredTotal.runCount === 0 ? "neutral" : "ok"}
        />
        <KpiCard title="集計対象 run" value={String(data.coverage.aggregatedRuns)} sub={`期間内 ${data.coverage.totalRuns} run`} />
        <KpiCard
          title="cost 除外 run"
          value={String(excludedTotal)}
          sub={excludedTotal === 0 ? "欠測なし" : "内訳は下表の「除外 run」"}
          tone={excludedTotal === 0 ? "neutral" : "warn"}
        />
      </div>

      <Card title={`${groupBy} 別コスト（推定と実測は別列・合算しない）`}>
        <CostTable axis={groupBy} rows={data.rows} total={data.total} />
      </Card>

      <Card title={`${groupBy} 別トークン内訳（すべて実測）`}>
        <TokenTable axis={groupBy} rows={data.rows} total={data.total} />
      </Card>

      <Card title="カバレッジ">
        <Coverage data={data} />
      </Card>

      <Card title="この数字の読み方">
        <Notes data={data} />
      </Card>
    </div>
  );
}
