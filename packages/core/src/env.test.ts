import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureEnvironmentDirs, resolveEnvironment } from "./env.js";

describe("resolveEnvironment", () => {
  it("既定値を解決する（docs/contract.md §3）", () => {
    const env = resolveEnvironment({});
    expect(env.home).toBe(join(homedir(), ".hachi-kanban"));
    expect(env.board).toBe("dev");
    expect(env.dbPath).toBe(`${env.home}/boards/dev/kanban.db`);
    expect(env.artifactsDir).toBe(`${env.home}/artifacts`);
    expect(env.bridges.codex.url).toBe("http://127.0.0.1:3456");
    expect(env.bridges.codex.tokenFile).toBe(join(env.home, "credentials", "codex-bridge-token"));
    expect(env.bridges.claude.url).toBe("http://127.0.0.1:3457");
    expect(env.bridges.claude.tokenFile).toBe(join(env.home, "credentials", "claude-bridge-token"));
  });

  it("bridge tokenの既定値は端末固有state rootへ追従する", () => {
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: "/tmp/custom-home" });
    expect(env.bridges.codex.tokenFile).toBe("/tmp/custom-home/credentials/codex-bridge-token");
    expect(env.bridges.claude.tokenFile).toBe("/tmp/custom-home/credentials/claude-bridge-token");
  });

  it("環境変数で上書きできる", () => {
    const env = resolveEnvironment({
      HACHI_KANBAN_HOME: "/tmp/custom-home",
      HACHI_KANBAN_BOARD: "prod",
      HACHI_CODEX_BRIDGE_URL: "http://127.0.0.1:9001",
      HACHI_CODEX_BRIDGE_TOKEN_FILE: "/tmp/codex-token",
      HACHI_CLAUDE_BRIDGE_URL: "http://127.0.0.1:9002",
      HACHI_CLAUDE_BRIDGE_TOKEN_FILE: "/tmp/claude-token",
    });
    expect(env.home).toBe("/tmp/custom-home");
    expect(env.board).toBe("prod");
    expect(env.dbPath).toBe("/tmp/custom-home/boards/prod/kanban.db");
    expect(env.bridges.codex.url).toBe("http://127.0.0.1:9001");
    expect(env.bridges.codex.tokenFile).toBe("/tmp/codex-token");
    expect(env.bridges.claude.url).toBe("http://127.0.0.1:9002");
    expect(env.bridges.claude.tokenFile).toBe("/tmp/claude-token");
  });

  it("`~` をホームディレクトリへ展開する", () => {
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: "~/custom-kanban" });
    expect(env.home).toBe(join(homedir(), "custom-kanban"));
  });

  it("board 名にパス区切りを含む値は fail-closed で throw する（docs/contract.md §12.8-1）", () => {
    expect(() => resolveEnvironment({ HACHI_KANBAN_BOARD: "a/b" })).toThrow(/不正な board 名/);
    expect(() => resolveEnvironment({ HACHI_KANBAN_BOARD: "../../evil" })).toThrow(/不正な board 名/);
  });

  it("board 名が `..` の場合は fail-closed で throw する（docs/contract.md §12.8-1）", () => {
    expect(() => resolveEnvironment({ HACHI_KANBAN_BOARD: ".." })).toThrow(/\.\./);
  });

  it("board 名が `.` の場合は fail-closed で throw する（docs/contract.md §12.8-1）", () => {
    expect(() => resolveEnvironment({ HACHI_KANBAN_BOARD: "." })).toThrow();
  });

  it("正常な board slug（英数字・.・_・- のみ）は通る", () => {
    const env = resolveEnvironment({ HACHI_KANBAN_BOARD: "my-board_1.2" });
    expect(env.board).toBe("my-board_1.2");
    expect(env.dbPath).toBe(`${env.home}/boards/my-board_1.2/kanban.db`);
  });
});

describe("ensureEnvironmentDirs", () => {
  let tempRoot: string;

  afterEach(() => {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("dbPath の親ディレクトリと artifactsDir を作成する", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-env-"));
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: tempRoot, HACHI_KANBAN_BOARD: "dev" });

    ensureEnvironmentDirs(env);

    expect(existsSync(`${tempRoot}/boards/dev`)).toBe(true);
    expect(existsSync(env.artifactsDir)).toBe(true);
  });
});
