// =============================================================================
// タスク状態機械（docs/contract.md §6）
// 遷移許可マップと block_reason の prefix 判定を提供する。
// 不正な遷移や未知の prefix は throw する fail-closed 設計。
// =============================================================================

import { REASON_PREFIXES, type TaskStatus } from "./types.js";

/** 状態ごとの遷移許可先マップ。ここに列挙されていない遷移はすべて不正とみなす */
export const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  triage: ["todo", "ready", "archived"],
  todo: ["ready", "triage", "archived", "done"],
  ready: ["blocked", "todo", "archived"],
  blocked: ["ready", "review", "needs-integration", "done", "archived"],
  review: ["blocked", "needs-integration", "done", "archived"],
  "needs-integration": ["done", "blocked", "archived"],
  done: ["archived"],
  archived: [],
};

/** 状態遷移が許可されているかを検証する。不正な場合は throw（fail-closed） */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(`不正な状態遷移です: ${from} -> ${to}`);
  }
}

/** 進行中（worker 実行中）を表す block_reason prefix かどうかを判定する */
export function isInProgressReason(reason: string): boolean {
  return reason.startsWith("codex-in-progress:") || reason.startsWith("claude-in-progress:");
}

/** block_reason が既知の prefix（REASON_PREFIXES）のいずれかで始まっているかを判定する */
export function hasKnownReasonPrefix(reason: string): boolean {
  return REASON_PREFIXES.some((prefix) => reason.startsWith(prefix));
}
