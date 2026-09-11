import Database from "better-sqlite3";
import type {
  RuntimeCleanupRequestRow,
  RuntimeResourceEventRow,
  RuntimeResourceLeaseRow,
  RuntimeResourceMemberRow,
  RuntimeResourceRequirementRow,
} from "./runtime-resources.js";

interface RawRequirement {
  id: string;
  task_id: string;
  name: string;
  bundle_kind: RuntimeResourceRequirementRow["bundleKind"];
  spec: string;
  status: RuntimeResourceRequirementRow["status"];
  lease_id: string;
  idempotency_key: string;
  created_at: number;
  updated_at: number;
}

interface RawLease {
  id: string;
  bundle_kind: RuntimeResourceLeaseRow["bundleKind"];
  state: RuntimeResourceLeaseRow["state"];
  cleanup_policy: RuntimeResourceLeaseRow["cleanupPolicy"];
  managed: number;
  ephemeral: number;
  owner_task_id: string | null;
  owner_run_id: number | null;
  controller_orchestrator_id: string | null;
  board: string;
  project: string;
  repo_common_dir: string;
  canonical_worktree: string;
  fence: number;
  heartbeat_at: number | null;
  expires_at: number | null;
  terminal_reason: RuntimeResourceLeaseRow["terminalReason"];
  provenance_version: number;
  rollout_generation: number;
  created_at: number;
  updated_at: number;
  released_at: number | null;
}

interface RawMember {
  id: string;
  lease_id: string;
  kind: RuntimeResourceMemberRow["kind"];
  state: RuntimeResourceMemberRow["state"];
  cleanup_policy: RuntimeResourceMemberRow["cleanupPolicy"];
  managed: number;
  ephemeral: number;
  object_fence: number;
  scope_key: string;
  native_id: string;
  display_name: string;
  host_ip: string;
  host_port: number | null;
  container_port: number | null;
  compose_project: string;
  labels_hash: string;
  provenance: string;
  provenance_verified_at: number | null;
  last_observed_at: number;
  released_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RawCleanupRequest {
  id: string;
  lease_id: string;
  decision_class: RuntimeCleanupRequestRow["decisionClass"];
  reason: string;
  status: RuntimeCleanupRequestRow["status"];
  expected_lease_fence: number;
  expected_members_hash: string;
  claimant_session_id: string;
  claimant_generation: number | null;
  claim_token_hash: string;
  claim_lease_until: number | null;
  approved_by: string;
  approval_generation: number | null;
  executor_id: string;
  executor_generation: number;
  executor_lease_until: number | null;
  execution_nonce: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string;
  escalation_generation: number;
  human_answer: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

interface RawResourceEvent {
  id: number;
  lease_id: string;
  request_id: string | null;
  event_type: string;
  actor: string;
  payload: string;
  idempotency_key: string;
  created_at: number;
}

function requirement(row: RawRequirement): RuntimeResourceRequirementRow {
  return {
    id: row.id,
    taskId: row.task_id,
    name: row.name,
    bundleKind: row.bundle_kind,
    spec: row.spec,
    status: row.status,
    leaseId: row.lease_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function lease(row: RawLease): RuntimeResourceLeaseRow {
  return {
    id: row.id,
    bundleKind: row.bundle_kind,
    state: row.state,
    cleanupPolicy: row.cleanup_policy,
    managed: row.managed === 1,
    ephemeral: row.ephemeral === 1,
    ownerTaskId: row.owner_task_id,
    ownerRunId: row.owner_run_id,
    controllerOrchestratorId: row.controller_orchestrator_id,
    board: row.board,
    project: row.project,
    repoCommonDir: row.repo_common_dir,
    canonicalWorktree: row.canonical_worktree,
    fence: row.fence,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    terminalReason: row.terminal_reason,
    provenanceVersion: row.provenance_version,
    rolloutGeneration: row.rollout_generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    releasedAt: row.released_at,
  };
}

function member(row: RawMember): RuntimeResourceMemberRow {
  return {
    id: row.id,
    leaseId: row.lease_id,
    kind: row.kind,
    state: row.state,
    cleanupPolicy: row.cleanup_policy,
    managed: row.managed === 1,
    ephemeral: row.ephemeral === 1,
    objectFence: row.object_fence,
    scopeKey: row.scope_key,
    nativeId: row.native_id,
    displayName: row.display_name,
    hostIp: row.host_ip,
    hostPort: row.host_port,
    containerPort: row.container_port,
    composeProject: row.compose_project,
    labelsHash: row.labels_hash,
    provenance: row.provenance,
    provenanceVerifiedAt: row.provenance_verified_at,
    lastObservedAt: row.last_observed_at,
    releasedAt: row.released_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cleanupRequest(row: RawCleanupRequest): RuntimeCleanupRequestRow {
  return {
    id: row.id,
    leaseId: row.lease_id,
    decisionClass: row.decision_class,
    reason: row.reason,
    status: row.status,
    expectedLeaseFence: row.expected_lease_fence,
    expectedMembersHash: row.expected_members_hash,
    claimantSessionId: row.claimant_session_id,
    claimantGeneration: row.claimant_generation,
    claimTokenHash: row.claim_token_hash,
    claimLeaseUntil: row.claim_lease_until,
    approvedBy: row.approved_by,
    approvalGeneration: row.approval_generation,
    executorId: row.executor_id,
    executorGeneration: row.executor_generation,
    executorLeaseUntil: row.executor_lease_until,
    executionNonce: row.execution_nonce,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    escalationGeneration: row.escalation_generation,
    humanAnswer: row.human_answer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function event(row: RawResourceEvent): RuntimeResourceEventRow {
  return {
    id: row.id,
    leaseId: row.lease_id,
    requestId: row.request_id,
    eventType: row.event_type,
    actor: row.actor,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

export interface RuntimeResourceReadView {
  /** owner/state を任意に絞った lease 一覧。legacy observation も owner 無しで返す。 */
  leases(options?: { taskId?: string; state?: RuntimeResourceLeaseRow["state"] }): RuntimeResourceLeaseRow[];
  requirement(id: string): RuntimeResourceRequirementRow | null;
  requirementsForTask(taskId: string): RuntimeResourceRequirementRow[];
  lease(id: string): RuntimeResourceLeaseRow | null;
  leasesForTask(taskId: string): RuntimeResourceLeaseRow[];
  members(leaseId: string): RuntimeResourceMemberRow[];
  cleanupRequests(leaseId: string): RuntimeCleanupRequestRow[];
  events(leaseId: string): RuntimeResourceEventRow[];
  close(): void;
}

class SqliteRuntimeResourceReadView implements RuntimeResourceReadView {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.db.pragma("busy_timeout = 5000");
  }

  leases(options: { taskId?: string; state?: RuntimeResourceLeaseRow["state"] } = {}): RuntimeResourceLeaseRow[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.taskId !== undefined) {
      clauses.push("owner_task_id = ?");
      params.push(options.taskId);
    }
    if (options.state !== undefined) {
      clauses.push("state = ?");
      params.push(options.state);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    return (
      this.db
        .prepare(`SELECT * FROM runtime_resource_leases ${where} ORDER BY created_at, id`)
        .all(...params) as RawLease[]
    ).map(lease);
  }

  requirement(id: string): RuntimeResourceRequirementRow | null {
    const row = this.db.prepare(`SELECT * FROM runtime_resource_requirements WHERE id = ?`).get(id) as
      | RawRequirement
      | undefined;
    return row === undefined ? null : requirement(row);
  }

  requirementsForTask(taskId: string): RuntimeResourceRequirementRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM runtime_resource_requirements WHERE task_id = ? ORDER BY created_at, id`)
        .all(taskId) as RawRequirement[]
    ).map(requirement);
  }

  lease(id: string): RuntimeResourceLeaseRow | null {
    const row = this.db.prepare(`SELECT * FROM runtime_resource_leases WHERE id = ?`).get(id) as RawLease | undefined;
    return row === undefined ? null : lease(row);
  }

  leasesForTask(taskId: string): RuntimeResourceLeaseRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM runtime_resource_leases WHERE owner_task_id = ? ORDER BY created_at, id`)
        .all(taskId) as RawLease[]
    ).map(lease);
  }

  members(leaseId: string): RuntimeResourceMemberRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM runtime_resource_members WHERE lease_id = ? ORDER BY created_at, id`)
        .all(leaseId) as RawMember[]
    ).map(member);
  }

  cleanupRequests(leaseId: string): RuntimeCleanupRequestRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM runtime_cleanup_requests WHERE lease_id = ? ORDER BY created_at, id`)
        .all(leaseId) as RawCleanupRequest[]
    ).map(cleanupRequest);
  }

  events(leaseId: string): RuntimeResourceEventRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM runtime_resource_events WHERE lease_id = ? ORDER BY created_at, id`)
        .all(leaseId) as RawResourceEvent[]
    ).map(event);
  }

  close(): void {
    this.db.close();
  }
}

export function createRuntimeResourceReadView(dbPath: string): RuntimeResourceReadView {
  return new SqliteRuntimeResourceReadView(dbPath);
}
