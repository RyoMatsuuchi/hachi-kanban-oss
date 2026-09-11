import { afterEach, describe, expect, it } from "vitest";
import { makeTempHome, type TempHome } from "@hachi/testing";
import {
  createKanbanReadView,
  HumanDecisionError,
  SqliteKanbanStore,
  type ActorProvenance,
  type HachiConfig,
  type HumanDecisionReadView,
  type HumanDecisionRequestRow,
  type TaskRow,
} from "@hachi/core";
import { buildApp, type WebDeps } from "./app.js";
import type { HumanDecisionListResponse, HumanDecisionResponse } from "./shared/api-types.js";

const WRITE_TOKEN = "human-decision-web-test-token";
const JSON_WRITE_HEADERS = {
  authorization: `Bearer ${WRITE_TOKEN}`,
  "content-type": "application/json",
};

const TEST_CONFIG: HachiConfig = {
  profiles: {
    implement: { provider: "codex", model: "gpt-5.6-terra", effort: "xhigh" },
    review: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
    docs: { provider: "codex", model: "gpt-5.6-luna", effort: "high" },
  },
  allowlist: {
    codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    claude: ["claude-sonnet-5"],
  },
  resourceGuard: { maxInFlight: 2, maxLaunchesPerTick: 1 },
  defaultProfile: "implement",
};

interface Fixture {
  tempHome: TempHome;
  store: SqliteKanbanStore;
  view: ReturnType<typeof createKanbanReadView>;
  ownerProvenance: ActorProvenance;
}

const fixtureCleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of fixtureCleanups.splice(0).reverse()) {
    cleanup();
  }
});

function createFixture(): Fixture {
  const tempHome = makeTempHome();
  const store = new SqliteKanbanStore(tempHome.env.dbPath);
  const view = createKanbanReadView(tempHome.env.dbPath);
  const orchestrator = store.registerOrchestrator({
    label: "human-web-api-owner",
    project: "hachi-kanban",
    repoCommonDir: `${tempHome.env.home}/repo/.git`,
  });
  const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
  fixtureCleanups.push(() => {
    view.close();
    store.close();
    tempHome.cleanup();
  });
  return {
    tempHome,
    store,
    view,
    ownerProvenance: {
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    },
  };
}

function buildDeps(fixture: Fixture): WebDeps {
  return {
    view: fixture.view,
    store: fixture.store,
    artifactsDir: fixture.tempHome.env.artifactsDir,
    home: fixture.tempHome.env.home,
    launchdLabel: "com.hachi-kanban.human-web-api-test-nonexistent",
    bridges: fixture.tempHome.env.bridges,
    config: TEST_CONFIG,
    writeToken: WRITE_TOKEN,
    humanDecisionView: fixture.view,
    humanDecisionAnswerStore: fixture.store,
  };
}

function createTask(fixture: Fixture, tenant = "tenant-a"): TaskRow {
  return fixture.store.createTask({ title: `task-${tenant}`, body: "cwd: /tmp/test", tenant }, "tester");
}

function createDecision(
  fixture: Fixture,
  taskId: string,
  key: string,
  choices: Array<{ id: string; label: string }> = [{ id: "keep", label: "現状維持" }],
): HumanDecisionRequestRow {
  return fixture.store.createHumanDecisionRequest({
    taskId,
    kind: "decision",
    title: "方針判断",
    question: "どの方針にしますか",
    choices,
    idempotencyKey: key,
    provenance: fixture.ownerProvenance,
    now: 1_700_000_000,
  });
}

function createApproval(fixture: Fixture, taskId: string, key: string): HumanDecisionRequestRow {
  return fixture.store.createHumanDecisionRequest({
    taskId,
    kind: "approval",
    title: "公開承認",
    question: "公開してよいですか",
    action: "publish",
    targetRevision: { kind: "git_commit", value: "a".repeat(40) },
    idempotencyKey: key,
    provenance: fixture.ownerProvenance,
    now: 1_700_000_001,
  });
}

function createReview(fixture: Fixture, taskId: string, key: string): HumanDecisionRequestRow {
  return fixture.store.createHumanDecisionRequest({
    taskId,
    kind: "review",
    title: "レビュー判断",
    question: "変更を受理しますか",
    targetRevision: { kind: "sha256", value: "b".repeat(64) },
    idempotencyKey: key,
    provenance: fixture.ownerProvenance,
    now: 1_700_000_002,
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function postAnswer(
  app: ReturnType<typeof buildApp>,
  requestId: string,
  body: unknown,
  tenant?: string,
  headers: Record<string, string> = JSON_WRITE_HEADERS,
): Promise<Response> {
  const suffix = tenant === undefined ? "" : `?tenant=${encodeURIComponent(tenant)}`;
  return await app.request(`/api/human-decisions/${requestId}/answer${suffix}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("§80 human decision Web API", () => {
  it("一覧・詳細は複数依頼をdedupeせずtenant/status/task境界を適用する", async () => {
    const fixture = createFixture();
    const task = createTask(fixture, "tenant-a");
    const otherTask = createTask(fixture, "tenant-b");
    const first = createDecision(fixture, task.id, "list-first");
    const second = createApproval(fixture, task.id, "list-second");
    createReview(fixture, otherTask.id, "list-other");
    fixture.store.answerHumanDecisionRequest({
      requestId: second.id,
      expectedRevision: 0,
      answerIdempotencyKey: "list-second-answer",
      answer: { kind: "approval", outcome: "approve" },
      provenance: { kind: "human", actorId: "web-human", actorSessionId: "", actorGeneration: null },
      now: 1_700_000_010,
    });

    const deps = buildDeps(fixture);
    deps.humanDecisionAnswerStore = {
      answerHumanDecisionRequest(): never {
        throw new Error("GETからanswer storeを呼び出してはいけません");
      },
    };
    const app = buildApp(deps);

    const allResponse = await app.request("/api/human-decisions");
    expect(allResponse.status).toBe(200);
    const all = await parseJson<HumanDecisionListResponse>(allResponse);
    expect(all.requests).toHaveLength(3);
    expect(all.requests.map((request) => request.id)).toEqual(expect.arrayContaining([first.id, second.id]));

    const scopedResponse = await app.request(
      `/api/human-decisions?taskId=${task.id}&tenant=tenant-a&statuses=waiting_human,answered`,
    );
    expect(scopedResponse.status).toBe(200);
    const scoped = await parseJson<HumanDecisionListResponse>(scopedResponse);
    expect(scoped.requests.map((request) => request.id)).toEqual([first.id, second.id]);
    const answeredOnly = await parseJson<HumanDecisionListResponse>(
      await app.request(`/api/human-decisions?taskId=${task.id}&statuses=answered`),
    );
    expect(answeredOnly.requests.map((request) => request.id)).toEqual([second.id]);

    const tenantOnly = await parseJson<HumanDecisionListResponse>(
      await app.request("/api/human-decisions?tenant=tenant-b"),
    );
    expect(tenantOnly.requests).toHaveLength(1);
    expect(tenantOnly.requests[0]?.taskId).toBe(otherTask.id);
    expect((await app.request(`/api/human-decisions?taskId=${task.id}&tenant=tenant-b`)).status).toBe(404);
    expect((await app.request("/api/human-decisions?taskId=t_deadbeef")).status).toBe(404);

    for (const statuses of ["", "waiting_human,", ",answered", "unknown"]) {
      expect((await app.request(`/api/human-decisions?statuses=${statuses}`)).status).toBe(400);
    }

    const detailResponse = await app.request(`/api/human-decisions/${first.id}?tenant=tenant-a`);
    expect(detailResponse.status).toBe(200);
    expect((await parseJson<HumanDecisionResponse>(detailResponse)).request.id).toBe(first.id);
    expect((await app.request(`/api/human-decisions/${first.id}?tenant=tenant-b`)).status).toBe(404);
    expect((await app.request("/api/human-decisions/hd_0000000000000000")).status).toBe(404);
  });

  it("一覧は1000件を超えても暗黙に切り捨てない", async () => {
    const fixture = createFixture();
    const task = createTask(fixture);
    for (let index = 0; index < 1_001; index += 1) {
      createDecision(fixture, task.id, `bulk-${index}`);
    }

    const response = await buildApp(buildDeps(fixture)).request(
      `/api/human-decisions?taskId=${task.id}&tenant=tenant-a&limit=1`,
    );
    expect(response.status).toBe(200);
    expect((await parseJson<HumanDecisionListResponse>(response)).requests).toHaveLength(1_001);
  });

  it("4種類の型付きanswerを実Storeへ保存しtask全field・周辺状態を変更しない", async () => {
    const fixture = createFixture();
    const task = createTask(fixture);
    fixture.store.addComment(task.id, "tester", "既存コメント");
    fixture.store.addEvent(task.id, "test_event", "tester", { stable: true });
    const approval = createApproval(fixture, task.id, "answer-approval");
    const review = createReview(fixture, task.id, "answer-review");
    const choice = createDecision(fixture, task.id, "answer-choice");
    const freeText = createDecision(fixture, task.id, "answer-text", []);
    const beforeTask = fixture.view.task(task.id);
    const beforeEvents = fixture.view.events(task.id);
    const beforeComments = fixture.view.comments(task.id);
    const beforeRuns = fixture.view.runs(task.id);
    const app = buildApp(buildDeps(fixture));

    const cases: Array<{
      request: HumanDecisionRequestRow;
      key: string;
      answer: object;
      expected: object;
    }> = [
      {
        request: approval,
        key: "web-approval",
        answer: { kind: "approval", outcome: "approve" },
        expected: { kind: "approval", outcome: "approve" },
      },
      {
        request: review,
        key: "web-review",
        answer: { kind: "review", outcome: "changes_requested" },
        expected: { kind: "review", outcome: "changes_requested" },
      },
      {
        request: choice,
        key: "web-choice",
        answer: { kind: "decision", choiceId: "keep" },
        expected: { kind: "decision", choiceId: "keep" },
      },
      {
        request: freeText,
        key: "web-text",
        answer: { kind: "decision", text: "別案で進める" },
        expected: { kind: "decision", text: "別案で進める" },
      },
    ];

    for (const testCase of cases) {
      const response = await postAnswer(app, testCase.request.id, {
        expectedRevision: 0,
        answerIdempotencyKey: testCase.key,
        answer: testCase.answer,
        comment: "Webから回答",
      }, "tenant-a");
      expect(response.status).toBe(200);
      const body = await parseJson<HumanDecisionResponse>(response);
      expect(body.request).toMatchObject({
        id: testCase.request.id,
        status: "answered",
        answerRevision: 1,
        answer: testCase.expected,
        answerComment: "Webから回答",
        answerProvenance: {
          kind: "human",
          actorId: "web-human",
          actorSessionId: "",
          actorGeneration: null,
        },
      });
      expect(fixture.view.getHumanDecisionRequest(testCase.request.id)).toEqual(body.request);
    }

    expect(fixture.view.task(task.id)).toEqual(beforeTask);
    expect(fixture.view.events(task.id)).toEqual(beforeEvents);
    expect(fixture.view.comments(task.id)).toEqual(beforeComments);
    expect(fixture.view.runs(task.id)).toEqual(beforeRuns);
  });

  it("claimed/resolved後も同じanswer retryをCoreへ委ねて収束させる", async () => {
    const fixture = createFixture();
    const task = createTask(fixture);
    const request = createDecision(fixture, task.id, "retry-request");
    const app = buildApp(buildDeps(fixture));
    const body = {
      expectedRevision: 0,
      answerIdempotencyKey: "retry-answer",
      answer: { kind: "decision", choiceId: "keep" },
      comment: "同じ回答",
    };
    expect((await postAnswer(app, request.id, body)).status).toBe(200);

    const now = Math.floor(Date.now() / 1000) + 1;
    fixture.store.claimHumanDecisionResponse({
      requestId: request.id,
      expectedRevision: 1,
      claimToken: "retry-claim-token",
      leaseUntil: now + 100,
      provenance: fixture.ownerProvenance,
      now,
    });
    const claimedRetry = await postAnswer(app, request.id, body);
    expect(claimedRetry.status).toBe(200);
    const claimedRequest = (await parseJson<HumanDecisionResponse>(claimedRetry)).request;
    expect(claimedRequest.status).toBe("claimed");
    expect(claimedRequest).not.toHaveProperty("claimToken");
    expect(claimedRequest).not.toHaveProperty("claimTokenHash");

    fixture.store.resolveHumanDecisionResponse({
      requestId: request.id,
      expectedRevision: 1,
      claimToken: "retry-claim-token",
      resolution: { outcome: "handled" },
      provenance: fixture.ownerProvenance,
      now: now + 1,
    });
    const resolvedRetry = await postAnswer(app, request.id, body);
    expect(resolvedRetry.status).toBe(200);
    expect((await parseJson<HumanDecisionResponse>(resolvedRetry)).request.status).toBe("resolved");
  });

  it("answer/cancel競合は片方だけを成功させHTTPと実状態を一致させる", async () => {
    const fixture = createFixture();
    const task = createTask(fixture);
    const answerWins = createDecision(fixture, task.id, "answer-wins");
    const cancelWins = createDecision(fixture, task.id, "cancel-wins");
    const app = buildApp(buildDeps(fixture));

    expect((await postAnswer(app, answerWins.id, {
      expectedRevision: 0,
      answerIdempotencyKey: "answer-wins-key",
      answer: { kind: "decision", choiceId: "keep" },
    })).status).toBe(200);
    expect(() => fixture.store.cancelHumanDecisionRequest({
      requestId: answerWins.id,
      expectedRevision: 0,
      reason: "late cancel",
      provenance: fixture.ownerProvenance,
    })).toThrow(/REVISION_CONFLICT/);

    fixture.store.cancelHumanDecisionRequest({
      requestId: cancelWins.id,
      expectedRevision: 0,
      reason: "cancel wins",
      provenance: fixture.ownerProvenance,
    });
    expect((await postAnswer(app, cancelWins.id, {
      expectedRevision: 0,
      answerIdempotencyKey: "late-answer",
      answer: { kind: "decision", choiceId: "keep" },
    })).status).toBe(409);
    expect(fixture.view.getHumanDecisionRequest(answerWins.id)).toMatchObject({ status: "answered" });
    expect(fixture.view.getHumanDecisionRequest(cancelWins.id)).toMatchObject({ status: "cancelled", answerRevision: 0 });
  });

  it("Bearer・same-origin拒否とtenant不一致はmutation 0にする", async () => {
    const fixture = createFixture();
    const task = createTask(fixture);
    const request = createDecision(fixture, task.id, "auth-request");
    const app = buildApp(buildDeps(fixture));
    const body = {
      expectedRevision: 0,
      answerIdempotencyKey: "auth-answer",
      answer: { kind: "decision", choiceId: "keep" },
    };

    expect((await postAnswer(app, request.id, body, undefined, { "content-type": "application/json" })).status)
      .toBe(401);
    expect((await postAnswer(app, request.id, body, undefined, {
      authorization: "Bearer wrong-token",
      "content-type": "application/json",
    })).status).toBe(401);
    expect((await postAnswer(app, request.id, body, undefined, {
      ...JSON_WRITE_HEADERS,
      "sec-fetch-site": "cross-site",
    })).status).toBe(403);
    expect((await postAnswer(app, request.id, body, "tenant-b")).status).toBe(404);
    expect(fixture.view.getHumanDecisionRequest(request.id)).toMatchObject({
      status: "waiting_human",
      answerRevision: 0,
      answer: null,
    });
  });

  it("array・余分field・invalid answer・stale retryを400/409で拒否する", async () => {
    const fixture = createFixture();
    const task = createTask(fixture);
    const request = createApproval(fixture, task.id, "invalid-request");
    const app = buildApp(buildDeps(fixture));
    const invalidBodies: unknown[] = [
      [],
      {
        expectedRevision: 0,
        answerIdempotencyKey: "invalid",
        answer: { kind: "approval", outcome: "approve" },
        extra: true,
      },
      { expectedRevision: 0, answerIdempotencyKey: "invalid", answer: [] },
      {
        expectedRevision: 0,
        answerIdempotencyKey: "invalid",
        answer: { kind: "approval", outcome: "approve", extra: true },
      },
      {
        expectedRevision: 0,
        answerIdempotencyKey: "invalid",
        answer: { kind: "approval", outcome: "unknown" },
      },
      {
        expectedRevision: 0,
        answerIdempotencyKey: "invalid",
        answer: { kind: "decision", choiceId: "keep", text: "both" },
      },
      {
        expectedRevision: 0,
        answerIdempotencyKey: "invalid",
        answer: { kind: "decision", choiceId: "keep" },
      },
      {
        expectedRevision: 1,
        answerIdempotencyKey: "invalid",
        answer: { kind: "approval", outcome: "approve" },
      },
      {
        expectedRevision: 0,
        answerIdempotencyKey: "invalid",
        answer: { kind: "approval", outcome: "approve" },
        comment: 1,
      },
    ];
    for (const body of invalidBodies) {
      expect((await postAnswer(app, request.id, body)).status).toBe(400);
    }
    expect(fixture.view.getHumanDecisionRequest(request.id)).toMatchObject({ status: "waiting_human" });

    const successBody = {
      expectedRevision: 0,
      answerIdempotencyKey: "saved-answer",
      answer: { kind: "approval", outcome: "approve" },
    };
    expect((await postAnswer(app, request.id, successBody)).status).toBe(200);
    expect((await postAnswer(app, request.id, {
      ...successBody,
      answerIdempotencyKey: "different-answer",
    })).status).toBe(409);
    expect(fixture.view.getHumanDecisionRequest(request.id)).toMatchObject({
      status: "answered",
      answer: { kind: "approval", outcome: "approve" },
    });
  });

  it("未注入・schema未適用は503、未知例外は生messageを隠した500にする", async () => {
    const fixture = createFixture();
    const task = createTask(fixture);
    const request = createDecision(fixture, task.id, "degrade-request");

    const missingDeps = buildDeps(fixture);
    delete missingDeps.humanDecisionView;
    delete missingDeps.humanDecisionAnswerStore;
    const missingApp = buildApp(missingDeps);
    expect((await missingApp.request("/api/human-decisions")).status).toBe(503);
    expect((await missingApp.request(`/api/human-decisions/${request.id}`)).status).toBe(503);
    expect((await postAnswer(missingApp, request.id, {
      expectedRevision: 0,
      answerIdempotencyKey: "missing",
      answer: { kind: "decision", choiceId: "keep" },
    })).status).toBe(503);

    const schemaUnavailable: HumanDecisionReadView = {
      getHumanDecisionRequest(): never {
        throw new HumanDecisionError("SCHEMA_UNAVAILABLE", "migration v32が未適用です");
      },
      listHumanDecisionRequests(): never {
        throw new HumanDecisionError("SCHEMA_UNAVAILABLE", "migration v32が未適用です");
      },
      listHumanDecisionResponses(): never {
        throw new HumanDecisionError("SCHEMA_UNAVAILABLE", "migration v32が未適用です");
      },
    };
    const schemaDeps = buildDeps(fixture);
    schemaDeps.humanDecisionView = schemaUnavailable;
    const schemaApp = buildApp(schemaDeps);
    expect((await schemaApp.request("/api/human-decisions")).status).toBe(503);
    expect((await schemaApp.request(`/api/human-decisions/${request.id}`)).status).toBe(503);
    expect((await postAnswer(schemaApp, request.id, {
      expectedRevision: 0,
      answerIdempotencyKey: "schema",
      answer: { kind: "decision", choiceId: "keep" },
    })).status).toBe(503);

    const unknownFailure: HumanDecisionReadView = {
      getHumanDecisionRequest(): never {
        throw new Error("secret SQL and credential details");
      },
      listHumanDecisionRequests(): never {
        throw new Error("secret SQL and credential details");
      },
      listHumanDecisionResponses(): never {
        throw new Error("secret SQL and credential details");
      },
    };
    const unknownDeps = buildDeps(fixture);
    unknownDeps.humanDecisionView = unknownFailure;
    const unknownResponse = await buildApp(unknownDeps).request("/api/human-decisions");
    expect(unknownResponse.status).toBe(500);
    expect(await unknownResponse.text()).not.toContain("secret SQL");
  });
});
