// =============================================================================
// タスク全項目テーブル（docs/contract.md §14.3「task 全項目」）。
// 追加要件: MaterialM トンマナのクリーンなテーブル + 長い値の truncate/break-all 使い分け。
// =============================================================================

import type { JSX, ReactNode } from "react";
import type { TaskRow } from "@hachi/core";
import { Card } from "./Card.js";
import { Badge } from "./Badge.js";
import { formatTimestamp, humanQueueLaneLabel, providerLabel, reasonPrefixLabel } from "../lib/format.js";
import { TD_CLASS, TR_CLASS } from "../lib/table-styles.js";

function Row(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <tr className={TR_CLASS}>
      <th className="w-32 whitespace-normal break-all px-3 py-2 text-left text-[10px] font-semibold uppercase leading-tight text-ink-muted sm:w-36 sm:text-[11px]">
        {props.label}
      </th>
      <td className={TD_CLASS}>{props.children}</td>
    </tr>
  );
}

function orDash(value: string): string {
  return value === "" ? "-" : value;
}

function WrappedValue(props: { value: string }): JSX.Element {
  return (
    <span className="whitespace-pre-wrap break-all leading-relaxed text-ink">
      {orDash(props.value)}
    </span>
  );
}

export function TaskFieldsCard(props: { task: TaskRow }): JSX.Element {
  const { task } = props;
  const reasonLabel = reasonPrefixLabel(task.blockReason);
  const laneLabel = humanQueueLaneLabel(task.status, task.blockReason);

  return (
    <Card title="タスク情報">
      <div className="overflow-hidden rounded-md border border-line">
        <table className="w-full table-fixed border-collapse text-sm">
          <tbody>
            <Row label="id">
              <span className="break-all">{task.id}</span>
            </Row>
            <Row label="status">{task.status}</Row>
            <Row label="priority">{task.priority}</Row>
            <Row label="tenant">
              <div className="min-w-0 break-all">
                <WrappedValue value={task.tenant} />
              </div>
            </Row>
            <Row label="assignee">
              <WrappedValue value={task.assignee} />
            </Row>
            <Row label="provider">{providerLabel(task.provider)}</Row>
            <Row label="profile">
              <WrappedValue value={task.profile} />
            </Row>
            <Row label="model_override">
              <WrappedValue value={task.modelOverride} />
            </Row>
            <Row label="effort_override">
              <WrappedValue value={task.effortOverride} />
            </Row>
            <Row label="speed_override">
              <WrappedValue value={task.speedOverride} />
            </Row>
            <Row label="review_profile_override">
              <WrappedValue value={task.reviewProfileOverride} />
            </Row>
            <Row label="review_provider_override">{providerLabel(task.reviewProviderOverride)}</Row>
            <Row label="review_model_override">
              <WrappedValue value={task.reviewModelOverride} />
            </Row>
            <Row label="review_effort_override">
              <WrappedValue value={task.reviewEffortOverride} />
            </Row>
            <Row label="review_speed_override">
              <WrappedValue value={task.reviewSpeedOverride} />
            </Row>
            <Row label="block_reason">
              <div className="flex flex-col items-start gap-1.5">
                {laneLabel !== null ? (
                  <Badge tone={laneLabel === "判断待ち" ? "danger" : "neutral"}>{laneLabel}</Badge>
                ) : null}
                {reasonLabel !== null ? <Badge tone="danger">{reasonLabel}</Badge> : null}
                <WrappedValue value={task.blockReason} />
              </div>
            </Row>
            <Row label="consecutive_failures">{task.consecutiveFailures}</Row>
            <Row label="last_failure_error">
              <WrappedValue value={task.lastFailureError} />
            </Row>
            <Row label="created_at">
              <span className="tabular-nums">{formatTimestamp(task.createdAt)}</span>
            </Row>
            <Row label="updated_at">
              <span className="tabular-nums">{formatTimestamp(task.updatedAt)}</span>
            </Row>
            <Row label="started_at">
              <span className="tabular-nums">{formatTimestamp(task.startedAt)}</span>
            </Row>
            <Row label="completed_at">
              <span className="tabular-nums">{formatTimestamp(task.completedAt)}</span>
            </Row>
          </tbody>
        </table>
      </div>
    </Card>
  );
}
