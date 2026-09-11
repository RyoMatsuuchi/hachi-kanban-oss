// =============================================================================
// TaskCard の密度仕様（docs/contract.md §37.3）を固定するテスト。
// =============================================================================

// @vitest-environment jsdom

import type { SteerDeliveryReadModel, TaskRow } from "@hachi/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LazyMotion, MotionConfig, domMax } from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskCard, type CardVariant } from "./TaskCard.js";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

interface RenderedTaskCard {
  container: HTMLDivElement;
  root: Root;
}

function fixtureTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t_card",
    title: "長いタイトル長いタイトル長いタイトル長いタイトル",
    body: "cwd: /tmp/project\n本文の1行目\n本文の2行目\n本文の3行目",
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

function fixtureSteer(overrides: Partial<SteerDeliveryReadModel> = {}): SteerDeliveryReadModel {
  return {
    id: "sd_card",
    taskId: "t_card",
    runId: 42,
    sessionId: "session-card",
    messageKey: "steer-card",
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
    currentSessionId: "session-card",
    runCancelFence: 0,
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

async function renderTaskCard(
  task: TaskRow,
  variant: CardVariant = "plain",
  onOpen: (taskId: string) => void = () => undefined,
  onToggleWatch?: (task: TaskRow) => void,
  steerDeliveries: SteerDeliveryReadModel[] = [],
): Promise<RenderedTaskCard> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const watchProps = onToggleWatch === undefined ? {} : { onToggleWatch };
  await act(async () => {
    root.render(
      <LazyMotion features={domMax} strict>
        <MotionConfig reducedMotion="user">
          <TaskCard
            task={task}
            variant={variant}
            onOpen={onOpen}
            steerDeliveries={steerDeliveries}
            {...watchProps}
          />
        </MotionConfig>
      </LazyMotion>,
    );
    await Promise.resolve();
  });
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("TaskCard", () => {
  it("タイトル2行 clamp・メタ行（チップ+テキスト）・本文2行プレビューで表示する", async () => {
    const rendered = await renderTaskCard(fixtureTask());
    const button = requiredElement(rendered.container, "button", HTMLButtonElement);
    const title = requiredElement(button, "div[title]", HTMLDivElement);
    // メタ行は flex レイアウトの div（タイトル div の次の兄弟）
    const meta = button.querySelectorAll(":scope > div").item(1);
    const preview = requiredElement(button, "p", HTMLParagraphElement);

    // ボタン・タイトルの基本クラス
    expect(button.className).toContain("block");
    expect(button.className).toContain("min-w-0");
    expect(title.className).toContain("line-clamp-2");
    expect(title.className).toContain("min-w-0");

    // メタ行: flex wrap レイアウト（行数キャップなし）
    expect(meta).toBeInstanceOf(HTMLDivElement);
    expect(meta?.className).toContain("flex");
    expect(meta?.className).toContain("flex-wrap");
    expect(meta?.className).not.toContain("max-h-[2.625rem]");
    expect(meta?.className).not.toContain("overflow-hidden");
    expect(meta?.className).toContain("min-w-0");

    // メタ行の内容: ID・テナントチップ・優先度バッジ・テキストパーツ
    expect(meta?.textContent).toContain("t_card");
    expect(meta?.textContent).toContain("dev");
    expect(meta?.textContent).toContain("P7");

    // テナントチップ: title 属性で識別
    const tenantChip = meta?.querySelector("span[title^='tenant:']");
    expect(tenantChip).toBeInstanceOf(HTMLSpanElement);
    expect(tenantChip?.textContent).toBe("dev");

    // 優先度バッジ: title 属性で識別
    const priorityBadge = meta?.querySelector("span[title^='優先度']");
    expect(priorityBadge).toBeInstanceOf(HTMLSpanElement);
    expect(priorityBadge?.textContent).toBe("P7");

    // separator は独立要素にせず、末尾テキスト内に含めて孤立を避ける
    const isolatedSeparators = Array.from(meta?.childNodes ?? []).filter((node) => node.textContent?.trim() === "·");
    expect(isolatedSeparators).toHaveLength(0);

    // プレビュー
    expect(preview.className).toContain("line-clamp-2");
    expect(preview.className).toContain("min-w-0");
    expect(preview.textContent).toContain("本文の1行目");
    expect(preview.textContent).not.toContain("cwd:");
  });

  it("human queue では block reason をプレビューに優先する", async () => {
    const rendered = await renderTaskCard(
      fixtureTask({
        status: "blocked",
        blockReason: "user-decision: 確認待ちの詳細",
      }),
      "human-queue",
    );
    const preview = requiredElement(rendered.container, "p", HTMLParagraphElement);
    // メタ行は title 属性に user-decision を含む div
    const meta = requiredElement(rendered.container, "div[title*='user-decision']", HTMLDivElement);

    expect(preview.textContent).toBe("user-decision: 確認待ちの詳細");
    expect(meta.textContent).toContain("user-decision");
  });

  it("優先度バッジの閾値色分け — danger/warning/neutral", async () => {
    // danger: 70+
    const high = await renderTaskCard(fixtureTask({ priority: 80 }));
    const highBadge = requiredElement(high.container, "span[title='優先度 80']", HTMLSpanElement);
    expect(highBadge.className).toContain("bg-danger-soft");
    expect(highBadge.textContent).toBe("P80");

    // warning: 50-69
    const mid = await renderTaskCard(fixtureTask({ priority: 55 }));
    const midBadge = requiredElement(mid.container, "span[title='優先度 55']", HTMLSpanElement);
    expect(midBadge.className).toContain("bg-warn-soft");
    expect(midBadge.textContent).toBe("P55");

    // neutral: 50 未満
    const low = await renderTaskCard(fixtureTask({ priority: 7 }));
    const lowBadge = requiredElement(low.container, "span[title='優先度 7']", HTMLSpanElement);
    expect(lowBadge.className).toContain("bg-surface-muted");
    expect(lowBadge.textContent).toBe("P7");
  });

  it("空テナントは neutral 色の (no tenant) チップで表示する", async () => {
    const rendered = await renderTaskCard(fixtureTask({ tenant: "" }));
    const chip = requiredElement(rendered.container, "span[title='tenant: -']", HTMLSpanElement);
    expect(chip.textContent).toBe("(no tenant)");
    expect(chip.className).toContain("bg-surface-muted");
    expect(chip.className).not.toContain("tenant-chip-hash");
  });

  it("テナントチップはハッシュ安定色クラスを持つ", async () => {
    const rendered = await renderTaskCard(fixtureTask({ tenant: "my-project" }));
    const chip = requiredElement(rendered.container, "span[title='tenant: my-project']", HTMLSpanElement);
    expect(chip.textContent).toBe("my-project");
    expect(chip.className).toContain("tenant-chip-hash");
  });

  it("watched カードはアクセント左ボーダーと塗りスターで表示する", async () => {
    const rendered = await renderTaskCard(fixtureTask({ watched: true }));
    const card = requiredElement(rendered.container, "div[data-watched='true']", HTMLDivElement);
    const toggle = requiredElement(rendered.container, "[data-testid='task-watch-toggle']", HTMLButtonElement);

    expect(card.className).toContain("border-l-4");
    expect(card.className).toContain("border-l-accent");
    expect(card.className).toContain("bg-accent-soft");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.className).toContain("text-accent-strong");
  });

  it("スタークリックはカード open と干渉しない", async () => {
    const onOpen = vi.fn<(taskId: string) => void>();
    const onToggleWatch = vi.fn<(task: TaskRow) => void>();
    const task = fixtureTask({ watched: false });
    const rendered = await renderTaskCard(task, "plain", onOpen, onToggleWatch);
    const toggle = requiredElement(rendered.container, "[data-testid='task-watch-toggle']", HTMLButtonElement);

    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });

    expect(onToggleWatch).toHaveBeenCalledWith(task);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("durable steerのexact statusとstale targetをコンパクト表示し適用済みを推測しない", async () => {
    const rendered = await renderTaskCard(
      fixtureTask(),
      "plain",
      () => undefined,
      undefined,
      [
        fixtureSteer(),
        fixtureSteer({ id: "sd_card_2", sequence: 2 }),
        fixtureSteer({
          id: "sd_card_3",
          sequence: 3,
          status: "superseded",
          targetState: "stale_run",
          currentRunId: 43,
          currentSessionId: "session-replacement",
        }),
      ],
    );
    const summary = requiredElement(
      rendered.container,
      "[data-testid='steer-state-summary']",
      HTMLDivElement,
    );

    expect(summary.getAttribute("aria-label")).toBe("Durable steer 3件");
    expect(summary.textContent).toContain("transport_accepted ×2");
    expect(summary.textContent).toContain("superseded · stale_run");
    expect(summary.textContent).not.toContain("applied");
  });
});
