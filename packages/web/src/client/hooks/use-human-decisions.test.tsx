// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanDecisionAnswer, HumanDecisionRequestRow } from "@hachi/core";
import {
  clearStoredWriteToken,
  setWriteTokenPrompt,
} from "../lib/api.js";
import {
  useHumanDecisions,
  type HumanDecisionScope,
  type UseHumanDecisionsResult,
} from "./use-human-decisions.js";

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
  authorization: string | null;
  signal: AbortSignal | null;
}

const ORCHESTRATOR_PROVENANCE: HumanDecisionRequestRow["requestProvenance"] = {
  kind: "orchestrator",
  actorId: "os_0000000000000001",
  actorSessionId: "os_session_1",
  actorGeneration: 1,
};

const HUMAN_PROVENANCE: NonNullable<HumanDecisionRequestRow["answerProvenance"]> = {
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
  requestProvenance: ORCHESTRATOR_PROVENANCE,
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

let latest: UseHumanDecisionsResult | null = null;
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
  status: "answered" | "claimed" | "resolved" = "answered",
): HumanDecisionRequestRow {
  return {
    ...request,
    status,
    answerRevision: 1,
    answer: { kind: "approval", outcome: "approve" },
    answerProvenance: HUMAN_PROVENANCE,
    answeredAt: 2,
    claimantOrchestratorId: status === "claimed" ? "os_0000000000000001" : null,
    claimantSessionId: status === "claimed" ? "os_session_1" : null,
    claimantGeneration: status === "claimed" ? 1 : null,
    claimLeaseUntil: status === "claimed" ? 100 : null,
    resolution: status === "resolved" ? { outcome: "handled" } : null,
    resolvedAt: status === "resolved" ? 3 : null,
    updatedAt: status === "answered" ? 2 : 3,
  };
}

function cancelledRow(request: HumanDecisionRequestRow): HumanDecisionRequestRow {
  return {
    ...request,
    status: "cancelled",
    cancelReason: "不要になった",
    cancelledAt: 2,
    updatedAt: 2,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function invalidJsonResponse(status = 200): Response {
  return new Response("{", {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(
  handler: (call: FetchCall, index: number) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const call: FetchCall = {
      path: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      authorization: headers.get("authorization"),
      signal: init?.signal ?? null,
    };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length - 1));
  }));
  return calls;
}

function requestIdFromPost(call: FetchCall): string {
  const match = /^\/api\/human-decisions\/([^/?]+)\/answer/.exec(call.path);
  if (match?.[1] === undefined) {
    throw new Error(`回答POSTではありません: ${call.path}`);
  }
  return decodeURIComponent(match[1]);
}

function Probe({ scope }: { scope: HumanDecisionScope }): null {
  latest = useHumanDecisions(scope);
  return null;
}

async function renderProbe(
  scope: HumanDecisionScope,
  strict = false,
): Promise<Root> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.add(root);
  await act(async () => {
    root.render(strict
      ? <StrictMode><Probe scope={scope} /></StrictMode>
      : <Probe scope={scope} />);
  });
  return root;
}

async function rerenderProbe(root: Root, scope: HumanDecisionScope, strict = false): Promise<void> {
  await act(async () => {
    root.render(strict
      ? <StrictMode><Probe scope={scope} /></StrictMode>
      : <Probe scope={scope} />);
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

async function unmount(root: Root): Promise<void> {
  if (!mountedRoots.delete(root)) {
    return;
  }
  await act(async () => root.unmount());
}

function postCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.method === "POST");
}

function getCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.method === "GET");
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
  latest = null;
});

describe("useHumanDecisions", () => {
  it("全依頼・正常空・初回失敗と、保持一覧のstaleからの回復を区別する", async () => {
    const first = requestRow("hd_first");
    const second = requestRow("hd_second");
    const responses: Array<Response> = [
      jsonResponse({ requests: [first, second] }),
      jsonResponse({ requests: [] }),
      jsonResponse({ error: "schema unavailable" }, 503),
      jsonResponse({ requests: [first] }),
      jsonResponse({ error: "temporary" }, 503),
      jsonResponse({ requests: [second] }),
    ];
    const calls = installFetch(() => {
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("GET fixtureが不足しています");
      }
      return response;
    });

    let root = await renderProbe({ taskId: first.taskId, tenant: "dev tenant" });
    await settle();
    expect(latest?.requests?.map((request) => request.id)).toEqual(["hd_first", "hd_second"]);
    const firstUrl = new URL(getCalls(calls)[0]?.path ?? "", "http://hachi.test");
    expect(firstUrl.searchParams.get("taskId")).toBe(first.taskId);
    expect(firstUrl.searchParams.get("tenant")).toBe("dev tenant");
    expect(firstUrl.searchParams.has("statuses")).toBe(false);
    expect(firstUrl.searchParams.has("limit")).toBe(false);

    await act(async () => latest?.refresh());
    expect(latest).toMatchObject({ requests: [], loading: false, error: null, stale: false });
    await unmount(root);

    root = await renderProbe({ tenant: "initial-failure" });
    await settle();
    expect(latest).toMatchObject({ requests: null, loading: false, stale: false });
    expect(latest?.error).toContain("503");
    await unmount(root);

    root = await renderProbe({ taskId: first.taskId });
    await settle();
    expect(latest?.requests?.map((request) => request.id)).toEqual(["hd_first"]);
    await act(async () => latest?.refresh());
    expect(latest?.requests?.map((request) => request.id)).toEqual(["hd_first"]);
    expect(latest).toMatchObject({ loading: false, stale: true });
    expect(latest?.error).toContain("503");
    await act(async () => latest?.refresh());
    expect(latest?.requests?.map((request) => request.id)).toEqual(["hd_second"]);
    expect(latest).toMatchObject({ loading: false, error: null, stale: false });
  });

  it("tenantのundefinedと空は同scope、taskIdのundefinedと空は別scopeとして扱う", async () => {
    const gets: Deferred<Response>[] = [];
    installFetch(() => {
      const item = deferred<Response>();
      gets.push(item);
      return item.promise;
    });
    const root = await renderProbe({});
    expect(gets).toHaveLength(1);
    const sameScopeRefresh = latest?.refresh;

    await rerenderProbe(root, { tenant: "" });
    expect(gets).toHaveLength(1);
    const explicitRefresh = sameScopeRefresh?.();
    expect(gets).toHaveLength(2);
    await act(async () => {
      gets[1]?.resolve(jsonResponse({ requests: [requestRow("hd_all_tenants")] }));
      await explicitRefresh;
    });
    expect(latest?.requests?.map((request) => request.id)).toEqual(["hd_all_tenants"]);

    await rerenderProbe(root, { taskId: "", tenant: "" });
    expect(gets).toHaveLength(3);
    expect(latest).toMatchObject({ requests: null, loading: true, error: null, stale: false });
    await act(async () => {
      gets[2]?.resolve(jsonResponse({ requests: [] }));
      await Promise.resolve();
    });
    await settle();
    expect(latest).toMatchObject({ requests: [], loading: false, error: null, stale: false });

    gets[0]?.resolve(jsonResponse({ requests: [requestRow("hd_late_undefined")] }));
    await settle();
    expect(latest?.requests).toEqual([]);
  });

  it("GET順序逆転、A→B→A、unmount、StrictModeで旧epochを混入させない", async () => {
    const gets: Deferred<Response>[] = [];
    const calls = installFetch((call) => {
      if (call.method === "POST") {
        throw new Error("旧callbackからPOSTされました");
      }
      const item = deferred<Response>();
      gets.push(item);
      return item.promise;
    });
    const root = await renderProbe({ taskId: "task-a" });
    const oldSubmit = latest?.submit;
    expect(gets).toHaveLength(1);

    await rerenderProbe(root, { taskId: "task-b" });
    await rerenderProbe(root, { taskId: "task-a" });
    expect(gets).toHaveLength(3);
    await act(async () => {
      gets[0]?.resolve(jsonResponse({ requests: [requestRow("hd_old_a")] }));
      gets[1]?.resolve(jsonResponse({ requests: [requestRow("hd_old_b")] }));
      gets[2]?.resolve(jsonResponse({ requests: [requestRow("hd_new_a")] }));
      await Promise.resolve();
    });
    await settle();
    expect(latest?.requests?.map((request) => request.id)).toEqual(["hd_new_a"]);
    await expect(oldSubmit?.("hd_new_a", { kind: "approval", outcome: "approve" })).resolves.toBeUndefined();
    expect(postCalls(calls)).toHaveLength(0);

    let olderRefresh: Promise<void> | undefined;
    let newerRefresh: Promise<void> | undefined;
    act(() => {
      olderRefresh = latest?.refresh();
      newerRefresh = latest?.refresh();
    });
    expect(gets).toHaveLength(5);
    await act(async () => {
      gets[4]?.resolve(jsonResponse({ requests: [requestRow("hd_latest")] }));
      await newerRefresh;
    });
    await act(async () => {
      gets[3]?.resolve(jsonResponse({ error: "late failure" }, 503));
      await olderRefresh;
    });
    expect(latest?.requests?.map((request) => request.id)).toEqual(["hd_latest"]);
    expect(latest).toMatchObject({ error: null, stale: false, loading: false });

    let unmountedRefresh: Promise<void> | undefined;
    act(() => {
      unmountedRefresh = latest?.refresh();
    });
    const unmountedSignal = gets[5]?.promise === undefined ? null : getCalls(calls)[5]?.signal;
    await unmount(root);
    expect(unmountedSignal?.aborted).toBe(true);
    await act(async () => {
      gets[5]?.resolve(jsonResponse({ requests: [requestRow("hd_after_unmount")] }));
      await unmountedRefresh;
    });
    expect(postCalls(calls)).toHaveLength(0);

    const strictRoot = await renderProbe({ taskId: "strict" }, true);
    expect(gets.length).toBeGreaterThanOrEqual(8);
    const strictFirst = gets.at(-2);
    const strictSecond = gets.at(-1);
    await act(async () => {
      strictSecond?.resolve(jsonResponse({ requests: [requestRow("hd_strict_current")] }));
      strictFirst?.resolve(jsonResponse({ requests: [requestRow("hd_strict_stale")] }));
      await Promise.resolve();
    });
    await settle();
    expect(latest?.requests?.map((request) => request.id)).toEqual(["hd_strict_current"]);
    await unmount(strictRoot);
  });

  it("scope離脱後もPOSTをabortせず、旧completionだけを新scopeから隔離する", async () => {
    const oldRequest = requestRow("hd_scope_post_old");
    const newRequest = requestRow("hd_scope_post_new");
    const pendingPost = deferred<Response>();
    const calls = installFetch((call) => {
      if (call.method === "POST") {
        return pendingPost.promise;
      }
      const url = new URL(call.path, "http://hachi.test");
      return jsonResponse({
        requests: url.searchParams.get("taskId") === "new-scope" ? [newRequest] : [oldRequest],
      });
    });
    const root = await renderProbe({ taskId: "old-scope" });
    await settle();

    let operation!: Promise<void>;
    act(() => {
      operation = latest?.submit(oldRequest.id, { kind: "approval", outcome: "approve" }) ?? Promise.resolve();
    });
    expect(postCalls(calls)).toHaveLength(1);
    expect(postCalls(calls)[0]?.signal).toBeNull();
    await rerenderProbe(root, { taskId: "new-scope" });
    await settle();
    expect(latest?.requests?.map((request) => request.id)).toEqual([newRequest.id]);

    await act(async () => {
      pendingPost.resolve(jsonResponse({ request: answeredRow(oldRequest) }));
      await operation;
    });
    expect(latest?.requests?.map((request) => request.id)).toEqual([newRequest.id]);
    expect(getCalls(calls)).toHaveLength(2);
  });

  it("同turn二重submitを1件にし、異なる依頼の並行結果と保留DTOを分離する", async () => {
    const requestA = requestRow("hd_parallel_a");
    const requestB = requestRow("hd_parallel_b");
    let serverRows = [requestA, requestB];
    const posts = new Map<string, Deferred<Response>>();
    const calls = installFetch((call) => {
      if (call.method === "GET") {
        return jsonResponse({ requests: serverRows });
      }
      const id = requestIdFromPost(call);
      const item = deferred<Response>();
      posts.set(id, item);
      return item.promise;
    });
    await renderProbe({ taskId: requestA.taskId });
    await settle();

    const callerAnswer: { kind: "approval"; outcome: "approve" | "reject" } = {
      kind: "approval",
      outcome: "approve",
    };
    let firstA!: Promise<void>;
    let duplicateA!: Promise<void>;
    let firstB!: Promise<void>;
    act(() => {
      firstA = latest?.submit(requestA.id, callerAnswer, "A comment") ?? Promise.resolve();
      duplicateA = latest?.submit(requestA.id, { kind: "approval", outcome: "reject" }) ?? Promise.resolve();
      firstB = latest?.submit(requestB.id, { kind: "approval", outcome: "reject" }) ?? Promise.resolve();
    });
    await duplicateA;
    expect(postCalls(calls)).toHaveLength(2);
    expect(latest?.submissions[requestA.id]).toMatchObject({ phase: "submitting", canSubmit: false });
    expect(latest?.submissions[requestB.id]).toMatchObject({ phase: "submitting", canSubmit: false });

    callerAnswer.outcome = "reject";
    const exposed = latest?.submissions[requestA.id]?.pendingAnswer?.answer;
    if (exposed?.kind === "approval") {
      exposed.outcome = "reject";
    }

    const answeredB = {
      ...answeredRow(requestB),
      answer: { kind: "approval", outcome: "reject" } as const,
    };
    serverRows = [requestA, answeredB];
    await act(async () => {
      posts.get(requestB.id)?.resolve(jsonResponse({ request: answeredB }));
      await firstB;
    });
    expect(latest?.submissions[requestA.id]?.phase).toBe("submitting");
    expect(latest?.submissions[requestB.id]?.phase).toBe("idle");

    const answeredA = answeredRow(requestA);
    serverRows = [answeredA, answeredB];
    await act(async () => {
      posts.get(requestA.id)?.resolve(jsonResponse({ request: answeredA }));
      await firstA;
    });
    expect(latest?.requests?.map((request) => request.status)).toEqual(["answered", "answered"]);
    const bodies = postCalls(calls).map((call) => JSON.parse(call.body ?? "null") as {
      answerIdempotencyKey: string;
      answer: HumanDecisionAnswer;
      comment?: string | null;
    });
    expect(bodies[0]?.answer).toEqual({ kind: "approval", outcome: "approve" });
    expect(bodies[0]?.comment).toBe("A comment");
    expect(bodies[1]?.answer).toEqual({ kind: "approval", outcome: "reject" });
    expect(new Set(bodies.map((body) => body.answerIdempotencyKey)).size).toBe(2);
  });

  it("401 token prompt中も送信枠を保持し、認証retryでbodyとkeyを変えない", async () => {
    const waiting = requestRow("hd_auth");
    const answered = answeredRow(waiting);
    let serverRow = waiting;
    const token = deferred<string | null>();
    let promptCalls = 0;
    setWriteTokenPrompt(() => {
      promptCalls += 1;
      return token.promise;
    });
    const calls = installFetch((call) => {
      if (call.method === "GET") {
        return jsonResponse({ requests: [serverRow] });
      }
      if (call.authorization === null) {
        return jsonResponse({ error: "write authorization required" }, 401);
      }
      serverRow = answered;
      return jsonResponse({ request: answered });
    });
    await renderProbe({ taskId: waiting.taskId, tenant: "tenant-auth" });
    await settle();

    let operation!: Promise<void>;
    act(() => {
      operation = latest?.submit(waiting.id, { kind: "approval", outcome: "approve" }) ?? Promise.resolve();
    });
    await settle();
    expect(promptCalls).toBe(1);
    expect(postCalls(calls)).toHaveLength(1);
    expect(latest?.submissions[waiting.id]).toMatchObject({ phase: "submitting", canSubmit: false, canRetry: false });
    await act(async () => {
      await latest?.submit(waiting.id, { kind: "approval", outcome: "reject" });
      await latest?.retrySameAnswer(waiting.id);
    });
    expect(postCalls(calls)).toHaveLength(1);

    await act(async () => {
      token.resolve("human-token");
      await operation;
    });
    const postsOnly = postCalls(calls);
    expect(postsOnly).toHaveLength(2);
    expect(postsOnly[0]?.path).toBe(postsOnly[1]?.path);
    expect(postsOnly[0]?.body).toBe(postsOnly[1]?.body);
    expect(postsOnly[0]?.authorization).toBeNull();
    expect(postsOnly[1]?.authorization).toBe("Bearer human-token");
    expect(latest?.submissions[waiting.id]).toMatchObject({ phase: "idle", pendingAnswer: null });
  });

  it("409後は新GETの結果に応じてimmutable・再入力可・再入力不可を決め、自動POSTしない", async () => {
    const requestA = requestRow("hd_conflict_answered");
    const requestB = requestRow("hd_conflict_waiting");
    const requestC = requestRow("hd_conflict_failed_get");
    let serverRows = [requestA, requestB, requestC];
    let getFailure = false;
    const postCounts = new Map<string, number>();
    const calls = installFetch((call) => {
      if (call.method === "GET") {
        return getFailure
          ? jsonResponse({ error: "refresh failed" }, 503)
          : jsonResponse({ requests: serverRows });
      }
      const id = requestIdFromPost(call);
      const count = (postCounts.get(id) ?? 0) + 1;
      postCounts.set(id, count);
      if (id === requestB.id && count === 2) {
        const answered = answeredRow(requestB);
        serverRows = serverRows.map((row) => row.id === id ? answered : row);
        return jsonResponse({ request: answered });
      }
      if (id === requestA.id) {
        serverRows = serverRows.map((row) => row.id === id ? answeredRow(row) : row);
      }
      if (id === requestC.id) {
        getFailure = true;
      }
      return jsonResponse({ error: "revision conflict" }, 409);
    });
    await renderProbe({ taskId: requestA.taskId });
    await settle();

    await act(async () => latest?.submit(requestA.id, { kind: "approval", outcome: "approve" }));
    expect(latest?.submissions[requestA.id]).toMatchObject({ phase: "idle", canSubmit: false });

    await act(async () => latest?.submit(requestB.id, { kind: "approval", outcome: "approve" }));
    expect(latest?.submissions[requestB.id]).toMatchObject({ phase: "rejected", canSubmit: true, canRetry: false });
    expect(postCounts.get(requestB.id)).toBe(1);
    await settle();
    expect(postCounts.get(requestB.id)).toBe(1);
    await act(async () => latest?.submit(requestB.id, { kind: "approval", outcome: "reject" }));
    expect(postCounts.get(requestB.id)).toBe(2);
    expect(latest?.submissions[requestB.id]?.phase).toBe("idle");

    await act(async () => latest?.submit(requestC.id, { kind: "approval", outcome: "approve" }));
    expect(latest?.submissions[requestC.id]).toMatchObject({ phase: "rejected", canSubmit: false, canRetry: false });
    expect(latest).toMatchObject({ stale: true });
    const before = postCalls(calls).length;
    await settle();
    expect(postCalls(calls)).toHaveLength(before);
  });

  it("network・5xx・parse不明は同じbody/keyだけを再送し、確定状態のGETで保留を解除する", async () => {
    const requestA = requestRow("hd_network");
    const requestB = requestRow("hd_5xx");
    const requestC = requestRow("hd_parse");
    let serverRows = [requestA, requestB, requestC];
    let failNextGet = false;
    const postCounts = new Map<string, number>();
    const calls = installFetch((call) => {
      if (call.method === "GET") {
        if (failNextGet) {
          failNextGet = false;
          return jsonResponse({ error: "refresh unavailable" }, 503);
        }
        return jsonResponse({ requests: serverRows });
      }
      const id = requestIdFromPost(call);
      const count = (postCounts.get(id) ?? 0) + 1;
      postCounts.set(id, count);
      if (id === requestA.id) {
        if (count === 1) {
          failNextGet = true;
        }
        return Promise.reject(new TypeError("network unavailable"));
      }
      if (id === requestB.id) {
        return jsonResponse({ error: "server error" }, 500);
      }
      return invalidJsonResponse();
    });
    await renderProbe({ taskId: requestA.taskId });
    await settle();

    await act(async () => latest?.submit(requestA.id, { kind: "approval", outcome: "approve" }, "keep"));
    expect(latest).toMatchObject({ stale: true });
    expect(latest?.submissions[requestA.id]).toMatchObject({ phase: "uncertain", canRetry: true });
    await act(async () => latest?.refresh());
    await act(async () => latest?.submit(requestB.id, { kind: "approval", outcome: "approve" }));
    await act(async () => latest?.submit(requestC.id, { kind: "approval", outcome: "reject" }));
    for (const request of [requestA, requestB, requestC]) {
      expect(latest?.submissions[request.id]).toMatchObject({
        phase: "uncertain",
        canSubmit: false,
        canRetry: true,
      });
    }

    const postsBeforeInvalidSubmits = postCalls(calls).length;
    await act(async () => {
      await latest?.submit(requestA.id, { kind: "approval", outcome: "reject" });
      await latest?.submit(requestB.id, { kind: "approval", outcome: "reject" });
      await latest?.submit(requestC.id, { kind: "approval", outcome: "approve" });
    });
    expect(postCalls(calls)).toHaveLength(postsBeforeInvalidSubmits);

    const exposed = latest?.submissions[requestA.id]?.pendingAnswer;
    if (exposed?.answer.kind === "approval") {
      exposed.answer.outcome = "reject";
    }
    if (exposed !== null && exposed !== undefined) {
      exposed.comment = "changed outside";
    }
    await act(async () => latest?.retrySameAnswer(requestA.id));
    await act(async () => latest?.retrySameAnswer(requestB.id));
    await act(async () => latest?.retrySameAnswer(requestC.id));
    for (const request of [requestA, requestB, requestC]) {
      expect(latest?.submissions[request.id]).toMatchObject({ phase: "uncertain", canRetry: true });
      const requestBodies = postCalls(calls)
        .filter((call) => requestIdFromPost(call) === request.id)
        .map((call) => call.body);
      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[0]).toBe(requestBodies[1]);
    }

    serverRows = [answeredRow(requestA), answeredRow(requestB, "resolved"), cancelledRow(requestC)];
    await act(async () => latest?.refresh());
    for (const request of [requestA, requestB, requestC]) {
      expect(latest?.submissions[request.id]).toMatchObject({
        phase: "idle",
        canSubmit: false,
        canRetry: false,
        pendingAnswer: null,
      });
    }
  });

  it("POSTとGETの交差で古いwaiting・revision低下・terminal巻戻しを防ぎ、claimed→answeredを許す", async () => {
    const requestA = requestRow("hd_cross_success");
    const requestB = requestRow("hd_cross_failure");
    const revisionOne = answeredRow(requestRow("hd_revision_one"));
    const terminal = answeredRow(requestRow("hd_terminal"), "resolved");
    const claimed = answeredRow(requestRow("hd_claimed"), "claimed");
    let getIndex = 0;
    const oldWaitingGet = deferred<Response>();
    const postA = deferred<Response>();
    const postB = deferred<Response>();
    const initialRows = [requestA, requestB, revisionOne, terminal, claimed];
    const answeredA = answeredRow(requestA);
    const answeredB = answeredRow(requestB);
    const calls = installFetch((call) => {
      if (call.method === "POST") {
        return requestIdFromPost(call) === requestA.id ? postA.promise : postB.promise;
      }
      getIndex += 1;
      if (getIndex === 1) {
        return jsonResponse({ requests: initialRows });
      }
      if (getIndex === 2) {
        return oldWaitingGet.promise;
      }
      if (getIndex === 3) {
        return jsonResponse({ requests: [answeredA, requestB, revisionOne, terminal, claimed] });
      }
      if (getIndex === 4 || getIndex === 5) {
        return jsonResponse({ requests: [answeredA, answeredB, revisionOne, terminal, claimed] });
      }
      return jsonResponse({
        requests: [
          answeredA,
          answeredB,
          requestRow(revisionOne.id),
          requestRow(terminal.id),
          answeredRow(claimed),
        ],
      });
    });
    await renderProbe({ taskId: requestA.taskId });
    await settle();

    let oldRefresh: Promise<void> | undefined;
    let submitA!: Promise<void>;
    act(() => {
      oldRefresh = latest?.refresh();
      submitA = latest?.submit(requestA.id, { kind: "approval", outcome: "approve" }) ?? Promise.resolve();
    });
    await act(async () => {
      postA.resolve(jsonResponse({ request: answeredA }));
      await submitA;
    });
    await act(async () => {
      oldWaitingGet.resolve(jsonResponse({ requests: initialRows }));
      await oldRefresh;
    });
    expect(latest?.requests?.find((row) => row.id === requestA.id)?.answerRevision).toBe(1);

    let submitB!: Promise<void>;
    act(() => {
      submitB = latest?.submit(requestB.id, { kind: "approval", outcome: "approve" }) ?? Promise.resolve();
    });
    await act(async () => latest?.refresh());
    expect(latest?.requests?.find((row) => row.id === requestB.id)?.status).toBe("answered");
    expect(latest?.submissions[requestB.id]).toMatchObject({ phase: "submitting", pendingAnswer: { answer: {} } });
    await act(async () => {
      postB.reject(new TypeError("late network failure"));
      await submitB;
    });
    expect(latest?.submissions[requestB.id]).toMatchObject({ phase: "idle", pendingAnswer: null });

    await act(async () => latest?.refresh());
    expect(latest?.requests?.find((row) => row.id === revisionOne.id)?.answerRevision).toBe(1);
    expect(latest?.requests?.find((row) => row.id === terminal.id)?.status).toBe("resolved");
    expect(latest?.requests?.find((row) => row.id === claimed.id)?.status).toBe("answered");
    expect(postCalls(calls)).toHaveLength(2);
  });

  it("deadlineから回答せず、visible 30秒poll・hidden skip・cleanupと無効操作を守る", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    const past = requestRow("hd_deadline_past", { deadlineAt: 1 });
    const future = requestRow("hd_deadline_future", { deadlineAt: 4_000_000_000 });
    const immutable = answeredRow(requestRow("hd_immutable"));
    let failGets = false;
    const pendingGet = deferred<Response>();
    let holdGet = false;
    const calls = installFetch((call) => {
      if (call.method === "POST") {
        throw new Error("無効操作またはdeadlineからPOSTされました");
      }
      if (holdGet) {
        return pendingGet.promise;
      }
      return failGets
        ? jsonResponse({ error: "poll failed" }, 503)
        : jsonResponse({ requests: [past, future, immutable] });
    });
    const root = await renderProbe({ taskId: past.taskId });
    await settle();
    expect(latest?.submissions[past.id]?.canSubmit).toBe(true);
    expect(latest?.submissions[future.id]?.canSubmit).toBe(true);
    expect(postCalls(calls)).toHaveLength(0);

    act(() => vi.advanceTimersByTime(30_000));
    await settle();
    expect(getCalls(calls)).toHaveLength(2);
    hidden = true;
    act(() => vi.advanceTimersByTime(90_000));
    await settle();
    expect(getCalls(calls)).toHaveLength(2);
    expect(postCalls(calls)).toHaveLength(0);

    await act(async () => {
      await latest?.submit("hd_missing", { kind: "approval", outcome: "approve" });
      await latest?.submit(immutable.id, { kind: "approval", outcome: "approve" });
      await latest?.retrySameAnswer(past.id);
    });
    expect(postCalls(calls)).toHaveLength(0);

    failGets = true;
    await act(async () => latest?.refresh());
    expect(latest).toMatchObject({ stale: true, loading: false });
    expect(latest?.error).toContain("503");

    failGets = false;
    await act(async () => latest?.refresh());
    const uuid = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new Error("uuid unavailable");
    });
    await act(async () => latest?.submit(past.id, { kind: "approval", outcome: "approve" }));
    expect(postCalls(calls)).toHaveLength(0);
    expect(latest?.submissions[past.id]).toMatchObject({ phase: "rejected", canSubmit: true });
    uuid.mockRestore();
    await act(async () => latest?.refresh());
    expect(latest?.submissions[past.id]).toMatchObject({ phase: "rejected", canSubmit: true });

    holdGet = true;
    let cleanupRefresh: Promise<void> | undefined;
    act(() => {
      cleanupRefresh = latest?.refresh();
    });
    const cleanupSignal = getCalls(calls).at(-1)?.signal;
    await unmount(root);
    expect(cleanupSignal?.aborted).toBe(true);
    const getCount = getCalls(calls).length;
    act(() => vi.advanceTimersByTime(120_000));
    pendingGet.resolve(jsonResponse({ requests: [past] }));
    await cleanupRefresh;
    expect(getCalls(calls)).toHaveLength(getCount);
    expect(postCalls(calls)).toHaveLength(0);
  });
});
