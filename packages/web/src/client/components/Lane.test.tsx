// =============================================================================
// Lane の密度仕様（docs/contract.md §37.3/37.4）を固定するテスト。
// =============================================================================

// @vitest-environment jsdom

import type { TaskRow } from "@hachi/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LazyMotion, MotionConfig, domMax } from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Lane } from "./Lane.js";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

interface RenderedLane {
  container: HTMLDivElement;
  root: Root;
}

function fixtureTask(): TaskRow {
  return {
    id: "t_lane",
    title: "レーン内タスク",
    body: "本文",
    status: "ready",
    priority: 1,
    tenant: "dev",
    assignee: "",
    provider: "",
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
  };
}

function requiredElement<T extends Element>(root: ParentNode, selector: string, ctor: { new (): T }): T {
  const element = root.querySelector(selector);
  if (!(element instanceof ctor)) {
    throw new Error(`element not found: ${selector}`);
  }
  return element;
}

async function renderLane(tasks: TaskRow[]): Promise<RenderedLane> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LazyMotion features={domMax} strict>
        <MotionConfig reducedMotion="user">
          <Lane
            title="ready"
            tasks={tasks}
            variant="plain"
            onOpenTask={() => undefined}
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

describe("Lane", () => {
  it("空レーンは表示領域を折りたたみつつモーション境界を維持する", async () => {
    const rendered = await renderLane([]);
    const section = requiredElement(rendered.container, "section", HTMLElement);
    const header = requiredElement(section, "header", HTMLElement);
    const scrollArea = requiredElement(section, "[data-slot='scroll-area']", HTMLDivElement);
    const list = requiredElement(section, "ul", HTMLUListElement);

    expect(section.className).toContain("w-[min(85vw,20rem)]");
    expect(section.className).toContain("sm:w-72");
    expect(section.className).toContain("overflow-hidden");
    expect(header.className).toContain("rounded-md");
    expect(header.className).not.toContain("border-b");
    expect(scrollArea.className).toContain("h-0");
    expect(scrollArea.className).toContain("flex-none");
    expect(list.className).toContain("gap-2");
    expect(rendered.container.textContent).toContain("ready");
    expect(rendered.container.textContent).toContain("0");
    expect(rendered.container.textContent).not.toContain("タスクはありません");
  });

  it("タスクがあるレーンはカード間 gap-2 で縦に並べる", async () => {
    const rendered = await renderLane([fixtureTask()]);
    const section = requiredElement(rendered.container, "section", HTMLElement);
    const scrollArea = requiredElement(section, "[data-slot='scroll-area']", HTMLDivElement);
    const viewport = requiredElement(section, "[data-slot='scroll-area-viewport']", HTMLDivElement);
    const list = requiredElement(section, "ul", HTMLUListElement);

    expect(section.className).toContain("overflow-hidden");
    expect(section.className).not.toContain("overflow-y-auto");
    expect(scrollArea.className).toContain("flex-1");
    expect(viewport.className).toContain("flex-auto");
    expect(viewport.className).toContain("min-h-0");
    expect(viewport.className).toContain("[&>div]:!block");
    expect(viewport.className).toContain("[&>div]:!w-full");
    expect(viewport.className).toContain("[&>div]:!min-w-0");
    expect(viewport.className).not.toContain("h-full");
    expect(list.className).toContain("gap-2");
    expect(list.className).toContain("min-w-0");
  });
});
