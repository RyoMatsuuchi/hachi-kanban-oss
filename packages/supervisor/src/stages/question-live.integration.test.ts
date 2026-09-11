import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeAgentMessage } from "@hachi/core";
import type { AgentMessageV1, OrchestratorSessionRow, TaskRow } from "@hachi/core";
import { taskInput } from "@hachi/testing";
import { FakeAdapter, setupHarness, type TestHarness } from "../test-support.js";
import { dispatchStage } from "./dispatch.js";
import { finalizeStage } from "./finalize.js";
import { messagesStage } from "./messages.js";
import { monitorStage } from "./monitor.js";
import { createReapStage } from "./reap.js";

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function handoff(taskId: string, outcome: "done" | "question", summary: string, context?: string): string {
  return [
    "作業ログ",
    "```hachi-handoff-v1",
    JSON.stringify({
      taskId,
      outcome,
      summary,
      ...(context !== undefined ? { context } : {}),
    }),
    "```",
  ].join("\n");
}

function answerMessage(taskId: string, text: string, idempotencyKey: string): AgentMessageV1 {
  return {
    schema: "agent.message.v1",
    from: { role: "human", provider: "", sessionId: "" },
    to: { role: "worker", taskId },
    intent: "answer",
    payload: { message: text },
    idempotencyKey,
    createdAt: Date.now(),
  };
}

function parsePayload(payload: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(payload);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("event payload が object ではありません");
  }
  return parsed as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function promptBodies(harness: TestHarness): Record<string, unknown>[] {
  return harness.codexBridge.requests
    .filter((request) => request.method === "POST" && request.path === "/api/prompt")
    .map((request) => request.body)
    .filter(isRecord);
}

function registerOrchestrator(task: TaskRow, harness: TestHarness): OrchestratorSessionRow {
  const orchestrator = harness.store.registerOrchestrator({
    label: `integration-${task.id}`,
    project: task.tenant,
    repoCommonDir: "",
  });
  harness.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
  return harness.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
}

function authorizeAnswer(
  task: TaskRow,
  session: OrchestratorSessionRow,
  harness: TestHarness,
  idempotencyKey: string,
): void {
  const request = harness.store.getActiveOrchestratorRequestByTask(task.id);
  if (request === null) {
    throw new Error("orchestrator request が作成されませんでした");
  }
  const claimToken = `claim-${idempotencyKey}`;
  harness.store.claimOrchestratorRequest({
    requestId: request.id,
    sessionId: session.id,
    generation: session.generation,
    claimToken,
    leaseUntil: now() + 120,
  });
  harness.store.beginOrchestratorRequestAnswer({
    requestId: request.id,
    sessionId: session.id,
    generation: session.generation,
    claimToken,
    answerKey: idempotencyKey,
  });
}

describe("worker question live integration（docs/contract.md §52.4）", () => {
  let harness: TestHarness;
  let tmpCwd: string;

  beforeEach(async () => {
    tmpCwd = mkdtempSync(join(tmpdir(), "hk-question-live-"));
    harness = await setupHarness();
    Object.assign(harness.deps.config, { notify: { transports: [] } });
  });

  afterEach(async () => {
    await harness.cleanup();
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  async function createBridgeQuestionAwaitingTask(
    title: string,
  ): Promise<{ task: TaskRow; sessionId: string; orchestratorSession: OrchestratorSessionRow }> {
    const task = harness.store.createTask(
      // worker の done 申告で done へ直行させる（§76 既定 required の review 遷移を避ける）
      taskInput({ status: "ready", title, body: `cwd: ${tmpCwd}\nreview-policy: worker-outcome\n本文` }),
      "tester",
    );
    const orchestratorSession = registerOrchestrator(task, harness);
    const startedAt = now();

    const dispatchResult = await dispatchStage.tick(harness.deps, true, startedAt);
    expect(dispatchResult.actions).toBe(1);

    const sessionId = harness.codexBridge.sessions()[0];
    if (sessionId === undefined) {
      throw new Error("MockBridgeServer が sessionId を発行しませんでした");
    }

    harness.codexBridge.completeSession(
      sessionId,
      handoff(task.id, "question", "外部仕様の確認が必要です。回答してください", "live integration"),
    );

    const firstMonitor = await monitorStage.tick(harness.deps, true, startedAt + 1);
    expect(firstMonitor.actions).toBe(1);
    const confirmedMonitor = await monitorStage.tick(harness.deps, true, startedAt + 61);
    expect(confirmedMonitor.actions).toBe(1);

    const firstFinalize = await finalizeStage.tick(harness.deps, true, startedAt + 62);
    expect(firstFinalize.actions).toBe(1);

    const waitingTask = harness.store.getTask(task.id);
    expect(waitingTask?.status).toBe("blocked");
    expect(waitingTask?.blockReason).toContain("worker-question:");

    return { task, sessionId, orchestratorSession };
  }

  it("bridge は question→awaiting→answer inject→同一 session 継続→done finalize まで通る", async () => {
    const { task, sessionId, orchestratorSession } = await createBridgeQuestionAwaitingTask("live bridge task");
    const awaiting = harness.store.listEvents(task.id, "question_awaiting");
    expect(awaiting).toHaveLength(1);
    const awaitingPayload = parsePayload(awaiting[0]!.payload);
    expect(awaitingPayload).toMatchObject({
      sessionId,
      baselineResultCount: 1,
      baselineResultWatermark: expect.any(Number),
      baselineLastResultId: expect.any(Number),
      questionId: expect.stringMatching(/^q_/),
    });

    const questionAsked = harness.store.listEvents(task.id, "question_asked");
    expect(parsePayload(questionAsked[0]!.payload).questionId).toBe(awaitingPayload.questionId);

    authorizeAnswer(task, orchestratorSession, harness, "idem-live-answer");
    harness.store.addComment(task.id, "orchestrator", serializeAgentMessage(answerMessage(task.id, "仕様は A で進めてください", "idem-live-answer")));

    const answerResult = await messagesStage.tick(harness.deps, true, now());
    expect(answerResult.actions).toBe(1);

    const injectBody = promptBodies(harness).find((body) => body.sessionId === sessionId && body.text === "仕様は A で進めてください");
    expect(injectBody).toBeDefined();
    expect(harness.codexBridge.sessions()).toEqual([sessionId]);
    expect(harness.store.hasProcessedMessage("idem-live-answer")).toBe(true);
    expect(harness.store.getTask(task.id)?.blockReason).toContain(`even-session=${sessionId}`);
    expect(harness.store.getOpenRunByTaskSession(task.id, sessionId)).toBeDefined();

    const answered = harness.store.listEvents(task.id, "question_answered");
    expect(parsePayload(answered[0]!.payload)).toMatchObject({
      sessionId,
      questionId: awaitingPayload.questionId,
      injected: true,
      idempotencyKey: "idem-live-answer",
    });

    harness.codexBridge.completeSession(sessionId, handoff(task.id, "done", "回答反映後の作業が完了しました"));

    const secondCandidateAt = now();
    const secondMonitor = await monitorStage.tick(harness.deps, true, secondCandidateAt);
    expect(secondMonitor.actions).toBe(1);
    const secondConfirmed = await monitorStage.tick(harness.deps, true, secondCandidateAt + 60);
    expect(secondConfirmed.actions).toBe(1);
    const endedCounts = harness.store
      .listEvents(task.id, "session_ended")
      .map((event) => parsePayload(event.payload).resultCount);
    expect(endedCounts).toEqual([1, 2]);
    const endedLastResultIds = harness.store
      .listEvents(task.id, "session_ended")
      .map((event) => parsePayload(event.payload).lastResultId)
      .filter((value): value is number => typeof value === "number");
    expect(endedLastResultIds).toHaveLength(2);
    expect(endedLastResultIds[1]!).toBeGreaterThan(endedLastResultIds[0]!);

    const secondFinalize = await finalizeStage.tick(harness.deps, true, secondCandidateAt + 61);
    expect(secondFinalize.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("done");
    expect(harness.store.listOpenRuns().find((run) => run.taskId === task.id)).toBeUndefined();
  });

  it("grace 超過の bridge question_awaiting run は question_expired を記録して released にする", async () => {
    const { task, sessionId } = await createBridgeQuestionAwaitingTask("expired bridge task");
    const awaitingPayload = parsePayload(harness.store.listEvents(task.id, "question_awaiting")[0]!.payload);
    const deadline = awaitingPayload.deadline;
    if (typeof deadline !== "number") {
      throw new Error("question_awaiting.deadline が number ではありません");
    }

    const reapStage = createReapStage({
      listProcesses: async () => [],
      signalProcess: () => {},
      delay: async () => {},
    });
    const reapResult = await reapStage.tick(harness.deps, true, deadline + 1);

    expect(reapResult.actions).toBe(1);
    expect(harness.store.getOpenRunByTaskSession(task.id, sessionId)).toBeNull();
    const expired = harness.store.listEvents(task.id, "question_expired");
    expect(expired).toHaveLength(1);
    expect(parsePayload(expired[0]!.payload)).toMatchObject({
      sessionId,
      questionId: awaitingPayload.questionId,
      baselineResultCount: 1,
    });
  });

  it("bridge answer inject 失敗時は mark せず worker-question のまま lease を解除する", async () => {
    const { task, sessionId, orchestratorSession } = await createBridgeQuestionAwaitingTask("inject failed bridge task");
    const awaitingPayload = parsePayload(harness.store.listEvents(task.id, "question_awaiting")[0]!.payload);
    harness.codexBridge.failNextPrompt(503);
    authorizeAnswer(task, orchestratorSession, harness, "idem-inject-fail");
    harness.store.addComment(task.id, "orchestrator", serializeAgentMessage(answerMessage(task.id, "再注入してください", "idem-inject-fail")));

    const answerResult = await messagesStage.tick(harness.deps, true, now());

    expect(answerResult.actions).toBe(1);
    expect(harness.store.hasProcessedMessage("idem-inject-fail")).toBe(false);
    expect(harness.store.getTask(task.id)?.blockReason).toContain("worker-question:");
    expect(harness.store.listEvents(task.id, "question_answered")).toHaveLength(0);
    expect(parsePayload(harness.store.listEvents(task.id, "question_answer_inject_failed")[0]!.payload)).toMatchObject({
      sessionId,
      questionId: awaitingPayload.questionId,
      idempotencyKey: "idem-inject-fail",
    });
    expect(harness.store.listEvents(task.id, "question_answering_released")).toHaveLength(1);
  });

  it("direct question は run を閉じ、answer は live inject せず body prepend + ready へ戻す", async () => {
    const directAdapter = new FakeAdapter("codex");
    harness.deps.directAdapters = { codex: directAdapter };
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "direct question task", body: `cwd: ${tmpCwd}\n本文` }),
      "tester",
    );
    const orchestratorSession = registerOrchestrator(task, harness);
    const sessionId = "direct-question-integration";
    harness.store.block(
      task.id,
      `codex-in-progress: 実装中 tmux=none even-session=${sessionId} server=direct started=2026-07-02T10:00:00+09:00`,
      "tester",
    );
    harness.store.startRun(task.id, "codex", sessionId, {
      serverUrl: "direct",
      model: "gpt-5.4",
      modelDelivery: "none",
      transport: "direct",
    });
    harness.store.addEvent(task.id, "session_ended", "supervisor", { sessionId, provider: "codex", resultCount: 1 });
    directAdapter.transcriptResponse = handoff(task.id, "question", "direct では追加確認が必要です");

    const finalizeResult = await finalizeStage.tick(harness.deps, true, now());

    expect(finalizeResult.actions).toBe(1);
    expect(harness.store.getOpenRunByTaskSession(task.id, sessionId)).toBeNull();
    expect(directAdapter.stopCalls).toHaveLength(1);
    const questionAsked = harness.store.listEvents(task.id, "question_asked");
    expect(parsePayload(questionAsked[0]!.payload)).toMatchObject({
      sessionId,
      questionId: expect.stringMatching(/^q_/),
      question: "direct では追加確認が必要です",
    });

    authorizeAnswer(task, orchestratorSession, harness, "idem-direct-answer");
    harness.store.addComment(task.id, "orchestrator", serializeAgentMessage(answerMessage(task.id, "direct 回答です", "idem-direct-answer")));
    const answerResult = await messagesStage.tick(harness.deps, true, now());

    expect(answerResult.actions).toBe(1);
    expect(directAdapter.injectCalls).toHaveLength(0);
    expect(harness.store.hasProcessedMessage("idem-direct-answer")).toBe(true);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("ready");
    expect(updated?.body).toContain("direct 回答です");
    expect(parsePayload(harness.store.listEvents(task.id, "question_answered")[0]!.payload)).toMatchObject({
      injected: false,
      idempotencyKey: "idem-direct-answer",
    });
  });
});
