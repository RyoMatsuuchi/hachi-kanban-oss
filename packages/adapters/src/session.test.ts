import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeConfig, LaunchOptions, SessionRef } from "@hachi/core";
import { BridgeError } from "./http.js";
import {
  fetchSessionMessages,
  fetchSessionsByCwdAndProvider,
  fetchSessionTranscript,
  getSessionStatus,
  injectSession,
  launchSession,
} from "./session.js";

function createTokenFile(token = "session-test-token"): string {
  const dir = mkdtempSync(join(tmpdir(), "hachi-adapters-session-"));
  const file = join(dir, "bridge-token");
  writeFileSync(file, token, { encoding: "utf8", mode: 0o600 });
  return file;
}

interface CapturedRequest {
  method?: string | undefined;
  url?: string | undefined;
  body: string;
}

interface CapturingServerHandle {
  server: Server;
  baseUrl: string;
  captured: CapturedRequest | null;
}

/**
 * bridge.url とは別ポートの HTTP サーバーを起動する。
 * ref.serverUrl が構成 bridge とは異なる接続先を指すケース（docs/contract.md §12.15-2）を
 * 検証するため、リクエストの到達有無をサーバー単位で確認できるようにする。
 */
async function startCapturingServer(responseBody: unknown): Promise<CapturingServerHandle> {
  const handle: CapturingServerHandle = { server: null as unknown as Server, baseUrl: "", captured: null };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      handle.captured = {
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server address が取得できませんでした");
  }
  handle.server = server;
  handle.baseUrl = `http://127.0.0.1:${address.port}`;
  return handle;
}

describe("session helpers", () => {
  let server: Server;
  let baseUrl: string;
  let bridge: BridgeConfig;
  let captured: CapturedRequest | null;
  let responseStatus: number;
  let responseBody: unknown;

  beforeEach(async () => {
    captured = null;
    responseStatus = 200;
    responseBody = {};
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        captured = {
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        res.writeHead(responseStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address が取得できませんでした");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    bridge = { url: baseUrl, tokenFile: createTokenFile() };
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe("launchSession", () => {
    it("body に text/provider/cwd を含めて POST し SessionRef を構築する（202 Accepted, docs/contract.md §13.1）", async () => {
      responseStatus = 202;
      responseBody = { ok: true, sessionId: "sess-123", provider: "codex" };
      const options: LaunchOptions = { model: "gpt-5.4", cwd: "/work/dir", promptText: "実装して" };
      const ref = await launchSession(bridge, "codex", options);

      expect(captured?.method).toBe("POST");
      expect(captured?.url).toBe("/api/prompt");
      expect(JSON.parse(captured?.body ?? "{}")).toEqual({
        text: "実装して",
        provider: "codex",
        cwd: "/work/dir",
      });
      expect(ref.provider).toBe("codex");
      expect(ref.sessionId).toBe("sess-123");
      expect(ref.serverUrl).toBe(baseUrl);
      expect(ref.model).toBe("gpt-5.4");
      expect(ref.modelDelivery).toBe("none");
      expect(typeof ref.startedAt).toBe("number");
    });

    it("ok=false のレスポンスは throw する", async () => {
      responseStatus = 202;
      responseBody = { ok: false };
      const options: LaunchOptions = { model: "gpt-5.4", cwd: "/work", promptText: "x" };
      await expect(launchSession(bridge, "codex", options)).rejects.toBeInstanceOf(BridgeError);
    });

    it("sessionId が無いレスポンスは throw する", async () => {
      responseStatus = 202;
      responseBody = { ok: true };
      const options: LaunchOptions = { model: "gpt-5.4", cwd: "/work", promptText: "x" };
      await expect(launchSession(bridge, "codex", options)).rejects.toBeInstanceOf(BridgeError);
    });

    describe("effort 伝搬（docs/contract.md §35.3: bridge は運べないため無視を隠さない）", () => {
      it("effort 指定時は POST body に含めず、effortDelivery='none' を記録する", async () => {
        responseStatus = 202;
        responseBody = { ok: true, sessionId: "sess-effort-1" };
        const options: LaunchOptions = { model: "gpt-5.4", cwd: "/work", promptText: "x", effort: "medium" };
        const ref = await launchSession(bridge, "codex", options);

        expect(ref.effortDelivery).toBe("none");
        // bridge は effort を運べないため POST body にも含めない（model と同じ扱い）
        expect(JSON.parse(captured?.body ?? "{}")).toEqual({
          text: "x",
          provider: "codex",
          cwd: "/work",
        });
      });

      it("effort 未指定時は effortDelivery キー自体を省略する（exactOptionalPropertyTypes）", async () => {
        responseStatus = 202;
        responseBody = { ok: true, sessionId: "sess-effort-2" };
        const options: LaunchOptions = { model: "gpt-5.4", cwd: "/work", promptText: "x" };
        const ref = await launchSession(bridge, "codex", options);

        expect("effortDelivery" in ref).toBe(false);
      });
    });

    it("passthrough 指定時は model/effort を POST body に含め、native echo を SessionRef に反映する", async () => {
      responseStatus = 202;
      responseBody = {
        ok: true,
        sessionId: "sess-native-1",
        modelDelivery: "native",
        appliedModel: "gpt-5.4",
        effortDelivery: "native",
        appliedEffort: "low",
        runtimeGenerationAttestation: { version: 1, generationId: "producer-object" },
      };
      const options: LaunchOptions = { model: "gpt-5.4", cwd: "/work", promptText: "x", effort: "low" };
      const ref = await launchSession(bridge, "codex", options, {
        passthrough: { model: true, effort: true },
      });

      expect(JSON.parse(captured?.body ?? "{}")).toEqual({
        text: "x",
        provider: "codex",
        cwd: "/work",
        model: "gpt-5.4",
        effort: "low",
      });
      expect(ref.modelDelivery).toBe("native");
      expect(ref.effortDelivery).toBe("native");
      expect(ref.appliedModel).toBe("gpt-5.4");
      expect(ref.appliedEffort).toBe("low");
      expect(ref.runtimeGenerationAttestation).toEqual({ version: 1, generationId: "producer-object" });
    });

    it("runtimeGenerationAttestation の非object値はbinding候補へ運ばない", async () => {
      responseStatus = 202;
      responseBody = { ok: true, sessionId: "sess-invalid-attestation", runtimeGenerationAttestation: "invalid" };
      const ref = await launchSession(
        bridge,
        "codex",
        { model: "gpt-5.4", cwd: "/work", promptText: "x" },
      );
      expect("runtimeGenerationAttestation" in ref).toBe(false);
    });

    it("speed passthrough は明示時だけ body に含め、native echo と appliedSpeed を分離して記録する", async () => {
      responseStatus = 202;
      responseBody = {
        ok: true,
        sessionId: "sess-speed-native",
        speedDelivery: "native",
        appliedSpeed: "fast",
      };
      const options: LaunchOptions = {
        model: "gpt-5.6-sol", cwd: "/work", promptText: "x", effort: "max", speed: "fast",
      };
      const ref = await launchSession(bridge, "codex", options, {
        passthrough: { effort: true, speed: true },
      });

      expect(JSON.parse(captured?.body ?? "{}")).toEqual({
        text: "x",
        provider: "codex",
        cwd: "/work",
        effort: "max",
        speed: "fast",
      });
      expect(ref.speedDelivery).toBe("native");
      expect(ref.appliedSpeed).toBe("fast");
      // delivery は設定配送の証拠であり、runtimeが実際に用いた速度の推測フィールドは作らない。
      expect(ref).not.toHaveProperty("effectiveSpeed");
    });

    it("speed 要求を passthrough しない旧bridgeは none、未指定はキー省略にする", async () => {
      responseStatus = 202;
      responseBody = { ok: true, sessionId: "sess-speed-legacy" };
      const requested = await launchSession(bridge, "claude", {
        model: "claude-opus-5", cwd: "/work", promptText: "x", speed: "standard",
      });
      expect(requested.speedDelivery).toBe("none");
      expect(JSON.parse(captured?.body ?? "{}")).not.toHaveProperty("speed");

      responseBody = { ok: true, sessionId: "sess-speed-omitted" };
      const omitted = await launchSession(bridge, "claude", {
        model: "claude-opus-5", cwd: "/work", promptText: "x",
      });
      expect("speedDelivery" in omitted).toBe(false);
    });

    it("speed passthrough を送っても native echo が欠ければ配送成功にしない", async () => {
      responseStatus = 202;
      responseBody = { ok: true, sessionId: "sess-speed-no-echo", appliedSpeed: "fast" };
      const ref = await launchSession(bridge, "codex", {
        model: "gpt-5.6-sol", cwd: "/work", promptText: "x", speed: "fast",
      }, { passthrough: { speed: true } });
      expect(ref.speedDelivery).toBe("none");
      expect(ref).not.toHaveProperty("appliedSpeed");
    });

    it("maxTurns の native echo と数値 appliedMaxTurns を SessionRef に記録する", async () => {
      responseStatus = 202;
      responseBody = {
        ok: true,
        sessionId: "sess-max-turns-native",
        maxTurnsDelivery: "native",
        appliedMaxTurns: 1000,
      };
      const ref = await launchSession(bridge, "claude", {
        model: "claude-opus-5", cwd: "/work", promptText: "x",
      }, { maxTurns: 1000 });

      expect(JSON.parse(captured?.body ?? "{}")).toMatchObject({ maxTurns: 1000 });
      expect(ref.requestedMaxTurns).toBe(1000);
      expect(ref.maxTurnsDelivery).toBe("native");
      expect(ref.appliedMaxTurns).toBe(1000);
    });

    it("maxTurns 未要求時は delivery / requested / applied を記録しない", async () => {
      responseStatus = 202;
      responseBody = {
        ok: true,
        sessionId: "sess-max-turns-unrequested",
        maxTurnsDelivery: "native",
        appliedMaxTurns: 50,
      };
      const ref = await launchSession(bridge, "codex", {
        model: "gpt-5.6-sol", cwd: "/work", promptText: "x",
      });

      expect(ref).not.toHaveProperty("requestedMaxTurns");
      expect(ref).not.toHaveProperty("maxTurnsDelivery");
      expect(ref).not.toHaveProperty("appliedMaxTurns");
    });

    it("maxTurns を要求しても native echo が欠ければ appliedMaxTurns を記録しない", async () => {
      responseStatus = 202;
      responseBody = {
        ok: true,
        sessionId: "sess-max-turns-no-echo",
        appliedMaxTurns: 1000,
      };
      const ref = await launchSession(bridge, "claude", {
        model: "claude-opus-5", cwd: "/work", promptText: "x",
      }, { maxTurns: 1000 });

      expect(ref.requestedMaxTurns).toBe(1000);
      expect(ref.maxTurnsDelivery).toBe("none");
      expect(ref).not.toHaveProperty("appliedMaxTurns");
    });
  });

  describe("fetchSessionsByCwdAndProvider（docs/contract.md §13.6 / §34.1）", () => {
    it("同一 cwd+provider だけを status で読み、title/cwd を返却せず不明 timestamp は null にする", async () => {
      responseBody = {
        sessions: [
          {
            id: "candidate-new",
            title: "payloadへ出してはいけないタイトル",
            timestamp: "2026-08-31T06:00:01.000Z",
            cwd: "/work/target",
            status: "busy",
            provider: "codex",
          },
          {
            id: "candidate-missing-time",
            title: "別の秘匿タイトル",
            cwd: "/work/target",
            status: "idle",
            provider: "codex",
          },
          {
            id: "candidate-invalid-time",
            timestamp: "not-a-timestamp",
            cwd: "/work/target",
            status: "idle",
            provider: "codex",
          },
          {
            id: "other-cwd",
            timestamp: "2026-08-31T06:00:02.000Z",
            cwd: "/work/other",
            status: "busy",
            provider: "codex",
          },
          {
            id: "other-provider",
            timestamp: "2026-08-31T06:00:03.000Z",
            cwd: "/work/target",
            status: "busy",
            provider: "claude",
          },
          {
            id: "state-is-not-status",
            timestamp: "2026-08-31T06:00:04.000Z",
            cwd: "/work/target",
            state: "busy",
            provider: "codex",
          },
        ],
      };

      const sessions = await fetchSessionsByCwdAndProvider(bridge, "/work/target", "codex");

      expect(captured?.method).toBe("GET");
      expect(captured?.url).toBe("/api/sessions");
      expect(sessions).toEqual([
        { id: "candidate-new", status: "busy", timestamp: "2026-08-31T06:00:01.000Z" },
        { id: "candidate-missing-time", status: "idle", timestamp: null },
        { id: "candidate-invalid-time", status: "idle", timestamp: "not-a-timestamp" },
      ]);
      expect(JSON.stringify(sessions)).not.toContain("payloadへ出してはいけないタイトル");
      expect(sessions.every((session) => !("cwd" in session) && !("title" in session))).toBe(true);
    });
  });

  describe("injectSession", () => {
    function makeInjectRef(overrides: Partial<SessionRef> = {}): SessionRef {
      return {
        provider: "claude",
        sessionId: "sess-abc",
        serverUrl: baseUrl,
        model: "gpt-5.4",
        modelDelivery: "none",
        startedAt: 1000,
        ...overrides,
      };
    }

    it("sessionId を body に含めて POST する", async () => {
      responseStatus = 202;
      responseBody = { ok: true, sessionId: "sess-abc" };
      await injectSession(bridge, makeInjectRef(), "続けて");
      expect(captured?.method).toBe("POST");
      expect(JSON.parse(captured?.body ?? "{}")).toEqual({
        text: "続けて",
        provider: "claude",
        sessionId: "sess-abc",
      });
    });

    it("ok=false のレスポンスは throw する", async () => {
      responseStatus = 202;
      responseBody = { ok: false };
      await expect(
        injectSession(bridge, makeInjectRef({ provider: "codex", sessionId: "sess-1" }), "x"),
      ).rejects.toBeInstanceOf(BridgeError);
    });
  });

  describe("getSessionStatus（docs/contract.md §13.2/§13.4: /api/messages を1回だけ呼ぶ）", () => {
    const workerApiErrorStreamId = "123e4567-e89b-42d3-a456-426614174000";

    function makeRef(): SessionRef {
      return {
        provider: "codex",
        sessionId: "sess-1",
        serverUrl: baseUrl,
        model: "gpt-5.4",
        modelDelivery: "none",
        startedAt: 1000,
      };
    }

    it("GET /api/messages を呼び、state:busy を active にマッピングする", async () => {
      responseBody = { messages: [], state: "busy", sessionId: "sess-1", provider: "codex" };
      const status = await getSessionStatus(bridge, makeRef());
      expect(captured?.method).toBe("GET");
      expect(captured?.url).toContain("/api/messages");
      expect(captured?.url).toContain("sessionId=sess-1");
      expect(captured?.url).toContain("provider=codex");
      expect(status.state).toBe("active");
    });

    it("state:idle は idle にマッピングする", async () => {
      responseBody = { messages: [], state: "idle" };
      const status = await getSessionStatus(bridge, makeRef());
      expect(status.state).toBe("idle");
    });

    it("busy/idle 以外の未知値は unknown を返す（キーワード推測はしない）", async () => {
      responseBody = { messages: [], state: "running" };
      const status = await getSessionStatus(bridge, makeRef());
      expect(status.state).toBe("unknown");
    });

    it("state フィールドが無い場合も unknown を返す", async () => {
      responseBody = { messages: [] };
      const status = await getSessionStatus(bridge, makeRef());
      expect(status.state).toBe("unknown");
    });

    it("type:result のエントリ数を resultCount として返す", async () => {
      responseBody = {
        messages: [
          { id: "1", type: "user_prompt", text: "実装して" },
          { id: "2", type: "status", state: "busy" },
          { id: "3", type: "text_delta", text: "作業中" },
          { id: "4", type: "result", success: true, text: "完了しました" },
        ],
        state: "idle",
      };
      const status = await getSessionStatus(bridge, makeRef());
      expect(status.resultCount).toBe(1);
    });

    it("resultCount が複数件のエントリを正しく数える", async () => {
      responseBody = {
        messages: [
          { id: "1", type: "result", success: true, text: "1ターン目" },
          { id: "2", type: "user_prompt", text: "続けて" },
          { id: "3", type: "result", success: true, text: "2ターン目" },
        ],
        state: "idle",
      };
      const status = await getSessionStatus(bridge, makeRef());
      expect(status.resultCount).toBe(2);
    });

    it("最後の type:result の id を lastResultId として返す", async () => {
      responseBody = {
        messages: [
          { id: 4419, type: "result", success: true, text: "1ターン目" },
          { id: 4420, type: "result", success: true, text: "2ターン目" },
        ],
        state: "idle",
      };
      const status = (await getSessionStatus(bridge, makeRef())) as { lastResultId?: number };
      expect(status.lastResultId).toBe(4420);
    });

    it("全 entry の最大の正の単調IDを lastEntryId として返す（数値文字列も許容）", async () => {
      responseBody = {
        messages: [
          { id: 4419, type: "result", success: true, text: "途中result" },
          { id: "4421", type: "text_delta", text: "編集中" },
          { id: 4420, type: "status", state: "busy" },
        ],
        state: "idle",
      };
      const status = await getSessionStatus(bridge, makeRef());
      expect(status.lastEntryId).toBe(4421);
    });

    it("entry id の欠如・不正値・非正値は lastEntryId=0 として扱う", async () => {
      responseBody = {
        messages: [
          { type: "status", state: "busy" },
          { id: "01", type: "text_delta", text: "不正" },
          { id: -1, type: "result", success: true, text: "不正" },
        ],
        state: "idle",
      };
      const status = await getSessionStatus(bridge, makeRef());
      expect(status.lastEntryId).toBe(0);
    });

    it("type:result が無ければ lastResultId は 0", async () => {
      responseBody = {
        messages: [{ id: 4420, type: "status", state: "busy" }],
        state: "idle",
      };
      const status = (await getSessionStatus(bridge, makeRef())) as { lastResultId?: number };
      expect(status.lastResultId).toBe(0);
    });

    it("未知セッション（200 + messages空配列 + state:idle）は state=idle/resultCount=0", async () => {
      responseBody = { messages: [], state: "idle", sessionId: "sess-1", provider: "codex" };
      const status = await getSessionStatus(bridge, makeRef());
      expect(status.state).toBe("idle");
      expect(status.resultCount).toBe(0);
    });

    it("raw に生ペイロードを保持する", async () => {
      responseBody = { messages: [], state: "idle", extra: "field" };
      const status = await getSessionStatus(bridge, makeRef());
      expect(status.raw).toEqual({ messages: [], state: "idle", extra: "field" });
    });

    it("apiErrorObservation absent は本文から推測せず unsupported として成功する", async () => {
      responseBody = {
        messages: [{ id: "1", type: "result", success: false, text: "Prompt is too long" }],
        state: "idle",
      };

      const status = await getSessionStatus(bridge, makeRef());

      expect(status.apiErrorObservation).toEqual({ kind: "absent" });
    });

    it("valid apiErrorObservation は検証済みの安全な値だけを返す", async () => {
      responseBody = {
        messages: [],
        state: "idle",
        apiErrorObservation: {
          schemaVersion: "worker-api-error-observation.v1",
          streamId: workerApiErrorStreamId,
          watermark: 34,
          recent: [
            { sequence: 3, category: "provider-hard-error", ignored: "entry-secret" },
            { sequence: 34, category: "context-window-exceeded" },
          ],
          ignored: "observation-secret",
        },
      };

      const status = await getSessionStatus(bridge, makeRef());

      expect(status.apiErrorObservation).toEqual({
        kind: "valid",
        value: {
          schemaVersion: "worker-api-error-observation.v1",
          streamId: workerApiErrorStreamId,
          watermark: 34,
          recent: [
            { sequence: 3, category: "provider-hard-error" },
            { sequence: 34, category: "context-window-exceeded" },
          ],
        },
      });
      expect(status.raw).toEqual({ messages: [], state: "idle" });
    });

    it.each([
      ["field shape", null, "recent-shape"],
      [
        "schemaVersion",
        { schemaVersion: "worker-api-error-observation.v2", streamId: workerApiErrorStreamId, watermark: 0, recent: [] },
        "schema-version",
      ],
      [
        "streamId",
        { schemaVersion: "worker-api-error-observation.v1", streamId: "not-a-uuid", watermark: 0, recent: [] },
        "stream-id",
      ],
      [
        "streamId UUID variant",
        {
          schemaVersion: "worker-api-error-observation.v1",
          streamId: "123e4567-e89b-42d3-7456-426614174000",
          watermark: 0,
          recent: [],
        },
        "stream-id",
      ],
      [
        "watermark",
        { schemaVersion: "worker-api-error-observation.v1", streamId: workerApiErrorStreamId, watermark: -1, recent: [] },
        "watermark",
      ],
      [
        "watermark safe integer",
        {
          schemaVersion: "worker-api-error-observation.v1",
          streamId: workerApiErrorStreamId,
          watermark: Number.MAX_SAFE_INTEGER + 1,
          recent: [],
        },
        "watermark",
      ],
      [
        "recent shape",
        { schemaVersion: "worker-api-error-observation.v1", streamId: workerApiErrorStreamId, watermark: 0, recent: {} },
        "recent-shape",
      ],
      [
        "sequence positive integer",
        {
          schemaVersion: "worker-api-error-observation.v1",
          streamId: workerApiErrorStreamId,
          watermark: 0,
          recent: [{ sequence: 0, category: "provider-hard-error" }],
        },
        "sequence",
      ],
      [
        "sequence safe integer",
        {
          schemaVersion: "worker-api-error-observation.v1",
          streamId: workerApiErrorStreamId,
          watermark: Number.MAX_SAFE_INTEGER,
          recent: [{ sequence: Number.MAX_SAFE_INTEGER + 1, category: "provider-hard-error" }],
        },
        "sequence",
      ],
      [
        "sequence strictly increasing",
        {
          schemaVersion: "worker-api-error-observation.v1",
          streamId: workerApiErrorStreamId,
          watermark: 2,
          recent: [
            { sequence: 2, category: "provider-hard-error" },
            { sequence: 2, category: "context-window-exceeded" },
          ],
        },
        "sequence",
      ],
      [
        "category allowlist",
        {
          schemaVersion: "worker-api-error-observation.v1",
          streamId: workerApiErrorStreamId,
          watermark: 1,
          recent: [{ sequence: 1, category: "secret-provider-message" }],
        },
        "category",
      ],
      [
        "watermark zero consistency",
        {
          schemaVersion: "worker-api-error-observation.v1",
          streamId: workerApiErrorStreamId,
          watermark: 0,
          recent: [{ sequence: 1, category: "provider-hard-error" }],
        },
        "consistency",
      ],
      [
        "positive watermark requires recent",
        {
          schemaVersion: "worker-api-error-observation.v1",
          streamId: workerApiErrorStreamId,
          watermark: 1,
          recent: [],
        },
        "consistency",
      ],
      [
        "positive watermark consistency",
        {
          schemaVersion: "worker-api-error-observation.v1",
          streamId: workerApiErrorStreamId,
          watermark: 2,
          recent: [{ sequence: 1, category: "provider-hard-error" }],
        },
        "consistency",
      ],
    ] as const)("malformed apiErrorObservation ($0) は safe reason を返す", async (_label, value, reason) => {
      responseBody = { messages: [], state: "idle", apiErrorObservation: value };

      const status = await getSessionStatus(bridge, makeRef());

      expect(status.apiErrorObservation).toEqual({ kind: "malformed", reason });
    });

    it("recent が32件を超える projection は recent-shape として拒否する", async () => {
      responseBody = {
        messages: [],
        state: "idle",
        apiErrorObservation: {
          schemaVersion: "worker-api-error-observation.v1",
          streamId: workerApiErrorStreamId,
          watermark: 33,
          recent: Array.from({ length: 33 }, (_unused, index) => ({
            sequence: index + 1,
            category: "provider-hard-error",
          })),
        },
      };

      const status = await getSessionStatus(bridge, makeRef());

      expect(status.apiErrorObservation).toEqual({ kind: "malformed", reason: "recent-shape" });
    });

    it("malformed projection の raw secret は structured result と status.raw のどちらにも含めない", async () => {
      const rawSecret = "sk-worker-api-error-secret-value";
      responseBody = {
        messages: [],
        state: "idle",
        apiErrorObservation: {
          schemaVersion: "unexpected-schema",
          rawErrorText: rawSecret,
          recent: [{ prompt: rawSecret }],
        },
      };

      const status = await getSessionStatus(bridge, makeRef());
      const serializedStatus = JSON.stringify(status);

      expect(status.apiErrorObservation).toEqual({ kind: "malformed", reason: "schema-version" });
      expect(serializedStatus).not.toContain(rawSecret);
      expect(status.raw).toEqual({ messages: [], state: "idle" });
    });

    it("lastActivityAt は常に null（実 bridge にタイムスタンプフィールドが無いため）", async () => {
      responseBody = { messages: [], state: "idle" };
      const status = await getSessionStatus(bridge, makeRef());
      expect(status.lastActivityAt).toBeNull();
    });

    it("最後の type:result イベントから lastResult（costUsd/turns/durationMs/inputTokens/outputTokens）を抽出する（docs/contract.md §14.5）", async () => {
      responseBody = {
        messages: [
          { id: "1", type: "user_prompt", text: "実装して" },
          { id: "2", type: "result", success: true, text: "完了しました", costUsd: 0.12, turns: 3, durationMs: 4500, inputTokens: 100, outputTokens: 200 },
        ],
        state: "idle",
      };
      const status = await getSessionStatus(bridge, makeRef());
      expect(status.lastResult).toEqual({
        costUsd: 0.12,
        turns: 3,
        durationMs: 4500,
        inputTokens: 100,
        outputTokens: 200,
      });
    });

    it("複数の result イベントがある場合は最後のイベントの統計を採用する", async () => {
      responseBody = {
        messages: [
          { id: "1", type: "result", success: true, text: "1ターン目", costUsd: 0.01, turns: 1, durationMs: 100 },
          { id: "2", type: "user_prompt", text: "続けて" },
          { id: "3", type: "result", success: true, text: "2ターン目", costUsd: 0.02, turns: 2, durationMs: 200 },
        ],
        state: "idle",
      };
      const status = await getSessionStatus(bridge, makeRef());
      expect(status.lastResult).toEqual({ costUsd: 0.02, turns: 2, durationMs: 200 });
    });

    it("数値でないフィールドは省略する", async () => {
      responseBody = {
        messages: [
          { id: "1", type: "result", success: true, text: "完了", costUsd: "not-a-number", turns: 1, durationMs: null },
        ],
        state: "idle",
      };
      const status = await getSessionStatus(bridge, makeRef());
      expect(status.lastResult).toEqual({ turns: 1 });
    });

    it("type:result イベントが無ければ lastResult 自体を省略する", async () => {
      responseBody = {
        messages: [{ id: "1", type: "user_prompt", text: "実装して" }],
        state: "busy",
      };
      const status = await getSessionStatus(bridge, makeRef());
      expect(status.lastResult).toBeUndefined();
      expect("lastResult" in status).toBe(false);
    });
  });

  describe("fetchSessionTranscript（docs/contract.md §13.5）", () => {
    function makeRef(): SessionRef {
      return {
        provider: "codex",
        sessionId: "sess-1",
        serverUrl: baseUrl,
        model: "gpt-5.4",
        modelDelivery: "none",
        startedAt: 1000,
      };
    }

    it("user_prompt を [user] <text> として採用する", async () => {
      responseBody = { messages: [{ id: "1", type: "user_prompt", text: "こんにちは" }], state: "idle" };
      const transcript = await fetchSessionTranscript(bridge, makeRef());
      expect(transcript).toContain("[user] こんにちは");
    });

    it("result を [assistant] <text> として採用する", async () => {
      responseBody = { messages: [{ id: "1", type: "result", success: true, text: "了解しました" }], state: "idle" };
      const transcript = await fetchSessionTranscript(bridge, makeRef());
      expect(transcript).toContain("[assistant] 了解しました");
    });

    it("status/running_stats/text_delta は除外する（テレメトリ・重複防止）", async () => {
      responseBody = {
        messages: [
          { id: "1", type: "status", state: "busy" },
          { id: "2", type: "running_stats", durationMs: 100, inputTokens: 10, outputTokens: 20 },
          { id: "3", type: "text_delta", text: "作業中の断片" },
          { id: "4", type: "result", success: true, text: "最終応答" },
        ],
        state: "idle",
      };
      const transcript = await fetchSessionTranscript(bridge, makeRef());
      expect(transcript).not.toContain("作業中の断片");
      expect(transcript).not.toContain("busy");
      expect(transcript).not.toContain("durationMs");
      expect(transcript).toContain("[assistant] 最終応答");
      // result のみが1回だけ現れる（text_delta との重複が無い）
      expect(transcript.match(/最終応答/g)).toHaveLength(1);
    });

    it("user_prompt → result の順で会話の流れを再現する", async () => {
      responseBody = {
        messages: [
          { id: "1", type: "user_prompt", text: "実装して" },
          { id: "2", type: "status", state: "busy" },
          { id: "3", type: "result", success: true, text: "実装完了" },
        ],
        state: "idle",
      };
      const transcript = await fetchSessionTranscript(bridge, makeRef());
      const userIndex = transcript.indexOf("[user] 実装して");
      const assistantIndex = transcript.indexOf("[assistant] 実装完了");
      expect(userIndex).toBeGreaterThanOrEqual(0);
      expect(assistantIndex).toBeGreaterThan(userIndex);
    });

    it("未知 type のエントリは除外し、末尾に除外件数を注記する", async () => {
      responseBody = {
        messages: [
          { id: "1", type: "user_prompt", text: "実装して" },
          { id: "2", type: "future_type_v2", text: "将来追加された未知の型" },
          { id: "3", type: "result", success: true, text: "完了" },
        ],
        state: "idle",
      };
      const transcript = await fetchSessionTranscript(bridge, makeRef());
      expect(transcript).not.toContain("将来追加された未知の型");
      expect(transcript).toContain("未知タイプ 1 件を除外");
    });

    it("空の messages 配列は空 transcript を返す", async () => {
      responseBody = { messages: [], state: "idle" };
      const transcript = await fetchSessionTranscript(bridge, makeRef());
      expect(transcript).toBe("");
    });
  });

  describe("fetchSessionMessages（docs/contract.md §50.3）", () => {
    it("/api/messages の生イベント列と top-level state を返す", async () => {
      responseBody = {
        messages: [
          { id: "1", type: "text_delta", text: "a" },
          { id: "2", type: "tool_end", command: "pnpm test" },
        ],
        state: "busy",
      };
      const messages = await fetchSessionMessages(bridge, {
        provider: "codex",
        sessionId: "sess-1",
        serverUrl: baseUrl,
        model: "gpt-5.4",
        modelDelivery: "none",
        startedAt: 1000,
      });

      expect(messages.state).toBe("busy");
      expect(messages.entries).toEqual([
        { id: "1", type: "text_delta", text: "a" },
        { id: "2", type: "tool_end", command: "pnpm test" },
      ]);
    });
  });

  describe("ref.serverUrl による接続先解決（docs/contract.md §12.15-2）", () => {
    let altServer: CapturingServerHandle;

    beforeEach(async () => {
      // 構成 bridge（primary, baseUrl）とは別ポートの alt サーバーを ref.serverUrl として使う。
      // GET(status/transcript)/POST(inject) いずれの検証にも耐える形状にする（ok: injectSession用、
      // messages/state: getSessionStatus/fetchSessionTranscript用）。
      altServer = await startCapturingServer({ ok: true, messages: [], state: "idle" });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        altServer.server.close(() => resolve());
      });
    });

    function makeAltRef(serverUrl: string): SessionRef {
      return {
        provider: "codex",
        sessionId: "sess-alt",
        serverUrl,
        model: "gpt-5.4",
        modelDelivery: "none",
        startedAt: 1000,
      };
    }

    it("getSessionStatus は構成 bridge ではなく ref.serverUrl へ接続する", async () => {
      await getSessionStatus(bridge, makeAltRef(altServer.baseUrl));
      expect(captured).toBeNull();
      expect(altServer.captured?.method).toBe("GET");
      expect(altServer.captured?.url).toContain("sessionId=sess-alt");
    });

    it("injectSession は構成 bridge ではなく ref.serverUrl へ接続する", async () => {
      await injectSession(bridge, makeAltRef(altServer.baseUrl), "続けて");
      expect(captured).toBeNull();
      expect(altServer.captured?.method).toBe("POST");
      expect(JSON.parse(altServer.captured?.body ?? "{}")).toEqual({
        text: "続けて",
        provider: "codex",
        sessionId: "sess-alt",
      });
    });

    it("fetchSessionTranscript は構成 bridge ではなく ref.serverUrl へ接続する", async () => {
      await fetchSessionTranscript(bridge, makeAltRef(altServer.baseUrl));
      expect(captured).toBeNull();
      expect(altServer.captured?.method).toBe("GET");
      expect(altServer.captured?.url).toContain("sessionId=sess-alt");
    });

    it("ref.serverUrl が空文字の場合は構成 bridge へフォールバックする（後方互換）", async () => {
      responseBody = { messages: [], state: "idle" };
      const status = await getSessionStatus(bridge, makeAltRef(""));
      expect(status.state).toBe("idle");
      expect(captured).not.toBeNull();
      expect(altServer.captured).toBeNull();
    });
  });
});
