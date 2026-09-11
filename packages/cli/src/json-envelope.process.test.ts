import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TaskRow } from "@hachi/core";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const HACHI_BIN = resolve(REPO_ROOT, "bin/hachi");

function runHachi(home: string, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(HACHI_BIN, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HACHI_KANBAN_HOME: home,
      HACHI_KANBAN_BOARD: "json-envelope-process",
      NO_COLOR: "1",
    },
    maxBuffer: 1024 * 1024,
  });
}

function expectSuccessfulJson(result: SpawnSyncReturns<string>): unknown {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(() => JSON.parse(result.stdout)).not.toThrow();
  return JSON.parse(result.stdout) as unknown;
}

describe("bin/hachi singular resource JSON", () => {
  it("実shimのcreate/show stdoutは単一JSON documentで共通id/statusとnested taskを返す", {
    timeout: 120_000,
  }, () => {
    const home = mkdtempSync(join(tmpdir(), "hachi-json-envelope-process-"));
    try {
      const created = expectSuccessfulJson(runHachi(home, [
        "task", "create",
        "--title", "process envelope",
        "--body", `cwd: ${REPO_ROOT}`,
        "--tenant", "dev",
        "--status", "todo",
        "--json",
      ])) as { id: string; status: string; task: TaskRow; dependencyIds: string[] };
      expect(created).toMatchObject({
        id: created.task.id,
        status: "todo",
        task: { id: created.task.id, status: "todo" },
        dependencyIds: [],
      });

      const shown = expectSuccessfulJson(runHachi(home, [
        "task", "show", created.id, "--json",
      ])) as { id: string; status: string; task: TaskRow; comments: unknown[]; events: unknown[] };
      expect(shown).toMatchObject({
        id: created.id,
        status: "todo",
        task: { id: created.id, status: "todo" },
        comments: [],
      });
      expect(shown.events.length).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
