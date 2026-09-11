import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerApiErrorObservationParseResult } from "@hachi/adapters";
import { makeTempHome, taskInput, type TempHome } from "@hachi/testing";
import { SqliteKanbanStore, createLogger } from "@hachi/core";
import type { HachiConfig, Logger, Provider, StageDeps, TaskRow } from "@hachi/core";
import {
  DEFAULT_TEST_CONFIG,
  FakeAdapter,
  setupHarness,
  type TestHarness,
  type TestSessionStatus,
} from "../test-support.js";
import { createMonitorStage, monitorStage } from "./monitor.js";
import type { NotifyMessage, NotifyTransport, NotifyTransportResult } from "./notify.js";

describe("monitorStage", () => {
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

  // 進行中タスクを構築する。block（表示用 reason）と startRun（session の正本 = task_runs）の
  // 両方を呼ぶ。reason 内の even-session= と startRun の sessionId は一致させる（テストの意図の
  // 一貫性のため。新ロジックは reason 文字列を参照しない）。
  function createInProgressTask(sessionId: string): TaskRow {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "進行中タスク" }), "tester");
    const blocked = harness.store.block(
      task.id,
      `codex-in-progress: 実装中 tmux=none even-session=${sessionId} server=http://x started=2026-07-02T10:00:00+09:00`,
      "tester",
    );
    harness.store.startRun(task.id, "codex", sessionId, { serverUrl: "http://x" });
    return blocked;
  }

  interface CapturedWarning {
    msg: string;
    fields?: Record<string, unknown>;
  }

  interface WorkerApiErrorCapture {
    stage: ReturnType<typeof createMonitorStage>;
    messages: NotifyMessage[];
    warnings: CapturedWarning[];
  }

  function setWorkerApiErrorStatus(
    observation: WorkerApiErrorObservationParseResult,
    patch: Partial<TestSessionStatus> = {},
  ): void {
    const status: TestSessionStatus & { apiErrorObservation: WorkerApiErrorObservationParseResult } = {
      state: "active",
      lastActivityAt: null,
      ...patch,
      apiErrorObservation: observation,
    };
    fakeCodex.statusResponse = status;
  }

  function captureWorkerApiErrorEffects(
    transportResult: NotifyTransportResult = { status: "sent" },
  ): WorkerApiErrorCapture {
    const messages: NotifyMessage[] = [];
    const warnings: CapturedWarning[] = [];
    const logger: Logger = {
      info: (): void => undefined,
      warn: (msg, fields): void => {
        warnings.push(fields === undefined ? { msg } : { msg, fields });
      },
      error: (): void => undefined,
      child: (): Logger => logger,
    };
    harness.deps.logger = logger;
    harness.deps.config = {
      ...harness.deps.config,
      notify: { transports: ["capture"] },
    } as HachiConfig & { notify: { transports: string[] } };
    const transport: NotifyTransport = {
      name: "capture",
      send: async (message): Promise<NotifyTransportResult> => {
        messages.push(message);
        return transportResult;
      },
    };
    return {
      stage: createMonitorStage({ workerApiErrorNotificationOptions: { transports: [transport] } }),
      messages,
      warnings,
    };
  }

  const STREAM_ID = "11111111-1111-4111-8111-111111111111";

  it("bridge の idle+result 初観測は candidate のみで、同一snapshotが60秒静穏なら1回だけ確定する", async () => {
    const task = createInProgressTask("sess-1");
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 10, lastEntryId: 12 };

    const result = await monitorStage.tick(harness.deps, true, 1_000);
    expect(result.actions).toBe(1);
    expect(harness.store.listEvents(task.id, "session_end_candidate")).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "session_ended")).toHaveLength(0);

    const before = await monitorStage.tick(harness.deps, true, 1_059);
    expect(before.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "session_ended")).toHaveLength(0);

    const confirmed = await monitorStage.tick(harness.deps, true, 1_060);
    expect(confirmed.actions).toBe(1);
    expect(harness.store.listEvents(task.id, "session_ended")).toHaveLength(1);
    expect(JSON.parse(harness.store.listEvents(task.id, "session_ended")[0]!.payload)).toMatchObject({
      sessionId: "sess-1",
      resultCount: 1,
      resultWatermark: 10,
      lastEntryId: 12,
    });

    const duplicate = await monitorStage.tick(harness.deps, true, 1_061);
    expect(duplicate.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "session_ended")).toHaveLength(1);
  });

  it("direct run は初回tickで即座に session_ended を確定する", async () => {
    const sessionId = "direct-immediate-end";
    const task = harness.store.createTask(taskInput({ status: "ready", title: "direct 即時終端" }), "tester");
    harness.store.block(
      task.id,
      `codex-in-progress: 実装中 tmux=none even-session=${sessionId} server=direct started=2026-07-02T10:00:00+09:00`,
      "tester",
    );
    harness.store.startRun(task.id, "codex", sessionId, { serverUrl: "direct", transport: "direct" });
    harness.deps.directAdapters = { codex: fakeCodex };
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 1, lastEntryId: 1 };

    const result = await monitorStage.tick(harness.deps, true, 1_000);

    expect(result.actions).toBe(2);
    expect(harness.store.listEvents(task.id, "direct-session-state-unreadable")).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "session_end_candidate")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "session_ended")).toHaveLength(1);
    expect(fakeCodex.statusCalls).toHaveLength(1);
  });

  it("lastEntryId または result watermark が変化したら旧candidateを使わず新candidate化する", async () => {
    const task = createInProgressTask("sess-watermark");
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 10, lastEntryId: 10 };
    await monitorStage.tick(harness.deps, true, 1_000);

    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 10, lastEntryId: 11 };
    await monitorStage.tick(harness.deps, true, 1_030);
    expect(harness.store.listEvents(task.id, "session_end_candidate")).toHaveLength(2);
    expect(harness.store.listEvents(task.id, "session_ended")).toHaveLength(0);

    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 2, lastResultId: 12, lastEntryId: 12 };
    await monitorStage.tick(harness.deps, true, 1_090);
    expect(harness.store.listEvents(task.id, "session_end_candidate")).toHaveLength(3);
    expect(harness.store.listEvents(task.id, "session_ended")).toHaveLength(0);

    await monitorStage.tick(harness.deps, true, 1_150);
    expect(harness.store.listEvents(task.id, "session_ended")).toHaveLength(1);
  });

  it("500cap で resultCount が減っても増加した lastResultId の新candidateを60秒確認する", async () => {
    const task = createInProgressTask("sess-500cap");
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 500, lastResultId: 4420, lastEntryId: 4420 };
    await monitorStage.tick(harness.deps, true, 1_000);

    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 480, lastResultId: 4421, lastEntryId: 4421 };
    await monitorStage.tick(harness.deps, true, 1_060);
    expect(harness.store.listEvents(task.id, "session_ended")).toHaveLength(0);

    await monitorStage.tick(harness.deps, true, 1_120);

    const payloads = harness.store
      .listEvents(task.id, "session_ended")
      .map((event) => JSON.parse(event.payload) as { resultCount: number; lastResultId: number });
    expect(payloads).toEqual([expect.objectContaining({ resultCount: 480, lastResultId: 4421 })]);
  });

  it("snapshot の無い legacy session_ended は bridge finalize 用の新candidateとして静穏確認し直す", async () => {
    const task = createInProgressTask("sess-legacy-watermark");
    harness.store.addEvent(task.id, "session_ended", "supervisor", {
      sessionId: "sess-legacy-watermark",
      provider: "codex",
    });
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastEntryId: 1 };

    const result = await monitorStage.tick(harness.deps, true, 1_000);

    expect(result.actions).toBe(1);
    expect(harness.store.listEvents(task.id, "session_ended")).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "session_end_candidate")).toHaveLength(1);

    await monitorStage.tick(harness.deps, true, 1_060);
    expect(harness.store.listEvents(task.id, "session_ended")).toHaveLength(2);
  });

  it("state='active' の場合は何もしない", async () => {
    createInProgressTask("sess-2");
    fakeCodex.statusResponse = { state: "active", lastActivityAt: null };

    const result = await monitorStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(0);
  });

  it("candidate後にbusyへ戻った場合は旧candidateを無効化し、再idle時に待ち直す", async () => {
    const task = createInProgressTask("sess-busy-return");
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 10, lastEntryId: 10 };
    await monitorStage.tick(harness.deps, true, 1_000);

    fakeCodex.statusResponse = { state: "active", lastActivityAt: null, resultCount: 1, lastResultId: 10, lastEntryId: 11 };
    await monitorStage.tick(harness.deps, true, 1_030);
    expect(harness.store.listEvents(task.id, "session_end_candidate_invalidated")).toHaveLength(1);

    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 10, lastEntryId: 11 };
    await monitorStage.tick(harness.deps, true, 1_090);
    expect(harness.store.listEvents(task.id, "session_ended")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "session_end_candidate")).toHaveLength(2);

    await monitorStage.tick(harness.deps, true, 1_150);
    expect(harness.store.listEvents(task.id, "session_ended")).toHaveLength(1);
  });

  it("state='idle' でも resultCount が 0（未設定）の場合は何もしない（turn 未完了, docs/contract.md §13.4）", async () => {
    createInProgressTask("sess-2b");
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null };

    const result = await monitorStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(0);
  });

  it("state='idle' でも窓内 result が 0 件なら lastResultId=0 のまま進めない", async () => {
    createInProgressTask("sess-zero-result");
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 0, lastResultId: 0 };

    const result = await monitorStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(0);
  });

  it("status() が throw してもクラッシュせず notes に記録する", async () => {
    createInProgressTask("sess-3");
    fakeCodex.statusError = new Error("network down");

    const result = await monitorStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(0);
    expect(result.notes?.some((n) => n.includes("status取得エラー"))).toBe(true);
  });

  it("unseen worker API error をsafe payloadのdurable eventへ記録し、warningと通知をbundleごとに1回だけ出す", async () => {
    const task = createInProgressTask("sess-worker-api-new");
    const before = harness.store.getTask(task.id);
    setWorkerApiErrorStatus({
      kind: "valid",
      value: {
        schemaVersion: "worker-api-error-observation.v1",
        streamId: STREAM_ID,
        watermark: 2,
        recent: [
          { sequence: 1, category: "context-window-exceeded" },
          { sequence: 2, category: "provider-hard-error" },
        ],
      },
    });
    const capture = captureWorkerApiErrorEffects();

    const result = await capture.stage.tick(harness.deps, true, 1_000);

    expect(result.actions).toBe(2);
    const payloads = harness.store.listEvents(task.id, "worker_api_error")
      .map((event) => JSON.parse(event.payload) as Record<string, unknown>);
    expect(payloads).toEqual([
      {
        sessionId: "sess-worker-api-new",
        streamId: STREAM_ID,
        sequence: 1,
        category: "context-window-exceeded",
        provider: "codex",
        transport: "bridge",
        observedAt: 1_000,
      },
      {
        sessionId: "sess-worker-api-new",
        streamId: STREAM_ID,
        sequence: 2,
        category: "provider-hard-error",
        provider: "codex",
        transport: "bridge",
        observedAt: 1_000,
      },
    ]);
    expect(capture.warnings.filter((entry) => entry.msg.includes("worker API error observation を記録")))
      .toHaveLength(1);
    expect(capture.messages).toHaveLength(1);
    expect(capture.messages[0]?.redactedReason).toContain(`streamId=${STREAM_ID}`);
    expect(capture.messages[0]?.redactedReason).toContain("errors=1:context-window-exceeded,2:provider-hard-error");
    expect(harness.store.getTask(task.id)).toMatchObject({
      status: before?.status,
      blockReason: before?.blockReason,
      assignee: before?.assignee,
    });
    expect(harness.store.getActiveRunCancelRequestByTask(task.id)).toBeNull();
  });

  it("同じprojectionの再tickとDB再openを伴うstage再生成後replayをdurable event正本でdedupeする", async () => {
    const task = createInProgressTask("sess-worker-api-replay");
    setWorkerApiErrorStatus({
      kind: "valid",
      value: {
        schemaVersion: "worker-api-error-observation.v1",
        streamId: STREAM_ID,
        watermark: 1,
        recent: [{ sequence: 1, category: "provider-hard-error" }],
      },
    });
    const firstCapture = captureWorkerApiErrorEffects();

    await firstCapture.stage.tick(harness.deps, true, 1_000);
    const duplicate = await firstCapture.stage.tick(harness.deps, true, 1_001);
    const restartedCapture = captureWorkerApiErrorEffects();
    const reopenedStore = new SqliteKanbanStore(harness.home.env.dbPath);
    const replay = await restartedCapture.stage.tick({ ...harness.deps, store: reopenedStore }, true, 1_002);
    reopenedStore.close();

    expect(duplicate.actions).toBe(0);
    expect(replay.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "worker_api_error")).toHaveLength(1);
    expect(firstCapture.messages).toHaveLength(1);
    expect(restartedCapture.messages).toHaveLength(0);
    expect(restartedCapture.warnings).toHaveLength(0);
  });

  it("retained recent先頭より前の未観測範囲をsafeなgap eventにし、後続sequenceだけを追加する", async () => {
    const task = createInProgressTask("sess-worker-api-gap");
    setWorkerApiErrorStatus({
      kind: "valid",
      value: {
        schemaVersion: "worker-api-error-observation.v1",
        streamId: STREAM_ID,
        watermark: 6,
        recent: [
          { sequence: 5, category: "provider-hard-error" },
          { sequence: 6, category: "context-window-exceeded" },
        ],
      },
    });
    const capture = captureWorkerApiErrorEffects();

    const first = await capture.stage.tick(harness.deps, true, 2_000);

    expect(first.actions).toBe(3);
    expect(harness.store.listEvents(task.id, "worker_api_error_gap")
      .map((event) => JSON.parse(event.payload))).toEqual([{
        sessionId: "sess-worker-api-gap",
        streamId: STREAM_ID,
        fromSequence: 1,
        toSequence: 4,
        count: 4,
        provider: "codex",
        transport: "bridge",
        observedAt: 2_000,
      }]);
    expect(capture.messages).toHaveLength(1);
    expect(capture.messages[0]?.redactedReason).toContain("gap=1-4 (count=4)");

    setWorkerApiErrorStatus({
      kind: "valid",
      value: {
        schemaVersion: "worker-api-error-observation.v1",
        streamId: STREAM_ID,
        watermark: 7,
        recent: [
          { sequence: 6, category: "context-window-exceeded" },
          { sequence: 7, category: "provider-hard-error" },
        ],
      },
    });
    const next = await capture.stage.tick(harness.deps, true, 2_001);

    expect(next.actions).toBe(1);
    expect(harness.store.listEvents(task.id, "worker_api_error_gap")).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "worker_api_error")
      .map((event) => (JSON.parse(event.payload) as { sequence: number }).sequence)).toEqual([5, 6, 7]);
    expect(capture.messages).toHaveLength(2);
  });

  it("malformed present projectionをsafe snapshot keyでinvalid eventへ記録してdedupeする", async () => {
    const task = createInProgressTask("sess-worker-api-invalid");
    setWorkerApiErrorStatus(
      { kind: "malformed", reason: "consistency" },
      { resultCount: 4, lastResultId: 40, lastEntryId: 45 },
    );
    const capture = captureWorkerApiErrorEffects();

    const first = await capture.stage.tick(harness.deps, true, 3_000);
    const duplicate = await capture.stage.tick(harness.deps, true, 3_001);

    expect(first.actions).toBe(1);
    expect(duplicate.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "worker_api_error_observation_invalid")
      .map((event) => JSON.parse(event.payload))).toEqual([{
        sessionId: "sess-worker-api-invalid",
        provider: "codex",
        transport: "bridge",
        resultWatermark: 40,
        lastEntryId: 45,
        reason: "consistency",
        observedAt: 3_000,
      }]);
    expect(capture.messages).toHaveLength(1);

    setWorkerApiErrorStatus(
      { kind: "malformed", reason: "consistency" },
      { resultCount: 4, lastResultId: 40, lastEntryId: 46 },
    );
    const changedSnapshot = await capture.stage.tick(harness.deps, true, 3_002);
    expect(changedSnapshot.actions).toBe(1);
    expect(harness.store.listEvents(task.id, "worker_api_error_observation_invalid")).toHaveLength(2);
    expect(capture.messages).toHaveLength(2);
  });

  it("operational notification失敗でもeventを維持してtask処理を止めず、duplicateで再試行しない", async () => {
    const task = createInProgressTask("sess-worker-api-notify-failure");
    const before = harness.store.getTask(task.id);
    setWorkerApiErrorStatus({
      kind: "valid",
      value: {
        schemaVersion: "worker-api-error-observation.v1",
        streamId: STREAM_ID,
        watermark: 1,
        recent: [{ sequence: 1, category: "provider-hard-error" }],
      },
    });
    const capture = captureWorkerApiErrorEffects({ status: "failed" });

    const first = await capture.stage.tick(harness.deps, true, 4_000);
    const duplicate = await capture.stage.tick(harness.deps, true, 4_001);

    expect(first.actions).toBe(1);
    expect(duplicate.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "worker_api_error")).toHaveLength(1);
    expect(capture.messages).toHaveLength(1);
    expect(capture.warnings.some((entry) => entry.msg.includes("operational transport 通知に失敗"))).toBe(true);
    expect(harness.store.getTask(task.id)).toMatchObject({
      status: before?.status,
      blockReason: before?.blockReason,
      assignee: before?.assignee,
    });
  });

  it("raw error・prompt・content・tool output・それらのhashをevent/log/notificationへ露出しない", async () => {
    const task = createInProgressTask("sess-worker-api-secret");
    const secret = "SECRET raw provider error with private prompt";
    const secretHash = "deadbeef-secret-content-hash";
    setWorkerApiErrorStatus({
      kind: "valid",
      value: {
        schemaVersion: "worker-api-error-observation.v1",
        streamId: STREAM_ID,
        watermark: 1,
        recent: [{ sequence: 1, category: "provider-hard-error" }],
      },
    }, {
      raw: {
        error: secret,
        prompt: secret,
        content: secret,
        toolOutput: secret,
        hash: secretHash,
      },
    });
    const capture = captureWorkerApiErrorEffects();

    const result = await capture.stage.tick(harness.deps, true, 5_000);
    const exposed = JSON.stringify({
      result,
      events: harness.store.listEvents(task.id),
      warnings: capture.warnings,
      notifications: capture.messages,
    });

    expect(exposed).not.toContain(secret);
    expect(exposed).not.toContain(secretHash);
  });

  it("open run が無い（task_runsが無い）in-progress タスクは needs-manual へ自己修復する（docs/contract.md §12.11-2）", async () => {
    // block だけ呼び startRun は呼ばない → task_runs が無いため session を再構築できない
    const task = harness.store.createTask(taskInput({ status: "ready", title: "run無し進行中" }), "tester");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=sess-x server=http://x started=2026-07-02T10:00:00+09:00",
      "tester",
    );

    const result = await monitorStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);
    expect(result.notes?.some((n) => n.includes("in-progress 不整合"))).toBe(true);

    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe("needs-manual: in-progress 不整合 (open run なし)");
    expect(updated?.assignee).toBe("human");

    // 付替後は in-progress prefix でなくなるため listInProgress から外れ、自然に冪等になる
    expect(harness.store.listInProgress().map((t) => t.id)).not.toContain(task.id);
    const second = await monitorStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(second.actions).toBe(0);
  });

  it("in-progress reason + run 消失（endRun 後）のタスクも needs-manual へ自己修復する（docs/contract.md §12.11-2）", async () => {
    // block と startRun の両方を呼んだ後 endRun で run を消し、「reason は in-progress だが open run
    // が無い」状態を再現する（handoff処理漏れ等の実運用シナリオに近い）
    const task = createInProgressTask("sess-orphan-reason");
    const run = harness.store.getLatestOpenRun(task.id);
    expect(run).not.toBeNull();
    harness.store.endRun(run!.id, "done");

    const result = await monitorStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);

    const updated = harness.store.getTask(task.id);
    expect(updated?.blockReason).toBe("needs-manual: in-progress 不整合 (open run なし)");
  });

  it("dry-run は actions を計上するが reason を書き換えない（自己修復）", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "run無し進行中dry" }), "tester");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=sess-dry server=http://x started=2026-07-02T10:00:00+09:00",
      "tester",
    );

    const result = await monitorStage.tick(harness.deps, false, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.blockReason.startsWith("codex-in-progress:")).toBe(true);
  });

  it("dry-run は actions を計上するがイベントを書き込まない", async () => {
    const task = createInProgressTask("sess-4");
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };

    const result = await monitorStage.tick(harness.deps, false, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);
    expect(harness.store.listEvents(task.id, "session_ended")).toHaveLength(0);
  });
});

describe("monitorStage: direct output stall 検知（docs/contract.md §50.2）", () => {
  interface DirectOnlyHarness {
    home: TempHome;
    store: SqliteKanbanStore;
    deps: StageDeps;
    cleanup: () => Promise<void>;
  }

  let harness: DirectOnlyHarness;

  beforeEach(async () => {
    const home = makeTempHome();
    const store = new SqliteKanbanStore(home.env.dbPath);
    const configWithNotify: typeof DEFAULT_TEST_CONFIG & { notify: { transports: string[] } } = {
      ...DEFAULT_TEST_CONFIG,
      notify: { transports: [] },
    };
    const deps: StageDeps = {
      store,
      env: home.env,
      config: configWithNotify,
      adapters: { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude") },
      logger: createLogger({ filePath: join(home.home, "test-monitor-direct.jsonl") }),
    };
    harness = {
      home,
      store,
      deps,
      cleanup: async (): Promise<void> => {
        store.close();
        home.cleanup();
      },
    };
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function createRun(
    sessionId: string,
    transport: "bridge" | "direct" = "direct",
    provider: Provider = "codex",
    body = "",
  ): TaskRow {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: `run ${sessionId}`, body }),
      "tester",
    );
    harness.store.startRun(task.id, provider, sessionId, {
      serverUrl: transport === "direct" ? "direct" : "http://x",
      transport,
    });
    return task;
  }

  // direct adapter が書く session state（pid / startedAt の正本）を模して置く。
  function writeSessionState(sessionId: string, taskId: string, patch: Record<string, unknown> = {}): void {
    const dir = join(harness.deps.env.home, "state", "direct-sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sessionId}.json`),
      JSON.stringify({
        pid: 424_242,
        taskId,
        outFile: join(dir, `${sessionId}.out`),
        exitFile: join(dir, `${sessionId}.exit`),
        model: "claude-opus-5",
        startedAt: 1_000,
        ...patch,
      }),
      "utf8",
    );
  }

  // プロセス生存判定を固定した monitor stage。実プロセスに依存せず 2 軸の分岐だけを検証する。
  function stageWithLiveness(
    alive: boolean,
    nativeLogPath: string | null = null,
  ): ReturnType<typeof createMonitorStage> {
    return createMonitorStage({
      isDirectSessionAlive: (): boolean => alive,
      directNativeLogPathResolver: async (): Promise<string | null> => nativeLogPath,
    });
  }

  function directStallConfig(stall: NonNullable<NonNullable<HachiConfig["direct"]>["stall"]>): HachiConfig {
    return { ...harness.deps.config, direct: { stall } };
  }

  function writeDirectOutput(sessionId: string, content: string): void {
    const dir = join(harness.deps.env.home, "state", "direct-sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.out`), content, "utf8");
  }

  function writeNativeLog(sessionId: string, content: string): string {
    const dir = join(harness.deps.env.home, "native-logs");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
    writeFileSync(path, content, "utf8");
    return path;
  }

  function writeArtifactTranscript(taskId: string, sessionId: string, content: string): void {
    const dir = join(harness.deps.env.artifactsDir, taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `transcript-${sessionId}-fixture.txt`), content, "utf8");
  }

  it("サイズ固定で15分経過した direct run は run_stalled を1回だけ記録する", async () => {
    const task = createRun("direct-stall-1");
    writeDirectOutput("direct-stall-1", "same");
    writeSessionState("direct-stall-1", task.id, { startedAt: 1_000 });
    const stage = stageWithLiveness(false);

    const first = await stage.tick(harness.deps, true, 1_000);
    expect(first.actions).toBe(0);

    const second = await stage.tick(harness.deps, true, 1_000 + 15 * 60);
    expect(second.actions).toBe(1);
    const events = harness.store.listEvents(task.id, "run_stalled");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({ sessionId: "direct-stall-1", size: 4 });
    expect(JSON.parse(events[0]!.payload).outputPath).toContain("state/direct-sessions/direct-stall-1.out");

    const third = await stage.tick(harness.deps, true, 1_000 + 30 * 60);
    expect(third.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "run_stalled")).toHaveLength(1);
  });

  it("実行中 output サイズが増加した場合は lastGrowthAt をリセットする", async () => {
    const task = createRun("direct-stall-growth");
    writeDirectOutput("direct-stall-growth", "a");
    writeSessionState("direct-stall-growth", task.id, { startedAt: 2_000 });
    const stage = stageWithLiveness(false);

    await stage.tick(harness.deps, true, 2_000);
    writeDirectOutput("direct-stall-growth", "abcdef");

    const afterGrowth = await stage.tick(harness.deps, true, 2_000 + 15 * 60);
    expect(afterGrowth.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "run_stalled")).toHaveLength(0);

    const afterAnotherWindow = await stage.tick(harness.deps, true, 2_000 + 30 * 60);
    expect(afterAnotherWindow.actions).toBe(1);
    expect(harness.store.listEvents(task.id, "run_stalled")).toHaveLength(1);
  });

  it("direct 以外の run は output が止まっていても対象外にする", async () => {
    const task = createRun("direct-stall-bridge", "bridge");
    writeDirectOutput("direct-stall-bridge", "same");

    await monitorStage.tick(harness.deps, true, 3_000);
    const result = await monitorStage.tick(harness.deps, true, 3_000 + 30 * 60);

    expect(result.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "run_stalled")).toHaveLength(0);
  });

  it("session state が読めない場合は一度だけ警告し、provider別判定をskipする", async () => {
    const task = createRun("direct-stall-missing");
    writeDirectOutput("direct-stall-missing", "無成長");

    const result = await monitorStage.tick(harness.deps, true, 4_000 + 30 * 60);

    expect(result.actions).toBe(1);
    expect(harness.store.listEvents(task.id, "run_stalled")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "direct-session-state-unreadable")).toHaveLength(1);
    expect(harness.store.getActiveRunCancelRequestByTask(task.id)).toBeNull();

    const again = await monitorStage.tick(harness.deps, true, 4_000 + 60 * 60);
    expect(again.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "direct-session-state-unreadable")).toHaveLength(1);
  });

  it("artifact transcript だけが存在しても direct 実行中 output ではないためスキップする", async () => {
    const task = createRun("direct-stall-artifact-only");
    writeArtifactTranscript(task.id, "direct-stall-artifact-only", "same");
    writeSessionState("direct-stall-artifact-only", task.id, { startedAt: 5_000 });
    const stage = stageWithLiveness(false);

    await stage.tick(harness.deps, true, 5_000);
    const result = await stage.tick(harness.deps, true, 5_000 + 30 * 60);

    expect(result.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "run_stalled")).toHaveLength(0);
  });

  it("codex は生存＋15分無成長で run_stall_suspected だけを作る", async () => {
    const task = createRun("direct-alive-1");
    writeDirectOutput("direct-alive-1", "同じまま");
    writeSessionState("direct-alive-1", task.id, { startedAt: 1_000 });
    const stage = stageWithLiveness(true);

    await stage.tick(harness.deps, true, 1_000);
    const result = await stage.tick(harness.deps, true, 1_000 + 15 * 60);

    expect(result.actions).toBe(1);
    expect(harness.store.listEvents(task.id, "run_stalled")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "run_stall_suspected")).toHaveLength(1);
    expect(harness.store.getActiveRunCancelRequestByTask(task.id)).toBeNull();
    expect(harness.store.getLatestOpenRun(task.id)).not.toBeNull();
    expect(harness.store.listOrchestratorRequests()).toEqual([
      expect.objectContaining({
        taskId: task.id,
        questionId: expect.stringMatching(/^run-stall-suspected:\d+:direct-alive-1$/),
        kind: "run_stall_suspected",
        status: "queued",
      }),
    ]);
  });

  it("同一 run の run_stall_suspected と run_stalled は別の冪等キーで共存する", async () => {
    const task = createRun("direct-suspected-then-dead");
    writeDirectOutput("direct-suspected-then-dead", "同じまま");
    writeSessionState("direct-suspected-then-dead", task.id, { startedAt: 1_000 });

    const aliveStage = stageWithLiveness(true);
    await aliveStage.tick(harness.deps, true, 1_000);
    await aliveStage.tick(harness.deps, true, 1_000 + 15 * 60);

    const deadStage = stageWithLiveness(false);
    await deadStage.tick(harness.deps, true, 1_000 + 30 * 60);

    expect(harness.store.listEvents(task.id, "run_stall_suspected")).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "run_stalled")).toHaveLength(1);
    expect(harness.store.getActiveRunCancelRequestByTask(task.id)).not.toBeNull();
    const requests = harness.store.listOrchestratorRequests();
    expect(requests).toHaveLength(2);
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        questionId: expect.stringMatching(/^run-stall-suspected:\d+:direct-suspected-then-dead$/),
        kind: "run_stall_suspected",
      }),
      expect.objectContaining({
        questionId: expect.stringMatching(/^run-stalled:\d+:direct-suspected-then-dead$/),
        kind: "run_stalled",
      }),
    ]));
    expect(new Set(requests.map((request) => request.questionId)).size).toBe(2);
  });

  it("codex は .out と native log の新しい方を progress 時計に使う", async () => {
    const task = createRun("direct-codex-native-progress");
    writeDirectOutput("direct-codex-native-progress", "同じまま");
    writeSessionState("direct-codex-native-progress", task.id, { startedAt: 1_000 });
    const nativeLogPath = writeNativeLog("codex-native", "one\n");
    const stage = stageWithLiveness(true, nativeLogPath);

    await stage.tick(harness.deps, true, 1_000);
    writeFileSync(nativeLogPath, "one\ntwo\n", "utf8");
    const afterNativeGrowth = await stage.tick(harness.deps, true, 1_000 + 15 * 60);
    expect(afterNativeGrowth.actions).toBe(0);

    const suspected = await stage.tick(harness.deps, true, 1_000 + 30 * 60);
    expect(suspected.actions).toBe(1);
    expect(JSON.parse(harness.store.listEvents(task.id, "run_stall_suspected")[0]!.payload)).toMatchObject({
      progressSources: ["direct-output", "native-log"],
      stalledSeconds: 15 * 60,
      warningOnly: true,
    });
    expect(harness.store.getActiveRunCancelRequestByTask(task.id)).toBeNull();
  });

  it("claude は .out 無成長だけでは警告せず native log の無成長45分を見る", async () => {
    const task = createRun("direct-claude-native-only", "direct", "claude");
    writeDirectOutput("direct-claude-native-only", "完了まで変わらない");
    writeSessionState("direct-claude-native-only", task.id, {
      startedAt: 1_000,
      nativeSessionId: "claude-native-session",
    });
    let nativeLogPath: string | null = null;
    const stage = createMonitorStage({
      isDirectSessionAlive: (): boolean => true,
      directNativeLogPathResolver: async (): Promise<string | null> => nativeLogPath,
    });

    await stage.tick(harness.deps, true, 1_000);
    const outputOnly = await stage.tick(harness.deps, true, 1_000 + 45 * 60);
    expect(outputOnly.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "run_stall_suspected")).toHaveLength(0);

    nativeLogPath = writeNativeLog("claude-native", "one\n");
    await stage.tick(harness.deps, true, 1_000 + 45 * 60);
    const nativeStalled = await stage.tick(harness.deps, true, 1_000 + 90 * 60);

    expect(nativeStalled.actions).toBe(1);
    const payload = JSON.parse(harness.store.listEvents(task.id, "run_stall_suspected")[0]!.payload);
    expect(payload).toMatchObject({
      provider: "claude",
      progressSources: ["native-log"],
      stalledSeconds: 45 * 60,
      warningOnly: true,
    });
    expect(payload.outputPath).toBeUndefined();
    expect(harness.store.getActiveRunCancelRequestByTask(task.id)).toBeNull();
  });

  it("native log の成長時刻だけ欠けた state は再初期化し、claude の停滞警告を沈黙させない", async () => {
    const sessionId = "direct-claude-broken-native-state";
    const task = createRun(sessionId, "direct", "claude");
    writeDirectOutput(sessionId, "same");
    writeSessionState(sessionId, task.id, {
      startedAt: 1_000,
      nativeSessionId: "claude-broken-native-state",
    });
    const nativeLogPath = writeNativeLog("claude-broken-native-state", "one\n");
    const stateDir = join(harness.deps.env.home, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "monitor-direct.json"),
      JSON.stringify({
        runs: {
          [sessionId]: {
            size: 4,
            lastGrowthAt: 1_000,
            stalled: false,
            nativeLogPath,
            nativeLogSize: 4,
          },
        },
      }),
      "utf8",
    );
    const stage = stageWithLiveness(true, nativeLogPath);

    const reinitialized = await stage.tick(harness.deps, true, 1_000);
    expect(reinitialized.actions).toBe(0);
    const repairedState = JSON.parse(readFileSync(join(stateDir, "monitor-direct.json"), "utf8")) as {
      runs: Record<string, Record<string, unknown>>;
    };
    expect(repairedState.runs[sessionId]).toMatchObject({
      nativeLogPath,
      nativeLogSize: 4,
      nativeLogLastGrowthAt: 1_000,
    });

    const suspected = await stage.tick(harness.deps, true, 1_000 + 45 * 60);
    expect(suspected.actions).toBe(1);
    expect(JSON.parse(harness.store.listEvents(task.id, "run_stall_suspected")[0]!.payload)).toMatchObject({
      provider: "claude",
      progressSources: ["native-log"],
      stalledSeconds: 45 * 60,
      warningOnly: true,
    });
    expect(harness.store.getActiveRunCancelRequestByTask(task.id)).toBeNull();
  });

  it("生存中 stall 警告へ git status hash・変更path・ownership一致を補助証拠として載せる", async () => {
    const worktree = "/repo/worktree";
    const task = createRun("direct-worktree-evidence", "direct", "codex", `cwd: ${worktree}`);
    writeDirectOutput("direct-worktree-evidence", "同じまま");
    writeSessionState("direct-worktree-evidence", task.id, { startedAt: 1_000 });
    const stage = createMonitorStage({
      isDirectSessionAlive: (): boolean => true,
      directNativeLogPathResolver: async (): Promise<null> => null,
      directStallWorktreeEvidenceCapture: async (_run, capturedWorktree) => {
        expect(capturedWorktree).toBe(worktree);
        return {
          statusHash: "abc123",
          changedPaths: ["packages/supervisor/src/stages/monitor.ts"],
          changedPathsTruncated: false,
          ownershipMatches: true,
        };
      },
    });

    await stage.tick(harness.deps, true, 1_000);
    await stage.tick(harness.deps, true, 1_000 + 15 * 60);

    expect(JSON.parse(harness.store.listEvents(task.id, "run_stall_suspected")[0]!.payload)).toMatchObject({
      worktreeEvidence: {
        statusHash: "abc123",
        changedPaths: ["packages/supervisor/src/stages/monitor.ts"],
        ownershipMatches: true,
      },
    });
  });

  it("出力無成長でプロセスツリーが不在なら run_stalled と cancel を作る", async () => {
    const task = createRun("direct-dead-1");
    writeDirectOutput("direct-dead-1", "同じまま");
    writeSessionState("direct-dead-1", task.id, { startedAt: 1_000 });
    const stage = stageWithLiveness(false);

    await stage.tick(harness.deps, true, 1_000);
    const result = await stage.tick(harness.deps, true, 1_000 + 15 * 60);

    expect(result.actions).toBe(1);
    const events = harness.store.listEvents(task.id, "run_stalled");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({
      sessionId: "direct-dead-1",
      reason: "output-stall",
      stalledSeconds: 15 * 60,
    });
    expect(harness.store.getActiveRunCancelRequestByTask(task.id)).toMatchObject({
      status: "cancel_requested",
      reason: expect.stringContaining("direct output stall"),
    });
    expect(harness.store.listOrchestratorRequests()).toEqual([
      expect.objectContaining({
        taskId: task.id,
        questionId: expect.stringMatching(/^run-stalled:\d+:direct-dead-1$/),
        kind: "run_stalled",
        status: "queued",
      }),
    ]);
  });

  it("run_stalled event・cancel・orchestrator request は途中失敗時にまとめてrollbackする", async () => {
    const task = createRun("direct-atomic-1");
    writeDirectOutput("direct-atomic-1", "同じまま");
    writeSessionState("direct-atomic-1", task.id, { startedAt: 1_000 });
    const stage = stageWithLiveness(false);
    await stage.tick(harness.deps, true, 1_000);

    const original = harness.store.createOrGetOrchestratorRequest.bind(harness.store);
    vi.spyOn(harness.store, "createOrGetOrchestratorRequest").mockImplementation((input) => {
      const request = original(input);
      if (input.questionId.startsWith("run-stalled:")) {
        throw new Error("injected request failure");
      }
      return request;
    });

    await expect(stage.tick(harness.deps, true, 1_000 + 15 * 60)).rejects.toThrow("injected request failure");
    expect(harness.store.listEvents(task.id, "run_stalled")).toHaveLength(0);
    expect(harness.store.getActiveRunCancelRequestByTask(task.id)).toBeNull();
    expect(harness.store.listOrchestratorRequests()).toHaveLength(0);
  });

  it("プロセス生存中でも maxRuntimeSeconds 超過は max-runtime 理由で run_stalled にする", async () => {
    const task = createRun("direct-maxruntime-1");
    writeDirectOutput("direct-maxruntime-1", "同じまま");
    writeSessionState("direct-maxruntime-1", task.id, { startedAt: 1_000 });
    const stage = stageWithLiveness(true);

    // codex 既定 maxRuntimeSeconds=7200（resourceGuard.maxRunSeconds と同値）。直前（7199s）ではまだ何もしない。
    const before = await stage.tick(harness.deps, true, 1_000 + 120 * 60 - 1);
    expect(before.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "run_stalled")).toHaveLength(0);

    const result = await stage.tick(harness.deps, true, 1_000 + 120 * 60);
    expect(result.actions).toBe(1);
    const events = harness.store.listEvents(task.id, "run_stalled");
    expect(events).toHaveLength(1);
    // 理由が「無出力」ではなく「上限超過」であることを payload と cancel reason の両方で区別できる。
    expect(JSON.parse(events[0]!.payload)).toMatchObject({
      sessionId: "direct-maxruntime-1",
      reason: "max-runtime",
      elapsedSeconds: 120 * 60,
      maxRuntimeSeconds: 120 * 60,
    });
    expect(harness.store.getActiveRunCancelRequestByTask(task.id)).toMatchObject({
      status: "cancel_requested",
      reason: expect.stringContaining("direct max runtime exceeded"),
    });

    // 同一 run で二重に宣言しない。
    const again = await stage.tick(harness.deps, true, 1_000 + 150 * 60);
    expect(again.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "run_stalled")).toHaveLength(1);
    expect(harness.store.listOrchestratorRequests().filter((request) => request.taskId === task.id)).toHaveLength(1);
  });

  it("出力が無いまま生存し続ける run も maxRuntimeSeconds 超過で打ち切る", async () => {
    const task = createRun("direct-maxruntime-nooutput", "direct", "claude");
    writeSessionState("direct-maxruntime-nooutput", task.id, { startedAt: 1_000 });
    const stage = stageWithLiveness(true);

    const result = await stage.tick(harness.deps, true, 1_000 + 180 * 60);

    expect(result.actions).toBe(1);
    const payload = JSON.parse(harness.store.listEvents(task.id, "run_stalled")[0]!.payload);
    expect(payload).toMatchObject({ reason: "max-runtime", maxRuntimeSeconds: 180 * 60 });
    // 出力が観測できていないので outputPath / size は載せない。
    expect(payload.outputPath).toBeUndefined();
  });

  it("pid を取得できない session は出力無成長でも cancel せず読取不能警告だけを出す", async () => {
    const task = createRun("direct-legacy-1");
    writeDirectOutput("direct-legacy-1", "同じまま");
    // pid=0 は readDirectSessionState が fail-closed で弾く（= 判定材料なし）。
    writeSessionState("direct-legacy-1", task.id, { pid: 0, startedAt: 1_000 });
    // 生存判定は呼ばず、共有 guard 以外の destructive path を閉じる。
    const stage = stageWithLiveness(true);

    await stage.tick(harness.deps, true, 1_000);
    const result = await stage.tick(harness.deps, true, 1_000 + 15 * 60);

    expect(result.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "run_stalled")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "direct-session-state-unreadable")).toHaveLength(1);
    expect(harness.store.getActiveRunCancelRequestByTask(task.id)).toBeNull();
  });

  it("provider 別の既定閾値が効く（claude は codex より長い無出力を許容する）", async () => {
    const codexTask = createRun("direct-default-codex", "direct", "codex");
    const claudeTask = createRun("direct-default-claude", "direct", "claude");
    writeDirectOutput("direct-default-codex", "同じまま");
    writeDirectOutput("direct-default-claude", "同じまま");
    writeSessionState("direct-default-codex", codexTask.id, { startedAt: 1_000 });
    writeSessionState("direct-default-claude", claudeTask.id, { startedAt: 1_000 });
    const stage = stageWithLiveness(false);

    await stage.tick(harness.deps, true, 1_000);
    // 30 分無成長: codex 既定 900s は超過、claude 既定 2700s は未超過。
    await stage.tick(harness.deps, true, 1_000 + 30 * 60);
    expect(harness.store.listEvents(codexTask.id, "run_stalled")).toHaveLength(1);
    expect(harness.store.listEvents(claudeTask.id, "run_stalled")).toHaveLength(0);

    // 50 分無成長で claude 既定も超過する。
    await stage.tick(harness.deps, true, 1_000 + 50 * 60);
    expect(harness.store.listEvents(claudeTask.id, "run_stalled")).toHaveLength(1);
  });

  it("config の direct.stall 上書きが provider 別に効く", async () => {
    const task = createRun("direct-override-1", "direct", "claude");
    writeDirectOutput("direct-override-1", "同じまま");
    writeSessionState("direct-override-1", task.id, { startedAt: 1_000 });
    harness.deps.config = directStallConfig({ claude: { outputStallSeconds: 60, maxRuntimeSeconds: 600 } });
    const stage = stageWithLiveness(false);

    await stage.tick(harness.deps, true, 1_000);
    // 既定 2700s なら未発火の 60s 経過で、上書きにより stall する。
    const result = await stage.tick(harness.deps, true, 1_060);

    expect(result.actions).toBe(1);
    expect(JSON.parse(harness.store.listEvents(task.id, "run_stalled")[0]!.payload)).toMatchObject({
      reason: "output-stall",
      stalledSeconds: 60,
    });
  });

  it("config の direct.stall で maxRuntimeSeconds も provider 別に上書きできる", async () => {
    const task = createRun("direct-override-2", "direct", "codex");
    writeDirectOutput("direct-override-2", "同じまま");
    writeSessionState("direct-override-2", task.id, { startedAt: 1_000 });
    harness.deps.config = directStallConfig({ codex: { maxRuntimeSeconds: 300 } });
    const stage = stageWithLiveness(true);

    const result = await stage.tick(harness.deps, true, 1_300);

    expect(result.actions).toBe(1);
    expect(JSON.parse(harness.store.listEvents(task.id, "run_stalled")[0]!.payload)).toMatchObject({
      reason: "max-runtime",
      maxRuntimeSeconds: 300,
    });
  });

  it("既定の生存判定は生きている pid を confirmed crash にせず suspected warning にする", async () => {
    const task = createRun("direct-default-probe");
    writeDirectOutput("direct-default-probe", "同じまま");
    // 自プロセスは必ず生存している。既定 probe が誤って「不在」を返すと本番と同じ誤 kill が起きる。
    writeSessionState("direct-default-probe", task.id, { pid: process.pid, startedAt: 1_000 });

    await monitorStage.tick(harness.deps, true, 1_000);
    const result = await monitorStage.tick(harness.deps, true, 1_000 + 15 * 60);

    expect(result.actions).toBe(1);
    expect(harness.store.listEvents(task.id, "run_stalled")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "run_stall_suspected")).toHaveLength(1);
    expect(harness.store.getActiveRunCancelRequestByTask(task.id)).toBeNull();
  });

  it("maxRuntimeStalled を持たない既存の monitor-direct.json をそのまま読める", async () => {
    const task = createRun("direct-legacy-state");
    writeDirectOutput("direct-legacy-state", "同じまま");
    writeSessionState("direct-legacy-state", task.id, { startedAt: 1_000 });
    // 旧フォーマット（size/lastGrowthAt/stalled の 3 フィールドのみ）。
    const stateDir = join(harness.deps.env.home, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "monitor-direct.json"),
      JSON.stringify({ runs: { "direct-legacy-state": { size: 12, lastGrowthAt: 1_000, stalled: false } } }),
      "utf8",
    );
    const stage = stageWithLiveness(false);

    // 旧エントリの lastGrowthAt=1000 が読めていれば、初回 tick でそのまま stall 判定に入る。
    const result = await stage.tick(harness.deps, true, 1_000 + 15 * 60);

    expect(result.actions).toBe(1);
    expect(JSON.parse(harness.store.listEvents(task.id, "run_stalled")[0]!.payload)).toMatchObject({
      reason: "output-stall",
      stalledSeconds: 15 * 60,
    });
  });
});

// resourceGuard.maxRunSeconds を小さく上書きする必要があるため、別の describe（別 harness）に分離する。
describe("monitorStage: max 実行時間の強制回収（docs/contract.md §34.3）", () => {
  let harness: TestHarness;
  let fakeCodex: FakeAdapter;

  // 実時間経過に頼らず、tick に渡す now を意図的に未来へずらして max-runtime 超過を再現する。
  const FAR_FUTURE_OFFSET_SEC = 100_000;

  beforeEach(async () => {
    harness = await setupHarness({
      resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2, maxRunSeconds: 60 },
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  // 進行中タスクを構築する（describe 外の同名ヘルパーと同一ロジック。describe 単位で harness が異なるため複製する）。
  function createInProgressTask(sessionId: string): TaskRow {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "進行中タスク（max-runtime）" }),
      "tester",
    );
    const blocked = harness.store.block(
      task.id,
      `codex-in-progress: 実装中 tmux=none even-session=${sessionId} server=http://x started=2026-07-02T10:00:00+09:00`,
      "tester",
    );
    harness.store.startRun(task.id, "codex", sessionId, { serverUrl: "http://x" });
    return blocked;
  }

  it("max-runtime は即 stop/close せず durable cancel request を作る", async () => {
    fakeCodex = new FakeAdapter("codex");
    fakeCodex.stopResponse = { stopped: true, reason: "terminated" };
    harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

    const task = createInProgressTask("sess-max-1");
    const now = Math.floor(Date.now() / 1000) + FAR_FUTURE_OFFSET_SEC;

    const result = await monitorStage.tick(harness.deps, true, now);
    expect(result.actions).toBe(1);

    expect(harness.store.getTask(task.id)?.blockReason.startsWith("codex-in-progress:")).toBe(true);
    expect(fakeCodex.stopCalls).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "run_stop")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "cancel_requested")).toHaveLength(1);
    expect(harness.store.getActiveRunCancelRequestByTask(task.id)).toMatchObject({
      status: "cancel_requested",
      reason: expect.stringContaining("max-runtime exceeded"),
    });
    expect(harness.store.getLatestOpenRun(task.id)).not.toBeNull();
  });

  it("stop capability が無い場合も monitor は pending request と open run を維持する", async () => {
    fakeCodex = new FakeAdapter("codex", { supportsStop: false });
    harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

    const task = createInProgressTask("sess-max-2");
    const now = Math.floor(Date.now() / 1000) + FAR_FUTURE_OFFSET_SEC;

    const result = await monitorStage.tick(harness.deps, true, now);
    expect(result.actions).toBe(1);

    expect(harness.store.getTask(task.id)?.blockReason.startsWith("codex-in-progress:")).toBe(true);
    expect(fakeCodex.stopCalls).toHaveLength(0);
    expect(harness.store.getActiveRunCancelRequestByTask(task.id)?.status).toBe("cancel_requested");
    expect(harness.store.getLatestOpenRun(task.id)).not.toBeNull();
  });

  it("direct run の max-runtime 超過も cancel engine に委譲し monitor は stop しない", async () => {
    const directCodex = new FakeAdapter("codex");
    directCodex.stopResponse = { stopped: true, reason: "terminated" };
    harness.deps.directAdapters = { codex: directCodex };

    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "direct 進行中タスク（max-runtime）" }),
      "tester",
    );
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=direct-max-1 server=direct started=2026-07-02T10:00:00+09:00",
      "tester",
    );
    harness.store.startRun(task.id, "codex", "direct-max-1", {
      serverUrl: "direct",
      model: "gpt-5.4",
      modelDelivery: "native",
      transport: "direct",
    });
    const now = Math.floor(Date.now() / 1000) + FAR_FUTURE_OFFSET_SEC;

    const result = await monitorStage.tick(harness.deps, true, now);

    expect(result.actions).toBe(2);
    expect(harness.store.listEvents(task.id, "direct-session-state-unreadable")).toHaveLength(1);
    expect(directCodex.stopCalls).toHaveLength(0);
    expect(harness.store.getLatestOpenRun(task.id)).not.toBeNull();
    expect(harness.store.getActiveRunCancelRequestByTask(task.id)?.sessionId).toBe("direct-max-1");
  });

  it("dry-run では actions のみ計上し副作用ゼロ", async () => {
    fakeCodex = new FakeAdapter("codex");
    harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

    const task = createInProgressTask("sess-max-3");
    const now = Math.floor(Date.now() / 1000) + FAR_FUTURE_OFFSET_SEC;

    const result = await monitorStage.tick(harness.deps, false, now);
    expect(result.actions).toBe(1);

    const updated = harness.store.getTask(task.id);
    expect(updated?.blockReason.startsWith("codex-in-progress:")).toBe(true);

    expect(harness.store.listEvents(task.id, "run_stop")).toHaveLength(0);
    expect(harness.store.getLatestOpenRun(task.id)).not.toBeNull();
    expect(fakeCodex.stopCalls).toHaveLength(0);
  });

  it("経過時間が閾値以内なら影響しない（既存の session_ended 検知が正常に動く）", async () => {
    fakeCodex = new FakeAdapter("codex");
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
    harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

    createInProgressTask("sess-max-4");
    const now = Math.floor(Date.now() / 1000);

    const result = await monitorStage.tick(harness.deps, true, now);
    expect(result.actions).toBe(1);
    expect(result.notes?.some((n) => n.includes("max-runtime"))).toBe(false);
  });

  it("max-runtime の反復 tick は二重 cancel を作らない", async () => {
    fakeCodex = new FakeAdapter("codex");
    fakeCodex.stopResponse = { stopped: true, reason: "terminated" };
    harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

    const task = createInProgressTask("sess-max-race-old");
    const now = Math.floor(Date.now() / 1000) + FAR_FUTURE_OFFSET_SEC;

    await monitorStage.tick(harness.deps, true, now);
    await monitorStage.tick(harness.deps, true, now + 1);

    expect(harness.store.listRunCancelRequests(task.id)).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "cancel_requested")).toHaveLength(1);
    expect(harness.store.getLatestOpenRun(task.id)?.sessionId).toBe("sess-max-race-old");
    expect(fakeCodex.stopCalls).toHaveLength(0);
  });
});
