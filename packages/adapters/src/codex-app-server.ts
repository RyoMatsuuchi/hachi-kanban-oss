// Hachi-owned Codex App Server durable worker と同一 provider native delivery。
// board/run/session/fence の lifecycle は supervisor/core が所有し、この adapter は
// provider の top-level thread に対する bounded wire operation だけを公開する。
import { mkdirSync, mkdtempSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type {
  EffortDelivery,
  LaunchOptions,
  NativeCommunicationAdapter,
  NativeCommunicationDeliveryRequest,
  NativeCommunicationDeliveryResult,
  NativeCommunicationProbeResult,
  NativeCommunicationSocketSnapshot,
  NativeCommunicationSessionRef,
  SessionRef,
  SessionState,
  SessionStatus,
  SpeedDelivery,
  StopResult,
  TaskRow,
  WorkerAdapter,
  WorkerStopCapabilities,
} from "@hachi/core";
import {
  CODEX_APP_SERVER_CLI_VERSION,
  CODEX_APP_SERVER_SCHEMA_CHECKSUM,
} from "./schema/codex-app-server-v2.js";
import {
  CodexAppServerError,
  CodexAppServerRpcClient,
  codexAppServerSocketSnapshotsEqual,
  codexAppServerSupervisorDetail,
  type CodexAppServerClientInfo,
  type CodexAppServerInitializeInfo,
  type CodexAppServerRpcClientOptions,
  type CodexAppServerSocketSnapshot,
} from "./codex-app-server-rpc.js";

interface UnknownRecord {
  [key: string]: unknown;
}

interface CodexThread {
  readonly id: string;
  readonly sessionId: string;
  readonly status: UnknownRecord;
  readonly turns: readonly UnknownRecord[];
  readonly raw: UnknownRecord;
}

interface CodexTurn {
  readonly id: string;
  readonly items: readonly UnknownRecord[];
  readonly status: string;
  readonly raw: UnknownRecord;
}

interface NativeSessionState {
  readonly client: CodexAppServerRpcClient;
  readonly socketPath: string;
  readonly threadId: string;
  readonly providerSessionId: string;
  ref: SessionRef;
  activeTurnId: string;
  runtimeVersion: string;
  seenMessageKeys: Set<string>;
  observedMessageKeys: Set<string>;
}

type SpawnProcess = (file: string, args: string[], options: SpawnOptions) => ChildProcess;
type ClientFactory = (
  options: CodexAppServerRpcClientOptions,
  stateKey: string,
) => CodexAppServerRpcClient;

export interface CodexAppServerAdapterOptions {
  /** App Server が bind する絶対 Unix socket path。省略時は専用 tmp dir に生成する。 */
  socketPath?: string;
  /** socketPath を省略したときの親ディレクトリ。 */
  socketDir?: string;
  /** `codex` 実行ファイル（既定 PATH の codex）。 */
  codexBin?: string;
  /** false のとき、既存 fake server へ接続するだけで process は起動しない。 */
  autoStart?: boolean;
  /** launch 時の process/socket 待機上限。 */
  serverStartTimeoutMs?: number;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  reconnectAttempts?: number;
  reconnectDelayMs?: number;
  expectedRuntimeVersion?: string;
  expectedSchemaVersion?: string;
  expectedSchemaChecksum?: string;
  /** durable binding から再構築した socket identity。path と併せて要求する。 */
  expectedSocketSnapshot?: CodexAppServerSocketSnapshot;
  clientInfo?: CodexAppServerClientInfo;
  /** 同じ steer の thread/read 観測を transport accepted 後に一度行う。 */
  observeAfterSteer?: boolean;
  /** SessionRef evidence の host identity。省略時は os.hostname()。 */
  hostId?: string;
  /** SessionRef evidence の有効秒数（有限値）。 */
  bindingTtlSeconds?: number;
  now?: () => number;
  /** fake Unix server 用。指定時は codex process を起動せずこの factory を使う。 */
  clientFactory?: ClientFactory;
  /** process spawn の差し替え。実装時既定は node:child_process spawn。 */
  spawnProcess?: SpawnProcess;
}

export interface CodexAppServerThreadReadResult {
  thread: UnknownRecord;
  status: SessionState;
  activeTurnId: string | null;
}

const DEFAULT_SERVER_START_TIMEOUT_MS = 8_000;
const DEFAULT_BINDING_TTL_SECONDS = 300;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new CodexAppServerError(`${label} が object ではありません`, "schema-drift");
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexAppServerError(`${label} が空でない string ではありません`, "schema-drift");
  }
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new CodexAppServerError(`${label} が array ではありません`, "schema-drift");
  }
  return value;
}

function parseTurn(value: unknown, label: string): CodexTurn {
  const raw = requireRecord(value, label);
  const id = requireString(raw.id, `${label}.id`);
  const items = requireArray(raw.items, `${label}.items`).map((item, index) =>
    requireRecord(item, `${label}.items[${index}]`),
  );
  const status = requireString(raw.status, `${label}.status`);
  return { id, items, status, raw };
}

function parseThread(value: unknown, label: string): CodexThread {
  const raw = requireRecord(value, label);
  const id = requireString(raw.id, `${label}.id`);
  const sessionId = requireString(raw.sessionId, `${label}.sessionId`);
  const status = requireRecord(raw.status, `${label}.status`);
  const turns = requireArray(raw.turns, `${label}.turns`).map((turn, index) =>
    requireRecord(turn, `${label}.turns[${index}]`),
  );
  // These fields are required by the generated v2 Thread schema. Keep checking them so a
  // newer incompatible server cannot be mistaken for a compatible one.
  if (typeof raw.cliVersion !== "string" || typeof raw.createdAt !== "number" || typeof raw.cwd !== "string" ||
      typeof raw.ephemeral !== "boolean" || typeof raw.modelProvider !== "string" || typeof raw.preview !== "string" ||
      typeof raw.updatedAt !== "number" || !("source" in raw)) {
    throw new CodexAppServerError(`${label} の generated v2 Thread required field が不正です`, "schema-drift");
  }
  return { id, sessionId, status, turns, raw };
}

function parseInitializeThread(result: unknown): CodexThread {
  const record = requireRecord(result, "thread/start response");
  return parseThread(record.thread, "thread/start.thread");
}

function parseStartTurn(result: unknown): CodexTurn {
  const record = requireRecord(result, "turn/start response");
  return parseTurn(record.turn, "turn/start.turn");
}

function parseSteerTurnId(result: unknown): string {
  const record = requireRecord(result, "turn/steer response");
  return requireString(record.turnId, "turn/steer.turnId");
}

function statusFromThread(thread: CodexThread): SessionState {
  const type = thread.status.type;
  if (type === "active") {
    return "active";
  }
  if (type === "idle") {
    return "idle";
  }
  if (type === "systemError") {
    return "unknown";
  }
  return "unknown";
}

function activeTurn(thread: CodexThread): CodexTurn | undefined {
  for (const rawTurn of thread.turns) {
    const turn = parseTurn(rawTurn, "thread.turns[]");
    if (turn.status === "inProgress") {
      return turn;
    }
  }
  return undefined;
}

function turnItems(thread: CodexThread): readonly UnknownRecord[] {
  const items: UnknownRecord[] = [];
  for (const rawTurn of thread.turns) {
    const turn = parseTurn(rawTurn, "thread.turns[]");
    items.push(...turn.items);
  }
  return items;
}

function textFromUserContent(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  const parts: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    if (entry.type === "text" && typeof entry.text === "string") {
      parts.push(entry.text);
    }
  }
  return parts.join("");
}

function transcriptForThread(thread: CodexThread): string {
  const lines: string[] = [];
  for (const item of turnItems(thread)) {
    if (item.type === "userMessage") {
      lines.push(`[user] ${textFromUserContent(item.content)}`);
    } else if (item.type === "agentMessage" && typeof item.text === "string") {
      lines.push(`[assistant] ${item.text}`);
    }
  }
  return lines.join("\n\n");
}

function toUnixUrl(socketPath: string): string {
  return `unix://${socketPath}`;
}

function socketPathFromUrl(serverUrl: string): string {
  if (!serverUrl.startsWith("unix://")) {
    throw new CodexAppServerError(`Codex App Server serverUrl が Unix socket ではありません: ${serverUrl}`, "protocol");
  }
  const path = serverUrl.slice("unix://".length);
  if (path.length === 0 || !path.startsWith("/")) {
    throw new CodexAppServerError("Codex App Server serverUrl の socket path が不正です", "protocol");
  }
  return path;
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

function nowSeconds(clock: () => number): number {
  const value = clock();
  return Number.isFinite(value) ? Math.floor(value) : Math.floor(Date.now() / 1000);
}

function isExpectedTurnMismatch(error: CodexAppServerError): boolean {
  return error.kind === "turn-mismatch" || error.code === -32602;
}

function requireSocketSnapshot(client: CodexAppServerRpcClient): NativeCommunicationSocketSnapshot {
  const snapshot = client.socketSnapshot;
  if (snapshot === undefined) {
    throw new CodexAppServerError("Codex App Server socket identity が観測されていません", "endpoint");
  }
  return snapshot;
}

function notificationContainsMessage(value: unknown, messageKey: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.clientUserMessageId === messageKey || value.clientId === messageKey || value.messageKey === messageKey) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => notificationContainsMessage(entry, messageKey));
  }
  for (const nested of Object.values(value)) {
    if (notificationContainsMessage(nested, messageKey)) {
      return true;
    }
  }
  return false;
}

function readContainsMessage(thread: CodexThread, messageKey: string): boolean {
  for (const item of turnItems(thread)) {
    if (item.clientId === messageKey || item.clientUserMessageId === messageKey || item.messageKey === messageKey) {
      return true;
    }
  }
  return false;
}

function evidenceFrom(
  thread: CodexThread,
  turnId: string,
  init: CodexAppServerInitializeInfo,
  socketSnapshot: NativeCommunicationSocketSnapshot,
  hostId: string,
  now: number,
  ttlSeconds: number,
): NativeCommunicationSessionRef {
  return {
    route: "codex-app-server",
    providerSessionId: thread.sessionId,
    threadId: thread.id,
    activeTurnId: turnId,
    socketSnapshot,
    runtimeVersion: init.runtimeVersion,
    capabilityHash: init.schemaChecksum,
    hostId,
    observedAt: now,
    expiresAt: now + ttlSeconds,
  };
}

function refWithEvidence(
  provider: "codex",
  thread: CodexThread,
  turnId: string,
  init: CodexAppServerInitializeInfo,
  socketPath: string,
  socketSnapshot: NativeCommunicationSocketSnapshot,
  model: string,
  startedAt: number,
  hostId: string,
  ttlSeconds: number,
  effort: boolean,
  speed: boolean,
): SessionRef {
  const effortDelivery: EffortDelivery | undefined = effort ? "native" : undefined;
  const speedDelivery: SpeedDelivery | undefined = speed ? "native" : undefined;
  const target = evidenceFrom(thread, turnId, init, socketSnapshot, hostId, startedAt, ttlSeconds);
  return {
    provider,
    sessionId: thread.sessionId,
    serverUrl: toUnixUrl(socketPath),
    model,
    modelDelivery: "native",
    ...(effortDelivery !== undefined ? { effortDelivery } : {}),
    ...(speedDelivery !== undefined ? { speedDelivery } : {}),
    nativeCommunication: target,
    startedAt,
  };
}

/**
 * Hachi-owned Codex App Server worker adapter。execution と native communication の両方を
 * 同じ socket/session binding から提供するが、native delivery の lifecycle は返り値だけで
 * 表現し、DB claim/fallback/ack は行わない。
 */
export class CodexAppServerAdapter implements WorkerAdapter, NativeCommunicationAdapter {
  readonly provider = "codex" as const;
  readonly route = "codex-app-server" as const;

  private readonly options: CodexAppServerAdapterOptions;
  private readonly socketPath: string;
  private readonly codexBin: string;
  private readonly autoStart: boolean;
  private readonly serverStartTimeoutMs: number;
  private readonly requestTimeoutMs: number | undefined;
  private readonly hostId: string;
  private readonly bindingTtlSeconds: number;
  private readonly now: () => number;
  private readonly observeAfterSteer: boolean;
  private readonly clientFactory: ClientFactory;
  private readonly spawnProcess: SpawnProcess;
  private readonly clients = new Map<string, CodexAppServerRpcClient>();
  private readonly sessions = new Map<string, NativeSessionState>();
  private serverProcess: ChildProcess | undefined;
  private generatedSocketDir: string | undefined;

  constructor(options: CodexAppServerAdapterOptions = {}) {
    this.options = options;
    this.codexBin = options.codexBin ?? "codex";
    this.autoStart = options.autoStart ?? true;
    this.serverStartTimeoutMs = positiveFinite(
      options.serverStartTimeoutMs,
      DEFAULT_SERVER_START_TIMEOUT_MS,
      "serverStartTimeoutMs",
    );
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.hostId = options.hostId ?? hostname();
    this.bindingTtlSeconds = positiveFinite(options.bindingTtlSeconds, DEFAULT_BINDING_TTL_SECONDS, "bindingTtlSeconds");
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.observeAfterSteer = options.observeAfterSteer ?? false;
    this.socketPath = this.resolveSocketPath(options);
    this.spawnProcess = options.spawnProcess ?? ((file, args, spawnOptions) => spawn(file, args, spawnOptions));
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new CodexAppServerRpcClient(clientOptions));
    if (options.clientFactory === undefined && options.socketPath !== undefined) {
      // default client is created lazily, after socketPath has been validated.
    }
  }

  private resolveSocketPath(options: CodexAppServerAdapterOptions): string {
    const path = options.socketPath ?? join(
      options.socketDir !== undefined
        ? (mkdirSync(options.socketDir, { recursive: true, mode: 0o700 }), options.socketDir)
        : (this.generatedSocketDir = mkdtempSync(join(tmpdir(), "hachi-codex-app-server-"))),
      "app-server.sock",
    );
    if (!path.startsWith("/") || path.length === 0) {
      throw new CodexAppServerError("Codex App Server socketPath は絶対パスが必要です", "protocol");
    }
    return path;
  }

  get appServerSocketPath(): string {
    return this.socketPath;
  }

  get pid(): number | undefined {
    return this.serverProcess?.pid;
  }

  private clientFor(
    socketPath: string,
    stateKey: string,
    expectedSocketSnapshot?: CodexAppServerSocketSnapshot,
  ): CodexAppServerRpcClient {
    const expected = expectedSocketSnapshot ?? this.options.expectedSocketSnapshot;
    const existing = this.clients.get(socketPath);
    if (existing !== undefined) {
      if (expected !== undefined) {
        const observed = existing.socketSnapshot;
        if (observed === undefined || !codexAppServerSocketSnapshotsEqual(observed, expected)) {
          throw new CodexAppServerError("Codex App Server durable socket identity が一致しません", "endpoint");
        }
      }
      return existing;
    }
    const clientHolder: { current: CodexAppServerRpcClient | undefined } = { current: undefined };
    const clientOptions: CodexAppServerRpcClientOptions = {
      socketPath,
      ...(expected === undefined ? {} : { socketSnapshot: expected }),
      ...(this.requestTimeoutMs !== undefined ? { timeoutMs: this.requestTimeoutMs } : {}),
      ...(this.options.connectTimeoutMs !== undefined ? { connectTimeoutMs: this.options.connectTimeoutMs } : {}),
      ...(this.options.reconnectAttempts !== undefined ? { reconnectAttempts: this.options.reconnectAttempts } : {}),
      ...(this.options.reconnectDelayMs !== undefined ? { reconnectDelayMs: this.options.reconnectDelayMs } : {}),
      ...(this.options.expectedRuntimeVersion !== undefined
        ? { expectedRuntimeVersion: this.options.expectedRuntimeVersion }
        : {}),
      ...(this.options.expectedSchemaVersion !== undefined ? { expectedSchemaVersion: this.options.expectedSchemaVersion } : {}),
      ...(this.options.expectedSchemaChecksum !== undefined ? { expectedSchemaChecksum: this.options.expectedSchemaChecksum } : {}),
      ...(this.options.clientInfo !== undefined ? { clientInfo: this.options.clientInfo } : {}),
      onNotification: (notification) => {
        const states = new Set(this.sessions.values());
        for (const state of states) {
          if (state.client !== clientHolder.current) {
            continue;
          }
          for (const messageKey of state.seenMessageKeys) {
            if (notificationContainsMessage(notification.params, messageKey)) {
              state.observedMessageKeys.add(messageKey);
            }
          }
        }
      },
    };
    const client = this.clientFactory(clientOptions, stateKey);
    clientHolder.current = client;
    this.clients.set(socketPath, client);
    return client;
  }

  private startServerIfNeeded(): void {
    if (!this.autoStart || this.serverProcess !== undefined || this.options.clientFactory !== undefined) {
      return;
    }
    const args = ["app-server", "--listen", toUnixUrl(this.socketPath)];
    const child = this.spawnProcess(this.codexBin, args, {
      detached: false,
      stdio: "ignore",
    });
    this.serverProcess = child;
    child.once("exit", () => {
      if (this.serverProcess === child) {
        this.serverProcess = undefined;
      }
    });
    child.once("error", () => {
      if (this.serverProcess === child) {
        this.serverProcess = undefined;
      }
    });
  }

  private async readyClient(socketPath: string, startServer: boolean, stateKey: string): Promise<CodexAppServerRpcClient> {
    if (startServer) {
      this.startServerIfNeeded();
    }
    const client = this.clientFor(socketPath, stateKey);
    // App Server processのsocket ready待機は client reconnect bounded retry に委譲する。
    // launch用に長い上限を別途持ち、無限に待たない。
    const deadline = Date.now() + this.serverStartTimeoutMs;
    for (;;) {
      try {
        await client.connect();
        return client;
      } catch (error) {
        if (!startServer || Date.now() >= deadline) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
      }
    }
  }

  private async initializedClient(
    socketPath: string,
    startServer: boolean,
    stateKey: string,
  ): Promise<{ client: CodexAppServerRpcClient; init: CodexAppServerInitializeInfo }> {
    const client = await this.readyClient(socketPath, startServer, stateKey);
    const init = await client.initialize();
    return { client, init };
  }

  async launch(task: TaskRow, options: LaunchOptions): Promise<SessionRef> {
    void task;
    const { client, init } = await this.initializedClient(this.socketPath, true, "launch");
    const threadResult = await client.request<unknown>(
      "thread/start",
      {
        cwd: options.cwd,
        model: options.model,
        ephemeral: false,
      },
      this.requestTimeoutMs,
    );
    const thread = parseInitializeThread(threadResult);
    const turnParams: UnknownRecord = {
      threadId: thread.id,
      input: [{ type: "text", text: options.promptText }],
      model: options.model,
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.speed !== undefined ? { serviceTier: options.speed === "fast" ? "fast" : "default" } : {}),
    };
    const turnResult = await client.request<unknown>("turn/start", turnParams, this.requestTimeoutMs);
    const turn = parseStartTurn(turnResult);
    const socketSnapshot = requireSocketSnapshot(client);
    const startedAt = nowSeconds(this.now);
    const ref = refWithEvidence(
      this.provider,
      thread,
      turn.id,
      init,
      this.socketPath,
      socketSnapshot,
      options.model,
      startedAt,
      this.hostId,
      this.bindingTtlSeconds,
      options.effort !== undefined,
      options.speed !== undefined,
    );
    this.rememberSession(ref, client, thread.id, turn.id, init.runtimeVersion, "launch");
    return ref;
  }

  private rememberSession(
    ref: SessionRef,
    client: CodexAppServerRpcClient,
    threadId: string,
    activeTurnId: string,
    runtimeVersion: string,
    stateKey: string,
  ): NativeSessionState {
    const state: NativeSessionState = {
      client,
      socketPath: socketPathFromUrl(ref.serverUrl),
      threadId,
      providerSessionId: ref.sessionId,
      ref,
      activeTurnId,
      runtimeVersion,
      seenMessageKeys: new Set<string>(),
      observedMessageKeys: new Set<string>(),
    };
    this.sessions.set(ref.sessionId, state);
    this.sessions.set(threadId, state);
    // client notification callback is keyed by stateKey; keeping a thread alias lets
    // reconnect-created sessions be found without a durable in-memory state mutation.
    this.sessions.set(stateKey, state);
    return state;
  }

  private stateForRef(ref: SessionRef): NativeSessionState {
    const target = ref.nativeCommunication;
    const existing = this.sessions.get(ref.sessionId) ??
      (target !== undefined && target.route === "codex-app-server" ? this.sessions.get(target.threadId) : undefined);
    if (existing !== undefined) {
      if (target?.route === "codex-app-server" &&
        !codexAppServerSocketSnapshotsEqual(requireSocketSnapshot(existing.client), target.socketSnapshot)) {
        throw new CodexAppServerError("Codex App Server durable socket identity が一致しません", "endpoint");
      }
      return existing;
    }
    if (target === undefined || target.route !== "codex-app-server") {
      throw new CodexAppServerError("SessionRef に Codex App Server native binding がありません", "protocol");
    }
    const socketPath = socketPathFromUrl(ref.serverUrl);
    const client = this.clientFor(socketPath, ref.sessionId, target.socketSnapshot);
    const state: NativeSessionState = {
      client,
      socketPath,
      threadId: target.threadId,
      providerSessionId: target.providerSessionId,
      ref,
      activeTurnId: target.activeTurnId,
      runtimeVersion: target.runtimeVersion,
      seenMessageKeys: new Set<string>(),
      observedMessageKeys: new Set<string>(),
    };
    this.sessions.set(ref.sessionId, state);
    this.sessions.set(target.threadId, state);
    return state;
  }

  private async readThread(state: NativeSessionState, includeTurns: boolean): Promise<CodexThread> {
    const init = await this.ensureInitialized(state);
    const result = await state.client.request<unknown>(
      "thread/read",
      { threadId: state.threadId, includeTurns },
      this.requestTimeoutMs,
    );
    const record = requireRecord(result, "thread/read response");
    const thread = parseThread(record.thread, "thread/read.thread");
    if (thread.id !== state.threadId || thread.sessionId !== state.providerSessionId) {
      throw new CodexAppServerError("thread/read の thread/session binding が不一致です", "schema-drift", {
        method: "thread/read",
      });
    }
    state.runtimeVersion = init.runtimeVersion;
    const active = activeTurn(thread);
    if (active !== undefined) {
      state.activeTurnId = active.id;
    }
    return thread;
  }

  private async ensureInitialized(state: NativeSessionState): Promise<CodexAppServerInitializeInfo> {
    if (state.client.initialized && state.client.initializeInfo !== undefined) {
      return state.client.initializeInfo;
    }
    const info = await state.client.initialize();
    if (info.runtimeVersion !== state.runtimeVersion && state.runtimeVersion !== "") {
      throw new CodexAppServerError("reconnect 後の App Server runtime version が変わりました", "schema-drift");
    }
    return info;
  }

  async status(ref: SessionRef): Promise<SessionStatus> {
    const sessionState = this.stateForRef(ref);
    const thread = await this.readThread(sessionState, false);
    const active = activeTurn(thread);
    const threadState = statusFromThread(thread);
    const rawUpdatedAt = thread.raw.updatedAt;
    const activeStartedAt = active?.raw.startedAt;
    const lastActivityAt = typeof activeStartedAt === "number"
      ? activeStartedAt
      : typeof rawUpdatedAt === "number" ? rawUpdatedAt : null;
    return {
      state: threadState,
      lastActivityAt,
      resultCount: thread.turns.length,
      raw: thread.raw,
    };
  }

  async fetchTranscript(ref: SessionRef): Promise<string> {
    const state = this.stateForRef(ref);
    const thread = await this.readThread(state, true);
    return transcriptForThread(thread);
  }

  async inject(ref: SessionRef, message: string): Promise<void> {
    const state = this.stateForRef(ref);
    await this.ensureInitialized(state);
    const expectedTurnId = state.activeTurnId;
    const result = await state.client.request<unknown>(
      "turn/steer",
      {
        threadId: state.threadId,
        expectedTurnId,
        input: [{ type: "text", text: message }],
      },
      this.requestTimeoutMs,
    );
    state.activeTurnId = parseSteerTurnId(result);
  }

  /** Exact turn interrupt。thread/session stopの証拠とは扱わない。 */
  async interrupt(ref: SessionRef): Promise<void> {
    const state = this.stateForRef(ref);
    await this.ensureInitialized(state);
    await state.client.request<unknown>(
      "turn/interrupt",
      { threadId: state.threadId, turnId: state.activeTurnId },
      this.requestTimeoutMs,
    );
  }

  async stop(ref: SessionRef): Promise<StopResult> {
    // App Server の turn/interrupt は turn の停止に過ぎず、thread process/tree の exact stop
    // ではない。可能なら cooperative interrupt を送り、WorkerAdapter の stop 結果は unsupported
    // として exact-session stop の証拠へ昇格させない。
    try {
      await this.interrupt(ref);
    } catch {
      // interrupt の timeout/切断も exact stop とはみなさない。
    }
    return { stopped: false, reason: "unsupported" };
  }

  async stopCapabilities(ref: SessionRef): Promise<WorkerStopCapabilities> {
    void ref;
    return {
      protocol: "unsupported",
      exactSession: false,
      childProcessTree: false,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const client = await this.readyClient(this.socketPath, false, "health");
      await client.initialize();
      return true;
    } catch {
      return false;
    }
  }

  async probe(ref: SessionRef, now: number): Promise<NativeCommunicationProbeResult> {
    const target = ref.nativeCommunication;
    if (ref.provider !== this.provider || target === undefined || target.route !== "codex-app-server") {
      return { state: "unsupported", detail: "Codex App Server native binding がありません" };
    }
    let state: NativeSessionState;
    try {
      state = this.stateForRef(ref);
      const init = await this.ensureInitialized(state);
      const thread = await this.readThread(state, true);
      const active = activeTurn(thread);
      if (thread.id !== target.threadId || thread.sessionId !== target.providerSessionId) {
        return { state: "unsupported", detail: "thread/session binding mismatch" };
      }
      if (active === undefined) {
        return { state: "unsupported", detail: "active turn が存在しません" };
      }
      const fresh = evidenceFrom(
        thread,
        active.id,
        init,
        requireSocketSnapshot(state.client),
        this.hostId,
        now,
        this.bindingTtlSeconds,
      );
      const nextRef: SessionRef = { ...state.ref, nativeCommunication: fresh };
      state.ref = nextRef;
      state.activeTurnId = active.id;
      return { state: "supported", detail: "Codex App Server v2 binding は fresh です", target: fresh };
    } catch (error) {
      const detail = codexAppServerSupervisorDetail(error);
      if (error instanceof CodexAppServerError && (error.kind === "connection" || error.kind === "timeout")) {
        return { state: "unknown", detail };
      }
      return { state: "unsupported", detail };
    }
  }

  async deliver(input: NativeCommunicationDeliveryRequest): Promise<NativeCommunicationDeliveryResult> {
    const target = input.target;
    if (target.route !== "codex-app-server") {
      return { outcome: "rejected", detail: "Codex App Server route ではありません" };
    }
    if (target.expiresAt <= nowSeconds(this.now)) {
      return { outcome: "rejected", detail: "native binding が期限切れです" };
    }
    if (target.runtimeVersion !== (this.options.expectedRuntimeVersion ?? CODEX_APP_SERVER_CLI_VERSION)) {
      return { outcome: "rejected", detail: "native runtime version drift" };
    }
    if (target.capabilityHash !== (this.options.expectedSchemaChecksum ?? CODEX_APP_SERVER_SCHEMA_CHECKSUM)) {
      return { outcome: "rejected", detail: "native schema checksum drift" };
    }
    if (target.hostId !== this.hostId) {
      return { outcome: "rejected", detail: "native binding host mismatch" };
    }
    let state: NativeSessionState;
    try {
      state = this.sessions.get(target.providerSessionId) ?? this.stateForTarget(target);
    } catch (error) {
      return { outcome: "rejected", detail: codexAppServerSupervisorDetail(error) };
    }
    try {
      await this.ensureInitialized(state);
      if (state.threadId !== target.threadId || state.activeTurnId !== target.activeTurnId) {
        return { outcome: "rejected", detail: "expectedTurnId または threadId が一致しません" };
      }
      state.seenMessageKeys.add(input.messageKey);
      const result = await state.client.request<unknown>(
        "turn/steer",
        {
          threadId: target.threadId,
          expectedTurnId: target.activeTurnId,
          input: [{ type: "text", text: input.message }],
          clientUserMessageId: input.messageKey,
        },
        this.requestTimeoutMs,
      );
      const receiptId = `codex-app-server:${input.attemptId}`;
      state.activeTurnId = parseSteerTurnId(result);
      if (state.observedMessageKeys.has(input.messageKey)) {
        return { outcome: "session_observed", receiptId };
      }
      if (this.observeAfterSteer) {
        try {
          const thread = await this.readThread(state, true);
          if (readContainsMessage(thread, input.messageKey)) {
            return { outcome: "session_observed", receiptId };
          }
        } catch {
          // JSON-RPC success is still transport_accepted; missing observation must not be
          // rounded up to acknowledged, and the caller can retain the accepted receipt.
        }
      }
      return { outcome: "transport_accepted", receiptId };
    } catch (error) {
      const detail = codexAppServerSupervisorDetail(error);
      if (error instanceof CodexAppServerError && isExpectedTurnMismatch(error)) {
        return { outcome: "rejected", detail };
      }
      if (error instanceof CodexAppServerError && (error.kind === "timeout" || error.kind === "connection")) {
        return { outcome: "uncertain", detail };
      }
      if (error instanceof CodexAppServerError && (error.kind === "schema-drift" || error.kind === "endpoint")) {
        return { outcome: "rejected", detail };
      }
      return { outcome: "uncertain", detail };
    }
  }

  private stateForTarget(
    target: Extract<NativeCommunicationSessionRef, { route: "codex-app-server" }>,
  ): NativeSessionState {
    const socketPath = this.socketPath;
    const client = this.clientFor(socketPath, target.providerSessionId, target.socketSnapshot);
    const state: NativeSessionState = {
      client,
      socketPath,
      threadId: target.threadId,
      providerSessionId: target.providerSessionId,
      ref: {
        provider: this.provider,
        sessionId: target.providerSessionId,
        serverUrl: toUnixUrl(socketPath),
        model: "unknown",
        modelDelivery: "native",
        nativeCommunication: target,
        startedAt: target.observedAt,
      },
      activeTurnId: target.activeTurnId,
      runtimeVersion: target.runtimeVersion,
      seenMessageKeys: new Set<string>(),
      observedMessageKeys: new Set<string>(),
    };
    this.sessions.set(target.providerSessionId, state);
    this.sessions.set(target.threadId, state);
    return state;
  }

  async read(ref: SessionRef, includeTurns = true): Promise<CodexAppServerThreadReadResult> {
    const state = this.stateForRef(ref);
    const thread = await this.readThread(state, includeTurns);
    const active = activeTurn(thread);
    return {
      thread: thread.raw,
      status: statusFromThread(thread),
      activeTurnId: active?.id ?? null,
    };
  }

  dispose(): void {
    for (const client of new Set(this.clients.values())) {
      client.dispose();
    }
    this.clients.clear();
    this.sessions.clear();
    const child = this.serverProcess;
    this.serverProcess = undefined;
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
}

/** 明示名を使う呼び出し側向けの別名。実装と capability は CodexAppServerAdapter と同一。 */
export const CodexAppServerNativeAdapter = CodexAppServerAdapter;
export const CodexAppServerWorkerAdapter = CodexAppServerAdapter;
export const CodexAppServerCommunicationAdapter = CodexAppServerAdapter;
