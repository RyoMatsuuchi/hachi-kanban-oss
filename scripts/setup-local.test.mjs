import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { applyPlan, buildPlan, parseArgs } from "./setup-local.mjs";

function options(root, transport = "direct") {
  return {
    apply: true,
    transport,
    hachiHome: join(root, "state"),
    binDir: join(root, "bin"),
    pnpmBin: "pnpm",
    install: false,
    link: true,
    help: false,
  };
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "hachi-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("parseArgsはdirectを既定にし、pathを展開する", () => {
  const parsed = parseArgs([], {}, "/tmp/hachi-user");
  assert.equal(parsed.transport, "direct");
  assert.equal(parsed.hachiHome, "/tmp/hachi-user/.hachi-kanban");
  assert.equal(parsed.binDir, "/tmp/hachi-user/.local/bin");
  assert.equal(parsed.apply, false);
});

test("parseArgsは未知transportを拒否する", () => {
  assert.throws(() => parseArgs(["--transport", "magic"], {}, "/tmp/hachi-user"), /direct または bridge/);
  assert.throws(() => parseArgs(["--hachi-home", "/"], {}, "/tmp/hachi-user"), /広すぎるpath/);
  assert.throws(() => parseArgs(["--hachi-home", "/tmp"], {}, "/tmp/hachi-user"), /広すぎるpath/);
  assert.throws(() => parseArgs(["--hachi-home", "/tmp/hachi-user"], {}, "/tmp/hachi-user"), /広すぎるpath/);
});

const HELPER_NAMES = ["hachi-handover-now", "hhn", "hachi-orch-enable", "cc-cache-ttl", "hachi-watch-stop"];

test("applyPlanはprivate state、config、CLI symlink、ヘルパーシムを冪等作成する", (t) => {
  const root = temporaryRoot(t);
  const plan = buildPlan(options(root));
  const first = applyPlan(plan);
  assert.deepEqual(first, {
    config: "created",
    link: "created",
    helpers: {
      "hachi-handover-now": "created",
      hhn: "created",
      "hachi-orch-enable": "created",
      "cc-cache-ttl": "created",
      "hachi-watch-stop": "created",
    },
  });
  assert.equal(statSync(plan.hachiHome).mode & 0o777, 0o700);
  assert.equal(statSync(join(plan.hachiHome, "credentials")).mode & 0o777, 0o700);
  assert.equal(statSync(plan.configTarget).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(plan.configTarget, "utf8")).profiles.implement.transport, "direct");
  assert.equal(lstatSync(plan.cliTarget).isSymbolicLink(), true);
  const cliResult = spawnSync(plan.cliTarget, ["board", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HACHI_NODE_BIN: process.execPath,
      HACHI_KANBAN_HOME: plan.hachiHome,
      HACHI_KANBAN_BOARD: "dev",
    },
  });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.equal(typeof JSON.parse(cliResult.stdout).counts, "object");

  for (const helper of plan.helpers) {
    assert.equal(statSync(helper.target).mode & 0o777, 0o755);
    assert.equal(
      readFileSync(helper.target, "utf8"),
      `#!/bin/sh\nexec "${helper.source}" "$@"\n`,
    );
  }

  const second = applyPlan(plan);
  assert.deepEqual(second, {
    config: "unchanged",
    link: "unchanged",
    helpers: {
      "hachi-handover-now": "unchanged",
      hhn: "unchanged",
      "hachi-orch-enable": "unchanged",
      "cc-cache-ttl": "unchanged",
      "hachi-watch-stop": "unchanged",
    },
  });
});

test("applyPlanは既存configを保持し、通常ファイルのCLI targetを上書きしない", (t) => {
  const root = temporaryRoot(t);
  const plan = buildPlan(options(root, "bridge"));
  applyPlan({ ...plan, link: false });
  writeFileSync(plan.configTarget, "user-owned\n", { mode: 0o600 });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(plan.cliTarget, "user-owned\n");
  assert.throws(() => applyPlan(plan), /既存ファイルを上書きしません/);
  assert.equal(readFileSync(plan.configTarget, "utf8"), "user-owned\n");
});

test("--no-link相当（link:false）はhachi symlinkもヘルパーシムも作成しない", (t) => {
  const root = temporaryRoot(t);
  const plan = buildPlan({ ...options(root), link: false });
  const result = applyPlan(plan);
  assert.deepEqual(result, {
    config: "created",
    link: "skipped",
    helpers: {
      "hachi-handover-now": "skipped",
      hhn: "skipped",
      "hachi-orch-enable": "skipped",
      "cc-cache-ttl": "skipped",
      "hachi-watch-stop": "skipped",
    },
  });
  assert.equal(existsSync(plan.cliTarget), false);
  for (const helper of plan.helpers) {
    assert.equal(existsSync(helper.target), false);
  }
});

test("applyPlanは既に導入済みの別シム（別repoを指すexecシム）を新しいsourceへ安全に更新する", (t) => {
  const root = temporaryRoot(t);
  const plan = buildPlan(options(root));
  mkdirSync(plan.hachiHome, { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  const staleHandoverNow = plan.helpers.find((helper) => helper.name === "hachi-handover-now");
  writeFileSync(
    staleHandoverNow.target,
    '#!/bin/sh\nexec "/some/other/checkout/scripts/hachi-handover-now" "$@"\n',
    { mode: 0o755 },
  );

  const result = applyPlan(plan);
  assert.equal(result.helpers["hachi-handover-now"], "replaced");
  assert.equal(
    readFileSync(staleHandoverNow.target, "utf8"),
    `#!/bin/sh\nexec "${staleHandoverNow.source}" "$@"\n`,
  );
});

test("applyPlanはシム形式ではない実体ファイルを上書きしない（原本破壊防止）", (t) => {
  const root = temporaryRoot(t);
  const plan = buildPlan(options(root));
  mkdirSync(plan.hachiHome, { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  const orchEnable = plan.helpers.find((helper) => helper.name === "hachi-orch-enable");
  const realBody = "#!/bin/bash\nset -euo pipefail\necho real-body\n";
  writeFileSync(orchEnable.target, realBody, { mode: 0o755 });

  assert.throws(() => applyPlan(plan), /シム形式ではないため上書きしません/);
  assert.equal(readFileSync(orchEnable.target, "utf8"), realBody);
});

test("applyPlanは版管理下のsourceと内容が完全一致する既存の実体ファイルを安全にシムへ移行する（t_eac0371a7a1a368e）", (t) => {
  const root = temporaryRoot(t);
  const plan = buildPlan(options(root));
  mkdirSync(plan.hachiHome, { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  const orchEnable = plan.helpers.find((helper) => helper.name === "hachi-orch-enable");
  // source（version管理下のrepo実体）と完全一致する内容を、まだシムでない既存の実体ファイルとして配置する。
  // これは「repoへ取り込み前は実ファイルだった~/.local/bin/hachi-orch-enableを、
  // 取り込み後に再setupするとシムへ移行できる」という実運用シナリオを再現する。
  const realSourceContent = readFileSync(orchEnable.source, "utf8");
  writeFileSync(orchEnable.target, realSourceContent, { mode: 0o755 });

  const result = applyPlan(plan);
  assert.equal(result.helpers["hachi-orch-enable"], "migrated");
  assert.equal(
    readFileSync(orchEnable.target, "utf8"),
    `#!/bin/sh\nexec "${orchEnable.source}" "$@"\n`,
  );
  assert.equal(statSync(orchEnable.target).mode & 0o777, 0o755);

  // 冪等性: 移行後にもう一度applyPlanしてもunchangedになる
  const second = applyPlan(plan);
  assert.equal(second.helpers["hachi-orch-enable"], "unchanged");
});

test("applyPlanは既存hachiのCLI targetが別経路のdelegating shim（comment付きexec）でも上書きも拒否もせずexternalとして残す（t_eac0371a7a1a368e）", (t) => {
  const root = temporaryRoot(t);
  const plan = buildPlan(options(root));
  mkdirSync(plan.hachiHome, { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  // 実機の ~/.local/bin/hachi が、symlinkではなく説明comment付きのexec shim（別checkoutへ委譲）として
  // 手動運用されているケースを再現する。docs/portable-install.md は「別targetを指す通常ファイルは
  // 上書きしない」と約束しているが、旧実装はthrowしてsetup全体（ヘルパーシムの作成含む）を止めていた。
  const externalContent =
    '#!/bin/sh\n# 別checkoutへ委譲するCLI shim（手動運用、comment付き）\nexec "/some/other/checkout/bin/hachi" "$@"\n';
  writeFileSync(plan.cliTarget, externalContent, { mode: 0o755 });

  const result = applyPlan(plan);
  assert.equal(result.link, "external");
  assert.equal(readFileSync(plan.cliTarget, "utf8"), externalContent);
  // hachi CLI targetの扱いに関わらず、ヘルパーシムは通常どおり作成される
  assert.equal(result.helpers["hachi-orch-enable"], "created");
  assert.equal(result.helpers["hachi-handover-now"], "created");
  assert.equal(result.helpers.hhn, "created");
});

test("applyPlanはhachiのCLI targetが未知の通常ファイル（delegating shim形式ではない）なら従来どおり拒否する", (t) => {
  const root = temporaryRoot(t);
  const plan = buildPlan(options(root));
  mkdirSync(plan.hachiHome, { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(plan.cliTarget, "user-owned\n");
  assert.throws(() => applyPlan(plan), /既存ファイルを上書きしません/);
  assert.equal(readFileSync(plan.cliTarget, "utf8"), "user-owned\n");
});

test("applyPlanはヘルパーの実体scriptがrepoに無ければエラーにする", (t) => {
  const root = temporaryRoot(t);
  const repoRoot = join(root, "repo");
  mkdirSync(join(repoRoot, "examples"), { recursive: true });
  mkdirSync(join(repoRoot, "bin"), { recursive: true });
  writeFileSync(join(repoRoot, "examples", "config.direct.json"), "{}\n");
  writeFileSync(join(repoRoot, "bin", "hachi"), "#!/bin/sh\n");
  // scripts/hachi-handover-now と scripts/orchestrator/hachi-orch-enable をわざと用意しない
  const plan = buildPlan(options(root), repoRoot);
  assert.throws(() => applyPlan(plan), /helper script が見つかりません/);
});

test("HELPER_NAMESはbuildPlanが返すhelper名と一致する（テストの網羅性チェック）", (t) => {
  const root = temporaryRoot(t);
  const plan = buildPlan(options(root));
  assert.deepEqual(plan.helpers.map((helper) => helper.name), HELPER_NAMES);
});

test("applyPlanはstate root symlinkを辿らない", (t) => {
  const root = temporaryRoot(t);
  const plan = buildPlan(options(root));
  const redirected = join(root, "redirected");
  mkdirSync(redirected);
  symlinkSync(redirected, plan.hachiHome);
  assert.throws(() => applyPlan(plan), /symlinkではないdirectory/);
});

test("applyPlanはdangling config symlinkをmutation前に拒否する", (t) => {
  const root = temporaryRoot(t);
  const plan = buildPlan({ ...options(root), install: true });
  mkdirSync(plan.hachiHome, { recursive: true });
  symlinkSync(join(root, "missing-config"), plan.configTarget);
  let spawnCount = 0;

  assert.throws(
    () => applyPlan(plan, { spawn: () => {
      spawnCount += 1;
      return { status: 0 };
    } }),
    /symlink先を解決できません/,
  );
  assert.equal(spawnCount, 0);
  assert.equal(existsSync(join(plan.hachiHome, "logs")), false);
  assert.equal(existsSync(join(plan.hachiHome, "credentials")), false);
});
