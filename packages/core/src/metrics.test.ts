import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import { MetricsReader } from "./metrics.js";
import type { ActorProvenance, Provider, TaskStatus } from "./types.js";

interface TaskFixture {
  id: string;
  status?: TaskStatus;
  tenant?: string;
  profile?: string;
  createdAt: number;
}

function epoch(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function insertTask(db: Database.Database, fixture: TaskFixture): void {
  db.prepare(
    `INSERT INTO tasks (id, title, body, status, tenant, profile, created_at, updated_at)
     VALUES (?, ?, '', ?, ?, ?, ?, ?)`,
  ).run(
    fixture.id,
    fixture.id,
    fixture.status ?? "ready",
    fixture.tenant ?? "dev",
    fixture.profile ?? "",
    fixture.createdAt,
    fixture.createdAt,
  );
}

function insertEvent(
  db: Database.Database,
  taskId: string,
  eventType: string,
  payload: Record<string, unknown>,
  createdAt: number,
  provenance?: ActorProvenance,
): void {
  const actorProvenance = provenance ?? {
    kind: "unknown",
    actorId: "",
    actorSessionId: "",
    actorGeneration: null,
  };
  db.prepare(
    `INSERT INTO task_events (
       task_id, event_type, actor, payload, created_at,
       actor_kind, actor_id, actor_session_id, actor_generation
     ) VALUES (?, ?, 'tester', ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    eventType,
    JSON.stringify(payload),
    createdAt,
    actorProvenance.kind,
    actorProvenance.actorId,
    actorProvenance.actorSessionId,
    actorProvenance.actorGeneration,
  );
}

function insertRawEvent(
  db: Database.Database,
  taskId: string,
  eventType: string,
  payload: string,
  createdAt: number,
): void {
  db.prepare(
    `INSERT INTO task_events (task_id, event_type, actor, payload, created_at)
     VALUES (?, ?, 'untrusted-display', ?, ?)`,
  ).run(taskId, eventType, payload, createdAt);
}

function insertRun(
  db: Database.Database,
  taskId: string,
  provider: Provider,
  status: "done" | "failed" | "running",
  costUsd: number,
  startedAt: number,
): void {
  const endedAt = status === "running" ? null : startedAt + 30;
  db.prepare(
    `INSERT INTO task_runs (task_id, provider, session_id, status, meta, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    provider,
    `sess-${taskId}`,
    status,
    JSON.stringify({ lastResult: { costUsd } }),
    startedAt,
    endedAt,
  );
}

describe("MetricsReader", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hachi-core-metrics-test-"));
    dbPath = join(tempDir, "kanban.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("tick_metrics を重複を落とさず記録し、90日超の行を pruning する", () => {
    const now = 1_800_000_000;
    const oldTs = now - 90 * 24 * 60 * 60 - 1;
    const store = new SqliteKanbanStore(dbPath);
    try {
      store.recordTickMetrics([{ stage: "dispatch", actions: 9, durationMs: 1 }], oldTs);
      store.recordTickMetrics([{ stage: "dispatch", actions: 1, durationMs: 5 }], now);
      store.recordTickMetrics([{ stage: "dispatch", actions: 2, durationMs: 6 }], now);
    } finally {
      store.close();
    }

    const reader = new MetricsReader(dbPath);
    try {
      const rows = reader.query(now - 90 * 24 * 60 * 60, now).tickMetrics;
      expect(rows.map((row) => row.actions).sort((a, b) => a - b)).toEqual([1, 2]);
      expect(rows.some((row) => row.actions === 9)).toBe(false);
    } finally {
      reader.close();
    }
  });

  it("task_events/task_runs/tick_metrics から §43.2 の集計を返す", () => {
    const from = epoch("2026-07-01T00:00:00+09:00");
    const to = epoch("2026-07-08T00:00:00+09:00");
    const doneAt1 = epoch("2026-07-01T10:00:00+09:00");
    const doneAt2 = epoch("2026-07-02T11:00:00+09:00");
    const queueEnter = epoch("2026-07-03T09:00:00+09:00");
    const openQueueEnter = epoch("2026-07-04T09:00:00+09:00");

    const migrated = new SqliteKanbanStore(dbPath);
    migrated.close();

    const db = new Database(dbPath);
    try {
      insertTask(db, { id: "t_0000000000000001", profile: "implement", createdAt: from });
      insertTask(db, { id: "t_0000000000000002", profile: "review", createdAt: from });
      insertTask(db, { id: "t_0000000000000003", profile: "implement", createdAt: from });
      insertTask(db, { id: "t_0000000000000004", profile: "docs", createdAt: from });

      insertEvent(db, "t_0000000000000001", "finalized", { from: "blocked", to: "done" }, doneAt1);
      insertEvent(db, "t_0000000000000002", "verdict_finalized", { from: "review", to: "done" }, doneAt2);
      insertEvent(db, "t_0000000000000002", "verdict_failed", { summaryHash: "deadbeef" }, doneAt2 - 3600);
      insertEvent(db, "t_0000000000000002", "rework_launched", { attempt: 1 }, doneAt2 - 3500);
      insertEvent(
        db,
        "t_0000000000000003",
        "status_changed",
        { from: "ready", to: "blocked", reason: "user-decision: 確認待ち" },
        queueEnter,
      );
      insertEvent(db, "t_0000000000000003", "status_changed", { from: "blocked", to: "ready" }, queueEnter + 7200);
      insertEvent(
        db,
        "t_0000000000000004",
        "status_changed",
        { from: "ready", to: "blocked", reason: "review-required: 確認待ち" },
        openQueueEnter,
      );

      insertRun(db, "t_0000000000000001", "codex", "done", 0.25, doneAt1);
      insertRun(db, "t_0000000000000002", "claude", "failed", 0.5, doneAt2);
      insertRun(db, "t_0000000000000003", "codex", "running", 1, queueEnter);
      db.prepare(`INSERT INTO tick_metrics (ts, stage, actions, duration_ms) VALUES (?, 'dispatch', 2, 15)`).run(
        doneAt1,
      );
    } finally {
      db.close();
    }

    const reader = new MetricsReader(dbPath);
    try {
      const data = reader.query(from, to);
      expect(data.throughput).toEqual([
        { date: "2026-07-01", count: 1 },
        { date: "2026-07-02", count: 1 },
      ]);
      expect(data.runSuccess).toEqual({ total: 2, succeeded: 1, failed: 1, rate: 0.5 });
      expect(data.rework).toEqual({ totalDone: 2, reworked: 1, rate: 0.5 });
      expect(data.humanQueueDwell).toEqual([
        { bucket: "<1h", count: 0 },
        { bucket: "1-4h", count: 1 },
        { bucket: "4-12h", count: 0 },
        { bucket: "12-24h", count: 0 },
        { bucket: ">24h", count: 1 },
      ]);
      expect(data.profileProviderStats).toEqual([
        { profile: "review", provider: "claude", runCount: 1, totalCostUsd: 0.5 },
        { profile: "implement", provider: "codex", runCount: 1, totalCostUsd: 0.25 },
      ]);
      expect(data.tickMetrics).toEqual([{ ts: doneAt1, stage: "dispatch", actions: 2, durationMs: 15 }]);
      expect(data.doneOrigins).toEqual({
        total: 2,
        counts: { gatePassed: 0, orchestratorHostFinalize: 0, humanDecision: 0, unknown: 2 },
        automaticCompletionRate: 0,
        manualRecoveryRate: 0,
        unknownRate: 1,
      });
    } finally {
      reader.close();
    }
  });

  it("done originをevent列と構造化provenanceから期間集計する", () => {
    const from = 1_800_000_000;
    const to = from + 100;
    const migrated = new SqliteKanbanStore(dbPath);
    migrated.close();
    const db = new Database(dbPath);
    try {
      for (let index = 1; index <= 5; index += 1) {
        insertTask(db, { id: `t_000000000000000${index}`, createdAt: from });
      }
      insertEvent(db, "t_0000000000000001", "finalized", {
        from: "blocked", to: "done", outcome: "done", sessionId: "sess-1",
      }, from + 1);
      insertEvent(db, "t_0000000000000002", "verdict_finalized", {
        from: "review", to: "done", verdict: "pass", confidence: "high", sessionId: "review-1",
      }, from + 2);
      insertEvent(db, "t_0000000000000003", "status_changed", { from: "todo", to: "done" }, from + 3, {
        kind: "orchestrator", actorId: "o_1", actorSessionId: "os_1", actorGeneration: 2,
      });
      insertEvent(db, "t_0000000000000004", "status_changed", { from: "todo", to: "done" }, from + 4, {
        kind: "human", actorId: "local-human", actorSessionId: "", actorGeneration: null,
      });
      insertEvent(db, "t_0000000000000005", "finalized", {
        from: "blocked", to: "done", outcome: "done",
      }, from + 5);
    } finally {
      db.close();
    }

    const reader = new MetricsReader(dbPath);
    try {
      expect(reader.query(from, to).doneOrigins).toEqual({
        total: 5,
        counts: { gatePassed: 2, orchestratorHostFinalize: 1, humanDecision: 1, unknown: 1 },
        automaticCompletionRate: 0.4,
        manualRecoveryRate: 0.4,
        unknownRate: 0.2,
      });
    } finally {
      reader.close();
    }
  });

  it("期間内シグナルで分母を選び、全event履歴と境界を使ってfail-closed集計する", () => {
    const from = 1_810_000_000;
    const to = from + 100;
    const migrated = new SqliteKanbanStore(dbPath);
    migrated.close();
    const db = new Database(dbPath);
    try {
      for (let index = 1; index <= 7; index += 1) {
        insertTask(db, { id: `t_100000000000000${index}`, createdAt: from - 10 });
      }

      // 期間外+期間内のdone重複は、期間内だけを切り出さず全履歴によりunknown。
      insertEvent(db, "t_1000000000000001", "finalized", {
        from: "blocked", to: "done", outcome: "done", sessionId: "outside",
      }, from - 1);
      insertEvent(db, "t_1000000000000001", "finalized", {
        from: "blocked", to: "done", outcome: "done", sessionId: "inside",
      }, from + 1);

      // from/to境界はinclusiveで分母へ入る。
      insertEvent(db, "t_1000000000000002", "finalized", {
        from: "blocked", to: "done", outcome: "done", sessionId: "at-from",
      }, from);
      insertEvent(db, "t_1000000000000003", "verdict_finalized", {
        from: "review", to: "done", verdict: "pass", confidence: "high", sessionId: "at-to",
      }, to);

      // 期間内複数doneもunknown。
      insertEvent(db, "t_1000000000000004", "finalized", {
        from: "blocked", to: "done", outcome: "done", sessionId: "multi-1",
      }, from + 10);
      insertEvent(db, "t_1000000000000004", "finalized", {
        from: "blocked", to: "done", outcome: "done", sessionId: "multi-2",
      }, from + 11);

      // payload.to=doneだがfrom欠落、および壊れたterminal eventも分母に残してunknown。
      insertEvent(db, "t_1000000000000005", "status_changed", { to: "done" }, from + 12);
      insertRawEvent(db, "t_1000000000000006", "telegram_approve", "{", from + 13);

      // 完全な非done finalized(review)だけのtaskはdoneシグナルではなく分母外。
      insertEvent(db, "t_1000000000000007", "finalized", {
        from: "blocked", to: "review", outcome: "review", sessionId: "worker-review",
      }, from + 14);
    } finally {
      db.close();
    }

    const reader = new MetricsReader(dbPath);
    try {
      expect(reader.query(from, to).doneOrigins).toEqual({
        total: 6,
        counts: { gatePassed: 2, orchestratorHostFinalize: 0, humanDecision: 0, unknown: 4 },
        automaticCompletionRate: 2 / 6,
        manualRecoveryRate: 0,
        unknownRate: 4 / 6,
      });
    } finally {
      reader.close();
    }
  });
});
