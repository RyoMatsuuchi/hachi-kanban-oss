import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskInput } from "@hachi/testing";
import type { ProcessEntry, StopResult } from "@hachi/core";
import { FakeAdapter, setupHarness, type TestHarness } from "../test-support.js";
import { createReapStage } from "./reap.js";

function parseEventPayload(payload: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(payload);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("event payload が object ではありません");
  }
  return parsed as Record<string, unknown>;
}

function readLogEntries(harness: TestHarness): Array<Record<string, unknown>> {
  const path = join(harness.home.home, "test-supervisor.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function proc(pid: number, ppid: number, etime: string, command: string, pgid = pid, startTime = `start-${pid}`): ProcessEntry {
  return { pid, ppid, pgid, etime, startTime, command };
}

describe("reapStage", () => {
  let harness: TestHarness;
  const stage = createReapStage({
    listProcesses: async () => [],
    signalProcess: () => {},
    delay: async () => {},
  });

  beforeEach(async () => {
    harness = await setupHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("親タスクが done の run は released になる", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "完了予定" }), "tester");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=sess-1 server=http://x started=2026-07-02T10:00:00+09:00",
      "tester",
    );
    const run = harness.store.startRun(task.id, "codex", "sess-1", {});
    harness.store.transition({ taskId: task.id, to: "done", actor: "tester" });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);

    expect(harness.store.listOpenRuns().find((r) => r.id === run.id)).toBeUndefined();
    expect(harness.store.listEvents(task.id, "run_released")).toHaveLength(1);
  });

  it("親タスクが done でも cancel stop 証拠待ちの run は released にしない", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "cancel待ち" }), "tester");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=cancel-reap server=http://x",
      "tester",
    );
    const run = harness.store.startRun(task.id, "codex", "cancel-reap", { serverUrl: "http://x" });
    harness.store.createOrGetRunCancelRequest({
      taskId: task.id,
      runId: run.id,
      sessionId: run.sessionId,
      provider: run.provider,
      requestNonce: "cancel-reap-gate",
      actor: "supervisor",
      reason: "reap gate test",
      deadlineAt: Math.floor(Date.now() / 1000) + 60,
    });
    harness.store.transition({ taskId: task.id, to: "done", actor: "tester" });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(0);
    expect(result.notes).toContainEqual(expect.stringContaining("cancel stop 証拠待ち"));
    expect(harness.store.listOpenRuns().find((candidate) => candidate.id === run.id)).toBeDefined();
    expect(harness.store.listEvents(task.id, "run_released")).toHaveLength(0);
  });

  it("孤児 run を released する前に bridge セッションへ中断注入する", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "中断注入" }), "tester");
    const ref = await harness.deps.adapters.codex.launch(task, {
      model: "gpt-5.4",
      cwd: "/work",
      promptText: "作業開始",
    });
    const run = harness.store.startRun(task.id, "codex", ref.sessionId, {
      serverUrl: ref.serverUrl,
      model: ref.model,
      modelDelivery: ref.modelDelivery,
    });
    harness.store.block(
      task.id,
      `codex-in-progress: 実装中 tmux=none even-session=${ref.sessionId} server=${ref.serverUrl} started=2026-07-02T10:00:00+09:00`,
      "tester",
    );
    harness.store.transition({ taskId: task.id, to: "done", actor: "tester" });

    const requestCountBefore = harness.codexBridge.requests.length;
    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.listOpenRuns().find((r) => r.id === run.id)).toBeUndefined();

    const promptRequests = harness.codexBridge.requests
      .slice(requestCountBefore)
      .filter((request) => request.path === "/api/prompt" && request.method === "POST");
    expect(promptRequests).toHaveLength(1);
    expect(promptRequests[0]?.body).toMatchObject({
      provider: "codex",
      sessionId: ref.sessionId,
    });
    expect((promptRequests[0]?.body as { text?: string }).text).toContain("run は released されました");

    const events = harness.store.listEvents(task.id, "run_released");
    expect(events).toHaveLength(1);
    expect(parseEventPayload(events[0]!.payload)).toMatchObject({ runId: run.id, injected: true });
  });

  it("bridge 不達でも孤児 run の released は完了し injected=false を記録する", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "bridge 不達" }), "tester");
    const run = harness.store.startRun(task.id, "codex", "sess-unreachable", {
      serverUrl: harness.codexBridge.url,
      model: "gpt-5.4",
      modelDelivery: "none",
    });
    harness.store.block(
      task.id,
      `codex-in-progress: 実装中 tmux=none even-session=sess-unreachable server=${harness.codexBridge.url} started=2026-07-02T10:00:00+09:00`,
      "tester",
    );
    harness.store.transition({ taskId: task.id, to: "done", actor: "tester" });
    await harness.codexBridge.close();

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.listOpenRuns().find((r) => r.id === run.id)).toBeUndefined();
    const events = harness.store.listEvents(task.id, "run_released");
    expect(events).toHaveLength(1);
    expect(parseEventPayload(events[0]!.payload)).toMatchObject({ runId: run.id, injected: false });
  });

  it("direct run は bridge 中断注入をスキップする", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "direct run" }), "tester");
    const run = harness.store.startRun(task.id, "codex", "direct-session", {
      serverUrl: "direct",
      model: "gpt-5.4",
      modelDelivery: "native",
      transport: "direct",
    });
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=direct-session server=direct started=2026-07-02T10:00:00+09:00",
      "tester",
    );
    harness.store.transition({ taskId: task.id, to: "done", actor: "tester" });

    const requestCountBefore = harness.codexBridge.requests.length;
    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.listOpenRuns().find((r) => r.id === run.id)).toBeUndefined();
    expect(harness.codexBridge.requests).toHaveLength(requestCountBefore);
    const events = harness.store.listEvents(task.id, "run_released");
    expect(events).toHaveLength(1);
    expect(parseEventPayload(events[0]!.payload)).toMatchObject({ runId: run.id, injected: false });
  });

  it("direct run を released する時は direct adapter.stop で process group cleanup を行う", async () => {
    const adapter = new FakeAdapter("codex");
    harness.deps.directAdapters = { codex: adapter };
    const task = harness.store.createTask(taskInput({ status: "ready", title: "direct cleanup" }), "tester");
    const run = harness.store.startRun(task.id, "codex", "direct-cleanup", {
      serverUrl: "direct",
      model: "gpt-5.4",
      modelDelivery: "native",
      transport: "direct",
    });
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=direct-cleanup server=direct started=2026-07-02T10:00:00+09:00",
      "tester",
    );
    harness.store.transition({ taskId: task.id, to: "done", actor: "tester" });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(adapter.stopCalls.map((ref) => ref.sessionId)).toEqual(["direct-cleanup"]);
    expect(harness.store.listOpenRuns().find((r) => r.id === run.id)).toBeUndefined();
    const events = harness.store.listEvents(task.id, "run_released");
    expect(events).toHaveLength(1);
    expect(parseEventPayload(events[0]!.payload)).toMatchObject({
      runId: run.id,
      injected: false,
      directCleanup: true,
    });
  });

  it("direct run released 時の adapter.stop が unsignalable を返した場合は directCleanup:false と reason を記録し、例外扱いにはしない（契約 §34.2.1）", async () => {
    const adapter = new FakeAdapter("codex");
    adapter.stopResponse = { stopped: false, reason: "unsignalable" };
    harness.deps.directAdapters = { codex: adapter };
    const task = harness.store.createTask(taskInput({ status: "ready", title: "direct cleanup unsignalable" }), "tester");
    const run = harness.store.startRun(task.id, "codex", "direct-cleanup-unsignalable", {
      serverUrl: "direct",
      model: "gpt-5.4",
      modelDelivery: "native",
      transport: "direct",
    });
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=direct-cleanup-unsignalable server=direct started=2026-07-02T10:00:00+09:00",
      "tester",
    );
    harness.store.transition({ taskId: task.id, to: "done", actor: "tester" });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(adapter.stopCalls.map((ref) => ref.sessionId)).toEqual(["direct-cleanup-unsignalable"]);
    expect(harness.store.listOpenRuns().find((r) => r.id === run.id)).toBeUndefined();
    const events = harness.store.listEvents(task.id, "run_released");
    expect(events).toHaveLength(1);
    expect(parseEventPayload(events[0]!.payload)).toMatchObject({
      runId: run.id,
      injected: false,
      directCleanup: false,
      reason: "unsignalable",
    });
    const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
    expect(log).toContain("停止を確認できませんでした");
    expect(log).toContain('"reason":"unsignalable"');
  });

  // 契約 §34.2.1: `StopResult` の全6値（terminated/killed/already-exited/unsupported/
  // unsignalable/kill-unconfirmed）が reap.ts の directCleanup/reason（run_released イベントの
  // 証拠キーは reason 固定）へ契約どおり写ることを表駆動で網羅する。terminated/killed だけ
  // directCleanup:true、残る4値は directCleanup:false（§34.2.1「表」・cleanupReleasedDirectRun の実装規則）。
  const stopResultCases: Array<{ stopResponse: StopResult; expectedDirectCleanup: boolean }> = [
    { stopResponse: { stopped: true, reason: "terminated" }, expectedDirectCleanup: true },
    { stopResponse: { stopped: true, reason: "killed" }, expectedDirectCleanup: true },
    { stopResponse: { stopped: false, reason: "already-exited" }, expectedDirectCleanup: false },
    { stopResponse: { stopped: false, reason: "unsupported" }, expectedDirectCleanup: false },
    { stopResponse: { stopped: false, reason: "unsignalable" }, expectedDirectCleanup: false },
    { stopResponse: { stopped: false, reason: "kill-unconfirmed" }, expectedDirectCleanup: false },
  ];

  it.each(stopResultCases)(
    "direct run released 時、adapter.stop が $stopResponse.reason を返すと directCleanup:$expectedDirectCleanup かつ reason が run_released イベントへ記録される（契約 §34.2.1 全6値網羅）",
    async ({ stopResponse, expectedDirectCleanup }) => {
      const adapter = new FakeAdapter("codex");
      adapter.stopResponse = stopResponse;
      harness.deps.directAdapters = { codex: adapter };
      const sessionId = `direct-cleanup-${stopResponse.reason}`;
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: `direct cleanup ${stopResponse.reason}` }),
        "tester",
      );
      const run = harness.store.startRun(task.id, "codex", sessionId, {
        serverUrl: "direct",
        model: "gpt-5.4",
        modelDelivery: "native",
        transport: "direct",
      });
      harness.store.block(
        task.id,
        `codex-in-progress: 実装中 tmux=none even-session=${sessionId} server=direct started=2026-07-02T10:00:00+09:00`,
        "tester",
      );
      harness.store.transition({ taskId: task.id, to: "done", actor: "tester" });

      const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(adapter.stopCalls.map((ref) => ref.sessionId)).toEqual([sessionId]);
      expect(harness.store.listOpenRuns().find((r) => r.id === run.id)).toBeUndefined();
      const events = harness.store.listEvents(task.id, "run_released");
      expect(events).toHaveLength(1);
      expect(parseEventPayload(events[0]!.payload)).toMatchObject({
        runId: run.id,
        injected: false,
        directCleanup: expectedDirectCleanup,
        reason: stopResponse.reason,
      });
    },
  );

  it("進行中（blocked + in-progress reason）の run は released にならない", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "進行中" }), "tester");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=sess-2 server=http://x started=2026-07-02T10:00:00+09:00",
      "tester",
    );
    const run = harness.store.startRun(task.id, "codex", "sess-2", {});

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(0);
    expect(harness.store.listOpenRuns().find((r) => r.id === run.id)).toBeDefined();
  });

  it("deadline 内の question_awaiting run は孤児扱いしない", async () => {
    const now = Math.floor(Date.now() / 1000);
    const task = harness.store.createTask(taskInput({ status: "ready", title: "質問待機" }), "tester");
    harness.store.block(task.id, "worker-question: 仕様確認", "tester");
    const run = harness.store.startRun(task.id, "codex", "sess-live-question", {
      serverUrl: harness.codexBridge.url,
      transport: "bridge",
    });
    harness.store.addEvent(task.id, "question_awaiting", "supervisor", {
      sessionId: "sess-live-question",
      baselineResultCount: 1,
      deadline: now + 60,
      questionId: "q_live",
    });

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(0);
    expect(harness.store.listOpenRuns().find((r) => r.id === run.id)).toBeDefined();
    expect(harness.store.listEvents(task.id, "question_expired")).toHaveLength(0);
  });

  it("deadline 超過の question_awaiting run は question_expired を記録して released にする", async () => {
    const now = Math.floor(Date.now() / 1000);
    const task = harness.store.createTask(taskInput({ status: "ready", title: "質問期限切れ" }), "tester");
    harness.store.block(task.id, "worker-question: 仕様確認", "tester");
    const run = harness.store.startRun(task.id, "codex", "sess-expired-question", {
      serverUrl: harness.codexBridge.url,
      transport: "bridge",
    });
    harness.store.addEvent(task.id, "question_awaiting", "supervisor", {
      sessionId: "sess-expired-question",
      baselineResultCount: 1,
      deadline: now - 1,
      questionId: "q_expired",
    });
    const requestCountBefore = harness.codexBridge.requests.length;

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(harness.store.listOpenRuns().find((r) => r.id === run.id)).toBeUndefined();
    expect(harness.codexBridge.requests).toHaveLength(requestCountBefore);
    const events = harness.store.listEvents(task.id, "question_expired");
    expect(events).toHaveLength(1);
    expect(parseEventPayload(events[0]!.payload)).toMatchObject({
      sessionId: "sess-expired-question",
      runId: run.id,
      questionId: "q_expired",
      baselineResultCount: 1,
    });
  });

  it("deadline 超過でも question_answering lease が有効なら released しない", async () => {
    const now = Math.floor(Date.now() / 1000);
    const task = harness.store.createTask(taskInput({ status: "ready", title: "回答注入中" }), "tester");
    harness.store.block(task.id, "worker-question: 仕様確認", "tester");
    const run = harness.store.startRun(task.id, "codex", "sess-answering-question", {
      serverUrl: harness.codexBridge.url,
      transport: "bridge",
    });
    harness.store.addEvent(task.id, "question_awaiting", "supervisor", {
      sessionId: "sess-answering-question",
      baselineResultCount: 1,
      deadline: now - 1,
      questionId: "q_answering",
    });
    harness.store.addEvent(task.id, "question_answering", "supervisor", {
      sessionId: "sess-answering-question",
      runId: run.id,
      questionId: "q_answering",
      idempotencyKey: "idem-answering",
      leaseUntil: now + 60,
    });

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(0);
    expect(harness.store.listOpenRuns().find((r) => r.id === run.id)).toBeDefined();
    expect(harness.store.listEvents(task.id, "question_expired")).toHaveLength(0);
  });

  it("deadline 超過の release Tx 内で answer lease が claim 済みなら released しない", async () => {
    const now = Math.floor(Date.now() / 1000);
    const task = harness.store.createTask(taskInput({ status: "ready", title: "回答注入競合" }), "tester");
    harness.store.block(task.id, "worker-question: 仕様確認", "tester");
    const run = harness.store.startRun(task.id, "codex", "sess-answering-race", {
      serverUrl: harness.codexBridge.url,
      transport: "bridge",
    });
    harness.store.addEvent(task.id, "question_awaiting", "supervisor", {
      sessionId: "sess-answering-race",
      baselineResultCount: 1,
      deadline: now - 1,
      questionId: "q_answering_race",
    });
    const originalTransaction = harness.store.transaction.bind(harness.store) as typeof harness.store.transaction;
    let injected = false;
    harness.store.transaction = (<T>(fn: () => T): T =>
      originalTransaction(() => {
        if (!injected) {
          injected = true;
          harness.store.addEvent(task.id, "question_answering", "supervisor", {
            sessionId: "sess-answering-race",
            runId: run.id,
            questionId: "q_answering_race",
            idempotencyKey: "idem-answering-race",
            leaseUntil: now + 60,
          });
        }
        return fn();
      })) as typeof harness.store.transaction;

    try {
      const result = await stage.tick(harness.deps, true, now);

      expect(result.actions).toBe(0);
      expect(harness.store.listOpenRuns().find((r) => r.id === run.id)).toBeDefined();
      expect(harness.store.listEvents(task.id, "question_expired")).toHaveLength(0);
    } finally {
      harness.store.transaction = originalTransaction;
    }
  });

  it("answer 後に新 run が起動しても旧 question_awaiting run を released する", async () => {
    const now = Math.floor(Date.now() / 1000);
    const task = harness.store.createTask(taskInput({ status: "ready", title: "質問回答後" }), "tester");
    harness.store.block(task.id, "worker-question: 仕様確認", "tester");
    const oldRun = harness.store.startRun(task.id, "codex", "sess-answer-old", {
      serverUrl: harness.codexBridge.url,
      transport: "bridge",
    });
    harness.store.addEvent(task.id, "question_awaiting", "supervisor", {
      sessionId: "sess-answer-old",
      baselineResultCount: 1,
      deadline: now + 60,
      questionId: "q_answer_old",
    });

    harness.store.unblock(task.id, "ready", "tester");
    const newRun = harness.store.startRun(task.id, "codex", "sess-answer-new", {
      serverUrl: harness.codexBridge.url,
      transport: "bridge",
    });
    harness.store.block(
      task.id,
      `codex-in-progress: 実装中 tmux=none even-session=sess-answer-new server=${harness.codexBridge.url} started=2026-07-02T10:00:00+09:00`,
      "tester",
    );

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(harness.store.listOpenRuns().find((r) => r.id === oldRun.id)).toBeUndefined();
    expect(harness.store.listOpenRuns().find((r) => r.id === newRun.id)).toBeDefined();
    const released = harness.store.listEvents(task.id, "run_released");
    expect(released).toHaveLength(1);
    expect(parseEventPayload(released[0]!.payload)).toMatchObject({ runId: oldRun.id });
  });

  it("status='review' の reviewer run は released にならない（docs/contract.md §15: review は block しない設計）", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "レビュー中" }), "tester");
    harness.store.block(task.id, "codex-in-progress: 実装中 even-session=sess-worker", "tester");
    harness.store.unblock(task.id, "review", "tester");
    const run = harness.store.startRun(task.id, "codex", "sess-reviewer", { role: "reviewer" });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(0);
    expect(harness.store.listOpenRuns().find((r) => r.id === run.id)).toBeDefined();
  });

  it("status='review' の古い reviewer run は released し、最新 reviewer run だけ保護する", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "レビュー旧run" }), "tester");
    harness.store.block(task.id, "codex-in-progress: 実装中 even-session=sess-worker", "tester");
    harness.store.unblock(task.id, "review", "tester");
    const staleReviewerRun = harness.store.startRun(task.id, "codex", "sess-reviewer-stale", { role: "reviewer" });
    const currentReviewerRun = harness.store.startRun(task.id, "codex", "sess-reviewer-current", { role: "reviewer" });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.listOpenRuns().find((r) => r.id === staleReviewerRun.id)).toBeUndefined();
    expect(harness.store.listOpenRuns().find((r) => r.id === currentReviewerRun.id)).toBeDefined();
  });

  it("status='review' でも reviewer でない stale run は released する", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "レビュー中の旧run" }), "tester");
    harness.store.block(task.id, "codex-in-progress: 実装中 even-session=sess-worker", "tester");
    const staleRun = harness.store.startRun(task.id, "codex", "sess-worker", {});
    harness.store.unblock(task.id, "review", "tester");
    const reviewerRun = harness.store.startRun(task.id, "codex", "sess-reviewer-current", { role: "reviewer" });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.listOpenRuns().find((r) => r.id === staleRun.id)).toBeUndefined();
    expect(harness.store.listOpenRuns().find((r) => r.id === reviewerRun.id)).toBeDefined();
  });

  it("blocked だが in-progress prefix でなくなった run は released になる", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "モデル判断待ち" }), "tester");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=sess-3 server=http://x started=2026-07-02T10:00:00+09:00",
      "tester",
    );
    const run = harness.store.startRun(task.id, "codex", "sess-3", {});
    harness.store.unblock(task.id, "review", "tester");
    harness.store.block(task.id, "review-required: 確認待ち", "tester");

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);
    expect(harness.store.listOpenRuns().find((r) => r.id === run.id)).toBeUndefined();
  });

  it("dry-run は判定のみで endRun しない", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "完了予定" }), "tester");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=sess-4 server=http://x started=2026-07-02T10:00:00+09:00",
      "tester",
    );
    const run = harness.store.startRun(task.id, "codex", "sess-4", {});
    harness.store.transition({ taskId: task.id, to: "done", actor: "tester" });

    const result = await stage.tick(harness.deps, false, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);
    expect(harness.store.listOpenRuns().find((r) => r.id === run.id)).toBeDefined();
  });

  describe("bridge 孤児プロセスハイジーン（docs/contract.md §51.2）", () => {
    it("dry-run は件数 note のみで signal も bridge_orphan_subtree_reaped event も書かない", async () => {
      const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
      const processStage = createReapStage({
        listProcesses: async () => [
          proc(10, 1, "01:00", "kanban-shared-app-server"),
          proc(20, 10, "01:00", "codex"),
          proc(30, 20, "03:00:01", "mcp-old"),
        ],
        signalProcess: (pid, signal): void => {
          signals.push({ pid, signal });
        },
        delay: async () => {},
      });

      const result = await processStage.tick(harness.deps, false, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(result.notes?.some((note) => note.includes("dry-run: bridge 孤児プロセス 1 件"))).toBe(true);
      expect(signals).toHaveLength(0);
      expect(readLogEntries(harness).filter((entry) => entry["msg"] === "bridge_orphan_subtree_reaped"))
        .toHaveLength(0);
    });

    it("apply は標的 1 件の subtree へ signal を送り bridge_orphan_subtree_reaped event を 1 件書く", async () => {
      const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
      const waits: number[] = [];
      const rootCommand = `mcp-old-parent-${"x".repeat(220)}`;
      const processStage = createReapStage({
        listProcesses: async () => [
          proc(10, 1, "01:00", "kanban-shared-app-server"),
          proc(20, 10, "01:00", "codex"),
          proc(30, 20, "03:00:01", rootCommand),
          proc(31, 30, "03:00:01", "mcp-old-child"),
        ],
        signalProcess: (pid, signal): void => {
          signals.push({ pid, signal });
        },
        delay: async (ms): Promise<void> => {
          waits.push(ms);
        },
      });

      const result = await processStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(waits).toEqual([10_000]);
      expect(signals).toEqual([
        { pid: 31, signal: "SIGTERM" },
        { pid: 30, signal: "SIGTERM" },
        { pid: 31, signal: 0 },
        { pid: 30, signal: 0 },
        { pid: 31, signal: "SIGKILL" },
        { pid: 30, signal: "SIGKILL" },
      ]);
      const events = readLogEntries(harness)
        .filter((entry) => entry["msg"] === "bridge_orphan_subtree_reaped");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        level: "info",
        rootPid: 30,
        attemptedPids: [31, 30],
        failedPids: [],
        rootCommand: rootCommand.slice(0, 200),
        rootEtime: "03:00:01",
        thresholdSeconds: 9_000,
      });
    });

    it("ESRCH を正常 return する sender でも apply なら bridge_orphan_subtree_reaped event を 1 件書く", async () => {
      const processStage = createReapStage({
        listProcesses: async () => [
          proc(10, 1, "01:00", "kanban-shared-app-server"),
          proc(20, 10, "01:00", "codex"),
          proc(30, 20, "03:00:01", "mcp-old-parent"),
          proc(31, 30, "03:00:01", "mcp-old-child"),
        ],
        // core の signalProcess が ESRCH を握りつぶす場合と同じく正常 return する。
        signalProcess: () => {},
        delay: async () => {},
      });

      const result = await processStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const events = readLogEntries(harness)
        .filter((entry) => entry["msg"] === "bridge_orphan_subtree_reaped");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        attemptedPids: [31, 30],
        failedPids: [],
      });
    });

    it("grace 待ちへ入る前に bridge_orphan_subtree_reaped event を書く", async () => {
      const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
      let notifyGraceStarted: (() => void) | undefined;
      let releaseGrace: (() => void) | undefined;
      const graceStarted = new Promise<void>((resolve) => {
        notifyGraceStarted = resolve;
      });
      const graceWait = new Promise<void>((resolve) => {
        releaseGrace = resolve;
      });
      const processStage = createReapStage({
        listProcesses: async () => [
          proc(10, 1, "01:00", "kanban-shared-app-server"),
          proc(20, 10, "01:00", "codex"),
          proc(30, 20, "03:00:01", "mcp-old-parent"),
          proc(31, 30, "03:00:01", "mcp-old-child"),
        ],
        signalProcess: (pid, signal): void => {
          signals.push({ pid, signal });
        },
        delay: async (): Promise<void> => {
          notifyGraceStarted?.();
          await graceWait;
        },
      });

      const tickPromise = processStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
      await graceStarted;

      try {
        expect(signals).toEqual([
          { pid: 31, signal: "SIGTERM" },
          { pid: 30, signal: "SIGTERM" },
        ]);
        expect(readLogEntries(harness).filter((entry) => entry["msg"] === "bridge_orphan_subtree_reaped"))
          .toHaveLength(1);
      } finally {
        releaseGrace?.();
      }

      await tickPromise;
    });

    it("SIGKILL はスナップショット PID の開始時刻が変わった場合に送らない", async () => {
      const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
      let listCalls = 0;
      const processStage = createReapStage({
        listProcesses: async () => {
          listCalls += 1;
          if (listCalls === 1) {
            return [
              proc(10, 1, "01:00", "kanban-shared-app-server"),
              proc(20, 10, "01:00", "codex"),
              proc(30, 20, "03:00:01", "mcp-old-parent"),
              proc(31, 30, "03:00:01", "mcp-old-child"),
            ];
          }
          return [
            proc(10, 1, "01:00", "kanban-shared-app-server"),
            proc(20, 10, "01:00", "codex"),
            proc(30, 1, "03:00:11", "unrelated-reused-pid", 30, "reused-30"),
            proc(31, 30, "03:00:11", "unrelated-child", 31, "reused-31"),
          ];
        },
        signalProcess: (pid, signal): void => {
          signals.push({ pid, signal });
        },
        delay: async () => {},
      });

      const result = await processStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(listCalls).toBe(2);
      expect(signals).toEqual([
        { pid: 31, signal: "SIGTERM" },
        { pid: 30, signal: "SIGTERM" },
      ]);
    });

    it("SIGTERM 後に親だけ消えて子が reparent されてもスナップショット由来で子へ SIGKILL を送る", async () => {
      const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
      let listCalls = 0;
      const processStage = createReapStage({
        listProcesses: async () => {
          listCalls += 1;
          if (listCalls === 1) {
            return [
              proc(10, 1, "01:00", "kanban-shared-app-server"),
              proc(20, 10, "01:00", "codex"),
              proc(30, 20, "03:00:01", "mcp-old-parent"),
              proc(31, 30, "03:00:01", "mcp-old-child"),
            ];
          }
          return [
            proc(10, 1, "01:00", "kanban-shared-app-server"),
            proc(20, 10, "01:00", "codex"),
            proc(31, 1, "03:00:11", "mcp-old-child"),
          ];
        },
        signalProcess: (pid, signal): void => {
          signals.push({ pid, signal });
        },
        delay: async () => {},
      });

      const result = await processStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(listCalls).toBe(2);
      // §51.2 注記: スナップショット後に生まれた孫はこの tick では追わず、次 tick の走査に委ねる。
      expect(signals).toEqual([
        { pid: 31, signal: "SIGTERM" },
        { pid: 30, signal: "SIGTERM" },
        { pid: 31, signal: 0 },
        { pid: 31, signal: "SIGKILL" },
      ]);
    });

    it("operational notify の既存閾値どおり 10 件では送らず 11 件で送る", async () => {
      for (const expectedTargets of [10, 11]) {
        let notified = 0;
        const processStage = createReapStage({
          listProcesses: async () => [
            proc(10, 1, "01:00", "kanban-shared-app-server"),
            proc(20, 10, "01:00", "codex"),
            ...Array.from({ length: expectedTargets }, (_, index) => proc(100 + index, 20, "03:00:01", "mcp-old")),
          ],
          signalProcess: () => {},
          delay: async () => {},
          notifyOperational: async () => {
            notified += 1;
            return { attempted: false, sent: false };
          },
        });

        const result = await processStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

        expect(result.actions).toBe(expectedTargets);
        expect(notified).toBe(expectedTargets > 10 ? 1 : 0);
      }
    });
  });

  describe("stale claim の定期清掃（docs/contract.md §12.8-2）", () => {
    it("stale claim（ready + claim_lock 10分以上更新無し）を解放し再 dispatch 可能にする", async () => {
      const task = harness.store.createTask(taskInput({ status: "ready", title: "stale claim" }), "tester");
      harness.store.claimTask(task.id, "stale-token", "other-supervisor");

      // reap の閾値(10分)を確実に超えさせるため、十分未来の now を渡す（実時間の待機なし）
      const farFutureNow = Math.floor(Date.now() / 1000) + 10_000;
      const result = await stage.tick(harness.deps, true, farFutureNow);

      expect(result.actions).toBeGreaterThanOrEqual(1);
      expect(result.notes?.some((n) => n.includes("stale claim"))).toBe(true);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("ready");
      expect(updated?.claimLock).toBe("");

      const events = harness.store.listEvents(task.id, "stale_claim_cleared");
      expect(events).toHaveLength(1);

      // stale claim 解放後は再度 claim できる（dispatch が再度対象にできる）
      expect(harness.store.claimTask(task.id, "fresh-token", "supervisor")).toBe(true);
    });

    it("10分以内の claim は解放しない", async () => {
      const task = harness.store.createTask(taskInput({ status: "ready", title: "fresh claim" }), "tester");
      harness.store.claimTask(task.id, "fresh-token", "other-supervisor");

      const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.notes?.some((n) => n.includes("stale claim"))).toBe(false);
      expect(harness.store.getTask(task.id)?.claimLock).toBe("fresh-token");
    });

    it("dry-run は対象件数のみ note し実際には解放しない", async () => {
      const task = harness.store.createTask(taskInput({ status: "ready", title: "dry-run stale" }), "tester");
      harness.store.claimTask(task.id, "stale-token", "other-supervisor");

      const farFutureNow = Math.floor(Date.now() / 1000) + 10_000;
      const result = await stage.tick(harness.deps, false, farFutureNow);

      expect(result.notes?.some((n) => n.includes("dry-run: stale claim"))).toBe(true);
      // dry-run のため実際の claim_lock は変化しない
      expect(harness.store.getTask(task.id)?.claimLock).toBe("stale-token");
    });
  });
});
