import { mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeTokenFile } from "@hachi/testing";
import type { RunCancelRequestRow } from "@hachi/core";
import { buildProgram } from "../program.js";
import { createBufferWriter, createTestDeps, type TestDeps } from "../test-support.js";
import {
  createAuthorityStreamRedactor,
  createBridgeAuthorityState,
  createBridgeAuthorityRedactor,
  followBridgeMessages,
  followDirectLog,
} from "./task-logs.js";
import { createBridgeLogFormatterState, type BridgeLogEntry } from "./logs-format.js";

function cancelRow(requestNonce: string, acknowledgedNonce = ""): RunCancelRequestRow {
  return {
    id: `rc_${requestNonce}`,
    taskId: "t_0000000000000001",
    runId: 1,
    sessionId: "worker-session",
    provider: "codex",
    status: "cancel_requested",
    requestNonce,
    actor: "supervisor",
    reason: "停止",
    orchestratorId: "",
    requesterSessionId: "",
    requesterGeneration: null,
    cancelFence: 1,
    deadlineAt: 1,
    acknowledgedNonce,
    capabilitySnapshot: "{}",
    stopEvidence: "{}",
    lastError: "",
    createdAt: 1,
    updatedAt: 1,
    resolvedAt: null,
  };
}

describe("hachi task logs", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
  });

  it("authority stream redactorは2分割・多分割・複数nonceを欠落/重複なくmaskする", () => {
    ctx = createTestDeps();
    const first = "0123456789abcdef";
    const second = "nonce-second-value";
    const stream = createAuthorityStreamRedactor([cancelRow(first), cancelRow(second, second)]);
    const outputs = [
      stream.push(`before-${first.slice(0, 5)}`),
      stream.push(first.slice(5, 11)),
      stream.push(`${first.slice(11)}-middle-${second.slice(0, 2)}`),
      stream.push(second.slice(2, 8)),
      stream.push(`${second.slice(8)}-after`),
      stream.flush(),
    ];

    expect(outputs.join("")).toBe("before-[REDACTED]-middle-[REDACTED]-after");
    expect(outputs.join("")).not.toContain(first.slice(0, 5));
    expect(outputs.join("")).not.toContain(second.slice(0, 8));
  });

  it("authority stream redactorは不完全prefixを最終flushし、secretなしなら即時透過する", () => {
    ctx = createTestDeps();
    const secret = "0123456789abcdef";
    const withSecret = createAuthorityStreamRedactor([cancelRow(secret)]);
    expect(withSecret.push(`prefix-${secret.slice(0, 7)}`)).toBe("prefix-");
    expect(withSecret.flush()).toBe(secret.slice(0, 7));

    const withoutSecret = createAuthorityStreamRedactor([]);
    expect(withoutSecret.push("immediate-output")).toBe("immediate-output");
    expect(withoutSecret.flush()).toBe("");
  });

  it("bridge redactorは同一text_delta burstだけを連結し非delta境界でflush/resetする", () => {
    ctx = createTestDeps();
    const secret = "fedcba9876543210";
    const redactor = createBridgeAuthorityRedactor([cancelRow(secret)]);
    expect(redactor.push([{ id: "1", type: "text_delta", text: `before-${secret.slice(0, 5)}` }])).toEqual([]);
    expect(redactor.push([{ id: "2", type: "text_delta", text: secret.slice(5) }])).toEqual([
      { id: "1", type: "text_delta", text: "before-" },
    ]);
    expect(redactor.push([{ id: "3", type: "status", state: "busy" }])).toEqual([
      { id: "2", type: "text_delta", text: "[REDACTED]" },
      { id: "3", type: "status", state: "busy" },
    ]);

    expect(redactor.push([{ id: "4", type: "text_delta", text: `burst-${secret.slice(0, 5)}` }])).toEqual([]);
    expect(redactor.push([{ id: "5", type: "result", text: "boundary" }])).toEqual([
      { id: "4", type: "text_delta", text: `burst-${secret.slice(0, 5)}` },
      { id: "5", type: "result", text: "boundary" },
    ]);
    expect(redactor.push([{ id: "6", type: "text_delta", text: `${secret.slice(5)}-next` }])).toEqual([]);
    expect(redactor.flush()).toEqual([
      { id: "6", type: "text_delta", text: `${secret.slice(5)}-next` },
    ]);
  });

  it("bridge redactorは明示idleの空pollだけを境界としてprefixを原順序でflushする", () => {
    ctx = createTestDeps();
    const secret = "fedcba9876543210";
    const redactor = createBridgeAuthorityRedactor([cancelRow(secret)]);
    const prefix = secret.slice(0, 5);
    const suffix = secret.slice(5);

    expect(redactor.push([{ id: "1", type: "text_delta", text: `idle-${prefix}` }])).toEqual([]);
    expect(redactor.push([], "busy")).toEqual([]);
    expect(redactor.push([], "unknown")).toEqual([]);
    expect(redactor.push([])).toEqual([]);
    expect(redactor.push([], "idle")).toEqual([
      { id: "1", type: "text_delta", text: `idle-${prefix}` },
    ]);
    expect(redactor.push([{ id: "2", type: "text_delta", text: `${suffix}-next` }])).toEqual([]);
    expect(redactor.push([], "idle")).toEqual([
      { id: "2", type: "text_delta", text: `${suffix}-next` },
    ]);
  });

  it("bridge redactorは空pollなしの連続deltaに跨るnonceをmaskする", () => {
    ctx = createTestDeps();
    const secret = "fedcba9876543210";
    const redactor = createBridgeAuthorityRedactor([cancelRow(secret)]);

    expect(redactor.push([{ id: "1", type: "text_delta", text: secret.slice(0, 5) }])).toEqual([]);
    expect(redactor.push([{ id: "2", type: "text_delta", text: secret.slice(5) }])).toEqual([
      { id: "1", type: "text_delta", text: "" },
    ]);
    expect(redactor.push([], "idle")).toEqual([
      { id: "2", type: "text_delta", text: "[REDACTED]" },
    ]);
  });

  it("bridge raw entryは順序/型/envelopeを保ち最終burstもflushする", () => {
    ctx = createTestDeps();
    const secret = "fedcba9876543210";
    const redactor = createBridgeAuthorityRedactor([cancelRow(secret)]);
    const entries: BridgeLogEntry[] = [
      { id: "1", type: "text_delta", text: secret.slice(0, 8), meta: { keep: true } },
      { id: "2", type: "text_delta", text: secret.slice(8), envelope: { requestNonce: secret } },
    ];
    const first = redactor.push(entries);
    const final = redactor.flush();

    expect([...first, ...final]).toEqual([
      { id: "1", type: "text_delta", text: "", meta: { keep: true } },
      { id: "2", type: "text_delta", text: "[REDACTED]", envelope: { requestNonce: "[REDACTED]" } },
    ]);
  });

  it.each([false, true])(
    "bridge followはbusy/unknown/state欠落の空pollを跨ぐnonceをmaskする(json=%s)",
    async (json) => {
      ctx = createTestDeps();
      const secret = "fedcba9876543210";
      const request = cancelRow(secret);
      ctx.deps.env.bridges.codex = {
        ...ctx.deps.env.bridges.codex,
        tokenFile: writeTokenFile(join(ctx.deps.env.home, `bridge-follow-${json}-token`), "dummy-token"),
      };
      const payloads: Array<Record<string, unknown>> = [
        { state: "busy", messages: [{ id: "1", type: "text_delta", text: secret.slice(0, 5) }] },
        { state: "busy", messages: [] },
        { state: "unknown", messages: [] },
        { messages: [] },
        { state: "busy", messages: [{ id: "2", type: "text_delta", text: secret.slice(5) }] },
        { state: "idle", messages: [] },
      ];
      let poll = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (): Promise<Response> => new Response(JSON.stringify(payloads[poll++] ?? {}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      const stdout = createBufferWriter();
      const deps = { ...ctx.deps, stdout };
      try {
        await followBridgeMessages(
          deps,
          {
            provider: "codex",
            sessionId: "bridge-follow-state",
            serverUrl: "http://127.0.0.1:1",
            model: "gpt-5.6-sol",
            modelDelivery: "native",
            startedAt: 1,
          },
          json,
          new Set<string>(),
          createBridgeLogFormatterState(),
          [request],
          createBridgeAuthorityState([request]),
          {
            sleep: (): Promise<void> => Promise.resolve(),
            control: { shouldContinue: (): boolean => poll < payloads.length },
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(stdout.text()).not.toContain(secret);
      expect(stdout.text()).toContain("[REDACTED]");
      if (json) {
        const entries = stdout.text().trim().split("\n").map((line) => JSON.parse(line) as BridgeLogEntry);
        expect(entries).toEqual([
          { id: "1", type: "text_delta", text: "" },
          { id: "2", type: "text_delta", text: "[REDACTED]" },
        ]);
      } else {
        expect(stdout.text()).toBe("[REDACTED]\n");
      }
    },
  );

  it.each([false, true])(
    "bridge followはidle空pollで偶然のnonce prefixを原順序でflushする(json=%s)",
    async (json) => {
      ctx = createTestDeps();
      const secret = "fedcba9876543210";
      const prefix = secret.slice(0, 5);
      const request = cancelRow(secret);
      ctx.deps.env.bridges.codex = {
        ...ctx.deps.env.bridges.codex,
        tokenFile: writeTokenFile(join(ctx.deps.env.home, `bridge-idle-${json}-token`), "dummy-token"),
      };
      const payloads = [
        { state: "busy", messages: [{ id: "1", type: "text_delta", text: `idle-${prefix}` }] },
        { state: "idle", messages: [] },
      ];
      let poll = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (): Promise<Response> => new Response(JSON.stringify(payloads[poll++] ?? {}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      const stdout = createBufferWriter();
      const deps = { ...ctx.deps, stdout };
      try {
        await followBridgeMessages(
          deps,
          {
            provider: "codex",
            sessionId: "bridge-follow-idle",
            serverUrl: "http://127.0.0.1:1",
            model: "gpt-5.6-sol",
            modelDelivery: "native",
            startedAt: 1,
          },
          json,
          new Set<string>(),
          createBridgeLogFormatterState(),
          [request],
          createBridgeAuthorityState([request]),
          {
            sleep: (): Promise<void> => Promise.resolve(),
            control: { shouldContinue: (): boolean => poll < payloads.length },
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }

      if (json) {
        expect(JSON.parse(stdout.text().trim())).toEqual({ id: "1", type: "text_delta", text: `idle-${prefix}` });
      } else {
        expect(stdout.text()).toBe(`idle-${prefix}\n`);
      }
    },
  );

  it("direct open run は state/direct-sessions/<sessionId>.out を tail する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    ctx.deps.store.startRun(task.id, "codex", "direct-1", {
      serverUrl: "direct",
      model: "gpt-5.5",
      modelDelivery: "native",
      transport: "direct",
    });
    const dir = join(ctx.deps.env.home, "state", "direct-sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "direct-1.out"), "one\ntwo\nthree\n", "utf8");

    await buildProgram(ctx.deps).parseAsync(["task", "logs", task.id, "--tail", "2"], { from: "user" });

    expect(ctx.stdout.text()).toBe("two\nthree\n");
  });

  it("cancel requestがある場合だけログ先頭にtri-state lifecycleを表示しnonceを隠す", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "cwd: /tmp", tenant: "dev", status: "ready" }, "tester");
    const run = ctx.deps.store.startRun(task.id, "codex", "direct-cancel-log", {
      serverUrl: "direct",
      model: "gpt-5.6-sol",
      modelDelivery: "native",
      transport: "direct",
    });
    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "log-owner", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    ctx.deps.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    const request = ctx.deps.store.createOrGetRunCancelRequest({
      taskId: task.id,
      runId: run.id,
      sessionId: run.sessionId,
      provider: run.provider,
      requestNonce: "0123456789abcdef",
      actor: "orchestrator",
      reason: "停止",
      orchestratorId: orchestrator.id,
      requesterSessionId: session.id,
      requesterGeneration: session.generation,
      deadlineAt: 1_700_000_060,
    });
    const dir = join(ctx.deps.env.home, "state", "direct-sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "direct-cancel-log.out"),
      `worker output echo=0123456789abcdef envelope={"requestNonce":"0123456789abcdef"}\n`,
      "utf8",
    );

    await buildProgram(ctx.deps).parseAsync(["task", "logs", task.id, "--json"], { from: "user" });

    const lines = ctx.stdout.text().trim().split("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: "cancel-state",
      cancel: {
        requestId: request.id,
        status: "cancel_requested",
        delivered: "no",
        observed: "unknown",
        acknowledged: "no",
        stopped: "no",
      },
    });
    expect(JSON.parse(lines[1]!)).toEqual({
      line: "worker output echo=[REDACTED] envelope={\"requestNonce\":\"[REDACTED]\"}",
    });
    expect(ctx.stdout.text()).not.toContain("0123456789abcdef");

    const sent = ctx.deps.store.transitionRunCancelRequest({
      requestId: request.id,
      expectedStatus: request.status,
      to: "cooperative_sent",
      expectedRunId: request.runId,
      expectedSessionId: request.sessionId,
      expectedCancelFence: request.cancelFence,
      requestNonce: request.requestNonce,
      actor: "test-cancel-engine",
    });
    const acknowledged = ctx.deps.store.transitionRunCancelRequest({
      requestId: sent.id,
      expectedStatus: sent.status,
      to: "acknowledged",
      expectedRunId: sent.runId,
      expectedSessionId: sent.sessionId,
      expectedCancelFence: sent.cancelFence,
      requestNonce: sent.requestNonce,
      acknowledgedNonce: sent.requestNonce,
      actor: "test-cancel-engine",
    });
    ctx.deps.store.transitionRunCancelRequest({
      requestId: acknowledged.id,
      expectedStatus: acknowledged.status,
      to: "failed",
      expectedRunId: acknowledged.runId,
      expectedSessionId: acknowledged.sessionId,
      expectedCancelFence: acknowledged.cancelFence,
      requestNonce: acknowledged.requestNonce,
      actor: "test-cancel-engine",
      capabilitySnapshot: {
        nested: { detail: "Authorization: Bearer capability-secret /Users/private/My Project/cap-token suffix" },
      },
      stopEvidence: {
        nested: { detail: "token=stop-secret /private/tmp/My Folder/stop-token suffix" },
      },
      lastError: "Authorization: Bearer error-secret /Users/private/Error Folder/error-token suffix",
    });
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "logs", task.id], { from: "user" });
    const text = ctx.stdout.text();
    expect(text).toContain("cancel=failed");
    expect(text).toContain(`requester=${orchestrator.id}/${session.id}`);
    expect(text).toContain(`generation=${session.generation}`);
    expect(text).toContain("deadline=1700000060");
    expect(text).toContain("reason=停止");
    expect(text).toContain("capability=");
    expect(text).toContain("stopEvidence=");
    expect(text).toContain("lastError=");
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("[REDACTED_PATH]");
    expect(text).not.toContain("capability-secret");
    expect(text).not.toContain("stop-secret");
    expect(text).not.toContain("error-secret");
    expect(text).not.toContain("cap-token");
    expect(text).not.toContain("stop-token");
    expect(text).not.toContain("error-token");
    expect(text).not.toContain("0123456789abcdef");
  });

  it("bridge raw/user_prompt/echoの深いenvelopeから全cancel nonceをliteral maskする", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "cwd: /tmp", tenant: "dev", status: "ready" }, "tester");
    const run = ctx.deps.store.startRun(task.id, "codex", "bridge-nonce", {
      serverUrl: "http://127.0.0.1:1",
      model: "gpt-5.6-sol",
      modelDelivery: "native",
      transport: "bridge",
    });
    const request = ctx.deps.store.createOrGetRunCancelRequest({
      taskId: task.id,
      runId: run.id,
      sessionId: run.sessionId,
      provider: run.provider,
      requestNonce: "fedcba9876543210",
      actor: "supervisor",
      reason: "停止",
      deadlineAt: 1_700_000_060,
    });
    ctx.deps.env.bridges.codex = {
      ...ctx.deps.env.bridges.codex,
      tokenFile: writeTokenFile(join(ctx.deps.env.home, "bridge-nonce-token"), "dummy-token"),
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (): Promise<Response> => new Response(JSON.stringify({
      state: "busy",
      messages: [
        {
          id: "1",
          type: "user_prompt",
          text: `cancel ${request.requestNonce}`,
          envelope: { cancel: { requestNonce: request.requestNonce } },
        },
        { id: "2", type: "text_delta", text: `echo ${request.requestNonce.slice(0, 6)}` },
        { id: "3", type: "text_delta", text: request.requestNonce.slice(6, 11) },
        { id: "4", type: "text_delta", text: `${request.requestNonce.slice(11)} echo-safe` },
        { id: "5", type: "result", text: `done ${request.requestNonce}` },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      await buildProgram(ctx.deps).parseAsync(["task", "logs", task.id, "--json"], { from: "user" });
      expect(ctx.stdout.text()).not.toContain(request.requestNonce);
      expect(ctx.stdout.text()).not.toContain(request.requestNonce.slice(0, 6));
      expect(ctx.stdout.text()).not.toContain(request.requestNonce.slice(6, 11));
      expect(ctx.stdout.text()).toContain("[REDACTED]");
      expect(ctx.stdout.text()).toContain("envelope");

      ctx.stdout.clear();
      await buildProgram(ctx.deps).parseAsync(["task", "logs", task.id], { from: "user" });
      const text = ctx.stdout.text();
      expect(text).toContain("[user] cancel [REDACTED]");
      expect(text).toContain("echo [REDACTED] echo-safe");
      expect(text).toContain("[assistant] done [REDACTED]");
      expect(text).not.toContain(request.requestNonce);
      expect(text.match(/\[REDACTED\]/g)).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("direct followでもauthority nonceをmaskしてから共通redactionする", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "cwd: /tmp", tenant: "dev", status: "ready" }, "tester");
    const run = ctx.deps.store.startRun(task.id, "codex", "direct-follow-nonce", { serverUrl: "direct", transport: "direct" });
    const request = ctx.deps.store.createOrGetRunCancelRequest({
      taskId: task.id,
      runId: run.id,
      sessionId: run.sessionId,
      provider: run.provider,
      requestNonce: "0011223344556677",
      actor: "supervisor",
      reason: "停止",
      deadlineAt: 1_700_000_060,
    });
    const path = join(ctx.deps.env.home, "direct-follow-nonce.out");
    writeFileSync(path, "before\n", "utf8");
    const stdout = createBufferWriter();
    const chunks = [
      `echo=${request.requestNonce.slice(0, 5)}`,
      request.requestNonce.slice(5, 11),
      `${request.requestNonce.slice(11)} /Users/private/secret\n`,
    ];
    let polls = 0;
    await followDirectLog(path, stdout, false, {
      sleep: (): Promise<void> => {
        writeFileSync(path, `${readFileSync(path, "utf8")}${chunks[polls] ?? ""}`, "utf8");
        polls += 1;
        return Promise.resolve();
      },
      control: { shouldContinue: (): boolean => polls < chunks.length },
    }, createAuthorityStreamRedactor([request]));
    expect(stdout.text()).toBe("echo=[REDACTED] [REDACTED_PATH]\n");
    expect(stdout.text()).not.toContain(request.requestNonce);
  });

  it.each(["disappear", "truncate", "replace"] as const)(
    "direct followはfile %s境界で旧suffixをflushしgenerationを混線しない",
    async (mode) => {
      ctx = createTestDeps();
      const secret = "fedcba9876543210";
      const path = join(ctx.deps.env.home, `direct-generation-${mode}.out`);
      writeFileSync(path, "seed\n", "utf8");
      const stdout = createBufferWriter();
      const prefix = secret.slice(0, 5);
      const suffix = secret.slice(5);
      let poll = 0;
      const actions: Array<() => void> = [
        () => writeFileSync(path, `${readFileSync(path, "utf8")}old-${prefix}`, "utf8"),
        () => {
          if (mode === "disappear") {
            rmSync(path);
          } else if (mode === "truncate") {
            writeFileSync(path, `${suffix}-new\n`, "utf8");
          } else {
            const replacement = `${path}.replacement`;
            writeFileSync(replacement, `${suffix}-new\n`, "utf8");
            renameSync(replacement, path);
          }
        },
        ...(mode === "disappear" ? [() => writeFileSync(path, `${suffix}-new\n`, "utf8")] : []),
      ];

      await followDirectLog(path, stdout, false, {
        sleep: (): Promise<void> => {
          actions[poll]?.();
          poll += 1;
          return Promise.resolve();
        },
        control: { shouldContinue: (): boolean => poll < actions.length },
      }, createAuthorityStreamRedactor([cancelRow(secret)]));

      expect(stdout.text()).toBe(`old-${prefix}\n[log generation boundary]\n${suffix}-new\n`);
      expect(stdout.text()).not.toContain(secret);
    },
  );

  it("clock rollback時もcancelFence最大のrequestをログ先頭へ表示する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "cwd: /tmp", tenant: "dev", status: "ready" }, "tester");
    const run = ctx.deps.store.startRun(task.id, "codex", "fence-latest", { serverUrl: "direct", transport: "direct" });
    const createAndFail = (nonce: string, reason: string, now: number): void => {
      vi.setSystemTime(now * 1_000);
      const row = ctx.deps.store.createOrGetRunCancelRequest({
        taskId: task.id,
        runId: run.id,
        sessionId: run.sessionId,
        provider: run.provider,
        requestNonce: nonce,
        actor: "supervisor",
        reason,
        deadlineAt: now,
      });
      ctx.deps.store.transitionRunCancelRequest({
        requestId: row.id,
        expectedStatus: row.status,
        to: "failed",
        expectedRunId: row.runId,
        expectedSessionId: row.sessionId,
        expectedCancelFence: row.cancelFence,
        requestNonce: row.requestNonce,
        actor: "test-cancel-engine",
      });
    };
    vi.useFakeTimers();
    try {
      createAndFail("older-fence-nonce", "attempt-old", 1_700_000_200);
      createAndFail("max-fence-nonce", "attempt-max", 1_700_000_100);
    } finally {
      vi.useRealTimers();
    }
    const dir = join(ctx.deps.env.home, "state", "direct-sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "fence-latest.out"),
      "worker older-fence-nonce max-fence-nonce\n",
      "utf8",
    );

    await buildProgram(ctx.deps).parseAsync(["task", "logs", task.id], { from: "user" });

    expect(ctx.stdout.text()).toContain("fence=2");
    expect(ctx.stdout.text()).toContain("reason=attempt-max");
    expect(ctx.stdout.text()).not.toContain("fence=1\n");
    expect(ctx.stdout.text()).not.toContain("older-fence-nonce");
    expect(ctx.stdout.text()).not.toContain("max-fence-nonce");
  });

  it("direct open run は --head と --tail の併用で中間省略を表示する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    ctx.deps.store.startRun(task.id, "codex", "direct-head-tail", {
      serverUrl: "direct",
      model: "gpt-5.5",
      modelDelivery: "native",
      transport: "direct",
    });
    const dir = join(ctx.deps.env.home, "state", "direct-sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "direct-head-tail.out"), "one\ntwo\nthree\nfour\nfive\nsix\n", "utf8");

    await buildProgram(ctx.deps).parseAsync(["task", "logs", task.id, "--head", "2", "--tail", "2"], {
      from: "user",
    });

    expect(ctx.stdout.text()).toBe("one\ntwo\n…(2 行省略)…\nfive\nsix\n");
  });

  it("direct open run は --head 単独なら冒頭行だけを表示する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    ctx.deps.store.startRun(task.id, "codex", "direct-head-only", {
      serverUrl: "direct",
      model: "gpt-5.5",
      modelDelivery: "native",
      transport: "direct",
    });
    const dir = join(ctx.deps.env.home, "state", "direct-sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "direct-head-only.out"), "one\ntwo\nthree\nfour\nfive\nsix\n", "utf8");

    await buildProgram(ctx.deps).parseAsync(["task", "logs", task.id, "--head", "2"], {
      from: "user",
    });

    expect(ctx.stdout.text()).toBe("one\ntwo\n");
  });

  it("direct open run は --tail 0 を明示した場合だけ全量表示する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    ctx.deps.store.startRun(task.id, "codex", "direct-all", {
      serverUrl: "direct",
      model: "gpt-5.5",
      modelDelivery: "native",
      transport: "direct",
    });
    const dir = join(ctx.deps.env.home, "state", "direct-sessions");
    mkdirSync(dir, { recursive: true });
    const lines = Array.from({ length: 45 }, (_value, index) => `line-${index + 1}`);
    writeFileSync(join(dir, "direct-all.out"), `${lines.join("\n")}\n`, "utf8");

    await buildProgram(ctx.deps).parseAsync(["task", "logs", task.id], { from: "user" });
    expect(ctx.stdout.text()).toBe(`${lines.slice(5).join("\n")}\n`);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "logs", task.id, "--tail", "0"], { from: "user" });
    expect(ctx.stdout.text()).toBe(`${lines.join("\n")}\n`);
  });

  it("direct follow は stat+read ポーリングで追記分だけ出力する", async () => {
    ctx = createTestDeps();
    const path = join(ctx.deps.env.home, "direct-follow.out");
    writeFileSync(path, "before\n", "utf8");
    const stdout = createBufferWriter();
    let sleeps = 0;
    let checks = 0;

    await followDirectLog(path, stdout, false, {
      sleep: (): Promise<void> => {
        sleeps += 1;
        if (sleeps === 1) {
          writeFileSync(path, `${readFileSync(path, "utf8")}after\n`, "utf8");
        }
        return Promise.resolve();
      },
      control: {
        shouldContinue: (): boolean => {
          checks += 1;
          return checks <= 2;
        },
      },
    });

    expect(stdout.text()).toBe("after\n");
  });

  it("closed run は最新 transcript artifact にフォールバックし終了済みを明示する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const run = ctx.deps.store.startRun(task.id, "codex", "sess-closed", {
      serverUrl: "http://127.0.0.1:3456",
      model: "gpt-5.5",
      modelDelivery: "none",
    });
    const cancel = ctx.deps.store.createOrGetRunCancelRequest({
      taskId: task.id,
      runId: run.id,
      sessionId: run.sessionId,
      provider: run.provider,
      requestNonce: "89abcdef01234567",
      actor: "supervisor",
      reason: "停止",
      deadlineAt: 1_700_000_060,
    });
    ctx.deps.store.transitionRunCancelRequest({
      requestId: cancel.id,
      expectedStatus: cancel.status,
      to: "failed",
      expectedRunId: cancel.runId,
      expectedSessionId: cancel.sessionId,
      expectedCancelFence: cancel.cancelFence,
      requestNonce: cancel.requestNonce,
      actor: "test-cancel-engine",
    });
    ctx.deps.store.endRun(run.id, "done");
    const dir = join(ctx.deps.env.artifactsDir, task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "transcript-sess-closed.txt"), `a\nb ${cancel.requestNonce}\nc\n`, "utf8");

    await buildProgram(ctx.deps).parseAsync(["task", "logs", task.id, "--tail", "2"], { from: "user" });

    expect(ctx.stdout.text()).toContain("(終了済み run のログ)\n");
    expect(ctx.stdout.text()).toContain("b [REDACTED]\nc\n");
    expect(ctx.stdout.text()).not.toContain(cancel.requestNonce);
  });

  it("closed fallback は transcript-review artifact を除外して worker transcript だけを表示する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const run = ctx.deps.store.startRun(task.id, "codex", "sess-worker", {
      serverUrl: "http://127.0.0.1:3456",
      model: "gpt-5.5",
      modelDelivery: "none",
    });
    ctx.deps.store.endRun(run.id, "done");
    const dir = join(ctx.deps.env.artifactsDir, task.id);
    mkdirSync(dir, { recursive: true });
    const workerPath = join(dir, "transcript-sess-worker.txt");
    const reviewPath = join(dir, "transcript-review-reviewer.txt");
    writeFileSync(workerPath, "worker\n", "utf8");
    writeFileSync(reviewPath, "reviewer\n", "utf8");
    utimesSync(workerPath, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
    utimesSync(reviewPath, new Date("2026-01-02T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z"));

    await buildProgram(ctx.deps).parseAsync(["task", "logs", task.id], { from: "user" });

    expect(ctx.stdout.text()).toBe("(終了済み run のログ)\nworker\n");
  });

  it("run が無いタスクは transcript artifact を tail する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const dir = join(ctx.deps.env.artifactsDir, task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "transcript-manual.txt"), "x\ny\n", "utf8");

    await buildProgram(ctx.deps).parseAsync(["task", "logs", task.id, "--json"], { from: "user" });

    expect(ctx.stdout.text()).toBe(`${JSON.stringify({ line: "x" })}\n${JSON.stringify({ line: "y" })}\n`);
  });

  it("存在しないタスクは fail-closed でエラー終了する", async () => {
    ctx = createTestDeps();

    await buildProgram(ctx.deps).parseAsync(["task", "logs", "t_missing"], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("タスクが見つかりません");
  });

  it("bridge open run は整形後の行を tail する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    ctx.deps.store.startRun(task.id, "codex", "sess-bridge", {
      serverUrl: "http://127.0.0.1:1",
      model: "gpt-5.5",
      modelDelivery: "none",
    });
    ctx.deps.env.bridges.codex = {
      ...ctx.deps.env.bridges.codex,
      tokenFile: writeTokenFile(join(ctx.deps.env.home, "bridge-test-token"), "dummy-token"),
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          state: "idle",
          messages: [
            { id: "1", type: "user_prompt", text: "依頼" },
            { id: "2", type: "text_delta", text: "作" },
            { id: "3", type: "text_delta", text: "業" },
            { id: "4", type: "tool_end", command: "pnpm typecheck" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    try {
      await buildProgram(ctx.deps).parseAsync(["task", "logs", task.id, "--tail", "2"], { from: "user" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(ctx.stdout.text()).toBe("作業\n⚙ pnpm typecheck\n");
  });

  it("bridge open run は整形後の行に --head と --tail を適用する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    ctx.deps.store.startRun(task.id, "codex", "sess-bridge-head", {
      serverUrl: "http://127.0.0.1:1",
      model: "gpt-5.5",
      modelDelivery: "none",
    });
    ctx.deps.env.bridges.codex = {
      ...ctx.deps.env.bridges.codex,
      tokenFile: writeTokenFile(join(ctx.deps.env.home, "bridge-test-token"), "dummy-token"),
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          state: "idle",
          messages: [
            { id: "1", type: "user_prompt", text: "依頼" },
            { id: "2", type: "text_delta", text: "作" },
            { id: "3", type: "text_delta", text: "業" },
            { id: "4", type: "tool_end", command: "pnpm typecheck" },
            { id: "5", type: "status", state: "idle" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    try {
      await buildProgram(ctx.deps).parseAsync(["task", "logs", task.id, "--head", "1", "--tail", "1"], {
        from: "user",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(ctx.stdout.text()).toBe("[user] 依頼\n…(2 行省略)…\nstatus: idle\n");
  });
});
