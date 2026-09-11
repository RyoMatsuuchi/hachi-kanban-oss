import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const SCRIPT = resolve("scripts/orchestrator/hachi-watch-stop");
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleep(milliseconds) {
  Atomics.wait(sleeper, 0, 0, milliseconds);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function processState(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function waitForFile(path, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!existsSync(path) && Date.now() < deadline) {
    sleep(20);
  }
  assert.equal(existsSync(path), true, `timed out waiting for ${path}`);
}

function waitForGone(pids, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  let remaining = pids.filter(processExists);
  while (remaining.length > 0 && Date.now() < deadline) {
    sleep(20);
    remaining = pids.filter(processExists);
  }
  assert.deepEqual(remaining, [], `processes remained: ${remaining.join(", ")}`);
}

function killForCleanup(pids) {
  for (const pid of [...pids].reverse()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
}

function runStop(watcher, args = [], extraEnv = {}) {
  return spawnSync(SCRIPT, [...args, watcher], {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 15_000,
  });
}

function lockedWatcherFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "hachi-watch-stop-"));
  const watcher = join(root, `watcher-${basename(root)}.sh`);
  const pidFile = join(root, "pids");
  const home = join(root, "home");
  const taskAwait = join(home, "state", "task-await");
  const locks = join(taskAwait, ".locks");
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  chmodSync(join(home, "state"), 0o700);
  chmodSync(taskAwait, 0o700);
  chmodSync(locks, 0o700);

  const checkpoint = join(realpathSync(taskAwait), "terminal.json");
  const digest = createHash("sha256").update(checkpoint, "utf8").digest("hex");
  const sidecar = join(locks, `${digest}.sqlite`);
  writeFileSync(sidecar, "", { mode: 0o600 });

  writeFileSync(watcher, `#!/bin/sh
python3 -c '
import os
import sqlite3
import subprocess
import sys
import time

connection = sqlite3.connect(sys.argv[1], timeout=0, isolation_level=None)
connection.execute("PRAGMA busy_timeout = 0")
connection.execute("PRAGMA journal_mode = MEMORY")
connection.execute("BEGIN EXCLUSIVE")
grandchild = subprocess.Popen(["/bin/sh", "-c", "sleep 60"])
with open(sys.argv[2], "w", encoding="utf-8") as output:
    output.write(f"{os.getppid()}\\n{os.getpid()}\\n{grandchild.pid}\\n")
    output.flush()
while True:
    time.sleep(1)
' "$HACHI_TEST_SIDECAR" "$HACHI_TEST_PID_FILE" --cursor-file terminal.json
`, { mode: 0o700 });

  const env = {
    ...process.env,
    HACHI_KANBAN_HOME: home,
    HACHI_TEST_PID_FILE: pidFile,
    HACHI_TEST_SIDECAR: sidecar,
  };
  const launch = spawnSync(
    "/bin/sh",
    ["-c", '"$1" >/dev/null 2>&1 &', "launcher", watcher],
    { env, encoding: "utf8" },
  );
  assert.equal(launch.status, 0, launch.stderr);
  waitForFile(pidFile);
  const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
  assert.equal(pids.length, 3);
  assert.equal(pids.every(processExists), true);

  t.after(() => {
    killForCleanup(pids);
    rmSync(root, { recursive: true, force: true });
  });
  return { watcher, pids, env, sidecar: realpathSync(sidecar) };
}

test("claude --session-id を含む候補は除外し、対象0件を異常終了にする", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hachi-watch-stop-claude-"));
  const watcher = join(root, `watcher-${basename(root)}.sh`);
  const candidate = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", "claude", "--session-id", "test-session", watcher],
    { stdio: "ignore" },
  );
  assert.notEqual(candidate.pid, undefined);
  t.after(() => {
    killForCleanup([candidate.pid]);
    rmSync(root, { recursive: true, force: true });
  });
  sleep(100);

  const result = runStop(watcher);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, new RegExp(`excluded claude pid=${candidate.pid} `));
  assert.match(result.stdout, new RegExp(watcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stderr, /停止対象の watcher wrapper が見つかりません/);
  assert.equal(processExists(candidate.pid), true);
});

test("wrapper から孫まで消滅し、terminal watcher の sidecar lock 取得後に成功する", (t) => {
  const fixture = lockedWatcherFixture(t);

  const result = runStop(fixture.watcher, [], fixture.env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /watcher wrapper と全子孫の消滅を確認しました/);
  assert.match(result.stdout, new RegExp(`sidecar lock acquired path=${fixture.sidecar}`));
  waitForGone(fixture.pids);
});

test("wrapper 消滅後も収集済みの子だけが残れば成功しない", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hachi-watch-stop-fake-ps-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  const watcher = join(root, "watcher-child-remains.sh");
  const wrapperPid = 900001;
  const childPid = 900002;
  mkdirSync(bin);
  const fakePs = join(bin, "ps");
  writeFileSync(fakePs, `#!/bin/sh
case " $* " in
  *" -eww "*)
    if [ ! -e "$HACHI_FAKE_PS_STATE" ]; then
      : > "$HACHI_FAKE_PS_STATE"
      printf "  ${wrapperPid} 1 /bin/sh ${watcher}\\n"
    fi
    printf "  ${childPid} ${wrapperPid} hachi task await --all --follow-new\\n"
    ;;
  *" -p ${childPid} "*)
    printf "  ${childPid} 1 hachi task await --all --follow-new\\n"
    ;;
esac
`, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runStop(watcher, [], {
    HACHI_FAKE_PS_STATE: state,
    PATH: `${bin}:${process.env.PATH}`,
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`PID ${childPid} が停止後も残っています`));
  assert.doesNotMatch(result.stdout, /全子孫の消滅を確認しました/);
});

test("--dry-run は signal を送らず PID と argv 全文を表示する", (t) => {
  const fixture = lockedWatcherFixture(t);

  const result = runStop(fixture.watcher, ["--dry-run"], fixture.env);

  assert.equal(result.status, 0, result.stderr);
  for (const pid of fixture.pids) {
    assert.match(result.stdout, new RegExp(`pid=${pid} `));
    assert.equal(processExists(pid), true);
    assert.doesNotMatch(processState(pid), /^T/);
  }
  assert.match(result.stdout, new RegExp(fixture.watcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stdout, /--cursor-file terminal\.json/);
  assert.match(result.stdout, /dry-run: signal と sidecar lock 取得は行っていません/);
});

test("対象の絶対パスに接尾辞を付けた argv は停止対象に選ばない", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hachi-watch-stop-suffix-"));
  const watcher = join(root, `watcher-${basename(root)}.sh`);
  const candidate = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", `${watcher}.other`],
    { stdio: "ignore" },
  );
  assert.notEqual(candidate.pid, undefined);
  t.after(() => {
    killForCleanup([candidate.pid]);
    rmSync(root, { recursive: true, force: true });
  });
  sleep(100);

  const result = runStop(watcher, ["--dry-run"]);

  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(`pid=${candidate.pid} `));
  assert.doesNotMatch(result.stdout, new RegExp(`${watcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.other`));
  assert.equal(processExists(candidate.pid), true);
});

test("相対パスで起動した watcher を絶対パス指定で停止対象に選ぶ", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hachi-watch-stop-relative-"));
  const bin = join(root, "bin");
  const watcherName = "hk-gen38-terminal.sh";
  const watcher = join(root, watcherName);
  const candidatePid = 900003;
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), `#!/bin/sh
case " $* " in
  *" -eww "*) printf "  ${candidatePid} 1 /bin/bash ./${watcherName}\\n" ;;
esac
`, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runStop(watcher, ["--dry-run"], {
    PATH: `${bin}:${process.env.PATH}`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`pid=${candidatePid} `));
  assert.match(result.stdout, /\/bin\/bash \.\/hk-gen38-terminal\.sh/);
});

test("相対パスの watcher 名に接尾辞を付けた argv は停止対象に選ばない", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hachi-watch-stop-relative-suffix-"));
  const bin = join(root, "bin");
  const watcherName = "hk-gen38-terminal.sh";
  const watcher = join(root, watcherName);
  const candidatePid = 900004;
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), `#!/bin/sh
case " $* " in
  *" -eww "*) printf "  ${candidatePid} 1 /bin/bash ./${watcherName}.other\\n" ;;
esac
`, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runStop(watcher, ["--dry-run"], {
    PATH: `${bin}:${process.env.PATH}`,
  });

  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(`pid=${candidatePid} `));
});
