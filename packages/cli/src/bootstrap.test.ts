// =============================================================================
// canonical CLI bootstrapのprocess-levelテスト。
// 実bin/hachiを子processとして起動し、package managerを経由しないstdout契約を検証する。
// =============================================================================

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const repositoryEntrypoint = join(repoRoot, "bin", "hachi");
const temporaryDirectories: string[] = [];

interface BoardJson {
  counts: Record<string, number>;
}

interface TaskCreateJson {
  task: {
    id: string;
  };
}

function createTemporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `hachi-cli-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function createFakePackageManager(directory: string): void {
  const path = join(directory, "pnpm");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      "echo 'unexpected package-manager banner'",
      "echo 'unexpected package-manager invocation' >&2",
      "exit 97",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o755);
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function createInstalledShim(directory: string): void {
  const path = join(directory, "hachi");
  writeFileSync(
    path,
    `#!/bin/sh\nexec ${quoteForShell(repositoryEntrypoint)} "$@"\n`,
    "utf8",
  );
  chmodSync(path, 0o755);
}

function runEntrypoint(
  entrypoint: string,
  args: readonly string[],
  options: {
    home: string;
    cwd: string;
    pathPrefix: string;
  },
): SpawnSyncReturns<string> {
  return spawnSync(entrypoint, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HACHI_KANBAN_HOME: options.home,
      HACHI_KANBAN_BOARD: "dev",
      PATH: `${options.pathPrefix}${delimiter}${process.env["PATH"] ?? ""}`,
    },
    timeout: 120_000,
  });
}

afterEach((): void => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.sequential("canonical CLI bootstrap (docs/contract.md §65.2)", () => {
  it("repository-local bin/hachiとinstalled shim相当の--json stdoutは単一JSON documentになる", () => {
    const fixtureRoot = createTemporaryDirectory("json");
    const fakeBin = join(fixtureRoot, "bin");
    const unrelatedCwd = join(fixtureRoot, "cwd");
    mkdirSync(fakeBin);
    mkdirSync(unrelatedCwd);
    createFakePackageManager(fakeBin);
    createInstalledShim(fakeBin);

    for (const entrypoint of [repositoryEntrypoint, "hachi"]) {
      const home = join(fixtureRoot, entrypoint === "hachi" ? "shim-home" : "repository-home");
      const result = runEntrypoint(entrypoint, ["board", "--json"], {
        home,
        cwd: unrelatedCwd,
        pathPrefix: fakeBin,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("package-manager");
      expect(JSON.parse(result.stdout) as BoardJson).toMatchObject({
        counts: expect.any(Object),
      });
    }

    const textResult = runEntrypoint(repositoryEntrypoint, ["board"], {
      home: join(fixtureRoot, "text-home"),
      cwd: unrelatedCwd,
      pathPrefix: fakeBin,
    });
    expect(textResult.error).toBeUndefined();
    expect(textResult.status).toBe(0);
    expect(textResult.stderr).toBe("");
    expect(textResult.stdout).toContain("=== 状態別件数 ===");
  }, 30_000);

  it("JSON modeの診断をstderrへ分離する", () => {
    const fixtureRoot = createTemporaryDirectory("stderr");
    const fakeBin = join(fixtureRoot, "bin");
    mkdirSync(fakeBin);
    createFakePackageManager(fakeBin);

    const home = join(fixtureRoot, "home");
    const createResult = runEntrypoint(
      repositoryEntrypoint,
      [
        "task",
        "create",
        "--title",
        "bootstrap test",
        "--body",
        "cwd: /tmp/hachi-cli-bootstrap-test\n\nbody",
        "--tenant",
        "test",
        "--json",
      ],
      { home, cwd: fixtureRoot, pathPrefix: fakeBin },
    );
    expect(createResult.error).toBeUndefined();
    expect(createResult.status).toBe(0);
    const taskId = (JSON.parse(createResult.stdout) as TaskCreateJson).task.id;

    const warningResult = runEntrypoint(
      repositoryEntrypoint,
      ["task", "set-cwd", taskId, join(fixtureRoot, "missing-worktree"), "--json"],
      { home, cwd: fixtureRoot, pathPrefix: fakeBin },
    );
    expect(warningResult.error).toBeUndefined();
    expect(warningResult.status).toBe(0);
    expect(() => JSON.parse(warningResult.stdout)).not.toThrow();
    expect(warningResult.stdout).not.toContain("警告");
    expect(warningResult.stderr).toContain("警告:");
  }, 30_000);

  it("install済みCLI runtimeが無い場合はpackage managerを起動せずstderrでfail-closedする", () => {
    const fixtureRoot = createTemporaryDirectory("missing-runtime");
    const incompleteRepository = join(fixtureRoot, "repository");
    const incompleteBin = join(incompleteRepository, "bin");
    const fakeBin = join(fixtureRoot, "fake-bin");
    mkdirSync(incompleteBin, { recursive: true });
    mkdirSync(fakeBin);
    copyFileSync(repositoryEntrypoint, join(incompleteBin, "hachi"));
    chmodSync(join(incompleteBin, "hachi"), 0o755);
    createFakePackageManager(fakeBin);

    const result = runEntrypoint(join(incompleteBin, "hachi"), ["board", "--json"], {
      home: join(fixtureRoot, "home"),
      cwd: fixtureRoot,
      pathPrefix: fakeBin,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("CLI runtime が見つかりません");
    expect(result.stderr).not.toContain("package-manager");
  }, 30_000);
});
