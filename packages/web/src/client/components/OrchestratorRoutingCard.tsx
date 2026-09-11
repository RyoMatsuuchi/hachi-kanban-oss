import type { JSX } from "react";
import type { OrchestratorRequestRow, TaskOrchestratorBindingRow } from "@hachi/core";
import { Card } from "./Card.js";
import { Badge } from "./Badge.js";
import { formatTimestamp } from "../lib/format.js";

export interface OrchestratorRoutingCardProps {
  request: OrchestratorRequestRow | null;
  bindings: TaskOrchestratorBindingRow[];
}

export function OrchestratorRoutingCard(props: OrchestratorRoutingCardProps): JSX.Element | null {
  if (props.request === null && props.bindings.length === 0) {
    return null;
  }
  return (
    <Card title="オーケストレータールーティング">
      <div className="space-y-3 text-sm">
        {props.bindings.length > 0 ? (
          <div>
            <p className="mb-1 text-xs font-semibold text-ink-muted">担当 binding</p>
            <ul className="space-y-1">
              {props.bindings.map((binding) => (
                <li className="flex min-w-0 items-center gap-2" key={binding.orchestratorId}>
                  <Badge tone={binding.role === "primary" ? "success" : "neutral"}>{binding.role}</Badge>
                  <span className="break-all">{binding.orchestratorId}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {props.request !== null ? (
          <div className="space-y-1 border-t border-line pt-3">
            <div className="flex items-center gap-2">
              <Badge tone={props.request.status === "waiting_human" ? "danger" : "neutral"}>
                {props.request.status}
              </Badge>
              <span className="break-all text-xs text-ink-muted">{props.request.id}</span>
            </div>
            <p className="whitespace-pre-wrap break-words text-ink">{props.request.question}</p>
            {props.request.claimantSessionId !== "" ? (
              <p className="break-all text-xs text-ink-muted">
                claimant: {props.request.claimantSessionId} / generation {props.request.claimantGeneration}
              </p>
            ) : null}
            {props.request.humanAnswer !== "" ? (
              <p className="whitespace-pre-wrap break-words rounded-md bg-surface-muted p-2">
                人間回答: {props.request.humanAnswer}
              </p>
            ) : null}
            <p className="text-xs tabular-nums text-ink-muted">更新: {formatTimestamp(props.request.updatedAt)}</p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
