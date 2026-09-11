// 価格表引きの規約を固定する。近いキーへ寄せる（前方一致・正規化）実装は誤った単価を静かに使うため禁止。
import { describe, expect, it } from "vitest";
import {
  costMetricFromEstimate,
  estimateCostUsd,
  lookupModelPrice,
  resolveDominantCacheReadPrice,
  resolveHandoffCacheReadPrice,
  resolveModelPrice,
} from "./usage-pricing.js";

describe("lookupModelPrice", () => {
  it("完全一致でのみ引ける", () => {
    expect(lookupModelPrice("claude-sonnet-5")).not.toBeNull();
    expect(lookupModelPrice("gpt-5.6-sol")).not.toBeNull();
  });

  it("前方一致・別名・空文字では引けない（誤った単価の適用を防ぐ）", () => {
    expect(lookupModelPrice("claude-sonnet-5-20260101")).toBeNull();
    expect(lookupModelPrice("gpt-5.6-sol-high")).toBeNull();
    expect(lookupModelPrice("claude")).toBeNull();
    expect(lookupModelPrice("")).toBeNull();
  });

  it("prototype 汚染由来のキーを価格として拾わない", () => {
    expect(lookupModelPrice("constructor")).toBeNull();
    expect(lookupModelPrice("toString")).toBeNull();
  });
});

describe("estimateCostUsd", () => {
  it("4系統それぞれに対応する単価を掛けて合算する", () => {
    const price = lookupModelPrice("claude-sonnet-5");
    if (price === null) {
      throw new Error("価格表に claude-sonnet-5 が必要");
    }
    const estimate = estimateCostUsd([
      {
        model: "claude-sonnet-5",
        inputTokens: 1_000,
        outputTokens: 2_000,
        cacheCreationTokens: 3_000,
        cacheReadTokens: 4_000,
      },
    ]);
    if (!estimate.priced) {
      throw new Error("priced であること");
    }
    const expected =
      1_000 * price.inputCostPerToken +
      2_000 * price.outputCostPerToken +
      3_000 * (price.cacheCreationCostPerToken ?? Number.NaN) +
      4_000 * (price.cacheReadCostPerToken ?? Number.NaN);
    expect(estimate.usd).toBeCloseTo(expected, 12);
    // cache read を落とすと総額が変わる = 4系統すべてが式に効いていることの確認。
    expect(estimate.usd).toBeGreaterThan(
      1_000 * price.inputCostPerToken + 2_000 * price.outputCostPerToken,
    );
  });

  it("cache write の 1h 分を 1h 単価で計算する（5m 単価で潰さない）", () => {
    const price = lookupModelPrice("claude-opus-5");
    if (price === null || price.cacheCreation1hCostPerToken === null || price.cacheCreationCostPerToken === null) {
      throw new Error("価格表に claude-opus-5 の 5m/1h 単価が必要");
    }
    // 1h は 5m より高い（LiteLLM 実値で input の 2.0倍 vs 1.25倍）。
    expect(price.cacheCreation1hCostPerToken).toBeGreaterThan(price.cacheCreationCostPerToken);

    const base = { model: "claude-opus-5", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    // 内訳あり: 1,000 のうち 400 が 1h。
    const split = estimateCostUsd([{ ...base, cacheCreationTokens: 1_000, cacheCreation1hTokens: 400 }]);
    // 内訳なし（codex 等）: 全量 5m 単価。
    const flat = estimateCostUsd([{ ...base, cacheCreationTokens: 1_000 }]);
    if (!split.priced || !flat.priced) {
      throw new Error("priced であること");
    }
    expect(split.usd).toBeCloseTo(
      600 * price.cacheCreationCostPerToken + 400 * price.cacheCreation1hCostPerToken,
      12,
    );
    expect(flat.usd).toBeCloseTo(1_000 * price.cacheCreationCostPerToken, 12);
    // 1h を 5m 単価で潰していたら差が出ない。
    expect(split.usd).toBeGreaterThan(flat.usd);
  });

  it("1h 内数が合計を超える壊れた入力は内訳を信用せず全量を 5m 扱いにする", () => {
    const price = lookupModelPrice("claude-opus-5");
    if (price === null || price.cacheCreationCostPerToken === null) {
      throw new Error("価格表に claude-opus-5 が必要");
    }
    const estimate = estimateCostUsd([
      {
        model: "claude-opus-5",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 100,
        // 内数のはずが合計を超えている（本来ありえない）。負の 5m 分を作らないこと。
        cacheCreation1hTokens: 500,
        cacheReadTokens: 0,
      },
    ]);
    if (!estimate.priced) {
      throw new Error("priced であること");
    }
    expect(estimate.usd).toBeCloseTo(100 * price.cacheCreationCostPerToken, 12);
  });

  it("1h 単価が価格表に無い provider でも 1h トークンが 0 なら推定できる", () => {
    // codex 系は 1h の概念が無く LiteLLM にも単価が無い。内訳未報告なら従来どおり算出できること。
    const price = lookupModelPrice("gpt-5.6-sol");
    if (price === null) {
      throw new Error("価格表に gpt-5.6-sol が必要");
    }
    expect(price.cacheCreation1hCostPerToken).toBeNull();
    const estimate = estimateCostUsd([
      { model: "gpt-5.6-sol", inputTokens: 100, outputTokens: 10, cacheCreationTokens: 50, cacheReadTokens: 0 },
    ]);
    expect(estimate.priced).toBe(true);
  });

  it("1モデルでも価格不明なら部分合計を返さない", () => {
    const estimate = estimateCostUsd([
      { model: "gpt-5.6-sol", inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { model: "unknown-model", inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ]);
    expect(estimate).toEqual({ priced: false, unpricedModels: ["unknown-model"] });
    expect(costMetricFromEstimate(estimate)).toEqual({ state: "unavailable-by-design" });
  });

  it("cache 単価が価格表に無いモデルでも、該当トークンが 0 なら金額に影響しないので推定できる", () => {
    // openai 系は cache_creation の単価を持たないエントリがある。
    const estimate = estimateCostUsd([
      { model: "gpt-5.4", inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 5 },
    ]);
    expect(estimate.priced).toBe(true);
  });

  it("cache 単価が無いのにそのトークンが 0 でない場合は価格不明として扱う", () => {
    const estimate = estimateCostUsd([
      { model: "gpt-5.4", inputTokens: 100, outputTokens: 10, cacheCreationTokens: 7, cacheReadTokens: 0 },
    ]);
    expect(estimate).toEqual({ priced: false, unpricedModels: ["gpt-5.4"] });
  });
});

describe("config 単価上書き", () => {
  const overrides = {
    "claude-sonnet-5": {
      inputCostPerToken: 1e-6,
      outputCostPerToken: 2e-6,
      cacheCreationCostPerToken: 3e-6,
      cacheCreation1hCostPerToken: 4e-6,
      cacheReadCostPerToken: 5e-6,
      source: "test fixture",
    },
  };

  it("価格表より override を優先し、cost と handoff の両方へ priceSource を残す", () => {
    expect(resolveModelPrice("claude-sonnet-5", overrides)).toEqual({
      price: {
        inputCostPerToken: 1e-6,
        outputCostPerToken: 2e-6,
        cacheCreationCostPerToken: 3e-6,
        cacheCreation1hCostPerToken: 4e-6,
        cacheReadCostPerToken: 5e-6,
      },
      priceSource: "override",
    });

    const estimate = estimateCostUsd([
      {
        model: "claude-sonnet-5",
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 30,
        cacheCreation1hTokens: 10,
        cacheReadTokens: 40,
      },
    ], overrides);
    if (!estimate.priced) {
      throw new Error("override 単価で priced になること");
    }
    expect(estimate.priceSource).toBe("override");
    expect(estimate.usd).toBeCloseTo(10e-6 + 40e-6 + 60e-6 + 40e-6 + 200e-6, 12);
    expect(resolveHandoffCacheReadPrice("claude-sonnet-5", [], 0.5e-6, overrides)).toEqual({
      cacheReadCostPerToken: 5e-6,
      source: "context-model",
      priceSource: "override",
    });
  });
});

describe("resolveDominantCacheReadPrice（orchestrator-session-budget.ts の handoffValue 軸が使う代表単価）", () => {
  it("活動量（input+output+cacheCreation+cacheRead 合計）が最大のモデルの単価を返す", () => {
    const sonnetPrice = lookupModelPrice("claude-sonnet-5");
    if (sonnetPrice === null || sonnetPrice.cacheReadCostPerToken === null) {
      throw new Error("価格表に claude-sonnet-5 の cache read 単価が必要");
    }
    const price = resolveDominantCacheReadPrice([
      { model: "claude-opus-5", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 100 },
      // こちらが支配的（cacheReadTokens が大きい）ので、代表モデルとして選ばれるべき。
      { model: "claude-sonnet-5", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 500 },
    ]);
    expect(price).toBe(sonnetPrice.cacheReadCostPerToken);
  });

  it("perModel が空なら null（呼び出し側は既定値へフォールバックする）", () => {
    expect(resolveDominantCacheReadPrice([])).toBeNull();
  });

  it("代表モデルが価格表に無ければ null", () => {
    const price = resolveDominantCacheReadPrice([
      { model: "unknown-model", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 100 },
    ]);
    expect(price).toBeNull();
  });

  it("全モデルの活動量合計が0なら代表を選べずnull（真のフォールバック経路）", () => {
    const price = resolveDominantCacheReadPrice([
      { model: "claude-sonnet-5", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { model: "claude-opus-5", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ]);
    expect(price).toBeNull();
  });

  it("F1リワーク: cacheReadTokens が全て0でも、既知モデルなら input/output トークンから代表を選び単価を返す（レビュー指摘 #1。旧実装はここで null を返し既定単価へ誤フォールバックしていた）", () => {
    const sonnetPrice = lookupModelPrice("claude-sonnet-5");
    if (sonnetPrice === null || sonnetPrice.cacheReadCostPerToken === null) {
      throw new Error("価格表に claude-sonnet-5 の cache read 単価が必要");
    }
    const price = resolveDominantCacheReadPrice([
      // まだ cache read が一度も発生していない（セッション序盤、または cache write 直後）。
      { model: "claude-sonnet-5", inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { model: "claude-opus-5", inputTokens: 50, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ]);
    expect(price).toBe(sonnetPrice.cacheReadCostPerToken);
  });

  it("cacheReadTokens ではなく活動量合計で代表を選ぶ（cache read が僅少でも入出力が支配的なモデルを優先する）", () => {
    const sonnetPrice = lookupModelPrice("claude-sonnet-5");
    if (sonnetPrice === null || sonnetPrice.cacheReadCostPerToken === null) {
      throw new Error("価格表に claude-sonnet-5 の cache read 単価が必要");
    }
    const opusPrice = lookupModelPrice("claude-opus-5");
    if (opusPrice === null || opusPrice.cacheReadCostPerToken === null) {
      throw new Error("価格表に claude-opus-5 の cache read 単価が必要");
    }
    // 旧実装（cacheReadTokens の大小だけで選ぶ）なら opus（cacheReadTokens=50>0）が代表に選ばれていた。
    // 新実装（活動量合計で選ぶ）なら sonnet（6,000 > 50）が代表に選ばれ、価格が変わる。
    const price = resolveDominantCacheReadPrice([
      { model: "claude-opus-5", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 50 },
      { model: "claude-sonnet-5", inputTokens: 5_000, outputTokens: 1_000, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ]);
    expect(price).toBe(sonnetPrice.cacheReadCostPerToken);
    expect(price).not.toBe(opusPrice.cacheReadCostPerToken);
  });
});

describe("resolveHandoffCacheReadPrice（直近応答モデルを優先する3段フォールバック）", () => {
  const defaultPrice = 0.5e-6;
  const fableDominant = [
    { model: "claude-fable-5", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 300_000 },
    { model: "claude-sonnet-5", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 231_230 },
  ];

  it("直近 Sonnet と累計最大 Fable が不一致でも contextModel の Sonnet 単価を選ぶ", () => {
    expect(resolveHandoffCacheReadPrice("claude-sonnet-5", fableDominant, defaultPrice)).toEqual({
      cacheReadCostPerToken: 0.2e-6,
      source: "context-model",
      priceSource: "table",
    });
  });

  it("contextModel が価格表に無ければ累計最大モデルへ落ち、出所を dominant と記録する", () => {
    expect(resolveHandoffCacheReadPrice("unknown-model", fableDominant, defaultPrice)).toEqual({
      cacheReadCostPerToken: 1e-6,
      source: "dominant",
      priceSource: "table",
    });
  });

  it("contextModel が undefined なら累計最大モデルへ落ちる", () => {
    expect(resolveHandoffCacheReadPrice(undefined, fableDominant, defaultPrice)).toEqual({
      cacheReadCostPerToken: 1e-6,
      source: "dominant",
      priceSource: "table",
    });
  });

  it("perModel が空なら既定定数へ落ち、出所を default と記録する", () => {
    expect(resolveHandoffCacheReadPrice(undefined, [], defaultPrice)).toEqual({
      cacheReadCostPerToken: defaultPrice,
      source: "default",
    });
  });
});
