// lessons テーブル用の独立型。types.ts は凍結契約のため拡張しない。

export const LESSON_TRIGGERS = ["rework", "user-decision", "needs-manual"] as const;

export type LessonTrigger = (typeof LESSON_TRIGGERS)[number];

export interface LessonCreateInput {
  trigger: LessonTrigger;
  tenant: string;
  cwd: string;
  profile: string;
  body: string;
  sourceTaskId: string;
}

export interface LessonRow {
  id: number;
  createdAt: number;
  trigger: LessonTrigger;
  tenant: string;
  cwd: string;
  profile: string;
  body: string;
  sourceTaskId: string;
}

export function isLessonTrigger(value: unknown): value is LessonTrigger {
  return typeof value === "string" && (LESSON_TRIGGERS as readonly string[]).includes(value);
}
