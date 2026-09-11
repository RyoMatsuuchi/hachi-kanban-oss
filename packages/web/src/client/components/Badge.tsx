// =============================================================================
// soft badge（低彩度のセマンティック状態色）。
// =============================================================================

import type { JSX, ReactNode } from "react";

export type BadgeTone =
  | "neutral"
  | "danger"
  | "info"
  | "success"
  | "warning"
  | "codex"
  | "claude"
  | "reviewer";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-surface-muted text-ink-muted",
  danger: "bg-danger-soft text-danger-strong",
  info: "bg-accent-soft text-accent-strong",
  success: "bg-ok-soft text-ok-strong",
  warning: "bg-warn-soft text-warn-strong",
  codex: "bg-accent-soft text-accent-strong",
  claude: "bg-surface-muted text-ink-muted",
  reviewer: "bg-review-soft text-review-strong",
};

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  title?: string;
  /** メタ行などの狭い場所用の小型表示 */
  compact?: boolean;
}

export function Badge(props: BadgeProps): JSX.Element {
  const tone = props.tone ?? "neutral";
  const sizeClass = props.compact === true
    ? "px-1.5 py-px text-[10px] leading-none"
    : "px-2 py-0.5 text-xs";
  return (
    <span
      title={props.title}
      className={`inline-flex w-fit items-center whitespace-nowrap rounded-md font-medium ${sizeClass} ${TONE_CLASSES[tone]} ${props.className ?? ""}`}
    >
      {props.children}
    </span>
  );
}
