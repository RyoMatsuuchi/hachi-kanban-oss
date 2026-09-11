// =============================================================================
// セッション消費の段階判定（runbooks/orchestrator-playbook.md §0.7 2026-08-22 改訂）。
// 4軸それぞれの境界値・集約対象3軸の最大段階・軸ごとの config 上書き・損益分岐計算を固定する。
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  computeContextSaturation,
  computeHandoffBreakEvenTurns,
  DEFAULT_SESSION_BUDGET_C0,
  DEFAULT_SESSION_BUDGET_THRESHOLDS,
  evaluateSessionBudget,
  evaluateSessionBudgetAxis,
  HANDOFF_CACHE_READ_USD_PER_TOKEN,
  resolveSessionBudgetThresholds,
  SESSION_BUDGET_AGGREGATED_AXES,
  SESSION_BUDGET_AXES,
  SESSION_BUDGET_AXIS_UNMEASURED_REASON_KIND,
  SESSION_BUDGET_EXIT_CODES,
  SESSION_BUDGET_INFORMATIONAL_AXES,
  type AssertTrue,
  type IsExactStringUnion,
  type SessionBudgetAxesMatchConfigKeys,
  type SessionBudgetAxisThresholds,
  type SessionBudgetMetrics,
} from "./orchestrator-session-budget.js";
import { lookupModelPrice, resolveDominantCacheReadPrice } from "./usage-pricing.js";

/** 純粋な N の式を固定するためのテスト入力。production の既定 S ではない。 */
const FORMULA_COST_MODEL = { c0: DEFAULT_SESSION_BUDGET_C0, s: 1.95 };

/** 指定した軸だけ値を持ち、他は観測できなかったことにする。1軸の効果を単独で見るため。 */
function only(axis: keyof SessionBudgetMetrics, value: number): SessionBudgetMetrics {
  return {
    turns: undefined,
    contextSaturation: undefined,
    handoffValue: undefined,
    effectiveCostUsd: undefined,
    [axis]: value,
  };
}

describe("既定の閾値（playbook §0.7 2026-08-22 改訂）", () => {
  it("表のとおりの値である", () => {
    // 既定値が動くと通知の意味が変わるため、表そのものを固定する。
    expect(DEFAULT_SESSION_BUDGET_THRESHOLDS).toEqual({
      turns: { notice: 60, recommend: 100, urgent: 200 },
      contextSaturation: { notice: 0.6, recommend: 0.75, urgent: 0.85 },
      handoffValue: { notice: 30, recommend: 20, urgent: 10 },
      effectiveCostUsd: { notice: 15, recommend: 30, urgent: 60 },
    });
  });

  it("段階ごとに別の終了コードを持つ（フックで段階を選別できる）", () => {
    expect(SESSION_BUDGET_EXIT_CODES).toEqual({ ok: 0, notice: 10, recommend: 11, urgent: 12 });
  });

  it("実測が無い場合の C0 だけを既定値として持ち、S の既定定数は持たない", () => {
    expect(DEFAULT_SESSION_BUDGET_C0).toBe(101_231);
  });

  it("総合段階へ集約する軸を1箇所で定義し、turns は含めない", () => {
    expect(SESSION_BUDGET_AGGREGATED_AXES).toEqual([
      "contextSaturation",
      "handoffValue",
      "effectiveCostUsd",
    ]);
  });

  it("全軸を集約対象か明示的な informational のどちらか一方に分類する", () => {
    const classifiedAxes = [...SESSION_BUDGET_AGGREGATED_AXES, ...SESSION_BUDGET_INFORMATIONAL_AXES];
    expect(new Set(classifiedAxes).size).toBe(classifiedAxes.length);
    expect([...classifiedAxes].sort()).toEqual([...SESSION_BUDGET_AXES].sort());
  });
});

describe("4軸それぞれの段階を算出する", () => {
  // 各軸の (値, 期待段階)。
  // turns / contextSaturation / effectiveCostUsd は higherIsWorse（閾値**以上**でその段階に入る）。
  // handoffValue だけ lowerIsWorse（閾値**以下**でその段階に入る。損益分岐ターン数 N は小さいほど悪い）。
  const cases: Array<[keyof SessionBudgetMetrics, Array<[number, string]>]> = [
    ["turns", [[59, "ok"], [60, "notice"], [99, "notice"], [100, "recommend"], [199, "recommend"], [200, "urgent"]]],
    ["contextSaturation", [
      [0.599, "ok"], [0.6, "notice"], [0.749, "notice"],
      [0.75, "recommend"], [0.849, "recommend"], [0.85, "urgent"],
    ]],
    ["effectiveCostUsd", [
      [14, "ok"], [15, "notice"], [29, "notice"],
      [30, "recommend"], [59, "recommend"], [60, "urgent"],
    ]],
    // handoffValue は逆向き: N が小さいほど悪い。31(ok)→30(notice)→21(notice)→20(recommend)→11(recommend)→10(urgent)。
    ["handoffValue", [[31, "ok"], [30, "notice"], [21, "notice"], [20, "recommend"], [11, "recommend"], [10, "urgent"]]],
  ];

  for (const [axis, boundaries] of cases) {
    for (const [value, expected] of boundaries) {
      it(`${axis}=${value} だけで ${expected} になる`, () => {
        const evaluation = evaluateSessionBudget(only(axis, value));
        expect(evaluation.axes.find((entry) => entry.axis === axis)?.stage).toBe(expected);
        expect(evaluation.stage).toBe(axis === "turns" ? null : expected);
        expect(evaluation.axes.filter((entry) => entry.axis !== axis).map((entry) => entry.stage)).toEqual([
          null,
          null,
          null,
        ]);
      });
    }
  }
});

describe("evaluateSessionBudgetAxis: axis から向きを解決する（direction 引数は存在しない）", () => {
  it("handoffValue=5（notice/recommend/urgentいずれの閾値も下回る）は urgent になる", () => {
    // レビュー指摘の再発防止: 旧シグネチャは direction 引数が省略可能で、既定値が
    // higherIsWorse だったため、lowerIsWorse な handoffValue を direction 省略で呼ぶと
    // N=5（本来 urgent）が黙って ok と判定されていた。新シグネチャは axis から
    // SESSION_BUDGET_AXIS_DIRECTIONS を内部で引くため、direction を渡す余地がなく反転しない。
    expect(
      evaluateSessionBudgetAxis("handoffValue", 5, { notice: 30, recommend: 20, urgent: 10 }),
    ).toBe("urgent");
  });

  it("4軸すべてで、軸名を渡すだけで軸ごとの正しい向きが適用される", () => {
    // turns / contextSaturation / effectiveCostUsd は higherIsWorse、handoffValue だけ lowerIsWorse。
    // 軸ごとの thresholds を使い、「urgent 側の値」「ok 側の値」を1つずつ確認する。
    const higherIsWorseAxes: Array<[keyof SessionBudgetMetrics, SessionBudgetAxisThresholds]> = [
      ["turns", DEFAULT_SESSION_BUDGET_THRESHOLDS.turns],
      ["contextSaturation", DEFAULT_SESSION_BUDGET_THRESHOLDS.contextSaturation],
      ["effectiveCostUsd", DEFAULT_SESSION_BUDGET_THRESHOLDS.effectiveCostUsd],
    ];
    for (const [axis, thresholds] of higherIsWorseAxes) {
      expect(evaluateSessionBudgetAxis(axis, thresholds.urgent, thresholds)).toBe("urgent");
      expect(evaluateSessionBudgetAxis(axis, thresholds.notice - 1, thresholds)).toBe("ok");
    }

    const handoffThresholds = DEFAULT_SESSION_BUDGET_THRESHOLDS.handoffValue;
    // lowerIsWorse: 値が閾値**以下**で悪化する。urgent の閾値そのものは urgent、notice を上回れば ok。
    expect(evaluateSessionBudgetAxis("handoffValue", handoffThresholds.urgent, handoffThresholds)).toBe("urgent");
    expect(evaluateSessionBudgetAxis("handoffValue", handoffThresholds.notice + 1, handoffThresholds)).toBe("ok");
  });
});

describe("D2 cross-validation: N空間とC空間の損益分岐が一致する", () => {
  // computeHandoffBreakEvenTurns（C→N）と evaluateSessionBudgetAxis（N→段階）が
  // 同じ境界で一致することを、両方向から証明する。
  const cases: Array<[number, number, string]> = [
    [231_231, 30, "notice"],
    [296_231, 20, "recommend"],
    [491_231, 10, "urgent"],
  ];

  for (const [contextTokens, expectedN, expectedStage] of cases) {
    it(`contextTokens=${contextTokens} は N=${expectedN}（${expectedStage}）と一致する`, () => {
      expect(computeHandoffBreakEvenTurns(contextTokens, FORMULA_COST_MODEL)).toBe(expectedN);
      expect(
        evaluateSessionBudgetAxis("handoffValue", expectedN, DEFAULT_SESSION_BUDGET_THRESHOLDS.handoffValue),
      ).toBe(expectedStage);
    });
  }
});

describe("軸が食い違うときは最大段階を採る", () => {
  it("turns だけが recommend でも集約対象3軸が ok なら総合は ok", () => {
    const evaluation = evaluateSessionBudget({
      turns: 184,
      contextSaturation: 0.26,
      handoffValue: 50,
      effectiveCostUsd: 1,
    });
    expect(evaluation?.stage).toBe("ok");
    expect(evaluation?.firedAxes).toEqual([]);
    expect(evaluation?.axes.find((entry) => entry.axis === "turns")).toMatchObject({
      value: 184,
      stage: "recommend",
      informational: true,
    });
  });

  it("turns が urgent でも集約対象3軸が ok なら総合は ok", () => {
    const evaluation = evaluateSessionBudget({
      turns: 200,
      contextSaturation: 0.26,
      handoffValue: 50,
      effectiveCostUsd: 1,
    });
    expect(evaluation.stage).toBe("ok");
    expect(evaluation.firedAxes).toEqual([]);
    expect(evaluation.axes.find((entry) => entry.axis === "turns")?.stage).toBe("urgent");
  });

  it("turns が ok でも contextSaturation が recommend なら総合は recommend", () => {
    const evaluation = evaluateSessionBudget({
      turns: 5,
      contextSaturation: 0.8,
      handoffValue: 50,
      effectiveCostUsd: 1,
    });
    expect(evaluation?.stage).toBe("recommend");
    expect(evaluation?.firedAxes).toEqual(["contextSaturation"]);
  });

  it("turns が ok でも文脈飽和だけで urgent になる", () => {
    const evaluation = evaluateSessionBudget({
      turns: 5,
      contextSaturation: 0.9,
      handoffValue: 50,
      effectiveCostUsd: 1,
    });
    expect(evaluation?.stage).toBe("urgent");
    expect(evaluation?.firedAxes).toEqual(["contextSaturation"]);
  });

  it("実効コストだけ recommend、文脈飽和は notice でも recommend になる", () => {
    const evaluation = evaluateSessionBudget({
      turns: 10,
      contextSaturation: 0.65,
      handoffValue: 50,
      effectiveCostUsd: 35,
    });
    expect(evaluation?.stage).toBe("recommend");
    expect(evaluation?.firedAxes).toEqual(["effectiveCostUsd"]);
  });

  it("同じ段階でも表示専用の turns は firedAxes に入れない", () => {
    const evaluation = evaluateSessionBudget({
      turns: 120,
      contextSaturation: 0.8,
      handoffValue: 50,
      effectiveCostUsd: 1,
    });
    expect(evaluation?.stage).toBe("recommend");
    expect(evaluation?.firedAxes).toEqual(["contextSaturation"]);
  });

  it("ok のときは firedAxes を空にする（全軸が発火したと読めないように）", () => {
    const evaluation = evaluateSessionBudget({
      turns: 1,
      contextSaturation: 0.01,
      handoffValue: 100,
      effectiveCostUsd: 1,
    });
    expect(evaluation?.stage).toBe("ok");
    expect(evaluation?.firedAxes).toEqual([]);
  });

  it("どの軸も観測できなければ内訳を残して判定不能（stage=null）", () => {
    const evaluation = evaluateSessionBudget({
      turns: undefined,
      contextSaturation: undefined,
      handoffValue: undefined,
      effectiveCostUsd: undefined,
    });
    expect(evaluation.stage).toBeNull();
    expect(evaluation.axes).toHaveLength(SESSION_BUDGET_AXES.length);
  });

  it("第3引数で軸別の未計測理由を上書きする", () => {
    const evaluation = evaluateSessionBudget(
      {
        turns: 1,
        contextSaturation: 0.1,
        handoffValue: undefined,
        effectiveCostUsd: undefined,
      },
      undefined,
      {
        handoffValue: "codex-credit-ledger-unpriced",
        effectiveCostUsd: "codex-credit-ledger-unpriced",
      },
    );
    expect(evaluation.axes.find((entry) => entry.axis === "handoffValue")?.unmeasured).toEqual({
      reason: "codex-credit-ledger-unpriced",
    });
    expect(evaluation.axes.find((entry) => entry.axis === "effectiveCostUsd")?.unmeasured).toEqual({
      reason: "codex-credit-ledger-unpriced",
    });
  });

  it("集約対象3軸が全て未計測なら turns だけ測れていても判定不能（stage=null）", () => {
    const evaluation = evaluateSessionBudget(only("turns", 250));
    expect(evaluation.stage).toBeNull();
    expect(evaluation.axes.find((entry) => entry.axis === "turns")).toMatchObject({
      value: 250,
      stage: "urgent",
      informational: true,
    });
  });

  it("観測できない集約対象軸を 0 扱いしない", () => {
    // contextSaturation だけ urgent。残りの集約対象2軸が未計測でも urgent は維持する。
    const evaluation = evaluateSessionBudget(only("contextSaturation", 0.9));
    expect(evaluation?.stage).toBe("urgent");
    expect(evaluation?.axes.find((entry) => entry.axis === "handoffValue")?.value).toBeUndefined();
  });
});

describe("config による軸ごとの上書き（additive）", () => {
  it("指定した軸・段階だけを上書きし、残りは既定のまま", () => {
    const thresholds = resolveSessionBudgetThresholds({ turns: { notice: 20 } });
    expect(thresholds.turns).toEqual({ notice: 20, recommend: 100, urgent: 200 });
    expect(thresholds.contextSaturation).toEqual(DEFAULT_SESSION_BUDGET_THRESHOLDS.contextSaturation);
    expect(thresholds.handoffValue).toEqual(DEFAULT_SESSION_BUDGET_THRESHOLDS.handoffValue);
    expect(thresholds.effectiveCostUsd).toEqual(DEFAULT_SESSION_BUDGET_THRESHOLDS.effectiveCostUsd);
  });

  it("上書きした閾値で判定が変わる", () => {
    const thresholds = resolveSessionBudgetThresholds({
      contextSaturation: { notice: 0.1, recommend: 0.2, urgent: 0.3 },
    });
    expect(evaluateSessionBudget(only("contextSaturation", 0.3), thresholds)?.stage).toBe("urgent");
    // 既定のままなら閾値未満で ok にしかならない値。
    expect(evaluateSessionBudget(only("contextSaturation", 0.3))?.stage).toBe("ok");
  });

  it("未指定なら既定と完全に一致する", () => {
    expect(resolveSessionBudgetThresholds()).toEqual(DEFAULT_SESSION_BUDGET_THRESHOLDS);
    expect(resolveSessionBudgetThresholds({})).toEqual(DEFAULT_SESSION_BUDGET_THRESHOLDS);
  });

  it("段階が逆転する上書き（higherIsWorse 軸）は fail-closed で throw する", () => {
    // notice > recommend では「notice を超えたのに recommend にならない」区間ができ判定が壊れる。
    expect(() => resolveSessionBudgetThresholds({ turns: { notice: 500 } })).toThrow(/notice <= recommend <= urgent/);
    // urgent だけ下げると既定の notice/recommend を下回り、同じく逆転する。
    expect(() => resolveSessionBudgetThresholds({ effectiveCostUsd: { urgent: 1 } })).toThrow(/effectiveCostUsd/);
  });

  it("段階が逆転する上書き（lowerIsWorse 軸）は fail-closed で throw する", () => {
    // handoffValue は逆向き（notice >= recommend >= urgent）。notice を recommend 未満へ下げると逆転する。
    expect(() => resolveSessionBudgetThresholds({ handoffValue: { notice: 5 } })).toThrow(
      /notice >= recommend >= urgent/,
    );
  });
});

describe("computeContextSaturation（文脈飽和度＝ contextTokens / contextWindowTokens）", () => {
  it("既知の比率を計算する", () => {
    expect(computeContextSaturation(600_000, 1_000_000)).toBe(0.6);
  });

  it("window サイズが不明なら undefined（0 や 1 で埋めない）", () => {
    expect(computeContextSaturation(600_000, undefined)).toBeUndefined();
  });

  it("window サイズが 0 以下なら undefined（不正値を計算に使わない）", () => {
    expect(computeContextSaturation(600_000, 0)).toBeUndefined();
    expect(computeContextSaturation(600_000, -1)).toBeUndefined();
  });
});

describe("computeHandoffBreakEvenTurns（損益分岐ターン数 N）", () => {
  it("明示した cost model で3つの境界値を計算する（D1/D2 と対応）", () => {
    expect(computeHandoffBreakEvenTurns(231_231, FORMULA_COST_MODEL)).toBe(30);
    expect(computeHandoffBreakEvenTurns(296_231, FORMULA_COST_MODEL)).toBe(20);
    expect(computeHandoffBreakEvenTurns(491_231, FORMULA_COST_MODEL)).toBe(10);
  });

  it("contextTokens が C0 以下なら損益分岐点が存在しない（undefined。0 で埋めない）", () => {
    expect(computeHandoffBreakEvenTurns(FORMULA_COST_MODEL.c0, FORMULA_COST_MODEL)).toBeUndefined();
    expect(computeHandoffBreakEvenTurns(50_000, FORMULA_COST_MODEL)).toBeUndefined();
  });

  it("cost model を上書きすると結果が変わる", () => {
    expect(computeHandoffBreakEvenTurns(300_000, { c0: 100_000, s: 1 })).toBe(10);
  });

  it("第三引数省略時は既定の HANDOFF_CACHE_READ_USD_PER_TOKEN を使う", () => {
    expect(computeHandoffBreakEvenTurns(231_231, FORMULA_COST_MODEL)).toBe(
      computeHandoffBreakEvenTurns(231_231, FORMULA_COST_MODEL, HANDOFF_CACHE_READ_USD_PER_TOKEN),
    );
  });

  it("claude-sonnet-5 の実単価（2e-7）を渡すと、既定フォールバック（0.5e-6）計算の N の 2.5倍になる", () => {
    // 価格表の値をハードコードせず lookupModelPrice で実測する（価格表が変わってもテストが追従する）。
    const price = lookupModelPrice("claude-sonnet-5");
    if (price === null || price.cacheReadCostPerToken === null) {
      throw new Error("価格表に claude-sonnet-5 の cache read 単価が必要");
    }
    const contextTokens = 300_000;
    const fallbackN = computeHandoffBreakEvenTurns(contextTokens, FORMULA_COST_MODEL);
    const sonnetN = computeHandoffBreakEvenTurns(
      contextTokens,
      FORMULA_COST_MODEL,
      price.cacheReadCostPerToken,
    );
    if (fallbackN === undefined || sonnetN === undefined) {
      throw new Error("この contextTokens では両方とも損益分岐点が存在するはず");
    }
    // 単価が既定の 1/2.5 なら、単価に反比例する N は 2.5倍になる。
    const priceRatio = HANDOFF_CACHE_READ_USD_PER_TOKEN / price.cacheReadCostPerToken;
    expect(priceRatio).toBeCloseTo(2.5, 10);
    expect(sonnetN / fallbackN).toBeCloseTo(priceRatio, 10);
  });

  it("claude-fable-5 の実単価（1e-6）を渡すと、既定フォールバック計算の N の 0.5倍になる（過大評価が是正される）", () => {
    const price = lookupModelPrice("claude-fable-5");
    if (price === null || price.cacheReadCostPerToken === null) {
      throw new Error("価格表に claude-fable-5 の cache read 単価が必要");
    }
    const contextTokens = 300_000;
    const fallbackN = computeHandoffBreakEvenTurns(contextTokens, FORMULA_COST_MODEL);
    const fableN = computeHandoffBreakEvenTurns(
      contextTokens,
      FORMULA_COST_MODEL,
      price.cacheReadCostPerToken,
    );
    if (fallbackN === undefined || fableN === undefined) {
      throw new Error("この contextTokens では両方とも損益分岐点が存在するはず");
    }
    const priceRatio = HANDOFF_CACHE_READ_USD_PER_TOKEN / price.cacheReadCostPerToken;
    expect(priceRatio).toBeCloseTo(0.5, 10);
    expect(fableN / fallbackN).toBeCloseTo(priceRatio, 10);
  });
});

describe("resolveDominantCacheReadPrice → computeHandoffBreakEvenTurns のフォールバック経路", () => {
  it("単価が引けない（perModel が空）ときは呼び出し側の ?? undefined で既定値計算に一致する", () => {
    const price = resolveDominantCacheReadPrice([]);
    expect(price).toBeNull();
    const n = computeHandoffBreakEvenTurns(231_231, FORMULA_COST_MODEL, price ?? undefined);
    expect(n).toBe(computeHandoffBreakEvenTurns(231_231, FORMULA_COST_MODEL));
  });

  it("単価が引けない（価格表に無いモデル）ときも既定値計算に一致する", () => {
    const price = resolveDominantCacheReadPrice([
      { model: "unknown-model", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 100 },
    ]);
    expect(price).toBeNull();
    const n = computeHandoffBreakEvenTurns(231_231, FORMULA_COST_MODEL, price ?? undefined);
    expect(n).toBe(computeHandoffBreakEvenTurns(231_231, FORMULA_COST_MODEL));
  });

  it("F1リワーク: 既知モデルは cacheReadTokens が全て0でも入出力トークンから単価が引け、既定値と異なる N になる（レビュー指摘 #1。旧実装はここで null を返し既定単価へ誤フォールバックしていた）", () => {
    const sonnetPrice = lookupModelPrice("claude-sonnet-5");
    if (sonnetPrice === null || sonnetPrice.cacheReadCostPerToken === null) {
      throw new Error("価格表に claude-sonnet-5 の cache read 単価が必要");
    }
    const price = resolveDominantCacheReadPrice([
      { model: "claude-sonnet-5", inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ]);
    expect(price).toBe(sonnetPrice.cacheReadCostPerToken);
    const n = computeHandoffBreakEvenTurns(300_000, FORMULA_COST_MODEL, price ?? undefined);
    const fallbackN = computeHandoffBreakEvenTurns(300_000, FORMULA_COST_MODEL);
    expect(n).not.toBe(fallbackN);
  });

  it("単価が引けない（全モデルの活動量合計が0）ときは既定値計算に一致する（真のフォールバック経路）", () => {
    const price = resolveDominantCacheReadPrice([
      { model: "claude-sonnet-5", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ]);
    expect(price).toBeNull();
    const n = computeHandoffBreakEvenTurns(231_231, FORMULA_COST_MODEL, price ?? undefined);
    expect(n).toBe(computeHandoffBreakEvenTurns(231_231, FORMULA_COST_MODEL));
  });

  it("価格表から単価が引けるときは既定値と異なる N になる（統合の効果を実際に確認する）", () => {
    const sonnetPrice = lookupModelPrice("claude-sonnet-5");
    if (sonnetPrice === null || sonnetPrice.cacheReadCostPerToken === null) {
      throw new Error("価格表に claude-sonnet-5 の cache read 単価が必要");
    }
    const price = resolveDominantCacheReadPrice([
      { model: "claude-sonnet-5", inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 500 },
    ]);
    expect(price).toBe(sonnetPrice.cacheReadCostPerToken);
    const n = computeHandoffBreakEvenTurns(300_000, FORMULA_COST_MODEL, price ?? undefined);
    const fallbackN = computeHandoffBreakEvenTurns(300_000, FORMULA_COST_MODEL);
    expect(n).not.toBe(fallbackN);
  });
});

describe("軸が未計測の理由（unmeasured）", () => {
  it("SESSION_BUDGET_AXIS_UNMEASURED_REASON_KIND の分類は missing / not-applicable を混同しない", () => {
    expect(SESSION_BUDGET_AXIS_UNMEASURED_REASON_KIND["context-window-unknown"]).toBe("missing");
    expect(SESSION_BUDGET_AXIS_UNMEASURED_REASON_KIND["cost-model-floor-not-exceeded"]).toBe("not-applicable");
    // 価格表に無いモデルは再生成すれば直せる欠測であり、not-applicable（良性）ではない。
    expect(SESSION_BUDGET_AXIS_UNMEASURED_REASON_KIND["cost-model-unpriced"]).toBe("missing");
  });

  it("contextSaturation だけ undefined なら unmeasured.reason=context-window-unknown が付く（他の軸には付かない）", () => {
    const evaluation = evaluateSessionBudget({
      turns: 5,
      contextSaturation: undefined,
      handoffValue: 50,
      effectiveCostUsd: 1,
    });
    const contextSaturationAxis = evaluation?.axes.find((entry) => entry.axis === "contextSaturation");
    expect(contextSaturationAxis?.unmeasured).toEqual({ reason: "context-window-unknown" });
    for (const axis of evaluation?.axes.filter((entry) => entry.axis !== "contextSaturation") ?? []) {
      expect(axis.unmeasured).toBeUndefined();
    }
  });

  it("handoffValue だけ undefined なら unmeasured.reason=cost-model-floor-not-exceeded が付く", () => {
    const evaluation = evaluateSessionBudget({
      turns: 5,
      contextSaturation: 0.1,
      handoffValue: undefined,
      effectiveCostUsd: 1,
    });
    const handoffValueAxis = evaluation?.axes.find((entry) => entry.axis === "handoffValue");
    expect(handoffValueAxis?.unmeasured).toEqual({ reason: "cost-model-floor-not-exceeded" });
    for (const axis of evaluation?.axes.filter((entry) => entry.axis !== "handoffValue") ?? []) {
      expect(axis.unmeasured).toBeUndefined();
    }
  });

  it("effectiveCostUsd だけ undefined なら unmeasured.reason=cost-model-unpriced が付く", () => {
    // 価格表に無いモデルを使うと usage-pricing.ts の estimateCostUsd が priced=false を返し、
    // orchestrator-usage.ts の costEstimate.priced 分岐で effectiveCostUsd が undefined になる。
    // かつて対応する reason が凍結契約に無く silent dropout だったが、cost-model-unpriced の追加で塞いだ。
    const evaluation = evaluateSessionBudget({
      turns: 5,
      contextSaturation: 0.1,
      handoffValue: 50,
      effectiveCostUsd: undefined,
    });
    const effectiveCostUsdAxis = evaluation?.axes.find((entry) => entry.axis === "effectiveCostUsd");
    expect(effectiveCostUsdAxis?.unmeasured).toEqual({ reason: "cost-model-unpriced" });
    for (const axis of evaluation?.axes.filter((entry) => entry.axis !== "effectiveCostUsd") ?? []) {
      expect(axis.unmeasured).toBeUndefined();
    }
  });

  it("reason テーブルに無い軸（turns）が undefined でも unmeasured は付かない", () => {
    // turns は usage.turns から直接入るため実測上 undefined にならないが、万一 undefined が
    // 渡っても reason テーブルに無い軸は unmeasured を持たないという契約を固定する。
    const evaluation = evaluateSessionBudget({
      turns: undefined,
      contextSaturation: 0.1,
      handoffValue: 50,
      effectiveCostUsd: 1,
    });
    expect(evaluation?.axes.find((entry) => entry.axis === "turns")?.unmeasured).toBeUndefined();
  });

  it("SESSION_BUDGET_AXES を全数列挙し、value===undefined なのに unmeasured が付かない軸がないことを固定する（silent dropout の再発防止）", () => {
    // 実運用で成立する入力を4軸へ列挙する。turns は usage.turns から得た実測値を入れ、
    // 残りは各軸で実際に起こる未計測状態（contextSaturation / effectiveCostUsd は missing、
    // handoffValue は cost model のフロア未超過による not-applicable）を表す。
    // 新しい軸を追加して reason を登録し忘れると、理由なし欠測の集合が空でなくなる。
    const evaluation = evaluateSessionBudget({
      turns: 5,
      contextSaturation: undefined,
      handoffValue: undefined,
      effectiveCostUsd: undefined,
    });
    const axesWithoutReasonWhenUndefined = SESSION_BUDGET_AXES.filter((axis) => {
      const entry = evaluation?.axes.find((e) => e.axis === axis);
      return entry !== undefined && entry.value === undefined && entry.unmeasured === undefined;
    });
    expect(axesWithoutReasonWhenUndefined).toEqual([]);
  });

  it("value が定義されている軸には unmeasured が一切付かない", () => {
    const evaluation = evaluateSessionBudget({
      turns: 5,
      contextSaturation: 0.1,
      handoffValue: 50,
      effectiveCostUsd: 1,
    });
    for (const axis of evaluation?.axes ?? []) {
      expect(axis.unmeasured).toBeUndefined();
    }
  });
});

describe("F3: SESSION_BUDGET_AXES と OrchestratorSessionBudgetConfig（types.ts）のキー集合の完全一致をコンパイル時に強制する", () => {
  it("SessionBudgetAxesMatchConfigKeys は現状の軸集合とconfigキー集合が一致するため型 true に解決される", () => {
    // 型だけの契約なので実行時には何もしない（何かを計算・検証するコードではない）。
    // SESSION_BUDGET_AXES に軸を足して types.ts の OrchestratorSessionBudgetConfig を更新し忘れると、
    // orchestrator-session-budget.ts 側で SessionBudgetAxesMatchConfigKeys の定義自体が型エラーになり、
    // この import 文（ひいては typecheck 全体）が壊れる。現状は一致しているため
    // SessionBudgetAxesMatchConfigKeys は型 `true` に解決され、次の代入が型検査を通る。
    const matches: SessionBudgetAxesMatchConfigKeys = true;
    expect(matches).toBe(true);
  });

  it("IsExactStringUnion + AssertTrue は、集合が一致しない架空の union に適用すると型エラーを起こす（negative type test。アサーション機構自体の健全性を固定する）", () => {
    // SessionBudgetAxis と ConfigAxisKeys を実際に不一致にすることはできない（types.ts は凍結契約で
    // 編集禁止）ため、ここでは同じ機構（IsExactStringUnion + AssertTrue）を、わざと集合として
    // 一致しない架空の union（"a" | "b" と "a" | "c"）に適用し、@ts-expect-error が
    // 「期待通りエラーになった」ことを検証する。
    //
    // もし将来 IsExactStringUnion または AssertTrue の実装を壊し、常に true を返すようにしてしまったら、
    // 次の行はもう型エラーを起こさなくなる。その場合 @ts-expect-error は「使われていない
    // ts-expect-error ディレクティブ」という別の型エラー（TS2578）を発生させるため、
    // アサーション機構自体が壊れたことに気づける。
    // @ts-expect-error "a" | "b" と "a" | "c" は集合として一致しないため AssertTrue<false> は型エラーになるはず
    type MismatchedUnionsShouldFail = AssertTrue<IsExactStringUnion<"a" | "b", "a" | "c">>;
    // 型だけのテストであることを明示するため、到達しないダミーの型注釈で参照しておく
    // （unused-vars 対策。実行時には値を持たない）。
    const _unused: MismatchedUnionsShouldFail | undefined = undefined;
    expect(_unused).toBeUndefined();
  });
});

/**
 * F3 の実測証跡（レビュー指摘: 架空unionのnegative type testだけでは実際の軸追加を再現していない）。
 *
 * 実際に SESSION_BUDGET_AXES / SESSION_BUDGET_AXIS_DIRECTIONS / DEFAULT_SESSION_BUDGET_THRESHOLDS
 * へ架空の軸 "bogusAxisForMutationTest" を一時的に追加し（types.ts は変更しない）、
 * `pnpm --filter @hachi/core run typecheck` を実行して失敗することを確認した
 * （検証後、追加は完全に取り消し済み。このコメントは検証記録のみ）。
 *
 * 実測結果:
 * - 変異前: typecheck 成功（`tsc --noEmit` がエラー無しで終了）。
 * - 変異後: typecheck が exit code 2 で失敗。実際に出力された主要なエラー行:
 *   `src/orchestrator-session-budget.ts(71,59): error TS2344: Type 'false' does not satisfy the
 *   constraint 'true'.`
 *   （71行目は `export type SessionBudgetAxesMatchConfigKeys = AssertTrue<IsExactStringUnion<...>>;`。
 *   SessionBudgetAxis に "bogusAxisForMutationTest" が増えたのに types.ts の
 *   OrchestratorSessionBudgetConfig 側は変わらず、集合が不一致になったため
 *   IsExactStringUnion が false に解決し、AssertTrue<false> が制約 true を満たせず型エラーになった。
 *   これが F3 の防御機構そのものの失敗）。
 *   加えて、SessionBudgetMetrics に bogusAxisForMutationTest が必須プロパティとして増えたことで、
 *   orchestrator-session-budget.test.ts 内の `only(...)` 等の既存オブジェクトリテラル十数箇所も
 *   `error TS2741` / `error TS2345`（Property 'bogusAxisForMutationTest' is missing）で連鎖的に
 *   失敗した（これは F3 の防御機構本体ではなく、型の伝播による副次的な失敗）。
 * - 復元後: typecheck 再び成功（`git diff packages/core/src/orchestrator-session-budget.ts` から
 *   bogusAxisForMutationTest 関連の差分が無いことも確認済み）。
 */
