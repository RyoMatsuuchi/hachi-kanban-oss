// =============================================================================
// @hachi/core の実行時定数のミラー（docs/contract.md §6, §7, §14.4 が正本）。
// クライアントバンドルは @hachi/core を型としてのみ import する方針のため
// （better-sqlite3 等の Node 専用依存をブラウザバンドルへ持ち込まないため）、
// ここに列挙値だけを意図的に複製する。値を変更する場合は必ず
// packages/core/src/types.ts と同期させること。
// =============================================================================

import type { BoardStatusLaneKey } from "../../shared/api-types.js";

/** タスク状態（archived を除く、ボードに表示され得るもの）。docs/contract.md §6 */
export const TASK_STATUSES = [
  "triage",
  "todo",
  "ready",
  "blocked",
  "review",
  "needs-integration",
  "done",
  "archived",
] as const;

/** block_reason の先頭 prefix（docs/contract.md §4/§6）。表示ラベル抽出に使う */
export const REASON_PREFIXES = [
  "codex-in-progress:",
  "claude-in-progress:",
  "user-decision:",
  "user-feedback:",
  "review-required:",
  "needs-manual:",
  "auto-launch-failed:",
] as const;

export const PROVIDERS = ["codex", "claude"] as const;

/** ツールバーの表示バケット選択肢（docs/contract.md §20 追加要件） */
export type DisplayBucket = "all" | "human_queue" | "in_progress" | BoardStatusLaneKey;

export const DISPLAY_BUCKETS: readonly { value: DisplayBucket; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "human_queue", label: "人間確認キュー" },
  { value: "in_progress", label: "自律進行中" },
  { value: "triage", label: "triage" },
  { value: "todo", label: "todo" },
  { value: "ready", label: "ready" },
  { value: "review", label: "review" },
  { value: "needs-integration", label: "needs-integration" },
  { value: "done", label: "done" },
];

/** 状態レーンの表示ラベル（done は直近件数を付記。docs/contract.md §14.3） */
export const STATE_LANE_LABELS: Record<BoardStatusLaneKey, string> = {
  triage: "triage",
  todo: "todo",
  ready: "ready",
  review: "review",
  "needs-integration": "needs-integration",
  done: "done（直近20件）",
};

export const STATE_LANE_ORDER: readonly BoardStatusLaneKey[] = [
  "triage",
  "todo",
  "ready",
  "review",
  "needs-integration",
  "done",
];
