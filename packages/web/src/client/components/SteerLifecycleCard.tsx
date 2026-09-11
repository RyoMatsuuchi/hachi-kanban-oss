// =============================================================================
// Durable steer lifecycle の読み取り専用表示（docs/contract.md §58 / §65.4）。
// transport受理・session観測・acknowledgeを別状態のまま示し、適用済みを推測しない。
// =============================================================================

import type { JSX } from "react";
import type { SteerDeliveryReadModel, SteerDeliveryStatus } from "@hachi/core";
import { formatTimestamp } from "../lib/format.js";
import { Badge, type BadgeTone } from "./Badge.js";
import { Card } from "./Card.js";

function statusTone(status: SteerDeliveryStatus): BadgeTone {
  switch (status) {
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

function targetTone(target: SteerDeliveryReadModel["targetState"]): BadgeTone {
  return target === "current" ? "success" : "warning";
}

export function SteerLifecycleCard(props: { deliveries: SteerDeliveryReadModel[] }): JSX.Element | null {
  if (props.deliveries.length === 0) {
    return null;
  }

  return (
    <Card title={`Durable steer（${props.deliveries.length}）`}>
      <div className="space-y-3 text-sm">
        <p className="rounded-md bg-warn-soft p-2 text-xs text-warn-strong">
          transport_accepted はtransport受理の記録です。session_observed / acknowledged
          が無ければworkerによる観測・確認は不明です。
        </p>
        <ol className="space-y-3">
          {props.deliveries.map((delivery) => (
            <li
              className="min-w-0 space-y-2 border-t border-line pt-3 first:border-t-0 first:pt-0"
              key={delivery.id}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge tone={statusTone(delivery.status)}>{delivery.status}</Badge>
                <Badge tone={targetTone(delivery.targetState)}>{delivery.targetState}</Badge>
                <span className="min-w-0 break-all font-mono text-xs text-ink-muted">
                  {delivery.id} / sequence {delivery.sequence}
                </span>
              </div>
              <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="text-ink-muted">message key</dt>
                <dd className="min-w-0 break-all font-mono text-ink">{delivery.messageKey}</dd>
                <dt className="text-ink-muted">run / session</dt>
                <dd className="min-w-0 break-all font-mono text-ink">
                  {delivery.runId} / {delivery.sessionId}
                </dd>
                <dt className="text-ink-muted">current target</dt>
                <dd className="min-w-0 break-all font-mono text-ink">
                  {delivery.currentRunId ?? "-"} / {delivery.currentSessionId ?? "-"}
                </dd>
                <dt className="text-ink-muted">cancel fence</dt>
                <dd className="font-mono text-ink">
                  expected {delivery.expectedCancelFence} / run {delivery.runCancelFence}
                </dd>
                <dt className="text-ink-muted">supersedes</dt>
                <dd className="min-w-0 break-all font-mono text-ink">{delivery.supersedesId ?? "-"}</dd>
                <dt className="text-ink-muted">observed message</dt>
                <dd className="min-w-0 break-all font-mono text-ink">{delivery.observedMessageId || "-"}</dd>
                <dt className="text-ink-muted">created / updated</dt>
                <dd className="break-words tabular-nums text-ink">
                  {formatTimestamp(delivery.createdAt)} / {formatTimestamp(delivery.updatedAt)}
                </dd>
                <dt className="text-ink-muted">observed / acknowledged</dt>
                <dd className="break-words tabular-nums text-ink">
                  {formatTimestamp(delivery.observedAt)} / {formatTimestamp(delivery.acknowledgedAt)}
                </dd>
                <dt className="text-ink-muted">resolved</dt>
                <dd className="tabular-nums text-ink">{formatTimestamp(delivery.resolvedAt)}</dd>
              </dl>
              {delivery.lastError !== "" ? (
                <p className="whitespace-pre-wrap break-words rounded-md bg-danger-soft p-2 text-xs text-danger-strong">
                  {delivery.lastError}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}
