// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanDecisionAnswer, HumanDecisionRequestRow } from "@hachi/core";
import { clearStoredWriteToken, setWriteTokenPrompt } from "../lib/api.js";
import { HumanDecisionsPanel, type HumanDecisionsPanelProps } from "./HumanDecisionsPanel.js";

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
  rerender: (props: HumanDecisionsPanelProps) => Promise<void>;
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

async function renderPanel(props: HumanDecisionsPanelProps): Promise<RenderedPanel> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.add(root);
  await act(async () => {
    root.render(<HumanDecisionsPanel {...props} />);
    await Promise.resolve();
  });
  return {
    container,
    root,
    rerender: async (nextProps: HumanDecisionsPanelProps): Promise<void> => {
      await act(async () => {
        root.render(<HumanDecisionsPanel {...nextProps} />);
        await Promise.resolve();
      });
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

describe("HumanDecisionsPanel", () => {
  it("task/tenant scopeの全依頼を実hookで取得し、明示操作した依頼だけ正しいPOSTを行う", async () => {
    const approval = requestRow("hd_first");
    const decision = requestRow("hd_second", {
      kind: "decision",
      title: "方針を選ぶ",
      action: null,
      targetRevision: null,
      choices: [{ id: "retain", label: "現状維持" }],
      defaultOutcome: "retain_current_state",
    });
    let serverRows = [approval, decision];
    const calls = installFetch((call) => {
      if (call.method === "GET") {
        return jsonResponse({ requests: serverRows });
      }
      const answered = answeredRow(approval);
      serverRows = [answered, decision];
      return jsonResponse({ request: answered });
    });
    const onOpenTask = vi.fn();
    const rendered = await renderPanel({
      taskId: approval.taskId,
      tenant: "tenant with space",
      onOpenTask,
    });
    await settle();

    expect(rendered.container.textContent).toContain("人間への確認");
    expect(rendered.container.textContent).toContain("このタスクへの確認");
    expect(rendered.container.textContent).toContain(approval.title);
    expect(rendered.container.textContent).toContain(decision.title);
    expect(rendered.container.textContent).toContain(approval.id);
    expect(rendered.container.textContent).toContain(decision.id);
    const initialUrl = new URL(getCalls(calls)[0]?.path ?? "", "http://hachi.test");
    expect(initialUrl.searchParams.get("taskId")).toBe(approval.taskId);
    expect(initialUrl.searchParams.get("tenant")).toBe("tenant with space");
    expect(initialUrl.searchParams.has("limit")).toBe(false);
    expect(initialUrl.searchParams.has("statuses")).toBe(false);
    expect(postCalls(calls)).toHaveLength(0);

    await click(buttonByText(rendered.container, "承認する"));
    await settle();
    expect(postCalls(calls)).toHaveLength(1);
    const post = postCalls(calls)[0];
    expect(post?.path).toBe(`/api/human-decisions/${approval.id}/answer?tenant=tenant+with+space`);
    const body = JSON.parse(post?.body ?? "null") as {
      expectedRevision: number;
      answerIdempotencyKey: string;
      answer: HumanDecisionAnswer;
    };
    expect(body).toMatchObject({
      expectedRevision: 0,
      answer: { kind: "approval", outcome: "approve" },
    });
    expect(body.answerIdempotencyKey).toEqual(expect.any(String));
    expect(rendered.container.textContent).toContain("回答済み・受領待ち");
    expect(postCalls(calls).filter((call) => call.path.includes(decision.id))).toHaveLength(0);
  });

  it("初回loading・503・再取得後の空と、保持一覧のstale警告・回復を区別する", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const initial = deferred<Response>();
    const responses: Array<Response | Promise<Response>> = [
      initial.promise,
      jsonResponse({ requests: [] }),
    ];
    let calls = installFetch(() => {
      const response = responses.shift();
      if (response === undefined) throw new Error("初回fixture不足");
      return response;
    });
    const rendered = await renderPanel({ tenant: "board", onOpenTask: () => undefined });
    expect(rendered.container.textContent).toContain("この一覧にはテナントの絞り込みだけが適用されます");
    expect(rendered.container.textContent).toContain("確認依頼を読み込み中");
    expect(postCalls(calls)).toHaveLength(0);
    await act(async () => {
      initial.resolve(jsonResponse({ error: "schema unavailable" }, 503));
      await initial.promise;
    });
    await settle();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("503");
    expect(rendered.container.textContent).not.toContain("確認依頼はありません");
    await click(buttonByText(rendered.container, "再取得"));
    await settle();
    expect(rendered.container.textContent).toContain("確認依頼はありません");
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    await unmount(rendered.root);

    const retained = requestRow("hd_retained");
    const retainedResponses = [
      jsonResponse({ requests: [retained] }),
      jsonResponse({ error: "temporary" }, 503),
      jsonResponse({ requests: [retained] }),
    ];
    calls = installFetch(() => {
      const response = retainedResponses.shift();
      if (response === undefined) throw new Error("stale fixture不足");
      return response;
    });
    const retainedPanel = await renderPanel({ taskId: retained.taskId, onOpenTask: () => undefined });
    await settle();
    expect(retainedPanel.container.textContent).toContain(retained.title);
    act(() => vi.advanceTimersByTime(30_000));
    await settle();
    const staleAlert = retainedPanel.container.querySelector('[role="alert"]');
    expect(staleAlert?.textContent).toContain("更新に失敗しました。前回の内容を表示しています");
    expect(staleAlert?.textContent).toContain(
      `API リクエストに失敗しました (503): /api/human-decisions?taskId=${retained.taskId}`,
    );
    expect(buttonByText(retainedPanel.container, "承認する").disabled).toBe(true);
    await click(buttonByText(retainedPanel.container, "再取得"));
    await settle();
    expect(retainedPanel.container.textContent).not.toContain("更新に失敗しました");
    expect(buttonByText(retainedPanel.container, "承認する").disabled).toBe(false);
    expect(postCalls(calls)).toHaveLength(0);
  });

  it("scope変更で旧フォームを破棄し、旧POST completionを新scopeへ反映しない", async () => {
    const oldRequest = requestRow("hd_old_scope", {
      taskId: "task-old",
      kind: "decision",
      action: null,
      targetRevision: null,
      choices: [],
      defaultOutcome: "retain_current_state",
      title: "旧scopeの判断",
    });
    const newRequest = requestRow("hd_new_scope", {
      taskId: "task-new",
      kind: "decision",
      action: null,
      targetRevision: null,
      choices: [],
      defaultOutcome: "retain_current_state",
      title: "新scopeの判断",
    });
    const pendingPost = deferred<Response>();
    const calls = installFetch((call) => {
      if (call.method === "POST") return pendingPost.promise;
      const url = new URL(call.path, "http://hachi.test");
      return jsonResponse({
        requests: url.searchParams.get("taskId") === "task-new" ? [newRequest] : [oldRequest],
      });
    });
    const rendered = await renderPanel({ taskId: "task-old", onOpenTask: () => undefined });
    await settle();
    const oldText = fieldByLabel(rendered.container, "判断の回答", HTMLTextAreaElement);
    await setTextValue(oldText, "旧scopeの入力");
    await click(buttonByText(rendered.container, "回答を送信"));
    expect(postCalls(calls)).toHaveLength(1);

    await rendered.rerender({ taskId: "task-new", onOpenTask: () => undefined });
    await settle();
    expect(rendered.container.textContent).not.toContain("旧scopeの判断");
    expect(rendered.container.textContent).toContain("新scopeの判断");
    expect(fieldByLabel(rendered.container, "判断の回答", HTMLTextAreaElement).value).toBe("");

    await act(async () => {
      pendingPost.resolve(jsonResponse({
        request: answeredRow(oldRequest, { kind: "decision", text: "旧scopeの入力" }),
      }));
      await pendingPost.promise;
    });
    await settle();
    expect(rendered.container.textContent).toContain("新scopeの判断");
    expect(rendered.container.textContent).not.toContain("回答済み・受領待ち");
    expect(getCalls(calls)).toHaveLength(2);
  });

  it("network不明は同じbody/keyだけを明示再送してansweredを反映する", async () => {
    const waiting = requestRow("hd_uncertain");
    const answered = answeredRow(waiting, { kind: "approval", outcome: "reject" });
    let serverRow = waiting;
    let postCount = 0;
    const calls = installFetch((call) => {
      if (call.method === "GET") return jsonResponse({ requests: [serverRow] });
      postCount += 1;
      if (postCount === 1) return Promise.reject(new TypeError("network unavailable"));
      serverRow = answered;
      return jsonResponse({ request: answered });
    });
    const rendered = await renderPanel({ taskId: waiting.taskId, onOpenTask: () => undefined });
    await settle();
    const comment = fieldByLabel(rendered.container, "コメント（任意）", HTMLTextAreaElement);
    await setTextValue(comment, "同じコメント");
    await click(buttonByText(rendered.container, "却下する"));
    await settle();
    expect(postCalls(calls)).toHaveLength(1);
    expect(rendered.container.textContent).toContain("送信結果を確認できません。同じ回答を再送できます");
    expect(rendered.container.textContent).toContain("保留中の回答: 却下する");
    expect(buttonByText(rendered.container, "承認する").disabled).toBe(true);

    const firstBody = postCalls(calls)[0]?.body;
    await click(buttonByText(rendered.container, "同じ回答を再送"));
    await settle();
    expect(postCalls(calls)).toHaveLength(2);
    expect(postCalls(calls)[1]?.body).toBe(firstBody);
    expect(rendered.container.textContent).toContain("回答済み・受領待ち");
    expect(rendered.container.textContent).toContain("回答: 却下する");
  });

  it("409後は確認GET完了までdisabledを保ち、waiting確認後の新しい明示回答だけを送る", async () => {
    const waiting = requestRow("hd_conflict");
    const refreshAfterConflict = deferred<Response>();
    let serverRow = waiting;
    let getCount = 0;
    let postCount = 0;
    const calls = installFetch((call) => {
      if (call.method === "GET") {
        getCount += 1;
        return getCount === 1
          ? jsonResponse({ requests: [serverRow] })
          : getCount === 2
            ? refreshAfterConflict.promise
            : jsonResponse({ requests: [serverRow] });
      }
      postCount += 1;
      if (postCount === 1) return jsonResponse({ error: "revision conflict" }, 409);
      serverRow = answeredRow(waiting, { kind: "approval", outcome: "reject" });
      return jsonResponse({ request: serverRow });
    });
    const rendered = await renderPanel({ taskId: waiting.taskId, onOpenTask: () => undefined });
    await settle();
    await click(buttonByText(rendered.container, "承認する"));
    await settle();
    expect(postCalls(calls)).toHaveLength(1);
    expect(rendered.container.textContent).toContain("回答は受け付けられませんでした");
    expect(buttonByText(rendered.container, "承認する").disabled).toBe(true);
    expect(buttonByText(rendered.container, "却下する").disabled).toBe(true);

    await settle();
    expect(postCalls(calls)).toHaveLength(1);
    await act(async () => {
      refreshAfterConflict.resolve(jsonResponse({ requests: [waiting] }));
      await refreshAfterConflict.promise;
    });
    await settle();
    expect(buttonByText(rendered.container, "承認する").disabled).toBe(false);
    await click(buttonByText(rendered.container, "却下する"));
    await settle();
    expect(postCalls(calls)).toHaveLength(2);
    const firstBody = JSON.parse(postCalls(calls)[0]?.body ?? "null") as { answerIdempotencyKey: string };
    const secondBody = JSON.parse(postCalls(calls)[1]?.body ?? "null") as {
      answerIdempotencyKey: string;
      answer: HumanDecisionAnswer;
    };
    expect(secondBody.answerIdempotencyKey).not.toBe(firstBody.answerIdempotencyKey);
    expect(secondBody.answer).toEqual({ kind: "approval", outcome: "reject" });
    expect(rendered.container.textContent).toContain("回答済み・受領待ち");
    expect(rendered.container.textContent).toContain("回答: 却下する");
  });
});
