import type { JSX } from "react";
import type { EventRow } from "@hachi/core";
import { Badge, type BadgeTone } from "./Badge.js";
import { Card } from "./Card.js";

interface CompatibilityPayload {
  provider?: string;
  model?: string;
  transport?: string;
  status?: "supported" | "unsupported" | "unknown";
  reason?: string;
  detail?: string;
  expectation?: {
    minimumRuntimeVersion?: string;
    requireNativeModelDelivery?: boolean;
    requireNativeEffortDelivery?: boolean;
  };
  observed?: {
    runtime?: { name?: string; version?: string | null; source?: string };
    capabilities?: string[];
    modelCatalog?: { knowledge?: string; models?: string[]; detail?: string };
    delivery?: { model?: string; effort?: string };
  } | null;
}

const EVENT_TYPES = new Set([
  "incompatible_model_transport",
  "model_transport_compatibility_unknown",
  "model_transport_compatibility_checked",
]);

function latestPayload(events: EventRow[]): CompatibilityPayload | null {
  // KanbanReadView.events は古い→新しい時系列順なので、最新の有効な互換イベントから探す。
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) {
      continue;
    }
    if (!EVENT_TYPES.has(event.eventType)) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(event.payload);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as CompatibilityPayload;
      }
    } catch {
      // 壊れた監査 payload は推測表示せず、次の候補を探す。
    }
  }
  return null;
}

function statusTone(status: CompatibilityPayload["status"]): BadgeTone {
  if (status === "supported") {
    return "success";
  }
  if (status === "unsupported") {
    return "danger";
  }
  return "warning";
}

function value(value: string | null | undefined): string {
  return value === undefined || value === null || value === "" ? "不明" : value;
}

export function ModelTransportCard(props: { events: EventRow[] }): JSX.Element | null {
  const payload = latestPayload(props.events);
  if (payload === null) {
    return null;
  }
  const observed = payload.observed;
  const runtime = observed?.runtime;
  const capabilities = observed?.capabilities ?? [];
  return (
    <Card title="Model × transport 互換性">
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone(payload.status)}>{value(payload.status)}</Badge>
          <span className="break-all text-ink">
            {value(payload.provider)} / {value(payload.model)} / {value(payload.transport)}
          </span>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-ink-muted">期待 version</dt>
          <dd className="break-all text-ink">{value(payload.expectation?.minimumRuntimeVersion)}</dd>
          <dt className="text-ink-muted">実 runtime</dt>
          <dd className="break-all text-ink">{value(runtime?.name)} @ {value(runtime?.version)}</dd>
          <dt className="text-ink-muted">広告元</dt>
          <dd className="break-all text-ink">{value(runtime?.source)}</dd>
          <dt className="text-ink-muted">capabilities</dt>
          <dd className="break-all font-mono text-ink">{capabilities.length > 0 ? capabilities.join(", ") : "なし / 不明"}</dd>
          <dt className="text-ink-muted">model catalog</dt>
          <dd className="break-all text-ink">{value(observed?.modelCatalog?.knowledge)}</dd>
          <dt className="text-ink-muted">native delivery</dt>
          <dd className="break-all text-ink">
            model={value(observed?.delivery?.model)} effort={value(observed?.delivery?.effort)}
          </dd>
        </dl>
        {payload.status !== "supported" ? (
          <p className="break-words rounded-md bg-surface-muted p-2 text-xs text-ink">
            {value(payload.reason)}: {value(payload.detail)}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
