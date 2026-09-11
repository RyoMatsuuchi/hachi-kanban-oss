import { describe, expect, it } from "vitest";
import {
  createBridgeLogFormatterState,
  formatBridgeLogEntries,
  serializeRawBridgeEntry,
} from "./logs-format.js";

describe("task logs bridge formatter", () => {
  it("text_delta を結合し、status は state 変化のみ、tool_end は command 先頭80字で表示する", () => {
    const result = formatBridgeLogEntries(
      [
        { id: "1", type: "status", state: "busy" },
        { id: "2", type: "status", state: "busy" },
        { id: "3", type: "text_delta", text: "hel" },
        { id: "4", type: "text_delta", text: "lo" },
        {
          id: "5",
          type: "tool_end",
          command: "pnpm test -- --runInBand --long-option abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz",
        },
        { id: "6", type: "status", state: "idle" },
      ],
      createBridgeLogFormatterState(),
    );

    expect(result.lines).toEqual([
      "status: busy",
      "hello",
      "⚙ pnpm test -- --runInBand --long-option abcdefghijklmnopqrstuvwxyz abcdefghijklmn",
      "status: idle",
    ]);
  });

  it("raw JSON line は文字列 leaf を redact する", () => {
    const line = serializeRawBridgeEntry({
      id: "1",
      type: "result",
      text: "Authorization: Bearer secret-token and sk-secret12345678",
    });

    expect(line).toContain("Bearer [REDACTED]");
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("secret-token");
    expect(line).not.toContain("sk-secret12345678");
  });
});
