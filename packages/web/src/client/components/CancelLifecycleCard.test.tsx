// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { CancelRequestResponse } from "../../shared/api-types.js";
import { CancelLifecycleCard } from "./CancelLifecycleCard.js";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

function request(overrides: Partial<CancelRequestResponse> = {}): CancelRequestResponse {
  return {
    requestId: "cr_0000000000000001",
    runId: 42,
    sessionId: "session-cancel",
    provider: "codex",
    status: "cooperative_sent",
    reason: "安全に停止",
    orchestratorId: "o_owner",
    requesterSessionId: "os_owner",
    requesterGeneration: 3,
    cancelFence: 1,
    deadlineAt: 1_700_000_060,
    delivered: "unknown",
    observed: "unknown",
    acknowledged: "no",
    stopped: "no",
    capabilitySnapshot: "{}",
    stopEvidence: "{}",
    lastError: "",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_010,
    resolvedAt: null,
    ...overrides,
  };
}

interface Rendered {
  container: HTMLDivElement;
  root: Root;
}

async function render(requests: CancelRequestResponse[]): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<CancelLifecycleCard requests={requests} />);
  });
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CancelLifecycleCard", () => {
  it("cooperative_sentをdelivered/observed/acknowledged/stoppedと誤表示しない", async () => {
    const rendered = await render([request()]);
    const text = rendered.container.textContent ?? "";

    expect(text).toContain("cooperative_sent");
    expect(text).toContain("delivered: unknown");
    expect(text).toContain("observed: unknown");
    expect(text).toContain("acknowledged: no");
    expect(text).toContain("stopped: no");
    expect(text).toContain("Telegram は FYI");
    expect(text).toContain("オーケストレーターの inbox");
    expect(rendered.container.querySelector("button")).toBeNull();

    await act(async () => rendered.root.unmount());
  });

  it("exact ackとstop evidenceがある場合だけ肯定表示する", async () => {
    const rendered = await render([
      request({
        status: "stopped",
        delivered: "yes",
        observed: "yes",
        acknowledged: "yes",
        stopped: "yes",
        capabilitySnapshot: '{"protocol":"session-stop-v1","exactSession":true}',
        stopEvidence: '{"sessionState":"ended","evidenceId":"stop-42"}',
        resolvedAt: 1_700_000_090,
      }),
    ]);
    const text = rendered.container.textContent ?? "";
    expect(text).toContain("delivered: yes");
    expect(text).toContain("observed: yes");
    expect(text).toContain("acknowledged: yes");
    expect(text).toContain("stopped: yes");
    expect(text).toContain("session-stop-v1");
    expect(text).toContain("stop-42");
    await act(async () => rendered.root.unmount());
  });

  it("長いsession/evidenceをbreak-allし402px幅で横溢れしにくい構造にする", async () => {
    const rendered = await render([
      request({
        sessionId: "session".repeat(80),
        stopEvidence: JSON.stringify({ evidenceId: "evidence".repeat(80) }),
      }),
    ]);
    expect(rendered.container.querySelectorAll(".break-all").length).toBeGreaterThan(0);
    expect(rendered.container.innerHTML).toContain("min-w-0");
    await act(async () => rendered.root.unmount());
  });

  it("APIのcancelFence降順を反転せず表示する", async () => {
    const rendered = await render([
      request({ requestId: "rc_fence_3", cancelFence: 3 }),
      request({ requestId: "rc_fence_2", cancelFence: 2 }),
      request({ requestId: "rc_fence_1", cancelFence: 1 }),
    ]);
    const text = rendered.container.textContent ?? "";
    expect(text.indexOf("rc_fence_3")).toBeLessThan(text.indexOf("rc_fence_2"));
    expect(text.indexOf("rc_fence_2")).toBeLessThan(text.indexOf("rc_fence_1"));
    await act(async () => rendered.root.unmount());
  });
});
