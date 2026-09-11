// =============================================================================
// orchestrator スコープ読み取り（docs/contract.md §55.1 / §69.3）。
// listScopedTasks の orchestrator 判定が §69.3 の配送先解決と同一結果になることを、
// 実際に steward proposal を発行して得た delivery 集合との比較で固定する。
// =============================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import type { TaskStatus } from "./types.js";

const BASE_NOW = 1_800_000_000;

describe("orchestrator スコープの読み取り（contract §55.1 / §69.3）", () => {
  let root: string;
  let store: SqliteKanbanStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hachi-orchestrator-scope-"));
    store = new SqliteKanbanStore(join(root, "kanban.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function createTask(
    title: string,
    options: { cwd?: string; tenant?: string; status?: TaskStatus } = {},
  ): string {
    return store.createTask(
      {
        title,
        body: `cwd: ${options.cwd ?? root}`,
        tenant: options.tenant ?? "dev",
        status: options.status ?? "triage",
      },
      "test",
    ).id;
  }

  function registerOrchestrator(label: string): string {
    return store.registerOrchestrator({ label, project: "hachi", repoCommonDir: root }).id;
  }

  /**
   * §69.3 の配送先解決を「実際に走らせて」観測する。
   * steward proposal は core 側で resolveOrchestratorDeliveryTargets を通るため、
   * ここで得た delivery 集合が配送先解決の実測値になる。
   */
  function deliveredOrchestrators(taskId: string): Set<string> {
    const task = store.getTask(taskId);
    if (task === null) {
      throw new Error(`task が見つかりません: ${taskId}`);
    }
    const worktree = task.body.match(/^cwd:\s*(\S+)\s*$/m)?.[1] ?? "";
    const routing = store.createStewardProposalRequest({
      taskId,
      kind: "promote",
      reason: "配送先解決の実測",
      worktree,
      project: task.tenant,
      now: BASE_NOW,
    });
    if (routing.outcome !== "created") {
      return new Set();
    }
    return new Set(store.listStewardProposalDeliveries(routing.request.id).map((delivery) => delivery.orchestratorId));
  }

  describe("listSubtreeTaskIds", () => {
    it("root 自身と subtask 子孫を深さに関係なく返す", () => {
      const root1 = createTask("親");
      const child = createTask("子");
      const grandchild = createTask("孫");
      const unrelated = createTask("無関係");
      store.link(root1, child, "subtask");
      store.link(child, grandchild, "subtask");

      expect(new Set(store.listSubtreeTaskIds(root1))).toEqual(new Set([root1, child, grandchild]));
      expect(store.listSubtreeTaskIds(root1)).not.toContain(unrelated);
    });

    it("subtask 以外のリンク種別は辿らない", () => {
      const parent = createTask("親");
      const dependency = createTask("依存先");
      store.link(parent, dependency, "depends-on");

      expect(store.listSubtreeTaskIds(parent)).toEqual([parent]);
    });

    it("循環リンクがあっても無限ループしない", () => {
      const a = createTask("A");
      const b = createTask("B");
      const c = createTask("C");
      store.link(a, b, "subtask");
      store.link(b, c, "subtask");
      store.link(c, a, "subtask");

      expect(new Set(store.listSubtreeTaskIds(a))).toEqual(new Set([a, b, c]));
      expect(new Set(store.listSubtreeTaskIds(b))).toEqual(new Set([a, b, c]));
    });

    it("存在しない root は fail-closed で throw する", () => {
      expect(() => store.listSubtreeTaskIds("t_missing")).toThrow(/タスクが見つかりません/);
    });
  });

  describe("listScopedTasks の orchestrator 絞り込み", () => {
    it("binding されたタスクと active watch に合致するタスクの両方を返す", () => {
      const owner = registerOrchestrator("owner");
      const bound = createTask("binding");
      store.bindTaskToOrchestrator(bound, owner, "primary");

      const worktree = join(root, "wt-a");
      const watched = createTask("worktree watch", { cwd: worktree });
      store.addOrchestratorWatch({ orchestratorId: owner, scope: "worktree", selector: worktree, role: "primary" });

      const unrelated = createTask("無関係");

      const ids = store.listScopedTasks({ orchestratorId: owner }).map((task) => task.id);
      expect(new Set(ids)).toEqual(new Set([bound, watched]));
      expect(ids).not.toContain(unrelated);
    });

    it("subtree watch は子孫タスクまで担当範囲に含める", () => {
      const owner = registerOrchestrator("owner");
      const mission = createTask("ミッション");
      const child = createTask("子");
      const grandchild = createTask("孫");
      store.link(mission, child, "subtask");
      store.link(child, grandchild, "subtask");
      store.addOrchestratorWatch({ orchestratorId: owner, scope: "subtree", selector: mission, role: "primary" });

      const ids = store.listScopedTasks({ orchestratorId: owner }).map((task) => task.id);
      expect(new Set(ids)).toEqual(new Set([mission, child, grandchild]));
    });

    it("inactive な watch は担当範囲に含めない", () => {
      const owner = registerOrchestrator("owner");
      const worktree = join(root, "wt-gone");
      const task = createTask("消えた worktree", { cwd: worktree });
      const watch = store.addOrchestratorWatch({
        orchestratorId: owner,
        scope: "worktree",
        selector: worktree,
        role: "primary",
      });
      expect(store.listScopedTasks({ orchestratorId: owner }).map((row) => row.id)).toEqual([task]);

      store.setOrchestratorWatchActive(watch.id, false);
      expect(store.listScopedTasks({ orchestratorId: owner })).toEqual([]);
    });

    it("存在しない orchestrator は fail-closed で throw する", () => {
      expect(() => store.listScopedTasks({ orchestratorId: "o_missing" })).toThrow(/orchestrator が見つかりません/);
    });
  });

  describe("配送先解決との一致（§69.3）", () => {
    it("同じ board 構成で listScopedTasks と delivery 集合が完全に一致する", () => {
      const owner = registerOrchestrator("owner");
      const other = registerOrchestrator("other");
      const ownerWorktree = join(root, "wt-owner");
      const otherWorktree = join(root, "wt-other");

      store.addOrchestratorWatch({ orchestratorId: owner, scope: "worktree", selector: ownerWorktree, role: "primary" });
      store.addOrchestratorWatch({ orchestratorId: owner, scope: "project", selector: "owner-project", role: "collaborator" });
      store.addOrchestratorWatch({ orchestratorId: other, scope: "worktree", selector: otherWorktree, role: "primary" });

      // 1. binding が owner
      const boundToOwner = createTask("owner binding");
      store.bindTaskToOrchestrator(boundToOwner, owner, "primary");

      // 2. binding は other だが worktree watch は owner に合致する（binding が勝ち owner は対象外）
      const boundToOtherInOwnerWorktree = createTask("other binding / owner worktree", { cwd: ownerWorktree });
      store.bindTaskToOrchestrator(boundToOtherInOwnerWorktree, other, "primary");

      // 3. owner の observer binding のみ（observer は配送先に含めない）
      const observerOnly = createTask("owner observer binding");
      store.bindTaskToOrchestrator(observerOnly, owner, "observer");

      // 4. worktree watch のみ
      const inOwnerWorktree = createTask("owner worktree", { cwd: ownerWorktree });

      // 5. project watch のみ
      const inOwnerProject = createTask("owner project", { tenant: "owner-project" });

      // 6. subtree watch（親経由）
      const missionRoot = createTask("mission root");
      const missionChild = createTask("mission child");
      store.link(missionRoot, missionChild, "subtask");
      store.addOrchestratorWatch({ orchestratorId: owner, scope: "subtree", selector: missionRoot, role: "primary" });

      // 7. binding も watch も無い
      const orphan = createTask("orphan");

      // 8. 他 identity の worktree watch だけに合致する
      const inOtherWorktree = createTask("other worktree", { cwd: otherWorktree });

      const allTaskIds = [
        boundToOwner,
        boundToOtherInOwnerWorktree,
        observerOnly,
        inOwnerWorktree,
        inOwnerProject,
        missionRoot,
        missionChild,
        orphan,
        inOtherWorktree,
      ];

      const scoped = new Set(store.listScopedTasks({ orchestratorId: owner }).map((task) => task.id));
      const routed = new Set(allTaskIds.filter((taskId) => deliveredOrchestrators(taskId).has(owner)));

      expect(scoped).toEqual(routed);
      // 判定が「全部入り」「全部空」に退化していないことを確認する
      expect(routed).toEqual(
        new Set([boundToOwner, inOwnerWorktree, inOwnerProject, missionRoot, missionChild]),
      );
      expect(scoped.has(boundToOtherInOwnerWorktree)).toBe(false);
      expect(scoped.has(observerOnly)).toBe(false);
      expect(scoped.has(orphan)).toBe(false);
      expect(scoped.has(inOtherWorktree)).toBe(false);
    });

    it("cwd 行と selector が末尾スラッシュつきでも配送実績と一致する", () => {
      // watch selector の突合は完全一致。配送側は cwd 行を正規化しないため、
      // listScopedTasks が末尾スラッシュを削ると「配送されるのに一覧に出ない」取りこぼしになる
      const owner = registerOrchestrator("owner");
      const worktree = `${join(root, "wt-slash")}/`;
      store.addOrchestratorWatch({ orchestratorId: owner, scope: "worktree", selector: worktree, role: "primary" });
      const task = createTask("末尾スラッシュ", { cwd: worktree });

      expect(deliveredOrchestrators(task).has(owner)).toBe(true);
      expect(store.listScopedTasks({ orchestratorId: owner }).map((row) => row.id)).toEqual([task]);
    });

    it("selector だけ末尾スラッシュが無い場合も配送実績と一致する（どちらも非該当）", () => {
      const owner = registerOrchestrator("owner");
      const selector = join(root, "wt-bare");
      store.addOrchestratorWatch({ orchestratorId: owner, scope: "worktree", selector, role: "primary" });
      const task = createTask("body だけスラッシュ", { cwd: `${selector}/` });

      expect(deliveredOrchestrators(task).has(owner)).toBe(false);
      expect(store.listScopedTasks({ orchestratorId: owner })).toEqual([]);
    });
  });

  describe("絞り込みと limit / status の併用", () => {
    it("status 絞り込みと併用できる", () => {
      const owner = registerOrchestrator("owner");
      const triage = createTask("triage", { status: "triage" });
      const todo = createTask("todo", { status: "todo" });
      store.bindTaskToOrchestrator(triage, owner, "primary");
      store.bindTaskToOrchestrator(todo, owner, "primary");

      expect(store.listScopedTasks({ orchestratorId: owner, status: "todo" }).map((task) => task.id)).toEqual([todo]);
    });

    it("limit は絞り込み後の件数に効く（先に limit を掛けて取りこぼさない）", () => {
      const owner = registerOrchestrator("owner");
      const noise = Array.from({ length: 5 }, (_, index) => createTask(`noise-${index}`));
      const mine = createTask("mine");
      store.bindTaskToOrchestrator(mine, owner, "primary");

      expect(noise).toHaveLength(5);
      expect(store.listScopedTasks({ orchestratorId: owner, limit: 3 }).map((task) => task.id)).toEqual([mine]);
    });

    it("orchestrator と subtree は AND で効く", () => {
      const owner = registerOrchestrator("owner");
      const missionRoot = createTask("mission root");
      const missionChild = createTask("mission child");
      const outsideMission = createTask("mission 外");
      store.link(missionRoot, missionChild, "subtask");
      store.bindTaskToOrchestrator(missionRoot, owner, "primary");
      store.bindTaskToOrchestrator(missionChild, owner, "primary");
      store.bindTaskToOrchestrator(outsideMission, owner, "primary");

      const ids = store
        .listScopedTasks({ orchestratorId: owner, subtreeRootId: missionRoot })
        .map((task) => task.id);
      expect(new Set(ids)).toEqual(new Set([missionRoot, missionChild]));
    });
  });
});
