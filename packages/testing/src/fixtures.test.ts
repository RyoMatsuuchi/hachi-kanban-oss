import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempHome, taskInput, writeTokenFile } from "./fixtures.js";

describe("makeTempHome", () => {
  it("docs/contract.md §3 のレイアウトを構築し、Environment を返す", () => {
    const { home, env, cleanup } = makeTempHome();
    try {
      expect(existsSync(join(home, "boards", "dev"))).toBe(true);
      expect(existsSync(join(home, "artifacts"))).toBe(true);

      expect(env.home).toBe(home);
      expect(env.board).toBe("dev");
      expect(env.dbPath).toBe(join(home, "boards", "dev", "kanban.db"));
      expect(env.artifactsDir).toBe(join(home, "artifacts"));

      expect(existsSync(env.bridges.codex.tokenFile)).toBe(true);
      expect(existsSync(env.bridges.claude.tokenFile)).toBe(true);
      expect(env.bridges.codex.tokenFile).not.toBe(env.bridges.claude.tokenFile);
      expect(env.bridges.codex.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(env.bridges.claude.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    } finally {
      cleanup();
    }
    expect(existsSync(home)).toBe(false);
  });

  it("呼び出すたびに一意なディレクトリを作る", () => {
    const first = makeTempHome();
    const second = makeTempHome();
    try {
      expect(first.home).not.toBe(second.home);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });
});

describe("writeTokenFile", () => {
  it("token ファイルを chmod 600 で作成する", () => {
    const { home, cleanup } = makeTempHome();
    try {
      const dir = join(home, "custom-token-dir");
      const filePath = writeTokenFile(dir, "abc123");
      expect(readFileSync(filePath, "utf8")).toBe("abc123");
      const mode = statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      cleanup();
    }
  });
});

describe("taskInput", () => {
  it("既定値入りの TaskCreateInput を生成する", () => {
    const input = taskInput();
    expect(input.title).toBeTruthy();
    expect(input.tenant).toBeTruthy();
    expect(input.status).toBe("triage");
    expect(input.priority).toBe(0);
  });

  it("overrides で個別フィールドを上書きできる", () => {
    const input = taskInput({ title: "カスタムタイトル", priority: 5, tenant: "acme" });
    expect(input.title).toBe("カスタムタイトル");
    expect(input.priority).toBe(5);
    expect(input.tenant).toBe("acme");
  });
});
