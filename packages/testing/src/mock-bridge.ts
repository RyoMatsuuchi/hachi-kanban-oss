// even-terminal bridge server（docs/contract.md §13。2026-07-02 live probe で確定した実仕様）の
// 忠実なモック実装。統合テストや adapters のテストが、実ネットワークに触れずに
// bridge の挙動（認証・prompt 投入・状態取得・履歴取得）を検証できるようにする。
// 127.0.0.1 のエフェメラルポート（listen(0)）以外では待受けない。

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { EffortLevel, ExecutionSpeed, Provider, SessionResultStats } from "@hachi/core";

/** MockBridgeServer の生成オプション */
export interface MockBridgeOptions {
  /** Authorization: Bearer <token> の完全一致検証に使う正しいトークン */
  token: string;
  /** どちらの provider を模した bridge か（既定 codex） */
  provider?: Provider;
  /** /api/info?provider=codex で広告する capabilities.codex */
  capabilities?: readonly string[];
  /** §59 execution capability 広告fixture（既定 legacy） */
  capabilityFixture?: MockBridgeCapabilityFixture;
  /** model/effort/speed/maxTurns passthrough フィールドへの応答モード（既定は未パッチ相当で無視） */
  passthroughMode?: "legacy" | "native" | "reject";
}

export type MockBridgeAppliedField = "model" | "effort" | "speed" | "maxTurns";

export type MockBridgeAppliedResponse =
  | { kind: "omit" }
  | { kind: "null" }
  | { kind: "value"; value: string | number };

export type MockBridgeCapabilityFixture =
  | "legacy"
  | "structured"
  | "invalid"
  | "known-empty"
  | "unknown-catalog";

/** テストから assertion するために記録される受信リクエスト */
export interface RecordedRequest {
  method: string;
  path: string;
  /** Authorization ヘッダの有無（値そのものは記録しない） */
  hasAuthorizationHeader: boolean;
  body: unknown;
}

/**
 * GET /api/messages の1エントリ（type 判別ユニオン。docs/contract.md §13.3）。
 * role/author/from フィールドは存在しない（実 bridge の実仕様）。
 */
type MessageEntry =
  | { id: string; type: "user_prompt"; text: string }
  | { id: string; type: "status"; state: "busy" | "idle" | "text_start" | "text_end" }
  | { id: string; type: "running_stats"; durationMs: number; inputTokens: number; outputTokens: number }
  | { id: string; type: "text_delta"; text: string }
  | {
      id: string;
      type: "result";
      success: boolean;
      text: string;
      costUsd: number;
      turns: number;
      durationMs: number;
      inputTokens?: number;
      outputTokens?: number;
    };

/** POST /api/prompt の body 形状（docs/contract.md §4） */
interface PromptBody {
  text: string;
  provider: Provider;
  sessionId?: string;
  cwd?: string;
  model?: string;
  effort?: EffortLevel;
  speed?: ExecutionSpeed;
  maxTurns?: number;
}

function isPromptBody(value: unknown): value is PromptBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record["text"] !== "string") {
    return false;
  }
  if (record["provider"] !== "codex" && record["provider"] !== "claude") {
    return false;
  }
  if (record["sessionId"] !== undefined && typeof record["sessionId"] !== "string") {
    return false;
  }
  if (record["cwd"] !== undefined && typeof record["cwd"] !== "string") {
    return false;
  }
  if (record["model"] !== undefined && typeof record["model"] !== "string") {
    return false;
  }
  if (
    record["effort"] !== undefined &&
    record["effort"] !== "low" &&
    record["effort"] !== "medium" &&
    record["effort"] !== "high" &&
    record["effort"] !== "xhigh" &&
    record["effort"] !== "max"
  ) {
    return false;
  }
  if (record["speed"] !== undefined && record["speed"] !== "standard" && record["speed"] !== "fast") {
    return false;
  }
  if (record["maxTurns"] !== undefined && typeof record["maxTurns"] !== "number") {
    return false;
  }
  return true;
}

/** セッションの内部状態。entries は /api/messages がそのまま返す type 判別イベントログ */
interface SessionRecord {
  provider: Provider;
  state: "busy" | "idle";
  title: string;
  cwd: string;
  timestamp: string;
  entries: MessageEntry[];
}

/**
 * even-terminal bridge の忠実なモック（docs/contract.md §13）。
 * - `Authorization: Bearer <token>` 完全一致以外は 401
 * - `GET /api/info` は token 無しでも 401 を返す（=生存証明の仕様。正しい token では 200）
 * - `POST /api/prompt` は 202 Accepted（非同期受理）。sessionId 無しなら新規セッションを
 *   state='busy' で発行し、有りなら inject として user_prompt イベントを記録し state を busy に戻す
 * - `GET /api/status` は既知セッション（provider 一致）のみ 200 {state, sessionId, provider}、
 *   未知・provider 不一致は 404 {"error": "Session not found"}
 * - `GET /api/messages` は常に 200。既知セッションは type 判別イベントログ + top-level
 *   state/sessionId/provider を返し、未知・provider 不一致は {messages:[], state:"idle", ...}
 * - `GET /api/sessions` は 200 {sessions:[...]} を返す（bridge identity probe 用）
 */
export class MockBridgeServer {
  /** この bridge インスタンスが模している provider */
  readonly provider: Provider;
  /** 受信した全リクエストの記録（テストから assertion 可能） */
  readonly requests: RecordedRequest[] = [];

  private readonly token: string;
  private server: Server | null = null;
  private port = 0;
  private sessionCounter = 0;
  private entryCounter = 0;
  private readonly sessionRecords = new Map<string, SessionRecord>();
  private failNextStatus: number | null = null;
  private failNextPromptStatus: number | null = null;
  private capabilities: readonly string[];
  private capabilityFixture: MockBridgeCapabilityFixture;
  private passthroughMode: "legacy" | "native" | "reject";
  private readonly appliedResponses: Partial<Record<MockBridgeAppliedField, MockBridgeAppliedResponse>> = {};

  constructor(options: MockBridgeOptions) {
    this.token = options.token;
    this.provider = options.provider ?? "codex";
    this.capabilities = options.capabilities ?? [];
    this.capabilityFixture = options.capabilityFixture ?? "legacy";
    this.passthroughMode = options.passthroughMode ?? "legacy";
  }

  /** `http://127.0.0.1:<port>`。start() 前に参照すると throw する */
  get url(): string {
    if (this.port === 0) {
      throw new Error("MockBridgeServer: call start() before accessing url");
    }
    return `http://127.0.0.1:${this.port}`;
  }

  /** 127.0.0.1 のエフェメラルポートで listen する */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err: unknown) => {
          this.sendJson(res, 500, { error: "internal", detail: String(err) });
        });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        this.port = address.port;
        this.server = server;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) {
      return;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
    this.server = null;
  }

  /** 次の1リクエストだけ指定 status で強制失敗させる（エラーパステスト用） */
  failNextRequest(status: number): void {
    this.failNextStatus = status;
  }

  /** 次の /api/prompt だけ指定 status で強制失敗させる（probe とは分離した POST エラーテスト用） */
  failNextPrompt(status: number): void {
    this.failNextPromptStatus = status;
  }

  /** テスト用ヘルパー: /api/info?provider=codex の capability 広告を切り替える */
  setCapabilities(capabilities: readonly string[]): void {
    this.capabilities = capabilities;
  }

  /** テスト用ヘルパー: §59 execution capability fixtureを切り替える */
  setCapabilityFixture(fixture: MockBridgeCapabilityFixture): void {
    this.capabilityFixture = fixture;
  }

  /** テスト用ヘルパー: model/effort/speed/maxTurns passthrough 応答モードを切り替える */
  setPassthroughMode(mode: "legacy" | "native" | "reject"): void {
    this.passthroughMode = mode;
  }

  /** native delivery フラグを保ったまま applied 値だけを欠落/null/任意値へ差し替える。 */
  setAppliedResponse(field: MockBridgeAppliedField, response: MockBridgeAppliedResponse): void {
    this.appliedResponses[field] = response;
  }

  /** 発行済み sessionId 一覧（発行順） */
  sessions(): string[] {
    return [...this.sessionRecords.keys()];
  }

  /**
   * テスト用ヘルパー: type:"result" イベントを追加し state を idle に遷移させる
   * （supervisor テストが「worker 完了（ターン完了）」を模擬する正規手段。docs/contract.md §13.4）。
   * stats を渡すと costUsd/turns/durationMs/inputTokens/outputTokens を result イベントへ反映する
   * （docs/contract.md §14.5 のコスト/トークン永続化テスト用）。省略時は従来通りの最小値
   * （costUsd=0/turns=1/durationMs=0、inputTokens/outputTokens は付与しない）。
   * 未知セッションを指定した場合は throw する（テストの誤用を早期検知する）。
   */
  completeSession(sessionId: string, resultText: string, stats?: SessionResultStats): void {
    const session = this.sessionRecords.get(sessionId);
    if (session === undefined) {
      throw new Error(`MockBridgeServer.completeSession: unknown sessionId ${sessionId}`);
    }
    session.entries.push({
      id: this.nextEntryId(),
      type: "result",
      success: true,
      text: resultText,
      costUsd: stats?.costUsd ?? 0,
      turns: stats?.turns ?? 1,
      durationMs: stats?.durationMs ?? 0,
      ...(stats?.inputTokens !== undefined ? { inputTokens: stats.inputTokens } : {}),
      ...(stats?.outputTokens !== undefined ? { outputTokens: stats.outputTokens } : {}),
    });
    session.state = "idle";
  }

  private nextEntryId(): string {
    this.entryCounter += 1;
    return String(this.entryCounter);
  }

  private nativeAppliedFields(
    field: MockBridgeAppliedField,
    deliveryKey: string,
    appliedKey: string,
    requestedValue: string | number,
  ): Record<string, unknown> {
    const response = this.appliedResponses[field];
    if (response?.kind === "omit") {
      return { [deliveryKey]: "native" };
    }
    if (response?.kind === "null") {
      return { [deliveryKey]: "native", [appliedKey]: null };
    }
    return {
      [deliveryKey]: "native",
      [appliedKey]: response?.kind === "value" ? response.value : requestedValue,
    };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const path = url.pathname;
    const authHeader = req.headers.authorization;
    const hasAuthorizationHeader = typeof authHeader === "string";
    const authValid = hasAuthorizationHeader && authHeader === `Bearer ${this.token}`;
    const body = await this.readJsonBody(req);

    this.requests.push({ method, path, hasAuthorizationHeader, body });

    if (this.failNextStatus !== null) {
      const status = this.failNextStatus;
      this.failNextStatus = null;
      this.sendJson(res, status, { error: "forced-failure" });
      return;
    }

    // /api/info は token 無し・不正 token でも 401（生存確認の仕様。docs/contract.md §4）
    if (path === "/api/info" && method === "GET") {
      if (!authValid) {
        this.sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const capabilities = { [this.provider]: [...this.capabilities] };
      if (this.capabilityFixture === "legacy") {
        this.sendJson(res, 200, { ok: true, capabilities });
        return;
      }
      if (this.capabilityFixture === "invalid") {
        this.sendJson(res, 200, {
          ok: true,
          capabilities,
          executionCapability: { schemaVersion: "invalid", provider: this.provider },
        });
        return;
      }
      const known = this.capabilityFixture !== "unknown-catalog";
      const models = this.capabilityFixture === "known-empty" ? [] : [`${this.provider}-model-v1`];
      this.sendJson(res, 200, {
        ok: true,
        capabilities,
        executionCapability: {
          schemaVersion: "execution-capability.v1",
          provider: this.provider,
          transport: "bridge",
          runtime: {
            name: `${this.provider}-mock-bridge`,
            version: "1.0.0",
            source: "advertised",
          },
          modelCatalog: known
            ? { knowledge: "known", models, source: "advertised" }
            : { knowledge: "unknown", detail: "not advertised" },
          delivery: {
            // capability を広告していない項目まで native と称さない（speed と同じ扱い）。
            // 実 runtime は passthrough パッチが無ければ model を運べないため、
            // 広告と実配送が食い違う fixture を作らない。
            model: this.capabilities.includes("model-passthrough-v1") ? "native" : "unknown",
            effort: this.capabilities.includes("effort-passthrough-v1") ? "native" : "unknown",
            speed: this.capabilities.includes("speed-passthrough-v1") ? "native" : "unknown",
          },
        },
      });
      return;
    }

    if (!authValid) {
      this.sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (path === "/api/prompt" && method === "POST") {
      if (this.failNextPromptStatus !== null) {
        const status = this.failNextPromptStatus;
        this.failNextPromptStatus = null;
        this.sendJson(res, status, { error: "forced-prompt-failure" });
        return;
      }
      this.handlePrompt(body, res);
      return;
    }

    if (path === "/api/status" && method === "GET") {
      this.handleStatus(url, res);
      return;
    }

    if (path === "/api/messages" && method === "GET") {
      this.handleMessages(url, res);
      return;
    }

    if (path === "/api/sessions" && method === "GET") {
      this.handleSessions(res);
      return;
    }

    this.sendJson(res, 404, { error: "not-found" });
  }

  /** POST /api/prompt: 202 Accepted（docs/contract.md §13.1）。sessionId 無し=新規、有り=inject */
  private handlePrompt(body: unknown, res: ServerResponse): void {
    if (!isPromptBody(body)) {
      this.sendJson(res, 400, { error: "invalid-body" });
      return;
    }
    if (
      this.passthroughMode === "reject" &&
      (
        body.model !== undefined || body.effort !== undefined || body.speed !== undefined ||
        body.maxTurns !== undefined
      )
    ) {
      this.sendJson(res, 409, {
        code: "model-passthrough-rejected",
        sessionCreated: false,
      });
      return;
    }
    if (body.sessionId === undefined) {
      const sessionId = `mock-${++this.sessionCounter}`;
      this.sessionRecords.set(sessionId, {
        provider: body.provider,
        state: "busy",
        title: body.text.slice(0, 80),
        cwd: body.cwd ?? "",
        timestamp: new Date(0).toISOString(),
        entries: [{ id: this.nextEntryId(), type: "user_prompt", text: body.text }],
      });
      this.sendJson(res, 202, {
        ok: true,
        sessionId,
        provider: body.provider,
        ...(this.passthroughMode === "native" && body.model !== undefined
          ? this.nativeAppliedFields("model", "modelDelivery", "appliedModel", body.model)
          : {}),
        ...(this.passthroughMode === "native" && body.effort !== undefined
          ? this.nativeAppliedFields("effort", "effortDelivery", "appliedEffort", body.effort)
          : {}),
        ...(this.passthroughMode === "native" && body.speed !== undefined
          ? this.nativeAppliedFields("speed", "speedDelivery", "appliedSpeed", body.speed)
          : {}),
        ...(this.passthroughMode === "native" && body.maxTurns !== undefined
          ? this.nativeAppliedFields("maxTurns", "maxTurnsDelivery", "appliedMaxTurns", body.maxTurns)
          : {}),
      });
      return;
    }
    // セッション不存在、または存在しても provider が一致しない場合は 404
    // （docs/contract.md §12.16-3。取り違えたセッションへの誤 inject をテストが偽陽性で見逃さないため）
    const session = this.sessionRecords.get(body.sessionId);
    if (session === undefined || session.provider !== body.provider) {
      this.sendJson(res, 404, { error: "unknown-session" });
      return;
    }
    // inject は user_prompt イベントとして記録し state='busy' に戻す（docs/contract.md FIX-2）
    session.entries.push({ id: this.nextEntryId(), type: "user_prompt", text: body.text });
    session.state = "busy";
    this.sendJson(res, 202, { ok: true, sessionId: body.sessionId, provider: body.provider });
  }

  /** GET /api/status: 既知（provider一致）のみ 200、それ以外は 404（docs/contract.md §13.2） */
  private handleStatus(url: URL, res: ServerResponse): void {
    const sessionId = url.searchParams.get("sessionId");
    const provider = url.searchParams.get("provider");
    const session = sessionId !== null ? this.sessionRecords.get(sessionId) : undefined;
    if (session === undefined || session.provider !== provider) {
      this.sendJson(res, 404, { error: "Session not found" });
      return;
    }
    this.sendJson(res, 200, { state: session.state, sessionId, provider: session.provider });
  }

  /** GET /api/messages: 常に 200。未知・provider不一致は messages 空配列 + state:"idle"（docs/contract.md §13.3） */
  private handleMessages(url: URL, res: ServerResponse): void {
    const sessionId = url.searchParams.get("sessionId");
    const provider = url.searchParams.get("provider");
    const session = sessionId !== null ? this.sessionRecords.get(sessionId) : undefined;
    if (session === undefined || session.provider !== provider) {
      this.sendJson(res, 200, {
        messages: [],
        state: "idle",
        sessionId: sessionId ?? "",
        provider: provider ?? "",
      });
      return;
    }
    this.sendJson(res, 200, {
      messages: session.entries,
      state: session.state,
      sessionId,
      provider: session.provider,
    });
  }

  /** GET /api/sessions: 発行済みセッション一覧（docs/contract.md §13.6 参考仕様） */
  private handleSessions(res: ServerResponse): void {
    this.sendJson(res, 200, {
      sessions: [...this.sessionRecords.entries()].map(([id, session]) => ({
        id,
        title: session.title,
        timestamp: session.timestamp,
        cwd: session.cwd,
        status: session.state,
        provider: session.provider,
      })),
    });
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) {
      return undefined;
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw.length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const raw = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(raw);
  }
}
