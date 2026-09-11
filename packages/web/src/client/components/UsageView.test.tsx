// =============================================================================
// usage 画面のテスト（契約 §14.5.1）。
// 「推定と実測を別列にする」「除外件数を出す」「未取得を 0 と見せない」を固定する。
// =============================================================================

// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  UsageMetricAggregate,
  UsageReportRowResponse,
  UsageResponse,
} from "../../shared/api-types.js";
import { UsageView } from "./UsageView.js";

const useUsageMock = vi.fn();

vi.mock("../hooks/use-usage.js", () => ({
  useUsage: (): unknown => useUsageMock(),
}));

interface AggregateFixture {
  measured?: number;
  measuredRuns?: number;
  estimated?: number;
  estimatedRuns?: number;
  excluded?: Partial<UsageMetricAggregate["excluded"]>;
}

function agg(fixture: AggregateFixture = {}): UsageMetricAggregate {
  const excluded = {
    notProvided: 0,
    unavailableByDesign: 0,
    unknown: 0,
    legacyUnverified: 0,
    ...fixture.excluded,
  };
  return {
    measured: {
      total: fixture.measured ?? 0,
      runCount: fixture.measuredRuns ?? (fixture.measured === undefined ? 0 : 1),
      provenances: fixture.measured === undefined ? [] : ["cli-native-session-log"],
    },
    estimated: {
      total: fixture.estimated ?? 0,
      runCount: fixture.estimatedRuns ?? (fixture.estimated === undefined ? 0 : 1),
      priceTableRefs: fixture.estimated === undefined ? [] : ["litellm@2026-08-01"],
    },
    excluded: {
      ...excluded,
      total:
        excluded.notProvided + excluded.unavailableByDesign + excluded.unknown + excluded.legacyUnverified,
    },
  };
}

function row(overrides: Partial<UsageReportRowResponse> = {}): UsageReportRowResponse {
  return {
    key: "claude-opus-5",
    label: "claude-opus-5",
    runCount: 3,
    costUsd: agg({ estimated: 10.4612, estimatedRuns: 3 }),
    inputTokens: agg({ measured: 1_234_567, measuredRuns: 3 }),
    outputTokens: agg({ measured: 45_678, measuredRuns: 3 }),
    cacheCreationTokens: agg({ measured: 234_567, measuredRuns: 3 }),
    cacheReadTokens: agg({ measured: 1_000_000, measuredRuns: 3 }),
    turns: agg({ measured: 42, measuredRuns: 3 }),
    durationMs: agg({ measured: 1000, measuredRuns: 3 }),
    models: ["claude-opus-5"],
    unpricedModels: [],
    ...overrides,
  };
}

function fixture(overrides: Partial<UsageResponse> = {}): UsageResponse {
  const rows = overrides.rows ?? [row()];
  return {
    period: { from: 1, to: 2 },
    groupBy: "model",
    rows,
    total: overrides.total ?? row({ key: "(total)", label: "(total)" }),
    coverage: {
      totalRuns: 6,
      aggregatedRuns: 5,
      withUsageRuns: 3,
      legacyOnlyRuns: 1,
      noUsageRuns: 1,
      duplicateRuns: 1,
      runningRuns: 1,
    },
    priceTableRefs: ["litellm@2026-08-01"],
    priceTableMixed: false,
    ...overrides,
  };
}

function mountWith(data: UsageResponse): void {
  useUsageMock.mockReturnValue({
    data,
    loading: false,
    error: null,
    days: 30,
    setDays: vi.fn(),
    groupBy: data.groupBy,
    setGroupBy: vi.fn(),
  });
  render(<UsageView />);
}

describe("UsageView", () => {
  // vitest の globals が無効なため RTL の自動 cleanup が登録されない。明示的に片付ける。
  afterEach(() => {
    cleanup();
  });

  it("推定コストと実測コストを別列で出し、合算値を出さない", () => {
    mountWith(fixture());

    const table = screen.getByTestId("usage-cost-table");
    expect(within(table).getByText("推定コスト")).toBeTruthy();
    expect(within(table).getByText("実測コスト")).toBeTruthy();
    // 推定 10.4612 は出るが、実測列は 0 ではなく "-"
    expect(within(table).getAllByText("$10.4612").length).toBeGreaterThan(0);
    expect(within(table).queryByText("$0.0000")).toBeNull();
    expect(within(table).getAllByText("-").length).toBeGreaterThan(0);
  });

  it("実測 cost を持つ run が無いことを KPI で明示する", () => {
    mountWith(fixture());
    expect(screen.getByText("実測 cost を持つ run なし")).toBeTruthy();
  });

  it("除外された run の件数を内訳付きで表示する", () => {
    mountWith(
      fixture({
        rows: [
          row({
            costUsd: agg({
              estimated: 3,
              estimatedRuns: 1,
              excluded: { unavailableByDesign: 2, legacyUnverified: 1 },
            }),
          }),
        ],
      }),
    );

    const table = screen.getByTestId("usage-cost-table");
    expect(within(table).getAllByText("3 (価格表外 2 / 旧形式 1)").length).toBeGreaterThan(0);
  });

  it("カバレッジ（未終端・重複除外・旧形式のみ）を表示する", () => {
    mountWith(fixture());

    expect(screen.getByText("期間内 run")).toBeTruthy();
    expect(screen.getByText("未終端（対象外）")).toBeTruthy();
    expect(screen.getByText("重複除外")).toBeTruthy();
    expect(screen.getByText("旧 lastResult のみ")).toBeTruthy();
  });

  it("価格表に無いモデルを名指しする（cost 欠測の理由が読めるようにする）", () => {
    mountWith(
      fixture({
        total: row({
          key: "(total)",
          label: "(total)",
          costUsd: agg({ excluded: { unavailableByDesign: 1 } }),
          unpricedModels: ["claude-haiku-4-5-20251001"],
        }),
      }),
    );

    expect(screen.getByTestId("usage-unpriced-models").textContent).toContain("claude-haiku-4-5-20251001");
  });

  it("行のコストが他モデル（subagent/advisor）分を含むことを明記する", () => {
    mountWith(fixture());
    expect(screen.getByTestId("usage-models").textContent).toContain("claude-opus-5");
    expect(screen.getByTestId("usage-models").textContent).toContain("subagent / advisor");
  });

  it("価格表の版が混在すると警告する", () => {
    mountWith(fixture({ priceTableRefs: ["litellm@2026-08-01", "litellm@2026-09-01"], priceTableMixed: true }));
    expect(screen.getByText(/複数版の価格表が混在しています/)).toBeTruthy();
  });

  it("再計算しないことを明記する", () => {
    mountWith(fixture());
    expect(screen.getByText(/価格表を引き直した再計算は行いません/)).toBeTruthy();
  });

  it("集計軸と期間の切替を提供する", () => {
    mountWith(fixture());
    const axis = screen.getByTestId("usage-axis-selector");
    for (const label of ["task", "tenant", "model", "effort", "provider", "role"]) {
      expect(within(axis).getByText(label)).toBeTruthy();
    }
    expect(within(screen.getByTestId("usage-period-selector")).getByText("30日")).toBeTruthy();
  });

  it("集計対象が無ければその旨を出す", () => {
    mountWith(fixture({ rows: [] }));
    expect(screen.getAllByText("集計対象の run はありません").length).toBe(2);
  });
});
