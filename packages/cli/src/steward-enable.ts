// =============================================================================
// steward auto-disable の厳格な復帰計画と file I/O（docs/contract.md §40.6）。
// dry-run と apply が同じ検証・決定関数を共有し、state 外や不正 file は fail-closed にする。
// =============================================================================

import {
  closeSync,
  chmodSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { BigIntStats } from "node:fs";
import {
  INTEGRATION_EVIDENCE_VALUES,
  removeFileDurable,
  writeFileAtomic0600Durable,
} from "@hachi/core";

export const MAX_STEWARD_STATE_BYTES = 64 * 1_024;

/** §74.2 の integrationEvidence 全値。strict parser は未知 key を拒否する。 */
export const STEWARD_INTEGRATION_EVIDENCE_KEYS = INTEGRATION_EVIDENCE_VALUES;

type StewardIntegrationEvidence = (typeof STEWARD_INTEGRATION_EVIDENCE_KEYS)[number];

export interface StewardState {
  lastRunAt: number;
  lastProposalCount: number;
  lastAppliedCount: number;
  lastProposedCount: number;
  /** §69.7: durable request として発行した提案数。legacy state に無い場合は 0 とみなす */
  lastRequestedCount: number;
  /** §69.7: §69.4 の判定で抑止した再提案数。legacy state に無い場合は 0 とみなす */
  lastSuppressedCount: number;
  /** §74.3: 直近 tick で integrationEvidence 別に自動 archive した件数 */
  lastArchivedByEvidence: Partial<Record<StewardIntegrationEvidence, number>>;
  lastError: string;
  consecutiveFailures: number;
  autoDisabled: boolean;
  autoDisabledReason: string;
  /** auto-disable へ遷移した epoch 秒。legacy state に無い場合は 0 とみなす */
  autoDisabledAt: number;
  /** half-open claim の単調増加世代。legacy state に無い場合は 0 とみなす */
  claimGeneration: number;
}

export type StewardEnableOutcome = "changed" | "already-enabled" | "no-state";

export interface StewardEnableResult {
  outcome: StewardEnableOutcome;
  changed: boolean;
  lastRunAt: number | null;
}

export interface PreparedStewardEnable {
  result: StewardEnableResult;
  beforeHash: string | null;
  afterHash: string | null;
  compensatedHash: string | null;
  /** changed plan だけが state を原子的に置換し、監査失敗時用CAS rollbackを返す。 */
  apply(): AppliedStewardEnable | null;
}

export interface AppliedStewardEnable {
  afterHash: string;
  /** post-write stateが自分の出力と一致するときだけrollbackする。 */
  rollbackIfUnchanged(): boolean;
}

interface StewardEnablePendingJournalV1 {
  version: "steward-enable-pending.v1";
  operationId: string;
  beforeHash: string;
  afterHash: string;
  outcome: "changed";
  lastRunAt: number;
  createdAt: number;
}

interface StewardEnablePendingJournalV2 {
  version: "steward-enable-pending.v2";
  operationId: string;
  beforeHash: string;
  afterHash: string;
  compensatedHash: string;
  outcome: "changed";
  lastRunAt: number;
  createdAt: number;
}

export type StewardEnablePendingJournal =
  StewardEnablePendingJournalV1 | StewardEnablePendingJournalV2;

interface StateSnapshot {
  stateDirPath: string;
  stateDirDevice: bigint;
  stateDirInode: bigint;
  path: string;
  raw: string;
  device: bigint;
  inode: bigint;
  mode: number;
  state: StewardState;
}

interface StateDirectory {
  path: string;
  device: bigint | null;
  inode: bigint | null;
}

/** 全 state に必ず存在する field。欠落は fail-closed。 */
const REQUIRED_STATE_KEYS = [
  "lastRunAt",
  "lastProposalCount",
  "lastAppliedCount",
  "lastProposedCount",
  "lastError",
  "consecutiveFailures",
  "autoDisabled",
  "autoDisabledReason",
] as const;

/**
 * 後から追加した optional field。
 *
 * これらを必須にすると、追加前に書かれた既存 state を読んだ `hachi admin steward-enable` が
 * schema 検証で落ち、auto-disable から復帰できなくなる。欠落は field ごとの空値とみなして
 * 後方互換を保ち、存在するときだけ必須 field と同じ厳格さで検証する。
 */
const OPTIONAL_STATE_KEYS = [
  "lastRequestedCount",
  "lastSuppressedCount",
  "lastArchivedByEvidence",
  "autoDisabledAt",
  "claimGeneration",
] as const;

/** state に現れてよい field の全集合。ここに無い key は未知として拒否する。 */
export const STEWARD_STATE_KEYS = [...REQUIRED_STATE_KEYS, ...OPTIONAL_STATE_KEYS] as const;

const STEWARD_INTEGRATION_EVIDENCE_KEY_SET: ReadonlySet<string> =
  new Set(STEWARD_INTEGRATION_EVIDENCE_KEYS);

const MAX_PENDING_BYTES = 4_096;

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`steward state ${label} は0以上の安全な整数が必須です`);
  }
  return value as number;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`steward state ${label} は文字列が必須です`);
  }
  return value;
}

/** §69.7 の後方互換 field。欠落は 0、存在するなら必須 field と同じ検証を通す。 */
function optionalNonNegativeInteger(value: unknown, label: string): number {
  return value === undefined ? 0 : requireNonNegativeInteger(value, label);
}

function incrementClaimGeneration(claimGeneration: number): number {
  if (claimGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new Error("steward state claimGeneration は Number.MAX_SAFE_INTEGER 未満が必須です");
  }
  return claimGeneration + 1;
}

/** §74.3 の後方互換 field。欠落は空、存在するなら全 key/value を厳格に検証する。 */
function optionalArchivedByEvidence(
  value: unknown,
): Partial<Record<StewardIntegrationEvidence, number>> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("steward state lastArchivedByEvidence は object が必須です");
  }
  const record = value as Record<string, unknown>;
  const result: Partial<Record<StewardIntegrationEvidence, number>> = {};
  for (const [evidence, count] of Object.entries(record)) {
    if (!STEWARD_INTEGRATION_EVIDENCE_KEY_SET.has(evidence)) {
      throw new Error(`steward state lastArchivedByEvidence.${evidence} は未知の evidence key です`);
    }
    result[evidence as StewardIntegrationEvidence] = requireNonNegativeInteger(
      count,
      `lastArchivedByEvidence.${evidence}`,
    );
  }
  return result;
}

/** schema外 field・型・値を一切補完しない strict parser。 */
export function parseStewardStateStrict(raw: string): StewardState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("steward state の JSON が壊れています");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("steward state は JSON object が必須です");
  }
  const record = parsed as Record<string, unknown>;
  const allowed = new Set<string>(STEWARD_STATE_KEYS);
  const hasKey = (key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
  // 未知 field は補完も無視もせず拒否する。必須 field の欠落も同じく拒否する。
  if (Object.keys(record).some((key) => !allowed.has(key)) || !REQUIRED_STATE_KEYS.every(hasKey)) {
    throw new Error("steward state に不足または未知の field があります");
  }
  if (typeof record["autoDisabled"] !== "boolean") {
    throw new Error("steward state autoDisabled は boolean が必須です");
  }
  return {
    lastRunAt: requireNonNegativeInteger(record["lastRunAt"], "lastRunAt"),
    lastProposalCount: requireNonNegativeInteger(record["lastProposalCount"], "lastProposalCount"),
    lastAppliedCount: requireNonNegativeInteger(record["lastAppliedCount"], "lastAppliedCount"),
    lastProposedCount: requireNonNegativeInteger(record["lastProposedCount"], "lastProposedCount"),
    lastRequestedCount: optionalNonNegativeInteger(record["lastRequestedCount"], "lastRequestedCount"),
    lastSuppressedCount: optionalNonNegativeInteger(record["lastSuppressedCount"], "lastSuppressedCount"),
    lastArchivedByEvidence: optionalArchivedByEvidence(record["lastArchivedByEvidence"]),
    lastError: requireString(record["lastError"], "lastError"),
    consecutiveFailures: requireNonNegativeInteger(record["consecutiveFailures"], "consecutiveFailures"),
    autoDisabled: record["autoDisabled"],
    autoDisabledReason: requireString(record["autoDisabledReason"], "autoDisabledReason"),
    autoDisabledAt: optionalNonNegativeInteger(record["autoDisabledAt"], "autoDisabledAt"),
    claimGeneration: optionalNonNegativeInteger(record["claimGeneration"], "claimGeneration"),
  };
}

/** state 内容だけから復帰結果を決める純粋関数。 */
export function decideStewardEnable(state: StewardState | null): {
  result: StewardEnableResult;
  nextState: StewardState | null;
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
    throw new Error("steward state directory は通常directoryである必要があります");
  }
  return { path: stateDir, device: stat.dev, inode: stat.ino };
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

function readSnapshot(home: string): StateSnapshot | null {
  const stateDir = assertStateDirectory(home);
  const path = join(stateDir.path, "steward.json");
  const linkStat = lstatOrNull(path);
  if (linkStat === null) {
    return null;
  }
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new Error("steward state は通常fileである必要があります");
  }
  if (linkStat.size > BigInt(MAX_STEWARD_STATE_BYTES)) {
    throw new Error(`steward state は ${MAX_STEWARD_STATE_BYTES} bytes 以下である必要があります`);
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_STEWARD_STATE_BYTES)) {
      throw new Error("steward state の file境界検証に失敗しました");
    }
    const raw = readFileSync(fd, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_STEWARD_STATE_BYTES) {
      throw new Error(`steward state は ${MAX_STEWARD_STATE_BYTES} bytes 以下である必要があります`);
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
      state: parseStewardStateStrict(raw),
    };
  } finally {
    closeSync(fd);
  }
}

function assertSnapshotUnchanged(snapshot: StateSnapshot): void {
  const stateDirStat = lstatSync(snapshot.stateDirPath, { bigint: true });
  if (stateDirStat.isSymbolicLink() || !stateDirStat.isDirectory() ||
      stateDirStat.dev !== snapshot.stateDirDevice || stateDirStat.ino !== snapshot.stateDirInode) {
    throw new Error("steward state directory が検証後に置き換わりました");
  }
  const linkStat = lstatSync(snapshot.path, { bigint: true });
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new Error("steward state が検証後に置き換わりました");
  }
  const fd = openSync(snapshot.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.dev !== snapshot.device || stat.ino !== snapshot.inode) {
      throw new Error("steward state が検証後に置き換わりました");
    }
    const currentRaw = readFileSync(fd, "utf8");
    if (currentRaw !== snapshot.raw) {
      throw new Error("steward state が検証後に変更されました");
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * strict read と純粋 decision を行い、apply可能な計画を返す。
 * no-state/already-enabled は fileを作らず、changedだけがatomic 0600 renameを行う。
 */
export function prepareStewardEnable(home: string): PreparedStewardEnable {
  const snapshot = readSnapshot(home);
  const decision = decideStewardEnable(snapshot?.state ?? null);
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
    apply: (): AppliedStewardEnable => {
      assertSnapshotUnchanged(snapshot);
      writeFileAtomic0600Durable(snapshot.path, nextRaw);
      const postWrite = readSnapshot(home);
      if (postWrite === null || sha256(postWrite.raw) !== afterHash) {
        throw new Error("steward state のpost-write snapshot検証に失敗しました");
      }
      return {
        afterHash,
        rollbackIfUnchanged: (): boolean => {
          const current = readSnapshot(home);
          if (current === null || sha256(current.raw) !== afterHash ||
              current.device !== postWrite.device || current.inode !== postWrite.inode) {
            return false;
          }
          // temp は常に0600。監査失敗時も claimGeneration は前進後の値を維持する。
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
  return join(home, "state", "steward-enable.pending.json");
}

function parsePendingJournal(raw: string): StewardEnablePendingJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("steward-enable pending journal が壊れています");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("steward-enable pending journal が壊れています");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedV1 = ["afterHash", "beforeHash", "createdAt", "lastRunAt", "operationId", "outcome", "version"].sort();
  const expectedV2 = [...expectedV1, "compensatedHash"].sort();
  const expected = record["version"] === "steward-enable-pending.v1"
    ? expectedV1
    : record["version"] === "steward-enable-pending.v2"
      ? expectedV2
      : null;
  if (expected === null || keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index]) || record["outcome"] !== "changed" ||
      typeof record["operationId"] !== "string" || !/^op_[0-9a-f]{32}$/.test(record["operationId"]) ||
      typeof record["beforeHash"] !== "string" || !/^[0-9a-f]{64}$/.test(record["beforeHash"]) ||
      typeof record["afterHash"] !== "string" || !/^[0-9a-f]{64}$/.test(record["afterHash"]) ||
      (record["version"] === "steward-enable-pending.v2" &&
        (typeof record["compensatedHash"] !== "string" ||
          !/^[0-9a-f]{64}$/.test(record["compensatedHash"]))) ||
      !Number.isSafeInteger(record["lastRunAt"]) || (record["lastRunAt"] as number) < 0 ||
      !Number.isSafeInteger(record["createdAt"]) || (record["createdAt"] as number) < 0) {
    throw new Error("steward-enable pending journal のschemaが不正です");
  }
  return record as unknown as StewardEnablePendingJournal;
}

export function readStewardEnablePending(home: string): StewardEnablePendingJournal | null {
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
    throw new Error("steward-enable pending journal は0600の通常小fileである必要があります");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_PENDING_BYTES) || Number(stat.mode & 0o777n) !== 0o600) {
      throw new Error("steward-enable pending journal のfile境界検証に失敗しました");
    }
    return parsePendingJournal(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

export function writeStewardEnablePending(home: string, journal: StewardEnablePendingJournal): void {
  // callerが構築した値も同じstrict parserへround-tripさせる。
  const raw = JSON.stringify(journal);
  parsePendingJournal(raw);
  writeFileAtomic0600Durable(pendingPath(home), raw);
}

export function removeStewardEnablePending(home: string): void {
  removeFileDurable(pendingPath(home));
}

export function currentStewardStateHash(home: string): string | null {
  const snapshot = readSnapshot(home);
  return snapshot === null ? null : sha256(snapshot.raw);
}
