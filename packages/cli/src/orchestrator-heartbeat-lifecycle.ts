// =============================================================================
// orchestrator heartbeat の detached lifecycle。
// provider session ID だけを argv に残し、board session ID / generation は子processへ環境変数で渡す。
// pidfile は PID と OS のprocess起動時刻を組にし、PID再利用された別processへsignalしない。
// =============================================================================

import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ORCHESTRATOR_AWAIT_HEARTBEAT_INTERVAL_SECONDS } from "@hachi/core";

const PIDFILE_VERSION = 1;
const MAX_STATE_FILE_BYTES = 4_096;
const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const HEARTBEAT_STATE_ENV_SESSION_ID = "HACHI_ORCHESTRATOR_HEARTBEAT_SESSION_ID";
const HEARTBEAT_STATE_ENV_GENERATION = "HACHI_ORCHESTRATOR_HEARTBEAT_GENERATION";
const HEARTBEAT_STATE_ENV_OWNER_TOKEN = "HACHI_ORCHESTRATOR_HEARTBEAT_OWNER_TOKEN";

export const ORCHESTRATOR_HEARTBEAT_SUPERSEDED_EXIT_CODE = 20;

export interface HeartbeatLifecyclePaths {
  directory: string;
  pidfile: string;
  lockfile: string;
  logfile: string;
}

export interface HeartbeatPidfileRecord {
  version: 1;
  pid: number;
  processStartedAt: string;
  createdAt: number;
}

interface HeartbeatLockRecord extends HeartbeatPidfileRecord {
  ownerToken: string;
}

export interface HeartbeatBootstrapInput {
  home: string;
  board: string;
  providerSessionId: string;
  sessionId: string;
  generation: number;
  processEnv: Readonly<NodeJS.ProcessEnv>;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface HeartbeatBootstrapResult {
  status: "started";
  pid: number;
  processStartedAt: string;
  pidfile: string;
  logfile: string;
}

export interface HeartbeatStopInput {
  home: string;
  providerSessionId: string;
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
}

export type HeartbeatStopResult =
  | { status: "not-running"; disappearanceConfirmed: true; pidfile: string }
  | {
    status: "stale-pidfile";
    disappearanceConfirmed: true;
    pid: number;
    pidReused: boolean;
    pidfile: string;
  }
  | {
    status: "stopped";
    disappearanceConfirmed: true;
    pid: number;
    forced: boolean;
    pidfile: string;
  };

export interface HeartbeatDaemonInput {
  home: string;
  providerSessionId: string;
  sessionId: string;
  generation: number;
  ownerToken: string;
  heartbeat: () => void;
  onTransientError: (message: string) => void;
}

export type HeartbeatLoopResult =
  | { reason: "stopped"; exitCode: 0 }
  | { reason: "superseded"; exitCode: typeof ORCHESTRATOR_HEARTBEAT_SUPERSEDED_EXIT_CODE; error: string };

interface SpawnHeartbeatDaemonInput extends HeartbeatBootstrapInput {
  ownerToken: string;
  logfile: string;
}

interface SpawnedHeartbeatDaemon {
  pid: number;
}

export interface HeartbeatLifecycleRuntime {
  currentPid(): number;
  nowMs(): number;
  randomToken(): string;
  getProcessStartTime(pid: number): string | null;
  spawnDaemon(input: SpawnHeartbeatDaemonInput): SpawnedHeartbeatDaemon;
  signalProcess(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
}

export interface OrchestratorHeartbeatLifecycle {
  bootstrap(input: HeartbeatBootstrapInput): Promise<HeartbeatBootstrapResult>;
  stop(input: HeartbeatStopInput): Promise<HeartbeatStopResult>;
  runDaemon(input: HeartbeatDaemonInput): Promise<HeartbeatLoopResult>;
}

interface OperationLockHandle {
  record: HeartbeatLockRecord;
  release(): void;
}

/** watcher版でも同じ命名規則を使えるよう、kind directoryの下はidentity hashだけで構成する。 */
export function resolveHeartbeatLifecyclePaths(home: string, providerSessionId: string): HeartbeatLifecyclePaths {
  const normalizedProviderSessionId = normalizeProviderSessionId(providerSessionId);
  const digest = createHash("sha256").update(normalizedProviderSessionId, "utf8").digest("hex");
  const directory = join(home, "state", "heartbeat");
  const prefix = `session-${digest}`;
  return {
    directory,
    pidfile: join(directory, `${prefix}.pid.json`),
    lockfile: join(directory, `${prefix}.lock.json`),
    logfile: join(directory, `${prefix}.log`),
  };
}

function normalizeProviderSessionId(providerSessionId: string): string {
  const normalized = providerSessionId.trim();
  if (normalized === "") {
    throw new Error("provider session ID は空にできません");
  }
  return normalized;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} のschemaが不正です`);
  }
}

function parsePidfileRecord(raw: string): HeartbeatPidfileRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("heartbeat pidfile が壊れています");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("heartbeat pidfile が壊れています");
  }
  const record = parsed as Record<string, unknown>;
  assertExactKeys(record, ["version", "pid", "processStartedAt", "createdAt"], "heartbeat pidfile");
  if (record["version"] !== PIDFILE_VERSION || !isPositiveInteger(record["pid"]) ||
      typeof record["processStartedAt"] !== "string" || record["processStartedAt"].trim() === "" ||
      !Number.isSafeInteger(record["createdAt"]) || (record["createdAt"] as number) < 0) {
    throw new Error("heartbeat pidfile のschemaが不正です");
  }
  return record as unknown as HeartbeatPidfileRecord;
}

function parseLockRecord(raw: string): HeartbeatLockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("heartbeat lifecycle lock が壊れています");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("heartbeat lifecycle lock が壊れています");
  }
  const record = parsed as Record<string, unknown>;
  assertExactKeys(
    record,
    ["version", "ownerToken", "pid", "processStartedAt", "createdAt"],
    "heartbeat lifecycle lock",
  );
  if (record["version"] !== PIDFILE_VERSION || typeof record["ownerToken"] !== "string" ||
      !/^[0-9a-f]{32}$/.test(record["ownerToken"]) || !isPositiveInteger(record["pid"]) ||
      typeof record["processStartedAt"] !== "string" || record["processStartedAt"].trim() === "" ||
      !Number.isSafeInteger(record["createdAt"]) || (record["createdAt"] as number) < 0) {
    throw new Error("heartbeat lifecycle lock のschemaが不正です");
  }
  return record as unknown as HeartbeatLockRecord;
}

function readSecureStateFile<T>(path: string, label: string, parse: (raw: string) => T): T | null {
  let linkStat;
  try {
    linkStat = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (linkStat.isSymbolicLink() || !linkStat.isFile() || linkStat.size > BigInt(MAX_STATE_FILE_BYTES) ||
      Number(linkStat.mode & 0o777n) !== 0o600) {
    throw new Error(`${label} は0600の通常小fileである必要があります`);
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_STATE_FILE_BYTES) || Number(stat.mode & 0o777n) !== 0o600) {
      throw new Error(`${label} のfile境界検証に失敗しました`);
    }
    return parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

function readPidfile(path: string): HeartbeatPidfileRecord | null {
  return readSecureStateFile(path, "heartbeat pidfile", parsePidfileRecord);
}

function readLockfile(path: string): HeartbeatLockRecord | null {
  return readSecureStateFile(path, "heartbeat lifecycle lock", parseLockRecord);
}

function writeExclusiveStateFile(path: string, record: HeartbeatPidfileRecord | HeartbeatLockRecord): void {
  let fd: number | null = null;
  let created = false;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    writeFileSync(fd, JSON.stringify(record), "utf8");
    fsyncSync(fd);
  } catch (error) {
    if (created) {
      rmSync(path, { force: true });
    }
    throw error;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

function recordsMatch(
  first: HeartbeatPidfileRecord,
  second: HeartbeatPidfileRecord,
): boolean {
  return first.version === second.version && first.pid === second.pid &&
    first.processStartedAt === second.processStartedAt && first.createdAt === second.createdAt;
}

function removePidfileIfOwned(path: string, expected: HeartbeatPidfileRecord): void {
  const current = readPidfile(path);
  if (current !== null && recordsMatch(current, expected)) {
    rmSync(path);
  }
}

function lockRecordsMatch(first: HeartbeatLockRecord, second: HeartbeatLockRecord): boolean {
  return recordsMatch(first, second) && first.ownerToken === second.ownerToken;
}

function removeLockIfOwned(path: string, expected: HeartbeatLockRecord): void {
  const current = readLockfile(path);
  if (current !== null && lockRecordsMatch(current, expected)) {
    rmSync(path);
  }
}

function ensureHeartbeatStateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("heartbeat state directory は通常directoryである必要があります");
  }
}

function acquireOperationLock(
  paths: HeartbeatLifecyclePaths,
  runtime: HeartbeatLifecycleRuntime,
): OperationLockHandle {
  ensureHeartbeatStateDirectory(paths.directory);
  const currentPid = runtime.currentPid();
  const processStartedAt = runtime.getProcessStartTime(currentPid);
  if (processStartedAt === null) {
    throw new Error("heartbeat lifecycle CLI 自身のprocess起動時刻を取得できません");
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record: HeartbeatLockRecord = {
      version: PIDFILE_VERSION,
      ownerToken: runtime.randomToken(),
      pid: currentPid,
      processStartedAt,
      createdAt: runtime.nowMs(),
    };
    try {
      writeExclusiveStateFile(paths.lockfile, record);
      let released = false;
      return {
        record,
        release: (): void => {
          if (!released) {
            removeLockIfOwned(paths.lockfile, record);
            released = true;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const existing = readLockfile(paths.lockfile);
      if (existing === null) {
        continue;
      }
      const actualStartedAt = runtime.getProcessStartTime(existing.pid);
      if (actualStartedAt === existing.processStartedAt) {
        throw new Error(`heartbeat lifecycle 操作が進行中です: pid=${existing.pid}`);
      }
      removeLockIfOwned(paths.lockfile, existing);
    }
  }
  throw new Error("heartbeat lifecycle lock を取得できません");
}

function openHeartbeatLog(path: string): number {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile() || Number(stat.mode & 0o777n) !== 0o600) {
      throw new Error("heartbeat log は0600の通常fileである必要があります");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
}

function defaultGetProcessStartTime(pid: number): string | null {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output === "" ? null : output;
  } catch (error) {
    const status = (error as NodeJS.ErrnoException & { status?: number }).status;
    if (status === 1) {
      return null;
    }
    throw error;
  }
}

function defaultSpawnDaemon(input: SpawnHeartbeatDaemonInput): SpawnedHeartbeatDaemon {
  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../bin/hachi");
  const logFd = openHeartbeatLog(input.logfile);
  try {
    const child = spawn(
      cliPath,
      [
        "orchestrator",
        "session",
        "bootstrap-heartbeat",
        "--provider-session-id",
        normalizeProviderSessionId(input.providerSessionId),
        "--daemon",
      ],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: {
          ...input.processEnv,
          HACHI_KANBAN_HOME: input.home,
          HACHI_KANBAN_BOARD: input.board,
          [HEARTBEAT_STATE_ENV_SESSION_ID]: input.sessionId,
          [HEARTBEAT_STATE_ENV_GENERATION]: String(input.generation),
          [HEARTBEAT_STATE_ENV_OWNER_TOKEN]: input.ownerToken,
        },
      },
    );
    if (child.pid === undefined || !isPositiveInteger(child.pid)) {
      throw new Error("detached heartbeat process の PID を取得できません");
    }
    child.unref();
    return { pid: child.pid };
  } finally {
    closeSync(logFd);
  }
}

function defaultSignalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

export const DEFAULT_HEARTBEAT_LIFECYCLE_RUNTIME: HeartbeatLifecycleRuntime = {
  currentPid: () => process.pid,
  nowMs: () => Date.now(),
  randomToken: () => randomBytes(16).toString("hex"),
  getProcessStartTime: defaultGetProcessStartTime,
  spawnDaemon: defaultSpawnDaemon,
  signalProcess: defaultSignalProcess,
  sleep: defaultSleep,
};

async function waitForExactProcessDisappearance(
  runtime: HeartbeatLifecycleRuntime,
  record: HeartbeatPidfileRecord,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = runtime.nowMs() + timeoutMs;
  for (;;) {
    if (runtime.getProcessStartTime(record.pid) !== record.processStartedAt) {
      return true;
    }
    if (runtime.nowMs() >= deadline) {
      return false;
    }
    await runtime.sleep(Math.max(1, pollIntervalMs));
  }
}

async function stopSpawnedProcessAfterFailure(
  runtime: HeartbeatLifecycleRuntime,
  pid: number,
  processStartedAt: string | null,
  pollIntervalMs: number,
): Promise<void> {
  if (processStartedAt === null || runtime.getProcessStartTime(pid) !== processStartedAt) {
    return;
  }
  const record: HeartbeatPidfileRecord = {
    version: PIDFILE_VERSION,
    pid,
    processStartedAt,
    createdAt: runtime.nowMs(),
  };
  runtime.signalProcess(pid, "SIGTERM");
  if (await waitForExactProcessDisappearance(runtime, record, 500, pollIntervalMs)) {
    return;
  }
  if (runtime.getProcessStartTime(pid) === processStartedAt) {
    runtime.signalProcess(pid, "SIGKILL");
    await waitForExactProcessDisappearance(runtime, record, 500, pollIntervalMs);
  }
}

export async function bootstrapHeartbeatProcess(
  input: HeartbeatBootstrapInput,
  runtime: HeartbeatLifecycleRuntime = DEFAULT_HEARTBEAT_LIFECYCLE_RUNTIME,
): Promise<HeartbeatBootstrapResult> {
  normalizeProviderSessionId(input.providerSessionId);
  if (!isPositiveInteger(input.generation)) {
    throw new Error("heartbeat generation は正の整数が必須です");
  }
  const paths = resolveHeartbeatLifecyclePaths(input.home, input.providerSessionId);
  const lock = acquireOperationLock(paths, runtime);
  let spawnedPid: number | null = null;
  let spawnedStartedAt: string | null = null;
  let observedPidfile: HeartbeatPidfileRecord | null = null;
  let ownsSpawnedArtifacts = false;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  try {
    const existing = readPidfile(paths.pidfile);
    if (existing !== null) {
      const actualStartedAt = runtime.getProcessStartTime(existing.pid);
      if (actualStartedAt === existing.processStartedAt) {
        throw new Error(`heartbeat already: pid=${existing.pid}`);
      }
      removePidfileIfOwned(paths.pidfile, existing);
    }

    ownsSpawnedArtifacts = true;
    const spawned = runtime.spawnDaemon({
      ...input,
      ownerToken: lock.record.ownerToken,
      logfile: paths.logfile,
    });
    spawnedPid = spawned.pid;
    const deadline = runtime.nowMs() + (input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    for (;;) {
      spawnedStartedAt = runtime.getProcessStartTime(spawned.pid);
      const pidfile = readPidfile(paths.pidfile);
      if (pidfile !== null && runtime.getProcessStartTime(pidfile.pid) === pidfile.processStartedAt) {
        observedPidfile = pidfile;
        return {
          status: "started",
          pid: pidfile.pid,
          processStartedAt: pidfile.processStartedAt,
          pidfile: paths.pidfile,
          logfile: paths.logfile,
        };
      }
      if (spawnedStartedAt === null && pidfile === null) {
        throw new Error("detached heartbeat process がpidfile作成前に終了しました");
      }
      if (runtime.nowMs() >= deadline) {
        throw new Error("detached heartbeat process の起動確認がtimeoutしました");
      }
      await runtime.sleep(Math.max(1, pollIntervalMs));
    }
  } catch (error) {
    if (ownsSpawnedArtifacts) {
      const daemonPidfile = observedPidfile ?? readPidfile(paths.pidfile);
      if (daemonPidfile !== null) {
        await stopSpawnedProcessAfterFailure(
          runtime,
          daemonPidfile.pid,
          daemonPidfile.processStartedAt,
          pollIntervalMs,
        );
        removePidfileIfOwned(paths.pidfile, daemonPidfile);
      }
      if (spawnedPid !== null) {
        await stopSpawnedProcessAfterFailure(runtime, spawnedPid, spawnedStartedAt, pollIntervalMs);
      }
    }
    throw error;
  } finally {
    lock.release();
  }
}

export async function stopHeartbeatProcess(
  input: HeartbeatStopInput,
  runtime: HeartbeatLifecycleRuntime = DEFAULT_HEARTBEAT_LIFECYCLE_RUNTIME,
): Promise<HeartbeatStopResult> {
  normalizeProviderSessionId(input.providerSessionId);
  const paths = resolveHeartbeatLifecyclePaths(input.home, input.providerSessionId);
  const lock = acquireOperationLock(paths, runtime);
  const timeoutMs = input.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  try {
    const pidfile = readPidfile(paths.pidfile);
    if (pidfile === null) {
      return { status: "not-running", disappearanceConfirmed: true, pidfile: paths.pidfile };
    }
    const actualStartedAt = runtime.getProcessStartTime(pidfile.pid);
    if (actualStartedAt !== pidfile.processStartedAt) {
      removePidfileIfOwned(paths.pidfile, pidfile);
      return {
        status: "stale-pidfile",
        disappearanceConfirmed: true,
        pid: pidfile.pid,
        pidReused: actualStartedAt !== null,
        pidfile: paths.pidfile,
      };
    }

    runtime.signalProcess(pidfile.pid, "SIGTERM");
    if (await waitForExactProcessDisappearance(runtime, pidfile, timeoutMs, pollIntervalMs)) {
      removePidfileIfOwned(paths.pidfile, pidfile);
      return {
        status: "stopped",
        disappearanceConfirmed: true,
        pid: pidfile.pid,
        forced: false,
        pidfile: paths.pidfile,
      };
    }

    if (runtime.getProcessStartTime(pidfile.pid) === pidfile.processStartedAt) {
      runtime.signalProcess(pidfile.pid, "SIGKILL");
    }
    if (!await waitForExactProcessDisappearance(runtime, pidfile, timeoutMs, pollIntervalMs)) {
      throw new Error(`heartbeat process の消滅を確認できません: pid=${pidfile.pid}`);
    }
    removePidfileIfOwned(paths.pidfile, pidfile);
    return {
      status: "stopped",
      disappearanceConfirmed: true,
      pid: pidfile.pid,
      forced: true,
      pidfile: paths.pidfile,
    };
  } finally {
    lock.release();
  }
}

function isSessionSuperseded(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).includes("SESSION_SUPERSEDED");
}

export async function runHeartbeatLoop(input: {
  heartbeat: () => void;
  shouldStop: () => boolean;
  wait: (ms: number) => Promise<void>;
  onTransientError: (message: string) => void;
  intervalMs?: number;
}): Promise<HeartbeatLoopResult> {
  const intervalMs = input.intervalMs ?? ORCHESTRATOR_AWAIT_HEARTBEAT_INTERVAL_SECONDS * 1_000;
  for (;;) {
    if (input.shouldStop()) {
      return { reason: "stopped", exitCode: 0 };
    }
    try {
      input.heartbeat();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isSessionSuperseded(error)) {
        return {
          reason: "superseded",
          exitCode: ORCHESTRATOR_HEARTBEAT_SUPERSEDED_EXIT_CODE,
          error: message,
        };
      }
      input.onTransientError(message);
    }
    if (input.shouldStop()) {
      return { reason: "stopped", exitCode: 0 };
    }
    await input.wait(intervalMs);
  }
}

function createInterruptibleWait(stopRequested: () => boolean): {
  wait: (ms: number) => Promise<void>;
  wake: () => void;
} {
  let wakeCurrent: (() => void) | null = null;
  return {
    wait: (ms: number): Promise<void> => {
      if (stopRequested()) {
        return Promise.resolve();
      }
      return new Promise((resolveWait) => {
        const timer = setTimeout(() => {
          wakeCurrent = null;
          resolveWait();
        }, ms);
        wakeCurrent = (): void => {
          clearTimeout(timer);
          wakeCurrent = null;
          resolveWait();
        };
      });
    },
    wake: (): void => {
      wakeCurrent?.();
    },
  };
}

export async function runHeartbeatDaemon(
  input: HeartbeatDaemonInput,
  runtime: HeartbeatLifecycleRuntime = DEFAULT_HEARTBEAT_LIFECYCLE_RUNTIME,
): Promise<HeartbeatLoopResult> {
  normalizeProviderSessionId(input.providerSessionId);
  if (!isPositiveInteger(input.generation)) {
    throw new Error("heartbeat generation は正の整数が必須です");
  }
  if (!/^[0-9a-f]{32}$/.test(input.ownerToken)) {
    throw new Error("heartbeat daemon owner token が不正です");
  }
  const paths = resolveHeartbeatLifecyclePaths(input.home, input.providerSessionId);
  ensureHeartbeatStateDirectory(paths.directory);
  const lock = readLockfile(paths.lockfile);
  if (lock === null || lock.ownerToken !== input.ownerToken) {
    throw new Error("heartbeat daemon の起動lockを確認できません");
  }
  const pid = runtime.currentPid();
  const processStartedAt = runtime.getProcessStartTime(pid);
  if (processStartedAt === null) {
    throw new Error("heartbeat daemon のprocess起動時刻を取得できません");
  }
  const pidfile: HeartbeatPidfileRecord = {
    version: PIDFILE_VERSION,
    pid,
    processStartedAt,
    createdAt: runtime.nowMs(),
  };
  writeExclusiveStateFile(paths.pidfile, pidfile);

  let stopRequested = false;
  const waitControl = createInterruptibleWait(() => stopRequested);
  const requestStop = (): void => {
    stopRequested = true;
    waitControl.wake();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    return await runHeartbeatLoop({
      heartbeat: input.heartbeat,
      shouldStop: () => stopRequested,
      wait: waitControl.wait,
      onTransientError: input.onTransientError,
    });
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    removePidfileIfOwned(paths.pidfile, pidfile);
  }
}

export function heartbeatDaemonEnvironment(
  processEnv: Readonly<NodeJS.ProcessEnv>,
): { sessionId: string; generation: number; ownerToken: string } {
  const sessionId = processEnv[HEARTBEAT_STATE_ENV_SESSION_ID]?.trim() ?? "";
  const rawGeneration = processEnv[HEARTBEAT_STATE_ENV_GENERATION]?.trim() ?? "";
  const ownerToken = processEnv[HEARTBEAT_STATE_ENV_OWNER_TOKEN]?.trim() ?? "";
  const generation = Number(rawGeneration);
  if (sessionId === "" || !isPositiveInteger(generation) || !/^[0-9a-f]{32}$/.test(ownerToken)) {
    throw new Error("heartbeat daemon の内部環境が不正です");
  }
  return { sessionId, generation, ownerToken };
}

export const DEFAULT_ORCHESTRATOR_HEARTBEAT_LIFECYCLE: OrchestratorHeartbeatLifecycle = {
  bootstrap: (input) => bootstrapHeartbeatProcess(input),
  stop: (input) => stopHeartbeatProcess(input),
  runDaemon: (input) => runHeartbeatDaemon(input),
};
