import { realpathSync } from "node:fs";
import {
  assertRuntimeProjectHostAdapterSnapshot,
  assertRuntimeProjectOwnershipSnapshot,
  createRuntimeResourceReadView,
  parseRuntimeProjectProfileSnapshots,
  runtimeProjectProfileRequirementIdentityMatches,
  RUNTIME_MEMBER_KINDS,
  type KanbanStore,
  type RuntimeCleanupDecisionClass,
  type RuntimeMemberKind,
  type RuntimeProjectHostAdapterSnapshot,
  type RuntimeProjectOwnershipSnapshot,
  type RuntimeResourceLeaseRow,
  type RuntimeResourceRequirementRow,
  type RuntimeResourcesConfig,
  type SqliteKanbanStore,
} from "@hachi/core";

export type RuntimeResourceStore = KanbanStore & Pick<
  SqliteKanbanStore,
  | "getRuntimeResourceRequirement"
  | "getRuntimeResourceLease"
  | "listRuntimeResourceMembers"
  | "transitionRuntimeResourceLease"
  | "createOrGetRuntimeCleanupRequest"
  | "transitionRuntimeResourceLeaseWithCleanupRequest"
  | "bindRuntimeResourceLeaseRun"
  | "rebindRuntimeResourceLeaseRun"
  | "getRun"
  | "createOrGetRuntimeResourceRequirement"
  | "addRuntimeResourceMember"
  | "reserveRuntimeResourceLease"
  | "claimRuntimeResourceLease"
  | "renewRuntimeResourceLease"
>;

export interface RuntimeResourceBinding {
  requirementId: string;
  leaseId: string;
  fence: number;
  canonicalWorktree: string;
  ownerRunId: number | null;
  controllerOrchestratorId: string;
  repoCommonDir: string;
}

export type RuntimeResourceGateResult =
  | { status: "unconfigured" }
  | { status: "waiting"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "ready"; bindings: RuntimeResourceBinding[] };

interface RequirementSpec {
  version: 1;
  requiredMembers: RuntimeMemberKind[];
  ownershipSnapshot?: RuntimeProjectOwnershipSnapshot;
  hostAdapterSnapshot?: RuntimeProjectHostAdapterSnapshot;
}

function parseRequirementSpec(
  requirement: RuntimeResourceRequirementRow,
  lookup?: { requirement(id: string): RuntimeResourceRequirementRow | null },
): RequirementSpec | null {
  try {
    const parsed = JSON.parse(requirement.spec) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const members = record["requiredMembers"];
    if (
      record["version"] !== 1 ||
      !Array.isArray(members) ||
      !members.every(
        (member): member is RuntimeMemberKind =>
          typeof member === "string" && (RUNTIME_MEMBER_KINDS as readonly string[]).includes(member),
      )
    ) {
      return null;
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
      return null;
    }
    return {
      version: 1,
      requiredMembers: members,
      ...(profileSnapshots === undefined ? {} : profileSnapshots),
    };
  } catch {
    return null;
  }
}

function leaseMatchesRuntimeProjectSnapshot(
  lease: RuntimeResourceLeaseRow,
  snapshot: RuntimeProjectOwnershipSnapshot,
): boolean {
  return (
    lease.controllerOrchestratorId === snapshot.orchestratorId &&
    lease.project === snapshot.project &&
    lease.repoCommonDir === snapshot.repoCommonDir &&
    lease.canonicalWorktree === snapshot.canonicalWorktree
  );
}

function activeLeaseMatches(
  lease: RuntimeResourceLeaseRow | null,
  taskId: string,
  canonicalWorktree: string,
  now: number,
  allowBoundRun = false,
): boolean {
  return (
    lease !== null &&
    lease.state === "active" &&
    lease.ownerTaskId === taskId &&
    (allowBoundRun || lease.ownerRunId === null) &&
    lease.controllerOrchestratorId !== null &&
    lease.canonicalWorktree === canonicalWorktree &&
    (lease.expiresAt === null || lease.expiresAt > now)
  );
}

function cleanupRetiredRequirement(
  requirement: RuntimeResourceRequirementRow,
  requirements: readonly RuntimeResourceRequirementRow[],
  lease: RuntimeResourceLeaseRow | null,
): boolean {
  // side effect 前の provision 失敗は failed lease を残したうえで durable な後継 requirement を作る。
  // 後継が存在する場合だけ旧 requirement を dispatch gate から退役させ、資源回復後の再試行を許可する。
  // 後継の無い failed は従来どおり fail-closed で block する。
  if (lease === null || !["cleanup_pending", "released", "quarantined", "failed"].includes(lease.state)) {
    return false;
  }
  return requirements.some((candidate) => candidate.idempotencyKey === `${requirement.id}:retry:${lease.id}`);
}

/** required requirement が全て active/ready かを claim 前に read-only 検査する。 */
function evaluateRuntimeResourceGate(
  dbPath: string,
  taskId: string,
  cwd: string | null,
  now: number,
  allowBoundRun: boolean,
  runtimeResources: RuntimeResourcesConfig | undefined,
): RuntimeResourceGateResult {
  const view = createRuntimeResourceReadView(dbPath);
  try {
    const requirements = view.requirementsForTask(taskId);
    if (requirements.length === 0) {
      return { status: "unconfigured" };
    }
    if (cwd === null) {
      return { status: "failed", reason: "needs-manual: runtime resource の worktree を検証できません（cwd 未指定）" };
    }

    let canonicalWorktree: string;
    try {
      canonicalWorktree = realpathSync.native(cwd);
    } catch {
      return { status: "failed", reason: "needs-manual: runtime resource の canonical worktree を検証できません" };
    }

    const bindings: RuntimeResourceBinding[] = [];
    for (const requirement of requirements) {
      const requirementLease = requirement.leaseId === "" ? null : view.lease(requirement.leaseId);
      // cleanup 対象の旧 lease は、durable な後継 requirement が存在する場合だけ dispatch gate から退役させる。
      // 後継が無い cleanup_pending は従来どおり fail-closed で待機する。
      if (cleanupRetiredRequirement(requirement, requirements, requirementLease)) {
        continue;
      }
      if (requirement.status === "failed" || requirement.status === "cancelled") {
        return {
          status: "failed",
          reason: `needs-manual: runtime resource requirement が ${requirement.status} です (${requirement.id})`,
        };
      }
      if (requirement.status !== "ready" || requirement.leaseId === "") {
        return {
          status: "waiting",
          reason: `runtime resource requirement が ready ではありません (${requirement.id}:${requirement.status})`,
        };
      }

      const lease = requirementLease;
      if (lease === null || !activeLeaseMatches(lease, taskId, canonicalWorktree, now, allowBoundRun)) {
        const terminal = lease !== null && ["failed", "quarantined", "cancelled"].includes(lease.state);
        return {
          status: terminal ? "failed" : "waiting",
          reason: terminal
            ? `needs-manual: runtime resource lease が利用不能です (${requirement.leaseId}:${lease.state})`
            : `runtime resource lease が active/ready 条件を満たしません (${requirement.leaseId})`,
        };
      }

      const spec = parseRequirementSpec(requirement, view);
      if (spec === null) {
        return { status: "failed", reason: `needs-manual: runtime resource requirement spec が不正です (${requirement.id})` };
      }
      if (
        spec.ownershipSnapshot !== undefined &&
        (
          canonicalWorktree !== spec.ownershipSnapshot.canonicalWorktree ||
          !leaseMatchesRuntimeProjectSnapshot(lease, spec.ownershipSnapshot)
        )
      ) {
        return {
          status: "failed",
          reason: `needs-manual: runtime profile ownership snapshot が一致しません (${requirement.id})`,
        };
      }
      if (spec.ownershipSnapshot !== undefined && spec.hostAdapterSnapshot !== undefined) {
        if (runtimeResources === undefined) {
          return {
            status: "failed",
            reason: `needs-manual: current runtime profile config を解決できません (${requirement.id})`,
          };
        }
        try {
          assertRuntimeProjectHostAdapterSnapshot({
            ownershipSnapshot: spec.ownershipSnapshot,
            hostAdapterSnapshot: spec.hostAdapterSnapshot,
            requirementBundleKind: "worktree_postgres",
            runtimeResources,
          });
        } catch {
          return {
            status: "failed",
            reason: `needs-manual: runtime profile snapshot/config drift を検出しました (${requirement.id})`,
          };
        }
      }
      const activeKinds = new Set(
        view.members(lease.id).filter((member) => member.state === "active").map((member) => member.kind),
      );
      if (!spec.requiredMembers.every((kind) => activeKinds.has(kind))) {
        return {
          status: "waiting",
          reason: `runtime resource の required member が active ではありません (${requirement.id})`,
        };
      }
      bindings.push({
        requirementId: requirement.id,
        leaseId: lease.id,
        fence: lease.fence,
        canonicalWorktree,
        ownerRunId: lease.ownerRunId,
        controllerOrchestratorId: lease.controllerOrchestratorId!,
        repoCommonDir: lease.repoCommonDir,
      });
    }
    return { status: "ready", bindings };
  } finally {
    view.close();
  }
}

export function evaluateRuntimeResourceDispatchGate(
  dbPath: string,
  taskId: string,
  cwd: string | null,
  now: number,
  runtimeResources?: RuntimeResourcesConfig,
): RuntimeResourceGateResult {
  return evaluateRuntimeResourceGate(dbPath, taskId, cwd, now, false, runtimeResources);
}

/** rework は終了済み旧 worker run に bind された lease も、後段の原子的 rebind 候補として検査する。 */
export function evaluateRuntimeResourceReworkGate(
  dbPath: string,
  taskId: string,
  cwd: string | null,
  now: number,
  runtimeResources?: RuntimeResourcesConfig,
): RuntimeResourceGateResult {
  return evaluateRuntimeResourceGate(dbPath, taskId, cwd, now, true, runtimeResources);
}

/** claim 後・launch 直前と launch Tx 内で同じ snapshot を CAS 前提として再検証する。 */
export function validateRuntimeResourceBindings(
  store: RuntimeResourceStore,
  taskId: string,
  bindings: readonly RuntimeResourceBinding[],
  now: number,
  allowBoundRun = false,
  runtimeResources?: RuntimeResourcesConfig,
): boolean {
  if (bindings.length === 0) {
    return true;
  }
  const task = store.getTask(taskId);
  const cwd = task === null ? null : /^cwd:\s*(\S+)\s*$/m.exec(task.body)?.[1] ?? null;
  const primaryBindings = store.listTaskOrchestratorBindings(taskId).filter((binding) => binding.role === "primary");
  const controller = primaryBindings.length === 1
    ? store.getOrchestrator(primaryBindings[0]!.orchestratorId)
    : null;
  let currentWorktree: string;
  let currentRepoCommonDir: string;
  try {
    if (cwd === null || controller === null) {
      return false;
    }
    currentWorktree = realpathSync.native(cwd);
    currentRepoCommonDir = realpathSync.native(controller.repoCommonDir);
  } catch {
    return false;
  }
  return bindings.every((binding) => {
    const requirement = store.getRuntimeResourceRequirement(binding.requirementId);
    const lease = store.getRuntimeResourceLease(binding.leaseId);
    const spec = requirement === null ? null : parseRequirementSpec(requirement, {
      requirement(id: string): RuntimeResourceRequirementRow | null {
        return store.getRuntimeResourceRequirement(id);
      },
    });
    if (
      requirement === null ||
      spec === null ||
      requirement.taskId !== taskId ||
      requirement.status !== "ready" ||
      requirement.leaseId !== binding.leaseId ||
      lease === null ||
      lease.controllerOrchestratorId !== controller.id ||
      lease.controllerOrchestratorId !== binding.controllerOrchestratorId ||
      lease.repoCommonDir !== currentRepoCommonDir ||
      lease.repoCommonDir !== binding.repoCommonDir ||
      lease.canonicalWorktree !== currentWorktree ||
      !activeLeaseMatches(lease, taskId, binding.canonicalWorktree, now, allowBoundRun) ||
      lease.ownerRunId !== binding.ownerRunId ||
      lease.fence !== binding.fence
    ) {
      return false;
    }
    if (spec.ownershipSnapshot !== undefined) {
      if (!leaseMatchesRuntimeProjectSnapshot(lease, spec.ownershipSnapshot)) {
        return false;
      }
      try {
        assertRuntimeProjectOwnershipSnapshot({
          snapshot: spec.ownershipSnapshot,
          orchestrator: controller,
          taskBody: task!.body,
        });
        if (spec.hostAdapterSnapshot === undefined || runtimeResources === undefined) {
          return false;
        }
        assertRuntimeProjectHostAdapterSnapshot({
          ownershipSnapshot: spec.ownershipSnapshot,
          hostAdapterSnapshot: spec.hostAdapterSnapshot,
          requirementBundleKind: "worktree_postgres",
          runtimeResources,
        });
      } catch {
        return false;
      }
    }
    if (allowBoundRun) {
      if (binding.ownerRunId === null) {
        return false;
      }
      const ownerRun = store.getRun(binding.ownerRunId);
      if (ownerRun === null || ownerRun.taskId !== taskId || ownerRun.status === "running") {
        return false;
      }
    }
    const activeKinds = new Set(
      store.listRuntimeResourceMembers(lease.id).filter((member) => member.state === "active").map((member) => member.kind),
    );
    return spec.requiredMembers.every((kind) => activeKinds.has(kind));
  });
}

/** ownership 競合時の stale lease を、取得済み exact snapshot だけで cleanup_pending へ送る。 */
export function requestExactRuntimeResourceCleanup(
  store: RuntimeResourceStore,
  binding: RuntimeResourceBinding,
  reason: string,
): void {
  const lease = store.getRuntimeResourceLease(binding.leaseId);
  const requirement = store.getRuntimeResourceRequirement(binding.requirementId);
  if (
    lease === null ||
    requirement === null ||
    requirement.taskId !== lease.ownerTaskId ||
    requirement.leaseId !== lease.id ||
    lease.state !== "active" ||
    lease.fence !== binding.fence ||
    lease.ownerRunId !== binding.ownerRunId ||
    lease.controllerOrchestratorId !== binding.controllerOrchestratorId ||
    lease.repoCommonDir !== binding.repoCommonDir ||
    lease.canonicalWorktree !== binding.canonicalWorktree ||
    store.listRuntimeResourceMembers(lease.id).length === 0
  ) {
    throw new Error(`runtime resource lease の exact cleanup identity が一致しません (${binding.leaseId})`);
  }
  store.transitionRuntimeResourceLeaseWithCleanupRequest({
    leaseId: lease.id,
    expectedFence: binding.fence,
    from: "active",
    terminalReason: "explicit_release",
    decisionClass: lease.cleanupPolicy === "auto" ? "auto" : "orchestrator",
    reason,
    actor: "supervisor",
  });
}

/** launch failure/孤児化時に、作成済み member を durable cleanup request へ引き渡す。 */
export function requestRuntimeResourceCleanup(
  store: RuntimeResourceStore,
  bindings: readonly RuntimeResourceBinding[],
  reason: string,
  createReplacement = false,
  decisionClassOverride?: RuntimeCleanupDecisionClass,
): number {
  let requested = 0;
  for (const binding of bindings) {
    const lease = store.getRuntimeResourceLease(binding.leaseId);
    const requirement = store.getRuntimeResourceRequirement(binding.requirementId);
    if (
      lease === null ||
      requirement === null ||
      requirement.leaseId !== lease.id ||
      requirement.taskId !== lease.ownerTaskId ||
      lease.state !== "active" ||
      lease.ownerRunId !== null ||
      lease.canonicalWorktree !== binding.canonicalWorktree ||
      lease.fence < binding.fence ||
      store.listRuntimeResourceMembers(lease.id).length === 0
    ) {
      continue;
    }
    try {
      store.transitionRuntimeResourceLeaseWithCleanupRequest({
        leaseId: lease.id,
        expectedFence: lease.fence,
        from: "active",
        terminalReason: "explicit_release",
        decisionClass:
          decisionClassOverride ?? (lease.cleanupPolicy === "auto" ? "auto" : "orchestrator"),
        reason,
        actor: "supervisor",
      });
      if (createReplacement) {
        const spec = parseRequirementSpec(requirement, {
          requirement(id: string): RuntimeResourceRequirementRow | null {
            return store.getRuntimeResourceRequirement(id);
          },
        });
        if (spec === null) {
          throw new Error("cleanup 対象 lease の requirement spec が不正です");
        }
        createRuntimeResourceReplacementRequirement(store, requirement, lease.id);
      }
      requested += 1;
    } catch {
      // 別 supervisor が fence/state を進めた場合は、その所有権を尊重して fail-closed に何もしない。
    }
  }
  return requested;
}

/** cleanup と provision retry を分離するため、旧 lease を参照しない durable な後継要求を作る。 */
export function createRuntimeResourceReplacementRequirement(
  store: RuntimeResourceStore,
  requirement: RuntimeResourceRequirementRow,
  retiredLeaseId: string,
): RuntimeResourceRequirementRow {
  const spec = parseRequirementSpec(requirement, {
    requirement(id: string): RuntimeResourceRequirementRow | null {
      return store.getRuntimeResourceRequirement(id);
    },
  });
  if (spec === null) {
    throw new Error("replacement 対象の runtime resource requirement spec が不正です");
  }
  return store.createOrGetRuntimeResourceRequirement({
    taskId: requirement.taskId,
    name: `retry-${retiredLeaseId}`,
    bundleKind: requirement.bundleKind,
    spec,
    idempotencyKey: `${requirement.id}:retry:${retiredLeaseId}`,
  });
}
