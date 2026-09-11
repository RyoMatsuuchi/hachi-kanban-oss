// ネイティブセッションログの観測結果を RunUsage（task_runs.meta.usage）へ変換する
// （設計 docs/plans/direct-run-usage-cost-audit.md §3.2 / R1〜R5）。
//
// 変換をここに集約する理由は、「値が無いときに 0 を書かない」という規約をひとつの関数で
// 守り切るため。今回の根因（codex bridge の偽ゼロ 816 行、claude の cache read 欠落）は
// いずれも collector ごとに判断が散らばったことで起きている。
import { costMetricFromEstimate, estimateCostUsd, type ModelTokenUsage } from "./usage-pricing.js";
import type { EffortLevel, MetricProvenance, MetricValue, Provider, RunUsage } from "./types.js";

/** provider / model / effort が同じ実行ターンをまとめた内訳。 */
export interface ExecutionTokenUsage extends ModelTokenUsage {
  provider: Provider;
  /** ログで観測できなかった場合は null。既定 effort で補完しない。 */
  effort: EffortLevel | null;
  turns: number;
}

/** 親セッションの main-chain 1ターン分の観測値。 */
export interface MainSessionTurn {
  provider: Provider;
  /** contextTokens と同じ応答からモデルを観測できた場合だけ持つ。 */
  model?: string;
  /** ログで観測できなかった場合は null。 */
  effort: EffortLevel | null;
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** cacheCreationTokens の内数。provider が報告しなければ省略する。 */
  cacheCreation1hTokens?: number;
  /** outputTokens の内数。provider が報告しなければ省略する。 */
  reasoningOutputTokens?: number;
  timestampMs: number | null;
}

/** 三つ組集計の安定キー。 */
export function executionKey(
  usage: Pick<ExecutionTokenUsage, "provider" | "model" | "effort">,
): string {
  return `${usage.provider}/${usage.model}/${usage.effort ?? "unset"}`;
}

/** provider ログの値を共通 effort 語彙へ閉じて解釈する。完全一致以外は未観測扱い。 */
export function parseEffortLevel(value: unknown): EffortLevel | null {
  switch (value) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      return null;
  }
}

/** usage を観測できなかった理由。どの state へ落とすかはここで一意に決まる。 */
export type UsageUnavailableReason =
  /** ログファイルに到達できなかった（session id 不明・ファイル不在・読み取り不能） */
  | "log-not-found"
  /** session id を特定できなかった */
  | "session-id-unknown"
  /** ログはあるが壊れていた / 大きすぎて読み切らなかった */
  | "log-unreadable"
  /** 設計上ログが書かれない起動だった（codex --ephemeral 等） */
  | "log-not-persisted"
  /** ログはあるが usage を持つレコードが 1 件も無かった */
  | "no-usage-records";

/**
 * 親セッション（サブエージェントを除く）だけの消費。オーケストレーターの自己計測で使う。
 * codex には子セッションの概念が無いため rollout 全体と一致する。
 */
export interface MainSessionUsage {
  /** 親セッションのターン数（= 自分の会話ターン） */
  turns: number;
  /** 親セッションの累計入力トークン（input + cacheRead + cacheCreation の合計） */
  inputTokens: number;
  /**
   * 直近ターンの入力側トークン合計（= その時点の文脈サイズ）。
   * 「これから1ターンいくらかかるか」というレートであり、累計とは別の軸。
   *
   * **このセッション自身の文脈だけ**を数える。claude の advisor は別の文脈を持ち、
   * 課金（inputTokens）には効くがこの値には載せない。
   * さらに claude では1ターンが複数の応答に分かれることがあり、後段は前段のプロンプトを丸ごと再送する。
   * そのため**最後の応答1件ぶん**を採り、ターン内で合計しない（合計するとほぼ2倍になり、
   * 実測では ok を urgent と誤報する。詳細は adapters の `ClaudeResponseUsage` を参照）。
  */
  contextTokens: number;
  /**
   * contextTokens を採ったのと同じ最後の応答1件のモデル名。
   * 累計 perModel や設定値からは推測せず、ログの同じ応答から観測できた場合だけ持つ。
   */
  contextModel?: string;
  /** contextModel と同じ最後の応答から観測した effort。未観測なら省略する。 */
  contextEffort?: EffortLevel;
  /** 親セッションの最初と最後の記録の間隔。特定できなければ null */
  elapsedMs: number | null;
  /**
   * 親セッション（サブエージェントを除く）だけのモデル別内訳。effectiveCostUsd 軸（usage-pricing.ts の
   * estimateCostUsd）の入力になる。cache 系統ごとに単価が違うため、4系統を維持したまま持つ
   * （合計せずに perModel のまま渡す）。
   */
  perModel: ModelTokenUsage[];
  /** provider / model / effort の三つ組別内訳。 */
  perExecution: ExecutionTokenUsage[];
  /** main-chain の turn 系列。 */
  turnSeries: MainSessionTurn[];
  /**
   * 直近ターンのモデルの context window サイズ（トークン）。ログが報告する provider（現状は codex の
   * token_count.info.model_context_window）でだけ分かる。claude の transcript にはこの情報が無いため
   * 常に undefined。contextSaturation 軸（orchestrator-session-budget.ts の computeContextSaturation）の
   * 分母に使う。新しい定数テーブルでモデル名から逆引きしてはいけない — 必ずログの実測値だけを使う。
   */
  contextWindowTokens?: number;
}

/**
 * ネイティブログ 1 セッション分の観測結果。adapter がここまでを作り、core が RunUsage へ変換する。
 * observed=false のとき合計値は一切使わない（0 を measured にしない唯一の砦）。
 */
export type NativeUsageObservation =
  | {
      observed: true;
      /** モデル別の内訳。1 run が複数モデルにまたがる（サブエージェント・advisor）ため配列 */
      perModel: ModelTokenUsage[];
      /**
       * 応答グループ数（claude は (requestId, message.id) 単位、codex は token_count の増分単位）。
       * advisor を挟んだターンは1グループに message と advisor_message が同居するので、
       * API 呼び出し回数とは一致しない。
       */
      turns: number;
      /** ログ上の最初と最後の記録の間隔。特定できなければ null */
      durationMs: number | null;
      /**
       * 親セッション（サブエージェントを除く）だけを見た内訳。
       * 上の perModel/turns は「その run が使った総額」なのでサブエージェント分を含むが、
       * オーケストレーターが**自分のセッションを切るかどうか**を判断する軸（playbook §0.7）は
       * 自分の会話ターンで測らないと意味が変わる。実測でサブエージェント込みのターン数は
       * 親のみの 1.11〜6.89 倍にばらつき、§0.7.2 の「30〜80ターン」と対応しなくなる。
       * 3つの値は同じ基準（親ファイルのみ）で揃えてある。特定できなければキーごと省略する。
       */
      mainSession?: MainSessionUsage;
    }
  | { observed: false; reason: UsageUnavailableReason };

/** 観測不能理由から token 系 metric の state を決める。 */
function unavailableMetric(reason: UsageUnavailableReason): MetricValue {
  switch (reason) {
    // 経路自体へ到達できていない。実測 0 と区別するため unknown。
    case "log-not-found":
    case "session-id-unknown":
    case "log-unreadable":
      return { state: "unknown" };
    // 経路があることは分かっているが、この run では値が出なかった。
    case "log-not-persisted":
    case "no-usage-records":
      return { state: "not-provided" };
  }
}

export interface BuildRunUsageOptions {
  /** 書き手の識別子。例 "direct-claude@native-log-v1" */
  collectedBy: string;
  /** measured metric に付ける出所 */
  provenance: MetricProvenance;
}

function sum(perModel: readonly ModelTokenUsage[], pick: (u: ModelTokenUsage) => number): number {
  return perModel.reduce((acc, u) => acc + pick(u), 0);
}

/**
 * 観測結果を RunUsage へ変換する。
 *
 * - token 4系統は観測できたときだけ measured。観測できなければ全項目が同じ state で揃う
 * - cost は provider のログに USD が無いため常に estimated（価格表引き）。measured にはしない
 * - 価格表に無いモデルが 1 つでもあれば cost は unavailable-by-design（部分合計を出さない）
 */
export function buildRunUsage(
  observation: NativeUsageObservation,
  options: BuildRunUsageOptions,
): RunUsage {
  if (!observation.observed) {
    const metric = unavailableMetric(observation.reason);
    return {
      costUsd: metric,
      inputTokens: metric,
      outputTokens: metric,
      cacheCreationTokens: metric,
      cacheReadTokens: metric,
      turns: metric,
      durationMs: metric,
      collectedBy: options.collectedBy,
    };
  }

  const { perModel, turns, durationMs } = observation;
  const measured = (value: number): MetricValue => ({
    state: "measured",
    value,
    provenance: options.provenance,
  });
  const estimate = estimateCostUsd(perModel);
  const models = [...new Set(perModel.map((u) => u.model))].sort();

  return {
    costUsd: costMetricFromEstimate(estimate),
    inputTokens: measured(sum(perModel, (u) => u.inputTokens)),
    outputTokens: measured(sum(perModel, (u) => u.outputTokens)),
    cacheCreationTokens: measured(sum(perModel, (u) => u.cacheCreationTokens)),
    cacheReadTokens: measured(sum(perModel, (u) => u.cacheReadTokens)),
    turns: measured(turns),
    durationMs: durationMs === null ? { state: "unknown" } : measured(durationMs),
    collectedBy: options.collectedBy,
    ...(models.length > 0 ? { models } : {}),
    ...(estimate.priced ? {} : { unpricedModels: estimate.unpricedModels }),
  };
}

/**
 * 既定集計が拾ってよい実測値だけを取り出す。
 * `estimated` / `legacy-unverified` は**意図的に**ここを通らない（合算禁止。§R4/§R5）。
 */
export function measuredValue(metric: MetricValue): number | null {
  return metric.state === "measured" ? metric.value : null;
}

/** 推定値だけを取り出す（measured とは別列で並べて表示するための入口）。 */
export function estimatedValue(metric: MetricValue): number | null {
  return metric.state === "estimated" ? metric.value : null;
}
