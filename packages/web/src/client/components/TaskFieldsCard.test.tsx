// =============================================================================
// TaskFieldsCard の長い未改行値の折返し仕様を固定するテスト。
// =============================================================================

// @vitest-environment jsdom

import type { TaskRow } from "@hachi/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { TaskFieldsCard } from "./TaskFieldsCard.js";

interface RenderedTaskFieldsCard {
  container: HTMLDivElement;
  root: Root;
}

function fixtureTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t_fields",
    title: "詳細テスト",
    body: "本文",
    status: "ready",
    priority: 7,
    tenant: "dev",
    assignee: "",
    provider: "codex",
    profile: "implement",
    modelOverride: "",
    effortOverride: "",
    speedOverride: "",
    reviewProfileOverride: "",
    reviewProviderOverride: "",
    reviewModelOverride: "",
    reviewEffortOverride: "",
    reviewSpeedOverride: "",
    blockReason: "",
    claimLock: "",
    watched: false,
    consecutiveFailures: 0,
    lastFailureError: "",
    lastHeartbeatAt: null,
    maxRetries: 2,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function requiredElement<T extends Element>(root: ParentNode, selector: string, ctor: { new (): T }): T {
  const element = root.querySelector(selector);
  if (!(element instanceof ctor)) {
    throw new Error(`element not found: ${selector}`);
  }
  return element;
}

function requiredRowByLabel(root: ParentNode, label: string): HTMLTableRowElement {
  const rows = Array.from(root.querySelectorAll("tr"));
  const row = rows.find((candidate) => candidate.querySelector("th")?.textContent === label);
  if (!(row instanceof HTMLTableRowElement)) {
    throw new Error(`row not found: ${label}`);
  }
  return row;
}

async function renderTaskFieldsCard(task: TaskRow): Promise<RenderedTaskFieldsCard> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<TaskFieldsCard task={task} />);
    await Promise.resolve();
  });
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TaskFieldsCard", () => {
  it("Codex 5.6 の model_override をタスク情報へそのまま表示する", async () => {
    const rendered = await renderTaskFieldsCard(fixtureTask({ modelOverride: "gpt-5.6-sol" }));

    expect(requiredRowByLabel(rendered.container, "model_override").textContent).toContain("gpt-5.6-sol");

    await act(async () => {
      rendered.root.unmount();
    });
  });

  it("worker と reviewer の requested override を分けて表示する", async () => {
    const rendered = await renderTaskFieldsCard(
      fixtureTask({
        speedOverride: "fast",
        reviewProfileOverride: "strict-review",
        reviewProviderOverride: "claude",
        reviewModelOverride: "claude-opus-5",
        reviewEffortOverride: "max",
        reviewSpeedOverride: "standard",
      }),
    );

    expect(requiredRowByLabel(rendered.container, "speed_override").textContent).toContain("fast");
    expect(requiredRowByLabel(rendered.container, "review_profile_override").textContent).toContain("strict-review");
    expect(requiredRowByLabel(rendered.container, "review_provider_override").textContent).toContain("Claude");
    expect(requiredRowByLabel(rendered.container, "review_model_override").textContent).toContain("claude-opus-5");
    expect(requiredRowByLabel(rendered.container, "review_effort_override").textContent).toContain("max");
    expect(requiredRowByLabel(rendered.container, "review_speed_override").textContent).toContain("standard");

    await act(async () => {
      rendered.root.unmount();
    });
  });

  it("長い未改行 tenant 値を min-w-0 + break-all で折り返せる", async () => {
    const tenant = "tenant-without-natural-breakpoints-".repeat(5);
    const rendered = await renderTaskFieldsCard(fixtureTask({ tenant }));
    const row = requiredRowByLabel(rendered.container, "tenant");
    const valueWrapper = requiredElement(row, "td > div", HTMLDivElement);
    const value = requiredElement(valueWrapper, "span", HTMLSpanElement);

    expect(valueWrapper.className).toContain("min-w-0");
    expect(valueWrapper.className).toContain("break-all");
    expect(value.className).toContain("break-all");
    expect(value.textContent).toBe(tenant);

    await act(async () => {
      rendered.root.unmount();
    });
  });

  it("block_reason の所属レーンバッジを判断待ちと回収待ちで表示し分ける", async () => {
    const decision = await renderTaskFieldsCard(
      fixtureTask({ status: "blocked", blockReason: "user-decision: 承認待ち" }),
    );
    const recovery = await renderTaskFieldsCard(
      fixtureTask({ status: "blocked", blockReason: "review-required: 確認待ち" }),
    );
    const inProgress = await renderTaskFieldsCard(
      fixtureTask({ status: "blocked", blockReason: "codex-in-progress: 実行中" }),
    );

    expect(requiredRowByLabel(decision.container, "block_reason").textContent).toContain("判断待ち");
    expect(requiredRowByLabel(recovery.container, "block_reason").textContent).toContain("回収待ち");
    expect(requiredRowByLabel(inProgress.container, "block_reason").textContent).not.toContain("回収待ち");

    await act(async () => {
      decision.root.unmount();
      recovery.root.unmount();
      inProgress.root.unmount();
    });
  });
});
