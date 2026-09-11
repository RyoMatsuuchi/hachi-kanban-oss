import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexLedger } from "./codex-ledger.js";

describe("readCodexLedger", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function fixturePath(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "hachi-codex-ledger-"));
    tempDirs.push(dir);
    const path = join(dir, "auth.json");
    writeFileSync(path, content, "utf8");
    return path;
  }

  it("chatgpt mode かつ空の API key は chatgpt 台帳だけを返す", () => {
    const secret = "refresh-token-must-not-leak";
    const ledger = readCodexLedger(fixturePath(JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { refresh_token: secret },
    })));

    expect(ledger).toBe("chatgpt");
    expect(JSON.stringify(ledger)).not.toContain(secret);
  });

  it("API key が非空なら値を露出せず api 台帳を返す", () => {
    const secret = "sk-test-must-not-leak";
    const ledger = readCodexLedger(fixturePath(JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: secret,
    })));

    expect(ledger).toBe("api");
    expect(JSON.stringify(ledger)).not.toContain(secret);
  });

  it.each([
    ["必須 field 欠如", JSON.stringify({ auth_mode: "chatgpt" })],
    ["不正 JSON", "{\"auth_mode\":\"chatgpt\",\"token\":\"must-not-leak\""],
  ])("%s は例外や値を返さず unknown に閉じる", (_label, content) => {
    const path = fixturePath(content);
    expect(() => readCodexLedger(path)).not.toThrow();
    expect(readCodexLedger(path)).toBe("unknown");
    expect(JSON.stringify(readCodexLedger(path))).not.toContain("must-not-leak");
  });
});
