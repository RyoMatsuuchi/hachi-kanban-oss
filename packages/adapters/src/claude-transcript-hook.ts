// Claude Code の公開 Stop hook を Hachi-owned stateDir へ束縛する helper。
//
// Claude hook は provider process が stdin へ渡す JSON だけを入力にし、
// undocumented socket や ~/.claude の内部ファイルを参照しない。runtime で
// 直接実行できる .mjs を stateDir に atomic install し、transcript_path は
// bounded read（canonical provider transcript root・owner・private mode・regular file を検証）、
// 結果は固定名の 0600 artifact へ atomic rename する。
import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const CLAUDE_STOP_HOOK_SCHEMA = "hachi.claude-stop-hook.v1";
export const CLAUDE_STOP_HOOK_SCRIPT_SUFFIX = ".stop-hook.mjs";
export const CLAUDE_STOP_TRANSCRIPT_SUFFIX = ".transcript.txt";
export const CLAUDE_STOP_RESULT_SUFFIX = ".result.json";
export const CLAUDE_STOP_MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
export const CLAUDE_STOP_MAX_LAST_MESSAGE_BYTES = 256 * 1024;
export const CLAUDE_STOP_MAX_HOOK_INPUT_BYTES = 512 * 1024;

const O_NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const PRIVATE_MODE_MASK = 0o077;

export interface ClaudeStopHookInput {
  session_id: string;
  transcript_path?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  hook_event_name?: "Stop" | "StopFailure" | string;
  error?: string;
  error_details?: string;
}

export interface ClaudeTranscriptHookPaths {
  stateDir: string;
  sessionId: string;
  scriptPath: string;
  transcriptPath: string;
  resultPath: string;
  /** Claude が実際に transcript を書くことを許可した canonical root。 */
  providerTranscriptRoot?: string;
}

export interface ClaudeStopResultArtifact {
  schemaVersion: typeof CLAUDE_STOP_HOOK_SCHEMA;
  sessionId: string;
  outcome: "captured" | "failed";
  capturedAt: number;
  transcriptBytes: number;
  lastAssistantMessageBytes: number;
  failureCode?: string;
  lastAssistantMessage?: string;
}

export interface ClaudeStopCaptureResult {
  artifact: ClaudeStopResultArtifact;
  paths: ClaudeTranscriptHookPaths;
}

export interface ClaudeStopHookSettings {
  hooks: {
    Stop: Array<{
      hooks: Array<{
        type: "command";
        command: string;
        timeout: number;
      }>;
    }>;
    StopFailure: Array<{
      hooks: Array<{
        type: "command";
        command: string;
        timeout: number;
      }>;
    }>;
  };
}

const STOP_FAILURE_CODES = new Set([
  "rate_limit",
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "invalid_request",
  "server_error",
  "max_output_tokens",
  "unknown",
]);

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} は UUID でなければなりません`);
  }
}

function assertPath(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes("\u0000")) throw new Error(`${label} は absolute path が必要です`);
  return resolve(value);
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("owner を検証できない runtime です");
  return uid;
}

function assertOwnedProtectedStat(
  stat: { uid: number; mode: number },
  label: string,
): void {
  if (stat.uid !== currentUid()) throw new Error(`${label} は current user が owner でなければなりません`);
  // provider 側の transcript / root が group・other から書き換え可能なら、
  // canonical path と regular-file check だけでは入力を信頼できない。
  if ((stat.mode & PRIVATE_MODE_MASK) !== 0) throw new Error(`${label} は group/other からアクセス可能であってはなりません`);
}

function canonicalProviderTranscriptRoot(value: string): string {
  const requested = assertPath(value, "providerTranscriptRoot");
  const requestedStat = lstatSync(requested);
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    throw new Error("providerTranscriptRoot は symlink でない directory が必要です");
  }
  const canonical = realpathSync(requested);
  const canonicalStat = lstatSync(canonical);
  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
    throw new Error("providerTranscriptRoot の canonical path が directory ではありません");
  }
  assertOwnedProtectedStat(canonicalStat, "providerTranscriptRoot");
  return canonical;
}

function ensureOwnedDirectory(stateDir: string): string {
  const resolved = assertPath(stateDir, "stateDir");
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("stateDir は symlink でない directory が必要です");
  chmodSync(resolved, 0o700);
  return resolved;
}

export function claudeTranscriptHookPaths(
  stateDir: string,
  sessionId: string,
  providerTranscriptRoot?: string,
): ClaudeTranscriptHookPaths {
  assertUuid(sessionId, "sessionId");
  const ownedDir = ensureOwnedDirectory(stateDir);
  return {
    stateDir: ownedDir,
    sessionId,
    // One script per provider session: a shared stateDir must not let a later
    // worker overwrite the exact-session binding of an earlier hook.
    scriptPath: join(ownedDir, `${sessionId}${CLAUDE_STOP_HOOK_SCRIPT_SUFFIX}`),
    transcriptPath: join(ownedDir, `${sessionId}${CLAUDE_STOP_TRANSCRIPT_SUFFIX}`),
    resultPath: join(ownedDir, `${sessionId}${CLAUDE_STOP_RESULT_SUFFIX}`),
    ...(providerTranscriptRoot === undefined
      ? {}
      : { providerTranscriptRoot: canonicalProviderTranscriptRoot(providerTranscriptRoot) }),
  };
}

function atomicWrite(path: string, value: string, mode: number): void {
  const directory = dirname(path);
  ensureOwnedDirectory(directory);
  const tempPath = join(directory, `.${randomUUID()}.tmp`);
  const fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    writeFileSync(fd, value, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tempPath, path);
    chmodSync(path, mode);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Keep the original rename failure as the useful diagnostic.
    }
    throw error;
  }
}

function assertCanonicalUnderRoot(path: string, root: string): string {
  const canonicalRoot = canonicalProviderTranscriptRoot(root);
  const requested = assertPath(path, "transcript_path");
  const canonicalPath = realpathSync(requested);
  const pathRelativeToRoot = relative(canonicalRoot, canonicalPath);
  if (pathRelativeToRoot === "" || pathRelativeToRoot.startsWith("..") || isAbsolute(pathRelativeToRoot)) {
    throw new Error("transcript_path が allowed provider transcript root の外側です");
  }
  const requestedStat = lstatSync(requested);
  if (requestedStat.isSymbolicLink()) throw new Error("transcript_path は symlink であってはなりません");
  assertOwnedProtectedStat(requestedStat, "transcript_path");
  return requested;
}

function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  allowedRoot?: string,
): { text: string; bytes: number } {
  const resolved = allowedRoot === undefined
    ? assertPath(path, "transcript_path")
    : assertCanonicalUnderRoot(path, allowedRoot);
  const fd = openSync(resolved, constants.O_RDONLY | O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("transcript_path は regular file が必要です");
    assertOwnedProtectedStat(stat, "transcript_path");
    if (stat.size > maxBytes) throw new Error("transcript が size limit を超えています");
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error("transcript の size が不正です");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (read <= 0) throw new Error("transcript の read が途中で終了しました");
      offset += read;
    }
    return { text: buffer.toString("utf8"), bytes: buffer.byteLength };
  } finally {
    closeSync(fd);
  }
}

function safeFailureCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP") {
    return "unsafe-transcript-path";
  }
  if (!(error instanceof Error)) return "capture-failed";
  if (/size limit/.test(error.message)) return "size-limit";
  if (/symlink|regular file|owner|writable|permissions|アクセス可能|allowed provider transcript root|canonical path/.test(error.message)) {
    return "unsafe-transcript-path";
  }
  if (/absolute path|providerTranscriptRoot|missing-provider-transcript-root/.test(error.message)) {
    return "invalid-transcript-path";
  }
  return "capture-failed";
}

function inputLastMessage(input: ClaudeStopHookInput): { value?: string; bytes: number; failureCode?: string } {
  if (input.last_assistant_message === undefined) return { bytes: 0 };
  if (typeof input.last_assistant_message !== "string") return { bytes: 0, failureCode: "invalid-last-assistant-message" };
  const bytes = Buffer.byteLength(input.last_assistant_message, "utf8");
  if (bytes > CLAUDE_STOP_MAX_LAST_MESSAGE_BYTES) return { bytes, failureCode: "last-message-size-limit" };
  return { value: input.last_assistant_message, bytes };
}

function failureArtifact(
  sessionId: string,
  capturedAt: number,
  failureCode: string,
  lastMessage: { value?: string; bytes: number },
): ClaudeStopResultArtifact {
  return {
    schemaVersion: CLAUDE_STOP_HOOK_SCHEMA,
    sessionId,
    outcome: "failed",
    capturedAt,
    transcriptBytes: 0,
    lastAssistantMessageBytes: lastMessage.bytes,
    failureCode,
    ...(lastMessage.value === undefined ? {} : { lastAssistantMessage: lastMessage.value }),
  };
}

function stopFailureCode(input: ClaudeStopHookInput): string | undefined {
  if (input.hook_event_name !== "StopFailure") return undefined;
  const error = typeof input.error === "string" && STOP_FAILURE_CODES.has(input.error)
    ? input.error
    : "unknown";
  return `stop-failure:${error}`;
}

/**
 * Stop hook input を exact session binding と bounded artifact へ変換する。
 * 失敗理由は code のみ artifact に保存し、provider path / payload をログへ出さない。
 */
export function captureClaudeStopHookInput(
  paths: ClaudeTranscriptHookPaths,
  input: ClaudeStopHookInput,
  nowSeconds = Math.floor(Date.now() / 1000),
): ClaudeStopCaptureResult {
  assertUuid(paths.sessionId, "paths.sessionId");
  if (input.session_id !== paths.sessionId) {
    throw new Error("Stop hook session_id が exact provider session と一致しません");
  }
  const lastMessage = inputLastMessage(input);
  let artifact: ClaudeStopResultArtifact;
  try {
    if (lastMessage.failureCode !== undefined) throw new Error(lastMessage.failureCode);
    if (input.transcript_path === undefined) throw new Error("missing-transcript-path");
    if (paths.providerTranscriptRoot === undefined) throw new Error("missing-provider-transcript-root");
    const transcript = readBoundedRegularFile(
      input.transcript_path,
      CLAUDE_STOP_MAX_TRANSCRIPT_BYTES,
      paths.providerTranscriptRoot,
    );
    atomicWrite(paths.transcriptPath, transcript.text, 0o600);
    const failureCode = stopFailureCode(input);
    artifact = {
      schemaVersion: CLAUDE_STOP_HOOK_SCHEMA,
      sessionId: paths.sessionId,
      outcome: failureCode === undefined ? "captured" : "failed",
      capturedAt: nowSeconds,
      transcriptBytes: transcript.bytes,
      lastAssistantMessageBytes: lastMessage.bytes,
      ...(failureCode === undefined ? {} : { failureCode }),
      ...(lastMessage.value === undefined || input.hook_event_name === "StopFailure"
        ? {}
        : { lastAssistantMessage: lastMessage.value }),
    };
  } catch (error) {
    const failureMessage = input.hook_event_name === "StopFailure"
      ? { bytes: lastMessage.bytes }
      : lastMessage;
    artifact = failureArtifact(paths.sessionId, nowSeconds, stopFailureCode(input) ?? safeFailureCode(error), failureMessage);
  }
  atomicWrite(paths.resultPath, JSON.stringify(artifact), 0o600);
  return { artifact, paths };
}

function shellQuote(value: string): string {
  if (value.includes("\u0000")) throw new Error("hook command path が不正です");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** stateDir 内へ standalone .mjs hook を atomic install する。 */
export function installClaudeTranscriptHook(
  stateDir: string,
  sessionId: string,
  providerTranscriptRoot: string,
): ClaudeTranscriptHookPaths {
  const paths = claudeTranscriptHookPaths(stateDir, sessionId, providerTranscriptRoot);
  atomicWrite(paths.scriptPath, renderClaudeStopHookScript(paths), 0o700);
  return paths;
}

/** Claude --settings の hooks fragment。command は shell-safe quote 済み。 */
export function buildClaudeStopHookSettings(paths: ClaudeTranscriptHookPaths, nodePath = process.execPath): ClaudeStopHookSettings {
  const entry = {
    hooks: [{
      type: "command" as const,
      command: `${shellQuote(nodePath)} ${shellQuote(paths.scriptPath)}`,
      timeout: 10,
    }],
  };
  return {
    hooks: {
      Stop: [entry],
      StopFailure: [entry],
    },
  };
}

/** hook command の単体実行テスト用。transcript が無い/壊れている場合は throw する。 */
export function readClaudeTranscriptCapture(stateDir: string, sessionId: string): string {
  const paths = claudeTranscriptHookPaths(stateDir, sessionId);
  let resultRaw: string;
  try {
    resultRaw = readFileSync(paths.resultPath, "utf8");
  } catch {
    throw new Error("Claude Stop hook result が未取得です");
  }
  let result: unknown;
  try {
    result = JSON.parse(resultRaw);
  } catch {
    throw new Error("Claude Stop hook result が壊れています");
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("Claude Stop hook result が不正です");
  }
  const record = result as Record<string, unknown>;
  if (record.schemaVersion !== CLAUDE_STOP_HOOK_SCHEMA || record.sessionId !== sessionId) {
    throw new Error("Claude Stop hook result binding が一致しません");
  }
  if (record.outcome !== "captured" && !(record.outcome === "failed"
    && typeof record.transcriptBytes === "number"
    && Number.isSafeInteger(record.transcriptBytes)
    && record.transcriptBytes > 0)) {
    throw new Error(`Claude Stop hook capture failed: ${typeof record.failureCode === "string" ? record.failureCode : "unknown"}`);
  }
  const transcript = readBoundedRegularFile(paths.transcriptPath, CLAUDE_STOP_MAX_TRANSCRIPT_BYTES);
  if (typeof record.transcriptBytes !== "number" || transcript.bytes !== record.transcriptBytes) {
    throw new Error("Claude Stop hook transcript size binding が一致しません");
  }
  return transcript.text;
}

/**
 * Hook script は package runtime に依存しない standalone ESM。stateDir/sessionId は
 * Hachi が JSON literal として埋め込み、stdin の session_id と exact compare する。
 */
export function renderClaudeStopHookScript(paths: ClaudeTranscriptHookPaths): string {
  const stateDir = JSON.stringify(paths.stateDir);
  const sessionId = JSON.stringify(paths.sessionId);
  const transcriptPath = JSON.stringify(paths.transcriptPath);
  const resultPath = JSON.stringify(paths.resultPath);
  const providerTranscriptRoot = JSON.stringify(paths.providerTranscriptRoot ?? "");
  return `import { constants, chmodSync, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative } from "node:path";

const SCHEMA = ${JSON.stringify(CLAUDE_STOP_HOOK_SCHEMA)};
const EXPECTED_SESSION_ID = ${sessionId};
const STATE_DIR = ${stateDir};
const TRANSCRIPT_PATH = ${transcriptPath};
const RESULT_PATH = ${resultPath};
const PROVIDER_TRANSCRIPT_ROOT = ${providerTranscriptRoot};
const MAX_TRANSCRIPT_BYTES = ${String(CLAUDE_STOP_MAX_TRANSCRIPT_BYTES)};
const MAX_LAST_MESSAGE_BYTES = ${String(CLAUDE_STOP_MAX_LAST_MESSAGE_BYTES)};
const MAX_INPUT_BYTES = ${String(CLAUDE_STOP_MAX_HOOK_INPUT_BYTES)};
const STOP_FAILURE_CODES = new Set(${JSON.stringify([...STOP_FAILURE_CODES])});
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const PRIVATE_MODE_MASK = 0o077;

function atomicWrite(path, value, mode) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const stateStat = lstatSync(STATE_DIR);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) throw new Error("unsafe-state-dir");
  chmodSync(STATE_DIR, 0o700);
  const temp = dirname(path) + "/." + randomUUID() + ".tmp";
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try { writeFileSync(fd, value, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, path); chmodSync(path, mode); } catch (error) { try { unlinkSync(temp); } catch {} throw error; }
}
function currentUid() {
  if (typeof process.getuid !== "function") throw new Error("owner-unavailable");
  return process.getuid();
}
function assertOwnedProtectedStat(stat, label) {
  if (stat.uid !== currentUid()) throw new Error(label + "-owner");
  if ((stat.mode & PRIVATE_MODE_MASK) !== 0) throw new Error(label + "-permissions");
}
function canonicalProviderRoot() {
  if (PROVIDER_TRANSCRIPT_ROOT === "") throw new Error("missing-provider-transcript-root");
  const rootStat = lstatSync(PROVIDER_TRANSCRIPT_ROOT);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("unsafe-provider-transcript-root");
  const root = realpathSync(PROVIDER_TRANSCRIPT_ROOT);
  const canonicalStat = lstatSync(root);
  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) throw new Error("unsafe-provider-transcript-root");
  assertOwnedProtectedStat(canonicalStat, "provider-transcript-root");
  return root;
}
function readTranscript(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\\u0000")) throw new Error("invalid-transcript-path");
  const root = canonicalProviderRoot();
  const canonicalPath = realpathSync(path);
  const rootRelative = relative(root, canonicalPath);
  if (rootRelative === "" || rootRelative.startsWith("..") || isAbsolute(rootRelative)) throw new Error("outside-provider-transcript-root");
  const requestedStat = lstatSync(path);
  if (requestedStat.isSymbolicLink()) throw new Error("unsafe-transcript-path");
  assertOwnedProtectedStat(requestedStat, "transcript");
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("unsafe-transcript-path");
    assertOwnedProtectedStat(stat, "transcript");
    if (stat.size > MAX_TRANSCRIPT_BYTES) throw new Error("size-limit");
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error("unsafe-transcript-path");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) { const read = readSync(fd, buffer, offset, buffer.length - offset, null); if (read <= 0) throw new Error("read-failed"); offset += read; }
    return { text: buffer.toString("utf8"), bytes: buffer.byteLength };
  } finally { closeSync(fd); }
}
function code(error) { return error instanceof Error && error.message === "size-limit" ? "size-limit" : "capture-failed"; }
let inputText = "";
for await (const chunk of process.stdin) { inputText += chunk.toString(); if (Buffer.byteLength(inputText, "utf8") > MAX_INPUT_BYTES) break; }
const now = Math.floor(Date.now() / 1000);
let input;
try { if (Buffer.byteLength(inputText, "utf8") > MAX_INPUT_BYTES) throw new Error("input-size-limit"); input = JSON.parse(inputText); } catch { process.exitCode = 0; }
if (input && typeof input === "object" && !Array.isArray(input) && input.session_id === EXPECTED_SESSION_ID) {
  const lastCandidate = typeof input.last_assistant_message === "string" ? input.last_assistant_message : undefined;
  const lastBytes = lastCandidate === undefined ? 0 : Buffer.byteLength(lastCandidate, "utf8");
  // oversized provider content は failure artifact に再掲しない。typed helper の
  // inputLastMessage と同じく bytes のみ残し、secret/response本文を bounded に保つ。
  const last = lastBytes <= MAX_LAST_MESSAGE_BYTES && input.hook_event_name !== "StopFailure"
    ? lastCandidate
    : undefined;
  let artifact;
  try {
    if (lastBytes > MAX_LAST_MESSAGE_BYTES || typeof input.transcript_path !== "string") throw new Error(lastBytes > MAX_LAST_MESSAGE_BYTES ? "size-limit" : "missing-transcript-path");
    const transcript = readTranscript(input.transcript_path);
    atomicWrite(TRANSCRIPT_PATH, transcript.text, 0o600);
    const failureCode = input.hook_event_name === "StopFailure" ? "stop-failure:" + (typeof input.error === "string" && STOP_FAILURE_CODES.has(input.error) ? input.error : "unknown") : undefined;
    artifact = { schemaVersion: SCHEMA, sessionId: EXPECTED_SESSION_ID, outcome: failureCode === undefined ? "captured" : "failed", capturedAt: now, transcriptBytes: transcript.bytes, lastAssistantMessageBytes: lastBytes, ...(failureCode === undefined ? {} : { failureCode }), ...(last === undefined ? {} : { lastAssistantMessage: last }) };
  } catch (error) {
    const failureCode = input.hook_event_name === "StopFailure"
      ? "stop-failure:" + (typeof input.error === "string" && STOP_FAILURE_CODES.has(input.error) ? input.error : "unknown")
      : code(error);
    artifact = { schemaVersion: SCHEMA, sessionId: EXPECTED_SESSION_ID, outcome: "failed", capturedAt: now, transcriptBytes: 0, lastAssistantMessageBytes: lastBytes, failureCode, ...(last === undefined ? {} : { lastAssistantMessage: last }) };
  }
  try { atomicWrite(RESULT_PATH, JSON.stringify(artifact), 0o600); } catch {}
}
process.exitCode = 0;
`;
}
