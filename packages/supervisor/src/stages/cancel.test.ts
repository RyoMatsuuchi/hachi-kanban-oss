import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskInput } from "@hachi/testing";
import type { RunCancelRequestRow, RunRow, TaskRow } from "@hachi/core";
import { FakeAdapter, setupHarness, type TestHarness } from "../test-support.js";
import { cancelStage, rejectLateResultOnce } from "./cancel.js";

describe("cancelStage durable cancel engine", () => {
  let harness: TestHarness;
  let adapter: FakeAdapter;

  beforeEach(async () => {
    harness = await setupHarness();
    adapter = new FakeAdapter("codex");
    harness.deps.adapters = { ...harness.deps.adapters, codex: adapter };
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function running(sessionId = "cancel-session", serverUrl = "http://bridge"): {
    task: TaskRow;
    run: RunRow;
  } {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "cancel対象", body: "cwd: /worktrees/cancel-target" }),
      "tester",
    );
    const blocked = harness.store.block(
      task.id,
      `codex-in-progress: 実装中 tmux=none even-session=${sessionId} server=${serverUrl}`,
      "tester",
    );
    const run = harness.store.startRun(task.id, "codex", sessionId, {
      serverUrl,
      transport: serverUrl === "direct" ? "direct" : "bridge",
    });
    return { task: blocked, run };
  }

  function request(run: RunRow, deadlineAt: number): RunCancelRequestRow {
    return harness.store.createOrGetRunCancelRequest({
      taskId: run.taskId,
      runId: run.id,
      sessionId: run.sessionId,
      provider: run.provider,
      requestNonce: `nonce-${run.id}`,
      actor: "supervisor",
      reason: "stall/no-progress",
      deadlineAt,
    });
  }

  function ack(cancel: RunCancelRequestRow, nonce = cancel.requestNonce): Record<string, unknown> {
    return {
      cancelAck: {
        schemaVersion: "cancel-ack.v1",
        requestId: cancel.id,
        requestNonce: nonce,
        runId: cancel.runId,
        sessionId: cancel.sessionId,
        cancelFence: cancel.cancelFence,
      },
    };
  }

  it("inject/message_processed は ack とみなさず cooperative_sent で継続する", async () => {
    const { run } = running();
    const cancel = request(run, 2_000);
    adapter.statusResponse = { state: "active", lastActivityAt: null, raw: { message_processed: true } };

    await cancelStage.tick(harness.deps, true, 1_000);
    expect(adapter.injectCalls).toHaveLength(1);
    expect(harness.store.getRunCancelRequest(cancel.id)?.status).toBe("cooperative_sent");

    await cancelStage.tick(harness.deps, true, 1_001);
    expect(adapter.injectCalls).toHaveLength(1);
    expect(harness.store.getRunCancelRequest(cancel.id)?.status).toBe("cooperative_sent");
    expect(harness.store.getLatestOpenRun(run.taskId)?.id).toBe(run.id);
  });

  it("cooperative inject の effect 後 crash を再現しても同じ envelope を再注入しない", async () => {
    const { run } = running();
    const cancel = request(run, 2_000);
    adapter.statusResponse = { state: "active", lastActivityAt: null };
    adapter.injectError = new Error("effect 後 crash");

    await cancelStage.tick(harness.deps, true, 1_000);

    expect(adapter.injectCalls).toHaveLength(1);
    expect(harness.store.getRunCancelRequest(cancel.id)?.status).toBe("cooperative_sent");

    adapter.injectError = null;
    await cancelStage.tick(harness.deps, true, 1_001);

    expect(adapter.injectCalls).toHaveLength(1);
    expect(harness.store.listEvents(run.taskId, "cancel_injected")).toHaveLength(1);
  });

  it("nonce/run/session/fence 不一致の ack を拒否し exact ack だけ acknowledged にする", async () => {
    const { run } = running();
    const cancel = request(run, 2_000);
    adapter.statusResponse = { state: "active", lastActivityAt: null };
    await cancelStage.tick(harness.deps, true, 1_000);

    adapter.statusResponse = { state: "active", lastActivityAt: null, raw: ack(cancel, "wrong-nonce") };
    await cancelStage.tick(harness.deps, true, 1_001);
    expect(harness.store.getRunCancelRequest(cancel.id)?.status).toBe("cooperative_sent");

    adapter.statusResponse = { state: "active", lastActivityAt: null, raw: ack(cancel) };
    await cancelStage.tick(harness.deps, true, 1_002);
    expect(harness.store.getRunCancelRequest(cancel.id)).toMatchObject({
      status: "acknowledged",
      acknowledgedNonce: cancel.requestNonce,
    });
  });

  it("grace 中は force せず、deadline 後は exact session だけ停止して再照合後に run を閉じる", async () => {
    const { task, run } = running("target-session");
    const unrelated = running("unrelated-session");
    const cancel = request(run, 1_100);
    adapter.statusResponse = { state: "active", lastActivityAt: null };
    adapter.stopCapabilitiesResponse = {
      protocol: "session-stop-v1",
      exactSession: true,
      childProcessTree: true,
    };
    adapter.stopExactHook = (): void => {
      adapter.statusResponse = { state: "ended", lastActivityAt: null };
    };

    await cancelStage.tick(harness.deps, true, 1_000);
    await cancelStage.tick(harness.deps, true, 1_099);
    expect(adapter.stopExactCalls).toHaveLength(0);

    await cancelStage.tick(harness.deps, true, 1_100);
    expect(adapter.stopExactCalls).toEqual([
      expect.objectContaining({
        ref: expect.objectContaining({ sessionId: "target-session" }),
        input: {
          requestNonce: cancel.requestNonce,
          expectedRunId: run.id,
          expectedSessionId: "target-session",
        },
      }),
    ]);
    expect(harness.store.getRunCancelRequest(cancel.id)?.status).toBe("stopped");
    expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
    expect(harness.store.getLatestOpenRun(unrelated.task.id)?.sessionId).toBe("unrelated-session");
    expect(harness.store.getTask(task.id)?.blockReason).toMatch(/^needs-manual: cancel stopped/);
  });

  it("capability 無しは deadline 後も pending・run/worktree 解放0を維持する", async () => {
    const { task, run } = running();
    const cancel = request(run, 1_000);
    const orchestrator = harness.store.registerOrchestrator({ label: "cancel-owner", project: "dev", repoCommonDir: "" });
    harness.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    adapter.statusResponse = { state: "active", lastActivityAt: null };
    adapter.stopCapabilitiesResponse = { protocol: "unsupported", exactSession: false, childProcessTree: false };

    const result = await cancelStage.tick(harness.deps, true, 1_001);

    expect(result.notes).toContainEqual(expect.stringContaining("pending を維持"));
    expect(harness.store.getRunCancelRequest(cancel.id)?.status).toBe("cancel_requested");
    expect(harness.store.getLatestOpenRun(task.id)?.id).toBe(run.id);
    expect(adapter.stopCalls).toHaveLength(0);
    expect(adapter.stopExactCalls).toHaveLength(0);
    expect(harness.store.listOrchestratorRequests(orchestrator.id)).toEqual([
      expect.objectContaining({ questionId: `cancel-failure:${cancel.id}`, status: "queued" }),
    ]);

    await cancelStage.tick(harness.deps, true, 1_002);
    expect(harness.store.listOrchestratorRequests(orchestrator.id)).toHaveLength(1);
  });

  it("session が自然終了した場合は force せず exact status 証拠で停止確定する", async () => {
    const { task, run } = running();
    const cancel = request(run, 2_000);
    adapter.statusResponse = { state: "ended", lastActivityAt: null, resultCount: 1 };

    await cancelStage.tick(harness.deps, true, 1_000);

    expect(harness.store.getRunCancelRequest(cancel.id)?.status).toBe("stopped");
    expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
    expect(adapter.injectCalls).toHaveLength(0);
    expect(adapter.stopExactCalls).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "late_result_rejected")).toHaveLength(1);
  });

  it("bridge の未知 session を表す idle+空 snapshot は停止証拠にしない", async () => {
    const { task, run } = running();
    const cancel = request(run, 2_000);
    adapter.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 0, lastEntryId: 0 };

    await cancelStage.tick(harness.deps, true, 1_000);
    await cancelStage.tick(harness.deps, true, 1_120);

    expect(harness.store.getRunCancelRequest(cancel.id)?.status).toBe("cooperative_sent");
    expect(harness.store.getLatestOpenRun(task.id)?.id).toBe(run.id);
    expect(harness.store.listEvents(task.id, "cancel_stop_candidate")).toHaveLength(0);
  });

  it("bridge idle は exact snapshot を60秒durable再観測した場合だけ自然停止確定する", async () => {
    const { task, run } = running();
    const cancel = request(run, 2_000);
    adapter.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastEntryId: 42 };

    await cancelStage.tick(harness.deps, true, 1_000);
    await cancelStage.tick(harness.deps, true, 1_059);
    expect(harness.store.getLatestOpenRun(task.id)?.id).toBe(run.id);

    await cancelStage.tick(harness.deps, true, 1_060);
    expect(harness.store.getRunCancelRequest(cancel.id)?.status).toBe("stopped");
    expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
  });

  it("force rejected/unknown は failed にするが停止証拠が無いため run を解放しない", async () => {
    const { task, run } = running();
    const cancel = request(run, 1_000);
    adapter.statusResponse = { state: "active", lastActivityAt: null };
    adapter.stopCapabilitiesResponse = {
      protocol: "session-stop-v1",
      exactSession: true,
      childProcessTree: true,
    };
    adapter.stopExactResponse = {
      state: "rejected",
      evidenceId: "fake:rejected",
      observedSessionState: "active",
      childProcessTreeCovered: false,
    };

    await cancelStage.tick(harness.deps, true, 1_001);

    expect(harness.store.getRunCancelRequest(cancel.id)?.status).toBe("failed");
    expect(harness.store.getLatestOpenRun(task.id)?.id).toBe(run.id);
    expect(harness.store.listOrchestratorRequests()).toEqual([
      expect.objectContaining({ questionId: `cancel-failure:${cancel.id}` }),
    ]);
  });

  it("forcing の stopExact 再試行は durable exponential backoff 到来まで発行しない", async () => {
    const { run } = running();
    const cancel = request(run, 1_000);
    adapter.statusResponse = { state: "active", lastActivityAt: null };
    adapter.stopCapabilitiesResponse = {
      protocol: "session-stop-v1",
      exactSession: true,
      childProcessTree: true,
    };
    adapter.stopExactResponse = {
      state: "stopped",
      evidenceId: "fake:unconfirmed",
      observedSessionState: "active",
      childProcessTreeCovered: true,
    };

    await cancelStage.tick(harness.deps, true, 1_001);
    expect(harness.store.getRunCancelRequest(cancel.id)?.status).toBe("forcing");
    expect(adapter.stopExactCalls).toHaveLength(1);

    const waiting = await cancelStage.tick(harness.deps, true, 1_005);
    expect(waiting.notes).toContainEqual(expect.stringContaining("backoff 待機中"));
    expect(adapter.stopExactCalls).toHaveLength(1);

    await cancelStage.tick(harness.deps, true, 1_006);
    expect(adapter.stopExactCalls).toHaveLength(2);
    expect(harness.store.listEvents(run.taskId, "cancel_force_attempted")).toHaveLength(2);
  });

  it("child process tree capability と証拠が不一致なら session ended でも解放しない", async () => {
    const { task, run } = running();
    const cancel = request(run, 1_000);
    adapter.statusResponse = { state: "active", lastActivityAt: null };
    adapter.stopCapabilitiesResponse = {
      protocol: "session-stop-v1",
      exactSession: true,
      childProcessTree: true,
    };
    adapter.stopExactResponse = {
      state: "stopped",
      evidenceId: "fake:parent-only",
      observedSessionState: "ended",
      childProcessTreeCovered: false,
    };
    adapter.stopExactHook = (): void => {
      adapter.statusResponse = { state: "ended", lastActivityAt: null };
    };

    await cancelStage.tick(harness.deps, true, 1_001);

    expect(harness.store.getRunCancelRequest(cancel.id)).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("child-process-tree"),
    });
    expect(harness.store.getLatestOpenRun(task.id)?.id).toBe(run.id);
  });

  it("forcing の crash window は status 再照合で冪等に close する", async () => {
    const { task, run } = running();
    let cancel = request(run, 1_000);
    cancel = harness.store.transitionRunCancelRequest({
      requestId: cancel.id,
      expectedStatus: cancel.status,
      to: "forcing",
      expectedRunId: run.id,
      expectedSessionId: run.sessionId,
      expectedCancelFence: cancel.cancelFence,
      requestNonce: cancel.requestNonce,
      actor: "supervisor",
      capabilitySnapshot: { protocol: "session-stop-v1", exactSession: true },
      now: 1_000,
    });
    adapter.statusResponse = { state: "ended", lastActivityAt: null };

    await cancelStage.tick(harness.deps, true, 1_001);

    expect(harness.store.getRunCancelRequest(cancel.id)?.status).toBe("stopped");
    expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
  });

  it("二重 tick で cooperative envelope を再注入せず、late result は監査1件・task mutation 0", async () => {
    const { task, run } = running();
    const cancel = request(run, 2_000);
    adapter.statusResponse = { state: "active", lastActivityAt: null };
    await cancelStage.tick(harness.deps, true, 1_000);
    await cancelStage.tick(harness.deps, true, 1_001);
    expect(adapter.injectCalls).toHaveLength(1);

    const before = harness.store.getTask(task.id);
    expect(rejectLateResultOnce(harness.store, run, run.sessionId)).toBe(true);
    expect(rejectLateResultOnce(harness.store, run, run.sessionId)).toBe(true);
    expect(harness.store.listEvents(task.id, "late_result_rejected")).toHaveLength(1);
    expect(harness.store.getTask(task.id)).toEqual(before);
    expect(harness.store.getRunCancelRequest(cancel.id)?.status).toBe("cooperative_sent");
  });

  it("direct transport は owned session の stop だけを呼び、再照合前には閉じない", async () => {
    const { task, run } = running("direct-target", "direct");
    request(run, 1_000);
    harness.deps.directAdapters = { codex: adapter };
    adapter.statusResponse = { state: "active", lastActivityAt: null };
    adapter.stopResponse = { stopped: true, reason: "terminated" };

    await cancelStage.tick(harness.deps, true, 1_001);

    expect(adapter.stopCalls).toHaveLength(1);
    expect(adapter.stopCalls[0]?.sessionId).toBe("direct-target");
    expect(harness.store.getLatestOpenRun(task.id)?.id).toBe(run.id);

    adapter.statusResponse = { state: "ended", lastActivityAt: null };
    await cancelStage.tick(harness.deps, true, 1_002);
    expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
  });

  it("direct stop の already-exited は process group 不存在の tree 証拠としてcloseできる", async () => {
    const { task, run } = running("direct-already-exited", "direct");
    request(run, 1_000);
    harness.deps.directAdapters = { codex: adapter };
    adapter.statusResponse = { state: "active", lastActivityAt: null };
    adapter.stopResponse = { stopped: false, reason: "already-exited" };
    adapter.stopHook = (): void => {
      adapter.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
    };

    await cancelStage.tick(harness.deps, true, 1_001);

    expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
    expect(harness.store.listRunCancelRequests(task.id)[0]).toMatchObject({ status: "stopped" });
  });

  it("status probe がdeadline後も失敗する場合はdurable orchestrator requestへ通知しrun gateを維持する", async () => {
    const { task, run } = running();
    const cancel = request(run, 1_000);
    const orchestrator = harness.store.registerOrchestrator({ label: "status-owner", project: "dev", repoCommonDir: "" });
    harness.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    adapter.statusError = new Error("bridge unavailable");

    await cancelStage.tick(harness.deps, true, 1_001);

    expect(harness.store.getRunCancelRequest(cancel.id)?.status).toBe("cancel_requested");
    expect(harness.store.getLatestOpenRun(task.id)?.id).toBe(run.id);
    expect(harness.store.listOrchestratorRequests(orchestrator.id)).toEqual([
      expect.objectContaining({ questionId: `cancel-failure:${cancel.id}`, status: "queued" }),
    ]);
  });

  it("1 tick の force budget を5件に制限する", async () => {
    adapter.statusResponse = { state: "active", lastActivityAt: null };
    adapter.stopCapabilitiesResponse = {
      protocol: "session-stop-v1",
      exactSession: true,
      childProcessTree: true,
    };
    for (let index = 0; index < 6; index += 1) {
      const { run } = running(`budget-${index}`);
      request(run, 1_000);
    }

    await cancelStage.tick(harness.deps, true, 1_001);

    expect(adapter.stopExactCalls).toHaveLength(5);
    expect(harness.store.listRunCancelRequests().filter((cancel) => cancel.status === "forcing")).toHaveLength(5);
    expect(harness.store.listRunCancelRequests().filter((cancel) => cancel.status === "cancel_requested")).toHaveLength(1);
  });
});
