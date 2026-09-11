#!/usr/bin/env node
// @hachi/supervisor CLI エントリポイント（docs/contract.md §10）
// 引数: --apply / --once / --interval <sec>（既定 30） / --board <name>
import { mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
  ClaudeAdapter,
  ClaudeCrossSessionWorkerAdapter,
  CodexAdapter,
  CodexAppServerAdapter,
  DirectClaudeAdapter,
  DirectCodexAdapter,
} from "@hachi/adapters";
import {
  SqliteKanbanStore,
  createLogger,
  ensureEnvironmentDirs,
  loadConfig,
  loadLogRotationConfig,
  resolveEnvironment,
} from "@hachi/core";
import type {
  HachiConfig,
  NativeCommunicationAdapter,
  NativeCommunicationSocketSnapshot,
  Provider,
  StageDeps,
  WorkerAdapter,
} from "@hachi/core";
import { parseArgs } from "./argv.js";
import { NodeExternalRuntimeGenerationReader } from "./external-runtime-generation-reader.js";
import type { ExternalRuntimeGenerationReader } from "./external-runtime-generation-reader.js";
import { resolveExternalRuntimeGenerationRoot } from "./external-runtime-generation-root.js";
import { parseRunMeta } from "./session-ref.js";
import {
  createRuntimeResourceCleanupConfigReloader,
  createRuntimeResourceReconcileConfigReloader,
} from "./runtime-resource-config.js";
import { Supervisor } from "./supervisor.js";
import type { RuntimeResourceCleanupConfig } from "./stages/resource-cleanup.js";
import type { RuntimeResourceReconcileConfig } from "./stages/resource-reconcile.js";

interface StageDepsWithConfigReloader extends StageDeps {
  reloadConfig: () => HachiConfig;
  reloadRuntimeResourceReconcile: () => RuntimeResourceReconcileConfig | undefined;
  reloadRuntimeResourceCleanup: () => RuntimeResourceCleanupConfig | undefined;
  runtimeResourceReconcile?: RuntimeResourceReconcileConfig;
  runtimeResourceCleanup?: RuntimeResourceCleanupConfig;
  externalRuntimeGenerationReader: ExternalRuntimeGenerationReader;
}

interface ExistingNativeSocket {
  readonly socketPath: string;
  readonly socketSnapshot: NativeCommunicationSocketSnapshot;
}

function sameSocketSnapshot(
  left: NativeCommunicationSocketSnapshot,
  right: NativeCommunicationSocketSnapshot,
): boolean {
  return left.canonicalPath === right.canonicalPath &&
    left.parentCanonicalPath === right.parentCanonicalPath &&
    left.parentDev === right.parentDev &&
    left.parentIno === right.parentIno &&
    left.parentUid === right.parentUid &&
    left.parentMode === right.parentMode &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode;
}

function existingNativeSocket(store: SqliteKanbanStore): ExistingNativeSocket | undefined {
  let candidate: ExistingNativeSocket | undefined;
  for (const run of store.listOpenRuns()) {
    if (run.provider !== "codex") {
      continue;
    }
    const meta = parseRunMeta(run.meta);
    if (meta.nativeCommunication?.route !== "codex-app-server" || !meta.serverUrl.startsWith("unix://")) {
      continue;
    }
    const socketPath = meta.serverUrl.slice("unix://".length);
    const socketSnapshot = meta.nativeCommunication.socketSnapshot;
    if (!socketPath.startsWith("/") || socketSnapshot.canonicalPath !== socketPath) {
      continue;
    }
    const next: ExistingNativeSocket = { socketPath, socketSnapshot };
    if (candidate === undefined) {
      candidate = next;
      continue;
    }
    if (candidate.socketPath !== next.socketPath || !sameSocketSnapshot(candidate.socketSnapshot, next.socketSnapshot)) {
      return undefined;
    }
  }
  return candidate;
}

function hasExistingNativeRun(store: SqliteKanbanStore, provider: Provider): boolean {
  return store.listOpenRuns().some((run) => run.provider === provider && parseRunMeta(run.meta).nativeCommunication !== undefined);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const processEnv: NodeJS.ProcessEnv = { ...process.env };
  if (options.board !== undefined) {
    processEnv.HACHI_KANBAN_BOARD = options.board;
  }

  const env = resolveEnvironment(processEnv);
  ensureEnvironmentDirs(env);
  mkdirSync(join(env.home, "logs"), { recursive: true });

  const config = loadConfig(env);
  const store = new SqliteKanbanStore(env.dbPath);
  const externalRuntimeGenerationRoot = resolveExternalRuntimeGenerationRoot({
    env: processEnv,
    accountHome: Object.hasOwn(processEnv, "HERMES_HOME") ? "" : userInfo().homedir,
  });
  const externalRuntimeGenerationReader = new NodeExternalRuntimeGenerationReader({
    root: externalRuntimeGenerationRoot,
    endpoints: {
      codex: env.bridges.codex.url,
      claude: env.bridges.claude.url,
    },
  });

  const adapters: Record<Provider, WorkerAdapter> = {
    codex: new CodexAdapter(env.bridges.codex),
    claude: new ClaudeAdapter(env.bridges.claude),
  };

  // active native rollout では、launch と native probe/deliver が同じ worker adapter を
  // 共有する。bridge adapter は off/observe/draining および config drift 後の Hachi
  // fallback 用に残し、native adapter を implicit bridge fallback には使わない。
  const nativeCommunicationAdapters: Partial<Record<Provider, NativeCommunicationAdapter>> = {};
  const codexCommunication = config.communication?.codex;
  const codexSocket = existingNativeSocket(store);
  if (codexCommunication?.rollout === "canary" || codexCommunication?.rollout === "on" || codexSocket !== undefined) {
    nativeCommunicationAdapters.codex = new CodexAppServerAdapter({
      ...(codexSocket === undefined ? {} : {
        socketPath: codexSocket.socketPath,
        expectedSocketSnapshot: codexSocket.socketSnapshot,
      }),
      ...(codexCommunication?.bindingTtlSeconds === undefined
        ? {}
        : { bindingTtlSeconds: codexCommunication.bindingTtlSeconds }),
    });
  }
  const claudeCommunication = config.communication?.claude;
  if (claudeCommunication?.rollout === "canary" || claudeCommunication?.rollout === "on" || hasExistingNativeRun(store, "claude")) {
    const claudeNativeStateDir = join(env.home, "state", "claude-cross-session");
    mkdirSync(claudeNativeStateDir, { recursive: true });
    // Active rollout の launch/probe/delivery は同じ公開 adapter instance を共有する。
    // export/constructor が契約から外れた場合は compile-time で検出し、bridgeへ黙って戻さない。
    nativeCommunicationAdapters.claude = new ClaudeCrossSessionWorkerAdapter({
      stateDir: claudeNativeStateDir,
      providerTranscriptRoot: join(homedir(), ".claude", "projects"),
      ...(claudeCommunication?.bindingTtlSeconds === undefined
        ? {}
        : { bindingTtlSeconds: claudeCommunication.bindingTtlSeconds }),
      ...(claudeCommunication?.minimumRuntimeVersion === undefined
        ? {}
        : { minimumRuntimeVersion: claudeCommunication.minimumRuntimeVersion }),
    });
  }

  // 契約 §17.3 / §22.1: direct transport 用 adapter を構成する。state（out/exit/prompt/session JSON）の
  // 置き場 $home/state/direct-sessions を作成してから DirectCodexAdapter / DirectClaudeAdapter へ渡す。
  const directSessionsDir = join(env.home, "state", "direct-sessions");
  mkdirSync(directSessionsDir, { recursive: true });
  const directAdapters: Partial<Record<Provider, WorkerAdapter>> = {
    codex: new DirectCodexAdapter({ stateDir: directSessionsDir, artifactsDir: env.artifactsDir }),
    claude: new DirectClaudeAdapter({ stateDir: directSessionsDir, artifactsDir: env.artifactsDir }),
  };

  // size-based rotation（config.json の任意 logging セクション。既定は core 側の
  // DEFAULT_LOG_ROTATION_CONFIG）。現行ファイル名は変えず、rotate 後は supervisor.jsonl.1 のように
  // 退避する（既存の tail/grep runbook 手順を壊さないため）。
  const logRotationConfig = loadLogRotationConfig(env);
  const logger = createLogger({
    filePath: join(env.home, "logs", "supervisor.jsonl"),
    rotation: logRotationConfig,
  });
  const configPath = join(env.home, "config.json");
  const reloadRuntimeResourceReconcile = createRuntimeResourceReconcileConfigReloader(configPath);
  const reloadRuntimeResourceCleanup = createRuntimeResourceCleanupConfigReloader(configPath);
  // 起動時にも strict validation を行い、常駐後は stage が同じ loader を tick ごとに再実行する。
  const runtimeResourceReconcile = reloadRuntimeResourceReconcile();
  const runtimeResourceCleanup = reloadRuntimeResourceCleanup();

  const deps: StageDepsWithConfigReloader = {
    store,
    config,
    env,
    adapters,
    directAdapters,
    nativeCommunicationAdapters,
    externalRuntimeGenerationReader,
    logger,
    reloadConfig: () => loadConfig(env),
    reloadRuntimeResourceReconcile,
    reloadRuntimeResourceCleanup,
    ...(runtimeResourceReconcile === undefined ? {} : { runtimeResourceReconcile }),
    ...(runtimeResourceCleanup === undefined ? {} : { runtimeResourceCleanup }),
  };
  // §43.1: SqliteKanbanStore は TickMetricsRecorder を構造的に実装する（duck typing）
  const supervisor = new Supervisor(deps, {
    apply: options.apply,
    intervalSec: options.intervalSec,
    metricsRecorder: store,
  });

  // 契約 §33.1: 起動直後の heartbeat を書く（--once / 常駐ループ両モード共通）
  supervisor.writeStartupHeartbeat();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("supervisor shutdown", { signal });
    // 進行中の tick が完了してから DB を close する（tick 完了前に close すると
    // 実行中の SQLite 操作がクラッシュしうるため。docs/contract.md §12.9-2）
    await supervisor.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (options.once) {
    const results = await supervisor.runTick();
    logger.info("single tick完了", { results });
    store.close();
    return;
  }

  logger.info("supervisor start", { apply: options.apply, intervalSec: options.intervalSec });
  supervisor.startLoop(options.intervalSec);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`supervisor fatal error: ${message}\n`);
  process.exitCode = 1;
});
