// runtime resource cleanup request の durable delivery routing（contract §55・§56）。
// watch/binding の関心範囲から宛先を選び、provider receipt を確認した場合だけ delivered にする。

import type {
  OrchestratorSessionRow,
  OrchestratorWatchRole,
  OrchestratorWatchRow,
  RuntimeCleanupDecisionClass,
  RuntimeCleanupRequestStatus,
  RuntimeResourceLeaseRow,
  TaskOrchestratorBindingRow,
} from "@hachi/core";
import { ORCHESTRATOR_SESSION_STALE_SECONDS } from "@hachi/core";

export interface PendingCleanupDelivery {
  deliveryId: number;
  requestId: string;
  orchestratorId: string;
  watchId: string | null;
  leaseId: string;
  decisionClass: RuntimeCleanupDecisionClass;
  reason: string;
  requestStatus: RuntimeCleanupRequestStatus;
  expectedLeaseFence: number;
  ownerTaskId: string | null;
  humanAnswer: string;
}

export interface CleanupDeliveryStore {
  listOrchestratorSessions(orchestratorId?: string): OrchestratorSessionRow[];
  listOrchestratorWatches(orchestratorId?: string): OrchestratorWatchRow[];
  listTaskOrchestratorBindings(taskId: string): TaskOrchestratorBindingRow[];
  listPendingRuntimeCleanupDeliveries(limit?: number): PendingCleanupDelivery[];
  markRuntimeCleanupDeliveryDelivered(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    receipt: string;
    now?: number;
  }): void;
  routeRuntimeCleanupDelivery(input: {
    requestId: string;
    expectedControllerId: string;
    targetOrchestratorId: string;
    targetWatchId?: string;
    expectedLeaseFence: number;
    now?: number;
  }): void;
  markRuntimeCleanupOrchestratorUnavailable(requestId: string, reason: string, actor: string, now?: number): void;
  getRuntimeResourceLease(id: string): RuntimeResourceLeaseRow | null;
}

export const STALE_SESSION_SECONDS = ORCHESTRATOR_SESSION_STALE_SECONDS;
const DELIVERY_BATCH_LIMIT = 50;

export type CleanupDeliveryMode = "poll" | "inject" | "app-wakeup";

export interface CleanupDeliveryAttempt {
  mode: CleanupDeliveryMode;
  delivery: PendingCleanupDelivery;
  session: OrchestratorSessionRow;
  message: string;
}

/** null は receipt 未確認を表し、delivery は pending のまま再試行する。 */
export type CleanupDeliveryAdapter = (attempt: CleanupDeliveryAttempt) => Promise<string | null>;

export interface CleanupDeliveryResult {
  delivered: number;
  routed: number;
  pending: number;
  escalated: number;
}

interface RankedTarget {
  delivery: PendingCleanupDelivery;
  session: OrchestratorSessionRow;
  scopeRank: number;
  roleRank: number;
  priority: number;
}

function compareTargetsWithinIdentity(left: RankedTarget, right: RankedTarget): number {
  return left.scopeRank - right.scopeRank ||
    left.roleRank - right.roleRank ||
    right.priority - left.priority ||
    right.session.generation - left.session.generation ||
    left.delivery.deliveryId - right.delivery.deliveryId;
}

function selectTarget(targets: readonly RankedTarget[]): RankedTarget | undefined {
  const byIdentity = new Map<string, RankedTarget>();
  for (const target of targets) {
    const current = byIdentity.get(target.delivery.orchestratorId);
    if (current === undefined || compareTargetsWithinIdentity(target, current) < 0) {
      byIdentity.set(target.delivery.orchestratorId, target);
    }
  }
  const collapsed = [...byIdentity.values()];
  const selectedScopeRank = collapsed.reduce(
    (current, target) => Math.min(current, target.scopeRank),
    Number.MAX_SAFE_INTEGER,
  );
  return collapsed
    .filter((target) => target.scopeRank === selectedScopeRank)
    .sort((left, right) =>
      left.roleRank - right.roleRank ||
      right.priority - left.priority ||
      right.session.generation - left.session.generation ||
      left.delivery.orchestratorId.localeCompare(right.delivery.orchestratorId) ||
      left.delivery.deliveryId - right.delivery.deliveryId,
    )[0];
}

function liveSessionsByIdentity(
  sessions: readonly OrchestratorSessionRow[],
  now: number,
): Map<string, OrchestratorSessionRow> {
  const result = new Map<string, OrchestratorSessionRow>();
  for (const session of sessions) {
    const isActive = session.status === "active" && session.heartbeatAt >= now - STALE_SESSION_SECONDS;
    const isPlannedHandoff =
      session.status === "handoff_pending" &&
      session.handoffExpiresAt !== null &&
      session.handoffExpiresAt >= now;
    if (!isActive && !isPlannedHandoff) {
      continue;
    }
    const current = result.get(session.orchestratorId);
    if (current === undefined || current.generation < session.generation) {
      result.set(session.orchestratorId, session);
    }
  }
  return result;
}

function roleRank(role: OrchestratorWatchRole): number {
  return role === "primary" ? 0 : role === "collaborator" ? 1 : 9;
}

function rankDelivery(
  store: CleanupDeliveryStore,
  delivery: PendingCleanupDelivery,
  session: OrchestratorSessionRow,
  lease: RuntimeResourceLeaseRow,
  watches: ReadonlyMap<string, OrchestratorWatchRow>,
): RankedTarget | null {
  if (delivery.ownerTaskId !== null) {
    const binding = store
      .listTaskOrchestratorBindings(delivery.ownerTaskId)
      .find((candidate) => candidate.orchestratorId === delivery.orchestratorId && candidate.releasedAt === null);
    if (binding !== undefined && binding.role !== "observer") {
      return { delivery, session, scopeRank: 0, roleRank: roleRank(binding.role), priority: Number.MAX_SAFE_INTEGER };
    }
  }
  if (delivery.watchId !== null) {
    const watch = watches.get(delivery.watchId);
    if (watch === undefined || !watch.active || watch.role === "observer") {
      return null;
    }
    const scopeRanks: Record<OrchestratorWatchRow["scope"], number> = {
      task: 0,
      subtree: 1,
      worktree: 2,
      project: 3,
    };
    return {
      delivery,
      session,
      scopeRank: scopeRanks[watch.scope],
      roleRank: roleRank(watch.role),
      priority: watch.priority,
    };
  }
  // watch/binding の無い controller delivery は最後の fallback owner。
  if (lease.controllerOrchestratorId === delivery.orchestratorId) {
    return { delivery, session, scopeRank: 4, roleRank: 2, priority: 0 };
  }
  return null;
}

function selectMode(session: OrchestratorSessionRow): CleanupDeliveryMode {
  if (session.provider === "") {
    return "poll";
  }
  return session.providerSessionId === "" ? "app-wakeup" : "inject";
}

function buildDeliveryMessage(delivery: PendingCleanupDelivery): string {
  return [
    "Runtime resource cleanup request が inbox に届きました。",
    `requestId: ${delivery.requestId}`,
    `leaseId: ${delivery.leaseId}`,
    `expectedLeaseFence: ${delivery.expectedLeaseFence}`,
    `reason: ${delivery.reason}`,
    ...(delivery.humanAnswer === "" ? [] : [`humanAnswer: ${delivery.humanAnswer}`]),
    "claim 後に fenced approve/reject/escalate/release を実行してください。",
  ].join("\n");
}

export async function processCleanupDeliveries(
  store: CleanupDeliveryStore,
  apply: boolean,
  now: number,
  adapter: CleanupDeliveryAdapter,
): Promise<{ result: CleanupDeliveryResult; notes: string[] }> {
  const notes: string[] = [];
  const result: CleanupDeliveryResult = { delivered: 0, routed: 0, pending: 0, escalated: 0 };
  const pending = store.listPendingRuntimeCleanupDeliveries(DELIVERY_BATCH_LIMIT);
  if (pending.length === 0) {
    return { result, notes };
  }

  const sessions = liveSessionsByIdentity(store.listOrchestratorSessions(), now);
  const watches = new Map(store.listOrchestratorWatches().map((watch) => [watch.id, watch]));
  const grouped = new Map<string, PendingCleanupDelivery[]>();
  for (const delivery of pending) {
    const entries = grouped.get(delivery.requestId) ?? [];
    entries.push(delivery);
    grouped.set(delivery.requestId, entries);
  }

  for (const [requestId, deliveries] of grouped) {
    const first = deliveries[0]!;
    const lease = store.getRuntimeResourceLease(first.leaseId);
    if (lease === null || lease.fence !== first.expectedLeaseFence) {
      notes.push(`${requestId}: lease/fence 不一致のため配送を保留`);
      result.pending += 1;
      continue;
    }
    const controllerSession = lease.controllerOrchestratorId === null
      ? undefined
      : sessions.get(lease.controllerOrchestratorId);
    if (controllerSession?.status === "handoff_pending") {
      notes.push(`${requestId}: controller planned handoff 完了待ちのため配送を保留`);
      result.pending += 1;
      continue;
    }
    const targets = deliveries
      .map((delivery): RankedTarget | null => {
        const session = sessions.get(delivery.orchestratorId);
        return session === undefined ? null : rankDelivery(store, delivery, session, lease, watches);
      })
      .filter((target): target is RankedTarget => target !== null);

    const target = selectTarget(targets);
    if (target === undefined) {
      if (apply) {
        store.markRuntimeCleanupOrchestratorUnavailable(
          requestId,
          `cleanup request ${requestId} の生存中 orchestrator 配送先がありません（reason: ${first.reason}）`,
          "supervisor",
          now,
        );
      } else {
        notes.push(`dry-run: ${requestId} を human escalation 予定`);
      }
      result.escalated += 1;
      continue;
    }

    if (target.session.status === "handoff_pending") {
      notes.push(`${requestId}: planned handoff 完了待ちのため配送を保留`);
      result.pending += 1;
      continue;
    }

    const controllerChanged = lease.controllerOrchestratorId !== target.delivery.orchestratorId;
    if (apply) {
      // controller が同じ場合も非選択 delivery を dismiss し、primary 生存中の collaborator poll を防ぐ。
      store.routeRuntimeCleanupDelivery({
        requestId,
        expectedControllerId: lease.controllerOrchestratorId ?? "",
        targetOrchestratorId: target.delivery.orchestratorId,
        ...(target.delivery.watchId === null ? {} : { targetWatchId: target.delivery.watchId }),
        expectedLeaseFence: first.expectedLeaseFence,
        now,
      });
    } else if (controllerChanged) {
        notes.push(`dry-run: ${requestId} を ${target.delivery.orchestratorId} へ route 予定`);
    }
    if (controllerChanged) {
      result.routed += 1;
    }
    if (!apply) {
      notes.push(`dry-run: ${requestId} を ${selectMode(target.session)} 配送予定`);
      continue;
    }

    const mode = selectMode(target.session);
    let receipt: string | null = null;
    try {
      receipt = await adapter({
        mode,
        delivery: target.delivery,
        session: target.session,
        message: buildDeliveryMessage(target.delivery),
      });
    } catch (error) {
      notes.push(`${requestId}: ${mode} 配送失敗（${error instanceof Error ? error.message : String(error)}）`);
    }
    if (receipt === null || receipt.trim() === "") {
      result.pending += 1;
      if (mode === "app-wakeup") {
        notes.push(JSON.stringify({
          event: "runtime_cleanup_app_wakeup_unconfigured",
          requestId,
          leaseId: target.delivery.leaseId,
          orchestratorId: target.delivery.orchestratorId,
          sessionId: target.session.id,
          generation: target.session.generation,
          deliveryStatus: "pending",
        }));
      } else {
        notes.push(`${requestId}: ${mode} receipt 未確認のため pending 維持`);
      }
      continue;
    }
    store.markRuntimeCleanupDeliveryDelivered({
      requestId,
      orchestratorId: target.delivery.orchestratorId,
      sessionId: target.session.id,
      generation: target.session.generation,
      receipt,
      now,
    });
    result.delivered += 1;
  }

  return { result, notes };
}
