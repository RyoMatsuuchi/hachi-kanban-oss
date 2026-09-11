#!/usr/bin/env node

import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_NODE = Object.freeze({ major: 22, minor: 13 });

/**
 * オーケストレーター運用ヘルパーの一覧。`~/.local/bin` へ exec シムとして導入する。
 * 実体は repo 管理下の scripts/ 配下に置き、host の `~/.local/bin` は薄いシムだけにする
 * （t_eac0371a7a1a368e）。この一覧は packages/cli/src/commands/doctor.ts の
 * ORCHESTRATOR_HELPER_SPECS と対応させること（doctor はこのシムの導入状態を検査する）。
 */
const ORCHESTRATOR_HELPERS = Object.freeze([
  Object.freeze({ name: "hachi-handover-now", repoRelativeSource: join("scripts", "hachi-handover-now") }),
  Object.freeze({ name: "hhn", repoRelativeSource: join("scripts", "hachi-handover-now") }),
  Object.freeze({
    name: "hachi-orch-enable",
    repoRelativeSource: join("scripts", "orchestrator", "hachi-orch-enable"),
  }),
  Object.freeze({
    name: "cc-cache-ttl",
    repoRelativeSource: join("scripts", "orchestrator", "cc-cache-ttl"),
  }),
  Object.freeze({
    name: "hachi-watch-stop",
    repoRelativeSource: join("scripts", "orchestrator", "hachi-watch-stop"),
  }),
]);

function usage() {
  return `Usage: node scripts/setup-local.mjs [options]

Options:
  --apply                 計画を実行する（省略時は dry-run）
  --transport <kind>      direct（既定）または bridge
  --hachi-home <path>     状態root（既定: HACHI_KANBAN_HOME または ~/.hachi-kanban）
  --bin-dir <path>        hachi symlink の配置先（既定: ~/.local/bin）
  --pnpm-bin <path>       pnpm executable（既定: HACHI_PNPM_BIN または PATH）
  --skip-install          pnpm install --frozen-lockfile を実行しない
  --no-link               ~/.local/bin/hachi symlink とオーケストレーターヘルパーシムを作成しない
  --help                  この説明を表示

--no-link を付けない場合、hachi symlink に加えて次のヘルパーシムも
--bin-dir 配下に作成/修復する（冪等）: hachi-handover-now, hhn, hachi-orch-enable, cc-cache-ttl, hachi-watch-stop
`;
}

function expandHome(input, home) {
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

function absolutePath(input, home, label) {
  const expanded = expandHome(input, home);
  const output = resolve(expanded);
  if (!isAbsolute(output) || output.includes("\0")) {
    throw new Error(`${label} は安全な絶対パスで指定してください`);
  }
  return output;
}

function scopedStateRoot(input, home) {
  const output = absolutePath(input, home, "Hachi home");
  const root = parse(output).root;
  if (output === root || output === resolve(home) || dirname(output) === root) {
    throw new Error(`Hachi home に広すぎるpathは指定できません: ${output}`);
  }
  return output;
}

function assertNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    throw new Error(`Node.js version を解釈できません: ${version}`);
  }
  if (major < MIN_NODE.major || (major === MIN_NODE.major && minor < MIN_NODE.minor)) {
    throw new Error(`Node.js >=${MIN_NODE.major}.${MIN_NODE.minor} が必要です（現在 ${version}）`);
  }
}

export function parseArgs(argv, env = process.env, home = homedir()) {
  const options = {
    apply: false,
    transport: "direct",
    hachiHome: scopedStateRoot(env.HACHI_KANBAN_HOME ?? "~/.hachi-kanban", home),
    binDir: absolutePath("~/.local/bin", home, "bin dir"),
    pnpmBin: env.HACHI_PNPM_BIN ?? "pnpm",
    install: true,
    link: true,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--skip-install") options.install = false;
    else if (arg === "--no-link") options.link = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (["--transport", "--hachi-home", "--bin-dir", "--pnpm-bin"].includes(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} に値が必要です`);
      index += 1;
      if (arg === "--transport") options.transport = value;
      if (arg === "--hachi-home") options.hachiHome = scopedStateRoot(value, home);
      if (arg === "--bin-dir") options.binDir = absolutePath(value, home, "bin dir");
      if (arg === "--pnpm-bin") options.pnpmBin = value;
    } else {
      throw new Error(`未知のoptionです: ${arg}`);
    }
  }

  if (!new Set(["direct", "bridge"]).has(options.transport)) {
    throw new Error(`--transport は direct または bridge です: ${options.transport}`);
  }
  if (options.pnpmBin.includes("\0") || options.pnpmBin.trim() === "") {
    throw new Error("pnpm executable が不正です");
  }
  return options;
}

export function buildPlan(options, repoRoot = REPO_ROOT) {
  const configSource = join(repoRoot, "examples", `config.${options.transport}.json`);
  const configTarget = join(options.hachiHome, "config.json");
  const cliSource = join(repoRoot, "bin", "hachi");
  const cliTarget = join(options.binDir, "hachi");
  const helpers = ORCHESTRATOR_HELPERS.map((helper) => ({
    name: helper.name,
    source: join(repoRoot, helper.repoRelativeSource),
    target: join(options.binDir, helper.name),
  }));
  return {
    repoRoot,
    install: options.install,
    pnpmBin: options.pnpmBin,
    hachiHome: options.hachiHome,
    configSource,
    configTarget,
    link: options.link,
    cliSource,
    cliTarget,
    helpers,
    transport: options.transport,
  };
}

/**
 * 通常ファイルが「shebang + 任意個数のcomment行 + 末尾1行の `exec "<path>" "$@"`」という
 * delegating shim の形になっているかを判定する。setup-local.mjsが生成するヘルパーシム
 * （isExecShim）より緩い形式まで許容する。これは `~/.local/bin/hachi` が、
 * docs/portable-install.mdの想定（symlink）とは別に、説明comment付きのexec shimとして
 * 手動運用されているケースが実在するため（t_eac0371a7a1a368e レビュー: 現行hachi通常ファイルで
 * setup dry-runがexit 1になる問題への対応）。判定結果は「上書きしてよい」ではなく
 * 「唯一の原本ではなく単なる委譲入口なので、別経路運用として黙って残置してよい」の意味。
 */
function isDelegatingShimLike(content) {
  const lines = content.split("\n");
  if (lines.length < 3) return false;
  if (lines[0] !== "#!/bin/sh" && lines[0] !== "#!/bin/bash") return false;
  if (lines[lines.length - 1] !== "") return false;
  const body = lines.slice(1, -1);
  const last = body[body.length - 1];
  if (last === undefined || !/^exec "[^"\n]+" "\$@"$/.test(last)) return false;
  return body.slice(0, -1).every((line) => line.startsWith("#"));
}

/**
 * - 既存が無ければ create
 * - 既存がsourceと同じsymlinkならunchanged、別のsymlinkなら拒否
 * - 既存が通常ファイルでも、delegating shim（isDelegatingShimLike）として機能済みなら
 *   externalとして黙認する（唯一の原本ではなく別経路の委譲入口に過ぎないため。上書きも
 *   しないが拒否もしない。docs/portable-install.md「別targetを指すsymlink/通常ファイルは
 *   上書きしません」の実装をthrowからskipへ揃える）
 * - それ以外の通常ファイルは拒否する（原本かもしれない未知ファイルを誤って壊さないため）
 */
function ensureSameOrAbsentSymlink(target, source) {
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "create";
    throw error;
  }
  if (!stat.isSymbolicLink()) {
    if (stat.isFile() && isDelegatingShimLike(readFileSync(target, "utf8"))) {
      return "external";
    }
    throw new Error(`既存ファイルを上書きしません: ${target}`);
  }
  const resolvedLink = resolve(dirname(target), readlinkSync(target));
  if (resolvedLink !== resolve(source)) {
    throw new Error(`別のsymlinkを上書きしません: ${target} -> ${resolvedLink}`);
  }
  return "unchanged";
}

/** exec シムの内容そのもの。setup-local.mjs が生成するシムは全てこの1行スクリプトである */
function shimScript(sourcePath) {
  return `#!/bin/sh\nexec "${sourcePath}" "$@"\n`;
}

/** 内容が「setup-local.mjs が生成するexec シム」の形式かどうか（実体スクリプトとの判別に使う） */
function isExecShim(content) {
  return /^#!\/bin\/sh\nexec "[^"\n]+" "\$@"\n$/.test(content);
}

/**
 * ヘルパーシムを冪等に作成できるか判定する。
 * - 既存が無ければ create
 * - 既存が「既に exec シム」なら、内容次第で unchanged/replace（シムはシムを上書きしてよい）
 * - 既存が実体スクリプト（シム形式でない通常ファイル）でも、内容が version 管理下の
 *   source scriptと完全一致するなら migrate（唯一の原本は既に repo に取り込み済みであり、
 *   この既存ファイルは単なる複製に過ぎないためシムへ安全に置き換えられる。t_eac0371a7a1a368e
 *   レビュー: 現行 hachi-orch-enable のような既存実体をシムへ移行する経路が無かった問題への対応）
 * - それ以外（symlink、または内容が一致しない実体スクリプト）は拒否する
 *   （唯一の原本かもしれない実体ファイルを誤って壊さないため）
 */
function ensureShim(target, source) {
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "create";
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`既存のsymlinkを上書きしません: ${target}`);
  }
  if (!stat.isFile()) {
    throw new Error(`既存ファイルを上書きしません: ${target}`);
  }
  const content = readFileSync(target, "utf8");
  if (isExecShim(content)) {
    return content === shimScript(source) ? "unchanged" : "replace";
  }
  if (existsSync(source) && content === readFileSync(source, "utf8")) {
    return "migrate";
  }
  throw new Error(`既存ファイルはシム形式ではないため上書きしません（実体の可能性があります）: ${target}`);
}

function ensureDirectory(path, mode, label) {
  assertDirectoryTarget(path, label);
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
}

function assertDirectoryTarget(path, label) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} はsymlinkではないdirectoryである必要があります: ${path}`);
    }
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
}

function inspectConfigTarget(path) {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "create";
    throw error;
  }
  if (entry.isSymbolicLink()) {
    try {
      if (!statSync(path).isFile()) {
        throw new Error(`既存configのsymlink先は通常ファイルである必要があります: ${path}`);
      }
    } catch {
      throw new Error(`既存configのsymlink先を解決できません: ${path}`);
    }
    return "unchanged";
  }
  if (!entry.isFile()) {
    throw new Error(`既存configは通常ファイルまたは通常ファイルへのsymlinkである必要があります: ${path}`);
  }
  return "unchanged";
}

export function preflightPlan(plan) {
  assertNodeVersion();
  if (!existsSync(plan.configSource)) throw new Error(`config template が見つかりません: ${plan.configSource}`);
  if (!existsSync(plan.cliSource)) throw new Error(`hachi CLI が見つかりません: ${plan.cliSource}`);
  assertDirectoryTarget(plan.hachiHome, "Hachi home");
  assertDirectoryTarget(join(plan.hachiHome, "logs"), "logs directory");
  assertDirectoryTarget(join(plan.hachiHome, "credentials"), "credentials directory");
  const config = inspectConfigTarget(plan.configTarget);
  const link = plan.link ? ensureSameOrAbsentSymlink(plan.cliTarget, plan.cliSource) : "skipped";
  const helpers = {};
  for (const helper of plan.helpers) {
    if (!plan.link) {
      helpers[helper.name] = "skipped";
      continue;
    }
    if (!existsSync(helper.source)) {
      throw new Error(`helper script が見つかりません: ${helper.source}`);
    }
    helpers[helper.name] = ensureShim(helper.target, helper.source);
  }
  return { config, link, helpers };
}

export function applyPlan(plan, { spawn = spawnSync } = {}) {
  const planned = preflightPlan(plan);

  if (plan.install) {
    const result = spawn(plan.pnpmBin, ["install", "--frozen-lockfile"], {
      cwd: plan.repoRoot,
      stdio: "inherit",
    });
    if (result.error) throw new Error(`pnpm install を起動できません: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`pnpm install が失敗しました (exit=${String(result.status)})`);
  }

  ensureDirectory(plan.hachiHome, 0o700, "Hachi home");
  ensureDirectory(join(plan.hachiHome, "logs"), 0o700, "logs directory");
  ensureDirectory(join(plan.hachiHome, "credentials"), 0o700, "credentials directory");

  let config = planned.config;
  if (config === "create") {
    copyFileSync(plan.configSource, plan.configTarget, fsConstants.COPYFILE_EXCL);
    chmodSync(plan.configTarget, 0o600);
    config = "created";
  }

  let link = "skipped";
  const helpers = {};
  if (plan.link) {
    mkdirSync(dirname(plan.cliTarget), { recursive: true, mode: 0o755 });
    link = planned.link;
    if (link === "create") {
      symlinkSync(plan.cliSource, plan.cliTarget);
      link = "created";
    }
    for (const helper of plan.helpers) {
      const status = planned.helpers[helper.name];
      if (status === "create" || status === "replace" || status === "migrate") {
        mkdirSync(dirname(helper.target), { recursive: true, mode: 0o755 });
        writeFileSync(helper.target, shimScript(helper.source), { mode: 0o755 });
        chmodSync(helper.target, 0o755);
        helpers[helper.name] =
          status === "create" ? "created" : status === "replace" ? "replaced" : "migrated";
      } else {
        helpers[helper.name] = "unchanged";
      }
    }
  } else {
    for (const helper of plan.helpers) {
      helpers[helper.name] = "skipped";
    }
  }
  return { config, link, helpers };
}

export function formatPlan(plan) {
  const lines = [
    `repo: ${plan.repoRoot}`,
    `transport: ${plan.transport}`,
    `dependency install: ${plan.install ? `${plan.pnpmBin} install --frozen-lockfile` : "skip"}`,
    `state root: ${plan.hachiHome} (0700)`,
    `config: ${plan.configSource} -> ${plan.configTarget} (既存時は保持)`,
    `CLI link: ${plan.link ? `${plan.cliTarget} -> ${plan.cliSource}` : "skip"}`,
    ...plan.helpers.map((helper) =>
      `helper shim: ${plan.link ? `${helper.target} -> exec ${helper.source}` : `${helper.target} (skip)`}`),
  ];
  return lines.join("\n");
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    assertNodeVersion();
    const plan = buildPlan(options);
    preflightPlan(plan);
    process.stdout.write(`${options.apply ? "APPLY" : "DRY-RUN"}\n${formatPlan(plan)}\n`);
    if (!options.apply) {
      process.stdout.write("変更はありません。実行するには --apply を付けてください。\n");
      return;
    }
    const result = applyPlan(plan);
    process.stdout.write(
      `setup complete: config=${result.config}, link=${result.link}, helpers=${JSON.stringify(result.helpers)}\n`,
    );
    process.stdout.write("次に hachi doctor を実行し、利用するmodel/transportとヘルパー導入状態を実機確認してください。\n");
  } catch (error) {
    process.stderr.write(`setup-local: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] === undefined ? "" : pathToFileURL(resolve(process.argv[1])).href;
if (entrypoint === import.meta.url) await main();
