// durable run cancel engine（docs/contract.md §57）
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { redactText } from "@hachi/core";
import type {
  ExactSessionStopResult,
  KanbanStore,
  RunCancelRequestRow,
  RunRow,
  SessionRef,
  SessionStatus,
  Stage,
  StageDeps,
  StageResult,
  WorkerAdapter,
  WorkerStopCapabilities,
} from "@hachi/core";
import { SUPERVISOR_ACTOR } from "../constants.js";
import {
  pickAdapter,
  reconstructSessionRef,
  sessionStatusLastEntryId,
  sessionStatusResultWatermark,
} from "../session-ref.js";

const DEFAULT_CANCEL_GRACE_SECONDS = 60;
const MAX_CANCELS_PER_TICK = 20;
const MAX_FORCES_PER_TICK = 5;
const MAX_WALL_MILLISECONDS = 5_000;
const FORCE_RETRY_BASE_SECONDS = 5;
const FORCE_RETRY_MAX_SECONDS = 300;
const BRIDGE_QUIESCENCE_SECONDS = 60;
const CWD_LINE_REGEX = /^cwd:\s*(\S+)\s*$/m;
const CANCEL_STOP_CANDIDATE_EVENT = "cancel_stop_candidate";

const ACTIVE_STATUSES = new Set<RunCancelRequestRow["status"]>([
  "cancel_requested",
  "cooperative_sent",
  "acknowledged",
  "forcing",
]);

interface CancelAcknowledgement {
  schemaVersion: "cancel-ack.v1";
  requestId: string;
  requestNonce: string;
  runId: number;
  sessionId: string;
  cancelFence: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAcknowledgement(value: unknown): CancelAcknowledgement | null {
  if (!isRecord(value)) {
    return null;
  }
  const candidate = isRecord(value["cancelAck"])
    ? value["cancelAck"]
    : isRecord(value["cancel_ack"])
      ? value["cancel_ack"]
      : value;
  if (
    candidate["schemaVersion"] !== "cancel-ack.v1" ||
    typeof candidate["requestId"] !== "string" ||
    typeof candidate["requestNonce"] !== "string" ||
    typeof candidate["runId"] !== "number" ||
    !Number.isSafeInteger(candidate["runId"]) ||
    typeof candidate["sessionId"] !== "string" ||
    typeof candidate["cancelFence"] !== "number" ||
    !Number.isSafeInteger(candidate["cancelFence"])
  ) {
    return null;
  }
  return {
    schemaVersion: "cancel-ack.v1",
    requestId: candidate["requestId"],
    requestNonce: candidate["requestNonce"],
    runId: candidate["runId"],
    sessionId: candidate["sessionId"],
    cancelFence: candidate["cancelFence"],
  };
}

/** message_processed や inject 成功とは独立した、exact fence 付き ack だけを返す。 */
export function extractCancelAcknowledgement(
  status: SessionStatus,
  request: RunCancelRequestRow,
): CancelAcknowledgement | null {
  const acknowledgement = parseAcknowledgement(status.raw);
  if (
    acknowledgement === null ||
    acknowledgement.requestId !== request.id ||
    acknowledgement.requestNonce !== request.requestNonce ||
    acknowledgement.runId !== request.runId ||
    acknowledgement.sessionId !== request.sessionId ||
    acknowledgement.cancelFence !== request.cancelFence
  ) {
    return null;
  }
  return acknowledgement;
}

function cancellationEnvelope(request: RunCancelRequestRow): string {
  return JSON.stringify({
    schemaVersion: "cancel.v1",
    priority: "highest",
    requestId: request.id,
    requestNonce: request.requestNonce,
    taskId: request.taskId,
    runId: request.runId,
    sessionId: request.sessionId,
    cancelFence: request.cancelFence,
    deadlineAt: request.deadlineAt,
    instructions: [
      "新規tool・sub-agent・side effectを開始しない",
      "現在進行中の副作用を安全に停止する",
      "cancel-ack.v1 と cancel handoff を返す",
    ],
  });
}

interface ForceAttemptState {
  attempts: number;
  lastAttemptAt: number | null;
}

/** force effect の intent event から、crash 後も同じ retry schedule を復元する。 */
function forceAttemptState(store: KanbanStore, request: RunCancelRequestRow): ForceAttemptState {
  const attemptedAt: number[] = [];
  for (const event of store.listEvents(request.taskId, "cancel_force_attempted")) {
    try {
      const payload = JSON.parse(event.payload) as unknown;
      if (
        isRecord(payload) && payload["requestId"] === request.id &&
        typeof payload["attemptedAt"] === "number" && Number.isSafeInteger(payload["attemptedAt"])
      ) {
        attemptedAt.push(payload["attemptedAt"]);
      }
    } catch {
      // 壊れた監査 event は retry を早める根拠にせず無視する。
    }
  }
  return {
    attempts: attemptedAt.length,
    lastAttemptAt: attemptedAt.at(-1) ?? null,
  };
}

function forceRetryDelaySeconds(attempts: number): number {
  if (attempts <= 0) {
    return 0;
  }
  return Math.min(FORCE_RETRY_BASE_SECONDS * (2 ** Math.min(attempts - 1, 10)), FORCE_RETRY_MAX_SECONDS);
}

function durableCancelEscalation(
  store: KanbanStore,
  request: RunCancelRequestRow,
  failure: string,
): void {
  const task = store.getTask(request.taskId);
  if (task === null) {
    throw new Error(`cancel escalation 対象 task が見つかりません: ${request.taskId}`);
  }
  const worktree = task.body.match(CWD_LINE_REGEX)?.[1] ?? "";
  store.createOrGetOrchestratorRequest({
    taskId: request.taskId,
    questionId: `cancel-failure:${request.id}`,
    question: "exact-session stop を確認できません。停止手段と resource/replacement gate の扱いを判断してください。",
    context:
      `cancelRequestId=${request.id} runId=${request.runId} sessionId=${request.sessionId} ` +
      `cancelFence=${request.cancelFence} failure=${redactText(failure)}`,
    worktree,
    project: task.tenant,
  });
}

function supervisorNonce(run: RunRow, reasonKey: string): string {
  const digest = createHash("sha256")
    .update(String(run.id))
    .update("\0")
    .update(run.sessionId)
    .update("\0")
    .update(reasonKey)
    .digest("hex")
    .slice(0, 24);
  return `supervisor-cancel-${digest}`;
}

/** monitor/stall から同一 run に冪等な host cancel intent を作る。 */
export function ensureSupervisorCancelRequest(
  store: KanbanStore,
  run: RunRow,
  reasonKey: string,
  reason: string,
  now: number,
  graceSeconds: number = DEFAULT_CANCEL_GRACE_SECONDS,
): RunCancelRequestRow {
  const active = store.getActiveRunCancelRequestByTask(run.taskId);
  if (active !== null) {
    return active;
  }
  const previous = cancellationForRun(store, run.id);
  const nonceKey = previous === null ? reasonKey : `${reasonKey}:retry:${previous.cancelFence + 1}`;
  return store.createOrGetRunCancelRequest({
    taskId: run.taskId,
    runId: run.id,
    sessionId: run.sessionId,
    provider: run.provider,
    requestNonce: supervisorNonce(run, nonceKey),
    actor: SUPERVISOR_ACTOR,
    reason,
    deadlineAt: now + graceSeconds,
  });
}

export function cancellationForRun(store: KanbanStore, runId: number): RunCancelRequestRow | null {
  return store.listRunCancelRequests().findLast((request) => request.runId === runId) ?? null;
}

function canonicalWorktree(path: string | null): string | null {
  if (path === null) {
    return null;
  }
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** cancel stop 証拠待ちの同一 task/worktree run を返す。起動系の前後 fence で共用する。 */
export function cancelledOpenRunForTaskOrWorktree(
  store: KanbanStore,
  taskId: string,
  cwd: string | null,
): RunRow | null {
  const canonicalCandidate = canonicalWorktree(cwd);
  const cancelledRunIds = new Set(store.listRunCancelRequests().map((request) => request.runId));
  for (const run of store.listOpenRuns()) {
    if (!cancelledRunIds.has(run.id)) {
      continue;
    }
    if (run.taskId === taskId) {
      return run;
    }
    if (canonicalCandidate === null) {
      continue;
    }
    const owner = store.getTask(run.taskId);
    const ownerCwd = owner?.body.match(CWD_LINE_REGEX)?.[1] ?? null;
    if (canonicalWorktree(ownerCwd) === canonicalCandidate) {
      return run;
    }
  }
  return null;
}

/** late handoff/result の task mutation を止め、同じ request について監査 event を一度だけ残す。 */
export function rejectLateResultOnce(
  store: KanbanStore,
  run: RunRow,
  observedSessionId: string,
): boolean {
  const request = cancellationForRun(store, run.id);
  if (request === null) {
    return false;
  }
  const alreadyRecorded = store.listEvents(run.taskId, "late_result_rejected").some((event) => {
    try {
      const payload = JSON.parse(event.payload) as unknown;
      return isRecord(payload) && payload["requestId"] === request.id && payload["runId"] === run.id;
    } catch {
      return false;
    }
  });
  if (!alreadyRecorded) {
    store.runMutationGate(run.id, observedSessionId);
  }
  return true;
}

function transition(
  store: KanbanStore,
  request: RunCancelRequestRow,
  to: RunCancelRequestRow["status"],
  now: number,
  extra: {
    acknowledgedNonce?: string;
    capabilitySnapshot?: Record<string, unknown>;
    stopEvidence?: Record<string, unknown>;
    lastError?: string;
  } = {},
): RunCancelRequestRow {
  return store.transitionRunCancelRequest({
    requestId: request.id,
    expectedStatus: request.status,
    to,
    expectedRunId: request.runId,
    expectedSessionId: request.sessionId,
    expectedCancelFence: request.cancelFence,
    requestNonce: request.requestNonce,
    actor: SUPERVISOR_ACTOR,
    now,
    ...extra,
  });
}

function isStrongStoppedState(ref: SessionRef, status: SessionStatus): boolean {
  return status.state === "ended" || (ref.serverUrl === "direct" && status.state === "idle");
}

interface CancelStopCandidate {
  state: "candidate" | "invalidated";
  requestId: string;
  runId: number;
  sessionId: string;
  cancelFence: number;
  resultWatermark: number;
  lastEntryId: number;
  observedAt: number;
}

function parseStopCandidate(payload: string): CancelStopCandidate | null {
  try {
    const value = JSON.parse(payload) as unknown;
    if (
      !isRecord(value) ||
      !["candidate", "invalidated"].includes(String(value["state"])) ||
      typeof value["requestId"] !== "string" ||
      typeof value["runId"] !== "number" ||
      typeof value["sessionId"] !== "string" ||
      typeof value["cancelFence"] !== "number" ||
      typeof value["resultWatermark"] !== "number" ||
      typeof value["lastEntryId"] !== "number" ||
      typeof value["observedAt"] !== "number"
    ) {
      return null;
    }
    return value as unknown as CancelStopCandidate;
  } catch {
    return null;
  }
}

function latestStopCandidate(store: KanbanStore, request: RunCancelRequestRow): CancelStopCandidate | null {
  return store
    .listEvents(request.taskId, CANCEL_STOP_CANDIDATE_EVENT)
    .map((event) => parseStopCandidate(event.payload))
    .filter((candidate): candidate is CancelStopCandidate =>
      candidate !== null && candidate.requestId === request.id && candidate.runId === request.runId &&
      candidate.sessionId === request.sessionId && candidate.cancelFence === request.cancelFence)
    .at(-1) ?? null;
}

function bridgeIdleSnapshot(status: SessionStatus): { resultWatermark: number; lastEntryId: number } | null {
  if (status.state !== "idle") {
    return null;
  }
  const resultWatermark = sessionStatusResultWatermark(status);
  const lastEntryId = sessionStatusLastEntryId(status);
  // bridge は未知 session も idle + 空 messages として返す。空 snapshot は停止証拠にしない。
  if (resultWatermark < 1 && lastEntryId < 1) {
    return null;
  }
  return { resultWatermark, lastEntryId };
}

/** bridge idle は一回の観測で閉じず、exact snapshot の durable 静穏再観測を要求する。 */
function observeBridgeQuiescence(
  store: KanbanStore,
  request: RunCancelRequestRow,
  status: SessionStatus,
  apply: boolean,
  now: number,
): boolean {
  const snapshot = bridgeIdleSnapshot(status);
  const previous = latestStopCandidate(store, request);
  if (snapshot === null) {
    if (apply && previous?.state === "candidate") {
      store.addEvent(request.taskId, CANCEL_STOP_CANDIDATE_EVENT, SUPERVISOR_ACTOR, {
        ...previous,
        state: "invalidated",
        observedAt: now,
      });
    }
    return false;
  }
  const same =
    previous?.state === "candidate" && previous.resultWatermark === snapshot.resultWatermark &&
    previous.lastEntryId === snapshot.lastEntryId;
  if (same && now - previous.observedAt >= BRIDGE_QUIESCENCE_SECONDS) {
    return true;
  }
  if (apply && !same) {
    store.addEvent(request.taskId, CANCEL_STOP_CANDIDATE_EVENT, SUPERVISOR_ACTOR, {
      state: "candidate",
      requestId: request.id,
      runId: request.runId,
      sessionId: request.sessionId,
      cancelFence: request.cancelFence,
      resultWatermark: snapshot.resultWatermark,
      lastEntryId: snapshot.lastEntryId,
      observedAt: now,
    });
  }
  return false;
}

function hasLateResultEvidence(store: KanbanStore, run: RunRow, status: SessionStatus): boolean {
  if ((status.resultCount ?? 0) > 0) {
    return true;
  }
  return store.listEvents(run.taskId, "session_ended").some((event) => {
    try {
      const payload = JSON.parse(event.payload) as unknown;
      return isRecord(payload) && payload["sessionId"] === run.sessionId;
    } catch {
      return false;
    }
  });
}

function stopEvidence(
  status: SessionStatus,
  source: "natural" | "forced",
  result?: ExactSessionStopResult,
): Record<string, unknown> {
  return {
    source,
    observedSessionState: status.state,
    resultWatermark: sessionStatusResultWatermark(status),
    lastEntryId: sessionStatusLastEntryId(status),
    ...(result === undefined
      ? {}
      : {
          stopState: result.state,
          evidenceId: result.evidenceId,
          childProcessTreeCovered: result.childProcessTreeCovered,
        }),
  };
}

function closeStoppedRun(
  store: KanbanStore,
  request: RunCancelRequestRow,
  status: SessionStatus,
  now: number,
  source: "natural" | "forced",
  result?: ExactSessionStopResult,
): void {
  store.transaction(() => {
    const current = store.getRunCancelRequest(request.id);
    const run = store.getOpenRunByTaskSession(request.taskId, request.sessionId);
    if (current === null || !ACTIVE_STATUSES.has(current.status) || run === null || run.id !== request.runId) {
      throw new Error("cancel close の run/request fence 再検証に失敗しました");
    }
    transition(store, current, "stopped", now, { stopEvidence: stopEvidence(status, source, result) });
    store.endRun(run.id, "failed", {
      cancelRequestId: current.id,
      cancelFence: current.cancelFence,
      stopEvidence: stopEvidence(status, source, result),
    });
    const task = store.getTask(request.taskId);
    const reason = `needs-manual: cancel stopped (${redactText(request.reason)})`;
    if (task?.status === "blocked") {
      store.updateBlockReason(request.taskId, reason, SUPERVISOR_ACTOR, "human");
    } else if (task?.status === "review") {
      store.block(request.taskId, reason, SUPERVISOR_ACTOR, "human");
    }
  });
}

async function capabilities(adapter: WorkerAdapter, ref: SessionRef): Promise<WorkerStopCapabilities> {
  if (ref.serverUrl === "direct") {
    return {
      protocol: adapter.stop === undefined ? "unsupported" : "direct-stop-v1",
      exactSession: adapter.stop !== undefined,
      childProcessTree: adapter.stop !== undefined,
    };
  }
  if (adapter.stopCapabilities === undefined) {
    return { protocol: "unsupported", exactSession: false, childProcessTree: false };
  }
  try {
    return await adapter.stopCapabilities(ref);
  } catch {
    return { protocol: "unsupported", exactSession: false, childProcessTree: false };
  }
}

async function forceStop(
  adapter: WorkerAdapter,
  ref: SessionRef,
  request: RunCancelRequestRow,
  advertised: WorkerStopCapabilities,
): Promise<ExactSessionStopResult> {
  if (advertised.protocol === "direct-stop-v1") {
    if (adapter.stop === undefined) {
      return {
        state: "unsupported",
        evidenceId: "direct:stop-missing",
        observedSessionState: "unknown",
        childProcessTreeCovered: false,
      };
    }
    try {
      const result = await adapter.stop(ref);
      return {
        state: result.stopped ? "stopped" : result.reason === "already-exited" ? "already-stopped" : "unknown",
        evidenceId: `direct:${result.reason}`,
        observedSessionState: result.stopped || result.reason === "already-exited" ? "ended" : "unknown",
        // stopDirectSession の already-exited は process group 自体が不存在という tree 証拠である。
        childProcessTreeCovered: result.stopped || result.reason === "already-exited",
      };
    } catch {
      return {
        state: "unknown",
        evidenceId: "direct:stop-failure",
        observedSessionState: "unknown",
        childProcessTreeCovered: false,
      };
    }
  }
  if (adapter.stopExact === undefined) {
    return {
      state: "unsupported",
      evidenceId: "adapter:stop-exact-missing",
      observedSessionState: "unknown",
      childProcessTreeCovered: false,
    };
  }
  return adapter.stopExact(ref, {
    requestNonce: request.requestNonce,
    expectedRunId: request.runId,
    expectedSessionId: request.sessionId,
  });
}

function latestRequests(store: KanbanStore): RunCancelRequestRow[] {
  const latest = new Map<number, RunCancelRequestRow>();
  for (const request of store.listRunCancelRequests()) {
    const previous = latest.get(request.runId);
    if (previous === undefined || request.cancelFence > previous.cancelFence) {
      latest.set(request.runId, request);
    }
  }
  return [...latest.values()]
    .filter((request) => ACTIVE_STATUSES.has(request.status))
    .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id));
}

export const cancelStage: Stage = {
  name: "cancel",

  async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
    const notes: string[] = [];
    let actions = 0;
    let forces = 0;
    const startedAt = Date.now();

    for (const initial of latestRequests(deps.store).slice(0, MAX_CANCELS_PER_TICK)) {
      if (Date.now() - startedAt >= MAX_WALL_MILLISECONDS) {
        notes.push("cancel wall-clock budget に到達しました");
        break;
      }
      const run = deps.store.getOpenRunByTaskSession(initial.taskId, initial.sessionId);
      const ref = reconstructSessionRef(deps.store, initial.taskId);
      if (run === null || run.id !== initial.runId || ref === null || ref.sessionId !== initial.sessionId) {
        notes.push(`${initial.taskId}: cancel target の open run/session を再構築できません`);
        continue;
      }

      let adapter: WorkerAdapter;
      let status: SessionStatus;
      try {
        adapter = pickAdapter(deps, ref);
        status = await adapter.status(ref);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notes.push(`${initial.taskId}: cancel status 取得失敗 (${redactText(message)})`);
        if (apply && now >= initial.deadlineAt) {
          durableCancelEscalation(deps.store, initial, `exact-session status probe failed: ${message}`);
        }
        continue;
      }

      const naturallyStopped = isStrongStoppedState(ref, status) ||
        (ref.serverUrl !== "direct" && observeBridgeQuiescence(deps.store, initial, status, apply, now));
      if (naturallyStopped) {
        actions += 1;
        notes.push(`${initial.taskId}: exact session の自然停止を確認しました`);
        if (apply) {
          if (hasLateResultEvidence(deps.store, run, status)) {
            rejectLateResultOnce(deps.store, run, initial.sessionId);
          }
          closeStoppedRun(deps.store, initial, status, now, "natural");
        }
        continue;
      }

      let request = initial;
      if (request.status === "cooperative_sent") {
        const acknowledgement = extractCancelAcknowledgement(status, request);
        if (acknowledgement !== null) {
          actions += 1;
          notes.push(`${request.taskId}: cancel ack を確認しました`);
          if (apply) {
            request = transition(deps.store, request, "acknowledged", now, {
              acknowledgedNonce: acknowledgement.requestNonce,
            });
          }
        }
      }

      if (request.status === "cancel_requested" && now < request.deadlineAt) {
        actions += 1;
        notes.push(`${request.taskId}: cooperative cancel を注入します`);
        if (apply) {
          // mark-first: effect 後・commit 前 crash で同じ envelope を二重配送しない。
          request = transition(deps.store, request, "cooperative_sent", now);
          try {
            await adapter.inject(ref, cancellationEnvelope(request));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            deps.logger.warn("cancel: cooperative inject に失敗しました", {
              taskId: request.taskId,
              sessionId: request.sessionId,
              error: redactText(message),
            });
          }
        }
        continue;
      }

      if (now < request.deadlineAt || forces >= MAX_FORCES_PER_TICK) {
        continue;
      }

      if (request.status === "forcing") {
        const attempt = forceAttemptState(deps.store, request);
        const retryAt = (attempt.lastAttemptAt ?? now) + forceRetryDelaySeconds(attempt.attempts);
        if (attempt.lastAttemptAt !== null && now < retryAt) {
          notes.push(
            `${request.taskId}: exact-session force stop backoff 待機中 ` +
            `(attempt=${attempt.attempts}, remaining=${retryAt - now}s)`,
          );
          continue;
        }
      }

      const advertised = await capabilities(adapter, ref);
      if (advertised.protocol === "unsupported" || !advertised.exactSession) {
        notes.push(`${request.taskId}: exact-session stop capability が無いため pending を維持します`);
        if (apply) {
          durableCancelEscalation(deps.store, request, "exact-session stop capability unsupported");
        }
        continue;
      }

      actions += 1;
      forces += 1;
      notes.push(`${request.taskId}: exact-session force stop を実行します`);
      if (!apply) {
        continue;
      }

      if (request.status !== "forcing") {
        request = transition(deps.store, request, "forcing", now, {
          capabilitySnapshot: {
            protocol: advertised.protocol,
            exactSession: advertised.exactSession,
            childProcessTree: advertised.childProcessTree,
          },
        });
      }
      const attempt = forceAttemptState(deps.store, request);
      // intent-before-effect: crash 後は status 再照合し、継続中の場合も backoff 後だけ再試行する。
      deps.store.addEvent(request.taskId, "cancel_force_attempted", SUPERVISOR_ACTOR, {
        requestId: request.id,
        runId: request.runId,
        sessionId: request.sessionId,
        cancelFence: request.cancelFence,
        attempt: attempt.attempts + 1,
        attemptedAt: now,
      });
      const result = await forceStop(adapter, ref, request, advertised);
      const childTreeMismatch = advertised.childProcessTree && !result.childProcessTreeCovered;
      let confirmed: SessionStatus;
      try {
        confirmed = await adapter.status(ref);
      } catch {
        confirmed = { state: "unknown", lastActivityAt: null };
      }
      const exactStopReported = result.state === "stopped" || result.state === "already-stopped";
      const forcedStopConfirmed =
        (exactStopReported && (confirmed.state === "idle" || confirmed.state === "ended")) ||
        isStrongStoppedState(ref, confirmed);
      if (forcedStopConfirmed && !childTreeMismatch) {
        if (hasLateResultEvidence(deps.store, run, confirmed)) {
          rejectLateResultOnce(deps.store, run, request.sessionId);
        }
        closeStoppedRun(deps.store, request, confirmed, now, "forced", result);
        continue;
      }
      if (childTreeMismatch || ["unsupported", "rejected", "unknown"].includes(result.state)) {
        const lastError = childTreeMismatch
          ? "exact-session stop child-process-tree evidence mismatch"
          : `exact-session stop ${result.state}`;
        // terminal 化より先に durable inbox を作り、途中 crash でも escalation を失わない。
        durableCancelEscalation(deps.store, request, lastError);
        transition(deps.store, request, "failed", now, {
          stopEvidence: stopEvidence(confirmed, "forced", result),
          lastError,
        });
      }
    }

    return { name: "cancel", actions, skipped: false, notes };
  },
};
