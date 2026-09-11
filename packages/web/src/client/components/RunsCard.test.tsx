// =============================================================================
// RunsCard.tsx の工程バッジ表示テスト（docs/contract.md §28.5）。
// =============================================================================

// @vitest-environment jsdom

import type { RunRow } from "@hachi/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunsCard } from "./RunsCard.js";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

interface RenderedRunsCard {
  container: HTMLDivElement;
  root: Root;
}

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: 1,
    taskId: "t_0000000000000001",
    provider: "codex",
    sessionId: "sess-1",
    status: "running",
    meta: "{}",
    startedAt: 1_700_000_000,
    endedAt: null,
    ...overrides,
  };
}

async function renderRunsCard(runs: RunRow[]): Promise<RenderedRunsCard> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<RunsCard runs={runs} />);
    await Promise.resolve();
  });
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("RunsCard", () => {
  it("meta.role から工程バッジを表示し、未指定は実装として扱う", async () => {
    const rendered = await renderRunsCard([
      makeRun({ id: 1, sessionId: "sess-worker" }),
      makeRun({
        id: 2,
        sessionId: "sess-reviewer",
        meta: JSON.stringify({ role: "reviewer", transport: "bridge" }),
      }),
    ]);

    const text = rendered.container.textContent ?? "";
    expect(text).toContain("実装");
    expect(text).toContain("レビュー");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("meta.verify がある場合は verify 結果を小さく表示する", async () => {
    const rendered = await renderRunsCard([
      makeRun({
        id: 1,
        meta: JSON.stringify({ verify: { status: "passed", exitCode: 0 } }),
      }),
      makeRun({
        id: 2,
        sessionId: "sess-failed",
        status: "failed",
        meta: JSON.stringify({ verify: { status: "failed", exitCode: 1 } }),
      }),
      makeRun({
        id: 3,
        sessionId: "sess-skipped",
        meta: JSON.stringify({ verify: { skipped: "no-command" } }),
      }),
    ]);

    const text = rendered.container.textContent ?? "";
    expect(text).toContain("verify: 成功 exit 0");
    expect(text).toContain("verify: 失敗 exit 1");
    expect(text).toContain("verify: skipped");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("要求速度と配送結果を分け、実効速度とは表示しない", async () => {
    const rendered = await renderRunsCard([
      makeRun({
        meta: JSON.stringify({
          model: "gpt-5.6-sol",
          modelDelivery: "native",
          speed: "fast",
          speedDelivery: "native",
          transport: "direct",
        }),
      }),
    ]);

    const text = rendered.container.textContent ?? "";
    expect(text).toContain("requested speed: fast");
    expect(text).toContain("speed delivery: native");
    expect(text).not.toContain("effective speed");

    const delivery = Array.from(rendered.container.querySelectorAll("span")).find((element) =>
      element.textContent?.includes("speed delivery: native"),
    );
    expect(delivery?.getAttribute("title")).toBe("speed delivery (not effective speed): native");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("meta.usage を state 付きで表示し、旧 lastResult と別列に置く（契約 §14.5.1）", async () => {
    const measured = (value: number): unknown => ({
      state: "measured",
      value,
      provenance: "cli-native-session-log",
    });
    const rendered = await renderRunsCard([
      makeRun({
        id: 1,
        status: "done",
        meta: JSON.stringify({
          usage: {
            costUsd: { state: "estimated", value: 10.46, basis: "price-table", priceTableRef: "litellm@2026-08-01" },
            inputTokens: measured(1234),
            outputTokens: measured(56),
            cacheCreationTokens: measured(78),
            cacheReadTokens: measured(144970),
            turns: measured(3),
            durationMs: measured(1000),
            collectedBy: "direct-claude@native-log-v1",
          },
          lastResult: { costUsd: 0, inputTokens: 2 },
        }),
      }),
    ]);

    const text = rendered.container.textContent ?? "";
    expect(text).toContain("usage（正本）");
    expect(text).toContain("lastResult（旧形式・参考）");
    // 推定であることを表示に残す
    expect(text).toContain("$10.4600");
    expect(text).toContain("(推定)");
    // cache read が表示される（旧経路が落としていた系統）
    expect(text).toContain("144,970");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("usage が無い run は 0 ではなく「未記録」と表示する", async () => {
    const rendered = await renderRunsCard([
      makeRun({ id: 1, status: "done", meta: JSON.stringify({ lastResult: { costUsd: 0 } }) }),
    ]);

    expect(rendered.container.textContent ?? "").toContain("usage 未記録");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("価格表に無いモデルを run 行に名指しする", async () => {
    const measured = (value: number): unknown => ({
      state: "measured",
      value,
      provenance: "cli-native-session-log",
    });
    const rendered = await renderRunsCard([
      makeRun({
        id: 1,
        status: "done",
        meta: JSON.stringify({
          usage: {
            costUsd: { state: "unavailable-by-design" },
            inputTokens: measured(10),
            outputTokens: measured(1),
            cacheCreationTokens: measured(0),
            cacheReadTokens: measured(0),
            turns: measured(1),
            durationMs: measured(10),
            collectedBy: "direct-codex@native-log-v1",
            unpricedModels: ["claude-haiku-4-5-20251001"],
          },
        }),
      }),
    ]);

    const text = rendered.container.textContent ?? "";
    expect(text).toContain("cost: N/A");
    expect(text).toContain("価格表外: claude-haiku-4-5-20251001");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("sessionId がある run は direct/終了済みでもセッション記録導線を表示する", async () => {
    const rendered = await renderRunsCard([
      makeRun({
        id: 1,
        sessionId: "direct-ended-session",
        status: "done",
        meta: JSON.stringify({ transport: "direct" }),
      }),
    ]);

    const text = rendered.container.textContent ?? "";
    expect(text).toContain("セッション記録を見る");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });
});
