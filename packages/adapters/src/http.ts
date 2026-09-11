// bridge（even-terminal）との低レベル HTTP 通信を担うモジュール
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import {
  redactText,
  type BridgeConfig,
  type ExecutionCapabilitySnapshot,
  type Provider,
} from "@hachi/core";

/** bridge 通信エラーの種別 */
export type BridgeErrorKind = "auth" | "http" | "network" | "policy" | "timeout";
export type BridgeIdentityFailureKind =
  | "auth"
  | "http"
  | "network"
  | "policy"
  | "timeout"
  | "invalid-json"
  | "invalid-body";

export interface BridgeIdentityFailure {
  kind: BridgeIdentityFailureKind;
  detail: string;
  status?: number;
  /** true の場合は even-terminal 以外が当該 port を横取りしている疑いが強い */
  suspectPortHijack: boolean;
}

export type BridgeIdentityResult =
  | { ok: true; sessionCount: number }
  | { ok: false; failure: BridgeIdentityFailure };

export type BridgeIdentityFetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface BridgeIdentityDeps {
  fetch?: BridgeIdentityFetchFn;
}

/**
 * bridge との通信で発生したエラー。
 * token 等の秘匿情報は message に絶対含めない。
 */
export class BridgeError extends Error {
  readonly status: number | null;
  readonly kind: BridgeErrorKind;
  readonly body: unknown;

  constructor(message: string, kind: BridgeErrorKind, status: number | null = null, body?: unknown) {
    super(message);
    this.name = "BridgeError";
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}

const MAX_BRIDGE_TOKEN_FILE_BYTES = 8 * 1024;

/**
 * bridge token を安全な regular file から上限付きで読み trim して返す。
 * 読み込みに失敗した場合は throw する（メッセージにパスは含めてよいが token 値は含めない）。
 */
export function readBridgeToken(tokenFile: string): string {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error(`bridge token ファイルのsymlink防止を利用できません: ${tokenFile}`);
  }

  let fileDescriptor: number;
  try {
    fileDescriptor = openSync(tokenFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error(`bridge token ファイルの読み込みに失敗しました: ${tokenFile}`);
  }

  try {
    const stats = fstatSync(fileDescriptor);
    if (!stats.isFile()) {
      throw new Error(`bridge token path はregular fileではありません: ${tokenFile}`);
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (currentUid !== undefined && stats.uid !== currentUid) {
      throw new Error(`bridge token ファイルのownerが現在のuserではありません: ${tokenFile}`);
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`bridge token ファイルはgroup/otherから読めないmodeにしてください: ${tokenFile}`);
    }
    if (stats.size > MAX_BRIDGE_TOKEN_FILE_BYTES) {
      throw new Error(`bridge token ファイルが上限を超えています: ${tokenFile}`);
    }

    const buffer = Buffer.alloc(MAX_BRIDGE_TOKEN_FILE_BYTES + 1);
    const bytesRead = readSync(fileDescriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BRIDGE_TOKEN_FILE_BYTES) {
      throw new Error(`bridge token ファイルが上限を超えています: ${tokenFile}`);
    }
    const token = buffer.toString("utf8", 0, bytesRead).trim();
    if (token === "") {
      throw new Error(`bridge token ファイルが空です: ${tokenFile}`);
    }
    return token;
  } finally {
    closeSync(fileDescriptor);
  }
}

/** bridgeFetch のリクエストオプション */
export interface BridgeFetchInit {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

export const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 10_000;
const BRIDGE_IDENTITY_TIMEOUT_MS = 10_000;

/** env HACHI_BRIDGE_ALLOW_REMOTE=1 のリモート bridge 明示 opt-in フラグ名 */
const ALLOW_REMOTE_ENV_VAR = "HACHI_BRIDGE_ALLOW_REMOTE";

// ========== GET リトライ（docs/contract.md §34.1） ==========

/** リトライ待機の実装の型。テスト容易性のため注入可能にする（実時間待機のテストを書かせないため）。 */
export type SleepFn = (ms: number) => Promise<void>;

/** 既定の sleep 実装（実時間 setTimeout）。 */
const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** bridgeFetch/bridgeHealthCheck が受け取る依存注入（sleep のみ。docs/contract.md §34.1） */
export interface BridgeRetryDeps {
  /** リトライ間の待機実装（省略時は実時間待機） */
  sleep?: SleepFn;
}

/**
 * リトライ待機の基準値（ms）。先頭から順に 1 回目=500ms、2 回目=1500ms を意味する
 * （docs/contract.md §34.1）。配列長がそのまま最大リトライ回数（2 回）になる。
 */
const RETRY_BACKOFF_BASE_MS: readonly number[] = [500, 1500];

/** バックオフの jitter 幅（±20%、docs/contract.md §34.1） */
const RETRY_JITTER_RATIO = 0.2;

/** ±20% の jitter を適用した待機時間（ms）を返す。 */
function jitteredDelay(baseMs: number): number {
  const jitterRatio = 1 + (Math.random() * 2 - 1) * RETRY_JITTER_RATIO;
  return Math.round(baseMs * jitterRatio);
}

/**
 * BridgeError が再試行対象かどうかを判定する。
 * network/timeout、または 5xx（kind='http' かつ status 500-599）のみ再試行対象とする。
 * 認可失敗（401/403）・policy 違反（リダイレクト・非 loopback）・4xx は対象外
 * （docs/contract.md §34.1、fail-closed で即時失敗させる）。
 */
function isRetryableBridgeError(error: unknown): boolean {
  if (!(error instanceof BridgeError)) {
    return false;
  }
  if (error.kind === "network" || error.kind === "timeout") {
    return true;
  }
  return error.kind === "http" && error.status !== null && error.status >= 500 && error.status < 600;
}

/**
 * 副作用の無い（GET 相当の）呼び出しを network/timeout/5xx 失敗時に最大2回まで指数バックオフ
 * （500ms → 1500ms、±20% jitter）で再試行する（docs/contract.md §34.1）。
 * POST 等の副作用がある呼び出しはこの経路を通さない（at-most-once 維持）。
 * RETRY_BACKOFF_BASE_MS を使い切った時点（3 回目の失敗）で最後のエラーを throw する。
 */
async function withGetRetry<T>(attempt: () => Promise<T>, sleep: SleepFn): Promise<T> {
  for (let index = 0; ; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      const baseMs = RETRY_BACKOFF_BASE_MS[index];
      if (baseMs === undefined || !isRetryableBridgeError(error)) {
        throw error;
      }
      await sleep(jitteredDelay(baseMs));
    }
  }
}

/**
 * URL のホストが loopback（127.0.0.1 / localhost / [::1]）かどうかを判定する。
 * WHATWG URL の hostname getter は IPv6 を `[::1]` のようにブラケット付きで返すため、
 * 比較前にブラケットを取り除く。
 */
function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

/**
 * bridge URL のホストが loopback 以外の場合、HTTPS と env HACHI_BRIDGE_ALLOW_REMOTE=1 の
 * 明示 opt-in を両方要求する。token を送る全経路（bridgeFetch）で必ず通す
 * （docs/contract.md §12.13-3, token 流出の防止）。
 */
function assertLoopbackOrRemoteAllowed(url: URL): void {
  if (isLoopbackHost(url.hostname)) {
    return;
  }
  if (process.env[ALLOW_REMOTE_ENV_VAR] !== "1") {
    throw new BridgeError(
      `bridge URL がループバック以外のホストを指しています (host=${url.hostname})。` +
        `リモート bridge を許可する場合は環境変数 ${ALLOW_REMOTE_ENV_VAR}=1 を設定してください。`,
      "policy",
    );
  }
  if (url.protocol !== "https:") {
    throw new BridgeError(
      `リモート bridge URL はHTTPSである必要があります (host=${url.hostname})。`,
      "policy",
    );
  }
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    return redactText(error.message);
  }
  return redactText(String(error));
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function isSessionsBody(value: unknown): value is { sessions: unknown[] } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Array.isArray((value as Record<string, unknown>)["sessions"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      return await response.json();
    }
    const text = await response.text();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

function bridgeIdentityFailure(
  kind: BridgeIdentityFailureKind,
  detail: string,
  suspectPortHijack: boolean,
  status?: number,
): BridgeIdentityResult {
  return {
    ok: false,
    failure: {
      kind,
      detail,
      suspectPortHijack,
      ...(status !== undefined ? { status } : {}),
    },
  };
}

/**
 * bridgeFetch の1回分の実行（リトライなし）。
 */
async function bridgeFetchOnce(
  bridge: BridgeConfig,
  path: string,
  init: BridgeFetchInit,
): Promise<Response> {
  const parsedUrl = new URL(path, bridge.url);
  assertLoopbackOrRemoteAllowed(parsedUrl);
  const token = readBridgeToken(bridge.tokenFile);
  const url = parsedUrl.toString();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  let response: Response;
  try {
    const requestInit: RequestInit = {
      method: init.method ?? "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS),
    };
    if (body !== undefined) {
      requestInit.body = body;
    }
    response = await fetch(url, requestInit);
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new BridgeError(`bridge への接続がタイムアウトしました: ${path}`, "timeout");
    }
    throw new BridgeError(`bridge への接続に失敗しました: ${path}`, "network");
  }

  // リダイレクト応答は追従せず fail-closed でエラーとする（docs/contract.md §12.14-1）。
  // loopback 検証をリダイレクトで迂回されないよう、token を送った後の応答が 3xx（または
  // ランタイムによっては status=0 の opaqueredirect）であれば必ず throw する。
  // リダイレクト先のホスト情報はメッセージに含めない。
  if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
    throw new BridgeError(`bridge がリダイレクト応答を返しました: ${path}`, "policy");
  }

  if (!response.ok) {
    const errorBody = await readResponseBody(response);
    if (response.status === 401 || response.status === 403) {
      throw new BridgeError(
        `bridge 認証に失敗しました (status=${response.status})`,
        "auth",
        response.status,
        errorBody,
      );
    }
    throw new BridgeError(
      `bridge がエラーを返しました (status=${response.status}): ${path}`,
      "http",
      response.status,
      errorBody,
    );
  }

  return response;
}

/**
 * bridge へ Authorization: Bearer <token> を付与して fetch する。
 * 非 2xx レスポンスは BridgeError を throw する。token 値はエラーメッセージへ含めない。
 * loopback 以外のホストへは既定で token を送らない（docs/contract.md §12.13-3）。
 *
 * GET（既定・副作用無し）は network/timeout/5xx 失敗時に最大2回まで指数バックオフで再試行する
 * （docs/contract.md §34.1）。POST 等の副作用がある呼び出しは絶対に再試行しない（at-most-once 維持）。
 */
export async function bridgeFetch(
  bridge: BridgeConfig,
  path: string,
  init: BridgeFetchInit = {},
  deps: BridgeRetryDeps = {},
): Promise<Response> {
  if ((init.method ?? "GET") !== "GET") {
    // 副作用がある呼び出し（POST 等）はリトライさせない（docs/contract.md §34.1, §12.10-1 と同根）。
    return bridgeFetchOnce(bridge, path, init);
  }
  const sleep = deps.sleep ?? realSleep;
  return withGetRetry(() => bridgeFetchOnce(bridge, path, init), sleep);
}

/**
 * bridgeHealthCheck の1回分の実行（リトライなし）。
 * network/timeout/5xx は BridgeError を throw し、呼び出し側のリトライ判定に委ねる。
 * それ以外（3xx・loopback 違反等）は再試行の余地が無いためこの関数内で確定させる。
 */
async function bridgeHealthCheckOnce(bridge: BridgeConfig): Promise<boolean> {
  const parsedUrl = new URL("/api/info", bridge.url);
  // token は送らないため対象外だが、loopback 検証を通しておいても害はない（docs/contract.md §12.13-3）。
  assertLoopbackOrRemoteAllowed(parsedUrl);

  let response: Response;
  try {
    response = await fetch(parsedUrl.toString(), {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new BridgeError("bridge healthCheck がタイムアウトしました", "timeout");
    }
    throw new BridgeError("bridge healthCheck の接続に失敗しました", "network");
  }

  if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
    return false;
  }
  if (response.status >= 500 && response.status < 600) {
    throw new BridgeError(
      `bridge healthCheck が 5xx を返しました (status=${response.status})`,
      "http",
      response.status,
    );
  }
  return response.status === 401;
}

/**
 * bridge の生存確認。token 無しで GET /api/info する。
 * status===401（token 無しで認証を要求してくる = bridge 自身が生きている証拠）の場合のみ true。
 * それ以外の HTTP 応答（200/404 等、bridge ではない別サービスの応答を含む）は false
 * （docs/contract.md §12.4-6, fail-closed）。
 * リダイレクト応答（3xx）も追従せず false 扱いとする（docs/contract.md §12.14-1）。
 *
 * network/timeout/5xx は最大2回まで指数バックオフで再試行してから false に倒す
 * （docs/contract.md §34.1）。それ以外の失敗（policy 違反・3xx 等）は再試行せず即 false。
 */
export async function bridgeHealthCheck(bridge: BridgeConfig, deps: BridgeRetryDeps = {}): Promise<boolean> {
  const sleep = deps.sleep ?? realSleep;
  try {
    return await withGetRetry(() => bridgeHealthCheckOnce(bridge), sleep);
  } catch {
    return false;
  }
}

/**
 * bridge identity probe。token 付き GET /api/sessions が 200 かつ `{sessions: [...]}` を返すことを
 * even-terminal 本人確認の条件にする。404/HTML/異形 JSON は port 乗っ取り疑いとして返す。
 */
export async function probeBridgeIdentity(
  bridge: BridgeConfig,
  deps: BridgeIdentityDeps = {},
): Promise<BridgeIdentityResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL("/api/sessions", bridge.url);
    assertLoopbackOrRemoteAllowed(parsedUrl);
  } catch (error) {
    return bridgeIdentityFailure("policy", errorDetail(error), false);
  }

  let token: string;
  try {
    token = readBridgeToken(bridge.tokenFile);
  } catch (error) {
    return bridgeIdentityFailure("auth", errorDetail(error), false);
  }

  const fetchImpl = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(parsedUrl.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(BRIDGE_IDENTITY_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      return bridgeIdentityFailure("timeout", "identity request timed out", false);
    }
    return bridgeIdentityFailure("network", errorDetail(error), false);
  }

  if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
    return bridgeIdentityFailure("policy", "redirect response", true, response.status);
  }

  if (response.status !== 200) {
    const authFailure = response.status === 401 || response.status === 403;
    return bridgeIdentityFailure(
      authFailure ? "auth" : "http",
      `status=${response.status}`,
      !authFailure,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return bridgeIdentityFailure("invalid-json", "JSON parse failed", true);
  }

  if (!isSessionsBody(body)) {
    return bridgeIdentityFailure("invalid-body", "sessions array missing", true);
  }

  return { ok: true, sessionCount: body.sessions.length };
}

export type BridgeCapabilitiesFailureKind =
  | "auth"
  | "http"
  | "network"
  | "policy"
  | "timeout"
  | "invalid-json"
  | "invalid-body";

export interface BridgeCapabilitiesFailure {
  kind: BridgeCapabilitiesFailureKind;
  detail: string;
  status?: number;
}

export type BridgeCapabilitiesResult =
  | { ok: true; provider: "codex"; capabilities: readonly string[] }
  | { ok: false; provider: "codex"; failure: BridgeCapabilitiesFailure };

export type BridgeExecutionCapabilityResult =
  | { ok: true; provider: Provider; snapshot: ExecutionCapabilitySnapshot }
  | { ok: false; provider: Provider; failure: BridgeCapabilitiesFailure };

export interface BridgeExecutionCapabilityDeps {
  now?: () => number;
  sleep?: SleepFn;
  timeoutMs?: number;
}

const MAX_EXECUTION_CAPABILITY_BODY_BYTES = 64 * 1024;
const MAX_CAPABILITY_ITEMS = 128;
const MAX_MODEL_ITEMS = 256;
const MAX_SAFE_VALUE_LENGTH = 160;
const SAFE_CAPABILITY_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]*$/;

function executionCapabilityFailure(
  provider: Provider,
  kind: BridgeCapabilitiesFailureKind,
  detail: string,
  status?: number,
): BridgeExecutionCapabilityResult {
  return {
    ok: false,
    provider,
    failure: { kind, detail, ...(status !== undefined ? { status } : {}) },
  };
}

function isSafeValue(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SAFE_VALUE_LENGTH &&
    SAFE_CAPABILITY_VALUE.test(value);
}

function normalizeSafeArray(value: unknown, maximumItems: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems || !value.every(isSafeValue)) {
    return null;
  }
  return [...new Set(value)].sort();
}

function extractProviderCapabilities(body: Record<string, unknown>, provider: Provider): readonly string[] | null {
  const capabilities = body["capabilities"];
  if (!isRecord(capabilities)) {
    return null;
  }
  return normalizeSafeArray(capabilities[provider], MAX_CAPABILITY_ITEMS);
}

function parseStructuredExecutionCapability(
  body: Record<string, unknown>,
  provider: Provider,
  capabilities: readonly string[],
  observedAt: number,
): ExecutionCapabilitySnapshot | "legacy" | null {
  const nestedAdvertisement = body["executionCapability"];
  const hasTopLevelAdvertisement =
    body["schemaVersion"] !== undefined ||
    body["runtime"] !== undefined ||
    body["modelCatalog"] !== undefined ||
    body["delivery"] !== undefined;
  if (nestedAdvertisement === undefined && !hasTopLevelAdvertisement) {
    return "legacy";
  }
  const advertised = nestedAdvertisement ?? body;
  if (!isRecord(advertised) ||
      advertised["schemaVersion"] !== "execution-capability.v1" ||
      advertised["provider"] !== provider ||
      advertised["transport"] !== "bridge") {
    return null;
  }
  const runtime = advertised["runtime"];
  const modelCatalog = advertised["modelCatalog"];
  const delivery = advertised["delivery"];
  if (!isRecord(runtime) || !isSafeValue(runtime["name"]) ||
      (runtime["version"] !== null && !isSafeValue(runtime["version"])) ||
      runtime["source"] !== "advertised" || !isRecord(modelCatalog) || !isRecord(delivery)) {
    return null;
  }
  if ((delivery["model"] !== "native" && delivery["model"] !== "none" && delivery["model"] !== "unknown") ||
      (delivery["effort"] !== "native" && delivery["effort"] !== "none" && delivery["effort"] !== "unknown") ||
      (delivery["speed"] !== undefined && delivery["speed"] !== "native" &&
        delivery["speed"] !== "none" && delivery["speed"] !== "unknown")) {
    return null;
  }

  let normalizedCatalog: ExecutionCapabilitySnapshot["modelCatalog"];
  if (modelCatalog["knowledge"] === "known") {
    const models = normalizeSafeArray(modelCatalog["models"], MAX_MODEL_ITEMS);
    if (models === null || modelCatalog["source"] !== "advertised") {
      return null;
    }
    normalizedCatalog = { knowledge: "known", models, source: "advertised" };
  } else if (modelCatalog["knowledge"] === "unknown") {
    normalizedCatalog = { knowledge: "unknown", detail: "model catalog not advertised" };
  } else {
    return null;
  }

  return {
    schemaVersion: "execution-capability.v1",
    provider,
    transport: "bridge",
    runtime: {
      name: runtime["name"],
      version: runtime["version"] as string | null,
      source: "advertised",
    },
    capabilities,
    modelCatalog: normalizedCatalog,
    delivery: {
      model: delivery["model"],
      effort: delivery["effort"],
      // v1 の旧広告には speed が無い。欠落を非対応へ丸めず unknown として保持する（contract §67）。
      speed: delivery["speed"] ?? "unknown",
    },
    observedAt,
  };
}

function bridgeCapabilitiesFailure(
  kind: BridgeCapabilitiesFailureKind,
  detail: string,
  status?: number,
): BridgeCapabilitiesResult {
  return {
    ok: false,
    provider: "codex",
    failure: {
      kind,
      detail,
      ...(status !== undefined ? { status } : {}),
    },
  };
}

function extractCodexCapabilities(body: unknown): readonly string[] | null {
  if (!isRecord(body)) {
    return null;
  }
  const capabilities = body["capabilities"];
  if (!isRecord(capabilities)) {
    return null;
  }
  const codex = capabilities["codex"];
  if (!Array.isArray(codex) || !codex.every((item): item is string => typeof item === "string")) {
    return null;
  }
  return codex;
}

/**
 * bridge model/effort passthrough capability probe（contract §49.4）。
 * 取得失敗・non-2xx・異形 body は capability 不明として ok:false を返し、200 かつ空配列は
 * 「広告なし」として ok:true/capabilities=[] で返す。
 */
export async function probeBridgeCapabilities(bridge: BridgeConfig): Promise<BridgeCapabilitiesResult> {
  let response: Response;
  try {
    response = await bridgeFetch(bridge, "/api/info?provider=codex", { method: "GET" });
  } catch (error) {
    if (error instanceof BridgeError) {
      return bridgeCapabilitiesFailure(
        error.kind === "auth" ? "auth" : error.kind,
        errorDetail(error),
        error.status ?? undefined,
      );
    }
    return bridgeCapabilitiesFailure("network", errorDetail(error));
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return bridgeCapabilitiesFailure("invalid-json", "JSON parse failed");
  }

  const capabilities = extractCodexCapabilities(body);
  if (capabilities === null) {
    return bridgeCapabilitiesFailure("invalid-body", "capabilities.codex array missing");
  }
  return { ok: true, provider: "codex", capabilities };
}

/** contract §59 の認証済み bridge execution capability probe。 */
export async function probeBridgeExecutionCapabilities(
  bridge: BridgeConfig,
  provider: Provider,
  deps: BridgeExecutionCapabilityDeps = {},
): Promise<BridgeExecutionCapabilityResult> {
  const observedAt = (deps.now ?? Date.now)();
  let response: Response;
  try {
    response = await bridgeFetch(
      bridge,
      `/api/info?provider=${provider}`,
      { method: "GET", timeoutMs: deps.timeoutMs ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS },
      { ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}) },
    );
  } catch (error) {
    if (error instanceof BridgeError) {
      return executionCapabilityFailure(
        provider,
        error.kind === "auth" ? "auth" : error.kind,
        errorDetail(error),
        error.status ?? undefined,
      );
    }
    return executionCapabilityFailure(provider, "network", errorDetail(error));
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_EXECUTION_CAPABILITY_BODY_BYTES) {
    return executionCapabilityFailure(provider, "invalid-body", "response body exceeds size limit");
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return executionCapabilityFailure(provider, "network", "response body read failed");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_EXECUTION_CAPABILITY_BODY_BYTES) {
    return executionCapabilityFailure(provider, "invalid-body", "response body exceeds size limit");
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return executionCapabilityFailure(provider, "invalid-json", "JSON parse failed");
  }
  if (!isRecord(body)) {
    return executionCapabilityFailure(provider, "invalid-body", "capability response must be an object");
  }
  const capabilities = extractProviderCapabilities(body, provider);
  if (capabilities === null) {
    return executionCapabilityFailure(provider, "invalid-body", `capabilities.${provider} array is invalid`);
  }
  const parsed = parseStructuredExecutionCapability(body, provider, capabilities, observedAt);
  if (parsed === null) {
    return executionCapabilityFailure(provider, "invalid-body", "execution capability advertisement is invalid");
  }
  if (parsed === "legacy") {
    return {
      ok: true,
      provider,
      snapshot: {
        schemaVersion: "execution-capability.v1",
        provider,
        transport: "bridge",
        runtime: { name: "bridge-runtime", version: null, source: "unknown" },
        capabilities,
        modelCatalog: { knowledge: "unknown", detail: "model catalog not advertised" },
        delivery: { model: "unknown", effort: "unknown", speed: "unknown" },
        observedAt,
      },
    };
  }
  return { ok: true, provider, snapshot: parsed };
}
