import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import { readBoardInstanceId } from "./readview.js";

describe("boardInstanceId migration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hachi-board-instance-id-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("新規DBで128bitのboardInstanceIdを生成する", () => {
    const dbPath = join(tempDir, "new.db");
    new SqliteKanbanStore(dbPath).close();

    expect(readBoardInstanceId(dbPath)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("同じDBを再オープンしても同じboardInstanceIdを返す", () => {
    const dbPath = join(tempDir, "reopen.db");
    new SqliteKanbanStore(dbPath).close();
    const first = readBoardInstanceId(dbPath);

    new SqliteKanbanStore(dbPath).close();

    expect(readBoardInstanceId(dbPath)).toBe(first);
  });

  it("migration前の既存DBへ適用しても既存データを保持してboardInstanceIdを生成する", () => {
    const dbPath = join(tempDir, "existing.db");
    const before = new SqliteKanbanStore(dbPath);
    const task = before.createTask({ title: "既存タスク", body: "既存データ", tenant: "dev" }, "tester");
    before.close();

    const legacy = new Database(dbPath);
    try {
      legacy.exec(`
        DELETE FROM schema_migrations WHERE version = 26;
        DROP TABLE board_metadata;
      `);
    } finally {
      legacy.close();
    }

    const migrated = new SqliteKanbanStore(dbPath);
    expect(migrated.getTask(task.id)).toEqual(task);
    migrated.close();
    expect(readBoardInstanceId(dbPath)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("別のDBファイルには別のboardInstanceIdを生成する", () => {
    const firstPath = join(tempDir, "first.db");
    const secondPath = join(tempDir, "second.db");
    new SqliteKanbanStore(firstPath).close();
    new SqliteKanbanStore(secondPath).close();

    expect(readBoardInstanceId(firstPath)).not.toBe(readBoardInstanceId(secondPath));
  });
});
