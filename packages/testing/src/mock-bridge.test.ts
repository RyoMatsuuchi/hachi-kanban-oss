import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockBridgeServer } from "./mock-bridge.js";

const TOKEN = "secret-token";

describe("MockBridgeServer", () => {
  let server: MockBridgeServer;

  beforeEach(async () => {
    server = new MockBridgeServer({ token: TOKEN });
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it("エフェメラルポートで待受け、url が 127.0.0.1 を指す", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("token 無し/不正 token のリクエストは 401 を返す", async () => {
    const noAuth = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", provider: "codex" }),
    });
    expect(noAuth.status).toBe(401);
    expect(await noAuth.json()).toEqual({ error: "unauthorized" });

    const badAuth = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: JSON.stringify({ text: "hi", provider: "codex" }),
    });
    expect(badAuth.status).toBe(401);
  });

  it("/api/info は token 無しで 401、正しい token で 200 を返す", async () => {
    const noAuth = await fetch(`${server.url}/api/info`);
    expect(noAuth.status).toBe(401);

    const ok = await fetch(`${server.url}/api/info`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, capabilities: { codex: [] } });
  });

  it("/api/info は capabilities.codex を広告できる", async () => {
    server.setCapabilities(["model-passthrough-v1", "effort-passthrough-v1"]);

    const ok = await fetch(`${server.url}/api/info?provider=codex`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      ok: true,
      capabilities: { codex: ["model-passthrough-v1", "effort-passthrough-v1"] },
    });
  });

  it.each([
    ["structured", "known", ["codex-model-v1"]],
    ["known-empty", "known", []],
    ["unknown-catalog", "unknown", undefined],
  ] as const)("/api/info は%s execution capability fixtureを返す", async (fixture, knowledge, models) => {
    server.setCapabilityFixture(fixture);
    server.setCapabilities(["future-capability-v7"]);
    const response = await fetch(`${server.url}/api/info?provider=codex`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["capabilities"]).toEqual({ codex: ["future-capability-v7"] });
    expect(body["executionCapability"]).toMatchObject({
      schemaVersion: "execution-capability.v1",
      provider: "codex",
      transport: "bridge",
      modelCatalog: {
        knowledge,
        ...(models !== undefined ? { models: [...models] } : {}),
      },
    });
  });

  it("/api/info はinvalid execution capability fixtureを返せる", async () => {
    server.setCapabilityFixture("invalid");
    const response = await fetch(`${server.url}/api/info?provider=codex`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await response.json()).toMatchObject({
      executionCapability: { schemaVersion: "invalid", provider: "codex" },
    });
  });

  it("Claude fixtureはcapabilities.claudeとproviderを広告する", async () => {
    await server.close();
    server = new MockBridgeServer({ token: TOKEN, provider: "claude", capabilityFixture: "structured" });
    await server.start();
    const response = await fetch(`${server.url}/api/info?provider=claude`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await response.json()).toMatchObject({
      capabilities: { claude: [] },
      executionCapability: { provider: "claude", transport: "bridge" },
    });
  });

  it("native mode は model/effort/speed/maxTurns を受理し native echo を返す", async () => {
    server.setCapabilities(["speed-passthrough-v1"]);
    server.setPassthroughMode("native");
    const res = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "実装して",
        provider: "codex",
        cwd: "/tmp/work",
        model: "gpt-5.4",
        effort: "max",
        speed: "fast",
        maxTurns: 1000,
      }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      ok: true,
      provider: "codex",
      modelDelivery: "native",
      appliedModel: "gpt-5.4",
      effortDelivery: "native",
      appliedEffort: "max",
      speedDelivery: "native",
      appliedSpeed: "fast",
      maxTurnsDelivery: "native",
      appliedMaxTurns: 1000,
    });
  });

  it.each([
    ["omit", undefined],
    ["null", null],
    ["value", "runtime-model"],
  ] as const)("native mode は delivery を保ったまま applied を%s応答にできる", async (kind, expected) => {
    server.setPassthroughMode("native");
    server.setAppliedResponse(
      "model",
      kind === "value" ? { kind, value: "runtime-model" } : { kind },
    );
    const response = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "実装して", provider: "codex", model: "requested-model" }),
    });

    const body = (await response.json()) as Record<string, unknown>;
    expect(body["modelDelivery"]).toBe("native");
    if (kind === "omit") {
      expect(body).not.toHaveProperty("appliedModel");
    } else {
      expect(body["appliedModel"]).toBe(expected);
    }
  });

  it("structured capability はspeed token欠落をunknown、広告時だけnativeにする", async () => {
    server.setCapabilityFixture("structured");
    let response = await fetch(`${server.url}/api/info?provider=codex`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await response.json()).toMatchObject({
      executionCapability: { delivery: { speed: "unknown" } },
    });

    server.setCapabilities(["speed-passthrough-v1"]);
    response = await fetch(`${server.url}/api/info?provider=codex`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await response.json()).toMatchObject({
      executionCapability: { delivery: { speed: "native" } },
    });
  });

  it("reject mode は passthrough 指定を sessionCreated:false の 409 で拒否する", async () => {
    server.setPassthroughMode("reject");
    const res = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "実装して", provider: "codex", model: "gpt-5.4" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: "model-passthrough-rejected",
      sessionCreated: false,
    });
    expect(server.sessions()).toEqual([]);
  });

  it("legacy mode は model/effort/speed/maxTurns フィールドを無視して従来応答を返す", async () => {
    const res = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "実装して", provider: "codex", model: "gpt-5.4", effort: "low", speed: "fast", maxTurns: 1000,
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.sessionId).toMatch(/^mock-\d+$/);
    expect(body).not.toHaveProperty("modelDelivery");
    expect(body).not.toHaveProperty("effortDelivery");
    expect(body).not.toHaveProperty("speedDelivery");
    expect(body).not.toHaveProperty("maxTurnsDelivery");
  });

  it("prompt でセッション発行(202) → inject 記録 → messages でイベントログを取得できる（docs/contract.md §13）", async () => {
    const authHeaders = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };

    const promptRes = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "最初のプロンプト", provider: "codex" }),
    });
    expect(promptRes.status).toBe(202);
    const promptBody = (await promptRes.json()) as { ok: boolean; sessionId: string; provider: string };
    expect(promptBody.ok).toBe(true);
    expect(promptBody.sessionId).toMatch(/^mock-\d+$/);
    expect(promptBody.provider).toBe("codex");
    const sessionId = promptBody.sessionId;

    // 新規発行直後は state='busy'
    const initialStatusRes = await fetch(
      `${server.url}/api/status?sessionId=${sessionId}&provider=codex`,
      { headers: authHeaders },
    );
    expect(initialStatusRes.status).toBe(200);
    expect(await initialStatusRes.json()).toEqual({ state: "busy", sessionId, provider: "codex" });

    const injectRes = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "追加の指示", provider: "codex", sessionId }),
    });
    expect(injectRes.status).toBe(202);
    expect(await injectRes.json()).toEqual({ ok: true, sessionId, provider: "codex" });

    const unknownRes = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "unknown", provider: "codex", sessionId: "mock-does-not-exist" }),
    });
    expect(unknownRes.status).toBe(404);

    const statusRes = await fetch(
      `${server.url}/api/status?sessionId=${sessionId}&provider=codex`,
      { headers: authHeaders },
    );
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual({ state: "busy", sessionId, provider: "codex" });

    const unknownStatusRes = await fetch(
      `${server.url}/api/status?sessionId=mock-does-not-exist&provider=codex`,
      { headers: authHeaders },
    );
    expect(unknownStatusRes.status).toBe(404);
    expect(await unknownStatusRes.json()).toEqual({ error: "Session not found" });

    const messagesRes = await fetch(
      `${server.url}/api/messages?sessionId=${sessionId}&provider=codex`,
      { headers: authHeaders },
    );
    expect(messagesRes.status).toBe(200);
    const messagesBody = (await messagesRes.json()) as {
      messages: Array<{ id: string; type: string; text?: string }>;
      state: string;
      sessionId: string;
      provider: string;
    };
    expect(messagesBody.state).toBe("busy");
    expect(messagesBody.sessionId).toBe(sessionId);
    expect(messagesBody.provider).toBe("codex");
    expect(messagesBody.messages).toHaveLength(2);
    expect(messagesBody.messages[0]?.type).toBe("user_prompt");
    expect(messagesBody.messages[0]?.text).toBe("最初のプロンプト");
    expect(messagesBody.messages[1]?.type).toBe("user_prompt");
    expect(messagesBody.messages[1]?.text).toBe("追加の指示");

    // 未知セッションの /api/messages は常に 200（messages 空配列 + state:"idle"）
    const unknownMessagesRes = await fetch(
      `${server.url}/api/messages?sessionId=mock-does-not-exist&provider=codex`,
      { headers: authHeaders },
    );
    expect(unknownMessagesRes.status).toBe(200);
    expect(await unknownMessagesRes.json()).toEqual({
      messages: [],
      state: "idle",
      sessionId: "mock-does-not-exist",
      provider: "codex",
    });

    const sessionsRes = await fetch(`${server.url}/api/sessions`, { headers: authHeaders });
    expect(sessionsRes.status).toBe(200);
    expect(await sessionsRes.json()).toEqual({
      sessions: [
        {
          id: sessionId,
          title: "最初のプロンプト",
          timestamp: "1970-01-01T00:00:00.000Z",
          cwd: "",
          status: "busy",
          provider: "codex",
        },
      ],
    });

    expect(server.sessions()).toEqual([sessionId]);

    const promptRequest = server.requests.find(
      (r) => r.method === "POST" && r.path === "/api/prompt" && r.hasAuthorizationHeader,
    );
    expect(promptRequest).toBeDefined();
    expect(promptRequest?.body).toMatchObject({ text: "最初のプロンプト", provider: "codex" });
  });

  it("completeSession は result イベントを追加し state を idle に遷移させる（docs/contract.md §13.4）", async () => {
    const authHeaders = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };

    const promptRes = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "実装して", provider: "codex" }),
    });
    const { sessionId } = (await promptRes.json()) as { sessionId: string };

    server.completeSession(sessionId, "実装完了しました");

    const statusRes = await fetch(`${server.url}/api/status?sessionId=${sessionId}&provider=codex`, {
      headers: authHeaders,
    });
    expect(await statusRes.json()).toMatchObject({ state: "idle" });

    const messagesRes = await fetch(`${server.url}/api/messages?sessionId=${sessionId}&provider=codex`, {
      headers: authHeaders,
    });
    const messagesBody = (await messagesRes.json()) as {
      messages: Array<{ type: string; text?: string; success?: boolean }>;
      state: string;
    };
    expect(messagesBody.state).toBe("idle");
    const resultEntry = messagesBody.messages.find((m) => m.type === "result");
    expect(resultEntry).toBeDefined();
    expect(resultEntry?.text).toBe("実装完了しました");
    expect(resultEntry?.success).toBe(true);
  });

  it("completeSession 後に inject すると state が busy に戻る", async () => {
    const authHeaders = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };

    const promptRes = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "実装して", provider: "codex" }),
    });
    const { sessionId } = (await promptRes.json()) as { sessionId: string };
    server.completeSession(sessionId, "1ターン目完了");

    await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "続けて", provider: "codex", sessionId }),
    });

    const statusRes = await fetch(`${server.url}/api/status?sessionId=${sessionId}&provider=codex`, {
      headers: authHeaders,
    });
    expect(await statusRes.json()).toMatchObject({ state: "busy" });
  });

  it("completeSession に未知の sessionId を渡すと throw する", () => {
    expect(() => server.completeSession("mock-does-not-exist", "x")).toThrow();
  });

  it("completeSession に stats を渡すと result イベントへ costUsd/turns/durationMs/inputTokens/outputTokens が反映される（docs/contract.md §14.5）", async () => {
    const authHeaders = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };

    const promptRes = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "実装して", provider: "codex" }),
    });
    const { sessionId } = (await promptRes.json()) as { sessionId: string };

    server.completeSession(sessionId, "実装完了しました", {
      costUsd: 0.34,
      turns: 5,
      durationMs: 6789,
      inputTokens: 1000,
      outputTokens: 2000,
    });

    const messagesRes = await fetch(`${server.url}/api/messages?sessionId=${sessionId}&provider=codex`, {
      headers: authHeaders,
    });
    const messagesBody = (await messagesRes.json()) as {
      messages: Array<{
        type: string;
        costUsd?: number;
        turns?: number;
        durationMs?: number;
        inputTokens?: number;
        outputTokens?: number;
      }>;
    };
    const resultEntry = messagesBody.messages.find((m) => m.type === "result");
    expect(resultEntry).toMatchObject({
      costUsd: 0.34,
      turns: 5,
      durationMs: 6789,
      inputTokens: 1000,
      outputTokens: 2000,
    });
  });

  it("completeSession に stats を渡さない場合は従来通りの最小値（costUsd=0/turns=1/durationMs=0）で inputTokens/outputTokens は付与しない", async () => {
    const authHeaders = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };

    const promptRes = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "実装して", provider: "codex" }),
    });
    const { sessionId } = (await promptRes.json()) as { sessionId: string };

    server.completeSession(sessionId, "実装完了しました");

    const messagesRes = await fetch(`${server.url}/api/messages?sessionId=${sessionId}&provider=codex`, {
      headers: authHeaders,
    });
    const messagesBody = (await messagesRes.json()) as {
      messages: Array<Record<string, unknown>>;
    };
    const resultEntry = messagesBody.messages.find((m) => m.type === "result");
    expect(resultEntry).toMatchObject({ costUsd: 0, turns: 1, durationMs: 0 });
    expect(resultEntry).not.toHaveProperty("inputTokens");
    expect(resultEntry).not.toHaveProperty("outputTokens");
  });

  it("provider 不一致は status で 404、messages では空配列 + idle を返す（docs/contract.md §12.16-3）", async () => {
    const authHeaders = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };

    // codex として発行したセッション
    const promptRes = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "codex session", provider: "codex" }),
    });
    const { sessionId } = (await promptRes.json()) as { sessionId: string };

    // provider=claude で inject しようとすると、セッションは実在するが provider が一致しないため 404
    const mismatchedInjectRes = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "wrong provider inject", provider: "claude", sessionId }),
    });
    expect(mismatchedInjectRes.status).toBe(404);
    expect(await mismatchedInjectRes.json()).toEqual({ error: "unknown-session" });

    // provider=claude で status を取得しようとしても 404
    const mismatchedStatusRes = await fetch(`${server.url}/api/status?sessionId=${sessionId}&provider=claude`, {
      headers: authHeaders,
    });
    expect(mismatchedStatusRes.status).toBe(404);
    expect(await mismatchedStatusRes.json()).toEqual({ error: "Session not found" });

    // provider=claude で messages を取得すると常に 200（messages 空配列 + state:idle）
    const mismatchedMessagesRes = await fetch(`${server.url}/api/messages?sessionId=${sessionId}&provider=claude`, {
      headers: authHeaders,
    });
    expect(mismatchedMessagesRes.status).toBe(200);
    expect(await mismatchedMessagesRes.json()).toEqual({
      messages: [],
      state: "idle",
      sessionId,
      provider: "claude",
    });

    // provider クエリ省略も不一致扱いで 404（status のフェイルセーフ）
    const missingProviderStatusRes = await fetch(`${server.url}/api/status?sessionId=${sessionId}`, {
      headers: authHeaders,
    });
    expect(missingProviderStatusRes.status).toBe(404);

    // 正しい provider を指定すれば従来通り成功する
    const correctStatusRes = await fetch(`${server.url}/api/status?sessionId=${sessionId}&provider=codex`, {
      headers: authHeaders,
    });
    expect(correctStatusRes.status).toBe(200);

    // 誤 inject は記録されず、正規メッセージ（prompt の1件）のみが残る
    const messagesRes = await fetch(`${server.url}/api/messages?sessionId=${sessionId}&provider=codex`, {
      headers: authHeaders,
    });
    const messagesBody = (await messagesRes.json()) as { messages: Array<{ type: string; text: string }> };
    expect(messagesBody.messages).toHaveLength(1);
    expect(messagesBody.messages[0]?.type).toBe("user_prompt");
  });

  it("failNextRequest は次の1リクエストだけ強制失敗させる", async () => {
    server.failNextRequest(503);
    const failed = await fetch(`${server.url}/api/info`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(failed.status).toBe(503);

    const recovered = await fetch(`${server.url}/api/info`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(recovered.status).toBe(200);
  });
});
