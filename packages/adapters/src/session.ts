// bridge /api/prompt・/api/messages の共通ロジック（docs/contract.md §13, live probe で確定した実仕様）
// CodexAdapter/ClaudeAdapter はこのモジュールに provider を束縛する薄いラッパー
import type {
  BridgeConfig,
  EffortLevel,
  EffortDelivery,
  ExecutionSpeed,
  LaunchOptions,
  Provider,
  SessionRef,
  SessionResultStats,
  SessionState,
  SessionStatus,
  StopResult,
  SpeedDelivery,
} from "@hachi/core";
import { BridgeError, bridgeFetch } from "./http.js";

/** /api/prompt の成功レスポンス形状（202 Accepted。docs/contract.md §13.1） */
interface PromptResponse {
  ok: boolean;
  sessionId?: string;
  modelDelivery?: unknown;
  effortDelivery?: unknown;
  speedDelivery?: unknown;
  maxTurnsDelivery?: unknown;
  appliedModel?: unknown;
  appliedEffort?: unknown;
  appliedSpeed?: unknown;
  appliedMaxTurns?: unknown;
  runtimeGenerationAttestation?: unknown;
}

interface LaunchSessionOptions {
  timeoutMs?: number;
  passthrough?: BridgePassthroughRequest;
  /** runtime のターン上限。省略時は runtime 既定に委ねる（even-terminal は 50 で打ち切る） */
  maxTurns?: number;
}

export interface BridgePassthroughRequest {
  model?: boolean;
  effort?: boolean;
  speed?: boolean;
}

export interface BridgeLaunchOptions extends LaunchOptions {
  bridgePassthrough?: BridgePassthroughRequest;
}

export interface BridgeLaunchSessionRef extends SessionRef {
  appliedModel?: string;
  appliedEffort?: EffortLevel;
  appliedSpeed?: ExecutionSpeed;
  requestedMaxTurns?: number;
  maxTurnsDelivery?: "native" | "none";
  appliedMaxTurns?: number;
  /** §75.10: producer responseのadditive object。status readerがexact validationするまでunknownのまま運ぶ。 */
  runtimeGenerationAttestation?: unknown;
}

/** /api/sessions から公開する launch 候補。応答由来の title/cwd は上位へ運ばない。 */
export interface BridgeSessionCandidate {
  id: string;
  status: "idle" | "busy";
  timestamp: string | null;
}

export type WorkerApiErrorCategory = "context-window-exceeded" | "provider-hard-error";

export interface WorkerApiErrorObservationEntry {
  sequence: number;
  category: WorkerApiErrorCategory;
}

/** adapter 内で検証済みの worker API hard error 観測（docs/contract.md §13.7）。 */
export interface WorkerApiErrorObservationV1 {
  schemaVersion: "worker-api-error-observation.v1";
  streamId: string;
  watermark: number;
  recent: readonly WorkerApiErrorObservationEntry[];
}

export type WorkerApiErrorObservationInvalidReason =
  | "schema-version"
  | "stream-id"
  | "watermark"
  | "recent-shape"
  | "sequence"
  | "category"
  | "consistency";

/** malformed variant は raw field やその hash を一切保持しない。 */
export type WorkerApiErrorObservationParseResult =
  | { kind: "absent" }
  | { kind: "valid"; value: WorkerApiErrorObservationV1 }
  | { kind: "malformed"; reason: WorkerApiErrorObservationInvalidReason };

export interface BridgeSessionStatus extends SessionStatus {
  /** 最後の type:"result" イベントの単調増加 id。窓内に result が無ければ 0。 */
  lastResultId: number;
  /** /api/messages 窓内の全 entry で最大の正の単調増加 id。無ければ 0。 */
  lastEntryId: number;
  /** top-level apiErrorObservation の安全な additive parse 結果。 */
  apiErrorObservation: WorkerApiErrorObservationParseResult;
}

function isPromptResponse(value: unknown): value is PromptResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof (value as { ok: unknown }).ok === "boolean"
  );
}

function modelDeliveryFromPayload(value: unknown): "native" | "none" {
  return value === "native" ? "native" : "none";
}

function effortDeliveryFromPayload(value: unknown, requested: boolean): EffortDelivery | undefined {
  if (!requested) {
    return undefined;
  }
  return value === "native" ? "native" : "none";
}

function speedDeliveryFromPayload(value: unknown, requested: boolean): SpeedDelivery | undefined {
  if (!requested) {
    return undefined;
  }
  return value === "native" ? "native" : "none";
}

function maxTurnsDeliveryFromPayload(value: unknown, requested: boolean): "native" | "none" | undefined {
  if (!requested) {
    return undefined;
  }
  return value === "native" ? "native" : "none";
}

function appliedEffortFromPayload(value: unknown): EffortLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (
    normalized === "low" || normalized === "medium" || normalized === "high" ||
    normalized === "xhigh" || normalized === "max"
  ) {
    return normalized;
  }
  return undefined;
}

function appliedSpeedFromPayload(value: unknown): ExecutionSpeed | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized === "standard" || normalized === "fast" ? normalized : undefined;
}

function appliedMaxTurnsFromPayload(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function promptBody(
  provider: Provider,
  options: LaunchOptions,
  passthrough: BridgePassthroughRequest,
  maxTurns?: number,
): Record<string, unknown> {
  return {
    text: options.promptText,
    provider,
    cwd: options.cwd,
    ...(passthrough.model === true ? { model: options.model } : {}),
    ...(passthrough.effort === true && options.effort !== undefined ? { effort: options.effort } : {}),
    ...(passthrough.speed === true && options.speed !== undefined ? { speed: options.speed } : {}),
    ...(maxTurns === undefined ? {} : { maxTurns }),
  };
}

/**
 * bridge /api/prompt へ POST し新規セッションを起動する。
 * 成功レスポンス（202 + {ok:true, sessionId}）を検証して SessionRef を構築する。
 * 既定では model/effort/speed/maxTurns を body に含めない。passthrough で真になった項目と
 * sessionOptions.maxTurns だけを送り、応答の delivery フィールドが native でない場合は
 * none として記録する（無視を隠さない）。
 */
export async function launchSession(
  bridge: BridgeConfig,
  provider: Provider,
  options: LaunchOptions,
  sessionOptions: LaunchSessionOptions = {},
): Promise<BridgeLaunchSessionRef> {
  // adapter 固有の要求（sessionOptions.passthrough）と呼び出し側の要求（bridgePassthrough）を併合する。
  // 片方で上書きすると、supervisor が resolution から組み立てた effort/speed のフラグが落ち、
  // 実配送されないまま bridge_native_missing で run が止まる。
  const passthrough: BridgePassthroughRequest = {
    ...((options as BridgeLaunchOptions).bridgePassthrough ?? {}),
    ...(sessionOptions.passthrough ?? {}),
  };
  const response = await bridgeFetch(bridge, "/api/prompt", {
    method: "POST",
    ...(sessionOptions.timeoutMs !== undefined ? { timeoutMs: sessionOptions.timeoutMs } : {}),
    body: promptBody(provider, options, passthrough, sessionOptions.maxTurns),
  });

  const payload: unknown = await response.json();
  if (
    !isPromptResponse(payload) ||
    payload.ok !== true ||
    typeof payload.sessionId !== "string" ||
    payload.sessionId === ""
  ) {
    throw new BridgeError(
      "bridge /api/prompt が不正なレスポンスを返しました（sessionId 欠如）",
      "http",
    );
  }

  const effortDelivery = effortDeliveryFromPayload(payload.effortDelivery, options.effort !== undefined);
  const speedDelivery = speedDeliveryFromPayload(payload.speedDelivery, options.speed !== undefined);
  const maxTurnsDelivery = maxTurnsDeliveryFromPayload(
    payload.maxTurnsDelivery,
    sessionOptions.maxTurns !== undefined,
  );
  const requestedMaxTurns = sessionOptions.maxTurns;
  const appliedModel = typeof payload.appliedModel === "string" ? payload.appliedModel : undefined;
  const appliedEffort = appliedEffortFromPayload(payload.appliedEffort);
  const appliedSpeed = speedDelivery === "native" ? appliedSpeedFromPayload(payload.appliedSpeed) : undefined;
  const appliedMaxTurns = maxTurnsDelivery === "native"
    ? appliedMaxTurnsFromPayload(payload.appliedMaxTurns)
    : undefined;
  const runtimeGenerationAttestation = typeof payload.runtimeGenerationAttestation === "object" &&
      payload.runtimeGenerationAttestation !== null && !Array.isArray(payload.runtimeGenerationAttestation)
    ? payload.runtimeGenerationAttestation
    : undefined;

  return {
    provider,
    sessionId: payload.sessionId,
    serverUrl: bridge.url,
    model: options.model,
    modelDelivery: modelDeliveryFromPayload(payload.modelDelivery),
    ...(effortDelivery !== undefined ? { effortDelivery } : {}),
    ...(speedDelivery !== undefined ? { speedDelivery } : {}),
    ...(requestedMaxTurns !== undefined ? { requestedMaxTurns } : {}),
    ...(maxTurnsDelivery !== undefined ? { maxTurnsDelivery } : {}),
    ...(appliedModel !== undefined ? { appliedModel } : {}),
    ...(appliedEffort !== undefined ? { appliedEffort } : {}),
    ...(appliedSpeed !== undefined ? { appliedSpeed } : {}),
    ...(appliedMaxTurns !== undefined ? { appliedMaxTurns } : {}),
    ...(runtimeGenerationAttestation !== undefined ? { runtimeGenerationAttestation } : {}),
    startedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * GET /api/sessions を照会し、同一 cwd + provider の session だけを返す（契約 §13.6 / §34.1）。
 * bridgeFetch の GET リトライ規約を使うが、呼び出し側からの論理照会は1回だけにする。
 * 他 session の title/cwd は返却型へ含めず、timestamp 欠落・非文字列は null のまま不明として運ぶ。
 */
export async function fetchSessionsByCwdAndProvider(
  bridge: BridgeConfig,
  cwd: string,
  provider: Provider,
): Promise<BridgeSessionCandidate[]> {
  const response = await bridgeFetch(bridge, "/api/sessions", { method: "GET" });
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.sessions)) {
    throw new BridgeError("bridge /api/sessions が不正なレスポンスを返しました", "http");
  }

  const candidates: BridgeSessionCandidate[] = [];
  for (const session of payload.sessions) {
    if (
      !isRecord(session) ||
      session.cwd !== cwd ||
      session.provider !== provider ||
      typeof session.id !== "string" ||
      session.id === "" ||
      (session.status !== "idle" && session.status !== "busy")
    ) {
      continue;
    }
    candidates.push({
      id: session.id,
      status: session.status,
      timestamp: typeof session.timestamp === "string" ? session.timestamp : null,
    });
  }
  return candidates;
}

/**
 * bridge 系 adapter の stop（契約 §34.2）。
 * bridge API に停止経路が無いため、常に「経路が無い」ことを正直に報告する
 * （throw しない。CodexAdapter/ClaudeAdapter で共用）。
 */
export async function stopUnsupported(): Promise<StopResult> {
  return { stopped: false, reason: "unsupported" };
}

/**
 * status / inject / fetchTranscript の接続先を解決する。
 * ref.serverUrl（task_runs 正本由来）が非空ならそちらを使い、bridge URL 変更後も既存セッションへ
 * 正しく到達できるようにする。ref.serverUrl が空文字（後方互換: 旧データ等）の場合のみ構成 bridge へ
 * フォールバックする（docs/contract.md §12.15-2）。loopback 検証は bridgeFetch 側で解決後の URL に
 * 対して適用される。
 */
function resolveSessionBridge(bridge: BridgeConfig, ref: SessionRef): BridgeConfig {
  if (ref.serverUrl === "") {
    return bridge;
  }
  return { ...bridge, url: ref.serverUrl };
}

/**
 * 稼働中セッションへメッセージを注入する（steer）。
 * ref.serverUrl（起動時に確定した接続先）へ sessionId を指定して /api/prompt へ POST する
 * （常に新規スレッドではなく既存へ注入）。
 */
export async function injectSession(bridge: BridgeConfig, ref: SessionRef, message: string): Promise<void> {
  const response = await bridgeFetch(resolveSessionBridge(bridge, ref), "/api/prompt", {
    method: "POST",
    body: {
      text: message,
      provider: ref.provider,
      sessionId: ref.sessionId,
    },
  });

  const payload: unknown = await response.json();
  if (!isPromptResponse(payload) || payload.ok !== true) {
    throw new BridgeError("bridge /api/prompt (inject) が不正なレスポンスを返しました", "http");
  }
}

// ========== /api/messages 共通取得（docs/contract.md §13.3） ==========

/** GET /api/messages の1エントリ（type 判別ユニオン。role/author/from フィールドは存在しない） */
interface MessagesPayload {
  /** entries（messages 配列）。取得できない・不正形状の場合は空配列 */
  entries: readonly unknown[];
  /** top-level state（"busy"|"idle" の想定だが未検証のまま渡す） */
  rawState: unknown;
  /** デバッグ用の生ペイロード（ログには要 redaction） */
  raw: unknown;
}

/** CLI 等の観測用に公開する /api/messages の取得結果（生イベント列 + top-level state）。 */
export interface SessionMessages {
  entries: readonly Record<string, unknown>[];
  state: unknown;
}

/**
 * GET /api/messages を取得し、entries（messages 配列）と top-level state を取り出す。
 * 未知セッションでも常に 200（messages 空配列 + state:"idle"）が返る仕様のため、404 は扱わない
 * （docs/contract.md §13.3）。レスポンス形状が不正な場合は空 entries・rawState=undefined として
 * fail-closed に倒す。
 */
async function fetchMessagesPayload(bridge: BridgeConfig, ref: SessionRef): Promise<MessagesPayload> {
  const path = `/api/messages?sessionId=${encodeURIComponent(ref.sessionId)}&provider=${encodeURIComponent(ref.provider)}`;
  const response = await bridgeFetch(resolveSessionBridge(bridge, ref), path, { method: "GET" });
  const raw: unknown = await response.json();

  if (typeof raw !== "object" || raw === null) {
    return { entries: [], rawState: undefined, raw };
  }
  const record = raw as Record<string, unknown>;
  const entries = Array.isArray(record.messages) ? record.messages : [];
  return { entries, rawState: record.state, raw };
}

/**
 * GET /api/messages の生イベント列を返す。表示整形は呼び出し側で行い、
 * token 読み取りや ref.serverUrl 解決は adapters 内に閉じ込める（docs/contract.md §50.3）。
 */
export async function fetchSessionMessages(bridge: BridgeConfig, ref: SessionRef): Promise<SessionMessages> {
  const { entries, rawState } = await fetchMessagesPayload(bridge, ref);
  return {
    entries: entries.filter(isRecord),
    state: rawState,
  };
}

/**
 * top-level state を厳密にマッピングする（docs/contract.md §13.2/§13.4）。
 * 実 bridge の state は "busy" | "idle" の2値のみ。それ以外（欠如・不正値含む）はすべて 'unknown'
 * として扱い、キーワード推測（旧実装）は行わない。
 */
function mapBusyIdleState(rawState: unknown): SessionState {
  if (rawState === "busy") {
    return "active";
  }
  if (rawState === "idle") {
    return "idle";
  }
  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const WORKER_API_ERROR_OBSERVATION_SCHEMA = "worker-api-error-observation.v1";
const WORKER_API_ERROR_OBSERVATION_MAX_RECENT = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function malformedWorkerApiErrorObservation(
  reason: WorkerApiErrorObservationInvalidReason,
): WorkerApiErrorObservationParseResult {
  return { kind: "malformed", reason };
}

function isWorkerApiErrorCategory(value: unknown): value is WorkerApiErrorCategory {
  return value === "context-window-exceeded" || value === "provider-hard-error";
}

/**
 * /api/messages の additive apiErrorObservation を検証する（docs/contract.md §13.7）。
 * field absent は旧 runtime として成功し、present だが不正な値は allowlist reason だけへ縮退する。
 */
export function parseWorkerApiErrorObservation(payload: unknown): WorkerApiErrorObservationParseResult {
  if (!isRecord(payload) || Array.isArray(payload) || !Object.hasOwn(payload, "apiErrorObservation")) {
    return { kind: "absent" };
  }

  const value = payload.apiErrorObservation;
  if (!isRecord(value) || Array.isArray(value)) {
    return malformedWorkerApiErrorObservation("recent-shape");
  }
  if (value.schemaVersion !== WORKER_API_ERROR_OBSERVATION_SCHEMA) {
    return malformedWorkerApiErrorObservation("schema-version");
  }
  if (typeof value.streamId !== "string" || !UUID_PATTERN.test(value.streamId)) {
    return malformedWorkerApiErrorObservation("stream-id");
  }
  if (!Number.isSafeInteger(value.watermark) || (value.watermark as number) < 0) {
    return malformedWorkerApiErrorObservation("watermark");
  }
  if (!Array.isArray(value.recent) || value.recent.length > WORKER_API_ERROR_OBSERVATION_MAX_RECENT) {
    return malformedWorkerApiErrorObservation("recent-shape");
  }

  const watermark = value.watermark as number;
  const recent: WorkerApiErrorObservationEntry[] = [];
  let previousSequence = 0;
  for (const entry of value.recent) {
    if (!isRecord(entry) || Array.isArray(entry)) {
      return malformedWorkerApiErrorObservation("recent-shape");
    }
    if (
      !Number.isSafeInteger(entry.sequence) ||
      (entry.sequence as number) <= 0 ||
      (entry.sequence as number) <= previousSequence
    ) {
      return malformedWorkerApiErrorObservation("sequence");
    }
    if (!isWorkerApiErrorCategory(entry.category)) {
      return malformedWorkerApiErrorObservation("category");
    }

    const sequence = entry.sequence as number;
    recent.push({ sequence, category: entry.category });
    previousSequence = sequence;
  }

  if (
    (watermark === 0 && recent.length !== 0) ||
    (watermark > 0 && (recent.length === 0 || recent[recent.length - 1]?.sequence !== watermark))
  ) {
    return malformedWorkerApiErrorObservation("consistency");
  }

  return {
    kind: "valid",
    value: {
      schemaVersion: WORKER_API_ERROR_OBSERVATION_SCHEMA,
      streamId: value.streamId,
      watermark,
      recent,
    },
  };
}

/** apiErrorObservation は検証済み projection だけを返すため、既存 raw status から常に除外する。 */
function omitWorkerApiErrorObservation(payload: unknown): unknown {
  if (!isRecord(payload) || Array.isArray(payload) || !Object.hasOwn(payload, "apiErrorObservation")) {
    return payload;
  }
  const sanitized = { ...payload };
  delete sanitized.apiErrorObservation;
  return sanitized;
}

/** entries 中の type:"result" イベント数を数える（docs/contract.md §13.4 のターン完了判定に使う） */
function countResultEntries(entries: readonly unknown[]): number {
  return entries.filter((entry) => isRecord(entry) && entry.type === "result").length;
}

function positiveIntegerId(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return Number(value);
  }
  return 0;
}

/** entries の中から最後の type:"result" イベントを返す（無ければ undefined。docs/contract.md §14.5） */
function findLastResultEntry(entries: readonly unknown[]): Record<string, unknown> | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (isRecord(entry) && entry.type === "result") {
      return entry;
    }
  }
  return undefined;
}

/** entries の中で最後に現れた type:"result" イベントの単調増加 id を返す（無ければ 0）。 */
function lastResultId(entries: readonly unknown[]): number {
  const last = findLastResultEntry(entries);
  return last === undefined ? 0 : positiveIntegerId(last.id);
}

/** entries 全体から最大の正の単調増加 id を返す（欠如・不正のみなら 0）。 */
function lastEntryId(entries: readonly unknown[]): number {
  return entries.reduce<number>((maxId, entry) => {
    if (!isRecord(entry)) {
      return maxId;
    }
    return Math.max(maxId, positiveIntegerId(entry.id));
  }, 0);
}

/** SessionResultStats に抽出する result イベントの数値フィールド一覧（docs/contract.md §14.5） */
const RESULT_STAT_KEYS = ["costUsd", "turns", "durationMs", "inputTokens", "outputTokens"] as const;

/**
 * 最後の type:"result" イベントから実行統計（コスト/トークン）を抽出する（docs/contract.md §14.5）。
 * 数値でないフィールドは省略する。result イベント自体が存在しない場合は undefined を返し、
 * 呼び出し側で SessionStatus.lastResult 自体を省略させる。
 */
function extractLastResult(entries: readonly unknown[]): SessionResultStats | undefined {
  const last = findLastResultEntry(entries);
  if (last === undefined) {
    return undefined;
  }
  const stats: SessionResultStats = {};
  for (const key of RESULT_STAT_KEYS) {
    const value = last[key];
    if (typeof value === "number") {
      stats[key] = value;
    }
  }
  return stats;
}

/**
 * GET /api/messages から top-level state と resultCount を取得する（docs/contract.md §13.4）。
 * /api/status は state が busy/idle の2値のみで終了検知に使えないため、adapter.status() は
 * /api/messages を1回だけ呼び、state と resultCount を同時に得る（/api/status は呼ばない）。
 * 未知セッション（200 + messages 空配列 + state:"idle"）は state='idle'/resultCount=0 になる。
 * 最後の type:"result" イベントの統計は lastResult に充填する（docs/contract.md §14.5）。
 */
export async function getSessionStatus(
  bridge: BridgeConfig,
  ref: SessionRef,
): Promise<BridgeSessionStatus> {
  const { entries, rawState, raw } = await fetchMessagesPayload(bridge, ref);
  const lastResult = extractLastResult(entries);
  const status: BridgeSessionStatus = {
    state: mapBusyIdleState(rawState),
    // 実 bridge の /api/messages にはタイムスタンプフィールドが存在しない（docs/contract.md §13.2）
    lastActivityAt: null,
    resultCount: countResultEntries(entries),
    lastResultId: lastResultId(entries),
    lastEntryId: lastEntryId(entries),
    apiErrorObservation: parseWorkerApiErrorObservation(raw),
    raw: omitWorkerApiErrorObservation(raw),
    ...(lastResult !== undefined ? { lastResult } : {}),
  };
  return status;
}

/**
 * GET /api/messages からセッションの会話ログ全文を transcript 文字列へ整形する（docs/contract.md §13.5）。
 */
export async function fetchSessionTranscript(bridge: BridgeConfig, ref: SessionRef): Promise<string> {
  const { entries } = await fetchMessagesPayload(bridge, ref);
  return formatTranscript(entries);
}

// ========== transcript 整形（docs/contract.md §13.5） ==========

/** entry から text フィールドを安全に取り出す（無ければ空文字） */
function extractEntryText(record: Record<string, unknown>): string {
  const value = record.text;
  return typeof value === "string" ? value : "";
}

/**
 * transcript の構築規約（docs/contract.md §13.5）:
 * - user_prompt -> `[user] <text>`
 * - result -> `[assistant] <text>`（確定応答。text_delta の断片はここに集約されるため text_delta 自体は除外）
 * - status / running_stats はテレメトリのため除外
 * - 上記以外の未知 type は将来の型追加に備えて安全側で除外し、件数のみ末尾に注記する（テレメトリの
 *   黙殺とは区別し、除外した事実を transcript 上に残す）
 */
function formatTranscript(entries: readonly unknown[]): string {
  const lines: string[] = [];
  let excludedUnknownCount = 0;

  for (const entry of entries) {
    if (!isRecord(entry)) {
      excludedUnknownCount += 1;
      continue;
    }

    switch (entry.type) {
      case "user_prompt":
        lines.push(`[user] ${extractEntryText(entry)}`);
        break;
      case "result":
        lines.push(`[assistant] ${extractEntryText(entry)}`);
        break;
      case "status":
      case "running_stats":
      case "text_delta":
        // テレメトリ・中間状態のため除外（docs/contract.md §13.5）
        break;
      default:
        // 未知 type: 安全側で除外し、件数のみ末尾に注記する
        excludedUnknownCount += 1;
        break;
    }
  }

  if (excludedUnknownCount > 0) {
    lines.push(`未知タイプ ${excludedUnknownCount} 件を除外`);
  }

  return lines.join("\n\n");
}
