import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import {
  HUMAN_DECISION_QUEUE_PREFIXES,
  ORCHESTRATOR_RECOVERY_QUEUE_PREFIXES,
  createKanbanReadView,
  humanQueueLaneOfReason,
  type KanbanReadViewCapabilities,
} from "./readview.js";
import type { KnowledgeListOptions } from "./db.js";
import type { KnowledgeRow, RunStatus, TaskCreateInput, TaskRow, TaskStatus } from "./types.js";
import type { RelayDeliveryUncertainRecordInput } from "./relay-control-persistence.js";

interface KnowledgeReadView extends KanbanReadViewCapabilities {
  listKnowledge(options?: KnowledgeListOptions): KnowledgeRow[];
}

/** bucketOf は task の値のみで判定する純粋関数のため、DB を経由せずフィクスチャで直接検証する */
function fixtureTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t_fixture",
    title: "fixture",
    body: "",
    status: "triage",
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
    watched: false,
    consecutiveFailures: 0,
    lastFailureError: "",
    lastHeartbeatAt: null,
    maxRetries: 3,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("createKanbanReadView", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteKanbanStore;
  let view: KanbanReadViewCapabilities | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hachi-core-readview-test-"));
    dbPath = join(tempDir, "kanban.db");
    // readview は :memory: を2接続で共有できないため一時ファイル DB を使う。
    // fileMustExist のため、先に書込側（SqliteKanbanStore）で DB ファイルとスキーマを作成する。
    store = new SqliteKanbanStore(dbPath);
  });

  afterEach(() => {
    vi.useRealTimers();
    view?.close();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createTask(input: TaskCreateInput): TaskRow {
    return store.createTask(input, "tester");
  }

  function createKnowledgeView(): KnowledgeReadView {
    return createKanbanReadView(dbPath) as KnowledgeReadView;
  }

  it("DB ファイルが存在しない場合は throw する（fileMustExist, fail-closed）", () => {
    expect(() => createKanbanReadView(join(tempDir, "missing.db"))).toThrow();
  });

  describe("tenants", () => {
    it("DISTINCT tenant を昇順で返す（空文字も1つの値として含む）", () => {
      createTask({ title: "a", body: "", tenant: "beta" });
      createTask({ title: "b", body: "", tenant: "alpha" });
      createTask({ title: "c", body: "", tenant: "" });
      createTask({ title: "d", body: "", tenant: "alpha" });

      view = createKanbanReadView(dbPath);
      expect(view.tenants()).toEqual(["", "alpha", "beta"]);
    });
  });

  describe("watched", () => {
    it("board/task の read view に watched を含める", () => {
      const task = createTask({ title: "watch 対象", body: "", tenant: "dev", status: "ready" });
      store.setWatched(task.id, true, "human");

      view = createKanbanReadView(dbPath);

      expect(view.byStatus("ready")[0]?.watched).toBe(true);
      expect(view.task(task.id)?.watched).toBe(true);
    });
  });

  describe("knowledge", () => {
    it("listKnowledge は tag/source/search/limit を readonly 接続で返す", () => {
      const first = store.addKnowledge(
        {
          title: "Bridge handover",
          body: "restart procedure",
          source: "session-handover",
          tags: ["handover", "bridge"],
          importance: 80,
          createdAt: 1_700_000_000,
        },
        "tester",
      );
      const second = store.addKnowledge(
        {
          title: "Bridge daily",
          body: "daily note",
          source: "steward",
          tags: ["bridge"],
          importance: 90,
          createdAt: 1_700_000_001,
        },
        "tester",
      );
      store.addKnowledge(
        {
          title: "Other",
          body: "unrelated",
          source: "steward",
          tags: ["other"],
          importance: 100,
          createdAt: 1_700_000_002,
        },
        "tester",
      );

      const knowledgeView = createKnowledgeView();
      view = knowledgeView;

      expect(knowledgeView.listKnowledge({ search: "bridge", limit: 1 }).map((row) => row.id)).toEqual([second.id]);
      expect(
        knowledgeView
          .listKnowledge({ tag: "handover", source: "session-handover", search: "restart", limit: 10 })
          .map((row) => row.id),
      ).toEqual([first.id]);
    });
  });

  describe("runningSessions", () => {
    it("running の task_runs を tasks と結合し、meta から表示項目を抽出する", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const oldTask = createTask({ title: "古い実行", body: "", tenant: "worker-tenant", status: "ready" });
      store.block(oldTask.id, "codex-in-progress: sess-old", "tester");
      const oldRun = store.startRun(oldTask.id, "codex", "sess-old", {
        model: "gpt-5.4",
        transport: "bridge",
        serverUrl: "http://127.0.0.1:3456",
      });

      vi.setSystemTime(1_700_000_010_000);
      const newTask = createTask({ title: "新しい実行", body: "", tenant: "review-tenant", status: "ready" });
      store.block(newTask.id, "codex-in-progress: sess-new", "tester");
      store.unblock(newTask.id, "review", "tester");
      const newRun = store.startRun(newTask.id, "claude", "sess-new", {
        role: "reviewer",
        model: "claude-sonnet-5",
        transport: "direct",
        serverUrl: "direct",
      });

      const doneTask = createTask({ title: "完了済み", body: "", tenant: "dev" });
      const doneRun = store.startRun(doneTask.id, "codex", "sess-done", {
        model: "gpt-5.4",
        transport: "bridge",
        serverUrl: "http://127.0.0.1:3456",
      });
      store.endRun(doneRun.id, "done");

      view = createKanbanReadView(dbPath);
      expect(view.runningSessions()).toEqual([
        {
          taskId: newTask.id,
          taskTitle: "新しい実行",
          taskStatus: "review",
          tenant: "review-tenant",
          provider: "claude",
          model: "claude-sonnet-5",
          transport: "direct",
          sessionId: "sess-new",
          serverUrl: "direct",
          startedAt: newRun.startedAt,
          state: "running",
          role: "reviewer",
          effort: null,
          effortDelivery: null,
          speed: null,
          speedDelivery: null,
        },
        {
          taskId: oldTask.id,
          taskTitle: "古い実行",
          taskStatus: "blocked",
          tenant: "worker-tenant",
          provider: "codex",
          model: "gpt-5.4",
          transport: "bridge",
          sessionId: "sess-old",
          serverUrl: "http://127.0.0.1:3456",
          startedAt: oldRun.startedAt,
          state: "running",
          role: "worker",
          effort: null,
          effortDelivery: null,
          speed: null,
          speedDelivery: null,
        },
      ]);
    });

    it("meta が壊れていても一覧取得は継続し、meta 由来フィールドを空文字にする", () => {
      const task = createTask({ title: "meta 壊れ", body: "", tenant: "broken-tenant" });
      const raw = new Database(dbPath);
      try {
        raw
          .prepare(
            `INSERT INTO task_runs (task_id, provider, session_id, status, meta, started_at)
             VALUES (?, ?, ?, 'running', ?, ?)`,
          )
          .run(task.id, "codex", "sess-broken", "{not-json", 1_700_000_000);
      } finally {
        raw.close();
      }

      view = createKanbanReadView(dbPath);
      expect(view.runningSessions()).toEqual([
        {
          taskId: task.id,
          taskTitle: "meta 壊れ",
          taskStatus: "triage",
          tenant: "broken-tenant",
          provider: "codex",
          model: "",
          transport: "",
          sessionId: "sess-broken",
          serverUrl: "",
          startedAt: 1_700_000_000,
          state: "running",
          role: "worker",
          effort: null,
          effortDelivery: null,
          speed: null,
          speedDelivery: null,
        },
      ]);
    });

    it("meta に effort/effortDelivery が記録されている場合は抽出する", () => {
      const task = createTask({ title: "effort 指定", body: "", tenant: "dev", status: "ready" });
      store.block(task.id, "codex-in-progress: sess-effort", "tester");
      store.startRun(task.id, "codex", "sess-effort", {
        model: "gpt-5.4",
        transport: "bridge",
        serverUrl: "http://127.0.0.1:3456",
        effort: "high",
        effortDelivery: "native",
      });

      view = createKanbanReadView(dbPath);
      const sessions = view.runningSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        effort: "high",
        effortDelivery: "native",
      });
    });

    it("effortDelivery が 'none' の場合も正しく抽出する", () => {
      const task = createTask({ title: "effort bridge", body: "", tenant: "dev", status: "ready" });
      store.block(task.id, "claude-in-progress: sess-effort-none", "tester");
      store.startRun(task.id, "claude", "sess-effort-none", {
        model: "claude-sonnet-5",
        transport: "bridge",
        serverUrl: "http://127.0.0.1:3457",
        effort: "medium",
        effortDelivery: "none",
      });

      view = createKanbanReadView(dbPath);
      const sessions = view.runningSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        effort: "medium",
        effortDelivery: "none",
      });
    });

    it("meta のspeed/speedDeliveryを要求値と配送結果として分離して抽出する", () => {
      const task = createTask({ title: "fast worker", body: "", tenant: "speed-tenant" });
      store.startRun(task.id, "codex", "sess-speed", {
        model: "gpt-5.6-sol",
        transport: "direct",
        serverUrl: "direct",
        speed: "fast",
        speedDelivery: "native",
      });

      view = createKanbanReadView(dbPath);
      expect(view.runningSessions()[0]).toMatchObject({
        speed: "fast",
        speedDelivery: "native",
      });
    });
  });

  describe("schedules", () => {
    it("schedules は作成順で ScheduleRow を返し、schedule(id) は1件を返す", () => {
      const first = store.createSchedule(
        {
          name: "朝の巡回",
          cadenceKind: "daily",
          atMinute: 30,
          atHour: 9,
          cwd: "/tmp/hk-scheduler",
          prompt: "状態を確認してください",
          tenant: "dev",
          profile: "implement",
          priority: 2,
        },
        "tester",
      );
      const second = store.createSchedule(
        {
          name: "週次レビュー",
          cadenceKind: "weekly",
          weekday: 1,
          atMinute: 0,
          atHour: 10,
          cwd: "/tmp/hk-scheduler",
          prompt: "レビューを実行してください",
        },
        "tester",
      );
      store.setScheduleEnabled(second.id, false, "tester", "paused");

      view = createKanbanReadView(dbPath);
      expect(view.schedules().map((schedule) => schedule.id)).toEqual([first.id, second.id]);
      expect(view.schedule(first.id)).toMatchObject({
        id: first.id,
        name: "朝の巡回",
        enabled: true,
        cadenceKind: "daily",
        tenant: "dev",
        profile: "implement",
        priority: 2,
      });
      expect(view.schedule(second.id)).toMatchObject({
        id: second.id,
        enabled: false,
        weekday: 1,
        autoDisabledReason: "paused",
      });
      expect(view.schedule("s_deadbeefdeadbeef")).toBeNull();
    });

    it("scheduleFormOptions は cwd と tenant の候補を契約どおり返す", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      createTask({
        title: "古い cwd",
        body: "cwd: /tmp/hk-old\n古いタスク",
        tenant: "beta",
      });

      vi.setSystemTime(1_700_000_005_000);
      const editedTask = createTask({
        title: "後から cwd を変えるタスク",
        body: "cwd: /tmp/hk-before-edit\n作成時の cwd",
        tenant: "beta",
      });

      vi.setSystemTime(1_700_000_010_000);
      store.createSchedule(
        {
          name: "schedule cwd",
          cadenceKind: "daily",
          atMinute: 0,
          atHour: 9,
          cwd: "/tmp/hk-schedule",
          prompt: "run",
          tenant: "alpha",
        },
        "tester",
      );

      vi.setSystemTime(1_700_000_020_000);
      createTask({
        title: "新しい cwd",
        body: "cwd: /tmp/hk-new\n新しいタスク",
        tenant: "",
      });
      createTask({
        title: "先頭行ではない cwd",
        body: "本文\ncwd: /tmp/hk-ignored",
        tenant: "beta",
      });
      createTask({
        title: "相対 cwd",
        body: "cwd: relative/path",
        tenant: "delta",
      });

      vi.setSystemTime(1_700_000_025_000);
      store.updateBody(editedTask.id, "cwd: /tmp/hk-edited\n後から更新した cwd", "tester");

      vi.setSystemTime(1_700_000_030_000);
      store.createSchedule(
        {
          name: "duplicate cwd",
          cadenceKind: "daily",
          atMinute: 0,
          atHour: 10,
          cwd: "/tmp/hk-old",
          prompt: "run",
          tenant: "gamma",
        },
        "tester",
      );

      view = createKanbanReadView(dbPath);
      expect(view.scheduleFormOptions()).toEqual({
        cwds: ["/tmp/hk-old", "/tmp/hk-edited", "/tmp/hk-new", "/tmp/hk-schedule"],
        tenants: ["alpha", "beta", "delta", "gamma"],
      });
    });
  });

  describe("recentSessions", () => {
    it("meta に effort/effortDelivery が記録されている終了済みセッションも正しく抽出する", () => {
      const task = createTask({ title: "effort 付き終了", body: "", tenant: "dev", status: "ready" });
      store.block(task.id, "codex-in-progress: sess-recent-effort", "tester");
      const run = store.startRun(task.id, "codex", "sess-recent-effort", {
        model: "gpt-5.4",
        transport: "bridge",
        serverUrl: "http://127.0.0.1:3456",
        effort: "low",
        effortDelivery: "native",
      });
      store.endRun(run.id, "done");

      view = createKanbanReadView(dbPath);
      const sessions = view.recentSessions(10);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        effort: "low",
        effortDelivery: "native",
        state: "ended",
      });
    });

    it("終了済み run を started_at 降順・limit 件で返し、state='ended' を付与する", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const oldTask = createTask({ title: "古い完了", body: "", tenant: "old-tenant" });
      const oldRun = store.startRun(oldTask.id, "codex", "sess-old-done", {
        model: "gpt-5.4",
        transport: "bridge",
        serverUrl: "http://127.0.0.1:3456",
      });
      store.endRun(oldRun.id, "done");

      vi.setSystemTime(1_700_000_010_000);
      const failedTask = createTask({ title: "失敗", body: "", tenant: "failed-tenant" });
      const failedRun = store.startRun(failedTask.id, "claude", "sess-failed", {
        role: "reviewer",
        model: "claude-sonnet-5",
        transport: "bridge",
        serverUrl: "http://127.0.0.1:3457",
      });
      store.endRun(failedRun.id, "failed");

      vi.setSystemTime(1_700_000_020_000);
      const releasedTask = createTask({ title: "解放", body: "", tenant: "released-tenant" });
      const releasedRun = store.startRun(releasedTask.id, "codex", "sess-released", {
        model: "gpt-5.4",
        transport: "direct",
        serverUrl: "direct",
      });
      store.endRun(releasedRun.id, "released");

      const runningTask = createTask({ title: "実行中", body: "", tenant: "dev" });
      store.startRun(runningTask.id, "codex", "sess-running", {
        model: "gpt-5.4",
        transport: "bridge",
        serverUrl: "http://127.0.0.1:3456",
      });

      view = createKanbanReadView(dbPath);
      expect(view.recentSessions(2)).toEqual([
        {
          taskId: releasedTask.id,
          taskTitle: "解放",
          taskStatus: "triage",
          tenant: "released-tenant",
          provider: "codex",
          model: "gpt-5.4",
          transport: "direct",
          sessionId: "sess-released",
          serverUrl: "direct",
          startedAt: releasedRun.startedAt,
          state: "ended",
          role: "worker",
          effort: null,
          effortDelivery: null,
          speed: null,
          speedDelivery: null,
        },
        {
          taskId: failedTask.id,
          taskTitle: "失敗",
          taskStatus: "triage",
          tenant: "failed-tenant",
          provider: "claude",
          model: "claude-sonnet-5",
          transport: "bridge",
          sessionId: "sess-failed",
          serverUrl: "http://127.0.0.1:3457",
          startedAt: failedRun.startedAt,
          state: "ended",
          role: "reviewer",
          effort: null,
          effortDelivery: null,
          speed: null,
          speedDelivery: null,
        },
      ]);
    });

    it("stopped run も終了済みセッションとして返す", () => {
      const task = createTask({ title: "停止済み", body: "", tenant: "stopped-tenant" });
      const run = store.startRun(task.id, "codex", "sess-stopped", {
        model: "gpt-5.5",
        transport: "direct",
        serverUrl: "direct",
      });
      store.endRun(run.id, "stopped" as RunStatus);

      view = createKanbanReadView(dbPath);
      expect(view.recentSessions(10)).toEqual([
        {
          taskId: task.id,
          taskTitle: "停止済み",
          taskStatus: "triage",
          tenant: "stopped-tenant",
          provider: "codex",
          model: "gpt-5.5",
          transport: "direct",
          sessionId: "sess-stopped",
          serverUrl: "direct",
          startedAt: run.startedAt,
          state: "ended",
          role: "worker",
          effort: null,
          effortDelivery: null,
          speed: null,
          speedDelivery: null,
        },
      ]);
    });

    it("limit が 0 以下なら空配列を返す", () => {
      view = createKanbanReadView(dbPath);
      expect(view.recentSessions(0)).toEqual([]);
      expect(view.recentSessions(-1)).toEqual([]);
    });
  });

  describe("runningSession", () => {
    it("sessionId 指定で effort/effortDelivery を含むセッションを返す", () => {
      const task = createTask({ title: "effort 単体取得", body: "", tenant: "dev", status: "ready" });
      store.block(task.id, "claude-in-progress: sess-single-effort", "tester");
      store.startRun(task.id, "claude", "sess-single-effort", {
        model: "claude-sonnet-5",
        transport: "direct",
        serverUrl: "direct",
        effort: "xhigh",
        effortDelivery: "none",
      });

      view = createKanbanReadView(dbPath);
      const session = view.runningSession("sess-single-effort");
      expect(session).not.toBeNull();
      expect(session).toMatchObject({
        effort: "xhigh",
        effortDelivery: "none",
        state: "running",
      });
    });

    it("終了済みセッションでも effort/effortDelivery を保持して返す", () => {
      const task = createTask({ title: "effort 終了後取得", body: "", tenant: "dev" });
      const run = store.startRun(task.id, "codex", "sess-ended-effort", {
        model: "gpt-5.4",
        transport: "bridge",
        serverUrl: "http://127.0.0.1:3456",
        effort: "medium",
        effortDelivery: "native",
      });
      store.endRun(run.id, "done");

      view = createKanbanReadView(dbPath);
      const session = view.runningSession("sess-ended-effort");
      expect(session).not.toBeNull();
      expect(session).toMatchObject({
        effort: "medium",
        effortDelivery: "native",
        state: "ended",
      });
    });

    it("sessionId が一致する running run を優先して返す", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const endedTask = createTask({ title: "終了済み", body: "", tenant: "ended-tenant" });
      const endedRun = store.startRun(endedTask.id, "codex", "sess-same", {
        model: "gpt-5.4",
        transport: "bridge",
        serverUrl: "http://127.0.0.1:3456",
      });
      store.endRun(endedRun.id, "done");

      vi.setSystemTime(1_700_000_010_000);
      const runningTask = createTask({ title: "実行中", body: "", tenant: "running-tenant" });
      const runningRun = store.startRun(runningTask.id, "claude", "sess-same", {
        role: "reviewer",
        model: "claude-sonnet-5",
        transport: "bridge",
        serverUrl: "http://127.0.0.1:3457",
      });

      view = createKanbanReadView(dbPath);
      expect(view.runningSession("sess-same")).toEqual({
        taskId: runningTask.id,
        taskTitle: "実行中",
        taskStatus: "triage",
        tenant: "running-tenant",
        provider: "claude",
        model: "claude-sonnet-5",
        transport: "bridge",
        sessionId: "sess-same",
        serverUrl: "http://127.0.0.1:3457",
        startedAt: runningRun.startedAt,
        state: "running",
        role: "reviewer",
        effort: null,
        effortDelivery: null,
        speed: null,
        speedDelivery: null,
      });
    });

    it("running が無ければ終了済み run を返し、無ければ null を返す", () => {
      const task = createTask({ title: "完了済み", body: "", tenant: "ended-only-tenant" });
      const run = store.startRun(task.id, "codex", "sess-ended", {
        model: "gpt-5.4",
        transport: "bridge",
        serverUrl: "http://127.0.0.1:3456",
      });
      store.endRun(run.id, "done");

      view = createKanbanReadView(dbPath);
      expect(view.runningSession("sess-ended")).toEqual({
        taskId: task.id,
        taskTitle: "完了済み",
        taskStatus: "triage",
        tenant: "ended-only-tenant",
        provider: "codex",
        model: "gpt-5.4",
        transport: "bridge",
        sessionId: "sess-ended",
        serverUrl: "http://127.0.0.1:3456",
        startedAt: run.startedAt,
        state: "ended",
        role: "worker",
        effort: null,
        effortDelivery: null,
        speed: null,
        speedDelivery: null,
      });
      expect(view.runningSession("missing")).toBeNull();
      expect(view.runningSession("")).toBeNull();
    });
  });

  describe("counts", () => {
    it("tenant 指定なしは全 status を0埋めで全体件数を返す", () => {
      createTask({ title: "a", body: "", tenant: "dev", status: "triage" });
      createTask({ title: "b", body: "", tenant: "other", status: "ready" });

      view = createKanbanReadView(dbPath);
      const counts = view.counts();
      expect(counts).toMatchObject({
        triage: 1,
        todo: 0,
        ready: 1,
        blocked: 0,
        review: 0,
        "needs-integration": 0,
        done: 0,
        archived: 0,
      });
    });

    it("tenant 指定時はその tenant のみ集計する", () => {
      createTask({ title: "a", body: "", tenant: "dev", status: "triage" });
      createTask({ title: "b", body: "", tenant: "dev", status: "triage" });
      createTask({ title: "c", body: "", tenant: "other", status: "triage" });

      view = createKanbanReadView(dbPath);
      expect(view.counts("dev").triage).toBe(2);
      expect(view.counts("other").triage).toBe(1);
    });
  });

  describe("humanQueue", () => {
    it("prefix ごとの対応主体を分類し、未知 prefix は回収待ちへ倒す", () => {
      for (const prefix of HUMAN_DECISION_QUEUE_PREFIXES) {
        expect(humanQueueLaneOfReason(`${prefix} 確認待ち`)).toBe("human_decision");
      }
      for (const prefix of ORCHESTRATOR_RECOVERY_QUEUE_PREFIXES) {
        expect(humanQueueLaneOfReason(`${prefix} 回収待ち`)).toBe("orchestrator_recovery");
      }
      expect(humanQueueLaneOfReason("worker-question: 仕様確認")).toBe("orchestrator_recovery");
      expect(humanQueueLaneOfReason("unknown-prefix: 確認不能")).toBe("orchestrator_recovery");
    });

    it("worker-question を含む5種の prefix を human_queue として拾い、priority 降順 → updated_at 昇順で返す", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const low = createTask({ title: "low", body: "", tenant: "dev", status: "ready", priority: 1 });
      store.block(low.id, "user-decision: x", "supervisor");

      vi.setSystemTime(1_700_000_010_000);
      const highEarly = createTask({ title: "highEarly", body: "", tenant: "dev", status: "ready", priority: 5 });
      store.block(highEarly.id, "user-feedback: x", "supervisor");

      vi.setSystemTime(1_700_000_020_000);
      const highLate = createTask({ title: "highLate", body: "", tenant: "dev", status: "ready", priority: 5 });
      store.block(highLate.id, "review-required: x", "supervisor");

      vi.setSystemTime(1_700_000_030_000);
      const zero = createTask({ title: "zero", body: "", tenant: "dev", status: "ready", priority: 0 });
      store.block(zero.id, "needs-manual: x", "supervisor");

      vi.setSystemTime(1_700_000_040_000);
      const question = createTask({ title: "question", body: "", tenant: "dev", status: "ready", priority: 0 });
      store.block(question.id, "worker-question: x", "supervisor");

      // 自律進行中（in-progress）は human_queue に含まれない
      const inProgressTask = createTask({ title: "wip", body: "", tenant: "dev", status: "ready" });
      store.block(inProgressTask.id, "codex-in-progress: x", "supervisor");

      view = createKanbanReadView(dbPath);
      const result = view.humanQueue();
      expect(result.map((t) => t.id)).toEqual([highEarly.id, highLate.id, low.id, zero.id, question.id]);
    });

    it("tenant で絞り込める", () => {
      const a = createTask({ title: "a", body: "", tenant: "dev", status: "ready" });
      store.block(a.id, "user-decision: x", "supervisor");
      const b = createTask({ title: "b", body: "", tenant: "other", status: "ready" });
      store.block(b.id, "user-decision: x", "supervisor");

      view = createKanbanReadView(dbPath);
      expect(view.humanQueue("dev").map((t) => t.id)).toEqual([a.id]);
    });
  });

  describe("inProgress", () => {
    it("2種の prefix を autonomous_in_progress として拾い、updated_at 降順で返す", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const first = createTask({ title: "first", body: "", tenant: "dev", status: "ready" });
      store.block(first.id, "codex-in-progress: x", "supervisor");

      vi.setSystemTime(1_700_000_010_000);
      const second = createTask({ title: "second", body: "", tenant: "dev", status: "ready" });
      store.block(second.id, "claude-in-progress: x", "supervisor");

      // human_queue は inProgress に含まれない
      const humanTask = createTask({ title: "human", body: "", tenant: "dev", status: "ready" });
      store.block(humanTask.id, "user-decision: x", "supervisor");

      view = createKanbanReadView(dbPath);
      const result = view.inProgress();
      expect(result.map((t) => t.id)).toEqual([second.id, first.id]);
    });

    it("tenant で絞り込める", () => {
      const a = createTask({ title: "a", body: "", tenant: "dev", status: "ready" });
      store.block(a.id, "codex-in-progress: x", "supervisor");
      const b = createTask({ title: "b", body: "", tenant: "other", status: "ready" });
      store.block(b.id, "codex-in-progress: x", "supervisor");

      view = createKanbanReadView(dbPath);
      expect(view.inProgress("dev").map((t) => t.id)).toEqual([a.id]);
    });
  });

  describe("byStatus", () => {
    it("priority 降順 → updated_at 降順で返し、limit を尊重する", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const a = createTask({ title: "a", body: "", tenant: "dev", status: "ready", priority: 1 });
      vi.setSystemTime(1_700_000_010_000);
      const b = createTask({ title: "b", body: "", tenant: "dev", status: "ready", priority: 5 });
      vi.setSystemTime(1_700_000_020_000);
      const c = createTask({ title: "c", body: "", tenant: "dev", status: "ready", priority: 5 });
      createTask({ title: "other-status", body: "", tenant: "dev", status: "todo" });

      view = createKanbanReadView(dbPath);
      expect(view.byStatus("ready").map((t) => t.id)).toEqual([c.id, b.id, a.id]);
      expect(view.byStatus("ready", undefined, 2).map((t) => t.id)).toEqual([c.id, b.id]);
    });

    it("tenant で絞り込める", () => {
      createTask({ title: "a", body: "", tenant: "dev", status: "ready" });
      const b = createTask({ title: "b", body: "", tenant: "other", status: "ready" });

      view = createKanbanReadView(dbPath);
      expect(view.byStatus("ready", "other").map((t) => t.id)).toEqual([b.id]);
    });
  });

  describe("bucketOf（docs/contract.md §14.4）", () => {
    it("status !== 'blocked' の場合は status をそのまま返す", () => {
      view = createKanbanReadView(dbPath);
      const statuses: TaskStatus[] = [
        "triage",
        "todo",
        "ready",
        "review",
        "needs-integration",
        "done",
        "archived",
      ];
      for (const status of statuses) {
        expect(view.bucketOf(fixtureTask({ status }))).toBe(status);
      }
    });

    it.each(["user-decision: x", "user-feedback: x", "review-required: x", "needs-manual: x", "worker-question: x"])(
      "blocked + %s は human_queue に分類する",
      (reason) => {
        view = createKanbanReadView(dbPath);
        expect(view.bucketOf(fixtureTask({ status: "blocked", blockReason: reason }))).toBe("human_queue");
      },
    );

    it.each(["codex-in-progress: x", "claude-in-progress: x"])(
      "blocked + %s は autonomous_in_progress に分類する",
      (reason) => {
        view = createKanbanReadView(dbPath);
        expect(view.bucketOf(fixtureTask({ status: "blocked", blockReason: reason }))).toBe(
          "autonomous_in_progress",
        );
      },
    );

    it("blocked + auto-launch-failed: は retry_pending に分類する", () => {
      view = createKanbanReadView(dbPath);
      expect(view.bucketOf(fixtureTask({ status: "blocked", blockReason: "auto-launch-failed: x" }))).toBe(
        "retry_pending",
      );
    });

    it("blocked + 未知の prefix は blocked_other に分類する", () => {
      view = createKanbanReadView(dbPath);
      expect(view.bucketOf(fixtureTask({ status: "blocked", blockReason: "totally-unknown: x" }))).toBe(
        "blocked_other",
      );
    });
  });

  describe("task", () => {
    it("存在する id は TaskRow を返す", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev" });
      view = createKanbanReadView(dbPath);
      expect(view.task(task.id)?.id).toBe(task.id);
    });

    it("存在しない id は null を返す", () => {
      view = createKanbanReadView(dbPath);
      expect(view.task("t_deadbeefdeadbeef")).toBeNull();
    });
  });

  describe("comments（KanbanStore.listComments と同セマンティクス）", () => {
    it("limit 省略時は全件を時系列順で返す", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev" });
      store.addComment(task.id, "codex", "1つ目");
      store.addComment(task.id, "claude", "2つ目");

      view = createKanbanReadView(dbPath);
      expect(view.comments(task.id).map((c) => c.body)).toEqual(["1つ目", "2つ目"]);
    });

    it("limit 指定時は新しい方から limit 件を時系列順で返す", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev" });
      for (const body of ["1", "2", "3", "4", "5"]) {
        store.addComment(task.id, "codex", body);
      }

      view = createKanbanReadView(dbPath);
      expect(view.comments(task.id, 2).map((c) => c.body)).toEqual(["4", "5"]);
    });
  });

  describe("events（KanbanStore.listEvents と同セマンティクス）", () => {
    it("limit 省略時は全件を時系列順で返す", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev" });
      // createTask 自体が task_created イベントを先頭に記録するため、custom_event はそれに続く
      store.addEvent(task.id, "custom_event", "tester", { seq: 1 });
      store.addEvent(task.id, "custom_event", "tester", { seq: 2 });

      view = createKanbanReadView(dbPath);
      const events = view.events(task.id);
      expect(events.map((e) => e.eventType)).toEqual(["task_created", "custom_event", "custom_event"]);
      const customEvents = events.filter((e) => e.eventType === "custom_event");
      expect(customEvents.map((e) => (JSON.parse(e.payload) as { seq: number }).seq)).toEqual([1, 2]);
    });

    it("limit 指定時は新しい方から limit 件を時系列順で返す", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev" });
      for (let seq = 1; seq <= 5; seq += 1) {
        store.addEvent(task.id, "custom_event", "tester", { seq });
      }

      view = createKanbanReadView(dbPath);
      const events = view.events(task.id, 2);
      expect(events.map((e) => (JSON.parse(e.payload) as { seq: number }).seq)).toEqual([4, 5]);
    });
  });

  describe("runs", () => {
    it("started_at 降順・id 降順で返す", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev" });
      const run1 = store.startRun(task.id, "codex", "sess-1", {});
      const run2 = store.startRun(task.id, "codex", "sess-2", {});

      view = createKanbanReadView(dbPath);
      expect(view.runs(task.id).map((r) => r.id)).toEqual([run2.id, run1.id]);
    });
  });

  describe("steerDeliveries（docs/contract.md §65.4）", () => {
    it("statusを昇格せずcurrent/stale run・session・fenceとredact済みerrorを返す", () => {
      const task = createTask({ title: "steer read", body: "cwd: /tmp", tenant: "dev", status: "ready" });
      const firstRun = store.startRun(task.id, "codex", "session-first", { transport: "bridge" });
      const accepted = store.createOrGetSteerDelivery({
        taskId: task.id,
        runId: firstRun.id,
        sessionId: firstRun.sessionId,
        messageKey: "steer-accepted",
        expectedCancelFence: 0,
        actor: "test",
      });
      store.claimSteerDispatch(accepted.id, firstRun.id, firstRun.sessionId, 0, "test");
      store.markSteerTransportAccepted(accepted.id, firstRun.id, firstRun.sessionId, 0, "test");
      store.endRun(firstRun.id, "released");

      const currentRun = store.startRun(task.id, "codex", "session-current", { transport: "bridge" });
      const sessionStale = store.createOrGetSteerDelivery({
        taskId: task.id,
        runId: currentRun.id,
        sessionId: currentRun.sessionId,
        messageKey: "steer-session-stale",
        expectedCancelFence: 0,
        actor: "test",
      });
      store.claimSteerDispatch(sessionStale.id, currentRun.id, currentRun.sessionId, 0, "test");
      store.markSteerTransportAccepted(sessionStale.id, currentRun.id, currentRun.sessionId, 0, "test");
      store.addEvent(task.id, "session_ended", "test", { sessionId: currentRun.sessionId });

      const raw = new Database(dbPath);
      raw.prepare(`UPDATE steer_deliveries SET last_error = ? WHERE id = ?`)
        .run("Authorization: Bearer raw-secret", sessionStale.id);
      raw.close();

      const steerView = createKanbanReadView(dbPath);
      view = steerView;
      const deliveries = steerView.steerDeliveries(task.id);

      expect(deliveries).toHaveLength(2);
      expect(deliveries[0]).toMatchObject({
        id: accepted.id,
        status: "transport_accepted",
        targetState: "stale_run",
        currentRunId: currentRun.id,
        currentSessionId: currentRun.sessionId,
        runCancelFence: 0,
      });
      expect(deliveries[1]).toMatchObject({
        id: sessionStale.id,
        status: "transport_accepted",
        targetState: "stale_session",
        lastError: "Authorization: Bearer [REDACTED]",
      });
      expect(deliveries[1]).not.toHaveProperty("applied");
    });

    it("cancel fenceが進んだcurrent runのaccepted deliveryをstale_cancel_fenceと表示する", () => {
      const task = createTask({ title: "steer fence", body: "cwd: /tmp", tenant: "dev", status: "ready" });
      const run = store.startRun(task.id, "codex", "session-fence", { transport: "bridge" });
      const delivery = store.createOrGetSteerDelivery({
        taskId: task.id,
        runId: run.id,
        sessionId: run.sessionId,
        messageKey: "steer-fence",
        expectedCancelFence: 0,
        actor: "test",
      });
      store.claimSteerDispatch(delivery.id, run.id, run.sessionId, 0, "test");
      store.createOrGetRunCancelRequest({
        taskId: task.id,
        runId: run.id,
        sessionId: run.sessionId,
        provider: "codex",
        requestNonce: "steer-read-fence",
        actor: "test",
        reason: "cancel",
        deadlineAt: 2_000_000_000,
      });
      store.markSteerTransportAccepted(delivery.id, run.id, run.sessionId, 0, "test");

      const steerView = createKanbanReadView(dbPath);
      view = steerView;
      expect(steerView.steerDeliveries(task.id)).toMatchObject([{
        id: delivery.id,
        status: "transport_accepted",
        targetState: "stale_cancel_fence",
        expectedCancelFence: 0,
        runCancelFence: 1,
      }]);
    });
  });

  describe("links", () => {
    it("parents は自分が child の行、children は自分が parent の行を返す", () => {
      const parent = createTask({ title: "parent", body: "", tenant: "dev" });
      const child = createTask({ title: "child", body: "", tenant: "dev" });
      const grandchild = createTask({ title: "grandchild", body: "", tenant: "dev" });
      store.link(parent.id, child.id);
      store.link(child.id, grandchild.id);

      view = createKanbanReadView(dbPath);
      const childLinks = view.links(child.id);
      expect(childLinks.parents.map((l) => l.parentId)).toEqual([parent.id]);
      expect(childLinks.children.map((l) => l.childId)).toEqual([grandchild.id]);

      const parentLinks = view.links(parent.id);
      expect(parentLinks.parents).toHaveLength(0);
      expect(parentLinks.children.map((l) => l.childId)).toEqual([child.id]);
    });
  });

  describe("readonly 性", () => {
    // KanbanReadView は better-sqlite3 の db ハンドルを一切外部に晒さない設計であり
    // （SqliteKanbanReadView は private フィールドとして保持し、インターフェース上に
    // 書き込みメソッドが存在しない）、view 経由での書き込みはそもそも型レベルでコンパイルできない。
    // 実行時の安全性は better-sqlite3 の `readonly: true` オプションが担保しており、
    // ここではその下位メカニズム（readonly 接続への書き込みが拒否されること）を検証する。
    it("readonly: true な接続への書き込みは SQLITE_READONLY で拒否される", () => {
      createTask({ title: "t", body: "", tenant: "dev" });
      const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        expect(() =>
          raw
            .prepare(`UPDATE tasks SET title = 'hacked' WHERE 1 = 1`)
            .run(),
        ).toThrow();
      } finally {
        raw.close();
      }
    });
  });

  describe("relayDeliveryUncertainEvent / relayDeliveryUncertainEvents（契約 §78.5.1）", () => {
    function recordInput(
      overrides: Partial<RelayDeliveryUncertainRecordInput> = {},
    ): RelayDeliveryUncertainRecordInput {
      return {
        sessionId: "session-a",
        handoverGeneration: 1,
        relayId: "relay-a",
        fencingToken: 1,
        eventId: "event-a",
        observedAt: 1_700_000_000,
        reason: "sending_remnant",
        provider: "codex",
        host: "host-a",
        evenTerminalBootEpoch: "boot-a",
        canonicalServerUrl: "http://127.0.0.1:3456",
        ...overrides,
      };
    }

    it("単件は (sessionId, eventId) の完全一致行、無ければ null を返す", () => {
      store.recordRelayDeliveryUncertain(recordInput());

      view = createKanbanReadView(dbPath);
      expect(view.relayDeliveryUncertainEvent("session-a", "event-a")).toMatchObject({ eventId: "event-a" });
      expect(view.relayDeliveryUncertainEvent("session-a", "no-such-event")).toBeNull();
    });

    it("一覧は recorded_at DESC, session_id COLLATE BINARY ASC, event_id COLLATE BINARY ASC で返す", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      store.recordRelayDeliveryUncertain(recordInput({ sessionId: "session-b", eventId: "event-1" }));
      store.recordRelayDeliveryUncertain(recordInput({ sessionId: "session-a", eventId: "event-2" }));

      vi.setSystemTime(1_700_000_010_000);
      store.recordRelayDeliveryUncertain(recordInput({ sessionId: "session-a", eventId: "event-1" }));

      view = createKanbanReadView(dbPath);
      const events = view.relayDeliveryUncertainEvents();
      expect(events.map((e) => [e.sessionId, e.eventId])).toEqual([
        ["session-a", "event-1"],
        ["session-a", "event-2"],
        ["session-b", "event-1"],
      ]);
    });

    it("sessionId 完全一致 filter を適用する", () => {
      store.recordRelayDeliveryUncertain(recordInput({ sessionId: "session-a", eventId: "event-1" }));
      store.recordRelayDeliveryUncertain(recordInput({ sessionId: "session-b", eventId: "event-1" }));

      view = createKanbanReadView(dbPath);
      const events = view.relayDeliveryUncertainEvents({ sessionId: "session-a" });
      expect(events.map((e) => e.sessionId)).toEqual(["session-a"]);
    });

    it("limit を適用する（既定値超えの指定は境界を尊重し、範囲外は throw する）", () => {
      store.recordRelayDeliveryUncertain(recordInput({ eventId: "event-1" }));
      store.recordRelayDeliveryUncertain(recordInput({ eventId: "event-2" }));
      store.recordRelayDeliveryUncertain(recordInput({ eventId: "event-3" }));

      view = createKanbanReadView(dbPath);
      const currentView = view;
      expect(currentView.relayDeliveryUncertainEvents({ limit: 2 })).toHaveLength(2);
      expect(() => currentView.relayDeliveryUncertainEvents({ limit: 0 })).toThrow();
      expect(() => currentView.relayDeliveryUncertainEvents({ limit: 1001 })).toThrow();
    });

    it("malformed 行があれば単件・一覧のどちらも隠さず throw する", () => {
      store.recordRelayDeliveryUncertain(recordInput());
      const raw = new Database(dbPath);
      try {
        // CHECK 制約は通るが（length > 0）、正規化済み canonical URL ではない値へ壊す。
        raw.prepare(`UPDATE relay_delivery_uncertain_events SET canonical_server_url = 'http://127.0.0.1:3456/'`).run();
      } finally {
        raw.close();
      }

      view = createKanbanReadView(dbPath);
      const currentView = view;
      expect(() => currentView.relayDeliveryUncertainEvent("session-a", "event-a")).toThrow();
      expect(() => currentView.relayDeliveryUncertainEvents()).toThrow();
    });
  });

  describe("human decision readonly API（契約 §80.4）", () => {
    function createOwner(suffix: string): { orchestratorId: string; provenance: {
      kind: "orchestrator";
      actorId: string;
      actorSessionId: string;
      actorGeneration: number;
    } } {
      const orchestrator = store.registerOrchestrator({
        label: `readview-human-${suffix}`,
        project: "hachi-kanban",
        repoCommonDir: `/repo/readview-${suffix}/.git`,
      });
      const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
      return {
        orchestratorId: orchestrator.id,
        provenance: {
          kind: "orchestrator",
          actorId: orchestrator.id,
          actorSessionId: session.id,
          actorGeneration: session.generation,
        },
      };
    }

    function createDecision(
      taskId: string,
      owner: ReturnType<typeof createOwner>,
      key: string,
      now: number,
    ): ReturnType<SqliteKanbanStore["createHumanDecisionRequest"]> {
      return store.createHumanDecisionRequest({
        taskId,
        kind: "decision",
        title: `decision-${key}`,
        question: "選択してください",
        idempotencyKey: key,
        choices: [{ id: "keep", label: "維持" }],
        provenance: owner.provenance,
        now,
      });
    }

    it("get/listは全件既定・createdAt/id順・status/task/tenant filterをLIMIT前に適用する", () => {
      const owner = createOwner("listing");
      const otherTenant = createTask({ title: "other", body: "", tenant: "other" });
      const dev = createTask({ title: "dev", body: "", tenant: "dev" });
      createDecision(otherTenant.id, owner, "other-1", 10);
      createDecision(otherTenant.id, owner, "other-2", 11);
      const devFirst = createDecision(dev.id, owner, "dev-1", 12);
      const devSecond = createDecision(dev.id, owner, "dev-2", 13);

      view = createKanbanReadView(dbPath);
      expect(view.getHumanDecisionRequest(devFirst.id)).toEqual(devFirst);
      expect(view.getHumanDecisionRequest("hd_0000000000000000")).toBeNull();
      expect(view.listHumanDecisionRequests().map((row) => row.id)).toHaveLength(4);
      expect(view.listHumanDecisionRequests({ tenant: "dev", limit: 1 }).map((row) => row.id)).toEqual([devFirst.id]);
      expect(view.listHumanDecisionRequests({ taskId: dev.id }).map((row) => row.id)).toEqual([
        devFirst.id,
        devSecond.id,
      ]);
      expect(view.listHumanDecisionRequests({ statuses: ["answered"] })).toEqual([]);
      expect(() => view!.listHumanDecisionRequests({ limit: 0 })).toThrow(/INVALID_INPUT/);
      expect(() => view!.listHumanDecisionRequests({ limit: 1001 })).toThrow(/INVALID_INPUT/);
    });

    it("responsesはowner分離しansweredAt/id順、answered/claimedだけを返しcredentialを出さない", () => {
      const owner = createOwner("responses-owner");
      const other = createOwner("responses-other");
      const task = createTask({ title: "t", body: "", tenant: "dev" });
      const later = createDecision(task.id, owner, "later", 10);
      const earlier = createDecision(task.id, owner, "earlier", 11);
      const otherRequest = createDecision(task.id, other, "other", 12);
      const localHuman = { kind: "human", actorId: "local", actorSessionId: "", actorGeneration: null } as const;
      store.answerHumanDecisionRequest({
        requestId: later.id,
        expectedRevision: 0,
        answerIdempotencyKey: "later-answer",
        answer: { kind: "decision", choiceId: "keep" },
        provenance: localHuman,
        now: 30,
      });
      store.answerHumanDecisionRequest({
        requestId: earlier.id,
        expectedRevision: 0,
        answerIdempotencyKey: "earlier-answer",
        answer: { kind: "decision", choiceId: "keep" },
        provenance: localHuman,
        now: 20,
      });
      store.answerHumanDecisionRequest({
        requestId: otherRequest.id,
        expectedRevision: 0,
        answerIdempotencyKey: "other-answer",
        answer: { kind: "decision", choiceId: "keep" },
        provenance: localHuman,
        now: 15,
      });
      store.claimHumanDecisionResponse({
        requestId: later.id,
        expectedRevision: 1,
        claimToken: "plain-secret",
        leaseUntil: 100,
        provenance: owner.provenance,
        now: 31,
      });

      view = createKanbanReadView(dbPath);
      const responses = view.listHumanDecisionResponses({ ownerOrchestratorId: owner.orchestratorId });
      expect(responses.map((row) => row.id)).toEqual([earlier.id, later.id]);
      expect(responses[1]).toMatchObject({ status: "claimed", claimLeaseUntil: 100 });
      expect(responses[1]).not.toHaveProperty("claimToken");
      expect(responses[1]).not.toHaveProperty("claimTokenHash");
      expect(view.listHumanDecisionResponses({ ownerOrchestratorId: other.orchestratorId, limit: 1 }))
        .toHaveLength(1);
    });

    it("v31 readonly viewは空queueを偽装せず、write/migrationせず、別Storeのv32適用後に同じviewで読める", () => {
      store.close();
      const raw = new Database(dbPath);
      try {
        raw.exec(`DROP TABLE human_decision_requests; DELETE FROM schema_migrations WHERE version = 32;`);
      } finally {
        raw.close();
      }
      view = createKanbanReadView(dbPath);
      expect(() => view!.listHumanDecisionRequests()).toThrow(/SCHEMA_UNAVAILABLE/);
      const before = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        expect(before.prepare(`SELECT 1 FROM schema_migrations WHERE version = 32`).get()).toBeUndefined();
        expect(before.prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'human_decision_requests'`,
        ).get()).toBeUndefined();
      } finally {
        before.close();
      }
      store = new SqliteKanbanStore(dbPath);
      expect(view.listHumanDecisionRequests()).toEqual([]);
    });
  });
});
