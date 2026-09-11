import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const SCRIPT = resolve("scripts/orchestrator/cc-cache-ttl");

function fixture(t, names) {
  const root = mkdtempSync(join(tmpdir(), "hachi-cc-cache-ttl-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const projects = join(root, "projects");
  const cwd = "/tmp/cc-cache-ttl-worktree";
  const projectDir = join(projects, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(home, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const paths = new Map();
  for (const [index, name] of names.entries()) {
    const pathname = join(projectDir, `${name}.jsonl`);
    writeFileSync(pathname, `${JSON.stringify({
      message: {
        usage: {
          input_tokens: (index + 1) * 100,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      },
    })}\n`);
    const timestamp = Date.now() / 1000 - (names.length - index) * 60;
    utimesSync(pathname, timestamp, timestamp);
    paths.set(name, pathname);
  }
  return { home, projects, cwd, paths };
}

function run(fixtureData, args, extraEnv = {}) {
  const result = spawnSync(SCRIPT, args, {
    cwd: resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixtureData.home,
      CC_CACHE_TTL_PROJECTS_DIR: fixtureData.projects,
      CC_CACHE_TTL_CWD: fixtureData.cwd,
      CC_CACHE_TTL_TMUX_SESSION: "",
      ...extraEnv,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result;
}

function jsonResult(fixtureData, sessionName) {
  const result = run(fixtureData, ["--format", "json"], {
    CC_CACHE_TTL_TMUX_SESSION: sessionName,
  });
  return JSON.parse(result.stdout);
}

test("tmux session UUID完全一致でmtimeの新しい別セッションを選ばない", (t) => {
  const uuidA = "6a684a5b-6a68-4a5b-8a68-b13f5b6af734";
  const uuidB = "2b342389-2b34-4238-8234-b13f5b6af734";
  const data = fixture(t, [uuidA, uuidB]);
  const result = jsonResult(data, `hachi-orch-o_x-${uuidA}`);
  assert.equal(result.transcript, data.paths.get(uuidA));
  assert.equal(result.contextTokens, 100);
});

test("tmux session UUIDを差し替えると対応するtranscriptへ切り替わる", (t) => {
  const uuidA = "6a684a5b-6a68-4a5b-8a68-b13f5b6af734";
  const uuidB = "2b342389-2b34-4238-8234-b13f5b6af734";
  const data = fixture(t, [uuidA, uuidB]);
  const result = jsonResult(data, uuidB);
  assert.equal(result.transcript, data.paths.get(uuidB));
  assert.equal(result.contextTokens, 200);

  const explicit = JSON.parse(run(data, ["--session", uuidA, "--format", "json"]).stdout);
  assert.equal(explicit.transcript, data.paths.get(uuidA));
});

test("UUIDの無いtmux sessionで候補が複数なら特定不能にする", (t) => {
  const uuidA = "aaaaaaaa-1111-4111-8111-111111111111";
  const uuidB = "aaaaaaaa-2222-4222-8222-222222222222";
  const data = fixture(t, [uuidA, uuidB]);
  const plain = run(data, ["--format", "plain"], { CC_CACHE_TTL_TMUX_SESSION: "my-shell" });
  assert.equal(plain.stdout, "session-not-found\n");
  const json = jsonResult(data, "my-shell");
  assert.equal(json.transcript, null);
  assert.deepEqual(Object.keys(json), [
    "transcript", "ttlSeconds", "idleSeconds", "marginSeconds", "remainingSeconds", "contextTokens",
  ]);
  const tmux = run(data, [], { CC_CACHE_TTL_TMUX_SESSION: "my-shell" });
  assert.equal(tmux.stdout, "\n");

  const explicit = run(data, ["--session", "aaaaaaaa", "--format", "plain"]);
  assert.equal(explicit.stdout, "session-not-found\n");
});

test("UUIDの無いtmux sessionで候補が1件なら従来どおり採用する", (t) => {
  const uuid = "9ffc7ddd-9ffc-4ddd-8ddd-b13f5b6af734";
  const data = fixture(t, [uuid]);
  const result = jsonResult(data, "my-shell");
  assert.equal(result.transcript, data.paths.get(uuid));
  assert.equal(result.contextTokens, 100);
});

test("tmux session UUIDに対応するtranscriptが無ければcwdの別候補へfallbackしない", (t) => {
  const missing = "68efc7b3-68ef-47b3-87b3-b13f5b6af734";
  const fallback = "11111111-1111-4111-8111-111111111111";
  const data = fixture(t, [fallback]);
  const plain = run(data, ["--format", "plain"], {
    CC_CACHE_TTL_TMUX_SESSION: `hachi-orch-o_x-${missing}`,
  });
  assert.equal(plain.stdout, "session-not-found\n");
  const json = jsonResult(data, `hachi-orch-o_x-${missing}`);
  assert.equal(json.transcript, null);
});
