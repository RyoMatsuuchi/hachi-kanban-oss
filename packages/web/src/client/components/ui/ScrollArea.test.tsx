// =============================================================================
// ScrollArea の Radix 構造と overlay scrollbar のスタイルを固定するテスト。
// =============================================================================

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScrollArea } from "./ScrollArea.js";

interface RenderedScrollArea {
  container: HTMLDivElement;
  root: Root;
}

const originalResizeObserver = globalThis.ResizeObserver;
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

class MockResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    void callback;
  }

  disconnect(): void {}

  observe(target: Element): void {
    void target;
  }

  unobserve(target: Element): void {
    void target;
  }
}

function requiredElement<T extends Element>(root: ParentNode, selector: string, ctor: { new (): T }): T {
  const element = root.querySelector(selector);
  if (!(element instanceof ctor)) {
    throw new Error(`element not found: ${selector}`);
  }
  return element;
}

async function renderScrollArea(): Promise<RenderedScrollArea> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ScrollArea
        className="h-24 border border-line"
        scrollbars="both"
        type="always"
        viewportClassName="p-1"
      >
        <div className="h-48 w-48">content</div>
      </ScrollArea>,
    );
    await Promise.resolve();
  });
  return { container, root };
}

async function renderFitWidthScrollArea(): Promise<RenderedScrollArea> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ScrollArea fitWidth>
        <div className="whitespace-nowrap">content</div>
      </ScrollArea>,
    );
    await Promise.resolve();
  });
  return { container, root };
}

beforeEach(() => {
  globalThis.ResizeObserver = MockResizeObserver;
});

afterEach(() => {
  if (originalResizeObserver === undefined) {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  } else {
    globalThis.ResizeObserver = originalResizeObserver;
  }
  document.body.innerHTML = "";
});

describe("ScrollArea", () => {
  it("Viewport にネイティブスクロールを残し、細身の Radix scrollbar を描画する", async () => {
    const rendered = await renderScrollArea();
    const root = requiredElement(rendered.container, "[data-slot='scroll-area']", HTMLDivElement);
    const viewport = requiredElement(root, "[data-slot='scroll-area-viewport']", HTMLDivElement);
    const vertical = requiredElement(root, "[data-orientation='vertical']", HTMLDivElement);
    const horizontal = requiredElement(root, "[data-orientation='horizontal']", HTMLDivElement);

    expect(root.className).toContain("relative");
    expect(root.className).toContain("flex");
    expect(root.className).toContain("flex-col");
    expect(root.className).toContain("overflow-hidden");
    expect(root.className).toContain("h-24");
    expect(viewport.className).toContain("flex-auto");
    expect(viewport.className).toContain("min-h-0");
    expect(viewport.className).toContain("w-full");
    expect(viewport.className).toContain("p-1");
    expect(viewport.className).not.toContain("[&>div]:!block");
    expect(viewport.className).not.toContain("[&>div]:!w-full");
    expect(viewport.className).not.toContain("[&>div]:!min-w-0");
    expect(vertical.className).toContain("w-2");
    expect(horizontal.className).toContain("h-2");
    expect(vertical.className).toContain("data-[state=visible]:bg-line/40");

    await act(async () => {
      rendered.root.unmount();
    });
  });

  it("fitWidth 指定時だけ Radix 内側ラッパを親幅に拘束する", async () => {
    const rendered = await renderFitWidthScrollArea();
    const viewport = requiredElement(
      rendered.container,
      "[data-slot='scroll-area-viewport']",
      HTMLDivElement,
    );

    expect(viewport.className).toContain("[&>div]:!block");
    expect(viewport.className).toContain("[&>div]:!w-full");
    expect(viewport.className).toContain("[&>div]:!min-w-0");

    await act(async () => {
      rendered.root.unmount();
    });
  });
});
