// =============================================================================
// hachi task logs: direct / bridge / transcript artifact の統一閲覧（docs/contract.md §50.3）
// =============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fetchSessionMessages } from "@hachi/adapters";
import {
  redactRuntimeObservationText,
  redactText,
  sortCancelRequestsDescending,
  summarizeCancelRequest,
  type ModelDelivery,
  type RunCancelRequestRow,
  type RunRow,
  type SessionRef,
} from "@hachi/core";
import type { CliDeps, CliWriter } from "../deps.js";
import { formatCancelSummary } from "../cancel-observability.js";
import {
  createBridgeLogFormatterState,
  formatBridgeLogEntries,
  serializeRawBridgeEntry,
  type BridgeLogEntry,
  type BridgeLogFormatterState,
} from "./logs-format.js";

const DEFAULT_LOG_TAIL = 40;
const DIRECT_FOLLOW_INTERVAL_MS = 1_000;
const BRIDGE_FOLLOW_INTERVAL_MS = 5_000;
const READ_CHUNK_MAX_BYTES = 64 * 1024;
const WORKER_TRANSCRIPT_PREFIX = "transcript-";
const REVIEW_TRANSCRIPT_PREFIX = "transcript-review-";

export interface TaskLogsOptions {
  follow?: boolean;
  head?: number;
  tail?: number;
  json?: boolean;
}

export interface SleepFn {
  (ms: number): Promise<void>;
}

export interface FollowControl {
  shouldContinue(): boolean;
}

export interface DirectFollowDeps {
  sleep: SleepFn;
  control: FollowControl;
}

interface RunMeta {
  serverUrl: string;
  model: string;
  modelDelivery: ModelDelivery;
  transport: "bridge" | "direct";
}

interface TranscriptCandidate {
  path: string;
  mtimeMs: number;
}

interface FileSnapshot {
  exists: boolean;
  size: number;
  identity: string;
}

const FILE_CHECKPOINT_BYTES = 64;

interface LogLineWindow {
  lines: string[];
  omittedCount: number;
  leadingCount: number;
}

interface ResolvedWindowOptions {
  head: number | undefined;
  tail: number | undefined;
}

type LogTextRedactor = (value: string) => string;

export interface AuthorityStreamRedactor {
  push(value: string): string;
  flush(): string;
}

function identityRedactor(value: string): string {
  return redactRuntimeObservationText(redactText(value));
}

function authorityValues(requests: readonly RunCancelRequestRow[]): string[] {
  return [...new Set(requests.flatMap((request) => [
    request.requestNonce,
    request.acknowledgedNonce,
  ]).filter((value) => value.length > 0))].sort((left, right) => right.length - left.length);
}

/**
 * chunk境界を越えるauthority nonceを安全確定前に出力しないstream redactor。
 * secret prefixに一致する最長suffixだけを次chunkまで保留する。
 */
export function createAuthorityStreamRedactor(requests: readonly RunCancelRequestRow[]): AuthorityStreamRedactor {
  const secrets = authorityValues(requests);
  let pending = "";

  const redactPending = (flush: boolean): string => {
    if (secrets.length === 0) {
      const output = pending;
      pending = "";
      return output;
    }
    let output = "";
    while (pending.length > 0) {
      let matchIndex = -1;
      let matchedSecret = "";
      for (const secret of secrets) {
        const index = pending.indexOf(secret);
        if (index >= 0 && (matchIndex < 0 || index < matchIndex ||
            (index === matchIndex && secret.length > matchedSecret.length))) {
          matchIndex = index;
          matchedSecret = secret;
        }
      }
      if (matchIndex >= 0) {
        output += pending.slice(0, matchIndex) + "[REDACTED]";
        pending = pending.slice(matchIndex + matchedSecret.length);
        continue;
      }
      if (flush) {
        output += pending;
        pending = "";
        break;
      }
      let retainedLength = 0;
      for (const secret of secrets) {
        const limit = Math.min(secret.length - 1, pending.length);
        for (let length = limit; length > retainedLength; length -= 1) {
          if (pending.endsWith(secret.slice(0, length))) {
            retainedLength = length;
            break;
          }
        }
      }
      const safeLength = pending.length - retainedLength;
      output += pending.slice(0, safeLength);
      pending = pending.slice(safeLength);
      break;
    }
    return output;
  };

  return {
    push(value: string): string {
      pending += value;
      return redactPending(false);
    },
    flush(): string {
      return redactPending(true);
    },
  };
}

/** finite値ではstreamをflushしてから共通credential/runtime redactionへ渡す。 */
export function createTaskLogRedactor(requests: readonly RunCancelRequestRow[]): LogTextRedactor {
  return (value: string): string => {
    const stream = createAuthorityStreamRedactor(requests);
    const masked = stream.push(value) + stream.flush();
    return redactRuntimeObservationText(redactText(masked));
  };
}

function maskFiniteAuthorityValue(value: unknown, requests: readonly RunCancelRequestRow[]): unknown {
  if (typeof value === "string") {
    const stream = createAuthorityStreamRedactor(requests);
    return stream.push(value) + stream.flush();
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskFiniteAuthorityValue(item, requests));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      maskFiniteAuthorityValue(nested, requests),
    ]));
  }
  return value;
}

export interface BridgeAuthorityState {
  stream: AuthorityStreamRedactor;
  pendingTextDelta: BridgeLogEntry | null;
}

export function createBridgeAuthorityState(requests: readonly RunCancelRequestRow[]): BridgeAuthorityState {
  return { stream: createAuthorityStreamRedactor(requests), pendingTextDelta: null };
}

function flushBridgeTextDelta(
  state: BridgeAuthorityState,
  requests: readonly RunCancelRequestRow[],
): BridgeLogEntry[] {
  if (state.pendingTextDelta === null) {
    state.stream = createAuthorityStreamRedactor(requests);
    return [];
  }
  const suffix = state.stream.flush();
  const currentText = typeof state.pendingTextDelta["text"] === "string" ? state.pendingTextDelta["text"] : "";
  state.pendingTextDelta["text"] = currentText + suffix;
  const flushed = state.pendingTextDelta;
  state.pendingTextDelta = null;
  state.stream = createAuthorityStreamRedactor(requests);
  return [flushed];
}

/** text_delta burstの最後のentryだけを保留し、非delta境界でflush/resetする。 */
function maskBridgeEntries(
  entries: readonly BridgeLogEntry[],
  requests: readonly RunCancelRequestRow[],
  state: BridgeAuthorityState,
  flush: boolean,
): BridgeLogEntry[] {
  const output: BridgeLogEntry[] = [];
  for (const entry of entries) {
    if (entry["type"] !== "text_delta") {
      output.push(...flushBridgeTextDelta(state, requests));
      output.push(maskFiniteAuthorityValue(entry, requests) as BridgeLogEntry);
      continue;
    }
    if (state.pendingTextDelta !== null) {
      output.push(state.pendingTextDelta);
    }
    const finiteEntry = maskFiniteAuthorityValue({ ...entry, text: "" }, requests) as BridgeLogEntry;
    const text = typeof entry["text"] === "string" ? entry["text"] : "";
    finiteEntry["text"] = state.stream.push(text);
    state.pendingTextDelta = finiteEntry;
  }
  if (flush) {
    output.push(...flushBridgeTextDelta(state, requests));
  }
  return output;
}

export interface BridgeAuthorityRedactor {
  push(entries: readonly BridgeLogEntry[], sessionState?: unknown): BridgeLogEntry[];
  flush(): BridgeLogEntry[];
}

export function createBridgeAuthorityRedactor(
  requests: readonly RunCancelRequestRow[],
): BridgeAuthorityRedactor {
  const state = createBridgeAuthorityState(requests);
  return {
    push(entries, sessionState): BridgeLogEntry[] {
      // top-level stateの厳密なidleだけをburst境界とする。欠落/未知/busyは保留する。
      return maskBridgeEntries(entries, requests, state, sessionState === "idle");
    },
    flush(): BridgeLogEntry[] {
      return maskBridgeEntries([], requests, state, true);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function parseRunMeta(meta: string): RunMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(meta);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { serverUrl: "", model: "", modelDelivery: "none", transport: "bridge" };
  }
  const record = parsed as Record<string, unknown>;
  const serverUrl = typeof record["serverUrl"] === "string" ? record["serverUrl"] : "";
  const model = typeof record["model"] === "string" ? record["model"] : "";
  const modelDelivery: ModelDelivery = record["modelDelivery"] === "native" ? "native" : "none";
  const transport = record["transport"] === "direct" || serverUrl === "direct" ? "direct" : "bridge";
  return { serverUrl, model, modelDelivery, transport };
}

function toSessionRef(run: RunRow, meta: RunMeta): SessionRef {
  return {
    provider: run.provider,
    sessionId: run.sessionId,
    serverUrl: meta.serverUrl,
    model: meta.model,
    modelDelivery: meta.modelDelivery,
    startedAt: run.startedAt,
  };
}

function directOutputPath(deps: CliDeps, sessionId: string): string {
  return join(deps.env.home, "state", "direct-sessions", `${sessionId}.out`);
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function tailLines(lines: readonly string[], count: number): string[] {
  return lines.slice(Math.max(0, lines.length - count));
}

function resolveWindowOptions(options: TaskLogsOptions): ResolvedWindowOptions {
  return {
    head: options.head,
    tail: options.tail ?? (options.head === undefined ? DEFAULT_LOG_TAIL : undefined),
  };
}

function selectLogLineWindow(lines: readonly string[], head: number | undefined, tail: number | undefined): LogLineWindow {
  if (tail === 0) {
    return { lines: [...lines], omittedCount: 0, leadingCount: lines.length };
  }
  if (head === undefined && tail === undefined) {
    return { lines: [...lines], omittedCount: 0, leadingCount: lines.length };
  }
  if (head === undefined) {
    const selected = tailLines(lines, tail ?? 0);
    return { lines: selected, omittedCount: 0, leadingCount: selected.length };
  }
  if (tail === undefined) {
    const selected = lines.slice(0, head);
    return { lines: selected, omittedCount: 0, leadingCount: selected.length };
  }
  if (lines.length <= head + tail) {
    return { lines: [...lines], omittedCount: 0, leadingCount: lines.length };
  }
  const headLines = lines.slice(0, head);
  const tailStart = Math.max(head, lines.length - tail);
  const tailLineWindow = lines.slice(tailStart);
  return {
    lines: [...headLines, ...tailLineWindow],
    omittedCount: tailStart - head,
    leadingCount: headLines.length,
  };
}

function readLines(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  const stats = statSync(path);
  if (!stats.isFile()) {
    return [];
  }
  return splitLines(readFileSync(path, "utf8"));
}

function writeTextWindow(stdout: CliWriter, window: LogLineWindow, redact: LogTextRedactor = identityRedactor): void {
  for (const [index, line] of window.lines.entries()) {
    stdout.write(`${redact(line)}\n`);
    if (window.omittedCount > 0 && index + 1 === window.leadingCount) {
      stdout.write(`…(${window.omittedCount} 行省略)…\n`);
    }
  }
}

function writeJsonLines(stdout: CliWriter, lines: readonly string[], redact: LogTextRedactor = identityRedactor): void {
  for (const line of lines) {
    stdout.write(`${JSON.stringify({ line: redact(line) })}\n`);
  }
}

function statFile(path: string): FileSnapshot {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      return { exists: false, size: 0, identity: "" };
    }
    return { exists: true, size: stats.size, identity: `${stats.dev}:${stats.ino}` };
  } catch {
    return { exists: false, size: 0, identity: "" };
  }
}

function readRange(path: string, start: number, end: number): string {
  const length = Math.max(0, end - start);
  if (length === 0) {
    return "";
  }
  const all = readFileSync(path);
  return all.subarray(start, end).toString("utf8");
}

function readFileCheckpoint(path: string, offset: number): string {
  return readRange(path, Math.max(0, offset - FILE_CHECKPOINT_BYTES), offset);
}

export async function followDirectLog(
  path: string,
  stdout: CliWriter,
  json: boolean,
  deps: DirectFollowDeps = {
    sleep,
    control: { shouldContinue: (): boolean => true },
  },
  authorityStream: AuthorityStreamRedactor = createAuthorityStreamRedactor([]),
): Promise<void> {
  const initial = statFile(path);
  let offset = initial.size;
  let fileIdentity = initial.identity;
  let fileCheckpoint = initial.exists ? readFileCheckpoint(path, offset) : "";
  const stream = authorityStream;
  const emitSafeChunk = (value: string): void => {
    if (value.length === 0) {
      return;
    }
    if (json) {
      stdout.write(`${JSON.stringify({ line: identityRedactor(value) })}\n`);
    } else {
      stdout.write(identityRedactor(value));
    }
  };
  const emitGenerationBoundary = (): void => {
    emitSafeChunk("\n[log generation boundary]\n");
  };
  while (deps.control.shouldContinue()) {
    await deps.sleep(DIRECT_FOLLOW_INTERVAL_MS);
    const snapshot = statFile(path);
    if (!snapshot.exists) {
      if (fileIdentity !== "") {
        emitSafeChunk(stream.flush());
        emitGenerationBoundary();
      }
      offset = 0;
      fileIdentity = "";
      fileCheckpoint = "";
      continue;
    }
    if (fileIdentity === "") {
      fileIdentity = snapshot.identity;
      offset = 0;
      fileCheckpoint = "";
    } else if (
      snapshot.identity !== fileIdentity ||
      snapshot.size < offset ||
      readFileCheckpoint(path, offset) !== fileCheckpoint
    ) {
      emitSafeChunk(stream.flush());
      emitGenerationBoundary();
      fileIdentity = snapshot.identity;
      offset = 0;
      fileCheckpoint = "";
    }
    if (snapshot.size === offset) {
      continue;
    }
    const nextOffset = snapshot.size;
    const start = Math.max(offset, nextOffset - READ_CHUNK_MAX_BYTES);
    const text = readRange(path, start, nextOffset);
    emitSafeChunk(stream.push(text));
    offset = nextOffset;
    fileCheckpoint = readFileCheckpoint(path, offset);
  }
  emitSafeChunk(stream.flush());
}

function findLatestTranscript(deps: CliDeps, taskId: string): TranscriptCandidate | null {
  const dir = join(deps.env.artifactsDir, taskId);
  if (!existsSync(dir)) {
    return null;
  }
  const candidates: TranscriptCandidate[] = [];
  for (const name of readdirSync(dir)) {
    if (
      !name.startsWith(WORKER_TRANSCRIPT_PREFIX) ||
      name.startsWith(REVIEW_TRANSCRIPT_PREFIX) ||
      !name.endsWith(".txt")
    ) {
      continue;
    }
    const path = join(dir, basename(name));
    const stats = statSync(path);
    if (stats.isFile()) {
      candidates.push({ path, mtimeMs: stats.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
  return candidates[0] ?? null;
}

function emitClosedTranscript(
  deps: CliDeps,
  taskId: string,
  head: number | undefined,
  tail: number | undefined,
  json: boolean,
  redact: LogTextRedactor,
): void {
  const transcript = findLatestTranscript(deps, taskId);
  if (transcript === null) {
    if (!json) {
      deps.stdout.write("(終了済み run のログはありません)\n");
    }
    return;
  }
  if (!json) {
    deps.stdout.write("(終了済み run のログ)\n");
  }
  const window = selectLogLineWindow(readLines(transcript.path), head, tail);
  if (json) {
    writeJsonLines(deps.stdout, window.lines, redact);
  } else {
    writeTextWindow(deps.stdout, window, redact);
  }
}

function emitDirectTail(
  deps: CliDeps,
  sessionId: string,
  head: number | undefined,
  tail: number | undefined,
  json: boolean,
  redact: LogTextRedactor,
): string {
  const path = directOutputPath(deps, sessionId);
  const window = selectLogLineWindow(readLines(path), head, tail);
  if (window.lines.length === 0 && !json && !existsSync(path)) {
    deps.stdout.write(`${redact(`(direct ログファイルなし: ${path})`)}\n`);
  }
  if (json) {
    writeJsonLines(deps.stdout, window.lines, redact);
  } else {
    writeTextWindow(deps.stdout, window, redact);
  }
  return path;
}

async function emitBridgeMessages(
  deps: CliDeps,
  ref: SessionRef,
  json: boolean,
  seenIds: Set<string>,
  formatterState: BridgeLogFormatterState,
  cancelRequests: readonly RunCancelRequestRow[],
  authorityState: BridgeAuthorityState,
  flushAuthorityStream: boolean,
  head?: number,
  tail?: number,
): Promise<BridgeLogFormatterState> {
  const messages = await fetchSessionMessages(deps.env.bridges[ref.provider], ref);
  const entries: BridgeLogEntry[] = [];
  for (const entry of messages.entries) {
    const id = entry["id"];
    const key = typeof id === "string" ? id : JSON.stringify(entry);
    if (seenIds.has(key)) {
      continue;
    }
    seenIds.add(key);
    entries.push(entry);
  }
  // followは通常終了しないため、bridgeが明示したidleをburst境界としてflush/resetする。
  const maskedEntries = maskBridgeEntries(
    entries,
    cancelRequests,
    authorityState,
    flushAuthorityStream || messages.state === "idle",
  );
  return emitMaskedBridgeEntries(deps, json, maskedEntries, formatterState, head, tail);
}

function emitMaskedBridgeEntries(
  deps: CliDeps,
  json: boolean,
  maskedEntries: readonly BridgeLogEntry[],
  formatterState: BridgeLogFormatterState,
  head?: number,
  tail?: number,
): BridgeLogFormatterState {
  if (json) {
    const window = selectLogLineWindow(
      maskedEntries.map((entry) => identityRedactor(serializeRawBridgeEntry(entry))),
      head,
      tail,
    );
    for (const entry of window.lines) {
      deps.stdout.write(`${entry}\n`);
    }
    return formatterState;
  }
  const formatted = formatBridgeLogEntries(maskedEntries, formatterState);
  writeTextWindow(deps.stdout, selectLogLineWindow(formatted.lines, head, tail));
  return formatted.state;
}

interface BridgeFollowDeps {
  sleep: SleepFn;
  control: FollowControl;
}

export async function followBridgeMessages(
  deps: CliDeps,
  ref: SessionRef,
  json: boolean,
  seenIds: Set<string>,
  formatterState: BridgeLogFormatterState,
  cancelRequests: readonly RunCancelRequestRow[],
  authorityState: BridgeAuthorityState,
  followDeps: BridgeFollowDeps = {
    sleep,
    control: { shouldContinue: (): boolean => true },
  },
): Promise<void> {
  let state = formatterState;
  while (followDeps.control.shouldContinue()) {
    await followDeps.sleep(BRIDGE_FOLLOW_INTERVAL_MS);
    state = await emitBridgeMessages(deps, ref, json, seenIds, state, cancelRequests, authorityState, false);
  }
  const flushed = maskBridgeEntries([], cancelRequests, authorityState, true);
  emitMaskedBridgeEntries(deps, json, flushed, state);
}

export async function runTaskLogs(deps: CliDeps, id: string, options: TaskLogsOptions): Promise<void> {
  const task = deps.store.getTask(id);
  if (task === null) {
    throw new Error(`タスクが見つかりません: ${id}`);
  }

  const { head, tail } = resolveWindowOptions(options);
  const json = options.json === true;
  const cancelRequests = sortCancelRequestsDescending(deps.store.listRunCancelRequests(id));
  const redact = createTaskLogRedactor(cancelRequests);
  const cancel = cancelRequests[0];
  if (cancel !== undefined) {
    const summary = summarizeCancelRequest(cancel);
    if (json) {
      deps.stdout.write(`${redact(JSON.stringify({ type: "cancel-state", cancel: summary }))}\n`);
    } else {
      deps.stdout.write(`${redact(`[cancel] ${formatCancelSummary(summary)}`)}\n`);
    }
  }
  const run = deps.store.getLatestOpenRun(id);
  if (run === null) {
    emitClosedTranscript(deps, id, head, tail, json, redact);
    return;
  }

  const meta = parseRunMeta(run.meta);
  if (meta.transport === "direct") {
    const path = emitDirectTail(deps, run.sessionId, head, tail, json, redact);
    if (options.follow === true) {
      await followDirectLog(path, deps.stdout, json, undefined, createAuthorityStreamRedactor(cancelRequests));
    }
    return;
  }

  const ref = toSessionRef(run, meta);
  const seenIds = new Set<string>();
  const authorityState = createBridgeAuthorityState(cancelRequests);
  const formatterState = await emitBridgeMessages(
    deps,
    ref,
    json,
    seenIds,
    createBridgeLogFormatterState(),
    cancelRequests,
    authorityState,
    options.follow !== true,
    head,
    tail,
  );
  if (options.follow === true) {
    await followBridgeMessages(deps, ref, json, seenIds, formatterState, cancelRequests, authorityState);
  }
}
