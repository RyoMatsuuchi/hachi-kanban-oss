// =============================================================================
// オーケストレーターの担当範囲を board から引く CLI（docs/contract.md §55.1 / §69.3）。
// task list --orchestrator / --subtree、watch list の既定 active、watch prune の dry-run を固定する。
// =============================================================================

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OrchestratorWatchRow, TaskRow, TaskStatus } from "@hachi/core";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";
import { classifyWatchSelectorError } from "./orchestrator.js";

interface ListPayload {
  tasks: TaskRow[];
}

interface WatchListPayload {
  watches: OrchestratorWatchRow[];
}

interface PrunePayload {
  dryRun: boolean;
  orchestrator: string;
  scanned: number;
  stale: Array<{ id: string; selector: string; role: string }>;
  skipped: Array<{ id: string; selector: string; role: string; reason: string }>;
}

describe("orchestrator スコープの CLI（contract §55.1 / §69.3）", () => {
  let ctx: TestDeps;
  const tempDirs: string[] = [];

  afterEach(() => {
    ctx.cleanup();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `hachi-scope-${prefix}-`));
    tempDirs.push(dir);
    return dir;
  }

  function createTask(
    title: string,
    options: { cwd?: string; tenant?: string; status?: TaskStatus } = {},
  ): string {
    return ctx.deps.store.createTask(
      {
        title,
        body: `cwd: ${options.cwd ?? "/tmp/none"}`,
        tenant: options.tenant ?? "dev",
        status: options.status ?? "triage",
      },
      "test",
    ).id;
  }

  function registerOrchestrator(label: string): string {
    return ctx.deps.store.registerOrchestrator({ label, project: "hachi", repoCommonDir: "/tmp/repo" }).id;
  }

  async function run(argv: string[]): Promise<string> {
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(argv, { from: "user" });
    return ctx.stdout.text();
  }

  async function runJson<T>(argv: string[]): Promise<T> {
    return JSON.parse(await run([...argv, "--json"])) as T;
  }

  describe("task list --orchestrator", () => {
    it("binding と active watch の両方を反映する", async () => {
      ctx = createTestDeps();
      const owner = registerOrchestrator("owner");
      const other = registerOrchestrator("other");
      const worktree = "/tmp/wt-owner";

      const bound = createTask("binding");
      ctx.deps.store.bindTaskToOrchestrator(bound, owner, "primary");
      const watched = createTask("watch", { cwd: worktree });
      ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner,
        scope: "worktree",
        selector: worktree,
        role: "primary",
      });
      const foreign = createTask("他 identity");
      ctx.deps.store.bindTaskToOrchestrator(foreign, other, "primary");
      const orphan = createTask("担当なし");

      const payload = await runJson<ListPayload>(["task", "list", "--orchestrator", owner]);
      const ids = payload.tasks.map((task) => task.id);
      expect(new Set(ids)).toEqual(new Set([bound, watched]));
      expect(ids).not.toContain(foreign);
      expect(ids).not.toContain(orphan);
    });

    it("--status と併用できる", async () => {
      ctx = createTestDeps();
      const owner = registerOrchestrator("owner");
      const triage = createTask("triage", { status: "triage" });
      const todo = createTask("todo", { status: "todo" });
      ctx.deps.store.bindTaskToOrchestrator(triage, owner, "primary");
      ctx.deps.store.bindTaskToOrchestrator(todo, owner, "primary");

      const payload = await runJson<ListPayload>(["task", "list", "--orchestrator", owner, "--status", "todo"]);
      expect(payload.tasks.map((task) => task.id)).toEqual([todo]);
    });

    it("--limit は絞り込み後の件数に効く", async () => {
      ctx = createTestDeps();
      const owner = registerOrchestrator("owner");
      for (let index = 0; index < 5; index += 1) {
        createTask(`noise-${index}`);
      }
      const mine = createTask("mine");
      ctx.deps.store.bindTaskToOrchestrator(mine, owner, "primary");

      const payload = await runJson<ListPayload>(["task", "list", "--orchestrator", owner, "--limit", "3"]);
      expect(payload.tasks.map((task) => task.id)).toEqual([mine]);
    });

    it("--all と併用しても絞り込み結果を全件返す", async () => {
      ctx = createTestDeps();
      const owner = registerOrchestrator("owner");
      const mine: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const taskId = createTask(`mine-${index}`);
        ctx.deps.store.bindTaskToOrchestrator(taskId, owner, "primary");
        mine.push(taskId);
      }
      createTask("担当なし");

      // --all は無制限 sentinel を渡す。絞り込み側が sentinel を 0 件と誤解して空にしないことを固定する
      const payload = await runJson<ListPayload>(["task", "list", "--orchestrator", owner, "--all"]);
      expect(new Set(payload.tasks.map((task) => task.id))).toEqual(new Set(mine));
    });

    it("存在しない orchestrator は fail-closed で失敗する", async () => {
      ctx = createTestDeps();
      await run(["task", "list", "--orchestrator", "o_missing"]);
      expect(ctx.stderr.text()).toContain("orchestrator が見つかりません");
      expect(ctx.exitCodes).toContain(1);
    });
  });

  describe("task list --subtree", () => {
    it("指定タスクと子孫を漏れなく返す", async () => {
      ctx = createTestDeps();
      const root = createTask("親");
      const child = createTask("子");
      const grandchild = createTask("孫");
      const outside = createTask("無関係");
      ctx.deps.store.link(root, child, "subtask");
      ctx.deps.store.link(child, grandchild, "subtask");

      const payload = await runJson<ListPayload>(["task", "list", "--subtree", root]);
      const ids = payload.tasks.map((task) => task.id);
      expect(new Set(ids)).toEqual(new Set([root, child, grandchild]));
      expect(ids).not.toContain(outside);
    });

    it("循環リンクがあっても無限ループしない", async () => {
      ctx = createTestDeps();
      const a = createTask("A");
      const b = createTask("B");
      ctx.deps.store.link(a, b, "subtask");
      ctx.deps.store.link(b, a, "subtask");

      const payload = await runJson<ListPayload>(["task", "list", "--subtree", a]);
      expect(new Set(payload.tasks.map((task) => task.id))).toEqual(new Set([a, b]));
    });

    it("--orchestrator と併用すると AND で効く", async () => {
      ctx = createTestDeps();
      const owner = registerOrchestrator("owner");
      const root = createTask("親");
      const child = createTask("子");
      const outside = createTask("mission 外");
      ctx.deps.store.link(root, child, "subtask");
      for (const taskId of [root, child, outside]) {
        ctx.deps.store.bindTaskToOrchestrator(taskId, owner, "primary");
      }

      const payload = await runJson<ListPayload>([
        "task", "list", "--orchestrator", owner, "--subtree", root,
      ]);
      expect(new Set(payload.tasks.map((task) => task.id))).toEqual(new Set([root, child]));
    });
  });

  describe("orchestrator watch list", () => {
    it("既定は active のみ、--all で inactive も表示する", async () => {
      ctx = createTestDeps();
      const owner = registerOrchestrator("owner");
      const active = ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner, scope: "worktree", selector: "/tmp/live", role: "primary",
      });
      const inactive = ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner, scope: "worktree", selector: "/tmp/dead", role: "primary",
      });
      ctx.deps.store.setOrchestratorWatchActive(inactive.id, false);

      const defaults = await runJson<WatchListPayload>(["orchestrator", "watch", "list", "--orchestrator", owner]);
      expect(defaults.watches.map((watch) => watch.id)).toEqual([active.id]);

      const all = await runJson<WatchListPayload>(["orchestrator", "watch", "list", "--orchestrator", owner, "--all"]);
      expect(new Set(all.watches.map((watch) => watch.id))).toEqual(new Set([active.id, inactive.id]));
    });

    it("scope 別に並べ、subtree は対象タスクのタイトルを表示する", async () => {
      ctx = createTestDeps();
      const owner = registerOrchestrator("owner");
      const mission = createTask("ミッション本体");
      ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner, scope: "project", selector: "dev", role: "collaborator",
      });
      ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner, scope: "worktree", selector: "/tmp/live", role: "primary",
      });
      ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner, scope: "subtree", selector: mission, role: "primary",
      });

      const text = await run(["orchestrator", "watch", "list", "--orchestrator", owner]);
      const lines = text.trimEnd().split("\n");
      expect(lines.map((line) => line.split(" ")[2]?.split(":")[0])).toEqual(["subtree", "worktree", "project"]);
      expect(lines[0]).toContain("title=ミッション本体");
    });

    it("subtree watch の対象タスクが無くても throw せず (不明) を出す", async () => {
      ctx = createTestDeps();
      const owner = registerOrchestrator("owner");
      ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner, scope: "subtree", selector: "t_missing", role: "primary",
      });

      expect(await run(["orchestrator", "watch", "list", "--orchestrator", owner])).toContain("title=(不明)");
    });
  });

  describe("orchestrator watch prune", () => {
    it("既定は dry-run で、--apply 時だけ inactive 化する", async () => {
      ctx = createTestDeps();
      const owner = registerOrchestrator("owner");
      const gone = join(makeDir("gone"), "removed");
      const stale = ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner, scope: "worktree", selector: gone, role: "primary",
      });

      const dry = await runJson<PrunePayload>(["orchestrator", "watch", "prune", "--orchestrator", owner]);
      expect(dry.dryRun).toBe(true);
      expect(dry.stale.map((watch) => watch.id)).toEqual([stale.id]);
      expect(ctx.deps.store.listOrchestratorWatches(owner)[0]?.active).toBe(true);

      const applied = await runJson<PrunePayload>([
        "orchestrator", "watch", "prune", "--orchestrator", owner, "--apply",
      ]);
      expect(applied.dryRun).toBe(false);
      expect(applied.stale.map((watch) => watch.id)).toEqual([stale.id]);
      expect(ctx.deps.store.listOrchestratorWatches(owner)[0]?.active).toBe(false);
    });

    it("存在するディレクトリの watch へは触れない", async () => {
      ctx = createTestDeps();
      const owner = registerOrchestrator("owner");
      const live = makeDir("live");
      const keep = ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner, scope: "worktree", selector: live, role: "primary",
      });

      const payload = await runJson<PrunePayload>([
        "orchestrator", "watch", "prune", "--orchestrator", owner, "--apply",
      ]);
      expect(payload.stale).toEqual([]);
      expect(payload.skipped).toEqual([
        { id: keep.id, selector: live, role: "primary", reason: "present" },
      ]);
      expect(ctx.deps.store.listOrchestratorWatches(owner)[0]?.active).toBe(true);
    });

    it("symlink 先が消えている watch も stale として検出する", async () => {
      ctx = createTestDeps();
      const owner = registerOrchestrator("owner");
      const base = makeDir("symlink");
      const target = join(base, "target");
      const link = join(base, "link");
      mkdirSync(target);
      symlinkSync(target, link);
      const stale = ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner, scope: "worktree", selector: link, role: "primary",
      });

      // symlink 自体は残るが実体が消えた状態。lstat では生きて見えるので realpath で判定する
      const beforeRemoval = await runJson<PrunePayload>(["orchestrator", "watch", "prune", "--orchestrator", owner]);
      expect(beforeRemoval.stale).toEqual([]);

      rmSync(target, { recursive: true, force: true });
      const payload = await runJson<PrunePayload>([
        "orchestrator", "watch", "prune", "--orchestrator", owner, "--apply",
      ]);
      expect(payload.stale.map((watch) => watch.id)).toEqual([stale.id]);
      expect(ctx.deps.store.listOrchestratorWatches(owner)[0]?.active).toBe(false);
    });

    it("selector がディレクトリでない場合も stale として扱う", async () => {
      ctx = createTestDeps();
      const owner = registerOrchestrator("owner");
      const file = join(makeDir("file"), "not-a-dir");
      writeFileSync(file, "worktree ではなくファイル");
      const stale = ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner, scope: "worktree", selector: file, role: "primary",
      });

      const payload = await runJson<PrunePayload>(["orchestrator", "watch", "prune", "--orchestrator", owner]);
      expect(payload.stale.map((watch) => watch.id)).toEqual([stale.id]);
    });

    it("相対パスの selector は判定不能として残す（CLI の cwd 基準で誤判定しない）", async () => {
      ctx = createTestDeps();
      const owner = registerOrchestrator("owner");
      const relative = ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner, scope: "worktree", selector: "relative/worktree", role: "primary",
      });

      const payload = await runJson<PrunePayload>([
        "orchestrator", "watch", "prune", "--orchestrator", owner, "--apply",
      ]);
      expect(payload.stale).toEqual([]);
      expect(payload.skipped.map((watch) => watch.reason)).toEqual(["unknown"]);
      expect(ctx.deps.store.listOrchestratorWatches(owner)).toEqual([{ ...relative, active: true }]);
    });

    it("他 identity の watch へは触れない", async () => {
      ctx = createTestDeps();
      const owner = registerOrchestrator("owner");
      const other = registerOrchestrator("other");
      const gone = join(makeDir("gone"), "removed");
      ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner, scope: "worktree", selector: gone, role: "primary",
      });
      const foreign = ctx.deps.store.addOrchestratorWatch({
        orchestratorId: other, scope: "worktree", selector: gone, role: "primary",
      });

      const payload = await runJson<PrunePayload>([
        "orchestrator", "watch", "prune", "--orchestrator", owner, "--apply",
      ]);
      expect(payload.scanned).toBe(1);
      expect(ctx.deps.store.listOrchestratorWatches(other)).toEqual([{ ...foreign, active: true }]);
    });

    it("worktree 以外の scope と inactive な watch は走査対象にしない", async () => {
      ctx = createTestDeps();
      const owner = registerOrchestrator("owner");
      const gone = join(makeDir("gone"), "removed");
      ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner, scope: "project", selector: "dev", role: "primary",
      });
      ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner, scope: "subtree", selector: "t_x", role: "primary",
      });
      const alreadyInactive = ctx.deps.store.addOrchestratorWatch({
        orchestratorId: owner, scope: "worktree", selector: gone, role: "primary",
      });
      ctx.deps.store.setOrchestratorWatchActive(alreadyInactive.id, false);

      const payload = await runJson<PrunePayload>(["orchestrator", "watch", "prune", "--orchestrator", owner]);
      expect(payload.scanned).toBe(0);
      expect(payload.stale).toEqual([]);
    });

    it("--orchestrator は必須", async () => {
      ctx = createTestDeps();
      await expect(
        buildProgram(ctx.deps).parseAsync(["orchestrator", "watch", "prune"], { from: "user" }),
      ).rejects.toThrow();
    });

    it("消えていると断定できる errno だけを stale 扱いにする", () => {
      ctx = createTestDeps();
      expect(classifyWatchSelectorError(Object.assign(new Error("no entry"), { code: "ENOENT" }))).toBe("missing");
      expect(classifyWatchSelectorError(Object.assign(new Error("not a dir"), { code: "ENOTDIR" }))).toBe("missing");
      // 権限やリンク上限は「消えた」と断定できないため watch を残す
      expect(classifyWatchSelectorError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe("unknown");
      expect(classifyWatchSelectorError(Object.assign(new Error("loop"), { code: "ELOOP" }))).toBe("unknown");
      expect(classifyWatchSelectorError(new Error("code なし"))).toBe("unknown");
    });
  });
});
