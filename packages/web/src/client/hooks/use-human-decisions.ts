import { useCallback, useEffect, useRef, useState } from "react";
import type { HumanDecisionAnswer, HumanDecisionRequestRow } from "@hachi/core";
import { ApiError, fetchHumanDecisions, postHumanDecisionAnswer } from "../lib/api.js";
import { useVisiblePolling } from "./use-visible-polling.js";

const POLL_INTERVAL_MS = 30_000;

export interface HumanDecisionScope {
  taskId?: string;
  tenant?: string;
}

export interface HumanDecisionSubmissionState {
  phase: "idle" | "submitting" | "uncertain" | "rejected";
  error: string | null;
  canSubmit: boolean;
  canRetry: boolean;
  pendingAnswer: { answer: HumanDecisionAnswer; comment?: string | null } | null;
}

export interface UseHumanDecisionsResult {
  confirmedAnswerCount: number;
  requests: HumanDecisionRequestRow[] | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  submissions: Record<string, HumanDecisionSubmissionState>;
  refresh: () => Promise<void>;
  submit: (requestId: string, answer: HumanDecisionAnswer, comment?: string | null) => Promise<void>;
  retrySameAnswer: (requestId: string) => Promise<void>;
}

interface PendingSubmission {
  expectedRevision: 0;
  answerIdempotencyKey: string;
  answer: HumanDecisionAnswer;
  comment?: string | null;
}

interface InternalSubmissionState {
  phase: "submitting" | "uncertain" | "rejected";
  error: string | null;
  pending: PendingSubmission | null;
  inFlight: boolean;
  operationId: number;
  rejectionRequiresRefresh: boolean;
  rejectionConfirmed: boolean;
}

interface EpochData {
  confirmedAnswerCount: number;
  requests: HumanDecisionRequestRow[] | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  submissions: Record<string, InternalSubmissionState>;
}

interface ActiveEpoch {
  scopeKey: string;
  epoch: number;
  taskId: string | undefined;
  tenant: string;
  alive: boolean;
  nextLoadSequence: number;
  currentLoadSequence: number;
  nextOperationId: number;
  controllers: Set<AbortController>;
  data: EpochData;
}

interface RenderData {
  confirmedAnswerCount: number;
  requests: HumanDecisionRequestRow[] | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  submissions: Record<string, HumanDecisionSubmissionState>;
}

interface RenderState {
  scopeKey: string;
  epoch: number | null;
  data: RenderData;
}

function initialData(): EpochData {
  return {
    confirmedAnswerCount: 0,
    requests: null,
    loading: true,
    error: null,
    stale: false,
    submissions: {},
  };
}

function scopeKeyOf(scope: HumanDecisionScope): string {
  return JSON.stringify([scope.taskId ?? null, scope.tenant ?? ""]);
}

function scopeFromKey(scopeKey: string): { taskId: string | undefined; tenant: string } {
  const [taskId, tenant] = JSON.parse(scopeKey) as [string | null, string];
  return { taskId: taskId === null ? undefined : taskId, tenant };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWaiting(request: HumanDecisionRequestRow | undefined): boolean {
  return request?.status === "waiting_human" && request.answerRevision === 0;
}

function isTerminal(request: HumanDecisionRequestRow): boolean {
  return request.status === "resolved" || request.status === "cancelled";
}

function mergeRequest(
  current: HumanDecisionRequestRow | undefined,
  received: HumanDecisionRequestRow,
): HumanDecisionRequestRow {
  if (current === undefined) {
    return received;
  }
  if (current.answerRevision === 1 && received.answerRevision === 0) {
    return current;
  }
  if (isTerminal(current) && !isTerminal(received)) {
    return current;
  }
  return received;
}

function mergeRequests(
  current: HumanDecisionRequestRow[] | null,
  received: HumanDecisionRequestRow[],
): HumanDecisionRequestRow[] {
  const currentById = new Map((current ?? []).map((request) => [request.id, request]));
  return received.map((request) => mergeRequest(currentById.get(request.id), request));
}

function reconcileSubmissions(
  submissions: Record<string, InternalSubmissionState>,
  requests: HumanDecisionRequestRow[],
): Record<string, InternalSubmissionState> {
  const next = { ...submissions };
  for (const request of requests) {
    const submission = next[request.id];
    if (submission === undefined || submission.inFlight) {
      continue;
    }
    if (!isWaiting(request)) {
      delete next[request.id];
      continue;
    }
    if (submission.phase === "rejected") {
      next[request.id] = { ...submission, rejectionConfirmed: true };
    }
  }
  return next;
}

function cloneAnswer(answer: HumanDecisionAnswer): HumanDecisionAnswer {
  return { ...answer };
}

function clonePendingAnswer(
  pending: PendingSubmission | null,
): { answer: HumanDecisionAnswer; comment?: string | null } | null {
  if (pending === null) {
    return null;
  }
  const answer = cloneAnswer(pending.answer);
  return pending.comment === undefined ? { answer } : { answer, comment: pending.comment };
}

function publicSubmissions(data: EpochData): Record<string, HumanDecisionSubmissionState> {
  const result: Record<string, HumanDecisionSubmissionState> = {};
  for (const request of data.requests ?? []) {
    const internal = data.submissions[request.id];
    const waiting = isWaiting(request);
    const rejectedCanSubmit = internal?.phase === "rejected"
      && !internal.inFlight
      && internal.pending === null
      && (!internal.rejectionRequiresRefresh || internal.rejectionConfirmed);
    result[request.id] = {
      phase: internal?.phase ?? "idle",
      error: internal?.error ?? null,
      canSubmit: waiting && !data.stale && (internal === undefined || rejectedCanSubmit),
      canRetry: waiting
        && internal?.phase === "uncertain"
        && !internal.inFlight
        && internal.pending !== null,
      pendingAnswer: clonePendingAnswer(internal?.pending ?? null),
    };
  }
  return result;
}

function renderData(data: EpochData): RenderData {
  return {
    confirmedAnswerCount: data.confirmedAnswerCount,
    requests: data.requests,
    loading: data.loading,
    error: data.error,
    stale: data.stale,
    submissions: publicSubmissions(data),
  };
}

function findRequest(data: EpochData, requestId: string): HumanDecisionRequestRow | undefined {
  return data.requests?.find((request) => request.id === requestId);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useHumanDecisions(scope: HumanDecisionScope): UseHumanDecisionsResult {
  const scopeKey = scopeKeyOf(scope);
  const activeRef = useRef<ActiveEpoch | null>(null);
  const epochCounterRef = useRef(0);
  const [renderState, setRenderState] = useState<RenderState>(() => ({
    scopeKey,
    epoch: null,
    data: renderData(initialData()),
  }));

  const isActive = useCallback((active: ActiveEpoch): boolean => (
    active.alive && activeRef.current === active
  ), []);

  const update = useCallback((
    active: ActiveEpoch,
    updater: (current: EpochData) => EpochData,
  ): boolean => {
    if (!isActive(active)) {
      return false;
    }
    const next = updater(active.data);
    active.data = next;
    setRenderState({ scopeKey: active.scopeKey, epoch: active.epoch, data: renderData(next) });
    return true;
  }, [isActive]);

  const invalidateLoads = useCallback((active: ActiveEpoch): void => {
    if (!isActive(active)) {
      return;
    }
    active.currentLoadSequence = ++active.nextLoadSequence;
    update(active, (current) => ({ ...current, loading: false }));
  }, [isActive, update]);

  const load = useCallback(async (active: ActiveEpoch): Promise<void> => {
    if (!isActive(active)) {
      return;
    }
    const sequence = ++active.nextLoadSequence;
    active.currentLoadSequence = sequence;
    const controller = new AbortController();
    active.controllers.add(controller);
    update(active, (current) => ({ ...current, loading: true }));

    try {
      const params = active.taskId === undefined
        ? (active.tenant === "" ? {} : { tenant: active.tenant })
        : (active.tenant === "" ? { taskId: active.taskId } : { taskId: active.taskId, tenant: active.tenant });
      const response = await fetchHumanDecisions(params, controller.signal);
      if (!Array.isArray(response.requests)) {
        throw new Error("人間判断一覧の応答形式が不正です");
      }
      if (!isActive(active) || sequence !== active.currentLoadSequence) {
        return;
      }
      update(active, (current) => {
        const requests = mergeRequests(current.requests, response.requests);
        return {
          ...current,
          requests,
          loading: false,
          error: null,
          stale: false,
          submissions: reconcileSubmissions(current.submissions, requests),
        };
      });
    } catch (error: unknown) {
      if (!isActive(active) || sequence !== active.currentLoadSequence) {
        return;
      }
      if (isAbortError(error)) {
        return;
      }
      update(active, (current) => ({
        ...current,
        loading: false,
        error: errorMessage(error),
        stale: current.requests !== null,
      }));
    } finally {
      active.controllers.delete(controller);
    }
  }, [isActive, update]);

  const performPost = useCallback(async (
    active: ActiveEpoch,
    requestId: string,
    operationId: number,
    pending: PendingSubmission,
  ): Promise<void> => {
    let responseRequest: HumanDecisionRequestRow | null = null;
    let failure: unknown = null;
    try {
      const response = await postHumanDecisionAnswer(requestId, pending, active.tenant);
      if (typeof response !== "object" || response === null
        || typeof response.request !== "object" || response.request === null
        || response.request.id !== requestId) {
        throw new Error("人間判断回答の応答形式が不正です");
      }
      responseRequest = response.request;
    } catch (error: unknown) {
      failure = error;
    }

    if (!isActive(active)) {
      return;
    }
    const currentSubmission = active.data.submissions[requestId];
    if (currentSubmission === undefined || currentSubmission.operationId !== operationId) {
      return;
    }

    invalidateLoads(active);
    update(active, (current) => {
      const currentRequest = findRequest(current, requestId);
      const submissions = { ...current.submissions };
      if (failure === null && responseRequest !== null) {
        const requests = current.requests === null
          ? null
          : current.requests.map((request) => (
            request.id === requestId ? mergeRequest(request, responseRequest) : request
          ));
        delete submissions[requestId];
        return { ...current, requests, submissions,
          confirmedAnswerCount: current.confirmedAnswerCount
            + (responseRequest.answerRevision > pending.expectedRevision
              && responseRequest.answer !== null
              && responseRequest.status !== "waiting_human"
              && responseRequest.status !== "cancelled" ? 1 : 0),
        };
      }

      if (!isWaiting(currentRequest)) {
        delete submissions[requestId];
        return { ...current, submissions };
      }

      const message = errorMessage(failure);
      if (failure instanceof ApiError
        && failure.status !== undefined
        && failure.status >= 400
        && failure.status <= 499) {
        submissions[requestId] = {
          phase: "rejected",
          error: message,
          pending: null,
          inFlight: false,
          operationId,
          rejectionRequiresRefresh: true,
          rejectionConfirmed: false,
        };
      } else {
        submissions[requestId] = {
          phase: "uncertain",
          error: message,
          pending,
          inFlight: false,
          operationId,
          rejectionRequiresRefresh: false,
          rejectionConfirmed: false,
        };
      }
      return { ...current, submissions };
    });
    await load(active);
  }, [invalidateLoads, isActive, load, update]);

  useEffect(() => {
    const normalized = scopeFromKey(scopeKey);
    const active: ActiveEpoch = {
      scopeKey,
      epoch: ++epochCounterRef.current,
      taskId: normalized.taskId,
      tenant: normalized.tenant,
      alive: true,
      nextLoadSequence: 0,
      currentLoadSequence: 0,
      nextOperationId: 0,
      controllers: new Set(),
      data: initialData(),
    };
    activeRef.current = active;
    setRenderState({ scopeKey, epoch: active.epoch, data: renderData(active.data) });
    void load(active);

    return () => {
      active.alive = false;
      for (const controller of active.controllers) {
        controller.abort();
      }
      active.controllers.clear();
      if (activeRef.current === active) {
        activeRef.current = null;
      }
    };
  }, [load, scopeKey]);

  const activeForRender = activeRef.current;
  const visible = renderState.scopeKey === scopeKey
    && renderState.epoch !== null
    && activeForRender !== null
    && activeForRender.alive
    && activeForRender.scopeKey === scopeKey
    && activeForRender.epoch === renderState.epoch;
  const visibleEpoch = visible ? renderState.epoch : null;
  const data = visible ? renderState.data : renderData(initialData());

  const getCapturedActive = useCallback((): ActiveEpoch | null => {
    const active = activeRef.current;
    if (visibleEpoch === null || active === null || !active.alive
      || active.scopeKey !== scopeKey || active.epoch !== visibleEpoch) {
      return null;
    }
    return active;
  }, [scopeKey, visibleEpoch]);

  const refresh = useCallback((): Promise<void> => {
    const active = getCapturedActive();
    return active === null ? Promise.resolve() : load(active);
  }, [getCapturedActive, load]);

  const submit = useCallback((
    requestId: string,
    answer: HumanDecisionAnswer,
    comment?: string | null,
  ): Promise<void> => {
    const active = getCapturedActive();
    if (active === null) {
      return Promise.resolve();
    }
    const request = findRequest(active.data, requestId);
    const current = active.data.submissions[requestId];
    const rejectedCanSubmit = current?.phase === "rejected"
      && !current.inFlight
      && current.pending === null
      && (!current.rejectionRequiresRefresh || current.rejectionConfirmed);
    if (active.data.requests === null || active.data.stale || !isWaiting(request)
      || (current !== undefined && !rejectedCanSubmit)) {
      return Promise.resolve();
    }

    const operationId = ++active.nextOperationId;
    update(active, (state) => ({
      ...state,
      submissions: {
        ...state.submissions,
        [requestId]: {
          phase: "submitting",
          error: null,
          pending: null,
          inFlight: true,
          operationId,
          rejectionRequiresRefresh: false,
          rejectionConfirmed: false,
        },
      },
    }));

    let pending: PendingSubmission;
    try {
      const answerCopy = cloneAnswer(answer);
      const answerIdempotencyKey = globalThis.crypto.randomUUID();
      pending = comment === undefined
        ? { expectedRevision: 0, answerIdempotencyKey, answer: answerCopy }
        : { expectedRevision: 0, answerIdempotencyKey, answer: answerCopy, comment };
    } catch (error: unknown) {
      update(active, (state) => ({
        ...state,
        submissions: {
          ...state.submissions,
          [requestId]: {
            phase: "rejected",
            error: errorMessage(error),
            pending: null,
            inFlight: false,
            operationId,
            rejectionRequiresRefresh: false,
            rejectionConfirmed: true,
          },
        },
      }));
      return Promise.resolve();
    }

    update(active, (state) => ({
      ...state,
      submissions: {
        ...state.submissions,
        [requestId]: {
          phase: "submitting",
          error: null,
          pending,
          inFlight: true,
          operationId,
          rejectionRequiresRefresh: false,
          rejectionConfirmed: false,
        },
      },
    }));
    invalidateLoads(active);
    return performPost(active, requestId, operationId, pending);
  }, [getCapturedActive, invalidateLoads, performPost, update]);

  const retrySameAnswer = useCallback((requestId: string): Promise<void> => {
    const active = getCapturedActive();
    if (active === null) {
      return Promise.resolve();
    }
    const request = findRequest(active.data, requestId);
    const current = active.data.submissions[requestId];
    if (!isWaiting(request) || current?.phase !== "uncertain"
      || current.inFlight || current.pending === null) {
      return Promise.resolve();
    }

    const operationId = ++active.nextOperationId;
    const pending = current.pending;
    update(active, (state) => ({
      ...state,
      submissions: {
        ...state.submissions,
        [requestId]: {
          ...current,
          phase: "submitting",
          error: null,
          inFlight: true,
          operationId,
        },
      },
    }));
    invalidateLoads(active);
    return performPost(active, requestId, operationId, pending);
  }, [getCapturedActive, invalidateLoads, performPost, update]);

  useVisiblePolling(() => {
    void refresh();
  }, POLL_INTERVAL_MS);

  return {
    confirmedAnswerCount: data.confirmedAnswerCount,
    requests: data.requests,
    loading: data.loading,
    error: data.error,
    stale: data.stale,
    submissions: data.submissions,
    refresh,
    submit,
    retrySameAnswer,
  };
}
