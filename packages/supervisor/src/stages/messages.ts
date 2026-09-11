// agent.message.v1 の処理ステージ（board-first 通信、docs/contract.md §8/§10）
import { buildInProgressReason } from "@hachi/adapters";
import {
  buildSteerEnvelope,
  isInProgressReason,
  parseAgentMessages,
  parseEnqueuePayload,
  parseSteerPayload,
  redactJsonStrings,
  redactText,
} from "@hachi/core";
import type {
  AgentMessageV1,
  CommunicationPreference,
  DurableSteerStore,
  HachiConfig,
  KanbanStore,
  Logger,
  OrchestratorRequestRow,
  RunRow,
  SessionRef,
  Stage,
  StageDeps,
  StageResult,
  TaskCreateInput,
  TaskRow,
} from "@hachi/core";
import { SUPERVISOR_ACTOR } from "../constants.js";
import { readMessagesCursor, writeMessagesCursor } from "../messages-cursor.js";
import {
  activeAnswerLease,
  isLiveQuestionAwaiting,
  latestQuestionAwaitingPayload,
  QUESTION_ANSWERING_EVENT_TYPE,
  QUESTION_ANSWERING_RELEASED_EVENT_TYPE,
  QUESTION_AWAITING_EVENT_TYPE,
  type QuestionAwaitingPayload,
} from "../question-awaiting.js";
import {
  parseRunMeta,
  reconstructSessionRef,
  sessionStatusLastResultId,
  type ResultWatermarkSessionStatus,
} from "../session-ref.js";
import {
  deliverNativeCodex,
  prepareNativeSteer,
  type StageDepsWithNativeReload,
} from "../native-delivery.js";

const ANSWER_LEASE_SECONDS = 120;

const TERMINAL_ANSWER_RESOLVED_EVENT_TYPE = "orchestrator_request_terminal_answer_resolved";

type TerminalTaskStatus = Extract<TaskRow["status"], "done" | "archived">;

interface TerminalAnswerReconcileResult {
  actions: number;
  notes: string[];
}

function parseEventPayload(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * task_events.payload（JSON文字列）から commentId を安全に取り出す。
 * message_parse_failed イベントの comment id スコープ冪等チェック（docs/contract.md §12.11-4）に使う。
 * パース失敗・型不一致の場合は null を返す。
 */
function extractEventCommentId(payload: string): number | null {
  const parsed = parseEventPayload(payload);
  return typeof parsed?.commentId === "number" ? parsed.commentId : null;
}

/**
 * terminal answer の解決根拠となる2イベントが同一task・exact answer_keyで揃っているかを検証する。
 * malformed payload や別intent/statusは根拠に昇格させない（fail-closed）。
 */
function hasTerminalAnswerEvidence(store: KanbanStore, taskId: string, answerKey: string): boolean {
  const processed = store.listEvents(taskId, "message_processed").some((event): boolean => {
    const payload = parseEventPayload(event.payload);
    return payload?.idempotencyKey === answerKey;
  });
  if (!processed) {
    return false;
  }
  return store.listEvents(taskId, "message_target_terminal").some((event): boolean => {
    const payload = parseEventPayload(event.payload);
    return payload?.idempotencyKey === answerKey &&
      payload.intent === "answer" &&
      (payload.status === "done" || payload.status === "archived");
  });
}

/**
 * exact taskId + answer_key の answering requestだけをresolvedへ進め、根拠をsecret-freeに監査する。
 * 呼び出し側のTx内で使い、expectedRequestId不一致はrollbackさせる。
 */
function resolveTerminalAnswerRequest(
  store: KanbanStore,
  taskId: string,
  answerKey: string,
  terminalStatus: TerminalTaskStatus,
  mode: "consume" | "reconcile",
  expectedRequestId?: string,
): boolean {
  if (!hasTerminalAnswerEvidence(store, taskId, answerKey)) {
    return false;
  }
  const resolved = store.resolveOrchestratorRequestByAnswerKey(taskId, answerKey);
  if (resolved === null) {
    return false;
  }
  if (expectedRequestId !== undefined && resolved.id !== expectedRequestId) {
    throw new Error("terminal answer reconcile の request identity が一致しません");
  }
  store.addEvent(taskId, TERMINAL_ANSWER_RESOLVED_EVENT_TYPE, SUPERVISOR_ACTOR, {
    requestId: resolved.id,
    mode,
    terminalStatus,
    evidence: ["message_processed", "message_target_terminal"],
  });
  return true;
}

/**
 * answer の mark 成功直後に対象taskを再検証し、終端化済みなら通常fallbackへ進まずconsumeする。
 * 呼び出し側のTx内で使い、message_processed・terminal event・request resolveを原子的に確定する。
 */
function consumeTerminalAnswerAfterMark(
  store: KanbanStore,
  taskId: string,
  answerKey: string,
  actor: string,
): TerminalTaskStatus | null {
  const current = store.getTask(taskId);
  if (current === null || (current.status !== "done" && current.status !== "archived")) {
    return null;
  }
  store.addEvent(taskId, "message_target_terminal", actor, {
    status: current.status,
    intent: "answer",
    idempotencyKey: answerKey,
  });
  resolveTerminalAnswerRequest(store, taskId, answerKey, current.status, "consume");
  return current.status;
}

/** 既にterminal consume済みだがansweringに残ったrequestを監査eventだけから冪等回収する。 */
function reconcileTerminalAnswerRequests(store: KanbanStore, apply: boolean): TerminalAnswerReconcileResult {
  let actions = 0;
  const notes: string[] = [];
  const requests = store.listOrchestratorRequests().filter(
    (request): request is OrchestratorRequestRow => request.status === "answering" && request.answerKey !== "",
  );

  for (const request of requests) {
    const target = store.getTask(request.taskId);
    if (
      target === null ||
      (target.status !== "done" && target.status !== "archived") ||
      !hasTerminalAnswerEvidence(store, target.id, request.answerKey)
    ) {
      continue;
    }

    if (!apply) {
      actions += 1;
      notes.push(`dry-run: ${target.id} terminal answer request reconcile予定 (requestId=${request.id})`);
      continue;
    }

    const reconciled = store.transaction((): boolean => {
      const currentRequest = store.getOrchestratorRequest(request.id);
      const currentTarget = store.getTask(request.taskId);
      if (
        currentRequest === null ||
        currentRequest.status !== "answering" ||
        currentRequest.answerKey !== request.answerKey ||
        currentTarget === null ||
        (currentTarget.status !== "done" && currentTarget.status !== "archived")
      ) {
        return false;
      }
      return resolveTerminalAnswerRequest(
        store,
        currentTarget.id,
        currentRequest.answerKey,
        currentTarget.status,
        "reconcile",
        currentRequest.id,
      );
    });
    if (reconciled) {
      actions += 1;
      notes.push(`${target.id}: terminal answer requestをresolvedへreconcile (requestId=${request.id})`);
    }
  }

  return { actions, notes };
}

/** payload から候補キーの中で最初に見つかった文字列を返す。無ければ payload 全体を JSON 化する */
function extractText(payload: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return JSON.stringify(payload);
}

function formatCommandTimestamp(): string {
  return new Date().toISOString();
}

function buildAnswerPrepend(question: string, answer: string): string {
  return [
    `## オーケストレーター回答 (${formatCommandTimestamp()})`,
    "",
    "### 質問",
    question,
    "",
    "### 回答",
    answer,
    "",
  ].join("\n");
}

function prependBody(prefix: string, body: string): string {
  return body.length > 0 ? `${prefix}${body}` : prefix.trimEnd();
}

function sessionRefFromRun(run: RunRow): SessionRef {
  const { serverUrl, model, modelDelivery, nativeCommunication } = parseRunMeta(run.meta);
  return {
    provider: run.provider,
    sessionId: run.sessionId,
    serverUrl,
    model,
    modelDelivery,
    ...(nativeCommunication === undefined ? {} : { nativeCommunication }),
    startedAt: run.startedAt,
  };
}

function isBridgeRef(ref: SessionRef): boolean {
  return ref.serverUrl !== "" && ref.serverUrl !== "direct";
}

/** intent=enqueue: 子タスクを ready で生成し親子リンクを張る */
function handleEnqueue(store: KanbanStore, msg: AgentMessageV1, actor: string): void {
  const payload = parseEnqueuePayload(msg.payload);

  const input: TaskCreateInput = {
    title: payload.title,
    body: payload.body,
    tenant: payload.tenant,
    status: "ready",
  };
  if (payload.profile !== undefined) {
    input.profile = payload.profile;
  }
  if (payload.priority !== undefined) {
    input.priority = payload.priority;
  }

  const child = store.createTask(input, actor);
  store.link(msg.to.taskId, child.id);
  // 明示 binding は subtree の途中で失われないよう、enqueue された子へ継承する（contract §55.1）。
  for (const binding of store.listTaskOrchestratorBindings(msg.to.taskId)) {
    store.bindTaskToOrchestrator(child.id, binding.orchestratorId, binding.role);
  }
  store.addComment(msg.to.taskId, actor, `enqueue 受理: ${child.id}`);
}

/** intent=steer: 対象タスクが進行中セッションであれば adapter.inject() で注入する */
function communicationPreference(msg: AgentMessageV1): CommunicationPreference {
  const communication = msg.payload["communication"];
  if (typeof communication !== "object" || communication === null || Array.isArray(communication)) {
    return "auto";
  }
  const preference = (communication as Record<string, unknown>)["preference"];
  return preference === "hachi" || preference === "native" || preference === "auto" ? preference : "auto";
}

function communicationAttemptId(msg: AgentMessageV1): string | undefined {
  const topLevel = msg.payload["communicationAttemptId"];
  if (typeof topLevel === "string" && topLevel !== "") {
    return topLevel;
  }
  const communication = msg.payload["communication"];
  if (typeof communication !== "object" || communication === null || Array.isArray(communication)) {
    return undefined;
  }
  const nested = (communication as Record<string, unknown>)["communicationAttemptId"] ??
    (communication as Record<string, unknown>)["attemptId"];
  return typeof nested === "string" && nested !== "" ? nested : undefined;
}

async function handleSteer(
  deps: StageDepsWithNativeReload,
  msg: AgentMessageV1,
  actor: string,
  logger: Logger,
  now: number,
): Promise<void> {
  const { store, adapters } = deps;
  let config: HachiConfig = deps.config;
  if (deps.reloadConfig !== undefined) {
    config = deps.reloadConfig();
  }
  const steerStore = store as KanbanStore & DurableSteerStore;
  const target = store.getTask(msg.to.taskId);
  if (target === null) {
    throw new Error(`steer 対象タスクが見つかりません: ${msg.to.taskId}`);
  }
  if (target.status !== "blocked" || !isInProgressReason(target.blockReason)) {
    logger.warn("steer: 対象タスクは進行中ではありません", { taskId: msg.to.taskId });
    const deliveryId = msg.payload["deliveryId"];
    if (typeof deliveryId === "string") {
      const delivery = steerStore.getSteerDelivery(deliveryId);
      if (delivery !== null) {
        steerStore.staleCancelSteersForRun(delivery.runId, delivery.sessionId, actor, "target-not-in-progress");
      }
    }
    store.addComment(msg.to.taskId, actor, "steer 失敗: 対象タスクは進行中ではありません");
    return;
  }

  const ref = reconstructSessionRef(store, target.id);
  if (ref === null) {
    logger.warn("steer: task_runsから session を再構築できません", { taskId: msg.to.taskId });
    const deliveryId = msg.payload["deliveryId"];
    if (typeof deliveryId === "string") {
      const delivery = steerStore.getSteerDelivery(deliveryId);
      if (delivery !== null) {
        steerStore.staleCancelSteersForRun(delivery.runId, delivery.sessionId, actor, "session-ref-missing");
      }
    }
    store.addComment(msg.to.taskId, actor, "steer 失敗: セッション情報を再構築できませんでした");
    return;
  }

  const payload = parseSteerPayload(msg.payload);
  const deliveryId = msg.payload["deliveryId"];
  const runId = msg.payload["runId"];
  const sessionId = msg.payload["sessionId"];
  const cancelFence = msg.payload["cancelFence"];
  if (
    typeof deliveryId !== "string" || deliveryId === "" || typeof runId !== "number" || !Number.isInteger(runId) ||
    typeof sessionId !== "string" || sessionId === "" || typeof cancelFence !== "number" ||
    !Number.isInteger(cancelFence) || cancelFence < 0
  ) {
    throw new Error("steer lifecycle metadata (deliveryId/runId/sessionId/cancelFence) が不正です");
  }
  const delivery = steerStore.getSteerDeliveryByMessageKey(msg.idempotencyKey);
  if (delivery === null || delivery.id !== deliveryId) {
    throw new Error("steer delivery が message key/lifecycle metadata と一致しません");
  }
  if (["superseded", "stale_cancelled", "failed"].includes(delivery.status)) {
    logger.warn("steer: 無効化済みdeliveryの注入をskipします", { taskId: target.id, deliveryId, status: delivery.status });
    return;
  }
  if (delivery.status !== "queued") {
    return;
  }
  const run = store.getLatestOpenRun(target.id);
  if (
    run === null || run.id !== runId || run.sessionId !== sessionId || ref.sessionId !== sessionId ||
    delivery.runId !== runId || delivery.sessionId !== sessionId || delivery.expectedCancelFence !== cancelFence
  ) {
    steerStore.staleCancelSteersForRun(delivery.runId, delivery.sessionId, actor, "delivery-fence-mismatch");
    throw new Error("steer delivery の task/run/session/fence が current session と一致しません");
  }
  if (steerStore.currentRunCancelFence(runId) !== cancelFence || cancelFence > 0) {
    steerStore.staleCancelSteersForRun(runId, sessionId, actor, "cancel-fenced-before-inject");
    throw new Error("cancel 開始後の通常 steer 注入を拒否しました");
  }

  const preference = communicationPreference(msg);
  const nativeAttemptId = communicationAttemptId(msg);
  const prepared = await prepareNativeSteer({
    deps,
    config,
    task: target,
    run,
    ref,
    deliveryId: delivery.id,
    messageKey: msg.idempotencyKey,
    message: payload.message,
    sourceProvider: msg.from.provider,
    sourceSessionId: msg.from.sessionId,
    preference,
    now,
    ...(nativeAttemptId === undefined ? {} : { communicationAttemptId: nativeAttemptId }),
  }, msg.payload);
  if (prepared.kind === "refused") {
    store.transaction(() => {
      store.addEvent(target.id, "communication_delivery_attempted", actor, {
        deliveryId: delivery.id,
        rollout: prepared.rollout,
        preference,
        decision: prepared.decision,
        implementation: "fail-closed",
        reason: prepared.reason,
      });
      steerStore.failSteerDelivery(
        delivery.id,
        `native communication unavailable: ${prepared.reason}`,
        actor,
      );
    });
    return;
  }
  if (prepared.kind === "relay-wait") {
    store.addEvent(target.id, "communication_delivery_attempted", actor, {
      deliveryId: delivery.id,
      rollout: prepared.rollout,
      preference,
      decision: prepared.decision,
      implementation: "claude-relay-recorded",
      attemptId: prepared.attempt?.id ?? null,
      reason: prepared.reason,
    });
    return;
  }
  if (prepared.kind === "native") {
    const latestTask = store.getTask(target.id);
    const latestRun = store.getLatestOpenRun(target.id);
    const latestRef = latestRun === null ? null : sessionRefFromRun(latestRun);
    const freshNativeRef = latestRef === null || prepared.targetEvidence === null
      ? latestRef
      : { ...latestRef, nativeCommunication: prepared.targetEvidence };
    if (
      latestTask === null || latestTask.status !== "blocked" || latestRun === null || latestRun.id !== run.id ||
      freshNativeRef === null || latestRun.sessionId !== run.sessionId ||
      steerStore.currentRunCancelFence(run.id) !== cancelFence
    ) {
      throw new Error("native steer の probe 後に task/run/session/fence が変化しました");
    }
    const result = await deliverNativeCodex({
      deps,
      config,
      task: latestTask,
      run: latestRun,
      ref: freshNativeRef,
      deliveryId: delivery.id,
      messageKey: msg.idempotencyKey,
      message: payload.message,
      sourceProvider: msg.from.provider,
      sourceSessionId: msg.from.sessionId,
      preference,
      now,
    }, prepared, payload.message);
    store.addEvent(target.id, "communication_delivery_attempted", actor, {
      deliveryId: delivery.id,
      rollout: prepared.rollout,
      preference,
      decision: prepared.decision,
      implementation: "codex-native-adapter",
      attemptId: prepared.attempt?.id ?? null,
      outcome: result.status,
      receiptId: result.receiptId,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    });
    return;
  }

  // off/observe/draining、canary未選出、cross-provider は従来 Hachi adapter を使う。
  store.transaction(() => {
    store.addEvent(target.id, "communication_delivery_attempted", actor, {
      deliveryId: delivery.id,
      rollout: prepared.rollout,
      preference,
      decision: prepared.decision,
      implementation: "hachi-adapter-inject",
    });
    steerStore.claimSteerDispatch(delivery.id, runId, sessionId, cancelFence, actor);
  });
  try {
    await adapters[ref.provider].inject(ref, buildSteerEnvelope(delivery, payload.message));
    steerStore.markSteerTransportAccepted(delivery.id, runId, sessionId, cancelFence, actor);
  } catch (error) {
    const current = steerStore.getSteerDelivery(delivery.id);
    if (current?.status === "dispatching") {
      steerStore.markSteerDispatchUncertain(
        delivery.id,
        error instanceof Error ? error.message : String(error),
        actor,
      );
    }
    throw error;
  }
}

/** intent=escalate: コメント追記 + 未 blocked ならば block(user-decision:) で人間に付け替える */
function handleEscalate(store: KanbanStore, msg: AgentMessageV1, actor: string): void {
  const target = store.getTask(msg.to.taskId);
  if (target === null) {
    throw new Error(`escalate 対象タスクが見つかりません: ${msg.to.taskId}`);
  }

  // escalate の payload はワーカー由来の自由文のため、コメント/block_reason へ書く前に
  // redactText を必ず通す（docs/contract.md §12.7-3）。生データは artifacts のみに置く。
  const summary = redactText(extractText(msg.payload, ["summary", "message", "reason"]));
  store.addComment(msg.to.taskId, actor, summary);

  if (target.status !== "blocked") {
    store.block(msg.to.taskId, `user-decision: ${summary}`, actor, "human");
  }
}

interface ClaimedAnswerLease {
  kind: "claimed";
  run: RunRow;
  ref: SessionRef;
  question: QuestionAwaitingPayload;
}

interface FallbackAnswer {
  kind: "fallback";
}

interface AlreadyProcessedAnswer {
  kind: "processed";
}

interface DeferredAnswer {
  kind: "deferred";
}

interface AnswerHandled {
  kind: "handled";
}

interface RetryAnswer {
  kind: "retry";
  reason: string;
}

type AnswerClaimResult = ClaimedAnswerLease | FallbackAnswer | AlreadyProcessedAnswer | DeferredAnswer;

type AnswerHandleResult = AnswerHandled | DeferredAnswer | RetryAnswer;

function fallbackAnswer(
  store: KanbanStore,
  msg: AgentMessageV1,
  actor: string,
  text: string,
  target: TaskRow,
): void {
  const current = store.getTask(target.id);
  if (current === null) {
    throw new Error(`answer 対象タスクが見つかりません: ${target.id}`);
  }
  const isNew = store.markMessageProcessed(current.id, msg.idempotencyKey, actor);
  if (!isNew) {
    return;
  }
  if (consumeTerminalAnswerAfterMark(store, current.id, msg.idempotencyKey, actor) !== null) {
    return;
  }
  if (current.status === "blocked" && current.blockReason.startsWith("worker-question:")) {
    const question = current.blockReason.slice("worker-question:".length).trim();
    store.updateBody(current.id, prependBody(buildAnswerPrepend(question, text), current.body), actor);
    store.addComment(current.id, actor, `オーケストレーター回答:\n${text}`);
    store.addEvent(current.id, "question_answered", actor, {
      question,
      injected: false,
      idempotencyKey: msg.idempotencyKey,
    });
    store.resolveOrchestratorRequestByAnswerKey(current.id, msg.idempotencyKey);
    store.unblock(current.id, "ready", actor);
    return;
  }
  store.addComment(current.id, actor, text);
  store.resolveOrchestratorRequestByAnswerKey(current.id, msg.idempotencyKey);
}

function claimAnswerLease(
  store: KanbanStore,
  msg: AgentMessageV1,
  actor: string,
  now: number,
): AnswerClaimResult {
  return store.transaction((): AnswerClaimResult => {
    if (store.hasProcessedMessage(msg.idempotencyKey)) {
      return { kind: "processed" };
    }

    const current = store.getTask(msg.to.taskId);
    if (current === null) {
      throw new Error(`answer 対象タスクが見つかりません: ${msg.to.taskId}`);
    }
    if (current.status !== "blocked" || !current.blockReason.startsWith("worker-question:")) {
      return { kind: "fallback" };
    }

    const run = store.getLatestOpenRun(current.id);
    if (run === null) {
      return { kind: "fallback" };
    }

    const ref = sessionRefFromRun(run);
    const questionEvents = store.listEvents(current.id, QUESTION_AWAITING_EVENT_TYPE);
    if (!isBridgeRef(ref) || !isLiveQuestionAwaiting(current, run, questionEvents, now)) {
      return { kind: "fallback" };
    }

    const question = latestQuestionAwaitingPayload(questionEvents, run.sessionId);
    if (question === null) {
      return { kind: "fallback" };
    }

    const activeLease = activeAnswerLease(store.listEvents(current.id), run.sessionId, now);
    if (activeLease !== null) {
      if (activeLease.idempotencyKey === msg.idempotencyKey) {
        return { kind: "deferred" };
      }
      return { kind: "fallback" };
    }

    store.addEvent(current.id, QUESTION_ANSWERING_EVENT_TYPE, actor, {
      sessionId: run.sessionId,
      runId: run.id,
      questionId: question.questionId,
      idempotencyKey: msg.idempotencyKey,
      leaseUntil: now + ANSWER_LEASE_SECONDS,
    });

    return { kind: "claimed", run, ref, question };
  });
}

function releaseAnswerLeaseForMessage(
  store: KanbanStore,
  taskId: string,
  claim: ClaimedAnswerLease,
  actor: string,
  idempotencyKey: string,
): void {
  store.addEvent(taskId, QUESTION_ANSWERING_RELEASED_EVENT_TYPE, actor, {
    sessionId: claim.ref.sessionId,
    runId: claim.run.id,
    questionId: claim.question.questionId,
    idempotencyKey,
  });
}

async function ensureClaimBaselineLastResultId(
  store: KanbanStore,
  adapters: StageDeps["adapters"],
  claim: ClaimedAnswerLease,
  actor: string,
  target: TaskRow,
  now: number,
): Promise<boolean> {
  if (claim.question.baselineResultWatermark !== undefined && claim.question.baselineLastResultId !== undefined) {
    return true;
  }

  let status: ResultWatermarkSessionStatus;
  try {
    status = await adapters[claim.ref.provider].status(claim.ref);
  } catch {
    return false;
  }
  const lastResultId = sessionStatusLastResultId(status);
  if (lastResultId <= 0) {
    return false;
  }

  let supplemented = false;
  store.transaction(() => {
    const current = store.getTask(target.id);
    const openRun = store.getOpenRunByTaskSession(target.id, claim.ref.sessionId);
    const questionEvents = store.listEvents(target.id, QUESTION_AWAITING_EVENT_TYPE);
    const lease = activeAnswerLease(store.listEvents(target.id), claim.ref.sessionId, now);
    const latestQuestion = latestQuestionAwaitingPayload(questionEvents, claim.ref.sessionId);
    if (
      current === null ||
      current.status !== "blocked" ||
      !current.blockReason.startsWith("worker-question:") ||
      openRun === null ||
      openRun.id !== claim.run.id ||
      !isLiveQuestionAwaiting(current, claim.run, questionEvents, now) ||
      lease === null ||
      latestQuestion === null ||
      latestQuestion.questionId !== claim.question.questionId
    ) {
      return;
    }
    if (latestQuestion.baselineResultWatermark !== undefined && latestQuestion.baselineLastResultId !== undefined) {
      supplemented = true;
      return;
    }
    store.addEvent(target.id, QUESTION_AWAITING_EVENT_TYPE, actor, {
      ...latestQuestion,
      baselineResultWatermark: lastResultId,
      baselineLastResultId: lastResultId,
    });
    supplemented = true;
  });
  return supplemented;
}

/** intent=answer: live 注入可能なら lease-first で inject、不可なら body prepend + ready 再投入 */
async function handleAnswer(
  store: KanbanStore,
  adapters: StageDeps["adapters"],
  msg: AgentMessageV1,
  actor: string,
  logger: Logger,
  now: number,
): Promise<AnswerHandleResult> {
  const target = store.getTask(msg.to.taskId);
  if (target === null) {
    throw new Error(`answer 対象タスクが見つかりません: ${msg.to.taskId}`);
  }

  // contract §55.2: active orchestrator request がある answer は、fenced CLI が事前に
  // status=answering + answer_key を確定したものだけを配送する。旧 task answer / msg send による迂回を拒否。
  const routedRequest = store.getActiveOrchestratorRequestByTask(target.id);
  if (
    routedRequest !== null &&
    (routedRequest.status !== "answering" || routedRequest.answerKey !== msg.idempotencyKey)
  ) {
    store.transaction(() => {
      const isNew = store.markMessageProcessed(target.id, msg.idempotencyKey, actor);
      if (!isNew || consumeTerminalAnswerAfterMark(store, target.id, msg.idempotencyKey, actor) !== null) {
        return;
      }
      store.addEvent(target.id, "orchestrator_answer_unauthorized", actor, {
        requestId: routedRequest.id,
        idempotencyKey: msg.idempotencyKey,
      });
      store.addComment(target.id, actor, "answer を拒否しました: active orchestrator request の session fencing がありません");
    });
    return { kind: "handled" };
  }

  // answer の payload もワーカー由来の自由文のため redactText を通す（docs/contract.md §12.7-3）
  const text = redactText(extractText(msg.payload, ["message", "answer", "text"]));
  const claim = claimAnswerLease(store, msg, actor, now);
  if (claim.kind === "processed") {
    return { kind: "handled" };
  }
  if (claim.kind === "deferred") {
    return { kind: "deferred" };
  }
  if (claim.kind === "fallback") {
    store.transaction(() => fallbackAnswer(store, msg, actor, text, target));
    return { kind: "handled" };
  }

  const canLiveInject = await ensureClaimBaselineLastResultId(store, adapters, claim, actor, target, now);
  if (!canLiveInject) {
    store.transaction(() => {
      releaseAnswerLeaseForMessage(store, target.id, claim, actor, msg.idempotencyKey);
      fallbackAnswer(store, msg, actor, text, target);
    });
    return { kind: "handled" };
  }

  try {
    await adapters[claim.ref.provider].inject(claim.ref, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("answer: live inject に失敗しました", {
      taskId: target.id,
      sessionId: claim.ref.sessionId,
      error: redactText(message),
    });
    store.transaction(() => {
      store.addEvent(target.id, "question_answer_inject_failed", actor, {
        sessionId: claim.ref.sessionId,
        runId: claim.run.id,
        questionId: claim.question.questionId,
        idempotencyKey: msg.idempotencyKey,
        error: redactText(message),
      });
      releaseAnswerLeaseForMessage(store, target.id, claim, actor, msg.idempotencyKey);
      store.failOrchestratorRequestAnswer(target.id, msg.idempotencyKey);
    });
    return { kind: "handled" };
  }

  let needsRetry = false;
  store.transaction(() => {
    const current = store.getTask(target.id);
    const openRun = store.getOpenRunByTaskSession(target.id, claim.ref.sessionId);
    const questionEvents = store.listEvents(target.id, QUESTION_AWAITING_EVENT_TYPE);
    const lease = activeAnswerLease(store.listEvents(target.id), claim.ref.sessionId, now);
    if (
      current === null ||
      current.status !== "blocked" ||
      !current.blockReason.startsWith("worker-question:") ||
      openRun === null ||
      openRun.id !== claim.run.id ||
      !isLiveQuestionAwaiting(current, claim.run, questionEvents, now) ||
      lease === null ||
      lease.idempotencyKey !== msg.idempotencyKey
    ) {
      store.addEvent(target.id, "question_answer_inject_failed", actor, {
        sessionId: claim.ref.sessionId,
        runId: claim.run.id,
        questionId: claim.question.questionId,
        idempotencyKey: msg.idempotencyKey,
        error: "open run closed before mark",
      });
      releaseAnswerLeaseForMessage(store, target.id, claim, actor, msg.idempotencyKey);
      needsRetry = true;
      return;
    }

    const isNew = store.markMessageProcessed(target.id, msg.idempotencyKey, actor);
    if (!isNew) {
      releaseAnswerLeaseForMessage(store, target.id, claim, actor, msg.idempotencyKey);
      return;
    }
    store.addComment(target.id, actor, `オーケストレーター回答を live inject しました:\n${text}`);
    store.addEvent(target.id, "question_answered", actor, {
      sessionId: claim.ref.sessionId,
      runId: claim.run.id,
      questionId: claim.question.questionId,
      injected: true,
      idempotencyKey: msg.idempotencyKey,
    });
    store.resolveOrchestratorRequestByAnswerKey(target.id, msg.idempotencyKey);
    store.updateBlockReason(target.id, buildInProgressReason(claim.ref, current.title), actor);
    releaseAnswerLeaseForMessage(store, target.id, claim, actor, msg.idempotencyKey);
  });
  if (needsRetry) {
    return { kind: "retry", reason: "post-inject validation failed" };
  }
  return { kind: "handled" };
}

export const messagesStage: Stage = {
  name: "messages",

  async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
    const { store, adapters, logger, env } = deps;
    const notes: string[] = [];
    let actions = 0;

    const reconciliation = reconcileTerminalAnswerRequests(store, apply);
    actions += reconciliation.actions;
    notes.push(...reconciliation.notes);

    // 全タスク×全コメントの毎tickフルスキャンではなく、処理済みカーソル（最終 comment id）からの
    // 増分走査にする（docs/contract.md §12.6-5）。dry-run ではカーソルを進めない。
    const cursorStart = readMessagesCursor(env);
    const comments = store.listMessageFenceComments(cursorStart);
    let maxSeenId = cursorStart;

    for (const comment of comments) {
      let commentDeferred = false;

      const task = store.getTask(comment.taskId);
      if (task === null) {
        logger.warn("messages: コメント宛先タスクが見つかりません", {
          taskId: comment.taskId,
          commentId: comment.id,
        });
        if (comment.id > maxSeenId) {
          maxSeenId = comment.id;
        }
        continue;
      }
      // 契約 §12.18-1: 処理可否のゲートは「コメントが載っているタスク」ではなく
      // メッセージごとの対象タスク（msg.to.taskId）で判定する（このコメントのタスク自体の
      // 状態では skip しない）。done タスク上のコメントから非終端タスク宛の followup
      // （enqueue 等）を正当なパターンとして許容するため。

      const { messages, errors } = parseAgentMessages(comment.body);
      if (errors.length > 0) {
        logger.warn("messages: agent.message.v1 パース失敗", {
          taskId: task.id,
          commentId: comment.id,
          errorCount: errors.length,
        });

        // 契約 §12.11-4: parse 失敗ブロックを黙って読み飛ばさず、当該タスクへ監査イベントを記録して
        // からカーソルを進める。comment id スコープで冪等（同一コメントの再走査で重複記録しない）。
        const alreadyRecorded = store
          .listEvents(task.id, "message_parse_failed")
          .some((event) => extractEventCommentId(event.payload) === comment.id);
        if (!alreadyRecorded) {
          actions += 1;
          if (apply) {
            store.addEvent(task.id, "message_parse_failed", SUPERVISOR_ACTOR, {
              commentId: comment.id,
              errorCount: errors.length,
              reasons: errors.map((e) => e.reason),
            });
          } else {
            notes.push(`dry-run: ${task.id} message_parse_failed 記録予定 (commentId=${comment.id})`);
          }
        }
      }

      for (const rawMsg of messages) {
        if (store.hasProcessedMessage(rawMsg.idempotencyKey)) {
          continue;
        }

        actions += 1;

        if (!apply) {
          notes.push(`dry-run: ${rawMsg.intent} -> ${rawMsg.to.taskId}`);
          continue;
        }

        // worker 発メッセージは CLI（hachi msg send）を経由しないため、intent 処理の前に payload の
        // 全文字列リーフを redactJsonStrings で redact した msg を以降の処理へ渡す
        // （docs/contract.md §12.15-1）。CLI 側 redaction は defense in depth として維持する。
        const msg: AgentMessageV1 = {
          ...rawMsg,
          payload: redactJsonStrings(rawMsg.payload) as Record<string, unknown>,
        };

        // 契約 §12.18-1: 処理可否は対象タスク（msg.to.taskId）の状態で判定する。
        const target = store.getTask(msg.to.taskId);

        if (target === null) {
          // 対象タスクが存在しない: コメントのタスク（task.id）へ message_target_missing を記録し、
          // 同じ Tx 内で mark（poison message 化防止）。対象が存在しないため task_events の
          // FK 制約上、記録先はコメントのタスクしか選べない（契約 §12.18-1）。
          store.transaction(() => {
            const isNew = store.markMessageProcessed(task.id, msg.idempotencyKey, SUPERVISOR_ACTOR);
            if (!isNew) {
              return;
            }
            store.addEvent(task.id, "message_target_missing", SUPERVISOR_ACTOR, {
              targetTaskId: msg.to.taskId,
              idempotencyKey: msg.idempotencyKey,
            });
          });
          notes.push(`${task.id}: ${msg.intent} 宛先タスク不存在 (${msg.to.taskId})`);
          continue;
        }

        if (target.status === "done" || target.status === "archived") {
          // 対象タスクが終端状態: intent 処理はせず message_target_terminal を対象タスクへ記録し、
          // 対象タスクの id で mark する（終端タスクの不変条件保護。契約 §12.18-1）。answerだけは
          // exact answer_keyのanswering requestを同じTxでresolvedへ収束させ、task自体は変更しない。
          store.transaction(() => {
            const isNew = store.markMessageProcessed(target.id, msg.idempotencyKey, SUPERVISOR_ACTOR);
            if (!isNew) {
              return;
            }
            const freshTarget = store.getTask(target.id);
            if (freshTarget === null || (freshTarget.status !== "done" && freshTarget.status !== "archived")) {
              throw new Error("terminal message consume中に対象taskの終端状態が一致しなくなりました");
            }
            store.addEvent(target.id, "message_target_terminal", SUPERVISOR_ACTOR, {
              status: freshTarget.status,
              intent: msg.intent,
              idempotencyKey: msg.idempotencyKey,
            });
            if (msg.intent === "answer") {
              resolveTerminalAnswerRequest(
                store,
                freshTarget.id,
                msg.idempotencyKey,
                freshTarget.status,
                "consume",
              );
            }
          });
          notes.push(`${target.id}: ${msg.intent} 宛先タスクが終端状態(${target.status})のため skip`);
          continue;
        }

        try {
          if (msg.intent === "answer") {
            const answerResult = await handleAnswer(store, adapters, msg, SUPERVISOR_ACTOR, logger, now);
            if (answerResult.kind === "deferred") {
              commentDeferred = true;
              notes.push(`${target.id}: answer は同一 idempotencyKey の active lease 中のため次 tick で再試行`);
              break;
            }
            if (answerResult.kind === "retry") {
              commentDeferred = true;
              notes.push(`${target.id}: answer は ${answerResult.reason} のため次 tick で再走査`);
              break;
            }
          } else if (msg.intent === "steer") {
            // steer は外部副作用（inject）を持つため、mark を先に確定させてから inject する（mark-first）。
            // mark が false（既に別経路が処理済み）の場合は inject をスキップし、二重注入を防ぐ
            // （at-most-once, docs/contract.md §12.10-1）。
            const isNew = store.markMessageProcessed(target.id, msg.idempotencyKey, SUPERVISOR_ACTOR);
            if (isNew) {
              await handleSteer(deps, msg, SUPERVISOR_ACTOR, logger, now);
            }
          } else {
            // enqueue/escalate は DB-only 同期処理のため、mark を Tx の先頭で行い戻り値で
            // handler の実行有無をゲートする（mark-first, docs/contract.md §12.10-1）。false（既処理）
            // なら handler を実行せず Tx を終える。handler が throw した場合は Tx ごと rollback され
            // （直前の mark も取り消される）、catch 節で改めて mark（新規 Tx）してエラーコメントを残す
            // （poison message 化防止を維持）。
            let terminalStatus: string | null = null;
            store.transaction(() => {
              const isNew = store.markMessageProcessed(target.id, msg.idempotencyKey, SUPERVISOR_ACTOR);
              if (!isNew) {
                return;
              }

              // 契約 §12.19-3: mark 直後（Tx 内）で対象タスクを再読込し、done/archived 化していないか
              // 再検証する。target のスナップショット取得（Tx 開始前）から mark までの間隙で終端化
              // された場合に handler を誤って実行しないための最終ゲート（終端タスクの不変条件保護）。
              const freshTarget = store.getTask(target.id);
              if (freshTarget !== null && (freshTarget.status === "done" || freshTarget.status === "archived")) {
                terminalStatus = freshTarget.status;
                store.addEvent(target.id, "message_target_terminal", SUPERVISOR_ACTOR, {
                  status: freshTarget.status,
                  intent: msg.intent,
                  idempotencyKey: msg.idempotencyKey,
                });
                return;
              }

              if (msg.intent === "enqueue") {
                handleEnqueue(store, msg, SUPERVISOR_ACTOR);
              } else {
                handleEscalate(store, msg, SUPERVISOR_ACTOR);
              }
            });

            if (terminalStatus !== null) {
              notes.push(`${target.id}: ${msg.intent} 処理中に対象タスクが終端状態(${terminalStatus})化したため skip`);
              continue;
            }
          }
          notes.push(`${target.id}: ${msg.intent} 処理完了`);
        } catch (err) {
          // poison message 化を防ぐため、rollback で取り消された（steer の場合は既に成立済みの）mark を
          // 改めて記録し直す。steer 側は既に mark 済みで UNIQUE 衝突により false が返るだけなので
          // 戻り値は無視してよい（docs/contract.md §12.10-1）。
          const message = err instanceof Error ? err.message : String(err);
          logger.error("messages: 処理に失敗しました", {
            taskId: target.id,
            intent: msg.intent,
            error: redactText(message),
          });
          store.addComment(target.id, SUPERVISOR_ACTOR, `agent.message.v1 処理エラー: ${redactText(message)}`);
          if (msg.intent === "answer") {
            store.addEvent(target.id, "question_answer_processing_failed", SUPERVISOR_ACTOR, {
              idempotencyKey: msg.idempotencyKey,
              error: redactText(message),
            });
            notes.push(`${target.id}: ${msg.intent} 処理エラー`);
            continue;
          }
          store.markMessageProcessed(target.id, msg.idempotencyKey, SUPERVISOR_ACTOR);
          notes.push(`${target.id}: ${msg.intent} 処理エラー`);
        }
      }

      if (commentDeferred) {
        break;
      }
      if (comment.id > maxSeenId) {
        maxSeenId = comment.id;
      }
    }

    // dry-run ではカーソルを進めない（docs/contract.md §12.6-5）。新規コメントが無ければ書き込み自体をskipする。
    if (apply && maxSeenId > cursorStart) {
      writeMessagesCursor(env, maxSeenId, logger);
    }

    return { name: "messages", actions, skipped: false, notes };
  },
};
