import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const SCRIPT = resolve("scripts/orchestrator/heartbeat.sh");
const OWN_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_UUID = "22222222-2222-4222-8222-222222222222";

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "hachi-orchestrator-heartbeat-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function liveList(providerSessionId = OWN_UUID) {
  return JSON.stringify({
    orchestrators: [
      {
        orchestrator: { id: "o_owner" },
        liveSession: {
          id: "os_owner",
          orchestratorId: "o_owner",
          generation: 57,
          provider: "codex",
          providerSessionId,
          status: "active",
        },
      },
    ],
  });
}

function installFakes(root) {
  const callsPath = join(root, "hachi-calls.log");
  const countPath = join(root, "heartbeat-count");
  const hachiPath = join(root, "hachi");
  const sleepPath = join(root, "sleep");
  writeFileSync(hachiPath, [
    "#!/bin/bash",
    "echo \"$*\" >> \"$FAKE_HACHI_CALLS\"",
    "if [ \"$*\" = \"orchestrator list --json\" ]; then",
    "  printf '%s\\n' \"$FAKE_LIST_JSON\"",
    "  exit 0",
    "fi",
    "count=0",
    "if [ -f \"$FAKE_HEARTBEAT_COUNT\" ]; then count=$(<\"$FAKE_HEARTBEAT_COUNT\"); fi",
    "count=$((count + 1))",
    "printf '%s\\n' \"$count\" > \"$FAKE_HEARTBEAT_COUNT\"",
    "if [ \"${FAKE_FIRST_HEARTBEAT_SUCCEEDS:-0}\" = 1 ] && [ \"$count\" -eq 1 ]; then exit 0; fi",
    "echo \"SESSION_SUPERSEDED: fake failure\" >&2",
    "exit 1",
    "",
  ].join("\n"), { mode: 0o700 });
  writeFileSync(sleepPath, "#!/bin/bash\nexit 0\n", { mode: 0o700 });
  chmodSync(hachiPath, 0o700);
  chmodSync(sleepPath, 0o700);
  return { callsPath, countPath };
}

function runHeartbeat(root, args, extraEnv = {}) {
  const paths = installFakes(root);
  return {
    ...paths,
    result: spawnSync(SCRIPT, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH ?? ""}`,
        TMPDIR: root,
        FAKE_HACHI_CALLS: paths.callsPath,
        FAKE_HEARTBEAT_COUNT: paths.countPath,
        FAKE_LIST_JSON: liveList(),
        ...extraEnv,
      },
    }),
  };
}

test("heartbeat scriptはprovider session UUID 1引数だけを要求する", (t) => {
  const root = temporaryRoot(t);
  const missing = runHeartbeat(root, []).result;
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /provider-session-uuid/);

  const invalid = runHeartbeat(root, ["not-a-uuid"]).result;
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /UUID 形式/);

  const extra = runHeartbeat(root, [OWN_UUID, OTHER_UUID]).result;
  assert.equal(extra.status, 2);
});

test("provider session idがlive sessionに一致しなければheartbeatを一度も打たず非0終了する", (t) => {
  const root = temporaryRoot(t);
  const { result, callsPath } = runHeartbeat(root, [OTHER_UUID]);

  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /heartbeat しません/);
  assert.deepEqual(readFileSync(callsPath, "utf8").trim().split("\n"), ["orchestrator list --json"]);
});

test("一致したlive sessionのid/generationだけを使い、3連続失敗でDEAD markerを残して終了する", (t) => {
  const root = temporaryRoot(t);
  const { result, callsPath, countPath } = runHeartbeat(root, [OWN_UUID], {
    FAKE_FIRST_HEARTBEAT_SUCCEEDS: "1",
  });

  assert.equal(result.status, 1, result.stderr);
  const calls = readFileSync(callsPath, "utf8").trim().split("\n");
  assert.equal(calls[0], "orchestrator list --json");
  assert.deepEqual(calls.slice(1), [
    "orchestrator session heartbeat os_owner --generation 57",
    "orchestrator session heartbeat os_owner --generation 57",
    "orchestrator session heartbeat os_owner --generation 57",
    "orchestrator session heartbeat os_owner --generation 57",
  ]);
  assert.equal(readFileSync(countPath, "utf8").trim(), "4");
  const marker = readFileSync(join(root, `hachi-orch-heartbeat-${OWN_UUID}.DEAD`), "utf8");
  assert.match(marker, /HEARTBEAT DEAD after 3 consecutive failures/);
  assert.match(marker, new RegExp(
    `orchestrator session takeover o_owner --stale-sec 90 --provider codex --provider-session-id ${OWN_UUID} --json`,
  ));
  assert.doesNotMatch(marker, /orchestrator session (close|start)/);
});
