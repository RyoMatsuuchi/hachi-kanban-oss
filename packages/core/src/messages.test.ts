import { describe, expect, it } from "vitest";
import {
  parseAgentMessages,
  parseEnqueuePayload,
  parseSteerPayload,
  serializeAgentMessage,
} from "./messages.js";
import type { AgentMessageV1 } from "./types.js";

function buildMessage(overrides: Partial<AgentMessageV1> = {}): AgentMessageV1 {
  return {
    schema: "agent.message.v1",
    from: { role: "worker", provider: "codex", sessionId: "sess-1" },
    to: { role: "orchestrator", taskId: "t_00000000" },
    intent: "enqueue",
    payload: { title: "子タスク", body: "本文", tenant: "dev" },
    idempotencyKey: "idem-key-1",
    createdAt: 1_700_000_000,
    ...overrides,
  };
}

describe("serializeAgentMessage / parseAgentMessages", () => {
  it("シリアライズしたブロックをそのままパースできる（往復一致）", () => {
    const msg = buildMessage();
    const serialized = serializeAgentMessage(msg);
    expect(serialized).toContain("```agent-message-v1");

    const { messages, errors } = parseAgentMessages(`前置きコメント\n\n${serialized}\n\n後書き`);
    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(msg);
  });

  it("複数ブロックを全て抽出する", () => {
    const first = buildMessage({ idempotencyKey: "idem-1" });
    const second = buildMessage({ idempotencyKey: "idem-2", intent: "steer", payload: { message: "続けて" } });
    const body = `${serializeAgentMessage(first)}\n\n${serializeAgentMessage(second)}`;

    const { messages, errors } = parseAgentMessages(body);
    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.idempotencyKey)).toEqual(["idem-1", "idem-2"]);
  });

  it("JSON として不正なブロックは messages に含めず errors に積む（fail-closed）", () => {
    const body = "```agent-message-v1\n{ not valid json\n```";
    const { messages, errors } = parseAgentMessages(body);
    expect(messages).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toMatch(/JSON パース/);
  });

  it("スキーマ不整合なブロックは messages に含めず errors に積む（fail-closed）", () => {
    const body = '```agent-message-v1\n{"schema":"agent.message.v1","intent":"enqueue"}\n```';
    const { messages, errors } = parseAgentMessages(body);
    expect(messages).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toMatch(/スキーマ検証/);
  });

  it("フェンスブロックが無ければ空配列を返す", () => {
    const { messages, errors } = parseAgentMessages("ただのコメント本文");
    expect(messages).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("正常ブロックと不正ブロックが混在しても正常分だけ抽出する", () => {
    const good = serializeAgentMessage(buildMessage());
    const bad = "```agent-message-v1\n{ broken\n```";
    const { messages, errors } = parseAgentMessages(`${good}\n\n${bad}`);
    expect(messages).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});

describe("parseEnqueuePayload", () => {
  it("必須フィールドのみの payload を検証する", () => {
    const result = parseEnqueuePayload({ title: "t", body: "b", tenant: "dev" });
    expect(result).toEqual({ title: "t", body: "b", tenant: "dev" });
  });

  it("profile / priority を含む payload も検証する", () => {
    const result = parseEnqueuePayload({ title: "t", body: "b", tenant: "dev", profile: "docs", priority: 5 });
    expect(result).toEqual({ title: "t", body: "b", tenant: "dev", profile: "docs", priority: 5 });
  });

  it("title が空文字なら throw する（fail-closed）", () => {
    expect(() => parseEnqueuePayload({ title: "", body: "b", tenant: "dev" })).toThrow(/検証に失敗/);
  });

  it("必須フィールド欠落は throw する（fail-closed）", () => {
    expect(() => parseEnqueuePayload({ title: "t" })).toThrow();
  });
});

describe("parseSteerPayload", () => {
  it("message を含む payload を検証する", () => {
    expect(parseSteerPayload({ message: "続けてください" })).toEqual({ message: "続けてください" });
  });

  it("message が空文字なら throw する（fail-closed）", () => {
    expect(() => parseSteerPayload({ message: "" })).toThrow();
  });

  it("message が欠落していれば throw する（fail-closed）", () => {
    expect(() => parseSteerPayload({})).toThrow();
  });
});
