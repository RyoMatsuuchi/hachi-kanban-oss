// =============================================================================
// hachi admin backup のビジネスロジック（docs/contract.md §19）
// better-sqlite3 の backup API でボード DB のスナップショットを
// $HACHI_KANBAN_HOME/backups/kanban-<board>-<YYYYMMDD-HHmmss>.db として作成し、
// 古い世代を keep 件まで削除する。生ファイルコピーは WAL モード中の一貫性を壊すため使わない
// （db.ts の SqliteKanbanStore は journal_mode=WAL を設定しており、生きたボードに対して安全に
// スナップショットを取るには better-sqlite3 の backup API を使う必要がある）。
// =============================================================================

import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Environment } from "@hachi/core";

/** --keep 未指定時の既定保持世代数（docs/contract.md §19） */
export const DEFAULT_BACKUP_KEEP = 14;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 文字列を正規表現の特殊文字をエスケープしたリテラルに変換する */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * board 名に完全一致するバックアップファイル名のみを判定する正規表現を組み立てる
 * （`kanban-<board>-YYYYMMDD-HHmmss.db`）。board 名は env.ts の BOARD_SLUG_REGEX により
 * `.` 等の regex メタ文字を含み得るため、必ずエスケープしてから埋め込む。
 */
export function buildBackupFileNameRegex(board: string): RegExp {
  return new RegExp(`^kanban-${escapeRegExp(board)}-\\d{8}-\\d{6}\\.db$`);
}

/** Date を JST の `YYYYMMDD-HHmmss` 文字列へ変換する（reason.ts の toJstIso8601 を参考に自前実装） */
function toJstTimestamp(date: Date): string {
  const jstDate = new Date(date.getTime() + JST_OFFSET_MS);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const year = jstDate.getUTCFullYear();
  const month = pad(jstDate.getUTCMonth() + 1);
  const day = pad(jstDate.getUTCDate());
  const hour = pad(jstDate.getUTCHours());
  const minute = pad(jstDate.getUTCMinutes());
  const second = pad(jstDate.getUTCSeconds());
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

/** runBackup() の実行結果 */
export interface BackupRunResult {
  /** 今回作成したバックアップファイルの絶対パス */
  createdPath: string;
  /** keep 世代を超過したため削除した既存バックアップファイルパス（古い順） */
  deletedPaths: string[];
}

/**
 * ボード DB のバックアップを作成し、古い世代を keep 件まで削除する（docs/contract.md §19）。
 * 1. env.dbPath の存在確認（無ければ日本語で明確に throw）
 * 2. $home/backups を mkdir -p
 * 3. better-sqlite3 の backup API で kanban-<board>-<timestamp>.db を作成
 * 4. backups 配下のうち board 名に完全一致するバックアップファイルのみを対象に、
 *    古い順で keep 件を超えた分を削除する
 */
export async function runBackup(env: Environment, keep: number): Promise<BackupRunResult> {
  if (!existsSync(env.dbPath)) {
    throw new Error(`ボード DB が見つかりません: ${env.dbPath}`);
  }

  const backupsDir = join(env.home, "backups");
  mkdirSync(backupsDir, { recursive: true });

  const timestamp = toJstTimestamp(new Date());
  const createdPath = join(backupsDir, `kanban-${env.board}-${timestamp}.db`);

  const source = new Database(env.dbPath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(createdPath);
  } finally {
    source.close();
  }

  const backupFileNameRegex = buildBackupFileNameRegex(env.board);
  const existingBackupNames = readdirSync(backupsDir)
    .filter((name) => backupFileNameRegex.test(name))
    .sort();

  const deletedPaths: string[] = [];
  const excess = existingBackupNames.length - keep;
  if (excess > 0) {
    for (const name of existingBackupNames.slice(0, excess)) {
      const targetPath = join(backupsDir, name);
      unlinkSync(targetPath);
      deletedPaths.push(targetPath);
    }
  }

  return { createdPath, deletedPaths };
}
