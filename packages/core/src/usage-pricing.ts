// 価格表を使った cost 推定（設計 docs/plans/direct-run-usage-cost-audit.md R1 / R4）。
//
// provider のネイティブログには USD が一切記録されていない（codex rollout / claude transcript の
// 双方で実測確認済み）。したがって cost は「トークン×単価」で合成するしかなく、それは実測ではない。
// 合成値は必ず MetricValue の `estimated` state で返し、`measured` と合算させない。
import { MODEL_PRICES, PRICE_TABLE_REF } from "./model-prices.generated.js";
import type { MetricValue, ModelPriceOverride } from "./types.js";

/** 1トークンあたりの USD 単価。cache 単価が価格表に無い provider は null を持つ。 */
export interface ModelPrice {
  inputCostPerToken: number;
  outputCostPerToken: number;
  /** cache write（5分 TTL）の単価 */
  cacheCreationCostPerToken: number | null;
  /** cache write（1時間 TTL）の単価。5m より高い（anthropic は input の 2.0倍 / 5m は 1.25倍） */
  cacheCreation1hCostPerToken: number | null;
  cacheReadCostPerToken: number | null;
}

/** モデル単価を config 上書きと生成価格表のどちらから解決したか。 */
export type ModelPriceSource = "override" | "table";

/** モデル単価と、その解決元。 */
export interface ResolvedModelPrice {
  price: ModelPrice;
  priceSource: ModelPriceSource;
}

/**
 * モデル単位のトークン内訳。
 * `inputTokens` / `outputTokens` / `cacheCreationTokens` / `cacheReadTokens` の**4系統が互いに素**で、
 * この4つだけを合算すれば二重計上にならない。`cacheCreation1hTokens` は
 * `cacheCreationTokens` の**内数**（単価を分けるためだけの補助項）なので、合算対象に入れないこと。
 */
export interface ModelTokenUsage {
  model: string;
  /** cache read/creation を含まない純 input */
  inputTokens: number;
  /** reasoning を内数として含む output */
  outputTokens: number;
  /** outputTokens の内数。合計へ足してはならない。provider が報告しなければ省略する。 */
  reasoningOutputTokens?: number;
  /** cache write の合計（5m と 1h の両方を含む） */
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /**
   * cacheCreationTokens の**内数**のうち 1h TTL 分。単価が 5m と異なるため分けて持つ。
   * 内訳を報告しない provider（codex）では undefined＝全量 5m 単価で算出する。
   * 合計から引いた残りが 5m 分なので、**この値を合計へ足してはならない**（二重計上になる）。
   */
  cacheCreation1hTokens?: number;
}

export { PRICE_TABLE_REF };

/**
 * モデル id を価格表で引く。**完全一致のみ**で、前方一致・正規化・別名解決は行わない。
 * 近いキーへ寄せると気付かないまま誤った単価が使われるため、引けなければ null を返して
 * 呼び出し側に「価格不明」として扱わせる。
 */
export function lookupModelPrice(model: string): ModelPrice | null {
  // Object.hasOwn で自前キーに限定する。素の添字アクセスだと "constructor" 等の prototype 由来の
  // 値が「単価らしきもの」として返り、モデル名次第で無関係なオブジェクトを単価に使ってしまう。
  return Object.hasOwn(MODEL_PRICES, model) ? (MODEL_PRICES[model] ?? null) : null;
}

/**
 * config 上書きを価格表より先に引く。どちらも完全一致だけを受理し、見つからなければ null を返す。
 * override の `source` は設定値の provenance であり、単価本体へ混ぜず `priceSource` と分けて返す。
 */
export function resolveModelPrice(
  model: string,
  overrides?: Readonly<Record<string, ModelPriceOverride>>,
): ResolvedModelPrice | null {
  if (overrides !== undefined && Object.hasOwn(overrides, model)) {
    const override = overrides[model];
    if (override !== undefined) {
      return {
        price: {
          inputCostPerToken: override.inputCostPerToken,
          outputCostPerToken: override.outputCostPerToken,
          cacheCreationCostPerToken: override.cacheCreationCostPerToken,
          cacheCreation1hCostPerToken: override.cacheCreation1hCostPerToken,
          cacheReadCostPerToken: override.cacheReadCostPerToken,
        },
        priceSource: "override",
      };
    }
  }
  const price = lookupModelPrice(model);
  return price === null ? null : { price, priceSource: "table" };
}

/** estimateCostUsd の結果。unpricedModels が空でない場合は金額を出さない。 */
export type CostEstimate =
  | { priced: true; usd: number; priceTableRef: string; priceSource: ModelPriceSource }
  | { priced: false; unpricedModels: string[] };

/**
 * モデル別トークン内訳から USD を推定する。
 *
 * 1モデルでも価格表に無ければ**部分合計を返さない**。部分合計は「安く見える正しそうな数値」に
 * なってしまい、欠落が誰にも観測されないまま集計を汚染するため（advisor 指摘）。
 * cache 単価が価格表に無い（openai 系の cache_creation 等）場合は、そのトークン数が 0 なら
 * 支払い額に影響しないので priced のまま扱い、0 でなければ価格不明として扱う。
 */
export function estimateCostUsd(
  perModel: readonly ModelTokenUsage[],
  overrides?: Readonly<Record<string, ModelPriceOverride>>,
): CostEstimate {
  const unpricedModels: string[] = [];
  let priceSource: ModelPriceSource = "table";
  let usd = 0;
  for (const usage of perModel) {
    const resolved = resolveModelPrice(usage.model, overrides);
    if (resolved === null) {
      unpricedModels.push(usage.model);
      continue;
    }
    const { price } = resolved;
    if (resolved.priceSource === "override") {
      priceSource = "override";
    }
    // 1h 分は内数。合計から引いた残りを 5m 単価で、1h 分を 1h 単価で計算する。
    // 内訳が範囲外（合計超過）なら信用せず全量を 5m 扱いにする（collector 側でも弾いているが、
    // 型としては外部入力なのでここでも閉じる）。
    const reported1h = usage.cacheCreation1hTokens ?? 0;
    const oneHourTokens = reported1h >= 0 && reported1h <= usage.cacheCreationTokens ? reported1h : 0;
    const fiveMinuteTokens = usage.cacheCreationTokens - oneHourTokens;
    const cacheCreationCost = resolveCacheCost(price.cacheCreationCostPerToken, fiveMinuteTokens);
    const cacheCreation1hCost = resolveCacheCost(price.cacheCreation1hCostPerToken, oneHourTokens);
    const cacheReadCost = resolveCacheCost(price.cacheReadCostPerToken, usage.cacheReadTokens);
    if (cacheCreationCost === null || cacheCreation1hCost === null || cacheReadCost === null) {
      unpricedModels.push(usage.model);
      continue;
    }
    usd +=
      usage.inputTokens * price.inputCostPerToken +
      usage.outputTokens * price.outputCostPerToken +
      cacheCreationCost +
      cacheCreation1hCost +
      cacheReadCost;
  }
  if (unpricedModels.length > 0) {
    return { priced: false, unpricedModels: [...new Set(unpricedModels)].sort() };
  }
  return { priced: true, usd, priceTableRef: PRICE_TABLE_REF, priceSource };
}

/** 単価未掲載でもトークン数が 0 なら金額に寄与しないので 0 を返す。0 でなければ null（価格不明）。 */
function resolveCacheCost(costPerToken: number | null, tokens: number): number | null {
  if (costPerToken !== null) {
    return tokens * costPerToken;
  }
  return tokens === 0 ? 0 : null;
}

/**
 * モデル別トークン内訳から「このセッションで最も活動しているモデル」の cache read 単価（USD/token）を引く。
 *
 * orchestrator-session-budget.ts の損益分岐計算（handoffValue 軸）では、直近応答の
 * contextModel を価格表で引けない場合にだけ使う**フォールバック専用**の解決器。
 * contextTokens は最後の応答1件の値なので、この累計内訳の代表モデルを第一候補にしてはならない。
 *
 * フォールバックの代表モデルは「input+output+cache creation+cache read の合計（活動量）が最大のモデル」とする
 * （レビュー指摘 #1 の初回リワーク。旧実装は cacheReadTokens の大小だけで選んでいたため、セッション
 * 序盤や cache write 直後など cache read がまだ1件も発生していない既知モデルでも代表を選べず、
 * 既定単価へ静かにフォールバックして claude-sonnet-5 で N を実際の 0.4倍（＝2.5分の1）に、
 * claude-fable-5 で N を実際の 2倍に誤算していた。cache read 数だけでなく input/output/cache write
 * からも累計内訳の代表は選べるため、活動量合計で選ぶ）。これは直近応答モデルを特定する手段ではなく、
 * contextModel を直接観測できない場合にだけ使う。
 *
 * 以下はすべて null（呼び出し側が既定値へフォールバックする）:
 * - perModel が空
 * - 代表モデルの活動量合計（input+output+cacheCreation+cacheRead）が 0
 *   （＝まだ何も消費しておらず代表を選べない）
 * - 代表モデルが価格表に無い、または価格表にあっても cacheReadCostPerToken が null
 */
export function resolveDominantCacheReadPrice(
  perModel: readonly ModelTokenUsage[],
  overrides?: Readonly<Record<string, ModelPriceOverride>>,
): number | null {
  if (perModel.length === 0) {
    return null;
  }
  const activity = (usage: ModelTokenUsage): number =>
    usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  const dominant = perModel.reduce((max, usage) => (activity(usage) > activity(max) ? usage : max));
  if (activity(dominant) <= 0) {
    return null;
  }
  const resolved = resolveModelPrice(dominant.model, overrides);
  return resolved?.price.cacheReadCostPerToken ?? null;
}

/** handoffValue 軸で cache read 単価を解決した経路。 */
export type HandoffCacheReadPriceSource = "context-model" | "dominant" | "default";

/** handoffValue 軸が実際に使う cache read 単価と、その解決経路。 */
export interface HandoffCacheReadPriceResolution {
  cacheReadCostPerToken: number;
  source: HandoffCacheReadPriceSource;
  /** default 定数へ落ちた場合はモデル単価を解決していないため省略する。 */
  priceSource?: ModelPriceSource;
}

/**
 * handoffValue 軸の cache read 単価を、直近応答モデル → 累計の代表モデル → 既定値の順で解決する。
 * contextModel が未観測または価格表に無い場合も、どのフォールバックを使ったかを戻り値へ残す。
 */
export function resolveHandoffCacheReadPrice(
  contextModel: string | undefined,
  perModel: readonly ModelTokenUsage[],
  defaultCacheReadCostPerToken: number,
  overrides?: Readonly<Record<string, ModelPriceOverride>>,
): HandoffCacheReadPriceResolution {
  if (contextModel !== undefined) {
    const resolved = resolveModelPrice(contextModel, overrides);
    if (resolved !== null && resolved.price.cacheReadCostPerToken !== null) {
      return {
        cacheReadCostPerToken: resolved.price.cacheReadCostPerToken,
        source: "context-model",
        priceSource: resolved.priceSource,
      };
    }
  }
  if (perModel.length > 0) {
    const activity = (usage: ModelTokenUsage): number =>
      usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
    const dominant = perModel.reduce((max, usage) => (activity(usage) > activity(max) ? usage : max));
    if (activity(dominant) > 0) {
      const resolved = resolveModelPrice(dominant.model, overrides);
      if (resolved !== null && resolved.price.cacheReadCostPerToken !== null) {
        return {
          cacheReadCostPerToken: resolved.price.cacheReadCostPerToken,
          source: "dominant",
          priceSource: resolved.priceSource,
        };
      }
    }
  }
  return { cacheReadCostPerToken: defaultCacheReadCostPerToken, source: "default" };
}

/** 推定 cost を MetricValue へ包む。価格不明なら unavailable-by-design（0 を入れない）。 */
export function costMetricFromEstimate(estimate: CostEstimate): MetricValue {
  if (!estimate.priced) {
    return { state: "unavailable-by-design" };
  }
  return { state: "estimated", value: estimate.usd, basis: "price-table", priceTableRef: estimate.priceTableRef };
}
