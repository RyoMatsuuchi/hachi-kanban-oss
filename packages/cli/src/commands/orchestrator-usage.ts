// =============================================================================
// hachi orchestrator usage: オーケストレーター自身のセッション消費を読み、段階を返す
// （runbooks/orchestrator-playbook.md §0.7、契約 §14.5.1 の native-usage parser を流用）。
//
// 設計の要点:
//  - **読み取り専用**。ネイティブログにも DB にも一切書かない
//  - 新しい parser を書かない。direct run の usage 収集と同じ collector をそのまま使う
//  - provider session id が未登録なら `unknown` を返し、推測値を出さない
//  - `--check` は判定不能で必ず exit 0（fail-open）。計測できないことを理由に
//    オーケストレーターを止めない。超過検知は**提案であって自動実行ではない**
// =============================================================================

import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { collectClaudeNativeUsage, collectCodexNativeUsage, resolveClaudeProjectsRoot, resolveCodexSessionsRoot } from "@hachi/adapters";
import {
  assessOrchestratorSession,
  readCodexLedger,
  SESSION_BUDGET_AXIS_DIRECTIONS,
  SESSION_BUDGET_AXIS_UNMEASURED_REASON_KIND,
  SESSION_BUDGET_EXIT_CODES,
  type MainSessionUsage,
  type NativeUsageObservation,
  type OrchestratorSessionAssessment,
  type OrchestratorSessionRow,
  type SessionBudgetAxis,
  type SessionBudgetAxisUnmeasuredReason,
  type SessionBudgetEvaluation,
  type HandoffCacheReadPriceResolution,
} from "@hachi/core";
import type { CliDeps } from "../deps.js";
import { withErrorHandling } from "../errors.js";

interface UsageOptions {
  session: string;
  json?: boolean;
  check?: boolean;
}

/**
 * 判定できなかった理由。observation 側の理由（契約 §14.5.1 の UsageUnavailableReason）に加え、
 * board 側で先に分かる理由をここで持つ。どちらも「推測しない」ことを表す。
 */
type UnknownReason =
  /** session row が board に無い */
  | "session-not-found"
  /** provider / provider_session_id が session row に未登録 */
  | "provider-session-id-unregistered"
  /** ログは読めたが親セッションの行が1つも無く、自分の消費を切り出せなかった */
  | "main-session-unavailable"
  /** 親セッションは読めたが、総合判定へ集約する3軸が全て未計測 */
  | "all-aggregated-axes-unmeasured"
  /** config の orchestrator.sessionBudget 上書きが不正（閾値の向き逆転、または costModel の c0/s<=0） */
  | "session-budget-config-invalid"
  | NativeUsageObservationReason;

type NativeUsageObservationReason = Extract<NativeUsageObservation, { observed: false }>["reason"];

/** 3桁区切り。ロケール依存を避けるため自前で入れる。 */
function formatCount(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 経過時間を人が読める短い形にする。特定できなければ "-"。 */
function formatElapsed(ms: number | null): string {
  if (ms === null) {
    return "-";
  }
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) {
    return `${Math.floor(ms / 1000)}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h${minutes}m`;
}

/** ミッション task ID は identity に持たせず board で表す（契約 §55.6）。active な subtree watch の selector を引く。 */
function missionTaskIds(deps: CliDeps, orchestratorId: string): string[] {
  return deps.store
    .listOrchestratorWatches(orchestratorId)
    .filter((watch) => watch.active && watch.scope === "subtree")
    .map((watch) => watch.selector);
}

/** ネイティブログを読む。ログにも DB にも書かない。 */
async function observe(deps: CliDeps, session: OrchestratorSessionRow): Promise<NativeUsageObservation> {
  const sessionId = session.providerSessionId;
  if (session.provider === "claude") {
    return collectClaudeNativeUsage({
      projectsRoot: deps.nativeUsageRoots?.claudeProjectsRoot ?? resolveClaudeProjectsRoot(),
      sessionId,
    });
  }
  return collectCodexNativeUsage({
    sessionsRoot: deps.nativeUsageRoots?.codexSessionsRoot ?? resolveCodexSessionsRoot(),
    sessionId,
  });
}

interface Measured extends OrchestratorSessionAssessment {
  kind: "measured";
  session: OrchestratorSessionRow;
  usage: MainSessionUsage;
  /** サブエージェント込みの API 往復回数。軸には使わないが、隠さず出す */
  totalTurns: number;
  /** サブエージェント込みの入力側合計。段階判定は親のみで行うため、総額はここで見せる */
  totalInputTokens: number;
  /** 集約3軸が全て未計測のときだけ、値を保持したまま判定不能の理由を表す */
  reason: "all-aggregated-axes-unmeasured" | undefined;
  missionTaskIds: string[];
}

interface Unknown {
  kind: "unknown";
  session: OrchestratorSessionRow | null;
  reason: UnknownReason;
}

type Result = Measured | Unknown;

/**
 * session を1つ読み、段階まで決める。
 *
 * 4軸すべてを**親セッション（サブエージェントを除く）**の値で揃える。
 * サブエージェント込みのターン数は実測で親のみの 1.11〜6.89 倍にばらつき、
 * turns 軸の閾値が想定している「親セッションの区切りの回数」と対応しなくなるため。
 * サブエージェント分は totalTurns として別に出し、落としてはいない。
 */
async function measure(deps: CliDeps, sessionId: string): Promise<Result> {
  const session = deps.store.getOrchestratorSession(sessionId);
  if (session === null) {
    return { kind: "unknown", session: null, reason: "session-not-found" };
  }
  if (session.provider === "" || session.providerSessionId === "") {
    return { kind: "unknown", session, reason: "provider-session-id-unregistered" };
  }
  const observation = await observe(deps, session);
  if (!observation.observed) {
    return { kind: "unknown", session, reason: observation.reason };
  }
  if (observation.mainSession === undefined) {
    return { kind: "unknown", session, reason: "main-session-unavailable" };
  }
  const usage = observation.mainSession;
  const ledger = session.provider === "codex"
    ? readCodexLedger(deps.nativeUsageRoots?.codexAuthPath ?? join(homedir(), ".codex", "auth.json"))
    : "unknown";
  let assessment: OrchestratorSessionAssessment;
  try {
    assessment = assessOrchestratorSession(
      session,
      usage,
      deps.store,
      deps.config,
      ledger,
      Math.floor(Date.now() / 1000),
    );
  } catch {
    // config 自体が壊れていても --check は fail-open の約束を守る（origin: code review 2026-08-22）。
    return { kind: "unknown", session, reason: "session-budget-config-invalid" };
  }
  return {
    kind: "measured",
    session,
    usage,
    totalTurns: observation.turns,
    totalInputTokens: observation.perModel.reduce(
      (sum, model) => sum + model.inputTokens + model.cacheReadTokens + model.cacheCreationTokens,
      0,
    ),
    ...assessment,
    reason: assessment.evaluation.stage === null ? "all-aggregated-axes-unmeasured" : undefined,
    missionTaskIds: missionTaskIds(deps, session.orchestratorId),
  };
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

/** 軸ごとに表示ラベルを変える。handoffValue は「損益分岐ターン数 N」の略記に統一する。 */
const AXIS_LABEL: Record<SessionBudgetAxis, string> = {
  turns: "turns",
  contextSaturation: "contextSaturation",
  handoffValue: "N",
  effectiveCostUsd: "effectiveCostUsd",
};

/** 軸の値の意味（回数・比率・USD）に応じて表示形式を変える。 */
function formatAxisValue(axis: SessionBudgetAxis, value: number): string {
  switch (axis) {
    case "contextSaturation":
      return `${Math.round(value * 100)}%`;
    case "effectiveCostUsd":
      return `$${value.toFixed(2)}`;
    case "turns":
      return formatCount(Math.round(value));
    case "handoffValue":
      // 整数へ丸めると N=30.4 が「N=30」となり notice 閾値（<=30）ちょうどに達したように読める。
      // 小数第1位まで残し、ちょうどの値（閾値側）では .0 を出さない。
      return value.toFixed(1).replace(/\.0$/, "");
  }
}

/** higherIsWorse は閾値以上、lowerIsWorse（handoffValue）は閾値以下でその段階に入る。表示もそれに合わせる。 */
function comparatorSymbol(axis: SessionBudgetAxis): string {
  return SESSION_BUDGET_AXIS_DIRECTIONS[axis] === "higherIsWorse" ? ">=" : "<=";
}

function jsonPayload(result: Result): unknown {
  if (result.kind === "unknown") {
    return {
      session: result.session,
      stage: null,
      reason: result.reason,
      // 推測値を出さないことを機械可読な形でも明示する。
      measurement: null,
      exitCode: 0,
    };
  }
  const { usage, evaluation, costModel } = result;
  const axisValue = (axis: SessionBudgetAxis): number | undefined =>
    evaluation.axes.find((entry) => entry.axis === axis)?.value;
  return {
    session: result.session,
    stage: evaluation.stage,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    firedAxes: evaluation.firedAxes,
    axes: evaluation.axes,
    measurement: {
      // 4軸はすべて親セッション（サブエージェントを除く）基準。
      turns: usage.turns,
      contextTokens: usage.contextTokens,
      contextModel: usage.contextModel,
      contextWindowTokens: result.contextWindowTokens,
      contextSaturation: axisValue("contextSaturation"),
      handoffValueTurns: axisValue("handoffValue"),
      handoffValueCacheReadCostPerToken: result.handoffCacheReadPrice?.cacheReadCostPerToken,
      handoffValueCacheReadPriceSource: result.handoffCacheReadPrice?.source,
      costModel,
      cumulativeInputTokens: usage.inputTokens,
      effectiveCostUsd: result.effectiveCostUsd,
      effectiveCostCredits: result.effectiveCostCredits,
      priceSource: result.priceSource ?? null,
      priceTableRef: result.priceTableRef,
      ledger: result.ledger,
      ...(result.unpricedModels.length === 0 ? {} : { unpricedModels: result.unpricedModels }),
      averageInputTokensPerTurn: usage.turns === 0 ? null : Math.round(usage.inputTokens / usage.turns),
      elapsedMs: usage.elapsedMs,
      /** サブエージェント込みの API 往復回数（軸には使わない） */
      totalTurns: result.totalTurns,
      /** サブエージェント込みの入力側合計（軸には使わない。総額を隠さないため） */
      totalInputTokens: result.totalInputTokens,
    },
    remaining: result.remaining,
    recommendation: result.recommendation,
    effortAdvisory: result.effortAdvisory,
    missionTaskIds: result.missionTaskIds,
    exitCode: evaluation.stage === null ? 0 : SESSION_BUDGET_EXIT_CODES[evaluation.stage],
  };
}

const UNKNOWN_REASON_TEXT: Record<UnknownReason, string> = {
  "session-not-found": "指定の orchestrator session が board にありません",
  "provider-session-id-unregistered": "session に provider / provider session id が未登録です",
  "main-session-unavailable": "ログはありますが親セッションの記録を切り出せませんでした",
  "all-aggregated-axes-unmeasured": "親セッションは読めましたが、総合判定に使う3軸を1つも測定できませんでした",
  "session-budget-config-invalid":
    "config の orchestrator.sessionBudget 上書きが不正です（閾値の向き、または costModel の値が正数条件を満たしていません）",
  "session-id-unknown": "provider session id を特定できませんでした",
  "log-not-found": "ネイティブログが見つかりませんでした",
  "log-unreadable": "ネイティブログを読み切れませんでした",
  "log-not-persisted": "この起動ではネイティブログが書かれません",
  "no-usage-records": "ネイティブログに usage を持つ記録がありませんでした",
};

/**
 * 判定不能のうち、オーケストレーターが自分で直せるものだけ対処方法を出す。
 * 直せないものは undefined にして汎用文言へ落とす（誤った手順を書かない）。
 */
const UNKNOWN_REASON_HINT: Partial<Record<UnknownReason, string>> = {
  "provider-session-id-unregistered":
    "hachi orchestrator session start <orchestrator-id> --provider <p> --provider-session-id <id> で登録すると測れます。",
  "session-budget-config-invalid":
    "config.json の orchestrator.sessionBudget を見直してください（各軸の向きと costModel の正数条件を確認してください）。",
  "all-aggregated-axes-unmeasured":
    "config.json の orchestrator.sessionBudget.contextWindowTokens を設定するか、node scripts/update-model-prices.mjs で価格表を更新してください。",
};

/** 軸の未計測理由の日本語説明。stderr に出すのは missing 分類のみ（呼び出し側で SESSION_BUDGET_AXIS_UNMEASURED_REASON_KIND を見てフィルタする）。 */
const AXIS_UNMEASURED_REASON_TEXT: Record<SessionBudgetAxisUnmeasuredReason, string> = {
  "context-window-unknown": "context window のサイズが観測でも設定でも得られません",
  "cost-model-floor-not-exceeded": "現在の文脈が cost model のフロア C0 を超えていません",
  "cost-model-unpriced": "使用モデルが価格表に無く、コストを算出できません",
  "codex-credit-ledger-unpriced": "Codex の台帳が ChatGPT サインイン（credits）で、USD 換算率が設定されていません",
};

/**
 * missing の軸だけに付ける是正手順（UNKNOWN_REASON_HINT と同じ方針で、自分で直せるものだけ出す）。
 * 直し方の書いていない警告は毎回同じ文面で出続けるだけになり、playbook §0.7.2 の
 * 「常に赤なので誰も見なくなる」を新しい通知経路で再現してしまう。
 */
const AXIS_UNMEASURED_REASON_HINT: Partial<Record<SessionBudgetAxisUnmeasuredReason, string>> = {
  "context-window-unknown":
    "config.json の orchestrator.sessionBudget.contextWindowTokens に窓サイズ（正の整数）を設定すると測れます。",
  "cost-model-unpriced":
    "node scripts/update-model-prices.mjs で価格表を再生成すると測れます（LiteLLM に無いモデルは載りません）。",
  "codex-credit-ledger-unpriced":
    "config.json の orchestrator.pricing.codexCreditUsdRate（1 credit あたり USD）を設定すると USD で測れます。推測値を置かないでください。",
};

function textLines(result: Result): string[] {
  if (result.kind === "unknown") {
    const provider = result.session === null || result.session.provider === "" ? "(未登録)" : result.session.provider;
    return [
      `session=${result.session?.id ?? "(不明)"} provider=${provider}`,
      `stage=unknown reason=${result.reason}（${UNKNOWN_REASON_TEXT[result.reason]}）`,
      "推測値は出しません。段階判定は行えていません。",
    ];
  }
  const { session, usage, evaluation, costModel } = result;
  const average = usage.turns === 0 ? "-" : formatCount(Math.round(usage.inputTokens / usage.turns));
  const costLine = result.effectiveCostUsd !== undefined
    ? `実効コスト=$${result.effectiveCostUsd.toFixed(2)}`
      + (result.effectiveCostCredits === undefined ? "" : ` credits=${result.effectiveCostCredits}`)
      + ` priceSource=${result.priceSource} ledger=${result.ledger}`
    : result.ledger === "chatgpt"
      ? `実効コスト=不明（Codex credits の USD 換算不可${result.unpricedModels.length === 0 ? "" : `: ${result.unpricedModels.join(",")}`}）`
        + (result.effectiveCostCredits === undefined ? "" : ` credits=${result.effectiveCostCredits}`)
        + ` priceSource=${result.priceSource} ledger=${result.ledger}`
      : `実効コスト=不明（価格表に無いモデル: ${result.unpricedModels.join(",")}）`;
  const windowSuffix = result.contextWindowTokens === undefined ? "" : `/${formatCount(result.contextWindowTokens)}`;
  const unknownReason = result.reason ?? "all-aggregated-axes-unmeasured";
  const lines = [
    `session=${session.id} orchestrator=${session.orchestratorId} provider=${session.provider} providerSession=${session.providerSessionId}`,
    evaluation.stage === null
      ? `stage=unknown reason=${unknownReason}（${UNKNOWN_REASON_TEXT[unknownReason]}）`
      : `stage=${evaluation.stage}${evaluation.firedAxes.length === 0 ? "" : ` fired=${evaluation.firedAxes.map((axis) => AXIS_LABEL[axis]).join(",")}`}`,
    `turns=${formatCount(usage.turns)} 累計入力=${formatCount(usage.inputTokens)} 文脈=${formatCount(usage.contextTokens)}${windowSuffix} 1ターン平均入力=${average} 経過=${formatElapsed(usage.elapsedMs)}`,
    costLine,
    `costModel: c0=${formatCount(costModel.c0)} source=${costModel.c0Source}`
      + ` s=${costModel.s === null ? "-" : `$${costModel.s.toFixed(2)}`} source=${costModel.sSource}`,
    `（サブエージェント込み: API 往復=${formatCount(result.totalTurns)} 入力=${formatCount(result.totalInputTokens)}。軸には使いません）`,
  ];
  for (const axis of evaluation.axes) {
    const value = axis.value === undefined ? "-" : formatAxisValue(axis.axis, axis.value);
    const reasonSuffix = axis.unmeasured === undefined ? "" : ` [${AXIS_UNMEASURED_REASON_TEXT[axis.unmeasured.reason]}]`;
    const informationalSuffix = axis.informational ? " [informational: 総合判定には不使用]" : "";
    const handoffPriceSuffix = axis.axis === "handoffValue" && result.handoffCacheReadPrice !== null
      ? ` [cacheRead=$${(result.handoffCacheReadPrice.cacheReadCostPerToken * 1_000_000).toFixed(2)}/MTok source=${result.handoffCacheReadPrice.source}]`
      : "";
    lines.push(
      `  ${AXIS_LABEL[axis.axis]}=${value} -> ${axis.stage ?? "unknown"}${informationalSuffix}${reasonSuffix}${handoffPriceSuffix}` +
        ` (notice=${formatAxisValue(axis.axis, axis.thresholds.notice)}` +
        ` recommend=${formatAxisValue(axis.axis, axis.thresholds.recommend)}` +
        ` urgent=${formatAxisValue(axis.axis, axis.thresholds.urgent)})`,
    );
  }
  lines.push(
    result.missionTaskIds.length === 0
      ? "mission=(subtree watch 未宣言)"
      : `mission=${result.missionTaskIds.join(",")}`,
  );
  return lines;
}

/** 発火した軸を「値 (比較 閾値)」の形で並べる。なぜ今なのかが分からないと行動に移せない。 */
function firedSummary(
  evaluation: SessionBudgetEvaluation,
  handoffCacheReadPrice: HandoffCacheReadPriceResolution | null,
): string {
  const stage = evaluation.stage;
  if (stage === null || stage === "ok") {
    return "";
  }
  // 観測できなかった軸は発火しえないが、値が無いまま 0 と表示しないよう flatMap で落とす。
  return evaluation.axes
    .flatMap((axis) =>
      evaluation.firedAxes.includes(axis.axis) && axis.value !== undefined
        ? [
            `${AXIS_LABEL[axis.axis]}=${formatAxisValue(axis.axis, axis.value)}` +
              ` (${comparatorSymbol(axis.axis)}${formatAxisValue(axis.axis, axis.thresholds[stage])})` +
              (axis.axis === "handoffValue" && handoffCacheReadPrice !== null
                ? ` [cacheRead=$${(handoffCacheReadPrice.cacheReadCostPerToken * 1_000_000).toFixed(2)}/MTok source=${handoffCacheReadPrice.source}]`
                : ""),
          ]
        : [],
    )
    .join(" / ");
}

/**
 * 損益分岐ターン数 N は、発火軸でなくても通知文に常に出す（「あと何ターンで損になるか」は
 * どの軸が引き金でも意思決定に要る数値のため）。fired 側に既に N が入っていれば二重に出さない。
 */
function handoffValueAlways(
  evaluation: SessionBudgetEvaluation,
  handoffCacheReadPrice: HandoffCacheReadPriceResolution | null,
): string {
  if (evaluation.firedAxes.includes("handoffValue")) {
    return "";
  }
  const axis = evaluation.axes.find((entry) => entry.axis === "handoffValue");
  if (axis === undefined || axis.value === undefined || handoffCacheReadPrice === null) {
    if (handoffCacheReadPrice === null) {
      return "N=-";
    }
    return `N=- [cacheRead=$${(handoffCacheReadPrice.cacheReadCostPerToken * 1_000_000).toFixed(2)}/MTok source=${handoffCacheReadPrice.source}]`;
  }
  return `N=${formatAxisValue("handoffValue", axis.value)}`
    + ` [cacheRead=$${(handoffCacheReadPrice.cacheReadCostPerToken * 1_000_000).toFixed(2)}/MTok source=${handoffCacheReadPrice.source}]`;
}

function assessmentPrefix(result: Measured): string {
  const model = result.recommendation.model ?? "unknown";
  const effort = result.recommendation.effort ?? "unset";
  return `[${result.session.provider}/${model}/${effort}] `;
}

function recommendationSummary(result: Measured): string {
  const n = result.recommendation.n === null ? "-" : formatAxisValue("handoffValue", result.recommendation.n);
  const { breakdown } = result.remaining;
  return `recommendation=${result.recommendation.action} R=${formatCount(result.recommendation.r)}`
    + ` (todo ${breakdown.todo} / ready ${breakdown.ready} / in-progress ${breakdown.inProgress}`
    + ` / review ${breakdown.review} / inbox ${breakdown.inbox}) N=${n}`;
}

function effortAdvisorySummary(result: Measured): string {
  const advisory = result.effortAdvisory;
  if (advisory === null) {
    return "";
  }
  return `effort=${advisory.currentEffort}->${advisory.suggestedEffort}`
    + ` 約$${advisory.savingsUsdPerTurn.toFixed(4)}/turn減（情報のみ）`;
}

function idleRecommendationLine(result: Measured): string | null {
  const idle = result.recommendation.idle;
  if (idle.action !== "handoff-before-idle" || idle.rewriteUsd === null || idle.savingsUsd === null) {
    return null;
  }
  return `idle: TTL 超の待ちに入るなら $${idle.rewriteUsd.toFixed(2)} の書き直し。`
    + `引き継げば $${idle.savingsUsd.toFixed(2)} 節約 → handoff-before-idle`;
}

function recommendationInstruction(result: Measured): string {
  const { recommendation } = result;
  switch (recommendation.action) {
    case "continue":
      return (recommendation.n === null
        ? recommendation.reasons.includes("N-unmeasured")
          ? "N が未計測のため引き継ぎは推奨せず、このセッションを継続してください。"
          : "現在の文脈が C0 以下で N は未定義のため、このセッションを継続してください。"
        : `R=${formatCount(recommendation.r)} < N=${formatAxisValue("handoffValue", recommendation.n)}`
          + " のため、このセッションを継続してください。")
        + (result.evaluation.firedAxes.includes("contextSaturation")
          ? " 文脈は上限付近で、序盤の指示が失われている可能性があります。"
          : "");
    case "handoff-at-boundary":
      return "R が N 以上のため、次の区切りで引き継ぎをユーザーへ提案してください（自動実行ではありません）。";
    case "handoff-now":
      return result.evaluation.firedAxes.includes("contextSaturation")
        ? "R が 2N 以上かつ urgent です。直ちに引き継ぎを提案してください。文脈が上限付近で、序盤の指示が失われている可能性があります。"
        : "R が 2N 以上かつ urgent です。直ちに引き継ぎを提案してください。";
  }
}

/**
 * フックへ渡す行を組み立てる。`ok` は無出力（フックを静かに保つ）、他は3行以内。
 * ミッション task ID は契約 §55.6 の「セッション交代時はミッション task ID 1行を引き継げばよい」に対応する。
 */
function checkLines(result: Result): string[] {
  if (result.kind === "unknown") {
    return [];
  }
  const { evaluation } = result;
  const mission = result.missionTaskIds.length === 0 ? null : `ミッション: ${result.missionTaskIds.join(",")}`;
  const headline = [
    firedSummary(evaluation, result.handoffCacheReadPrice),
    handoffValueAlways(evaluation, result.handoffCacheReadPrice),
    recommendationSummary(result),
    effortAdvisorySummary(result),
  ].filter((part) => part !== "").join(" / ");
  const firstLine = `${assessmentPrefix(result)}[hachi] セッション消費`;
  const instruction = recommendationInstruction(result);
  const idleLine = idleRecommendationLine(result);
  switch (evaluation.stage) {
    case null:
      return idleLine === null ? [] : [idleLine];
    case "ok":
      return idleLine === null ? [] : [idleLine];
    case "notice":
      return [
        `${firstLine} notice: ${headline}。${instruction}`,
        ...(idleLine === null ? [] : [idleLine]),
      ];
    case "recommend":
      return [
        `${firstLine} recommend: ${headline}`,
        instruction,
        ...(mission === null ? [] : [mission]),
        ...(idleLine === null ? [] : [idleLine]),
      ];
    case "urgent":
      return [
        `${firstLine} urgent: ${headline}`,
        instruction,
        ...(mission === null ? [] : [mission]),
        ...(idleLine === null ? [] : [idleLine]),
      ];
  }
}

async function runUsage(deps: CliDeps, options: UsageOptions): Promise<void> {
  const result = await measure(deps, options.session);

  if (options.check === true) {
    if (result.kind === "unknown") {
      // exit 0 のまま抜ける（fail-open。計測できないことでオーケストレーターを止めない）。
      // ただし**黙って**抜けてはならない。無出力 + exit 0 は「消費 ok」と区別できず、
      // 壊れた計測が健全に見える。実際 provider session id の登録漏れに気付かないまま
      // セッションを使い続けた事例がある（2026-08-21）。理由は必ず出す。
      // 「ok ではない」は常に言う。ヒントは自分で直せる場合だけ追加する。
      const hint = UNKNOWN_REASON_HINT[result.reason];
      deps.stderr.write(
        `[hachi] セッション消費を判定できません: ${result.reason}（${UNKNOWN_REASON_TEXT[result.reason]}）\n`
        + "段階判定は行えていません。ok ではありません。\n"
        + (hint === undefined ? "" : `${hint}\n`),
      );
      return;
    }
    const lines = checkLines(result);
    if (lines.length > 0) {
      deps.stdout.write(`${lines.join("\n")}\n`);
    }
    if (result.reason !== undefined) {
      const hint = UNKNOWN_REASON_HINT[result.reason];
      deps.stderr.write(
        `[hachi] セッション消費を判定できません: ${result.reason}（${UNKNOWN_REASON_TEXT[result.reason]}）\n`
        + "段階判定は行えていません。ok ではありません。\n"
        + (hint === undefined ? "" : `${hint}\n`),
      );
    }
    // 個々の軸が未計測の理由を、総合判定の stage に関わらず stderr へ1行ずつ出す。
    // missing（測る手段が無い欠測）だけを出す。not-applicable（例: C<=C0 の handoffValue）は
    // 良性の結果であり警告してはならない（playbook §0.7.2「常に赤なので誰も見なくなる」を避ける）。
    // stdout 契約（ok=無出力/notice=1行/recommend・urgent=3行以内）には一切触れない。exit code も変えない。
    // **必ず stdout の後に書くこと**: フック（hachi-orchestrator-usage-check.sh）は stdout+stderr を
    // `2>&1` でマージし、先頭1行から数字を除いた文字列を抑制キーにして15分間同じ通知を抑制する。
    // stderr のこの行が先に来ると、stage が変わって stdout の内容が変化しても先頭行（stderr側）が
    // 変わらないままになり、本来「段階が変われば必ず再通知される」はずの動作が抑制されてしまう
    // （playbook §0.7.3.2 の約束を壊す）。stage=ok で stdout が無出力のときはこの stderr 行が結果的に
    // 先頭行になる＝ok の間は抑制が効き続けるのは正しい挙動。
    for (const axis of result.evaluation.axes) {
      if (axis.unmeasured === undefined) {
        continue;
      }
      if (SESSION_BUDGET_AXIS_UNMEASURED_REASON_KIND[axis.unmeasured.reason] !== "missing") {
        continue;
      }
      const axisHint = AXIS_UNMEASURED_REASON_HINT[axis.unmeasured.reason];
      deps.stderr.write(
        `[hachi] 軸 ${axis.axis} を判定できません: ${axis.unmeasured.reason}` +
          `（${AXIS_UNMEASURED_REASON_TEXT[axis.unmeasured.reason]}）。総合判定にこの軸は入っていません。` +
          `${axisHint === undefined ? "" : ` ${axisHint}`}\n`,
      );
    }
    deps.exit(result.evaluation.stage === null ? 0 : SESSION_BUDGET_EXIT_CODES[result.evaluation.stage]);
    return;
  }

  if (options.json === true) {
    deps.stdout.write(`${JSON.stringify(jsonPayload(result), null, 2)}\n`);
    return;
  }
  deps.stdout.write(`${textLines(result).join("\n")}\n`);
}

export function registerOrchestratorUsageCommand(orchestrator: Command, deps: CliDeps): void {
  orchestrator.command("usage")
    .description("自セッションの消費を読み段階判定する（読み取り専用。playbook §0.7）")
    .requiredOption("--session <id>", "orchestrator session ID")
    .option("--check", "フック用。段階を exit code で返し ok は無出力（判定不能は exit 0）。--json より優先する")
    .option("--json")
    .action(withErrorHandling(deps, (options: UsageOptions) => runUsage(deps, options)));
}
