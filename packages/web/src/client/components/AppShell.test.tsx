// =============================================================================
// AppShell ヘッダーのレスポンシブナビゲーションと More メニューの回帰テスト。
// =============================================================================

// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Route } from "../hooks/use-navigation.js";
import { AppShell, type AppShellProps } from "./AppShell.js";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../hooks/use-running-sessions.js", () => ({
  useRunningSessions: () => ({
    data: { sessions: [{ id: "session-1" }, { id: "session-2" }] },
    error: null,
    loading: false,
  }),
}));

vi.mock("../hooks/use-supervisor-status.js", () => ({
  useSupervisorStatus: () => ({
    data: null,
    error: null,
    loading: false,
    toggle: () => undefined,
  }),
}));

vi.mock("../hooks/use-runtime-resources.js", () => ({
  useRuntimeResources: () => ({
    data: null,
    error: null,
    degraded: false,
    loading: true,
  }),
}));


interface RenderedAppShell {
  container: HTMLDivElement;
  root: Root;
  rerender: (route: Route) => Promise<void>;
}

interface MatchMediaController {
  enterDesktop: () => void;
}

const mountedRoots: Root[] = [];

const defaultBoardControls: AppShellProps["boardControls"] = {
  tenants: ["dev"],
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

function findButton(root: ParentNode, label: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find((candidate) => candidate.textContent === label);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${label}`);
  }
  return button;
}

function mockMatchMedia(): MatchMediaController {
  let listener: ((event: MediaQueryListEvent) => void) | undefined;
  const mediaQuery = {
    matches: false,
    media: "(min-width: 48rem)",
    onchange: null,
    addEventListener: ((_type: string, nextListener: EventListenerOrEventListenerObject): void => {
      listener = typeof nextListener === "function"
        ? (event) => nextListener(event)
        : (event) => nextListener.handleEvent(event);
    }) as MediaQueryList["addEventListener"],
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } satisfies MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));

  return {
    enterDesktop: () => listener?.({ matches: true, media: mediaQuery.media } as MediaQueryListEvent),
  };
}

async function renderAppShell(
  initialRoute: Route,
  onNavigate: (path: string) => void,
  headerHumanDecisions?: ReactNode,
): Promise<RenderedAppShell> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  const renderRoute = async (route: Route): Promise<void> => {
    await act(async () => {
      root.render(
        <AppShell
          route={route}
          boardControls={defaultBoardControls}
          boardCounts={null}
          onNavigate={onNavigate}
          headerHumanDecisions={headerHumanDecisions}
        >
          <main>content</main>
        </AppShell>,
      );
      await Promise.resolve();
    });
  };
  await renderRoute(initialRoute);
  return { container, root, rerender: renderRoute };
}

async function openMore(container: ParentNode): Promise<HTMLButtonElement> {
  const trigger = requiredElement(
    container,
    '[data-testid="appshell-more-nav-trigger"]',
    HTMLButtonElement,
  );
  await act(async () => {
    trigger.focus();
    trigger.click();
    await Promise.resolve();
  });
  return trigger;
}

async function activateButtonWithKeyboard(
  button: HTMLButtonElement,
  key: "Enter" | " ",
): Promise<void> {
  await act(async () => {
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    button.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    // jsdom は button のキーボード操作から click を合成しないため、ブラウザが生成する
    // detail=0 の click までを明示的に再現する。
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  mockMatchMedia();
});

afterEach(async () => {
  await act(async () => { mountedRoots.splice(0).forEach((root) => root.unmount()); });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AppShell", () => {
  it("モバイルは board・sessions・More を直接表示し、低優先5導線を畳む", async () => {
    const onNavigate = vi.fn<(path: string) => void>();
    const rendered = await renderAppShell({ name: "board" }, onNavigate);
    const boardButton = requiredElement(rendered.container, 'button[aria-label="board"]', HTMLButtonElement);
    const mobileSessions = requiredElement(
      rendered.container,
      '[data-testid="appshell-mobile-sessions"]',
      HTMLDivElement,
    );
    const mobileNavTrigger = requiredElement(
      rendered.container,
      '[data-testid="appshell-more-nav-trigger"]',
      HTMLButtonElement,
    );
    const desktopNav = requiredElement(
      rendered.container,
      '[data-testid="appshell-desktop-nav"]',
      HTMLDivElement,
    );

    expect(mobileSessions.className).toContain("md:hidden");
    expect(mobileNavTrigger.className).not.toContain("md:hidden");
    expect(mobileSessions.querySelector('[aria-label="sessions"]')).not.toBeNull();
    expect(desktopNav.querySelector('[aria-label="metrics"]')).toBeNull();
    expect(desktopNav.className).toContain("hidden");
    expect(desktopNav.className).toContain("md:flex");

    await act(async () => {
      boardButton.click();
      mobileSessions.querySelector<HTMLButtonElement>('[aria-label="sessions"]')?.click();
    });
    expect(onNavigate).toHaveBeenNthCalledWith(1, "/");
    expect(onNavigate).toHaveBeenNthCalledWith(2, "/sessions");
    expect(mobileSessions.textContent).toContain("2");
  });

  it("md以上も低優先5導線とテーマを一つのその他へ集約する", async () => {
    const rendered = await renderAppShell({ name: "board" }, () => undefined);
    const desktopNav = requiredElement(
      rendered.container,
      '[data-testid="appshell-desktop-nav"]',
      HTMLDivElement,
    );

    expect(desktopNav.className).toContain("hidden");
    expect(desktopNav.className).toContain("md:flex");
    expect(desktopNav.querySelector('button[aria-label="sessions"]')).not.toBeNull();
    expect(desktopNav.querySelectorAll("button")).toHaveLength(1);
    const trigger = await openMore(rendered.container);
    expect(trigger.getAttribute("aria-label")).toBe("その他");
    expect(trigger.className).not.toContain("md:hidden");
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.body.querySelectorAll('input[type="radio"]')).toHaveLength(3);
  });

  it("More内5導線はクリック遷移してメニューを閉じる", async () => {
    const onNavigate = vi.fn<(path: string) => void>();
    const rendered = await renderAppShell({ name: "board" }, onNavigate);
    const routes = [
      ["メトリクス", "/metrics"],
      ["利用状況", "/usage"],
      ["ナレッジ", "/knowledge"],
      ["スケジュール", "/schedules"],
      ["設定", "/settings"],
    ] as const;

    for (const [label, path] of routes) {
      await openMore(rendered.container);
      const button = findButton(document.body, label);
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
      expect(onNavigate).toHaveBeenLastCalledWith(path);
      expect(document.body.querySelector('[aria-label="その他のナビゲーション"]')).toBeNull();
    }
  });

  it.each([
    ["Enter", "Enter"],
    ["Space", " "],
  ] as const)("More内5導線は%sで遷移してメニューを閉じる", async (_keyName, key) => {
    const onNavigate = vi.fn<(path: string) => void>();
    const rendered = await renderAppShell({ name: "board" }, onNavigate);
    const routes = [
      ["メトリクス", "/metrics"],
      ["利用状況", "/usage"],
      ["ナレッジ", "/knowledge"],
      ["スケジュール", "/schedules"],
      ["設定", "/settings"],
    ] as const;

    for (const [label, path] of routes) {
      const trigger = await openMore(rendered.container);
      const button = findButton(document.body, label);
      await activateButtonWithKeyboard(button, key);
      expect(onNavigate).toHaveBeenLastCalledWith(path);
      expect(document.body.querySelector('[aria-label="その他のナビゲーション"]')).toBeNull();
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
      expect(document.activeElement).toBe(trigger);
    }
    expect(onNavigate).toHaveBeenCalledTimes(routes.length);
  });

  it("畳まれたrouteではMoreと該当項目をactive表示し、route変更時に閉じる", async () => {
    const rendered = await renderAppShell({ name: "knowledge" }, () => undefined);
    const trigger = await openMore(rendered.container);
    const activeItem = findButton(document.body, "ナレッジ");

    expect(trigger.className).toContain("bg-accent-soft");
    expect(activeItem.getAttribute("aria-current")).toBe("page");
    await rendered.rerender({ name: "sessions" });
    expect(document.body.querySelector('[aria-label="その他のナビゲーション"]')).toBeNull();
  });

  it("Escapeとoutside clickで閉じ、triggerへfocusを戻す", async () => {
    const rendered = await renderAppShell({ name: "board" }, () => undefined);
    const trigger = await openMore(rendered.container);
    expect(document.activeElement?.textContent).toBe("メトリクス");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(document.body.querySelector('[aria-label="その他のナビゲーション"]')).toBeNull();
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(document.activeElement).toBe(trigger);

    await openMore(rendered.container);
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      document.body.click();
      await Promise.resolve();
    });
    expect(document.body.querySelector('[aria-label="その他のナビゲーション"]')).toBeNull();
  });

  it("確認入口へfocusを移すとその他を閉じ、focusを奪わない", async () => {
    const rendered = await renderAppShell({ name: "board" }, () => undefined, <button type="button">確認入口</button>);
    await openMore(rendered.container);
    const decisionTrigger = findButton(rendered.container, "確認入口");
    await act(async () => { decisionTrigger.focus(); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(document.body.querySelector('[aria-label="その他のナビゲーション"]')).toBeNull();
    expect(document.activeElement).toBe(decisionTrigger);
  });

  it("ネイティブradioでテーマを永続化し、選択後もその他を開いたままにする", async () => {
    const rendered = await renderAppShell({ name: "board" }, () => undefined);
    await openMore(rendered.container);
    const dark = requiredElement(document.body, 'input[value="dark"]', HTMLInputElement);
    await act(async () => { dark.click(); });
    expect(dark.checked).toBe(true);
    expect(window.localStorage.getItem("hk-theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.body.querySelector('[aria-label="その他のナビゲーション"]')).not.toBeNull();
    const radios = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.map((radio) => radio.name)).toEqual(["header-theme", "header-theme", "header-theme"]);
    // 同じnameのネイティブradioがブラウザの矢印キー選択を提供する。
    // jsdomは既定動作を実装しないため、keydown後のブラウザによるclickを再現する。
    const system = requiredElement(document.body, 'input[value="system"]', HTMLInputElement);
    await act(async () => {
      dark.focus();
      dark.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      system.focus();
      system.click();
    });
    expect(system.checked).toBe(true);
    expect(document.activeElement).toBe(system);
    expect(window.localStorage.getItem("hk-theme")).toBe("system");
    expect(document.body.querySelector('[aria-label="その他のナビゲーション"]')).not.toBeNull();
  });

  it("ヘッダー左端に柴犬ロゴを置き、ワードマークも残す", async () => {
    const rendered = await renderAppShell({ name: "board" }, () => undefined);
    const boardButton = requiredElement(rendered.container, 'button[aria-label="board"]', HTMLButtonElement);
    const logo = requiredElement(boardButton, '[data-testid="appshell-logo"]', HTMLImageElement);

    // jsdom の img.src は絶対 URL に解決されるため属性値で検証する。
    expect(logo.getAttribute("src")).toBe("/icons/shiba.svg");
    expect(logo.getAttribute("alt")).toBe("");
    expect(logo.getAttribute("aria-hidden")).toBe("true");
    expect(boardButton.textContent).toContain("hachi");
  });

  it("実行中ワーカー数を document.title の先頭へ出す", async () => {
    // 直前の値を残さず、このレンダーが書いたことを確かめる。
    document.title = "sentinel";
    await renderAppShell({ name: "board" }, () => undefined);

    expect(document.title).toBe("(2) hachi-kanban");
  });

  it("その他はmd以上へリサイズしても開いた状態を維持する", async () => {
    const matchMedia = mockMatchMedia();
    const rendered = await renderAppShell({ name: "board" }, () => undefined);
    await openMore(rendered.container);
    expect(document.body.querySelector('[aria-label="その他のナビゲーション"]')).not.toBeNull();

    await act(async () => {
      matchMedia.enterDesktop();
      await Promise.resolve();
    });

    expect(document.body.querySelector('[aria-label="その他のナビゲーション"]')).not.toBeNull();
  });
});
