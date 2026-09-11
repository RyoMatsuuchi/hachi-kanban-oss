// config.json のホットリロードと worker 実行中変更検知を支える補助関数。
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactText, sha256Hex } from "@hachi/core";
import type { Environment, HachiConfig, Logger, RunRow, StageDeps } from "@hachi/core";

export const CONFIG_FILE_SNAPSHOT_META_KEY = "configFileSnapshot";
export const CONFIG_MODIFIED_EVENT_TYPE = "config_modified_during_run";

export interface ConfigFileSnapshot {
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
  hash: string | null;
}

interface StageDepsWithConfigReloader extends StageDeps {
  reloadConfig?: () => HachiConfig;
}

interface SnapshotContext {
  stage: string;
  taskId?: string;
  sessionId?: string;
}

function configPath(env: Environment): string {
  return join(env.home, "config.json");
}

function errorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return null;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function readConfigFileSnapshot(env: Environment): ConfigFileSnapshot {
  const path = configPath(env);
  try {
    const raw = readFileSync(path, "utf8");
    const stat = statSync(path);
    return {
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: sha256Hex(raw),
    };
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      return { exists: false, mtimeMs: null, size: null, hash: null };
    }
    throw err;
  }
}

export function tryReadConfigFileSnapshot(
  env: Environment,
  logger: Logger,
  context: SnapshotContext,
): ConfigFileSnapshot | null {
  try {
    return readConfigFileSnapshot(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("config.json の snapshot 取得に失敗しました", {
      stage: context.stage,
      taskId: context.taskId,
      sessionId: context.sessionId,
      error: redactText(message),
    });
    return null;
  }
}

export function reloadDispatchConfig(deps: StageDeps, notes: string[]): HachiConfig {
  const reloader = (deps as StageDepsWithConfigReloader).reloadConfig;
  if (reloader === undefined) {
    return deps.config;
  }

  try {
    const config = reloader();
    deps.config = config;
    return config;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.warn("dispatch: config.json のホットリロードに失敗しました。前回値で継続します", {
      error: redactText(message),
    });
    notes.push(`config hot reload failed: ${redactText(message)}`);
    return deps.config;
  }
}

function isConfigFileSnapshot(value: unknown): value is ConfigFileSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const exists = record.exists;
  const mtimeMs = record.mtimeMs;
  const size = record.size;
  const hash = record.hash;
  return (
    typeof exists === "boolean" &&
    (mtimeMs === null || typeof mtimeMs === "number") &&
    (size === null || typeof size === "number") &&
    (hash === null || typeof hash === "string")
  );
}

function parseRunMeta(meta: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(meta) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function runStartConfigSnapshot(run: RunRow): ConfigFileSnapshot | null {
  const meta = parseRunMeta(run.meta);
  const snapshot = meta[CONFIG_FILE_SNAPSHOT_META_KEY];
  return isConfigFileSnapshot(snapshot) ? snapshot : null;
}

function snapshotsDiffer(start: ConfigFileSnapshot, current: ConfigFileSnapshot): boolean {
  return (
    start.exists !== current.exists ||
    start.mtimeMs !== current.mtimeMs ||
    start.size !== current.size ||
    start.hash !== current.hash
  );
}

export function buildConfigModifiedEventPayload(
  run: RunRow,
  current: ConfigFileSnapshot | null,
): Record<string, unknown> | null {
  const start = runStartConfigSnapshot(run);
  if (start === null || current === null || !snapshotsDiffer(start, current)) {
    return null;
  }
  return {
    sessionId: run.sessionId,
    start,
    current,
  };
}
