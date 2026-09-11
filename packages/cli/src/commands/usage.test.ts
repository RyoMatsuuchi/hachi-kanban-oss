// =============================================================================
// hachi usage のテスト（契約 §14.5.1）。
// 「measured と estimated を合算しない」「除外件数を必ず出す」「二重計上しない」が
// テキスト・JSON の両面で守られることを固定する。
// =============================================================================

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { MetricValue, RunUsage, UsageReport } from "@hachi/core";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";
import { displayWidth, formatTable, resolvePeriod } from "./usage.js";

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
  unpricedModels?: string[];
}

function usage(fixture: UsageFixture = {}): RunUsage {
  return {
    costUsd: fixture.costUsd ?? estimated(1),
    inputTokens: measured(fixture.inputTokens ?? 100),
    outputTokens: measured(fixture.outputTokens ?? 10),
    cacheCreationTokens: measured(0),
    cacheReadTokens: measured(0),
    turns: measured(1),
    durationMs: measured(1000),
    collectedBy: "direct-claude@native-log-v1",
    ...(fixture.unpricedModels === undefined ? {} : { unpricedModels: fixture.unpricedModels }),
  };
}

interface RunFixture {
  taskId: string;
  tenant?: string;
  title?: string;
  provider?: string;
  sessionId: string;
  status?: string;
  role?: string;
  model?: string;
  effort?: string;
  usage?: RunUsage;
  lastResult?: Record<string, number>;
  startedAt?: number;
}

/** createTestDeps が用意した DB へ直接 run を差し込む（store には run 追加の read-only 面が無いため）。 */
function seedRuns(ctx: TestDeps, runs: RunFixture[]): void {
  const db = new Database(ctx.deps.env.dbPath);
  try {
    const seen = new Set<string>();
    for (const run of runs) {
      if (!seen.has(run.taskId)) {
        seen.add(run.taskId);
        db.prepare(
          `INSERT INTO tasks (id, title, body, status, tenant, created_at, updated_at)
           VALUES (?, ?, '', 'done', ?, 100, 100)`,
        ).run(run.taskId, run.title ?? `${run.taskId} のタイトル`, run.tenant ?? "dev");
      }
      const meta: Record<string, unknown> = {
        role: run.role ?? "worker",
        model: run.model ?? "claude-opus-5",
        ...(run.effort === undefined ? {} : { effort: run.effort }),
        ...(run.usage === undefined ? {} : { usage: run.usage }),
        ...(run.lastResult === undefined ? {} : { lastResult: run.lastResult }),
      };
      const startedAt = run.startedAt ?? Math.floor(Date.now() / 1000) - 3600;
      db.prepare(
        `INSERT INTO task_runs (task_id, provider, session_id, status, meta, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.taskId,
        run.provider ?? "claude",
        run.sessionId,
        run.status ?? "done",
        JSON.stringify(meta),
        startedAt,
        startedAt + 60,
      );
    }
  } finally {
    db.close();
  }
}

function parseJson(ctx: TestDeps): UsageReport {
  return JSON.parse(ctx.stdout.text()) as UsageReport;
}

describe("hachi usage", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
  });

  it("1タスクの総額が worker + reviewer + rework を合算した値になる", async () => {
    ctx = createTestDeps();
    seedRuns(ctx, [
      { taskId: "t_aaa", sessionId: "s1", role: "worker", usage: usage({ costUsd: estimated(1.5), inputTokens: 1000 }) },
      { taskId: "t_aaa", sessionId: "s2", role: "reviewer", usage: usage({ costUsd: estimated(0.5), inputTokens: 200 }) },
      { taskId: "t_aaa", sessionId: "s3", role: "worker", usage: usage({ costUsd: estimated(2), inputTokens: 800 }) },
    ]);

    await buildProgram(ctx.deps).parseAsync(["usage", "--by", "task", "--json"], { from: "user" });

    const report = parseJson(ctx);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.runCount).toBe(3);
    expect(report.rows[0]?.costUsd.estimated.total).toBeCloseTo(4, 10);
    expect(report.rows[0]?.inputTokens.measured.total).toBe(2000);
  });

  it("tenant / model / effort 単位の集計が出る", async () => {
    ctx = createTestDeps();
    seedRuns(ctx, [
      { taskId: "t_a", tenant: "hachi-kanban", sessionId: "s1", model: "claude-opus-5", effort: "high", usage: usage({ costUsd: estimated(9) }) },
      { taskId: "t_b", tenant: "tenant-a", sessionId: "s2", model: "claude-sonnet-5", effort: "medium", usage: usage({ costUsd: estimated(1) }) },
    ]);
    const program = buildProgram(ctx.deps);

    await program.parseAsync(["usage", "--by", "tenant", "--json"], { from: "user" });
    expect(parseJson(ctx).rows.map((r) => r.key)).toEqual(["hachi-kanban", "tenant-a"]);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["usage", "--by", "model", "--json"], { from: "user" });
    const byModel = parseJson(ctx);
    expect(byModel.rows.map((r) => r.key)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(byModel.rows[0]?.costUsd.estimated.total).toBeCloseTo(9, 10);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["usage", "--by", "effort", "--json"], { from: "user" });
    expect(parseJson(ctx).rows.map((r) => r.key)).toEqual(["high", "medium"]);
  });

  it("measured と estimated が合算されず別列で出る", async () => {
    ctx = createTestDeps();
    seedRuns(ctx, [
      { taskId: "t_a", sessionId: "s1", usage: usage({ costUsd: estimated(3) }) },
      { taskId: "t_b", sessionId: "s2", usage: usage({ costUsd: { state: "measured", value: 7, provenance: "bridge-result-event" } }) },
    ]);

    await buildProgram(ctx.deps).parseAsync(["usage", "--by", "task"], { from: "user" });

    const text = ctx.stdout.text();
    expect(text).toContain("推定コスト");
    expect(text).toContain("実測コスト");
    expect(text).toContain("$3.0000");
    expect(text).toContain("$7.0000");
    // 合算した 10 はどこにも出さない
    expect(text).not.toContain("$10.0000");
  });

  it("推定しか無い列は 0 ではなく - を出す（実測ゼロと未取得を混同させない）", async () => {
    ctx = createTestDeps();
    seedRuns(ctx, [{ taskId: "t_a", sessionId: "s1", usage: usage({ costUsd: estimated(3) }) }]);

    await buildProgram(ctx.deps).parseAsync(["usage"], { from: "user" });

    expect(ctx.stdout.text()).not.toContain("$0.0000");
    expect(ctx.stdout.text()).toMatch(/\$3\.0000\s+-/);
  });

  it("除外された run の件数が表示される", async () => {
    ctx = createTestDeps();
    seedRuns(ctx, [
      { taskId: "t_a", sessionId: "s1", usage: usage({ costUsd: estimated(3) }) },
      { taskId: "t_b", sessionId: "s2", usage: usage({ costUsd: { state: "unavailable-by-design" }, unpricedModels: ["claude-haiku-4-5-20251001"] }) },
      { taskId: "t_c", sessionId: "s3", lastResult: { costUsd: 0, inputTokens: 0 } },
      { taskId: "t_d", sessionId: "s4" },
    ]);

    await buildProgram(ctx.deps).parseAsync(["usage"], { from: "user" });

    const text = ctx.stdout.text();
    expect(text).toContain("=== カバレッジ ===");
    expect(text).toContain("期間内 run: 4（集計対象 4 / 未終端 0 / 重複除外 0）");
    expect(text).toContain("usage 記録あり 2 / 旧 lastResult のみ 1（legacy-unverified・値は未使用） / 記録なし 1");
    expect(text).toContain("価格表外 1");
    // cost 欠測の原因モデルを名指しする（利用者が理由を理解できるようにする）
    expect(text).toContain("claude-haiku-4-5-20251001");
  });

  it("同一 run が二重計上されない", async () => {
    ctx = createTestDeps();
    const bridgeUsage = usage({ costUsd: estimated(4), inputTokens: 20 });
    bridgeUsage.inputTokens = { state: "measured", value: 20, provenance: "bridge-result-event" };
    seedRuns(ctx, [
      { taskId: "t_a", sessionId: "sess-shared", usage: bridgeUsage },
      { taskId: "t_a", sessionId: "sess-shared", usage: usage({ costUsd: estimated(9), inputTokens: 5000 }) },
    ]);

    await buildProgram(ctx.deps).parseAsync(["usage", "--json"], { from: "user" });

    const report = parseJson(ctx);
    expect(report.coverage.duplicateRuns).toBe(1);
    expect(report.coverage.aggregatedRuns).toBe(1);
    expect(report.total.costUsd.estimated.total).toBeCloseTo(9, 10);
    expect(report.total.inputTokens.measured.total).toBe(5000);
  });

  it("--json が機械可読で state と provenance を保持する", async () => {
    ctx = createTestDeps();
    seedRuns(ctx, [
      { taskId: "t_a", sessionId: "s1", usage: usage({ costUsd: estimated(2, "litellm@2026-08-01") }) },
      { taskId: "t_b", sessionId: "s2", usage: usage({ costUsd: { state: "not-provided" } }) },
    ]);

    await buildProgram(ctx.deps).parseAsync(["usage", "--json"], { from: "user" });

    const report = parseJson(ctx);
    expect(report.total.inputTokens.measured.provenances).toEqual(["cli-native-session-log"]);
    expect(report.total.costUsd.estimated.priceTableRefs).toEqual(["litellm@2026-08-01"]);
    expect(report.total.costUsd.excluded).toEqual({
      notProvided: 1,
      unavailableByDesign: 0,
      unknown: 0,
      legacyUnverified: 0,
      total: 1,
    });
    expect(report.priceTableMixed).toBe(false);
    expect(report.coverage.withUsageRuns).toBe(2);
    // stdout が単一 JSON document であること（テキストが混ざらない）
    expect(() => JSON.parse(ctx.stdout.text())).not.toThrow();
  });

  it("行のコストが他モデル（subagent/advisor）分を含むことを明記する", async () => {
    ctx = createTestDeps();
    const withModels = usage({ costUsd: estimated(1) });
    withModels.models = ["claude-haiku-4-5", "claude-opus-5"];
    seedRuns(ctx, [{ taskId: "t_a", sessionId: "s1", model: "claude-opus-5", usage: withModels }]);

    await buildProgram(ctx.deps).parseAsync(["usage", "--by", "model"], { from: "user" });

    const text = ctx.stdout.text();
    expect(text).toContain("subagent / advisor");
    expect(text).toContain("claude-haiku-4-5, claude-opus-5");
  });

  it("価格表の版が混在すると警告する", async () => {
    ctx = createTestDeps();
    seedRuns(ctx, [
      { taskId: "t_a", sessionId: "s1", usage: usage({ costUsd: estimated(1, "litellm@2026-08-01") }) },
      { taskId: "t_b", sessionId: "s2", usage: usage({ costUsd: estimated(2, "litellm@2026-09-01") }) },
    ]);

    await buildProgram(ctx.deps).parseAsync(["usage"], { from: "user" });

    expect(ctx.stdout.text()).toContain("複数版の価格表が混在しています");
  });

  it("期間・tenant・task で絞り込む", async () => {
    ctx = createTestDeps();
    const now = Math.floor(Date.now() / 1000);
    seedRuns(ctx, [
      { taskId: "t_recent", tenant: "dev", sessionId: "s1", usage: usage({ costUsd: estimated(1) }), startedAt: now - 3600 },
      { taskId: "t_other", tenant: "tenant-a", sessionId: "s2", usage: usage({ costUsd: estimated(5) }), startedAt: now - 3600 },
      { taskId: "t_old", tenant: "dev", sessionId: "s3", usage: usage({ costUsd: estimated(7) }), startedAt: now - 400 * 24 * 3600 },
    ]);

    await buildProgram(ctx.deps).parseAsync(["usage", "--days", "7", "--json"], { from: "user" });
    expect(parseJson(ctx).total.costUsd.estimated.total).toBeCloseTo(6, 10);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["usage", "--days", "7", "--tenant", "dev", "--json"], { from: "user" });
    expect(parseJson(ctx).total.costUsd.estimated.total).toBeCloseTo(1, 10);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["usage", "--task", "t_other", "--json"], { from: "user" });
    expect(parseJson(ctx).total.costUsd.estimated.total).toBeCloseTo(5, 10);
  });

  it("未終端 run は集計へ入れず件数だけ残す", async () => {
    ctx = createTestDeps();
    seedRuns(ctx, [
      { taskId: "t_a", sessionId: "s1", status: "running" },
      { taskId: "t_b", sessionId: "s2", usage: usage({ costUsd: estimated(2) }) },
    ]);

    await buildProgram(ctx.deps).parseAsync(["usage", "--json"], { from: "user" });

    const report = parseJson(ctx);
    expect(report.coverage.runningRuns).toBe(1);
    expect(report.coverage.aggregatedRuns).toBe(1);
  });

  it("集計対象が無ければその旨を出す", async () => {
    ctx = createTestDeps();
    await buildProgram(ctx.deps).parseAsync(["usage"], { from: "user" });
    expect(ctx.stdout.text()).toContain("(集計対象の run はありません)");
  });

  it("--limit はテキスト表示だけに効き、JSON と合計行には効かない", async () => {
    ctx = createTestDeps();
    seedRuns(ctx, [
      { taskId: "t_a", sessionId: "s1", usage: usage({ costUsd: estimated(3) }) },
      { taskId: "t_b", sessionId: "s2", usage: usage({ costUsd: estimated(2) }) },
      { taskId: "t_c", sessionId: "s3", usage: usage({ costUsd: estimated(1) }) },
    ]);

    await buildProgram(ctx.deps).parseAsync(["usage", "--limit", "1"], { from: "user" });
    const text = ctx.stdout.text();
    expect(text).toContain("(残り 2 行は --limit で表示できます");
    expect(text).toContain("$6.0000"); // 合計は全行ぶん

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["usage", "--limit", "1", "--json"], { from: "user" });
    expect(parseJson(ctx).rows).toHaveLength(3);
  });

  it("不正な引数を拒否する", async () => {
    ctx = createTestDeps();
    await expect(
      buildProgram(ctx.deps).parseAsync(["usage", "--by", "nonexistent"], { from: "user" }),
    ).rejects.toThrow();
    await expect(buildProgram(ctx.deps).parseAsync(["usage", "--days", "0"], { from: "user" })).rejects.toThrow();
    await expect(buildProgram(ctx.deps).parseAsync(["usage", "--totally-unknown"], { from: "user" })).rejects.toThrow();
  });

  it("from > to の期間はエラーにする", async () => {
    ctx = createTestDeps();
    await buildProgram(ctx.deps).parseAsync(["usage", "--from", "2026-08-20", "--to", "2026-08-01"], { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("期間の指定が逆転しています");
  });
});

describe("usage の整形ヘルパ", () => {
  it("--from/--to は JST の日付境界で解釈する", () => {
    const period = resolvePeriod({ from: "2026-08-01", to: "2026-08-01" }, 0);
    // JST 2026-08-01 00:00:00 = UTC 2026-07-31 15:00:00
    expect(period.from).toBe(Math.floor(Date.UTC(2026, 7, 1) / 1000) - 9 * 3600);
    expect(period.to - period.from).toBe(24 * 3600 - 1);
  });

  it("--days は --to から遡る", () => {
    const now = 1_800_000_000;
    expect(resolvePeriod({ days: 7 }, now)).toEqual({ from: now - 7 * 24 * 3600, to: now });
  });

  it("全角文字を2桁として数える", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("タスク")).toBe(6);
    expect(displayWidth("t_a タスク")).toBe(10);
  });

  it("全角混じりでも桁が揃う", () => {
    // 右寄せ最終列なので trimEnd の影響を受けず、桁が揃っていれば全行の表示幅が一致する
    const lines = formatTable(["name", "n"], [["タスク", "1"], ["ab", "22"]], ["left", "right"]);
    expect(new Set(lines.map(displayWidth)).size).toBe(1);
    // 素の String.length で揃えると全角行だけ短くなる（この実装が避けている失敗）
    expect(new Set(lines.map((line) => line.length)).size).toBe(2);
  });
});
