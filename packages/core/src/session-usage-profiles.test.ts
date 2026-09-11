import { describe, expect, it } from "vitest";
import {
  computeSessionBootSample,
  computeSessionUsageProfiles,
  SESSION_USAGE_PROFILE_REF,
  type SessionTurnSeries,
  type SessionUsageResolvedPrice,
  type UsageProfileSessionRow,
} from "./session-usage-profiles.js";
import type { MainSessionTurn } from "./usage.js";

function session(overrides: Partial<UsageProfileSessionRow> = {}): UsageProfileSessionRow {
  return {
    id: "os_old",
    orchestratorId: "o_test",
    generation: 1,
    provider: "claude",
    providerSessionId: "provider-old",
    providerSessionSource: "manual",
    status: "closed",
    heartbeatAt: 100,
    handoffTokenHash: "",
    handoffExpiresAt: null,
    createdAt: 100,
    updatedAt: 110,
    ...overrides,
  };
}

function turn(overrides: Partial<MainSessionTurn> = {}): MainSessionTurn {
  return {
    provider: "claude",
    model: "claude-opus-5",
    effort: "high",
    contextTokens: 100,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 30,
    cacheReadTokens: 40,
    cacheCreation1hTokens: 10,
    reasoningOutputTokens: 5,
    timestampMs: 1_000,
    ...overrides,
  };
}

describe("computeSessionUsageProfiles", () => {
  it("minTurns 境界で measured を切り替え、三つ組ごとの平均を返す", () => {
    const sources: SessionTurnSeries[] = [
      {
        session: session(),
        turnSeries: Array.from({ length: 29 }, () => turn({ effort: null })),
      },
      {
        session: session({ id: "os_new", providerSessionId: "provider-new", createdAt: 200, updatedAt: 210 }),
        turnSeries: Array.from({ length: 30 }, () => turn({ model: "claude-sonnet-5" })),
      },
    ];

    const profiles = computeSessionUsageProfiles(sources);

    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toMatchObject({
      model: "claude-opus-5",
      effort: null,
      turns: 29,
      measured: false,
      cacheReadPerTurn: 40,
      cacheWrite5mPerTurn: 20,
      cacheWrite1hPerTurn: 10,
      outputPerTurn: 20,
      reasoningPerTurn: 5,
      sourceSessionIds: ["provider-old"],
      computedFromRef: SESSION_USAGE_PROFILE_REF,
    });
    expect(profiles[1]).toMatchObject({
      model: "claude-sonnet-5",
      turns: 30,
      measured: true,
      sourceSessionIds: ["provider-new"],
    });
  });

  it("context growth は同一 session の連続 turn だけを使い、compaction の負差分を除外する", () => {
    const profiles = computeSessionUsageProfiles([
      {
        session: session(),
        turnSeries: [100, 150, 20, 50].map((contextTokens) => turn({ contextTokens })),
      },
      {
        session: session({ id: "os_new", providerSessionId: "provider-new", createdAt: 200, updatedAt: 210 }),
        turnSeries: [turn({ contextTokens: 10 })],
      },
    ], { minTurns: 1 });

    expect(profiles[0]?.contextGrowthPerTurn).toBe(40);
    expect(profiles[0]?.sourceSessionIds).toEqual(["provider-new", "provider-old"]);
  });
});

describe("computeSessionBootSample", () => {
  it("15 turn 目と cache read 0 の turn2 だけを標本化し、条件外は null にする", () => {
    const turns = Array.from({ length: 15 }, (_, index) => turn({
      contextTokens: 1_000 + index,
      cacheCreationTokens: index === 1 ? 40_000 : 0,
      cacheCreation1hTokens: index === 1 ? 40_000 : 0,
      cacheReadTokens: 0,
    }));
    const resolvePrice = (): SessionUsageResolvedPrice => ({
      price: {
        inputCostPerToken: 5e-6,
        outputCostPerToken: 25e-6,
        cacheCreationCostPerToken: 6.25e-6,
        cacheCreation1hCostPerToken: 10e-6,
        cacheReadCostPerToken: 0.5e-6,
      },
      priceSource: "table" as const,
    });

    expect(computeSessionBootSample(session(), turns, resolvePrice)).toMatchObject({
      model: "claude-opus-5",
      contextAtTurn15: 1_014,
      bootOverheadUsd: 0.38,
      provenance: `${SESSION_USAGE_PROFILE_REF};priceSource=table;writePrice=cacheCreation1h`,
    });
    expect(computeSessionBootSample(session(), turns.slice(0, 14), resolvePrice).contextAtTurn15).toBeNull();
    expect(computeSessionBootSample(
      session(),
      turns.map((entry, index) => index === 1 ? { ...entry, cacheReadTokens: 1 } : entry),
      resolvePrice,
    ).bootOverheadUsd).toBeNull();
    expect(computeSessionBootSample(session(), turns, () => null).bootOverheadUsd).toBeNull();
  });
});
