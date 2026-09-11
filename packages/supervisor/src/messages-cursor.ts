// agent.message.v1 走査カーソルの永続化ヘルパー（docs/contract.md §12.6-5）。
// messages ステージが「どのコメント id まで走査済みか」を $HACHI_KANBAN_HOME/state/messages-cursor.json
// に記録し、全タスク×全コメントの毎tickフルスキャンを避けて増分走査（listMessageFenceComments）にする。
// クラッシュ等でカーソルが巻き戻っても agent.message.v1 の idempotencyKey 照合が重複実行を防ぐ
// （at-least-once + idempotent。書き込み失敗は例外にせず warn ログに留める）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Environment, Logger } from "@hachi/core";

interface MessagesCursorState {
  lastCommentId: number;
}

function cursorFilePath(env: Environment): string {
  return join(env.home, "state", "messages-cursor.json");
}

/**
 * カーソル（最後に走査済みの comment id）を読み込む。
 * ファイルが無い・パースに失敗した場合は 0（未走査）を返す（fail-open。
 * 冪等キー照合が重複実行を防ぐため、走査の取りこぼしより多重走査の方が安全側）。
 */
export function readMessagesCursor(env: Environment): number {
  let raw: string;
  try {
    raw = readFileSync(cursorFilePath(env), "utf8");
  } catch {
    return 0;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<MessagesCursorState>;
    return typeof parsed.lastCommentId === "number" ? parsed.lastCommentId : 0;
  } catch {
    return 0;
  }
}

/**
 * カーソルを保存する。書き込みに失敗しても例外を投げず warn ログに留める
 * （docs/contract.md §12.6-5: 次 tick で再走査されるだけで、idempotencyKey が重複実行を防ぐ）。
 */
export function writeMessagesCursor(env: Environment, lastCommentId: number, logger: Logger): void {
  try {
    mkdirSync(join(env.home, "state"), { recursive: true });
    const state: MessagesCursorState = { lastCommentId };
    writeFileSync(cursorFilePath(env), JSON.stringify(state), "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("messages: カーソルの書き込みに失敗しました（次tickで再走査されます）", { error: message });
  }
}
