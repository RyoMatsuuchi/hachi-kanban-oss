// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WriteTokenModal } from "./WriteTokenModal.js";

const state = vi.hoisted(() => ({ prompt: null as (() => Promise<string | null>) | null }));
vi.mock("../lib/api.js", () => ({ setWriteTokenPrompt: (prompt: typeof state.prompt): void => { state.prompt = prompt; } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

async function openPrompt(): Promise<{ answer: Promise<string | null> }> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<WriteTokenModal />));
  let answer!: Promise<string | null>;
  await act(async () => { answer = state.prompt!(); });
  return { answer };
}

describe("WriteTokenModal", () => {
  it("空入力を拒否し、tokenを正規化して解決する", async () => {
    const { answer } = await openPrompt();
    const input = document.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    const form = document.querySelector("form")!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(document.body.textContent).toContain("token を入力してください");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "  synthetic-token  ");
      input.dispatchEvent(new Event("input", {bubbles: true}));
    });
    await act(async () => { form.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})); });
    expect(await answer).toBe("synthetic-token");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Escapeでnullを返し未解決promptを残さない", async () => {
    const { answer } = await openPrompt();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(await answer).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
