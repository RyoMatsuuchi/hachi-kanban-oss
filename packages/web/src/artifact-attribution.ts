// =============================================================================
// artifact の stat・attach event・run を結合し、表示用の帰属を解決する純関数（contract §32.5）。
// =============================================================================

import type { EventRow, RunRow } from "@hachi/core";
import type { ArtifactEntry } from "./shared/api-types.js";

const IMAGE_ARTIFACT_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"] as const;
const SESSION_ARTIFACT_PATTERN = /^(?:transcript-full|transcript-review|transcript|prompt)-(.+)-[0-9a-f]{8}\.txt$/i;

export interface ArtifactStat {
  sizeBytes: number;
  mtimeMs: number;
}

export interface ResolveArtifactAttributionInput {
  names: readonly string[];
  stats: ReadonlyMap<string, ArtifactStat>;
  events: readonly EventRow[];
  runs: readonly RunRow[];
  /** epoch 秒 */
  now: number;
}

interface ParsedArtifactEvent {
  event: EventRow;
  runId: number | null;
  sessionId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArtifactEvent(event: EventRow, name: string): ParsedArtifactEvent | null {
  if (event.eventType !== "artifact_attached") {
    return null;
  }
  try {
    const payload: unknown = JSON.parse(event.payload);
    if (!isRecord(payload) || payload["name"] !== name) {
      return null;
    }
    const rawRunId = payload["runId"];
    const rawSessionId = payload["sessionId"];
    return {
      event,
      runId: typeof rawRunId === "number" && Number.isInteger(rawRunId) ? rawRunId : null,
      sessionId: typeof rawSessionId === "string" && rawSessionId !== "" ? rawSessionId : null,
    };
  } catch {
    return null;
  }
}

function latestArtifactEvent(events: readonly EventRow[], name: string): ParsedArtifactEvent | null {
  let latest: ParsedArtifactEvent | null = null;
  for (const event of events) {
    const parsed = parseArtifactEvent(event, name);
    if (
      parsed !== null &&
      (latest === null || parsed.event.createdAt > latest.event.createdAt ||
        (parsed.event.createdAt === latest.event.createdAt && parsed.event.id > latest.event.id))
    ) {
      latest = parsed;
    }
  }
  return latest;
}

function roleFromRun(run: RunRow): ArtifactEntry["role"] {
  try {
    const meta: unknown = JSON.parse(run.meta);
    if (isRecord(meta) && meta["role"] === "reviewer") {
      return "reviewer";
    }
    if (isRecord(meta) && meta["role"] === "rework") {
      return "rework";
    }
  } catch {
    // 旧 run や壊れた meta は worker へ縮退する。
  }
  return "worker";
}

function actorRole(event: EventRow): ArtifactEntry["role"] {
  if (event.provenance.kind === "orchestrator" || event.provenance.kind === "human") {
    return event.provenance.kind;
  }
  return "unknown";
}

function runFromEvent(event: ParsedArtifactEvent, runs: readonly RunRow[]): RunRow | null {
  const byId = event.runId === null ? null : runs.find((run) => run.id === event.runId) ?? null;
  const bySession = event.sessionId === null
    ? null
    : runs.find((run) => run.sessionId === event.sessionId) ?? null;

  if (event.runId !== null && event.sessionId !== null) {
    return byId !== null && bySession !== null && byId.id === bySession.id ? byId : null;
  }
  return byId ?? bySession;
}

function sessionIdFromFilename(name: string): string | null {
  if (name.startsWith("prompt-review-") || /^prompt-rework[0-9]+-/.test(name)) {
    return null;
  }
  return SESSION_ARTIFACT_PATTERN.exec(name)?.[1] ?? null;
}

function intervalRun(attachedAt: number, runs: readonly RunRow[], now: number): RunRow | null {
  let latest: RunRow | null = null;
  for (const run of runs) {
    const endedAt = run.endedAt ?? now;
    if (run.startedAt <= attachedAt && attachedAt <= endedAt &&
      (latest === null || run.startedAt > latest.startedAt)) {
      latest = run;
    }
  }
  return latest;
}

function artifactKind(name: string): ArtifactEntry["kind"] {
  const lowerName = name.toLowerCase();
  return IMAGE_ARTIFACT_EXTENSIONS.some((extension) => lowerName.endsWith(extension)) ? "image" : "text";
}

function unresolvedEntry(name: string, sizeBytes: number | null, attachedAt: number | null): ArtifactEntry {
  return {
    name,
    kind: artifactKind(name),
    sizeBytes,
    attachedAt,
    attachedAtSource: "mtime",
    runId: null,
    sessionId: null,
    role: "unknown",
    attributionSource: "none",
  };
}

function resolveOne(
  name: string,
  stats: ReadonlyMap<string, ArtifactStat>,
  events: readonly EventRow[],
  runs: readonly RunRow[],
  now: number,
): ArtifactEntry {
  const artifactStat = stats.get(name);
  if (artifactStat === undefined) {
    return unresolvedEntry(name, null, null);
  }

  const event = latestArtifactEvent(events, name);
  const attachedAt = event?.event.createdAt ??
    (Number.isFinite(artifactStat.mtimeMs) ? Math.floor(artifactStat.mtimeMs / 1000) : null);
  const attachedAtSource: ArtifactEntry["attachedAtSource"] = event === null ? "mtime" : "event";
  const base = {
    name,
    kind: artifactKind(name),
    sizeBytes: artifactStat.sizeBytes,
    attachedAt,
    attachedAtSource,
  } as const;

  if (event !== null && (event.runId !== null || event.sessionId !== null)) {
    const run = runFromEvent(event, runs);
    return {
      ...base,
      runId: run?.id ?? event.runId,
      sessionId: run?.sessionId ?? event.sessionId,
      role: run === null ? actorRole(event.event) : roleFromRun(run),
      attributionSource: "event-run",
    };
  }

  const filenameSessionId = sessionIdFromFilename(name);
  const filenameRun = filenameSessionId === null
    ? null
    : runs.find((run) => run.sessionId === filenameSessionId) ?? null;
  if (filenameRun !== null) {
    return {
      ...base,
      runId: filenameRun.id,
      sessionId: filenameRun.sessionId,
      role: roleFromRun(filenameRun),
      attributionSource: "filename-session",
    };
  }

  const matchedIntervalRun = attachedAt === null ? null : intervalRun(attachedAt, runs, now);
  if (matchedIntervalRun !== null) {
    return {
      ...base,
      runId: matchedIntervalRun.id,
      sessionId: matchedIntervalRun.sessionId,
      role: roleFromRun(matchedIntervalRun),
      attributionSource: "interval",
    };
  }

  return {
    ...base,
    runId: null,
    sessionId: null,
    role: event === null ? "unknown" : actorRole(event.event),
    attributionSource: "none",
  };
}

/** contract §32.5 の優先順で artifact の帰属を解決し、帰属不明を末尾へ送る。 */
export function resolveArtifactAttribution(input: ResolveArtifactAttributionInput): ArtifactEntry[] {
  const resolved = input.names.map((name) => resolveOne(name, input.stats, input.events, input.runs, input.now));
  return [
    ...resolved.filter((entry) => entry.attributionSource !== "none"),
    ...resolved.filter((entry) => entry.attributionSource === "none"),
  ];
}
