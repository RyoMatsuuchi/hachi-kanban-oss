// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SteerDeliveryReadModel } from "@hachi/core";
import { SteerLifecycleCard } from "./SteerLifecycleCard.js";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

function delivery(overrides: Partial<SteerDeliveryReadModel> = {}): SteerDeliveryReadModel {
  return {
    id: "sd_0000000000000001",
    taskId: "t_0000000000000001",
    runId: 42,
    sessionId: "session-steer",
    messageKey: "steer-key",
    sequence: 1,
    status: "transport_accepted",
    supersedesId: null,
    expectedCancelFence: 0,
    observedMessageId: "",
    lastError: "",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_010,
    observedAt: null,
    acknowledgedAt: null,
    resolvedAt: null,
    targetState: "current",
    currentRunId: 42,
    currentSessionId: "session-steer",
    runCancelFence: 0,
    ...overrides,
  };
}

interface Rendered {
  container: HTMLDivElement;
  root: Root;
}

async function render(deliveries: SteerDeliveryReadModel[]): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SteerLifecycleCard deliveries={deliveries} />);
  });
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SteerLifecycleCard", () => {
  it("transport_acceptedを観測・acknowledge済みに昇格せずexact statusを表示する", async () => {
    const rendered = await render([delivery()]);
    const text = rendered.container.textContent ?? "";

    expect(text).toContain("transport_accepted");
    expect(text).toContain("current");
    expect(text).toContain("workerによる観測・確認は不明");
    expect(text).not.toContain("applied");
    expect(rendered.container.querySelector("button")).toBeNull();
    await act(async () => rendered.root.unmount());
  });

  it("stale runとcurrent target、fence、全timestamp、redact済みerrorを表示する", async () => {
    const rendered = await render([
      delivery({
        status: "uncertain",
        targetState: "stale_run",
        currentRunId: 43,
        currentSessionId: "session-replacement",
        runCancelFence: 1,
        observedAt: 1_700_000_020,
        acknowledgedAt: 1_700_000_030,
        resolvedAt: 1_700_000_040,
        lastError: "Bearer [REDACTED]",
      }),
    ]);
    const text = rendered.container.textContent ?? "";

    expect(text).toContain("uncertain");
    expect(text).toContain("stale_run");
    expect(text).toContain("43 / session-replacement");
    expect(text).toContain("expected 0 / run 1");
    expect(text).toContain("Bearer [REDACTED]");
    expect(text).toContain("2023-11-15");
    await act(async () => rendered.root.unmount());
  });
});
