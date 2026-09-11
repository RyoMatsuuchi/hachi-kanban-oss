import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { BridgeConfig } from "@hachi/core";
import {
  BridgeError,
  bridgeFetch,
  bridgeHealthCheck,
  probeBridgeCapabilities,
  probeBridgeExecutionCapabilities,
  probeBridgeIdentity,
  readBridgeToken,
} from "./http.js";
import type { SleepFn } from "./http.js";

/** テスト用の bridge token ファイルを一時ディレクトリに作成する */
function createTokenFile(token: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hachi-adapters-http-"));
  const file = join(dir, "bridge-token");
  writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}

describe("readBridgeToken", () => {
  it("ファイルを読み trim して返す", () => {
    const file = createTokenFile("plain-token-value");
    expect(readBridgeToken(file)).toBe("plain-token-value");
  });

  it("存在しないファイルは throw する", () => {
    expect(() => readBridgeToken("/nonexistent/path/to/token")).toThrow();
  });

  it("throw メッセージにパスは含めるが token 値は含めない", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-adapters-http-empty-"));
    const emptyFile = join(dir, "empty-token");
    writeFileSync(emptyFile, "   \n", { encoding: "utf8", mode: 0o600 });
    expect(() => readBridgeToken(emptyFile)).toThrow(emptyFile);
  });

  it("group/other が読める mode は拒否する", () => {
    const file = createTokenFile("private-token");
    chmodSync(file, 0o644);
    expect(() => readBridgeToken(file)).toThrow(/group\/other/);
  });

  it("symlink は拒否する", () => {
    const target = createTokenFile("private-token");
    const link = `${target}-link`;
    symlinkSync(target, link);
    expect(() => readBridgeToken(link)).toThrow(link);
  });

  it("8 KiB を超える token file は拒否する", () => {
    const file = createTokenFile("x".repeat(8 * 1024));
    expect(() => readBridgeToken(file)).toThrow(/上限/);
  });
});

interface CapturedRequest {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe("bridgeFetch", () => {
  let server: Server;
  let baseUrl: string;
  let captured: CapturedRequest | null;
  let responseStatus: number;
  let responseBody: unknown;

  beforeEach(async () => {
    captured = null;
    responseStatus = 200;
    responseBody = { ok: true };
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        captured = {
          method: req.method,
          url: req.url,
          headers: req.headers,
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
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function bridge(tokenValue = "test-token-abc123"): BridgeConfig {
    return { url: baseUrl, tokenFile: createTokenFile(tokenValue) };
  }

  it("Authorization ヘッダに Bearer token を付与する", async () => {
    await bridgeFetch(bridge("token-xyz-987"), "/api/prompt", { method: "POST", body: { text: "hi" } });
    expect(captured?.headers.authorization).toBe("Bearer token-xyz-987");
  });

  it("POST body を JSON で送る", async () => {
    await bridgeFetch(bridge(), "/api/prompt", {
      method: "POST",
      body: { text: "hello", provider: "codex", cwd: "/tmp/work" },
    });
    expect(captured?.method).toBe("POST");
    expect(JSON.parse(captured?.body ?? "{}")).toEqual({
      text: "hello",
      provider: "codex",
      cwd: "/tmp/work",
    });
  });

  it("401 で BridgeError(kind='auth') を throw する", async () => {
    responseStatus = 401;
    responseBody = { error: "unauthorized" };
    await expect(bridgeFetch(bridge(), "/api/status")).rejects.toMatchObject({
      kind: "auth",
      status: 401,
    });
  });

  it("5xx で BridgeError(kind='http') を throw する（GET はリトライ対象のため sleep を注入して即決着させる）", async () => {
    responseStatus = 500;
    responseBody = { error: "boom" };
    await expect(
      bridgeFetch(bridge(), "/api/status", {}, { sleep: async () => {} }),
    ).rejects.toMatchObject({
      kind: "http",
      status: 500,
    });
  });

  it("接続不可で BridgeError(kind='network') を throw する（GET はリトライ対象のため sleep を注入して即決着させる）", async () => {
    const deadBridge: BridgeConfig = { url: "http://127.0.0.1:1", tokenFile: createTokenFile("t") };
    await expect(
      bridgeFetch(deadBridge, "/api/status", {}, { sleep: async () => {} }),
    ).rejects.toMatchObject({ kind: "network" });
  });

  it("token 値がエラーメッセージに含まれない", async () => {
    responseStatus = 401;
    const secretToken = "super-secret-token-value-zzz";
    let caught: unknown = null;
    try {
      await bridgeFetch(bridge(secretToken), "/api/status");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as Error).message).not.toContain(secretToken);
  });
});

describe("probeBridgeCapabilities", () => {
  let server: Server;
  let baseUrl: string;
  let responseStatus: number;
  let responseBody: unknown;

  beforeEach(async () => {
    responseStatus = 200;
    responseBody = { ok: true, capabilities: { codex: [] } };
    server = createServer((_req, res) => {
      res.writeHead(responseStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address が取得できませんでした");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function bridgeConfig(): BridgeConfig {
    return { url: baseUrl, tokenFile: createTokenFile("cap-token") };
  }

  it("200 + 空配列は capability なしとして ok:true を返す", async () => {
    const result = await probeBridgeCapabilities(bridgeConfig());
    expect(result).toEqual({ ok: true, provider: "codex", capabilities: [] });
  });

  it("200 + capabilities.codex 配列を返す", async () => {
    responseBody = { ok: true, capabilities: { codex: ["model-passthrough-v1"] } };
    const result = await probeBridgeCapabilities(bridgeConfig());
    expect(result).toEqual({
      ok: true,
      provider: "codex",
      capabilities: ["model-passthrough-v1"],
    });
  });

  it("non-2xx は capability 不明として ok:false を返す", async () => {
    responseStatus = 404;
    responseBody = { error: "not-found" };
    const result = await probeBridgeCapabilities(bridgeConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("http");
      expect(result.failure.status).toBe(404);
    }
  });

  it("capabilities.codex が無い 200 は invalid-body の不明として返す", async () => {
    responseBody = { ok: true };
    const result = await probeBridgeCapabilities(bridgeConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("invalid-body");
    }
  });
});

describe("probeBridgeExecutionCapabilities", () => {
  let server: Server;
  let baseUrl: string;
  let responseStatus: number;
  let responseBody: unknown;

  beforeEach(async () => {
    responseStatus = 200;
    responseBody = { ok: true, capabilities: { codex: ["unknown-token-v9", "a-v1", "a-v1"] } };
    server = createServer((_req, res) => {
      res.writeHead(responseStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address が取得できませんでした");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function config(token = "execution-secret-token"): BridgeConfig {
    return { url: baseUrl, tokenFile: createTokenFile(token) };
  }

  it("legacy配列を維持しruntime/catalog/deliveryをunknownにする", async () => {
    const result = await probeBridgeExecutionCapabilities(config(), "codex", { now: () => 42 });
    expect(result).toEqual({
      ok: true,
      provider: "codex",
      snapshot: {
        schemaVersion: "execution-capability.v1",
        provider: "codex",
        transport: "bridge",
        runtime: { name: "bridge-runtime", version: null, source: "unknown" },
        capabilities: ["a-v1", "unknown-token-v9"],
        modelCatalog: { knowledge: "unknown", detail: "model catalog not advertised" },
        delivery: { model: "unknown", effort: "unknown", speed: "unknown" },
        observedAt: 42,
      },
    });
  });

  it("structured広告を検証して配列を重複除去・辞書順にする", async () => {
    responseBody = {
      capabilities: { claude: ["z-v1", "a-v1", "z-v1", "future-token-v8"] },
      executionCapability: {
        schemaVersion: "execution-capability.v1",
        provider: "claude",
        transport: "bridge",
        runtime: { name: "claude-bridge", version: "2.1.0", source: "advertised" },
        modelCatalog: {
          knowledge: "known",
          models: ["claude-opus-5", "claude-sonnet-5", "claude-opus-5"],
          source: "advertised",
        },
        delivery: { model: "native", effort: "none" },
      },
    };
    const result = await probeBridgeExecutionCapabilities(config(), "claude", { now: () => 9 });
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        capabilities: ["a-v1", "future-token-v8", "z-v1"],
        modelCatalog: { knowledge: "known", models: ["claude-opus-5", "claude-sonnet-5"] },
        delivery: { speed: "unknown" },
      },
    });
  });

  it("speed delivery は広告値を保持し、異形値はsnapshot全体を拒否する", async () => {
    const base = {
      schemaVersion: "execution-capability.v1",
      provider: "codex",
      transport: "bridge",
      runtime: { name: "codex-bridge", version: "1.0.0", source: "advertised" },
      modelCatalog: { knowledge: "known", models: ["gpt-5.6-sol"], source: "advertised" },
    };
    responseBody = {
      capabilities: { codex: ["speed-passthrough-v1"] },
      executionCapability: { ...base, delivery: { model: "native", effort: "native", speed: "native" } },
    };
    expect(await probeBridgeExecutionCapabilities(config(), "codex")).toMatchObject({
      ok: true,
      snapshot: { capabilities: ["speed-passthrough-v1"], delivery: { speed: "native" } },
    });

    responseBody = {
      capabilities: { codex: ["speed-passthrough-v1"] },
      executionCapability: { ...base, delivery: { model: "native", effort: "native", speed: "turbo" } },
    };
    expect(await probeBridgeExecutionCapabilities(config(), "codex")).toMatchObject({
      ok: false,
      failure: { kind: "invalid-body" },
    });
  });

  it("top-level structured広告も同じsnapshotへ正規化する", async () => {
    responseBody = {
      schemaVersion: "execution-capability.v1",
      provider: "codex",
      transport: "bridge",
      capabilities: { codex: [] },
      runtime: { name: "codex-bridge", version: null, source: "advertised" },
      modelCatalog: { knowledge: "unknown", detail: "raw detail is not retained" },
      delivery: { model: "none", effort: "unknown" },
    };
    const result = await probeBridgeExecutionCapabilities(config(), "codex", { now: () => 10 });
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        runtime: { name: "codex-bridge", version: null, source: "advertised" },
        modelCatalog: { knowledge: "unknown", detail: "model catalog not advertised" },
        delivery: { model: "none", effort: "unknown" },
      },
    });
  });

  it("明示known emptyとunknown catalogを区別する", async () => {
    const base = {
      schemaVersion: "execution-capability.v1",
      provider: "codex",
      transport: "bridge",
      runtime: { name: "codex-bridge", version: "1.0.0", source: "advertised" },
      delivery: { model: "unknown", effort: "unknown" },
    };
    responseBody = {
      capabilities: { codex: [] },
      executionCapability: {
        ...base,
        modelCatalog: { knowledge: "known", models: [], source: "advertised" },
      },
    };
    const known = await probeBridgeExecutionCapabilities(config(), "codex");
    expect(known).toMatchObject({ ok: true, snapshot: { modelCatalog: { knowledge: "known", models: [] } } });
    responseBody = {
      capabilities: { codex: [] },
      executionCapability: { ...base, modelCatalog: { knowledge: "unknown", detail: "secret raw detail" } },
    };
    const unknown = await probeBridgeExecutionCapabilities(config(), "codex");
    expect(unknown).toMatchObject({ ok: true, snapshot: {
      modelCatalog: { knowledge: "unknown", detail: "model catalog not advertised" },
    } });
    expect(JSON.stringify(unknown)).not.toContain("secret raw detail");
  });

  it("provider/transport不一致・異形・過大bodyはsnapshotを捏造しない", async () => {
    responseBody = {
      capabilities: { codex: [] },
      executionCapability: {
        schemaVersion: "execution-capability.v1",
        provider: "claude",
        transport: "direct",
      },
    };
    expect(await probeBridgeExecutionCapabilities(config(), "codex")).toMatchObject({
      ok: false, failure: { kind: "invalid-body" },
    });
    responseBody = { capabilities: { codex: Array.from({ length: 129 }, (_, index) => `cap-${index}`) } };
    expect(await probeBridgeExecutionCapabilities(config(), "codex")).toMatchObject({
      ok: false, failure: { kind: "invalid-body" },
    });
    responseBody = { padding: "x".repeat(70_000), capabilities: { codex: [] } };
    expect(await probeBridgeExecutionCapabilities(config(), "codex")).toMatchObject({
      ok: false, failure: { kind: "invalid-body" },
    });
  });

  it("auth failureにtokenやraw bodyを残さない", async () => {
    responseStatus = 401;
    responseBody = { error: "execution-secret-token", home: "/Users/alice/.token" };
    const result = await probeBridgeExecutionCapabilities(config("execution-secret-token"), "codex");
    expect(result).toMatchObject({ ok: false, failure: { kind: "auth", status: 401 } });
    expect(JSON.stringify(result)).not.toContain("execution-secret-token");
    expect(JSON.stringify(result)).not.toContain("/Users/alice");
  });

  it.each([
    ["network", new Error("secret network payload")],
    ["timeout", new DOMException("secret timeout payload", "TimeoutError")],
  ] as const)("%s failureを構造化しraw errorを残さない", async (kind, error) => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
    const result = await probeBridgeExecutionCapabilities(config(), "codex", {
      sleep: () => Promise.resolve(),
    });
    expect(result).toMatchObject({ ok: false, failure: { kind } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("bridgeFetch のリダイレクト非追従（docs/contract.md §12.14-1）", () => {
  let server: Server;
  let baseUrl: string;
  let redirectTargetHit: boolean;

  beforeEach(async () => {
    redirectTargetHit = false;
    server = createServer((req, res) => {
      if (req.url === "/redirect-target") {
        redirectTargetHit = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(302, { Location: "/redirect-target" });
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address が取得できませんでした");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("302 応答は追従せず BridgeError(kind='policy') を throw し、リダイレクト先へリクエストが発生しない", async () => {
    const bridgeConfig: BridgeConfig = { url: baseUrl, tokenFile: createTokenFile("redirect-test-token") };

    let caught: unknown = null;
    try {
      await bridgeFetch(bridgeConfig, "/api/status");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).kind).toBe("policy");
    // リダイレクト先の情報はメッセージに含めない
    expect((caught as Error).message).not.toContain("redirect-target");
    expect(redirectTargetHit).toBe(false);
  });
});

describe("bridgeFetch のループバック検証（docs/contract.md §12.13-3）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.HACHI_BRIDGE_ALLOW_REMOTE;
  });

  it.each(["127.0.0.1", "localhost", "[::1]"])("loopback ホスト %s は許可され fetch が呼ばれる", async (host) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const loopbackBridge: BridgeConfig = { url: `http://${host}:3456`, tokenFile: createTokenFile("t") };

    await expect(bridgeFetch(loopbackBridge, "/api/status")).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("loopback 以外の URL は HACHI_BRIDGE_ALLOW_REMOTE 未設定だと BridgeError(kind='policy') を throw し token を送らない", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const remoteBridge: BridgeConfig = { url: "http://example.com", tokenFile: createTokenFile("remote-secret-token") };

    let caught: unknown = null;
    try {
      await bridgeFetch(remoteBridge, "/api/status");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).kind).toBe("policy");
    expect((caught as Error).message).not.toContain("remote-secret-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("HACHI_BRIDGE_ALLOW_REMOTE=1 かつ HTTPS の場合だけリモート URL を許可する", async () => {
    process.env.HACHI_BRIDGE_ALLOW_REMOTE = "1";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const remoteBridge: BridgeConfig = { url: "https://example.com", tokenFile: createTokenFile("t") };

    await expect(bridgeFetch(remoteBridge, "/api/status")).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("HACHI_BRIDGE_ALLOW_REMOTE=1 でもリモート HTTP URL は拒否し token を送らない", async () => {
    process.env.HACHI_BRIDGE_ALLOW_REMOTE = "1";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const remoteBridge: BridgeConfig = {
      url: "http://example.com",
      tokenFile: createTokenFile("remote-secret-token"),
    };

    await expect(bridgeFetch(remoteBridge, "/api/status")).rejects.toMatchObject({ kind: "policy" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("bridgeFetch の GET リトライ（docs/contract.md §34.1）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** sleep 呼び出しを実時間待たずに記録するだけのモック（テスト容易性のための注入、契約 §34.1） */
  // 戻り値は SleepFn として使えるが、呼び出し検証（.mock.calls）のため Mock 型で返す
  function fakeSleep(): Mock<SleepFn> {
    return vi.fn(async () => {});
  }

  it("network エラーが2回続いても3回目で成功すれば結果を返し、500ms→1500ms±20%でバックオフする", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = fakeSleep();
    const target: BridgeConfig = { url: "http://127.0.0.1:3456", tokenFile: createTokenFile("t") };

    const response = await bridgeFetch(target, "/api/status", {}, { sleep });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const [firstDelay] = sleep.mock.calls[0] ?? [];
    const [secondDelay] = sleep.mock.calls[1] ?? [];
    expect(firstDelay).toBeGreaterThanOrEqual(400);
    expect(firstDelay).toBeLessThanOrEqual(600);
    expect(secondDelay).toBeGreaterThanOrEqual(1200);
    expect(secondDelay).toBeLessThanOrEqual(1800);
  });

  it("5xx が1回続いても成功すれば再試行後に結果を返す", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "boom" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = fakeSleep();
    const target: BridgeConfig = { url: "http://127.0.0.1:3456", tokenFile: createTokenFile("t") };

    const response = await bridgeFetch(target, "/api/messages", {}, { sleep });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("3回とも失敗すると最大2回のリトライ上限に達し最後のエラーを throw する", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = fakeSleep();
    const target: BridgeConfig = { url: "http://127.0.0.1:3456", tokenFile: createTokenFile("t") };

    await expect(bridgeFetch(target, "/api/status", {}, { sleep })).rejects.toMatchObject({ kind: "network" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("POST（副作用あり）は network エラーでも再試行しない（at-most-once 維持）", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = fakeSleep();
    const target: BridgeConfig = { url: "http://127.0.0.1:3456", tokenFile: createTokenFile("t") };

    await expect(
      bridgeFetch(target, "/api/prompt", { method: "POST", body: { text: "hi" } }, { sleep }),
    ).rejects.toMatchObject({ kind: "network" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("POST（副作用あり）は 5xx でも再試行しない", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = fakeSleep();
    const target: BridgeConfig = { url: "http://127.0.0.1:3456", tokenFile: createTokenFile("t") };

    await expect(
      bridgeFetch(target, "/api/prompt", { method: "POST", body: { text: "hi" } }, { sleep }),
    ).rejects.toMatchObject({ kind: "http", status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("401（認可失敗）は再試行しない（fail-closed 即時）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = fakeSleep();
    const target: BridgeConfig = { url: "http://127.0.0.1:3456", tokenFile: createTokenFile("t") };

    await expect(bridgeFetch(target, "/api/status", {}, { sleep })).rejects.toMatchObject({
      kind: "auth",
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("404（5xx 以外の 4xx）は再試行しない", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = fakeSleep();
    const target: BridgeConfig = { url: "http://127.0.0.1:3456", tokenFile: createTokenFile("t") };

    await expect(bridgeFetch(target, "/api/status", {}, { sleep })).rejects.toMatchObject({
      kind: "http",
      status: 404,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("リダイレクト（policy 違反）は再試行しない", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: "/x" } }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = fakeSleep();
    const target: BridgeConfig = { url: "http://127.0.0.1:3456", tokenFile: createTokenFile("t") };

    await expect(bridgeFetch(target, "/api/status", {}, { sleep })).rejects.toMatchObject({ kind: "policy" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("probeBridgeIdentity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function bridge(tokenValue = "identity-token-abc123"): BridgeConfig {
    return { url: "http://127.0.0.1:3456", tokenFile: createTokenFile(tokenValue) };
  }

  it("GET /api/sessions に Bearer token を付け、sessions 配列があれば OK にする", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));

    const result = await probeBridgeIdentity(bridge("identity-token-xyz"), { fetch: fetchMock });

    expect(result).toEqual({ ok: true, sessionCount: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3456/api/sessions");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer identity-token-xyz");
  });

  it("404 は port 乗っ取り疑いとして NG にする", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "not-found" }), { status: 404 }));

    const result = await probeBridgeIdentity(bridge(), { fetch: fetchMock });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("http");
      expect(result.failure.status).toBe(404);
      expect(result.failure.suspectPortHijack).toBe(true);
    }
  });

  it("HTML など非 JSON 応答は port 乗っ取り疑いとして NG にする", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("<html>not bridge</html>", { status: 200 }));

    const result = await probeBridgeIdentity(bridge(), { fetch: fetchMock });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("invalid-json");
      expect(result.failure.suspectPortHijack).toBe(true);
    }
  });

  it("sessions 配列が無い異形 JSON は port 乗っ取り疑いとして NG にする", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await probeBridgeIdentity(bridge(), { fetch: fetchMock });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("invalid-body");
      expect(result.failure.suspectPortHijack).toBe(true);
    }
  });

  it("token 値を失敗 detail に含めない", async () => {
    const secretToken = "super-secret-identity-token";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "not-found" }), { status: 404 }));

    const result = await probeBridgeIdentity(bridge(secretToken), { fetch: fetchMock });

    expect(JSON.stringify(result)).not.toContain(secretToken);
  });
});

describe("bridgeHealthCheck", () => {
  it("401 応答でも true を返す（token 無し生存確認）", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address が取得できませんでした");
    }
    const bridge: BridgeConfig = {
      url: `http://127.0.0.1:${address.port}`,
      tokenFile: createTokenFile("unused"),
    };
    await expect(bridgeHealthCheck(bridge)).resolves.toBe(true);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("200 応答は false を返す（token 無しで認証を要求しない = bridge ではない可能性、docs/contract.md §12.4-6）", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address が取得できませんでした");
    }
    const bridge: BridgeConfig = {
      url: `http://127.0.0.1:${address.port}`,
      tokenFile: createTokenFile("unused"),
    };
    await expect(bridgeHealthCheck(bridge)).resolves.toBe(false);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("404 応答は false を返す（docs/contract.md §12.4-6）", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address が取得できませんでした");
    }
    const bridge: BridgeConfig = {
      url: `http://127.0.0.1:${address.port}`,
      tokenFile: createTokenFile("unused"),
    };
    await expect(bridgeHealthCheck(bridge)).resolves.toBe(false);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("サーバ停止（接続不可）で false を返す（リトライ対象のため sleep を注入して即決着させる）", async () => {
    const bridge: BridgeConfig = { url: "http://127.0.0.1:1", tokenFile: createTokenFile("unused") };
    await expect(bridgeHealthCheck(bridge, { sleep: async () => {} })).resolves.toBe(false);
  });

  it("302 応答は追従せず false を返す（docs/contract.md §12.14-1）", async () => {
    let redirectTargetHit = false;
    const server = createServer((req, res) => {
      if (req.url === "/redirect-target") {
        redirectTargetHit = true;
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(302, { Location: "/redirect-target" });
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address が取得できませんでした");
    }
    const bridge: BridgeConfig = {
      url: `http://127.0.0.1:${address.port}`,
      tokenFile: createTokenFile("unused"),
    };
    await expect(bridgeHealthCheck(bridge)).resolves.toBe(false);
    expect(redirectTargetHit).toBe(false);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
});

describe("bridgeHealthCheck の GET リトライ（docs/contract.md §34.1）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 戻り値は SleepFn として使えるが、呼び出し検証（.mock.calls）のため Mock 型で返す
  function fakeSleep(): Mock<SleepFn> {
    return vi.fn(async () => {});
  }

  it("5xx が続いた後に401が来たら再試行後に true を返す", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = fakeSleep();
    const bridge: BridgeConfig = { url: "http://127.0.0.1:3456", tokenFile: createTokenFile("t") };

    await expect(bridgeHealthCheck(bridge, { sleep })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("network エラーが続いても最終的に401が来れば再試行後に true を返す", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = fakeSleep();
    const bridge: BridgeConfig = { url: "http://127.0.0.1:3456", tokenFile: createTokenFile("t") };

    await expect(bridgeHealthCheck(bridge, { sleep })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("5xx が3回続くとリトライ上限に達し false を返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = fakeSleep();
    const bridge: BridgeConfig = { url: "http://127.0.0.1:3456", tokenFile: createTokenFile("t") };

    await expect(bridgeHealthCheck(bridge, { sleep })).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("200（bridge ではない可能性）は再試行せず即 false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = fakeSleep();
    const bridge: BridgeConfig = { url: "http://127.0.0.1:3456", tokenFile: createTokenFile("t") };

    await expect(bridgeHealthCheck(bridge, { sleep })).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
