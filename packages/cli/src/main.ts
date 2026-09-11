#!/usr/bin/env node
// =============================================================================
// hachi CLI の実環境エントリポイント。
// process.env / process.argv から CliDeps を組み立てて buildProgram(deps) に処理を委ねるだけの薄い層。
// =============================================================================

import { CommanderError } from "commander";
import {
  ensureEnvironmentDirs,
  loadConfig,
  resolveEnvironment,
  SqliteKanbanStore,
  type HachiConfig,
  type Provider,
  type WorkerAdapter,
} from "@hachi/core";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter, CodexAdapter, DirectClaudeAdapter, DirectCodexAdapter } from "@hachi/adapters";
import { extractGlobalFlags, stripLeadingSeparators } from "./argv.js";
import {
  resolveHermesHome,
  type CliDeps,
  type CliWriteCallback,
  type CliWriter,
} from "./deps.js";
import { buildProgram } from "./program.js";
import {
  createProcessStdinReader,
  defaultCanonicalizeSuccessorCwd,
  defaultCurrentHostId,
  defaultSuccessorTmuxReadback,
} from "./successor-attestation.js";
import { createSuccessorAttestationArtifactResolver } from "./successor-attestation-artifacts.js";

/**
 * config.json が不正な場合に doctor コマンドだけを起動させるためのプレースホルダ。
 * docs/contract.md §12.4-2: doctor は原因報告のために起動を許可するが、値そのものは
 * どのコマンドの判断にも使わせない（doctor は checkConfig 内で loadConfig を再実行し
 * 真の原因を報告するため、ここでは意味のある既定値を持たせない）。
 */
const DOCTOR_PLACEHOLDER_CONFIG: HachiConfig = {
  profiles: {},
  allowlist: { codex: [], claude: [] },
  resourceGuard: { maxInFlight: 0, maxLaunchesPerTick: 0 },
  defaultProfile: "",
};

function makeStreamWriter(stream: NodeJS.WritableStream): CliWriter {
  return {
    write(text: string, callback?: CliWriteCallback): void {
      if (callback === undefined) {
        stream.write(text);
        return;
      }
      stream.write(text, callback);
    },
  };
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  // `pnpm --filter @hachi/cli run hachi -- <args>`（README で案内している起動方法）では、
  // npm/yarn と異なり pnpm が区切りの "--" を剥がさずそのまま argv へ転送するため、
  // 先頭の "--" は本 CLI の引数ではなく pnpm 由来の区切りとして無条件に取り除く。
  // `pnpm hachi -- <args>` のようにユーザー自身が追加で "--" を渡すと二重になるため、
  // 先頭に連続する "--" を全て取り除く（docs/contract.md §12.9-4）。
  // 取り除かないと commander が「--」を「以降オプション解析しない」印と解釈し、
  // doctor --offline のようなフラグ付きコマンドの解析が壊れる。
  const argv = stripLeadingSeparators(rawArgv);

  // extractGlobalFlags は --board の値検証で throw しうる（docs/contract.md §12.10-4）。
  // config.json 読み込み失敗時と同じ体裁で、日本語エラーメッセージ + exit 1 で終える。
  let boardOverride: string | undefined;
  let debug: boolean;
  let rest: string[];
  try {
    ({ boardOverride, debug, rest } = extractGlobalFlags(argv));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`エラー: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  const envVars: NodeJS.ProcessEnv = { ...process.env };
  if (boardOverride !== undefined) {
    envVars.HACHI_KANBAN_BOARD = boardOverride;
  }

  const env = resolveEnvironment(envVars);
  ensureEnvironmentDirs(env);

  // グローバルフラグ除去後の rest[0] が実行しようとしているサブコマンド名。
  // doctor だけは config.json が不正でも起動を許可し、検査結果として原因を報告する。
  const isDoctorCommand = rest[0] === "doctor";

  let config: HachiConfig;
  try {
    config = loadConfig(env);
  } catch (err) {
    if (!isDoctorCommand) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`エラー: config.json の読み込みに失敗しました: ${message}\n`);
      process.exitCode = 1;
      return;
    }
    config = DOCTOR_PLACEHOLDER_CONFIG;
  }

  const store = new SqliteKanbanStore(env.dbPath);
  const adapters: Record<Provider, WorkerAdapter> = {
    codex: new CodexAdapter(env.bridges.codex),
    claude: new ClaudeAdapter(env.bridges.claude),
  };
  const directSessionsDir = join(env.home, "state", "direct-sessions");
  const directAdapters: Partial<Record<Provider, WorkerAdapter>> = {
    codex: new DirectCodexAdapter({ stateDir: directSessionsDir, artifactsDir: env.artifactsDir }),
    claude: new DirectClaudeAdapter({ stateDir: directSessionsDir, artifactsDir: env.artifactsDir }),
  };
  const successorAttestationArtifactResolver = createSuccessorAttestationArtifactResolver({
    hachiStateHome: env.home,
    processEnv: envVars,
    osHome: homedir(),
  });

  const deps: CliDeps = {
    store,
    config,
    env,
    hermesHome: resolveHermesHome(envVars, homedir()),
    adapters,
    directAdapters,
    stdin: createProcessStdinReader(),
    processEnv: envVars,
    successorTmuxReadback: defaultSuccessorTmuxReadback,
    currentHostId: defaultCurrentHostId,
    canonicalizeSuccessorCwd: defaultCanonicalizeSuccessorCwd,
    successorAttestationHashProbe: successorAttestationArtifactResolver,
    successorAttestationArtifactResolver,
    stdout: makeStreamWriter(process.stdout),
    stderr: makeStreamWriter(process.stderr),
    debug,
    exit: (code: number): void => {
      process.exitCode = code;
    },
  };

  try {
    await buildProgram(deps).parseAsync(rest, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exitCode = err.exitCode;
    } else {
      deps.stderr.write(`エラー: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`致命的エラー: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
