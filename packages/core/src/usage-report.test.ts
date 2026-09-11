import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import {
  aggregateUsage,
  parseRunUsage,
  UsageReportReader,
  type UsageGroupBy,
  type UsageReport,
  type UsageRunRecord,
} from "./usage-report.js";
import type { MetricValue, RunUsage } from "./types.js";

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

function measured(value: number): MetricValue {
  return { state: "measured", value, provenance: "cli-native-session-log" };
}

function estimated(value: number, priceTableRef = "litellm@2026-08-01"): MetricValue {
  return { state: "estimated", value, basis: "price-table", priceTableRef };
}

interface UsageFixture {
  costUsd?: MetricValue;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  turns?: number;
  models?: string[];
  unpricedModels?: string[];
}

function usage(fixture: UsageFixture = {}): RunUsage {
  return {
    costUsd: fixture.costUsd ?? estimated(1),
    inputTokens: measured(fixture.inputTokens ?? 100),
    outputTokens: measured(fixture.outputTokens ?? 10),
    cacheCreationTokens: measured(fixture.cacheCreationTokens ?? 0),
    cacheReadTokens: measured(fixture.cacheReadTokens ?? 0),
    turns: measured(fixture.turns ?? 1),
    durationMs: measured(1000),
    collectedBy: "direct-claude@native-log-v1",
    ...(fixture.models === undefined ? {} : { models: fixture.models }),
    ...(fixture.unpricedModels === undefined ? {} : { unpricedModels: fixture.unpricedModels }),
  };
}

let nextRunId = 1;

interface RecordFixture {
  taskId?: string;
  tenant?: string;
  provider?: string;
  sessionId?: string;
  status?: UsageRunRecord["status"];
  model?: string;
  effort?: string;
  role?: string;
  usage?: RunUsage | null;
  hasLegacyLastResult?: boolean;
  runId?: number;
}

function record(fixture: RecordFixture = {}): UsageRunRecord {
  const runId = fixture.runId ?? nextRunId++;
  return {
    runId,
    taskId: fixture.taskId ?? "t_task1",
    taskTitle: "テストタスク",
    tenant: fixture.tenant ?? "dev",
    provider: fixture.provider ?? "claude",
    sessionId: fixture.sessionId ?? `sess-${runId}`,
    status: fixture.status ?? "done",
    startedAt: 1000 + runId,
    model: fixture.model ?? "claude-opus-5",
    effort: fixture.effort ?? "high",
    role: fixture.role ?? "worker",
    usage: fixture.usage === undefined ? usage() : fixture.usage,
    hasLegacyLastResult: fixture.hasLegacyLastResult ?? false,
  };
}

const PERIOD = { from: 0, to: 9999 };

function report(records: UsageRunRecord[], groupBy: UsageGroupBy = "task"): UsageReport {
  return aggregateUsage(records, { groupBy, period: PERIOD });
}

beforeEach(() => {
  nextRunId = 1;
});

// ---------------------------------------------------------------------------

describe("aggregateUsage — 集計軸", () => {
  it("1タスクの総額は worker + reviewer + rework の全 run を合算する", () => {
    const result = report([
      record({ taskId: "t_a", role: "worker", usage: usage({ costUsd: estimated(1.5), inputTokens: 1000 }) }),
      record({ taskId: "t_a", role: "reviewer", usage: usage({ costUsd: estimated(0.5), inputTokens: 200 }) }),
      // rework は worker run の再起動なので role は worker のまま増える
      record({ taskId: "t_a", role: "worker", usage: usage({ costUsd: estimated(2), inputTokens: 800 }) }),
      record({ taskId: "t_b", role: "worker", usage: usage({ costUsd: estimated(0.25), inputTokens: 50 }) }),
    ]);

    const taskA = result.rows.find((r) => r.key === "t_a");
    expect(taskA?.runCount).toBe(3);
    expect(taskA?.costUsd.estimated.total).toBeCloseTo(4, 10);
    expect(taskA?.costUsd.estimated.runCount).toBe(3);
    expect(taskA?.inputTokens.measured.total).toBe(2000);
    expect(result.rows.find((r) => r.key === "t_b")?.costUsd.estimated.total).toBeCloseTo(0.25, 10);
    expect(result.total.costUsd.estimated.total).toBeCloseTo(4.25, 10);
  });

  it("tenant 単位で集計する", () => {
    const result = report(
      [
        record({ tenant: "hachi-kanban", usage: usage({ costUsd: estimated(3) }) }),
        record({ tenant: "tenant-a", usage: usage({ costUsd: estimated(1) }) }),
        record({ tenant: "hachi-kanban", usage: usage({ costUsd: estimated(2) }) }),
      ],
      "tenant",
    );

    expect(result.rows.map((r) => r.key)).toEqual(["hachi-kanban", "tenant-a"]);
    expect(result.rows[0]?.costUsd.estimated.total).toBeCloseTo(5, 10);
    expect(result.rows[0]?.runCount).toBe(2);
  });

  it("model / effort 単位で集計し、未指定は明示ラベルで別グループにする", () => {
    const records = [
      record({ model: "claude-opus-5", effort: "high", usage: usage({ costUsd: estimated(9) }) }),
      record({ model: "claude-sonnet-5", effort: "medium", usage: usage({ costUsd: estimated(1) }) }),
      record({ model: "", effort: "", usage: usage({ costUsd: estimated(0.5) }) }),
    ];

    const byModel = report(records, "model");
    expect(byModel.rows.map((r) => r.key)).toEqual(["claude-opus-5", "claude-sonnet-5", ""]);
    expect(byModel.rows[0]?.costUsd.estimated.total).toBeCloseTo(9, 10);
    expect(byModel.rows[2]?.label).toBe("(未指定)");

    const byEffort = report(records, "effort");
    expect(byEffort.rows.map((r) => r.key)).toEqual(["high", "medium", ""]);
    expect(byEffort.rows[0]?.costUsd.estimated.total).toBeCloseTo(9, 10);
  });

  it("provider / role 単位でも集計できる", () => {
    const records = [
      record({ provider: "codex", role: "worker", usage: usage({ costUsd: estimated(2) }) }),
      record({ provider: "claude", role: "reviewer", usage: usage({ costUsd: estimated(1) }) }),
    ];
    expect(report(records, "provider").rows.map((r) => r.key)).toEqual(["codex", "claude"]);
    expect(report(records, "role").rows.map((r) => r.key)).toEqual(["worker", "reviewer"]);
  });
});

describe("aggregateUsage — measured と estimated を混ぜない", () => {
  it("cost の実測と推定は別フィールドに積まれ、合算されない", () => {
    const result = report([
      record({ usage: usage({ costUsd: estimated(3) }) }),
      record({ usage: usage({ costUsd: { state: "measured", value: 7, provenance: "bridge-result-event" } }) }),
    ]);

    const total = result.total.costUsd;
    expect(total.estimated.total).toBeCloseTo(3, 10);
    expect(total.estimated.runCount).toBe(1);
    expect(total.measured.total).toBeCloseTo(7, 10);
    expect(total.measured.runCount).toBe(1);
    // 合算した 10 がどこにも現れないこと
    expect(total.measured.total + total.estimated.total).toBeCloseTo(10, 10);
    expect(total.measured.total).not.toBeCloseTo(10, 10);
    expect(total.estimated.total).not.toBeCloseTo(10, 10);
  });

  it("legacy-unverified の値は件数だけ数え、measured にも estimated にも足さない", () => {
    const result = report([
      record({ usage: usage({ costUsd: { state: "legacy-unverified", value: 999 } }) }),
    ]);

    const cost = result.total.costUsd;
    expect(cost.measured.total).toBe(0);
    expect(cost.measured.runCount).toBe(0);
    expect(cost.estimated.total).toBe(0);
    expect(cost.estimated.runCount).toBe(0);
    expect(cost.excluded.legacyUnverified).toBe(1);
    expect(cost.excluded.total).toBe(1);
  });

  it("provenance と価格表の版を保持する", () => {
    const result = report([
      record({ usage: usage({ costUsd: estimated(1, "litellm@2026-08-01") }) }),
      record({ usage: usage({ costUsd: estimated(2, "litellm@2026-09-01") }) }),
    ]);

    expect(result.total.inputTokens.measured.provenances).toEqual(["cli-native-session-log"]);
    expect(result.priceTableRefs).toEqual(["litellm@2026-08-01", "litellm@2026-09-01"]);
    expect(result.priceTableMixed).toBe(true);
  });

  it("価格表の版が1つだけなら混在フラグは立たない", () => {
    const result = report([record({ usage: usage({ costUsd: estimated(1) }) })]);
    expect(result.priceTableMixed).toBe(false);
    expect(result.priceTableRefs).toEqual(["litellm@2026-08-01"]);
  });
});

describe("aggregateUsage — 除外された run の件数", () => {
  it("state ごとに除外件数を数え、値は一切合算しない", () => {
    const result = report([
      record({ usage: usage({ costUsd: estimated(5) }) }),
      record({ usage: usage({ costUsd: { state: "unavailable-by-design" }, models: ["gpt-5.6"], unpricedModels: ["claude-haiku-4-5-20251001"] }) }),
      record({ usage: usage({ costUsd: { state: "not-provided" } }) }),
      record({ usage: usage({ costUsd: { state: "unknown" } }) }),
    ]);

    const cost = result.total.costUsd;
    expect(cost.estimated.total).toBeCloseTo(5, 10);
    expect(cost.estimated.runCount).toBe(1);
    expect(cost.excluded.unavailableByDesign).toBe(1);
    expect(cost.excluded.notProvided).toBe(1);
    expect(cost.excluded.unknown).toBe(1);
    expect(cost.excluded.total).toBe(3);
    expect(result.total.runCount).toBe(4);
  });

  it("価格表に無いモデル id を集計へ残す（cost 欠測の理由を表示できるようにする）", () => {
    const result = report([
      record({ usage: usage({ costUsd: { state: "unavailable-by-design" }, unpricedModels: ["claude-haiku-4-5-20251001"] }) }),
      record({ usage: usage({ costUsd: { state: "unavailable-by-design" }, unpricedModels: ["gpt-5.6-mini"] }) }),
    ]);

    expect(result.total.unpricedModels).toEqual(["claude-haiku-4-5-20251001", "gpt-5.6-mini"]);
  });

  it("usage が無く旧 lastResult だけある run は legacy-unverified として数える", () => {
    const result = report([
      record({ usage: null, hasLegacyLastResult: true }),
      record({ usage: null, hasLegacyLastResult: false }),
      record({ usage: usage({ costUsd: estimated(1) }) }),
    ]);

    expect(result.coverage.legacyOnlyRuns).toBe(1);
    expect(result.coverage.noUsageRuns).toBe(1);
    expect(result.coverage.withUsageRuns).toBe(1);
    expect(result.total.costUsd.excluded.legacyUnverified).toBe(1);
    expect(result.total.costUsd.excluded.unknown).toBe(1);
    expect(result.total.costUsd.estimated.total).toBeCloseTo(1, 10);
    // トークンも同様に除外側で数える（片方だけ数えて総トークンを小さく見せない）
    expect(result.total.inputTokens.excluded.total).toBe(2);
  });

  it("未終端 run は集計へ入れず件数だけ残す", () => {
    const result = report([
      record({ status: "running", usage: null }),
      record({ status: "done", usage: usage({ costUsd: estimated(2) }) }),
    ]);

    expect(result.coverage.runningRuns).toBe(1);
    expect(result.coverage.totalRuns).toBe(2);
    expect(result.coverage.aggregatedRuns).toBe(1);
    expect(result.total.runCount).toBe(1);
    expect(result.total.costUsd.excluded.total).toBe(0);
  });

  it("released run は終端として集計へ入れる", () => {
    const result = report([record({ status: "released", usage: usage({ costUsd: estimated(2) }) })]);
    expect(result.coverage.aggregatedRuns).toBe(1);
    expect(result.total.costUsd.estimated.total).toBeCloseTo(2, 10);
  });
});

describe("aggregateUsage — 二重計上の防止", () => {
  it("同一 (provider, sessionId) が2行あってもネイティブログ由来を1件だけ数える", () => {
    const bridgeUsage = usage({ costUsd: estimated(4), inputTokens: 20 });
    bridgeUsage.inputTokens = { state: "measured", value: 20, provenance: "bridge-result-event" };
    const nativeUsage = usage({ costUsd: estimated(9), inputTokens: 5000 });

    const result = report([
      record({ runId: 1, provider: "claude", sessionId: "sess-shared", usage: bridgeUsage }),
      record({ runId: 2, provider: "claude", sessionId: "sess-shared", usage: nativeUsage }),
    ]);

    expect(result.coverage.duplicateRuns).toBe(1);
    expect(result.coverage.aggregatedRuns).toBe(1);
    expect(result.total.runCount).toBe(1);
    // ネイティブログ側（正本）が残る。4+9=13 にも 20+5000 にもならない
    expect(result.total.costUsd.estimated.total).toBeCloseTo(9, 10);
    expect(result.total.inputTokens.measured.total).toBe(5000);
  });

  it("記録順が逆でもネイティブログ由来が優先される", () => {
    const nativeUsage = usage({ costUsd: estimated(9) });
    const bridgeUsage = usage({ costUsd: estimated(4) });
    bridgeUsage.inputTokens = { state: "measured", value: 20, provenance: "bridge-result-event" };

    const result = report([
      record({ runId: 1, sessionId: "sess-shared", usage: nativeUsage }),
      record({ runId: 2, sessionId: "sess-shared", usage: bridgeUsage }),
    ]);

    expect(result.total.costUsd.estimated.total).toBeCloseTo(9, 10);
  });

  it("provider が違えば同じ session 文字列でも別 run として数える", () => {
    const result = report([
      record({ provider: "claude", sessionId: "sess-x", usage: usage({ costUsd: estimated(1) }) }),
      record({ provider: "codex", sessionId: "sess-x", usage: usage({ costUsd: estimated(2) }) }),
    ]);

    expect(result.coverage.duplicateRuns).toBe(0);
    expect(result.total.costUsd.estimated.total).toBeCloseTo(3, 10);
  });

  it("sessionId が空の run は同一視せずそれぞれ数える", () => {
    const result = report([
      record({ sessionId: "", usage: usage({ costUsd: estimated(1) }) }),
      record({ sessionId: "", usage: usage({ costUsd: estimated(2) }) }),
    ]);

    expect(result.coverage.duplicateRuns).toBe(0);
    expect(result.total.costUsd.estimated.total).toBeCloseTo(3, 10);
  });

  it("usage を持つ行が、usage を持たない同一セッション行に負けない", () => {
    const result = report([
      record({ runId: 1, sessionId: "sess-shared", usage: usage({ costUsd: estimated(3) }) }),
      record({ runId: 2, sessionId: "sess-shared", usage: null, hasLegacyLastResult: true }),
    ]);

    expect(result.coverage.duplicateRuns).toBe(1);
    expect(result.coverage.withUsageRuns).toBe(1);
    expect(result.total.costUsd.estimated.total).toBeCloseTo(3, 10);
  });
});

describe("parseRunUsage — fail-closed", () => {
  it("正常な usage を復元する", () => {
    const parsed = parseRunUsage(JSON.parse(JSON.stringify(usage({ models: ["claude-opus-5"] }))));
    expect(parsed?.collectedBy).toBe("direct-claude@native-log-v1");
    expect(parsed?.models).toEqual(["claude-opus-5"]);
  });

  it("metric が1つでも壊れていれば usage 全体を無効にする", () => {
    const broken = JSON.parse(JSON.stringify(usage())) as Record<string, unknown>;
    broken.outputTokens = { state: "measured", value: 10 }; // provenance 欠落
    expect(parseRunUsage(broken)).toBeNull();
  });

  it("未知の state を採用しない", () => {
    const broken = JSON.parse(JSON.stringify(usage())) as Record<string, unknown>;
    broken.costUsd = { state: "totally-new", value: 1 };
    expect(parseRunUsage(broken)).toBeNull();
  });

  it("measured の値が数値でなければ無効にする（偽値を通さない）", () => {
    const broken = JSON.parse(JSON.stringify(usage())) as Record<string, unknown>;
    broken.inputTokens = { state: "measured", value: "100", provenance: "cli-native-session-log" };
    expect(parseRunUsage(broken)).toBeNull();
  });

  it("usage キー自体が無い / null なら null を返す", () => {
    expect(parseRunUsage(undefined)).toBeNull();
    expect(parseRunUsage(null)).toBeNull();
    expect(parseRunUsage("usage")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DB 経由
// ---------------------------------------------------------------------------

describe("UsageReportReader", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hachi-usage-report-"));
    dbPath = join(tempDir, "kanban.db");
    const store = new SqliteKanbanStore(dbPath);
    store.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seed(rows: Array<{ taskId: string; tenant: string; provider: string; sessionId: string; status: string; meta: unknown; startedAt: number }>): void {
    const db = new Database(dbPath);
    try {
      const tasks = new Set(rows.map((r) => r.taskId));
      for (const taskId of tasks) {
        const tenant = rows.find((r) => r.taskId === taskId)?.tenant ?? "";
        db.prepare(
          `INSERT INTO tasks (id, title, body, status, tenant, created_at, updated_at) VALUES (?, ?, '', 'done', ?, 100, 100)`,
        ).run(taskId, `${taskId} のタイトル`, tenant);
      }
      for (const row of rows) {
        db.prepare(
          `INSERT INTO task_runs (task_id, provider, session_id, status, meta, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(row.taskId, row.provider, row.sessionId, row.status, JSON.stringify(row.meta), row.startedAt, row.startedAt + 30);
      }
    } finally {
      db.close();
    }
  }

  it("meta.usage を読み、task 単位で集計する", () => {
    seed([
      {
        taskId: "t_aaa",
        tenant: "dev",
        provider: "claude",
        sessionId: "s1",
        status: "done",
        meta: { role: "worker", model: "claude-opus-5", effort: "high", usage: usage({ costUsd: estimated(2), inputTokens: 500 }) },
        startedAt: 1000,
      },
      {
        taskId: "t_aaa",
        tenant: "dev",
        provider: "claude",
        sessionId: "s2",
        status: "done",
        meta: { role: "reviewer", model: "claude-sonnet-5", effort: "medium", usage: usage({ costUsd: estimated(0.5), inputTokens: 100 }) },
        startedAt: 1010,
      },
    ]);

    const reader = new UsageReportReader(dbPath);
    try {
      const result = reader.query({ from: 0, to: 9999, groupBy: "task" });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.key).toBe("t_aaa");
      expect(result.rows[0]?.label).toContain("t_aaa のタイトル");
      expect(result.rows[0]?.costUsd.estimated.total).toBeCloseTo(2.5, 10);
      expect(result.rows[0]?.inputTokens.measured.total).toBe(600);

      const byModel = reader.query({ from: 0, to: 9999, groupBy: "model" });
      expect(byModel.rows.map((r) => r.key)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    } finally {
      reader.close();
    }
  });

  it("meta が壊れていても落ちず、unknown として件数に残す", () => {
    const db = new Database(dbPath);
    try {
      db.prepare(`INSERT INTO tasks (id, title, body, status, tenant, created_at, updated_at) VALUES ('t_bad', 'x', '', 'done', 'dev', 100, 100)`).run();
      db.prepare(
        `INSERT INTO task_runs (task_id, provider, session_id, status, meta, started_at, ended_at)
         VALUES ('t_bad', 'claude', 's-bad', 'done', '{not json', 1000, 1030)`,
      ).run();
    } finally {
      db.close();
    }

    const reader = new UsageReportReader(dbPath);
    try {
      const result = reader.query({ from: 0, to: 9999, groupBy: "task" });
      expect(result.coverage.noUsageRuns).toBe(1);
      expect(result.total.costUsd.excluded.unknown).toBe(1);
      expect(result.total.costUsd.estimated.total).toBe(0);
    } finally {
      reader.close();
    }
  });

  it("期間・tenant・task で絞り込む", () => {
    seed([
      { taskId: "t_in", tenant: "dev", provider: "claude", sessionId: "s1", status: "done", meta: { usage: usage({ costUsd: estimated(1) }) }, startedAt: 1000 },
      { taskId: "t_other", tenant: "tenant-a", provider: "claude", sessionId: "s2", status: "done", meta: { usage: usage({ costUsd: estimated(5) }) }, startedAt: 1000 },
      { taskId: "t_old", tenant: "dev", provider: "claude", sessionId: "s3", status: "done", meta: { usage: usage({ costUsd: estimated(7) }) }, startedAt: 10 },
    ]);

    const reader = new UsageReportReader(dbPath);
    try {
      expect(reader.query({ from: 500, to: 9999, groupBy: "task" }).total.costUsd.estimated.total).toBeCloseTo(6, 10);
      expect(reader.query({ from: 0, to: 9999, groupBy: "task", tenant: "dev" }).total.costUsd.estimated.total).toBeCloseTo(8, 10);
      expect(reader.query({ from: 0, to: 9999, groupBy: "task", taskId: "t_other" }).total.costUsd.estimated.total).toBeCloseTo(5, 10);
    } finally {
      reader.close();
    }
  });

  it("旧 lastResult だけの run は legacy-unverified として数え、値を合算しない", () => {
    seed([
      { taskId: "t_legacy", tenant: "dev", provider: "codex", sessionId: "s1", status: "done", meta: { lastResult: { costUsd: 0, inputTokens: 0 } }, startedAt: 1000 },
    ]);

    const reader = new UsageReportReader(dbPath);
    try {
      const result = reader.query({ from: 0, to: 9999, groupBy: "provider" });
      expect(result.coverage.legacyOnlyRuns).toBe(1);
      expect(result.total.costUsd.excluded.legacyUnverified).toBe(1);
      expect(result.total.costUsd.estimated.total).toBe(0);
      expect(result.total.costUsd.measured.total).toBe(0);
    } finally {
      reader.close();
    }
  });
});
