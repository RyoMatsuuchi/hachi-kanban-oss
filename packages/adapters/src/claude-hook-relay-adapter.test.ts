import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { generateRedactionCases, type RelayIngressEvent, type RelayOwnerFence } from "@hachi/core";
import {
  CLAUDE_HOOK_TOOL_PAYLOAD_MAX_BYTES,
  CLAUDE_HOOK_TOOL_SUMMARY_MAX_BYTES,
  ClaudeHookRelayAdapter,
  createClaudeHookRelaySettings,
  redactClaudeHookRelayText,
  type ClaudeHookEnableRecord,
  type ClaudeHookRelayEmitter,
} from "./claude-hook-relay-adapter.js";

function isAlreadyStructuredSerializedJsonInput(input: string): boolean {
  try {
    const parsed = JSON.parse(input) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>)["alreadyStructured"] === "[REDACTED]";
  } catch {
    return false;
  }
}

const OWNER: RelayOwnerFence = {
  sessionId: "hachi-session-a",
  providerSessionId: "claude-session-a",
  provider: "claude",
  serverUrl: "http://127.0.0.1:3457",
  host: "host-a",
  evenTerminalBootEpoch: "boot-a",
  handoverGeneration: 7,
  relayId: "relay-a",
  fencingToken: 3,
};

const ENABLE_RECORD: ClaudeHookEnableRecord = {
  sessionId: OWNER.sessionId,
  providerSessionId: OWNER.providerSessionId,
  handoverGeneration: OWNER.handoverGeneration,
  relayId: OWNER.relayId,
  expiresAt: 2_000,
};

function common(hookEventName: string): Record<string, unknown> {
  return {
    session_id: OWNER.providerSessionId,
    transcript_path: "/not-forwarded/transcript.jsonl",
    cwd: "/not-forwarded/worktree",
    prompt_id: "prompt-a",
    hook_event_name: hookEventName,
  };
}

function recordingEmitter(): {
  emitter: ClaudeHookRelayEmitter;
  events: RelayIngressEvent[];
  unregistered: RelayOwnerFence[];
} {
  const events: RelayIngressEvent[] = [];
  const unregistered: RelayOwnerFence[] = [];
  return {
    emitter: {
      async emit(event: RelayIngressEvent): Promise<void> {
        events.push(event);
      },
      async unregister(owner: RelayOwnerFence): Promise<void> {
        unregistered.push(owner);
      },
    },
    events,
    unregistered,
  };
}

function adapterWith(
  emitter: ClaudeHookRelayEmitter,
  readEnableRecord: () => unknown = () => ENABLE_RECORD,
  timeoutMs = 250,
): ClaudeHookRelayAdapter {
  return new ClaudeHookRelayAdapter({
    owner: OWNER,
    readEnableRecord,
    emitter,
    timeoutMs,
    now: () => 1_000,
  });
}

describe("ClaudeHookRelayAdapter hook mapping", () => {
  it("各 hook を event kind へ変換し、SessionEnd は登録解除する", async () => {
    const recorded = recordingEmitter();
    const adapter = adapterWith(recorded.emitter);

    await expect(adapter.handle({ ...common("SessionStart"), source: "startup" }))
      .resolves.toEqual({ status: "sent", eventCount: 1 });
    await adapter.handle({
      ...common("PreToolUse"),
      tool_name: "Bash",
      tool_input: { command: "printf secret-argument" },
      tool_use_id: "tool-a",
    });
    await adapter.handle({
      ...common("PostToolUse"),
      tool_name: "Bash",
      tool_input: { command: "printf secret-argument" },
      tool_response: {
        stdout: "ok",
        stderr: "",
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
      tool_use_id: "tool-a",
      duration_ms: 12,
    });
    await adapter.handle({
      ...common("PostToolUseFailure"),
      tool_name: "Bash",
      tool_input: { command: "exit 7" },
      tool_use_id: "tool-b",
      error: "Exit code 7",
      is_interrupt: false,
      duration_ms: 9,
    });
    await adapter.handle({
      ...common("MessageDisplay"),
      turn_id: "turn-a",
      message_id: "message-a",
      index: 0,
      final: true,
      delta: "ALPHA\nBETA\nGAMMA",
    });
    await expect(adapter.handle({
      ...common("Stop"),
      stop_hook_active: false,
      last_assistant_message: "ALPHA\nBETA\nGAMMA",
    })).resolves.toEqual({ status: "sent", eventCount: 2 });
    await adapter.handle({
      ...common("Notification"),
      notification_type: "permission_prompt",
      message: "Claude needs your permission to use Bash",
      title: "Permission needed",
    });
    await adapter.handle({
      ...common("StopFailure"),
      error: "rate_limit",
      error_details: "429 Too Many Requests",
      last_assistant_message: "API Error: Rate limit reached",
    });
    await expect(adapter.handle({ ...common("SessionEnd"), reason: "other" }))
      .resolves.toEqual({ status: "unregistered" });

    expect(recorded.events.map((event) => event.kind)).toEqual([
      "status",
      "tool_start",
      "tool_end",
      "tool_end",
      "text_delta",
      "result",
      "status",
      "permission_request",
      "error",
    ]);
    expect(recorded.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(recorded.events[7]?.payload).toMatchObject({ displayOnly: true });
    expect(recorded.events[8]?.payload).toMatchObject({ code: "rate_limit" });
    expect(recorded.unregistered).toEqual([OWNER]);

    const serialized = JSON.stringify(recorded.events);
    expect(serialized).not.toContain("secret-argument");
    expect(serialized).not.toContain("transcript.jsonl");
  });

  it("MessageDisplay が無い Stop は text / result / status を順に補う", async () => {
    const recorded = recordingEmitter();
    const adapter = adapterWith(recorded.emitter);

    await expect(adapter.handle({
      ...common("Stop"),
      last_assistant_message: "fallback response",
    })).resolves.toEqual({ status: "sent", eventCount: 3 });

    expect(recorded.events.map((event) => event.kind)).toEqual(["text", "result", "status"]);
    expect(recorded.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("permission_prompt 以外の Notification は表示 event にしない", async () => {
    const recorded = recordingEmitter();
    const adapter = adapterWith(recorded.emitter);

    await expect(adapter.handle({
      ...common("Notification"),
      notification_type: "idle_prompt",
      message: "Claude is waiting",
    })).resolves.toEqual({ status: "ignored", reason: "unsupported" });
    expect(recorded.events).toEqual([]);
  });
});

describe("ClaudeHookRelayAdapter ordering", () => {
  it("先行 async hook の送信が遅くても後続 hook を追い越さず、予約済み sequence を保つ", async () => {
    const events: RelayIngressEvent[] = [];
    let releaseFirst: () => void = () => {
      throw new Error("先行 emitter の release が初期化されませんでした");
    };
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const emitter: ClaudeHookRelayEmitter = {
      async emit(event: RelayIngressEvent): Promise<void> {
        events.push(event);
        if (event.sequence === 1) await firstBlocked;
      },
      async unregister(): Promise<void> {},
    };
    const adapter = adapterWith(emitter);

    const pre = adapter.handle({
      ...common("PreToolUse"),
      tool_name: "Bash",
      tool_use_id: "tool-ordered",
    });
    const post = adapter.handle({
      ...common("PostToolUse"),
      tool_name: "Bash",
      tool_use_id: "tool-ordered",
      tool_response: { stdout: "done" },
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ kind: "tool_start", sequence: 1 });

    releaseFirst();
    await Promise.all([pre, post]);

    expect(events).toMatchObject([
      { kind: "tool_start", sequence: 1, toolId: "tool-ordered" },
      { kind: "tool_end", sequence: 2, toolId: "tool-ordered" },
    ]);
  });
});

describe("ClaudeHookRelayAdapter §79 redaction cases", () => {
  it.each(generateRedactionCases())("$id", (redactionCase) => {
    const redacted = redactClaudeHookRelayText(redactionCase.input);
    for (const secret of redactionCase.secrets) {
      expect(redacted).not.toContain(secret);
    }
    if (isAlreadyStructuredSerializedJsonInput(redactionCase.input)) {
      expect(() => JSON.parse(redacted) as unknown).not.toThrow();
    }
    if (redactionCase.id.startsWith("secretInObjectKeyJson/")) {
      const parsed = JSON.parse(redacted) as { nested?: unknown };
      expect(parsed.nested).toBeTypeOf("object");
      expect((parsed.nested as Record<string, unknown>).publicSibling).toBe("preserved");
      for (const secret of redactionCase.secrets) {
        expect(redacted).not.toContain(secret);
      }
    }
  });

  it("key のマスク結果が衝突しても suffix で全要素を保持する", () => {
    const input = JSON.stringify({
      "sk-objectkeyvalue111": "first",
      "sk-objectkeyvalue222": "second",
      "[REDACTED]": "third",
    });
    const redacted = JSON.parse(redactClaudeHookRelayText(input)) as Record<string, unknown>;
    expect(Object.keys(redacted)).toEqual(["[REDACTED]", "[REDACTED]#2", "[REDACTED]#3"]);
    expect(Object.values(redacted)).toEqual(["first", "second", "third"]);
  });
});

describe("ClaudeHookRelayAdapter tool result safety", () => {
  it("tool_result は許可 field の1行要約だけを残し、secret を redact して byte 上限に収める", async () => {
    const recorded = recordingEmitter();
    const adapter = adapterWith(recorded.emitter);
    const bearerSecret = "relay-super-secret-value";
    const apiKeySecret = "plain-private-api-key-value";
    const unknownSecret = "unknown-field-must-not-pass";

    await adapter.handle({
      ...common("PostToolUse"),
      tool_name: "Bash",
      tool_use_id: "tool-safe",
      tool_input: { command: `curl -H Authorization:${bearerSecret}` },
      tool_response: {
        stdout: `first line\nAuthorization: Bearer ${bearerSecret}\nAPI_KEY=${apiKeySecret}\n${"x".repeat(20_000)}`,
        stderr: "warning line",
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
        raw: unknownSecret,
      },
      duration_ms: 15,
    });

    const event = recorded.events[0];
    expect(event?.kind).toBe("tool_end");
    const serialized = JSON.stringify(event?.payload);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(CLAUDE_HOOK_TOOL_PAYLOAD_MAX_BYTES);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain(bearerSecret);
    expect(serialized).not.toContain(apiKeySecret);
    expect(serialized).not.toContain(unknownSecret);
    expect(serialized).not.toContain("curl -H");
    expect((event?.payload as { summary: string }).summary).not.toMatch(/[\r\n]/);
  });

  it.each([
    ["Basic", "dXNlcjpwYXNz"],
    ["Bearer", "bearer-credential-value"],
    ["Token", "token-credential-value"],
    ["Foo", "unknown-scheme-credential-value"],
  ])("Authorization: %s の値を行末まで残さない", async (scheme, credential) => {
    const recorded = recordingEmitter();
    const adapter = adapterWith(recorded.emitter);

    await adapter.handle({
      ...common("PostToolUse"),
      tool_name: "Bash",
      tool_use_id: `tool-authorization-${scheme}`,
      tool_response: {
        stdout: `Authorization: ${scheme} ${credential}\nvisible next line`,
      },
    });

    const payload = recorded.events[0]?.payload as {
      summary: string;
      summaryRedacted: boolean;
    };
    expect(payload.summary).toBe("stdout: Authorization: [REDACTED] visible next line");
    expect(payload.summary).not.toContain(scheme);
    expect(payload.summary).not.toContain(credential);
    expect(payload.summaryRedacted).toBe(true);
  });

  it("JSON の Authorization 値に escaped quote があっても閉じ引用符まで残さない", async () => {
    const recorded = recordingEmitter();
    const adapter = adapterWith(recorded.emitter);
    const credentialBeforeQuote = "credential-before-escaped-quote";
    const credentialAfterQuote = "credential-after-escaped-quote";

    await adapter.handle({
      ...common("PostToolUse"),
      tool_name: "Bash",
      tool_use_id: "tool-authorization-escaped-quote",
      tool_response: {
        stdout: `{"Authorization":"Foo ${credentialBeforeQuote}\\\"${credentialAfterQuote}","visible":true}`,
      },
    });

    const payload = recorded.events[0]?.payload as {
      summary: string;
      summaryRedacted: boolean;
    };
    expect(payload.summary).toBe('stdout: {"Authorization":[REDACTED]');
    expect(payload.summary).not.toContain(credentialBeforeQuote);
    expect(payload.summary).not.toContain(credentialAfterQuote);
    expect(payload.summaryRedacted).toBe(true);
  });

  it("JSON credential の api_key と password を値ごと残さない", async () => {
    const recorded = recordingEmitter();
    const adapter = adapterWith(recorded.emitter);
    const apiKey = "json-api-key-secret";
    const password = "json-password-secret";

    await adapter.handle({
      ...common("PostToolUse"),
      tool_name: "Bash",
      tool_use_id: "tool-json-credentials",
      tool_response: {
        stdout: `{"api_key":"${apiKey}","password":"${password}","visible":true}`,
      },
    });

    const payload = recorded.events[0]?.payload as {
      summary: string;
      summaryRedacted: boolean;
    };
    expect(payload.summary).toBe('stdout: {"api_key":[REDACTED]');
    expect(payload.summary).not.toContain(apiKey);
    expect(payload.summary).not.toContain(password);
    expect(payload.summaryRedacted).toBe(true);
  });

  it("escaped quote を含む JSON credential も閉じ引用符まで残さない", async () => {
    const recorded = recordingEmitter();
    const adapter = adapterWith(recorded.emitter);
    const credentialBeforeQuote = "json-credential-before-escaped-quote";
    const credentialAfterQuote = "json-credential-after-escaped-quote";

    await adapter.handle({
      ...common("PostToolUse"),
      tool_name: "Bash",
      tool_use_id: "tool-json-credential-escaped-quote",
      tool_response: {
        stdout: `{"api_key":"${credentialBeforeQuote}\\\"${credentialAfterQuote}","visible":true}`,
      },
    });

    const payload = recorded.events[0]?.payload as {
      summary: string;
      summaryRedacted: boolean;
    };
    expect(payload.summary).toBe('stdout: {"api_key":[REDACTED]');
    expect(payload.summary).not.toContain(credentialBeforeQuote);
    expect(payload.summary).not.toContain(credentialAfterQuote);
    expect(payload.summaryRedacted).toBe(true);
  });

  it("escaped quote を含む assignment credential は閉じ引用符まで残さない", async () => {
    const recorded = recordingEmitter();
    const adapter = adapterWith(recorded.emitter);
    const credentialBeforeQuote = "assignment-credential-before-escaped-quote";
    const credentialAfterQuote = "assignment-credential-after-escaped-quote";

    await adapter.handle({
      ...common("PostToolUse"),
      tool_name: "Bash",
      tool_use_id: "tool-assignment-credential-escaped-quote",
      tool_response: {
        stdout: `api_key="${credentialBeforeQuote}\\"${credentialAfterQuote}" visible=true`,
      },
    });

    const payload = recorded.events[0]?.payload as {
      summary: string;
      summaryRedacted: boolean;
    };
    expect(payload.summary).toBe("stdout: api_key=[REDACTED]");
    expect(payload.summary).not.toContain(credentialBeforeQuote);
    expect(payload.summary).not.toContain(credentialAfterQuote);
    expect(payload.summaryRedacted).toBe(true);
  });

  it("credential URL の userinfo を残さない", async () => {
    const recorded = recordingEmitter();
    const adapter = adapterWith(recorded.emitter);
    const user = "admin";
    const password = "db-password-123";

    await adapter.handle({
      ...common("PostToolUse"),
      tool_name: "Bash",
      tool_use_id: "tool-credential-url",
      tool_response: {
        stdout: `DATABASE_URL=postgresql://${user}:${password}@example.test/db visible=true`,
      },
    });

    const payload = recorded.events[0]?.payload as {
      summary: string;
      summaryRedacted: boolean;
    };
    expect(payload.summary).toBe("stdout: DATABASE_URL=[REDACTED]");
    expect(payload.summary).not.toContain(user);
    expect(payload.summary).not.toContain(password);
    expect(payload.summaryRedacted).toBe(true);
  });

  it("8 KiB を超える PEM private key を終端 marker の有無にかかわらず残さない", async () => {
    const privateKeyBody = "private-key-material".repeat(512);

    for (const endMarker of ["\n-----END PRIVATE KEY-----\nvisible-after-key", ""]) {
      const recorded = recordingEmitter();
      const adapter = adapterWith(recorded.emitter);
      await adapter.handle({
        ...common("PostToolUse"),
        tool_name: "Bash",
        tool_use_id: `tool-long-pem-${endMarker === "" ? "unterminated" : "terminated"}`,
        tool_response: {
          stdout: `-----BEGIN PRIVATE KEY-----\n${privateKeyBody}${endMarker}`,
        },
      });

      const payload = recorded.events[0]?.payload as {
        summary: string;
        summaryRedacted: boolean;
      };
      expect(payload.summary).toContain("[REDACTED]");
      expect(payload.summary).not.toContain("BEGIN PRIVATE KEY");
      expect(payload.summary).not.toContain("private-key-material");
      expect(payload.summaryRedacted).toBe(true);
    }
  });

  it("scan truncate 境界を跨ぐ PEM private key を部分的にも残さない", async () => {
    const recorded = recordingEmitter();
    const adapter = adapterWith(recorded.emitter);
    const beginMarker = "-----BEGIN PRIVATE KEY-----";
    const scanContentBytes = CLAUDE_HOOK_TOOL_SUMMARY_MAX_BYTES * 8
      - Buffer.byteLength("…[truncated]", "utf8");
    const whitespacePrefix = "\n".repeat(
      scanContentBytes - Buffer.byteLength("stdout: ", "utf8") - Math.floor(beginMarker.length / 2),
    );

    await adapter.handle({
      ...common("PostToolUse"),
      tool_name: "Bash",
      tool_use_id: "tool-scan-boundary-pem",
      tool_response: {
        stdout: `${whitespacePrefix}${beginMarker}\nboundary-private-key-material\n-----END PRIVATE KEY-----`,
      },
    });

    const payload = recorded.events[0]?.payload as {
      summary: string;
      summaryRedacted: boolean;
    };
    expect(payload.summary).toBe("stdout: [REDACTED]");
    expect(payload.summary).not.toContain("BEGIN PRIVATE KEY");
    expect(payload.summary).not.toContain("boundary-private-key-material");
    expect(payload.summaryRedacted).toBe(true);
  });
});

describe("ClaudeHookRelayAdapter enable gate", () => {
  it("session/provider/generation/relay/期限のどれかが不一致なら局所 read のみで終了する", async () => {
    const records: unknown[] = [
      { ...ENABLE_RECORD, sessionId: "other-session" },
      { ...ENABLE_RECORD, providerSessionId: "other-provider-session" },
      { ...ENABLE_RECORD, handoverGeneration: ENABLE_RECORD.handoverGeneration + 1 },
      { ...ENABLE_RECORD, relayId: "other-relay" },
      { ...ENABLE_RECORD, expiresAt: 1_000 },
      { ...ENABLE_RECORD, expiresAt: 999 },
    ];
    let emitCount = 0;
    let unregisterCount = 0;
    const emitter: ClaudeHookRelayEmitter = {
      async emit(): Promise<void> {
        emitCount += 1;
      },
      async unregister(): Promise<void> {
        unregisterCount += 1;
      },
    };

    for (const record of records) {
      let localReads = 0;
      const adapter = adapterWith(emitter, () => {
        localReads += 1;
        return record;
      });
      await expect(adapter.handle({ ...common("SessionStart"), source: "startup" }))
        .resolves.toEqual({ status: "ignored", reason: "not-enabled" });
      expect(localReads).toBe(1);
    }
    const providerPayloadMismatch = adapterWith(emitter);
    await expect(providerPayloadMismatch.handle({
      ...common("SessionStart"),
      session_id: "other-provider-session",
      source: "startup",
    })).resolves.toEqual({ status: "ignored", reason: "not-enabled" });

    expect(emitCount).toBe(0);
    expect(unregisterCount).toBe(0);
  });
});

describe("ClaudeHookRelayAdapter relay timeout", () => {
  it("relay が応答しなくても短い timeout で hook を解放する", async () => {
    vi.useFakeTimers();
    try {
      let emitCount = 0;
      const emitter: ClaudeHookRelayEmitter = {
        async emit(): Promise<void> {
          emitCount += 1;
          await new Promise<void>(() => {});
        },
        async unregister(): Promise<void> {},
      };
      const adapter = adapterWith(emitter, () => ENABLE_RECORD, 20);
      const outcome = adapter.handle({
        ...common("PreToolUse"),
        tool_name: "Bash",
        tool_use_id: "tool-timeout",
      });
      const queuedOutcome = adapter.handle({
        ...common("PostToolUse"),
        tool_name: "Bash",
        tool_use_id: "tool-timeout",
        tool_response: { stdout: "late" },
      });

      await vi.advanceTimersByTimeAsync(20);
      await expect(outcome).resolves.toEqual({ status: "timed_out", action: "emit" });
      await expect(queuedOutcome).resolves.toEqual({ status: "timed_out", action: "emit" });
      expect(emitCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createClaudeHookRelaySettings", () => {
  it("全 emitter を async:true にし、permission は Notification 表示だけに限定する", () => {
    const settings = createClaudeHookRelaySettings("/opt/hachi/bin/claude-hook-relay", 1);
    const entries = Object.entries(settings.hooks);

    expect(entries.flatMap(([, groups]) => groups.flatMap((group) => group.hooks)))
      .toSatisfy((hooks: Array<{ async: boolean }>) => hooks.every((hook) => hook.async === true));
    expect(settings.hooks.Notification).toMatchObject([{ matcher: "permission_prompt" }]);
    expect(settings.hooks).not.toHaveProperty("PermissionRequest");
  });
});
