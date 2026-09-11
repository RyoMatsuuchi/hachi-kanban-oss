// durable cancel の読み取り専用表示（docs/contract.md §57.5）。
// mutation control は置かず、transport intent と exact ack/stop 証拠を明確に分離する。

import type { JSX } from "react";
import type { CancelEvidenceState } from "@hachi/core";
import type { CancelRequestResponse } from "../../shared/api-types.js";
import { formatTimestamp } from "../lib/format.js";
import { Badge, type BadgeTone } from "./Badge.js";
import { Card } from "./Card.js";

function statusTone(status: CancelRequestResponse["status"]): BadgeTone {
  if (status === "stopped") {
    return "success";
  }
  if (status === "failed" || status === "expired") {
    return "danger";
  }
  if (status === "forcing") {
    return "warning";
  }
  return "info";
}

function evidenceTone(state: CancelEvidenceState): BadgeTone {
  if (state === "yes") {
    return "success";
  }
  if (state === "unknown") {
    return "warning";
  }
  return "neutral";
}

function evidenceLabel(label: string, state: CancelEvidenceState): JSX.Element {
  return <Badge tone={evidenceTone(state)}>{label}: {state}</Badge>;
}

function readableEvidence(value: string): string {
  return value === "" || value === "{}" ? "記録なし" : value;
}

export function CancelLifecycleCard(props: { requests: CancelRequestResponse[] }): JSX.Element | null {
  if (props.requests.length === 0) {
    return null;
  }
  const requests = props.requests;
  return (
    <Card title={`Durable cancel（${requests.length}）`}>
      <div className="space-y-3 text-sm">
        <p className="rounded-md bg-warn-soft p-2 text-xs text-warn-strong">
          Telegram は FYI です。判断は担当オーケストレーターの inbox で行い、解決不能時だけ人間へ
          エスカレーションします。
        </p>
        <ol className="space-y-3">
          {requests.map((request) => (
            <li className="min-w-0 space-y-2 border-t border-line pt-3 first:border-t-0 first:pt-0" key={request.requestId}>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge tone={statusTone(request.status)}>{request.status}</Badge>
                <span className="min-w-0 break-all font-mono text-xs text-ink-muted">
                  {request.requestId} / fence {request.cancelFence}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {evidenceLabel("delivered", request.delivered)}
                {evidenceLabel("observed", request.observed)}
                {evidenceLabel("acknowledged", request.acknowledged)}
                {evidenceLabel("stopped", request.stopped)}
              </div>
              <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="text-ink-muted">run / session</dt>
                <dd className="min-w-0 break-all font-mono text-ink">{request.runId} / {request.sessionId}</dd>
                <dt className="text-ink-muted">requester</dt>
                <dd className="min-w-0 break-all text-ink">
                  {request.orchestratorId || "host"} / generation {request.requesterGeneration ?? "-"}
                </dd>
                <dt className="text-ink-muted">deadline</dt>
                <dd className="break-words tabular-nums text-ink">{formatTimestamp(request.deadlineAt)}</dd>
                <dt className="text-ink-muted">reason</dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words text-ink">{request.reason}</dd>
                <dt className="text-ink-muted">capability</dt>
                <dd className="min-w-0 break-all font-mono text-ink">{readableEvidence(request.capabilitySnapshot)}</dd>
                <dt className="text-ink-muted">stop evidence</dt>
                <dd className="min-w-0 break-all font-mono text-ink">{readableEvidence(request.stopEvidence)}</dd>
              </dl>
              {request.lastError !== "" ? (
                <p className="whitespace-pre-wrap break-words rounded-md bg-danger-soft p-2 text-xs text-danger-strong">
                  {request.lastError}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}
