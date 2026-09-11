import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeConfig, LaunchOptions, SessionRef, TaskRow } from "@hachi/core";
import { CodexAdapter } from "./codex.js";

function createTokenFile(token = "codex-adapter-token"): string {
  const dir = mkdtempSync(join(tmpdir(), "hachi-adapters-codex-"));
  const file = join(dir, "bridge-token");
  writeFileSync(file, token, { encoding: "utf8", mode: 0o600 });
  return file;
}

function fakeTask(): TaskRow {
  return {
    id: "t_00000001",
    title: "テストタスク",
    body: "",
    status: "ready",
    priority: 0,
    tenant: "",
    assignee: "",
    provider: "",
    profile: "",
    modelOverride: "",
    effortOverride: "",
    speedOverride: "",
    reviewProfileOverride: "",
    reviewProviderOverride: "",
    reviewModelOverride: "",
    reviewEffortOverride: "",
    reviewSpeedOverride: "",
    blockReason: "",
    claimLock: "",
    watched: false,
    consecutiveFailures: 0,
    lastFailureError: "",
    lastHeartbeatAt: null,
    maxRetries: 3,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
  };
}

function fakeRef(baseUrl: string): SessionRef {
  return {
    provider: "codex",
    sessionId: "sess-1",
    serverUrl: baseUrl,
    model: "gpt-5.4",
    modelDelivery: "none",
    startedAt: 1000,
  };
}

describe("CodexAdapter", () => {
  let server: Server;
  let baseUrl: string;
  let bridge: BridgeConfig;
  let responseStatus: number;
  let responseBody: unknown;
  /** 直近リクエストの JSON body。model/effort が実際に配送されたかを検証するために保持する */
  let lastRequestBody: Record<string, unknown> | null;

  beforeEach(async () => {
    responseStatus = 200;
    responseBody = {};
    lastRequestBody = null;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        lastRequestBody = raw === "" ? null : (JSON.parse(raw) as Record<string, unknown>);
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

  it("provider は 'codex'", () => {
    const adapter = new CodexAdapter(bridge);
    expect(adapter.provider).toBe("codex");
  });

  it("launch で SessionRef を構築する（modelDelivery='none'）", async () => {
    responseBody = { ok: true, sessionId: "sess-codex-launch" };
    const adapter = new CodexAdapter(bridge);
    const options: LaunchOptions = { model: "gpt-5.4", cwd: "/work", promptText: "実装して" };
    const ref = await adapter.launch(fakeTask(), options);

    expect(ref.provider).toBe("codex");
    expect(ref.sessionId).toBe("sess-codex-launch");
    expect(ref.serverUrl).toBe(baseUrl);
    expect(ref.model).toBe("gpt-5.4");
    expect(ref.modelDelivery).toBe("none");
    expect(typeof ref.startedAt).toBe("number");
  });

  it("launch は model / effort を /api/prompt の body へ載せる", async () => {
    responseBody = { ok: true, sessionId: "sess-codex-passthrough", modelDelivery: "native", appliedModel: "gpt-5.4" };
    const adapter = new CodexAdapter(bridge);
    const options: LaunchOptions = {
      model: "gpt-5.4",
      cwd: "/work",
      promptText: "実装して",
      effort: "high",
    };

    await adapter.launch(fakeTask(), options);

    expect(lastRequestBody).not.toBeNull();
    expect(lastRequestBody?.model).toBe("gpt-5.4");
    expect(lastRequestBody?.effort).toBe("high");
  });

  it("status でセッション状態を取得する（GET /api/messages の top-level state, docs/contract.md §13.2/§13.4）", async () => {
    responseBody = { messages: [], state: "busy" };
    const adapter = new CodexAdapter(bridge);
    const status = await adapter.status(fakeRef(baseUrl));
    expect(status.state).toBe("active");
  });

  it("inject でメッセージを注入する", async () => {
    responseBody = { ok: true };
    const adapter = new CodexAdapter(bridge);
    await expect(adapter.inject(fakeRef(baseUrl), "続けて")).resolves.toBeUndefined();
  });

  it("fetchTranscript でログを取得する（docs/contract.md §13.5: [user]/[assistant] 形式）", async () => {
    responseBody = { messages: [{ id: "1", type: "user_prompt", text: "hello" }], state: "idle" };
    const adapter = new CodexAdapter(bridge);
    const transcript = await adapter.fetchTranscript(fakeRef(baseUrl));
    expect(transcript).toContain("[user] hello");
  });

  it("healthCheck は 401 応答でも true を返す", async () => {
    responseStatus = 401;
    responseBody = {};
    const adapter = new CodexAdapter(bridge);
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it("stop は bridge に停止経路が無いため unsupported を返す（throw しない、契約 §34.2）", async () => {
    const adapter = new CodexAdapter(bridge);
    await expect(adapter.stop(fakeRef(baseUrl))).resolves.toEqual({ stopped: false, reason: "unsupported" });
  });

  it("status/inject/fetchTranscript は構成 bridge ではなく ref.serverUrl（別ポート）へ到達する（docs/contract.md §12.15-2）", async () => {
    let altCaptured: { method?: string | undefined; url?: string | undefined } | null = null;
    const altServer = createServer((req, res) => {
      altCaptured = { method: req.method, url: req.url };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, state: "active" }));
    });
    await new Promise<void>((resolve) => {
      altServer.listen(0, "127.0.0.1", () => resolve());
    });
    const altAddress = altServer.address();
    if (altAddress === null || typeof altAddress === "string") {
      throw new Error("alt server address が取得できませんでした");
    }
    const altBaseUrl = `http://127.0.0.1:${altAddress.port}`;

    try {
      const adapter = new CodexAdapter(bridge);
      const ref = fakeRef(altBaseUrl);

      await adapter.status(ref);
      expect(altCaptured).not.toBeNull();

      altCaptured = null;
      await adapter.inject(ref, "続けて");
      expect(altCaptured).not.toBeNull();

      altCaptured = null;
      await adapter.fetchTranscript(ref);
      expect(altCaptured).not.toBeNull();
    } finally {
      await new Promise<void>((resolve) => {
        altServer.close(() => resolve());
      });
    }
  });
});
