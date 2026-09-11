import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import { createKanbanReadView } from "./readview.js";
import type { ActorProvenance, EffortLevel, ScheduleRow, TaskRow } from "./types.js";
import type { RelayDeliveryUncertainRecordInput } from "./relay-control-persistence.js";

// PK 衝突リトライ（docs/contract.md §12.7-5）のテストのため node:crypto の randomBytes を差し替え可能にする。
// ESM のモジュール名前空間は spyOn で直接書き換えられないため vi.mock で包む
// （既定実装は実体の randomBytes に委譲するので、他のテストの id 採番挙動には影響しない）。
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

describe("SqliteKanbanStore", () => {
  let store: SqliteKanbanStore;

  beforeEach(() => {
    store = new SqliteKanbanStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  function createTask(overrides: Parameters<SqliteKanbanStore["createTask"]>[0] = { title: "t", body: "b", tenant: "dev" }): TaskRow {
    return store.createTask(overrides, "tester");
  }

  function createSchedule(
    overrides: Partial<Parameters<SqliteKanbanStore["createSchedule"]>[0]> = {},
  ): ScheduleRow {
    return store.createSchedule(
      {
        name: "朝の巡回",
        cadenceKind: "daily",
        atMinute: 30,
        atHour: 9,
        cwd: "/tmp/hk-scheduler",
        prompt: "今日の状態を確認してください",
        ...overrides,
      },
      "tester",
    );
  }

  function createOrchestratorProvenance(
    taskId?: string,
    label = "db-test-orchestrator",
  ): ActorProvenance {
    const orchestrator = store.registerOrchestrator({
      label,
      project: "hachi-kanban",
      repoCommonDir: `/repo/${label}.git`,
    });
    const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    const provenance: ActorProvenance = {
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    };
    if (taskId !== undefined) {
      store.bindTaskToOrchestrator(taskId, orchestrator.id, "primary");
    }
    return provenance;
  }

  it("session-budget questionId は kind=session_budget の request を作る", () => {
    const task = createTask();

    const request = store.createOrGetOrchestratorRequest({
      taskId: task.id,
      questionId: "session-budget:os_test:notice:continue:123",
      question: "session budget が変化しました",
      context: JSON.stringify({ action: "continue" }),
    });

    expect(request).toMatchObject({
      taskId: task.id,
      kind: "session_budget",
      context: JSON.stringify({ action: "continue" }),
    });
  });

  it("kind=session_budget の request は再配送を記録しても notification_outbox を作らない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const task = createTask({ title: "t", body: "cwd: /worktrees/session-budget", tenant: "dev" });

    const first = store.createOrGetOrchestratorRequest({
      taskId: task.id,
      questionId: "session-budget:os_test:urgent:handoff-now:124",
      question: "session budget が urgent へ変化しました",
      worktree: "/worktrees/session-budget",
    });
    const duplicate = store.createOrGetOrchestratorRequest({
      taskId: task.id,
      questionId: "session-budget:os_test:urgent:handoff-now:124",
      question: "同じ bucket の再試行です",
    });
    const orchestrator = store.registerOrchestrator({
      label: "session-budget-test",
      project: "dev",
      repoCommonDir: "",
    });
    store.addOrchestratorWatch({
      orchestratorId: orchestrator.id,
      scope: "worktree",
      selector: "/worktrees/session-budget",
      role: "primary",
    });
    vi.setSystemTime(1_700_000_001_000);
    const rerouted = store.reconcileOrchestratorRequestRouting(first.id);
    vi.useRealTimers();

    expect(duplicate.id).toBe(first.id);
    expect(rerouted).toEqual({
      requestId: first.id,
      addedDeliveries: 1,
      cancelled: false,
    });
    expect(store.getOrchestratorRequest(first.id)?.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(store.listEvents(task.id, "orchestrator_request_rerouted")).toHaveLength(1);
    expect(store.listPendingNotificationOutbox()).toEqual([]);
  });

  it("session usage profile と boot sample は key 単位で upsert し、規定順と null effort を往復する", () => {
    store.upsertSessionUsageProfile({
      provider: "codex",
      model: "gpt-z",
      effort: null,
      turns: 1,
      measured: false,
      cacheReadPerTurn: 1,
      cacheWrite5mPerTurn: 2,
      cacheWrite1hPerTurn: 3,
      outputPerTurn: 4,
      reasoningPerTurn: null,
      contextGrowthPerTurn: null,
      sourceSessionIds: ["provider-old"],
      computedFromRef: "old@v0",
      updatedAt: 10,
    });
    store.upsertSessionUsageProfile({
      provider: "claude",
      model: "claude-a",
      effort: "high",
      turns: 30,
      measured: true,
      cacheReadPerTurn: 10,
      cacheWrite5mPerTurn: 20,
      cacheWrite1hPerTurn: 30,
      outputPerTurn: 40,
      reasoningPerTurn: 5,
      contextGrowthPerTurn: 6,
      sourceSessionIds: ["provider-claude"],
      computedFromRef: "turnSeries@v1",
      updatedAt: 20,
    });
    store.upsertSessionUsageProfile({
      provider: "codex",
      model: "gpt-z",
      effort: null,
      turns: 31,
      measured: true,
      cacheReadPerTurn: 11,
      cacheWrite5mPerTurn: 12,
      cacheWrite1hPerTurn: 13,
      outputPerTurn: 14,
      reasoningPerTurn: 7,
      contextGrowthPerTurn: 8,
      sourceSessionIds: ["provider-new", "provider-old"],
      computedFromRef: "turnSeries@v1",
      updatedAt: 30,
    });

    expect(store.listSessionUsageProfiles()).toEqual([
      {
        provider: "claude",
        model: "claude-a",
        effort: "high",
        turns: 30,
        measured: true,
        cacheReadPerTurn: 10,
        cacheWrite5mPerTurn: 20,
        cacheWrite1hPerTurn: 30,
        outputPerTurn: 40,
        reasoningPerTurn: 5,
        contextGrowthPerTurn: 6,
        sourceSessionIds: ["provider-claude"],
        computedFromRef: "turnSeries@v1",
        updatedAt: 20,
      },
      {
        provider: "codex",
        model: "gpt-z",
        effort: null,
        turns: 31,
        measured: true,
        cacheReadPerTurn: 11,
        cacheWrite5mPerTurn: 12,
        cacheWrite1hPerTurn: 13,
        outputPerTurn: 14,
        reasoningPerTurn: 7,
        contextGrowthPerTurn: 8,
        sourceSessionIds: ["provider-new", "provider-old"],
        computedFromRef: "turnSeries@v1",
        updatedAt: 30,
      },
    ]);

    store.upsertSessionBootSample({
      orchestratorId: "o_test",
      sessionId: "os_a",
      providerSessionId: "provider-a-old",
      provider: "codex",
      model: null,
      contextAtTurn15: null,
      bootOverheadUsd: null,
      provenance: "old@v0;priceSource=unresolved",
      createdAt: 100,
      updatedAt: 100,
    });
    store.upsertSessionBootSample({
      orchestratorId: "o_test",
      sessionId: "os_b",
      providerSessionId: "provider-b",
      provider: "claude",
      model: "claude-a",
      contextAtTurn15: 15_000,
      bootOverheadUsd: 0.4,
      provenance: "turnSeries@v1;priceSource=table",
      createdAt: 200,
      updatedAt: 200,
    });
    store.upsertSessionBootSample({
      orchestratorId: "o_test",
      sessionId: "os_a",
      providerSessionId: "provider-a-new",
      provider: "codex",
      model: "gpt-z",
      contextAtTurn15: 14_000,
      bootOverheadUsd: 0.3,
      provenance: "turnSeries@v1;priceSource=table",
      createdAt: 999,
      updatedAt: 300,
    });

    expect(store.listSessionBootSamples({ orchestratorId: "o_test" })).toEqual([
      {
        orchestratorId: "o_test",
        sessionId: "os_b",
        providerSessionId: "provider-b",
        provider: "claude",
        model: "claude-a",
        contextAtTurn15: 15_000,
        bootOverheadUsd: 0.4,
        provenance: "turnSeries@v1;priceSource=table",
        createdAt: 200,
        updatedAt: 200,
      },
      {
        orchestratorId: "o_test",
        sessionId: "os_a",
        providerSessionId: "provider-a-new",
        provider: "codex",
        model: "gpt-z",
        contextAtTurn15: 14_000,
        bootOverheadUsd: 0.3,
        provenance: "turnSeries@v1;priceSource=table",
        createdAt: 100,
        updatedAt: 300,
      },
    ]);
  });

  describe("createTask / getTask", () => {
    it("t_ + 16 hex の id を採番し既定値で作成する（docs/contract.md §12.7-5）", () => {
      const task = createTask();
      expect(task.id).toMatch(/^t_[0-9a-f]{16}$/);
      expect(task.status).toBe("triage");
      expect(task.priority).toBe(0);
      expect(task.provider).toBe("");
      expect(task.profile).toBe("");
      expect(task.effortOverride).toBe("");
      expect(task.watched).toBe(false);
      expect(task.createdAt).toBeGreaterThan(0);
      expect(task.updatedAt).toBe(task.createdAt);
      expect(task.startedAt).toBeNull();
      expect(task.completedAt).toBeNull();
    });

    it("status/priority/profile/provider を明示指定できる", () => {
      const task = createTask({
        title: "custom",
        body: "b",
        tenant: "dev",
        status: "ready",
        priority: 3,
        profile: "implement",
        provider: "codex",
      });
      expect(task.status).toBe("ready");
      expect(task.priority).toBe(3);
      expect(task.profile).toBe("implement");
      expect(task.provider).toBe("codex");
    });

    it("task_created イベントを記録する", () => {
      const task = createTask();
      const events = store.listEvents(task.id);
      expect(events.some((e) => e.eventType === "task_created")).toBe(true);
    });

    it.each(["focused", "full", "test", "skip", "all", "default", "auto"])(
      "verify: %s は INSERT 前に拒否する",
      (reservedWord) => {
        expect(() =>
          createTask({ title: "予約語", body: `cwd: /tmp\nverify: ${reservedWord}`, tenant: "dev" }),
        ).toThrow(new RegExp(`verify:.*予約語.*${reservedWord}`));
      },
    );

    it("verify 予約語は trim・case-insensitive の完全一致で拒否する", () => {
      expect(() =>
        createTask({ title: "予約語", body: "cwd: /tmp\nverify:   FoCuSeD   ", tenant: "dev" }),
      ).toThrow(/verify:.*予約語.*focused/);
    });

    it.each(["test -e file", "pnpm test", "none", "./focused", "command focused", "make", "just"])(
      "verify: %s は正当なコマンドまたは none として許可する",
      (verifyDirective) => {
        const task = createTask({
          title: "許可値",
          body: `cwd: /tmp\nverify: ${verifyDirective}`,
          tenant: "dev",
        });
        expect(task.body).toContain(`verify: ${verifyDirective}`);
      },
    );

    it("getTask は存在しない id で null を返す", () => {
      expect(store.getTask("t_deadbeef")).toBeNull();
    });

    it("id が PK 衝突した場合は再生成してリトライし成功する（docs/contract.md §12.7-5）", () => {
      const fixed = Buffer.from("0102030405060708", "hex");
      const distinct = Buffer.from("a1a2a3a4a5a6a7a8", "hex");
      const mocked = vi.mocked(randomBytes);
      // 1回目: 通常作成。2回目: 同じ id を返して衝突を発生させる。3回目: 別の id で成功させる
      mocked.mockImplementationOnce(() => fixed as unknown as Buffer);
      mocked.mockImplementationOnce(() => fixed as unknown as Buffer);
      mocked.mockImplementationOnce(() => distinct as unknown as Buffer);

      const first = createTask({ title: "first", body: "", tenant: "dev" });
      expect(first.id).toBe("t_0102030405060708");

      const second = createTask({ title: "second", body: "", tenant: "dev" });
      expect(second.id).toBe("t_a1a2a3a4a5a6a7a8");
      expect(second.id).not.toBe(first.id);
    });

    it("初期 status に blocked を指定すると throw する（fail-closed, docs/contract.md §12.8-5）", () => {
      expect(() =>
        createTask({ title: "t", body: "", tenant: "dev", status: "blocked" }),
      ).toThrow(/triage \/ todo \/ ready のみ/);
    });

    it("初期 status に done を指定すると throw する（fail-closed, docs/contract.md §12.8-5）", () => {
      expect(() => createTask({ title: "t", body: "", tenant: "dev", status: "done" })).toThrow(
        /triage \/ todo \/ ready のみ/,
      );
    });

    it("初期 status に review / needs-integration / archived を指定すると throw する（fail-closed, docs/contract.md §12.8-5）", () => {
      expect(() => createTask({ title: "t", body: "", tenant: "dev", status: "review" })).toThrow();
      expect(() =>
        createTask({ title: "t", body: "", tenant: "dev", status: "needs-integration" }),
      ).toThrow();
      expect(() => createTask({ title: "t", body: "", tenant: "dev", status: "archived" })).toThrow();
    });

    it("PK 衝突がリトライ上限を超えた場合は throw する（fail-closed, docs/contract.md §12.7-5）", () => {
      const fixed = Buffer.from("1122334455667788", "hex");
      const mocked = vi.mocked(randomBytes);
      // 1回目: first の作成用。以降6回: second の初回試行 + 5回のリトライすべてが衝突する
      // （mockImplementationOnce のキューが尽きた後は既定実装＝実体の randomBytes に戻るため、
      // 他のテストへ状態が漏れない）
      for (let i = 0; i < 7; i += 1) {
        mocked.mockImplementationOnce(() => fixed as unknown as Buffer);
      }

      createTask({ title: "first", body: "", tenant: "dev" });
      expect(() => createTask({ title: "second", body: "", tenant: "dev" })).toThrow(/PK 衝突/);
    });
  });

  describe("listByStatus / listInProgress", () => {
    it("status で絞り込み priority 降順で返す", () => {
      const low = createTask({ title: "low", body: "", tenant: "dev", status: "ready", priority: 1 });
      const high = createTask({ title: "high", body: "", tenant: "dev", status: "ready", priority: 9 });
      createTask({ title: "other", body: "", tenant: "dev", status: "todo" });

      const readyTasks = store.listByStatus("ready");
      expect(readyTasks.map((t) => t.id)).toEqual([high.id, low.id]);
    });

    it("listInProgress は blocked かつ in-progress prefix のみ返す", () => {
      const target = createTask({ title: "wip", body: "", tenant: "dev", status: "ready" });
      store.block(target.id, "codex-in-progress: 実装中", "supervisor");

      const other = createTask({ title: "waiting", body: "", tenant: "dev", status: "ready" });
      store.block(other.id, "user-decision: 判断待ち", "supervisor");

      const inProgress = store.listInProgress();
      expect(inProgress.map((t) => t.id)).toEqual([target.id]);
    });
  });

  describe("transition", () => {
    it("許可された遷移を実行し task_events を記録する", () => {
      const task = createTask();
      const updated = store.transition({ taskId: task.id, to: "todo", actor: "tester" });
      expect(updated.status).toBe("todo");
      expect(updated.updatedAt).toBeGreaterThanOrEqual(task.updatedAt);

      const events = store.listEvents(task.id, "status_changed");
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload) as { from: string; to: string };
      expect(payload).toMatchObject({ from: "triage", to: "todo" });
    });

    it("不正な遷移は throw する（fail-closed）", () => {
      const task = createTask();
      expect(() => store.transition({ taskId: task.id, to: "done", actor: "tester" })).toThrow(/不正な状態遷移/);
    });

    it("blocked への遷移は reason が必須", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      expect(() => store.transition({ taskId: task.id, to: "blocked", actor: "tester" })).toThrow(
        /block_reason が必須/,
      );
    });

    it("blocked への遷移は known prefix のみ許可（fail-closed）", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      expect(() =>
        store.transition({ taskId: task.id, to: "blocked", actor: "tester", reason: "unknown-prefix: x" }),
      ).toThrow(/未知の block_reason prefix/);
    });

    it("in-progress reason で blocked に入る初回に started_at を設定する", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      expect(task.startedAt).toBeNull();

      const blocked = store.transition({
        taskId: task.id,
        to: "blocked",
        actor: "tester",
        reason: "codex-in-progress: 実装中",
      });
      expect(blocked.startedAt).not.toBeNull();

      // review へ移した後、再度 blocked に戻っても started_at は上書きされない
      const reviewed = store.transition({ taskId: task.id, to: "review", actor: "tester" });
      const rebocked = store.transition({
        taskId: task.id,
        to: "blocked",
        actor: "tester",
        reason: "codex-in-progress: 再実装中",
      });
      expect(rebocked.startedAt).toBe(blocked.startedAt);
      expect(reviewed.status).toBe("review");
    });

    it("done への遷移で completed_at を設定する", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.transition({ taskId: task.id, to: "blocked", actor: "tester", reason: "codex-in-progress: x" });
      const done = store.transition({ taskId: task.id, to: "done", actor: "tester" });
      expect(done.completedAt).not.toBeNull();
    });

    it("blocked から抜けると block_reason がクリアされる", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.transition({ taskId: task.id, to: "blocked", actor: "tester", reason: "user-decision: wait" });
      const back = store.transition({ taskId: task.id, to: "ready", actor: "tester" });
      expect(back.blockReason).toBe("");
    });

    it("既存行の予約語は ready 遷移前に拒否する", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "hachi-verify-ready-"));
      const dbPath = join(tempDir, "kanban.db");
      let legacyStore: SqliteKanbanStore | null = new SqliteKanbanStore(dbPath);
      try {
        const task = legacyStore.createTask(
          { title: "既存行", body: "cwd: /tmp", tenant: "dev", status: "todo" },
          "tester",
        );
        legacyStore.close();
        legacyStore = null;

        const raw = new Database(dbPath);
        try {
          raw.prepare(`UPDATE tasks SET body = ? WHERE id = ?`).run("cwd: /tmp\nverify: test", task.id);
        } finally {
          raw.close();
        }

        legacyStore = new SqliteKanbanStore(dbPath);
        expect(() =>
          legacyStore?.transition({ taskId: task.id, to: "ready", actor: "tester" }),
        ).toThrow(/verify:.*予約語.*test/);
        expect(legacyStore.getTask(task.id)?.status).toBe("todo");
      } finally {
        legacyStore?.close();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("ready からの遷移が成立すると claim_lock がクリアされる（docs/contract.md §12.7-1）", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      const claimed = store.claimTask(task.id, "token-abc", "supervisor");
      expect(claimed).toBe(true);
      expect(store.getTask(task.id)?.claimLock).toBe("token-abc");

      const updated = store.transition({
        taskId: task.id,
        to: "blocked",
        actor: "tester",
        reason: "codex-in-progress: 実装中",
      });
      expect(updated.claimLock).toBe("");
    });

    it("ready 以外からの遷移では claim_lock を変更しない", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.transition({ taskId: task.id, to: "blocked", actor: "tester", reason: "user-decision: wait" });
      // blocked -> review は from='ready' ではないため claim_lock はそのまま（既に空）
      const reviewed = store.transition({ taskId: task.id, to: "review", actor: "tester" });
      expect(reviewed.claimLock).toBe("");
    });
  });

  describe("block / unblock", () => {
    it("block は status を blocked にし block_reason と assignee を設定する", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      const blocked = store.block(task.id, "user-decision: 承認待ち", "supervisor", "human-ryo");
      expect(blocked.status).toBe("blocked");
      expect(blocked.blockReason).toBe("user-decision: 承認待ち");
      expect(blocked.assignee).toBe("human-ryo");
    });

    it("block は不正な状態遷移では throw する", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "triage" });
      expect(() => store.block(task.id, "user-decision: x", "supervisor")).toThrow(/不正な状態遷移/);
    });

    it("block は known prefix 以外では throw する（fail-closed）", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      expect(() => store.block(task.id, "totally-unknown: x", "supervisor")).toThrow(/未知の block_reason prefix/);
    });

    it("unblock は block_reason をクリアし指定 status へ戻す", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.block(task.id, "review-required: 確認待ち", "supervisor");
      const unblocked = store.unblock(task.id, "review", "supervisor");
      expect(unblocked.status).toBe("review");
      expect(unblocked.blockReason).toBe("");
    });

    it("unblock は blocked 以外の状態では throw する", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      expect(() => store.unblock(task.id, "todo", "supervisor")).toThrow(/blocked 状態のタスクにのみ/);
    });
  });

  describe("blockIfReadyUnclaimed（docs/contract.md §12.17-1）", () => {
    it("status='ready' かつ claim_lock='' の場合は blocked へ CAS 遷移し true を返す", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      const result = store.blockIfReadyUnclaimed(
        task.id,
        "needs-manual: 孤児セッション",
        "supervisor",
        "human",
      );
      expect(result).toBe(true);

      const updated = store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("needs-manual: 孤児セッション");
      expect(updated?.assignee).toBe("human");
      expect(updated?.claimLock).toBe("");

      const events = store.listEvents(task.id, "status_changed");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        from: "ready",
        to: "blocked",
        reason: "needs-manual: 孤児セッション",
      });
    });

    it("CAS 不成立（claim_lock が既に設定済み）の場合は false を返し状態を変更しない", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.claimTask(task.id, "other-token", "other-supervisor");

      const result = store.blockIfReadyUnclaimed(task.id, "needs-manual: 孤児セッション", "supervisor");
      expect(result).toBe(false);

      const updated = store.getTask(task.id);
      expect(updated?.status).toBe("ready");
      expect(updated?.blockReason).toBe("");
      expect(updated?.claimLock).toBe("other-token");
      expect(store.listEvents(task.id, "status_changed")).toHaveLength(0);
    });

    it("CAS 不成立（status が ready 以外）の場合は false を返し状態を変更しない", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.block(task.id, "user-decision: 先に別遷移", "supervisor");

      const result = store.blockIfReadyUnclaimed(task.id, "needs-manual: 孤児セッション", "supervisor");
      expect(result).toBe(false);

      const updated = store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("user-decision: 先に別遷移");
    });

    it("known prefix 以外の reason では throw する（fail-closed）", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      expect(() => store.blockIfReadyUnclaimed(task.id, "totally-unknown: x", "supervisor")).toThrow(
        /未知の block_reason prefix/,
      );
      expect(store.getTask(task.id)?.status).toBe("ready");
    });
  });

  describe("blockClaimedTask（docs/contract.md §12.19-2）", () => {
    it("status='ready' かつ claim_lock=claimToken の場合は blocked へ CAS 遷移し true を返す", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      const claimed = store.claimTask(task.id, "token-abc", "supervisor");
      expect(claimed).toBe(true);

      const result = store.blockClaimedTask(
        task.id,
        "token-abc",
        "user-decision: モデル解決に失敗",
        "supervisor",
        "human",
      );
      expect(result).toBe(true);

      const updated = store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("user-decision: モデル解決に失敗");
      expect(updated?.assignee).toBe("human");
      expect(updated?.claimLock).toBe("");

      const events = store.listEvents(task.id, "status_changed");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        from: "ready",
        to: "blocked",
        reason: "user-decision: モデル解決に失敗",
      });
    });

    it("CAS 不成立（claim_lock が異なるトークン）の場合は false を返し状態を変更しない", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.claimTask(task.id, "other-token", "other-supervisor");

      const result = store.blockClaimedTask(task.id, "stale-token", "user-decision: x", "supervisor");
      expect(result).toBe(false);

      const updated = store.getTask(task.id);
      expect(updated?.status).toBe("ready");
      expect(updated?.blockReason).toBe("");
      expect(updated?.claimLock).toBe("other-token");
      expect(store.listEvents(task.id, "status_changed")).toHaveLength(0);
    });

    it("CAS 不成立（status が ready 以外）の場合は false を返し状態を変更しない", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.claimTask(task.id, "token-abc", "supervisor");
      // claim 保持中に別 writer が先に遷移させた状況を再現する（ready からの遷移で claim_lock はクリアされる）
      store.block(task.id, "user-decision: 先に別遷移", "other-writer");

      const result = store.blockClaimedTask(task.id, "token-abc", "user-decision: x", "supervisor");
      expect(result).toBe(false);

      const updated = store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("user-decision: 先に別遷移");
    });

    it("claim_lock='' な未 claim タスクへの呼び出しは false を返す（claimToken='' の悪用を防ぐ）", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      const result = store.blockClaimedTask(task.id, "", "user-decision: x", "supervisor");
      expect(result).toBe(false);
      expect(store.getTask(task.id)?.status).toBe("ready");
    });

    it("known prefix 以外の reason では throw する（fail-closed）", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.claimTask(task.id, "token-abc", "supervisor");
      expect(() => store.blockClaimedTask(task.id, "token-abc", "totally-unknown: x", "supervisor")).toThrow(
        /未知の block_reason prefix/,
      );
      expect(store.getTask(task.id)?.status).toBe("ready");
    });
  });

  describe("comments", () => {
    it("追加した順で listComments が返る", () => {
      const task = createTask();
      store.addComment(task.id, "codex", "1つ目");
      store.addComment(task.id, "claude", "2つ目");

      const comments = store.listComments(task.id);
      expect(comments.map((c) => c.body)).toEqual(["1つ目", "2つ目"]);
    });

    it("limit を指定できる", () => {
      const task = createTask();
      store.addComment(task.id, "codex", "1");
      store.addComment(task.id, "codex", "2");
      store.addComment(task.id, "codex", "3");

      expect(store.listComments(task.id, 2)).toHaveLength(2);
    });

    it("limit 指定時は新しい方から N 件を時系列順で返す（直近 N 件, docs/contract.md §12.9-5）", () => {
      const task = createTask();
      store.addComment(task.id, "codex", "1");
      store.addComment(task.id, "codex", "2");
      store.addComment(task.id, "codex", "3");
      store.addComment(task.id, "codex", "4");
      store.addComment(task.id, "codex", "5");

      const comments = store.listComments(task.id, 2);
      expect(comments.map((c) => c.body)).toEqual(["4", "5"]);
    });
  });

  describe("events", () => {
    it("eventType でフィルタできる", () => {
      const task = createTask();
      store.addEvent(task.id, "custom_event", "tester", { foo: "bar" });

      const events = store.listEvents(task.id, "custom_event");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toEqual({ foo: "bar" });
    });

    it("limit 指定時は新しい方から N 件を時系列順で返す（直近 N 件, docs/contract.md §12.9-5）", () => {
      const task = createTask();
      store.addEvent(task.id, "custom_event", "tester", { seq: 1 });
      store.addEvent(task.id, "custom_event", "tester", { seq: 2 });
      store.addEvent(task.id, "custom_event", "tester", { seq: 3 });
      store.addEvent(task.id, "custom_event", "tester", { seq: 4 });
      store.addEvent(task.id, "custom_event", "tester", { seq: 5 });

      const events = store.listEvents(task.id, "custom_event", 2);
      expect(events.map((e) => (JSON.parse(e.payload) as { seq: number }).seq)).toEqual([4, 5]);
    });
  });

  describe("hasProcessedMessage / markMessageProcessed", () => {
    it("未処理の idempotencyKey は false を返す", () => {
      const task = createTask();
      expect(store.hasProcessedMessage(`${task.id}-idem-1`)).toBe(false);
    });

    it("markMessageProcessed 後は hasProcessedMessage が true になる（冪等性照合）", () => {
      const task = createTask();
      const key = `${task.id}-idem-2`;
      expect(store.hasProcessedMessage(key)).toBe(false);

      store.markMessageProcessed(task.id, key, "supervisor");

      expect(store.hasProcessedMessage(key)).toBe(true);
    });

    it("同一 key の重複記録があっても hasProcessedMessage は true のまま", () => {
      const task = createTask();
      const key = `${task.id}-idem-3`;
      store.markMessageProcessed(task.id, key, "supervisor");
      store.markMessageProcessed(task.id, key, "supervisor");
      expect(store.hasProcessedMessage(key)).toBe(true);
    });

    it("同一 key の二重 mark は例外にならず、1回目は true・2回目は false（既処理・no-op）を返す（docs/contract.md §12.9-1）", () => {
      const task = createTask();
      const key = `${task.id}-idem-4`;

      const first = store.markMessageProcessed(task.id, key, "supervisor");
      let second: boolean | undefined;
      expect(() => {
        second = store.markMessageProcessed(task.id, key, "supervisor");
      }).not.toThrow();

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(store.hasProcessedMessage(key)).toBe(true);
    });
  });

  describe("task_runs", () => {
    it("startRun / endRun / listOpenRuns", () => {
      const task = createTask();
      const run = store.startRun(task.id, "codex", "sess-1", { model: "gpt-5.4" });
      expect(run.status).toBe("running");
      expect(store.listOpenRuns().map((r) => r.id)).toContain(run.id);

      store.endRun(run.id, "done", { result: "ok" });
      expect(store.listOpenRuns().map((r) => r.id)).not.toContain(run.id);
    });
  });

  describe("getLatestOpenRun（docs/contract.md §12.7-6）", () => {
    it("open run が無ければ null を返す", () => {
      const task = createTask();
      expect(store.getLatestOpenRun(task.id)).toBeNull();
    });

    it("open run が1件なら それを返す", () => {
      const task = createTask();
      const run = store.startRun(task.id, "codex", "sess-1", { model: "gpt-5.4" });
      const latest = store.getLatestOpenRun(task.id);
      expect(latest?.id).toBe(run.id);
      expect(latest?.sessionId).toBe("sess-1");
    });

    it("複数 open run がある場合は started_at 最新（同着なら id 最大）の run を返す", () => {
      const task = createTask();
      store.startRun(task.id, "codex", "sess-old", { model: "gpt-5.4" });
      const newer = store.startRun(task.id, "claude", "sess-new", { model: "claude-sonnet-5" });

      const latest = store.getLatestOpenRun(task.id);
      expect(latest?.id).toBe(newer.id);
      expect(latest?.sessionId).toBe("sess-new");
    });

    it("status='running' 以外の run（他タスク含む）は対象外", () => {
      const task = createTask();
      const other = createTask({ title: "other", body: "", tenant: "dev" });
      const run = store.startRun(task.id, "codex", "sess-1", {});
      store.endRun(run.id, "done");
      store.startRun(other.id, "codex", "sess-other", {});

      expect(store.getLatestOpenRun(task.id)).toBeNull();
    });
  });

  describe("getOpenRunByTaskSession（docs/contract.md §12.17-4）", () => {
    it("taskId と sessionId が一致する running run を返す", () => {
      const task = createTask();
      const run = store.startRun(task.id, "codex", "sess-1", { model: "gpt-5.4" });

      const found = store.getOpenRunByTaskSession(task.id, "sess-1");
      expect(found?.id).toBe(run.id);
      expect(found?.sessionId).toBe("sess-1");
    });

    it("sessionId が一致しない場合は null を返す", () => {
      const task = createTask();
      store.startRun(task.id, "codex", "sess-1", {});

      expect(store.getOpenRunByTaskSession(task.id, "sess-other")).toBeNull();
    });

    it("同一 taskId でも別セッションの run は返さない（旧セッションの run を新セッションへ誤適用しない）", () => {
      const task = createTask();
      const oldRun = store.startRun(task.id, "codex", "sess-old", {});
      store.endRun(oldRun.id, "failed");
      const newRun = store.startRun(task.id, "codex", "sess-new", {});

      expect(store.getOpenRunByTaskSession(task.id, "sess-old")).toBeNull();
      expect(store.getOpenRunByTaskSession(task.id, "sess-new")?.id).toBe(newRun.id);
    });

    it("status='running' 以外（既に close 済み）の run は対象外", () => {
      const task = createTask();
      const run = store.startRun(task.id, "codex", "sess-1", {});
      store.endRun(run.id, "done");

      expect(store.getOpenRunByTaskSession(task.id, "sess-1")).toBeNull();
    });

    it("他タスクの同名 sessionId は対象外", () => {
      const task = createTask();
      const other = createTask({ title: "other", body: "", tenant: "dev" });
      store.startRun(other.id, "codex", "sess-shared", {});

      expect(store.getOpenRunByTaskSession(task.id, "sess-shared")).toBeNull();
    });
  });

  describe("claimTask / releaseClaim（docs/contract.md §12.7-1）", () => {
    it("ready タスクを claim できる（成功時 task_claimed イベントを記録）", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      const claimed = store.claimTask(task.id, "token-1", "supervisor");
      expect(claimed).toBe(true);
      expect(store.getTask(task.id)?.claimLock).toBe("token-1");

      const events = store.listEvents(task.id, "task_claimed");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({ claimToken: "token-1" });
    });

    it("並行 CAS: 同一タスクに2つの token で claimTask すると片方だけ true になる", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      const first = store.claimTask(task.id, "token-a", "supervisor");
      const second = store.claimTask(task.id, "token-b", "supervisor");

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(store.getTask(task.id)?.claimLock).toBe("token-a");
    });

    it("status が ready 以外のタスクは claim できない", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "triage" });
      expect(store.claimTask(task.id, "token-1", "supervisor")).toBe(false);
      expect(store.getTask(task.id)?.claimLock).toBe("");
    });

    it("releaseClaim は一致する token のみ解放できる（成功時 claim_released イベントを記録）", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.claimTask(task.id, "token-1", "supervisor");

      const released = store.releaseClaim(task.id, "token-1", "supervisor");
      expect(released).toBe(true);
      expect(store.getTask(task.id)?.claimLock).toBe("");

      const events = store.listEvents(task.id, "claim_released");
      expect(events).toHaveLength(1);
    });

    it("releaseClaim は一致しない token では失敗しロックを維持する", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.claimTask(task.id, "token-1", "supervisor");

      const released = store.releaseClaim(task.id, "token-wrong", "supervisor");
      expect(released).toBe(false);
      expect(store.getTask(task.id)?.claimLock).toBe("token-1");
    });

    it("releaseClaim 後は別 token で再 claim できる", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.claimTask(task.id, "token-1", "supervisor");
      store.releaseClaim(task.id, "token-1", "supervisor");

      expect(store.claimTask(task.id, "token-2", "supervisor")).toBe(true);
      expect(store.getTask(task.id)?.claimLock).toBe("token-2");
    });
  });

  describe("clearStaleClaims（docs/contract.md §12.8-2）", () => {
    it("olderThanSec より古い ready + claim_lock 付きの行を解放し件数を返す", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.claimTask(task.id, "stale-token", "supervisor");

      // claim 直後の updated_at はほぼ現在時刻なので、十分未来の now を渡して
      // 「olderThanSec=0 でも stale」とみなされる状態を作る（実時間の待機なしで検証する）
      const farFutureNow = Math.floor(Date.now() / 1000) + 10_000;
      const cleared = store.clearStaleClaims(0, farFutureNow, "supervisor");
      expect(cleared).toBe(1);
      expect(store.getTask(task.id)?.claimLock).toBe("");

      const events = store.listEvents(task.id, "stale_claim_cleared");
      expect(events).toHaveLength(1);
    });

    it("olderThanSec 以内の claim は解放しない", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.claimTask(task.id, "fresh-token", "supervisor");

      const now = Math.floor(Date.now() / 1000);
      const cleared = store.clearStaleClaims(600, now, "supervisor");

      expect(cleared).toBe(0);
      expect(store.getTask(task.id)?.claimLock).toBe("fresh-token");
      expect(store.listEvents(task.id, "stale_claim_cleared")).toHaveLength(0);
    });

    it("claim されていない ready 行は対象外", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      const farFutureNow = Math.floor(Date.now() / 1000) + 10_000;

      const cleared = store.clearStaleClaims(0, farFutureNow, "supervisor");
      expect(cleared).toBe(0);
      expect(store.getTask(task.id)?.claimLock).toBe("");
    });

    it("実際にクリアした行数と stale_claim_cleared イベント記録数が一致する（docs/contract.md §12.15-4）", () => {
      // 候補選定（SELECT）後に UPDATE 側の述語（id ごとの再確認）で実際にクリアできた行のみ
      // イベントを記録することを、複数行を対象に「返り値の件数」と「実際に記録されたイベントの総数」の
      // 一致で検証する（Tx 内で完結するため、条件が崩れる race を直接再現することはできない）。
      const staleTaskA = createTask({ title: "a", body: "", tenant: "dev", status: "ready" });
      const staleTaskB = createTask({ title: "b", body: "", tenant: "dev", status: "ready" });
      store.claimTask(staleTaskA.id, "stale-token-a", "supervisor");
      store.claimTask(staleTaskB.id, "stale-token-b", "supervisor");

      const farFutureNow = Math.floor(Date.now() / 1000) + 10_000;
      const cleared = store.clearStaleClaims(0, farFutureNow, "supervisor");

      expect(cleared).toBe(2);
      expect(store.getTask(staleTaskA.id)?.claimLock).toBe("");
      expect(store.getTask(staleTaskB.id)?.claimLock).toBe("");

      const totalEvents =
        store.listEvents(staleTaskA.id, "stale_claim_cleared").length +
        store.listEvents(staleTaskB.id, "stale_claim_cleared").length;
      expect(totalEvents).toBe(cleared);
    });
  });

  describe("task_links", () => {
    it("link / listLinks で親子関係を張る", () => {
      const parent = createTask({ title: "parent", body: "", tenant: "dev" });
      const child = createTask({ title: "child", body: "", tenant: "dev" });

      store.link(parent.id, child.id);

      const parentLinks = store.listLinks(parent.id);
      expect(parentLinks).toHaveLength(1);
      expect(parentLinks[0]!.childId).toBe(child.id);
      expect(parentLinks[0]!.linkType).toBe("subtask");

      const childLinks = store.listLinks(child.id);
      expect(childLinks).toHaveLength(1);
      expect(childLinks[0]!.parentId).toBe(parent.id);
    });

    it("同一 (parent,child,linkType) の重複は無視される（UNIQUE制約）", () => {
      const parent = createTask({ title: "parent", body: "", tenant: "dev" });
      const child = createTask({ title: "child", body: "", tenant: "dev" });
      store.link(parent.id, child.id);
      store.link(parent.id, child.id);

      expect(store.listLinks(parent.id)).toHaveLength(1);
    });

    it("dependencies は depends-on の前提タスクだけを TaskRow で返す", () => {
      const prerequisite = createTask({ title: "prerequisite", body: "", tenant: "dev" });
      const subtaskParent = createTask({ title: "subtask-parent", body: "", tenant: "dev" });
      const child = createTask({ title: "child", body: "", tenant: "dev" });

      store.link(prerequisite.id, child.id, "depends-on");
      store.link(subtaskParent.id, child.id);

      const dependencies = store.dependencies(child.id);
      expect(dependencies).toHaveLength(1);
      expect(dependencies[0]!.id).toBe(prerequisite.id);
      expect(dependencies[0]!.title).toBe("prerequisite");
    });

    it("depends-on の循環を拒否する", () => {
      const a = createTask({ title: "a", body: "", tenant: "dev" });
      const b = createTask({ title: "b", body: "", tenant: "dev" });

      store.link(a.id, b.id, "depends-on");

      expect(() => store.link(b.id, a.id, "depends-on")).toThrow(/循環/);
      expect(store.listLinks(a.id)).toHaveLength(1);
      expect(store.dependencies(a.id)).toHaveLength(0);
    });

    it("depends-on の自己依存を拒否する", () => {
      const task = createTask({ title: "self", body: "", tenant: "dev" });

      expect(() => store.link(task.id, task.id, "depends-on")).toThrow(/自己依存/);
      expect(store.listLinks(task.id)).toHaveLength(0);
    });

    it("subtask は循環チェックしない", () => {
      const a = createTask({ title: "a", body: "", tenant: "dev" });
      const b = createTask({ title: "b", body: "", tenant: "dev" });

      expect(() => {
        store.link(a.id, b.id, "subtask");
        store.link(b.id, a.id, "subtask");
      }).not.toThrow();

      const links = store.listLinks(a.id);
      expect(links).toHaveLength(2);
      expect(links.every((link) => link.linkType === "subtask")).toBe(true);
    });

    it("未充足判定に使う status を dependencies から確認できる", () => {
      const done = createTask({ title: "done", body: "", tenant: "dev", status: "ready" });
      const archived = createTask({ title: "archived", body: "", tenant: "dev" });
      const ready = createTask({ title: "ready", body: "", tenant: "dev", status: "ready" });
      const dependent = createTask({ title: "dependent", body: "", tenant: "dev" });

      store.block(done.id, "codex-in-progress: テスト", "tester");
      store.transition({ taskId: done.id, to: "done", actor: "tester" });
      store.transition({ taskId: archived.id, to: "archived", actor: "tester" });
      store.link(done.id, dependent.id, "depends-on");
      store.link(archived.id, dependent.id, "depends-on");
      store.link(ready.id, dependent.id, "depends-on");

      const statusesById = new Map(store.dependencies(dependent.id).map((task) => [task.id, task.status]));
      expect(statusesById.get(done.id)).toBe("done");
      expect(statusesById.get(archived.id)).toBe("archived");
      expect(statusesById.get(ready.id)).toBe("ready");

      const unmetDependencyIds = store
        .dependencies(dependent.id)
        .filter((task) => task.status !== "done" && task.status !== "archived")
        .map((task) => task.id);
      expect(unmetDependencyIds).toEqual([ready.id]);
    });
  });

  describe("schedules", () => {
    it("createSchedule は s_ + 16 hex の id を採番し既定値で作成する", () => {
      const schedule = createSchedule();

      expect(schedule.id).toMatch(/^s_[0-9a-f]{16}$/);
      expect(schedule.enabled).toBe(true);
      expect(schedule.cadenceKind).toBe("daily");
      expect(schedule.weekday).toBeNull();
      expect(schedule.dayOfMonth).toBeNull();
      expect(schedule.runDate).toBeNull();
      expect(schedule.tenant).toBe("");
      expect(schedule.profile).toBe("");
      expect(schedule.priority).toBe(0);
      expect(schedule.lastRunAt).toBeNull();
      expect(schedule.lastTaskId).toBeNull();
      expect(schedule.consecutiveFailures).toBe(0);
      expect(schedule.autoDisabledReason).toBe("");
      expect(schedule.createdAt).toBeGreaterThan(0);
      expect(schedule.updatedAt).toBe(schedule.createdAt);
    });

    it("listSchedules / getSchedule は作成順で schedule を返す", () => {
      const first = createSchedule({ name: "first" });
      const second = createSchedule({ name: "second", atHour: 10 });

      expect(store.listSchedules().map((schedule) => schedule.id)).toEqual([first.id, second.id]);
      expect(store.getSchedule(first.id)?.name).toBe("first");
      expect(store.getSchedule("s_deadbeefdeadbeef")).toBeNull();
    });

    it("weekly / monthly / once の必須フィールドを保持し、不要フィールドを null に正規化する", () => {
      const weekly = createSchedule({ cadenceKind: "weekly", weekday: 1, dayOfMonth: 20, runDate: "2026-07-04" });
      expect(weekly.weekday).toBe(1);
      expect(weekly.dayOfMonth).toBeNull();
      expect(weekly.runDate).toBeNull();

      const monthly = createSchedule({ cadenceKind: "monthly", weekday: 2, dayOfMonth: 31 });
      expect(monthly.weekday).toBeNull();
      expect(monthly.dayOfMonth).toBe(31);
      expect(monthly.runDate).toBeNull();

      const once = createSchedule({ cadenceKind: "once", weekday: 3, dayOfMonth: 10, runDate: "2026-07-04" });
      expect(once.weekday).toBeNull();
      expect(once.dayOfMonth).toBeNull();
      expect(once.runDate).toBe("2026-07-04");
    });

    it("updateSchedule は cadence 変更を再検証し、不要フィールドを null に正規化する", () => {
      const schedule = createSchedule({ cadenceKind: "weekly", weekday: 5, tenant: "dev", profile: "implement" });

      const updated = store.updateSchedule(
        schedule.id,
        { cadenceKind: "monthly", dayOfMonth: 31, name: "月末処理", atHour: 22, atMinute: 15, priority: 7 },
        "tester",
      );

      expect(updated.name).toBe("月末処理");
      expect(updated.cadenceKind).toBe("monthly");
      expect(updated.weekday).toBeNull();
      expect(updated.dayOfMonth).toBe(31);
      expect(updated.runDate).toBeNull();
      expect(updated.tenant).toBe("dev");
      expect(updated.profile).toBe("implement");
      expect(updated.atHour).toBe(22);
      expect(updated.atMinute).toBe(15);
      expect(updated.priority).toBe(7);
      expect(updated.updatedAt).toBeGreaterThanOrEqual(schedule.updatedAt);
    });

    it("setScheduleEnabled は enabled と autoDisabledReason を更新し、再有効化時に理由をクリアする", () => {
      const schedule = createSchedule();

      const disabled = store.setScheduleEnabled(schedule.id, false, "scheduler", "3 consecutive failures");
      expect(disabled.enabled).toBe(false);
      expect(disabled.autoDisabledReason).toBe("3 consecutive failures");

      const enabled = store.setScheduleEnabled(schedule.id, true, "human");
      expect(enabled.enabled).toBe(true);
      expect(enabled.autoDisabledReason).toBe("");
    });

    it("markScheduleFired / setScheduleFailures は実行結果列を更新する", () => {
      const schedule = createSchedule();
      const task = createTask({ title: "scheduled", body: "", tenant: "dev" });

      store.markScheduleFired(schedule.id, task.id, 1_800_000_000, "scheduler");
      store.setScheduleFailures(schedule.id, 2, "scheduler");

      const updated = store.getSchedule(schedule.id);
      expect(updated?.lastRunAt).toBe(1_800_000_000);
      expect(updated?.lastTaskId).toBe(task.id);
      expect(updated?.consecutiveFailures).toBe(2);
    });

    it("markScheduleFired は同じ発火時刻の二重 claim を拒否する", () => {
      const schedule = createSchedule();
      const firstTask = createTask({ title: "scheduled first", body: "", tenant: "dev" });
      const secondTask = createTask({ title: "scheduled second", body: "", tenant: "dev" });

      store.markScheduleFired(schedule.id, firstTask.id, 1_800_000_000, "scheduler");

      expect(() => store.markScheduleFired(schedule.id, secondTask.id, 1_800_000_000, "scheduler")).toThrow(
        /既に claim 済み/,
      );
      const updated = store.getSchedule(schedule.id);
      expect(updated?.lastRunAt).toBe(1_800_000_000);
      expect(updated?.lastTaskId).toBe(firstTask.id);
    });

    it("deleteSchedule は schedule を削除し、存在しない id は throw する", () => {
      const schedule = createSchedule();
      store.deleteSchedule(schedule.id, "tester");

      expect(store.getSchedule(schedule.id)).toBeNull();
      expect(() => store.deleteSchedule(schedule.id, "tester")).toThrow(/スケジュールが見つかりません/);
    });

    it("cwd は絶対パス必須で、時刻範囲も fail-closed で検証する", () => {
      expect(() => createSchedule({ cwd: "relative/path" })).toThrow(/cwd は絶対パス/);
      expect(() => createSchedule({ atHour: 24 })).toThrow(/atHour/);
      expect(() => createSchedule({ atMinute: 60 })).toThrow(/atMinute/);
    });

    it("cadence ごとの必須フィールド欠落は fail-closed で拒否する", () => {
      expect(() => createSchedule({ cadenceKind: "weekly" })).toThrow(/weekday/);
      expect(() => createSchedule({ cadenceKind: "monthly" })).toThrow(/dayOfMonth/);
      expect(() => createSchedule({ cadenceKind: "once" })).toThrow(/runDate/);
      expect(() => createSchedule({ cadenceKind: "once", runDate: "2026-02-31" })).toThrow(/runDate/);
    });

    it("updateSchedule の検証失敗時は既存 schedule を変更しない", () => {
      const schedule = createSchedule({ cadenceKind: "weekly", weekday: 2 });

      expect(() => store.updateSchedule(schedule.id, { cadenceKind: "monthly" }, "tester")).toThrow(/dayOfMonth/);

      const unchanged = store.getSchedule(schedule.id);
      expect(unchanged?.cadenceKind).toBe("weekly");
      expect(unchanged?.weekday).toBe(2);
    });

    it("markScheduleFired は存在しない taskId や負の firedAt を拒否する", () => {
      const schedule = createSchedule();
      expect(() => store.markScheduleFired(schedule.id, "t_deadbeefdeadbeef", 1_800_000_000, "scheduler")).toThrow(
        /タスクが見つかりません/,
      );
      expect(() => store.markScheduleFired(schedule.id, createTask().id, -1, "scheduler")).toThrow(/firedAt/);
    });

    it("setScheduleFailures は負の値を拒否する", () => {
      const schedule = createSchedule();
      expect(() => store.setScheduleFailures(schedule.id, -1, "scheduler")).toThrow(/consecutiveFailures/);
    });
  });

  describe("setModelOverride", () => {
    it("charset に合致する値を設定できる", () => {
      const task = createTask();
      const provenance = createOrchestratorProvenance(task.id);
      const updated = store.setModelOverride(task.id, "gpt-5.4", "tester", provenance);
      expect(updated.modelOverride).toBe("gpt-5.4");
    });

    it("空文字は常にクリアとして許可される", () => {
      const task = createTask();
      const provenance = createOrchestratorProvenance(task.id);
      store.setModelOverride(task.id, "gpt-5.4", "tester", provenance);
      const cleared = store.setModelOverride(task.id, "", "tester", provenance);
      expect(cleared.modelOverride).toBe("");
    });

    it("charset 不正な値は throw する（fail-closed）", () => {
      const task = createTask();
      expect(() => store.setModelOverride(task.id, "gpt 5.4!", "tester")).toThrow(/charset が不正/);
    });

    it("compound APIと同じexecution_overrides_changed監査を変更時だけ記録する", () => {
      const task = createTask();
      const provenance = createOrchestratorProvenance(task.id);
      store.setModelOverride(task.id, "gpt-5.5", "tester", provenance);
      store.setModelOverride(task.id, "gpt-5.5", "tester", provenance);
      const events = store.listEvents(task.id, "execution_overrides_changed");
      expect(events).toHaveLength(1);
      expect(events[0]?.actor).toBe("tester");
      expect(JSON.parse(events[0]?.payload ?? "{}")).toEqual({
        role: "worker",
        changes: {
          model: { field: "model_override", previous: "", value: "gpt-5.5" },
        },
      });
      expect(events[0]?.provenance).toEqual(provenance);
      expect(store.listEvents(task.id, "override_changed")).toHaveLength(0);
    });
  });

  describe("setEffortOverride", () => {
    it("EffortLevel の値を設定・クリアできる", () => {
      const task = createTask();
      const provenance = createOrchestratorProvenance(task.id);
      const updated = store.setEffortOverride(task.id, "high", "tester", provenance);
      expect(updated.effortOverride).toBe("high");

      const cleared = store.setEffortOverride(task.id, "", "tester", provenance);
      expect(cleared.effortOverride).toBe("");
    });

    it("不正な値は throw する（fail-closed）", () => {
      const task = createTask();
      expect(() => store.setEffortOverride(task.id, "ultra" as EffortLevel, "tester")).toThrow(/effort override/);
      expect(store.getTask(task.id)?.effortOverride).toBe("");
    });

    it("compound APIと同じexecution_overrides_changed監査を変更時だけ記録する", () => {
      const task = createTask();
      const provenance = createOrchestratorProvenance(task.id);
      store.setEffortOverride(task.id, "medium", "tester", provenance);
      store.setEffortOverride(task.id, "medium", "tester", provenance);

      const events = store.listEvents(task.id, "execution_overrides_changed");
      expect(events).toHaveLength(1);
      expect(events[0]?.actor).toBe("tester");
      expect(JSON.parse(events[0]?.payload ?? "{}")).toEqual({
        role: "worker",
        changes: {
          effort: { field: "effort_override", previous: "", value: "medium" },
        },
      });
      expect(events[0]?.provenance).toEqual(provenance);
      expect(store.listEvents(task.id, "override_changed")).toHaveLength(0);
    });

    it("legacy model/effort APIもexact orchestratorとrun/claim gateを迂回できない", () => {
      const unauthorized = createTask();
      expect(() => store.setModelOverride(unauthorized.id, "gpt-5.6-sol", "tester"))
        .toThrow(/active exact orchestrator provenance/);
      expect(() => store.setEffortOverride(unauthorized.id, "max", "service", {
        kind: "service",
        actorId: "supervisor",
        actorSessionId: "",
        actorGeneration: null,
      })).toThrow(/active exact orchestrator provenance/);

      const provenance = createOrchestratorProvenance();
      const claimed = createTask({ title: "claimed", body: "", tenant: "dev", status: "ready" });
      store.bindTaskToOrchestrator(claimed.id, provenance.actorId, "primary");
      expect(store.claimTask(claimed.id, "override-claim", "supervisor")).toBe(true);
      expect(() => store.setModelOverride(claimed.id, "gpt-5.6-sol", "tester", provenance))
        .toThrow(/launch claim中/);
      expect(store.getTask(claimed.id)?.modelOverride).toBe("");

      const running = createTask({ title: "running", body: "", tenant: "dev", status: "ready" });
      store.bindTaskToOrchestrator(running.id, provenance.actorId, "primary");
      store.startRun(running.id, "codex", "legacy-override-running", { role: "worker" });
      expect(() => store.setEffortOverride(running.id, "max", "tester", provenance))
        .toThrow(/実行開始済み/);
      expect(store.getTask(running.id)?.effortOverride).toBe("");
    });
  });

  describe("setExecutionOverrides", () => {
    it("worker/reviewerを独立にcompound更新しmax/fastを保存する", () => {
      const task = createTask();
      const provenance = createOrchestratorProvenance(task.id);
      const worker = store.setExecutionOverrides(task.id, "worker", {
        profile: "implement",
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "max",
        speed: "fast",
      }, "tester", provenance);
      expect(worker).toMatchObject({
        profile: "implement",
        provider: "codex",
        modelOverride: "gpt-5.6-sol",
        effortOverride: "max",
        speedOverride: "fast",
      });

      const reviewer = store.setExecutionOverrides(task.id, "reviewer", {
        profile: "review",
        provider: "claude",
        model: "claude-opus-5",
        effort: "max",
        speed: "standard",
      }, "tester", provenance);
      expect(reviewer).toMatchObject({
        reviewProfileOverride: "review",
        reviewProviderOverride: "claude",
        reviewModelOverride: "claude-opus-5",
        reviewEffortOverride: "max",
        reviewSpeedOverride: "standard",
        modelOverride: "gpt-5.6-sol",
      });
      const events = store.listEvents(task.id, "execution_overrides_changed");
      expect(events).toHaveLength(2);
      expect(JSON.parse(events[1]!.payload)).toMatchObject({
        role: "reviewer",
        changes: {
          effort: { field: "review_effort_override", previous: "", value: "max" },
          speed: { field: "review_speed_override", previous: "", value: "standard" },
        },
      });
    });

    it("不正patchは一部fieldも保存せず、no-opは監査eventを増やさない", () => {
      const task = createTask();
      const provenance = createOrchestratorProvenance(task.id);
      expect(() => store.setExecutionOverrides(task.id, "reviewer", {
        model: "claude-opus-5",
        speed: "turbo" as "fast",
      }, "tester", provenance)).toThrow(/speed override/);
      expect(store.getTask(task.id)).toMatchObject({ reviewModelOverride: "", reviewSpeedOverride: "" });

      store.setExecutionOverrides(task.id, "worker", { speed: "fast" }, "tester", provenance);
      store.setExecutionOverrides(task.id, "worker", { speed: "fast" }, "tester", provenance);
      expect(store.listEvents(task.id, "execution_overrides_changed")).toHaveLength(1);
    });

    it("open run中の変更を拒否して中間設定を観測させない", () => {
      const task = createTask();
      const provenance = createOrchestratorProvenance(task.id);
      store.startRun(task.id, "codex", "running-override", { role: "worker" });
      expect(() => store.setExecutionOverrides(task.id, "worker", {
        model: "gpt-5.6-terra",
        effort: "high",
      }, "tester", provenance)).toThrow(/実行開始済み/);
      expect(store.getTask(task.id)).toMatchObject({ modelOverride: "", effortOverride: "" });
    });

    it("unknown/service provenanceによるcompound overrideを拒否する", () => {
      const task = createTask();
      expect(() => store.setExecutionOverrides(task.id, "worker", { speed: "fast" }, "tester"))
        .toThrow(/active exact orchestrator provenance/);
      expect(() => store.setExecutionOverrides(task.id, "reviewer", { effort: "high" }, "service", {
        kind: "service",
        actorId: "supervisor",
        actorSessionId: "",
        actorGeneration: null,
      })).toThrow(/active exact orchestrator provenance/);
    });

    it("active sessionでも別primary ownerの既存taskは変更できない", () => {
      const task = createTask();
      createOrchestratorProvenance(task.id);
      const other = createOrchestratorProvenance(undefined, "db-test-other-orchestrator");

      expect(() => store.setExecutionOverrides(
        task.id,
        "worker",
        { model: "gpt-5.6-sol", effort: "max", speed: "fast" },
        "other-orchestrator",
        other,
      )).toThrow(/primary orchestrator authority/);
      expect(store.getTask(task.id)).toMatchObject({
        modelOverride: "",
        effortOverride: "",
        speedOverride: "",
      });
      expect(store.listEvents(task.id, "execution_overrides_changed")).toHaveLength(0);
    });
  });

  describe("setWatched", () => {
    it("watched を true/false に切り替え、変更時だけ監査イベントを記録する", () => {
      const task = createTask();

      const watched = store.setWatched(task.id, true, "human");
      expect(watched.watched).toBe(true);
      expect(watched.updatedAt).toBeGreaterThanOrEqual(task.updatedAt);
      expect(store.listEvents(task.id, "watch_set")).toHaveLength(1);

      const watchedAgain = store.setWatched(task.id, true, "human");
      expect(watchedAgain.watched).toBe(true);
      expect(store.listEvents(task.id, "watch_set")).toHaveLength(1);

      const cleared = store.setWatched(task.id, false, "human");
      expect(cleared.watched).toBe(false);
      expect(store.listEvents(task.id, "watch_cleared")).toHaveLength(1);

      const clearedAgain = store.setWatched(task.id, false, "human");
      expect(clearedAgain.watched).toBe(false);
      expect(store.listEvents(task.id, "watch_cleared")).toHaveLength(1);
    });

    it("watch_set / watch_cleared イベントに actor と payload を記録する", () => {
      const task = createTask();
      store.setWatched(task.id, true, "agent");
      store.setWatched(task.id, false, "human");

      const setEvent = store.listEvents(task.id, "watch_set")[0];
      const clearEvent = store.listEvents(task.id, "watch_cleared")[0];
      expect(setEvent?.actor).toBe("agent");
      expect(JSON.parse(setEvent?.payload ?? "{}")).toEqual({ previous: false, watched: true });
      expect(clearEvent?.actor).toBe("human");
      expect(JSON.parse(clearEvent?.payload ?? "{}")).toEqual({ previous: true, watched: false });
    });

    it("存在しない taskId は throw し、イベントを作らない", () => {
      expect(() => store.setWatched("t_notfound", true, "human")).toThrow(/タスクが見つかりません/);
    });
  });

  describe("updateBlockReason", () => {
    it("blocked タスクの block_reason を状態遷移なしで更新する", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.block(task.id, "codex-in-progress: 実装中 even-session=sess-1", "supervisor");

      const updated = store.updateBlockReason(
        task.id,
        "needs-manual: handoff 欠落 (session=sess-1)",
        "supervisor",
        "human",
      );

      expect(updated.status).toBe("blocked");
      expect(updated.blockReason).toBe("needs-manual: handoff 欠落 (session=sess-1)");
      expect(updated.assignee).toBe("human");
    });

    it("assignee 省略時は既存の assignee を保持する", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.block(task.id, "codex-in-progress: 実装中", "supervisor", "codex-worker");

      const updated = store.updateBlockReason(task.id, "needs-manual: 手動確認が必要です", "supervisor");

      expect(updated.assignee).toBe("codex-worker");
    });

    it("blocked 以外の状態では throw する（fail-closed）", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      expect(() => store.updateBlockReason(task.id, "needs-manual: x", "supervisor")).toThrow(
        /blocked 状態のタスクにのみ/,
      );
    });

    it("未知の prefix は throw する（fail-closed）", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.block(task.id, "codex-in-progress: 実装中", "supervisor");
      expect(() => store.updateBlockReason(task.id, "totally-unknown: x", "supervisor")).toThrow(
        /未知の block_reason prefix/,
      );
    });

    it("block_reason_updated イベントを記録する", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.block(task.id, "codex-in-progress: 実装中", "supervisor");
      store.updateBlockReason(task.id, "needs-manual: 手動確認が必要です", "supervisor", "human");

      const events = store.listEvents(task.id, "block_reason_updated");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        reason: "needs-manual: 手動確認が必要です",
        assignee: "human",
      });
    });

    it("reason 付替後は listInProgress から外れる（resource guard 枠の解放）", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });
      store.block(task.id, "codex-in-progress: 実装中", "supervisor");
      expect(store.listInProgress().map((t) => t.id)).toContain(task.id);

      store.updateBlockReason(task.id, "needs-manual: handoff 欠落", "supervisor", "human");

      expect(store.listInProgress().map((t) => t.id)).not.toContain(task.id);
    });
  });

  describe("updateBody", () => {
    it("body を全置換し body_updated イベントを記録する（本文はイベントに含めない）", () => {
      const task = createTask({ title: "t", body: "旧本文", tenant: "dev" });
      const updated = store.updateBody(task.id, "cwd: /abs/path\n\n新本文", "tester");

      expect(updated.body).toBe("cwd: /abs/path\n\n新本文");

      const events = store.listEvents(task.id, "body_updated");
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
      expect(payload["bodyLength"]).toBe("cwd: /abs/path\n\n新本文".length);
      expect(JSON.stringify(payload)).not.toContain("新本文");
    });

    it("存在しないタスクは throw する（fail-closed）", () => {
      expect(() => store.updateBody("t_notfound", "本文", "tester")).toThrow(/タスクが見つかりません/);
    });

    it.each(["test", "focused"])("verify: %s は UPDATE 前に拒否する", (reservedWord) => {
      const task = createTask({ title: "t", body: "変更前", tenant: "dev" });

      expect(() =>
        store.updateBody(task.id, `cwd: /tmp\nverify: ${reservedWord}\n秘密の本文`, "tester"),
      ).toThrow(new RegExp(`verify:.*予約語.*${reservedWord}`));
      expect(store.getTask(task.id)?.body).toBe("変更前");
      expect(store.listEvents(task.id, "body_updated")).toHaveLength(0);
    });
  });

  describe("listMessageFenceComments", () => {
    it("afterId より大きい id かつ agent-message-v1 を含むコメントのみ id 昇順で返す", () => {
      const task = createTask();
      store.addComment(task.id, "worker", "ただの雑談コメント");
      const withFence1 = store.addComment(task.id, "worker", "前置き\n```agent-message-v1\n{}\n```\n後書き");
      store.addComment(task.id, "worker", "もう一つの雑談");
      const withFence2 = store.addComment(task.id, "worker", "```agent-message-v1\n{}\n```");

      const result = store.listMessageFenceComments(0);
      expect(result.map((c) => c.id)).toEqual([withFence1.id, withFence2.id]);
    });

    it("afterId 以下のコメントは含めない（増分走査）", () => {
      const task = createTask();
      const first = store.addComment(task.id, "worker", "```agent-message-v1\n{}\n```");
      const second = store.addComment(task.id, "worker", "```agent-message-v1\n{}\n```");

      const result = store.listMessageFenceComments(first.id);
      expect(result.map((c) => c.id)).toEqual([second.id]);
    });

    it("limit を指定できる（既定は200）", () => {
      const task = createTask();
      for (let i = 0; i < 3; i += 1) {
        store.addComment(task.id, "worker", "```agent-message-v1\n{}\n```");
      }

      expect(store.listMessageFenceComments(0, 2)).toHaveLength(2);
    });
  });

  describe("listRecent（docs/contract.md §12.12-4）", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("updated_at 降順で返す", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const oldest = createTask({ title: "oldest", body: "", tenant: "dev" });
      vi.setSystemTime(1_700_000_010_000);
      const middle = createTask({ title: "middle", body: "", tenant: "dev" });
      vi.setSystemTime(1_700_000_020_000);
      const newest = createTask({ title: "newest", body: "", tenant: "dev" });

      const result = store.listRecent(10);
      expect(result.map((t) => t.id)).toEqual([newest.id, middle.id, oldest.id]);
    });

    it("limit で件数を絞る", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      createTask({ title: "a", body: "", tenant: "dev" });
      vi.setSystemTime(1_700_000_010_000);
      const b = createTask({ title: "b", body: "", tenant: "dev" });
      vi.setSystemTime(1_700_000_020_000);
      const c = createTask({ title: "c", body: "", tenant: "dev" });

      const result = store.listRecent(2);
      expect(result.map((t) => t.id)).toEqual([c.id, b.id]);
    });

    it("status を問わず全状態横断で返す", () => {
      const triageTask = createTask({ title: "t", body: "", tenant: "dev", status: "triage" });
      const readyTask = createTask({ title: "r", body: "", tenant: "dev", status: "ready" });
      store.block(readyTask.id, "user-decision: 判断待ち", "tester");

      const result = store.listRecent(10).map((t) => t.id);
      expect(result).toContain(triageTask.id);
      expect(result).toContain(readyTask.id);
    });

    it("タスク更新（block 等）で updated_at が進むと順位が繰り上がる", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const a = createTask({ title: "a", body: "", tenant: "dev", status: "ready" });
      vi.setSystemTime(1_700_000_010_000);
      const b = createTask({ title: "b", body: "", tenant: "dev", status: "ready" });

      // a を b より後で更新すると a が最新になる
      vi.setSystemTime(1_700_000_020_000);
      store.block(a.id, "user-decision: 判断待ち", "tester");

      const result = store.listRecent(10);
      expect(result.map((t) => t.id)).toEqual([a.id, b.id]);
    });
  });

  describe("transaction", () => {
    it("fn 内の複数操作が原子的に commit される", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });

      const result = store.transaction(() => {
        store.addComment(task.id, "tester", "tx内コメント1");
        store.addComment(task.id, "tester", "tx内コメント2");
        store.markMessageProcessed(task.id, "tx-idem-1", "tester");
        return "done";
      });

      expect(result).toBe("done");
      expect(store.listComments(task.id).map((c) => c.body)).toEqual(["tx内コメント1", "tx内コメント2"]);
      expect(store.hasProcessedMessage("tx-idem-1")).toBe(true);
    });

    it("fn が throw した場合は全操作が rollback される", () => {
      const task = createTask({ title: "t", body: "", tenant: "dev", status: "ready" });

      expect(() =>
        store.transaction(() => {
          store.addComment(task.id, "tester", "rollbackされるはずのコメント");
          store.markMessageProcessed(task.id, "tx-idem-2", "tester");
          throw new Error("意図的な失敗");
        }),
      ).toThrow(/意図的な失敗/);

      expect(store.listComments(task.id)).toHaveLength(0);
      expect(store.hasProcessedMessage("tx-idem-2")).toBe(false);
    });
  });

  describe("lessons（docs/contract.md §44.1/§44.2）", () => {
    it("recordLesson は lesson_recorded イベントを残し、listRecentLessons は同 tenant の cwd prefix を優先して直近3件を返す", () => {
      const target = createTask({ title: "target", body: "cwd: /repo/app\n作業", tenant: "dev", status: "ready" });
      const genericOld = createTask({ title: "old", body: "cwd: /elsewhere", tenant: "dev" });
      const prefix = createTask({ title: "prefix", body: "cwd: /repo/app/pkg", tenant: "dev" });
      const genericNew = createTask({ title: "new", body: "cwd: /other", tenant: "dev" });
      const genericNewest = createTask({ title: "newest", body: "cwd: /another", tenant: "dev" });
      const otherTenant = createTask({ title: "other tenant", body: "cwd: /repo/app", tenant: "prod" });

      store.recordLesson(
        {
          trigger: "rework",
          tenant: "dev",
          cwd: "/elsewhere",
          profile: "implement",
          body: "generic-old",
          sourceTaskId: genericOld.id,
        },
        "supervisor",
      );
      const prefixLesson = store.recordLesson(
        {
          trigger: "rework",
          tenant: "dev",
          cwd: "/repo/app/pkg",
          profile: "implement",
          body: "prefix-match",
          sourceTaskId: prefix.id,
        },
        "supervisor",
      );
      store.recordLesson(
        {
          trigger: "user-decision",
          tenant: "dev",
          cwd: "/other",
          profile: "plan",
          body: "generic-new",
          sourceTaskId: genericNew.id,
        },
        "supervisor",
      );
      store.recordLesson(
        {
          trigger: "needs-manual",
          tenant: "dev",
          cwd: "/another",
          profile: "docs",
          body: "generic-newest",
          sourceTaskId: genericNewest.id,
        },
        "supervisor",
      );
      store.recordLesson(
        {
          trigger: "rework",
          tenant: "prod",
          cwd: "/repo/app",
          profile: "implement",
          body: "other-tenant",
          sourceTaskId: otherTenant.id,
        },
        "supervisor",
      );

      const lessons = store.listRecentLessons(target.tenant, "/repo/app", 3);
      expect(lessons.map((lesson) => lesson.body)).toEqual(["prefix-match", "generic-newest", "generic-new"]);
      expect(lessons.every((lesson) => lesson.tenant === "dev")).toBe(true);

      const events = store.listEvents(prefix.id, "lesson_recorded");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({ lessonId: prefixLesson.id, trigger: "rework" });
    });

    it("user-decision block の解除時に原因要約を redaction 済み lesson として機械記録する", () => {
      const task = createTask({
        title: "human decision",
        body: "cwd: /repo/app\n確認が必要",
        tenant: "dev",
        status: "ready",
        profile: "implement",
      });
      store.block(task.id, "user-decision: 方針を確認してください sk-liveSECRET1234", "supervisor", "human");

      store.unblock(task.id, "ready", "human");

      const lessons = store.listRecentLessons("dev", "/repo/app", 3);
      expect(lessons).toHaveLength(1);
      expect(lessons[0]).toMatchObject({
        trigger: "user-decision",
        tenant: "dev",
        cwd: "/repo/app",
        profile: "implement",
        sourceTaskId: task.id,
      });
      expect(lessons[0]?.body).toContain("方針を確認してください");
      expect(lessons[0]?.body).toContain("[REDACTED]");
      expect(lessons[0]?.body).not.toContain("sk-liveSECRET1234");
      expect(lessons[0]?.body).toContain("解除先: ready");
      expect(store.listEvents(task.id, "lesson_recorded")).toHaveLength(1);
    });
  });

  describe("counts", () => {
    it("全 status を 0 埋めで返す", () => {
      const counts = store.counts();
      expect(counts).toEqual({
        triage: 0,
        todo: 0,
        ready: 0,
        blocked: 0,
        review: 0,
        "needs-integration": 0,
        done: 0,
        archived: 0,
      });
    });

    it("作成済みタスクの status ごとに件数を返す", () => {
      createTask({ title: "a", body: "", tenant: "dev", status: "triage" });
      createTask({ title: "b", body: "", tenant: "dev", status: "triage" });
      createTask({ title: "c", body: "", tenant: "dev", status: "ready" });

      const counts = store.counts();
      expect(counts.triage).toBe(2);
      expect(counts.ready).toBe(1);
      expect(counts.done).toBe(0);
    });
  });

  describe("knowledge", () => {
    it("addKnowledge は k_ + 12 hex を採番し本文 hash を保存する", () => {
      const row = store.addKnowledge(
        {
          title: "handover",
          body: "session note",
          source: "session-handover",
          tags: ["handover", "session"],
          importance: 80,
          originPath: "/tmp/session.md",
          createdAt: 1_700_000_000,
        },
        "tester",
      );

      expect(row.id).toMatch(/^k_[0-9a-f]{12}$/);
      expect(row.title).toBe("handover");
      expect(row.tags).toEqual(["handover", "session"]);
      expect(row.importance).toBe(80);
      expect(row.originPath).toBe("/tmp/session.md");
      expect(row.actor).toBe("tester");
      expect(row.provenance).toEqual({ kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null });
      expect(row.createdAt).toBe(1_700_000_000);
      expect(row.contentHash).toHaveLength(64);
    });

    it("同一 body の addKnowledge は既存行を返す no-op になる", () => {
      const first = store.addKnowledge({ title: "first", body: "same body", source: "orchestrator" }, "tester");
      const second = store.addKnowledge({ title: "second", body: "same body", source: "steward" }, "tester");

      expect(second.id).toBe(first.id);
      expect(second.title).toBe("first");
      expect(store.listKnowledge({ includeExpired: true })).toHaveLength(1);
    });

    it("listKnowledge は tag/source/expires を絞り込み importance 降順→created_at 降順で返す", () => {
      const now = Math.floor(Date.now() / 1000);
      const low = store.addKnowledge(
        {
          title: "low",
          body: "low body",
          source: "session-handover",
          tags: ["handover"],
          importance: 10,
          createdAt: now + 10,
        },
        "tester",
      );
      const highOld = store.addKnowledge(
        {
          title: "high old",
          body: "high old body",
          source: "session-handover",
          tags: ["handover", "important"],
          importance: 90,
          createdAt: now + 1,
        },
        "tester",
      );
      const highNew = store.addKnowledge(
        {
          title: "high new",
          body: "high new body",
          source: "session-handover",
          tags: ["handover"],
          importance: 90,
          createdAt: now + 2,
        },
        "tester",
      );
      const expired = store.addKnowledge(
        {
          title: "expired",
          body: "expired body",
          source: "session-handover",
          tags: ["handover"],
          importance: 100,
          expiresAt: now - 1,
          createdAt: now + 20,
        },
        "tester",
      );
      store.addKnowledge(
        {
          title: "other source",
          body: "other source body",
          source: "steward",
          tags: ["handover"],
          importance: 100,
          createdAt: now + 30,
        },
        "tester",
      );

      expect(
        store
          .listKnowledge({ tag: "handover", source: "session-handover", limit: 10 })
          .map((row) => row.id),
      ).toEqual([highNew.id, highOld.id, low.id]);
      expect(store.listKnowledge({ includeExpired: true, limit: 10 }).map((row) => row.id)).toContain(
        expired.id,
      );
    });

    it("listKnowledge は search で title/body を部分一致検索する", () => {
      const byTitle = store.addKnowledge(
        {
          title: "Bridge handover",
          body: "supervisor note",
          source: "session-handover",
          importance: 80,
        },
        "tester",
      );
      const byBody = store.addKnowledge(
        {
          title: "Daily note",
          body: "Bridge restart procedure",
          source: "steward",
          importance: 70,
        },
        "tester",
      );
      store.addKnowledge(
        {
          title: "Other note",
          body: "unrelated",
          source: "steward",
          importance: 100,
        },
        "tester",
      );

      expect(store.listKnowledge({ search: "bridge", limit: 10 }).map((row) => row.id)).toEqual([
        byTitle.id,
        byBody.id,
      ]);
      expect(store.listKnowledge({ search: "restart", source: "steward", limit: 10 }).map((row) => row.id)).toEqual([
        byBody.id,
      ]);
    });

    it("getKnowledge は存在行を返し、未知 id は null を返す", () => {
      const row = store.addKnowledge({ title: "get", body: "get body" }, "tester");
      expect(store.getKnowledge(row.id)?.id).toBe(row.id);
      expect(store.getKnowledge("k_000000000000")).toBeNull();
    });
  });

  describe("peekRuntimeCleanupAwaitCandidate（docs/contract.md §80.5）", () => {
    interface CleanupPeekFixture {
      taskId: string;
      orchestratorId: string;
      leaseId: string;
      activeFence: number;
      ownerPath: string;
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    function setupCleanupPeekLease(controllerOrchestratorId?: string): CleanupPeekFixture {
      const ownerPath = process.cwd();
      const task = createTask({
        title: "cleanup peek",
        body: `cwd: ${ownerPath}`,
        tenant: "dev",
        status: "ready",
      });
      const orchestratorId = controllerOrchestratorId ?? store.registerOrchestrator({
        label: `cleanup-peek-${task.id}`,
        project: "hachi-kanban",
        repoCommonDir: ownerPath,
      }).id;
      const requirement = store.createOrGetRuntimeResourceRequirement({
        taskId: task.id,
        name: "cleanup-peek",
        bundleKind: "worktree_preview",
        spec: { version: 1, requiredMembers: ["docker_container"] },
        idempotencyKey: `${task.id}:cleanup-peek`,
      });
      const lease = store.reserveRuntimeResourceLease({
        requirementId: requirement.id,
        controllerOrchestratorId: orchestratorId,
        board: "dev",
        project: "hachi-kanban",
        repoCommonDir: ownerPath,
        worktree: ownerPath,
        cleanupPolicy: "auto",
        managed: true,
        ephemeral: true,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        provenanceVersion: 1,
        rolloutGeneration: 1,
        actor: "test",
      });
      const provisioning = store.claimRuntimeResourceLease(lease.id, lease.fence, "test");
      store.addRuntimeResourceMember({
        leaseId: lease.id,
        expectedLeaseFence: provisioning.fence,
        kind: "docker_container",
        state: "active",
        cleanupPolicy: "auto",
        managed: true,
        ephemeral: true,
        scopeKey: `cleanup-peek:${task.id}`,
        nativeId: `container-${task.id}`,
        labelsHash: "a".repeat(64),
        provenance: { version: 1, labels: {} },
        observedAt: Math.floor(Date.now() / 1000),
        actor: "test",
      });
      const active = store.transitionRuntimeResourceLease({
        leaseId: lease.id,
        expectedFence: provisioning.fence,
        from: "provisioning",
        to: "active",
        actor: "test",
      });
      return {
        taskId: task.id,
        orchestratorId,
        leaseId: lease.id,
        activeFence: active.fence,
        ownerPath,
      };
    }

    function requestCleanup(
      fixture: CleanupPeekFixture,
      reason: string,
    ): ReturnType<SqliteKanbanStore["requestRuntimeResourceRelease"]> {
      return store.requestRuntimeResourceRelease({
        leaseId: fixture.leaseId,
        expectedLeaseFence: fixture.activeFence,
        reason,
        actor: "test",
      });
    }

    it("再配送時刻で逆転しても元request時刻が最古の1件を返し、既存listの配送順は維持する", () => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      const source = store.registerOrchestrator({
        label: "cleanup-peek-source",
        project: "hachi-kanban",
        repoCommonDir: process.cwd(),
      });
      const target = store.registerOrchestrator({
        label: "cleanup-peek-target",
        project: "hachi-kanban",
        repoCommonDir: process.cwd(),
      });
      const oldFixture = setupCleanupPeekLease(source.id);
      const oldRequest = requestCleanup(oldFixture, "古い request");

      vi.setSystemTime(200_000);
      const newFixture = setupCleanupPeekLease(source.id);
      const newRequest = requestCleanup(newFixture, "新しい request");
      store.routeRuntimeCleanupDelivery({
        requestId: newRequest.id,
        expectedControllerId: source.id,
        targetOrchestratorId: target.id,
        expectedLeaseFence: newFixture.activeFence,
        now: 300,
      });
      store.routeRuntimeCleanupDelivery({
        requestId: oldRequest.id,
        expectedControllerId: source.id,
        targetOrchestratorId: target.id,
        expectedLeaseFence: oldFixture.activeFence,
        now: 400,
      });

      expect(store.listRuntimeCleanupInboxDeliveries(target.id).map((row) => row.requestId)).toEqual([
        newRequest.id,
        oldRequest.id,
      ]);
      expect(store.peekRuntimeCleanupAwaitCandidate(target.id)).toEqual({
        requestId: oldRequest.id,
        claimableAt: oldRequest.createdAt,
        expectedLeaseFence: oldFixture.activeFence,
        leaseId: oldFixture.leaseId,
        reason: "古い request",
        ownerTaskId: oldFixture.taskId,
        humanAnswer: "",
      });
    });

    it("有効claim中は除外し、期限ちょうどで元request時刻の候補へ戻して観測を無副作用に保つ", () => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      const fixture = setupCleanupPeekLease();
      const request = requestCleanup(fixture, "期限境界");
      const session = store.startOrchestratorSession({ orchestratorId: fixture.orchestratorId });
      store.claimRuntimeCleanupRequest({
        requestId: request.id,
        orchestratorId: fixture.orchestratorId,
        sessionId: session.id,
        generation: session.generation,
        claimToken: "cleanup-peek-secret",
        expectedLeaseFence: fixture.activeFence,
        leaseUntil: 120,
        now: 110,
      });

      expect(store.peekRuntimeCleanupAwaitCandidate(fixture.orchestratorId, 119)).toBeNull();
      const requestBefore = store.getRuntimeCleanupRequest(request.id);
      const deliveriesBefore = store.listRuntimeCleanupInboxDeliveries(fixture.orchestratorId, 50, 120);
      const leaseBefore = store.getRuntimeResourceLease(fixture.leaseId);
      const taskBefore = store.getTask(fixture.taskId);
      const expectedCandidate = {
        requestId: request.id,
        claimableAt: request.createdAt,
        expectedLeaseFence: fixture.activeFence,
        leaseId: fixture.leaseId,
        reason: "期限境界",
        ownerTaskId: fixture.taskId,
        humanAnswer: "",
      };

      const candidate = store.peekRuntimeCleanupAwaitCandidate(fixture.orchestratorId, 120);
      expect(candidate).toEqual(expectedCandidate);
      expect(store.peekRuntimeCleanupAwaitCandidate(fixture.orchestratorId, 120)).toEqual(expectedCandidate);
      expect(Object.keys(candidate ?? {}).sort()).toEqual([
        "claimableAt",
        "expectedLeaseFence",
        "humanAnswer",
        "leaseId",
        "ownerTaskId",
        "reason",
        "requestId",
      ]);
      expect(store.getRuntimeCleanupRequest(request.id)).toEqual(requestBefore);
      expect(store.listRuntimeCleanupInboxDeliveries(fixture.orchestratorId, 50, 120)).toEqual(deliveriesBefore);
      expect(store.getRuntimeResourceLease(fixture.leaseId)).toEqual(leaseBefore);
      expect(store.getTask(fixture.taskId)).toEqual(taskBefore);
    });

    it("controller・orchestrator・decision class・終端状態をLIMIT前に除外し、候補無しはnullを返す", () => {
      const controllerFixture = setupCleanupPeekLease();
      const collaborator = store.registerOrchestrator({
        label: "cleanup-peek-collaborator",
        project: "hachi-kanban",
        repoCommonDir: process.cwd(),
      });
      store.bindTaskToOrchestrator(controllerFixture.taskId, collaborator.id, "collaborator");
      const controllerRequest = requestCleanup(controllerFixture, "controller mismatch");
      expect(store.listPendingRuntimeCleanupDeliveries()).toEqual(expect.arrayContaining([
        expect.objectContaining({ requestId: controllerRequest.id, orchestratorId: collaborator.id }),
      ]));
      expect(store.peekRuntimeCleanupAwaitCandidate(collaborator.id)).toBeNull();

      const unrelated = store.registerOrchestrator({
        label: "cleanup-peek-unrelated",
        project: "hachi-kanban",
        repoCommonDir: process.cwd(),
      });
      expect(store.peekRuntimeCleanupAwaitCandidate(unrelated.id)).toBeNull();

      const humanFixture = setupCleanupPeekLease();
      const human = store.transitionRuntimeResourceLeaseWithCleanupRequest({
        leaseId: humanFixture.leaseId,
        expectedFence: humanFixture.activeFence,
        from: "active",
        terminalReason: "explicit_release",
        decisionClass: "human",
        reason: "human decision",
        actor: "test",
      });
      expect(human.request.decisionClass).toBe("human");
      expect(store.peekRuntimeCleanupAwaitCandidate(humanFixture.orchestratorId)).toBeNull();

      const terminalFixture = setupCleanupPeekLease();
      const terminalRequest = requestCleanup(terminalFixture, "terminal request");
      const session = store.startOrchestratorSession({ orchestratorId: terminalFixture.orchestratorId });
      store.claimRuntimeCleanupRequest({
        requestId: terminalRequest.id,
        orchestratorId: terminalFixture.orchestratorId,
        sessionId: session.id,
        generation: session.generation,
        claimToken: "terminal-token",
        expectedLeaseFence: terminalFixture.activeFence,
        leaseUntil: 200,
        now: 100,
      });
      store.rejectRuntimeCleanupRequest({
        requestId: terminalRequest.id,
        orchestratorId: terminalFixture.orchestratorId,
        sessionId: session.id,
        generation: session.generation,
        claimToken: "terminal-token",
        expectedLeaseFence: terminalFixture.activeFence,
        reason: "終了",
        now: 110,
      });
      expect(store.peekRuntimeCleanupAwaitCandidate(terminalFixture.orchestratorId, 300)).toBeNull();

      const empty = store.registerOrchestrator({
        label: "cleanup-peek-empty",
        project: "hachi-kanban",
        repoCommonDir: process.cwd(),
      });
      expect(store.peekRuntimeCleanupAwaitCandidate(empty.id)).toBeNull();
    });

    it("同じrequest時刻はid順で選ぶ", () => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      const fixture = setupCleanupPeekLease();
      const first = requestCleanup(fixture, "同時刻1");
      const second = requestCleanup(fixture, "同時刻2");
      const expectedId = [first.id, second.id].sort()[0]!;

      expect(first.createdAt).toBe(second.createdAt);
      expect(store.peekRuntimeCleanupAwaitCandidate(fixture.orchestratorId)?.requestId).toBe(expectedId);
    });

    it("authority fenceが変わっても観測ではskipせず、既存claimがstaleを拒否する", () => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      const fixture = setupCleanupPeekLease();
      const request = requestCleanup(fixture, "stale authority");
      const candidate = store.peekRuntimeCleanupAwaitCandidate(fixture.orchestratorId);
      const renewed = store.renewRuntimeResourceLease({
        leaseId: fixture.leaseId,
        expectedFence: fixture.activeFence,
        controllerOrchestratorId: fixture.orchestratorId,
        repoCommonDir: fixture.ownerPath,
        worktree: fixture.ownerPath,
        heartbeatAt: 110,
        expiresAt: 200,
        actor: "test",
      });
      const session = store.startOrchestratorSession({ orchestratorId: fixture.orchestratorId });

      expect(candidate).toEqual({
        requestId: request.id,
        claimableAt: request.createdAt,
        expectedLeaseFence: fixture.activeFence,
        leaseId: fixture.leaseId,
        reason: "stale authority",
        ownerTaskId: fixture.taskId,
        humanAnswer: "",
      });
      expect(renewed.fence).toBe(fixture.activeFence + 1);
      expect(store.peekRuntimeCleanupAwaitCandidate(fixture.orchestratorId)).toEqual(candidate);
      expect(() => store.claimRuntimeCleanupRequest({
        requestId: request.id,
        orchestratorId: fixture.orchestratorId,
        sessionId: session.id,
        generation: session.generation,
        claimToken: "stale-token",
        expectedLeaseFence: fixture.activeFence,
        leaseUntil: 200,
        now: 110,
      })).toThrow(/fence.*stale/);
      expect(store.getRuntimeCleanupRequest(request.id)?.status).toBe("queued");
      expect(store.peekRuntimeCleanupAwaitCandidate(fixture.orchestratorId)).toEqual(candidate);
    });
  });
});

/** docs/contract.md §5 の DDL全文（migration version 1 相当）。
 * SqliteKanbanStore を経由せず「version 1 のみ適用済み」の状態を手動構築するために使う */
const MIGRATION_V1_SQL_FOR_TEST = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'triage',
  priority INTEGER NOT NULL DEFAULT 0,
  tenant TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL DEFAULT '',
  model_override TEXT NOT NULL DEFAULT '',
  block_reason TEXT NOT NULL DEFAULT '',
  claim_lock TEXT NOT NULL DEFAULT '',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_error TEXT NOT NULL DEFAULT '',
  last_heartbeat_at INTEGER,
  max_retries INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  meta TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS task_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id TEXT NOT NULL REFERENCES tasks(id),
  child_id TEXT NOT NULL REFERENCES tasks(id),
  link_type TEXT NOT NULL DEFAULT 'subtask',
  created_at INTEGER NOT NULL,
  UNIQUE(parent_id, child_id, link_type)
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

/** docs/contract.md §12.5-4 で追加される5つのインデックス名 */
const EXPECTED_V2_INDEX_NAMES = [
  "idx_tasks_status_priority",
  "idx_comments_task",
  "idx_events_task_type",
  "idx_events_idem",
  "idx_runs_task_status",
];

const EXPECTED_MIGRATION_VERSIONS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
  13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
];

/** db.ts の IDEMPOTENCY_KEY_EXPR と完全一致させる（docs/contract.md §12.16-2）。
 * 式インデックスはテキスト一致でのみ最適化に使われるため、テスト側でも同じ文字列を使う */
const IDEMPOTENCY_KEY_EXPR_FOR_TEST = "CASE WHEN json_valid(payload) THEN json_extract(payload, '$.idempotencyKey') END";

/** docs/contract.md §12.9-1 の v2 相当インデックス DDL（SqliteKanbanStore を経由せず「version 2 まで適用済み」状態を手動構築するために使う）。
 * §12.16-2 のガード付き式（現行の db.ts と同一）を使う */
const MIGRATION_V2_SQL_FOR_TEST = `
CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority);
CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id, id);
CREATE INDEX IF NOT EXISTS idx_events_task_type ON task_events(task_id, event_type, id);
CREATE INDEX IF NOT EXISTS idx_events_idem ON task_events(event_type, ${IDEMPOTENCY_KEY_EXPR_FOR_TEST});
CREATE INDEX IF NOT EXISTS idx_runs_task_status ON task_runs(task_id, status);
`;

/** docs/contract.md §12.9-1 で追加される部分 UNIQUE インデックス名 */
const EXPECTED_V3_INDEX_NAME = "idx_events_idem_unique";

/** docs/contract.md §12.9-1 の v3 相当インデックス DDL（現行のガード付き式）。 */
const MIGRATION_V3_SQL_FOR_TEST = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem_unique ON task_events(${IDEMPOTENCY_KEY_EXPR_FOR_TEST}) WHERE event_type = 'message_processed';
`;

/**
 * §12.16-2 修正前（v4 未適用）の旧・ガード無し式インデックス DDL。
 * 「既に v1〜v3 が旧式で適用済みの本番/開発 DB」を再現し、v4 の DROP→再 CREATE による
 * 自己修復を検証するためだけに使う（新規 DB は最初からガード付きで作成されるため使わない）。
 */
const LEGACY_UNGUARDED_V2_SQL_FOR_TEST = `
CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority);
CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id, id);
CREATE INDEX IF NOT EXISTS idx_events_task_type ON task_events(task_id, event_type, id);
CREATE INDEX IF NOT EXISTS idx_events_idem ON task_events(event_type, json_extract(payload, '$.idempotencyKey'));
CREATE INDEX IF NOT EXISTS idx_runs_task_status ON task_runs(task_id, status);
`;
const LEGACY_UNGUARDED_V3_SQL_FOR_TEST = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem_unique ON task_events(json_extract(payload, '$.idempotencyKey')) WHERE event_type = 'message_processed';
`;

describe("migrations", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hachi-core-db-test-"));
    dbPath = join(tempDir, "kanban.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function readMigrationVersions(path: string): number[] {
    const raw = new Database(path, { readonly: true });
    try {
      const rows = raw.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as Array<{
        version: number;
      }>;
      return rows.map((row) => row.version);
    } finally {
      raw.close();
    }
  }

  function readIndexNames(path: string): string[] {
    const raw = new Database(path, { readonly: true });
    try {
      const rows = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{
        name: string;
      }>;
      return rows.map((row) => row.name);
    } finally {
      raw.close();
    }
  }

  function readTableColumns(path: string, tableName: string): string[] {
    const raw = new Database(path, { readonly: true });
    try {
      const rows = raw.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
      return rows.map((row) => row.name);
    } finally {
      raw.close();
    }
  }

  it("stable identityはINSERT競合が発生しても既存行へ冪等収束する", () => {
    const store = new SqliteKanbanStore(dbPath);
    const raw = new Database(dbPath);
    try {
      raw.exec(`
        CREATE TRIGGER inject_orchestrator_registration_race
        BEFORE INSERT ON orchestrators
        WHEN NEW.label = 'race' AND NEW.id <> 'o_concurrent_winner'
        BEGIN
          INSERT INTO orchestrators (
            id, label, project, repo_common_dir, created_at, updated_at
          ) VALUES (
            'o_concurrent_winner', NEW.label, NEW.project, NEW.repo_common_dir,
            NEW.created_at, NEW.updated_at
          );
        END;
      `);

      const registered = store.registerOrchestrator({
        label: "race",
        project: "hachi-kanban",
        repoCommonDir: "/repo/.git",
      });

      expect(registered.id).toBe("o_concurrent_winner");
      expect(store.listOrchestrators()).toHaveLength(1);
    } finally {
      raw.close();
      store.close();
    }
  });

  it("新規DB作成時に version 1〜32 が記録され、execution/communication/liveness/human decision面まで作成される", () => {
    const store = new SqliteKanbanStore(dbPath);
    store.close();

    expect(readMigrationVersions(dbPath)).toEqual(EXPECTED_MIGRATION_VERSIONS);

    const indexNames = readIndexNames(dbPath);
    for (const expected of EXPECTED_V2_INDEX_NAMES) {
      expect(indexNames).toContain(expected);
    }
    expect(indexNames).toContain(EXPECTED_V3_INDEX_NAME);
    expect(indexNames).toContain("idx_orchestrators_stable_identity");
    expect(indexNames).toEqual(expect.arrayContaining([
      "idx_human_decision_status_created",
      "idx_human_decision_task_status_created",
      "idx_human_decision_owner_status_answered",
      "idx_human_decision_claimant_session",
    ]));
    expect(readTableColumns(dbPath, "human_decision_requests")).toEqual(expect.arrayContaining([
      "owner_orchestrator_id",
      "ask_payload_hash",
      "answer_payload_hash",
      "claim_token_hash",
      "request_actor_kind",
      "resolve_actor_generation",
    ]));

    expect(readTableColumns(dbPath, "orchestrator_requests")).toContain("question_id");
    expect(readTableColumns(dbPath, "notification_outbox")).toContain("dedupe_key");
    expect(readTableColumns(dbPath, "notification_outbox")).toContain("sent_transports");
    expect(readTableColumns(dbPath, "orchestrator_liveness_incidents")).toEqual(expect.arrayContaining([
      "session_id",
      "generation",
      "gap_seconds",
      "status",
      "attempts",
      "next_attempt_at",
      "sent_at",
    ]));
    expect(indexNames).toContain("idx_orchestrator_liveness_pending");
    expect(readTableColumns(dbPath, "tasks")).toEqual(expect.arrayContaining([
      "speed_override",
      "review_profile_override",
      "review_provider_override",
      "review_model_override",
      "review_effort_override",
      "review_speed_override",
    ]));
    expect(readTableColumns(dbPath, "native_session_bindings")).toContain("provider_session_id");
    expect(readTableColumns(dbPath, "native_session_bindings")).toContain("native_address");
    expect(readTableColumns(dbPath, "communication_delivery_attempts")).toContain("steer_delivery_id");
    expect(readTableColumns(dbPath, "communication_delivery_attempts")).toEqual(expect.arrayContaining([
      "payload",
      "config_hash",
      "config_rollout",
      "config_minimum_runtime_version",
      "config_same_host_only",
      "config_canary_percent",
      "source_binding_hash",
      "target_binding_hash",
      "attempt_nonce_hash",
      "dispatching_at",
    ]));

    expect(readTableColumns(dbPath, "schedules")).toEqual([
      "id",
      "name",
      "enabled",
      "cadence_kind",
      "at_minute",
      "at_hour",
      "weekday",
      "day_of_month",
      "run_date",
      "tenant",
      "profile",
      "cwd",
      "prompt",
      "priority",
      "last_run_at",
      "last_task_id",
      "consecutive_failures",
      "auto_disabled_reason",
      "created_at",
      "updated_at",
    ]);
    expect(readTableColumns(dbPath, "tick_metrics")).toEqual(["ts", "stage", "actions", "duration_ms"]);
    expect(readTableColumns(dbPath, "lessons")).toEqual([
      "id",
      "created_at",
      "trigger",
      "tenant",
      "cwd",
      "profile",
      "body",
      "source_task_id",
    ]);
    expect(readTableColumns(dbPath, "knowledge")).toEqual([
      "id",
      "title",
      "body",
      "source",
      "tags",
      "importance",
      "expires_at",
      "origin_path",
      "content_hash",
      "actor",
      "actor_kind",
      "actor_id",
      "actor_session_id",
      "actor_generation",
      "created_at",
      "updated_at",
    ]);
    expect(readTableColumns(dbPath, "tasks")).toContain("watched");
    expect(readTableColumns(dbPath, "tasks")).toContain("effort_override");
    expect(readTableColumns(dbPath, "relay_delivery_uncertain_events")).toEqual([
      "session_id",
      "event_id",
      "handover_generation",
      "relay_id",
      "fencing_token",
      "reason",
      "observed_at",
      "provider",
      "host",
      "even_terminal_boot_epoch",
      "canonical_server_url",
      "recorded_at",
    ]);
    expect(indexNames).toContain("idx_relay_delivery_uncertain_events_recorded");
    expect(indexNames).toContain("idx_relay_delivery_uncertain_events_session");
  });

  it("v31→v32は既存v30/v31 dataを変更せず適用し、再openも冪等", () => {
    const initial = new SqliteKanbanStore(dbPath);
    initial.close();
    const legacy = new Database(dbPath);
    let beforeUncertain: unknown;
    let beforeAuthority: unknown;
    try {
      legacy.prepare(
        `INSERT INTO relay_delivery_uncertain_events (
           session_id, event_id, handover_generation, relay_id, fencing_token, reason,
           observed_at, provider, host, even_terminal_boot_epoch, canonical_server_url, recorded_at
         ) VALUES (?, ?, ?, ?, ?, 'sending_remnant', ?, 'codex', ?, ?, ?, ?)`,
      ).run("legacy-session", "legacy-event", 1, "legacy-relay", 1, 100, "legacy-host", "legacy-boot",
        "http://127.0.0.1:3456", 101);
      legacy.prepare(
        `INSERT INTO relay_authority_installation (
           singleton, board_instance_id, adoption_id, host_identity, host_epoch, authority_revision,
           created_at, updated_at
         ) VALUES (1, ?, ?, ?, 1, 1, 100, 100)`,
      ).run("a".repeat(32), "b".repeat(64), "c".repeat(64));
      beforeUncertain = legacy.prepare(`SELECT * FROM relay_delivery_uncertain_events`).get();
      beforeAuthority = legacy.prepare(`SELECT * FROM relay_authority_installation`).get();
      legacy.exec(`DROP TABLE human_decision_requests; DELETE FROM schema_migrations WHERE version = 32;`);
    } finally {
      legacy.close();
    }
    expect(readMigrationVersions(dbPath)).toEqual(EXPECTED_MIGRATION_VERSIONS.slice(0, -1));

    const migrated = new SqliteKanbanStore(dbPath);
    migrated.close();
    const reopened = new SqliteKanbanStore(dbPath);
    reopened.close();

    const checked = new Database(dbPath, { readonly: true });
    try {
      expect(checked.prepare(`SELECT * FROM relay_delivery_uncertain_events`).get()).toEqual(beforeUncertain);
      expect(checked.prepare(`SELECT * FROM relay_authority_installation`).get()).toEqual(beforeAuthority);
      expect(checked.prepare(`SELECT COUNT(*) AS count FROM human_decision_requests`).get()).toEqual({ count: 0 });
    } finally {
      checked.close();
    }
    expect(readMigrationVersions(dbPath)).toEqual(EXPECTED_MIGRATION_VERSIONS);
  });

  it("migration v32 CHECKはkind/status/revision/claim/auditの不整合を拒否する", () => {
    const current = new SqliteKanbanStore(dbPath);
    const task = current.createTask({ title: "t", body: "", tenant: "dev" }, "tester");
    const orchestrator = current.registerOrchestrator({
      label: "migration-v32-check",
      project: "hachi-kanban",
      repoCommonDir: "/repo/migration-v32-check/.git",
    });
    const session = current.startOrchestratorSession({ orchestratorId: orchestrator.id });
    const request = current.createHumanDecisionRequest({
      taskId: task.id,
      kind: "decision",
      title: "判断",
      question: "選択してください",
      idempotencyKey: "migration-v32-check",
      provenance: {
        kind: "orchestrator",
        actorId: orchestrator.id,
        actorSessionId: session.id,
        actorGeneration: session.generation,
      },
    });
    current.close();
    const raw = new Database(dbPath);
    try {
      expect(() => raw.prepare(
        `UPDATE human_decision_requests SET status = 'claimed' WHERE id = ?`,
      ).run(request.id)).toThrow();
      expect(() => raw.prepare(
        `UPDATE human_decision_requests SET ask_payload_hash = ? WHERE id = ?`,
      ).run("A".repeat(64), request.id)).toThrow();
      expect(() => raw.prepare(
        `UPDATE human_decision_requests SET request_actor_id = 'o_other' WHERE id = ?`,
      ).run(request.id)).toThrow();
    } finally {
      raw.close();
    }
  });

  it("既存 version 1 適用済みDBへ version 2〜10 が追加適用される", () => {
    // SqliteKanbanStore を経由せず、生の better-sqlite3 で「version 1 のみ適用済み」状態を手動構築する
    const bootstrap = new Database(dbPath);
    try {
      bootstrap.exec(MIGRATION_V1_SQL_FOR_TEST);
      bootstrap
        .prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)`)
        .run(Math.floor(Date.now() / 1000));
    } finally {
      bootstrap.close();
    }

    // version 1 のみが適用済みであることを事前確認
    // （sqlite_autoindex_* は PRIMARY KEY/UNIQUE 制約由来で DDL 実行時に自動作成されるため、
    //   ここでは v2 が追加する5つのインデックスがまだ存在しないことのみを確認する）
    expect(readMigrationVersions(dbPath)).toEqual([1]);
    const preIndexNames = readIndexNames(dbPath);
    for (const expected of EXPECTED_V2_INDEX_NAMES) {
      expect(preIndexNames).not.toContain(expected);
    }

    const store = new SqliteKanbanStore(dbPath);
    store.close();

    expect(readMigrationVersions(dbPath)).toEqual(EXPECTED_MIGRATION_VERSIONS);

    const indexNames = readIndexNames(dbPath);
    for (const expected of EXPECTED_V2_INDEX_NAMES) {
      expect(indexNames).toContain(expected);
    }
    expect(indexNames).toContain(EXPECTED_V3_INDEX_NAME);
    expect(readTableColumns(dbPath, "tasks")).toContain("watched");
    expect(readTableColumns(dbPath, "tasks")).toContain("effort_override");
    expect(readTableColumns(dbPath, "knowledge")).toContain("content_hash");
  });

  it("既存 version 2 適用済みDBへ version 3〜7 が追加適用される（docs/contract.md §12.9-1/§43.1/§44.1）", () => {
    // SqliteKanbanStore を経由せず、生の better-sqlite3 で「version 2 まで適用済み」状態を手動構築する
    const bootstrap = new Database(dbPath);
    try {
      bootstrap.exec(MIGRATION_V1_SQL_FOR_TEST);
      bootstrap.exec(MIGRATION_V2_SQL_FOR_TEST);
      const now = Math.floor(Date.now() / 1000);
      bootstrap.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)`).run(now);
      bootstrap.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)`).run(now);
    } finally {
      bootstrap.close();
    }

    expect(readMigrationVersions(dbPath)).toEqual([1, 2]);
    const preIndexNames = readIndexNames(dbPath);
    expect(preIndexNames).not.toContain(EXPECTED_V3_INDEX_NAME);

    const store = new SqliteKanbanStore(dbPath);
    store.close();

    expect(readMigrationVersions(dbPath)).toEqual(EXPECTED_MIGRATION_VERSIONS);
    const indexNames = readIndexNames(dbPath);
    expect(indexNames).toContain(EXPECTED_V3_INDEX_NAME);
  });

  it("migration v8 は watched 列と既存行の既定値を冪等に追加する", () => {
    const bootstrap = new Database(dbPath);
    try {
      bootstrap.exec(MIGRATION_V1_SQL_FOR_TEST);
      const now = Math.floor(Date.now() / 1000);
      bootstrap.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)`).run(now);
      bootstrap
        .prepare(`INSERT INTO tasks (id, title, tenant, created_at, updated_at) VALUES ('t_watch_v8', 'w', 'dev', ?, ?)`)
        .run(now, now);
    } finally {
      bootstrap.close();
    }

    const firstOpen = new SqliteKanbanStore(dbPath);
    firstOpen.close();
    const secondOpen = new SqliteKanbanStore(dbPath);
    secondOpen.close();

    expect(readMigrationVersions(dbPath)).toEqual(EXPECTED_MIGRATION_VERSIONS);
    expect(readTableColumns(dbPath, "tasks").filter((column) => column === "watched")).toHaveLength(1);

    const raw = new Database(dbPath, { readonly: true });
    try {
      const row = raw.prepare(`SELECT watched FROM tasks WHERE id = 't_watch_v8'`).get() as { watched: number };
      expect(row.watched).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("migration v9 は knowledge テーブルを冪等に追加する", () => {
    const bootstrap = new Database(dbPath);
    try {
      bootstrap.exec(MIGRATION_V1_SQL_FOR_TEST);
      const now = Math.floor(Date.now() / 1000);
      bootstrap.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)`).run(now);
    } finally {
      bootstrap.close();
    }

    const firstOpen = new SqliteKanbanStore(dbPath);
    firstOpen.close();
    const secondOpen = new SqliteKanbanStore(dbPath);
    secondOpen.close();

    expect(readMigrationVersions(dbPath)).toEqual(EXPECTED_MIGRATION_VERSIONS);
    expect(readTableColumns(dbPath, "knowledge").filter((column) => column === "content_hash")).toHaveLength(1);
  });

  it("migration v10 は effort_override 列と既存行の既定値を冪等に追加する", () => {
    const bootstrap = new Database(dbPath);
    try {
      bootstrap.exec(MIGRATION_V1_SQL_FOR_TEST);
      const now = Math.floor(Date.now() / 1000);
      bootstrap.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)`).run(now);
      bootstrap
        .prepare(`INSERT INTO tasks (id, title, tenant, created_at, updated_at) VALUES ('t_effort_v10', 'e', 'dev', ?, ?)`)
        .run(now, now);
    } finally {
      bootstrap.close();
    }

    const firstOpen = new SqliteKanbanStore(dbPath);
    firstOpen.close();
    const secondOpen = new SqliteKanbanStore(dbPath);
    secondOpen.close();

    expect(readMigrationVersions(dbPath)).toEqual(EXPECTED_MIGRATION_VERSIONS);
    expect(readTableColumns(dbPath, "tasks").filter((column) => column === "effort_override")).toHaveLength(1);

    const raw = new Database(dbPath, { readonly: true });
    try {
      const row = raw.prepare(`SELECT effort_override FROM tasks WHERE id = 't_effort_v10'`).get() as {
        effort_override: string;
      };
      expect(row.effort_override).toBe("");
    } finally {
      raw.close();
    }
  });

  it("既存 version 4 適用済みDBへ version 5 の schedules テーブルが追加適用される", () => {
    const bootstrap = new Database(dbPath);
    try {
      bootstrap.exec(MIGRATION_V1_SQL_FOR_TEST);
      bootstrap.exec(MIGRATION_V2_SQL_FOR_TEST);
      bootstrap.exec(MIGRATION_V3_SQL_FOR_TEST);
      const now = Math.floor(Date.now() / 1000);
      for (const version of [1, 2, 3, 4]) {
        bootstrap.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, now);
      }
    } finally {
      bootstrap.close();
    }

    expect(readMigrationVersions(dbPath)).toEqual([1, 2, 3, 4]);
    expect(readTableColumns(dbPath, "schedules")).toEqual([]);

    const store = new SqliteKanbanStore(dbPath);
    store.close();

    expect(readMigrationVersions(dbPath)).toEqual(EXPECTED_MIGRATION_VERSIONS);
    expect(readTableColumns(dbPath, "schedules")).toContain("cadence_kind");
    expect(readTableColumns(dbPath, "schedules")).toContain("auto_disabled_reason");
    expect(readTableColumns(dbPath, "tick_metrics")).toContain("duration_ms");
    expect(readTableColumns(dbPath, "lessons")).toContain("source_task_id");
  });

  it("v3 preflight: 既存の重複 idempotencyKey を持つ message_processed 行があっても再オープンに成功し、重複が解消される（docs/contract.md §12.11-3）", () => {
    // SqliteKanbanStore を経由せず、生の better-sqlite3 で「version 2 まで適用済み（UNIQUE インデックス
    // 未作成）」かつ重複 idempotencyKey を持つ message_processed 行が既に存在する状態を手動構築する
    // （既存 DB / import 由来 DB で起こりうる汚染データを再現）
    let firstDuplicateId = -1;
    const bootstrap = new Database(dbPath);
    try {
      bootstrap.exec(MIGRATION_V1_SQL_FOR_TEST);
      bootstrap.exec(MIGRATION_V2_SQL_FOR_TEST);
      const now = Math.floor(Date.now() / 1000);
      bootstrap.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)`).run(now);
      bootstrap.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)`).run(now);

      bootstrap
        .prepare(`INSERT INTO tasks (id, title, tenant, created_at, updated_at) VALUES ('t_dup', 'dup', 'dev', ?, ?)`)
        .run(now, now);

      const insertEvent = bootstrap.prepare(
        `INSERT INTO task_events (task_id, event_type, actor, payload, created_at) VALUES (?, 'message_processed', 'tester', ?, ?)`,
      );
      // 同一 idempotencyKey を持つ重複行を3件仕込む（UNIQUE インデックスが無い状態なので直接INSERT可能）
      firstDuplicateId = Number(
        insertEvent.run("t_dup", JSON.stringify({ idempotencyKey: "dup-key" }), now).lastInsertRowid,
      );
      insertEvent.run("t_dup", JSON.stringify({ idempotencyKey: "dup-key" }), now + 1);
      insertEvent.run("t_dup", JSON.stringify({ idempotencyKey: "dup-key" }), now + 2);
      // 別 key の非重複行も1件仕込み、誤って消されないことを確認する
      insertEvent.run("t_dup", JSON.stringify({ idempotencyKey: "unique-key" }), now);

      const beforeCount = bootstrap
        .prepare(`SELECT COUNT(*) AS c FROM task_events WHERE event_type = 'message_processed'`)
        .get() as { c: number };
      expect(beforeCount.c).toBe(4);
    } finally {
      bootstrap.close();
    }

    // 再オープン（= runMigrations 実行）が preflight により UNIQUE 制約違反なく成功すること
    expect(() => {
      const store = new SqliteKanbanStore(dbPath);
      store.close();
    }).not.toThrow();

    expect(readMigrationVersions(dbPath)).toEqual(EXPECTED_MIGRATION_VERSIONS);
    const indexNames = readIndexNames(dbPath);
    expect(indexNames).toContain(EXPECTED_V3_INDEX_NAME);

    const raw = new Database(dbPath, { readonly: true });
    try {
      const remaining = raw
        .prepare(
          `SELECT id, json_extract(payload, '$.idempotencyKey') AS key FROM task_events
           WHERE event_type = 'message_processed' ORDER BY id ASC`,
        )
        .all() as Array<{ id: number; key: string }>;
      // 重複は各 key ごと最小 id の1件のみへ解消され、非重複行は保持される
      expect(remaining.map((r) => r.key)).toEqual(["dup-key", "unique-key"]);
      expect(remaining[0]?.id).toBe(firstDuplicateId);
    } finally {
      raw.close();
    }
  });

  it("v3 preflight: schema_migrations に version 3 が記録済みでも実インデックスが無い（import 由来DB）場合は preflight してから作成する（docs/contract.md §12.11-3）", () => {
    // import / 手動復旧により schema_migrations だけ version 3 まで記録されているが、
    // 実際の UNIQUE インデックスは存在しない汚染 DB を再現する。
    let firstDuplicateId = -1;
    const bootstrap = new Database(dbPath);
    try {
      bootstrap.exec(MIGRATION_V1_SQL_FOR_TEST);
      bootstrap.exec(MIGRATION_V2_SQL_FOR_TEST);
      const now = Math.floor(Date.now() / 1000);
      bootstrap.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)`).run(now);
      bootstrap.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)`).run(now);
      // version 3 の記録だけ存在し、実インデックス（idx_events_idem_unique）は作られていない状態
      bootstrap.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)`).run(now);

      bootstrap
        .prepare(`INSERT INTO tasks (id, title, tenant, created_at, updated_at) VALUES ('t_import', 'imp', 'dev', ?, ?)`)
        .run(now, now);

      const insertEvent = bootstrap.prepare(
        `INSERT INTO task_events (task_id, event_type, actor, payload, created_at) VALUES (?, 'message_processed', 'tester', ?, ?)`,
      );
      firstDuplicateId = Number(
        insertEvent.run("t_import", JSON.stringify({ idempotencyKey: "import-dup" }), now).lastInsertRowid,
      );
      insertEvent.run("t_import", JSON.stringify({ idempotencyKey: "import-dup" }), now + 1);

      expect(readIndexNames(dbPath)).not.toContain(EXPECTED_V3_INDEX_NAME);
    } finally {
      bootstrap.close();
    }

    // version 3 は記録済みだが実インデックスが無いため preflight が走り、制約違反なく成功すること
    expect(() => {
      const store = new SqliteKanbanStore(dbPath);
      store.close();
    }).not.toThrow();

    // schema_migrations に version 3 の重複INSERTは起きない（PRIMARY KEY違反にならず1行のまま）
    expect(readMigrationVersions(dbPath)).toEqual(EXPECTED_MIGRATION_VERSIONS);
    expect(readIndexNames(dbPath)).toContain(EXPECTED_V3_INDEX_NAME);

    const raw = new Database(dbPath, { readonly: true });
    try {
      const remaining = raw
        .prepare(
          `SELECT id FROM task_events WHERE event_type = 'message_processed'
           AND json_extract(payload, '$.idempotencyKey') = 'import-dup'`,
        )
        .all() as Array<{ id: number }>;
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe(firstDuplicateId);
    } finally {
      raw.close();
    }
  });

  it("生SQL で同一 idempotencyKey を持つ message_processed イベントを直接INSERTしようとするとUNIQUE制約で失敗する（docs/contract.md §12.9-1）", () => {
    const store = new SqliteKanbanStore(dbPath);
    const task = store.createTask({ title: "t", body: "", tenant: "dev" }, "tester");
    store.markMessageProcessed(task.id, "idem-raw-dup", "supervisor");
    store.close();

    const raw = new Database(dbPath);
    try {
      expect(() =>
        raw
          .prepare(
            `INSERT INTO task_events (task_id, event_type, actor, payload, created_at) VALUES (?, 'message_processed', ?, ?, ?)`,
          )
          .run(task.id, "attacker", JSON.stringify({ idempotencyKey: "idem-raw-dup" }), Math.floor(Date.now() / 1000)),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      raw.close();
    }
  });

  it("hasProcessedMessage が idx_events_idem インデックスと同じ（json_valid ガード付き）式インデックスを使用する（docs/contract.md §12.16-2）", () => {
    const store = new SqliteKanbanStore(dbPath);
    store.close();

    const raw = new Database(dbPath, { readonly: true });
    try {
      // db.ts の IDEMPOTENCY_KEY_EXPR と完全一致させる（式インデックスはテキスト一致でのみ最適化に使われる）
      const plan = raw
        .prepare(
          `EXPLAIN QUERY PLAN SELECT 1 AS found FROM task_events
           WHERE event_type = 'message_processed' AND ${IDEMPOTENCY_KEY_EXPR_FOR_TEST} = 'x'
           LIMIT 1`,
        )
        .all();
      expect(JSON.stringify(plan)).toContain("idx_events_idem");
    } finally {
      raw.close();
    }
  });

  it("malformed payload の message_processed 行が既に存在する新規DB（v1のみ）を開いても throw せず、v1〜v7 が一括適用され malformed 行が隔離される（docs/contract.md §12.16-2/§43.1/§44.1）", () => {
    // 「hachi-agent kanban CLI patch」等、SqliteKanbanStore を経由しない raw SQL による書込で
    // 不正な JSON payload を持つ message_processed 行が v1 スキーマのみの DB に混入した状態を再現する。
    // v2/v3 の式インデックス作成（json_extract の生評価）はこの malformed 行1件でも例外化しうるため、
    // v1〜v7 の一括適用が例外を投げず成功することを確認する。
    const bootstrap = new Database(dbPath);
    try {
      bootstrap.exec(MIGRATION_V1_SQL_FOR_TEST);
      const now = Math.floor(Date.now() / 1000);
      bootstrap
        .prepare(`INSERT INTO tasks (id, title, tenant, created_at, updated_at) VALUES ('t_malformed', 'm', 'dev', ?, ?)`)
        .run(now, now);
      bootstrap
        .prepare(
          `INSERT INTO task_events (task_id, event_type, actor, payload, created_at) VALUES (?, 'message_processed', 'tester', ?, ?)`,
        )
        .run("t_malformed", "not valid json {{{", now);
    } finally {
      bootstrap.close();
    }

    expect(() => {
      const store = new SqliteKanbanStore(dbPath);
      store.close();
    }).not.toThrow();

    expect(readMigrationVersions(dbPath)).toEqual(EXPECTED_MIGRATION_VERSIONS);
    const indexNames = readIndexNames(dbPath);
    expect(indexNames).toContain(EXPECTED_V3_INDEX_NAME);

    const raw = new Database(dbPath, { readonly: true });
    try {
      const events = raw
        .prepare(`SELECT event_type, payload FROM task_events WHERE task_id = 't_malformed'`)
        .all() as Array<{ event_type: string; payload: string }>;
      // 削除せず event_type を付替して隔離する（監査を残す）
      expect(events).toEqual([{ event_type: "message_processed_malformed", payload: "not valid json {{{" }]);
    } finally {
      raw.close();
    }

    const reopened = new SqliteKanbanStore(dbPath);
    try {
      expect(reopened.hasProcessedMessage("anything")).toBe(false);
    } finally {
      reopened.close();
    }
  });

  it("v4 未適用（旧・ガード無し式インデックス）の既存DBを開くと、インデックスが DROP→再 CREATE されガード付きへ更新される（docs/contract.md §12.16-2）", () => {
    // §12.16-2 修正前の状態（v1〜v3 が旧式・ガード無しで適用済み、かつ有効な message_processed 行が
    // 既に存在する）を再現する。旧インデックスが存在する間は malformed payload 行を書き込めない
    // （CREATE INDEX / INSERT いずれも式評価で即例外化するため、旧インデックスと malformed 行は
    // 同時に構築できない）。malformed 行の混入は「ガード付きへ更新された後」に別途検証する。
    const bootstrap = new Database(dbPath);
    try {
      bootstrap.exec(MIGRATION_V1_SQL_FOR_TEST);
      const now = Math.floor(Date.now() / 1000);
      bootstrap
        .prepare(`INSERT INTO tasks (id, title, tenant, created_at, updated_at) VALUES ('t_legacy', 'l', 'dev', ?, ?)`)
        .run(now, now);
      bootstrap
        .prepare(
          `INSERT INTO task_events (task_id, event_type, actor, payload, created_at) VALUES (?, 'message_processed', 'tester', ?, ?)`,
        )
        .run("t_legacy", JSON.stringify({ idempotencyKey: "legacy-key" }), now);

      bootstrap.exec(LEGACY_UNGUARDED_V2_SQL_FOR_TEST);
      bootstrap.exec(LEGACY_UNGUARDED_V3_SQL_FOR_TEST);
      bootstrap.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)`).run(now);
      bootstrap.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)`).run(now);
      bootstrap.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)`).run(now);
    } finally {
      bootstrap.close();
    }

    // 再オープン前は旧・ガード無し式インデックスのまま
    const beforeSql = new Database(dbPath, { readonly: true })
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_idem'`)
      .get() as { sql: string };
    expect(beforeSql.sql).not.toContain("json_valid");

    expect(() => {
      const store = new SqliteKanbanStore(dbPath);
      store.close();
    }).not.toThrow();

    expect(readMigrationVersions(dbPath)).toEqual(EXPECTED_MIGRATION_VERSIONS);

    const raw = new Database(dbPath, { readonly: true });
    try {
      // 両インデックスとも DROP→再 CREATE によりガード付きの新式へ更新されている
      const idemSql = raw
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_idem'`)
        .get() as { sql: string };
      const uniqueSql = raw
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_idem_unique'`)
        .get() as { sql: string };
      expect(idemSql.sql).toContain("json_valid");
      expect(uniqueSql.sql).toContain("json_valid");

      // 既存の有効な行は失われず保持される
      const events = raw
        .prepare(`SELECT event_type, payload FROM task_events WHERE task_id = 't_legacy' ORDER BY id ASC`)
        .all() as Array<{ event_type: string; payload: string }>;
      expect(events).toEqual([
        { event_type: "message_processed", payload: JSON.stringify({ idempotencyKey: "legacy-key" }) },
      ]);
    } finally {
      raw.close();
    }

    const reopened = new SqliteKanbanStore(dbPath);
    expect(reopened.hasProcessedMessage("legacy-key")).toBe(true);
    reopened.close();

    // ガード付きへ更新された後は、raw SQL による malformed payload 行の書込自体が例外化しなくなる
    // （§12.16-2 が解消する本体の問題）。挿入後、次回オープンで隔離されることも併せて確認する。
    const rawWrite = new Database(dbPath);
    try {
      expect(() =>
        rawWrite
          .prepare(
            `INSERT INTO task_events (task_id, event_type, actor, payload, created_at) VALUES ('t_legacy', 'message_processed', 'attacker', ?, ?)`,
          )
          .run("post-guard garbage", Math.floor(Date.now() / 1000)),
      ).not.toThrow();
    } finally {
      rawWrite.close();
    }

    const finalReopen = new SqliteKanbanStore(dbPath);
    finalReopen.close();

    const finalCheck = new Database(dbPath, { readonly: true });
    try {
      const events = finalCheck
        .prepare(`SELECT event_type, payload FROM task_events WHERE task_id = 't_legacy' ORDER BY id ASC`)
        .all() as Array<{ event_type: string; payload: string }>;
      expect(events).toEqual([
        { event_type: "message_processed", payload: JSON.stringify({ idempotencyKey: "legacy-key" }) },
        { event_type: "message_processed_malformed", payload: "post-guard garbage" },
      ]);
    } finally {
      finalCheck.close();
    }
  });

  it("完全移行済みDBへ再オープン後に raw SQL で新規混入した malformed 行も、次回オープンで隔離される（docs/contract.md §12.16-2）", () => {
    const store = new SqliteKanbanStore(dbPath);
    const task = store.createTask({ title: "t", body: "", tenant: "dev" }, "tester");
    store.close();

    // ガード付きインデックスが既に存在するため、malformed payload の raw INSERT 自体は例外化しない
    const raw = new Database(dbPath);
    try {
      expect(() =>
        raw
          .prepare(
            `INSERT INTO task_events (task_id, event_type, actor, payload, created_at) VALUES (?, 'message_processed', 'attacker', ?, ?)`,
          )
          .run(task.id, "fresh garbage", Math.floor(Date.now() / 1000)),
      ).not.toThrow();
    } finally {
      raw.close();
    }

    // 再オープンのたびに隔離処理が走るため、v4 適用済み後に混入した行も隔離される
    const reopened = new SqliteKanbanStore(dbPath);
    reopened.close();

    const check = new Database(dbPath, { readonly: true });
    try {
      const events = check
        .prepare(`SELECT event_type, payload FROM task_events WHERE task_id = ? AND payload = 'fresh garbage'`)
        .all(task.id) as Array<{ event_type: string; payload: string }>;
      expect(events).toEqual([{ event_type: "message_processed_malformed", payload: "fresh garbage" }]);
    } finally {
      check.close();
    }
  });

  it("hasProcessedMessage は malformed payload の message_processed 行があっても throw せず false を返す（docs/contract.md §12.16-2）", () => {
    const store = new SqliteKanbanStore(dbPath);
    const task = store.createTask({ title: "t", body: "", tenant: "dev" }, "tester");
    store.markMessageProcessed(task.id, "valid-key", "supervisor");

    const raw = new Database(dbPath);
    try {
      raw
        .prepare(
          `INSERT INTO task_events (task_id, event_type, actor, payload, created_at) VALUES (?, 'message_processed', 'attacker', ?, ?)`,
        )
        .run(task.id, "totally not json", Math.floor(Date.now() / 1000));
    } finally {
      raw.close();
    }

    expect(() => store.hasProcessedMessage("valid-key")).not.toThrow();
    expect(store.hasProcessedMessage("valid-key")).toBe(true);
    expect(() => store.hasProcessedMessage("nonexistent")).not.toThrow();
    expect(store.hasProcessedMessage("nonexistent")).toBe(false);

    store.close();
  });

  it("migration v23 はprovider session source・successor slot・owner-only capability・partial UNIQUEを冪等に自己修復する", () => {
    const store = new SqliteKanbanStore(dbPath);
    store.close();

    const raw = new Database(dbPath);
    try {
      raw.exec(`DROP INDEX idx_orchestrator_successor_blocking`);
      raw.exec(`DROP INDEX idx_orchestrator_successor_provider_session`);
      raw.exec(
        `CREATE INDEX idx_orchestrator_successor_blocking
         ON orchestrator_successor_launches(status)`,
      );
      raw.exec(
        `CREATE UNIQUE INDEX idx_orchestrator_successor_provider_session
         ON orchestrator_successor_launches(provider_session_id)
         WHERE provider_session_id <> ''`,
      );
      raw.exec(`DROP TABLE orchestrator_successor_launch_capabilities`);
    } finally {
      raw.close();
    }

    const reopened = new SqliteKanbanStore(dbPath);
    reopened.close();
    expect(readMigrationVersions(dbPath)).toEqual(EXPECTED_MIGRATION_VERSIONS);
    expect(readTableColumns(dbPath, "orchestrator_sessions")).toContain("provider_session_source");
    expect(readTableColumns(dbPath, "orchestrator_successor_launches")).toContain("stop_fence_hash");
    expect(readTableColumns(dbPath, "orchestrator_successor_launch_capabilities")).toEqual([
      "launch_id",
      "attestation_handle",
      "accept_fence",
      "stop_fence",
    ]);
    expect(readIndexNames(dbPath)).toEqual(expect.arrayContaining([
      "idx_orchestrator_successor_blocking",
      "idx_orchestrator_successor_runtime",
      "idx_orchestrator_successor_provider_session",
    ]));
    const repaired = new Database(dbPath, { readonly: true });
    try {
      expect(repaired.prepare(`PRAGMA index_info(idx_orchestrator_successor_blocking)`).all()).toMatchObject([
        { name: "orchestrator_id" },
      ]);
      expect(repaired.prepare(`PRAGMA index_info(idx_orchestrator_successor_provider_session)`).all()).toMatchObject([
        { name: "target_provider" },
        { name: "provider_session_id" },
      ]);
      const definitions = repaired.prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'index' AND name IN (
           'idx_orchestrator_successor_blocking', 'idx_orchestrator_successor_provider_session'
         ) ORDER BY name`,
      ).all() as Array<{ name: string; sql: string }>;
      expect(definitions).toEqual([
        expect.objectContaining({
          name: "idx_orchestrator_successor_blocking",
          sql: expect.stringContaining("WHERE status IN ('armed', 'runtime_bound', 'attested', 'accepting', 'stop_pending', 'uncertain')"),
        }),
        expect.objectContaining({
          name: "idx_orchestrator_successor_provider_session",
          sql: expect.stringContaining("ON orchestrator_successor_launches(target_provider, provider_session_id)"),
        }),
      ]);
    } finally {
      repaired.close();
    }
  });

  it("migration v23 はデータ入りpartial successor schemaを推測修復せずfail-closedにする", () => {
    const store = new SqliteKanbanStore(dbPath);
    store.close();
    const raw = new Database(dbPath);
    try {
      raw.exec(`DROP TABLE orchestrator_successor_launch_capabilities`);
      raw.exec(`DROP TABLE orchestrator_successor_launches`);
      raw.exec(`CREATE TABLE orchestrator_successor_launches (id TEXT PRIMARY KEY)`);
      raw.prepare(`INSERT INTO orchestrator_successor_launches (id) VALUES ('partial')`).run();
    } finally {
      raw.close();
    }
    expect(() => new SqliteKanbanStore(dbPath)).toThrow("既存行schemaが不完全");
  });

  it("migration v23 は全columnがあってもconstraint/FK/default欠落をshape不一致として扱う", () => {
    const first = new SqliteKanbanStore(dbPath);
    first.close();
    const raw = new Database(dbPath);
    try {
      raw.exec(`
        DROP TABLE orchestrator_successor_launch_capabilities;
        CREATE TABLE malformed_successor_launches AS
          SELECT * FROM orchestrator_successor_launches WHERE 0;
        DROP TABLE orchestrator_successor_launches;
        ALTER TABLE malformed_successor_launches RENAME TO orchestrator_successor_launches;
      `);
    } finally {
      raw.close();
    }

    const repaired = new SqliteKanbanStore(dbPath);
    repaired.close();
    const checked = new Database(dbPath, { readonly: true });
    try {
      const definition = checked.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orchestrator_successor_launches'`,
      ).get() as { sql: string };
      expect(definition.sql).toContain("CHECK(status IN ('armed', 'runtime_bound'");
      expect(checked.prepare(`PRAGMA foreign_key_list(orchestrator_successor_launches)`).all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: "orchestrator_id", table: "orchestrators", to: "id" }),
          expect.objectContaining({ from: "source_session_id", table: "orchestrator_sessions", to: "id" }),
        ]),
      );
    } finally {
      checked.close();
    }
  });

  it("migration v23 はlaunch欠落時の空orphan capability tableを再構築する", () => {
    const first = new SqliteKanbanStore(dbPath);
    first.close();
    const raw = new Database(dbPath);
    try {
      raw.exec(`
        DROP TABLE orchestrator_successor_launch_capabilities;
        DROP TABLE orchestrator_successor_launches;
        CREATE TABLE orchestrator_successor_launch_capabilities (wrong_column TEXT);
      `);
    } finally {
      raw.close();
    }

    const repaired = new SqliteKanbanStore(dbPath);
    repaired.close();
    expect(readTableColumns(dbPath, "orchestrator_successor_launch_capabilities")).toEqual([
      "launch_id",
      "attestation_handle",
      "accept_fence",
      "stop_fence",
    ]);
    expect(readTableColumns(dbPath, "orchestrator_successor_launches")).toContain("runtime_ownership_claimed");
  });

  it("migration v23 は全columnの不正shapeに既存行があればfail-closedにする", () => {
    const first = new SqliteKanbanStore(dbPath);
    first.close();
    const raw = new Database(dbPath);
    try {
      raw.exec(`
        DROP TABLE orchestrator_successor_launch_capabilities;
        CREATE TABLE malformed_successor_launches AS
          SELECT * FROM orchestrator_successor_launches WHERE 0;
        DROP TABLE orchestrator_successor_launches;
        ALTER TABLE malformed_successor_launches RENAME TO orchestrator_successor_launches;
      `);
      raw.prepare(`INSERT INTO orchestrator_successor_launches (id) VALUES ('malformed')`).run();
    } finally {
      raw.close();
    }

    expect(() => new SqliteKanbanStore(dbPath)).toThrow("既存行schemaが不完全");
  });

  it("migration v25 はv24事故rowのterminal claimだけ解放し、legacy lifetimeとuncertain停止証拠を保持して冪等に再openする", () => {
    const first = new SqliteKanbanStore(dbPath);
    const now = Math.floor(Date.now() / 1000);
    const armSlot = (suffix: string): string => {
      const orchestrator = first.registerOrchestrator({
        label: `migration-v25-${suffix}`,
        project: "hachi-kanban",
        repoCommonDir: `/repo/migration-v25-${suffix}/.git`,
      });
      const source = first.startOrchestratorSession({ orchestratorId: orchestrator.id });
      return first.armSuccessorLaunch({
        orchestratorId: orchestrator.id,
        targetProvider: "codex",
        sourceSessionId: source.id,
        sourceGeneration: source.generation,
        canonicalCwd: `/repo/migration-v25-${suffix}`,
        hostId: `host-migration-v25-${suffix}`,
        launchNonceHash: "1".repeat(64),
        plannedTmuxSession: `tmux-migration-v25-${suffix}`,
        hookDefinitionHash: "2".repeat(64),
        hookExecutableHash: "3".repeat(64),
        runtimeDeadlineAt: now + 60,
        attestationDeadlineAt: now + 120,
        kind: "handoff",
        handoffTokenFenceHash: "4".repeat(64),
        handoffExpiresAt: now + 120,
        now,
      }).id;
    };
    const terminalId = armSlot("terminal");
    const uncertainId = armSlot("uncertain");
    first.close();

    const legacy = new Database(dbPath);
    try {
      legacy.prepare(
        `UPDATE orchestrator_successor_launches
         SET status = 'succeeded', observed_host_id = 'legacy-terminal-host', tmux_session = planned_tmux_session,
             tmux_pane = '%71', pane_pid = 17001, process_group_id = 18001,
             owner_nonce_hash = ?, runtime_ownership_claimed = 1, revision = 7, terminal_at = ?,
             stop_owner_matched = 1, stop_owner_readback_at = 101,
             stop_kill_result = 'succeeded', stop_tmux_session_absent = 1,
             stop_pane_pid_absent = 1, stop_process_group_absent = 1, stop_observed_at = 102
         WHERE id = ?`,
      ).run("a".repeat(64), now, terminalId);
      legacy.prepare(
        `UPDATE orchestrator_successor_launches
         SET status = 'uncertain', observed_host_id = 'legacy-uncertain-host', tmux_session = planned_tmux_session,
             tmux_pane = '%72', pane_pid = 27001, process_group_id = 28001,
             owner_nonce_hash = ?, kill_owner_readback_hash = ?, runtime_ownership_claimed = 0,
             revision = 9, last_error = 'legacy uncertain', stop_owner_matched = 1,
             stop_owner_readback_at = 201, stop_kill_result = 'unknown',
             stop_tmux_session_absent = 1, stop_pane_pid_absent = 1,
             stop_process_group_absent = 0, stop_observed_at = 202
         WHERE id = ?`,
      ).run("b".repeat(64), "b".repeat(64), uncertainId);
      legacy.exec(`
        DELETE FROM schema_migrations WHERE version = 25;
        DROP INDEX idx_orchestrator_successor_runtime;
        ALTER TABLE orchestrator_successor_launches DROP COLUMN tmux_socket_path;
        ALTER TABLE orchestrator_successor_launches DROP COLUMN tmux_server_pid;
        ALTER TABLE orchestrator_successor_launches DROP COLUMN tmux_server_start_time;
        ALTER TABLE orchestrator_successor_launches DROP COLUMN tmux_server_lifetime_hash;
        CREATE UNIQUE INDEX idx_orchestrator_successor_runtime
          ON orchestrator_successor_launches(observed_host_id, tmux_pane)
          WHERE runtime_ownership_claimed = 1 AND observed_host_id <> '' AND tmux_pane <> ''
            AND status IN ('runtime_bound', 'attested', 'accepting', 'succeeded', 'stop_pending', 'uncertain');
      `);
    } finally {
      legacy.close();
    }

    const migrated = new SqliteKanbanStore(dbPath);
    expect(migrated.getSuccessorLaunch(terminalId)).toMatchObject({
      status: "succeeded",
      revision: 7,
      runtimeOwnershipClaimed: false,
      tmuxSocketPath: "",
      tmuxServerPid: null,
      tmuxServerStartTime: null,
      tmuxServerLifetimeHash: "",
      stopEvidence: {
        ownerMatched: true,
        ownerReadbackAt: 101,
        killResult: "succeeded",
        tmuxSessionAbsent: true,
        panePidAbsent: true,
        processGroupAbsent: true,
        observedAt: 102,
      },
    });
    expect(migrated.getSuccessorLaunch(uncertainId)).toMatchObject({
      status: "uncertain",
      revision: 9,
      runtimeOwnershipClaimed: false,
      tmuxSocketPath: "",
      tmuxServerLifetimeHash: "",
      lastError: "legacy uncertain",
      stopEvidence: {
        ownerMatched: true,
        ownerReadbackAt: 201,
        killResult: "unknown",
        tmuxSessionAbsent: true,
        panePidAbsent: true,
        processGroupAbsent: false,
        observedAt: 202,
      },
    });
    migrated.close();
    expect(readMigrationVersions(dbPath)).toEqual(EXPECTED_MIGRATION_VERSIONS);

    const checked = new Database(dbPath, { readonly: true });
    try {
      expect(checked.prepare(`PRAGMA index_info(idx_orchestrator_successor_runtime)`).all()).toMatchObject([
        { name: "observed_host_id" },
        { name: "tmux_socket_path" },
        { name: "tmux_server_lifetime_hash" },
        { name: "tmux_pane" },
      ]);
      const definition = checked.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_orchestrator_successor_runtime'`,
      ).get() as { sql: string };
      expect(definition.sql).not.toContain("'succeeded'");
      expect(definition.sql).toContain("tmux_server_lifetime_hash <> ''");
    } finally {
      checked.close();
    }

    const reopened = new SqliteKanbanStore(dbPath);
    expect(reopened.getSuccessorLaunch(uncertainId)).toMatchObject({
      status: "uncertain",
      revision: 9,
      runtimeOwnershipClaimed: false,
    });
    reopened.close();
  });

  it("migration v25 はruntime identity列の部分適用を推測修復せずfail-closedにする", () => {
    const first = new SqliteKanbanStore(dbPath);
    first.close();
    const raw = new Database(dbPath);
    try {
      raw.exec(`
        DELETE FROM schema_migrations WHERE version = 25;
        DROP INDEX idx_orchestrator_successor_runtime;
        ALTER TABLE orchestrator_successor_launches DROP COLUMN tmux_server_pid;
        ALTER TABLE orchestrator_successor_launches DROP COLUMN tmux_server_start_time;
        ALTER TABLE orchestrator_successor_launches DROP COLUMN tmux_server_lifetime_hash;
        CREATE UNIQUE INDEX idx_orchestrator_successor_runtime
          ON orchestrator_successor_launches(observed_host_id, tmux_pane)
          WHERE runtime_ownership_claimed = 1 AND observed_host_id <> '' AND tmux_pane <> ''
            AND status IN ('runtime_bound', 'attested', 'accepting', 'succeeded', 'stop_pending', 'uncertain');
      `);
    } finally {
      raw.close();
    }
    expect(() => new SqliteKanbanStore(dbPath)).toThrow("runtime identity列が部分適用");
  });

  it("migration v25 は記録済みruntime authority indexの破損を自動再作成せずfail-closedにする", () => {
    const first = new SqliteKanbanStore(dbPath);
    first.close();
    const raw = new Database(dbPath);
    try {
      raw.exec(`
        DROP INDEX idx_orchestrator_successor_runtime;
        CREATE UNIQUE INDEX idx_orchestrator_successor_runtime
          ON orchestrator_successor_launches(observed_host_id, tmux_pane)
          WHERE runtime_ownership_claimed = 1 AND observed_host_id <> '' AND tmux_pane <> '';
      `);
    } finally {
      raw.close();
    }
    expect(() => new SqliteKanbanStore(dbPath)).toThrow("runtime authority indexが欠落または不正");
  });
});

describe("relay delivery uncertain persistence と ownership projection（契約 §78.5.1 / §78.8）", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteKanbanStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hachi-relay-persistence-test-"));
    dbPath = join(tempDir, "kanban.db");
    store = new SqliteKanbanStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function validInput(
    overrides: Partial<RelayDeliveryUncertainRecordInput> = {},
  ): RelayDeliveryUncertainRecordInput {
    return {
      sessionId: "session-a",
      handoverGeneration: 7,
      relayId: "relay-a",
      fencingToken: 3,
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

  describe("recordRelayDeliveryUncertain", () => {
    it("初回は recorded:true, duplicate:false を返し、全列を保持する", () => {
      const result = store.recordRelayDeliveryUncertain(validInput());
      expect(result).toEqual({ recorded: true, duplicate: false });

      const view = createKanbanReadView(dbPath);
      try {
        expect(view.relayDeliveryUncertainEvent("session-a", "event-a")).toMatchObject({
          sessionId: "session-a",
          handoverGeneration: 7,
          relayId: "relay-a",
          fencingToken: 3,
          eventId: "event-a",
          observedAt: 1_700_000_000,
          reason: "sending_remnant",
          provider: "codex",
          host: "host-a",
          evenTerminalBootEpoch: "boot-a",
          canonicalServerUrl: "http://127.0.0.1:3456",
        });
      } finally {
        view.close();
      }
    });

    it("同じ (sessionId, eventId) の再報告は duplicate:true になり、初回記録を一切更新しない", () => {
      store.recordRelayDeliveryUncertain(validInput());
      const second = store.recordRelayDeliveryUncertain(
        validInput({
          handoverGeneration: 99,
          relayId: "relay-b",
          fencingToken: 999,
          observedAt: 1_800_000_000,
          host: "host-b",
          evenTerminalBootEpoch: "boot-b",
          canonicalServerUrl: "http://127.0.0.1:9999",
        }),
      );
      expect(second).toEqual({ recorded: true, duplicate: true });

      const view = createKanbanReadView(dbPath);
      try {
        expect(view.relayDeliveryUncertainEvent("session-a", "event-a")).toMatchObject({
          handoverGeneration: 7,
          relayId: "relay-a",
          fencingToken: 3,
          observedAt: 1_700_000_000,
          host: "host-a",
          evenTerminalBootEpoch: "boot-a",
          canonicalServerUrl: "http://127.0.0.1:3456",
        });
      } finally {
        view.close();
      }
    });

    it("session_id/event_id が大文字小文字違いなら独立した行として記録する（BINARY 比較）", () => {
      expect(store.recordRelayDeliveryUncertain(validInput({ sessionId: "Session-A" }))).toEqual({
        recorded: true,
        duplicate: false,
      });
      expect(store.recordRelayDeliveryUncertain(validInput({ sessionId: "session-a" }))).toEqual({
        recorded: true,
        duplicate: false,
      });
      expect(store.recordRelayDeliveryUncertain(validInput({ eventId: "Event-A" }))).toEqual({
        recorded: true,
        duplicate: false,
      });
    });

    it("Store の再 open 後も既存記録を保持し、新規記録も引き続き機能する", () => {
      store.recordRelayDeliveryUncertain(validInput());
      store.close();

      store = new SqliteKanbanStore(dbPath);
      expect(store.recordRelayDeliveryUncertain(validInput())).toEqual({ recorded: true, duplicate: true });
      expect(store.recordRelayDeliveryUncertain(validInput({ eventId: "event-b" }))).toEqual({
        recorded: true,
        duplicate: false,
      });
    });

    it("複数 connection からの同一 key 競合も duplicate として収束する", () => {
      const other = new SqliteKanbanStore(dbPath);
      try {
        expect(store.recordRelayDeliveryUncertain(validInput())).toEqual({ recorded: true, duplicate: false });
        expect(
          other.recordRelayDeliveryUncertain(validInput({ handoverGeneration: 42, fencingToken: 42 })),
        ).toEqual({ recorded: true, duplicate: true });
      } finally {
        other.close();
      }
    });

    it("閉じた接続への呼び出しは DB 障害として throw する", () => {
      store.close();
      expect(() => store.recordRelayDeliveryUncertain(validInput())).toThrow();
    });

    it("(session_id, event_id) 以外の制約違反は duplicate 成功へ読み替えず throw する", () => {
      const raw = new Database(dbPath);
      try {
        raw.exec(`
          CREATE TRIGGER reject_relay_delivery_uncertain
          BEFORE INSERT ON relay_delivery_uncertain_events
          BEGIN
            SELECT RAISE(ABORT, 'injected constraint failure');
          END;
        `);
      } finally {
        raw.close();
      }

      expect(() => store.recordRelayDeliveryUncertain(validInput())).toThrow();

      const view = createKanbanReadView(dbPath);
      try {
        expect(view.relayDeliveryUncertainEvents()).toEqual([]);
      } finally {
        view.close();
      }
    });

    it.each([
      ["sessionId 空", { sessionId: "" }],
      ["reason 未知", { reason: "other" as never }],
      ["provider 未知", { provider: "gpt" as never }],
      ["canonicalServerUrl 非canonical", { canonicalServerUrl: "http://127.0.0.1:3456/" }],
    ])("%s は throw し、記録しない", (_label, overrides) => {
      expect(() => store.recordRelayDeliveryUncertain(validInput(overrides))).toThrow();
      const view = createKanbanReadView(dbPath);
      try {
        expect(view.relayDeliveryUncertainEvents()).toEqual([]);
      } finally {
        view.close();
      }
    });

    it.each([
      ["fencing_token 小数", { fencing_token: 1.5 }],
      ["fencing_token safe-integer上限超過", { fencing_token: Number.MAX_SAFE_INTEGER + 1 }],
      ["handover_generation 小数", { handover_generation: 1.5 }],
      ["handover_generation safe-integer上限超過", { handover_generation: Number.MAX_SAFE_INTEGER + 1 }],
      ["observed_at 小数", { observed_at: 1.5 }],
      ["observed_at safe-integer上限超過", { observed_at: Number.MAX_SAFE_INTEGER + 1 }],
    ] as const)(
      "schema level: Store の JS 検証を経由せず生SQLで直接INSERTしても %s は CHECK 制約で拒否される",
      (_label, overrides) => {
        const raw = new Database(dbPath);
        try {
          const columns = {
            session_id: "session-raw",
            event_id: "event-raw",
            handover_generation: 7,
            relay_id: "relay-raw",
            fencing_token: 3,
            reason: "sending_remnant",
            observed_at: 1_700_000_000,
            provider: "codex",
            host: "host-raw",
            even_terminal_boot_epoch: "boot-raw",
            canonical_server_url: "http://127.0.0.1:3456",
            recorded_at: 1_700_000_000,
            ...overrides,
          };
          expect(() =>
            raw
              .prepare(
                `INSERT INTO relay_delivery_uncertain_events
                   (session_id, event_id, handover_generation, relay_id, fencing_token, reason,
                    observed_at, provider, host, even_terminal_boot_epoch, canonical_server_url, recorded_at)
                 VALUES (@session_id, @event_id, @handover_generation, @relay_id, @fencing_token, @reason,
                         @observed_at, @provider, @host, @even_terminal_boot_epoch, @canonical_server_url, @recorded_at)`,
              )
              .run(columns),
          ).toThrow(/CHECK constraint failed/);
        } finally {
          raw.close();
        }
      },
    );
  });

  describe("lookupRelaySessionOwnership", () => {
    function taskWithRun(sessionId: string, provider: "codex" | "claude", meta: Record<string, unknown>): number {
      const task = store.createTask({ title: "t", body: "", tenant: "dev" }, "tester");
      return store.startRun(task.id, provider, sessionId, meta).id;
    }

    it("行が無ければ空配列を返す", () => {
      expect(store.lookupRelaySessionOwnership("no-such-session")).toEqual([]);
    });

    it("provider/transport/serverUrl 不一致・direct・異status を含め全行を返す（status filter/LIMIT/dedupe をしない）", () => {
      taskWithRun("session-a", "codex", { transport: "bridge", serverUrl: "http://127.0.0.1:3456" });
      taskWithRun("session-a", "claude", { transport: "bridge", serverUrl: "http://127.0.0.1:3456" });
      taskWithRun("session-a", "codex", { transport: "bridge", serverUrl: "http://127.0.0.1:9999" });
      taskWithRun("session-a", "codex", { transport: "direct", serverUrl: "direct" });
      const endedRunId = taskWithRun("session-a", "codex", {
        transport: "bridge",
        serverUrl: "http://127.0.0.1:3456",
      });
      store.endRun(endedRunId, "done");

      const result = store.lookupRelaySessionOwnership("session-a");
      expect(result).toEqual([
        { provider: "codex", transport: "bridge", serverUrl: "http://127.0.0.1:3456" },
        { provider: "claude", transport: "bridge", serverUrl: "http://127.0.0.1:3456" },
        { provider: "codex", transport: "bridge", serverUrl: "http://127.0.0.1:9999" },
        { provider: "codex", transport: "direct", serverUrl: "direct" },
        { provider: "codex", transport: "bridge", serverUrl: "http://127.0.0.1:3456" },
      ]);
    });

    it("session_id は BINARY 完全一致のみ（大文字小文字を混同しない）", () => {
      taskWithRun("session-a", "codex", { transport: "bridge", serverUrl: "http://127.0.0.1:3456" });
      expect(store.lookupRelaySessionOwnership("Session-A")).toEqual([]);
    });

    it("meta が malformed な行が1つでもあれば lookup 全体を throw する", () => {
      taskWithRun("session-a", "codex", { transport: "bridge", serverUrl: "http://127.0.0.1:3456" });
      const runId = taskWithRun("session-a", "codex", {
        transport: "bridge",
        serverUrl: "http://127.0.0.1:3456",
      });
      const raw = new Database(dbPath);
      try {
        raw.prepare(`UPDATE task_runs SET meta = ? WHERE id = ?`).run("not json", runId);
      } finally {
        raw.close();
      }
      expect(() => store.lookupRelaySessionOwnership("session-a")).toThrow();
    });
  });
});
