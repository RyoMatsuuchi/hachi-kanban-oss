import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskInput } from "@hachi/testing";
import { serializeAgentMessage } from "@hachi/core";
import type { AgentMessageV1, KanbanStore } from "@hachi/core";
import { readMessagesCursor, writeMessagesCursor } from "../messages-cursor.js";
import { FakeAdapter, setupHarness, type TestHarness } from "../test-support.js";
import { messagesStage } from "./messages.js";

/**
 * hasProcessedMessage を常に false にし、外側の重複チェック（TOCTOU の判定窓）を素通りさせる
 * テスト用ラッパー。事前に本物の markMessageProcessed で「別経路が直前に処理済み」の状態を
 * 作っておくことで、2つの経路がほぼ同時に同一 idempotencyKey を処理しようとするレースを再現し、
 * messages ステージ内部の mark-first ロジックが side effect を正しくゲートするかを検証する
 * （docs/contract.md §12.10-1）。他のメソッドは全て実 store に委譲する。
 */
function withForcedUnprocessedCheck(base: KanbanStore): KanbanStore {
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop === "hasProcessedMessage") {
        return (): boolean => false;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function baseMessage(overrides: Partial<AgentMessageV1>): AgentMessageV1 {
  return {
    schema: "agent.message.v1",
    from: { role: "worker", provider: "codex", sessionId: "sess-x" },
    to: { role: "orchestrator", taskId: "" },
    intent: "answer",
    payload: {},
    idempotencyKey: `idem-${Math.random().toString(16).slice(2)}`,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("messagesStage", () => {
  let harness: TestHarness;
  let fakeCodex: FakeAdapter;

  beforeEach(async () => {
    harness = await setupHarness();
    fakeCodex = new FakeAdapter("codex");
    harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const now = (): number => Math.floor(Date.now() / 1000);

  function setupQuestionAwaiting(
    sessionId: string,
    currentNow: number,
    options: { serverUrl?: string; deadline?: number; legacyBaseline?: boolean; baselineLastResultId?: number } = {},
  ): { taskId: string; runId: number } {
    const target = harness.store.createTask(taskInput({ status: "ready", title: "質問対象", body: "cwd: /tmp\nbody" }), "tester");
    harness.store.block(target.id, "worker-question: 仕様を確認してください", "supervisor", "human");
    const run = harness.store.startRun(target.id, "codex", sessionId, {
      serverUrl: options.serverUrl ?? "http://x",
      transport: options.serverUrl === "direct" ? "direct" : "bridge",
      model: "gpt-5.4",
    });
    const baselineLastResultId = options.baselineLastResultId ?? 4420;
    harness.store.addEvent(target.id, "question_awaiting", "supervisor", {
      sessionId,
      baselineResultCount: 1,
      ...(options.legacyBaseline === true
        ? {}
        : { baselineResultWatermark: baselineLastResultId, baselineLastResultId }),
      deadline: options.deadline ?? currentNow + 60,
      questionId: `q_${sessionId}`,
    });
    return { taskId: target.id, runId: run.id };
  }

  function setupAnsweringRequest(taskId: string, answerKey: string): string {
    const orchestrator = harness.store.registerOrchestrator({
      label: `answer-owner-${answerKey}`,
      project: "dev",
      repoCommonDir: "",
    });
    const session = harness.store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "codex",
      providerSessionId: `codex-answer-owner-${answerKey}`,
    });
    harness.store.bindTaskToOrchestrator(taskId, orchestrator.id, "primary");
    const request = harness.store.createOrGetOrchestratorRequest({
      taskId,
      questionId: `q_${answerKey}`,
      question: "仕様を確認してください",
    });
    const claimToken = `claim-${answerKey}`;
    harness.store.claimOrchestratorRequest({
      requestId: request.id,
      sessionId: session.id,
      generation: session.generation,
      claimToken,
      leaseUntil: now() + 600,
    });
    harness.store.beginOrchestratorRequestAnswer({
      requestId: request.id,
      sessionId: session.id,
      generation: session.generation,
      claimToken,
      answerKey,
    });
    return request.id;
  }

  function makeTerminal(taskId: string, status: "done" | "archived"): void {
    if (status === "done") {
      harness.store.block(
        taskId,
        "codex-in-progress: 完了直前 tmux=none even-session=sess-terminal server=http://x started=2026-07-02T10:00:00+09:00",
        "tester",
      );
    }
    harness.store.transition({ taskId, to: status, actor: "tester" });
  }

  it("enqueue: 子タスクを ready で生成し親子リンクを張る（冪等）", async () => {
    const parent = harness.store.createTask(taskInput({ status: "ready", title: "親タスク" }), "tester");
    const orchestrator = harness.store.registerOrchestrator({ label: "enqueue-owner", project: "dev", repoCommonDir: "" });
    harness.store.bindTaskToOrchestrator(parent.id, orchestrator.id, "primary");
    const msg = baseMessage({
      to: { role: "orchestrator", taskId: parent.id },
      intent: "enqueue",
      payload: { title: "子タスク", body: "cwd: /tmp/x", tenant: "dev" },
      idempotencyKey: "idem-enqueue-1",
    });
    harness.store.addComment(parent.id, "worker", serializeAgentMessage(msg));

    const result = await messagesStage.tick(harness.deps, true, now());
    expect(result.actions).toBe(1);

    const links = harness.store.listLinks(parent.id);
    expect(links).toHaveLength(1);
    const child = harness.store.getTask(links[0]!.childId);
    expect(child?.status).toBe("ready");
    expect(child?.title).toBe("子タスク");
    expect(harness.store.listTaskOrchestratorBindings(child!.id)).toEqual([
      expect.objectContaining({ orchestratorId: orchestrator.id, role: "primary" }),
    ]);

    expect(harness.store.listComments(parent.id).some((c) => c.body.includes("enqueue 受理"))).toBe(true);
    expect(harness.store.hasProcessedMessage("idem-enqueue-1")).toBe(true);

    // 2回目の tick では重複生成しない（冪等）
    const second = await messagesStage.tick(harness.deps, true, now());
    expect(second.actions).toBe(0);
    expect(harness.store.listLinks(parent.id)).toHaveLength(1);
  });

  it("enqueue: ハンドラ内で例外が起きると子タスクは作られず rollback されるが、catch 節で mark され poison message 化しない（docs/contract.md §12.4-4）", async () => {
    const parent = harness.store.createTask(taskInput({ status: "ready", title: "親タスク" }), "tester");
    const msg = baseMessage({
      to: { role: "orchestrator", taskId: parent.id },
      intent: "enqueue",
      // title を欠落させ parseEnqueuePayload の zod 検証で throw させる
      payload: { body: "cwd: /tmp/x", tenant: "dev" },
      idempotencyKey: "idem-enqueue-invalid",
    });
    harness.store.addComment(parent.id, "worker", serializeAgentMessage(msg));

    const result = await messagesStage.tick(harness.deps, true, now());
    expect(result.actions).toBe(1);

    // トランザクションが rollback されるため子タスクのリンクは作られない
    expect(harness.store.listLinks(parent.id)).toHaveLength(0);
    // handler 失敗時も catch 節で mark され、poison message 化しない
    expect(harness.store.hasProcessedMessage("idem-enqueue-invalid")).toBe(true);
    expect(
      harness.store.listComments(parent.id).some((c) => c.body.includes("agent.message.v1 処理エラー")),
    ).toBe(true);

    // 2回目の tick でも再処理されない（mark 済みのため）
    const second = await messagesStage.tick(harness.deps, true, now());
    expect(second.actions).toBe(0);
  });

  it("steer: inject結果が曖昧な失敗はuncertainで残し再送しない（at-most-once）", async () => {
    const target = harness.store.createTask(taskInput({ status: "ready", title: "対象" }), "tester");
    harness.store.block(
      target.id,
      "codex-in-progress: 実行中 tmux=none even-session=sess-steer server=http://x started=2026-07-02T10:00:00+09:00",
      "tester",
    );
    const run = harness.store.startRun(target.id, "codex", "sess-steer", { serverUrl: "http://x" });
    fakeCodex.injectError = new Error("inject に失敗しました");
    const delivery = harness.store.createOrGetSteerDelivery({
      taskId: target.id,
      runId: run.id,
      sessionId: run.sessionId,
      messageKey: "idem-steer-fail",
      expectedCancelFence: 0,
      actor: "orchestrator",
    });
    const msg = baseMessage({
      to: { role: "worker", taskId: target.id },
      intent: "steer",
      payload: {
        message: "続けてください",
        deliveryId: delivery.id,
        runId: run.id,
        sessionId: run.sessionId,
        cancelFence: 0,
      },
      idempotencyKey: "idem-steer-fail",
    });
    harness.store.addComment(target.id, "orchestrator", serializeAgentMessage(msg));

    const result = await messagesStage.tick(harness.deps, true, now());
    expect(result.actions).toBe(1);
    expect(fakeCodex.injectCalls).toHaveLength(1);
    expect(harness.store.getSteerDelivery(delivery.id)?.status).toBe("uncertain");

    // mark-first: inject が失敗しても既に mark 済みなので hasProcessedMessage は true のまま
    expect(harness.store.hasProcessedMessage("idem-steer-fail")).toBe(true);
    expect(
      harness.store.listComments(target.id).some((c) => c.body.includes("agent.message.v1 処理エラー")),
    ).toBe(true);

    // 2回目の tick では再送（再 inject）されない
    const second = await messagesStage.tick(harness.deps, true, now());
    expect(second.actions).toBe(0);
    expect(fakeCodex.injectCalls).toHaveLength(1);
  });

  it("mark-first: 別経路が直前に mark 済みの場合、DB-only intent の handler は実行されない（side effect 二重発生防止, docs/contract.md §12.10-1）", async () => {
    const parent = harness.store.createTask(taskInput({ status: "ready", title: "親タスク" }), "tester");
    const msg = baseMessage({
      to: { role: "orchestrator", taskId: parent.id },
      intent: "enqueue",
      payload: { title: "子タスク", body: "cwd: /tmp/x", tenant: "dev" },
      idempotencyKey: "idem-race-enqueue",
    });
    harness.store.addComment(parent.id, "worker", serializeAgentMessage(msg));

    // 別経路（他プロセス/他 tick）が直前に処理済みとしてマークした状況を再現する
    harness.store.markMessageProcessed(parent.id, "idem-race-enqueue", "concurrent-writer");

    const racedDeps = { ...harness.deps, store: withForcedUnprocessedCheck(harness.store) };
    const result = await messagesStage.tick(racedDeps, true, now());

    // 外側の hasProcessedMessage チェックは無効化されているため試行はされる
    expect(result.actions).toBe(1);
    // mark-first（Tx 先頭での mark 戻り値ゲート）により handler は実行されず、子タスクは二重に生成されない
    expect(harness.store.listLinks(parent.id)).toHaveLength(0);
  });

  it("mark-first: 別経路が直前に mark 済みの場合、steer の inject は実行されない（side effect 二重発生防止, docs/contract.md §12.10-1）", async () => {
    const target = harness.store.createTask(taskInput({ status: "ready", title: "対象" }), "tester");
    harness.store.block(
      target.id,
      "codex-in-progress: 実行中 tmux=none even-session=sess-race server=http://x started=2026-07-02T10:00:00+09:00",
      "tester",
    );
    harness.store.startRun(target.id, "codex", "sess-race", { serverUrl: "http://x" });
    const msg = baseMessage({
      to: { role: "worker", taskId: target.id },
      intent: "steer",
      payload: { message: "続けてください" },
      idempotencyKey: "idem-race-steer",
    });
    harness.store.addComment(target.id, "orchestrator", serializeAgentMessage(msg));

    // 別経路が直前に処理済みとしてマークした状況を再現する
    harness.store.markMessageProcessed(target.id, "idem-race-steer", "concurrent-writer");

    const racedDeps = { ...harness.deps, store: withForcedUnprocessedCheck(harness.store) };
    const result = await messagesStage.tick(racedDeps, true, now());

    expect(result.actions).toBe(1);
    // mark-first により inject は二重に呼ばれない（呼ばれない）
    expect(fakeCodex.injectCalls).toHaveLength(0);
  });

  it("steer: 進行中セッションへ adapter.inject を呼ぶ", async () => {
    const target = harness.store.createTask(taskInput({ status: "ready", title: "対象" }), "tester");
    harness.store.block(
      target.id,
      "codex-in-progress: 実行中 tmux=none even-session=sess-steer server=http://x started=2026-07-02T10:00:00+09:00",
      "tester",
    );
    const run = harness.store.startRun(target.id, "codex", "sess-steer", { serverUrl: "http://x" });
    const delivery = harness.store.createOrGetSteerDelivery({
      taskId: target.id,
      runId: run.id,
      sessionId: run.sessionId,
      messageKey: "idem-steer-1",
      expectedCancelFence: 0,
      actor: "orchestrator",
    });
    const msg = baseMessage({
      to: { role: "worker", taskId: target.id },
      intent: "steer",
      payload: {
        message: "続けてください",
        deliveryId: delivery.id,
        runId: run.id,
        sessionId: run.sessionId,
        cancelFence: 0,
      },
      idempotencyKey: "idem-steer-1",
    });
    harness.store.addComment(target.id, "orchestrator", serializeAgentMessage(msg));

    const result = await messagesStage.tick(harness.deps, true, now());
    expect(result.actions).toBe(1);
    expect(fakeCodex.injectCalls).toHaveLength(1);
    expect(fakeCodex.injectCalls[0]?.message).toContain("hachi-steer-v1");
    expect(fakeCodex.injectCalls[0]?.message).toContain("続けてください");
    expect(harness.store.getSteerDelivery(delivery.id)?.status).toBe("transport_accepted");
    expect(harness.store.hasProcessedMessage("idem-steer-1")).toBe(true);
  });

  it("steer: observeはnative候補の監査後も既存Hachi injectを使う", async () => {
    harness.deps.config.communication = { codex: { rollout: "observe" } };
    const target = harness.store.createTask(taskInput({ status: "ready", title: "observe対象" }), "tester");
    harness.store.block(
      target.id,
      "codex-in-progress: 実行中 tmux=none even-session=sess-observe server=http://x",
      "tester",
    );
    const run = harness.store.startRun(target.id, "codex", "sess-observe", { serverUrl: "http://x" });
    const delivery = harness.store.createOrGetSteerDelivery({
      taskId: target.id,
      runId: run.id,
      sessionId: run.sessionId,
      messageKey: "idem-steer-observe",
      expectedCancelFence: 0,
      actor: "orchestrator",
    });
    const msg = baseMessage({
      from: { role: "orchestrator", provider: "codex", sessionId: "orch-codex" },
      to: { role: "worker", taskId: target.id },
      intent: "steer",
      payload: {
        message: "観測しつつ続行",
        deliveryId: delivery.id,
        runId: run.id,
        sessionId: run.sessionId,
        cancelFence: 0,
        communication: { preference: "auto" },
      },
      idempotencyKey: "idem-steer-observe",
    });
    harness.store.addComment(target.id, "orchestrator", serializeAgentMessage(msg));

    await messagesStage.tick(harness.deps, true, now());

    expect(fakeCodex.injectCalls).toHaveLength(1);
    expect(harness.store.getSteerDelivery(delivery.id)?.status).toBe("transport_accepted");
    const attempts = harness.store.listEvents(target.id, "communication_delivery_attempted");
    expect(attempts).toHaveLength(1);
    expect(JSON.parse(attempts[0]!.payload)).toMatchObject({
      rollout: "observe",
      decision: { status: "deliver", route: "hachi" },
      implementation: "hachi-adapter-inject",
    });
  });

  it("steer: onのsame-providerでnative未実装ならHachiへfallbackせずfailedにする", async () => {
    harness.deps.config.communication = { codex: { rollout: "on" } };
    const target = harness.store.createTask(taskInput({ status: "ready", title: "native必須対象" }), "tester");
    harness.store.block(
      target.id,
      "codex-in-progress: 実行中 tmux=none even-session=sess-native server=http://x",
      "tester",
    );
    const run = harness.store.startRun(target.id, "codex", "sess-native", { serverUrl: "http://x" });
    const delivery = harness.store.createOrGetSteerDelivery({
      taskId: target.id,
      runId: run.id,
      sessionId: run.sessionId,
      messageKey: "idem-steer-native",
      expectedCancelFence: 0,
      actor: "orchestrator",
    });
    const msg = baseMessage({
      from: { role: "orchestrator", provider: "codex", sessionId: "orch-codex" },
      to: { role: "worker", taskId: target.id },
      intent: "steer",
      payload: {
        message: "nativeで続行",
        deliveryId: delivery.id,
        runId: run.id,
        sessionId: run.sessionId,
        cancelFence: 0,
        communication: { preference: "auto" },
      },
      idempotencyKey: "idem-steer-native",
    });
    harness.store.addComment(target.id, "orchestrator", serializeAgentMessage(msg));

    await messagesStage.tick(harness.deps, true, now());

    expect(fakeCodex.injectCalls).toHaveLength(0);
    expect(harness.store.getSteerDelivery(delivery.id)).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("native communication unavailable"),
    });
    expect(harness.store.listEvents(target.id, "communication_delivery_attempted")).toHaveLength(1);
  });

  it("steer: 対象が in-progress でなければ inject せず警告コメントを残す", async () => {
    const target = harness.store.createTask(taskInput({ status: "ready", title: "未進行" }), "tester");
    const msg = baseMessage({
      to: { role: "worker", taskId: target.id },
      intent: "steer",
      payload: { message: "続けてください" },
      idempotencyKey: "idem-steer-2",
    });
    harness.store.addComment(target.id, "orchestrator", serializeAgentMessage(msg));

    await messagesStage.tick(harness.deps, true, now());

    expect(fakeCodex.injectCalls).toHaveLength(0);
    expect(harness.store.listComments(target.id).some((c) => c.body.includes("steer 失敗"))).toBe(true);
    expect(harness.store.hasProcessedMessage("idem-steer-2")).toBe(true);
  });

  it("escalate: 未 blocked のタスクは user-decision で block する", async () => {
    const target = harness.store.createTask(taskInput({ status: "ready", title: "エスカレ対象" }), "tester");
    const msg = baseMessage({
      to: { role: "human", taskId: target.id },
      intent: "escalate",
      payload: { summary: "判断してください" },
      idempotencyKey: "idem-esc-1",
    });
    harness.store.addComment(target.id, "worker", serializeAgentMessage(msg));

    await messagesStage.tick(harness.deps, true, now());

    const updated = harness.store.getTask(target.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe("user-decision: 判断してください");
  });

  it("escalate: 既に blocked のタスクはコメントのみ追加し reason を上書きしない", async () => {
    const target = harness.store.createTask(taskInput({ status: "ready", title: "既にblocked" }), "tester");
    harness.store.block(target.id, "user-decision: 既存の理由", "tester");

    const msg = baseMessage({
      to: { role: "human", taskId: target.id },
      intent: "escalate",
      payload: { summary: "追加の判断依頼" },
      idempotencyKey: "idem-esc-2",
    });
    harness.store.addComment(target.id, "worker", serializeAgentMessage(msg));

    const result = await messagesStage.tick(harness.deps, true, now());
    expect(result.actions).toBeGreaterThanOrEqual(1);

    const updated = harness.store.getTask(target.id);
    // blocked->blocked の再遷移は状態機械上不許可のため reason は書き換わらない
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe("user-decision: 既存の理由");
    expect(harness.store.listComments(target.id).some((c) => c.body.includes("追加の判断依頼"))).toBe(true);
  });

  it("answer: bridge question_awaiting は lease claim 後に live inject し、成功時のみ mark して in-progress へ復帰する", async () => {
    const currentNow = now();
    const { taskId, runId } = setupQuestionAwaiting("sess-answer-live", currentNow);
    const msg = baseMessage({
      to: { role: "worker", taskId },
      intent: "answer",
      payload: { message: "回答内容です" },
      idempotencyKey: "idem-ans-1",
    });
    harness.store.addComment(taskId, "human", serializeAgentMessage(msg));

    const result = await messagesStage.tick(harness.deps, true, currentNow);

    expect(result.actions).toBe(1);
    expect(fakeCodex.injectCalls).toHaveLength(1);
    expect(fakeCodex.injectCalls[0]?.message).toBe("回答内容です");
    expect(harness.store.hasProcessedMessage("idem-ans-1")).toBe(true);
    const updated = harness.store.getTask(taskId);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toContain("codex-in-progress:");
    expect(updated?.blockReason).toContain("tmux=none");
    expect(updated?.blockReason).toContain("even-session=sess-answer-live");
    expect(updated?.blockReason).toContain("server=http://x");
    expect(harness.store.getOpenRunByTaskSession(taskId, "sess-answer-live")?.id).toBe(runId);
    const answered = harness.store.listEvents(taskId, "question_answered");
    expect(JSON.parse(answered[0]!.payload)).toMatchObject({ injected: true, idempotencyKey: "idem-ans-1" });
  });

  it("answer: 非終端taskのfenced routed requestは従来どおりlive injectしてresolvedへ進む", async () => {
    const currentNow = now();
    const { taskId } = setupQuestionAwaiting("sess-answer-routed-active", currentNow);
    const answerKey = "idem-answer-routed-active";
    const requestId = setupAnsweringRequest(taskId, answerKey);
    const msg = baseMessage({
      to: { role: "worker", taskId },
      intent: "answer",
      payload: { message: "active taskへの回答です" },
      idempotencyKey: answerKey,
    });
    harness.store.addComment(taskId, "orchestrator", serializeAgentMessage(msg));

    await messagesStage.tick(harness.deps, true, currentNow);

    expect(fakeCodex.injectCalls).toHaveLength(1);
    expect(harness.store.getOrchestratorRequest(requestId)?.status).toBe("resolved");
    expect(harness.store.getTask(taskId)).toMatchObject({ status: "blocked" });
    expect(harness.store.getTask(taskId)?.blockReason).toContain("codex-in-progress:");
    expect(harness.store.listEvents(taskId, "orchestrator_request_terminal_answer_resolved")).toHaveLength(0);
  });

  it("answer: legacy baselineResultCount の question は status から lastResultId を補完して live inject する", async () => {
    const currentNow = now();
    const { taskId } = setupQuestionAwaiting("sess-answer-legacy-supplement", currentNow, {
      legacyBaseline: true,
    });
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 480, lastResultId: 4420 };
    const msg = baseMessage({
      to: { role: "worker", taskId },
      intent: "answer",
      payload: { message: "回答内容です" },
      idempotencyKey: "idem-ans-legacy-supplement",
    });
    harness.store.addComment(taskId, "human", serializeAgentMessage(msg));

    await messagesStage.tick(harness.deps, true, currentNow);

    expect(fakeCodex.injectCalls).toHaveLength(1);
    const awaitingPayloads = harness.store
      .listEvents(taskId, "question_awaiting")
      .map((event) => JSON.parse(event.payload) as { baselineResultWatermark?: number; baselineLastResultId?: number });
    expect(awaitingPayloads.at(-1)).toMatchObject({
      baselineResultWatermark: 4420,
      baselineLastResultId: 4420,
    });
    expect(harness.store.hasProcessedMessage("idem-ans-legacy-supplement")).toBe(true);
  });

  it("answer: legacy baselineResultCount の question で lastResultId を補完できなければ live inject せず fallback する", async () => {
    const currentNow = now();
    const { taskId } = setupQuestionAwaiting("sess-answer-legacy-fallback", currentNow, {
      legacyBaseline: true,
    });
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 480 };
    const msg = baseMessage({
      to: { role: "worker", taskId },
      intent: "answer",
      payload: { message: "回答内容です" },
      idempotencyKey: "idem-ans-legacy-fallback",
    });
    harness.store.addComment(taskId, "human", serializeAgentMessage(msg));

    await messagesStage.tick(harness.deps, true, currentNow);

    expect(fakeCodex.injectCalls).toHaveLength(0);
    expect(harness.store.hasProcessedMessage("idem-ans-legacy-fallback")).toBe(true);
    expect(harness.store.getTask(taskId)?.status).toBe("ready");
    expect(harness.store.getTask(taskId)?.body).toContain("## オーケストレーター回答");
    expect(harness.store.listEvents(taskId, "question_answering_released")).toHaveLength(1);
  });

  it("answer: inject 例外時は inject_failed と lease 解除を記録し、未 mark のまま worker-question を維持する", async () => {
    const currentNow = now();
    const { taskId } = setupQuestionAwaiting("sess-answer-fail", currentNow);
    fakeCodex.injectError = new Error("bridge timeout");
    const msg = baseMessage({
      to: { role: "worker", taskId },
      intent: "answer",
      payload: { message: "回答内容です" },
      idempotencyKey: "idem-ans-fail",
    });
    harness.store.addComment(taskId, "human", serializeAgentMessage(msg));

    await messagesStage.tick(harness.deps, true, currentNow);

    expect(fakeCodex.injectCalls).toHaveLength(1);
    expect(harness.store.hasProcessedMessage("idem-ans-fail")).toBe(false);
    expect(harness.store.getTask(taskId)?.blockReason).toBe("worker-question: 仕様を確認してください");
    expect(harness.store.listEvents(taskId, "question_answer_inject_failed")).toHaveLength(1);
    expect(harness.store.listEvents(taskId, "question_answering_released")).toHaveLength(1);

    fakeCodex.injectError = null;
    const retry = baseMessage({
      to: { role: "worker", taskId },
      intent: "answer",
      payload: { message: "再回答です" },
      idempotencyKey: "idem-ans-retry",
    });
    harness.store.addComment(taskId, "human", serializeAgentMessage(retry));
    await messagesStage.tick(harness.deps, true, currentNow);

    expect(fakeCodex.injectCalls).toHaveLength(2);
    expect(harness.store.hasProcessedMessage("idem-ans-retry")).toBe(true);
  });

  it("answer: active lease がある場合は fallback し body prepend + ready 再投入する", async () => {
    const currentNow = now();
    const { taskId, runId } = setupQuestionAwaiting("sess-answer-lease", currentNow);
    harness.store.addEvent(taskId, "question_answering", "supervisor", {
      sessionId: "sess-answer-lease",
      runId,
      questionId: "q_sess-answer-lease",
      idempotencyKey: "idem-other-answer",
      leaseUntil: currentNow + 60,
    });
    const msg = baseMessage({
      to: { role: "worker", taskId },
      intent: "answer",
      payload: { message: "fallback回答です" },
      idempotencyKey: "idem-ans-lease-fallback",
    });
    harness.store.addComment(taskId, "human", serializeAgentMessage(msg));

    await messagesStage.tick(harness.deps, true, currentNow);

    expect(fakeCodex.injectCalls).toHaveLength(0);
    expect(harness.store.hasProcessedMessage("idem-ans-lease-fallback")).toBe(true);
    const updated = harness.store.getTask(taskId);
    expect(updated?.status).toBe("ready");
    expect(updated?.body.startsWith("## オーケストレーター回答")).toBe(true);
    expect(harness.store.listEvents(taskId, "question_answered")).toHaveLength(1);
    expect(JSON.parse(harness.store.listEvents(taskId, "question_answered")[0]!.payload)).toMatchObject({
      injected: false,
    });
  });

  it("answer: 同一 idempotencyKey の active lease 中は fallback/mark せず cursor を進めない", async () => {
    const currentNow = now();
    const { taskId, runId } = setupQuestionAwaiting("sess-answer-same-lease", currentNow);
    harness.store.addEvent(taskId, "question_answering", "supervisor", {
      sessionId: "sess-answer-same-lease",
      runId,
      questionId: "q_sess-answer-same-lease",
      idempotencyKey: "idem-answer-same-lease",
      leaseUntil: currentNow + 60,
    });
    const msg = baseMessage({
      to: { role: "worker", taskId },
      intent: "answer",
      payload: { message: "回答内容です" },
      idempotencyKey: "idem-answer-same-lease",
    });
    const comment = harness.store.addComment(taskId, "human", serializeAgentMessage(msg));

    const deferred = await messagesStage.tick(harness.deps, true, currentNow);

    expect(deferred.actions).toBe(1);
    expect(fakeCodex.injectCalls).toHaveLength(0);
    expect(harness.store.hasProcessedMessage("idem-answer-same-lease")).toBe(false);
    expect(harness.store.getTask(taskId)?.blockReason).toBe("worker-question: 仕様を確認してください");
    expect(harness.store.listEvents(taskId, "question_answered")).toHaveLength(0);
    expect(readMessagesCursor(harness.deps.env)).toBe(0);

    harness.store.addEvent(taskId, "question_answering_released", "supervisor", {
      sessionId: "sess-answer-same-lease",
      runId,
      questionId: "q_sess-answer-same-lease",
      idempotencyKey: "idem-answer-same-lease",
    });

    await messagesStage.tick(harness.deps, true, currentNow);

    expect(fakeCodex.injectCalls).toHaveLength(1);
    expect(harness.store.hasProcessedMessage("idem-answer-same-lease")).toBe(true);
    expect(readMessagesCursor(harness.deps.env)).toBe(comment.id);
  });

  it.each([
    ["open run 無し", "sess-no-run", undefined, false],
    ["direct", "sess-direct", "direct", true],
    ["deadline 超過", "sess-deadline", "http://x", true],
  ])("answer: %s は fallback し body prepend + ready 再投入する", async (_label, sessionId, serverUrl, createRun) => {
    const currentNow = now();
    const target = harness.store.createTask(taskInput({ status: "ready", title: "質問対象", body: "cwd: /tmp\nbody" }), "tester");
    harness.store.block(target.id, "worker-question: 仕様を確認してください", "supervisor", "human");
    if (createRun) {
      harness.store.startRun(target.id, "codex", sessionId, {
        serverUrl,
        transport: serverUrl === "direct" ? "direct" : "bridge",
      });
      harness.store.addEvent(target.id, "question_awaiting", "supervisor", {
        sessionId,
        baselineResultCount: 1,
        deadline: sessionId === "sess-deadline" ? currentNow - 1 : currentNow + 60,
        questionId: `q_${sessionId}`,
      });
    }
    const msg = baseMessage({
      to: { role: "worker", taskId: target.id },
      intent: "answer",
      payload: { message: "fallback回答です" },
      idempotencyKey: `idem-${sessionId}`,
    });
    harness.store.addComment(target.id, "human", serializeAgentMessage(msg));

    await messagesStage.tick(harness.deps, true, currentNow);

    expect(fakeCodex.injectCalls).toHaveLength(0);
    expect(harness.store.hasProcessedMessage(`idem-${sessionId}`)).toBe(true);
    const updated = harness.store.getTask(target.id);
    expect(updated?.status).toBe("ready");
    expect(updated?.body).toContain("fallback回答です");
  });

  it("answer: 同じ idempotencyKey の二重 answer は 1 回だけ inject する", async () => {
    const currentNow = now();
    const { taskId } = setupQuestionAwaiting("sess-answer-dup", currentNow);
    const msg = baseMessage({
      to: { role: "worker", taskId },
      intent: "answer",
      payload: { message: "回答内容です" },
      idempotencyKey: "idem-ans-dup",
    });
    harness.store.addComment(taskId, "human", serializeAgentMessage(msg));
    harness.store.addComment(taskId, "human", serializeAgentMessage(msg));

    await messagesStage.tick(harness.deps, true, currentNow);

    expect(fakeCodex.injectCalls).toHaveLength(1);
    expect(harness.store.hasProcessedMessage("idem-ans-dup")).toBe(true);
  });

  it("answer: inject 成功後に open run が閉じた場合は mark せず in-progress へ復帰しない", async () => {
    const currentNow = now();
    const { taskId, runId } = setupQuestionAwaiting("sess-answer-race", currentNow);
    fakeCodex.injectHook = (): void => {
      harness.store.endRun(runId, "released");
    };
    const msg = baseMessage({
      to: { role: "worker", taskId },
      intent: "answer",
      payload: { message: "回答内容です" },
      idempotencyKey: "idem-ans-race",
    });
    const comment = harness.store.addComment(taskId, "human", serializeAgentMessage(msg));

    await messagesStage.tick(harness.deps, true, currentNow);

    expect(fakeCodex.injectCalls).toHaveLength(1);
    expect(harness.store.hasProcessedMessage("idem-ans-race")).toBe(false);
    expect(harness.store.getTask(taskId)?.blockReason).toBe("worker-question: 仕様を確認してください");
    expect(harness.store.listEvents(taskId, "question_answer_inject_failed")).toHaveLength(1);
    expect(readMessagesCursor(harness.deps.env)).toBe(0);

    await messagesStage.tick(harness.deps, true, currentNow);

    expect(fakeCodex.injectCalls).toHaveLength(1);
    expect(harness.store.hasProcessedMessage("idem-ans-race")).toBe(true);
    const updated = harness.store.getTask(taskId);
    expect(updated?.status).toBe("ready");
    expect(updated?.body).toContain("回答内容です");
    expect(readMessagesCursor(harness.deps.env)).toBe(comment.id);
  });

  it("escalate: payload 中の機密情報らしき文字列はコメント/block_reason で redact される（docs/contract.md §12.7-3）", async () => {
    const target = harness.store.createTask(taskInput({ status: "ready", title: "エスカレ機密" }), "tester");
    const msg = baseMessage({
      to: { role: "human", taskId: target.id },
      intent: "escalate",
      payload: { summary: "認証エラー: Authorization: Bearer abc123defghi" },
      idempotencyKey: "idem-esc-secret",
    });
    harness.store.addComment(target.id, "worker", serializeAgentMessage(msg));

    await messagesStage.tick(harness.deps, true, now());

    const updated = harness.store.getTask(target.id);
    expect(updated?.blockReason).not.toContain("abc123defghi");
    expect(updated?.blockReason).toContain("[REDACTED]");
    const comments = harness.store.listComments(target.id);
    expect(comments.some((c) => c.body.includes("[REDACTED]") && !c.body.includes("abc123defghi"))).toBe(true);
  });

  it("answer: payload 中の機密情報らしき文字列はコメントで redact される（docs/contract.md §12.7-3）", async () => {
    const target = harness.store.createTask(taskInput({ status: "ready", title: "回答機密" }), "tester");
    const msg = baseMessage({
      to: { role: "worker", taskId: target.id },
      intent: "answer",
      payload: { message: "token=abcdefghijklmnop で接続してください" },
      idempotencyKey: "idem-ans-secret",
    });
    harness.store.addComment(target.id, "human", serializeAgentMessage(msg));

    await messagesStage.tick(harness.deps, true, now());

    // 元の agent-message-v1 フェンスコメント（生 payload を含む）を除き、
    // handleAnswer が新規追加したコメントのみを検証する
    const answerComment = harness.store
      .listComments(target.id)
      .find((c) => !c.body.includes("agent-message-v1"));
    expect(answerComment?.body).toContain("[REDACTED]");
    expect(answerComment?.body).not.toContain("abcdefghijklmnop");
  });

  it("enqueue: worker 発 payload の title/body 中の機密情報らしき文字列は子タスクへ redact して伝播する（docs/contract.md §12.15-1）", async () => {
    const parent = harness.store.createTask(taskInput({ status: "ready", title: "親タスク" }), "tester");
    const msg = baseMessage({
      to: { role: "orchestrator", taskId: parent.id },
      intent: "enqueue",
      payload: {
        title: "認証情報: Authorization: Bearer abc123defghi",
        body: "cwd: /tmp/x\ntoken=abcdefghijklmnop で接続してください",
        tenant: "dev",
      },
      idempotencyKey: "idem-enqueue-secret",
    });
    // CLI（hachi msg send）を経由しない worker 発メッセージ想定: 生の機密情報らしき文字列を含む payload を
    // 直接コメントへ書き込む（CLI 側 redaction を経由しない経路の再現）。
    harness.store.addComment(parent.id, "worker", serializeAgentMessage(msg));

    const result = await messagesStage.tick(harness.deps, true, now());
    expect(result.actions).toBe(1);

    const links = harness.store.listLinks(parent.id);
    expect(links).toHaveLength(1);
    const child = harness.store.getTask(links[0]!.childId);
    expect(child?.title).toContain("[REDACTED]");
    expect(child?.title).not.toContain("abc123defghi");
    expect(child?.body).toContain("[REDACTED]");
    expect(child?.body).not.toContain("abcdefghijklmnop");
  });

  it("dry-run は actions を計上するが DB に書き込まない", async () => {
    const parent = harness.store.createTask(taskInput({ status: "ready", title: "親タスク" }), "tester");
    const msg = baseMessage({
      to: { role: "orchestrator", taskId: parent.id },
      intent: "enqueue",
      payload: { title: "子タスク", body: "cwd: /tmp/x", tenant: "dev" },
      idempotencyKey: "idem-dry-1",
    });
    harness.store.addComment(parent.id, "worker", serializeAgentMessage(msg));

    const result = await messagesStage.tick(harness.deps, false, now());
    expect(result.actions).toBe(1);
    expect(harness.store.listLinks(parent.id)).toHaveLength(0);
    expect(harness.store.hasProcessedMessage("idem-dry-1")).toBe(false);
  });

  describe("カーソル走査（docs/contract.md §12.6-5）", () => {
    it("apply=true では最後に見た comment id までカーソルが進む", async () => {
      const parent = harness.store.createTask(taskInput({ status: "ready", title: "親タスク" }), "tester");
      const msg = baseMessage({
        to: { role: "orchestrator", taskId: parent.id },
        intent: "enqueue",
        payload: { title: "子タスク", body: "cwd: /tmp/x", tenant: "dev" },
        idempotencyKey: "idem-cursor-1",
      });
      const comment = harness.store.addComment(parent.id, "worker", serializeAgentMessage(msg));

      expect(readMessagesCursor(harness.deps.env)).toBe(0);

      await messagesStage.tick(harness.deps, true, now());

      expect(readMessagesCursor(harness.deps.env)).toBe(comment.id);
    });

    it("新規コメントが無ければカーソルは進まない（ファイル未作成のまま）", async () => {
      const result = await messagesStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(0);
      expect(readMessagesCursor(harness.deps.env)).toBe(0);
    });

    it("dry-run ではカーソルを進めない", async () => {
      const parent = harness.store.createTask(taskInput({ status: "ready", title: "親タスク" }), "tester");
      const msg = baseMessage({
        to: { role: "orchestrator", taskId: parent.id },
        intent: "enqueue",
        payload: { title: "子タスク", body: "cwd: /tmp/x", tenant: "dev" },
        idempotencyKey: "idem-cursor-dry",
      });
      harness.store.addComment(parent.id, "worker", serializeAgentMessage(msg));

      await messagesStage.tick(harness.deps, false, now());

      expect(readMessagesCursor(harness.deps.env)).toBe(0);
    });

    it("カーソルが巻き戻っても idempotencyKey 照合により重複実行されない", async () => {
      const parent = harness.store.createTask(taskInput({ status: "ready", title: "親タスク" }), "tester");
      const msg = baseMessage({
        to: { role: "orchestrator", taskId: parent.id },
        intent: "enqueue",
        payload: { title: "子タスク", body: "cwd: /tmp/x", tenant: "dev" },
        idempotencyKey: "idem-rollback-1",
      });
      harness.store.addComment(parent.id, "worker", serializeAgentMessage(msg));

      await messagesStage.tick(harness.deps, true, now());
      expect(harness.store.listLinks(parent.id)).toHaveLength(1);

      // クラッシュ等でカーソルが巻き戻ったケースを再現する
      writeMessagesCursor(harness.deps.env, 0, harness.deps.logger);

      const result = await messagesStage.tick(harness.deps, true, now());

      // 同一コメントが再走査されるが idempotencyKey 照合により重複処理はされない
      expect(result.actions).toBe(0);
      expect(harness.store.listLinks(parent.id)).toHaveLength(1);
    });

    it("対象タスクが archived になっても skip せず message_target_terminal を記録し idempotencyKey を消費する（docs/contract.md §12.18-1）", async () => {
      const target = harness.store.createTask(taskInput({ status: "ready", title: "対象" }), "tester");
      const msg = baseMessage({
        to: { role: "worker", taskId: target.id },
        intent: "answer",
        payload: { message: "後で読む" },
        idempotencyKey: "idem-archived-1",
      });
      harness.store.addComment(target.id, "human", serializeAgentMessage(msg));

      // コメント投稿後にタスクが archived になったケースを再現する
      harness.store.transition({ taskId: target.id, to: "archived", actor: "tester" });

      const result = await messagesStage.tick(harness.deps, true, now());

      // ゲートは対象タスクの状態で判定する（コメントが載っているタスクの状態では skip しない）
      expect(result.actions).toBe(1);
      expect(harness.store.hasProcessedMessage("idem-archived-1")).toBe(true);

      const events = harness.store.listEvents(target.id, "message_target_terminal");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({ status: "archived", intent: "answer" });

      // intent 処理（answer のコメント追記）自体は行われない: 元のフェンス済みコメント以外は増えない
      expect(harness.store.listComments(target.id)).toHaveLength(1);
    });
  });

  describe("対象タスクゲート（docs/contract.md §12.18-1）", () => {
    it("enqueue: active タスク上のコメントから done タスク宛でも子タスクを作らず message_target_terminal を記録する", async () => {
      const commentTask = harness.store.createTask(taskInput({ status: "ready", title: "コメント元(active)" }), "tester");
      const doneTarget = harness.store.createTask(taskInput({ status: "ready", title: "完了済み対象" }), "tester");
      harness.store.block(
        doneTarget.id,
        "codex-in-progress: 実装中 tmux=none even-session=sess-done server=http://x started=2026-07-02T10:00:00+09:00",
        "tester",
      );
      harness.store.transition({ taskId: doneTarget.id, to: "done", actor: "tester" });

      const msg = baseMessage({
        to: { role: "orchestrator", taskId: doneTarget.id },
        intent: "enqueue",
        payload: { title: "followup子タスク", body: "cwd: /tmp/x", tenant: "dev" },
        idempotencyKey: "idem-target-terminal-enqueue",
      });
      // コメント自体は別の active タスク上に投稿される（対象タスクとコメントのタスクが異なるケース）
      harness.store.addComment(commentTask.id, "worker", serializeAgentMessage(msg));

      const result = await messagesStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);

      // 対象タスクが done のため子タスクは作られない
      expect(harness.store.listLinks(doneTarget.id)).toHaveLength(0);

      const events = harness.store.listEvents(doneTarget.id, "message_target_terminal");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({ status: "done", intent: "enqueue" });

      // idempotencyKey はグローバルに消費済み（対象タスク側に mark が記録される）
      expect(harness.store.hasProcessedMessage("idem-target-terminal-enqueue")).toBe(true);

      // 2回目の tick では再処理されない
      const second = await messagesStage.tick(harness.deps, true, now());
      expect(second.actions).toBe(0);
      expect(harness.store.listEvents(doneTarget.id, "message_target_terminal")).toHaveLength(1);
    });

    it("answer: done タスク上のコメントから active タスク宛は正当な followup として処理される", async () => {
      const doneCommentTask = harness.store.createTask(taskInput({ status: "ready", title: "コメント元(done)" }), "tester");
      harness.store.block(
        doneCommentTask.id,
        "codex-in-progress: 実装中 tmux=none even-session=sess-followup server=http://x started=2026-07-02T10:00:00+09:00",
        "tester",
      );
      harness.store.transition({ taskId: doneCommentTask.id, to: "done", actor: "tester" });

      const activeTarget = harness.store.createTask(taskInput({ status: "ready", title: "回答対象(active)" }), "tester");

      const msg = baseMessage({
        to: { role: "worker", taskId: activeTarget.id },
        intent: "answer",
        payload: { message: "followup回答です" },
        idempotencyKey: "idem-followup-answer",
      });
      // done タスク上に投稿されたコメント（followup パターン）
      harness.store.addComment(doneCommentTask.id, "human", serializeAgentMessage(msg));

      const result = await messagesStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);

      expect(harness.store.listComments(activeTarget.id).some((c) => c.body.includes("followup回答です"))).toBe(
        true,
      );
      expect(harness.store.hasProcessedMessage("idem-followup-answer")).toBe(true);
      expect(harness.store.listEvents(activeTarget.id, "message_target_terminal")).toHaveLength(0);
    });

    it("不存在タスク宛メッセージは message_target_missing をコメントのタスクへ記録し poison 化しない", async () => {
      const commentTask = harness.store.createTask(taskInput({ status: "ready", title: "コメント元" }), "tester");
      const msg = baseMessage({
        to: { role: "orchestrator", taskId: "t_does_not_exist" },
        intent: "answer",
        payload: { message: "宛先不明" },
        idempotencyKey: "idem-target-missing",
      });
      harness.store.addComment(commentTask.id, "worker", serializeAgentMessage(msg));

      const result = await messagesStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);

      const events = harness.store.listEvents(commentTask.id, "message_target_missing");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        targetTaskId: "t_does_not_exist",
        idempotencyKey: "idem-target-missing",
      });

      expect(harness.store.hasProcessedMessage("idem-target-missing")).toBe(true);

      // poison message 化しない: 2回目の tick では再処理されない
      const second = await messagesStage.tick(harness.deps, true, now());
      expect(second.actions).toBe(0);
      expect(harness.store.listEvents(commentTask.id, "message_target_missing")).toHaveLength(1);
    });

    it("enqueue: markMessageProcessed 直後（Tx内）に対象タスクが終端化した場合、handler を実行せず message_target_terminal を記録する（docs/contract.md §12.19-3）", async () => {
      const parent = harness.store.createTask(taskInput({ status: "ready", title: "親タスク" }), "tester");
      const msg = baseMessage({
        to: { role: "orchestrator", taskId: parent.id },
        intent: "enqueue",
        payload: { title: "子タスク", body: "cwd: /tmp/x", tenant: "dev" },
        idempotencyKey: "idem-terminal-race",
      });
      harness.store.addComment(parent.id, "worker", serializeAgentMessage(msg));

      // 対象タスク取得（Tx 開始前のスナップショット）の時点では非終端だが、Tx 内の
      // markMessageProcessed 成功直後に別 writer が終端化した競合を再現する
      // （markMessageProcessed の戻り値を返した瞬間に横取りする）
      const originalMark = harness.store.markMessageProcessed.bind(harness.store);
      harness.store.markMessageProcessed = (taskId: string, idempotencyKey: string, actor: string): boolean => {
        const result = originalMark(taskId, idempotencyKey, actor);
        if (result && idempotencyKey === "idem-terminal-race") {
          harness.store.transition({ taskId: parent.id, to: "archived", actor: "concurrent-writer" });
        }
        return result;
      };

      const result = await messagesStage.tick(harness.deps, true, now());
      harness.store.markMessageProcessed = originalMark;

      expect(result.actions).toBe(1);
      // handler（enqueue）は実行されず子タスクは作られない
      expect(harness.store.listLinks(parent.id)).toHaveLength(0);

      const events = harness.store.listEvents(parent.id, "message_target_terminal");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({ status: "archived", intent: "enqueue" });

      expect(harness.store.hasProcessedMessage("idem-terminal-race")).toBe(true);
      expect(result.notes?.some((n) => n.includes("終端状態(archived)化"))).toBe(true);
    });
  });

  describe("終端task宛fenced answerのrequest収束", () => {
    it.each(["done", "archived"] as const)(
      "%s: 外側の非終端判定後に終端化してもfallback Tx内でterminal consumeへ切り替える",
      async (terminalStatus) => {
        const target = harness.store.createTask(
          taskInput({ status: "ready", title: `answer競合-${terminalStatus}`, body: "cwd: /tmp\n変更禁止" }),
          "tester",
        );
        const answerKey = `idem-terminal-answer-race-${terminalStatus}`;
        const requestId = setupAnsweringRequest(target.id, answerKey);
        const msg = baseMessage({
          to: { role: "worker", taskId: target.id },
          intent: "answer",
          payload: { message: "終端化と競合した回答" },
          idempotencyKey: answerKey,
        });
        harness.store.addComment(target.id, "orchestrator", serializeAgentMessage(msg));

        // messages stage外側の判定とfallbackAnswer内の初回読込では非終端だが、mark成功直後に
        // 別writerが終端化する競合を再現する。§12.19-3どおりTx内で再読込しなければ、
        // 通常fallbackが本文/コメントへ作用してrequestだけをresolvedにしてしまう。
        const originalMark = harness.store.markMessageProcessed.bind(harness.store);
        let raced = false;
        harness.store.markMessageProcessed = (taskId: string, idempotencyKey: string, actor: string): boolean => {
          const result = originalMark(taskId, idempotencyKey, actor);
          if (result && !raced && idempotencyKey === answerKey) {
            raced = true;
            makeTerminal(target.id, terminalStatus);
          }
          return result;
        };

        try {
          await messagesStage.tick(harness.deps, true, now());
        } finally {
          harness.store.markMessageProcessed = originalMark;
        }

        const terminalSnapshot = harness.store.getTask(target.id)!;
        expect(terminalSnapshot).toMatchObject({
          status: terminalStatus,
          body: "cwd: /tmp\n変更禁止",
        });
        if (terminalStatus === "done") {
          expect(terminalSnapshot.completedAt).not.toBeNull();
        } else {
          expect(terminalSnapshot.completedAt).toBeNull();
        }
        expect(harness.store.getOrchestratorRequest(requestId)?.status).toBe("resolved");
        expect(harness.store.listComments(target.id)).toHaveLength(1);
        const terminalEvents = harness.store.listEvents(target.id, "message_target_terminal");
        expect(terminalEvents).toHaveLength(1);
        expect(JSON.parse(terminalEvents[0]!.payload)).toMatchObject({
          status: terminalStatus,
          intent: "answer",
          idempotencyKey: answerKey,
        });
        const resolvedEvents = harness.store.listEvents(target.id, "orchestrator_request_terminal_answer_resolved");
        expect(resolvedEvents).toHaveLength(1);
        expect(JSON.parse(resolvedEvents[0]!.payload)).toMatchObject({
          requestId,
          mode: "consume",
          terminalStatus,
          evidence: ["message_processed", "message_target_terminal"],
        });
      },
    );

    it("外側の非終端判定後に終端化したanswer_key不一致もterminal consumeしrequestへ作用しない", async () => {
      const target = harness.store.createTask(taskInput({ status: "ready", title: "answer key不一致競合" }), "tester");
      const expectedAnswerKey = "idem-terminal-answer-race-expected";
      const actualAnswerKey = "idem-terminal-answer-race-mismatch";
      const requestId = setupAnsweringRequest(target.id, expectedAnswerKey);
      const msg = baseMessage({
        to: { role: "worker", taskId: target.id },
        intent: "answer",
        payload: { message: "key不一致の回答" },
        idempotencyKey: actualAnswerKey,
      });
      harness.store.addComment(target.id, "orchestrator", serializeAgentMessage(msg));

      const originalMark = harness.store.markMessageProcessed.bind(harness.store);
      harness.store.markMessageProcessed = (taskId: string, idempotencyKey: string, actor: string): boolean => {
        const result = originalMark(taskId, idempotencyKey, actor);
        if (result && idempotencyKey === actualAnswerKey) {
          makeTerminal(target.id, "archived");
        }
        return result;
      };

      try {
        await messagesStage.tick(harness.deps, true, now());
      } finally {
        harness.store.markMessageProcessed = originalMark;
      }

      expect(harness.store.getTask(target.id)?.status).toBe("archived");
      expect(harness.store.getOrchestratorRequest(requestId)?.status).toBe("answering");
      expect(harness.store.listComments(target.id)).toHaveLength(1);
      expect(harness.store.listEvents(target.id, "orchestrator_answer_unauthorized")).toHaveLength(0);
      const terminalEvents = harness.store.listEvents(target.id, "message_target_terminal");
      expect(terminalEvents).toHaveLength(1);
      expect(JSON.parse(terminalEvents[0]!.payload)).toMatchObject({
        status: "archived",
        intent: "answer",
        idempotencyKey: actualAnswerKey,
      });
      expect(harness.store.listEvents(target.id, "orchestrator_request_terminal_answer_resolved")).toHaveLength(0);
    });

    it.each(["done", "archived"] as const)(
      "%s task宛answerはtask不変のままexact requestを同一tickでresolvedにする",
      async (terminalStatus) => {
        const target = harness.store.createTask(
          taskInput({ status: "ready", title: `終端answer対象-${terminalStatus}`, body: "cwd: /tmp\n変更禁止" }),
          "tester",
        );
        const answerKey = `idem-terminal-answer-${terminalStatus}`;
        const requestId = setupAnsweringRequest(target.id, answerKey);
        makeTerminal(target.id, terminalStatus);
        const terminalSnapshot = harness.store.getTask(target.id)!;
        const msg = baseMessage({
          to: { role: "worker", taskId: target.id },
          intent: "answer",
          payload: { message: "終端後に届いた回答" },
          idempotencyKey: answerKey,
        });
        harness.store.addComment(target.id, "orchestrator", serializeAgentMessage(msg));

        const result = await messagesStage.tick(harness.deps, true, now());

        expect(result.actions).toBe(1);
        expect(harness.store.getOrchestratorRequest(requestId)?.status).toBe("resolved");
        expect(harness.store.getTask(target.id)).toMatchObject({
          status: terminalSnapshot.status,
          body: terminalSnapshot.body,
          completedAt: terminalSnapshot.completedAt,
        });
        expect(harness.store.listComments(target.id)).toHaveLength(1);
        expect(harness.store.listEvents(target.id, "message_target_terminal")).toHaveLength(1);
        const resolvedEvents = harness.store.listEvents(target.id, "orchestrator_request_terminal_answer_resolved");
        expect(resolvedEvents).toHaveLength(1);
        expect(JSON.parse(resolvedEvents[0]!.payload)).toMatchObject({
          requestId,
          mode: "consume",
          terminalStatus,
          evidence: ["message_processed", "message_target_terminal"],
        });
      },
    );

    it("answer_key不一致のterminal answerはrequestへ作用しない", async () => {
      const target = harness.store.createTask(taskInput({ status: "ready", title: "key mismatch" }), "tester");
      const requestId = setupAnsweringRequest(target.id, "idem-terminal-expected");
      makeTerminal(target.id, "done");
      const msg = baseMessage({
        to: { role: "worker", taskId: target.id },
        intent: "answer",
        payload: { message: "別keyの回答" },
        idempotencyKey: "idem-terminal-mismatch",
      });
      harness.store.addComment(target.id, "orchestrator", serializeAgentMessage(msg));

      await messagesStage.tick(harness.deps, true, now());
      await messagesStage.tick(harness.deps, true, now());

      expect(harness.store.getOrchestratorRequest(requestId)?.status).toBe("answering");
      expect(harness.store.listEvents(target.id, "orchestrator_request_terminal_answer_resolved")).toHaveLength(0);
    });

    it("answer以外のterminal messageはanswer_keyが一致してもrequestへ作用しない", async () => {
      const target = harness.store.createTask(taskInput({ status: "ready", title: "non-answer" }), "tester");
      const answerKey = "idem-terminal-non-answer";
      const requestId = setupAnsweringRequest(target.id, answerKey);
      makeTerminal(target.id, "archived");
      const msg = baseMessage({
        to: { role: "worker", taskId: target.id },
        intent: "steer",
        payload: { message: "終端後のsteer" },
        idempotencyKey: answerKey,
      });
      harness.store.addComment(target.id, "orchestrator", serializeAgentMessage(msg));

      await messagesStage.tick(harness.deps, true, now());
      await messagesStage.tick(harness.deps, true, now());

      expect(harness.store.getOrchestratorRequest(requestId)?.status).toBe("answering");
      expect(harness.store.listEvents(target.id, "orchestrator_request_terminal_answer_resolved")).toHaveLength(0);
    });

    it("既存stale answeringは同task・同keyのprocessed/terminal answer証跡が揃う場合だけreconcileする", async () => {
      const target = harness.store.createTask(taskInput({ status: "ready", title: "stale answering" }), "tester");
      const answerKey = "idem-terminal-stale";
      const requestId = setupAnsweringRequest(target.id, answerKey);
      makeTerminal(target.id, "done");
      const terminalSnapshot = harness.store.getTask(target.id)!;
      harness.store.markMessageProcessed(target.id, answerKey, "supervisor");
      harness.store.addEvent(target.id, "message_target_terminal", "supervisor", {
        status: "done",
        intent: "answer",
        idempotencyKey: answerKey,
      });

      const preview = await messagesStage.tick(harness.deps, false, now());
      expect(preview.actions).toBe(1);
      expect(harness.store.getOrchestratorRequest(requestId)?.status).toBe("answering");
      expect(harness.store.listEvents(target.id, "orchestrator_request_terminal_answer_resolved")).toHaveLength(0);

      const reconciled = await messagesStage.tick(harness.deps, true, now());

      expect(reconciled.actions).toBe(1);
      expect(harness.store.getOrchestratorRequest(requestId)?.status).toBe("resolved");
      expect(harness.store.getTask(target.id)).toMatchObject({
        status: terminalSnapshot.status,
        body: terminalSnapshot.body,
        completedAt: terminalSnapshot.completedAt,
      });
      const resolvedEvents = harness.store.listEvents(target.id, "orchestrator_request_terminal_answer_resolved");
      expect(resolvedEvents).toHaveLength(1);
      expect(JSON.parse(resolvedEvents[0]!.payload)).toMatchObject({ requestId, mode: "reconcile" });

      const second = await messagesStage.tick(harness.deps, true, now());
      expect(second.actions).toBe(0);
      expect(harness.store.listEvents(target.id, "orchestrator_request_terminal_answer_resolved")).toHaveLength(1);
    });

    it("stale answeringはexact processed証跡だけではreconcileしない", async () => {
      const target = harness.store.createTask(taskInput({ status: "ready", title: "partial stale evidence" }), "tester");
      const answerKey = "idem-terminal-partial";
      const requestId = setupAnsweringRequest(target.id, answerKey);
      makeTerminal(target.id, "archived");
      harness.store.markMessageProcessed(target.id, answerKey, "supervisor");
      harness.store.addEvent(target.id, "message_target_terminal", "supervisor", {
        status: "archived",
        intent: "answer",
        idempotencyKey: "idem-terminal-other",
      });

      const result = await messagesStage.tick(harness.deps, true, now());

      expect(result.actions).toBe(0);
      expect(harness.store.getOrchestratorRequest(requestId)?.status).toBe("answering");
      expect(harness.store.listEvents(target.id, "orchestrator_request_terminal_answer_resolved")).toHaveLength(0);
    });

    it("terminal consumeのrequest resolve失敗時はmark/event/request更新を同一Txでrollbackする", async () => {
      const target = harness.store.createTask(taskInput({ status: "ready", title: "terminal tx boundary" }), "tester");
      const answerKey = "idem-terminal-tx";
      const requestId = setupAnsweringRequest(target.id, answerKey);
      makeTerminal(target.id, "done");
      const terminalSnapshot = harness.store.getTask(target.id)!;
      const msg = baseMessage({
        to: { role: "worker", taskId: target.id },
        intent: "answer",
        payload: { message: "Tx境界確認" },
        idempotencyKey: answerKey,
      });
      harness.store.addComment(target.id, "orchestrator", serializeAgentMessage(msg));

      const originalResolve = harness.store.resolveOrchestratorRequestByAnswerKey.bind(harness.store);
      harness.store.resolveOrchestratorRequestByAnswerKey = (taskId: string, key: string) => {
        const resolved = originalResolve(taskId, key);
        if (resolved !== null) {
          throw new Error("injected resolve failure");
        }
        return resolved;
      };
      try {
        await expect(messagesStage.tick(harness.deps, true, now())).rejects.toThrow("injected resolve failure");
      } finally {
        harness.store.resolveOrchestratorRequestByAnswerKey = originalResolve;
      }

      expect(harness.store.getOrchestratorRequest(requestId)?.status).toBe("answering");
      expect(harness.store.hasProcessedMessage(answerKey)).toBe(false);
      expect(harness.store.listEvents(target.id, "message_target_terminal")).toHaveLength(0);
      expect(harness.store.listEvents(target.id, "orchestrator_request_terminal_answer_resolved")).toHaveLength(0);
      expect(harness.store.getTask(target.id)).toMatchObject({
        status: terminalSnapshot.status,
        body: terminalSnapshot.body,
        completedAt: terminalSnapshot.completedAt,
      });
    });
  });

  describe("malformed メッセージの監査記録（docs/contract.md §12.11-4）", () => {
    it("不正な JSON ブロックを含むコメントは message_parse_failed イベントを1回だけ記録しカーソルを進める", async () => {
      const target = harness.store.createTask(taskInput({ status: "ready", title: "不正メッセージ" }), "tester");
      const comment = harness.store.addComment(target.id, "worker", "```agent-message-v1\n{ invalid json\n```");

      const result = await messagesStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);

      const events = harness.store.listEvents(target.id, "message_parse_failed");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({ commentId: comment.id });

      expect(readMessagesCursor(harness.deps.env)).toBe(comment.id);

      // 新規コメントが無い2回目の tick では再走査されず、重複記録されない
      const second = await messagesStage.tick(harness.deps, true, now());
      expect(second.actions).toBe(0);
      expect(harness.store.listEvents(target.id, "message_parse_failed")).toHaveLength(1);
    });

    it("カーソルが巻き戻り同一コメントが再走査されても message_parse_failed は重複記録しない（comment id スコープの冪等）", async () => {
      const target = harness.store.createTask(taskInput({ status: "ready", title: "不正メッセージ再走査" }), "tester");
      harness.store.addComment(target.id, "worker", "```agent-message-v1\n{ invalid json\n```");

      await messagesStage.tick(harness.deps, true, now());
      expect(harness.store.listEvents(target.id, "message_parse_failed")).toHaveLength(1);

      // クラッシュ等でカーソルが巻き戻ったケースを再現する
      writeMessagesCursor(harness.deps.env, 0, harness.deps.logger);
      const result = await messagesStage.tick(harness.deps, true, now());

      expect(result.actions).toBe(0);
      expect(harness.store.listEvents(target.id, "message_parse_failed")).toHaveLength(1);
    });

    it("スキーマ検証失敗（intent不正等）のブロックも message_parse_failed を記録する", async () => {
      const target = harness.store.createTask(taskInput({ status: "ready", title: "スキーマ不正" }), "tester");
      const comment = harness.store.addComment(
        target.id,
        "worker",
        '```agent-message-v1\n{"schema":"agent.message.v1","intent":"not-a-real-intent"}\n```',
      );

      const result = await messagesStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);

      const events = harness.store.listEvents(target.id, "message_parse_failed");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({ commentId: comment.id });
    });

    it("dry-run では actions を計上するがイベントを記録しない", async () => {
      const target = harness.store.createTask(taskInput({ status: "ready", title: "不正メッセージdry" }), "tester");
      harness.store.addComment(target.id, "worker", "```agent-message-v1\n{ invalid json\n```");

      const result = await messagesStage.tick(harness.deps, false, now());
      expect(result.actions).toBe(1);
      expect(harness.store.listEvents(target.id, "message_parse_failed")).toHaveLength(0);
    });
  });
});
