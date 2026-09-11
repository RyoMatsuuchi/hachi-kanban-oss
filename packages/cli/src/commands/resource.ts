// =============================================================================
// hachi resource: runtime lease の read/status/request porcelain。
// Docker/OS の観測は read-only に限り、cleanup の実行・delete/prune/adopt は公開しない。
// =============================================================================

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { Command } from "commander";
import {
  createRuntimeResourceReadView,
  newNonce,
  redactJsonStrings,
  redactMaybeJsonText,
  redactText,
  type RuntimeCleanupRequestRow,
  type RuntimeLeaseState,
  type RuntimeResourceEventRow,
  type RuntimeResourceLeaseRow,
  type RuntimeResourceMemberRow,
} from "@hachi/core";
import type { CliDeps } from "../deps.js";
import { withErrorHandling } from "../errors.js";
import { emit, singularResourceEnvelope } from "../output.js";
import {
  SystemRuntimeResourceInspector,
  type RuntimeMemberInspection,
  type RuntimeResourceInspector,
  type RuntimeResourceInventory,
} from "../resource-inspector.js";

const DEFAULT_CLAIM_LEASE_SEC = 600;
const RUNTIME_LEASE_STATES: readonly RuntimeLeaseState[] = [
  "requested",
  "provisioning",
  "active",
  "cleanup_pending",
  "expired",
  "releasing",
  "released",
  "quarantined",
  "failed",
  "cancelled",
];

interface JsonOption {
  json?: boolean;
}

interface OfflineOption {
  offline?: boolean;
}

interface ConfirmOption {
  confirm?: boolean;
}

interface ResourceMutationStore {
  getRuntimeCleanupRequest(id: string): RuntimeCleanupRequestRow | null;
  requestRuntimeResourceRelease(input: {
    leaseId: string;
    expectedLeaseFence: number;
    reason: string;
    actor: string;
  }): RuntimeCleanupRequestRow;
  claimRuntimeCleanupRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    expectedLeaseFence: number;
    leaseUntil: number;
  }): RuntimeCleanupRequestRow;
  approveRuntimeCleanupRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    expectedLeaseFence: number;
  }): RuntimeCleanupRequestRow;
  rejectRuntimeCleanupRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    expectedLeaseFence: number;
    reason: string;
  }): RuntimeCleanupRequestRow;
  releaseRuntimeCleanupRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    expectedLeaseFence: number;
  }): RuntimeCleanupRequestRow;
  escalateRuntimeCleanupRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    expectedLeaseFence: number;
    question: string;
  }): RuntimeCleanupRequestRow;
}

interface PublicLease {
  id: string;
  bundleKind: string;
  state: string;
  cleanupPolicy: string;
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
  terminalReason: string;
  provenanceVersion: number;
  rolloutGeneration: number;
  createdAt: number;
  updatedAt: number;
  releasedAt: number | null;
}

interface PublicMember {
  id: string;
  leaseId: string;
  kind: string;
  state: string;
  cleanupPolicy: string;
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
  provenanceRecorded: boolean;
  provenanceVerifiedAt: number | null;
  lastObservedAt: number;
  releasedAt: number | null;
}

interface PublicCleanupRequest {
  id: string;
  leaseId: string;
  decisionClass: string;
  reason: string;
  status: string;
  expectedLeaseFence: number;
  expectedMembersHash: string;
  claimantSessionId: string;
  claimantGeneration: number | null;
  claimLeaseUntil: number | null;
  approvedBy: string;
  approvalGeneration: number | null;
  executorId: string;
  executorGeneration: number;
  executorLeaseUntil: number | null;
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

interface PublicEvent {
  id: number;
  requestId: string | null;
  eventType: string;
  actor: string;
  payload: unknown;
  createdAt: number;
}

interface CleanupDecision {
  category: "hold" | "auto_candidate" | "orchestrator" | "human";
  reason: string;
}

interface PortOwnerConflict {
  memberId: string;
  expectedPid: number;
  expectedStartTime: string;
  actualPid: number | null;
  actualStartTime: string;
  reason: "listener_missing" | "multiple_listeners" | "pid_mismatch" | "start_time_mismatch";
}

interface HostNativePortIdentity {
  kind: "host_native";
  owner: { pid: number; startTime: string };
}

interface DockerPublishedPortIdentity {
  kind: "docker_published";
  containerMember: RuntimeResourceMemberRow;
}

interface InvalidPortIdentity {
  kind: "invalid";
}

type PortIdentity = HostNativePortIdentity | DockerPublishedPortIdentity | InvalidPortIdentity;

interface DockerPortMappingConflict {
  memberId: string;
  containerMemberId: string;
  reason: "container_metadata_missing" | "mapping_missing" | "multiple_mappings" | "mapping_mismatch";
}

function assertSafeSecretComponent(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`runtime cleanup ${label} がsecret pathに使用できません`);
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function writeCleanupClaimToken(deps: CliDeps, request: RuntimeCleanupRequestRow, token: string): string {
  assertSafeSecretComponent(request.leaseId, "leaseId");
  assertSafeSecretComponent(request.id, "requestId");
  const root = join(deps.env.home, "runtime-secrets");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error("runtime-secrets root にsymlinkは使用できません");
  }
  chmodSync(root, 0o700);
  const rootReal = realpathSync.native(root);
  const directory = join(root, request.leaseId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || !isContainedPath(rootReal, realpathSync.native(directory))) {
    throw new Error("cleanup claim token directory がruntime-secrets配下ではありません");
  }
  chmodSync(directory, 0o700);
  const path = join(directory, `cleanup-claim-${request.id}-${newNonce()}.token`);
  writeFileSync(path, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}

function readCleanupClaimToken(deps: CliDeps, path: string): string {
  if (!isAbsolute(path)) {
    throw new Error("cleanup claim token file は絶対パスが必須です");
  }
  const rootPath = join(deps.env.home, "runtime-secrets");
  if (lstatSync(rootPath).isSymbolicLink() || lstatSync(path).isSymbolicLink()) {
    throw new Error("cleanup claim token path にsymlinkは使用できません");
  }
  const root = realpathSync.native(rootPath);
  const resolved = realpathSync.native(path);
  if (!isContainedPath(root, resolved)) {
    throw new Error("cleanup claim token file がruntime-secrets配下ではありません");
  }
  const stat = lstatSync(resolved);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error("cleanup claim token file は0600の通常ファイルが必須です");
  }
  const token = readFileSync(resolved, "utf8").trim();
  if (!/^[0-9a-f]{32,128}$/.test(token)) {
    throw new Error("cleanup claim token file の内容が不正です");
  }
  return token;
}

export function removeCleanupClaimToken(deps: CliDeps, path: string): boolean {
  try {
    unlinkSync(realpathSync.native(path));
    return true;
  } catch (err) {
    deps.stderr.write(`警告: cleanup claim token file を削除できませんでした: ${redactText(err instanceof Error ? err.message : String(err))}\n`);
    return false;
  }
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} は1以上の整数が必須です: ${value}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} は安全な整数が必須です: ${value}`);
  }
  return parsed;
}

function parseLeaseState(value: string): RuntimeLeaseState {
  if (!RUNTIME_LEASE_STATES.includes(value as RuntimeLeaseState)) {
    throw new Error(`state が不正です: ${value}`);
  }
  return value as RuntimeLeaseState;
}

function mutationStore(deps: CliDeps): ResourceMutationStore {
  const candidate = deps.store as unknown as Partial<ResourceMutationStore>;
  const required: Array<keyof ResourceMutationStore> = [
    "getRuntimeCleanupRequest",
    "requestRuntimeResourceRelease",
    "claimRuntimeCleanupRequest",
    "approveRuntimeCleanupRequest",
    "rejectRuntimeCleanupRequest",
    "releaseRuntimeCleanupRequest",
    "escalateRuntimeCleanupRequest",
  ];
  if (required.some((key) => typeof candidate[key] !== "function")) {
    throw new Error("runtime resource Store API が未対応です。migration v13 以降の supervisor を使用してください");
  }
  return candidate as ResourceMutationStore;
}

function orchestratorIdForSession(deps: CliDeps, sessionId: string, generation: number): string {
  const session = deps.store.getOrchestratorSession(sessionId);
  if (session === null || session.status !== "active" || session.generation !== generation) {
    throw new Error("SESSION_SUPERSEDED: active generation と一致しません");
  }
  return session.orchestratorId;
}

function publicLease(lease: RuntimeResourceLeaseRow): PublicLease {
  return {
    ...lease,
    id: redactText(lease.id),
    ownerTaskId: lease.ownerTaskId === null ? null : redactText(lease.ownerTaskId),
    controllerOrchestratorId: lease.controllerOrchestratorId === null ? null : redactText(lease.controllerOrchestratorId),
    repoCommonDir: redactText(lease.repoCommonDir),
    canonicalWorktree: redactText(lease.canonicalWorktree),
  };
}

function publicMember(member: RuntimeResourceMemberRow): PublicMember {
  return {
    id: redactText(member.id),
    leaseId: redactText(member.leaseId),
    kind: member.kind,
    state: member.state,
    cleanupPolicy: member.cleanupPolicy,
    managed: member.managed,
    ephemeral: member.ephemeral,
    objectFence: member.objectFence,
    scopeKey: redactText(member.scopeKey),
    nativeId: redactText(member.nativeId),
    displayName: redactText(member.displayName),
    hostIp: redactText(member.hostIp),
    hostPort: member.hostPort,
    containerPort: member.containerPort,
    composeProject: redactText(member.composeProject),
    labelsHash: redactText(member.labelsHash),
    provenanceRecorded: member.provenance !== "",
    provenanceVerifiedAt: member.provenanceVerifiedAt,
    lastObservedAt: member.lastObservedAt,
    releasedAt: member.releasedAt,
  };
}

function publicInspection(inspection: RuntimeMemberInspection): RuntimeMemberInspection {
  return redactJsonStrings(inspection) as RuntimeMemberInspection;
}

function publicInventory(inventory: RuntimeResourceInventory | null): RuntimeResourceInventory | null {
  return inventory === null
    ? null
    : redactJsonStrings(inventory) as RuntimeResourceInventory;
}

function publicRequest(request: RuntimeCleanupRequestRow): PublicCleanupRequest {
  return {
    id: redactText(request.id),
    leaseId: redactText(request.leaseId),
    decisionClass: request.decisionClass,
    reason: redactText(request.reason),
    status: request.status,
    expectedLeaseFence: request.expectedLeaseFence,
    expectedMembersHash: redactText(request.expectedMembersHash),
    claimantSessionId: redactText(request.claimantSessionId),
    claimantGeneration: request.claimantGeneration,
    claimLeaseUntil: request.claimLeaseUntil,
    approvedBy: redactText(request.approvedBy),
    approvalGeneration: request.approvalGeneration,
    executorId: redactText(request.executorId),
    executorGeneration: request.executorGeneration,
    executorLeaseUntil: request.executorLeaseUntil,
    attempts: request.attempts,
    nextAttemptAt: request.nextAttemptAt,
    lastError: redactText(request.lastError),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    resolvedAt: request.resolvedAt,
  };
}

function publicEvent(event: RuntimeResourceEventRow): PublicEvent {
  const redacted = redactMaybeJsonText(event.payload);
  let payload: unknown = redacted;
  try {
    payload = JSON.parse(redacted) as unknown;
  } catch {
    // 壊れた既存 event も CLI を落とさず安全な文字列として可視化する。
  }
  return {
    id: event.id,
    requestId: event.requestId === null ? null : redactText(event.requestId),
    eventType: redactText(event.eventType),
    actor: redactText(event.actor),
    payload,
    createdAt: event.createdAt,
  };
}

function cleanupDecision(
  lease: RuntimeResourceLeaseRow,
  members: readonly RuntimeResourceMemberRow[],
  requests: readonly RuntimeCleanupRequestRow[],
): CleanupDecision {
  const activeRequest = requests.find((request) =>
    ["queued", "delivered", "claimed", "waiting_human", "approved", "executing", "retry_wait"].includes(request.status),
  );
  if (activeRequest !== undefined) {
    const category = activeRequest.decisionClass === "human" ? "human" : "orchestrator";
    return { category, reason: `cleanup request=${activeRequest.id} status=${activeRequest.status} を待機中` };
  }
  if (!lease.managed || lease.bundleKind === "legacy_observation") {
    return { category: "human", reason: "legacy/unowned は managed=0 として隔離し、人間判断が必要です" };
  }
  if (lease.cleanupPolicy === "human" || lease.cleanupPolicy === "never") {
    return { category: "human", reason: `lease cleanupPolicy=${lease.cleanupPolicy} のため人間判断が必要です` };
  }
  if (members.some((member) => member.kind === "docker_volume")) {
    return { category: "human", reason: "docker_volume を含むため v1 では保持します" };
  }
  if (lease.state === "active" || lease.state === "provisioning" || lease.state === "requested") {
    return { category: "hold", reason: `lease state=${lease.state} は live owner を保護するため保持します` };
  }
  if (!["cleanup_pending", "expired"].includes(lease.state)) {
    return { category: "hold", reason: `lease state=${lease.state} は cleanup 対象外のため保持します` };
  }
  if (lease.cleanupPolicy === "orchestrator") {
    return { category: "orchestrator", reason: "cleanupPolicy=orchestrator のため担当者の fenced 判断が必要です" };
  }
  if (!lease.ephemeral || members.some((member) => !member.managed || !member.ephemeral || member.cleanupPolicy !== "auto")) {
    return { category: "human", reason: "managed/ephemeral/auto policy の根拠が不足するため人間判断が必要です" };
  }
  return {
    category: "auto_candidate",
    reason: "dry-run 候補です。provenance・unused・object fence・kill-switch・budget の再検証前には解放しません",
  };
}

function inspectionFor(members: readonly RuntimeResourceMemberRow[], offline: boolean, deps: CliDeps): Promise<RuntimeMemberInspection[]> {
  if (offline) {
    return Promise.resolve([]);
  }
  const inspector = deps.runtimeResourceInspector ?? new SystemRuntimeResourceInspector();
  const liveMembers = members.filter((member) => member.state !== "released");
  return Promise.all(liveMembers.map((member) => {
    if (resolvePortIdentity(member, liveMembers).kind === "docker_published") {
      // Docker-owned published port は owner container の exact inspect/mapping で照合し、
      // Docker backend の実装依存 listener PID を host-native identity として扱わない。
      return Promise.resolve({
        memberId: member.id,
        available: true,
        error: "",
        portOwner: null,
        portOwners: [],
        docker: null,
      });
    }
    return inspector.inspectMember(member);
  }));
}

function formatListLine(lease: RuntimeResourceLeaseRow, decision: CleanupDecision): string {
  const owner = lease.ownerTaskId ?? "-";
  return `${lease.id} [${lease.state}] task=${owner} fence=${lease.fence} ${decision.category}: ${decision.reason}`;
}

async function runList(
  deps: CliDeps,
  options: JsonOption & OfflineOption & { task?: string; state?: RuntimeLeaseState; inventory?: boolean },
): Promise<void> {
  const view = createRuntimeResourceReadView(deps.env.dbPath);
  try {
    const leases = view.leases({
      ...(options.task === undefined ? {} : { taskId: options.task }),
      ...(options.state === undefined ? {} : { state: options.state }),
    });
    const rows = leases.map((lease) => {
      const members = view.members(lease.id);
      const requests = view.cleanupRequests(lease.id);
      return {
        rawLease: lease,
        lease: publicLease(lease),
        members: members.map(publicMember),
        cleanup: cleanupDecision(lease, members, requests),
      };
    });

    const inspector = deps.runtimeResourceInspector ?? new SystemRuntimeResourceInspector();
    const inventory = options.inventory === true && options.offline !== true
      ? await inspector.inventory()
      : null;
    const knownNetworkIds = new Set(
      leases.flatMap((lease) => view.members(lease.id))
        .filter((member) => member.kind === "docker_network")
        .map((member) => member.nativeId),
    );
    const legacyCandidates = inventory === null || !inventory.available
      ? []
      : inventory.networks
        .filter((network) => !["bridge", "host", "none"].includes(network.displayName) && !knownNetworkIds.has(network.nativeId))
        .map((network) => ({
          kind: "docker_network",
          nativeId: redactText(network.nativeId),
          displayName: redactText(network.displayName),
          managed: false,
          ephemeral: false,
          cleanupPolicy: "never",
          state: "quarantined",
          reason: network.hachiManaged
            ? "DB lease が無い managed label object は provenance mismatch として隔離します"
            : "unlabeled/unowned object は legacy quarantine として観測のみします",
          attachedNativeIds: network.attachedNativeIds.map(redactText),
          subnets: network.subnets.map(redactText),
        }));
    emit(
      deps,
      options.json === true,
      {
        leases: rows.map((row) => ({ lease: row.lease, members: row.members, cleanup: row.cleanup })),
        inventory: inventory === null
          ? null
          : {
            available: inventory.available,
            error: redactText(inventory.error),
            inspectionErrors: inventory.inspectionErrors.map(redactText),
            dockerContext: redactText(inventory.dockerContext),
            legacyCandidates,
          },
      },
      rows.length === 0
        ? ["(runtime resource lease はありません)"]
        : rows.map((row) => formatListLine(row.rawLease, row.cleanup)),
    );
  } finally {
    view.close();
  }
}

async function runShow(
  deps: CliDeps,
  leaseId: string,
  options: JsonOption & OfflineOption & { events: number },
): Promise<void> {
  const view = createRuntimeResourceReadView(deps.env.dbPath);
  try {
    const lease = view.lease(leaseId);
    if (lease === null) {
      throw new Error(`runtime resource lease が見つかりません: ${leaseId}`);
    }
    const members = view.members(lease.id);
    const requests = view.cleanupRequests(lease.id);
    const inspections = await inspectionFor(members, options.offline === true, deps);
    const events = view.events(lease.id).slice(-options.events);
    const decision = cleanupDecision(lease, members, requests);
    const visibleLease = publicLease(lease);
    emit(
      deps,
      options.json === true,
      singularResourceEnvelope(visibleLease, {
        lease: visibleLease,
        members: members.map(publicMember),
        inspections: inspections.map(publicInspection),
        cleanup: { decision, requests: requests.map(publicRequest) },
        events: events.map(publicEvent),
      }),
      [
        `${lease.id} state=${lease.state} fence=${lease.fence} managed=${lease.managed ? "1" : "0"}`,
        `cleanup ${decision.category}: ${decision.reason}`,
        ...members.map((member) => `member ${member.id} ${member.kind} id=${redactText(member.nativeId)} policy=${member.cleanupPolicy}`),
        ...inspections.map((inspection) =>
          inspection.available
            ? `inspect ${redactText(inspection.memberId)}: OK portOwner=${inspection.portOwner?.pid ?? "-"} docker=${redactText(inspection.docker?.objectId ?? "-")}`
            : `inspect ${redactText(inspection.memberId)}: unavailable ${redactText(inspection.error)}`,
        ),
      ],
    );
  } finally {
    view.close();
  }
}

function resourceKillSwitchDetail(home: string): string {
  const switches = ["supervisor.disabled", "resource-reconcile.disabled", "resource-cleanup.disabled"]
    .filter((name) => existsSync(join(home, name)));
  return switches.length === 0 ? "0件" : `${switches.length}件: ${switches.join(", ")}`;
}

function duplicatedPorts(leases: readonly RuntimeResourceLeaseRow[], view: ReturnType<typeof createRuntimeResourceReadView>): string[] {
  const owners = new Map<string, string[]>();
  for (const lease of leases) {
    for (const member of view.members(lease.id)) {
      if (member.kind !== "tcp_port" || member.hostPort === null || member.state === "released") {
        continue;
      }
      const key = `${member.hostIp}:${member.hostPort}`;
      const existing = owners.get(key) ?? [];
      existing.push(member.id);
      owners.set(key, existing);
    }
  }
  return [...owners.entries()]
    .filter(([, memberIds]) => memberIds.length > 1)
    .map(([port, memberIds]) => `${port} (${memberIds.join(",")})`);
}

function expectedPortOwner(member: RuntimeResourceMemberRow): { pid: number; startTime: string } | null {
  if (member.kind !== "tcp_port") {
    return null;
  }
  // nativeId は host-native listener の immutable identity を保持する。start-time は ISO 時刻等で ':' を含み得る。
  const match = /^pid:([1-9][0-9]*):start:(.+):port:[1-9][0-9]*$/.exec(member.nativeId);
  if (match === null) {
    return null;
  }
  const pid = Number.parseInt(match[1]!, 10);
  const startTime = match[2]!;
  return Number.isSafeInteger(pid) && startTime !== "" ? { pid, startTime } : null;
}

function resolvePortIdentity(
  member: RuntimeResourceMemberRow,
  members: readonly RuntimeResourceMemberRow[],
): PortIdentity {
  if (member.kind !== "tcp_port") {
    return { kind: "invalid" };
  }
  const hostNativeOwner = expectedPortOwner(member);
  const containerMembers = members.filter((candidate) =>
    candidate.kind === "docker_container" &&
    candidate.state === "active" &&
    candidate.leaseId === member.leaseId &&
    candidate.scopeKey === member.scopeKey &&
    candidate.objectFence === member.objectFence &&
    candidate.labelsHash === member.labelsHash &&
    candidate.provenance === member.provenance &&
    candidate.managed === member.managed &&
    candidate.ephemeral === member.ephemeral,
  );
  if (hostNativeOwner !== null) {
    return containerMembers.length === 0
      ? { kind: "host_native", owner: hostNativeOwner }
      : { kind: "invalid" };
  }
  if (
    member.nativeId !== "" ||
    member.hostIp !== "127.0.0.1" ||
    member.hostPort === null ||
    member.hostPort <= 0 ||
    member.hostPort > 65535 ||
    member.containerPort === null ||
    member.containerPort <= 0 ||
    member.containerPort > 65535 ||
    containerMembers.length !== 1
  ) {
    return { kind: "invalid" };
  }
  return { kind: "docker_published", containerMember: containerMembers[0]! };
}

function dockerPortMappingConflicts(
  members: readonly RuntimeResourceMemberRow[],
  inspections: readonly RuntimeMemberInspection[],
): DockerPortMappingConflict[] {
  const inspectionByMemberId = new Map(inspections.map((inspection) => [inspection.memberId, inspection]));
  const conflicts: DockerPortMappingConflict[] = [];
  for (const member of members) {
    if (member.state === "released") {
      continue;
    }
    const identity = resolvePortIdentity(member, members);
    if (identity.kind !== "docker_published") {
      continue;
    }
    const containerInspection = inspectionByMemberId.get(identity.containerMember.id);
    if (
      containerInspection === undefined ||
      !containerInspection.available
    ) {
      // owner container の inspect 失敗は unavailable 側で fail-closed に集計する。
      continue;
    }
    if (containerInspection.docker === null) {
      conflicts.push({
        memberId: member.id,
        containerMemberId: identity.containerMember.id,
        reason: "container_metadata_missing",
      });
      continue;
    }
    const mappings = containerInspection.docker.publishedPorts.filter(
      (mapping) => mapping.containerPort === member.containerPort,
    );
    if (mappings.length === 0) {
      conflicts.push({
        memberId: member.id,
        containerMemberId: identity.containerMember.id,
        reason: "mapping_missing",
      });
      continue;
    }
    if (mappings.length > 1) {
      conflicts.push({
        memberId: member.id,
        containerMemberId: identity.containerMember.id,
        reason: "multiple_mappings",
      });
      continue;
    }
    const mapping = mappings[0]!;
    if (mapping.hostIp !== member.hostIp || mapping.hostPort !== member.hostPort) {
      conflicts.push({
        memberId: member.id,
        containerMemberId: identity.containerMember.id,
        reason: "mapping_mismatch",
      });
    }
  }
  return conflicts;
}

function portOwnerConflicts(
  members: readonly RuntimeResourceMemberRow[],
  inspections: readonly RuntimeMemberInspection[],
): PortOwnerConflict[] {
  const inspectionByMemberId = new Map(inspections.map((inspection) => [inspection.memberId, inspection]));
  const conflicts: PortOwnerConflict[] = [];
  for (const member of members) {
    if (member.state === "released") {
      continue;
    }
    const identity = resolvePortIdentity(member, members);
    const inspection = inspectionByMemberId.get(member.id);
    if (identity.kind !== "host_native" || inspection === undefined || !inspection.available) {
      continue;
    }
    const expected = identity.owner;
    const owners = inspection.portOwners ?? (inspection.portOwner === null ? [] : [inspection.portOwner]);
    if (owners.length === 0) {
      conflicts.push({
        memberId: redactText(member.id),
        expectedPid: expected.pid,
        expectedStartTime: redactText(expected.startTime),
        actualPid: null,
        actualStartTime: "",
        reason: "listener_missing",
      });
      continue;
    }
    if (owners.length > 1) {
      const unexpected = owners.find((owner) => owner.pid !== expected.pid || owner.startTime !== expected.startTime)
        ?? owners[1]!;
      conflicts.push({
        memberId: redactText(member.id),
        expectedPid: expected.pid,
        expectedStartTime: redactText(expected.startTime),
        actualPid: unexpected.pid,
        actualStartTime: redactText(unexpected.startTime),
        reason: "multiple_listeners",
      });
      continue;
    }
    const actual = owners[0]!;
    if (actual.pid !== expected.pid) {
      conflicts.push({
        memberId: redactText(member.id),
        expectedPid: expected.pid,
        expectedStartTime: redactText(expected.startTime),
        actualPid: actual.pid,
        actualStartTime: redactText(actual.startTime),
        reason: "pid_mismatch",
      });
      continue;
    }
    if (actual.startTime !== expected.startTime) {
      conflicts.push({
        memberId: redactText(member.id),
        expectedPid: expected.pid,
        expectedStartTime: redactText(expected.startTime),
        actualPid: actual.pid,
        actualStartTime: redactText(actual.startTime),
        reason: "start_time_mismatch",
      });
    }
  }
  return conflicts;
}

async function runDoctor(deps: CliDeps, options: JsonOption & OfflineOption): Promise<void> {
  const view = createRuntimeResourceReadView(deps.env.dbPath);
  try {
    const now = Math.floor(Date.now() / 1000);
    const leases = view.leases();
    const members = leases.flatMap((lease) => view.members(lease.id));
    const liveMembers = members.filter((member) => member.state !== "released");
    const requests = leases.flatMap((lease) => view.cleanupRequests(lease.id));
    const staleLeases = leases.filter((lease) =>
      ["active", "cleanup_pending"].includes(lease.state) && lease.expiresAt !== null && lease.expiresAt <= now,
    );
    const staleClaims = requests.filter((request) =>
      request.status === "claimed" && (request.claimLeaseUntil === null || request.claimLeaseUntil <= now),
    );
    const duplicatePorts = duplicatedPorts(leases, view);
    const wildcardMembers = members.filter(
      (member) => member.kind === "tcp_port" && member.state !== "released" && ["", "0.0.0.0", "::", "*"].includes(member.hostIp),
    );
    const invalidPortIdentityMembers = members.filter(
      (member) =>
        member.kind === "tcp_port" &&
        member.state !== "released" &&
        resolvePortIdentity(member, liveMembers).kind === "invalid",
    );
    const legacy = leases.filter((lease) => !lease.managed || lease.cleanupPolicy === "never" || lease.state === "quarantined");
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [
      {
        name: "runtime resource lease freshness",
        ok: staleLeases.length === 0,
        detail: `leases=${leases.length} stale=${staleLeases.length}`,
      },
      {
        name: "runtime cleanup claims",
        ok: staleClaims.length === 0,
        detail: `requests=${requests.length} staleClaims=${staleClaims.length}`,
      },
      {
        name: "runtime port bindings",
        ok: duplicatePorts.length === 0 && wildcardMembers.length === 0 && invalidPortIdentityMembers.length === 0,
        detail: `duplicate=${duplicatePorts.length} wildcardOrUnknown=${wildcardMembers.length} invalidIdentity=${invalidPortIdentityMembers.length}`,
      },
      {
        name: "runtime legacy quarantine",
        ok: true,
        detail: `managed=0/never/quarantined=${legacy.length}（観測のみ。解放・adopt はしません）`,
      },
      {
        name: "runtime resource kill-switch",
        ok: true,
        detail: resourceKillSwitchDetail(deps.env.home),
      },
    ];

    let inspections: RuntimeMemberInspection[] = [];
    let listenerOwnershipConflicts: PortOwnerConflict[] = [];
    let publishedPortMappingConflicts: DockerPortMappingConflict[] = [];
    let inventory = null as Awaited<ReturnType<RuntimeResourceInspector["inventory"]>> | null;
    if (options.offline === true) {
      checks.push({ name: "runtime external inspection", ok: true, detail: "オフラインモードのためスキップしました" });
    } else {
      inspections = await inspectionFor(liveMembers, false, deps);
      const unavailable = inspections.filter((inspection) => !inspection.available);
      const drift = inspections.filter((inspection) => {
        const member = liveMembers.find((candidate) => candidate.id === inspection.memberId);
        return member !== undefined && inspection.docker !== null && inspection.docker.objectId !== member.nativeId;
      });
      publishedPortMappingConflicts = dockerPortMappingConflicts(liveMembers, inspections);
      listenerOwnershipConflicts = portOwnerConflicts(liveMembers, inspections);
      checks.push({
        name: "runtime external inspection",
        ok: unavailable.length === 0 && drift.length === 0 && publishedPortMappingConflicts.length === 0,
        detail: `members=${liveMembers.length} unavailable=${unavailable.length} idDrift=${drift.length} mappingDrift=${publishedPortMappingConflicts.length}`,
      });
      checks.push({
        name: "runtime listener ownership",
        ok: listenerOwnershipConflicts.length === 0,
        detail: `checked=${liveMembers.filter((member) => resolvePortIdentity(member, liveMembers).kind === "host_native").length} conflicts=${listenerOwnershipConflicts.length}`,
      });
      const inspector = deps.runtimeResourceInspector ?? new SystemRuntimeResourceInspector();
      inventory = await inspector.inventory();
      const knownNetworkIds = new Set(members.filter((member) => member.kind === "docker_network").map((member) => member.nativeId));
      const legacyNetworks = inventory.networks.filter((network) =>
        !["bridge", "host", "none"].includes(network.displayName) && !knownNetworkIds.has(network.nativeId),
      );
      const subnets = new Map<string, number>();
      for (const network of inventory.networks) {
        for (const subnet of network.subnets) {
          subnets.set(subnet, (subnets.get(subnet) ?? 0) + 1);
        }
      }
      const duplicateSubnets = [...subnets.values()].filter((count) => count > 1).length;
      checks.push({
        name: "runtime Docker inventory",
        ok: inventory.available,
        detail: inventory.available
          ? `context=${redactText(inventory.dockerContext)} networks=${inventory.networks.length} legacyCandidates=${legacyNetworks.length} duplicateSubnets=${duplicateSubnets}`
          : `read-only inspection に失敗しました: ${redactText(inventory.error)}`,
      });
    }

    const ok = checks.every((check) => check.ok);
    emit(
      deps,
      options.json === true,
      {
        checks,
        ok,
        staleLeaseIds: staleLeases.map((lease) => redactText(lease.id)),
        staleRequestIds: staleClaims.map((request) => redactText(request.id)),
        duplicatePorts: duplicatePorts.map(redactText),
        wildcardMemberIds: wildcardMembers.map((member) => redactText(member.id)),
        invalidPortIdentityMemberIds: invalidPortIdentityMembers.map((member) => redactText(member.id)),
        listenerOwnershipConflicts,
        publishedPortMappingConflicts: publishedPortMappingConflicts.map((conflict) =>
          redactJsonStrings(conflict) as DockerPortMappingConflict
        ),
        inspections: inspections.map(publicInspection),
        inventory: publicInventory(inventory),
      },
      checks.map((check) => `[${check.ok ? "OK" : "NG"}] ${check.name}: ${check.detail}`),
    );
    if (!ok) {
      deps.exit(1);
    }
  } finally {
    view.close();
  }
}

function requestForPlan(deps: CliDeps, requestId: string): RuntimeCleanupRequestRow {
  const request = mutationStore(deps).getRuntimeCleanupRequest(requestId);
  if (request === null) {
    throw new Error(`runtime cleanup request が見つかりません: ${requestId}`);
  }
  return request;
}

function runRequestRelease(
  deps: CliDeps,
  leaseId: string,
  options: JsonOption & ConfirmOption & { fence: number; reason: string },
): void {
  const view = createRuntimeResourceReadView(deps.env.dbPath);
  try {
    const lease = view.lease(leaseId);
    if (lease === null) {
      throw new Error(`runtime resource lease が見つかりません: ${leaseId}`);
    }
    if (lease.fence !== options.fence) {
      throw new Error(`lease fence が一致しません: expected=${options.fence} actual=${lease.fence}`);
    }
    const members = view.members(leaseId);
    const requests = view.cleanupRequests(leaseId);
    const requiresHuman =
      !lease.managed ||
      lease.controllerOrchestratorId === null ||
      lease.cleanupPolicy === "human" ||
      lease.cleanupPolicy === "never" ||
      members.some((member) =>
        member.kind === "docker_volume" || !member.managed || member.cleanupPolicy === "human" || member.cleanupPolicy === "never",
      );
    const decisionClass = requiresHuman ? "human" : "orchestrator";
    const plan = {
      dryRun: options.confirm !== true,
      lease: publicLease(lease),
      projectedLease: {
        state: lease.state,
        fence: lease.fence,
        terminalReason: lease.terminalReason,
      },
      transition: {
        applies: false,
        from: lease.state,
        to: lease.state,
        expectedFence: lease.fence,
        nextFence: lease.fence,
        reason: "release request は lease を遷移させず、担当オーケストレーターの fenced 判断を待ちます",
      },
      projectedRequest: {
        decisionClass,
        status: decisionClass === "human" ? "waiting_human" : "queued",
        expectedLeaseFence: lease.fence,
      },
      cleanup: cleanupDecision(lease, members, requests),
      requestedFence: options.fence,
      reason: redactText(options.reason),
      effect: "durable cleanup request のみ。Docker/port/network への変更は行いません",
    };
    if (options.confirm !== true) {
      emit(deps, options.json === true, plan, [
        "dry-run: release request は未作成です",
        `lease: ${plan.transition.from} を保持します（fence=${plan.transition.expectedFence}）`,
        `projected request: ${plan.projectedRequest.decisionClass}/${plan.projectedRequest.status} fence=${plan.projectedRequest.expectedLeaseFence}`,
      ]);
      return;
    }
    const request = mutationStore(deps).requestRuntimeResourceRelease({
      leaseId,
      expectedLeaseFence: options.fence,
      reason: options.reason,
      actor: "cli:resource-request-release",
    });
    const visibleRequest = publicRequest(request);
    emit(
      deps,
      options.json === true,
      singularResourceEnvelope(visibleRequest, { ...plan, dryRun: false, request: visibleRequest }),
      [
        `release request を作成しました: ${request.id}`,
        `decision=${request.decisionClass} status=${request.status} fence=${request.expectedLeaseFence}`,
      ],
    );
  } finally {
    view.close();
  }
}

function runCleanupClaim(
  deps: CliDeps,
  requestId: string,
  options: JsonOption & ConfirmOption & { session: string; generation: number; fence: number; lease: number },
): void {
  const request = requestForPlan(deps, requestId);
  if (request.expectedLeaseFence !== options.fence) {
    throw new Error(`cleanup request fence が一致しません: expected=${options.fence} actual=${request.expectedLeaseFence}`);
  }
  if (options.confirm !== true) {
    const visibleRequest = publicRequest(request);
    emit(
      deps,
      options.json === true,
      singularResourceEnvelope(visibleRequest, { dryRun: true, request: visibleRequest, action: "claim" }),
      ["dry-run: cleanup claim は未実行です"],
    );
    return;
  }
  const claimToken = newNonce() + newNonce();
  // DB claim 後にtoken file作成が失敗すると回復不能になるため、0600 fileを先に用意し、CAS失敗時だけ破棄する。
  const claimTokenPath = writeCleanupClaimToken(deps, request, claimToken);
  let claimed: RuntimeCleanupRequestRow;
  try {
    claimed = mutationStore(deps).claimRuntimeCleanupRequest({
      requestId,
      orchestratorId: orchestratorIdForSession(deps, options.session, options.generation),
      sessionId: options.session,
      generation: options.generation,
      claimToken,
      expectedLeaseFence: options.fence,
      leaseUntil: Math.floor(Date.now() / 1000) + options.lease,
    });
  } catch (err) {
    removeCleanupClaimToken(deps, claimTokenPath);
    throw err;
  }
  const visibleClaimed = publicRequest(claimed);
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(visibleClaimed, { dryRun: false, request: visibleClaimed, claimTokenPath }),
    [
      `cleanup request を claim しました: ${claimed.id}`,
      `claimTokenPath=${claimTokenPath}`,
    ],
  );
}

function runCleanupApprove(
  deps: CliDeps,
  requestId: string,
  options: JsonOption & ConfirmOption & { session: string; generation: number; claimFile: string; fence: number },
): void {
  const request = requestForPlan(deps, requestId);
  if (request.expectedLeaseFence !== options.fence) {
    throw new Error(`cleanup request fence が一致しません: expected=${options.fence} actual=${request.expectedLeaseFence}`);
  }
  if (options.confirm !== true) {
    const visibleRequest = publicRequest(request);
    emit(
      deps,
      options.json === true,
      singularResourceEnvelope(visibleRequest, { dryRun: true, request: visibleRequest, action: "approve" }),
      ["dry-run: cleanup approval は未実行です"],
    );
    return;
  }
  const approved = mutationStore(deps).approveRuntimeCleanupRequest({
    requestId,
    orchestratorId: orchestratorIdForSession(deps, options.session, options.generation),
    sessionId: options.session,
    generation: options.generation,
    claimToken: readCleanupClaimToken(deps, options.claimFile),
    expectedLeaseFence: options.fence,
  });
  const claimTokenRemoved = removeCleanupClaimToken(deps, options.claimFile);
  const visibleApproved = publicRequest(approved);
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(visibleApproved, { dryRun: false, request: visibleApproved, claimTokenRemoved }),
    [`cleanup request を承認しました: ${approved.id}`],
  );
}

function runCleanupReject(
  deps: CliDeps,
  requestId: string,
  options: JsonOption & ConfirmOption & { session: string; generation: number; claimFile: string; fence: number; reason: string },
): void {
  const request = requestForPlan(deps, requestId);
  if (request.expectedLeaseFence !== options.fence) {
    throw new Error(`cleanup request fence が一致しません: expected=${options.fence} actual=${request.expectedLeaseFence}`);
  }
  if (options.confirm !== true) {
    const visibleRequest = publicRequest(request);
    emit(
      deps,
      options.json === true,
      singularResourceEnvelope(visibleRequest, {
        dryRun: true,
        request: visibleRequest,
        action: "reject",
        reason: redactText(options.reason),
      }),
      ["dry-run: cleanup reject は未実行です"],
    );
    return;
  }
  const rejected = mutationStore(deps).rejectRuntimeCleanupRequest({
    requestId,
    orchestratorId: orchestratorIdForSession(deps, options.session, options.generation),
    sessionId: options.session,
    generation: options.generation,
    claimToken: readCleanupClaimToken(deps, options.claimFile),
    expectedLeaseFence: options.fence,
    reason: options.reason,
  });
  const claimTokenRemoved = removeCleanupClaimToken(deps, options.claimFile);
  const visibleRejected = publicRequest(rejected);
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(visibleRejected, { dryRun: false, request: visibleRejected, claimTokenRemoved }),
    [`cleanup request を却下しました: ${rejected.id}`],
  );
}

function runCleanupRelease(
  deps: CliDeps,
  requestId: string,
  options: JsonOption & ConfirmOption & { session: string; generation: number; claimFile: string; fence: number },
): void {
  const request = requestForPlan(deps, requestId);
  if (request.expectedLeaseFence !== options.fence) {
    throw new Error(`cleanup request fence が一致しません: expected=${options.fence} actual=${request.expectedLeaseFence}`);
  }
  if (options.confirm !== true) {
    const visibleRequest = publicRequest(request);
    emit(
      deps,
      options.json === true,
      singularResourceEnvelope(visibleRequest, { dryRun: true, request: visibleRequest, action: "release" }),
      ["dry-run: cleanup claim release は未実行です"],
    );
    return;
  }
  const released = mutationStore(deps).releaseRuntimeCleanupRequest({
    requestId,
    orchestratorId: orchestratorIdForSession(deps, options.session, options.generation),
    sessionId: options.session,
    generation: options.generation,
    claimToken: readCleanupClaimToken(deps, options.claimFile),
    expectedLeaseFence: options.fence,
  });
  const claimTokenRemoved = removeCleanupClaimToken(deps, options.claimFile);
  const visibleReleased = publicRequest(released);
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(visibleReleased, { dryRun: false, request: visibleReleased, claimTokenRemoved }),
    [`cleanup claim を解放しました: ${released.id}`],
  );
}

function runCleanupEscalate(
  deps: CliDeps,
  requestId: string,
  options: JsonOption & ConfirmOption & {
    session: string;
    generation: number;
    claimFile: string;
    fence: number;
    question: string;
  },
): void {
  const request = requestForPlan(deps, requestId);
  if (request.expectedLeaseFence !== options.fence) {
    throw new Error(`cleanup request fence が一致しません: expected=${options.fence} actual=${request.expectedLeaseFence}`);
  }
  if (options.confirm !== true) {
    const visibleRequest = publicRequest(request);
    emit(
      deps,
      options.json === true,
      singularResourceEnvelope(visibleRequest, { dryRun: true, request: visibleRequest, action: "escalate" }),
      ["dry-run: cleanup human escalation は未実行です"],
    );
    return;
  }
  const escalated = mutationStore(deps).escalateRuntimeCleanupRequest({
    requestId,
    orchestratorId: orchestratorIdForSession(deps, options.session, options.generation),
    sessionId: options.session,
    generation: options.generation,
    claimToken: readCleanupClaimToken(deps, options.claimFile),
    expectedLeaseFence: options.fence,
    question: options.question,
  });
  const claimTokenRemoved = removeCleanupClaimToken(deps, options.claimFile);
  const visibleEscalated = publicRequest(escalated);
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(visibleEscalated, {
      dryRun: false,
      request: visibleEscalated,
      claimTokenRemoved,
    }),
    [`cleanup request を人間へエスカレーションしました: ${escalated.id}`],
  );
}

function addFenceOptions(command: Command): Command {
  return command
    .requiredOption("--session <id>", "orchestrator session ID")
    .requiredOption("--generation <n>", "session generation", (value) => parsePositiveInteger(value, "generation"))
    .requiredOption("--claim-file <path>", "0600のcleanup claim token file")
    .requiredOption("--fence <n>", "expected lease fence", (value) => parsePositiveInteger(value, "fence"))
    .option("--confirm", "dry-run を確認して durable decision を記録する")
    .option("--json");
}

/** runtime resource の観測・fenced decision コマンドを登録する。 */
export function registerResourceCommand(program: Command, deps: CliDeps): void {
  const resource = program.command("resource").description("runtime resource lease の観測と fenced cleanup decision（Docker変更なし）");
  resource.command("list")
    .option("--task <id>", "owner task ID")
    .option("--state <state>", "lease state", parseLeaseState)
    .option("--inventory", "read-only Docker inventory と legacy quarantine candidate を表示する")
    .option("--offline", "host/Docker inspection をスキップする")
    .option("--json")
    .action(withErrorHandling(deps, (options) => runList(deps, options)));
  resource.command("show")
    .argument("<lease-id>")
    .option("--events <n>", "表示する event 数", (value) => parsePositiveInteger(value, "events"), 20)
    .option("--offline", "host/Docker inspection をスキップする")
    .option("--json")
    .action(withErrorHandling(deps, (id, options) => runShow(deps, id, options)));
  resource.command("doctor")
    .option("--offline", "host/Docker inspection をスキップする")
    .option("--json")
    .action(withErrorHandling(deps, (options) => runDoctor(deps, options)));
  resource.command("request-release")
    .argument("<lease-id>")
    .requiredOption("--fence <n>", "expected lease fence", (value) => parsePositiveInteger(value, "fence"))
    .requiredOption("--reason <text>", "release request reason")
    .option("--confirm", "dry-run を確認して durable release request を作成する")
    .option("--json")
    .action(withErrorHandling(deps, (id, options) => runRequestRelease(deps, id, options)));

  const cleanup = resource.command("cleanup").description("担当オーケストレーターの fenced cleanup decision");
  cleanup.command("claim")
    .argument("<request-id>")
    .requiredOption("--session <id>", "orchestrator session ID")
    .requiredOption("--generation <n>", "session generation", (value) => parsePositiveInteger(value, "generation"))
    .requiredOption("--fence <n>", "expected lease fence", (value) => parsePositiveInteger(value, "fence"))
    .option("--lease <sec>", "claim lease seconds", (value) => parsePositiveInteger(value, "lease"), DEFAULT_CLAIM_LEASE_SEC)
    .option("--confirm", "dry-run を確認して durable claim を記録する")
    .option("--json")
    .action(withErrorHandling(deps, (id, options) => runCleanupClaim(deps, id, options)));
  addFenceOptions(cleanup.command("approve").argument("<request-id>"))
    .action(withErrorHandling(deps, (id, options) => runCleanupApprove(deps, id, options)));
  addFenceOptions(cleanup.command("reject").argument("<request-id>").requiredOption("--reason <text>", "reject reason"))
    .action(withErrorHandling(deps, (id, options) => runCleanupReject(deps, id, options)));
  addFenceOptions(cleanup.command("release").argument("<request-id>"))
    .action(withErrorHandling(deps, (id, options) => runCleanupRelease(deps, id, options)));
  addFenceOptions(cleanup.command("escalate").argument("<request-id>").requiredOption("--question <text>", "human question"))
    .action(withErrorHandling(deps, (id, options) => runCleanupEscalate(deps, id, options)));
}
