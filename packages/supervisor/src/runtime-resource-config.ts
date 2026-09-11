import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  runtimeResourcesSchema,
  type RuntimeResourcesConfig,
} from "@hachi/core";
import {
  DockerHostResourceAdapter,
  type CommandRunner,
  type CommandRunnerOptions,
  type CommandRunnerResult,
} from "@hachi/adapters";
import type { RuntimeResourceReconcileConfig } from "./stages/resource-reconcile.js";
import type { RuntimeResourceCleanupConfig } from "./stages/resource-cleanup.js";

interface RootConfigShape {
  runtimeResources?: unknown;
}

/** current host config の runtimeResources section を strict に読み取る。 */
export function loadRuntimeResourcesConfig(
  configPath: string,
): RuntimeResourcesConfig | undefined {
  let parsed: RootConfigShape;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as RootConfigShape;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("runtimeResources host config の root がobjectではありません");
  }
  return parsed.runtimeResources === undefined
    ? undefined
    : runtimeResourcesSchema.parse(parsed.runtimeResources);
}

/** shell を介さず Docker adapter の argv を実行する production runner。 */
export class SystemCommandRunner implements CommandRunner {
  run(argv: readonly string[], options?: CommandRunnerOptions): Promise<CommandRunnerResult> {
    const command = argv[0];
    if (command === undefined || command === "") {
      return Promise.reject(new Error("command argv は空にできません"));
    }
    return new Promise<CommandRunnerResult>((resolve) => {
      execFile(command, argv.slice(1), {
        maxBuffer: 1024 * 1024,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      }, (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ exitCode, stdout, stderr });
      });
    });
  }
}

/**
 * core の共有 HachiConfig 型を変更せず、§56 の独立 section を production stage dependency へ変換する。
 * section 欠如・observe・provision disabled は adapter を作らず observe-only を維持する。
 */
export function loadRuntimeResourceReconcileConfig(
  configPath: string,
  commandRunner: CommandRunner = new SystemCommandRunner(),
): RuntimeResourceReconcileConfig | undefined {
  const runtimeResources = loadRuntimeResourcesConfig(configPath);
  if (runtimeResources === undefined) {
    return undefined;
  }
  if (runtimeResources.mode !== "enforce") {
    return undefined;
  }
  if (runtimeResources.dockerContext === undefined || runtimeResources.worktreePostgres === undefined) {
    if (runtimeResources.provisioningEnabled) {
      throw new Error("runtimeResources enforce/provision には dockerContext と worktreePostgres が必須です");
    }
    return undefined;
  }
  return {
    mode: runtimeResources.mode,
    provisioningEnabled: runtimeResources.provisioningEnabled,
    leaseTtlSeconds: runtimeResources.leaseTtlSeconds,
    ...(runtimeResources.heartbeatIntervalSeconds === undefined
      ? {}
      : { heartbeatIntervalSeconds: runtimeResources.heartbeatIntervalSeconds }),
    rolloutGeneration: runtimeResources.rolloutGeneration ?? 1,
    scopeKey: runtimeResources.dockerContext,
    worktreePostgres: runtimeResources.worktreePostgres,
    runtimeResources,
    adapter: new DockerHostResourceAdapter({
      commandRunner,
      dockerContext: runtimeResources.dockerContext,
    }),
  };
}

/**
 * 常駐 supervisor が各 tick で current host config を strict に再解決するための loader を作る。
 * 同じ command runner を再利用しつつ、adapter と authority snapshot は毎回の config から作り直す。
 */
export function createRuntimeResourceReconcileConfigReloader(
  configPath: string,
  commandRunner: CommandRunner = new SystemCommandRunner(),
): () => RuntimeResourceReconcileConfig | undefined {
  return (): RuntimeResourceReconcileConfig | undefined =>
    loadRuntimeResourceReconcileConfig(configPath, commandRunner);
}

/** enforce cleanup 設定だけを exact-ID production adapter 付き dependency へ変換する。 */
export function loadRuntimeResourceCleanupConfig(
  configPath: string,
  commandRunner: CommandRunner = new SystemCommandRunner(),
  executorId = `resource-cleanup:${String(process.pid)}`,
): RuntimeResourceCleanupConfig | undefined {
  const runtimeResources = loadRuntimeResourcesConfig(configPath);
  if (runtimeResources === undefined) {
    return undefined;
  }
  if (runtimeResources.mode !== "enforce" || runtimeResources.cleanup === undefined) {
    return undefined;
  }
  if (runtimeResources.dockerContext === undefined) {
    throw new Error("runtimeResources enforce/cleanup には dockerContext が必須です");
  }
  return {
    mode: "enforce",
    ...runtimeResources.cleanup,
    executorId,
    adapter: new DockerHostResourceAdapter({
      commandRunner,
      dockerContext: runtimeResources.dockerContext,
    }),
  };
}

/**
 * cleanup も provision と同様に current host config を tick ごとに再読込する。
 * dockerContext や enforce/cleanup 設定が変わった後に、起動時 snapshot の adapter で
 * external effect を続行しないための fail-closed loader。
 */
export function createRuntimeResourceCleanupConfigReloader(
  configPath: string,
  commandRunner: CommandRunner = new SystemCommandRunner(),
  executorId = `resource-cleanup:${String(process.pid)}`,
): () => RuntimeResourceCleanupConfig | undefined {
  return (): RuntimeResourceCleanupConfig | undefined =>
    loadRuntimeResourceCleanupConfig(configPath, commandRunner, executorId);
}
