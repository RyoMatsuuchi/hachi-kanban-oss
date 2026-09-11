// artifacts（プロンプト/セッション全文ログ）を $artifactsDir/<taskId>/ 配下へ保存するヘルパー。
// 生ログはここへ保存し、コメントには要約+パスのみを残す（docs/contract.md §3）。
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { redactText, sha256Hex } from "@hachi/core";
import type { Environment } from "@hachi/core";

const FULL_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;
const FULL_TRANSCRIPT_HEAD_NOTE = "[hachi] transcript が 2MB を超えたため、末尾を優先して先頭を省略しました。\n";
const FULL_TRANSCRIPT_FALLBACK_NOTE =
  "[hachi] 完全記録の保存元（rollout/out）を取得できなかったため、bridge transcript をフォールバック保存しました。\n";
const TOOL_ARGUMENT_SUMMARY_MAX_CHARS = 120;
const EVENT_SUMMARY_MAX_CHARS = 240;

export interface FullTranscriptDirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface FullTranscriptStat {
  mtimeMs: number;
}

export interface FullTranscriptFileSystem {
  readdir(path: string): FullTranscriptDirEntry[];
  readFile(path: string): string;
  stat(path: string): FullTranscriptStat;
}

export interface SaveFullTranscriptArtifactOptions {
  codexSessionsDir?: string;
  fileSystem?: FullTranscriptFileSystem;
}

interface RolloutCandidate {
  path: string;
  mtimeMs: number;
}

interface FullTranscriptSource {
  text: string;
}

const NODE_FULL_TRANSCRIPT_FILE_SYSTEM: FullTranscriptFileSystem = {
  readdir(path: string): FullTranscriptDirEntry[] {
    return readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }));
  },
  readFile(path: string): string {
    return readFileSync(path, "utf8");
  },
  stat(path: string): FullTranscriptStat {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs };
  },
};

/**
 * ファイル名に使えない可能性のある文字を安全な文字へ置換する（docs/contract.md §12.17-2）。
 * sessionId / claim token はワーカー adapter / nonce 生成に由来する自由文字列であり、
 * そのままファイル名へ埋め込むとパス区切り文字等で artifactsDir 外を指す危険がある。
 */
function sanitizeForFilename(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * 衝突耐性のある artifact ファイル名を組み立てる（docs/contract.md §12.19-1）。
 * sanitizeForFilename は非英数字を一律 '_' へ潰すため、'a/b' と 'a_b' のように異なる元 ID が
 * 同一のサニタイズ結果へ衝突しうる。元 ID の sha256 先頭 8 hex を必ず付与することで、
 * 可読性のためのサニタイズ結果が衝突してもファイル自体は衝突しない。
 */
function buildArtifactFilename(prefix: string, id: string): string {
  const safe = sanitizeForFilename(id);
  const digest = sha256Hex(id).slice(0, 8);
  return `${prefix}-${safe}-${digest}.txt`;
}

/**
 * 解決済み絶対パスが baseDir 配下に収まっているかを検証する（docs/contract.md §12.19-1, fail-closed）。
 * taskId はサニタイズを経由せずディレクトリ名（$artifactsDir/<taskId>/）へそのまま使われるため、
 * '../evil' のような値による artifactsDir 外への path traversal を防ぐ最終防衛として使う。
 * 逸脱している場合は throw する。
 */
function assertContained(baseDir: string, targetPath: string): void {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(targetPath);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + sep)) {
    throw new Error(`artifacts パスが artifactsDir 配下に収まりません: ${resolvedTarget}`);
  }
}

/**
 * $artifactsDir/<taskId>/prompt-<safe>-<hash>.txt へワーカー起動時のプロンプト全文を保存する
 * （docs/contract.md §12.17-2, §12.19-1）。dispatch は launch 前で sessionId が未確定のため、
 * id には claim token を渡す（起動ごとに区別できることが目的であり、確定後の sessionId と
 * 一致させる必要はない）。
 */
export function savePromptArtifact(env: Environment, taskId: string, id: string, promptText: string): void {
  const dir = join(env.artifactsDir, taskId);
  assertContained(env.artifactsDir, dir);
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, buildArtifactFilename("prompt", id));
  assertContained(env.artifactsDir, filePath);
  writeFileSync(filePath, promptText, "utf8");
}

/**
 * $artifactsDir/<taskId>/transcript-<safe>-<hash>.txt へセッションの会話ログ全文を保存し、保存先の絶対パスを返す
 * （docs/contract.md §12.17-2, §12.19-1）。stale セッションの transcript が現行セッションの監査証跡を上書きしないよう、
 * ファイル名をセッション単位でスコープする。
 */
export function saveTranscriptArtifact(
  env: Environment,
  taskId: string,
  sessionId: string,
  transcript: string,
): string {
  const dir = join(env.artifactsDir, taskId);
  assertContained(env.artifactsDir, dir);
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, buildArtifactFilename("transcript", sessionId));
  assertContained(env.artifactsDir, filePath);
  writeFileSync(filePath, transcript, "utf8");
  return filePath;
}

function compactText(value: unknown, maxChars: number): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const text = raw ?? String(value);
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...`;
}

function recordValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = recordValue(record, key);
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return null;
}

function payloadRecord(record: Record<string, unknown>): Record<string, unknown> {
  const payload = nestedRecord(recordValue(record, "payload"));
  return payload ?? record;
}

function rolloutEventType(record: Record<string, unknown>): string {
  const payload = payloadRecord(record);
  return (
    firstString(record, ["type", "event", "kind"]) ??
    firstString(payload, ["type", "event", "kind"]) ??
    "unknown"
  );
}

function textFromContent(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      const itemRecord = nestedRecord(item);
      if (itemRecord === null) {
        continue;
      }
      const itemText = firstString(itemRecord, ["text", "content", "message"]);
      if (itemText !== null) {
        parts.push(itemText);
      }
    }
    return parts.length > 0 ? parts.join("") : null;
  }
  const record = nestedRecord(value);
  if (record === null) {
    return null;
  }
  return firstString(record, ["text", "content", "message"]);
}

function rolloutText(record: Record<string, unknown>): string | null {
  const payload = payloadRecord(record);
  for (const source of [payload, record]) {
    const direct = firstString(source, ["text", "message", "prompt", "output"]);
    if (direct !== null) {
      return direct;
    }
    const content = textFromContent(recordValue(source, "content"));
    if (content !== null) {
      return content;
    }
  }
  return null;
}

function rolloutRole(record: Record<string, unknown>): string | null {
  const payload = payloadRecord(record);
  return firstString(record, ["role", "author"]) ?? firstString(payload, ["role", "author"]);
}

function toolName(record: Record<string, unknown>): string {
  const payload = payloadRecord(record);
  const functionRecord = nestedRecord(recordValue(payload, "function")) ?? nestedRecord(recordValue(record, "function"));
  return (
    firstString(payload, ["name", "toolName", "tool_name", "callable"]) ??
    firstString(record, ["name", "toolName", "tool_name", "callable"]) ??
    (functionRecord !== null ? firstString(functionRecord, ["name"]) : null) ??
    "unknown"
  );
}

function toolArguments(record: Record<string, unknown>): unknown {
  const payload = payloadRecord(record);
  const functionRecord = nestedRecord(recordValue(payload, "function")) ?? nestedRecord(recordValue(record, "function"));
  return (
    recordValue(payload, "arguments") ??
    recordValue(payload, "args") ??
    recordValue(payload, "input") ??
    recordValue(record, "arguments") ??
    recordValue(record, "args") ??
    recordValue(record, "input") ??
    (functionRecord !== null ? recordValue(functionRecord, "arguments") : undefined)
  );
}

function patchPathSummary(record: Record<string, unknown>): string {
  const payload = payloadRecord(record);
  const files = recordValue(payload, "files") ?? recordValue(record, "files");
  if (Array.isArray(files)) {
    const paths = files.filter((file): file is string => typeof file === "string");
    if (paths.length > 0) {
      return paths.join(", ");
    }
  }
  return (
    firstString(payload, ["path", "file", "filename"]) ??
    firstString(record, ["path", "file", "filename"]) ??
    compactText(record, TOOL_ARGUMENT_SUMMARY_MAX_CHARS)
  );
}

function formatRolloutRecord(record: Record<string, unknown>): string {
  const type = rolloutEventType(record);
  const role = rolloutRole(record);
  const text = rolloutText(record);
  if (type === "user_prompt" || role === "user") {
    return `[user] ${text ?? ""}`;
  }
  if (type === "agent_message" || type === "assistant_message" || role === "assistant") {
    return `[assistant] ${text ?? ""}`;
  }
  if (type === "tool" || type === "tool_call" || type === "custom_tool_call") {
    return `[tool] ${toolName(record)} ${compactText(toolArguments(record) ?? "", TOOL_ARGUMENT_SUMMARY_MAX_CHARS)}`;
  }
  if (type === "patch_apply" || type === "apply_patch") {
    return `[patch] ${patchPathSummary(record)}`;
  }
  return `[event:${type}] ${compactText(record, EVENT_SUMMARY_MAX_CHARS)}`;
}

function formatRolloutJsonl(raw: string): string {
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const record = nestedRecord(parsed);
      lines.push(record === null ? `[event:unknown] ${compactText(parsed, EVENT_SUMMARY_MAX_CHARS)}` : formatRolloutRecord(record));
    } catch {
      lines.push(`[event:invalid_json] ${compactText(trimmed, EVENT_SUMMARY_MAX_CHARS)}`);
    }
  }
  return lines.join("\n");
}

function findRolloutCandidates(
  fileSystem: FullTranscriptFileSystem,
  rootDir: string,
  sessionId: string,
): RolloutCandidate[] {
  const candidates: RolloutCandidate[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: FullTranscriptDirEntry[];
    try {
      entries = fileSystem.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      if (!entry.name.includes(sessionId)) {
        continue;
      }
      let mtimeMs = 0;
      try {
        mtimeMs = fileSystem.stat(path).mtimeMs;
      } catch {
        // stat 失敗時も候補からは落とさず、パス順の tie-breaker に委ねる。
      }
      candidates.push({ path, mtimeMs });
    }
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
}

function truncateFullTranscript(text: string): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= FULL_TRANSCRIPT_MAX_BYTES) {
    return text;
  }
  const note = Buffer.from(FULL_TRANSCRIPT_HEAD_NOTE, "utf8");
  const tailBytes = FULL_TRANSCRIPT_MAX_BYTES - note.byteLength;
  return `${FULL_TRANSCRIPT_HEAD_NOTE}${buffer.subarray(buffer.byteLength - tailBytes).toString("utf8")}`;
}

function resolveFullTranscriptSource(
  env: Environment,
  sessionId: string,
  provider: string,
  serverUrl: string,
  fallbackTranscript: string,
  options: SaveFullTranscriptArtifactOptions,
): FullTranscriptSource {
  const fileSystem = options.fileSystem ?? NODE_FULL_TRANSCRIPT_FILE_SYSTEM;
  if (serverUrl === "direct") {
    try {
      const directPath = join(env.home, "state", "direct-sessions", `${sessionId}.out`);
      return { text: fileSystem.readFile(directPath) };
    } catch {
      return { text: `${FULL_TRANSCRIPT_FALLBACK_NOTE}${fallbackTranscript}` };
    }
  }

  if (provider !== "codex") {
    return { text: `${FULL_TRANSCRIPT_FALLBACK_NOTE}${fallbackTranscript}` };
  }

  const codexSessionsDir = options.codexSessionsDir ?? join(homedir(), ".codex", "sessions");
  const candidates = findRolloutCandidates(fileSystem, codexSessionsDir, sessionId);
  for (const candidate of candidates) {
    try {
      return { text: formatRolloutJsonl(fileSystem.readFile(candidate.path)) };
    } catch {
      continue;
    }
  }
  return { text: `${FULL_TRANSCRIPT_FALLBACK_NOTE}${fallbackTranscript}` };
}

export function saveFullTranscriptArtifact(
  env: Environment,
  taskId: string,
  sessionId: string,
  provider: string,
  serverUrl: string,
  fallbackTranscript: string,
  options: SaveFullTranscriptArtifactOptions = {},
): string {
  const dir = join(env.artifactsDir, taskId);
  assertContained(env.artifactsDir, dir);
  mkdirSync(dir, { recursive: true });

  const source = resolveFullTranscriptSource(env, sessionId, provider, serverUrl, fallbackTranscript, options);
  const text = truncateFullTranscript(redactText(source.text));
  const filePath = join(dir, buildArtifactFilename("transcript-full", sessionId));
  assertContained(env.artifactsDir, filePath);
  writeFileSync(filePath, text, "utf8");
  return filePath;
}

/**
 * $artifactsDir/<taskId>/prompt-review-<safe>-<hash>.txt へレビュアー起動時のプロンプト全文を保存する
 * （docs/contract.md §15.1）。review ステージは launch 前で sessionId が未確定のため、
 * id には nonce（claim token 相当）を渡す。worker 用の savePromptArtifact とはプレフィックスを
 * 分けることで、同一タスク配下でも起動対象（worker/reviewer）を artifact 名から判別できるようにする。
 */
export function saveReviewPromptArtifact(env: Environment, taskId: string, nonce: string, promptText: string): void {
  const dir = join(env.artifactsDir, taskId);
  assertContained(env.artifactsDir, dir);
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, buildArtifactFilename("prompt-review", nonce));
  assertContained(env.artifactsDir, filePath);
  writeFileSync(filePath, promptText, "utf8");
}

/**
 * $artifactsDir/<taskId>/prompt-rework<attempt>-<safe>-<hash>.txt へ rework（自動再作業）起動時の
 * プロンプト全文を保存する（docs/contract.md §21.2）。review ステージは launch 前で sessionId が
 * 未確定のため、id には nonce を渡す。attempt ごとに prefix を分けることで、同一タスク配下でも
 * 何回目の rework 起動かを artifact 名から判別できるようにする。
 */
export function saveReworkPromptArtifact(
  env: Environment,
  taskId: string,
  attempt: number,
  nonce: string,
  promptText: string,
): void {
  const dir = join(env.artifactsDir, taskId);
  assertContained(env.artifactsDir, dir);
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, buildArtifactFilename(`prompt-rework${attempt}`, nonce));
  assertContained(env.artifactsDir, filePath);
  writeFileSync(filePath, promptText, "utf8");
}

/**
 * $artifactsDir/<taskId>/transcript-review-<safe>-<hash>.txt へレビューセッションの会話ログ全文を
 * 保存し、保存先の絶対パスを返す（docs/contract.md §15.2）。worker 用の transcript-*.txt とは
 * プレフィックスを分け、artifact 名から reviewer 分と判別できるようにする。
 */
export function saveReviewTranscriptArtifact(
  env: Environment,
  taskId: string,
  sessionId: string,
  transcript: string,
): string {
  const dir = join(env.artifactsDir, taskId);
  assertContained(env.artifactsDir, dir);
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, buildArtifactFilename("transcript-review", sessionId));
  assertContained(env.artifactsDir, filePath);
  writeFileSync(filePath, transcript, "utf8");
  return filePath;
}
