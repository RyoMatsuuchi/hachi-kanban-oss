import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeConfig, LaunchOptions, SessionRef, TaskRow } from "@hachi/core";
import { ClaudeAdapter, CLAUDE_BRIDGE_MAX_TURNS } from "./claude.js";
import type { BridgeLaunchOptions, BridgeLaunchSessionRef } from "./session.js";

function createTokenFile(token = "claude-adapter-token"): string {
  const dir = mkdtempSync(join(tmpdir(), "hachi-adapters-claude-"));
  const file = join(dir, "bridge-token");
  writeFileSync(file, token, { encoding: "utf8", mode: 0o600 });
  return file;
}

function fakeTask(): TaskRow {
  return {
    id: "t_00000002",
    title: "テストタスク（claude）",
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
    provider: "claude",
    sessionId: "sess-1",
    serverUrl: baseUrl,
    model: "claude-opus-4-6",
    modelDelivery: "none",
    startedAt: 1000,
  };
}

describe("ClaudeAdapter", () => {
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
    vi.restoreAllMocks();
  });

  it("provider は 'claude'", () => {
    const adapter = new ClaudeAdapter(bridge);
    expect(adapter.provider).toBe("claude");
  });

  it("launch は model / effort を /api/prompt の body へ載せる", async () => {
    responseBody = { ok: true, sessionId: "sess-claude-passthrough", modelDelivery: "native", appliedModel: "claude-sonnet-5" };
    const adapter = new ClaudeAdapter(bridge);
    const options: LaunchOptions = {
      model: "claude-sonnet-5",
      cwd: "/work",
      promptText: "レビューして",
      effort: "high",
    };

    await adapter.launch(fakeTask(), options);

    expect(lastRequestBody).not.toBeNull();
    expect(lastRequestBody?.model).toBe("claude-sonnet-5");
    expect(lastRequestBody?.effort).toBe("high");
  });

  it("launch は runtime 既定より高い maxTurns を送る（既定 50 での途中打ち切りを避ける）", async () => {
    responseBody = {
      ok: true,
      sessionId: "sess-claude-turns",
      maxTurnsDelivery: "native",
      appliedMaxTurns: CLAUDE_BRIDGE_MAX_TURNS,
    };
    const adapter = new ClaudeAdapter(bridge);
    const options: LaunchOptions = { model: "claude-sonnet-5", cwd: "/work", promptText: "レビューして" };

    const ref = (await adapter.launch(fakeTask(), options)) as BridgeLaunchSessionRef;

    expect(lastRequestBody?.maxTurns).toBe(CLAUDE_BRIDGE_MAX_TURNS);
    expect(CLAUDE_BRIDGE_MAX_TURNS).toBeGreaterThan(50);
    expect(ref.maxTurnsDelivery).toBe("native");
    expect(ref.appliedMaxTurns).toBe(CLAUDE_BRIDGE_MAX_TURNS);
  });

  it("呼び出し側の bridgePassthrough を握り潰さない（speed のフラグが落ちない）", async () => {
    // supervisor は resolution から effort/speed の passthrough フラグを組み立てて渡す。
    // adapter 側の固定値でこれを上書きすると speed が body から落ち、実配送されないまま
    // bridge_native_missing で run が止まる。併合されることを固定する。
    responseBody = { ok: true, sessionId: "sess-claude-merge", speedDelivery: "native", appliedSpeed: "fast" };
    const adapter = new ClaudeAdapter(bridge);
    const options: LaunchOptions & BridgeLaunchOptions = {
      model: "claude-sonnet-5",
      cwd: "/work",
      promptText: "レビューして",
      effort: "high",
      speed: "fast",
      bridgePassthrough: { effort: true, speed: true },
    };

    await adapter.launch(fakeTask(), options);

    expect(lastRequestBody?.speed).toBe("fast");
    expect(lastRequestBody?.effort).toBe("high");
    expect(lastRequestBody?.model).toBe("claude-sonnet-5");
  });

  it("runtime が modelDelivery=native を返せば native として記録する", async () => {
    responseBody = { ok: true, sessionId: "sess-claude-native", modelDelivery: "native", appliedModel: "claude-sonnet-5" };
    const adapter = new ClaudeAdapter(bridge);
    const options: LaunchOptions = { model: "claude-sonnet-5", cwd: "/work", promptText: "レビューして" };

    // supervisor(dispatch.ts) は BridgeLaunchSessionRef で受けて appliedModel を run へ記録する。
    // WorkerAdapter の宣言戻り値は SessionRef へ狭まるため、同じ型で受け直して検証する
    const ref = (await adapter.launch(fakeTask(), options)) as BridgeLaunchSessionRef;

    expect(ref.modelDelivery).toBe("native");
    expect(ref.appliedModel).toBe("claude-sonnet-5");
  });

  it("runtime が delivery を返さない場合は none として記録する（無視を隠さない）", async () => {
    responseBody = { ok: true, sessionId: "sess-claude-launch" };
    const adapter = new ClaudeAdapter(bridge);
    const options: LaunchOptions = { model: "claude-opus-4-6", cwd: "/work", promptText: "レビューして" };
    const ref = await adapter.launch(fakeTask(), options);

    expect(ref.provider).toBe("claude");
    expect(ref.sessionId).toBe("sess-claude-launch");
    expect(ref.serverUrl).toBe(baseUrl);
    expect(ref.model).toBe("claude-opus-4-6");
    expect(ref.modelDelivery).toBe("none");
    expect(typeof ref.startedAt).toBe("number");
  });

  it("launch の /api/prompt は 120 秒 timeout を使う", async () => {
    responseBody = { ok: true, sessionId: "sess-claude-timeout" };
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const adapter = new ClaudeAdapter(bridge);
    const options: LaunchOptions = { model: "claude-opus-4-6", cwd: "/work", promptText: "レビューして" };

    await adapter.launch(fakeTask(), options);

    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
  });

  it("status でセッション状態を取得する（GET /api/messages の top-level state, docs/contract.md §13.2/§13.4）", async () => {
    responseBody = { messages: [], state: "idle" };
    const adapter = new ClaudeAdapter(bridge);
    const status = await adapter.status(fakeRef(baseUrl));
    expect(status.state).toBe("idle");
  });

  it("inject でメッセージを注入する", async () => {
    responseBody = { ok: true };
    const adapter = new ClaudeAdapter(bridge);
    await expect(adapter.inject(fakeRef(baseUrl), "続けて")).resolves.toBeUndefined();
  });

  it("fetchTranscript でログを取得する（docs/contract.md §13.5: [user]/[assistant] 形式）", async () => {
    responseBody = { messages: [{ id: "1", type: "result", success: true, text: "了解しました" }], state: "idle" };
    const adapter = new ClaudeAdapter(bridge);
    const transcript = await adapter.fetchTranscript(fakeRef(baseUrl));
    expect(transcript).toContain("[assistant] 了解しました");
  });

  it("healthCheck は 401 応答でも true を返す", async () => {
    responseStatus = 401;
    responseBody = {};
    const adapter = new ClaudeAdapter(bridge);
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it("stop は bridge に停止経路が無いため unsupported を返す（throw しない、契約 §34.2）", async () => {
    const adapter = new ClaudeAdapter(bridge);
    await expect(adapter.stop(fakeRef(baseUrl))).resolves.toEqual({ stopped: false, reason: "unsupported" });
  });
});
