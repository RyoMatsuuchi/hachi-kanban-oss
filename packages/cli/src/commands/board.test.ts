import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

interface BoardJson {
  counts: Record<string, number>;
  doneOrigins: {
    total: number;
    counts: { gatePassed: number; orchestratorHostFinalize: number; humanDecision: number; unknown: number };
    automaticCompletionRate: number;
    manualRecoveryRate: number;
    unknownRate: number;
  };
  inProgress: Array<{ id: string; title: string; reason: string }>;
  humanQueue: Array<{ id: string; priority: number; reason: string; title: string }>;
}

describe("hachi board", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
  });

  it("counts と in-progress 一覧を JSON で出力する", async () => {
    ctx = createTestDeps();
    const created = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    ctx.deps.store.transition({ taskId: created.id, to: "ready", actor: "tester" });
    ctx.deps.store.block(created.id, "codex-in-progress: 実装中です".padEnd(120, "x"), "tester");

    await buildProgram(ctx.deps).parseAsync(["board", "--json"], { from: "user" });

    const parsed = JSON.parse(ctx.stdout.text()) as BoardJson;
    expect(parsed.counts.blocked).toBe(1);
    expect(parsed.inProgress).toHaveLength(1);
    expect(parsed.inProgress[0]?.id).toBe(created.id);
    expect(parsed.inProgress[0]?.reason.length).toBeLessThanOrEqual(80);
    // in-progress のタスクは human_queue には出ない（後方互換: 既存フィールドに新フィールドを追加しただけ）
    expect(parsed.humanQueue).toEqual([]);
    expect(parsed.doneOrigins.total).toBe(0);
  });

  it("テキスト出力は状態別件数と in-progress と human_queue を含む", async () => {
    ctx = createTestDeps();
    await buildProgram(ctx.deps).parseAsync(["board"], { from: "user" });

    const text = ctx.stdout.text();
    expect(text).toContain("=== 状態別件数 ===");
    expect(text).toContain("triage: 0");
    expect(text).toContain("=== 進行中 (in-progress) ===");
    expect(text).toContain("=== Done origin ===");
    expect(text).toContain("manual recovery: 0.0%");
    expect(text).toContain("進行中のタスクはありません");
    expect(text).toContain("=== 要対応 (human_queue) ===");
    expect(text).toContain("要対応のタスクはありません");
  });

  it("done originを確定event列からJSONとテキストへ集計する", async () => {
    ctx = createTestDeps();
    const automatic = ctx.deps.store.createTask({ title: "auto", body: "b", tenant: "dev" }, "tester");
    ctx.deps.store.transition({ taskId: automatic.id, to: "ready", actor: "tester" });
    ctx.deps.store.block(automatic.id, "codex-in-progress: 実装中", "tester");
    ctx.deps.store.transition({
      taskId: automatic.id,
      to: "done",
      actor: "supervisor",
      eventType: "finalized",
      payload: { outcome: "done", sessionId: "sess-1" },
    });

    const unknown = ctx.deps.store.createTask({ title: "unknown", body: "b", tenant: "dev" }, "human");
    ctx.deps.store.transition({ taskId: unknown.id, to: "todo", actor: "human" });
    ctx.deps.store.transition({ taskId: unknown.id, to: "done", actor: "human" });

    await buildProgram(ctx.deps).parseAsync(["board", "--json"], { from: "user" });
    const parsed = JSON.parse(ctx.stdout.text()) as BoardJson;
    expect(parsed.doneOrigins).toEqual({
      total: 2,
      counts: { gatePassed: 1, orchestratorHostFinalize: 0, humanDecision: 0, unknown: 1 },
      automaticCompletionRate: 0.5,
      manualRecoveryRate: 0,
      unknownRate: 0.5,
    });

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["board"], { from: "user" });
    const text = ctx.stdout.text();
    expect(text).toContain("gate_passed: 1 (50.0%)");
    expect(text).toContain("orchestrator_host_finalize: 0");
    expect(text).toContain("human_decision: 0");
    expect(text).toContain("manual recovery: 0.0%");
    expect(text).toContain("unknown: 1 (50.0%)");
  });

  it("human_queue には user-decision 等の prefix を持つ blocked タスクのみを表示する（docs/contract.md §36）", async () => {
    ctx = createTestDeps();
    const humanTask = ctx.deps.store.createTask({ title: "承認待ち", body: "b", tenant: "dev" }, "tester");
    ctx.deps.store.transition({ taskId: humanTask.id, to: "ready", actor: "tester" });
    ctx.deps.store.block(humanTask.id, "user-decision: 進め方を確認してください", "tester");

    const progressTask = ctx.deps.store.createTask({ title: "実装中", body: "b", tenant: "dev" }, "tester");
    ctx.deps.store.transition({ taskId: progressTask.id, to: "ready", actor: "tester" });
    ctx.deps.store.block(progressTask.id, "codex-in-progress: 実装中です", "tester");

    await buildProgram(ctx.deps).parseAsync(["board", "--json"], { from: "user" });

    const parsed = JSON.parse(ctx.stdout.text()) as BoardJson;
    expect(parsed.humanQueue).toHaveLength(1);
    expect(parsed.humanQueue[0]?.id).toBe(humanTask.id);
    expect(parsed.humanQueue[0]?.title).toBe("承認待ち");
    expect(parsed.humanQueue[0]?.priority).toBe(0);
    expect(parsed.humanQueue[0]?.reason).toBe("user-decision: 進め方を確認してください");
    expect(parsed.inProgress).toHaveLength(1);
    expect(parsed.inProgress[0]?.id).toBe(progressTask.id);
  });

  it("human_queue の reason は先頭60字に切り詰める", async () => {
    ctx = createTestDeps();
    const longReason = `needs-manual: ${"あ".repeat(100)}`;
    const task = ctx.deps.store.createTask({ title: "長い理由", body: "b", tenant: "dev" }, "tester");
    ctx.deps.store.transition({ taskId: task.id, to: "ready", actor: "tester" });
    ctx.deps.store.block(task.id, longReason, "tester");

    await buildProgram(ctx.deps).parseAsync(["board", "--json"], { from: "user" });

    const parsed = JSON.parse(ctx.stdout.text()) as BoardJson;
    expect(parsed.humanQueue[0]?.reason).toHaveLength(60);
    expect(parsed.humanQueue[0]?.reason).toBe(longReason.slice(0, 60));
  });

  it("--tenant 指定時は counts / in-progress / human_queue のすべてを該当 tenant のみに絞り込む", async () => {
    ctx = createTestDeps();
    const devHuman = ctx.deps.store.createTask({ title: "dev human", body: "b", tenant: "dev" }, "tester");
    ctx.deps.store.transition({ taskId: devHuman.id, to: "ready", actor: "tester" });
    ctx.deps.store.block(devHuman.id, "user-decision: dev 確認", "tester");

    const acmeHuman = ctx.deps.store.createTask({ title: "acme human", body: "b", tenant: "acme" }, "tester");
    ctx.deps.store.transition({ taskId: acmeHuman.id, to: "ready", actor: "tester" });
    ctx.deps.store.block(acmeHuman.id, "user-decision: acme 確認", "tester");

    const devProgress = ctx.deps.store.createTask({ title: "dev progress", body: "b", tenant: "dev" }, "tester");
    ctx.deps.store.transition({ taskId: devProgress.id, to: "ready", actor: "tester" });
    ctx.deps.store.block(devProgress.id, "codex-in-progress: dev 実装中", "tester");

    const acmeProgress = ctx.deps.store.createTask({ title: "acme progress", body: "b", tenant: "acme" }, "tester");
    ctx.deps.store.transition({ taskId: acmeProgress.id, to: "ready", actor: "tester" });
    ctx.deps.store.block(acmeProgress.id, "codex-in-progress: acme 実装中", "tester");

    await buildProgram(ctx.deps).parseAsync(["board", "--json", "--tenant", "dev"], { from: "user" });

    const parsed = JSON.parse(ctx.stdout.text()) as BoardJson;
    // 件数は tenant 絞り込み後に再集計される（dev の blocked は2件のみ）
    expect(parsed.counts.blocked).toBe(2);
    expect(parsed.inProgress).toHaveLength(1);
    expect(parsed.inProgress[0]?.id).toBe(devProgress.id);
    expect(parsed.humanQueue).toHaveLength(1);
    expect(parsed.humanQueue[0]?.id).toBe(devHuman.id);
  });

  it("human_queue は priority 降順で並ぶ（KanbanReadView.humanQueue と同じ並び）", async () => {
    ctx = createTestDeps();
    const low = ctx.deps.store.createTask({ title: "low", body: "b", tenant: "dev", priority: 1 }, "tester");
    ctx.deps.store.transition({ taskId: low.id, to: "ready", actor: "tester" });
    ctx.deps.store.block(low.id, "user-decision: low", "tester");

    const high = ctx.deps.store.createTask({ title: "high", body: "b", tenant: "dev", priority: 5 }, "tester");
    ctx.deps.store.transition({ taskId: high.id, to: "ready", actor: "tester" });
    ctx.deps.store.block(high.id, "user-decision: high", "tester");

    await buildProgram(ctx.deps).parseAsync(["board", "--json"], { from: "user" });

    const parsed = JSON.parse(ctx.stdout.text()) as BoardJson;
    expect(parsed.humanQueue.map((item) => item.id)).toEqual([high.id, low.id]);
  });

  it("未知フラグはエラーになる", async () => {
    ctx = createTestDeps();
    await expect(
      buildProgram(ctx.deps).parseAsync(["board", "--totally-unknown"], { from: "user" }),
    ).rejects.toThrow();
  });
});
