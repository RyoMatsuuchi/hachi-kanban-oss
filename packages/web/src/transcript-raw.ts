// =============================================================================
// GET /api/session/:sessionId/transcript-raw の実装本体。
// artifact（supervisor が finalize 時に書く .txt）ではなく、ディスク上のネイティブ JSONL を
// 正本として読む。走行中でも辿れることが目的なので、finalize を待たない。
// 1.4MB を超えるログが実在するため全文を一括で返さず、行範囲でページングする。
// =============================================================================
import { existsSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  findClaudeSessionDir,
  findCodexRollout,
  isPathWithinRoot,
  isValidNativeSessionId,
  parseCodexSessionId,
  readDirectOutHead,
  readDirectSessionState,
} from "@hachi/adapters";
import { redactJsonStrings, redactText, type Provider, type RunningSession } from "@hachi/core";
import type {
  SessionTranscriptRawEntry,
  SessionTranscriptRawLimitReason,
  SessionTranscriptRawUnavailableReason,
} from "./shared/api-types.js";

/** ネイティブログのルート（claude projects / codex sessions）。テストで差し替えるための入れ物。 */
export interface NativeLogRoots {
  /** $HACHI_KANBAN_HOME 相当。direct セッションの state JSON を引くのに使う */
  home: string;
  /** ~/.claude/projects 相当のルート */
  claudeProjectsRoot: string;
  /** ~/.codex/sessions 相当のルート */
  codexSessionsRoot: string;
}

/**
 * 解決済みの絶対パスが対応 root 配下にあることを最終確認する（契約 §28.6-2）。形式検証を通った id でも、
 * 将来ヘルパ側の実装が変わればパスが境界外を指しうるため、返す直前に必ず通す。
 * `resolve` は symlink を辿らないため、root 配下に置かれた symlink による境界越えはここでは防げない
 * （契約が指定しているのは resolve 後の containment であり、実装はそれに適合している）。
 */
function containedPath(
  root: string,
  path: string,
): { path: string } | { reason: SessionTranscriptRawUnavailableReason } {
  return isPathWithinRoot(root, path) ? { path } : { reason: "path-outside-root" };
}

/**
 * `RunningSession` からネイティブ transcript の絶対パスを解決する。
 *
 * `session.sessionId` は transport によって意味が異なる:
 * - direct: board 上の sessionId（例: `direct-<nonce>`）であり、ネイティブログのファイル名とは
 *   **一致しない**。claude は起動時に別採番した `nativeSessionId`（state JSON に保存）を、
 *   codex は `--session-id` 相当を持たないため `.out` 冒頭の `session id: <uuid>` ヘッダを読む。
 * - それ以外（bridge 等）: 他に手掛かりが無いため `session.sessionId` をそのままネイティブ
 *   session id とみなす（bridge が起動時に board と揃えている前提）。
 *
 * パス境界は形式検証（`^[A-Za-z0-9_-]{1,128}$`）と containment（resolve 後の絶対パスが対応 root
 * 配下）の**両方**を課す（契約 §28.6-2）。本エンドポイントは tailscale 経由で外部から到達しうるため、
 * 境界外の任意 `.jsonl` を読ませない。形式に適合しない id は「見つからない」ではなく
 * `session-id-invalid` として明示的に拒否し、log-not-found と混ぜない。
 */
export async function resolveNativeTranscriptPath(
  session: RunningSession,
  roots: NativeLogRoots,
): Promise<{ path: string } | { reason: SessionTranscriptRawUnavailableReason }> {
  if (session.transport === "direct") {
    // direct は board sessionId から state JSON（`<id>.json`）と `.out` のパスを組み立てるため、
    // 中継する native id だけでなく board sessionId 自体にも形式検証を課す。
    if (!isValidNativeSessionId(session.sessionId)) {
      return { reason: "session-id-invalid" };
    }
    const stateDir = resolve(roots.home, "state", "direct-sessions");
    const state = readDirectSessionState(stateDir, session.sessionId);

    if (session.provider === "claude") {
      const nativeSessionId = state?.nativeSessionId;
      if (nativeSessionId === undefined) {
        // `--session-id` 導入前に起動した in-flight session。推測せず正直に unknown を返す。
        return { reason: "session-id-unknown" };
      }
      if (!isValidNativeSessionId(nativeSessionId)) {
        return { reason: "session-id-invalid" };
      }
      const dir = await findClaudeSessionDir(roots.claudeProjectsRoot, nativeSessionId);
      if (dir === null) {
        return { reason: "log-not-found" };
      }
      return containedPath(roots.claudeProjectsRoot, join(dir, `${nativeSessionId}.jsonl`));
    }

    // codex: --session-id 相当が無いため .out ヘッダの session id: <uuid> を読み取る。
    if (state?.nativeLogsDisabled === true) {
      // codex --ephemeral 起動等、設計上ネイティブログが書かれない。
      return { reason: "log-not-persisted" };
    }
    const outFile = state?.outFile ?? join(stateDir, `${session.sessionId}.out`);
    // readDirectOutHead は開けない場合も例外を投げず "" を返す実装のため、事前に存在確認を行う。
    // これを怠ると「.out が未生成（起動直後）」も session-id-unknown に化けてしまう（誤った理由コード）。
    if (!existsSync(outFile)) {
      return { reason: "log-not-found" };
    }
    const head = readDirectOutHead(outFile);
    const codexSessionId = parseCodexSessionId(head);
    if (codexSessionId === null) {
      return { reason: "session-id-unknown" };
    }
    if (!isValidNativeSessionId(codexSessionId)) {
      return { reason: "session-id-invalid" };
    }
    const path = await findCodexRollout(roots.codexSessionsRoot, codexSessionId);
    if (path === null) {
      return { reason: "log-not-found" };
    }
    return containedPath(roots.codexSessionsRoot, path);
  }

  // bridge 等: session.sessionId をそのままネイティブ session id とみなす（他に手掛かりが無い）。
  if (!isValidNativeSessionId(session.sessionId)) {
    return { reason: "session-id-invalid" };
  }
  if (session.provider === "claude") {
    const dir = await findClaudeSessionDir(roots.claudeProjectsRoot, session.sessionId);
    if (dir === null) {
      return { reason: "log-not-found" };
    }
    return containedPath(roots.claudeProjectsRoot, join(dir, `${session.sessionId}.jsonl`));
  }
  const path = await findCodexRollout(roots.codexSessionsRoot, session.sessionId);
  if (path === null) {
    return { reason: "log-not-found" };
  }
  return containedPath(roots.codexSessionsRoot, path);
}

/**
 * 1ファイルあたりの走査上限（64MB）。native-usage.ts の MAX_LOG_BYTES（256MB）より低いのは、
 * こちらはポーリングされるインタラクティブな閲覧用途のため（毎回全行走査するコストを抑える）。
 */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/** 改行を除く raw physical line の上限（契約 §28.6-10）。 */
export const MAX_RAW_LINE_BYTES = 1 * 1024 * 1024;

/** oversize 行に使うsource非依存の固定文言。source断片・hash・byte列は混ぜない。 */
export const OVERSIZED_RAW_LINE_PLACEHOLDER = "この行は 1 MiB を超えたため表示を省略しました";

/** resource反例をwall-clockに頼らず観測するための決定論的カウンタ。 */
export interface TranscriptScanMetrics {
  scanPasses: number;
  readCalls: number;
  bytesRead: number;
  byteVisits: number;
  peakRetainedBytes: number;
  decodedLines: number;
  jsonParseAttempts: number;
  redactionCalls: number;
  oversizedLines: number;
}

export function createTranscriptScanMetrics(): TranscriptScanMetrics {
  return {
    scanPasses: 0,
    readCalls: 0,
    bytesRead: 0,
    byteVisits: 0,
    peakRetainedBytes: 0,
    decodedLines: 0,
    jsonParseAttempts: 0,
    redactionCalls: 0,
    oversizedLines: 0,
  };
}

function resetTranscriptScanMetrics(metrics: TranscriptScanMetrics | undefined): void {
  if (metrics === undefined) {
    return;
  }
  Object.assign(metrics, createTranscriptScanMetrics());
}

export interface TranscriptRawRangeOptions {
  /** 指定行より後ろを昇順で最大 limit 件（ポーリング用） */
  after?: number;
  /** 指定行より前を、直前の limit 件（先頭側を遡る用） */
  before?: number;
  /** 1〜1000 */
  limit: number;
}

export type TranscriptRawRangeResult =
  | {
      totalLines: number;
      startLine: number;
      endLine: number;
      hasMoreBefore: boolean;
      hasMoreAfter: boolean;
      limitedBy: SessionTranscriptRawLimitReason[];
      entries: SessionTranscriptRawEntry[];
    }
  | { reason: SessionTranscriptRawUnavailableReason };

/** ネストした値を安全に取り出す（redact 済み row からの allowlist 抽出用）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

type EntryKind = SessionTranscriptRawEntry["kind"];

/** claude の1ブロック（message.content の要素）をテキストへ平坦化する。 */
function claudeContentBlockText(blockRaw: unknown): string {
  const block = asRecord(blockRaw);
  if (block === null) {
    return typeof blockRaw === "string" ? blockRaw : JSON.stringify(blockRaw);
  }
  const type = asString(block.type);
  switch (type) {
    case "text":
      return asString(block.text) ?? "";
    case "thinking":
      return `[thinking] ${asString(block.thinking) ?? ""}`;
    case "tool_use":
      return `[tool_use:${asString(block.name) ?? "?"}] ${JSON.stringify(block.input ?? {})}`;
    case "tool_result":
      return `[tool_result] ${typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "")}`;
    case "image":
      return "[image omitted]";
    default:
      return `[${type ?? "unknown"}]`;
  }
}

/** claude の行から表示用テキストを抽出する。message が無ければ行全体を JSON.stringify する。 */
function extractClaudeText(row: Record<string, unknown>): string {
  const message = asRecord(row.message);
  if (message === null) {
    return JSON.stringify(row);
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((block) => claudeContentBlockText(block)).join("\n");
  }
  return JSON.stringify(row);
}

/**
 * claude の行を分類する（実機の実データを基点。未知の type/content block 形は
 * 例外を投げず kind "other" ＋ JSON.stringify フォールバックへ倒す）。
 */
function classifyClaudeRow(row: Record<string, unknown>): { kind: EntryKind; text: string } {
  const rowType = asString(row.type);
  const kind: EntryKind = rowType === "user" ? "user" : rowType === "assistant" ? "assistant" : "other";
  return { kind, text: extractClaudeText(row) };
}

/** codex の response_item message ブロックをテキストへ平坦化する。 */
function codexMessageBlockText(blockRaw: unknown): string {
  const block = asRecord(blockRaw);
  if (block === null) {
    return typeof blockRaw === "string" ? blockRaw : "";
  }
  return asString(block.text) ?? asString(block.output_text) ?? asString(block.input_text) ?? "";
}

function codexMessageContentText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((block) => codexMessageBlockText(block)).join("\n");
  }
  return JSON.stringify(payload);
}

/** event_msg のうち、明示的な分類が無い種別を粗く分ける集合（token_count/task_started/task_complete）。 */
const CODEX_EVENT_OTHER_TYPES = new Set(["token_count", "task_started", "task_complete"]);

/** codex の event_msg（payload.type）を分類する。 */
function classifyCodexEventMsg(payload: Record<string, unknown>): { kind: EntryKind; text: string } {
  const type = asString(payload.type);
  if (type === "user_message") {
    return { kind: "user", text: asString(payload.message) ?? JSON.stringify(payload) };
  }
  if (type === "agent_message") {
    return { kind: "assistant", text: asString(payload.message) ?? JSON.stringify(payload) };
  }
  if (type === "agent_reasoning") {
    return { kind: "other", text: JSON.stringify(payload) };
  }
  if (type !== undefined && CODEX_EVENT_OTHER_TYPES.has(type)) {
    return { kind: "other", text: JSON.stringify(payload) };
  }
  // exec_command_begin/end・mcp_tool_call_begin/end・patch_apply_begin/end 等の未知イベントは
  // 実行系の副作用イベントとみなし kind "tool" に倒す。
  return { kind: "tool", text: JSON.stringify(payload) };
}

/** codex の response_item（payload.type）を分類する。 */
function classifyCodexResponseItem(payload: Record<string, unknown>): { kind: EntryKind; text: string } {
  const type = asString(payload.type);
  if (type === "message") {
    const role = asString(payload.role);
    const kind: EntryKind = role === "user" ? "user" : role === "assistant" ? "assistant" : "other";
    return { kind, text: codexMessageContentText(payload) };
  }
  if (type === "reasoning") {
    return { kind: "other", text: JSON.stringify(payload.summary ?? payload) };
  }
  if (type === "function_call") {
    const name = asString(payload.name) ?? "?";
    const args = asString(payload.arguments) ?? "";
    return { kind: "tool", text: `[function_call:${name}] ${args}` };
  }
  if (type === "function_call_output") {
    return { kind: "tool", text: asString(payload.output) ?? JSON.stringify(payload) };
  }
  // local_shell_call/local_shell_call_output 等、実機で未観測だが "call" を含む未知 type は
  // ツール呼び出し系とみなし kind "tool" に倒す。それ以外の真に未知な type は "other"。
  if (type !== undefined && /call/i.test(type)) {
    return { kind: "tool", text: JSON.stringify(payload) };
  }
  return { kind: "other", text: JSON.stringify(payload) };
}

/**
 * codex の行を分類する（実機の実データを基点。未知の type/payload.type は
 * 例外を投げず kind "other" ＋ JSON.stringify フォールバックへ倒す）。
 */
function classifyCodexRow(row: Record<string, unknown>): { kind: EntryKind; text: string } {
  const rowType = asString(row.type);
  if (rowType === "session_meta") {
    return { kind: "other", text: "[session_meta]" };
  }
  if (rowType === "turn_context") {
    const payload = asRecord(row.payload) ?? {};
    return { kind: "other", text: `[turn_context] model=${asString(payload.model) ?? "?"}` };
  }
  if (rowType === "event_msg") {
    const payload = asRecord(row.payload);
    if (payload === null) {
      return { kind: "other", text: JSON.stringify(row) };
    }
    return classifyCodexEventMsg(payload);
  }
  if (rowType === "response_item") {
    const payload = asRecord(row.payload);
    if (payload === null) {
      return { kind: "other", text: JSON.stringify(row) };
    }
    return classifyCodexResponseItem(payload);
  }
  return { kind: "other", text: JSON.stringify(row) };
}

/**
 * 1エントリの text 上限（**UTF-8 バイト数**、契約 §28.6-6）。1行1エントリの text 長には元々上限が無く、
 * 1行が数十MBある JSONL でも limit=1 のままクライアントへ送信されうる（クライアント側の省略表示は
 * 受信後に適用されるため防御にならない）。サーバ側で強制的に切り詰めることで応答サイズを有限に保つ。
 *
 * UTF-16 code unit 数（`String.length`）で数えないのが要点。日本語は1文字3バイト・絵文字は4バイトで、
 * `length` 基準だと実際の応答バイト量が上限の3〜4倍に膨らむ。
 */
export const MAX_ENTRY_TEXT_BYTES = 200_000;

/** 省略した事実をクライアントで明示するための注記。 */
const TRUNCATION_NOTICE = "\n...(サーバ側で省略)";

/**
 * text が UTF-8 バイト上限を超えていたら切り詰め、末尾に省略注記を付ける。
 * バイト境界で切ると多バイト文字が壊れて U+FFFD になるため、継続バイト（10xxxxxx）を
 * 遡って文字境界まで戻す。
 */
function truncateEntryText(text: string): string {
  // 超過していなければ Buffer 化しない（巨大な text で無駄なコピーを作らないため）。
  if (Buffer.byteLength(text, "utf8") <= MAX_ENTRY_TEXT_BYTES) {
    return text;
  }
  const buffer = Buffer.from(text, "utf8");
  let end = MAX_ENTRY_TEXT_BYTES;
  while (end > 0 && (buffer[end] ?? 0) >= 0x80 && (buffer[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return `${buffer.subarray(0, end).toString("utf8")}${TRUNCATION_NOTICE}`;
}

/**
 * 1行を entry へ変換する。JSON.parse に失敗した行（書き込み中の途中行等）は unparsed:true とし、
 * redactText を通した生テキストだけを保持する。
 *
 * redaction の適用順序（契約 §28.6-3）:
 * 1. `redactJsonStrings` を行全体へ適用し、値リーフと object key の両方を走査する。
 *    text とは別フィールドとして返す `rawType` / `timestamp` を覆うのもこの経路だけ。
 * 2. 分類・平坦化して得た **最終文字列全体** へ `redactText` を適用してから truncate する。
 *    `claudeContentBlockText` などが `JSON.stringify(block.input)` で object を再直列化するため、
 *    **key** に入った秘匿値も再直列化より前の 1. でマスク済みであり、この経路へ持ち越さない。
 * 3. パース失敗行・非オブジェクト行の raw 経路も「redact してから truncate」の順序を保つ
 *    （truncate 後に redact すると、切れ目を跨いだパターンが redact されずに残る）。
 */
function buildEntry(
  line: number,
  rawLine: string,
  provider: Provider,
  metrics?: TranscriptScanMetrics,
): SessionTranscriptRawEntry {
  let parsed: unknown;
  if (metrics !== undefined) {
    metrics.jsonParseAttempts += 1;
  }
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    if (metrics !== undefined) {
      metrics.redactionCalls += 1;
    }
    return {
      line,
      kind: "other",
      rawType: null,
      timestamp: null,
      text: truncateEntryText(redactText(rawLine)),
      unparsed: true,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    // オブジェクトでない行（配列・プリミティブ直書き等）は分類テーブルの対象外。安全側で unparsed 扱いにする。
    if (metrics !== undefined) {
      metrics.redactionCalls += 1;
    }
    return {
      line,
      kind: "other",
      rawType: null,
      timestamp: null,
      text: truncateEntryText(redactText(rawLine)),
      unparsed: true,
    };
  }

  if (metrics !== undefined) {
    metrics.redactionCalls += 1;
  }
  const redactedRow = redactJsonStrings(parsed) as Record<string, unknown>;
  const rawType = asString(redactedRow.type) ?? null;
  const timestamp = asString(redactedRow.timestamp) ?? null;
  const classified = provider === "claude" ? classifyClaudeRow(redactedRow) : classifyCodexRow(redactedRow);

  if (metrics !== undefined) {
    metrics.redactionCalls += 1;
  }
  return {
    line,
    kind: classified.kind,
    rawType,
    timestamp,
    // 直列化後の最終文字列へ redactText を適用してから truncate する（契約 §28.6-3）。
    text: truncateEntryText(redactText(classified.text)),
    unparsed: false,
  };
}

/** 1回の read で読み込むバイト数。 */
const SNAPSHOT_CHUNK_BYTES = 256 * 1024;

/**
 * 読み取り snapshot。**同一 fd** と**固定 size** の組で、行番号算出・範囲選択・本文抽出が必ず
 * 同じ内容を見ることを保証する（契約 §28.6-5, §28.6-11）。
 *
 * ネイティブ JSONL は追記専用なので `[0, size)` のバイト列は後から変化しない。逆に size を固定せず
 * 「現在の EOF まで」を2回読むと、その間に走行中セッションが書き足した分だけ2回目が長くなる。
 * size外への追記は読まず、snapshot内で改行まで到達した行だけを確定行として数える。
 */
export interface TranscriptSnapshot {
  /** 走査に使う唯一の fd。inode が入れ替わっても掴んだ実体は変わらない */
  handle: FileHandle;
  /** snapshot として固定したバイト長。この境界を越えて読まない */
  size: number;
}

export type TranscriptSnapshotResult =
  | { snapshot: TranscriptSnapshot }
  | { reason: SessionTranscriptRawUnavailableReason };

/**
 * ファイルを開き、その時点の size を固定して snapshot を作る。
 * 呼び出し側は必ず `closeTranscriptSnapshot` で閉じること。
 */
export async function openTranscriptSnapshot(path: string): Promise<TranscriptSnapshotResult> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return { reason: "log-not-found" };
  }
  try {
    // stat は path ではなく fd に対して行う。以降の読み取りと同じ実体を必ず見る。
    const info = await handle.stat();
    if (!info.isFile()) {
      // ディレクトリも POSIX では open できてしまうため、fd 側で弾く。
      await handle.close();
      return { reason: "log-not-found" };
    }
    if (info.size > MAX_SCAN_BYTES) {
      await handle.close();
      return { reason: "log-too-large" };
    }
    // 末尾確認の別readは行わない。改行判定も `[0, size)` の単一scan内で完了させる。
    return { snapshot: { handle, size: info.size } };
  } catch {
    await handle.close().catch(() => undefined);
    return { reason: "log-unreadable" };
  }
}

/** snapshot の fd を閉じる（close 自体の失敗は握り潰す。読み取りは既に終わっている）。 */
export async function closeTranscriptSnapshot(snapshot: TranscriptSnapshot): Promise<void> {
  await snapshot.handle.close().catch(() => undefined);
}

interface RetainedRawLine {
  line: number;
  /** oversize 行はsource bytesを一切保持しない。 */
  raw: Buffer | null;
  oversized: boolean;
}

interface SnapshotScanResult {
  totalLines: number;
  lines: RetainedRawLine[];
}

/** 現在の物理行が、方向別の候補範囲へ入りうるかを返す。 */
function shouldRetainCurrentLine(
  lineNo: number,
  retainedLineCount: number,
  opts: TranscriptRawRangeOptions,
): boolean {
  if (opts.after !== undefined) {
    return lineNo > opts.after && retainedLineCount < opts.limit;
  }
  if (opts.before !== undefined) {
    return lineNo < opts.before;
  }
  return true;
}

/**
 * snapshotの各byteを最大1回だけ訪問する。改行探索はチャンク内の未探索offsetからだけ進め、
 * 1MiB超過が確定した行は保持済みsource bytesを即時破棄して次の改行まで長さだけ数える。
 */
async function scanSnapshot(
  snapshot: TranscriptSnapshot,
  opts: TranscriptRawRangeOptions,
  metrics?: TranscriptScanMetrics,
): Promise<SnapshotScanResult> {
  const { handle, size } = snapshot;
  if (metrics !== undefined) {
    metrics.scanPasses += 1;
  }
  if (size === 0) {
    return { totalLines: 0, lines: [] };
  }
  const buffer = Buffer.allocUnsafe(Math.min(SNAPSHOT_CHUNK_BYTES, size));
  let position = 0;
  let totalLines = 0;
  let currentLineBytes = 0;
  let currentLastByte: number | undefined;
  let currentChunks: Buffer[] = [];
  let currentRetainedBytes = 0;
  let retainedBytes = 0;
  let currentOversized = false;
  const lines: RetainedRawLine[] = [];

  const observeRetainedBytes = (): void => {
    if (metrics !== undefined) {
      metrics.peakRetainedBytes = Math.max(metrics.peakRetainedBytes, retainedBytes);
    }
  };

  const clearCurrentBytes = (): void => {
    retainedBytes -= currentRetainedBytes;
    currentRetainedBytes = 0;
    currentChunks = [];
  };

  const retainSegment = (segment: Buffer, retainCurrent: boolean): void => {
    if (segment.length === 0) {
      return;
    }
    currentLineBytes += segment.length;
    currentLastByte = segment[segment.length - 1];
    if (!retainCurrent || currentOversized) {
      return;
    }
    // MAX+1 の末尾byteが CR なら、CRLFのterminatorを除いてちょうどMAXになりうる。
    if (currentLineBytes > MAX_RAW_LINE_BYTES + 1) {
      currentOversized = true;
      clearCurrentBytes();
      return;
    }
    const copied = Buffer.from(segment);
    currentChunks.push(copied);
    currentRetainedBytes += copied.length;
    retainedBytes += copied.length;
    observeRetainedBytes();
  };

  const finishLine = (): void => {
    totalLines += 1;
    const lineNo = totalLines;
    const hasCarriageReturn = currentLineBytes > 0 && currentLastByte === 0x0d;
    const rawBytes = currentLineBytes - (hasCarriageReturn ? 1 : 0);
    const oversized = currentOversized || rawBytes > MAX_RAW_LINE_BYTES;
    if (oversized && metrics !== undefined) {
      metrics.oversizedLines += 1;
    }

    const selected = shouldRetainCurrentLine(lineNo, lines.length, opts);
    if (selected) {
      let raw: Buffer | null = null;
      if (!oversized) {
        const withTerminatorPrefix = Buffer.concat(currentChunks, currentLineBytes);
        raw = withTerminatorPrefix.subarray(0, rawBytes);
        // CR はline terminatorなので、候補の保持量からも除く。
        retainedBytes -= currentLineBytes - rawBytes;
      } else {
        clearCurrentBytes();
      }
      lines.push({ line: lineNo, raw, oversized });
      if (opts.after === undefined && lines.length > opts.limit) {
        const removed = lines.shift();
        if (removed?.raw !== null && removed?.raw !== undefined) {
          retainedBytes -= removed.raw.length;
        }
      }
    } else {
      clearCurrentBytes();
    }

    currentLineBytes = 0;
    currentLastByte = undefined;
    currentChunks = [];
    currentRetainedBytes = 0;
    currentOversized = false;
  };

  while (position < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (bytesRead <= 0) {
      throw new Error("snapshot ended before fixed size");
    }
    if (metrics !== undefined) {
      metrics.readCalls += 1;
      metrics.bytesRead += bytesRead;
    }
    position += bytesRead;
    let from = 0;
    while (from < bytesRead) {
      const newlineAt = buffer.indexOf(0x0a, from);
      const boundedNewlineAt = newlineAt >= bytesRead ? -1 : newlineAt;
      const segmentEnd = boundedNewlineAt === -1 ? bytesRead : boundedNewlineAt;
      const segment = buffer.subarray(from, segmentEnd);
      if (metrics !== undefined) {
        metrics.byteVisits += segment.length + (boundedNewlineAt === -1 ? 0 : 1);
      }
      retainSegment(segment, shouldRetainCurrentLine(totalLines + 1, lines.length, opts));
      if (boundedNewlineAt === -1) {
        break;
      }
      finishLine();
      from = boundedNewlineAt + 1;
    }
  }
  // 改行に到達していない末尾行は書き込み途中なので、物理行cursorにもentryにも含めない。
  clearCurrentBytes();
  return { totalLines, lines };
}

/**
 * after/before/未指定（tail）から startLine/endLine（1始まり・両端含む、limit 件以内）を計算する。
 * after と before の同時指定は呼び出し側（app.ts）で 400 にする前提のため考慮しないが、
 * 防御的に after を優先する。空範囲（totalLines===0 等）は startLine > endLine で表す。
 */
function computeLineRange(
  totalLines: number,
  opts: TranscriptRawRangeOptions,
): { startLine: number; endLine: number } {
  const { limit } = opts;
  if (opts.after !== undefined) {
    const startLine = opts.after + 1;
    const endLine = Math.min(totalLines, startLine + limit - 1);
    return { startLine, endLine };
  }
  if (opts.before !== undefined) {
    // before は totalLines より後ろを指しうる（クライアントが古い cursor を持ち続けた場合など）。
    // totalLines でクランプしないと、確定行として数えていない末尾の未改行行まで endLine に入り、
    // 未確定行が entries に載って endLine > totalLines という自己矛盾を返す（契約 §28.6-5）。
    const endLine = Math.min(totalLines, opts.before - 1);
    const startLine = Math.max(1, endLine - limit + 1);
    return { startLine, endLine };
  }
  // tail: 末尾 limit 行。
  const endLine = totalLines;
  const startLine = Math.max(1, endLine - limit + 1);
  return { startLine, endLine };
}

/**
 * 固定 snapshot に対して行範囲を1-passで読む（契約 §28.6-5, §28.6-11）。
 */
export async function readRangeFromSnapshot(
  snapshot: TranscriptSnapshot,
  provider: Provider,
  opts: TranscriptRawRangeOptions,
  metrics?: TranscriptScanMetrics,
): Promise<TranscriptRawRangeResult> {
  resetTranscriptScanMetrics(metrics);
  let scanned: SnapshotScanResult;
  try {
    scanned = await scanSnapshot(snapshot, opts, metrics);
  } catch {
    return { reason: "log-unreadable" };
  }

  const { totalLines } = scanned;
  const { startLine, endLine } = computeLineRange(totalLines, opts);
  const hasMoreBefore = startLine > 1;
  const hasMoreAfter = endLine < totalLines;

  if (startLine > endLine) {
    // ポーリングで「まだ新しい行が無い」を自然に表現する。エラーにはしない。
    return { totalLines, startLine, endLine, hasMoreBefore, hasMoreAfter, limitedBy: [], entries: [] };
  }

  const entries: SessionTranscriptRawEntry[] = [];
  let rawLineLimited = false;
  for (const line of scanned.lines) {
    if (line.line < startLine || line.line > endLine) {
      continue;
    }
    if (line.oversized) {
      rawLineLimited = true;
      entries.push({
        line: line.line,
        kind: "other",
        rawType: null,
        timestamp: null,
        text: OVERSIZED_RAW_LINE_PLACEHOLDER,
        unparsed: true,
      });
      continue;
    }
    if (line.raw === null) {
      continue;
    }
    if (metrics !== undefined) {
      metrics.decodedLines += 1;
    }
    const rawLine = line.raw.toString("utf8");
    if (rawLine.trim().length !== 0) {
      entries.push(buildEntry(line.line, rawLine, provider, metrics));
    }
  }

  return {
    totalLines,
    startLine,
    endLine,
    hasMoreBefore,
    hasMoreAfter,
    limitedBy: rawLineLimited ? ["raw-line-bytes"] : [],
    entries,
  };
}

/**
 * ネイティブ JSONL を行範囲でページングし、同一snapshotを1-passで読む。
 */
export async function readTranscriptRawRange(
  path: string,
  provider: Provider,
  opts: TranscriptRawRangeOptions,
  metrics?: TranscriptScanMetrics,
): Promise<TranscriptRawRangeResult> {
  resetTranscriptScanMetrics(metrics);
  const opened = await openTranscriptSnapshot(path);
  if ("reason" in opened) {
    return { reason: opened.reason };
  }
  try {
    return await readRangeFromSnapshot(opened.snapshot, provider, opts, metrics);
  } finally {
    await closeTranscriptSnapshot(opened.snapshot);
  }
}

/** found=false のときの理由コードに対応する人間向け文言（orchestrator-usage.ts の語彙感を踏襲）。 */
export const TRANSCRIPT_RAW_REASON_TEXT: Record<SessionTranscriptRawUnavailableReason, string> = {
  "log-not-found": "ネイティブログが見つかりませんでした",
  "log-unreadable": "ネイティブログを読み切れませんでした",
  "log-not-persisted": "この起動ではネイティブログが書かれません",
  "log-too-large": "ログが大きすぎるため全文表示は無効化されています",
  "session-id-unknown": "provider session id を特定できませんでした",
  "session-id-invalid": "provider session id の形式が不正なため参照を拒否しました",
  "path-outside-root": "ログのパスが許可された領域の外を指していたため参照を拒否しました",
};
