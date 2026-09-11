// =============================================================================
// KnowledgeView の smoke test。一覧・フィルタ・本文表示切替を検証する。
// =============================================================================

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeRow } from "@hachi/core";
import type { FetchKnowledgeParams } from "../lib/api.js";
import type { KnowledgeListResponse } from "../../shared/api-types.js";
import { KnowledgeView } from "./KnowledgeView.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface RenderedKnowledgeView {
  container: HTMLDivElement;
  root: Root;
}

const mocks = vi.hoisted(() => ({
  fetchKnowledge: vi.fn<(params?: FetchKnowledgeParams, signal?: AbortSignal) => Promise<KnowledgeListResponse>>(),
}));

vi.mock("../lib/api.js", () => ({
  fetchKnowledge: mocks.fetchKnowledge,
}));

vi.mock("../hooks/use-debounced-value.js", () => ({
  useDebouncedValue(value: unknown): unknown {
    return value;
  },
}));

function fixtureKnowledge(overrides: Partial<KnowledgeRow> = {}): KnowledgeRow {
  return {
    id: "k_000000000001",
    title: "Bridge handover",
    body: "line one\nline two",
    source: "session-handover",
    tags: ["bridge", "handover"],
    importance: 80,
    expiresAt: null,
    originPath: "",
    contentHash: "hash",
    actor: "tester",
    provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
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

async function renderKnowledgeView(): Promise<RenderedKnowledgeView> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<KnowledgeView />);
    await Promise.resolve();
  });
  await waitFor(() => expect(mocks.fetchKnowledge).toHaveBeenCalledTimes(1));
  return { container, root };
}

async function setTextValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.fetchKnowledge.mockResolvedValue({
    knowledge: [
      fixtureKnowledge(),
      fixtureKnowledge({
        id: "k_000000000002",
        title: "Steward note",
        body: "別の本文",
        source: "steward",
        tags: ["daily"],
        importance: 50,
      }),
    ],
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("KnowledgeView", () => {
  it("一覧表示・フィルタ・本文表示切替ができる", async () => {
    const rendered = await renderKnowledgeView();

    expect(rendered.container.textContent).toContain("Bridge handover");
    expect(rendered.container.textContent).toContain("Steward note");
    expect(rendered.container.textContent).toContain("行を選択してください");

    const firstRow = Array.from(rendered.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Bridge handover"),
    );
    if (!(firstRow instanceof HTMLButtonElement)) {
      throw new Error("knowledge row not found");
    }
    await click(firstRow);

    expect(rendered.container.textContent).toContain("line one");
    expect(rendered.container.textContent).toContain("line two");

    const search = requiredElement(rendered.container, 'input[aria-label="knowledge 検索"]', HTMLInputElement);
    const tag = requiredElement(rendered.container, 'input[aria-label="tag フィルタ"]', HTMLInputElement);
    const source = requiredElement(rendered.container, 'input[aria-label="source フィルタ"]', HTMLInputElement);

    await setTextValue(tag, "bridge");
    await waitFor(() => expect(mocks.fetchKnowledge).toHaveBeenLastCalledWith(
      { tag: "bridge", source: "", q: "" },
      expect.any(AbortSignal),
    ));

    await setTextValue(source, "session-handover");
    await waitFor(() => expect(mocks.fetchKnowledge).toHaveBeenLastCalledWith(
      { tag: "bridge", source: "session-handover", q: "" },
      expect.any(AbortSignal),
    ));

    await setTextValue(search, "restart");
    await waitFor(() => expect(mocks.fetchKnowledge).toHaveBeenLastCalledWith(
      { tag: "bridge", source: "session-handover", q: "restart" },
      expect.any(AbortSignal),
    ));
  });
});
