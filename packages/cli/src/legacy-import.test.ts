// =============================================================================
// legacy-import.ts のユニットテスト（docs/contract.md §16）
// 旧 DB 相当の最小 tasks テーブルを一時ファイルに生 SQL で構築し、dry-run / apply / 冪等性 /
// blocked reason 変換 / --task 絞り込み / スキーマ差異への耐性を検証する。
// =============================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore, type KanbanStore } from "@hachi/core";
import { makeTempHome, type TempHome } from "@hachi/testing";
import {
  applyImportItem,
  buildImportPlan,
  convertLegacyBlockReason,
  formatLegacyImportReport,
  openLegacyDatabase,
  readLegacyImportState,
  readLegacyTasks,
  runLegacyImport,
  type LegacyImportPlanItem,
} from "./legacy-import.js";

/** 旧 DB 相当の最小 tasks テーブルを一時ファイルに構築する（実 DB に近い列構成） */
function createLegacyDbFile(dir: string): string {
  const dbPath = join(dir, "legacy.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT,
      assignee TEXT,
      status TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      tenant TEXT,
      result TEXT
    );
  `);
  db.close();
  return dbPath;
}

interface LegacyRowInput {
  id: string;
  title: string;
  body?: string;
  assignee?: string;
  status: string;
  priority?: number;
  createdAt: number;
  tenant?: string;
  result?: string | null;
}

function insertLegacyRow(dbPath: string, row: LegacyRowInput): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO tasks (id, title, body, assignee, status, priority, created_at, tenant, result)
     VALUES (@id, @title, @body, @assignee, @status, @priority, @createdAt, @tenant, @result)`,
  ).run({
    id: row.id,
    title: row.title,
    body: row.body ?? "",
    assignee: row.assignee ?? "",
    status: row.status,
    priority: row.priority ?? 0,
    createdAt: row.createdAt,
    tenant: row.tenant ?? "",
    result: row.result ?? null,
  });
  db.close();
}

describe("legacy-import", () => {
  // convertLegacyBlockReason / formatLegacyImportReport は純粋関数のテストで setup() を呼ばないため、
  // afterEach の後片付け対象は | undefined を許容する（setup() を呼んだテストのみ実体を持つ）。
  let tmpDir: string | undefined;
  let home: TempHome | undefined;
  let store: KanbanStore | undefined;

  afterEach(() => {
    store?.close();
    home?.cleanup();
    if (tmpDir !== undefined) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * home/store/tmpDir を新規に組み立てて返す（後片付け用に外側の let にも代入する）。
   * 戻り値を各テストでシャドーイングして使うことで、外側の | undefined 型に悩まされず
   * 具体型のまま home.env / store を参照できる。
   */
  function setup(): { dbPath: string; tmpDir: string; home: TempHome; store: KanbanStore } {
    tmpDir = mkdtempSync(join(tmpdir(), "hachi-legacy-import-"));
    home = makeTempHome();
    store = new SqliteKanbanStore(":memory:");
    const dbPath = createLegacyDbFile(tmpDir);
    return { dbPath, tmpDir, home, store };
  }

  describe("convertLegacyBlockReason", () => {
    it("既知 prefix はそのまま採用し wasConverted=false（assignee 付替不要）", () => {
      const result = convertLegacyBlockReason("user-decision: 続行判断待ち");
      expect(result.reason).toBe("user-decision: 続行判断待ち");
      expect(result.wasConverted).toBe(false);
    });

    it("in-progress prefix は supervisor 専有のため変換対象にする（wasConverted=true）", () => {
      const result = convertLegacyBlockReason("codex-in-progress: 旧セッション情報");
      expect(result.reason.startsWith("needs-manual: (imported) codex-in-progress:")).toBe(true);
      expect(result.wasConverted).toBe(true);
    });

    it("旧固有 prefix（未知）は needs-manual: (imported) に変換する（wasConverted=true）", () => {
      const result = convertLegacyBlockReason("codex-paused: 何か理由");
      expect(result.reason).toBe("needs-manual: (imported) codex-paused: 何か理由");
      expect(result.wasConverted).toBe(true);
    });

    it("200字を超える場合は先頭200字に切り詰める", () => {
      const long = "あ".repeat(300);
      const result = convertLegacyBlockReason(long);
      expect(result.reason).toBe(`needs-manual: (imported) ${"あ".repeat(200)}`);
    });

    it("空文字は (旧理由なし) に変換する", () => {
      expect(convertLegacyBlockReason("").reason).toBe("needs-manual: (imported) (旧理由なし)");
    });
  });

  describe("readLegacyTasks", () => {
    it("既定 status（triage,todo,blocked）で絞り込み、done/archived を除外する", () => {
      const { dbPath } = setup();
      insertLegacyRow(dbPath, { id: "t_1", title: "triage task", status: "triage", createdAt: 100 });
      insertLegacyRow(dbPath, { id: "t_2", title: "todo task", status: "todo", createdAt: 200 });
      insertLegacyRow(dbPath, { id: "t_3", title: "done task", status: "done", createdAt: 300 });
      insertLegacyRow(dbPath, { id: "t_4", title: "archived task", status: "archived", createdAt: 400 });

      const db = openLegacyDatabase(dbPath);
      const rows = readLegacyTasks(db, ["triage", "todo", "blocked"], []);
      db.close();

      expect(rows.map((r) => r.legacyId).sort()).toEqual(["t_1", "t_2"]);
    });

    it("--task 絞り込みで指定 id のみ返す", () => {
      const { dbPath } = setup();
      insertLegacyRow(dbPath, { id: "t_1", title: "a", status: "triage", createdAt: 100 });
      insertLegacyRow(dbPath, { id: "t_2", title: "b", status: "todo", createdAt: 200 });

      const db = openLegacyDatabase(dbPath);
      const rows = readLegacyTasks(db, ["triage", "todo", "blocked"], ["t_2"]);
      db.close();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.legacyId).toBe("t_2");
    });

    it("欠落カラム（tenant/assignee/result 等が無いスキーマ）でも既定値で読み取れる", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "hachi-legacy-import-minimal-"));
      const dbPath = join(tmpDir, "legacy-minimal.db");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL
        );
      `);
      db.prepare(`INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)`).run("t_minimal", "最小行", "triage");
      db.close();

      const readDb = openLegacyDatabase(dbPath);
      const rows = readLegacyTasks(readDb, ["triage", "todo", "blocked"], []);
      readDb.close();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        legacyId: "t_minimal",
        title: "最小行",
        status: "triage",
        body: "",
        priority: 0,
        tenant: "",
        assignee: "",
        blockReasonRaw: "",
        createdAt: 0,
      });
    });
  });

  describe("runLegacyImport（dry-run）", () => {
    it("dry-run では新ボードに書き込まない。変換後 status/block_reason を計画に含める", () => {
      const { dbPath, home, store } = setup();
      insertLegacyRow(dbPath, { id: "t_1", title: "triage", status: "triage", createdAt: 1000 });
      insertLegacyRow(dbPath, { id: "t_2", title: "todo", status: "todo", createdAt: 1100 });
      insertLegacyRow(dbPath, {
        id: "t_3",
        title: "blocked known",
        status: "blocked",
        assignee: "alice",
        createdAt: 1200,
        result: "user-decision: 確認待ち",
      });
      insertLegacyRow(dbPath, {
        id: "t_4",
        title: "blocked unknown",
        status: "blocked",
        assignee: "alice",
        createdAt: 1300,
        result: "codex-paused: 旧固有理由",
      });

      const report = runLegacyImport(home.env, store, {
        dbPath,
        statusCsv: undefined,
        taskIds: [],
        apply: false,
      });

      expect(report.apply).toBe(false);
      expect(report.applied).toEqual([]);
      expect(report.items).toHaveLength(4);

      const byId = new Map(report.items.map((item) => [item.legacy.legacyId, item]));
      expect(byId.get("t_1")?.targetStatus).toBe("triage");
      expect(byId.get("t_2")?.targetStatus).toBe("todo");
      expect(byId.get("t_3")?.targetStatus).toBe("blocked");
      expect(byId.get("t_3")?.targetBlockReason).toBe("user-decision: 確認待ち");
      // 既知 prefix のまま採用された場合は assignee 付替なし（旧 assignee を引き継ぐ）
      expect(byId.get("t_3")?.targetAssignee).toBeUndefined();
      expect(byId.get("t_4")?.targetBlockReason).toBe("needs-manual: (imported) codex-paused: 旧固有理由");
      // needs-manual: (imported) へ変換された場合は assignee=human へ付替する（docs/contract.md §16.2）
      expect(byId.get("t_4")?.targetAssignee).toBe("human");

      // dry-run のため新ボードにタスクは作られない
      expect(store.listRecent(100)).toHaveLength(0);

      // 状態ファイルが無いため fail-open 警告が出る
      expect(report.warning).toContain("状態ファイル");
    });
  });

  describe("runLegacyImport（apply）", () => {
    it("apply で新ボードへ作成し、provenance コメントと legacy_imported イベントを記録する", () => {
      const { dbPath, home, store } = setup();
      insertLegacyRow(dbPath, {
        id: "t_10",
        title: "移行対象",
        body: "本文です",
        assignee: "alice",
        status: "todo",
        priority: 5,
        tenant: "dev",
        createdAt: 1700000000,
      });

      const report = runLegacyImport(home.env, store, {
        dbPath,
        statusCsv: undefined,
        taskIds: [],
        apply: true,
      });

      expect(report.errors).toEqual([]);
      expect(report.applied).toHaveLength(1);
      const newId = report.applied[0]?.newTaskId;
      expect(newId).toBeDefined();

      const task = store.getTask(newId as string);
      expect(task?.status).toBe("todo");
      expect(task?.title).toBe("移行対象");
      expect(task?.body).toBe("本文です");
      expect(task?.assignee).toBe("alice");
      expect(task?.priority).toBe(5);
      expect(task?.tenant).toBe("dev");

      const comments = store.listComments(newId as string, 10);
      expect(comments.some((c) => c.body.includes("imported from hermes kanban t_10"))).toBe(true);

      const events = store.listEvents(newId as string, "legacy_imported", 10);
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]?.payload ?? "{}") as { legacyId?: string; legacyStatus?: string };
      expect(payload.legacyId).toBe("t_10");
      expect(payload.legacyStatus).toBe("todo");
    });

    it("blocked は triage→ready→block の経路で block_reason 付きの blocked になり、変換時は assignee=human へ付替する", () => {
      const { dbPath, home, store } = setup();
      insertLegacyRow(dbPath, {
        id: "t_20",
        title: "blocked 移行対象",
        assignee: "alice",
        status: "blocked",
        createdAt: 1700000100,
        result: "旧システム固有の理由文言",
      });

      const report = runLegacyImport(home.env, store, {
        dbPath,
        statusCsv: undefined,
        taskIds: [],
        apply: true,
      });

      expect(report.applied).toHaveLength(1);
      const newId = report.applied[0]?.newTaskId as string;
      const task = store.getTask(newId);
      expect(task?.status).toBe("blocked");
      expect(task?.blockReason).toBe("needs-manual: (imported) 旧システム固有の理由文言");
      // 未知 prefix からの変換のため、旧 assignee(alice) ではなく human へ付替される（docs/contract.md §16.2）
      expect(task?.assignee).toBe("human");
    });

    it("既知 prefix がそのまま採用された blocked は旧 assignee を引き継ぐ（付替しない）", () => {
      const { dbPath, home, store } = setup();
      insertLegacyRow(dbPath, {
        id: "t_21",
        title: "blocked 既知理由",
        assignee: "alice",
        status: "blocked",
        createdAt: 1700000150,
        result: "user-decision: 続行判断待ち",
      });

      const report = runLegacyImport(home.env, store, {
        dbPath,
        statusCsv: undefined,
        taskIds: [],
        apply: true,
      });

      expect(report.applied).toHaveLength(1);
      const newId = report.applied[0]?.newTaskId as string;
      const task = store.getTask(newId);
      expect(task?.blockReason).toBe("user-decision: 続行判断待ち");
      expect(task?.assignee).toBe("alice");
    });

    it("2回目の apply は import 済みタスクをスキップする（冪等性）", () => {
      const { dbPath, home, store } = setup();
      insertLegacyRow(dbPath, { id: "t_30", title: "重複防止対象", status: "triage", createdAt: 1700000200 });

      const first = runLegacyImport(home.env, store, {
        dbPath,
        statusCsv: undefined,
        taskIds: [],
        apply: true,
      });
      expect(first.applied).toHaveLength(1);

      const second = runLegacyImport(home.env, store, {
        dbPath,
        statusCsv: undefined,
        taskIds: [],
        apply: true,
      });
      expect(second.applied).toHaveLength(0);
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.itemStatus).toBe("already-imported");
      expect(second.items[0]?.existingNewId).toBe(first.applied[0]?.newTaskId);

      // 2回目の状態ファイル読み込みでは警告が出ない（1回目の apply で永続化されているため）
      expect(second.warning).toBeUndefined();

      // 新ボードに重複タスクが作られていないことを確認する
      expect(store.listRecent(100)).toHaveLength(1);
    });

    it("--task 絞り込みで指定した旧タスクのみ import する", () => {
      const { dbPath, home, store } = setup();
      insertLegacyRow(dbPath, { id: "t_40", title: "対象", status: "triage", createdAt: 1700000300 });
      insertLegacyRow(dbPath, { id: "t_41", title: "対象外", status: "triage", createdAt: 1700000301 });

      const report = runLegacyImport(home.env, store, {
        dbPath,
        statusCsv: undefined,
        taskIds: ["t_40"],
        apply: true,
      });

      expect(report.applied).toHaveLength(1);
      expect(report.applied[0]?.legacyId).toBe("t_40");
      expect(store.listRecent(100)).toHaveLength(1);
    });

    it("見つからない --task 指定は notFoundTaskIds に記録する", () => {
      const { dbPath, home, store } = setup();
      insertLegacyRow(dbPath, { id: "t_50", title: "存在するタスク", status: "triage", createdAt: 1700000400 });

      const report = runLegacyImport(home.env, store, {
        dbPath,
        statusCsv: undefined,
        taskIds: ["t_50", "t_does_not_exist"],
        apply: false,
      });

      expect(report.notFoundTaskIds).toEqual(["t_does_not_exist"]);
    });
  });

  describe("--status 検証", () => {
    it("done/archived を --status に指定するとエラーになる", () => {
      const { dbPath, home, store } = setup();
      expect(() =>
        runLegacyImport(home.env, store, { dbPath, statusCsv: "done", taskIds: [], apply: false }),
      ).toThrow(/done\/archived/);
    });
  });

  describe("旧 DB パス不正", () => {
    it("存在しないパスはエラーになる", () => {
      const { tmpDir, home, store } = setup();
      expect(() =>
        runLegacyImport(home.env, store, {
          dbPath: join(tmpDir, "not-exist.db"),
          statusCsv: undefined,
          taskIds: [],
          apply: false,
        }),
      ).toThrow(/見つかりません/);
    });
  });

  describe("readLegacyImportState / buildImportPlan / applyImportItem（直接呼び出し）", () => {
    it("state に無い legacyId は pending として計画される", () => {
      const { dbPath } = setup();
      insertLegacyRow(dbPath, { id: "t_60", title: "a", status: "triage", createdAt: 1 });
      const db = openLegacyDatabase(dbPath);
      const rows = readLegacyTasks(db, ["triage", "todo", "blocked"], []);
      db.close();

      const plan = buildImportPlan(rows, {});
      expect(plan).toHaveLength(1);
      expect(plan[0]?.itemStatus).toBe("pending");
    });

    it("applyImportItem は pending 以外を渡すと throw する", () => {
      const { store } = setup();
      const alreadyImported: LegacyImportPlanItem = {
        legacy: {
          legacyId: "t_70",
          title: "x",
          body: "",
          status: "triage",
          priority: 0,
          tenant: "",
          assignee: "",
          blockReasonRaw: "",
          createdAt: 0,
        },
        itemStatus: "already-imported",
        existingNewId: "t_existing",
      };
      expect(() => applyImportItem(store, alreadyImported)).toThrow();
    });

    it("状態ファイルが無い場合 readLegacyImportState は fail-open で空マップ+警告を返す", () => {
      const { home } = setup();
      const result = readLegacyImportState(home.env);
      expect(result.state).toEqual({});
      expect(result.warning).toBeDefined();
    });
  });

  describe("formatLegacyImportReport", () => {
    it("対象0件・skip0件でもクラッシュせず表示できる", () => {
      const lines = formatLegacyImportReport({
        apply: false,
        dbPath: "/tmp/legacy.db",
        statuses: ["triage", "todo", "blocked"],
        notFoundTaskIds: [],
        items: [],
        applied: [],
        errors: [],
      });
      expect(lines.join("\n")).toContain("対象件数: 0件");
    });
  });
});
