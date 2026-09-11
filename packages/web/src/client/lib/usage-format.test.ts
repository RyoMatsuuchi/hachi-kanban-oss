// =============================================================================
// usage 表示整形のテスト（契約 §14.5.1）。
// 「未取得を 0 と見せない」「state を表示から消さない」を固定する。
// =============================================================================

import { describe, expect, it } from "vitest";
import type { MetricValue } from "@hachi/core";
import { formatExcluded, formatMetricValue, formatUsageTokens, formatUsageUsd } from "./usage-format.js";
import type { UsageMetricAggregate } from "../../shared/api-types.js";

function aggregate(overrides: Partial<UsageMetricAggregate> = {}): UsageMetricAggregate {
  return {
    measured: { total: 0, runCount: 0, provenances: [] },
    estimated: { total: 0, runCount: 0, priceTableRefs: [] },
    excluded: { notProvided: 0, unavailableByDesign: 0, unknown: 0, legacyUnverified: 0, total: 0 },
    ...overrides,
  };
}

describe("formatUsageUsd / formatUsageTokens", () => {
  it("寄与 run が 0 件なら 0 ではなく - を返す", () => {
    expect(formatUsageUsd({ total: 0, runCount: 0, provenances: [] })).toBe("-");
    expect(formatUsageTokens({ total: 0, runCount: 0, provenances: [] })).toBe("-");
  });

  it("実測ゼロ（run が存在する 0）は 0 として表示する", () => {
    expect(formatUsageUsd({ total: 0, runCount: 2, provenances: ["cli-native-session-log"] })).toBe("$0.0000");
    expect(formatUsageTokens({ total: 0, runCount: 2, provenances: ["cli-native-session-log"] })).toBe("0");
  });

  it("トークンは桁区切りで表示する", () => {
    expect(formatUsageTokens({ total: 1_234_567, runCount: 1, provenances: [] })).toBe("1,234,567");
  });
});

describe("formatExcluded", () => {
  it("除外 0 件は 0 と表示する", () => {
    expect(formatExcluded(aggregate())).toBe("0");
  });

  it("state ごとの内訳を日本語で並べる", () => {
    expect(
      formatExcluded(
        aggregate({
          excluded: { notProvided: 1, unavailableByDesign: 2, unknown: 3, legacyUnverified: 4, total: 10 },
        }),
      ),
    ).toBe("10 (価格表外 2 / 未提供 1 / 不明 3 / 旧形式 4)");
  });
});

describe("formatMetricValue", () => {
  const cases: Array<[string, MetricValue, string, string | null]> = [
    ["measured", { state: "measured", value: 12, provenance: "cli-native-session-log" }, "12", null],
    [
      "estimated",
      { state: "estimated", value: 1.5, basis: "price-table", priceTableRef: "litellm@2026-08-01" },
      "1.5",
      "推定",
    ],
    ["not-provided", { state: "not-provided" }, "-", "未提供"],
    ["unavailable-by-design", { state: "unavailable-by-design" }, "N/A", "対象外"],
    ["unknown", { state: "unknown" }, "-", "不明"],
    ["legacy-unverified", { state: "legacy-unverified", value: 0 }, "0", "旧形式・未検証"],
  ];

  for (const [name, metric, text, note] of cases) {
    it(`${name} を state が読める表記に落とす`, () => {
      const formatted = formatMetricValue(metric);
      expect(formatted.text).toBe(text);
      expect(formatted.note).toBe(note);
    });
  }

  it("usd 指定では通貨表記にする", () => {
    expect(formatMetricValue({ state: "estimated", value: 10.46, basis: "price-table", priceTableRef: "r" }, "usd").text)
      .toBe("$10.4600");
  });

  it("旧形式の 0 は実測 0 と別トーンで返す（同じ 0 でも意味が違う）", () => {
    const legacy = formatMetricValue({ state: "legacy-unverified", value: 0 });
    const real = formatMetricValue({ state: "measured", value: 0, provenance: "cli-native-session-log" });
    expect(legacy.text).toBe(real.text);
    expect(legacy.tone).not.toBe(real.tone);
    expect(legacy.note).not.toBeNull();
    expect(real.note).toBeNull();
  });
});
