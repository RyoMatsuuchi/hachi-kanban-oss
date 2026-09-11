// =============================================================================
// ボードレーンのタスクカード: タイトル・1行メタ・本文プレビュー。
// human_queue カードは reason をプレビューに優先表示する（docs/contract.md §37.3）。
// =============================================================================

import type {
  ForwardedRef,
  ForwardRefExoticComponent,
  JSX,
  RefAttributes,
} from "react";
import { forwardRef } from "react";
import * as m from "motion/react-m";
import type { SteerDeliveryReadModel, SteerDeliveryStatus, TaskRow } from "@hachi/core";
import { formatElapsed, providerLabel, reasonPrefixLabel } from "../lib/format.js";
import { Badge, type BadgeTone } from "./Badge.js";
import { StarIcon } from "./icons.js";
import { TenantChip } from "./TenantChip.js";

export type CardVariant = "human-queue" | "in-progress" | "plain";

export interface TaskCardProps {
  task: TaskRow;
  variant: CardVariant;
  onOpen: (taskId: string) => void;
  onToggleWatch?: (task: TaskRow) => void;
  /** board API が返す同一taskのdurable steer read model。 */
  steerDeliveries?: SteerDeliveryReadModel[];
  /** 外枠 <li> に付与する追加クラス（横スクロール帯での幅制御など、呼び出し側のレイアウト都合用） */
  className?: string;
}

function bodyPreview(body: string): string {
  const trimmed = body.trim();
  if (trimmed === "") {
    return "";
  }
  const lines = trimmed.split(/\r?\n/);
  if (lines[0]?.startsWith("cwd:")) {
    return lines.slice(1).join("\n").trim();
  }
  return trimmed;
}

/** 優先度の閾値に応じたバッジトーンを返す（70+=danger, 50-69=warning, 未満=neutral） */
function priorityTone(priority: number): BadgeTone {
  if (priority >= 70) return "danger";
  if (priority >= 50) return "warning";
  return "neutral";
}

function previewText(task: TaskRow, variant: CardVariant): string {
  const reason = task.blockReason.trim();
  if (variant === "human-queue" && reason !== "") {
    return reason;
  }

  const preview = bodyPreview(task.body);
  if (preview !== "") {
    return preview;
  }
  return reason;
}

const STEER_STATUS_ORDER: readonly SteerDeliveryStatus[] = [
  "queued",
  "dispatching",
  "transport_accepted",
  "session_observed",
  "acknowledged",
  "uncertain",
  "superseded",
  "stale_cancelled",
  "failed",
];

interface SteerStateGroup {
  status: SteerDeliveryStatus;
  targetState: SteerDeliveryReadModel["targetState"];
  count: number;
}

function groupSteerStates(deliveries: SteerDeliveryReadModel[]): SteerStateGroup[] {
  const groups = new Map<string, SteerStateGroup>();
  for (const delivery of deliveries) {
    const key = `${delivery.status}\u0000${delivery.targetState}`;
    const current = groups.get(key);
    if (current === undefined) {
      groups.set(key, { status: delivery.status, targetState: delivery.targetState, count: 1 });
    } else {
      current.count += 1;
    }
  }
  return [...groups.values()].sort((a, b) =>
    STEER_STATUS_ORDER.indexOf(a.status) - STEER_STATUS_ORDER.indexOf(b.status) ||
    a.targetState.localeCompare(b.targetState));
}

function steerStateTone(group: SteerStateGroup): BadgeTone {
  if (group.targetState !== "current") {
    return "warning";
  }
  switch (group.status) {
    case "acknowledged":
      return "success";
    case "session_observed":
      return "info";
    case "transport_accepted":
    case "uncertain":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

function TaskCardBase(props: TaskCardProps, ref: ForwardedRef<HTMLLIElement>): JSX.Element {
  const { task, variant, onOpen, onToggleWatch } = props;
  const reasonLabel = reasonPrefixLabel(task.blockReason);
  const provider = task.provider === "" ? null : providerLabel(task.provider);

  // チップ以外のテキストパーツ（provider, elapsed, reason）
  const textParts = [
    ...(provider === null ? [] : [provider]),
    formatElapsed(task.updatedAt),
    ...(variant === "human-queue" && reasonLabel !== null ? [reasonLabel] : []),
  ];
  const trailingText = textParts.join(" · ");

  // title 属性用のフルテキスト
  const metaTitle = [task.id, task.tenant || "(no tenant)", `優先度 ${task.priority}`, trailingText]
    .filter(Boolean)
    .join(" · ");
  const preview = previewText(task, variant);
  const steerStates = groupSteerStates(props.steerDeliveries ?? []);
  const listItemClassName =
    props.className === undefined || props.className === "" ? "min-w-0" : `min-w-0 ${props.className}`;
  const cardClassName = task.watched
    ? "relative min-w-0 rounded-md border border-accent/35 border-l-4 border-l-accent bg-accent-soft/70 transition hover:border-accent/60 hover:bg-accent-soft"
    : "relative min-w-0 rounded-md border border-line bg-surface transition hover:border-accent/50 hover:bg-accent-soft";
  const watchLabel = task.watched ? "ウォッチを解除" : "ウォッチ";

  return (
    <m.li
      ref={ref}
      className={listItemClassName}
      layoutId={task.id}
      layout="position"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <div className={cardClassName} data-watched={task.watched ? "true" : "false"}>
        <button
          type="button"
          onClick={() => onOpen(task.id)}
          className="block w-full min-w-0 rounded-md bg-transparent p-3 pr-11 text-left"
        >
          <div
            className="line-clamp-2 min-w-0 break-words text-sm font-semibold leading-5 text-ink"
            title={task.title}
          >
            {task.title}
          </div>
          <div
            className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-4 text-ink-muted"
            title={metaTitle}
          >
            <span className="shrink-0">{task.id}</span>
            <TenantChip tenant={task.tenant} />
            <Badge tone={priorityTone(task.priority)} compact title={`優先度 ${task.priority}`}>
              P{task.priority}
            </Badge>
            {trailingText !== "" && (
              <span className="min-w-0 truncate whitespace-nowrap">{trailingText}</span>
            )}
          </div>
          {steerStates.length > 0 ? (
            <div
              className="mt-2 flex min-w-0 flex-wrap gap-1"
              data-testid="steer-state-summary"
              aria-label={`Durable steer ${steerStates.reduce((total, group) => total + group.count, 0)}件`}
            >
              {steerStates.map((group) => {
                const staleSuffix = group.targetState === "current" ? "" : ` · ${group.targetState}`;
                const countSuffix = group.count === 1 ? "" : ` ×${group.count}`;
                return (
                  <Badge
                    key={`${group.status}:${group.targetState}`}
                    compact
                    tone={steerStateTone(group)}
                    title={`durable steer: ${group.status}, target=${group.targetState}, count=${group.count}`}
                  >
                    {group.status}{staleSuffix}{countSuffix}
                  </Badge>
                );
              })}
            </div>
          ) : null}
          {preview !== "" ? (
            <p className="mt-2 line-clamp-2 min-w-0 break-words text-xs leading-5 text-ink-muted">
              {preview}
            </p>
          ) : null}
        </button>
        <button
          type="button"
          aria-label={watchLabel}
          title={watchLabel}
          data-testid="task-watch-toggle"
          aria-pressed={task.watched}
          onClick={(event) => {
            event.stopPropagation();
            onToggleWatch?.(task);
          }}
          className={`absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-md border transition focus-visible:ring-2 focus-visible:ring-accent ${
            task.watched
              ? "border-accent/30 bg-accent-soft text-accent-strong hover:bg-surface"
              : "border-line bg-surface text-ink-muted hover:border-accent/50 hover:text-accent-strong"
          }`}
        >
          <StarIcon filled={task.watched} className="h-4 w-4" />
        </button>
      </div>
    </m.li>
  );
}

export const TaskCard: ForwardRefExoticComponent<TaskCardProps & RefAttributes<HTMLLIElement>> =
  forwardRef<HTMLLIElement, TaskCardProps>(TaskCardBase);
TaskCard.displayName = "TaskCard";
