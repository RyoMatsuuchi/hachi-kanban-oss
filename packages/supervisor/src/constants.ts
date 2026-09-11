// supervisor 全ステージ共通の actor/author 識別子（task_events.actor / task_comments.author に使う）
export const SUPERVISOR_ACTOR = "supervisor";

// handoff 欠落救済リプロンプト後に自動回収を待つ猶予秒数（docs/contract.md §53.3）。
export const HANDOFF_NUDGE_GRACE_SECONDS = 600;

// worker question ライブ待機の猶予秒数（docs/contract.md §52.4）。
export const QUESTION_GRACE_SECONDS = 1800;
