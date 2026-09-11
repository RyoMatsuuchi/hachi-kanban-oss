// =============================================================================
// task 系コマンドで共有するヘルパー（タスク取得・表示整形）
// =============================================================================

import type { CommentRow, EventRow, TaskRow } from "@hachi/core";
import type { CliDeps } from "./deps.js";

/** id からタスクを取得する。存在しない場合は fail-closed で throw する */
export function requireTask(deps: CliDeps, id: string): TaskRow {
  const task = deps.store.getTask(id);
  if (task === null) {
    throw new Error(`タスクが見つかりません: ${id}`);
  }
  return task;
}

/** TaskRow をテキスト表示用の1行に整形する */
export function formatTaskLine(task: TaskRow): string {
  return `${task.id} [${task.status}] ${task.title} (priority=${task.priority}, tenant=${task.tenant})`;
}

/** CommentRow をテキスト表示用の1行に整形する */
export function formatComment(comment: CommentRow): string {
  return `#${comment.id} ${comment.author}: ${comment.body}`;
}

/** EventRow をテキスト表示用の1行に整形する */
export function formatEvent(event: EventRow): string {
  return `#${event.id} ${event.eventType} actor=${event.actor} payload=${event.payload}`;
}
