import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import { createKanbanReadView, type KanbanReadViewCapabilities } from "./readview.js";

interface DatabaseSnapshot {
  schema: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  contents: Buffer;
}

describe("orchestrator scope の readonly 共通API", () => {
  let root: string;
  let dbPath: string;
  let store: SqliteKanbanStore;
  let view: KanbanReadViewCapabilities | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hachi-orchestrator-scope-readview-"));
    dbPath = join(root, "kanban.db");
    store = new SqliteKanbanStore(dbPath);
    view = undefined;
  });

  afterEach(() => {
    view?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function registerOrchestrator(label: string): string {
    return store.registerOrchestrator({ label, project: "hachi", repoCommonDir: root }).id;
  }

  function createTask(
    title: string,
    options: { cwd?: string; tenant?: string } = {},
  ): string {
    return store.createTask(
      {
        title,
        body: `cwd: ${options.cwd ?? root}`,
        tenant: options.tenant ?? "dev",
        status: "triage",
      },
      "test",
    ).id;
  }

  function openView(): KanbanReadViewCapabilities {
    view = createKanbanReadView(dbPath);
    return view;
  }

  function expectScope(
    readView: KanbanReadViewCapabilities,
    orchestratorId: string,
    taskId: string,
    expected: boolean,
  ): void {
    const storeResult = store.isOrchestratorScopedToTask(orchestratorId, taskId);
    expect(storeResult).toBe(expected);
    expect(readView.isOrchestratorScopedToTask(orchestratorId, taskId)).toBe(storeResult);
  }

  function releaseBinding(taskId: string, orchestratorId: string): void {
    const fixtureDb = new Database(dbPath);
    try {
      const result = fixtureDb
        .prepare(
          `UPDATE task_orchestrator_bindings
           SET released_at = 1
           WHERE task_id = ? AND orchestrator_id = ?`,
        )
        .run(taskId, orchestratorId);
      expect(result.changes).toBe(1);
    } finally {
      fixtureDb.close();
    }
  }

  function snapshotDatabase(): DatabaseSnapshot {
    const snapshotDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return {
        schema: snapshotDb
          .prepare(
            `SELECT type, name, tbl_name, sql
             FROM sqlite_schema
             ORDER BY type, name`,
          )
          .all() as Array<Record<string, unknown>>,
        events: snapshotDb.prepare(`SELECT * FROM task_events ORDER BY id`).all() as Array<Record<string, unknown>>,
        contents: snapshotDb.serialize(),
      };
    } finally {
      snapshotDb.close();
    }
  }

  it("primary/collaborator を候補にし、observer-only と他identity binding は watch を抑制する", () => {
    const watchedWorktree = join(root, "watched");
    const watcher = registerOrchestrator("watcher");
    const primary = registerOrchestrator("primary");
    const collaborator = registerOrchestrator("collaborator");
    const observer = registerOrchestrator("observer");
    const other = registerOrchestrator("other");
    store.addOrchestratorWatch({
      orchestratorId: watcher,
      scope: "worktree",
      selector: watchedWorktree,
      role: "primary",
    });

    const primaryTask = createTask("primary", { cwd: watchedWorktree });
    store.bindTaskToOrchestrator(primaryTask, primary, "primary");
    const collaboratorTask = createTask("collaborator", { cwd: watchedWorktree });
    store.bindTaskToOrchestrator(collaboratorTask, collaborator, "collaborator");
    const observerTask = createTask("observer-only", { cwd: watchedWorktree });
    store.bindTaskToOrchestrator(observerTask, observer, "observer");
    const otherTask = createTask("other identity", { cwd: watchedWorktree });
    store.bindTaskToOrchestrator(otherTask, other, "primary");

    const readView = openView();
    expectScope(readView, primary, primaryTask, true);
    expectScope(readView, watcher, primaryTask, false);
    expectScope(readView, collaborator, collaboratorTask, true);
    expectScope(readView, watcher, collaboratorTask, false);
    expectScope(readView, observer, observerTask, false);
    expectScope(readView, watcher, observerTask, false);
    expectScope(readView, watcher, otherTask, false);
    expectScope(readView, other, otherTask, true);
  });

  it("released binding を除外し、active binding が0件になったときだけ watch へ戻る", () => {
    const watchedWorktree = join(root, "released");
    const released = registerOrchestrator("released");
    const watcher = registerOrchestrator("watcher");
    store.addOrchestratorWatch({
      orchestratorId: watcher,
      scope: "worktree",
      selector: watchedWorktree,
      role: "primary",
    });
    const taskId = createTask("released binding", { cwd: watchedWorktree });
    store.bindTaskToOrchestrator(taskId, released, "primary");
    releaseBinding(taskId, released);

    const readView = openView();
    expectScope(readView, released, taskId, false);
    expectScope(readView, watcher, taskId, true);
  });

  it("task/subtree/worktree/project の4 scopeを扱い、depends-on を subtree 継承に使わない", () => {
    const worktree = join(root, "four-scopes");
    const tenant = "scope-project";
    const rootTask = createTask("subtree root", { cwd: join(root, "root"), tenant: "root-project" });
    const child = createTask("subtask child", { cwd: worktree, tenant });
    const dependency = createTask("depends-on child", { cwd: join(root, "dependency"), tenant: "dependency-project" });
    store.link(rootTask, child, "subtask");
    store.link(rootTask, dependency, "depends-on");

    const taskOwner = registerOrchestrator("task scope");
    const subtreeOwner = registerOrchestrator("subtree scope");
    const worktreeOwner = registerOrchestrator("worktree scope");
    const projectOwner = registerOrchestrator("project scope");
    const observer = registerOrchestrator("watch observer");
    store.addOrchestratorWatch({ orchestratorId: taskOwner, scope: "task", selector: child, role: "primary" });
    store.addOrchestratorWatch({
      orchestratorId: subtreeOwner,
      scope: "subtree",
      selector: rootTask,
      role: "collaborator",
    });
    store.addOrchestratorWatch({
      orchestratorId: worktreeOwner,
      scope: "worktree",
      selector: worktree,
      role: "primary",
    });
    store.addOrchestratorWatch({
      orchestratorId: projectOwner,
      scope: "project",
      selector: tenant,
      role: "collaborator",
    });
    store.addOrchestratorWatch({
      orchestratorId: observer,
      scope: "task",
      selector: child,
      role: "observer",
    });

    const readView = openView();
    expectScope(readView, taskOwner, child, true);
    expectScope(readView, subtreeOwner, child, true);
    expectScope(readView, worktreeOwner, child, true);
    expectScope(readView, projectOwner, child, true);
    expectScope(readView, observer, child, false);
    expectScope(readView, subtreeOwner, dependency, false);
  });

  it("同じreadonly接続でbinding候補の更新を即時反映する", () => {
    const worktree = join(root, "binding-update");
    const first = registerOrchestrator("first");
    const second = registerOrchestrator("second");
    for (const orchestratorId of [first, second]) {
      store.addOrchestratorWatch({
        orchestratorId,
        scope: "worktree",
        selector: worktree,
        role: "primary",
      });
    }
    const taskId = createTask("binding update", { cwd: worktree });
    const readView = openView();

    expectScope(readView, first, taskId, true);
    expectScope(readView, second, taskId, true);

    store.bindTaskToOrchestrator(taskId, first, "primary");
    expectScope(readView, first, taskId, true);
    expectScope(readView, second, taskId, false);

    store.bindTaskToOrchestrator(taskId, second, "collaborator");
    expectScope(readView, first, taskId, true);
    expectScope(readView, second, taskId, true);

    store.bindTaskToOrchestrator(taskId, first, "observer");
    expectScope(readView, first, taskId, false);
    expectScope(readView, second, taskId, true);
  });

  it("未知identity・未知task・DB読取失敗をStoreと同じくthrowする", () => {
    const owner = registerOrchestrator("owner");
    const taskId = createTask("known task");
    const readView = openView();

    expect(() => store.isOrchestratorScopedToTask("o_missing", taskId)).toThrow(
      "orchestrator が見つかりません: o_missing",
    );
    expect(() => readView.isOrchestratorScopedToTask("o_missing", taskId)).toThrow(
      "orchestrator が見つかりません: o_missing",
    );
    expect(() => store.isOrchestratorScopedToTask(owner, "t_missing")).toThrow(
      "タスクが見つかりません: t_missing",
    );
    expect(() => readView.isOrchestratorScopedToTask(owner, "t_missing")).toThrow(
      "タスクが見つかりません: t_missing",
    );

    readView.close();
    view = undefined;
    expect(() => readView.isOrchestratorScopedToTask(owner, taskId)).toThrow();
  });

  it("readonly判定はschema・events・DB内容を変更せず、未作成DBも生成しない", () => {
    const owner = registerOrchestrator("owner");
    const taskId = createTask("readonly");
    store.bindTaskToOrchestrator(taskId, owner, "primary");
    const before = snapshotDatabase();

    const readView = openView();
    expect(readView.isOrchestratorScopedToTask(owner, taskId)).toBe(true);
    expect(snapshotDatabase()).toEqual(before);

    const missingPath = join(root, "missing.db");
    expect(existsSync(missingPath)).toBe(false);
    expect(() => createKanbanReadView(missingPath)).toThrow();
    expect(existsSync(missingPath)).toBe(false);
  });
});
