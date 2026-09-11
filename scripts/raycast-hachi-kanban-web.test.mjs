import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "raycast-hachi-kanban-web.sh");

function executable(pathname, body) {
  writeFileSync(pathname, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(pathname, 0o755);
}

test("healthy fast pathはcloneとpnpmが無くても既存Webを開く", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "hachi-raycast-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, ".local", "bin");
  const opened = path.join(root, "opened-url");
  mkdirSync(bin, { recursive: true });
  executable(path.join(bin, "curl"), "printf '{\"ok\":true}'");
  executable(path.join(bin, "open"), `printf '%s' \"$1\" > '${opened}'`);

  const result = spawnSync("/bin/bash", [script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      HOME: root,
      PATH: "/usr/bin:/bin",
      HACHI_KANBAN_REPO_ROOT: "/missing/hachi-kanban",
      HACHI_PNPM_BIN: "/missing/pnpm",
      HACHI_KANBAN_WEB_PORT: "19131",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(readFileSync(opened, "utf8"), "http://127.0.0.1:19131");
});
