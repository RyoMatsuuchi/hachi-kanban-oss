import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWebToken, formatFileMode, webTokenPath, type WebTokenWarnFields } from "./write-auth.js";

describe("ensureWebToken", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function makeHome(): string {
    tempDir = mkdtempSync(join(tmpdir(), "hachi-web-token-"));
    return tempDir;
  }

  it("無ければ 32byte hex token を wx 生成し mode 0600 にする", () => {
    const home = makeHome();

    const token = ensureWebToken(home);
    const filePath = webTokenPath(home);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(filePath, "utf8")).toBe(token);
    expect(formatFileMode(statSync(filePath).mode)).toBe("0600");
  });

  it("既存ファイルは上書きしない", () => {
    const home = makeHome();
    const filePath = webTokenPath(home);
    writeFileSync(filePath, "existing-web-token", { mode: 0o600 });
    chmodSync(filePath, 0o600);

    const token = ensureWebToken(home);

    expect(token).toBe("existing-web-token");
    expect(readFileSync(filePath, "utf8")).toBe("existing-web-token");
  });

  it("既存 mode が 0600 以外なら token 値を含まない warn を出す", () => {
    const home = makeHome();
    const filePath = webTokenPath(home);
    const secretToken = "secret-web-token-value";
    writeFileSync(filePath, secretToken, { mode: 0o644 });
    chmodSync(filePath, 0o644);
    const warnings: Array<{ message: string; fields: WebTokenWarnFields }> = [];

    const token = ensureWebToken(home, (message, fields) => {
      warnings.push({ message, fields });
    });

    expect(token).toBe(secretToken);
    expect(warnings).toEqual([
      {
        message: "web-token mode is not 0600",
        fields: { path: filePath, mode: "0644", expectedMode: "0600" },
      },
    ]);
    expect(JSON.stringify(warnings)).not.toContain(secretToken);
  });
});
