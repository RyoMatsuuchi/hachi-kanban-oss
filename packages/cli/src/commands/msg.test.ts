import { afterEach, describe, expect, it } from "vitest";
import { parseAgentMessages, type DurableSteerStore } from "@hachi/core";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

describe("hachi msg send", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
  });

  it("agent.message.v1 の正しいフェンスドブロックをコメントとして書き込む（往復検証）", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "親", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(
      [
        "msg",
        "send",
        "--task",
        task.id,
        "--intent",
        "enqueue",
        "--payload",
        JSON.stringify({ title: "子タスク", body: "子の本文", tenant: "dev" }),
        "--from-role",
        "orchestrator",
        "--key",
        "idem-key-1",
        "--json",
      ],
      { from: "user" },
    );

    const comments = ctx.deps.store.listComments(task.id);
    expect(comments).toHaveLength(1);
    expect(JSON.parse(ctx.stdout.text())).toMatchObject({
      id: comments[0]!.id,
      comment: { id: comments[0]!.id, taskId: task.id },
    });

    const { messages, errors } = parseAgentMessages(comments[0]!.body);
    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.schema).toBe("agent.message.v1");
    expect(msg.intent).toBe("enqueue");
    expect(msg.from.role).toBe("orchestrator");
    expect(msg.to.taskId).toBe(task.id);
    expect(msg.idempotencyKey).toBe("idem-key-1");
    expect(msg.payload).toMatchObject({ title: "子タスク", body: "子の本文", tenant: "dev" });
  });

  it("--key 省略時は idempotencyKey が自動生成される", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev", status: "ready" }, "tester");
    ctx.deps.store.startRun(task.id, "codex", "msg-steer-session", { transport: "bridge" });

    await buildProgram(ctx.deps).parseAsync(
      ["msg", "send", "--task", task.id, "--intent", "steer", "--payload", JSON.stringify({ message: "続けて" })],
      { from: "user" },
    );

    const comments = ctx.deps.store.listComments(task.id);
    const { messages } = parseAgentMessages(comments[0]!.body);
    expect(messages[0]?.idempotencyKey.length).toBeGreaterThan(0);
    expect(messages[0]?.payload).toMatchObject({ runId: expect.any(Number), sessionId: "msg-steer-session", cancelFence: 0 });
    const steerStore = ctx.deps.store as typeof ctx.deps.store & DurableSteerStore;
    expect(steerStore.listSteerDeliveries(task.id)).toHaveLength(1);
  });

  it("payload の JSON パース失敗は fail-closed で exit 1", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(
      ["msg", "send", "--task", task.id, "--intent", "escalate", "--payload", "{ invalid json"],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("payload の JSON パースに失敗しました");
    expect(ctx.deps.store.listComments(task.id)).toHaveLength(0);
  });

  it("未知の intent は commander の choices 検証で拒否される", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await expect(
      buildProgram(ctx.deps).parseAsync(
        ["msg", "send", "--task", task.id, "--intent", "not-a-real-intent", "--payload", "{}"],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(ctx.deps.store.listComments(task.id)).toHaveLength(0);
  });

  it("enqueue payload の必須フィールド欠如は fail-closed でエラーになる", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(
      ["msg", "send", "--task", task.id, "--intent", "enqueue", "--payload", JSON.stringify({ title: "x" })],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
  });

  it("payload の自由文フィールド（トップレベル/ネスト1段）は redactText でマスクしてからコメントへ書き込む（docs/contract.md §12.12-3）", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(
      [
        "msg",
        "send",
        "--task",
        task.id,
        "--intent",
        "escalate",
        "--payload",
        JSON.stringify({
          message: "認証は Authorization: Bearer abc123defghi を使ってください",
          detail: { note: "sk-abcdefghijklmnop も併記されています" },
        }),
      ],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([]);
    const comments = ctx.deps.store.listComments(task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).not.toContain("abc123defghi");
    expect(comments[0]?.body).not.toContain("sk-abcdefghijklmnop");
    expect(comments[0]?.body).toContain("[REDACTED]");
  });

  it("payload の自由文フィールドは配列内・任意深さのネストまで再帰的にマスクしてからコメントへ書き込む（docs/contract.md §12.13-2）", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(
      [
        "msg",
        "send",
        "--task",
        task.id,
        "--intent",
        "escalate",
        "--payload",
        JSON.stringify({
          detail: {
            logs: ["Authorization: Bearer abc123defghi...", { nested: { deeper: "sk-abcdefghijklmnop" } }],
          },
        }),
      ],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([]);
    const comments = ctx.deps.store.listComments(task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).not.toContain("abc123defghi");
    expect(comments[0]?.body).not.toContain("sk-abcdefghijklmnop");
    expect(comments[0]?.body).toContain("[REDACTED]");

    const { messages } = parseAgentMessages(comments[0]!.body);
    const detail = messages[0]?.payload.detail as { logs: unknown[] } | undefined;
    expect(Array.isArray(detail?.logs)).toBe(true);
    // redactText の Bearer パターンは [A-Za-z0-9._~+/=-] を貪欲にマッチするため末尾の "..." も含めてマスクされる
    expect(detail?.logs[0]).toBe("Authorization: Bearer [REDACTED]");
    expect((detail?.logs[1] as { nested: { deeper: string } }).nested.deeper).toBe("[REDACTED]");
  });
});
