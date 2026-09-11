// =============================================================================
// Toolbar.tsx のレスポンシブ表示とフィルタバッジのテスト。
// =============================================================================

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toolbar, countActiveFilters, type ToolbarProps } from "./Toolbar.js";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

interface RenderedToolbar {
  container: HTMLDivElement;
  root: Root;
}

const defaultProps: ToolbarProps = {
  tenants: ["alpha", "beta"],
  tenant: "",
  bucket: "all",
  watchedOnly: false,
  query: "",
  onTenantChange: () => undefined,
  onBucketChange: () => undefined,
  onWatchedOnlyChange: () => undefined,
  onQueryChange: () => undefined,
};

function requiredElement<T extends Element>(root: ParentNode, selector: string, ctor: { new (): T }): T {
  const element = root.querySelector(selector);
  if (!(element instanceof ctor)) {
    throw new Error(`element not found: ${selector}`);
  }
  return element;
}

async function renderToolbar(props: Partial<ToolbarProps> = {}): Promise<RenderedToolbar> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Toolbar {...defaultProps} {...props} />);
    await Promise.resolve();
  });
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("countActiveFilters", () => {
  it("tenant・bucket・query の有効な絞り込み数を返す", () => {
    expect(countActiveFilters({ tenant: "", bucket: "all", watchedOnly: false, query: "" })).toBe(0);
    expect(countActiveFilters({ tenant: "alpha", bucket: "all", watchedOnly: false, query: "" })).toBe(1);
    expect(countActiveFilters({ tenant: "alpha", bucket: "review", watchedOnly: true, query: "  " })).toBe(3);
    expect(countActiveFilters({ tenant: "alpha", bucket: "review", watchedOnly: true, query: "t_1234" })).toBe(4);
  });
});

describe("Toolbar", () => {
  it("モバイルはコンパクト行、sm 以上は従来のインライン表示に切り替える", async () => {
    const rendered = await renderToolbar();

    const mobile = requiredElement(rendered.container, '[data-testid="toolbar-mobile"]', HTMLDivElement);
    const desktop = requiredElement(rendered.container, '[data-testid="toolbar-desktop"]', HTMLDivElement);
    const trigger = requiredElement(mobile, 'button[aria-label="検索と絞り込みを開く"]', HTMLButtonElement);

    expect(mobile.className).toContain("sm:hidden");
    expect(desktop.className).toContain("hidden");
    expect(desktop.className).toContain("sm:flex");
    expect(trigger.className).toContain("min-h-10");
    expect(trigger.className).toContain("min-w-10");
    expect(mobile.querySelector('input[type="search"]')).toBeNull();
    expect(desktop.querySelector('input[type="search"]')).not.toBeNull();
  });

  it("有効な絞り込みがある時だけ件数バッジを表示する", async () => {
    const inactive = await renderToolbar();
    expect(inactive.container.querySelector('[data-testid="toolbar-filter-badge"]')).toBeNull();
    inactive.root.unmount();

    const active = await renderToolbar({ tenant: "alpha", bucket: "review", watchedOnly: true, query: "t_1234" });
    const badge = requiredElement(active.container, '[data-testid="toolbar-filter-badge"]', HTMLSpanElement);

    expect(badge.textContent).toBe("絞り込み中 4");
  });

  it("Popover 内のクリアで全フィルタを解除する", async () => {
    const onTenantChange = vi.fn<(tenant: string) => void>();
    const onBucketChange = vi.fn<(bucket: ToolbarProps["bucket"]) => void>();
    const onWatchedOnlyChange = vi.fn<(watchedOnly: boolean) => void>();
    const onQueryChange = vi.fn<(query: string) => void>();
    const rendered = await renderToolbar({
      tenant: "alpha",
      bucket: "review",
      watchedOnly: true,
      query: "t_1234",
      onTenantChange,
      onBucketChange,
      onWatchedOnlyChange,
      onQueryChange,
    });
    const trigger = requiredElement(
      rendered.container,
      'button[aria-label="検索と絞り込みを開く"]',
      HTMLButtonElement,
    );

    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });

    const clearButton = requiredElement(document.body, '[data-testid="toolbar-clear-filters"]', HTMLButtonElement);
    await act(async () => {
      clearButton.click();
      await Promise.resolve();
    });

    expect(onTenantChange).toHaveBeenCalledWith("");
    expect(onBucketChange).toHaveBeenCalledWith("all");
    expect(onWatchedOnlyChange).toHaveBeenCalledWith(false);
    expect(onQueryChange).toHaveBeenCalledWith("");
  });
});
