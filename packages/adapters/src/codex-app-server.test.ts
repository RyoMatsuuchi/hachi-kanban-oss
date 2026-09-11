import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { LaunchOptions, TaskRow } from "@hachi/core";
import {
  CODEX_APP_SERVER_CLI_VERSION,
  CODEX_APP_SERVER_GENERATED_SCHEMA_SHA256,
  CODEX_APP_SERVER_SCHEMA_FIXTURE_SHA256,
  CODEX_APP_SERVER_SCHEMA_FIXTURE,
  CODEX_APP_SERVER_SCHEMA_CHECKSUM,
  CodexAppServerAdapter,
  CodexAppServerRpcClient,
} from "./index.js";
import {
  codexAppServerSupervisorDetail,
  type CodexAppServerError,
} from "./codex-app-server-rpc.js";

const GENERATED_SCHEMA_FIXTURE_PATH = fileURLToPath(
  new URL("./schema/codex-app-server-v2.generated.fixture.json", import.meta.url),
);

interface RpcRequest {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface FakeRpcServer {
  readonly socketPath: string;
  readonly requests: RpcRequest[];
  readonly server: Server;
  close(): Promise<void>;
}

type RequestHandler = (request: RpcRequest, socket: Socket) => void;

// Darwin's per-user TMPDIR exceeds the Unix socket path limit. Linux CI does
// not expose /private/tmp, so use its canonical system temp directory there.
const TEST_TMP_ROOT =
  process.platform === "darwin" ? "/private/tmp" : realpathSync(tmpdir());

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function makeServer(handler: RequestHandler): Promise<FakeRpcServer> {
  const root = mkdtempSync(join(TEST_TMP_ROOT, "hachi-codex-app-server-test-"));
  const socketPath = join(root, "app-server.sock");
  const requests: RpcRequest[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          return;
        }
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          continue;
        }
        const request = JSON.parse(line) as RpcRequest;
        requests.push(request);
        handler(request, socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  // The adapter deliberately rejects group/other socket permissions. A real
  // Codex App Server is expected to create the endpoint with the same mode.
  chmodSync(socketPath, 0o600);
  const fake: FakeRpcServer = {
    socketPath,
    requests,
    server,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      rmSync(root, { recursive: true, force: true });
    },
  };
  cleanups.push(fake.close);
  return fake;
}

function sendResponse(socket: Socket, id: string | number | undefined, result: unknown, fragmented = false): void {
  if (id === undefined) {
    return;
  }
  const encoded = `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
  if (!fragmented) {
    socket.write(encoded);
    return;
  }
  const midpoint = Math.max(1, Math.floor(encoded.length / 2));
  socket.write(encoded.slice(0, midpoint));
  setTimeout(() => socket.write(encoded.slice(midpoint)), 1);
}

function sendError(socket: Socket, id: string | number | undefined, code: number, message: string): void {
  if (id === undefined) {
    return;
  }
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function threadPayload(threadId: string, sessionId: string, turnId: string, items: readonly Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    cliVersion: "0.144.1",
    createdAt: 1,
    cwd: "/tmp",
    ephemeral: false,
    id: threadId,
    modelProvider: "openai",
    preview: "fake thread",
    sessionId,
    source: "app-server",
    status: { type: "active", activeFlags: [] },
    turns: [{ id: turnId, items, status: "inProgress" }],
    updatedAt: 2,
  };
}

function initializePayload(userAgent = "codex-cli 0.144.1"): Record<string, unknown> {
  return {
    codexHome: "/tmp/codex-home",
    platformFamily: "unix",
    platformOs: "linux",
    userAgent,
  };
}

function fakeTask(): TaskRow {
  return {
    id: "t_codex_app_server",
    title: "fake app server",
    body: "",
    status: "ready",
    priority: 0,
    tenant: "",
    assignee: "",
    provider: "codex",
    profile: "implement",
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

function launchOptions(): LaunchOptions {
  return { model: "gpt-5.5", cwd: "/tmp", promptText: "worker prompt" };
}

describe("CodexAppServerRpcClient", () => {
  it("fragmented frame と out-of-order response を request id 相関する", async () => {
    const fake = await makeServer((request, socket) => {
      if (request.method === "first") {
        setTimeout(() => sendResponse(socket, request.id, { value: "one" }, true), 10);
      } else if (request.method === "second") {
        sendResponse(socket, request.id, { value: "two" }, true);
      }
    });
    const client = new CodexAppServerRpcClient({
      socketPath: fake.socketPath,
      reconnectAttempts: 0,
      timeoutMs: 500,
    });
    cleanups.push(() => client.dispose());

    const [first, second] = await Promise.all([
      client.request<{ value: string }>("first"),
      client.request<{ value: string }>("second"),
    ]);
    expect(first.value).toBe("one");
    expect(second.value).toBe("two");
  });

  it("bounded timeout は副作用不明を timeout error として返す", async () => {
    const fake = await makeServer(() => undefined);
    const client = new CodexAppServerRpcClient({
      socketPath: fake.socketPath,
      reconnectAttempts: 0,
      timeoutMs: 30,
    });
    cleanups.push(() => client.dispose());

    const result = client.request("never");
    await expect(result).rejects.toMatchObject({ kind: "timeout" });
  });

  it("initialize は runtime version drift を fail-closed する", async () => {
    const fake = await makeServer((request, socket) => {
      if (request.method === "initialize") {
        sendResponse(socket, request.id, initializePayload("codex-cli 0.144.2"));
      }
    });
    const client = new CodexAppServerRpcClient({
      socketPath: fake.socketPath,
      reconnectAttempts: 0,
    });
    cleanups.push(() => client.dispose());

    await expect(client.initialize()).rejects.toMatchObject({ kind: "schema-drift" });
  });

  it("socket close 後の次 request は reconnect して相関する", async () => {
    let connectionCount = 0;
    const fake = await makeServer((request, socket) => {
      if (request.method === "ping") {
        sendResponse(socket, request.id, { ok: true });
        socket.destroy();
      } else if (request.method === "pong") {
        sendResponse(socket, request.id, { ok: "reconnected" });
      }
    });
    fake.server.on("connection", () => {
      connectionCount += 1;
    });
    const client = new CodexAppServerRpcClient({
      socketPath: fake.socketPath,
      reconnectAttempts: 2,
      reconnectDelayMs: 2,
      timeoutMs: 500,
    });
    cleanups.push(() => client.dispose());

    await expect(client.request<{ ok: boolean }>("ping")).resolves.toEqual({ ok: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await expect(client.request<{ ok: string }>("pong")).resolves.toEqual({ ok: "reconnected" });
    expect(connectionCount).toBeGreaterThanOrEqual(2);
  });

  it("provider RPC message は固定 code のみを supervisor detail へ出す", async () => {
    const secret = "provider-secret-".repeat(128);
    const fake = await makeServer((request, socket) => {
      sendError(socket, request.id, -32001, secret);
    });
    const client = new CodexAppServerRpcClient({
      socketPath: fake.socketPath,
      reconnectAttempts: 0,
    });
    cleanups.push(() => client.dispose());

    const result = client.request("provider-failure");
    let caught: unknown;
    try {
      await result;
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      kind: "rpc",
      code: -32001,
    });
    expect(codexAppServerSupervisorDetail(caught)).toBe("codex_app_server_rpc:-32001");
    expect((caught as CodexAppServerError).message).not.toContain(secret);
    expect((caught as CodexAppServerError).message.length).toBeLessThanOrEqual(96);
  });

  it("socket mode と inode replacement を RPC 前に拒否する", async () => {
    const fake = await makeServer((request, socket) => {
      sendResponse(socket, request.id, { ok: true });
    });
    const client = new CodexAppServerRpcClient({
      socketPath: fake.socketPath,
      reconnectAttempts: 0,
    });
    cleanups.push(() => client.dispose());
    await expect(client.request<{ ok: boolean }>("ping")).resolves.toEqual({ ok: true });

    chmodSync(fake.socketPath, 0o666);
    await expect(client.request("mode-changed")).rejects.toMatchObject({
      kind: "endpoint",
    });

    chmodSync(fake.socketPath, 0o600);
    const movedPath = `${fake.socketPath}.old`;
    renameSync(fake.socketPath, movedPath);
    const replacement = createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(fake.socketPath, () => resolve());
    });
    chmodSync(fake.socketPath, 0o600);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => replacement.close(() => resolve()));
    });

    await expect(client.request("replaced")).rejects.toMatchObject({
      kind: "endpoint",
    });
  });

  it("socket parent の mode を canonical endpoint として拒否する", async () => {
    const fake = await makeServer((request, socket) => {
      sendResponse(socket, request.id, { ok: true });
    });
    const client = new CodexAppServerRpcClient({
      socketPath: fake.socketPath,
      reconnectAttempts: 0,
    });
    cleanups.push(() => client.dispose());
    await expect(client.request<{ ok: boolean }>("ping")).resolves.toEqual({ ok: true });

    chmodSync(dirname(fake.socketPath), 0o755);
    await expect(client.request("parent-mode-changed")).rejects.toMatchObject({
      kind: "endpoint",
    });
  });
});

describe("CodexAppServerAdapter", () => {
  it("launch/status/transcript/native delivery/interrupt を provider response の粒度で返す", async () => {
    const threadId = "thread-1";
    const sessionId = "session-1";
    const turnId = "turn-1";
    let items: Record<string, unknown>[] = [];
    const fake = await makeServer((request, socket) => {
      switch (request.method) {
        case "initialize":
          sendResponse(socket, request.id, initializePayload());
          break;
        case "thread/start":
          sendResponse(socket, request.id, { thread: threadPayload(threadId, sessionId, turnId) }, true);
          break;
        case "turn/start":
          sendResponse(socket, request.id, { turn: { id: turnId, items: [], status: "inProgress" } });
          break;
        case "thread/read":
          sendResponse(socket, request.id, {
            thread: threadPayload(threadId, sessionId, turnId, items),
          });
          break;
        case "turn/steer": {
          const expected = request.params?.expectedTurnId;
          if (expected !== turnId) {
            sendError(socket, request.id, -32602, "expectedTurnId mismatch");
            break;
          }
          const messageKey = request.params?.clientUserMessageId;
          const input = request.params?.input;
          const firstInput = Array.isArray(input) && typeof input[0] === "object" && input[0] !== null
            ? input[0] as Record<string, unknown>
            : undefined;
          items = [...items, {
            id: `item-${items.length + 1}`,
            type: "userMessage",
            clientId: messageKey,
            content: [{ type: "text", text: firstInput?.text }],
          }];
          sendResponse(socket, request.id, { turnId });
          break;
        }
        case "turn/interrupt":
          sendResponse(socket, request.id, {});
          break;
        default:
          sendError(socket, request.id, -32601, `unknown method ${request.method}`);
      }
    });
    const adapter = new CodexAppServerAdapter({
      socketPath: fake.socketPath,
      autoStart: false,
      reconnectAttempts: 0,
      requestTimeoutMs: 500,
      observeAfterSteer: true,
      now: () => 100,
      hostId: "test-host",
    });
    cleanups.push(() => adapter.dispose());

    const ref = await adapter.launch(fakeTask(), launchOptions());
    expect(ref.nativeCommunication).toMatchObject({
      route: "codex-app-server",
      providerSessionId: sessionId,
      threadId,
      activeTurnId: turnId,
      runtimeVersion: "0.144.1",
      hostId: "test-host",
    });
    expect(ref.nativeCommunication?.route === "codex-app-server"
      ? ref.nativeCommunication.socketSnapshot.canonicalPath
      : undefined).toBe(fake.socketPath);
    expect(ref.nativeCommunication?.capabilityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(ref.modelDelivery).toBe("native");

    await expect(adapter.status(ref)).resolves.toMatchObject({ state: "active", resultCount: 1 });
    const accepted = await adapter.deliver({
      attemptId: "attempt-1",
      attemptNonce: "nonce-1",
      deliveryId: "delivery-1",
      messageKey: "message-1",
      taskId: "task-1",
      runId: 1,
      hachiSessionId: "hachi-session-1",
      expectedCancelFence: 0,
      message: "steer text",
      target: ref.nativeCommunication!,
    });
    expect(accepted.outcome).toBe("session_observed");

    const transcript = await adapter.fetchTranscript(ref);
    expect(transcript).toContain("[user]");
    expect(transcript).toContain("steer text");

    const fresh = await adapter.probe(ref, 100);
    expect(fresh.state).toBe("supported");

    const mismatchRef = {
      ...ref,
      nativeCommunication: { ...ref.nativeCommunication!, activeTurnId: "turn-old" },
    };
    const mismatch = await adapter.deliver({
      attemptId: "attempt-2",
      attemptNonce: "nonce-2",
      deliveryId: "delivery-2",
      messageKey: "message-2",
      taskId: "task-1",
      runId: 1,
      hachiSessionId: "hachi-session-1",
      expectedCancelFence: 0,
      message: "must not duplicate",
      target: mismatchRef.nativeCommunication!,
    });
    expect(mismatch).toMatchObject({ outcome: "rejected" });

    await expect(adapter.interrupt(ref)).resolves.toBeUndefined();
    await expect(adapter.stop(ref)).resolves.toEqual({ stopped: false, reason: "unsupported" });
  });

  it("同じ本文の既存 user item だけでは session_observed に昇格しない", async () => {
    const threadId = "thread-duplicate-text";
    const sessionId = "session-duplicate-text";
    const turnId = "turn-duplicate-text";
    const priorItems: Record<string, unknown>[] = [{
      id: "prior-item",
      type: "userMessage",
      content: [{ type: "text", text: "duplicate text" }],
    }];
    const fake = await makeServer((request, socket) => {
      switch (request.method) {
        case "initialize":
          sendResponse(socket, request.id, initializePayload());
          break;
        case "thread/start":
          sendResponse(socket, request.id, {
            thread: threadPayload(threadId, sessionId, turnId, priorItems),
          });
          break;
        case "turn/start":
          sendResponse(socket, request.id, { turn: { id: turnId, items: [], status: "inProgress" } });
          break;
        case "turn/steer":
          // Provider accepts the steer but the readback only contains a prior item
          // with identical text and no exact client message key.
          sendResponse(socket, request.id, { turnId });
          break;
        case "thread/read":
          sendResponse(socket, request.id, {
            thread: threadPayload(threadId, sessionId, turnId, priorItems),
          });
          break;
        default:
          sendError(socket, request.id, -32601, `unknown method ${request.method}`);
      }
    });
    const adapter = new CodexAppServerAdapter({
      socketPath: fake.socketPath,
      autoStart: false,
      reconnectAttempts: 0,
      requestTimeoutMs: 500,
      observeAfterSteer: true,
      now: () => 100,
      hostId: "test-host",
    });
    cleanups.push(() => adapter.dispose());

    const ref = await adapter.launch(fakeTask(), launchOptions());
    const result = await adapter.deliver({
      attemptId: "attempt-duplicate-text",
      attemptNonce: "nonce-duplicate-text",
      deliveryId: "delivery-duplicate-text",
      messageKey: "new-exact-key",
      taskId: "task-1",
      runId: 1,
      hachiSessionId: "hachi-session-1",
      expectedCancelFence: 0,
      message: "duplicate text",
      target: ref.nativeCommunication!,
    });
    expect(result).toMatchObject({ outcome: "transport_accepted" });
  });

  it("durable socket snapshot は adapter 再起動後の replacement を拒否する", async () => {
    const fake = await makeServer((request, socket) => {
      sendResponse(socket, request.id, { ok: true });
    });
    const bootstrap = new CodexAppServerRpcClient({
      socketPath: fake.socketPath,
      reconnectAttempts: 0,
    });
    await expect(bootstrap.request<{ ok: boolean }>("ping")).resolves.toEqual({ ok: true });
    const snapshot = bootstrap.socketSnapshot;
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      throw new Error("socket snapshot が観測されませんでした");
    }
    bootstrap.dispose();

    renameSync(fake.socketPath, `${fake.socketPath}.old`);
    let replacementRequests = 0;
    const replacement = createServer((socket) => {
      replacementRequests += 1;
      socket.on("data", () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(fake.socketPath, () => resolve());
    });
    chmodSync(fake.socketPath, 0o600);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => replacement.close(() => resolve()));
    });

    const adapter = new CodexAppServerAdapter({
      socketPath: fake.socketPath,
      expectedSocketSnapshot: snapshot,
      autoStart: false,
      reconnectAttempts: 0,
      hostId: "test-host",
      now: () => 100,
    });
    cleanups.push(() => adapter.dispose());
    const result = await adapter.deliver({
      attemptId: "attempt-replacement",
      attemptNonce: "nonce-replacement",
      deliveryId: "delivery-replacement",
      messageKey: "message-replacement",
      taskId: "task-1",
      runId: 1,
      hachiSessionId: "session-1",
      expectedCancelFence: 0,
      message: "must reject replacement",
      target: {
        route: "codex-app-server",
        providerSessionId: "session-1",
        threadId: "thread-1",
        activeTurnId: "turn-1",
        socketSnapshot: snapshot,
        runtimeVersion: "0.144.1",
        capabilityHash: CODEX_APP_SERVER_SCHEMA_CHECKSUM,
        hostId: "test-host",
        observedAt: 1,
        expiresAt: 1000,
      },
    });
    expect(result).toEqual({ outcome: "rejected", detail: "codex_app_server_endpoint" });
    expect(replacementRequests).toBe(0);
  });

  it("schema checksum drift と transport timeout を native route へ昇格させない", async () => {
    const fake = await makeServer((request, socket) => {
      if (request.method === "initialize") {
        sendResponse(socket, request.id, initializePayload());
      }
    });
    const adapter = new CodexAppServerAdapter({
      socketPath: fake.socketPath,
      autoStart: false,
      reconnectAttempts: 0,
      requestTimeoutMs: 25,
      expectedSchemaChecksum: "sha256:drift",
    });
    cleanups.push(() => adapter.dispose());
    const ref = {
      provider: "codex" as const,
      sessionId: "session-1",
      serverUrl: `unix://${fake.socketPath}`,
      model: "gpt-5.5",
      modelDelivery: "native" as const,
      startedAt: 1,
      nativeCommunication: {
        route: "codex-app-server" as const,
        providerSessionId: "session-1",
        threadId: "thread-1",
        activeTurnId: "turn-1",
        socketSnapshot: {
          canonicalPath: fake.socketPath,
          parentCanonicalPath: dirname(fake.socketPath),
          parentDev: 1,
          parentIno: 2,
          parentUid: 501,
          parentMode: 0o700,
          dev: 3,
          ino: 4,
          uid: 501,
          gid: 20,
          mode: 0o600,
        },
        runtimeVersion: "0.144.1",
        capabilityHash: CODEX_APP_SERVER_SCHEMA_CHECKSUM,
        hostId: "test-host",
        observedAt: 1,
        expiresAt: 1000,
      },
    };
    const result = await adapter.deliver({
      attemptId: "attempt-drift",
      attemptNonce: "nonce-drift",
      deliveryId: "delivery-drift",
      messageKey: "message-drift",
      taskId: "task-1",
      runId: 1,
      hachiSessionId: "session-1",
      expectedCancelFence: 0,
      message: "drift",
      target: ref.nativeCommunication,
    });
    expect(result).toMatchObject({ outcome: "rejected" });
    expect(CODEX_APP_SERVER_GENERATED_SCHEMA_SHA256).toBe(
      "092f12a1107c1a156ca85cafca77fb553d9c9846e53a2a744e2f2aef88544f51",
    );
    expect(CODEX_APP_SERVER_SCHEMA_CHECKSUM).toBe(CODEX_APP_SERVER_GENERATED_SCHEMA_SHA256);
    expect(CODEX_APP_SERVER_SCHEMA_FIXTURE_SHA256).toBe(
      "3add4bc60448773f72b571f833da534a4913b6e7c164b434b9243a4836b482e1",
    );
    expect(createHash("sha256").update(JSON.stringify(CODEX_APP_SERVER_SCHEMA_FIXTURE)).digest("hex")).toBe(
      CODEX_APP_SERVER_SCHEMA_FIXTURE_SHA256,
    );
  });

  it("generated v2 schema fixture pin is current and internally consistent", () => {
    const fixture = JSON.parse(readFileSync(GENERATED_SCHEMA_FIXTURE_PATH, "utf8")) as {
      runtimeVersion: string;
      schemaVersion: string;
      source: string;
      file: string;
      sha256: string;
    };
    expect(fixture.runtimeVersion).toBe(CODEX_APP_SERVER_CLI_VERSION);
    expect(fixture.schemaVersion).toBe("v2");
    expect(fixture.source).toBe("codex app-server generate-json-schema --experimental");
    expect(fixture.file).toBe("codex_app_server_protocol.v2.schemas.json");
    expect(fixture.sha256).toBe(CODEX_APP_SERVER_GENERATED_SCHEMA_SHA256);
    expect(CODEX_APP_SERVER_SCHEMA_CHECKSUM).toBe(fixture.sha256);
  });
});
