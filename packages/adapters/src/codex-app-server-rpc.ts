// Codex App Server の Unix domain socket JSON-RPC transport。
// App Server の provider-specific object は上位 adapter に残し、この層は framing、相関、
// timeout、再接続、JSON-RPC error の境界だけを担当する。
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createConnection, type Socket } from "node:net";
import type { NativeCommunicationSocketSnapshot } from "@hachi/core";
import type { CodexAppServerMethod } from "./schema/codex-app-server-v2.js";
import {
  CODEX_APP_SERVER_CLI_VERSION,
  CODEX_APP_SERVER_SCHEMA_CHECKSUM,
  CODEX_APP_SERVER_SCHEMA_VERSION,
} from "./schema/codex-app-server-v2.js";

export type CodexAppServerRequestId = string | number;

export interface CodexAppServerNotification {
  method: string;
  params?: unknown;
}

export type CodexAppServerErrorKind =
  | "connection"
  | "timeout"
  | "rpc"
  | "protocol"
  | "schema-drift"
  | "turn-mismatch"
  | "endpoint";

export type CodexAppServerSupervisorErrorCode =
  | "codex_app_server_connection"
  | "codex_app_server_timeout"
  | "codex_app_server_rpc"
  | "codex_app_server_protocol"
  | "codex_app_server_schema_drift"
  | "codex_app_server_turn_mismatch"
  | "codex_app_server_endpoint"
  | "codex_app_server_unknown";

/**
 * Unix socket の path と stat を一つの観測値へ固定する。
 * provider が返す peer identity ではなく、Hachi が観測できるローカル endpoint の証拠。
 */
export type CodexAppServerSocketSnapshot = NativeCommunicationSocketSnapshot;

export const CODEX_APP_SERVER_MAX_SUPERVISOR_ERROR_DETAIL = 96;

const PRIVATE_MODE_MASK = 0o077;

function supervisorErrorCode(kind: CodexAppServerErrorKind): CodexAppServerSupervisorErrorCode {
  switch (kind) {
    case "connection":
      return "codex_app_server_connection";
    case "timeout":
      return "codex_app_server_timeout";
    case "rpc":
      return "codex_app_server_rpc";
    case "protocol":
      return "codex_app_server_protocol";
    case "schema-drift":
      return "codex_app_server_schema_drift";
    case "turn-mismatch":
      return "codex_app_server_turn_mismatch";
    case "endpoint":
      return "codex_app_server_endpoint";
    default:
      return "codex_app_server_unknown";
  }
}

function boundedSupervisorErrorCode(
  kind: CodexAppServerErrorKind,
  code: number | undefined,
): string {
  const base = supervisorErrorCode(kind);
  // JSON-RPC codes are integers, but keep the exposed suffix bounded even when a
  // malformed provider response reaches this boundary.
  if (kind !== "rpc" || code === undefined || !Number.isInteger(code)) {
    return base;
  }
  return `${base}:${String(code).slice(0, 16)}`.slice(0, CODEX_APP_SERVER_MAX_SUPERVISOR_ERROR_DETAIL);
}

/** Supervisor へ返す detail。provider の message/path/credential はここへ出さない。 */
export function codexAppServerSupervisorDetail(error: unknown): string {
  if (error instanceof CodexAppServerError) {
    return boundedSupervisorErrorCode(error.kind, error.code);
  }
  return "codex_app_server_unknown";
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new CodexAppServerError("Unix socket owner identity is unavailable", "endpoint");
  }
  return process.getuid();
}

function statMode(stats: Stats): number {
  return stats.mode & 0o777;
}

function endpointError(message: string): CodexAppServerError {
  return new CodexAppServerError(message, "endpoint");
}

function secureParent(
  socketPath: string,
): { canonicalPath: string; parentCanonicalPath: string; parentStats: Stats; ownerUid: number } {
  const normalizedPath = resolve(socketPath);
  if (socketPath !== normalizedPath) {
    throw endpointError("App Server socket path is not canonical");
  }
  const parentPath = dirname(normalizedPath);
  let parentCanonicalPath: string;
  let parentStats: Stats;
  try {
    parentCanonicalPath = realpathSync.native(parentPath);
    parentStats = lstatSync(parentCanonicalPath);
  } catch {
    throw endpointError("App Server socket parent is unavailable");
  }
  const ownerUid = currentUid();
  if (!parentStats.isDirectory() || parentCanonicalPath !== parentPath) {
    throw endpointError("App Server socket parent is not canonical");
  }
  if (parentStats.uid !== ownerUid || (statMode(parentStats) & PRIVATE_MODE_MASK) !== 0) {
    throw endpointError("App Server socket parent is not Hachi-private");
  }
  return {
    canonicalPath: join(parentCanonicalPath, basename(normalizedPath)),
    parentCanonicalPath,
    parentStats,
    ownerUid,
  };
}

function socketSnapshot(socketPath: string): CodexAppServerSocketSnapshot {
  const parent = secureParent(socketPath);
  let stats: Stats;
  try {
    stats = lstatSync(socketPath);
  } catch {
    throw endpointError("App Server socket is unavailable");
  }
  if (!stats.isSocket() || stats.uid !== parent.ownerUid || (statMode(stats) & PRIVATE_MODE_MASK) !== 0) {
    throw endpointError("App Server socket is not Hachi-private");
  }
  if (parent.canonicalPath !== socketPath) {
    throw endpointError("App Server socket path is not canonical");
  }
  return {
    canonicalPath: parent.canonicalPath,
    parentCanonicalPath: parent.parentCanonicalPath,
    parentDev: parent.parentStats.dev,
    parentIno: parent.parentStats.ino,
    parentUid: parent.parentStats.uid,
    parentMode: statMode(parent.parentStats),
    dev: stats.dev,
    ino: stats.ino,
    uid: stats.uid,
    gid: stats.gid,
    mode: statMode(stats),
  };
}

function sameSocketSnapshot(
  left: CodexAppServerSocketSnapshot,
  right: CodexAppServerSocketSnapshot,
): boolean {
  return left.canonicalPath === right.canonicalPath &&
    left.parentCanonicalPath === right.parentCanonicalPath &&
    left.parentDev === right.parentDev &&
    left.parentIno === right.parentIno &&
    left.parentUid === right.parentUid &&
    left.parentMode === right.parentMode &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode;
}

/** snapshot が durable binding と同じ endpoint identity を表すか確認する。 */
export function codexAppServerSocketSnapshotsEqual(
  left: CodexAppServerSocketSnapshot,
  right: CodexAppServerSocketSnapshot,
): boolean {
  return sameSocketSnapshot(left, right);
}

function assertSocketSnapshot(
  socketPath: string,
  expected: CodexAppServerSocketSnapshot | undefined,
): CodexAppServerSocketSnapshot {
  const current = socketSnapshot(socketPath);
  if (expected !== undefined && !sameSocketSnapshot(current, expected)) {
    throw endpointError("App Server socket endpoint was replaced");
  }
  return current;
}

export class CodexAppServerError extends Error {
  readonly kind: CodexAppServerErrorKind;
  readonly method: string | undefined;
  readonly code: number | undefined;
  readonly supervisorCode: CodexAppServerSupervisorErrorCode;

  constructor(
    _message: string,
    kind: CodexAppServerErrorKind,
    details: { method?: string; code?: number } = {},
  ) {
    // Keep local diagnostics useful, but bound them. Provider-controlled RPC
    // text is never exposed even if a future call site passes it as `_message`;
    // supervisor-facing detail uses the fixed `supervisorCode` below instead.
    const localMessage = kind === "rpc" ? "App Server RPC returned an error" : _message;
    super(localMessage.slice(0, CODEX_APP_SERVER_MAX_SUPERVISOR_ERROR_DETAIL));
    this.name = "CodexAppServerError";
    this.kind = kind;
    this.method = details.method;
    this.code = details.code;
    this.supervisorCode = supervisorErrorCode(kind);
  }
}

export interface CodexAppServerClientInfo {
  name: string;
  version: string;
}

export interface CodexAppServerRpcClientOptions {
  socketPath: string;
  /** launch 時に観測した endpoint snapshot。再接続で同一 socket を要求する。 */
  socketSnapshot?: CodexAppServerSocketSnapshot;
  /** 各 request の上限。副作用があり得る呼び出しも必ず有限時間で終える。 */
  timeoutMs?: number;
  /** connect の一回あたりの上限。 */
  connectTimeoutMs?: number;
  /** App Server 起動直後の Unix socket ready 待機回数。 */
  reconnectAttempts?: number;
  /** 再接続間隔。テストでは短縮できる。 */
  reconnectDelayMs?: number;
  clientInfo?: CodexAppServerClientInfo;
  expectedRuntimeVersion?: string;
  expectedSchemaVersion?: string;
  expectedSchemaChecksum?: string;
  onNotification?: (notification: CodexAppServerNotification) => void;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: CodexAppServerRequestId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: CodexAppServerRequestId | null;
  result?: unknown;
  error?: JsonRpcErrorPayload;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RecordValue {
  [key: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_DELAY_MS = 50;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

function isRequestId(value: unknown): value is CodexAppServerRequestId {
  return (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value));
}

function requestIdKey(value: CodexAppServerRequestId): string {
  return `${typeof value}:${String(value)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJsonRpcErrorPayload(value: unknown): value is JsonRpcErrorPayload {
  return isRecord(value) && typeof value.code === "number" && Number.isInteger(value.code) && typeof value.message === "string";
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!isRecord(value) || !("id" in value)) {
    return false;
  }
  const id = value.id;
  if (id !== null && !isRequestId(id)) {
    return false;
  }
  if ("error" in value) {
    return isJsonRpcErrorPayload(value.error);
  }
  return "result" in value;
}

function isJsonRpcServerRequest(value: unknown): value is JsonRpcRequest {
  return (
    isRecord(value) &&
    isRequestId(value.id) &&
    typeof value.method === "string" &&
    value.method.length > 0
  );
}

function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  return isRecord(value) && typeof value.method === "string" && !isRequestId(value.id);
}

function parseRuntimeVersion(userAgent: string): string | undefined {
  const match = userAgent.match(/(?:codex(?:-cli)?|app-server)[\s\/-]+v?(\d+\.\d+\.\d+)/i);
  if (match?.[1] !== undefined) {
    return match[1];
  }
  const bare = userAgent.match(/^(\d+\.\d+\.\d+)$/);
  return bare?.[1];
}

/** JSON-RPC response を検証した後の初期化情報。 */
export interface CodexAppServerInitializeInfo {
  runtimeVersion: string;
  userAgent: string;
  schemaVersion: string;
  schemaChecksum: string;
}

export class CodexAppServerRpcClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly reconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private readonly clientInfo: CodexAppServerClientInfo;
  private readonly expectedRuntimeVersion: string | undefined;
  private readonly expectedSchemaVersion: string;
  private readonly expectedSchemaChecksum: string;
  private readonly initialSocketSnapshot: CodexAppServerSocketSnapshot | undefined;
  private readonly onNotification: ((notification: CodexAppServerNotification) => void) | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 1;
  private socket: Socket | undefined;
  private connectPromise: Promise<void> | undefined;
  private receiveBuffer = "";
  private initializedState = false;
  private initializeInfoState: CodexAppServerInitializeInfo | undefined;
  private socketSnapshotState: CodexAppServerSocketSnapshot | undefined;
  private disposed = false;

  constructor(options: CodexAppServerRpcClientOptions) {
    if (options.socketPath.length === 0 || !options.socketPath.startsWith("/")) {
      throw new CodexAppServerError("App Server socketPath は絶対パスが必要です", "protocol");
    }
    this.socketPath = options.socketPath;
    this.initialSocketSnapshot = options.socketSnapshot;
    this.timeoutMs = positiveFinite(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.connectTimeoutMs = positiveFinite(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, "connectTimeoutMs");
    this.reconnectAttempts = nonNegativeInteger(options.reconnectAttempts, DEFAULT_RECONNECT_ATTEMPTS, "reconnectAttempts");
    this.reconnectDelayMs = nonNegativeFinite(options.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS, "reconnectDelayMs");
    this.clientInfo = options.clientInfo ?? { name: "hachi-kanban", version: "0.1.0" };
    this.expectedRuntimeVersion = options.expectedRuntimeVersion ?? CODEX_APP_SERVER_CLI_VERSION;
    this.expectedSchemaVersion = options.expectedSchemaVersion ?? CODEX_APP_SERVER_SCHEMA_VERSION;
    this.expectedSchemaChecksum = options.expectedSchemaChecksum ?? CODEX_APP_SERVER_SCHEMA_CHECKSUM;
    this.onNotification = options.onNotification;
  }

  get path(): string {
    return this.socketPath;
  }

  get socketSnapshot(): CodexAppServerSocketSnapshot | undefined {
    return this.socketSnapshotState ?? this.initialSocketSnapshot;
  }

  get initialized(): boolean {
    return this.initializedState;
  }

  get runtimeVersion(): string | undefined {
    return this.initializeInfoState?.runtimeVersion;
  }

  get initializeInfo(): CodexAppServerInitializeInfo | undefined {
    return this.initializeInfoState;
  }

  async connect(): Promise<void> {
    if (this.disposed) {
      throw new CodexAppServerError("App Server client は dispose 済みです", "connection");
    }
    if (this.socket !== undefined && !this.socket.destroyed) {
      return;
    }
    if (this.connectPromise !== undefined) {
      return this.connectPromise;
    }
    this.connectPromise = this.openWithRetry().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async openWithRetry(): Promise<void> {
    let lastError: unknown = new Error("socket connection failed");
    for (let attempt = 0; attempt <= this.reconnectAttempts; attempt += 1) {
      try {
        await this.openOnce();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.reconnectAttempts) {
          await sleep(this.reconnectDelayMs);
        }
      }
    }
    if (lastError instanceof CodexAppServerError && lastError.kind === "endpoint") {
      throw lastError;
    }
    throw new CodexAppServerError("App Server socket connection failed", "connection");
  }

  private async openOnce(): Promise<void> {
    const candidateSnapshot = assertSocketSnapshot(this.socketPath, this.socketSnapshotState ?? this.initialSocketSnapshot);
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    this.receiveBuffer = "";
    this.attachSocketHandlers(socket);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        reject(new CodexAppServerError("App Server socket connect が timeout しました", "timeout"));
      }, this.connectTimeoutMs);

      const succeed = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          const connectedSnapshot = assertSocketSnapshot(this.socketPath, candidateSnapshot);
          this.socketSnapshotState = connectedSnapshot;
        } catch (error) {
          socket.destroy();
          reject(error);
          return;
        }
        resolve();
      };
      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        void error;
        reject(new CodexAppServerError("App Server socket connect failed", "connection"));
      };

      socket.once("connect", succeed);
      socket.once("error", fail);
    }).catch((error: unknown) => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      throw error;
    });
  }

  private attachSocketHandlers(socket: Socket): void {
    socket.on("data", (chunk: Buffer) => {
      this.receiveBuffer += chunk.toString("utf8");
      if (Buffer.byteLength(this.receiveBuffer, "utf8") > MAX_FRAME_BYTES) {
        this.failConnection(new CodexAppServerError("App Server JSON-RPC frame が大きすぎます", "protocol"), socket);
        return;
      }
      for (;;) {
        const newline = this.receiveBuffer.indexOf("\n");
        if (newline < 0) {
          return;
        }
        const line = this.receiveBuffer.slice(0, newline).replace(/\r$/, "");
        this.receiveBuffer = this.receiveBuffer.slice(newline + 1);
        if (line.trim() === "") {
          continue;
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(line) as unknown;
        } catch (error) {
          this.failConnection(
            new CodexAppServerError(`App Server JSON-RPC JSON が不正です: ${errorMessage(error)}`, "protocol"),
            socket,
          );
          return;
        }
        this.handleMessage(decoded, socket);
      }
    });
    socket.on("error", (error: Error) => {
      void error;
      this.failConnection(new CodexAppServerError("App Server socket error", "connection"), socket);
    });
    socket.on("close", () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      this.initializedState = false;
      this.initializeInfoState = undefined;
      this.rejectPending(new CodexAppServerError("App Server socket が切断されました", "connection"));
    });
  }

  private failConnection(error: CodexAppServerError, socket: Socket): void {
    this.rejectPending(error);
    if (this.socket === socket && !socket.destroyed) {
      socket.destroy();
    }
  }

  private rejectPending(error: Error): void {
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(key);
      pending.reject(error);
    }
  }

  private handleMessage(value: unknown, socket: Socket): void {
    if (isJsonRpcResponse(value)) {
      if (value.id === null) {
        return;
      }
      const pending = this.pending.get(requestIdKey(value.id));
      if (pending === undefined) {
        // 古い接続から遅れてきた response は他の request を解決してはならない。
        return;
      }
      this.pending.delete(requestIdKey(value.id));
      clearTimeout(pending.timer);
      if (value.error !== undefined) {
        const errorKind: CodexAppServerErrorKind =
          value.error.code === -32601
            ? "schema-drift"
            : value.error.code === -32602 || value.error.message.toLowerCase().includes("expectedturnid")
              ? "turn-mismatch"
              : "rpc";
        pending.reject(
          new CodexAppServerError(
            "App Server RPC returned an error",
            errorKind,
            { method: pending.method, code: value.error.code },
          ),
        );
        return;
      }
      pending.resolve(value.result);
      return;
    }

    if (isJsonRpcNotification(value)) {
      this.onNotification?.({
        method: value.method,
        ...(value.params !== undefined ? { params: value.params } : {}),
      });
      return;
    }

    if (isJsonRpcServerRequest(value)) {
      // approval/elicitation 等 provider request はこの bounded adapter の責務外。
      // 返答をしないと server 側 turn が無期限待ちになるため、明示的な not-supported を返す。
      try {
        this.socketSnapshotState = assertSocketSnapshot(
          this.socketPath,
          this.socketSnapshotState ?? this.initialSocketSnapshot,
        );
        this.writeFrame(
          {
            jsonrpc: "2.0",
            id: value.id,
            error: { code: -32601, message: "Unsupported server request" },
          },
          socket,
        );
      } catch (error) {
        this.failConnection(
          error instanceof CodexAppServerError ? error : new CodexAppServerError("endpoint check failed", "endpoint"),
          socket,
        );
      }
      return;
    }

    this.failConnection(new CodexAppServerError("App Server JSON-RPC message の形状が不正です", "protocol"), socket);
  }

  async request<T>(method: string, params?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    if (method.length === 0) {
      throw new CodexAppServerError("JSON-RPC method は空にできません", "protocol");
    }
    const boundedTimeout = positiveFinite(timeoutMs, this.timeoutMs, "timeoutMs");
    await this.connect();
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) {
      throw new CodexAppServerError("App Server socket が接続されていません", "connection", { method });
    }
    try {
      this.socketSnapshotState = assertSocketSnapshot(
        this.socketPath,
        this.socketSnapshotState ?? this.initialSocketSnapshot,
      );
    } catch (error) {
      this.failConnection(error instanceof CodexAppServerError ? error : new CodexAppServerError("endpoint check failed", "endpoint"), socket);
      throw error;
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const key = requestIdKey(id);
    const frame: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new CodexAppServerError(`App Server RPC ${method} が timeout しました`, "timeout", { method }));
      }, boundedTimeout);
      this.pending.set(key, {
        method,
        timer,
        resolve: (value: unknown) => resolve(value as T),
        reject,
      });
      try {
        this.writeFrame(frame, socket);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (method.length === 0) {
      throw new CodexAppServerError("JSON-RPC notification method は空にできません", "protocol");
    }
    await this.connect();
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) {
      throw new CodexAppServerError("App Server socket が接続されていません", "connection", { method });
    }
    try {
      this.socketSnapshotState = assertSocketSnapshot(
        this.socketPath,
        this.socketSnapshotState ?? this.initialSocketSnapshot,
      );
    } catch (error) {
      this.failConnection(error instanceof CodexAppServerError ? error : new CodexAppServerError("endpoint check failed", "endpoint"), socket);
      throw error;
    }
    this.writeFrame({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    }, socket);
  }

  private writeFrame(frame: JsonRpcRequest | JsonRpcNotification | RecordValue, socket: Socket): void {
    const text = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
      throw new CodexAppServerError("App Server JSON-RPC request が大きすぎます", "protocol");
    }
    socket.write(text);
  }

  /** initialize + initialized notification。再接続後は再び handshake を行う。 */
  async initialize(): Promise<CodexAppServerInitializeInfo> {
    if (this.initializedState && this.initializeInfoState !== undefined) {
      return this.initializeInfoState;
    }
    const result = await this.request<unknown>("initialize", {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: false },
    });
    const record = requireRecord(result, "initialize response");
    for (const field of ["codexHome", "platformFamily", "platformOs"]) {
      if (typeof record[field] !== "string" || record[field] === "") {
        throw new CodexAppServerError(`initialize.${field} が欠落しています`, "schema-drift", {
          method: "initialize",
        });
      }
    }
    const userAgent = requireString(record.userAgent, "initialize.userAgent");
    const runtimeVersion = parseRuntimeVersion(userAgent);
    if (runtimeVersion === undefined) {
      throw new CodexAppServerError("App Server userAgent version is invalid", "schema-drift", {
        method: "initialize",
      });
    }
    if (this.expectedRuntimeVersion !== undefined && runtimeVersion !== this.expectedRuntimeVersion) {
      throw new CodexAppServerError(
        `App Server runtime version mismatch: expected ${this.expectedRuntimeVersion}, got ${runtimeVersion}`,
        "schema-drift",
        { method: "initialize" },
      );
    }
    const reportedSchemaVersion = optionalString(record.schemaVersion);
    if (reportedSchemaVersion !== undefined && reportedSchemaVersion !== this.expectedSchemaVersion) {
      throw new CodexAppServerError(
        `App Server schema version mismatch: expected ${this.expectedSchemaVersion}, got ${reportedSchemaVersion}`,
        "schema-drift",
        { method: "initialize" },
      );
    }
    const reportedSchemaChecksum = optionalString(record.schemaChecksum);
    if (reportedSchemaChecksum !== undefined && reportedSchemaChecksum !== this.expectedSchemaChecksum) {
      throw new CodexAppServerError(
        "App Server generated schema checksum mismatch",
        "schema-drift",
        { method: "initialize" },
      );
    }
    await this.notify("initialized");
    const info: CodexAppServerInitializeInfo = {
      runtimeVersion,
      userAgent,
      schemaVersion: this.expectedSchemaVersion,
      schemaChecksum: this.expectedSchemaChecksum,
    };
    this.initializeInfoState = info;
    this.initializedState = true;
    return info;
  }

  /** 再接続を明示的に行う。次の request は initialize を再実行できる。 */
  async reconnect(): Promise<void> {
    this.close();
    await this.connect();
  }

  /** socket だけ閉じる。後続 request は再接続できる。 */
  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.initializedState = false;
    this.initializeInfoState = undefined;
    this.rejectPending(new CodexAppServerError("App Server socket を閉じました", "connection"));
    socket?.destroy();
  }

  /** adapter dispose 用の不可逆な close。 */
  dispose(): void {
    this.disposed = true;
    this.close();
  }
}

function requireRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) {
    throw new CodexAppServerError(`${label} が object ではありません`, "schema-drift");
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexAppServerError(`${label} が string ではありません`, "schema-drift");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function positiveFinite(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new CodexAppServerError(`${label} は正の有限値が必要です`, "protocol");
  }
  return value;
}

function nonNegativeFinite(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new CodexAppServerError(`${label} は0以上の有限値が必要です`, "protocol");
  }
  return value;
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new CodexAppServerError(`${label} は0以上の整数が必要です`, "protocol");
  }
  return value;
}

/** Keep the method import in the public module graph for generated-schema consumers. */
export type { CodexAppServerMethod };

/** 呼び出し側の短い名前。wire behavior は RpcClient と同一。 */
export const CodexAppServerClient = CodexAppServerRpcClient;
