// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricsResponse } from "../../shared/api-types.js";
import { MetricsView } from "./MetricsView.js";

const useMetricsMock = vi.fn();

vi.mock("../hooks/use-metrics.js", () => ({
  useMetrics: (): unknown => useMetricsMock(),
}));

function fixture(): MetricsResponse {
  return {
    period: { from: 1, to: 2 },
    throughput: [],
    runSuccess: { total: 0, succeeded: 0, failed: 0, rate: 0 },
    rework: { totalDone: 0, reworked: 0, rate: 0 },
    humanQueueDwell: [],
    profileProviderStats: [],
    tickMetrics: [],
    doneOrigins: {
      total: 5,
      counts: { gatePassed: 2, orchestratorHostFinalize: 1, humanDecision: 1, unknown: 1 },
      automaticCompletionRate: 0.4,
      manualRecoveryRate: 0.4,
      unknownRate: 0.2,
    },
  };
}

describe("MetricsView done origin", () => {
  beforeEach(() => {
    useMetricsMock.mockReturnValue({
      data: fixture(),
      loading: false,
      error: null,
      days: 30,
      setDays: vi.fn(),
    });
  });

  it("gate自動完走率・manual recovery率・unknownを独立表示する", () => {
    render(<MetricsView />);
    expect(screen.getByText("Gate 自動完走率")).toBeTruthy();
    expect(screen.getByText("Manual recovery率")).toBeTruthy();
    expect(screen.getByText("Done origin unknown")).toBeTruthy();
    expect(screen.getAllByText("40.0%")).toHaveLength(2);
    expect(screen.getByText("20.0%")).toBeTruthy();
    expect(screen.getByText("orchestrator 1 / human 1")).toBeTruthy();
  });
});
