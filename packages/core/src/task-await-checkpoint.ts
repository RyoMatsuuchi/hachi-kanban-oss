// task await の再アーム窓を塞ぐ checkpoint store（docs/contract.md §50.1.1）。
// checkpoint の内容と sidecar SQLite lock を core に閉じ込め、board DB には書き込まない。

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  type BigIntStats,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  SidecarLockBusyError,
  SidecarLockError,
  acquireSidecarLockWithTestHooks,
  type SidecarLock,
  type SidecarLockTestHooks,
} from "./sidecar-lock.js";

export const TASK_AWAIT_CHECKPOINT_SCHEMA_VERSION = "task-await-checkpoint.v1" as const;
export const TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION = "task-await-checkpoint.v2" as const;
export const TASK_AWAIT_ORCHESTRATOR_CHECKPOINT_SCHEMA_VERSION = "task-await-checkpoint.v3" as const;
export const TASK_AWAIT_CHECKPOINT_MAX_BYTES = 1024 * 1024;
export const TASK_AWAIT_LOCK_MAX_BYTES = 1024 * 1024;
export const TASK_AWAIT_DIRECTORY_MODE = 0o700;
export const TASK_AWAIT_FILE_MODE = 0o600;

const TASK_AWAIT_DIRECTORY_NAME = "task-await";
const TASK_AWAIT_LOCK_DIRECTORY_NAME = ".locks";
const SAFE_PATH_COMPONENT = /^[a-z0-9._-]+$/;
const BOARD_INSTANCE_ID = /^[0-9a-f]{32}$/;
const TASK_ID = /^t_[0-9a-f]{16}$/;
const TASK_AWAIT_TENANT_FILTER_REVISION = 1 as const;

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  uid: bigint;
}

interface SecureDirectory {
  path: string;
  identity: FileIdentity;
  expectedMode: number | null;
  label: string;
}

interface SecureRegularFile {
  fd: number;
  identity: FileIdentity;
}

interface TaskAwaitCheckpointV1 {
  schemaVersion: typeof TASK_AWAIT_CHECKPOINT_SCHEMA_VERSION;
  boardInstanceId: string;
  eventCursor: number;
  targetIds: string[];
}

interface TaskAwaitCheckpointV2 {
  schemaVersion: typeof TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION;
  boardInstanceId: string;
  eventCursor: number;
  targetIds: string[];
  tenants: string[];
  filterRevision: typeof TASK_AWAIT_TENANT_FILTER_REVISION;
}

interface TaskAwaitCheckpointV3 {
  schemaVersion: typeof TASK_AWAIT_ORCHESTRATOR_CHECKPOINT_SCHEMA_VERSION;
  boardInstanceId: string;
  eventCursor: number;
  targetIds: string[];
  tenants: string[];
  orchestratorId: string;
  filterRevision: typeof TASK_AWAIT_TENANT_FILTER_REVISION;
}

export type TaskAwaitCheckpoint =
  | TaskAwaitCheckpointV1
  | TaskAwaitCheckpointV2
  | TaskAwaitCheckpointV3;

export interface TaskAwaitCheckpointStoreTestHooks extends SidecarLockTestHooks {
  /** temp file の fsync 後・rename 前の crash 境界を検証するためのhook。 */
  afterTemporaryCheckpointDurable?: () => void;
}

export interface OpenTaskAwaitCheckpointStoreOptions {
  home: string;
  relativePath: string;
  boardInstanceId: string;
  tenants?: readonly string[];
  orchestratorId?: string;
  testHooks?: TaskAwaitCheckpointStoreTestHooks;
}

/** tenant購読条件をtrim・重複排除・辞書順sortしたprivate copyへ正規化する。 */
export function normalizeAwaitTenantFilter(values: readonly string[]): string[] {
  const tenants: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      throw new Error("task-await tenant filter はstring配列である必要があります");
    }
    const tenant = value.trim();
    if (tenant.length === 0) {
      throw new Error("task-await tenant filter に空のtenantは指定できません");
    }
    if (tenant.includes("\0")) {
      throw new Error("task-await tenant filter にNULを含むtenantは指定できません");
    }
    if (!seen.has(tenant)) {
      seen.add(tenant);
      tenants.push(tenant);
    }
  }
  if (tenants.length === 0) {
    throw new Error("task-await tenant filter は1件以上必要です");
  }
  return tenants.sort();
}

/** 担当OR購読のstable identityをtrim済みのprivate stringへ正規化する。 */
export function normalizeAwaitOrchestratorFilter(value: string): string {
  if (typeof value !== "string") {
    throw new Error("task-await orchestrator filter はstringである必要があります");
  }
  const orchestratorId = value.trim();
  if (orchestratorId.length === 0) {
    throw new Error("task-await orchestrator filter に空のidentityは指定できません");
  }
  if (orchestratorId.includes("\0")) {
    throw new Error("task-await orchestrator filter にNULを含むidentityは指定できません");
  }
  return orchestratorId;
}

/** tenants未指定は全件、指定時は正規化済みtenantとのexact一致だけを受理する。 */
export function matchesAwaitTenantFilter(
  tenant: string,
  tenants: readonly string[] | undefined,
): boolean {
  return tenants === undefined || tenants.includes(tenant);
}

function currentUid(): bigint {
  if (typeof process.getuid !== "function") {
    throw new Error("task-await checkpoint は現在userのuidを取得できる環境でのみ利用できます");
  }
  return BigInt(process.getuid());
}

function identityOf(stat: { dev: bigint; ino: bigint; uid: bigint }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

function exactMode(mode: bigint, expected: number): boolean {
  return Number(mode & 0o777n) === expected;
}

function assertContained(root: string, candidate: string, label: string): void {
  const relativePath = relative(root, candidate);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} が task-await directory 配下に収まりません`);
  }
}

function inspectDirectory(path: string, label: string, expectedMode: number | null): SecureDirectory {
  const linkStat = lstatSync(path, { bigint: true });
  if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) {
    throw new Error(`${label} はsymlinkではない通常directoryである必要があります`);
  }
  if (linkStat.uid !== currentUid()) {
    throw new Error(`${label} の所有者が現在userではありません`);
  }
  if (expectedMode !== null && !exactMode(linkStat.mode, expectedMode)) {
    throw new Error(`${label} のmodeは${expectedMode.toString(8)}である必要があります`);
  }

  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const openedStat = fstatSync(fd, { bigint: true });
    const beforeIdentity = identityOf(linkStat);
    const openedIdentity = identityOf(openedStat);
    if (!openedStat.isDirectory() || !sameIdentity(beforeIdentity, openedIdentity)) {
      throw new Error(`${label} のinode検査に失敗しました`);
    }
    if (openedStat.uid !== currentUid()) {
      throw new Error(`${label} の所有者がopen中に変化しました`);
    }
    if (expectedMode !== null && !exactMode(openedStat.mode, expectedMode)) {
      throw new Error(`${label} のmodeがopen中に変化しました`);
    }
  } finally {
    closeSync(fd);
  }

  const afterStat = lstatSync(path, { bigint: true });
  if (afterStat.isSymbolicLink() || !afterStat.isDirectory() ||
      !sameIdentity(identityOf(linkStat), identityOf(afterStat))) {
    throw new Error(`${label} のinodeが検査中に変化しました`);
  }
  const canonical = realpathSync.native(path);
  if (canonical !== resolve(path)) {
    throw new Error(`${label} のpathにsymlinkまたは非canonical要素が含まれます`);
  }
  return { path: canonical, identity: identityOf(afterStat), expectedMode, label };
}

function ensureDirectory(
  parent: SecureDirectory,
  name: string,
  label: string,
  expectedMode: number | null,
): SecureDirectory {
  const path = join(parent.path, name);
  let created = false;
  try {
    mkdirSync(path, { mode: expectedMode ?? TASK_AWAIT_DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  if (created && expectedMode !== null) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fchmodSync(fd, expectedMode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  const directory = inspectDirectory(path, label, expectedMode);
  if (created) {
    fsyncDirectory(parent);
  }
  return directory;
}

function recheckDirectory(directory: SecureDirectory): void {
  const current = inspectDirectory(directory.path, directory.label, directory.expectedMode);
  if (!sameIdentity(current.identity, directory.identity)) {
    throw new Error(`${directory.label} のinodeが取得後に変化しました`);
  }
}

function fsyncDirectory(directory: SecureDirectory): void {
  recheckDirectory(directory);
  const fd = openSync(
    directory.path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!sameIdentity(identityOf(stat), directory.identity)) {
      throw new Error(`${directory.label} のinodeがfsync前に変化しました`);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  recheckDirectory(directory);
}

function assertSecureRegularStat(
  stat: BigIntStats,
  label: string,
  maxBytes: number,
): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} はsymlinkではない通常fileである必要があります`);
  }
  if (stat.uid !== currentUid()) {
    throw new Error(`${label} の所有者が現在userではありません`);
  }
  if (!exactMode(stat.mode, TASK_AWAIT_FILE_MODE)) {
    throw new Error(`${label} のmodeは600である必要があります`);
  }
  if (stat.nlink !== 1n) {
    throw new Error(`${label} のhard link数は1である必要があります`);
  }
  if (stat.size > BigInt(maxBytes)) {
    throw new Error(`${label} がsize上限を超えています`);
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
      throw new Error(`${label} のinodeがopen中に変化しました`);
    }
    const after = lstatSync(path, { bigint: true });
    assertSecureRegularStat(after, label, maxBytes);
    if (!sameIdentity(identityOf(opened), identityOf(after))) {
      throw new Error(`${label} のinodeがopen後に変化しました`);
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
    TASK_AWAIT_FILE_MODE,
  );
  try {
    fchmodSync(fd, TASK_AWAIT_FILE_MODE);
    const stat = fstatSync(fd, { bigint: true });
    assertSecureRegularStat(stat, label, maxBytes);
    const pathStat = lstatSync(path, { bigint: true });
    assertSecureRegularStat(pathStat, label, maxBytes);
    if (!sameIdentity(identityOf(stat), identityOf(pathStat))) {
      throw new Error(`${label} のinodeが作成中に変化しました`);
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

function checkpointComponents(relativePath: string): string[] {
  if (relativePath.length === 0 || isAbsolute(relativePath) || relativePath.includes("\\") ||
      relativePath.includes("\0")) {
    throw new Error("cursor-file は task-await directory からの相対pathで指定してください");
  }
  const components = relativePath.split("/");
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    throw new Error("cursor-file に空要素、.、.. は使用できません");
  }
  if (components[0] === TASK_AWAIT_LOCK_DIRECTORY_NAME) {
    throw new Error(".locks は task-await store の予約領域です");
  }
  if (components.some((component) => !SAFE_PATH_COMPONENT.test(component))) {
    throw new Error("cursor-file の各path要素は小文字ASCII英数と - _ . のみ使用できます");
  }
  return components;
}

function checkpointParent(
  taskAwaitDirectory: SecureDirectory,
  components: readonly string[],
): SecureDirectory {
  let current = taskAwaitDirectory;
  for (const component of components.slice(0, -1)) {
    const nextPath = join(current.path, component);
    const next = inspectDirectory(nextPath, `cursor-file parent (${component})`, TASK_AWAIT_DIRECTORY_MODE);
    assertContained(taskAwaitDirectory.path, next.path, "cursor-file parent");
    current = next;
  }
  return current;
}

function validateTargetIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("task-await checkpoint のtargetIdsが配列ではありません");
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !TASK_ID.test(item)) {
      throw new Error("task-await checkpoint のtargetIdsに不正なtask IDがあります");
    }
    if (seen.has(item)) {
      throw new Error("task-await checkpoint のtargetIdsに重複があります");
    }
    seen.add(item);
    ids.push(item);
  }
  return ids.sort();
}

function assertExactCheckpointKeys(record: Record<string, unknown>, expectedKeys: string[]): void {
  const actualKeys = Object.keys(record).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (actualKeys.length !== sortedExpectedKeys.length ||
      actualKeys.some((key, index) => key !== sortedExpectedKeys[index])) {
    throw new Error("task-await checkpoint のschema keyが不正です");
  }
}

function validateCheckpointFields(record: Record<string, unknown>): {
  boardInstanceId: string;
  eventCursor: number;
  targetIds: string[];
} {
  if (typeof record["boardInstanceId"] !== "string" || !BOARD_INSTANCE_ID.test(record["boardInstanceId"])) {
    throw new Error("task-await checkpoint のboardInstanceIdが不正です");
  }
  if (typeof record["eventCursor"] !== "number" || !Number.isSafeInteger(record["eventCursor"]) ||
      record["eventCursor"] < 0) {
    throw new Error("task-await checkpoint のeventCursorが不正です");
  }
  return {
    boardInstanceId: record["boardInstanceId"],
    eventCursor: record["eventCursor"],
    targetIds: validateTargetIds(record["targetIds"]),
  };
}

function validateCheckpoint(value: unknown): TaskAwaitCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("task-await checkpoint のroot schemaが不正です");
  }
  const record = value as Record<string, unknown>;
  if (record["schemaVersion"] === TASK_AWAIT_CHECKPOINT_SCHEMA_VERSION) {
    assertExactCheckpointKeys(record, ["schemaVersion", "boardInstanceId", "eventCursor", "targetIds"]);
    return {
      schemaVersion: TASK_AWAIT_CHECKPOINT_SCHEMA_VERSION,
      ...validateCheckpointFields(record),
    };
  }
  if (record["schemaVersion"] === TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION) {
    assertExactCheckpointKeys(record, [
      "schemaVersion",
      "boardInstanceId",
      "eventCursor",
      "targetIds",
      "tenants",
      "filterRevision",
    ]);
    if (record["filterRevision"] !== TASK_AWAIT_TENANT_FILTER_REVISION) {
      throw new Error("task-await checkpoint のfilterRevisionが不正です");
    }
    const rawTenants = record["tenants"];
    if (!Array.isArray(rawTenants)) {
      throw new Error("task-await checkpoint のtenantsが配列ではありません");
    }
    const tenants = normalizeAwaitTenantFilter(rawTenants as readonly string[]);
    if (tenants.length !== rawTenants.length ||
        tenants.some((tenant, index) => tenant !== rawTenants[index])) {
      throw new Error("task-await checkpoint のtenantsが正規化されていません");
    }
    return {
      schemaVersion: TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION,
      ...validateCheckpointFields(record),
      tenants,
      filterRevision: TASK_AWAIT_TENANT_FILTER_REVISION,
    };
  }
  if (record["schemaVersion"] === TASK_AWAIT_ORCHESTRATOR_CHECKPOINT_SCHEMA_VERSION) {
    assertExactCheckpointKeys(record, [
      "schemaVersion",
      "boardInstanceId",
      "eventCursor",
      "targetIds",
      "tenants",
      "orchestratorId",
      "filterRevision",
    ]);
    if (record["filterRevision"] !== TASK_AWAIT_TENANT_FILTER_REVISION) {
      throw new Error("task-await checkpoint のfilterRevisionが不正です");
    }
    const rawTenants = record["tenants"];
    if (!Array.isArray(rawTenants)) {
      throw new Error("task-await checkpoint のtenantsが配列ではありません");
    }
    const tenants = rawTenants.length === 0
      ? []
      : normalizeAwaitTenantFilter(rawTenants as readonly string[]);
    if (tenants.length !== rawTenants.length ||
        tenants.some((tenant, index) => tenant !== rawTenants[index])) {
      throw new Error("task-await checkpoint のtenantsが正規化されていません");
    }
    const rawOrchestratorId = record["orchestratorId"];
    if (typeof rawOrchestratorId !== "string") {
      throw new Error("task-await orchestrator filter はstringである必要があります");
    }
    const orchestratorId = normalizeAwaitOrchestratorFilter(rawOrchestratorId);
    if (orchestratorId !== rawOrchestratorId) {
      throw new Error("task-await checkpoint のorchestratorIdが正規化されていません");
    }
    return {
      schemaVersion: TASK_AWAIT_ORCHESTRATOR_CHECKPOINT_SCHEMA_VERSION,
      ...validateCheckpointFields(record),
      tenants,
      orchestratorId,
      filterRevision: TASK_AWAIT_TENANT_FILTER_REVISION,
    };
  }
  throw new Error("task-await checkpoint のschemaVersionが不正です");
}

function serializeCheckpoint(checkpoint: TaskAwaitCheckpoint): string {
  return `${JSON.stringify(checkpoint)}\n`;
}

function parseCheckpoint(raw: Buffer): TaskAwaitCheckpoint {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error("task-await checkpoint がUTF-8ではありません");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error("task-await checkpoint のJSONが壊れています");
  }
  return validateCheckpoint(parsed);
}

function buildDirectories(home: string): {
  taskAwait: SecureDirectory;
  locks: SecureDirectory;
} {
  if (!isAbsolute(home)) {
    throw new Error("HACHI_KANBAN_HOME は絶対pathである必要があります");
  }
  const canonicalHome = realpathSync.native(home);
  const homeDirectory = inspectDirectory(canonicalHome, "HACHI_KANBAN_HOME", null);
  const stateDirectory = ensureDirectory(homeDirectory, "state", "state directory", null);
  const taskAwait = ensureDirectory(
    stateDirectory,
    TASK_AWAIT_DIRECTORY_NAME,
    "task-await directory",
    TASK_AWAIT_DIRECTORY_MODE,
  );
  const locks = ensureDirectory(
    taskAwait,
    TASK_AWAIT_LOCK_DIRECTORY_NAME,
    "task-await .locks directory",
    TASK_AWAIT_DIRECTORY_MODE,
  );
  assertContained(taskAwait.path, locks.path, "task-await .locks directory");
  return { taskAwait, locks };
}

function rethrowTaskAwaitSidecarError(error: unknown): never {
  if (error instanceof SidecarLockBusyError) {
    throw new Error("task-await checkpoint は別watcherが使用中です", { cause: error });
  }
  if (error instanceof SidecarLockError) {
    const message = error.message
      .replace(
        "sidecar lock SQLite EXCLUSIVE transactionが失われています",
        "task-await sidecar SQLite lock が失われています",
      )
      .replace(
        "sidecar lock SQLite EXCLUSIVE transactionを取得できませんでした",
        "task-await sidecar SQLite EXCLUSIVE transactionを取得できませんでした",
      )
      .replaceAll("sidecar lock owner marker", "task-await sidecar owner marker")
      .replaceAll("sidecar lock", "task-await sidecar lock");
    throw new Error(message, { cause: error });
  }
  throw error;
}

function acquireTaskAwaitSidecarLock(
  locksDirectory: SecureDirectory,
  taskAwaitDirectory: SecureDirectory,
  checkpointParentDirectory: SecureDirectory,
  canonicalCheckpointPath: string,
  testHooks: TaskAwaitCheckpointStoreTestHooks,
): SidecarLock {
  const hash = createHash("sha256").update(canonicalCheckpointPath, "utf8").digest("hex");
  const lockPath = join(locksDirectory.path, `${hash}.sqlite`);
  const ownerMarkerPath = join(locksDirectory.path, `${hash}.owner`);
  assertContained(locksDirectory.path, ownerMarkerPath, "task-await sidecar owner marker");
  try {
    return acquireSidecarLockWithTestHooks(
      {
        lockPath,
        ownerMarkerPath,
        recheckDirectoryPaths: [
          taskAwaitDirectory.path,
          checkpointParentDirectory.path,
          locksDirectory.path,
        ],
        maxBytes: TASK_AWAIT_LOCK_MAX_BYTES,
      },
      testHooks,
    );
  } catch (error) {
    rethrowTaskAwaitSidecarError(error);
  }
}

export class TaskAwaitCheckpointStore {
  readonly checkpointPath: string;
  readonly sidecarPath: string;

  private readonly boardInstanceId: string;
  private readonly tenantFilter: string[] | undefined;
  private readonly orchestratorFilter: string | undefined;
  private readonly checkpointParentDirectory: SecureDirectory;
  private readonly sidecarLock: SidecarLock;
  private readonly testHooks: TaskAwaitCheckpointStoreTestHooks;
  private closed = false;

  constructor(options: OpenTaskAwaitCheckpointStoreOptions) {
    if (!BOARD_INSTANCE_ID.test(options.boardInstanceId)) {
      throw new Error("expected boardInstanceId が不正です");
    }
    const orchestratorFilter = options.orchestratorId === undefined
      ? undefined
      : normalizeAwaitOrchestratorFilter(options.orchestratorId);
    let tenantFilter: string[] | undefined;
    if (orchestratorFilter === undefined) {
      tenantFilter = options.tenants === undefined
        ? undefined
        : normalizeAwaitTenantFilter(options.tenants);
    } else {
      tenantFilter = options.tenants === undefined || options.tenants.length === 0
        ? []
        : normalizeAwaitTenantFilter(options.tenants);
    }
    const components = checkpointComponents(options.relativePath);
    const directories = buildDirectories(options.home);
    const parent = checkpointParent(directories.taskAwait, components);
    const testHooks = options.testHooks ?? {};
    const fileName = components[components.length - 1];
    if (fileName === undefined) {
      throw new Error("cursor-file のfile名がありません");
    }
    const checkpointPath = join(parent.path, fileName);
    assertContained(directories.taskAwait.path, checkpointPath, "cursor-file");

    const lock = acquireTaskAwaitSidecarLock(
      directories.locks,
      directories.taskAwait,
      parent,
      checkpointPath,
      testHooks,
    );
    this.checkpointPath = checkpointPath;
    this.sidecarPath = lock.lockPath;
    this.boardInstanceId = options.boardInstanceId;
    this.tenantFilter = tenantFilter;
    this.orchestratorFilter = orchestratorFilter;
    this.checkpointParentDirectory = parent;
    this.sidecarLock = lock;
    this.testHooks = testHooks;
  }

  private assertOpenAndLocked(): void {
    if (this.closed) {
      throw new Error("task-await checkpoint store は既にcloseされています");
    }
    try {
      this.sidecarLock.assertOpenAndLocked();
    } catch (error) {
      rethrowTaskAwaitSidecarError(error);
    }
  }

  private assertCheckpointFilter(checkpoint: TaskAwaitCheckpoint): void {
    if (this.orchestratorFilter !== undefined) {
      if (checkpoint.schemaVersion !== TASK_AWAIT_ORCHESTRATOR_CHECKPOINT_SCHEMA_VERSION) {
        throw new Error("task-await checkpoint のschemaVersionがopen条件と一致しません");
      }
      if (checkpoint.filterRevision !== TASK_AWAIT_TENANT_FILTER_REVISION) {
        throw new Error("task-await checkpoint のfilterRevisionがopen条件と一致しません");
      }
      if (checkpoint.orchestratorId !== this.orchestratorFilter) {
        throw new Error("task-await checkpoint のorchestratorIdがopen条件と一致しません");
      }
      if (checkpoint.tenants.length !== this.tenantFilter?.length ||
          checkpoint.tenants.some((tenant, index) => tenant !== this.tenantFilter?.[index])) {
        throw new Error("task-await checkpoint のtenantsがopen条件と一致しません");
      }
      return;
    }
    if (this.tenantFilter === undefined) {
      if (checkpoint.schemaVersion !== TASK_AWAIT_CHECKPOINT_SCHEMA_VERSION) {
        throw new Error("task-await checkpoint のschemaVersionがopen条件と一致しません");
      }
      return;
    }
    if (checkpoint.schemaVersion !== TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION) {
      throw new Error("task-await checkpoint のschemaVersionがopen条件と一致しません");
    }
    if (checkpoint.filterRevision !== TASK_AWAIT_TENANT_FILTER_REVISION) {
      throw new Error("task-await checkpoint のfilterRevisionがopen条件と一致しません");
    }
    if (checkpoint.tenants.length !== this.tenantFilter.length ||
        checkpoint.tenants.some((tenant, index) => tenant !== this.tenantFilter?.[index])) {
      throw new Error("task-await checkpoint のtenantsがopen条件と一致しません");
    }
  }

  private readExisting(): TaskAwaitCheckpoint | null {
    this.assertOpenAndLocked();
    let file: SecureRegularFile;
    try {
      file = openExistingSecureRegularFile(
        this.checkpointPath,
        constants.O_RDONLY,
        "task-await checkpoint",
        TASK_AWAIT_CHECKPOINT_MAX_BYTES,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    try {
      const checkpoint = parseCheckpoint(readFileSync(file.fd));
      if (checkpoint.boardInstanceId !== this.boardInstanceId) {
        throw new Error("task-await checkpoint のboardInstanceIdが現在のboardと一致しません");
      }
      this.assertCheckpointFilter(checkpoint);
      return checkpoint;
    } finally {
      closeSync(file.fd);
      this.assertOpenAndLocked();
    }
  }

  read(): TaskAwaitCheckpoint | null {
    return this.readExisting();
  }

  write(value: TaskAwaitCheckpoint): TaskAwaitCheckpoint {
    const checkpoint = validateCheckpoint(value);
    if (checkpoint.boardInstanceId !== this.boardInstanceId) {
      throw new Error("task-await checkpoint のboardInstanceIdが現在のboardと一致しません");
    }
    this.assertCheckpointFilter(checkpoint);
    const previous = this.readExisting();
    if (previous !== null && checkpoint.eventCursor < previous.eventCursor) {
      throw new Error("task-await checkpoint のeventCursorを逆行させることはできません");
    }
    if (previous !== null && checkpoint.eventCursor === previous.eventCursor) {
      const nextTargets = new Set(checkpoint.targetIds);
      if (previous.targetIds.some((taskId) => !nextTargets.has(taskId))) {
        throw new Error("同じeventCursorでtask-await checkpointのtargetIdsを減らすことはできません");
      }
    }

    const raw = serializeCheckpoint(checkpoint);
    if (Buffer.byteLength(raw, "utf8") > TASK_AWAIT_CHECKPOINT_MAX_BYTES) {
      throw new Error("task-await checkpoint がsize上限を超えています");
    }
    this.assertOpenAndLocked();
    const tempPath = join(
      this.checkpointParentDirectory.path,
      `.${this.checkpointPath.slice(this.checkpointParentDirectory.path.length + 1)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    const temp = createSecureRegularFile(
      tempPath,
      constants.O_WRONLY,
      "task-await checkpoint temp",
      TASK_AWAIT_CHECKPOINT_MAX_BYTES,
    );
    let renamed = false;
    try {
      writeFileSync(temp.fd, raw, "utf8");
      fsyncSync(temp.fd);
      const durable = fstatSync(temp.fd, { bigint: true });
      assertSecureRegularStat(durable, "task-await checkpoint temp", TASK_AWAIT_CHECKPOINT_MAX_BYTES);
      if (!sameIdentity(temp.identity, identityOf(durable))) {
        throw new Error("task-await checkpoint temp のinodeが書き込み中に変化しました");
      }
      this.testHooks.afterTemporaryCheckpointDurable?.();
      this.assertOpenAndLocked();
      const currentTemp = lstatSync(tempPath, { bigint: true });
      assertSecureRegularStat(
        currentTemp,
        "task-await checkpoint temp",
        TASK_AWAIT_CHECKPOINT_MAX_BYTES,
      );
      if (!sameIdentity(temp.identity, identityOf(currentTemp))) {
        throw new Error("task-await checkpoint temp のinodeがrename前に変化しました");
      }

      try {
        const current = openExistingSecureRegularFile(
          this.checkpointPath,
          constants.O_RDONLY,
          "task-await checkpoint",
          TASK_AWAIT_CHECKPOINT_MAX_BYTES,
        );
        closeSync(current.fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      renameSync(tempPath, this.checkpointPath);
      renamed = true;
      const finalStat = lstatSync(this.checkpointPath, { bigint: true });
      assertSecureRegularStat(finalStat, "task-await checkpoint", TASK_AWAIT_CHECKPOINT_MAX_BYTES);
      if (!sameIdentity(temp.identity, identityOf(finalStat))) {
        throw new Error("task-await checkpoint のinodeがatomic rename後に一致しません");
      }
      fsyncDirectory(this.checkpointParentDirectory);
      this.assertOpenAndLocked();
      return checkpoint;
    } finally {
      try {
        if (!renamed) {
          removeIfOwned(tempPath, temp.identity);
          fsyncDirectory(this.checkpointParentDirectory);
        }
      } finally {
        closeSync(temp.fd);
      }
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.sidecarLock.close();
  }
}

/** lock取得を伴う store factory。checkpoint のread/createより前に呼ぶ。 */
export function openTaskAwaitCheckpointStore(
  options: OpenTaskAwaitCheckpointStoreOptions,
): TaskAwaitCheckpointStore {
  return new TaskAwaitCheckpointStore(options);
}
