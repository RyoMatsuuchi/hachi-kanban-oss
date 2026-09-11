// =============================================================================
// 帰属付き artifacts を run 単位で表示する（docs/contract.md §32.5）。
// =============================================================================

import type { JSX } from "react";
import type { RunRow } from "@hachi/core";
import { useMemo, useState } from "react";
import type { ArtifactEntry } from "../../shared/api-types.js";
import { formatElapsed, formatTimestamp } from "../lib/format.js";
import { Badge, type BadgeTone } from "./Badge.js";
import { Card } from "./Card.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/Collapsible.js";
import { ToggleGroup, ToggleGroupItem } from "./ui/ToggleGroup.js";

type ArtifactSegment = "all" | "latest" | "images";

interface RunMeta {
  model?: string;
}

interface ArtifactGroup {
  key: string;
  entries: ArtifactEntry[];
  run: RunRow | null;
  latestAttachedAt: number | null;
}

export interface ArtifactsCardProps {
  taskId: string;
  artifactDetails: ArtifactEntry[];
  runs?: RunRow[];
}

const ROLE_TONES: Record<ArtifactEntry["role"], BadgeTone> = {
  worker: "neutral",
  reviewer: "info",
  rework: "warning",
  orchestrator: "success",
  human: "success",
  unknown: "neutral",
};

function artifactHref(taskId: string, name: string): string {
  return `/task/${encodeURIComponent(taskId)}/artifact/${encodeURIComponent(name)}`;
}

function groupKey(entry: ArtifactEntry): string {
  if (entry.runId !== null) {
    return `run:${entry.runId}`;
  }
  if (entry.sessionId !== null) {
    return `session:${entry.sessionId}`;
  }
  return "none";
}

function compareAttachedAt(left: ArtifactEntry, right: ArtifactEntry): number {
  const byTime = (right.attachedAt ?? Number.NEGATIVE_INFINITY) -
    (left.attachedAt ?? Number.NEGATIVE_INFINITY);
  return byTime !== 0 ? byTime : left.name.localeCompare(right.name);
}

function findGroupRun(entries: readonly ArtifactEntry[], runs: readonly RunRow[]): RunRow | null {
  const runId = entries.find((entry) => entry.runId !== null)?.runId ?? null;
  if (runId !== null) {
    return runs.find((run) => run.id === runId) ?? null;
  }
  const sessionId = entries.find((entry) => entry.sessionId !== null)?.sessionId ?? null;
  return sessionId === null ? null : runs.find((run) => run.sessionId === sessionId) ?? null;
}

function groupArtifacts(entries: readonly ArtifactEntry[], runs: readonly RunRow[]): ArtifactGroup[] {
  const grouped = new Map<string, ArtifactEntry[]>();
  for (const entry of entries) {
    const key = groupKey(entry);
    const current = grouped.get(key) ?? [];
    current.push(entry);
    grouped.set(key, current);
  }
  const groups = Array.from(grouped, ([key, unsortedEntries]) => {
    const sortedEntries = [...unsortedEntries].sort(compareAttachedAt);
    return {
      key,
      entries: sortedEntries,
      run: findGroupRun(sortedEntries, runs),
      latestAttachedAt: sortedEntries[0]?.attachedAt ?? null,
    } satisfies ArtifactGroup;
  });
  groups.sort((left, right) => {
    if (left.key === "none") {
      return right.key === "none" ? 0 : 1;
    }
    if (right.key === "none") {
      return -1;
    }
    return (right.latestAttachedAt ?? Number.NEGATIVE_INFINITY) -
      (left.latestAttachedAt ?? Number.NEGATIVE_INFINITY);
  });
  return groups;
}

function parseRunMeta(raw: string): RunMeta {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const model = (parsed as Record<string, unknown>)["model"];
    return typeof model === "string" && model !== "" ? { model } : {};
  } catch {
    return {};
  }
}

function shortId(value: string | number): string {
  return String(value).slice(0, 8);
}

function formatSize(sizeBytes: number | null): string {
  return sizeBytes === null ? "size -" : `${sizeBytes.toLocaleString("ja-JP")} B`;
}

function groupTimeRange(group: ArtifactGroup): string {
  const timestamps = group.entries
    .map((entry) => entry.attachedAt)
    .filter((value): value is number => value !== null);
  const startedAt = group.run?.startedAt ?? (timestamps.length === 0 ? null : Math.min(...timestamps));
  const endedAt = group.run?.endedAt ?? (timestamps.length === 0 ? null : Math.max(...timestamps));
  return `${formatTimestamp(startedAt)} – ${formatTimestamp(endedAt)}`;
}

function groupRole(group: ArtifactGroup): ArtifactEntry["role"] {
  return group.entries[0]?.role ?? "unknown";
}

function ArtifactItem(props: { taskId: string; entry: ArtifactEntry }): JSX.Element {
  const { taskId, entry } = props;
  const href = artifactHref(taskId, entry.name);
  const attachedAt = entry.attachedAt === null
    ? `${formatTimestamp(null)}（-）`
    : `${formatTimestamp(entry.attachedAt)}（${formatElapsed(entry.attachedAt)}）`;

  return (
    <li className="min-w-0 max-w-full">
      {entry.kind === "image" ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title={entry.name}
          className="block min-w-0 rounded-md border border-line bg-surface-muted p-2 transition hover:bg-accent-soft"
        >
          <img
            src={href}
            alt={entry.name}
            loading="lazy"
            className="max-h-64 w-full max-w-full rounded-md bg-surface object-contain"
          />
          <span className="mt-2 block max-w-full truncate text-xs font-medium text-accent-strong">
            {entry.name}
          </span>
        </a>
      ) : (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title={entry.name}
          className="block max-w-full truncate rounded-md border border-line bg-surface-muted px-3 py-1.5 text-xs font-medium text-accent-strong hover:bg-accent-soft"
        >
          {entry.name}
        </a>
      )}
      <p className="mt-1 truncate text-[11px] tabular-nums text-ink-muted" title={`${attachedAt} · ${formatSize(entry.sizeBytes)}`}>
        {attachedAt} · {formatSize(entry.sizeBytes)}
      </p>
    </li>
  );
}

function ArtifactGroupView(props: {
  group: ArtifactGroup;
  taskId: string;
  defaultOpen: boolean;
}): JSX.Element {
  const { group, taskId, defaultOpen } = props;
  const role = groupRole(group);
  const runMeta = group.run === null ? {} : parseRunMeta(group.run.meta);
  const runLabel = group.key === "none" ? "run なし" : `run ${shortId(group.run?.id ?? group.entries[0]?.runId ?? "-")}`;
  const sessionId = group.run?.sessionId ?? group.entries[0]?.sessionId ?? null;

  return (
    <Collapsible
      className="rounded-md border border-line bg-surface-muted/40"
      data-artifact-group={group.key}
      defaultOpen={defaultOpen}
    >
      <h3>
        <CollapsibleTrigger className="group flex w-full min-w-0 items-start gap-2 rounded-md px-3 py-2 text-left outline-none transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent-strong/40">
          <span aria-hidden="true" className="mt-0.5 shrink-0 text-xs text-ink-muted transition-transform group-data-[state=open]:rotate-90">▶</span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone={ROLE_TONES[role]} compact>{role}</Badge>
              <span className="font-mono text-xs font-medium text-ink">{runLabel}</span>
              <span className="font-mono text-xs text-ink-muted">session {sessionId === null ? "-" : shortId(sessionId)}</span>
              {group.run === null ? null : (
                <span className="text-xs text-ink-muted">
                  {group.run.provider}{runMeta.model === undefined ? "" : ` / ${runMeta.model}`}
                </span>
              )}
              <span className="text-xs text-ink-muted">{group.entries.length} 件</span>
            </span>
            <span className="text-[11px] tabular-nums text-ink-muted">{groupTimeRange(group)}</span>
          </span>
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent className="border-t border-line px-3 py-3">
        <ul className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {group.entries.map((entry) => (
            <ArtifactItem key={entry.name} taskId={taskId} entry={entry} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ArtifactsCard(props: ArtifactsCardProps): JSX.Element {
  const { taskId, artifactDetails, runs = [] } = props;
  const [segment, setSegment] = useState<ArtifactSegment>("all");
  const groups = useMemo(() => groupArtifacts(artifactDetails, runs), [artifactDetails, runs]);
  const visibleGroups = useMemo(() => {
    if (segment === "latest") {
      return groups.slice(0, 1);
    }
    if (segment === "images") {
      return groups
        .map((group) => ({ ...group, entries: group.entries.filter((entry) => entry.kind === "image") }))
        .filter((group) => group.entries.length > 0);
    }
    return groups;
  }, [groups, segment]);

  return (
    <Card title={`artifacts（${artifactDetails.length}）`}>
      {artifactDetails.length === 0 ? (
        <p className="text-sm italic text-ink-muted">artifacts はありません</p>
      ) : (
        <div className="space-y-3">
          <ToggleGroup
            type="single"
            value={segment}
            onValueChange={(value) => {
              if (value === "all" || value === "latest" || value === "images") {
                setSegment(value);
              }
            }}
            aria-label="artifact の絞り込み"
          >
            <ToggleGroupItem value="all">すべて</ToggleGroupItem>
            <ToggleGroupItem value="latest">最新の run</ToggleGroupItem>
            <ToggleGroupItem value="images">画像のみ</ToggleGroupItem>
          </ToggleGroup>

          {visibleGroups.length === 0 ? (
            <p className="text-sm italic text-ink-muted">該当する artifacts はありません</p>
          ) : (
            <div className="space-y-2">
              {visibleGroups.map((group, index) => (
                <ArtifactGroupView
                  key={`${segment}:${group.key}`}
                  group={group}
                  taskId={taskId}
                  defaultOpen={index === 0 && group.key !== "none"}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
