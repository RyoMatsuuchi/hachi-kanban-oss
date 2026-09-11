import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const RUNTIME_BUNDLE_KINDS = [
  "worktree_postgres",
  "worktree_preview",
  "shared_main_db_exception",
  "legacy_observation",
] as const;
export type RuntimeBundleKind = (typeof RUNTIME_BUNDLE_KINDS)[number];

export const RUNTIME_MEMBER_KINDS = [
  "compose_project",
  "docker_container",
  "docker_network",
  "docker_volume",
  "tcp_port",
  "postgres_endpoint",
] as const;
export type RuntimeMemberKind = (typeof RUNTIME_MEMBER_KINDS)[number];

export type RuntimeCleanupPolicy = "auto" | "orchestrator" | "human" | "never";
export type RuntimeRequirementStatus = "pending" | "provisioning" | "ready" | "failed" | "cancelled";
export type RuntimeLeaseState =
  | "requested"
  | "provisioning"
  | "active"
  | "cleanup_pending"
  | "expired"
  | "releasing"
  | "released"
  | "quarantined"
  | "failed"
  | "cancelled";
export type RuntimeMemberState = "observed" | "active" | "releasing" | "released" | "quarantined";
export type RuntimeTerminalReason = "" | "owner_terminal" | "lease_expired" | "provision_failed" | "explicit_release";

export interface RuntimeResourceRequirementRow {
  id: string;
  taskId: string;
  name: string;
  bundleKind: Exclude<RuntimeBundleKind, "legacy_observation">;
  spec: string;
  status: RuntimeRequirementStatus;
  leaseId: string;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeResourceLeaseRow {
  id: string;
  bundleKind: RuntimeBundleKind;
  state: RuntimeLeaseState;
  cleanupPolicy: RuntimeCleanupPolicy;
  managed: boolean;
  ephemeral: boolean;
  ownerTaskId: string | null;
  ownerRunId: number | null;
  controllerOrchestratorId: string | null;
  board: string;
  project: string;
  repoCommonDir: string;
  canonicalWorktree: string;
  fence: number;
  heartbeatAt: number | null;
  expiresAt: number | null;
  terminalReason: RuntimeTerminalReason;
  provenanceVersion: number;
  rolloutGeneration: number;
  createdAt: number;
  updatedAt: number;
  releasedAt: number | null;
}

export interface RuntimeResourceMemberRow {
  id: string;
  leaseId: string;
  kind: RuntimeMemberKind;
  state: RuntimeMemberState;
  cleanupPolicy: RuntimeCleanupPolicy;
  managed: boolean;
  ephemeral: boolean;
  objectFence: number;
  scopeKey: string;
  nativeId: string;
  displayName: string;
  hostIp: string;
  hostPort: number | null;
  containerPort: number | null;
  composeProject: string;
  labelsHash: string;
  provenance: string;
  provenanceVerifiedAt: number | null;
  lastObservedAt: number;
  releasedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type RuntimeCleanupDecisionClass = "auto" | "orchestrator" | "human";
export type RuntimeCleanupRequestStatus =
  | "queued"
  | "delivered"
  | "claimed"
  | "waiting_human"
  | "approved"
  | "executing"
  | "retry_wait"
  | "succeeded"
  | "rejected"
  | "quarantined"
  | "cancelled";

export interface RuntimeCleanupRequestRow {
  id: string;
  leaseId: string;
  decisionClass: RuntimeCleanupDecisionClass;
  reason: string;
  status: RuntimeCleanupRequestStatus;
  expectedLeaseFence: number;
  expectedMembersHash: string;
  claimantSessionId: string;
  claimantGeneration: number | null;
  claimTokenHash: string;
  claimLeaseUntil: number | null;
  approvedBy: string;
  approvalGeneration: number | null;
  executorId: string;
  executorGeneration: number;
  executorLeaseUntil: number | null;
  executionNonce: string;
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
  /** 人間 escalation の単調世代。通知 dedupe と stale reply fence に使う。 */
  escalationGeneration: number;
  /** 人間回答は worker へ直送せず、再 claim する orchestrator が解釈する。 */
  humanAnswer: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export interface RuntimeResourceEventRow {
  id: number;
  leaseId: string;
  requestId: string | null;
  eventType: string;
  actor: string;
  payload: string;
  idempotencyKey: string;
  createdAt: number;
}

export interface RuntimeOwnerPaths {
  repoCommonDir: string;
  canonicalWorktree: string;
}

export interface RuntimePathResolver {
  realpath(path: string): string;
}

const defaultPathResolver: RuntimePathResolver = {
  realpath(path: string): string {
    return realpathSync.native(path);
  },
};

/** managed lease の owner path は実在する絶対パスの realpath に固定する。 */
export function canonicalizeRuntimeOwnerPaths(
  repoCommonDir: string,
  worktree: string,
  resolver: RuntimePathResolver = defaultPathResolver,
): RuntimeOwnerPaths {
  if (!isAbsolute(repoCommonDir) || !isAbsolute(worktree)) {
    throw new Error("runtime resource owner path は絶対パスが必須です");
  }
  const canonicalRepo = resolver.realpath(repoCommonDir);
  const canonicalWorktree = resolver.realpath(worktree);
  if (!isAbsolute(canonicalRepo) || !isAbsolute(canonicalWorktree)) {
    throw new Error("runtime resource owner path の canonicalization に失敗しました");
  }
  return { repoCommonDir: canonicalRepo, canonicalWorktree };
}

const requirementSpecSchema = z
  .object({
    version: z.literal(1),
    requiredMembers: z.array(z.enum(RUNTIME_MEMBER_KINDS)).min(1),
    ownershipSnapshot: z
      .object({
        version: z.literal(1),
        profileId: z.string().min(1).refine((value) => value === value.trim()),
        orchestratorId: z.string().min(1).refine((value) => value === value.trim()),
        project: z.string().min(1).refine((value) => value === value.trim()),
        repoCommonDir: z
          .string()
          .min(1)
          .refine(isAbsolute)
          .refine((value) => value === value.trim() && !value.includes("\0")),
        canonicalWorktree: z
          .string()
          .min(1)
          .refine(isAbsolute)
          .refine((value) => value === value.trim() && !value.includes("\0")),
      })
      .strict()
      .optional(),
    hostAdapterSnapshot: z
      .object({
        version: z.literal(1),
        hostAdapter: z.literal("worktreePostgres"),
        configFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((spec, context) => {
    if ((spec.ownershipSnapshot === undefined) !== (spec.hostAdapterSnapshot === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runtime profile snapshot は ownership/host adapter の組が必須です",
        path: ["hostAdapterSnapshot"],
      });
    }
  });

const memberProvenanceSchema = z
  .object({
    version: z.literal(1),
    labels: z.record(z.string(), z.string()),
    composeService: z.string().optional(),
    networkMode: z.string().optional(),
  })
  .strict();

export function normalizeRuntimeRequirementSpec(value: unknown): string {
  return JSON.stringify(requirementSpecSchema.parse(value));
}

export function normalizeRuntimeMemberProvenance(value: unknown): string {
  return JSON.stringify(memberProvenanceSchema.parse(value));
}

export function sha256RuntimeValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function runtimeLabelsHash(labels: Readonly<Record<string, string>>): string {
  const canonical = Object.keys(labels)
    .sort()
    .map((key) => [key, labels[key]]);
  return sha256RuntimeValue(JSON.stringify(canonical));
}

export interface RuntimeDiscoveredResource {
  kind: RuntimeMemberKind;
  scopeKey: string;
  nativeId: string;
  displayName: string;
  labels: Readonly<Record<string, string>>;
  attachedNativeIds: readonly string[] | null;
  observedAt: number;
}

export interface RuntimeProvenanceVerification {
  verified: boolean;
  failedConditions: string[];
}

/** DB owner/member と discovery の exact ID・context・required labels を conjunction で照合する。 */
export function verifyRuntimeResourceProvenance(input: {
  lease: RuntimeResourceLeaseRow;
  member: RuntimeResourceMemberRow;
  observed: RuntimeDiscoveredResource;
  minimumRolloutGeneration: number;
}): RuntimeProvenanceVerification {
  const { lease, member, observed } = input;
  const labels = observed.labels;
  const expectedLabels: Readonly<Record<string, string>> = {
    "io.hachi.managed": "true",
    "io.hachi.ephemeral": member.ephemeral ? "true" : "false",
    "io.hachi.provenance-version": String(lease.provenanceVersion),
    "io.hachi.lease-id": lease.id,
    "io.hachi.object-fence": String(member.objectFence),
    "io.hachi.board": lease.board,
    "io.hachi.task-id": lease.ownerTaskId ?? "",
    "io.hachi.orchestrator-id": lease.controllerOrchestratorId ?? "",
    "io.hachi.repo-common-dir-hash": sha256RuntimeValue(lease.repoCommonDir),
    "io.hachi.worktree-hash": sha256RuntimeValue(lease.canonicalWorktree),
    "io.hachi.bundle-kind": lease.bundleKind,
    "io.hachi.rollout-generation": String(lease.rolloutGeneration),
  };
  const labelsMatch = Object.entries(expectedLabels).every(([key, value]) => labels[key] === value);
  // object 作成後に ownerRunId が一度だけ bind されるため、作成時の空 label も immutable provenance として許可する。
  const runLabel = labels["io.hachi.run-id"];
  const runLabelMatches =
    lease.ownerRunId === null ? runLabel === "" : runLabel === "" || runLabel === String(lease.ownerRunId);
  const composeMatches =
    member.composeProject === "" || labels["com.docker.compose.project"] === member.composeProject;
  const conditions: Array<readonly [string, boolean]> = [
    ["managed", lease.managed && member.managed],
    ["provenance_version", lease.provenanceVersion >= 1],
    ["rollout_generation", lease.rolloutGeneration >= input.minimumRolloutGeneration],
    ["kind", observed.kind === member.kind],
    ["scope", observed.scopeKey === member.scopeKey],
    ["native_id", member.nativeId !== "" && observed.nativeId === member.nativeId],
    ["required_labels", labelsMatch],
    ["run_label", runLabelMatches],
    ["compose_labels", composeMatches],
    ["labels_hash", runtimeLabelsHash(labels) === member.labelsHash],
    ["member_state", member.state !== "quarantined"],
  ];
  const failedConditions = conditions.filter((condition) => !condition[1]).map((condition) => condition[0]);
  return { verified: failedConditions.length === 0, failedConditions };
}

export interface RuntimeMemberSnapshot {
  id: string;
  kind: RuntimeMemberKind;
  state: RuntimeMemberState;
  objectFence: number;
  scopeKey: string;
  nativeId: string;
  labelsHash: string;
}

/** request fencing に使う member snapshot hash。順序は member ID で正規化する。 */
export function runtimeMembersHash(members: readonly RuntimeMemberSnapshot[]): string {
  const canonical = [...members]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((member) => ({
      id: member.id,
      kind: member.kind,
      state: member.state,
      objectFence: member.objectFence,
      scopeKey: member.scopeKey,
      nativeId: member.nativeId,
      labelsHash: member.labelsHash,
    }));
  return sha256RuntimeValue(JSON.stringify(canonical));
}

export interface RuntimeAutoCleanupEvidence {
  leaseManaged: boolean;
  memberManaged: boolean;
  leaseEphemeral: boolean;
  memberEphemeral: boolean;
  leaseCleanupPolicy: RuntimeCleanupPolicy;
  memberCleanupPolicy: RuntimeCleanupPolicy;
  provenanceVerified: boolean | null;
  unused: boolean | null;
  ownerTerminal: boolean | null;
  leaseExpired: boolean | null;
  partialProvisionFailed: boolean | null;
  ownerMatches: boolean;
  leaseFenceMatches: boolean;
  memberSnapshotMatches: boolean;
  objectFenceMatches: boolean;
  memberKind: RuntimeMemberKind;
  enforceMode: boolean;
  cleanupEnabled: boolean;
  budgetAvailable: boolean;
  backoffDue: boolean;
}

export interface RuntimeCleanupEligibility {
  eligible: boolean;
  failedConditions: string[];
}

const AUTO_CLEANABLE_MEMBER_KINDS: readonly RuntimeMemberKind[] = [
  "docker_container",
  "docker_network",
  "tcp_port",
];

/** unknown/null を false とし、全証拠の conjunction だけを auto-cleanable とする。 */
export function evaluateRuntimeAutoCleanup(evidence: RuntimeAutoCleanupEvidence): RuntimeCleanupEligibility {
  const conditions: Array<readonly [string, boolean]> = [
    ["managed", evidence.leaseManaged && evidence.memberManaged],
    ["ephemeral", evidence.leaseEphemeral && evidence.memberEphemeral],
    ["cleanup_policy", evidence.leaseCleanupPolicy === "auto" && evidence.memberCleanupPolicy === "auto"],
    ["provenance", evidence.provenanceVerified === true],
    ["unused", evidence.unused === true],
    [
      "terminal_or_expired",
      evidence.ownerTerminal === true || evidence.leaseExpired === true || evidence.partialProvisionFailed === true,
    ],
    ["owner", evidence.ownerMatches],
    ["lease_fence", evidence.leaseFenceMatches],
    ["member_snapshot", evidence.memberSnapshotMatches],
    ["object_fence", evidence.objectFenceMatches],
    ["kind", AUTO_CLEANABLE_MEMBER_KINDS.includes(evidence.memberKind)],
    ["enforce_mode", evidence.enforceMode],
    ["cleanup_enabled", evidence.cleanupEnabled],
    ["budget", evidence.budgetAvailable],
    ["backoff", evidence.backoffDue],
  ];
  const failedConditions = conditions.filter((condition) => !condition[1]).map((condition) => condition[0]);
  return { eligible: failedConditions.length === 0, failedConditions };
}

export const RUNTIME_LEASE_TRANSITIONS: Readonly<Record<RuntimeLeaseState, readonly RuntimeLeaseState[]>> = {
  requested: ["provisioning", "cancelled", "failed"],
  provisioning: ["active", "cleanup_pending", "quarantined", "failed"],
  active: ["active", "cleanup_pending", "expired", "quarantined"],
  cleanup_pending: ["releasing", "quarantined", "cancelled"],
  expired: ["releasing", "quarantined"],
  // released は全 member の released/absent 証拠を同一 Tx で検証する専用 API だけが設定する。
  releasing: ["cleanup_pending", "quarantined"],
  released: [],
  // quarantine 解除は人間が exact object と ownership を再検証し、新しい fence を発行する専用経路に限定する。
  quarantined: [],
  failed: [],
  cancelled: [],
};

export function assertRuntimeLeaseTransition(from: RuntimeLeaseState, to: RuntimeLeaseState): void {
  if (!RUNTIME_LEASE_TRANSITIONS[from].includes(to)) {
    throw new Error(`runtime lease の不正な遷移です: ${from} -> ${to}`);
  }
}
