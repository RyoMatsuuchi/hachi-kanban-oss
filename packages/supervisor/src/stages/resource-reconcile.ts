import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  assertRuntimeProjectHostAdapterSnapshot,
  assertRuntimeProjectOwnershipSnapshot,
  createRuntimeResourceReadView,
  parseRuntimeProjectProfileSnapshots,
  redactText,
  runtimeProjectProfileRequirementIdentityMatches,
  runtimeLabelsHash,
  RUNTIME_MEMBER_KINDS,
  sha256RuntimeValue,
  type RuntimeMemberKind,
  type RuntimeProjectProfileSnapshots,
  type RuntimeResourceLeaseRow,
  type RuntimeResourceRequirementRow,
  type RuntimeResourcesConfig,
  type Stage,
  type StageDeps,
  type StageResult,
  type TaskRow,
} from "@hachi/core";
import {
  HACHI_LABELS,
  HostResourceAdapterError,
  verifyLabelsMatch,
  type CreatedHostResource,
  type HealthCheckConfig,
  type HostResourceAdapter,
  type ProvisionContainerResult,
} from "@hachi/adapters";
import { SUPERVISOR_ACTOR } from "../constants.js";
import { synchronizeRuntimeResourceManifestFence } from "../runtime-resource-manifest.js";
import {
  createRuntimeResourceReplacementRequirement,
  type RuntimeResourceStore,
} from "../runtime-resource-dispatch.js";

const CWD_LINE_REGEX = /^cwd:\s*(\S+)\s*$/m;
const PRE_CREATE_BACKPRESSURE_ATTEMPT_LIMIT = 3;
const RESOURCE_EXHAUSTION_PATTERN =
  /(?:address\s*pool|host\s*port|port).*(?:exhaust|枯渇|no\s+available|already\s+allocated)|(?:exhaust|枯渇|no\s+available).*(?:address\s*pool|host\s*port|port)/iu;

export interface RuntimeResourceReconcileConfig {
  mode: "observe" | "enforce";
  provisioningEnabled: boolean;
  leaseTtlSeconds: number;
  heartbeatIntervalSeconds?: number;
  rolloutGeneration: number;
  scopeKey: string;
  worktreePostgres: {
    image: string;
    containerPort: number;
    healthCheck: HealthCheckConfig;
  };
  runtimeResources: RuntimeResourcesConfig;
  adapter: HostResourceAdapter;
}

interface StageDepsWithRuntimeResourceReconcile extends StageDeps {
  runtimeResourceReconcile?: RuntimeResourceReconcileConfig;
  reloadRuntimeResourceReconcile?: () => RuntimeResourceReconcileConfig | undefined;
}

interface RequirementSpec {
  version: 1;
  requiredMembers: RuntimeMemberKind[];
  profileSnapshots?: RuntimeProjectProfileSnapshots;
}

interface PostgresAssignment {
  database: string;
  role: string;
  passwordFilePath: string;
  containerPasswordFilePath: string;
  manifestPath: string;
}

function extractCwd(task: TaskRow): string | null {
  return CWD_LINE_REGEX.exec(task.body)?.[1] ?? null;
}

function parseRequirementSpec(
  requirement: RuntimeResourceRequirementRow,
  lookup?: { requirement(id: string): RuntimeResourceRequirementRow | null },
): RequirementSpec {
  const parsed = JSON.parse(requirement.spec) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("runtime resource requirement spec が不正です");
  }
  const record = parsed as Record<string, unknown>;
  const requiredMembers = record["requiredMembers"];
  if (
    record["version"] !== 1 ||
    !Array.isArray(requiredMembers) ||
    requiredMembers.length === 0 ||
    !requiredMembers.every(
      (member): member is RuntimeMemberKind =>
        typeof member === "string" && (RUNTIME_MEMBER_KINDS as readonly string[]).includes(member),
    )
  ) {
    throw new Error("runtime resource requirement spec が不正です");
  }
  const profileSnapshots = parseRuntimeProjectProfileSnapshots(record);
  if (
    profileSnapshots !== undefined &&
    !runtimeProjectProfileRequirementIdentityMatches(
      requirement,
      profileSnapshots.ownershipSnapshot,
      lookup,
    )
  ) {
    throw new Error("runtime profile ownership snapshot と requirement identity が一致しません");
  }
  return {
    version: 1,
    requiredMembers,
    ...(profileSnapshots === undefined ? {} : { profileSnapshots }),
  };
}

function killSwitchEnabled(deps: StageDeps): boolean {
  return (
    existsSync(join(deps.env.home, "supervisor.disabled")) ||
    existsSync(join(deps.env.home, "resource-reconcile.disabled"))
  );
}

function validateConfig(config: RuntimeResourceReconcileConfig): void {
  const runtimePostgres = config.runtimeResources.worktreePostgres;
  const currentHealthCheck = runtimePostgres?.healthCheck;
  const healthCheck = config.worktreePostgres.healthCheck;
  if (
    config.scopeKey.trim() === "" ||
    config.worktreePostgres.image.trim() === "" ||
    !Number.isInteger(config.leaseTtlSeconds) ||
    config.leaseTtlSeconds <= 0 ||
    (config.heartbeatIntervalSeconds !== undefined &&
      (
        !Number.isInteger(config.heartbeatIntervalSeconds) ||
        config.heartbeatIntervalSeconds <= 0 ||
        config.heartbeatIntervalSeconds >= config.leaseTtlSeconds
      )) ||
    !Number.isInteger(config.rolloutGeneration) ||
    config.rolloutGeneration < 1 ||
    !Number.isInteger(config.worktreePostgres.containerPort) ||
    config.worktreePostgres.containerPort <= 0 ||
    config.worktreePostgres.containerPort > 65535 ||
    config.runtimeResources.mode !== config.mode ||
    config.runtimeResources.provisioningEnabled !== config.provisioningEnabled ||
    config.runtimeResources.leaseTtlSeconds !== config.leaseTtlSeconds ||
    config.runtimeResources.heartbeatIntervalSeconds !== config.heartbeatIntervalSeconds ||
    (config.runtimeResources.rolloutGeneration ?? 1) !== config.rolloutGeneration ||
    config.runtimeResources.dockerContext !== config.scopeKey ||
    runtimePostgres === undefined ||
    runtimePostgres.image !== config.worktreePostgres.image ||
    runtimePostgres.containerPort !== config.worktreePostgres.containerPort ||
    currentHealthCheck === undefined ||
    currentHealthCheck.intervalMs !== healthCheck.intervalMs ||
    currentHealthCheck.timeoutMs !== healthCheck.timeoutMs ||
    currentHealthCheck.retries !== healthCheck.retries ||
    currentHealthCheck.command.length !== healthCheck.command.length ||
    !currentHealthCheck.command.every((part, index) => part === healthCheck.command[index])
  ) {
    throw new Error("runtime resource reconcile config が不正です");
  }
}

function primaryController(deps: StageDeps, taskId: string): { id: string; project: string; repoCommonDir: string } | null {
  const primaryBindings = deps.store
    .listTaskOrchestratorBindings(taskId)
    .filter((binding) => binding.role === "primary");
  if (primaryBindings.length !== 1) {
    return null;
  }
  const orchestrator = deps.store.getOrchestrator(primaryBindings[0]!.orchestratorId);
  if (orchestrator === null || !isAbsolute(orchestrator.repoCommonDir)) {
    return null;
  }
  return orchestrator;
}

function validateFreshProvisionOwnership(
  deps: StageDeps,
  lease: RuntimeResourceLeaseRow,
  profileSnapshots: RuntimeProjectProfileSnapshots | undefined,
  config: RuntimeResourceReconcileConfig,
): boolean {
  const task = lease.ownerTaskId === null ? null : deps.store.getTask(lease.ownerTaskId);
  const cwd = task === null ? null : extractCwd(task);
  const controller = lease.ownerTaskId === null ? null : primaryController(deps, lease.ownerTaskId);
  if (task === null || cwd === null || controller === null) {
    return false;
  }
  try {
    const leaseOwnershipMatches = (
      realpathSync.native(cwd) === lease.canonicalWorktree &&
      realpathSync.native(controller.repoCommonDir) === lease.repoCommonDir &&
      controller.id === lease.controllerOrchestratorId &&
      controller.project === lease.project
    );
    if (!leaseOwnershipMatches || profileSnapshots === undefined) {
      return leaseOwnershipMatches;
    }
    const { ownershipSnapshot, hostAdapterSnapshot } = profileSnapshots;
    if (
      lease.controllerOrchestratorId !== ownershipSnapshot.orchestratorId ||
      lease.project !== ownershipSnapshot.project ||
      lease.repoCommonDir !== ownershipSnapshot.repoCommonDir ||
      lease.canonicalWorktree !== ownershipSnapshot.canonicalWorktree
    ) {
      return false;
    }
    assertRuntimeProjectOwnershipSnapshot({
      snapshot: ownershipSnapshot,
      orchestrator: controller,
      taskBody: task.body,
    });
    assertRuntimeProjectHostAdapterSnapshot({
      ownershipSnapshot,
      hostAdapterSnapshot,
      requirementBundleKind: "worktree_postgres",
      runtimeResources: config.runtimeResources,
    });
    return true;
  } catch {
    return false;
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("runtime resource private directory の containment を検証できません");
  }
}

function createPostgresAssignment(home: string, lease: RuntimeResourceLeaseRow): PostgresAssignment {
  const suffix = lease.id.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
  const database = `hachi_${suffix}`;
  const role = `hachi_${suffix}`;
  const secretRoot = join(home, "runtime-secrets");
  const secretDirectory = join(secretRoot, lease.id);
  ensurePrivateDirectory(secretRoot);
  ensurePrivateDirectory(secretDirectory);
  const passwordFilePath = join(secretDirectory, "postgres-password");
  writeFileSync(passwordFilePath, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });

  const manifestRoot = join(home, "runtime-manifests");
  ensurePrivateDirectory(manifestRoot);
  return {
    database,
    role,
    passwordFilePath,
    containerPasswordFilePath: "/run/secrets/hachi-postgres-password",
    manifestPath: join(manifestRoot, `${lease.id}.json`),
  };
}

/** side effect 前にだけ、exact lease 配下の未使用 password file を containment 検証して回収する。 */
function removeUnusedPostgresSecret(home: string, leaseId: string): boolean {
  const secretRootPath = join(home, "runtime-secrets");
  const secretDirectoryPath = join(secretRootPath, leaseId);
  const passwordFilePath = join(secretDirectoryPath, "postgres-password");
  try {
    const secretRoot = realpathSync.native(secretRootPath);
    const secretDirectory = realpathSync.native(secretDirectoryPath);
    const passwordFile = lstatSync(passwordFilePath);
    const canonicalPasswordFile = realpathSync.native(passwordFilePath);
    if (
      secretDirectory !== join(secretRoot, leaseId) ||
      relative(secretRoot, secretDirectory) !== leaseId ||
      canonicalPasswordFile !== join(secretDirectory, "postgres-password") ||
      relative(secretDirectory, canonicalPasswordFile) !== "postgres-password" ||
      passwordFile.isSymbolicLink()
    ) {
      return false;
    }
    unlinkSync(canonicalPasswordFile);
    rmdirSync(secretDirectory);
    return true;
  } catch {
    return false;
  }
}

function writePostgresManifest(
  assignment: PostgresAssignment,
  lease: RuntimeResourceLeaseRow,
  hostPort: number,
): void {
  const temporaryPath = `${assignment.manifestPath}.tmp`;
  const manifest = {
    version: 1,
    leaseId: lease.id,
    // manifest は直後の provisioning -> active CAS で進む fence に固定する。
    fence: lease.fence + 1,
    bundleKind: lease.bundleKind,
    host: "127.0.0.1",
    port: hostPort,
    database: assignment.database,
    role: assignment.role,
    secretFilePath: assignment.passwordFilePath,
  };
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporaryPath, assignment.manifestPath);
}

function buildLabels(
  lease: RuntimeResourceLeaseRow,
  objectFence: number,
): Record<string, string> {
  return {
    [HACHI_LABELS.MANAGED]: "true",
    [HACHI_LABELS.EPHEMERAL]: lease.ephemeral ? "true" : "false",
    [HACHI_LABELS.PROVENANCE_VERSION]: String(lease.provenanceVersion),
    [HACHI_LABELS.LEASE_ID]: lease.id,
    [HACHI_LABELS.OBJECT_FENCE]: String(objectFence),
    [HACHI_LABELS.BOARD]: lease.board,
    [HACHI_LABELS.TASK_ID]: lease.ownerTaskId ?? "",
    [HACHI_LABELS.RUN_ID]: "",
    [HACHI_LABELS.ORCHESTRATOR_ID]: lease.controllerOrchestratorId ?? "",
    [HACHI_LABELS.REPO_COMMON_DIR_HASH]: sha256RuntimeValue(lease.repoCommonDir),
    [HACHI_LABELS.WORKTREE_HASH]: sha256RuntimeValue(lease.canonicalWorktree),
    [HACHI_LABELS.BUNDLE_KIND]: lease.bundleKind,
    [HACHI_LABELS.ROLLOUT_GENERATION]: String(lease.rolloutGeneration),
  };
}

function addContainerMember(
  deps: StageDeps,
  lease: RuntimeResourceLeaseRow,
  resource: CreatedHostResource,
  observedAt: number,
): void {
  const store = deps.store as RuntimeResourceStore;
  const existing = store
    .listRuntimeResourceMembers(lease.id)
    .some((member) => member.kind === "docker_container" && member.nativeId === resource.nativeId);
  if (existing) {
    return;
  }
  store.addRuntimeResourceMember({
    leaseId: lease.id,
    expectedLeaseFence: lease.fence,
    kind: "docker_container",
    state: "active",
    cleanupPolicy: lease.cleanupPolicy,
    managed: true,
    ephemeral: lease.ephemeral,
    scopeKey: resource.scopeKey,
    nativeId: resource.nativeId,
    labelsHash: runtimeLabelsHash(resource.labels),
    provenance: { version: 1, labels: resource.labels, networkMode: "bridge" },
    observedAt,
    actor: SUPERVISOR_ACTOR,
  });
}

function addEndpointMembers(
  deps: StageDeps,
  lease: RuntimeResourceLeaseRow,
  result: ProvisionContainerResult,
  scopeKey: string,
  containerPort: number,
  observedAt: number,
): void {
  const store = deps.store as RuntimeResourceStore;
  const mapping = result.portMappings[0];
  if (
    result.portMappings.length !== 1 ||
    mapping === undefined ||
    mapping.containerPort !== containerPort ||
    mapping.hostIp !== "127.0.0.1" ||
    !Number.isInteger(mapping.hostPort) ||
    mapping.hostPort <= 0 ||
    mapping.hostPort > 65535
  ) {
    throw new Error("runtime resource の actual ephemeral port mapping が不正です");
  }
  const common = {
    leaseId: lease.id,
    expectedLeaseFence: lease.fence,
    state: "active" as const,
    cleanupPolicy: lease.cleanupPolicy,
    managed: true,
    ephemeral: lease.ephemeral,
    scopeKey,
    hostIp: mapping.hostIp,
    hostPort: mapping.hostPort,
    containerPort,
    labelsHash: runtimeLabelsHash(result.labels),
    provenance: { version: 1, labels: result.labels, networkMode: "bridge" },
    observedAt,
    actor: SUPERVISOR_ACTOR,
  };
  store.addRuntimeResourceMember({ ...common, kind: "tcp_port" });
  store.addRuntimeResourceMember({ ...common, kind: "postgres_endpoint" });
}

type ProvisionFailureDisposition = "stale" | "backpressure" | "cleanup-pending" | "failed";

function isPreCreateResourceExhaustion(error: unknown, createdResource: CreatedHostResource | undefined): boolean {
  return (
    createdResource === undefined &&
    error instanceof HostResourceAdapterError &&
    ["invalid_id", "invalid_port"].includes(error.code) &&
    RESOURCE_EXHAUSTION_PATTERN.test(error.message)
  );
}

function provisionAttemptNumber(
  requirement: RuntimeResourceRequirementRow,
  requirements: readonly RuntimeResourceRequirementRow[],
): number {
  let current = requirement;
  let attempts = 1;
  const visited = new Set<string>([current.id]);
  while (true) {
    const parent = requirements.find((candidate) => current.idempotencyKey.startsWith(`${candidate.id}:retry:`));
    if (parent === undefined || visited.has(parent.id)) {
      return attempts;
    }
    visited.add(parent.id);
    current = parent;
    attempts += 1;
  }
}

function markProvisionFailure(
  deps: StageDeps,
  requirement: RuntimeResourceRequirementRow,
  leaseId: string,
  createdResource: CreatedHostResource | undefined,
  message: string,
  now: number,
  backpressureEligible: boolean,
  attemptNumber: number,
): ProvisionFailureDisposition {
  const store = deps.store as RuntimeResourceStore;
  const lease = store.getRuntimeResourceLease(leaseId);
  if (lease === null || lease.state !== "provisioning") {
    return "stale";
  }
  const hasMembers = store.listRuntimeResourceMembers(lease.id).length > 0;
  if (createdResource !== undefined || hasMembers) {
    const { lease: failed } = store.transitionRuntimeResourceLeaseWithCleanupRequest({
      leaseId: lease.id,
      expectedFence: lease.fence,
      from: "provisioning",
      terminalReason: "provision_failed",
      decisionClass: lease.cleanupPolicy === "auto" ? "auto" : "orchestrator",
      reason: `partial provision failed: ${message}`,
      actor: SUPERVISOR_ACTOR,
      ...(createdResource === undefined
        ? {}
        : {
            member: {
              kind: "docker_container" as const,
              state: "active" as const,
              cleanupPolicy: lease.cleanupPolicy,
              managed: true,
              ephemeral: lease.ephemeral,
              scopeKey: createdResource.scopeKey,
              nativeId: createdResource.nativeId,
              labelsHash: runtimeLabelsHash(createdResource.labels),
              provenance: { version: 1, labels: createdResource.labels, networkMode: "bridge" },
              observedAt: now,
            },
          }),
    });
    createRuntimeResourceReplacementRequirement(store, requirement, failed.id);
    return "cleanup-pending";
  } else {
    const failed = store.transitionRuntimeResourceLease({
      leaseId: lease.id,
      expectedFence: lease.fence,
      from: "provisioning",
      to: "failed",
      actor: SUPERVISOR_ACTOR,
    });
    const secretRemoved = removeUnusedPostgresSecret(deps.env.home, failed.id);
    if (backpressureEligible && secretRemoved && attemptNumber < PRE_CREATE_BACKPRESSURE_ATTEMPT_LIMIT) {
      // host side effect が無い一時的な枯渇だけを、上限付きの durable 後継要求へ送る。
      createRuntimeResourceReplacementRequirement(store, requirement, failed.id);
      return "backpressure";
    }
    return "failed";
  }
}

async function provisionPostgres(
  deps: StageDeps,
  config: RuntimeResourceReconcileConfig,
  lease: RuntimeResourceLeaseRow,
  profileSnapshots: RuntimeProjectProfileSnapshots | undefined,
  now: number,
): Promise<void> {
  const store = deps.store as RuntimeResourceStore;
  const assignment = createPostgresAssignment(deps.env.home, lease);
  const labels = buildLabels(lease, lease.fence);
  // secret/manifest directory の準備中に controller/path/fence が変わる窓を塞ぐ。adapter はこの検証の
  // 直後にだけ呼び、競合時は外部 container を一切作成しない。
  const freshBeforeProvision = store.getRuntimeResourceLease(lease.id);
  let assignmentIsFresh = false;
  try {
    const secretDirectory = realpathSync.native(join(deps.env.home, "runtime-secrets", lease.id));
    const secretFile = lstatSync(assignment.passwordFilePath);
    const manifestDirectory = lstatSync(join(deps.env.home, "runtime-manifests"));
    const canonicalSecretFile = realpathSync.native(assignment.passwordFilePath);
    assignmentIsFresh =
      canonicalSecretFile === join(secretDirectory, "postgres-password") &&
      relative(secretDirectory, canonicalSecretFile) === "postgres-password" &&
      !secretFile.isSymbolicLink() &&
      (secretFile.mode & 0o077) === 0 &&
      manifestDirectory.isDirectory() &&
      !manifestDirectory.isSymbolicLink();
  } catch {
    assignmentIsFresh = false;
  }
  if (
    killSwitchEnabled(deps) ||
    freshBeforeProvision === null ||
    freshBeforeProvision.state !== "provisioning" ||
    freshBeforeProvision.fence !== lease.fence ||
    freshBeforeProvision.ownerTaskId !== lease.ownerTaskId ||
    freshBeforeProvision.repoCommonDir !== lease.repoCommonDir ||
    freshBeforeProvision.canonicalWorktree !== lease.canonicalWorktree ||
    !validateFreshProvisionOwnership(deps, freshBeforeProvision, profileSnapshots, config) ||
    !assignmentIsFresh
  ) {
    throw new Error("provision 直前の lease/worktree/fence/secret 再検証に失敗しました");
  }
  const result = await config.adapter.provisionContainer({
    scopeKey: config.scopeKey,
    image: config.worktreePostgres.image,
    labels,
    env: {
      POSTGRES_USER: assignment.role,
      POSTGRES_DB: assignment.database,
      POSTGRES_PASSWORD_FILE: assignment.containerPasswordFilePath,
    },
    readOnlyBindMounts: [{
      sourcePath: assignment.passwordFilePath,
      targetPath: assignment.containerPasswordFilePath,
    }],
    exposePorts: [config.worktreePostgres.containerPort],
    healthCheck: {
      ...config.worktreePostgres.healthCheck,
      command: ["pg_isready", "-U", assignment.role, "-d", assignment.database],
    },
  });
  const createdResource: CreatedHostResource = {
    kind: "docker_container",
    nativeId: result.nativeId,
    scopeKey: config.scopeKey,
    labels: result.labels,
  };
  try {
    addContainerMember(deps, lease, createdResource, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HostResourceAdapterError(
      `created container member の初回永続化に失敗しました: ${message}`,
      "inspect_failed",
      createdResource,
    );
  }

  const freshLease = store.getRuntimeResourceLease(lease.id);
  if (
    freshLease === null ||
    freshLease.state !== "provisioning" ||
    freshLease.fence !== lease.fence ||
    freshLease.canonicalWorktree !== lease.canonicalWorktree ||
    killSwitchEnabled(deps) ||
    !validateFreshProvisionOwnership(deps, freshLease, profileSnapshots, config)
  ) {
    throw new HostResourceAdapterError(
      "fresh inspect 前の lease/worktree/fence 再検証に失敗しました",
      "scope_mismatch",
      createdResource,
    );
  }
  const inspection = await config.adapter.inspectContainer(result.nativeId, config.scopeKey);
  const labelMatch = inspection === null ? { matched: false } : verifyLabelsMatch(inspection.labels, labels);
  if (
    inspection === null ||
    inspection.nativeId !== result.nativeId ||
    inspection.scopeKey !== config.scopeKey ||
    !inspection.running ||
    inspection.healthy !== true ||
    !result.healthy ||
    !labelMatch.matched
  ) {
    throw new HostResourceAdapterError(
      "provision 後の exact ID/labels/health 検証に失敗しました",
      "unhealthy",
      createdResource,
    );
  }
  const mapping = result.portMappings[0];
  if (mapping === undefined) {
    throw new HostResourceAdapterError("PostgreSQL port mapping が欠落しています", "invalid_port", createdResource);
  }
  writePostgresManifest(assignment, lease, mapping.hostPort);
  addEndpointMembers(
    deps,
    lease,
    result,
    config.scopeKey,
    config.worktreePostgres.containerPort,
    Math.floor(inspection.observedAt / 1000),
  );
  store.transitionRuntimeResourceLease({
    leaseId: lease.id,
    expectedFence: lease.fence,
    from: "provisioning",
    to: "active",
    actor: SUPERVISOR_ACTOR,
  });
}

interface RuntimeLeaseLifecycleResult {
  actions: number;
  notes: string[];
}

function runtimeLeaseHeartbeatInterval(config: RuntimeResourceReconcileConfig): number {
  return config.heartbeatIntervalSeconds ?? Math.max(1, Math.floor(config.leaseTtlSeconds / 3));
}

function lifecycleCleanupReason(
  lease: RuntimeResourceLeaseRow,
  task: TaskRow,
  cancelStopped: boolean,
): string {
  if (cancelStopped) {
    return `cancel stopped run ${String(lease.ownerRunId)} の runtime resource cleanup`;
  }
  if (task.status === "done" || task.status === "archived") {
    return `terminal task ${task.id} の runtime resource cleanup`;
  }
  return `closed run ${String(lease.ownerRunId)} の runtime resource replacement cleanup`;
}

/**
 * ownerRunId が未bindでも、lease作成後にtask claimがあれば外部launch済みの可能性を除外できない。
 * exact session stop証拠を構成できないため、unusedはunknownとしてauto cleanupを拒否する。
 */
function hasPossibleUnboundWorkerLaunch(
  deps: StageDeps,
  lease: RuntimeResourceLeaseRow,
  task: TaskRow,
): boolean {
  return deps.store
    .listEvents(task.id, "task_claimed")
    .some((event) => event.createdAt >= lease.createdAt);
}

/**
 * active lease のhost-owned heartbeatとrun終端後cleanupを同じtickで収束させる。
 * cancel stop証拠のないrunはcleanupせず、review reworkだけは終了済みrunからのfenced rebind用に維持する。
 */
function reconcileActiveLeaseLifecycle(
  deps: StageDeps,
  config: RuntimeResourceReconcileConfig | undefined,
  apply: boolean,
  now: number,
): RuntimeLeaseLifecycleResult {
  const store = deps.store as RuntimeResourceStore;
  const view = createRuntimeResourceReadView(deps.env.dbPath);
  const activeLeases = view.leases({ state: "active" });
  const requirementsByTask = new Map<string, RuntimeResourceRequirementRow[]>();
  for (const lease of activeLeases) {
    if (lease.ownerTaskId !== null && !requirementsByTask.has(lease.ownerTaskId)) {
      requirementsByTask.set(lease.ownerTaskId, view.requirementsForTask(lease.ownerTaskId));
    }
  }
  view.close();

  const notes: string[] = [];
  let actions = 0;
  const heartbeatInterval = config === undefined ? null : runtimeLeaseHeartbeatInterval(config);
  for (const lease of activeLeases) {
    const task = lease.ownerTaskId === null ? null : deps.store.getTask(lease.ownerTaskId);
    const requirements = lease.ownerTaskId === null
      ? []
      : requirementsByTask.get(lease.ownerTaskId) ?? [];
    const requirement = requirements.find((candidate) => candidate.leaseId === lease.id);
    if (task === null || requirement === undefined || requirement.status !== "ready") {
      notes.push(`${lease.id}: active lease の task/ready requirement が一致しないため lifecycle を保留します`);
      continue;
    }

    const run = lease.ownerRunId === null ? null : store.getRun(lease.ownerRunId);
    if (lease.ownerRunId !== null && (run === null || run.taskId !== task.id)) {
      notes.push(`${lease.id}: owner run identity が一致しないため lifecycle を保留します`);
      continue;
    }
    const cancel = lease.ownerRunId === null
      ? null
      : deps.store.listRunCancelRequests(task.id).find((candidate) => candidate.runId === lease.ownerRunId) ?? null;
    const cancelStopped = cancel?.status === "stopped" && run?.status !== "running";
    const cancelStopUnconfirmed = cancel !== null && cancel.status !== "stopped";
    const taskTerminal = task.status === "done" || task.status === "archived";
    const runClosed = run !== null && run.status !== "running";
    const possibleUnboundLaunch =
      lease.ownerRunId === null &&
      hasPossibleUnboundWorkerLaunch(deps, lease, task);
    const shouldCleanup =
      !cancelStopUnconfirmed &&
      !possibleUnboundLaunch &&
      (
        cancelStopped ||
        (taskTerminal && (lease.ownerRunId === null || runClosed)) ||
        (runClosed && task.status !== "review")
      );

    if (shouldCleanup) {
      actions += 1;
      if (!apply) {
        notes.push(`${lease.id}: dry-run: owner終端後の cleanup request を作成予定です`);
        continue;
      }
      try {
        store.transaction(() => {
          const freshLease = store.getRuntimeResourceLease(lease.id);
          const freshRequirement = store.getRuntimeResourceRequirement(requirement.id);
          if (
            freshLease === null ||
            freshLease.state !== "active" ||
            freshLease.fence !== lease.fence ||
            freshLease.ownerRunId !== lease.ownerRunId ||
            freshRequirement === null ||
            freshRequirement.leaseId !== freshLease.id ||
            freshRequirement.status !== "ready"
          ) {
            throw new Error("runtime lease lifecycle cleanup の fresh fence が一致しません");
          }
          const terminalReason = taskTerminal ? "owner_terminal" as const : "explicit_release" as const;
          store.transitionRuntimeResourceLeaseWithCleanupRequest({
            leaseId: freshLease.id,
            expectedFence: freshLease.fence,
            from: "active",
            terminalReason,
            decisionClass: freshLease.cleanupPolicy === "auto" ? "auto" : "orchestrator",
            reason: lifecycleCleanupReason(freshLease, task, cancelStopped),
            actor: SUPERVISOR_ACTOR,
          });
          if (!taskTerminal) {
            createRuntimeResourceReplacementRequirement(store, freshRequirement, freshLease.id);
          }
        });
        notes.push(`${lease.id}: owner run/task終端を durable cleanup request へ移しました`);
      } catch (error) {
        actions -= 1;
        notes.push(`${lease.id}: lifecycle cleanup CAS が不成立でした`);
        deps.logger.warn("resource-reconcile: lifecycle cleanup を保留しました", {
          leaseId: lease.id,
          error: redactText(error instanceof Error ? error.message : String(error)),
        });
      }
      continue;
    }

    const expiredUnbound =
      lease.ownerRunId === null &&
      lease.expiresAt !== null &&
      lease.expiresAt <= now;
    if (expiredUnbound) {
      if (possibleUnboundLaunch) {
        const reason =
          `needs-manual: 期限切れ未bind runtime resource lease はworker launch済みの可能性があり` +
          ` exact-session stop証拠を確認できません (${lease.id})`;
        if (!apply) {
          if (task.status === "ready" && task.claimLock === "") {
            actions += 1;
            notes.push(`${lease.id}: dry-run: launch可能性がある期限切れ未bind leaseのtaskをneeds-manualにする予定です`);
          } else {
            notes.push(`${lease.id}: launch可能性がある期限切れ未bind leaseをcleanupせず保留します`);
          }
          continue;
        }
        if (deps.store.blockIfReadyUnclaimed(task.id, reason, SUPERVISOR_ACTOR, "human")) {
          actions += 1;
          notes.push(`${lease.id}: exact-session stop証拠が無いためtaskをneeds-manualにしました`);
        } else {
          notes.push(
            `${lease.id}: exact-session stop証拠が無くtaskが未claim readyではないためleaseをcleanupせず保留します`,
          );
        }
        continue;
      }

      let replacementProvisionable = false;
      if (config !== undefined && config.mode === "enforce" && config.provisioningEnabled) {
        try {
          const requirementSpec = parseRequirementSpec(requirement, {
            requirement(id: string): RuntimeResourceRequirementRow | null {
              return requirements.find((candidate) => candidate.id === id) ?? null;
            },
          });
          replacementProvisionable = validateFreshProvisionOwnership(
            deps,
            lease,
            requirementSpec.profileSnapshots,
            config,
          );
        } catch {
          replacementProvisionable = false;
        }
      }
      const replacementBlockReason =
        `needs-manual: 期限切れ未bind runtime resource lease の replacement authorityを解決できません (${lease.id})`;
      actions += 1;
      if (!apply) {
        notes.push(`${lease.id}: dry-run: 期限切れ未bind leaseをcleanup/replacementへ移す予定です`);
        continue;
      }
      try {
        store.transaction(() => {
          const freshLease = store.getRuntimeResourceLease(lease.id);
          const freshRequirement = store.getRuntimeResourceRequirement(requirement.id);
          const freshTask = deps.store.getTask(task.id);
          if (
            freshLease === null ||
            freshLease.state !== "active" ||
            freshLease.fence !== lease.fence ||
            freshLease.ownerRunId !== null ||
            freshLease.expiresAt === null ||
            freshLease.expiresAt > now ||
            freshRequirement === null ||
            freshRequirement.leaseId !== freshLease.id ||
            freshRequirement.status !== "ready" ||
            freshTask === null ||
            freshTask.status === "done" ||
            freshTask.status === "archived" ||
            freshTask.claimLock !== "" ||
            hasPossibleUnboundWorkerLaunch(deps, freshLease, freshTask) ||
            store.listRuntimeResourceMembers(freshLease.id).length === 0
          ) {
            throw new Error("期限切れ未bind runtime lease の fresh fence/member証拠が一致しません");
          }
          store.transitionRuntimeResourceLeaseWithCleanupRequest({
            leaseId: freshLease.id,
            expectedFence: freshLease.fence,
            from: "active",
            terminalReason: "lease_expired",
            decisionClass: freshLease.cleanupPolicy === "auto" ? "auto" : "orchestrator",
            reason: `expired unbound lease ${freshLease.id} の runtime resource replacement cleanup`,
            actor: SUPERVISOR_ACTOR,
          });
          createRuntimeResourceReplacementRequirement(store, freshRequirement, freshLease.id);
          if (
            !replacementProvisionable &&
            freshTask.status === "ready" &&
            !deps.store.blockIfReadyUnclaimed(
              freshTask.id,
              replacementBlockReason,
              SUPERVISOR_ACTOR,
              "human",
            )
          ) {
            throw new Error("期限切れ未bind runtime lease の replacement block CASに失敗しました");
          }
        });
        notes.push(`${lease.id}: 期限切れ未bind leaseをdurable cleanup/replacementへ移しました`);
        if (!replacementProvisionable) {
          notes.push(`${lease.id}: replacement authority不成立のためtaskをneeds-manualにしました`);
        }
      } catch (error) {
        actions -= 1;
        const reason = `needs-manual: 期限切れ未bind runtime resource lease をcleanupへ移せません (${lease.id})`;
        if (deps.store.blockIfReadyUnclaimed(task.id, reason, SUPERVISOR_ACTOR, "human")) {
          actions += 1;
        }
        notes.push(`${lease.id}: 期限切れ未bind leaseのcleanup CASが不成立でした`);
        deps.logger.warn("resource-reconcile: 期限切れ未bind leaseをcleanupへ移せません", {
          leaseId: lease.id,
          error: redactText(error instanceof Error ? error.message : String(error)),
        });
      }
      continue;
    }

    if (cancelStopUnconfirmed && runClosed) {
      notes.push(`${lease.id}: cancel stop 証拠未確認の終了runをcleanup/replacementへ共有しません`);
    }
    if (config === undefined || config.mode !== "enforce" || heartbeatInterval === null) {
      notes.push(`${lease.id}: current enforce config が無いため heartbeat を更新しません`);
      continue;
    }
    let requirementSpec: ReturnType<typeof parseRequirementSpec>;
    try {
      requirementSpec = parseRequirementSpec(requirement, {
        requirement(id: string): RuntimeResourceRequirementRow | null {
          return requirements.find((candidate) => candidate.id === id) ?? null;
        },
      });
    } catch {
      const reason = `needs-manual: runtime resource requirement identity/spec が不正です (${requirement.id})`;
      if (apply && deps.store.blockIfReadyUnclaimed(task.id, reason, SUPERVISOR_ACTOR, "human")) {
        actions += 1;
      }
      notes.push(`${lease.id}: requirement identity/spec が不正なため heartbeat を更新しません`);
      continue;
    }
    if (!validateFreshProvisionOwnership(deps, lease, requirementSpec.profileSnapshots, config)) {
      notes.push(`${lease.id}: current owner/profile authority drift のため heartbeat を更新しません`);
      continue;
    }
    if (lease.expiresAt === null || lease.expiresAt <= now) {
      notes.push(`${lease.id}: active lease の expiry が失効済みまたは不明なため heartbeat を更新しません`);
      continue;
    }
    const heartbeatDue =
      lease.heartbeatAt === null ||
      lease.heartbeatAt + heartbeatInterval <= now ||
      lease.expiresAt <= now + heartbeatInterval;
    if (!heartbeatDue) {
      continue;
    }
    actions += 1;
    if (!apply) {
      notes.push(`${lease.id}: dry-run: runtime lease heartbeat を更新予定です`);
      continue;
    }
    if (!synchronizeRuntimeResourceManifestFence(deps.env.home, lease)) {
      actions -= 1;
      notes.push(`${lease.id}: manifest fence を検証できないため heartbeat を更新しません`);
      continue;
    }
    try {
      const renewed = store.renewRuntimeResourceLease({
        leaseId: lease.id,
        expectedFence: lease.fence,
        controllerOrchestratorId: lease.controllerOrchestratorId!,
        repoCommonDir: lease.repoCommonDir,
        worktree: lease.canonicalWorktree,
        heartbeatAt: now,
        expiresAt: now + config.leaseTtlSeconds,
        actor: SUPERVISOR_ACTOR,
      });
      if (!synchronizeRuntimeResourceManifestFence(deps.env.home, renewed)) {
        notes.push(`${lease.id}: renew後manifest fenceの追従に失敗し、dispatchをfail-closedに保ちます`);
      } else {
        notes.push(`${lease.id}: runtime lease heartbeat/fence を更新しました`);
      }
    } catch (error) {
      actions -= 1;
      notes.push(`${lease.id}: runtime lease heartbeat CAS が不成立でした`);
      deps.logger.warn("resource-reconcile: lease heartbeat 更新を保留しました", {
        leaseId: lease.id,
        error: redactText(error instanceof Error ? error.message : String(error)),
      });
    }
  }
  return { actions, notes };
}

export const resourceReconcileStage: Stage = {
  name: "resource-reconcile",

  async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
    if (killSwitchEnabled(deps)) {
      return { name: "resource-reconcile", actions: 0, skipped: true, notes: ["kill-switch が有効です"] };
    }
    const reconcileDeps = deps as StageDepsWithRuntimeResourceReconcile;
    const config = reconcileDeps.reloadRuntimeResourceReconcile === undefined
      ? reconcileDeps.runtimeResourceReconcile
      : reconcileDeps.reloadRuntimeResourceReconcile();
    if (config !== undefined) {
      validateConfig(config);
    }
    const lifecycle = reconcileActiveLeaseLifecycle(deps, config, apply, now);
    if (config === undefined || config.mode !== "enforce") {
      return {
        name: "resource-reconcile",
        actions: lifecycle.actions,
        skipped: false,
        notes: [
          ...lifecycle.notes,
          "runtime resource config が無いため observe-only / provision disabled です",
        ],
      };
    }
    const store = deps.store as RuntimeResourceStore;

    let actions = lifecycle.actions;
    const notes: string[] = [...lifecycle.notes];
    if (!config.provisioningEnabled) {
      notes.push("runtime resource provisioning disabled: lifecycle のみ実行しました");
      return { name: "resource-reconcile", actions, skipped: false, notes };
    }
    const candidates = [
      ...deps.store.listByStatus("ready"),
      ...deps.store.listByStatus("blocked").filter((task) => task.blockReason.startsWith("auto-launch-failed:")),
    ];
    candidateLoop: for (const task of candidates) {
      // requirement が無い通常taskには ownership/profile 診断を適用しない。
      const view = createRuntimeResourceReadView(deps.env.dbPath);
      const taskRequirements = view.requirementsForTask(task.id);
      const requirements = taskRequirements.filter((requirement) => requirement.status === "pending");
      view.close();
      if (requirements.length === 0) {
        continue;
      }

      const blockForManualRecovery = (detail: string): void => {
        const reason = `needs-manual: runtime resource ${detail}`;
        if (apply && deps.store.blockIfReadyUnclaimed(task.id, reason, SUPERVISOR_ACTOR, "human")) {
          actions += 1;
        }
      };
      const cwd = extractCwd(task);
      if (cwd === null || !isAbsolute(cwd)) {
        blockForManualRecovery("owner cwd を検証できません");
        notes.push(`${task.id}: owner cwd を検証できないため provision を保留します`);
        continue;
      }
      const controller = primaryController(deps, task.id);
      if (controller === null) {
        blockForManualRecovery("primary orchestrator/controller を一意に解決できません");
        notes.push(`${task.id}: primary orchestrator/controller を一意に解決できないため provision を保留します`);
        continue;
      }
      let canonicalWorktree: string;
      let repoCommonDir: string;
      try {
        canonicalWorktree = realpathSync.native(cwd);
        repoCommonDir = realpathSync.native(controller.repoCommonDir);
      } catch {
        blockForManualRecovery("owner path の realpath を検証できません");
        notes.push(`${task.id}: owner path の realpath 検証に失敗したため provision を保留します`);
        continue;
      }

      for (const requirement of requirements) {
        if (requirement.bundleKind !== "worktree_postgres") {
          blockForManualRecovery(`未対応 bundle kind です (${requirement.bundleKind})`);
          notes.push(`${task.id}: 未対応 bundle kind のため provision を保留します (${requirement.bundleKind})`);
          continue candidateLoop;
        }
        let requirementSpec: ReturnType<typeof parseRequirementSpec>;
        try {
          requirementSpec = parseRequirementSpec(requirement, {
            requirement(id: string): RuntimeResourceRequirementRow | null {
              return taskRequirements.find((candidate) => candidate.id === id) ?? null;
            },
          });
        } catch {
          blockForManualRecovery(`requirement identity/spec が不正です (${requirement.id})`);
          notes.push(`${task.id}: requirement identity/spec が不正なため provision を保留します (${requirement.id})`);
          continue candidateLoop;
        }
        const profileSnapshots = requirementSpec.profileSnapshots;
        const ownershipSnapshot = profileSnapshots?.ownershipSnapshot;
        if (profileSnapshots !== undefined) {
          try {
            assertRuntimeProjectOwnershipSnapshot({
              snapshot: profileSnapshots.ownershipSnapshot,
              orchestrator: controller,
              taskBody: task.body,
            });
            assertRuntimeProjectHostAdapterSnapshot({
              ownershipSnapshot: profileSnapshots.ownershipSnapshot,
              hostAdapterSnapshot: profileSnapshots.hostAdapterSnapshot,
              requirementBundleKind: requirement.bundleKind,
              runtimeResources: config.runtimeResources,
            });
          } catch {
            const reason =
              `needs-manual: runtime profile snapshot/config drift のため provision できません (${requirement.id})`;
            if (apply && deps.store.blockIfReadyUnclaimed(task.id, reason, SUPERVISOR_ACTOR, "human")) {
              actions += 1;
            }
            notes.push(
              `${task.id}: runtime profile snapshot/config drift のため provision を保留します (${requirement.id})`,
            );
            continue;
          }
        }
        if (!apply) {
          actions += 1;
          notes.push(`${task.id}: dry-run: requirement ${requirement.id} を provision 予定です`);
          continue;
        }

        let lease: RuntimeResourceLeaseRow;
        try {
          const reserved = store.reserveRuntimeResourceLease({
            requirementId: requirement.id,
            controllerOrchestratorId: ownershipSnapshot?.orchestratorId ?? controller.id,
            board: deps.env.board,
            project: ownershipSnapshot?.project ?? controller.project,
            repoCommonDir: ownershipSnapshot?.repoCommonDir ?? repoCommonDir,
            worktree: ownershipSnapshot?.canonicalWorktree ?? canonicalWorktree,
            cleanupPolicy: "auto",
            managed: true,
            ephemeral: true,
            expiresAt: now + config.leaseTtlSeconds,
            provenanceVersion: 1,
            rolloutGeneration: config.rolloutGeneration,
            actor: SUPERVISOR_ACTOR,
          });
          lease = store.claimRuntimeResourceLease(reserved.id, reserved.fence, SUPERVISOR_ACTOR);
        } catch {
          notes.push(`${task.id}: requirement ${requirement.id} の CAS claim 競合によりスキップしました`);
          continue;
        }

        try {
          await provisionPostgres(deps, config, lease, profileSnapshots, now);
          actions += 1;
          notes.push(`${task.id}: runtime resource lease ${lease.id} を active/ready にしました`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const redactedMessage = redactText(message);
          const createdResource = error instanceof HostResourceAdapterError ? error.createdResource : undefined;
          const disposition = markProvisionFailure(
            deps,
            requirement,
            lease.id,
            createdResource,
            message,
            now,
            isPreCreateResourceExhaustion(error, createdResource),
            provisionAttemptNumber(requirement, taskRequirements),
          );
          actions += disposition === "stale" ? 0 : 1;
          if (disposition === "backpressure") {
            deps.logger.warn("runtime resource provision を backpressure しました", {
              stage: "resource-reconcile",
              taskId: task.id,
              requirementId: requirement.id,
              leaseId: lease.id,
              reason: redactedMessage,
            });
            notes.push(
              `${task.id}: provision 失敗を backpressure し、後継 requirement の再試行を待ちます (${redactedMessage})`,
            );
            // host 枯渇・未知の create 前失敗時に同一 tick で別 task の provision を連打しない。
            break candidateLoop;
          } else {
            notes.push(`${task.id}: provision 失敗を fail-closed で記録しました (${redactedMessage})`);
          }
        }
      }
    }
    return { name: "resource-reconcile", actions, skipped: false, notes };
  },
};
