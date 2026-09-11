// =============================================================================
// タスク詳細画面ヘッダー: タイトル + ステータスチップ（docs/contract.md §20.2）。
// =============================================================================

import type { JSX } from "react";
import type { TaskRow } from "@hachi/core";
import { Badge, type BadgeTone } from "./Badge.js";
import { Card } from "./Card.js";
import { StarIcon } from "./icons.js";
import { humanQueueLaneLabel, reasonPrefixLabel } from "../lib/format.js";

function statusTone(status: TaskRow["status"]): BadgeTone {
  switch (status) {
    case "done":
      return "success";
    case "blocked":
      return "danger";
    case "review":
      return "reviewer";
    case "needs-integration":
      return "warning";
    case "archived":
      return "neutral";
    default:
      return "info";
  }
}

export interface TaskHeaderCardProps {
  task: TaskRow;
  onToggleWatch?: (task: TaskRow) => void;
}

export function TaskHeaderCard(props: TaskHeaderCardProps): JSX.Element {
  const { task, onToggleWatch } = props;
  const reasonLabel = reasonPrefixLabel(task.blockReason);
  const laneLabel = humanQueueLaneLabel(task.status, task.blockReason);
  const watchLabel = task.watched ? "ウォッチを解除" : "ウォッチ";

  return (
    <Card className="space-y-2">
      <div className="flex min-w-0 items-start gap-2">
        <h1 className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-ink">{task.title}</h1>
        <button
          type="button"
          aria-label={watchLabel}
          title={watchLabel}
          data-testid="task-header-watch-toggle"
          aria-pressed={task.watched}
          onClick={(event) => {
            event.stopPropagation();
            onToggleWatch?.(task);
          }}
          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition focus-visible:ring-2 focus-visible:ring-accent ${
            task.watched
              ? "border-accent/30 bg-accent-soft text-accent-strong hover:bg-surface"
              : "border-line bg-surface text-ink-muted hover:border-accent/50 hover:text-accent-strong"
          }`}
        >
          <StarIcon filled={task.watched} className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge tone={statusTone(task.status)}>{task.status}</Badge>
        {laneLabel !== null ? (
          <Badge tone={laneLabel === "判断待ち" ? "danger" : "neutral"}>{laneLabel}</Badge>
        ) : null}
        {reasonLabel !== null ? <Badge tone="danger">{reasonLabel}</Badge> : null}
        <span className="min-w-0 truncate font-mono text-xs text-ink-muted" title={task.id}>
          {task.id}
        </span>
      </div>
    </Card>
  );
}
