// =============================================================================
// 実行履歴テーブル（task_runs: provider/session/状態/開始終了/model・modelDelivery・
// requested speed・speedDelivery・transport・usage / lastResult コスト。
// docs/contract.md §14.3・§14.5.1・§17.3・§67）。
//
// usage（RunUsage）が費用判断の正本で、lastResult は互換のため残る旧形式（codex は全項目0の
// 偽ゼロ、claude は cache 分欠落）。両者を同じ列に混ぜず、旧形式にはその旨を明記する。
// =============================================================================

import type { JSX } from "react";
import type { MetricValue, RunRow, RunUsage } from "@hachi/core";
import { Card } from "./Card.js";
import { Badge, type BadgeTone } from "./Badge.js";
import { ScrollArea } from "./ui/ScrollArea.js";
import { formatStat, formatTimestamp, providerLabel } from "../lib/format.js";
import { formatMetricValue } from "../lib/usage-format.js";
import { TD_CLASS, THEAD_ROW_CLASS, TH_CLASS, TR_CLASS } from "../lib/table-styles.js";

interface LastResult {
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

interface RunMeta {
  model?: string;
  modelDelivery?: string;
  /** runtime に要求した速度。実効速度の観測値ではない。 */
  speed?: string;
  /** 速度要求の配送結果。実効速度の観測値ではない。 */
  speedDelivery?: string;
  role?: string;
  /** direct transport の場合に記録される（docs/contract.md §17.3）。省略時は既定の bridge */
  transport?: string;
  lastResult?: LastResult;
  /** 費用判断の正本（契約 §14.5.1）。旧 run には存在しない */
  usage?: RunUsage;
  verify?: VerifyMeta;
}

interface VerifyMeta {
  status?: string;
  skipped?: string;
  exitCode?: number | null;
  timedOut?: boolean;
}

type SessionRole = "worker" | "reviewer";

function parseMeta(raw: string): RunMeta {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as RunMeta) : {};
  } catch {
    return {};
  }
}

function statusTone(status: RunRow["status"]): BadgeTone {
  switch (status) {
    case "done":
      return "success";
    case "running":
      return "info";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

function roleFromMeta(meta: RunMeta): SessionRole {
  return meta.role === "reviewer" ? "reviewer" : "worker";
}

function roleLabel(role: SessionRole): string {
  return role === "reviewer" ? "レビュー" : "実装";
}

function roleTone(role: SessionRole): BadgeTone {
  return role === "reviewer" ? "reviewer" : "info";
}

function verifyBadge(meta: VerifyMeta | undefined): { label: string; tone: BadgeTone; title: string } | null {
  if (meta === undefined) {
    return null;
  }
  if (typeof meta.skipped === "string") {
    return { label: `verify: skipped`, tone: "neutral", title: `verify skipped: ${meta.skipped}` };
  }
  if (meta.status === "passed") {
    return { label: `verify: 成功 exit ${formatStat(meta.exitCode)}`, tone: "success", title: "verify 成功" };
  }
  if (meta.status === "failed") {
    const result = meta.timedOut === true ? "timeout" : `exit ${formatStat(meta.exitCode)}`;
    return { label: `verify: 失敗 ${result}`, tone: "danger", title: "verify 失敗" };
  }
  return null;
}

function openSessionWindow(sessionId: string): void {
  window.open(`/session/${encodeURIComponent(sessionId)}`, "_blank", "width=720,height=900");
}

/** MetricValue 1件を「値 + state」で表示する。値だけを裸で出すと 0 と未取得が混ざる。 */
function MetricChip(props: { label: string; metric: MetricValue; kind?: "usd" | "count" }): JSX.Element {
  const formatted = formatMetricValue(props.metric, props.kind ?? "count");
  const toneClass =
    formatted.tone === "measured"
      ? "bg-ok-soft text-ok-strong"
      : formatted.tone === "estimated"
        ? "bg-warn-soft text-warn-strong"
        : "bg-surface-muted text-ink-muted";
  return (
    <span className={`whitespace-nowrap rounded-md px-1.5 py-0.5 ${toneClass}`}>
      {props.label}: {formatted.text}
      {formatted.note === null ? null : <span className="ml-1 text-[10px]">({formatted.note})</span>}
    </span>
  );
}

function UsageCell(props: { usage: RunUsage | undefined }): JSX.Element {
  const { usage } = props;
  if (usage === undefined) {
    return <span className="text-xs text-ink-muted">usage 未記録</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5 text-xs tabular-nums text-ink">
      <MetricChip label="cost" metric={usage.costUsd} kind="usd" />
      <MetricChip label="in" metric={usage.inputTokens} />
      <MetricChip label="out" metric={usage.outputTokens} />
      <MetricChip label="cache w" metric={usage.cacheCreationTokens} />
      <MetricChip label="cache r" metric={usage.cacheReadTokens} />
      {usage.unpricedModels !== undefined && usage.unpricedModels.length > 0 ? (
        <span className="whitespace-nowrap rounded-md bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn-strong">
          価格表外: {usage.unpricedModels.join(", ")}
        </span>
      ) : null}
    </div>
  );
}

export function RunsCard(props: { runs: RunRow[] }): JSX.Element {
  const { runs } = props;
  return (
    <Card title={`実行履歴（${runs.length}）`}>
      {runs.length === 0 ? (
        <p className="text-sm italic text-ink-muted">実行履歴はありません</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-line">
          <ScrollArea scrollbars="horizontal" viewportClassName="max-w-full">
            <div className="min-w-full pb-2">
              <table className="w-full min-w-[1150px] table-fixed border-collapse text-sm">
                <thead>
                  <tr className={THEAD_ROW_CLASS}>
                    <th className={`${TH_CLASS} w-[155px] whitespace-nowrap`}>provider / session</th>
                    <th className={`${TH_CLASS} w-[140px] whitespace-nowrap`}>status</th>
                    <th className={`${TH_CLASS} w-[270px] whitespace-nowrap`}>usage（正本）</th>
                    <th className={`${TH_CLASS} w-[160px] whitespace-nowrap`}>開始 / 終了</th>
                    <th className={`${TH_CLASS} w-[240px] whitespace-nowrap`}>model / requested speed / delivery</th>
                    <th className={`${TH_CLASS} w-[205px] whitespace-nowrap`}>lastResult（旧形式・参考）</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => {
                    const meta = parseMeta(run.meta);
                    const role = roleFromMeta(meta);
                    const lastResult = meta.lastResult;
                    const verify = verifyBadge(meta.verify);
                    const sessionViewAvailable = run.sessionId !== "";
                    return (
                      <tr key={run.id} className={TR_CLASS}>
                        <td className={TD_CLASS}>
                          <div className="flex min-w-0 max-w-full flex-col items-start gap-1">
                            <Badge tone={run.provider === "codex" ? "codex" : "claude"}>
                              {providerLabel(run.provider)}
                            </Badge>
                            <Badge tone={roleTone(role)}>{roleLabel(role)}</Badge>
                            <span
                              className="block max-w-full truncate text-xs text-ink-muted"
                              title={run.sessionId}
                            >
                              {run.sessionId}
                            </span>
                            {sessionViewAvailable ? (
                              <button
                                type="button"
                                onClick={() => openSessionWindow(run.sessionId)}
                                className="whitespace-nowrap rounded-md border border-line px-2 py-1 text-xs font-medium text-ink-muted transition hover:bg-surface-muted"
                              >
                                セッション記録を見る
                              </button>
                            ) : null}
                          </div>
                        </td>
                        <td className={`${TD_CLASS} whitespace-nowrap`}>
                          <div className="flex flex-col items-start gap-1">
                            <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                            {verify !== null ? (
                              <Badge tone={verify.tone} className="px-1.5 text-[11px]" title={verify.title}>
                                {verify.label}
                              </Badge>
                            ) : null}
                          </div>
                        </td>
                        <td className={TD_CLASS}>
                          <UsageCell usage={meta.usage} />
                        </td>
                        <td className={`${TD_CLASS} whitespace-nowrap text-xs text-ink-muted`}>
                          <div className="flex flex-col gap-0.5 tabular-nums">
                            <span>開始 {formatTimestamp(run.startedAt)}</span>
                            <span>終了 {formatTimestamp(run.endedAt)}</span>
                          </div>
                        </td>
                        <td className={`${TD_CLASS} text-xs text-ink`}>
                          <div className="flex min-w-0 max-w-full flex-col gap-0.5">
                            <span className="truncate" title={meta.model ?? "-"}>
                              model: {meta.model ?? "-"}
                            </span>
                            <span className="truncate" title={meta.modelDelivery ?? "-"}>
                              model delivery: {meta.modelDelivery ?? "-"}
                            </span>
                            <span className="truncate" title={meta.speed ?? "-"}>
                              requested speed: {meta.speed ?? "-"}
                            </span>
                            <span
                              className="truncate"
                              title={`speed delivery (not effective speed): ${meta.speedDelivery ?? "-"}`}
                            >
                              speed delivery: {meta.speedDelivery ?? "-"}
                            </span>
                            <span className="truncate" title={meta.transport ?? "bridge"}>
                              transport: {meta.transport ?? "bridge"}
                            </span>
                          </div>
                        </td>
                        <td className={TD_CLASS}>
                          <div className="flex flex-wrap gap-1.5 text-xs tabular-nums text-ink-muted">
                            <span className="whitespace-nowrap rounded-md bg-surface-muted px-1.5 py-0.5">
                              cost: {formatStat(lastResult?.costUsd)}
                            </span>
                            <span className="whitespace-nowrap rounded-md bg-surface-muted px-1.5 py-0.5">
                              in: {formatStat(lastResult?.inputTokens)}
                            </span>
                            <span className="whitespace-nowrap rounded-md bg-surface-muted px-1.5 py-0.5">
                              out: {formatStat(lastResult?.outputTokens)}
                            </span>
                            <span className="whitespace-nowrap rounded-md bg-surface-muted px-1.5 py-0.5">
                              ms: {formatStat(lastResult?.durationMs)}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </ScrollArea>
        </div>
      )}
    </Card>
  );
}
