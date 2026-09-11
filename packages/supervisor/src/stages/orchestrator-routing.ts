// worker-question と runtime cleanup request の durable routing、
// stale orchestrator session 回収と durable liveness incident 通知（contract §55・§56）。
import type {
  EventRow,
  OrchestratorLivenessIncidentRow,
  SessionRef,
  Stage,
  StageDeps,
  StageResult,
  TaskRow,
} from "@hachi/core";
import {
  processCleanupDeliveries,
  STALE_SESSION_SECONDS,
  type CleanupDeliveryAttempt,
  type CleanupDeliveryStore,
} from "../cleanup-delivery.js";
import { sendOperationalNotification, type OperationalNotifyResult } from "./notify.js";
const BACKFILL_LIMIT = 200;
const CWD_LINE_REGEX = /^cwd:\s*(.+)$/m;
const LIVENESS_INCIDENT_LIMIT = 100;
const LIVENESS_MAX_ATTEMPTS = 5;
const LIVENESS_RETRY_DELAYS_SECONDS = [30, 60, 120, 240] as const;

export interface OrchestratorHeartbeatStaleAlert {
  incident: OrchestratorLivenessIncidentRow;
  body: string;
}

export type OrchestratorHeartbeatStaleNotifyFn = (
  deps: StageDeps,
  alert: OrchestratorHeartbeatStaleAlert,
) => Promise<OperationalNotifyResult>;

export interface OrchestratorRoutingStageOptions {
  notifyStaleSession?: OrchestratorHeartbeatStaleNotifyFn;
}

interface QuestionEventPayload {
  questionId?: unknown;
  question?: unknown;
  context?: unknown;
}

function parseQuestionEvent(event: EventRow | undefined): QuestionEventPayload {
  if (event === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(event.payload);
    return typeof parsed === "object" && parsed !== null ? parsed as QuestionEventPayload : {};
  } catch {
    return {};
  }
}

function backfillQuestion(deps: StageDeps, task: TaskRow): void {
  const event = deps.store.listEvents(task.id, "question_asked", 1)[0];
  const payload = parseQuestionEvent(event);
  const reasonQuestion = task.blockReason.slice("worker-question:".length).trim();
  const question = typeof payload.question === "string" && payload.question.trim().length > 0
    ? payload.question
    : reasonQuestion;
  const questionId = typeof payload.questionId === "string" && payload.questionId.length > 0
    ? payload.questionId
    : `q_backfill_${task.id}_${event?.id ?? task.updatedAt}`;
  const cwd = task.body.match(CWD_LINE_REGEX)?.[1]?.trim() ?? "";
  deps.store.createOrGetOrchestratorRequest({
    taskId: task.id,
    questionId,
    question,
    context: typeof payload.context === "string" ? payload.context : "",
    worktree: cwd,
    project: task.tenant,
  });
  deps.store.addEvent(task.id, "orchestrator_request_backfilled", "supervisor", { questionId });
}

async function deliverCleanupToOrchestrator(deps: StageDeps, attempt: CleanupDeliveryAttempt): Promise<string | null> {
  if (attempt.mode === "poll" || attempt.mode === "app-wakeup") {
    // poll は claim 自体を receipt/ack とする。app-wakeup は専用 capability 未構成なら pending を維持する。
    return null;
  }
  const provider = attempt.session.provider;
  if (provider === "" || attempt.session.providerSessionId === "") {
    return null;
  }
  const ref: SessionRef = {
    provider,
    sessionId: attempt.session.providerSessionId,
    serverUrl: deps.env.bridges[provider].url,
    model: "",
    modelDelivery: "none",
    startedAt: attempt.session.createdAt,
  };
  await deps.adapters[provider].inject(ref, attempt.message);
  return `inject-v1:${provider}:${attempt.session.id}:${attempt.session.generation}:${attempt.delivery.requestId}`;
}

function livenessIncidentKey(incident: OrchestratorLivenessIncidentRow): string {
  return `${incident.sessionId}:${incident.generation}`;
}

function buildStaleSessionRecoveryBody(deps: StageDeps, incident: OrchestratorLivenessIncidentRow): string {
  const identity = deps.store.getOrchestrator(incident.orchestratorId);
  const provider = incident.provider === "" ? "<codex|claude>" : incident.provider;
  const providerSessionId = incident.providerSessionId === ""
    ? "<provider-session-uuid>"
    : incident.providerSessionId;
  return [
    `orchestrator heartbeat gap を検知しました: gapSeconds=${incident.gapSeconds}`,
    `session=${incident.sessionId} generation=${incident.generation}`,
    `orchestrator=${incident.orchestratorId} label=${identity?.label ?? "<unknown>"}`,
    `provider=${provider} providerNativeSessionId=${providerSessionId}`,
    "supervisor は active への復帰、新 generation の開始、自動再登録を行いません。",
    "hachi orchestrator list --json で現在の session status と監視状態を確認してください。",
    "status=stale かつ後継がいない場合だけ、次の fenced takeover を手動実行してください。",
    `hachi orchestrator session takeover ${incident.orchestratorId} --stale-sec 90 --provider ${provider} --provider-session-id ${providerSessionId} --json`,
    "status=active へ復帰済みなら二重起動せず、heartbeat と await の監視状態を確認してください。",
  ].join("\n");
}

async function defaultNotifyStaleSession(
  deps: StageDeps,
  alert: OrchestratorHeartbeatStaleAlert,
): Promise<OperationalNotifyResult> {
  return sendOperationalNotification(deps, {
    id: `orchestrator-heartbeat-stale:${alert.incident.sessionId}:${alert.incident.generation}`,
    title: "orchestrator heartbeat stale",
    body: alert.body,
    fullMacosBody: true,
  });
}

function unsentNotificationError(result: OperationalNotifyResult): string {
  const failedTransports = result.failedTransports?.join(",") ?? "";
  return `operational notification unsent: attempted=${result.attempted} sent=${result.sent} failedTransports=${failedTransports}`;
}

function markLivenessNotificationFailure(
  deps: StageDeps,
  incident: OrchestratorLivenessIncidentRow,
  error: string,
  now: number,
  notes: string[],
): void {
  const attempts = incident.attempts + 1;
  const exhausted = attempts >= LIVENESS_MAX_ATTEMPTS;
  let nextAttemptAt = 0;
  if (!exhausted) {
    const delay = LIVENESS_RETRY_DELAYS_SECONDS[incident.attempts];
    if (delay === undefined) {
      throw new Error(`liveness retry delay が未定義です: attempts=${attempts}`);
    }
    nextAttemptAt = now + delay;
  }
  const marked = deps.store.markOrchestratorLivenessIncident(
    incident.id,
    incident.attempts,
    exhausted ? "exhausted" : "pending",
    nextAttemptAt,
    error,
    now,
  );
  const key = livenessIncidentKey(incident);
  if (marked === null) {
    notes.push(`liveness incident ${incident.id} (${key}): attempts CAS競合のため更新をskipしました`);
    return;
  }
  if (marked.status === "exhausted") {
    notes.push(
      `liveness incident exhausted: incident=${marked.id} session=${marked.sessionId} ` +
      `generation=${marked.generation} attempts=${marked.attempts}`,
    );
    deps.logger.warn("orchestrator-routing: liveness incident notification exhausted", {
      incidentId: marked.id,
      sessionId: marked.sessionId,
      generation: marked.generation,
      attempts: marked.attempts,
    });
    return;
  }
  notes.push(
    `liveness incident retry: incident=${marked.id} session=${marked.sessionId} ` +
    `generation=${marked.generation} attempts=${marked.attempts} nextAttemptAt=${marked.nextAttemptAt}`,
  );
}

export function createOrchestratorRoutingStage(options: OrchestratorRoutingStageOptions = {}): Stage {
  const notifyStaleSession = options.notifyStaleSession ?? defaultNotifyStaleSession;

  return {
    name: "orchestrator-routing",

    async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
      const notes: string[] = [];
      let actions = 0;
      const staleSessions = deps.store
        .listOrchestratorSessions()
        .filter((session) =>
          session.heartbeatAt < now - STALE_SESSION_SECONDS &&
          (session.status === "active" ||
            (session.status === "handoff_pending" &&
              (session.handoffExpiresAt === null || session.handoffExpiresAt < now)))
        );
      if (apply) {
        actions += deps.store.expireStaleOrchestratorSessions(now - STALE_SESSION_SECONDS, now);
      } else if (staleSessions.length > 0) {
        actions += staleSessions.length;
        notes.push(`dry-run: stale orchestrator session ${staleSessions.length}件を回収予定`);
      }

      const incidents = deps.store.listPendingOrchestratorLivenessIncidents(now, LIVENESS_INCIDENT_LIMIT);
      actions += incidents.length;
      for (const incident of incidents) {
        const key = livenessIncidentKey(incident);
        if (!apply) {
          notes.push(
            `dry-run: liveness incident ${incident.id} (${key}, attempts=${incident.attempts}) を通知予定`,
          );
          continue;
        }
        let result: OperationalNotifyResult;
        try {
          result = await notifyStaleSession(deps, {
            incident,
            body: buildStaleSessionRecoveryBody(deps, incident),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          markLivenessNotificationFailure(deps, incident, message, now, notes);
          continue;
        }
        if (!result.sent) {
          markLivenessNotificationFailure(deps, incident, unsentNotificationError(result), now, notes);
          continue;
        }
        const marked = deps.store.markOrchestratorLivenessIncident(
          incident.id,
          incident.attempts,
          "sent",
          0,
          "",
          now,
        );
        if (marked === null) {
          notes.push(`liveness incident ${incident.id} (${key}): attempts CAS競合のため sent 更新をskipしました`);
          continue;
        }
        notes.push(`liveness incident sent: incident=${marked.id} session=${marked.sessionId} generation=${marked.generation} attempts=${marked.attempts}`);
      }

      const routableRequests = deps.store.listOrchestratorRequests().filter((request) =>
        request.status === "queued" || request.status === "delivered"
      );
      if (apply) {
        for (const request of routableRequests) {
          const reconciled = deps.store.reconcileOrchestratorRequestRouting(request.id);
          actions += reconciled.addedDeliveries + (reconciled.cancelled ? 1 : 0);
          if (reconciled.addedDeliveries > 0) {
            notes.push(`${request.id}: current binding/watchへ${reconciled.addedDeliveries}件を再配送しました`);
          }
          if (reconciled.cancelled) {
            notes.push(`${request.id}: 終端taskの未claim requestをcancelしました`);
          }
        }
      } else if (routableRequests.length > 0) {
        notes.push(`dry-run: queued/delivered orchestrator request ${routableRequests.length}件を再評価予定`);
      }

      const candidates = deps.store
        .listByStatus("blocked", BACKFILL_LIMIT)
        .filter((task) =>
          task.blockReason.startsWith("worker-question:") &&
          deps.store.getActiveOrchestratorRequestByTask(task.id) === null,
        );
      actions += candidates.length;
      for (const task of candidates) {
        if (apply) {
          backfillQuestion(deps, task);
        } else {
          notes.push(`dry-run: ${task.id} の worker-question を routing backfill予定`);
        }
      }

      // runtime cleanup request の durable delivery routing（§56.5）
      // CleanupDeliveryStore の全メソッドを runtime チェックしてから利用する
      const candidateStore = deps.store as unknown as Partial<CleanupDeliveryStore>;
      const isCleanupCapable =
        typeof candidateStore.listOrchestratorSessions === "function" &&
        typeof candidateStore.listOrchestratorWatches === "function" &&
        typeof candidateStore.listTaskOrchestratorBindings === "function" &&
        typeof candidateStore.listPendingRuntimeCleanupDeliveries === "function" &&
        typeof candidateStore.markRuntimeCleanupDeliveryDelivered === "function" &&
        typeof candidateStore.routeRuntimeCleanupDelivery === "function" &&
        typeof candidateStore.markRuntimeCleanupOrchestratorUnavailable === "function" &&
        typeof candidateStore.getRuntimeResourceLease === "function";
      if (isCleanupCapable) {
        const cleanupStore = deps.store as unknown as CleanupDeliveryStore;
        const { result: cleanupResult, notes: cleanupNotes } = await processCleanupDeliveries(
          cleanupStore,
          apply,
          now,
          (attempt) => deliverCleanupToOrchestrator(deps, attempt),
        );
        actions += cleanupResult.delivered + cleanupResult.routed + cleanupResult.escalated;
        notes.push(...cleanupNotes);
      }

      return { name: "orchestrator-routing", actions, skipped: false, notes };
    },
  };
}

export const orchestratorRoutingStage: Stage = createOrchestratorRoutingStage();
