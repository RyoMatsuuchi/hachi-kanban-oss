// =============================================================================
// brief auto-disable の厳格な復帰計画と file I/O（docs/contract.md §48.3）。
// state本文を外へ出さず、hash/inode CASでapplyとrollbackを限定する。
// =============================================================================

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import {
  removeFileDurable,
  writeFileAtomic0600Durable,
} from "@hachi/core";

export const MAX_BRIEF_STATE_BYTES = 64 * 1_024;
const MAX_PENDING_BYTES = 4_096;

export interface BriefEnableState {
  lastRunAt: number;
  lastError: string;
  consecutiveFailures: number;
  autoDisabled: boolean;
  autoDisabledReason: string;
  /** auto-disable へ遷移した epoch 秒。legacy state に無い場合は 0 とみなす */
  autoDisabledAt: number;
  /** half-open claim の単調増加世代。legacy state に無い場合は 0 とみなす */
  claimGeneration: number;
}

export type BriefEnableOutcome = "changed" | "already-enabled" | "no-state";

export interface BriefEnableResult {
  outcome: BriefEnableOutcome;
  changed: boolean;
  lastRunAt: number | null;
}

export interface PreparedBriefEnable {
  result: BriefEnableResult;
  beforeHash: string | null;
  afterHash: string | null;
  compensatedHash: string | null;
  apply(): AppliedBriefEnable | null;
}

export interface AppliedBriefEnable {
  afterHash: string;
  rollbackIfUnchanged(): boolean;
}

interface BriefEnablePendingJournalV1 {
  version: "brief-enable-pending.v1";
  operationId: string;
  beforeHash: string;
  afterHash: string;
  outcome: "changed";
  lastRunAt: number;
  createdAt: number;
}

interface BriefEnablePendingJournalV2 {
  version: "brief-enable-pending.v2";
  operationId: string;
  beforeHash: string;
  afterHash: string;
  compensatedHash: string;
  outcome: "changed";
  lastRunAt: number;
  createdAt: number;
}

export type BriefEnablePendingJournal = BriefEnablePendingJournalV1 | BriefEnablePendingJournalV2;

interface StateDirectory {
  path: string;
  device: bigint | null;
  inode: bigint | null;
}

interface StateSnapshot {
  stateDirPath: string;
  stateDirDevice: bigint;
  stateDirInode: bigint;
  path: string;
  raw: string;
  device: bigint;
  inode: bigint;
  mode: number;
  state: BriefEnableState;
}

const REQUIRED_STATE_KEYS = [
  "lastRunAt",
  "lastError",
  "consecutiveFailures",
  "autoDisabled",
  "autoDisabledReason",
] as const;

/** 後から追加した field。欠落は後方互換値として扱い、存在時は厳格に検証する。 */
const OPTIONAL_STATE_KEYS = ["autoDisabledAt", "claimGeneration"] as const;

const STATE_KEYS = [...REQUIRED_STATE_KEYS, ...OPTIONAL_STATE_KEYS] as const;

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`brief state ${label} は0以上の安全な整数が必須です`);
  }
  return value as number;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`brief state ${label} は文字列が必須です`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, label: string): number {
  return value === undefined ? 0 : requireNonNegativeInteger(value, label);
}

function incrementClaimGeneration(claimGeneration: number): number {
  if (claimGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new Error("brief state claimGeneration は Number.MAX_SAFE_INTEGER 未満が必須です");
  }
  return claimGeneration + 1;
}

/** schema外fieldや不正型を補完せず拒否する。 */
export function parseBriefStateStrict(raw: string): BriefEnableState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("brief state の JSON が壊れています");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("brief state は JSON object が必須です");
  }
  const record = parsed as Record<string, unknown>;
  const allowed = new Set<string>(STATE_KEYS);
  const hasKey = (key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
  if (Object.keys(record).some((key) => !allowed.has(key)) || !REQUIRED_STATE_KEYS.every(hasKey)) {
    throw new Error("brief state に不足または未知の field があります");
  }
  if (typeof record["autoDisabled"] !== "boolean") {
    throw new Error("brief state autoDisabled は boolean が必須です");
  }
  return {
    lastRunAt: requireNonNegativeInteger(record["lastRunAt"], "lastRunAt"),
    lastError: requireString(record["lastError"], "lastError"),
    consecutiveFailures: requireNonNegativeInteger(record["consecutiveFailures"], "consecutiveFailures"),
    autoDisabled: record["autoDisabled"],
    autoDisabledReason: requireString(record["autoDisabledReason"], "autoDisabledReason"),
    autoDisabledAt: optionalNonNegativeInteger(record["autoDisabledAt"], "autoDisabledAt"),
    claimGeneration: optionalNonNegativeInteger(record["claimGeneration"], "claimGeneration"),
  };
}

export function decideBriefEnable(state: BriefEnableState | null): {
  result: BriefEnableResult;
  nextState: BriefEnableState | null;
} {
  if (state === null) {
    return { result: { outcome: "no-state", changed: false, lastRunAt: null }, nextState: null };
  }
  if (!state.autoDisabled) {
    return {
      result: { outcome: "already-enabled", changed: false, lastRunAt: state.lastRunAt },
      nextState: state,
    };
  }
  return {
    result: { outcome: "changed", changed: true, lastRunAt: state.lastRunAt },
    nextState: {
      ...state,
      lastError: "",
      consecutiveFailures: 0,
      autoDisabled: false,
      autoDisabledReason: "",
      autoDisabledAt: 0,
      claimGeneration: incrementClaimGeneration(state.claimGeneration),
    },
  };
}

function lstatOrNull(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertStateDirectory(home: string): StateDirectory {
  const homeStat = lstatOrNull(home);
  if (homeStat === null || homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new Error("HACHI_KANBAN_HOME は通常directoryである必要があります");
  }
  const stateDir = join(home, "state");
  const stat = lstatOrNull(stateDir);
  if (stat === null) {
    return { path: stateDir, device: null, inode: null };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("brief state directory は通常directoryである必要があります");
  }
  return { path: stateDir, device: stat.dev, inode: stat.ino };
}

function readSnapshot(home: string): StateSnapshot | null {
  const stateDir = assertStateDirectory(home);
  const path = join(stateDir.path, "brief.json");
  const linkStat = lstatOrNull(path);
  if (linkStat === null) {
    return null;
  }
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new Error("brief state は通常fileである必要があります");
  }
  if (linkStat.size > BigInt(MAX_BRIEF_STATE_BYTES)) {
    throw new Error(`brief state は ${MAX_BRIEF_STATE_BYTES} bytes 以下である必要があります`);
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_BRIEF_STATE_BYTES)) {
      throw new Error("brief state の file境界検証に失敗しました");
    }
    const raw = readFileSync(fd, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_BRIEF_STATE_BYTES) {
      throw new Error(`brief state は ${MAX_BRIEF_STATE_BYTES} bytes 以下である必要があります`);
    }
    return {
      stateDirPath: stateDir.path,
      stateDirDevice: stateDir.device!,
      stateDirInode: stateDir.inode!,
      path,
      raw,
      device: stat.dev,
      inode: stat.ino,
      mode: Number(stat.mode & 0o777n),
      state: parseBriefStateStrict(raw),
    };
  } finally {
    closeSync(fd);
  }
}

function assertSnapshotUnchanged(snapshot: StateSnapshot): void {
  const stateDirStat = lstatSync(snapshot.stateDirPath, { bigint: true });
  if (stateDirStat.isSymbolicLink() || !stateDirStat.isDirectory() ||
      stateDirStat.dev !== snapshot.stateDirDevice || stateDirStat.ino !== snapshot.stateDirInode) {
    throw new Error("brief state directory が検証後に置き換わりました");
  }
  const linkStat = lstatSync(snapshot.path, { bigint: true });
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new Error("brief state が検証後に置き換わりました");
  }
  const fd = openSync(snapshot.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.dev !== snapshot.device || stat.ino !== snapshot.inode) {
      throw new Error("brief state が検証後に置き換わりました");
    }
    if (readFileSync(fd, "utf8") !== snapshot.raw) {
      throw new Error("brief state が検証後に変更されました");
    }
  } finally {
    closeSync(fd);
  }
}

export function prepareBriefEnable(home: string): PreparedBriefEnable {
  const snapshot = readSnapshot(home);
  const decision = decideBriefEnable(snapshot?.state ?? null);
  if (snapshot === null || decision.nextState === null || !decision.result.changed) {
    const currentHash = snapshot === null ? null : sha256(snapshot.raw);
    return {
      result: decision.result,
      beforeHash: currentHash,
      afterHash: currentHash,
      compensatedHash: currentHash,
      apply: (): null => null,
    };
  }
  const nextRaw = JSON.stringify(decision.nextState);
  const rollbackRaw = JSON.stringify({
    ...snapshot.state,
    // 復帰で無効化した claimant を再び有効にしないため、世代だけは巻き戻さない。
    claimGeneration: decision.nextState.claimGeneration,
  });
  const beforeHash = sha256(snapshot.raw);
  const afterHash = sha256(nextRaw);
  const compensatedHash = sha256(rollbackRaw);
  return {
    result: decision.result,
    beforeHash,
    afterHash,
    compensatedHash,
    apply: (): AppliedBriefEnable => {
      assertSnapshotUnchanged(snapshot);
      writeFileAtomic0600Durable(snapshot.path, nextRaw);
      const postWrite = readSnapshot(home);
      if (postWrite === null || sha256(postWrite.raw) !== afterHash) {
        throw new Error("brief state のpost-write snapshot検証に失敗しました");
      }
      return {
        afterHash,
        rollbackIfUnchanged: (): boolean => {
          const current = readSnapshot(home);
          if (current === null || sha256(current.raw) !== afterHash ||
              current.device !== postWrite.device || current.inode !== postWrite.inode) {
            return false;
          }
          writeFileAtomic0600Durable(snapshot.path, rollbackRaw);
          if (snapshot.mode !== 0o600) {
            chmodSync(snapshot.path, snapshot.mode);
          }
          return true;
        },
      };
    },
  };
}

function pendingPath(home: string): string {
  return join(home, "state", "brief-enable.pending.json");
}

function parsePendingJournal(raw: string): BriefEnablePendingJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("brief-enable pending journal が壊れています");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("brief-enable pending journal が壊れています");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedV1 = ["afterHash", "beforeHash", "createdAt", "lastRunAt", "operationId", "outcome", "version"].sort();
  const expectedV2 = [...expectedV1, "compensatedHash"].sort();
  const expected = record["version"] === "brief-enable-pending.v1"
    ? expectedV1
    : record["version"] === "brief-enable-pending.v2"
      ? expectedV2
      : null;
  if (expected === null || keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index]) || record["outcome"] !== "changed" ||
      typeof record["operationId"] !== "string" || !/^op_[0-9a-f]{32}$/.test(record["operationId"]) ||
      typeof record["beforeHash"] !== "string" || !/^[0-9a-f]{64}$/.test(record["beforeHash"]) ||
      typeof record["afterHash"] !== "string" || !/^[0-9a-f]{64}$/.test(record["afterHash"]) ||
      (record["version"] === "brief-enable-pending.v2" &&
        (typeof record["compensatedHash"] !== "string" ||
          !/^[0-9a-f]{64}$/.test(record["compensatedHash"]))) ||
      !Number.isSafeInteger(record["lastRunAt"]) || (record["lastRunAt"] as number) < 0 ||
      !Number.isSafeInteger(record["createdAt"]) || (record["createdAt"] as number) < 0) {
    throw new Error("brief-enable pending journal のschemaが不正です");
  }
  return record as unknown as BriefEnablePendingJournal;
}

export function readBriefEnablePending(home: string): BriefEnablePendingJournal | null {
  const stateDir = assertStateDirectory(home);
  if (stateDir.device === null) {
    return null;
  }
  const path = pendingPath(home);
  const linkStat = lstatOrNull(path);
  if (linkStat === null) {
    return null;
  }
  if (linkStat.isSymbolicLink() || !linkStat.isFile() || linkStat.size > BigInt(MAX_PENDING_BYTES) ||
      Number(linkStat.mode & 0o777n) !== 0o600) {
    throw new Error("brief-enable pending journal は0600の通常小fileである必要があります");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_PENDING_BYTES) || Number(stat.mode & 0o777n) !== 0o600) {
      throw new Error("brief-enable pending journal のfile境界検証に失敗しました");
    }
    return parsePendingJournal(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

export function writeBriefEnablePending(home: string, journal: BriefEnablePendingJournal): void {
  const raw = JSON.stringify(journal);
  parsePendingJournal(raw);
  writeFileAtomic0600Durable(pendingPath(home), raw);
}

export function removeBriefEnablePending(home: string): void {
  removeFileDurable(pendingPath(home));
}

export function currentBriefStateHash(home: string): string | null {
  const snapshot = readSnapshot(home);
  return snapshot === null ? null : sha256(snapshot.raw);
}
