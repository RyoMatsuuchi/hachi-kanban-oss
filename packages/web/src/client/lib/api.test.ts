// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanDecisionRequestRow, TaskRow } from "@hachi/core";
import type {
  HumanDecisionAnswerRequest,
  HumanDecisionResponse,
  RuntimeResourcesResponse,
  ScheduleWithNextFire,
  ScheduleWriteRequest,
} from "../../shared/api-types.js";
import {
  WRITE_TOKEN_STORAGE_KEY,
  clearStoredWriteToken,
  deleteSchedule,
  fetchHumanDecision,
  fetchHumanDecisions,
  fetchTaskDetail,
  fetchRuntimeResources,
  postHumanDecisionAnswer,
  postSchedule,
  putConfig,
  setWriteTokenPrompt,
  unwatchTask,
  watchTask,
} from "./api.js";

interface CapturedFetch {
  path: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: string | null;
  signal: AbortSignal | null;
}

const SCHEDULE_ID = "s_0000000000000001";

const SCHEDULE_REQUEST: ScheduleWriteRequest = {
  name: "daily",
  cadenceKind: "daily",
  at: "09:00",
  cwd: "/tmp/hk-scheduler",
  prompt: "run",
};

const SCHEDULE_RESPONSE: ScheduleWithNextFire = {
  id: SCHEDULE_ID,
  name: "daily",
  enabled: true,
  cadenceKind: "daily",
  atHour: 9,
  atMinute: 0,
  weekday: null,
  dayOfMonth: null,
  runDate: null,
  tenant: "",
  profile: "",
  cwd: "/tmp/hk-scheduler",
  prompt: "run",
  priority: 0,
  lastRunAt: null,
  lastTaskId: null,
  consecutiveFailures: 0,
  autoDisabledReason: "",
  createdAt: 1,
  updatedAt: 1,
  nextFireAt: 2,
};

const TASK_RESPONSE: TaskRow = {
  id: "t_00000001",
  title: "watch target",
  body: "",
  status: "ready",
  priority: 0,
  tenant: "dev",
  assignee: "",
  provider: "",
  profile: "",
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
  watched: true,
  consecutiveFailures: 0,
  lastFailureError: "",
  lastHeartbeatAt: null,
  maxRetries: 3,
  createdAt: 1,
  updatedAt: 1,
  startedAt: null,
  completedAt: null,
};

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

const HUMAN_DECISION_REQUEST: HumanDecisionRequestRow = {
  id: "hd_0000000000000001",
  taskId: "t_00000001",
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

function humanDecisionRequest(
  id: string,
  overrides: Partial<HumanDecisionRequestRow> = {},
): HumanDecisionRequestRow {
  return { ...HUMAN_DECISION_REQUEST, id, ...overrides };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(
  handler: (call: CapturedFetch, index: number) => Response | Promise<Response>,
): CapturedFetch[] {
  const calls: CapturedFetch[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      const call: CapturedFetch = {
        path: input instanceof Request ? input.url : String(input),
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
        contentType: headers.get("content-type"),
        body: typeof init?.body === "string" ? init.body : null,
        signal: init?.signal ?? null,
      };
      calls.push(call);
      return Promise.resolve(handler(call, calls.length - 1));
    }),
  );
  return calls;
}

describe("human decision client API", () => {
  afterEach(() => {
    setWriteTokenPrompt(null);
    clearStoredWriteToken();
    vi.unstubAllGlobals();
  });

  it("一覧envelopeとquery scopeを省略・dedupeせず保持する", async () => {
    const controller = new AbortController();
    const requests = [
      humanDecisionRequest("hd_0000000000000001"),
      humanDecisionRequest("hd_0000000000000002", {
        kind: "review",
        title: "レビュー結果を確認する",
        action: null,
        defaultOutcome: "not_accepted",
        status: "answered",
        answerRevision: 1,
        answer: { kind: "review", outcome: "accepted" },
        answerProvenance: HUMAN_PROVENANCE,
        answeredAt: 2,
        updatedAt: 2,
      }),
    ];
    const calls = stubFetch(() => jsonResponse({ requests }, 200));

    const allResponse = await fetchHumanDecisions({}, controller.signal);
    const scopedResponse = await fetchHumanDecisions({
      taskId: "t_ 日本 & 1",
      tenant: " tenant 日本& ",
      statuses: ["answered", "waiting_human"],
    });
    await fetchHumanDecisions({ taskId: "", tenant: "", statuses: [] });

    expect(allResponse).toEqual({ requests });
    expect(allResponse.requests).toHaveLength(2);
    expect(allResponse.requests.map((request) => [request.id, request.status])).toEqual([
      ["hd_0000000000000001", "waiting_human"],
      ["hd_0000000000000002", "answered"],
    ]);
    expect(scopedResponse.requests).toHaveLength(2);
    expect(calls[0]?.path).toBe("/api/human-decisions");
    expect(calls[0]?.signal).toBe(controller.signal);

    const scopedUrl = new URL(calls[1]?.path ?? "", "http://hachi.test");
    expect(scopedUrl.pathname).toBe("/api/human-decisions");
    expect(Array.from(scopedUrl.searchParams.keys())).toEqual(["taskId", "tenant", "statuses"]);
    expect(scopedUrl.searchParams.get("taskId")).toBe("t_ 日本 & 1");
    expect(scopedUrl.searchParams.get("tenant")).toBe(" tenant 日本& ");
    expect(scopedUrl.searchParams.get("statuses")).toBe("answered,waiting_human");
    expect(scopedUrl.searchParams.has("limit")).toBe(false);
    expect(calls[2]?.path).toBe("/api/human-decisions?taskId=");
  });

  it("詳細GETでencoded ID・tenant・AbortSignal・AbortErrorを保持する", async () => {
    const response = { request: HUMAN_DECISION_REQUEST };
    const abortError = new DOMException("aborted", "AbortError");
    const firstController = new AbortController();
    const secondController = new AbortController();
    const calls = stubFetch((call, index) => {
      if (index === 0) {
        return jsonResponse(response, 200);
      }
      return new Promise<Response>((_resolve, reject) => {
        call.signal?.addEventListener("abort", () => reject(abortError), { once: true });
      });
    });

    await expect(fetchHumanDecision("hd_/日本?&", "tenant 日本&", firstController.signal)).resolves.toEqual(response);
    const abortedRequest = fetchHumanDecision("hd_abort", undefined, secondController.signal);
    secondController.abort();

    await expect(abortedRequest).rejects.toBe(abortError);
    const detailUrl = new URL(calls[0]?.path ?? "", "http://hachi.test");
    expect(detailUrl.pathname).toBe(`/api/human-decisions/${encodeURIComponent("hd_/日本?&")}`);
    expect(detailUrl.searchParams.get("tenant")).toBe("tenant 日本&");
    expect(calls[0]?.signal).toBe(firstController.signal);
    expect(calls[1]?.path).toBe("/api/human-decisions/hd_abort");
    expect(calls[1]?.signal).toBe(secondController.signal);
  });

  it("4種の回答body・呼出元keyとanswered/claimed/resolved envelopeを変更しない", async () => {
    const requestBodies: HumanDecisionAnswerRequest[] = [
      {
        expectedRevision: 0,
        answerIdempotencyKey: "answer-approval",
        answer: { kind: "approval", outcome: "approve" },
        comment: "承認します",
      },
      {
        expectedRevision: 0,
        answerIdempotencyKey: "answer-review",
        answer: { kind: "review", outcome: "changes_requested" },
        comment: null,
      },
      {
        expectedRevision: 0,
        answerIdempotencyKey: "answer-choice",
        answer: { kind: "decision", choiceId: "choice-a" },
      },
      {
        expectedRevision: 0,
        answerIdempotencyKey: "answer-text",
        answer: { kind: "decision", text: "現状を維持する" },
        comment: "自由回答",
      },
    ];
    const responseRequests = [
      humanDecisionRequest("hd_/approval", {
        status: "answered",
        answerRevision: 1,
        answer: requestBodies[0]?.answer ?? null,
        answerComment: "承認します",
        answerProvenance: HUMAN_PROVENANCE,
        answeredAt: 2,
        updatedAt: 2,
      }),
      humanDecisionRequest("hd_review", {
        kind: "review",
        action: null,
        defaultOutcome: "not_accepted",
        status: "claimed",
        answerRevision: 1,
        answer: requestBodies[1]?.answer ?? null,
        answerProvenance: HUMAN_PROVENANCE,
        answeredAt: 3,
        claimantOrchestratorId: "os_0000000000000001",
        claimantSessionId: "os_session_1",
        claimantGeneration: 1,
        claimLeaseUntil: 100,
        updatedAt: 3,
      }),
      humanDecisionRequest("hd_choice", {
        kind: "decision",
        action: null,
        targetRevision: null,
        choices: [{ id: "choice-a", label: "選択肢A" }],
        defaultOutcome: "retain_current_state",
        status: "resolved",
        answerRevision: 1,
        answer: requestBodies[2]?.answer ?? null,
        answerProvenance: HUMAN_PROVENANCE,
        answeredAt: 4,
        resolution: { outcome: "handled" },
        resolveProvenance: ORCHESTRATOR_PROVENANCE,
        resolvedAt: 10,
        updatedAt: 10,
      }),
      humanDecisionRequest("hd_text", {
        kind: "decision",
        action: null,
        targetRevision: null,
        defaultOutcome: "retain_current_state",
        status: "answered",
        answerRevision: 1,
        answer: requestBodies[3]?.answer ?? null,
        answerComment: "自由回答",
        answerProvenance: HUMAN_PROVENANCE,
        answeredAt: 5,
        updatedAt: 5,
      }),
    ];
    const calls = stubFetch((_call, index) => jsonResponse({ request: responseRequests[index] }, 200));

    const responses: HumanDecisionResponse[] = [];
    for (const [index, requestBody] of requestBodies.entries()) {
      const responseRequest = responseRequests[index];
      if (responseRequest === undefined) {
        throw new Error("response fixture is missing");
      }
      responses.push(
        await postHumanDecisionAnswer(responseRequest.id, requestBody, index === 0 ? "tenant 日本&" : undefined),
      );
    }

    expect(responses.map((response) => response.request.status)).toEqual(["answered", "claimed", "resolved", "answered"]);
    expect(responses.map((response) => response.request.id)).toEqual(responseRequests.map((request) => request.id));
    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "POST", "POST"]);
    expect(calls.map((call) => JSON.parse(call.body ?? "null"))).toEqual(requestBodies);
    expect(
      calls.map(
        (call) => (JSON.parse(call.body ?? "null") as HumanDecisionAnswerRequest).answerIdempotencyKey,
      ),
    ).toEqual(["answer-approval", "answer-review", "answer-choice", "answer-text"]);
    const answerUrl = new URL(calls[0]?.path ?? "", "http://hachi.test");
    expect(answerUrl.pathname).toBe(`/api/human-decisions/${encodeURIComponent("hd_/approval")}/answer`);
    expect(answerUrl.searchParams.get("tenant")).toBe("tenant 日本&");
    expect(calls[1]?.path).toBe("/api/human-decisions/hd_review/answer");
  });

  it("回答401では同じpath・serialized body・keyで認証headerだけ加えて1回retryする", async () => {
    const requestBody: HumanDecisionAnswerRequest = {
      expectedRevision: 0,
      answerIdempotencyKey: "answer-retry-key",
      answer: { kind: "approval", outcome: "reject" },
      comment: "見送ります",
    };
    const response = humanDecisionRequest("hd_retry", {
      status: "answered",
      answerRevision: 1,
      answer: requestBody.answer,
      answerProvenance: HUMAN_PROVENANCE,
      answeredAt: 2,
      updatedAt: 2,
    });
    const calls = stubFetch((call) =>
      call.authorization === "Bearer human-token"
        ? jsonResponse({ request: response }, 200)
        : jsonResponse({ error: "write authorization required" }, 401),
    );
    setWriteTokenPrompt(() => Promise.resolve("human-token"));

    await expect(postHumanDecisionAnswer("hd_retry", requestBody, "tenant-a")).resolves.toEqual({ request: response });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe(calls[1]?.path);
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(calls[0]?.contentType).toBe("application/json");
    expect(calls[1]?.contentType).toBe("application/json");
    expect(
      (JSON.parse(calls[1]?.body ?? "null") as HumanDecisionAnswerRequest).answerIdempotencyKey,
    ).toBe("answer-retry-key");
    expect(calls[0]?.authorization).toBeNull();
    expect(calls[1]?.authorization).toBe("Bearer human-token");
  });

  it("回答retryの2回目も401なら追加prompt・追加fetchなしで失敗する", async () => {
    const calls = stubFetch(() => jsonResponse({ error: "write authorization required" }, 401));
    let promptCalls = 0;
    setWriteTokenPrompt(() => {
      promptCalls += 1;
      return Promise.resolve("wrong-token");
    });

    await expect(
      postHumanDecisionAnswer("hd_retry", {
        expectedRevision: 0,
        answerIdempotencyKey: "answer-second-401",
        answer: { kind: "review", outcome: "accepted" },
      }),
    ).rejects.toMatchObject({ status: 401 });

    expect(promptCalls).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("回答401でtoken入力をcancelした場合は再送しない", async () => {
    const calls = stubFetch(() => jsonResponse({ error: "write authorization required" }, 401));
    setWriteTokenPrompt(() => Promise.resolve(null));

    await expect(
      postHumanDecisionAnswer("hd_cancel", {
        expectedRevision: 0,
        answerIdempotencyKey: "answer-cancel-token",
        answer: { kind: "decision", text: "保留" },
      }),
    ).rejects.toMatchObject({ status: 401 });

    expect(calls).toHaveLength(1);
  });

  it("GET 503・POST 409・network failureを成功にせず再送もしない", async () => {
    const getCalls = stubFetch(() => jsonResponse({ error: "schema unavailable" }, 503));
    await expect(fetchHumanDecisions()).rejects.toMatchObject({ status: 503 });
    expect(getCalls).toHaveLength(1);

    const requestBody: HumanDecisionAnswerRequest = {
      expectedRevision: 0,
      answerIdempotencyKey: "answer-conflict",
      answer: { kind: "approval", outcome: "approve" },
    };
    const conflictCalls = stubFetch(() => jsonResponse({ error: "revision conflict" }, 409));
    await expect(postHumanDecisionAnswer("hd_conflict", requestBody)).rejects.toMatchObject({ status: 409 });
    expect(conflictCalls).toHaveLength(1);

    const networkError = new TypeError("network unavailable");
    const networkCalls = stubFetch(() => Promise.reject(networkError));
    await expect(postHumanDecisionAnswer("hd_network", requestBody)).rejects.toBe(networkError);
    expect(networkCalls).toHaveLength(1);
  });
});

function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("write API auth fetch wrapper", () => {
  afterEach(() => {
    setWriteTokenPrompt(null);
    clearStoredWriteToken();
    vi.unstubAllGlobals();
  });

  it("旧task detail responseのadditive lifecycle欠落を空配列へ正規化する", async () => {
    const calls = stubFetch(() => jsonResponse({ task: TASK_RESPONSE }, 200));

    const response = await fetchTaskDetail(TASK_RESPONSE.id);

    expect(response.cancelRequests).toEqual([]);
    expect(response.steerDeliveries).toEqual([]);
    expect(calls[0]?.path).toBe(`/api/task/${TASK_RESPONSE.id}`);
  });

  it("write 401 で token 入力を求め、保存して元リクエストを 1 回リトライする", async () => {
    const calls = stubFetch((call) =>
      call.authorization === "Bearer web-secret"
        ? jsonResponse({ schedule: SCHEDULE_RESPONSE }, 201)
        : jsonResponse({ error: "write authorization required" }, 401),
    );
    let promptCalls = 0;
    setWriteTokenPrompt(() => {
      promptCalls += 1;
      return Promise.resolve("web-secret");
    });

    const schedule = await postSchedule(SCHEDULE_REQUEST);

    expect(schedule.id).toBe(SCHEDULE_ID);
    expect(promptCalls).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.authorization).toBeNull();
    expect(calls[1]?.authorization).toBe("Bearer web-secret");
    expect(localStorage.getItem(WRITE_TOKEN_STORAGE_KEY)).toBe("web-secret");
  });

  it("保存済み token は以降の write に常に付与する", async () => {
    localStorage.setItem(WRITE_TOKEN_STORAGE_KEY, "stored-token");
    const calls = stubFetch(() => jsonResponse({ deleted: true, id: SCHEDULE_ID }, 200));
    setWriteTokenPrompt(() => Promise.reject(new Error("prompt must not be called")));

    await deleteSchedule(SCHEDULE_ID);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe("Bearer stored-token");
  });

  it("同時 401 でも token 入力は 1 回だけ表示し、各リクエストを 1 回ずつリトライする", async () => {
    const calls = stubFetch((call) =>
      call.authorization === "Bearer shared-token"
        ? jsonResponse({ deleted: true, id: SCHEDULE_ID }, 200)
        : jsonResponse({ error: "write authorization required" }, 401),
    );
    let promptCalls = 0;
    let resolvePrompt: ((token: string | null) => void) | undefined;
    setWriteTokenPrompt(
      () =>
        new Promise<string | null>((resolve) => {
          promptCalls += 1;
          resolvePrompt = resolve;
        }),
    );

    const first = deleteSchedule(SCHEDULE_ID);
    const second = deleteSchedule("s_0000000000000002");
    await waitForMicrotasks();
    expect(promptCalls).toBe(1);

    resolvePrompt?.("shared-token");
    await Promise.all([first, second]);

    expect(calls).toHaveLength(4);
    expect(calls.filter((call) => call.authorization === "Bearer shared-token")).toHaveLength(2);
  });

  it("リトライ後も 401 なら再入力せず ApiError として失敗する", async () => {
    const calls = stubFetch(() => jsonResponse({ error: "write authorization required" }, 401));
    let promptCalls = 0;
    setWriteTokenPrompt(() => {
      promptCalls += 1;
      return Promise.resolve("wrong-token");
    });

    await expect(deleteSchedule(SCHEDULE_ID)).rejects.toMatchObject({ status: 401 });

    expect(promptCalls).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.authorization).toBe("Bearer wrong-token");
  });

  it("watch/unwatch は write token を付けて正しい method で送る", async () => {
    localStorage.setItem(WRITE_TOKEN_STORAGE_KEY, "stored-token");
    const calls = stubFetch((call) => {
      if (call.method === "POST") {
        return jsonResponse({ task: TASK_RESPONSE }, 200);
      }
      return jsonResponse({ task: { ...TASK_RESPONSE, watched: false } }, 200);
    });

    const watched = await watchTask(TASK_RESPONSE.id);
    const unwatched = await unwatchTask(TASK_RESPONSE.id);

    expect(watched.watched).toBe(true);
    expect(unwatched.watched).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      path: `/api/tasks/${TASK_RESPONSE.id}/watch`,
      method: "POST",
      authorization: "Bearer stored-token",
    });
    expect(calls[1]).toMatchObject({
      path: `/api/tasks/${TASK_RESPONSE.id}/watch`,
      method: "DELETE",
      authorization: "Bearer stored-token",
    });
  });
});

describe("putConfig の失敗理由の伝達", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("400 body の error/issues を ApiError へ載せる（allowlist 違反など）", async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: "config.json の検証に失敗しました",
          issues: ["profiles.implement.model が allowlist 外です（provider=codex）: claude-sonnet-5"],
        },
        400,
      ),
    );

    await expect(putConfig({ config: {}, baseEtag: null })).rejects.toMatchObject({
      status: 400,
      message: "config.json の検証に失敗しました",
      issues: ["profiles.implement.model が allowlist 外です（provider=codex）: claude-sonnet-5"],
    });
  });

  it("400 body が JSON でない場合はフォールバックの汎用メッセージへ倒し issues は undefined になる", async () => {
    stubFetch(() => new Response("not json", { status: 400 }));

    await expect(putConfig({ config: {}, baseEtag: null })).rejects.toMatchObject({
      status: 400,
      message: "API リクエストに失敗しました (400): /api/config",
      issues: undefined,
    });
  });

  it("body が JSON でも issues を含まない場合は issues が undefined になる", async () => {
    stubFetch(() => jsonResponse({ error: "内部エラー" }, 400));

    await expect(putConfig({ config: {}, baseEtag: null })).rejects.toMatchObject({
      status: 400,
      message: "内部エラー",
      issues: undefined,
    });
  });

  it("409（etag 競合）は従来どおり status のみで扱えるよう message も維持する", async () => {
    stubFetch(() =>
      jsonResponse({ error: "baseEtag が現在の config.json と一致しません", currentEtag: "etag-x" }, 409),
    );

    await expect(putConfig({ config: {}, baseEtag: "stale" })).rejects.toMatchObject({
      status: 409,
      message: "baseEtag が現在の config.json と一致しません",
    });
  });
});

describe("runtime resource fetch wrapper", () => {
  it("readonly endpoint を typed response として取得する", async () => {
    const fixture: RuntimeResourcesResponse = {
      generatedAt: 123,
      summary: {
        total: 0,
        byState: { requested: 0, provisioning: 0, active: 0, cleanup_pending: 0, expired: 0, releasing: 0, released: 0, quarantined: 0, failed: 0, cancelled: 0, unknown: 0 },
        active: 0,
        stale: 0,
        expired: 0,
        cleanupPending: 0,
        quarantined: 0,
        legacyNever: 0,
      },
      leases: [],
    };
    const calls = stubFetch(() => jsonResponse(fixture, 200));
    await expect(fetchRuntimeResources()).resolves.toEqual(fixture);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/api/runtime-resources", method: "GET", authorization: null });
  });
});
