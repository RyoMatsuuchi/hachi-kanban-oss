// SQLite の EXCLUSIVE transaction と owner marker を組み合わせた再利用可能な sidecar lock。

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  type BigIntStats,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import Database from "better-sqlite3";

const SIDECAR_LOCK_FILE_MODE = 0o600;
const SIDECAR_LOCK_DIRECTORY_MODE = 0o700;
const SIDECAR_OWNER_TOKEN_BYTES = 32;
const SIDECAR_OWNER_MARKER_MAX_BYTES = SIDECAR_OWNER_TOKEN_BYTES * 2;
const PROCESS_SIDECAR_OWNER_TOKEN = randomBytes(SIDECAR_OWNER_TOKEN_BYTES).toString("hex");
const activeSidecarLocks = new Set<string>();

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  uid: bigint;
}

interface SecureDirectory {
  path: string;
  identity: FileIdentity;
}

interface SecureRegularFile {
  fd: number;
  identity: FileIdentity;
}

interface SidecarLockRegistryReservation {
  key: string;
}

export interface SidecarLockTestHooks {
  /** sidecar 作成直後の fsync 失敗を注入するためのhook。 */
  fsyncCreatedSidecar?: (fd: number) => void;
  /** owner marker temp の fsync 後・rename 前の crash 境界を検証するためのhook。 */
  afterTemporaryOwnerMarkerDurable?: () => void;
}

export interface AcquireSidecarLockOptions {
  lockPath: string;
  ownerMarkerPath: string;
  recheckDirectoryPaths?: readonly string[];
  maxBytes: number;
}

/** sidecar lock の構造・所有権検証に失敗したことを表す。 */
export class SidecarLockError extends Error {
  override readonly name: string = "SidecarLockError";
}

/** 同じ sidecar lock を別の所有者が保持中であることを表す。 */
export class SidecarLockBusyError extends SidecarLockError {
  override readonly name: string = "SidecarLockBusyError";
}

export interface SidecarLock {
  readonly lockPath: string;
  readonly ownerMarkerPath: string;
  assertOpenAndLocked(): void;
  close(): void;
}

function currentUid(): bigint {
  if (typeof process.getuid !== "function") {
    throw new SidecarLockError("sidecar lock は現在userのuidを取得できる環境でのみ利用できます");
  }
  return BigInt(process.getuid());
}

function identityOf(stat: { dev: bigint; ino: bigint; uid: bigint }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

function registryKeyForIdentity(identity: Pick<FileIdentity, "dev" | "ino">): string {
  return `${identity.dev}:${identity.ino}`;
}

function registryKeyForLockPath(path: string): string {
  try {
    const stat = lstatSync(path, { bigint: true });
    return registryKeyForIdentity(stat);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return path;
    }
    throw error;
  }
}

function exactMode(mode: bigint, expected: number): boolean {
  return Number(mode & 0o777n) === expected;
}

function assertSecureDirectoryStat(stat: BigIntStats, label: string): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new SidecarLockError(`${label} はsymlinkではない通常directoryである必要があります`);
  }
  if (stat.uid !== currentUid()) {
    throw new SidecarLockError(`${label} の所有者が現在userではありません`);
  }
  if (!exactMode(stat.mode, SIDECAR_LOCK_DIRECTORY_MODE)) {
    throw new SidecarLockError(`${label} のmodeは700である必要があります`);
  }
}

function inspectDirectory(path: string, label: string): SecureDirectory {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new SidecarLockError(`${label} はcanonicalな絶対pathで指定する必要があります`);
  }
  const linkStat = lstatSync(path, { bigint: true });
  assertSecureDirectoryStat(linkStat, label);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const openedStat = fstatSync(fd, { bigint: true });
    assertSecureDirectoryStat(openedStat, label);
    if (!sameIdentity(identityOf(linkStat), identityOf(openedStat))) {
      throw new SidecarLockError(`${label} のinode検査に失敗しました`);
    }
  } finally {
    closeSync(fd);
  }

  const afterStat = lstatSync(path, { bigint: true });
  if (afterStat.isSymbolicLink() || !afterStat.isDirectory() ||
      !sameIdentity(identityOf(linkStat), identityOf(afterStat))) {
    throw new SidecarLockError(`${label} のinodeが検査中に変化しました`);
  }
  if (realpathSync.native(path) !== path) {
    throw new SidecarLockError(`${label} のpathにsymlinkまたは非canonical要素が含まれます`);
  }
  return { path, identity: identityOf(afterStat) };
}

function recheckDirectory(directory: SecureDirectory, label: string): void {
  const current = inspectDirectory(directory.path, label);
  if (!sameIdentity(current.identity, directory.identity)) {
    throw new SidecarLockError(`${label} のinodeが取得後に変化しました`);
  }
}

function fsyncDirectory(directory: SecureDirectory, label: string): void {
  recheckDirectory(directory, label);
  const fd = openSync(
    directory.path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!sameIdentity(identityOf(stat), directory.identity)) {
      throw new SidecarLockError(`${label} のinodeがfsync前に変化しました`);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  recheckDirectory(directory, label);
}

function assertSecureRegularStat(stat: BigIntStats, label: string, maxBytes: number): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SidecarLockError(`${label} はsymlinkではない通常fileである必要があります`);
  }
  if (stat.uid !== currentUid()) {
    throw new SidecarLockError(`${label} の所有者が現在userではありません`);
  }
  if (!exactMode(stat.mode, SIDECAR_LOCK_FILE_MODE)) {
    throw new SidecarLockError(`${label} のmodeは600である必要があります`);
  }
  if (stat.nlink !== 1n) {
    throw new SidecarLockError(`${label} のhard link数は1である必要があります`);
  }
  if (stat.size > BigInt(maxBytes)) {
    throw new SidecarLockError(`${label} がsize上限を超えています`);
  }
}

function openExistingSecureRegularFile(
  path: string,
  flags: number,
  label: string,
  maxBytes: number,
): SecureRegularFile {
  const before = lstatSync(path, { bigint: true });
  assertSecureRegularStat(before, label, maxBytes);
  const fd = openSync(path, flags | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    assertSecureRegularStat(opened, label, maxBytes);
    if (!sameIdentity(identityOf(before), identityOf(opened))) {
      throw new SidecarLockError(`${label} のinodeがopen中に変化しました`);
    }
    const after = lstatSync(path, { bigint: true });
    assertSecureRegularStat(after, label, maxBytes);
    if (!sameIdentity(identityOf(opened), identityOf(after))) {
      throw new SidecarLockError(`${label} のinodeがopen後に変化しました`);
    }
    return { fd, identity: identityOf(opened) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function createSecureRegularFile(
  path: string,
  flags: number,
  label: string,
  maxBytes: number,
  unlinkOnFailure = true,
): SecureRegularFile {
  const fd = openSync(
    path,
    flags | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    SIDECAR_LOCK_FILE_MODE,
  );
  try {
    fchmodSync(fd, SIDECAR_LOCK_FILE_MODE);
    const stat = fstatSync(fd, { bigint: true });
    assertSecureRegularStat(stat, label, maxBytes);
    const pathStat = lstatSync(path, { bigint: true });
    assertSecureRegularStat(pathStat, label, maxBytes);
    if (!sameIdentity(identityOf(stat), identityOf(pathStat))) {
      throw new SidecarLockError(`${label} のinodeが作成中に変化しました`);
    }
    return { fd, identity: identityOf(stat) };
  } catch (error) {
    try {
      if (unlinkOnFailure) {
        const opened = fstatSync(fd, { bigint: true });
        const pathStat = lstatSync(path, { bigint: true });
        if (!pathStat.isSymbolicLink() && pathStat.isFile() &&
            sameIdentity(identityOf(opened), identityOf(pathStat))) {
          unlinkSync(path);
        }
      }
    } catch {
      // 取得したinodeとの同一性を証明できないpathは削除しない。
    } finally {
      closeSync(fd);
    }
    throw error;
  }
}

function removeIfOwned(path: string, identity: FileIdentity): void {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isSymbolicLink() && stat.isFile() && sameIdentity(identityOf(stat), identity)) {
      unlinkSync(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function fdPath(fd: number): string {
  if (process.platform === "darwin") {
    return `/dev/fd/${fd}`;
  }
  if (process.platform === "linux") {
    return `/proc/self/fd/${fd}`;
  }
  throw new SidecarLockError("sidecar lock のno-follow fd openに対応していないOSです");
}

function assertCanonicalFilePath(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || dirname(path) === path) {
    throw new SidecarLockError(`${label} はcanonicalな絶対pathで指定する必要があります`);
  }
}

function inspectOwnerMarkerIfPresent(path: string): void {
  let marker: SecureRegularFile;
  try {
    marker = openExistingSecureRegularFile(
      path,
      constants.O_RDONLY,
      "sidecar lock owner marker",
      SIDECAR_OWNER_MARKER_MAX_BYTES,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  closeSync(marker.fd);
}

function writeOwnerMarker(
  markerDirectory: SecureDirectory,
  path: string,
  token: string,
  testHooks: SidecarLockTestHooks,
): void {
  recheckDirectory(markerDirectory, "sidecar lock owner marker directory");
  inspectOwnerMarkerIfPresent(path);
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  assertCanonicalFilePath(tempPath, "sidecar lock owner marker temp");
  const temp = createSecureRegularFile(
    tempPath,
    constants.O_WRONLY,
    "sidecar lock owner marker temp",
    SIDECAR_OWNER_MARKER_MAX_BYTES,
  );
  let renamed = false;
  try {
    writeFileSync(temp.fd, token, "utf8");
    fsyncSync(temp.fd);
    const durable = fstatSync(temp.fd, { bigint: true });
    assertSecureRegularStat(
      durable,
      "sidecar lock owner marker temp",
      SIDECAR_OWNER_MARKER_MAX_BYTES,
    );
    if (!sameIdentity(temp.identity, identityOf(durable))) {
      throw new SidecarLockError("sidecar lock owner marker temp のinodeが書き込み中に変化しました");
    }
    testHooks.afterTemporaryOwnerMarkerDurable?.();
    recheckDirectory(markerDirectory, "sidecar lock owner marker directory");
    inspectOwnerMarkerIfPresent(path);
    renameSync(tempPath, path);
    renamed = true;
    const finalStat = lstatSync(path, { bigint: true });
    assertSecureRegularStat(
      finalStat,
      "sidecar lock owner marker",
      SIDECAR_OWNER_MARKER_MAX_BYTES,
    );
    if (!sameIdentity(temp.identity, identityOf(finalStat))) {
      throw new SidecarLockError("sidecar lock owner marker のinodeがatomic rename後に一致しません");
    }
    fsyncDirectory(markerDirectory, "sidecar lock owner marker directory");
  } finally {
    try {
      if (!renamed) {
        removeIfOwned(tempPath, temp.identity);
        fsyncDirectory(markerDirectory, "sidecar lock owner marker directory");
      }
    } finally {
      closeSync(temp.fd);
    }
  }
}

function readOwnerMarker(markerDirectory: SecureDirectory, path: string): string {
  recheckDirectory(markerDirectory, "sidecar lock owner marker directory");
  const marker = openExistingSecureRegularFile(
    path,
    constants.O_RDONLY,
    "sidecar lock owner marker",
    SIDECAR_OWNER_MARKER_MAX_BYTES,
  );
  try {
    const token = readFileSync(marker.fd, "utf8");
    const opened = fstatSync(marker.fd, { bigint: true });
    assertSecureRegularStat(
      opened,
      "sidecar lock owner marker",
      SIDECAR_OWNER_MARKER_MAX_BYTES,
    );
    const current = lstatSync(path, { bigint: true });
    assertSecureRegularStat(
      current,
      "sidecar lock owner marker",
      SIDECAR_OWNER_MARKER_MAX_BYTES,
    );
    if (!sameIdentity(marker.identity, identityOf(opened)) ||
        !sameIdentity(marker.identity, identityOf(current))) {
      throw new SidecarLockError("sidecar lock owner marker のinodeが読み取り中に変化しました");
    }
    recheckDirectory(markerDirectory, "sidecar lock owner marker directory");
    return token;
  } finally {
    closeSync(marker.fd);
  }
}

function releaseDatabaseAndFile(
  db: Database.Database | null,
  file: SecureRegularFile,
): void {
  try {
    if (db?.inTransaction === true) {
      db.exec("ROLLBACK");
    }
  } finally {
    try {
      db?.close();
    } finally {
      closeSync(file.fd);
    }
  }
}

class AcquiredSidecarLock implements SidecarLock {
  readonly lockPath: string;
  readonly ownerMarkerPath: string;

  private readonly lockIdentity: FileIdentity;
  private readonly ownerToken: string;
  private readonly lockDb: Database.Database;
  private readonly lockFd: number;
  private readonly registryKey: string;
  private readonly recheckDirectories: readonly SecureDirectory[];
  private readonly markerDirectory: SecureDirectory;
  private readonly maxBytes: number;
  private closed = false;

  constructor(options: {
    lockPath: string;
    ownerMarkerPath: string;
    lockIdentity: FileIdentity;
    ownerToken: string;
    lockDb: Database.Database;
    lockFd: number;
    registryKey: string;
    recheckDirectories: readonly SecureDirectory[];
    markerDirectory: SecureDirectory;
    maxBytes: number;
  }) {
    this.lockPath = options.lockPath;
    this.ownerMarkerPath = options.ownerMarkerPath;
    this.lockIdentity = options.lockIdentity;
    this.ownerToken = options.ownerToken;
    this.lockDb = options.lockDb;
    this.lockFd = options.lockFd;
    this.registryKey = options.registryKey;
    this.recheckDirectories = options.recheckDirectories;
    this.markerDirectory = options.markerDirectory;
    this.maxBytes = options.maxBytes;
  }

  assertOpenAndLocked(): void {
    if (this.closed) {
      throw new SidecarLockError("sidecar lock は既にcloseされています");
    }
    if (!this.lockDb.inTransaction) {
      throw new SidecarLockError("sidecar lock SQLite EXCLUSIVE transactionが失われています");
    }
    for (const [index, directory] of this.recheckDirectories.entries()) {
      recheckDirectory(directory, `sidecar lock recheck directory (${index + 1})`);
    }
    const lockPathStat = lstatSync(this.lockPath, { bigint: true });
    assertSecureRegularStat(lockPathStat, "sidecar lock", this.maxBytes);
    const lockFdStat = fstatSync(this.lockFd, { bigint: true });
    assertSecureRegularStat(lockFdStat, "sidecar lock", this.maxBytes);
    if (!sameIdentity(this.lockIdentity, identityOf(lockPathStat)) ||
        !sameIdentity(this.lockIdentity, identityOf(lockFdStat))) {
      throw new SidecarLockError("sidecar lock のinodeまたは所有者が変化しました");
    }
    if (readOwnerMarker(this.markerDirectory, this.ownerMarkerPath) !== this.ownerToken) {
      throw new SidecarLockError("sidecar lock owner marker が現在processと一致しません");
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    let rollbackError: unknown;
    try {
      if (this.lockDb.inTransaction) {
        this.lockDb.exec("ROLLBACK");
      }
    } catch (error) {
      rollbackError = error;
    } finally {
      try {
        this.lockDb.close();
      } finally {
        try {
          closeSync(this.lockFd);
        } finally {
          activeSidecarLocks.delete(this.registryKey);
        }
      }
    }
    if (rollbackError !== undefined) {
      throw rollbackError;
    }
  }
}

function acquireReservedSidecarLock(
  options: AcquireSidecarLockOptions,
  lockDirectory: SecureDirectory,
  markerDirectory: SecureDirectory,
  registryReservation: SidecarLockRegistryReservation,
  testHooks: SidecarLockTestHooks,
): SidecarLock {
  let file: SecureRegularFile | undefined;
  let created = false;
  try {
    file = createSecureRegularFile(
      options.lockPath,
      constants.O_RDWR,
      "sidecar lock",
      options.maxBytes,
      false,
    );
    created = true;
    const inodeRegistryKey = registryKeyForIdentity(file.identity);
    if (activeSidecarLocks.has(inodeRegistryKey)) {
      throw new SidecarLockBusyError("sidecar lock は別processが使用中です");
    }
    activeSidecarLocks.delete(registryReservation.key);
    activeSidecarLocks.add(inodeRegistryKey);
    registryReservation.key = inodeRegistryKey;
    (testHooks.fsyncCreatedSidecar ?? fsyncSync)(file.fd);
    fsyncDirectory(lockDirectory, "sidecar lock directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      if (created && file !== undefined) {
        try {
          closeSync(file.fd);
        } catch {
          // 元の作成・fsync error を優先する。
        }
      }
      throw error;
    }
    file = openExistingSecureRegularFile(
      options.lockPath,
      constants.O_RDWR,
      "sidecar lock",
      options.maxBytes,
    );
  }
  if (file === undefined) {
    throw new SidecarLockError("sidecar lock file の取得に失敗しました");
  }

  let db: Database.Database | null = null;
  try {
    const additionalDirectories = (options.recheckDirectoryPaths ?? []).map((path, index) =>
      inspectDirectory(path, `sidecar lock recheck directory (${index + 1})`));
    const recheckDirectories = [...additionalDirectories];
    if (!additionalDirectories.some((directory) => directory.path === lockDirectory.path)) {
      recheckDirectories.push(lockDirectory);
    }
    if (!recheckDirectories.some((directory) => directory.path === markerDirectory.path)) {
      recheckDirectories.push(markerDirectory);
    }

    db = new Database(fdPath(file.fd), { fileMustExist: true, timeout: 0 });
    db.pragma("busy_timeout = 0");
    // empty fileもSQLite DBとして扱える。MEMORY journalにより fd path 隣接fileを作らない。
    db.pragma("journal_mode = MEMORY");
    db.exec("BEGIN EXCLUSIVE");
    if (!db.inTransaction) {
      throw new SidecarLockError("sidecar lock SQLite EXCLUSIVE transactionを取得できませんでした");
    }
    const after = lstatSync(options.lockPath, { bigint: true });
    assertSecureRegularStat(after, "sidecar lock", options.maxBytes);
    if (!sameIdentity(file.identity, identityOf(after))) {
      throw new SidecarLockError("sidecar lock のinodeがSQLite open中に変化しました");
    }
    recheckDirectory(lockDirectory, "sidecar lock directory");
    writeOwnerMarker(
      markerDirectory,
      options.ownerMarkerPath,
      PROCESS_SIDECAR_OWNER_TOKEN,
      testHooks,
    );
    return new AcquiredSidecarLock({
      lockPath: options.lockPath,
      ownerMarkerPath: options.ownerMarkerPath,
      lockIdentity: file.identity,
      ownerToken: PROCESS_SIDECAR_OWNER_TOKEN,
      lockDb: db,
      lockFd: file.fd,
      registryKey: registryReservation.key,
      recheckDirectories,
      markerDirectory,
      maxBytes: options.maxBytes,
    });
  } catch (error) {
    releaseDatabaseAndFile(db, file);
    const code = (error as { code?: unknown }).code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      throw new SidecarLockBusyError("sidecar lock は別processが使用中です");
    }
    throw error;
  }
}

/**
 * SQLite EXCLUSIVE transaction を保持する sidecar lock を取得する。
 * 取得後の操作前には必ず返却値の assertOpenAndLocked() を呼ぶ。
 */
export function acquireSidecarLock(options: AcquireSidecarLockOptions): SidecarLock {
  return acquireSidecarLockWithTestHooks(options, {});
}

/** package 内の既存 crash-boundary test 専用。公開 barrel からは export しない。 */
export function acquireSidecarLockWithTestHooks(
  options: AcquireSidecarLockOptions,
  testHooks: SidecarLockTestHooks,
): SidecarLock {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new SidecarLockError("sidecar lock のmaxBytesは0以上の安全な整数で指定してください");
  }
  assertCanonicalFilePath(options.lockPath, "sidecar lock");
  assertCanonicalFilePath(options.ownerMarkerPath, "sidecar lock owner marker");
  if (options.lockPath === options.ownerMarkerPath) {
    throw new SidecarLockError("sidecar lock とowner markerは別pathで指定してください");
  }

  const lockDirectory = inspectDirectory(dirname(options.lockPath), "sidecar lock directory");
  const markerDirectory = dirname(options.ownerMarkerPath) === lockDirectory.path
    ? lockDirectory
    : inspectDirectory(dirname(options.ownerMarkerPath), "sidecar lock owner marker directory");

  const registryReservation = { key: registryKeyForLockPath(options.lockPath) };
  if (activeSidecarLocks.has(registryReservation.key)) {
    throw new SidecarLockBusyError("sidecar lock は別processが使用中です");
  }
  activeSidecarLocks.add(registryReservation.key);
  let reservationRetained = false;
  try {
    const lock = acquireReservedSidecarLock(
      options,
      lockDirectory,
      markerDirectory,
      registryReservation,
      testHooks,
    );
    reservationRetained = true;
    return lock;
  } finally {
    if (!reservationRetained) {
      activeSidecarLocks.delete(registryReservation.key);
    }
  }
}
