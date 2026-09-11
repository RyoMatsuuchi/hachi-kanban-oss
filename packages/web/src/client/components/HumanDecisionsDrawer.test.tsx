// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanDecisionAnswer, HumanDecisionRequestRow } from "@hachi/core";
import { clearStoredWriteToken, setWriteTokenPrompt } from "../lib/api.js";
import { WriteTokenModal } from "./WriteTokenModal.js";
import { HumanDecisionsDrawer, type HumanDecisionsDrawerProps } from "./HumanDecisionsDrawer.js";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface FetchCall {
  path: string;
  method: string;
  body: string | null;
  signal: AbortSignal | null;
}

interface RenderedPanel {
  container: HTMLDivElement;
  root: Root;
  rerender: (props: HumanDecisionsDrawerProps) => Promise<void>;
}

const REQUEST_PROVENANCE: HumanDecisionRequestRow["requestProvenance"] = {
  kind: "orchestrator",
  actorId: "os_0000000000000001",
  actorSessionId: "os_session_1",
  actorGeneration: 1,
};

const ANSWER_PROVENANCE: NonNullable<HumanDecisionRequestRow["answerProvenance"]> = {
  kind: "human",
  actorId: "human-local",
  actorSessionId: "",
  actorGeneration: null,
};

const BASE_REQUEST: HumanDecisionRequestRow = {
  id: "hd_0000000000000001",
  taskId: "t_0000000000000001",
  ownerOrchestratorId: "os_0000000000000001",
  kind: "approval",
  title: "公開を承認する",
  question: "このrevisionを公開しますか",
  action: "公開する",
  targetRevision: { kind: "git_commit", value: "a".repeat(40) },
  choices: [],
  links: [],
  defaultOutcome: "deny",
  relatedRequestId: null,
  deadlineAt: null,
  status: "waiting_human",
  answerRevision: 0,
  answer: null,
  answerComment: null,
  requestProvenance: REQUEST_PROVENANCE,
  answerProvenance: null,
  cancelProvenance: null,
  resolveProvenance: null,
  answeredAt: null,
  claimantOrchestratorId: null,
  claimantSessionId: null,
  claimantGeneration: null,
  claimLeaseUntil: null,
  resolution: null,
  resolvedAt: null,
  cancelReason: null,
  cancelledAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const mountedRoots = new Set<Root>();

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requestRow(
  id: string,
  overrides: Partial<HumanDecisionRequestRow> = {},
): HumanDecisionRequestRow {
  return { ...BASE_REQUEST, id, ...overrides };
}

function answeredRow(
  request: HumanDecisionRequestRow,
  answer: HumanDecisionAnswer = { kind: "approval", outcome: "approve" },
): HumanDecisionRequestRow {
  return {
    ...request,
    status: "answered",
    answerRevision: 1,
    answer,
    answerProvenance: ANSWER_PROVENANCE,
    answeredAt: 2,
    updatedAt: 2,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(
  handler: (call: FetchCall, index: number) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: FetchCall = {
      path: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      signal: init?.signal ?? null,
    };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length - 1));
  }));
  return calls;
}

async function renderPanel(props: HumanDecisionsDrawerProps): Promise<RenderedPanel> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.add(root);
  await act(async () => {
    root.render(<><WriteTokenModal /><HumanDecisionsDrawer {...props} /></>);
    await Promise.resolve();
  });
  await click(container.querySelector("button")!);
  return {
    container: document.body as HTMLDivElement,
    root,
    rerender: async (nextProps: HumanDecisionsDrawerProps): Promise<void> => {
      await act(async () => {
        root.render(<><WriteTokenModal /><HumanDecisionsDrawer {...nextProps} /></>);
        await Promise.resolve();
      });
      await click(container.querySelector("button")!);
    },
  };
}

async function unmount(root: Root): Promise<void> {
  if (!mountedRoots.delete(root)) return;
  await act(async () => root.unmount());
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) {
      await Promise.resolve();
    }
  });
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`buttonが見つかりません: ${text}`);
  }
  return button;
}

function fieldByLabel<T extends HTMLSelectElement | HTMLTextAreaElement>(
  container: ParentNode,
  text: string,
  constructor: { new(): T },
): T {
  const label = Array.from(container.querySelectorAll("label"))
    .find((candidate) => candidate.textContent?.includes(text));
  const field = label?.querySelector("select, textarea");
  if (!(field instanceof constructor)) {
    throw new Error(`入力欄が見つかりません: ${text}`);
  }
  return field;
}

async function setTextValue(element: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(element: HTMLButtonElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function getCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.method === "GET");
}

function postCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.method === "POST");
}

afterEach(async () => {
  for (const root of [...mountedRoots]) {
    await unmount(root);
  }
  setWriteTokenPrompt(null);
  clearStoredWriteToken();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "hidden");
  document.body.replaceChildren();
});

describe("HumanDecisionsDrawer", () => {
  it("waitingだけを集計し、タブと開閉で下書きを保持する", async () => {
    installFetch(() => jsonResponse({ requests: [BASE_REQUEST, requestRow("hd_a", {status: "answered"}), requestRow("hd_r", {status: "resolved"})] }));
    await renderPanel({ tenant: "demo", onOpenTask: vi.fn() });
    expect(document.querySelector('[aria-label="人間への確認、1件"]')).not.toBeNull();
    await setTextValue(fieldByLabel(document.body, "コメント", HTMLTextAreaElement), "下書き");
    await click(buttonByText(document.body, "回答済み"));
    expect(document.body.textContent).toContain("処理待ち");
    await click(buttonByText(document.body, "閉じる"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(document.querySelector('[aria-label="人間への確認、1件"]')!);
    expect(fieldByLabel(document.body, "コメント", HTMLTextAreaElement).value).toBe("下書き");
    expect(buttonByText(document.body, "確認待ち").getAttribute("aria-pressed")).toBe("true");
  });

  it("初回unknownと取得失敗は0扱いせず再取得できる", async () => {
    const loading = deferred<Response>();
    installFetch((_call, index) => index === 0 ? loading.promise : jsonResponse({requests: []}));
    await renderPanel({ onOpenTask: vi.fn() });
    expect(document.querySelector('[aria-label="人間への確認、件数を読み込み中"]')).not.toBeNull();
    await act(async () => loading.resolve(jsonResponse({error: "offline"}, 503)));
    await settle();
    expect(document.querySelector('[aria-label="人間への確認、件数を取得できません"]')).not.toBeNull();
    await click(buttonByText(document.body, "再取得"));
    expect(document.body.textContent).toContain("確認待ちはありません");
  });

  it("不確定回答は成功通知せず、閉鎖後も同じkeyで再送し確定時だけ通知する", async () => {
    let rows = [BASE_REQUEST];
    let attempts = 0;
    const calls = installFetch((call) => {
      if (call.method === "GET") return jsonResponse({requests: rows});
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      rows = [answeredRow(BASE_REQUEST, {kind: "approval", outcome: "approve"})];
      return jsonResponse({request: rows[0]});
    });
    await renderPanel({onOpenTask: vi.fn()});
    await click(buttonByText(document.body, "承認する"));
    await settle();
    expect(document.body.textContent).not.toContain("回答しました。");
    await click(buttonByText(document.body, "閉じる"));
    await click(document.querySelector('[aria-label="人間への確認、1件"]')!);
    await click(buttonByText(document.body, "同じ回答を再送"));
    await settle();
    expect(postCalls(calls)[0]?.body).toBe(postCalls(calls)[1]?.body);
    expect(document.body.textContent).toContain("回答しました。回答済みで確認できます");
    expect(document.activeElement?.tagName).toBe("H2");
    expect(document.querySelector('[aria-label="人間への確認、0件"]')).not.toBeNull();
  });

  it("更新失敗では前回件数と理由を保持し、拒否回答を成功扱いしない", async () => {
    let stale = false;
    const calls = installFetch((call) => {
      if (call.method === "POST") { stale = true; return jsonResponse({error: "conflict"}, 409); }
      return stale ? jsonResponse({error: "offline"}, 503) : jsonResponse({requests: [BASE_REQUEST]});
    });
    await renderPanel({onOpenTask: vi.fn()});
    await click(buttonByText(document.body, "承認する"));
    await settle();
    expect(document.body.textContent).not.toContain("回答しました。");
    expect(document.querySelector('[aria-label="人間への確認、1件、更新失敗・前回の件数"]')).not.toBeNull();
    expect(document.body.textContent).toContain("前回の内容を表示しています");
    stale = false;
    await click(buttonByText(document.body, "再取得"));
    expect(document.querySelector('[aria-label="人間への確認、1件"]')).not.toBeNull();
    expect(getCalls(calls)).toHaveLength(3);
  });

  it("409後の他者回答GETでは自分の成功通知やfocus移動を行わない", async () => {
    let answered = false;
    const rejection = deferred<Response>();
    installFetch((call) => {
      if (call.method === "POST") { answered = true; return rejection.promise; }
      return jsonResponse({requests: [answered ? answeredRow(BASE_REQUEST, {kind: "approval", outcome: "reject"}) : BASE_REQUEST]});
    });
    await renderPanel({onOpenTask: vi.fn()});
    await click(buttonByText(document.body, "承認する"));
    const close = buttonByText(document.body, "閉じる");
    close.focus();
    await act(async () => rejection.resolve(jsonResponse({error: "conflict"}, 409)));
    await settle();
    expect(document.body.textContent).not.toContain("回答しました。");
    expect(document.querySelector('[aria-label="人間への確認、0件"]')).not.toBeNull();
    expect(document.activeElement).toBe(close);
  });

  it("tenant切替後の遅延応答を隔離する", async () => {
    const old = deferred<Response>();
    installFetch((call) => call.path.includes("tenant=old") ? old.promise : jsonResponse({requests: []}));
    const rendered = await renderPanel({tenant: "old", onOpenTask: vi.fn()});
    await rendered.rerender({tenant: "new", onOpenTask: vi.fn()});
    await act(async () => old.resolve(jsonResponse({requests: [BASE_REQUEST]})));
    await settle();
    expect(document.body.textContent).not.toContain(BASE_REQUEST.title);
    expect(document.body.textContent).toContain("対象: new");
  });

  it("認証のEscapeを優先し回答ボタンへfocusを戻し次のEscapeでドロワーを閉じる", async () => {
    installFetch((call) => call.method === "GET" ? jsonResponse({requests: [BASE_REQUEST]}) : jsonResponse({error: "unauthorized"}, 401));
    await renderPanel({onOpenTask: vi.fn()});
    const approve = buttonByText(document.body, "承認する");
    approve.focus();
    await click(approve);
    await settle();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true})); });
    await settle();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
    expect(document.body.textContent).not.toContain("回答しました。");
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true})); });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("人間への確認、1件");
  });
});
