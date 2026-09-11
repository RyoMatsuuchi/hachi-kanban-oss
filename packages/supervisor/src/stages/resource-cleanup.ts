// durable cleanup request を exact-ID external effect へ変換する host supervisor 専用 stage（contract §56）。
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  HostResourceAdapterError,
  type ContainerInspection,
  type HostResourceAdapter,
  type NetworkInspection,
  type RemoveResult,
} from "@hachi/adapters";
import {
  createRuntimeResourceReadView,
  evaluateRuntimeAutoCleanup,
  redactText,
  runtimeMembersHash,
  verifyRuntimeResourceProvenance,
  type RuntimeCleanupExecutionAttempt,
  type RuntimeCleanupExecutionFence,
  type RuntimeCleanupRequestRow,
  type RuntimeResourceLeaseRow,
  type RuntimeResourceMemberRow,
  type Stage,
  type StageDeps,
} from "@hachi/core";
import { SUPERVISOR_ACTOR } from "../constants.js";
import { cancellationForRun } from "./cancel.js";

const EXECUTOR_LEASE_SECONDS = 30;

export interface RuntimeResourceCleanupConfig {
  mode: "enforce";
  maxRequestsPerTick: number;
  maxContainerRemovalsPerTick: number;
  maxNetworkRemovalsPerTick: number;
  maxWallSecondsPerTick: number;
  baseBackoffSeconds: number;
  maxBackoffSeconds: number;
  maxAttempts: number;
  autoCleanupRolloutGeneration: number;
  executorId: string;
  adapter: HostResourceAdapter;
  /** deterministic test 用。production は Date.now。 */
  clockMs?: () => number;
}

interface StageDepsWithRuntimeResourceCleanup extends StageDeps {
  runtimeResourceCleanup?: RuntimeResourceCleanupConfig;
  reloadRuntimeResourceCleanup?: () => RuntimeResourceCleanupConfig | undefined;
}

interface RuntimeCleanupStore {
  listDueRuntimeCleanupRequests(limit: number, now?: number): RuntimeCleanupRequestRow[];
  beginRuntimeCleanupAttempt(input: {
    requestId: string;
    executorId: string;
    executorLeaseSeconds: number;
    now?: number;
  }): RuntimeCleanupExecutionAttempt;
  getRuntimeCleanupRequest(id: string): RuntimeCleanupRequestRow | null;
  getRuntimeResourceLease(id: string): RuntimeResourceLeaseRow | null;
  listRuntimeResourceMembers(leaseId: string): RuntimeResourceMemberRow[];
  markRuntimeCleanupEffectStarted(input: RuntimeCleanupExecutionFence & { memberId: string; now?: number }): void;
  markRuntimeCleanupMemberReleased(input: RuntimeCleanupExecutionFence & {
    memberId: string;
    result: Record<string, unknown>;
    now?: number;
  }): RuntimeCleanupExecutionAttempt;
  completeRuntimeCleanupAttempt(input: RuntimeCleanupExecutionFence & { now?: number }): void;
  retryRuntimeCleanupAttempt(input: RuntimeCleanupExecutionFence & {
    error: string;
    nextAttemptAt: number;
    now?: number;
  }): void;
  deferRuntimeCleanupAttempt(input: RuntimeCleanupExecutionFence & {
    reason: string;
    now?: number;
  }): void;
  quarantineRuntimeCleanupRequest(input: {
    requestId: string;
    reason: string;
    actor: string;
    exhausted?: boolean;
    executionNonce?: string;
    executorGeneration?: number;
    now?: number;
  }): void;
}

interface CleanupBudget {
  containers: number;
  networks: number;
}

interface MemberProvenance {
  version: 1;
  labels: Record<string, string>;
}

class RetryableCleanupError extends Error {}
class QuarantineCleanupError extends Error {}
class CleanupPausedError extends Error {}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
}

function cleanupDisabled(deps: StageDeps): boolean {
  return (
    existsSync(join(deps.env.home, "supervisor.disabled")) ||
    existsSync(join(deps.env.home, "resource-cleanup.disabled"))
  );
}

/**
 * released 済み worktree PostgreSQL の非DB artifact を exact lease path だけで回収する。
 * ディレクトリ全体の再帰削除は行わず、未知ファイルやsymlinkを検出した場合は残して診断へ委ねる。
 */
function removeReleasedPostgresArtifacts(home: string, lease: RuntimeResourceLeaseRow): boolean {
  if (lease.bundleKind !== "worktree_postgres" || lease.state !== "released") {
    return false;
  }
  let removed = false;
  const manifestRootPath = join(home, "runtime-manifests");
  const manifestPath = join(manifestRootPath, `${lease.id}.json`);
  if (existsSync(manifestPath)) {
    const manifestRoot = realpathSync.native(manifestRootPath);
    const manifestStat = lstatSync(manifestPath);
    const canonicalManifest = realpathSync.native(manifestPath);
    const parsed = JSON.parse(readFileSync(canonicalManifest, "utf8")) as Record<string, unknown>;
    if (
      manifestStat.isSymbolicLink() ||
      !manifestStat.isFile() ||
      (manifestStat.mode & 0o077) !== 0 ||
      canonicalManifest !== join(manifestRoot, `${lease.id}.json`) ||
      relative(manifestRoot, canonicalManifest) !== `${lease.id}.json` ||
      parsed["version"] !== 1 ||
      parsed["leaseId"] !== lease.id
    ) {
      throw new Error(`released lease ${lease.id} の manifest containment/identity が不正です`);
    }
    unlinkSync(canonicalManifest);
    removed = true;
  }

  const secretRootPath = join(home, "runtime-secrets");
  const secretDirectoryPath = join(secretRootPath, lease.id);
  if (!existsSync(secretDirectoryPath)) {
    return removed;
  }
  const secretRoot = realpathSync.native(secretRootPath);
  const secretDirectoryStat = lstatSync(secretDirectoryPath);
  const secretDirectory = realpathSync.native(secretDirectoryPath);
  if (
    secretDirectoryStat.isSymbolicLink() ||
    !secretDirectoryStat.isDirectory() ||
    secretDirectory !== join(secretRoot, lease.id) ||
    relative(secretRoot, secretDirectory) !== lease.id
  ) {
    throw new Error(`released lease ${lease.id} の secret directory containment が不正です`);
  }
  const passwordFilePath = join(secretDirectory, "postgres-password");
  if (existsSync(passwordFilePath)) {
    const passwordStat = lstatSync(passwordFilePath);
    const canonicalPasswordFile = realpathSync.native(passwordFilePath);
    if (
      passwordStat.isSymbolicLink() ||
      !passwordStat.isFile() ||
      (passwordStat.mode & 0o077) !== 0 ||
      canonicalPasswordFile !== passwordFilePath ||
      relative(secretDirectory, canonicalPasswordFile) !== "postgres-password"
    ) {
      throw new Error(`released lease ${lease.id} の secret file containment が不正です`);
    }
    unlinkSync(canonicalPasswordFile);
    removed = true;
  }
  // 未知ファイルがあれば ENOTEMPTY となり、再帰削除せず診断へ残す。
  rmdirSync(secretDirectory);
  return true;
}

function validateConfig(config: RuntimeResourceCleanupConfig): void {
  const positiveIntegers = [
    config.maxRequestsPerTick,
    config.maxContainerRemovalsPerTick,
    config.maxNetworkRemovalsPerTick,
    config.maxWallSecondsPerTick,
    config.baseBackoffSeconds,
    config.maxBackoffSeconds,
    config.maxAttempts,
    config.autoCleanupRolloutGeneration,
  ];
  if (
    config.executorId.trim() === "" ||
    positiveIntegers.some((value) => !Number.isInteger(value) || value <= 0) ||
    config.maxRequestsPerTick > 100 ||
    config.maxContainerRemovalsPerTick > 100 ||
    config.maxNetworkRemovalsPerTick > 100 ||
    config.maxWallSecondsPerTick > 300 ||
    config.baseBackoffSeconds > 86_400 ||
    config.maxBackoffSeconds > 86_400 ||
    config.maxAttempts > 100 ||
    config.autoCleanupRolloutGeneration > 2_147_483_647 ||
    config.maxBackoffSeconds < config.baseBackoffSeconds
  ) {
    throw new Error("runtime resource cleanup config が不正です");
  }
}

/** request ID と attempt 回数だけから決まる bounded exponential backoff。 */
export function runtimeCleanupBackoffSeconds(
  requestId: string,
  attempts: number,
  baseSeconds: number,
  maxSeconds: number,
): number {
  const exponent = Math.max(0, Math.min(30, attempts - 1));
  const exponential = Math.min(maxSeconds, baseSeconds * (2 ** exponent));
  const jitterWindow = Math.max(1, Math.floor(exponential / 4));
  const digest = createHash("sha256").update(`${requestId}:${String(attempts)}`, "utf8").digest();
  const jitter = digest.readUInt32BE(0) % jitterWindow;
  return Math.min(maxSeconds, exponential + jitter);
}

function parseProvenance(member: RuntimeResourceMemberRow): MemberProvenance {
  let value: unknown;
  try {
    value = JSON.parse(member.provenance) as unknown;
  } catch {
    throw new QuarantineCleanupError(`member ${member.id} の provenance JSON が不正です`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new QuarantineCleanupError(`member ${member.id} の provenance を検証できません`);
  }
  const record = value as Record<string, unknown>;
  const labels = record.labels;
  if (record.version !== 1 || typeof labels !== "object" || labels === null || Array.isArray(labels)) {
    throw new QuarantineCleanupError(`member ${member.id} の provenance version/labels が不正です`);
  }
  if (Object.values(labels).some((entry) => typeof entry !== "string")) {
    throw new QuarantineCleanupError(`member ${member.id} の provenance labels が不正です`);
  }
  return { version: 1, labels: labels as Record<string, string> };
}

function fenceFrom(attempt: RuntimeCleanupExecutionAttempt, config: RuntimeResourceCleanupConfig): RuntimeCleanupExecutionFence {
  return {
    requestId: attempt.request.id,
    executionNonce: attempt.executionNonce,
    executorId: config.executorId,
    executorGeneration: attempt.executorGeneration,
    expectedLeaseFence: attempt.request.expectedLeaseFence,
    expectedMembersHash: attempt.request.expectedMembersHash,
  };
}

function freshAttempt(
  store: RuntimeCleanupStore,
  attempt: RuntimeCleanupExecutionAttempt,
): RuntimeCleanupExecutionAttempt {
  const request = store.getRuntimeCleanupRequest(attempt.request.id);
  const lease = request === null ? null : store.getRuntimeResourceLease(request.leaseId);
  const members = lease === null ? [] : store.listRuntimeResourceMembers(lease.id);
  if (
    request === null || lease === null || request.status !== "executing" ||
    request.executionNonce !== attempt.executionNonce ||
    request.executorGeneration !== attempt.executorGeneration ||
    request.expectedLeaseFence !== lease.fence || request.expectedMembersHash !== runtimeMembersHash(members)
  ) {
    throw new QuarantineCleanupError("cleanup request/lease/member の fresh fence が一致しません");
  }
  return { ...attempt, request, lease, members };
}

function terminalEvidence(deps: StageDeps, lease: RuntimeResourceLeaseRow, now: number): boolean {
  if (lease.terminalReason === "provision_failed") {
    return true;
  }
  const task = lease.ownerTaskId === null ? null : deps.store.getTask(lease.ownerTaskId);
  const runStore = deps.store as unknown as { getRun(id: number): { status: string } | null };
  const run = lease.ownerRunId === null ? null : runStore.getRun(lease.ownerRunId);
  if (lease.terminalReason === "lease_expired") {
    if (lease.expiresAt === null || lease.expiresAt > now || task === null) {
      return false;
    }
    // dispatch前の未bind leaseは、exact expiryとtask ownershipだけでunusedを証明できる。
    if (lease.ownerRunId === null) {
      return true;
    }
  }
  if (lease.terminalReason === "explicit_release") {
    if (task === null) {
      return false;
    }
    if (lease.ownerRunId === null) {
      // launch前/launch失敗でrunへbindされなかったexact lease。
      return true;
    }
    if (run === null || run.status === "running") {
      return false;
    }
    const cancel = deps.store
      .listRunCancelRequests(task.id)
      .find((candidate) => candidate.runId === lease.ownerRunId);
    return cancel === undefined || cancel.status === "stopped";
  }
  const taskTerminal = task === null || task.status === "done" || task.status === "archived";
  const runTerminal = run === null || run.status !== "running";
  if (!taskTerminal || !runTerminal) {
    return false;
  }
  if (lease.ownerRunId !== null && task !== null) {
    const cancel = deps.store
      .listRunCancelRequests(task.id)
      .find((candidate) => candidate.runId === lease.ownerRunId);
    if (cancel !== undefined && cancel.status !== "stopped") {
      return false;
    }
  }
  if (lease.terminalReason === "owner_terminal") {
    return true;
  }
  return lease.terminalReason === "lease_expired";
}

function observedContainer(inspection: ContainerInspection): {
  kind: "docker_container";
  scopeKey: string;
  nativeId: string;
  displayName: string;
  labels: Readonly<Record<string, string>>;
  attachedNativeIds: readonly string[];
  observedAt: number;
} {
  return {
    kind: "docker_container",
    scopeKey: inspection.scopeKey,
    nativeId: inspection.nativeId,
    displayName: "",
    labels: inspection.labels,
    attachedNativeIds: inspection.networkIds,
    observedAt: inspection.observedAt,
  };
}

function observedNetwork(inspection: NetworkInspection): {
  kind: "docker_network";
  scopeKey: string;
  nativeId: string;
  displayName: string;
  labels: Readonly<Record<string, string>>;
  attachedNativeIds: readonly string[];
  observedAt: number;
} {
  return {
    kind: "docker_network",
    scopeKey: inspection.scopeKey,
    nativeId: inspection.nativeId,
    displayName: "",
    labels: inspection.labels,
    attachedNativeIds: inspection.connectedContainerIds,
    observedAt: inspection.observedAt,
  };
}

function assertEligible(input: {
  deps: StageDeps;
  attempt: RuntimeCleanupExecutionAttempt;
  member: RuntimeResourceMemberRow;
  provenanceVerified: boolean;
  unused: boolean;
  config: RuntimeResourceCleanupConfig;
  now: number;
}): void {
  const { attempt, member, config } = input;
  if (attempt.request.decisionClass !== "auto") {
    if (attempt.request.approvedBy === "") {
      throw new QuarantineCleanupError("orchestrator cleanup request の durable approval がありません");
    }
    if (
      !attempt.lease.managed || !member.managed || !attempt.lease.ephemeral || !member.ephemeral ||
      !input.provenanceVerified || attempt.lease.cleanupPolicy === "never" || member.cleanupPolicy === "never"
    ) {
      throw new QuarantineCleanupError("approved request の managed/ephemeral/provenance を検証できません");
    }
    return;
  }
  const eligibility = evaluateRuntimeAutoCleanup({
    leaseManaged: attempt.lease.managed,
    memberManaged: member.managed,
    leaseEphemeral: attempt.lease.ephemeral,
    memberEphemeral: member.ephemeral,
    leaseCleanupPolicy: attempt.lease.cleanupPolicy,
    memberCleanupPolicy: member.cleanupPolicy,
    provenanceVerified: input.provenanceVerified,
    unused: input.unused,
    ownerTerminal:
      ["owner_terminal", "explicit_release"].includes(attempt.lease.terminalReason) &&
      terminalEvidence(input.deps, attempt.lease, input.now),
    leaseExpired: attempt.lease.terminalReason === "lease_expired" && terminalEvidence(input.deps, attempt.lease, input.now),
    partialProvisionFailed: attempt.lease.terminalReason === "provision_failed",
    ownerMatches: terminalEvidence(input.deps, attempt.lease, input.now),
    leaseFenceMatches: attempt.request.expectedLeaseFence === attempt.lease.fence,
    memberSnapshotMatches: attempt.request.expectedMembersHash === runtimeMembersHash(attempt.members),
    objectFenceMatches: true,
    memberKind: member.kind,
    enforceMode: config.mode === "enforce",
    cleanupEnabled: true,
    budgetAvailable: true,
    backoffDue: attempt.request.nextAttemptAt <= input.now,
  });
  if (!eligibility.eligible) {
    throw new QuarantineCleanupError(`auto cleanup eligibility 不一致: ${eligibility.failedConditions.join(",")}`);
  }
}

function checkControl(
  deps: StageDeps,
  config: RuntimeResourceCleanupConfig,
  startedMs: number,
  lease?: RuntimeResourceLeaseRow,
): void {
  if (cleanupDisabled(deps)) {
    throw new CleanupPausedError("resource-cleanup kill-switch が有効です");
  }
  const clockMs = config.clockMs ?? Date.now;
  if (clockMs() - startedMs >= config.maxWallSecondsPerTick * 1_000) {
    throw new CleanupPausedError("resource-cleanup wall-clock budget に到達しました");
  }
  if (lease?.ownerRunId !== null && lease?.ownerRunId !== undefined) {
    const openOwnerRun = deps.store.listOpenRuns().find((run) => run.id === lease.ownerRunId);
    if (openOwnerRun !== undefined && cancellationForRun(deps.store, openOwnerRun.id) !== null) {
      throw new CleanupPausedError("cancel stop 証拠未確認の owner run があるため resource cleanup を延期します");
    }
  }
}

function classifyRemoveResult(result: RemoveResult, recovery: boolean): void {
  if (result.status === "removed") {
    return;
  }
  if (result.status === "already_absent" && recovery) {
    return;
  }
  if (result.status === "containers_remain") {
    throw new RetryableCleanupError(result.failureDetail ?? result.status);
  }
  throw new QuarantineCleanupError(result.failureDetail ?? result.status);
}

async function releaseContainer(input: {
  deps: StageDeps;
  store: RuntimeCleanupStore;
  attempt: RuntimeCleanupExecutionAttempt;
  memberId: string;
  config: RuntimeResourceCleanupConfig;
  budget: CleanupBudget;
  startedMs: number;
  now: number;
  signal: AbortSignal;
}): Promise<RuntimeCleanupExecutionAttempt> {
  if (input.budget.containers >= input.config.maxContainerRemovalsPerTick) {
    throw new CleanupPausedError("container removal budget に到達しました");
  }
  let current = freshAttempt(input.store, input.attempt);
  const member = current.members.find((candidate) => candidate.id === input.memberId);
  if (member === undefined || member.kind !== "docker_container" || member.state !== "releasing") {
    throw new QuarantineCleanupError("container member の fresh state/kind が不正です");
  }
  const provenance = parseProvenance(member);
  const inspection = await input.config.adapter.inspectContainer(
    member.nativeId,
    member.scopeKey,
    { signal: input.signal },
  );
  if (inspection === null) {
    if (!current.recoveryMemberIds.includes(member.id)) {
      throw new QuarantineCleanupError("container exact ID absent に対応する effect_started 証拠がありません");
    }
  } else {
    const verification = verifyRuntimeResourceProvenance({
      lease: current.lease,
      member,
      observed: observedContainer(inspection),
      minimumRolloutGeneration: input.config.autoCleanupRolloutGeneration,
    });
    assertEligible({
      deps: input.deps,
      attempt: current,
      member,
      provenanceVerified: verification.verified,
      unused: terminalEvidence(input.deps, current.lease, input.now),
      config: input.config,
      now: input.now,
    });
  }
  checkControl(input.deps, input.config, input.startedMs, current.lease);
  current = freshAttempt(input.store, current);
  const fence = fenceFrom(current, input.config);
  input.store.markRuntimeCleanupEffectStarted({ ...fence, memberId: member.id, now: input.now });
  // intent 永続化中の switch 変更も effect 前に止める。
  checkControl(input.deps, input.config, input.startedMs, current.lease);
  // remove 発行後は応答を観測できなくても外部で削除済みの可能性があるため、発行前に保守的に消費する。
  input.budget.containers += 1;
  const result = await input.config.adapter.removeContainer(
    {
      nativeId: member.nativeId,
      scopeKey: member.scopeKey,
      expectedLabels: provenance.labels,
      executionNonce: current.executionNonce,
    },
    { signal: input.signal },
  );
  classifyRemoveResult(result, current.recoveryMemberIds.includes(member.id) || inspection !== null);
  if (await input.config.adapter.inspectContainer(member.nativeId, member.scopeKey, { signal: input.signal }) !== null) {
    throw new RetryableCleanupError("remove 後も container exact ID が存在します");
  }
  return input.store.markRuntimeCleanupMemberReleased({
    ...fence,
    memberId: member.id,
    result: { kind: member.kind, nativeId: member.nativeId, status: result.status },
    now: input.now,
  });
}

async function releaseNetwork(input: {
  deps: StageDeps;
  store: RuntimeCleanupStore;
  attempt: RuntimeCleanupExecutionAttempt;
  memberId: string;
  config: RuntimeResourceCleanupConfig;
  budget: CleanupBudget;
  startedMs: number;
  now: number;
  signal: AbortSignal;
}): Promise<RuntimeCleanupExecutionAttempt> {
  if (input.budget.networks >= input.config.maxNetworkRemovalsPerTick) {
    throw new CleanupPausedError("network removal budget に到達しました");
  }
  let current = freshAttempt(input.store, input.attempt);
  const member = current.members.find((candidate) => candidate.id === input.memberId);
  if (member === undefined || member.kind !== "docker_network" || member.state !== "releasing") {
    throw new QuarantineCleanupError("network member の fresh state/kind が不正です");
  }
  const provenance = parseProvenance(member);
  const containerIds = current.members
    .filter((candidate) => candidate.kind === "docker_container")
    .map((candidate) => candidate.nativeId);
  for (const containerId of containerIds) {
    if (await input.config.adapter.inspectContainer(containerId, member.scopeKey, { signal: input.signal }) !== null) {
      throw new RetryableCleanupError("container が残るため network を解放できません");
    }
  }
  const inspection = await input.config.adapter.inspectNetwork(member.nativeId, member.scopeKey, { signal: input.signal });
  if (inspection === null) {
    if (!current.recoveryMemberIds.includes(member.id)) {
      throw new QuarantineCleanupError("network exact ID absent に対応する effect_started 証拠がありません");
    }
  } else {
    if (inspection.isBuiltInBridge) {
      throw new QuarantineCleanupError("built-in bridge は cleanup 対象外です");
    }
    const verification = verifyRuntimeResourceProvenance({
      lease: current.lease,
      member,
      observed: observedNetwork(inspection),
      minimumRolloutGeneration: input.config.autoCleanupRolloutGeneration,
    });
    assertEligible({
      deps: input.deps,
      attempt: current,
      member,
      provenanceVerified: verification.verified,
      unused: inspection.connectedContainerIds.length === 0,
      config: input.config,
      now: input.now,
    });
  }
  checkControl(input.deps, input.config, input.startedMs, current.lease);
  current = freshAttempt(input.store, current);
  const fence = fenceFrom(current, input.config);
  input.store.markRuntimeCleanupEffectStarted({ ...fence, memberId: member.id, now: input.now });
  // intent 永続化中の switch 変更も effect 前に止める。
  checkControl(input.deps, input.config, input.startedMs, current.lease);
  // remove 発行後は応答を観測できなくても外部で削除済みの可能性があるため、発行前に保守的に消費する。
  input.budget.networks += 1;
  const result = await input.config.adapter.removeNetwork(
    {
      nativeId: member.nativeId,
      scopeKey: member.scopeKey,
      expectedLabels: provenance.labels,
      executionNonce: current.executionNonce,
      expectedAbsentContainerIds: containerIds,
    },
    { signal: input.signal },
  );
  classifyRemoveResult(result, current.recoveryMemberIds.includes(member.id) || inspection !== null);
  if (await input.config.adapter.inspectNetwork(member.nativeId, member.scopeKey, { signal: input.signal }) !== null) {
    throw new RetryableCleanupError("remove 後も network exact ID が存在します");
  }
  return input.store.markRuntimeCleanupMemberReleased({
    ...fence,
    memberId: member.id,
    result: { kind: member.kind, nativeId: member.nativeId, status: result.status },
    now: input.now,
  });
}

async function releaseDerivedMembers(input: {
  store: RuntimeCleanupStore;
  attempt: RuntimeCleanupExecutionAttempt;
  config: RuntimeResourceCleanupConfig;
  now: number;
  signal: AbortSignal;
}): Promise<RuntimeCleanupExecutionAttempt> {
  let current = freshAttempt(input.store, input.attempt);
  const containerMembers = current.members.filter((member) => member.kind === "docker_container");
  const derivedMembers = current.members.filter(
    (member) => member.state === "releasing" && ["tcp_port", "postgres_endpoint"].includes(member.kind),
  );
  if (derivedMembers.length > 0 && containerMembers.length === 0) {
    throw new QuarantineCleanupError("port/endpoint の owner container exact ID が記録されていません");
  }
  for (const container of containerMembers) {
    if (await input.config.adapter.inspectContainer(
      container.nativeId,
      container.scopeKey,
      { signal: input.signal },
    ) !== null) {
      throw new RetryableCleanupError("container が残るため port/endpoint を released にできません");
    }
  }
  for (const member of derivedMembers) {
    if (!member.managed || !member.ephemeral || member.cleanupPolicy === "never") {
      throw new QuarantineCleanupError(`derived member ${member.id} の ownership を検証できません`);
    }
    const fence = fenceFrom(current, input.config);
    current = input.store.markRuntimeCleanupMemberReleased({
      ...fence,
      memberId: member.id,
      result: { kind: member.kind, status: "owner_container_absent" },
      now: input.now,
    });
  }
  return current;
}

async function executeRequest(input: {
  deps: StageDeps;
  store: RuntimeCleanupStore;
  request: RuntimeCleanupRequestRow;
  config: RuntimeResourceCleanupConfig;
  budget: CleanupBudget;
  startedMs: number;
  now: number;
  signal: AbortSignal;
}): Promise<void> {
  if (input.request.attempts >= input.config.maxAttempts) {
    input.store.quarantineRuntimeCleanupRequest({
      requestId: input.request.id,
      reason: `最大試行回数 ${String(input.config.maxAttempts)} に到達しました`,
      actor: SUPERVISOR_ACTOR,
      exhausted: true,
      now: input.now,
    });
    return;
  }
  let attempt: RuntimeCleanupExecutionAttempt;
  try {
    attempt = input.store.beginRuntimeCleanupAttempt({
      requestId: input.request.id,
      executorId: input.config.executorId,
      executorLeaseSeconds: Math.max(EXECUTOR_LEASE_SECONDS, input.config.maxWallSecondsPerTick + 5),
      now: input.now,
    });
  } catch (error) {
    const fresh = input.store.getRuntimeCleanupRequest(input.request.id);
    // 別 tick が先に execution claim を得た通常競合は、その executor に任せる。
    if (fresh?.status === "executing" && fresh.executorLeaseUntil !== null && fresh.executorLeaseUntil > input.now) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    input.store.quarantineRuntimeCleanupRequest({
      requestId: input.request.id,
      reason: `execution preflight 不一致: ${message}`,
      actor: SUPERVISOR_ACTOR,
      now: input.now,
    });
    return;
  }
  try {
    checkControl(input.deps, input.config, input.startedMs, attempt.lease);
    const unsupported = attempt.members.find((member) =>
      member.state !== "released" && ["docker_volume", "compose_project"].includes(member.kind),
    );
    if (unsupported !== undefined) {
      throw new QuarantineCleanupError(`${unsupported.kind} は v1 cleanup 対象外です`);
    }
    for (const member of attempt.members.filter(
      (candidate) => candidate.kind === "docker_container" && candidate.state === "releasing",
    )) {
      checkControl(input.deps, input.config, input.startedMs, attempt.lease);
      attempt = await releaseContainer({ ...input, attempt, memberId: member.id });
    }
    for (const member of attempt.members.filter(
      (candidate) => candidate.kind === "docker_network" && candidate.state === "releasing",
    )) {
      checkControl(input.deps, input.config, input.startedMs, attempt.lease);
      attempt = await releaseNetwork({ ...input, attempt, memberId: member.id });
    }
    checkControl(input.deps, input.config, input.startedMs, attempt.lease);
    attempt = await releaseDerivedMembers({
      store: input.store,
      attempt,
      config: input.config,
      now: input.now,
      signal: input.signal,
    });
    attempt = freshAttempt(input.store, attempt);
    input.store.completeRuntimeCleanupAttempt({ ...fenceFrom(attempt, input.config), now: input.now });
    const releasedLease = input.store.getRuntimeResourceLease(attempt.lease.id);
    if (releasedLease !== null && !cleanupDisabled(input.deps)) {
      try {
        removeReleasedPostgresArtifacts(input.deps.env.home, releasedLease);
      } catch (error) {
        input.deps.logger.warn("resource-cleanup: released artifact 回収を次tickへ延期しました", {
          leaseId: releasedLease.id,
          error: redactText(error instanceof Error ? error.message : String(error)),
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let current: RuntimeCleanupExecutionAttempt;
    try {
      current = freshAttempt(input.store, attempt);
    } catch (freshError) {
      const competing = input.store.getRuntimeCleanupRequest(attempt.request.id);
      if (
        competing?.status === "executing" &&
        (competing.executionNonce !== attempt.executionNonce ||
          competing.executorGeneration !== attempt.executorGeneration)
      ) {
        // 新 generation が authority を取得済み。旧 executor は current request を変更しない。
        return;
      }
      const freshMessage = freshError instanceof Error ? freshError.message : String(freshError);
      input.store.quarantineRuntimeCleanupRequest({
        requestId: attempt.request.id,
        reason: `${message}; fresh execution fence: ${freshMessage}`,
        actor: SUPERVISOR_ACTOR,
        now: input.now,
      });
      return;
    }
    if (error instanceof CleanupPausedError) {
      input.store.deferRuntimeCleanupAttempt({
        ...fenceFrom(current, input.config),
        reason: message,
        now: input.now,
      });
      return;
    }
    const retryable =
      error instanceof RetryableCleanupError ||
      isAbortError(error) ||
      (error instanceof HostResourceAdapterError && ["inspect_failed", "unhealthy"].includes(error.code));
    if (error instanceof QuarantineCleanupError || !retryable) {
      input.store.quarantineRuntimeCleanupRequest({
        requestId: current.request.id,
        reason: message,
        actor: SUPERVISOR_ACTOR,
        executionNonce: current.executionNonce,
        executorGeneration: current.executorGeneration,
        now: input.now,
      });
      return;
    }
    const exhausted = current.request.attempts >= input.config.maxAttempts;
    if (exhausted) {
      input.store.quarantineRuntimeCleanupRequest({
        requestId: current.request.id,
        reason: message,
        actor: SUPERVISOR_ACTOR,
        exhausted: true,
        executionNonce: current.executionNonce,
        executorGeneration: current.executorGeneration,
        now: input.now,
      });
      return;
    }
    const delay = runtimeCleanupBackoffSeconds(
      current.request.id,
      current.request.attempts,
      input.config.baseBackoffSeconds,
      input.config.maxBackoffSeconds,
    );
    input.store.retryRuntimeCleanupAttempt({
      ...fenceFrom(current, input.config),
      error: message,
      nextAttemptAt: input.now + delay,
      now: input.now,
    });
  }
}

export const resourceCleanupStage: Stage = {
  name: "resource-cleanup",
  async tick(deps, apply, now) {
    const cleanupDeps = deps as StageDepsWithRuntimeResourceCleanup;
    const config = cleanupDeps.reloadRuntimeResourceCleanup === undefined
      ? cleanupDeps.runtimeResourceCleanup
      : cleanupDeps.reloadRuntimeResourceCleanup();
    if (config === undefined) {
      return { name: "resource-cleanup", actions: 0, skipped: false, notes: ["observe-only: cleanup config なし"] };
    }
    validateConfig(config);
    if (cleanupDisabled(deps)) {
      return { name: "resource-cleanup", actions: 0, skipped: true, notes: ["kill-switch"] };
    }
    const store = deps.store as unknown as RuntimeCleanupStore;
    const requests = store.listDueRuntimeCleanupRequests(config.maxRequestsPerTick, now);
    if (!apply) {
      return {
        name: "resource-cleanup",
        actions: 0,
        skipped: false,
        notes: [`dry-run: due request ${String(requests.length)} 件（external effect なし）`],
      };
    }
    const clockMs = config.clockMs ?? Date.now;
    const startedMs = clockMs();
    const signal = AbortSignal.timeout(config.maxWallSecondsPerTick * 1_000);
    const budget: CleanupBudget = { containers: 0, networks: 0 };
    let actions = 0;
    const notes: string[] = [];
    for (const request of requests) {
      if (cleanupDisabled(deps) || clockMs() - startedMs >= config.maxWallSecondsPerTick * 1_000) {
        notes.push("kill-switch または wall-clock budget により残 request を延期しました");
        break;
      }
      const lease = store.getRuntimeResourceLease(request.leaseId);
      if (lease !== null && !terminalEvidence(deps, lease, now)) {
        const cancelExists =
          lease.ownerRunId !== null &&
          lease.ownerTaskId !== null &&
          deps.store
            .listRunCancelRequests(lease.ownerTaskId)
            .some((cancel) => cancel.runId === lease.ownerRunId);
        notes.push(cancelExists
          ? `${request.id}: cancel stop 証拠未確認の run が resource を所有しているため cleanup を延期します`
          : `${request.id}: owner terminal/expiry 証拠未確認のため cleanup を延期します`);
        continue;
      }
      await executeRequest({ deps, store, request, config, budget, startedMs, now, signal });
      actions += 1;
    }
    // DB commit 後・artifact unlink 前 crash の回復。released exact lease だけを再走査する。
    const view = createRuntimeResourceReadView(deps.env.dbPath);
    const releasedLeases = view.leases({ state: "released" });
    view.close();
    for (const lease of releasedLeases) {
      if (cleanupDisabled(deps) || clockMs() - startedMs >= config.maxWallSecondsPerTick * 1_000) {
        notes.push("kill-switch または wall-clock budget により artifact cleanup を延期しました");
        break;
      }
      try {
        if (removeReleasedPostgresArtifacts(deps.env.home, lease)) {
          actions += 1;
        }
      } catch (error) {
        notes.push(`${lease.id}: released runtime artifact の containment/cleanup が不一致です`);
        deps.logger.warn("resource-cleanup: released artifact の exact cleanup に失敗しました", {
          leaseId: lease.id,
          error: redactText(error instanceof Error ? error.message : String(error)),
        });
      }
    }
    return { name: "resource-cleanup", actions, skipped: false, notes };
  },
};
