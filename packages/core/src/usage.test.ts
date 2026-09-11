// buildRunUsage の state 決定を固定する。
// ここが崩れると「取れなかった 0」が「実測 0」として集計へ混入する（今回の根因の再発）。
import { describe, expect, it } from "vitest";
import {
  buildRunUsage,
  estimatedValue,
  executionKey,
  measuredValue,
  parseEffortLevel,
  type NativeUsageObservation,
} from "./usage.js";
import { PRICE_TABLE_REF } from "./usage-pricing.js";
import type { MetricValue } from "./types.js";

const OPTIONS = { collectedBy: "test@v1", provenance: "cli-native-session-log" as const };

describe("turn 単位 usage の識別子", () => {
  it("executionKey は provider/model/effort の三つ組を固定し、未観測 effort を unset にする", () => {
    expect(executionKey({ provider: "claude", model: "claude-opus-5", effort: "xhigh" })).toBe(
      "claude/claude-opus-5/xhigh",
    );
    expect(executionKey({ provider: "codex", model: "gpt-5.6-sol", effort: null })).toBe(
      "codex/gpt-5.6-sol/unset",
    );
  });

  it("parseEffortLevel は5値の完全一致だけを受理する", () => {
    expect(["low", "medium", "high", "xhigh", "max"].map(parseEffortLevel)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(parseEffortLevel("HIGH")).toBeNull();
    expect(parseEffortLevel("ultra")).toBeNull();
    expect(parseEffortLevel(undefined)).toBeNull();
  });
});

describe("buildRunUsage", () => {
  it("観測できたトークンは4系統すべてが measured になる（cache read を落とさない）", () => {
    const observation: NativeUsageObservation = {
      observed: true,
      perModel: [
        {
          model: "claude-sonnet-5",
          inputTokens: 2,
          outputTokens: 7588,
          cacheCreationTokens: 1895,
          cacheReadTokens: 144970,
        },
      ],
      turns: 3,
      durationMs: 12_000,
    };

    const usage = buildRunUsage(observation, OPTIONS);

    expect(usage.inputTokens).toEqual({ state: "measured", value: 2, provenance: "cli-native-session-log" });
    expect(usage.outputTokens).toEqual({ state: "measured", value: 7588, provenance: "cli-native-session-log" });
    expect(usage.cacheCreationTokens).toEqual({
      state: "measured",
      value: 1895,
      provenance: "cli-native-session-log",
    });
    expect(usage.cacheReadTokens).toEqual({
      state: "measured",
      value: 144970,
      provenance: "cli-native-session-log",
    });
    expect(usage.turns).toEqual({ state: "measured", value: 3, provenance: "cli-native-session-log" });
    expect(usage.collectedBy).toBe("test@v1");
    expect(usage.models).toEqual(["claude-sonnet-5"]);
  });

  it("複数モデル（サブエージェント）のトークンをモデル横断で合算する", () => {
    const usage = buildRunUsage(
      {
        observed: true,
        perModel: [
          { model: "claude-opus-5", inputTokens: 10, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 40 },
          { model: "claude-sonnet-5", inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 },
        ],
        turns: 5,
        durationMs: null,
      },
      OPTIONS,
    );

    expect(measuredValue(usage.inputTokens)).toBe(11);
    expect(measuredValue(usage.cacheReadTokens)).toBe(44);
    expect(usage.models).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    // duration が取れないケースは 0 ではなく unknown。
    expect(usage.durationMs).toEqual({ state: "unknown" });
  });

  it("cost は estimated で、measured としては読み出せない（合算禁止の型上の担保）", () => {
    const usage = buildRunUsage(
      {
        observed: true,
        perModel: [
          { model: "gpt-5.6-sol", inputTokens: 1000, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 500 },
        ],
        turns: 1,
        durationMs: 1,
      },
      { collectedBy: "direct-codex@native-log-v1", provenance: "cli-native-session-log" },
    );

    expect(usage.costUsd.state).toBe("estimated");
    // 既定集計（measured のみ）は推定値を拾わない。
    expect(measuredValue(usage.costUsd)).toBeNull();
    expect(estimatedValue(usage.costUsd)).toBeGreaterThan(0);
    if (usage.costUsd.state !== "estimated") {
      throw new Error("estimated であること");
    }
    expect(usage.costUsd.basis).toBe("price-table");
    expect(usage.costUsd.priceTableRef).toBe(PRICE_TABLE_REF);
  });

  it("価格表に無いモデルは unavailable-by-design になり、0 も部分合計も入らない", () => {
    const usage = buildRunUsage(
      {
        observed: true,
        perModel: [
          { model: "gpt-5.6-sol", inputTokens: 1000, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 },
          { model: "future-model-x", inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
        ],
        turns: 2,
        durationMs: 1,
      },
      OPTIONS,
    );

    expect(usage.costUsd).toEqual({ state: "unavailable-by-design" });
    expect(usage.unpricedModels).toEqual(["future-model-x"]);
    // トークン自体は取れているので measured のまま。
    expect(measuredValue(usage.inputTokens)).toBe(1001);
  });

  it.each([
    ["log-not-found", "unknown"],
    ["session-id-unknown", "unknown"],
    ["log-unreadable", "unknown"],
    ["log-not-persisted", "not-provided"],
    ["no-usage-records", "not-provided"],
  ] as const)("観測不能 %s は全 metric が %s になり 0 を書かない", (reason, expected) => {
    const usage = buildRunUsage({ observed: false, reason }, OPTIONS);
    const metrics: MetricValue[] = [
      usage.costUsd,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheCreationTokens,
      usage.cacheReadTokens,
      usage.turns,
      usage.durationMs,
    ];
    for (const metric of metrics) {
      expect(metric.state).toBe(expected);
      expect("value" in metric).toBe(false);
    }
  });

  it("失敗 run（ログ不在）のゼロは measured にならない", () => {
    const usage = buildRunUsage({ observed: false, reason: "log-not-found" }, OPTIONS);
    expect(usage.inputTokens).toEqual({ state: "unknown" });
    expect(measuredValue(usage.inputTokens)).toBeNull();
    expect(measuredValue(usage.costUsd)).toBeNull();
  });

  it("実測 0 は measured 0 として残る（観測できた 0 と取れなかった 0 を区別する）", () => {
    const usage = buildRunUsage(
      {
        observed: true,
        perModel: [
          { model: "claude-sonnet-5", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        ],
        turns: 1,
        durationMs: 0,
      },
      OPTIONS,
    );
    expect(usage.inputTokens).toEqual({ state: "measured", value: 0, provenance: "cli-native-session-log" });
    expect(measuredValue(usage.costUsd)).toBeNull();
    expect(estimatedValue(usage.costUsd)).toBe(0);
  });
});
