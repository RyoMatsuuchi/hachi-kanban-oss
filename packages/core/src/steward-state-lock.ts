// =============================================================================
// steward state のprocess間排他とdurable atomic file操作（docs/contract.md §40.5/§40.6）。
// CLI復帰とsupervisor tickが同じO_EXCL lockを使い、相互のstate上書きを防ぐ。
// =============================================================================

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const STEWARD_STATE_LOCK_NAME = "steward-state.lock";
export const STEWARD_STATE_LOCK_GUARD_NAME = `${STEWARD_STATE_LOCK_NAME}.guard`;
export const STEWARD_STATE_LOCK_STALE_SECONDS = 120;
const LOCK_VERSION = "steward-state-lock.v1";
const GUARD_VERSION = "steward-state-lock-guard.v1";
const MAX_LOCK_BYTES = 4_096;

export type StewardStateLockOwner =
  | "cli-steward-enable"
  | "supervisor-steward"
  | "cli-brief-enable"
  | "supervisor-brief";

const STEWARD_STATE_LOCK_OWNERS: readonly StewardStateLockOwner[] = [
  "cli-steward-enable",
  "supervisor-steward",
  "cli-brief-enable",
  "supervisor-brief",
];

interface StewardStateLockRecord {
  version: typeof LOCK_VERSION;
  owner: StewardStateLockOwner;
  operationId: string;
  pid: number;
  createdAt: number;
}

interface StewardStateLockGuardRecord {
  version: typeof GUARD_VERSION;
  owner: StewardStateLockOwner;
  nonce: string;
  pid: number;
  createdAt: number;
}

interface StewardStateLockGuardHandle {
  nonce: string;
  release(): void;
}

export interface StewardStateLockHandle {
  operationId: string;
  release(): void;
}

export interface AcquireStewardStateLockOptions {
  recoverStale?: boolean;
  processAlive?: (pid: number) => boolean;
  now?: () => number;
  /** 二回収者barrierを決定論的に検証するテスト用hook。guard保持中にだけ呼ぶ。 */
  beforeStaleRemoval?: () => void;
  /** O_EXCL作成後のI/O失敗cleanupを検証するテスト用hook。 */
  afterGuardOpened?: () => void;
  /** O_EXCL作成後のI/O失敗cleanupを検証するテスト用hook。 */
  afterMainOpened?: () => void;
}

export interface InspectStewardStateLockOptions {
  processAlive?: (pid: number) => boolean;
  now?: () => number;
}

export interface StewardStateLockInspection {
  ok: boolean;
  detail: string;
}

function assertNormalDirectory(path: string, label: string): void {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} は通常directoryである必要があります`);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length ||
      actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} のschema keyが不正です`);
  }
}

function parseLockRecord(raw: string): StewardStateLockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("steward state lock が壊れています");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("steward state lock が壊れています");
  }
  const record = parsed as Record<string, unknown>;
  assertExactKeys(record, ["version", "owner", "operationId", "pid", "createdAt"], "steward state lock");
  if (record["version"] !== LOCK_VERSION ||
      !STEWARD_STATE_LOCK_OWNERS.includes(String(record["owner"]) as StewardStateLockOwner) ||
      typeof record["operationId"] !== "string" || !/^op_[0-9a-f]{32}$/.test(record["operationId"]) ||
      !Number.isSafeInteger(record["pid"]) || (record["pid"] as number) <= 0 ||
      !Number.isSafeInteger(record["createdAt"]) || (record["createdAt"] as number) < 0) {
    throw new Error("steward state lock のschemaが不正です");
  }
  return record as unknown as StewardStateLockRecord;
}

function parseGuardRecord(raw: string): StewardStateLockGuardRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("steward state lock guard が壊れています");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("steward state lock guard が壊れています");
  }
  const record = parsed as Record<string, unknown>;
  assertExactKeys(record, ["version", "owner", "nonce", "pid", "createdAt"], "steward state lock guard");
  if (record["version"] !== GUARD_VERSION ||
      !STEWARD_STATE_LOCK_OWNERS.includes(String(record["owner"]) as StewardStateLockOwner) ||
      typeof record["nonce"] !== "string" || !/^guard_[0-9a-f]{32}$/.test(record["nonce"]) ||
      !Number.isSafeInteger(record["pid"]) || (record["pid"] as number) <= 0 ||
      !Number.isSafeInteger(record["createdAt"]) || (record["createdAt"] as number) < 0) {
    throw new Error("steward state lock guard のschemaが不正です");
  }
  return record as unknown as StewardStateLockGuardRecord;
}

function readLockRecord(path: string): StewardStateLockRecord {
  const linkStat = lstatSync(path, { bigint: true });
  if (linkStat.isSymbolicLink() || !linkStat.isFile() || linkStat.size > BigInt(MAX_LOCK_BYTES) ||
      Number(linkStat.mode & 0o777n) !== 0o600) {
    throw new Error("steward state lock は0600の通常小fileである必要があります");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_LOCK_BYTES) || Number(stat.mode & 0o777n) !== 0o600) {
      throw new Error("steward state lock のfile境界検証に失敗しました");
    }
    return parseLockRecord(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

function readGuardRecord(path: string): StewardStateLockGuardRecord {
  const linkStat = lstatSync(path, { bigint: true });
  if (linkStat.isSymbolicLink() || !linkStat.isFile() || linkStat.size > BigInt(MAX_LOCK_BYTES) ||
      Number(linkStat.mode & 0o777n) !== 0o600) {
    throw new Error("steward state lock guard は0600の通常小fileである必要があります");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_LOCK_BYTES) || Number(stat.mode & 0o777n) !== 0o600) {
      throw new Error("steward state lock guard のfile境界検証に失敗しました");
    }
    return parseGuardRecord(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

function cleanupOwnedPartialFile(path: string, parent: string, primaryError: unknown): never {
  try {
    rmSync(path, { force: true });
    fsyncDirectory(parent);
  } catch (cleanupError) {
    const primary = primaryError instanceof Error ? primaryError.message : String(primaryError);
    const secondary = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new Error(`lock file永続化失敗後のcleanupにも失敗しました: ${primary}; ${secondary}`);
  }
  throw primaryError;
}

function createGuard(
  home: string,
  owner: StewardStateLockOwner,
  now: () => number,
  afterOpened?: () => void,
): StewardStateLockGuardHandle | null {
  const path = join(home, STEWARD_STATE_LOCK_GUARD_NAME);
  const nonce = `guard_${randomBytes(16).toString("hex")}`;
  const record: StewardStateLockGuardRecord = {
    version: GUARD_VERSION,
    owner,
    nonce,
    pid: process.pid,
    createdAt: now(),
  };
  let fd: number | null = null;
  let created = false;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
    afterOpened?.();
    writeFileSync(fd, JSON.stringify(record), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    fsyncDirectory(home);
  } catch (error) {
    if (fd !== null) {
      closeSync(fd);
    }
    if (created) {
      cleanupOwnedPartialFile(path, home, error);
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // guardはcrash残骸も自動回収しない。live writerを奪うより安全側へ倒す。
      return null;
    }
    throw error;
  }
  let released = false;
  return {
    nonce,
    release: (): void => {
      if (released) {
        return;
      }
      const current = readGuardRecord(path);
      if (current.nonce !== nonce) {
        throw new Error("steward state lock guard の所有nonceが変化したため解放できません");
      }
      rmSync(path);
      fsyncDirectory(home);
      released = true;
    },
  };
}

function removeOwnedLock(path: string, operationId: string): void {
  const current = readLockRecord(path);
  if (current.operationId !== operationId) {
    throw new Error("steward state lock の所有権が変化したため解放できません");
  }
  rmSync(path);
  fsyncDirectory(dirname(path));
}

function createMainLock(
  home: string,
  owner: StewardStateLockOwner,
  now: () => number,
  afterOpened?: () => void,
): { operationId: string } {
  const path = join(home, STEWARD_STATE_LOCK_NAME);
  const operationId = `op_${randomBytes(16).toString("hex")}`;
  const record: StewardStateLockRecord = {
    version: LOCK_VERSION,
    owner,
    operationId,
    pid: process.pid,
    createdAt: now(),
  };
  let fd: number | null = null;
  let created = false;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
    afterOpened?.();
    writeFileSync(fd, JSON.stringify(record), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    fsyncDirectory(home);
  } catch (error) {
    if (fd !== null) {
      closeSync(fd);
    }
    if (created) {
      cleanupOwnedPartialFile(path, home, error);
    }
    throw error;
  }
  return { operationId };
}

function releaseMainLockWithGuard(
  home: string,
  owner: StewardStateLockOwner,
  operationId: string,
  now: () => number,
): void {
  const guard = createGuard(home, owner, now);
  if (guard === null) {
    throw new Error("steward state lock guard が使用中のためlockを解放できません");
  }
  try {
    removeOwnedLock(join(home, STEWARD_STATE_LOCK_NAME), operationId);
  } finally {
    guard.release();
  }
}

/**
 * O_EXCL lockを取得する。supervisorはrecoverStale=falseで既存lockを尊重し、
 * CLIだけがdead pidのcrash残骸をstrict validation後に回収できる。
 */
export function acquireStewardStateLock(
  home: string,
  owner: StewardStateLockOwner,
  options: AcquireStewardStateLockOptions = {},
): StewardStateLockHandle | null {
  assertNormalDirectory(home, "HACHI_KANBAN_HOME");
  const path = join(home, STEWARD_STATE_LOCK_NAME);
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const guard = createGuard(home, owner, now, options.afterGuardOpened);
  if (guard === null) {
    return null;
  }
  let operationId: string | null = null;
  try {
    try {
      operationId = createMainLock(home, owner, now, options.afterMainOpened).operationId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (options.recoverStale !== true) {
        return null;
      }
      const existing = readLockRecord(path);
      if (processAlive(existing.pid)) {
        throw new Error(`steward state は ${existing.owner} が操作中です`);
      }
      const age = now() - existing.createdAt;
      if (age < STEWARD_STATE_LOCK_STALE_SECONDS) {
        throw new Error("steward state lock は若いためcrash残骸として回収できません");
      }
      options.beforeStaleRemoval?.();
      removeOwnedLock(path, existing.operationId);
      operationId = createMainLock(home, owner, now, options.afterMainOpened).operationId;
    }
  } finally {
    guard.release();
  }
  if (operationId === null) {
    return null;
  }
  let released = false;
  return {
    operationId,
    release: (): void => {
      if (released) {
        return;
      }
      releaseMainLockWithGuard(home, owner, operationId, now);
      released = true;
    },
  };
}

function inspectLockRecord(
  path: string,
  label: "main" | "guard",
  processAlive: (pid: number) => boolean,
  now: number,
): { ok: boolean; detail: string } | null {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return { ok: false, detail: `${label} lockの確認に失敗: ${(error as Error).message}` };
  }
  try {
    const record = label === "main" ? readLockRecord(path) : readGuardRecord(path);
    const age = now - record.createdAt;
    if (age < 0) {
      return { ok: false, detail: `${label} lockのcreatedAtが未来です` };
    }
    const alive = processAlive(record.pid);
    if (!alive) {
      const state = age >= STEWARD_STATE_LOCK_STALE_SECONDS ? "stale" : "dead-pid grace";
      return { ok: false, detail: `${label} lock ${state}: owner=${record.owner} ageSec=${age}` };
    }
    if (label === "guard" && age >= STEWARD_STATE_LOCK_STALE_SECONDS) {
      return { ok: false, detail: `guard lockが長時間残存: owner=${record.owner} ageSec=${age}` };
    }
    return { ok: true, detail: `${label} lock使用中: owner=${record.owner} ageSec=${age}` };
  } catch (error) {
    return { ok: false, detail: `${label} lock不正: ${(error as Error).message}` };
  }
}

/** doctor向けread-only診断。nonceやstate本文は返さず、自動cleanupもしない。 */
export function inspectStewardStateLocks(
  home: string,
  options: InspectStewardStateLockOptions = {},
): StewardStateLockInspection {
  try {
    assertNormalDirectory(home, "HACHI_KANBAN_HOME");
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
  const now = (options.now ?? (() => Math.floor(Date.now() / 1_000)))();
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const main = inspectLockRecord(join(home, STEWARD_STATE_LOCK_NAME), "main", processAlive, now);
  const guard = inspectLockRecord(join(home, STEWARD_STATE_LOCK_GUARD_NAME), "guard", processAlive, now);
  const present = [main, guard].filter((value): value is { ok: boolean; detail: string } => value !== null);
  if (present.length === 0) {
    return { ok: true, detail: "main/guard lockなし" };
  }
  return {
    ok: present.every((value) => value.ok),
    detail: present.map((value) => value.detail).join("; "),
  };
}

/** file内容を0600 tempへfsyncし、rename後に親directoryもfsyncする。 */
export function writeFileAtomic0600Durable(path: string, raw: string): void {
  const parent = dirname(path);
  assertNormalDirectory(parent, "steward state parent");
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, raw, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, path);
    fsyncDirectory(parent);
  } catch (error) {
    if (fd !== null) {
      closeSync(fd);
    }
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

/** recovery journal等を削除し、directory entryまでdurableにする。 */
export function removeFileDurable(path: string): void {
  rmSync(path);
  fsyncDirectory(dirname(path));
}
