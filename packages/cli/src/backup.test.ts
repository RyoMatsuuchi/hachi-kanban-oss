// =============================================================================
// backup.ts のユニットテスト（docs/contract.md §19）
// legacy-import.test.ts のお手本に倣い、makeTempHome() + 実ファイル DB でバックアップ生成/
// 世代削除/対象外ファイルの保護を検証する。
// =============================================================================

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore, type KanbanStore } from "@hachi/core";
import { makeTempHome, type TempHome } from "@hachi/testing";
import { buildBackupFileNameRegex, DEFAULT_BACKUP_KEEP, runBackup } from "./backup.js";

describe("backup", () => {
  let home: TempHome | undefined;
  let store: KanbanStore | undefined;

  afterEach(() => {
    // (a) の意図（生きているボードに対してバックアップを取る状況を模す）のため、
    // 各テストでは store を明示的に close せずに使う。after 片付けでのみ close する。
    store?.close();
    home?.cleanup();
  });

  it("(a) バックアップファイルを作成し、開いたままの DB の内容がそのまま読み取れる", async () => {
    home = makeTempHome();
    store = new SqliteKanbanStore(home.env.dbPath);
    store.createTask({ title: "バックアップ対象タスク", body: "本文", tenant: "dev" }, "tester");

    const result = await runBackup(home.env, DEFAULT_BACKUP_KEEP);

    // ファイル名パターン（kanban-<board>-YYYYMMDD-HHmmss.db）通りであること
    expect(existsSync(result.createdPath)).toBe(true);
    const fileName = result.createdPath.split("/").pop() ?? "";
    expect(buildBackupFileNameRegex(home.env.board).test(fileName)).toBe(true);
    expect(result.deletedPaths).toEqual([]);

    // 単なるファイル存在確認だけでなく、有効な sqlite ファイルとして中身を読み取れることを確認する
    const backupDb = new Database(result.createdPath, { readonly: true, fileMustExist: true });
    const rows = backupDb.prepare("SELECT title FROM tasks").all() as Array<{ title: string }>;
    backupDb.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("バックアップ対象タスク");
  });

  it("(b) keep 世代を超えた古いバックアップを、古い順に超過分だけ削除する", async () => {
    home = makeTempHome();
    store = new SqliteKanbanStore(home.env.dbPath);
    store.createTask({ title: "t", body: "", tenant: "dev" }, "tester");

    const backupsDir = join(home.env.home, "backups");
    mkdirSync(backupsDir, { recursive: true });

    // 同一秒内の複数回 runBackup() 呼び出しによるファイル名衝突（秒精度）を避けるため、
    // ダミーの古い世代ファイルを名前だけ手作りして事前に配置しておく（クロック非依存）。
    const dummyNames = [
      "kanban-dev-20260101-000000.db",
      "kanban-dev-20260102-000000.db",
      "kanban-dev-20260103-000000.db",
    ];
    for (const name of dummyNames) {
      writeFileSync(join(backupsDir, name), "");
    }

    const result = await runBackup(home.env, 2);

    // ダミー3件 + 今回作成分1件 = 4件のうち keep=2 に収めるため、古い2件が削除される
    expect(result.deletedPaths).toEqual([
      join(backupsDir, "kanban-dev-20260101-000000.db"),
      join(backupsDir, "kanban-dev-20260102-000000.db"),
    ]);

    const remaining = readdirSync(backupsDir).filter((name) =>
      buildBackupFileNameRegex(home?.env.board ?? "dev").test(name),
    );
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain("kanban-dev-20260103-000000.db");
    expect(remaining).not.toContain("kanban-dev-20260101-000000.db");
    expect(remaining).not.toContain("kanban-dev-20260102-000000.db");
  });

  it("(c) パターンに一致しないファイルは keep 超過があっても削除対象にせず残す", async () => {
    home = makeTempHome();
    store = new SqliteKanbanStore(home.env.dbPath);
    store.createTask({ title: "t", body: "", tenant: "dev" }, "tester");

    const backupsDir = join(home.env.home, "backups");
    mkdirSync(backupsDir, { recursive: true });

    const untouchedNames = [
      "kanban-otherboard-20260101-000000.db", // 他 board 名
      "kanban-dev-20260101-000000.txt", // 拡張子違い
      "notes.txt", // ユーザーの手動ファイル
    ];
    for (const name of untouchedNames) {
      writeFileSync(join(backupsDir, name), "keep-me");
    }

    // keep=1 を超過させるためのダミーバックアップ（マッチ対象）を2件用意する
    const dummyMatchNames = ["kanban-dev-20260101-000000.db", "kanban-dev-20260102-000000.db"];
    for (const name of dummyMatchNames) {
      writeFileSync(join(backupsDir, name), "");
    }

    await runBackup(home.env, 1);

    const remainingAll = readdirSync(backupsDir);
    for (const name of untouchedNames) {
      expect(remainingAll).toContain(name);
    }
  });

  it("board 名の regex メタ文字はエスケープされ、無関係な board 名に誤マッチしない", () => {
    const regex = buildBackupFileNameRegex("dev.v2");
    expect(regex.test("kanban-dev.v2-20260101-000000.db")).toBe(true);
    // '.' が正規表現上「任意の1文字」として解釈されていたら誤ってマッチしてしまう例
    expect(regex.test("kanban-devXv2-20260101-000000.db")).toBe(false);
  });

  it("ボード DB が存在しない場合は日本語で明確にエラーになる", async () => {
    home = makeTempHome();
    // dbPath を作成しないまま呼び出す（store も生成しない）

    await expect(runBackup(home.env, DEFAULT_BACKUP_KEEP)).rejects.toThrow(/見つかりません/);
  });
});
