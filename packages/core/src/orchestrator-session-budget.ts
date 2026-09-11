// =============================================================================
// オーケストレーター自身のセッション消費を段階判定する（runbooks/orchestrator-playbook.md §0.7）。
//
// 2026-08-22 改訂: 3軸（turns / cumulativeInputTokens / contextTokens）を実測ベースの4軸へ差し替えた。
// 旧設計の2つの誤りを直す:
//   1. cumulativeInputTokens は名目トークン数を数えていた。cache read は input の 1/10 の単価なのに
//      同じ重みで足すと実効コストを最大 8 倍過大評価する（knowledge k_4c160e163a7c）。
//      → 実際の USD（effectiveCostUsd）に置き換える。単価計算は usage-pricing.ts に既にある。
//   2. contextTokens は「コストのレート」と「品質（飽和・溢れ）」という別々の意味を1軸に詰め込んでいた。
//      → 品質は contextSaturation（context window に対する比率）、コストは handoffValue
//        （このセッションを続けるのが損になるまでのターン数 N）へ分離する。
//
// 4軸:
//   - turns: 往復回数の参考値。段階は算出するが、総合段階には寄与しない
//   - contextSaturation: 文脈が context window に対してどれだけ埋まっているか（比率 0〜1）。
//     window サイズが分からないモデル/provider では undefined（新しい定数テーブルは作らない）。
//   - handoffValue: 損益分岐ターン数 N。あと何ターンで「このセッションを続ける方が新規セッションより
//     高くつく」かを表す。**小さいほど悪い**（他の3軸と逆向き）。
//   - effectiveCostUsd: このセッションが実際に消費した USD（cache 単価を織り込んだ実額）。
//
// C0（起動直後の文脈フロア）は実測が無い場合だけ config/既定値を使う。
// S（起動の実効コスト）は契約 §77.5 に従って単価と boot overhead から導出し、
// このファイルには既定値を置かない。
//
// この module は純粋関数だけを持つ。ログの読み取りも DB も CLI もここには入れない。
// =============================================================================

/** 判定に使う4つの軸。 */
import type {
  OrchestratorSessionBudgetConfig,
  SessionBudgetAxisUnmeasuredKind,
  SessionBudgetAxisUnmeasuredReason,
  SessionBudgetCostModelOverride,
  SessionBudgetThresholdOverride,
} from "./types.js";

// 閾値・cost model の上書き型は凍結契約（types.ts）が唯一の宣言。ここでは再輸出だけを行う。
export type {
  SessionBudgetAxisUnmeasuredKind,
  SessionBudgetAxisUnmeasuredReason,
  SessionBudgetCostModelOverride,
  SessionBudgetThresholdOverride,
};

export const SESSION_BUDGET_AXES = ["turns", "contextSaturation", "handoffValue", "effectiveCostUsd"] as const;
export type SessionBudgetAxis = (typeof SESSION_BUDGET_AXES)[number];

/**
 * F3: SESSION_BUDGET_AXES（の型 SessionBudgetAxis）と、凍結契約 OrchestratorSessionBudgetConfig
 * （types.ts）から costModel / contextWindowTokens を除いたキー集合が完全一致することを
 * コンパイル時に強制する仕組み。3つの型を合成して使う:
 *
 *   1. ConfigAxisKeys        : types.ts 側の「軸として扱われるべきキー」の集合
 *   2. IsExactStringUnion<A, B> : 2つの文字列 union が集合として完全一致するときだけ true を返す
 *      （タプルで包んで [A] extends [B] にすることで union のメンバーごとに分配されるのを防ぎ、
 *      「和集合として」比較する。単なる `A extends B` だと分配され、意図しない部分一致で
 *      true を返してしまう）
 *   3. AssertTrue<T extends true> : T が false になった時点で「型引数 false は制約 true を
 *      満たさない」というコンパイルエラーを起こす
 *
 * SessionBudgetAxesMatchConfigKeys の定義そのものがこの3つを直列に適用する式になっているため、
 * 軸を追加して types.ts の更新を忘れる（＝集合が不一致になる）と、この export 文の型引数の
 * 評価自体が失敗し、orchestrator-session-budget.ts の typecheck が落ちる（レビュー指摘 #5）。
 * 実行時には一切関与しない（値を生成・検証するコードは書かない）。unused-vars 系 lint に
 * 引っかからないよう export して module の public interface にしている
 * （IsExactStringUnion / AssertTrue は orchestrator-session-budget.test.ts の negative type test
 * が「アサーション機構自体の健全性」を固定するためにも import して使う）。
 */
type ConfigAxisKeys = Exclude<
  keyof OrchestratorSessionBudgetConfig,
  "costModel" | "contextWindowTokens" | "monitor" | "autoHandover"
>;
export type IsExactStringUnion<A extends string, B extends string> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type AssertTrue<T extends true> = T;
export type SessionBudgetAxesMatchConfigKeys = AssertTrue<IsExactStringUnion<SessionBudgetAxis, ConfigAxisKeys>>;

/** 総合段階へ集約する軸。 */
export const SESSION_BUDGET_AGGREGATED_AXES = ["contextSaturation", "handoffValue", "effectiveCostUsd"] as const;
export type SessionBudgetAggregatedAxis = (typeof SESSION_BUDGET_AGGREGATED_AXES)[number];
const SESSION_BUDGET_AGGREGATED_AXIS_SET: ReadonlySet<SessionBudgetAxis> = new Set(
  SESSION_BUDGET_AGGREGATED_AXES,
);

/** 総合段階には使わず、値と軸段階だけを表示することを明示的に許可した軸。 */
export const SESSION_BUDGET_INFORMATIONAL_AXES = ["turns"] as const;
export type SessionBudgetInformationalAxis = (typeof SESSION_BUDGET_INFORMATIONAL_AXES)[number];
const SESSION_BUDGET_INFORMATIONAL_AXIS_SET: ReadonlySet<SessionBudgetAxis> = new Set(
  SESSION_BUDGET_INFORMATIONAL_AXES,
);

/** 弱い順に並べた段階。配列の順序が段階の強さの正本。 */
export const SESSION_BUDGET_STAGES = ["ok", "notice", "recommend", "urgent"] as const;
export type SessionBudgetStage = (typeof SESSION_BUDGET_STAGES)[number];

/**
 * 軸の値がどちら向きに悪化するか。
 * - higherIsWorse: 値が大きいほど悪い（turns / contextSaturation / effectiveCostUsd）
 * - lowerIsWorse: 値が小さいほど悪い（handoffValue＝損益分岐ターン数 N。あと何ターンかが少ないほど悪い）
 */
export type SessionBudgetAxisDirection = "higherIsWorse" | "lowerIsWorse";

export const SESSION_BUDGET_AXIS_DIRECTIONS: Record<SessionBudgetAxis, SessionBudgetAxisDirection> = {
  turns: "higherIsWorse",
  contextSaturation: "higherIsWorse",
  handoffValue: "lowerIsWorse",
  effectiveCostUsd: "higherIsWorse",
};

/**
 * 軸ごとの閾値。higherIsWorse の軸は値が閾値**以上**、lowerIsWorse の軸は値が閾値**以下**でその段階に入る。
 * どちらの向きでも「urgent が最も厳しい値」になるよう、higherIsWorse は notice<=recommend<=urgent、
 * lowerIsWorse は notice>=recommend>=urgent の順で並べる（resolveSessionBudgetThresholds が強制する）。
 */
export interface SessionBudgetAxisThresholds {
  notice: number;
  recommend: number;
  urgent: number;
}

export type SessionBudgetThresholds = Record<SessionBudgetAxis, SessionBudgetAxisThresholds>;

/**
 * 既定の閾値（playbook §0.7 2026-08-22 改訂の実測に対応する）。
 *
 * - turns: 表示専用の参考値。旧設計の値をそのまま引き継いでいる。
 *   §0.7 2026-08-22 改訂は旧版の「目安30〜80ターン」を「文脈サイズを見ておらず使えない」として
 *   撤回しており、この既定値は実測から再導出できていない（follow-up）。
 * - contextSaturation: context window に対する比率。0.60/0.75/0.85。
 *   window サイズが観測（例: codex の model_context_window）でも
 *   orchestrator.sessionBudget.contextWindowTokens の config 上書きでも得られない場合のみ
 *   undefined になり判定から除外される（claude は観測手段が無いため config 指定が必要）。
 * - handoffValue: 損益分岐ターン数 N。N は小さいほど悪いので
 *   notice=30 > recommend=20 > urgent=10 の順で並ぶ。C0/S は assessment 時に導出する。
 * - effectiveCostUsd: cache 単価を織り込んだ実額。$15 / $30 / $60。
 */
export const DEFAULT_SESSION_BUDGET_THRESHOLDS: SessionBudgetThresholds = {
  turns: { notice: 60, recommend: 100, urgent: 200 },
  contextSaturation: { notice: 0.6, recommend: 0.75, urgent: 0.85 },
  handoffValue: { notice: 30, recommend: 20, urgent: 10 },
  effectiveCostUsd: { notice: 15, recommend: 30, urgent: 60 },
};

/**
 * 段階ごとの終了コード。フック側で「urgent だけ拾う」等の使い分けを可能にするため段階ごとに分ける。
 * 判定不能はここに含めない（呼び出し側が fail-open で 0 を返す）。
 */
export const SESSION_BUDGET_EXIT_CODES: Record<SessionBudgetStage, number> = {
  ok: 0,
  notice: 10,
  recommend: 11,
  urgent: 12,
};

/** 観測できた軸だけ数値を持つ。観測できない軸は undefined にする（0 で埋めない）。 */
export type SessionBudgetMetrics = { [K in SessionBudgetAxis]: number | undefined };

export interface SessionBudgetAxisResult {
  axis: SessionBudgetAxis;
  /** true の軸は値と段階を表示するが、総合段階と firedAxes には寄与しない */
  informational: boolean;
  /** 観測できなかった軸は undefined。判定から除外されたことを表す */
  value: number | undefined;
  /** 観測できなかった軸は null */
  stage: SessionBudgetStage | null;
  thresholds: SessionBudgetAxisThresholds;
  /** value が undefined の理由。理由が定義されている軸（contextSaturation / handoffValue /
   * effectiveCostUsd）は、value===undefined のとき必ず付く。理由が定義されていない軸（turns）は
   * undefined になっても付かない（turns は usage.turns から直接入るため実測上 undefined にならない）。 */
  unmeasured?: { reason: SessionBudgetAxisUnmeasuredReason };
}

/**
 * SessionBudgetAxisUnmeasuredReason の分類の正本（types.ts の SessionBudgetAxisUnmeasuredReason 宣言のコメントが参照している）。
 * missing = 測る手段が無い欠測、not-applicable = 測った結果その軸に意味が無い良性の結果。
 * 2つを同じ扱いに潰さないこと（not-applicable を警告すると立ち上げ直後に常に赤くなり誰も見なくなる）。
 */
export const SESSION_BUDGET_AXIS_UNMEASURED_REASON_KIND: Record<SessionBudgetAxisUnmeasuredReason, SessionBudgetAxisUnmeasuredKind> = {
  "context-window-unknown": "missing",
  "cost-model-floor-not-exceeded": "not-applicable",
  "cost-model-unpriced": "missing",
  "codex-credit-ledger-unpriced": "missing",
};

/**
 * 軸ごとの「undefined になったときの理由」。turns だけここに載らない
 * （usage.turns から直接入るため実測上 undefined にならず、対応する reason も存在しない）。
 * 新しい軸を追加するときはここへ reason を足すか、turns と同様に「構造的に undefined にならない」
 * ことを確認すること（確認は orchestrator-session-budget.test.ts の網羅テストが強制する）。
 */
const SESSION_BUDGET_AXIS_UNMEASURED_REASON: Partial<Record<SessionBudgetAxis, SessionBudgetAxisUnmeasuredReason>> = {
  contextSaturation: "context-window-unknown",
  handoffValue: "cost-model-floor-not-exceeded",
  effectiveCostUsd: "cost-model-unpriced",
};

export interface SessionBudgetEvaluation {
  /** 集約対象3軸の**最大**段階。全軸が未計測なら null */
  stage: SessionBudgetStage | null;
  /** 全軸の内訳（観測できなかった軸も value=undefined で残す） */
  axes: SessionBudgetAxisResult[];
  /** stage を決めた軸。同点なら全部入る（「なぜ今なのか」が1つに絞れるとは限らない） */
  firedAxes: SessionBudgetAxis[];
}

function stageRank(stage: SessionBudgetStage): number {
  return SESSION_BUDGET_STAGES.indexOf(stage);
}

/**
 * 1軸の段階を決める。
 * higherIsWorse: 値が閾値**以上**でその段階に入る。lowerIsWorse: 値が閾値**以下**でその段階に入る。
 * どちらも urgent → recommend → notice の順に厳しい方から判定する（閾値の並びが逆向きでも成立する）。
 *
 * direction は呼び出し側から渡させず、axis から SESSION_BUDGET_AXIS_DIRECTIONS を引いて内部で解決する。
 * 呼び出し側が direction を指定・省略できる余地を型レベルで無くし、default 値による向きの取り違え
 * （例: handoffValue を higherIsWorse で評価してしまい urgent が ok に化ける）を構造的に防ぐ。
 */
export function evaluateSessionBudgetAxis(
  axis: SessionBudgetAxis,
  value: number,
  thresholds: SessionBudgetAxisThresholds,
): SessionBudgetStage {
  const direction = SESSION_BUDGET_AXIS_DIRECTIONS[axis];
  const worse = direction === "higherIsWorse" ? (v: number, t: number) => v >= t : (v: number, t: number) => v <= t;
  if (worse(value, thresholds.urgent)) {
    return "urgent";
  }
  if (worse(value, thresholds.recommend)) {
    return "recommend";
  }
  if (worse(value, thresholds.notice)) {
    return "notice";
  }
  return "ok";
}

/**
 * SESSION_BUDGET_AGGREGATED_AXES の最大段階を採る。観測できなかった軸は 0 として扱わず**判定から外す**
 * （0 と未取得を混同すると、測れていないセッションが「まだ余裕がある」と読めてしまう）。
 * 集約対象を1軸も観測できなければ、表示専用軸が観測できていても stage=null とする。
 * 全軸の内訳は残し、呼び出し側が値と欠測理由を表示できるようにする。
 */
export function evaluateSessionBudget(
  metrics: SessionBudgetMetrics,
  thresholds: SessionBudgetThresholds = DEFAULT_SESSION_BUDGET_THRESHOLDS,
  unmeasuredReasons?: Partial<Record<SessionBudgetAxis, SessionBudgetAxisUnmeasuredReason>>,
): SessionBudgetEvaluation {
  const axes: SessionBudgetAxisResult[] = SESSION_BUDGET_AXES.map((axis) => {
    const value = metrics[axis];
    const unmeasuredReason = unmeasuredReasons?.[axis] ?? SESSION_BUDGET_AXIS_UNMEASURED_REASON[axis];
    return {
      axis,
      informational: SESSION_BUDGET_INFORMATIONAL_AXIS_SET.has(axis),
      value,
      stage: value === undefined ? null : evaluateSessionBudgetAxis(axis, value, thresholds[axis]),
      thresholds: thresholds[axis],
      ...(value === undefined && unmeasuredReason !== undefined ? { unmeasured: { reason: unmeasuredReason } } : {}),
    };
  });
  const aggregated = axes
    .filter((entry): entry is SessionBudgetAxisResult & { stage: SessionBudgetStage } => entry.stage !== null)
    .filter((entry) => SESSION_BUDGET_AGGREGATED_AXIS_SET.has(entry.axis));
  if (aggregated.length === 0) {
    return { stage: null, axes, firedAxes: [] };
  }
  const stage = aggregated.reduce<SessionBudgetStage>(
    (worst, entry) => (stageRank(entry.stage) > stageRank(worst) ? entry.stage : worst),
    "ok",
  );
  // ok のときに「全軸が発火した」と読めてしまわないよう、ok では firedAxes を空にする。
  const firedAxes = stage === "ok" ? [] : aggregated.filter((entry) => entry.stage === stage).map((entry) => entry.axis);
  return { stage, axes, firedAxes };
}

/** 損益分岐計算に使う2定数。 */
export interface SessionBudgetCostModel {
  /** 起動直後の文脈フロア（トークン）。世代が進むごとに増加するため config で上書きする。 */
  c0: number;
  /** 起動の実効コスト（USD）。既知の固定ロスを含む as-observed 値。 */
  s: number;
}

/**
 * config で軸ごと・cost model を上書きするための部分指定（additive。未指定は既定のまま）。
 *
 * 軸名を SESSION_BUDGET_AXES から導出するため、凍結契約の OrchestratorSessionBudgetConfig
 * （types.ts）と同じ形を意図している。両者は独立した宣言だが、SessionBudgetAxesMatchConfigKeys
 * （本ファイル）が軸のキー集合の完全一致をコンパイル時に強制しているため、軸を足して types.ts
 * の更新を忘れると、その場でこのファイルの typecheck が失敗する（黙って無視される、ということは
 * もう起きない）。ただし config-schema.ts（実行時の zod バリデーション）はこの型検査の対象外
 * で別途手で追随させる必要があるため、軸を増やすときは types.ts / config-schema.ts / ここの
 * 3箇所を必ず揃えること。
 */
export type SessionBudgetOverride = {
  [K in SessionBudgetAxis]?: SessionBudgetThresholdOverride;
} & {
  costModel?: SessionBudgetCostModelOverride;
  /** contextSaturation の分母（config 優先度2位）。types.ts の OrchestratorSessionBudgetConfig と型を同期させるためのフィールド。 */
  contextWindowTokens?: number;
};

/**
 * 既定へ config の上書きを重ねる。指定のない軸・段階は既定値を保つ（additive）。
 * 段階の逆転は判定を無意味にするので fail-closed で throw する。
 * 向きは軸ごとに異なる（SESSION_BUDGET_AXIS_DIRECTIONS）ため、higherIsWorse は notice<=recommend<=urgent、
 * lowerIsWorse は notice>=recommend>=urgent を要求する。
 */
export function resolveSessionBudgetThresholds(override?: SessionBudgetOverride): SessionBudgetThresholds {
  const resolved = {} as SessionBudgetThresholds;
  for (const axis of SESSION_BUDGET_AXES) {
    const merged = { ...DEFAULT_SESSION_BUDGET_THRESHOLDS[axis], ...(override?.[axis] ?? {}) };
    const direction = SESSION_BUDGET_AXIS_DIRECTIONS[axis];
    const ordered =
      direction === "higherIsWorse"
        ? merged.notice <= merged.recommend && merged.recommend <= merged.urgent
        : merged.notice >= merged.recommend && merged.recommend >= merged.urgent;
    if (!ordered) {
      const relation = direction === "higherIsWorse" ? "notice <= recommend <= urgent" : "notice >= recommend >= urgent";
      throw new Error(
        `orchestrator.sessionBudget.${axis} は ${relation} が必須です: ` +
          `notice=${merged.notice} recommend=${merged.recommend} urgent=${merged.urgent}`,
      );
    }
    resolved[axis] = merged;
  }
  return resolved;
}

/** C0 の実測標本が無い場合に使う既定値。S の既定値は持たない。 */
export const DEFAULT_SESSION_BUDGET_C0 = 101_231;

/** cache read の単価（$/token）＝ $0.50/MTok。損益分岐の計算はこの単価を前提にする（playbook §0.7.0）。 */
export const HANDOFF_CACHE_READ_USD_PER_TOKEN = 0.5e-6;

/**
 * 損益分岐ターン数 N を計算する。
 *
 * このセッションを続けると、以後1ターンごとに文脈 C を cache read 単価で読み直す（≒ C × 単価 ドル）。
 * 新規セッションへ引き継ぐと起動コスト S を払うがフロア C0 から再開する。N ターン後に両者が釣り合う点は
 *   N × (C - C0) × 単価 = S  ⇔  N = S / ((C - C0) × 単価)
 * C <= C0（いまの文脈がフロア以下）なら続ける方が常に得＝損益分岐点が存在しないので undefined を返す
 * （0 で埋めない。observed=false とは別の「定義域外」を表す）。
 *
 * cache read 単価（cacheReadUsdPerToken）は既定で HANDOFF_CACHE_READ_USD_PER_TOKEN（$0.50/MTok）
 * を使うが、これはモデル別の実勢単価が引けないときのフォールバックにすぎない。opus / gpt-5.6 は
 * 実際にこの値と一致するが、claude-sonnet-5（2e-7）や claude-fable-5（1e-6）等は大きく異なるため、
 * 呼び出し側は usage-pricing.ts の resolveHandoffCacheReadPrice() で直近応答モデルを優先して
 * 解決し、ここへ渡すこと（cache read 単価の解決は usage-pricing.ts の責務であり、
 * このファイルは純粋関数だけを持つという冒頭のコメントの設計意図に沿う）。
 */
export function computeHandoffBreakEvenTurns(
  contextTokens: number,
  costModel: SessionBudgetCostModel,
  cacheReadUsdPerToken: number = HANDOFF_CACHE_READ_USD_PER_TOKEN,
): number | undefined {
  const overCostPerTurn = (contextTokens - costModel.c0) * cacheReadUsdPerToken;
  if (!(overCostPerTurn > 0)) {
    return undefined;
  }
  return costModel.s / overCostPerTurn;
}

/**
 * 文脈飽和度＝ contextTokens / contextWindowTokens。provider/model に依存しない比率で表す。
 * window サイズが分からなければ undefined を返す（新しい定数テーブルは作らない）。呼び出し側は
 * 実測できればログの値を、できなければ orchestrator.sessionBudget.contextWindowTokens の
 * config 上書きを渡す（観測値を優先。詳細は orchestrator-usage.ts の measure() を参照）。
 * 両方とも無い場合のみ undefined になる。
 */
export function computeContextSaturation(
  contextTokens: number,
  contextWindowTokens: number | undefined,
): number | undefined {
  if (contextWindowTokens === undefined || !(contextWindowTokens > 0)) {
    return undefined;
  }
  return contextTokens / contextWindowTokens;
}
