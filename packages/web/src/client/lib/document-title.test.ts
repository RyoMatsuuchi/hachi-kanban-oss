// =============================================================================
// document.title 単一所有モジュールの回帰テスト（docs/contract.md §37.7）。
// JSX を使わずに createElement で probe を組み立て、lib/ 配下の .ts 規約に合わせる。
// =============================================================================

// @vitest-environment jsdom

import { act, createElement, StrictMode, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DOCUMENT_TITLE,
  formatDocumentTitle,
  useActiveWorkerCountTitle,
  useDocumentTitleBase,
} from "./document-title.js";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

function BaseProbe(props: { base: string | null }): null {
  useDocumentTitleBase(props.base);
  return null;
}

/** ルート差し替え（別コンポーネントへの入れ替え）を再現するための2つ目の probe。 */
function OtherBaseProbe(props: { base: string | null }): null {
  useDocumentTitleBase(props.base);
  return null;
}

function CountProbe(props: { count: number }): null {
  useActiveWorkerCountTitle(props.count);
  return null;
}

async function mount(element: ReactElement): Promise<Root> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return root;
}

async function unmountAll(...roots: Root[]): Promise<void> {
  await act(async () => {
    for (const root of roots) {
      root.unmount();
    }
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("formatDocumentTitle", () => {
  it("0 件ならプレフィックスを付けない（バッジの badge > 0 条件と一致）", () => {
    expect(formatDocumentTitle("セッション - hachi-kanban", 0)).toBe("セッション - hachi-kanban");
  });

  it("正数なら先頭に件数プレフィックスを付ける", () => {
    expect(formatDocumentTitle("▶ タスクA", 3)).toBe("(3) ▶ タスクA");
  });

  it("ベース未登録（null）は既定タイトルへフォールバックする", () => {
    expect(formatDocumentTitle(null, 0)).toBe(DEFAULT_DOCUMENT_TITLE);
    expect(formatDocumentTitle(null, 2)).toBe(`(2) ${DEFAULT_DOCUMENT_TITLE}`);
  });
});

describe("useDocumentTitleBase / useActiveWorkerCountTitle", () => {
  it("ベースと件数を合成して document.title へ反映する", async () => {
    const countRoot = await mount(createElement(CountProbe, { count: 2 }));
    const baseRoot = await mount(createElement(BaseProbe, { base: "セッション - hachi-kanban" }));

    expect(document.title).toBe("(2) セッション - hachi-kanban");

    await unmountAll(baseRoot, countRoot);
  });

  it("ベースの unmount では既定へ戻るが、件数プレフィックスは残る", async () => {
    const countRoot = await mount(createElement(CountProbe, { count: 3 }));
    const baseRoot = await mount(createElement(BaseProbe, { base: "▶ タスクA" }));
    expect(document.title).toBe("(3) ▶ タスクA");

    await unmountAll(baseRoot);
    expect(document.title).toBe("(3) hachi-kanban");

    await unmountAll(countRoot);
    expect(document.title).toBe("hachi-kanban");
  });

  it("画面遷移でベースを差し替えると新しいベースへ追随する", async () => {
    const countRoot = await mount(createElement(CountProbe, { count: 1 }));
    const baseRoot = await mount(createElement(BaseProbe, { base: "旧画面" }));
    expect(document.title).toBe("(1) 旧画面");

    await act(async () => {
      baseRoot.render(createElement(BaseProbe, { base: "新画面" }));
    });
    expect(document.title).toBe("(1) 新画面");

    await unmountAll(baseRoot, countRoot);
  });

  it("旧ベースの unmount が新ベースの mount と交差しても新ベースを巻き戻さない", async () => {
    const countRoot = await mount(createElement(CountProbe, { count: 2 }));
    const oldRoot = await mount(createElement(BaseProbe, { base: "旧画面" }));
    const newRoot = await mount(createElement(BaseProbe, { base: "新画面" }));
    expect(document.title).toBe("(2) 新画面");

    // owner トークンが無い実装だと、ここで "(2) hachi-kanban" に巻き戻ってしまう。
    await unmountAll(oldRoot);
    expect(document.title).toBe("(2) 新画面");

    await unmountAll(newRoot, countRoot);
    expect(document.title).toBe("hachi-kanban");
  });

  it("同一 root のルート差し替え（旧 cleanup → 新 effect）でも新ベースが残る", async () => {
    const countRoot = await mount(createElement(CountProbe, { count: 2 }));
    const baseRoot = await mount(createElement(BaseProbe, { base: "▶ タスクA" }));
    expect(document.title).toBe("(2) ▶ タスクA");

    // 別コンポーネントへ差し替えると、React は旧 cleanup → 新 effect の順で実行する。
    await act(async () => {
      baseRoot.render(createElement(OtherBaseProbe, { base: "セッション - hachi-kanban" }));
    });
    expect(document.title).toBe("(2) セッション - hachi-kanban");

    await unmountAll(baseRoot, countRoot);
    expect(document.title).toBe("hachi-kanban");
  });

  it("旧 root の unmount と新 root の mount が同一 act 内で起きても新ベースが残る", async () => {
    const countRoot = await mount(createElement(CountProbe, { count: 2 }));
    const oldRoot = await mount(createElement(BaseProbe, { base: "▶ タスクA" }));

    const container = document.createElement("div");
    document.body.append(container);
    const newRoot = createRoot(container);
    await act(async () => {
      oldRoot.unmount();
      newRoot.render(createElement(OtherBaseProbe, { base: "セッション - hachi-kanban" }));
    });
    expect(document.title).toBe("(2) セッション - hachi-kanban");

    await unmountAll(newRoot, countRoot);
    expect(document.title).toBe("hachi-kanban");
  });

  it("StrictMode の effect 二重実行でもベースが消えない", async () => {
    const countRoot = await mount(
      createElement(StrictMode, null, createElement(CountProbe, { count: 4 })),
    );
    const baseRoot = await mount(
      createElement(StrictMode, null, createElement(BaseProbe, { base: "セッション - hachi-kanban" })),
    );

    expect(document.title).toBe("(4) セッション - hachi-kanban");

    await unmountAll(baseRoot, countRoot);
    expect(document.title).toBe("hachi-kanban");
  });
});
