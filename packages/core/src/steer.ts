// Durable steer lifecycle の公開型（docs/contract.md §58）。
// 凍結された共有契約 types.ts とは分離し、段階導入できる additive API とする。

export type SteerDeliveryStatus =
  | "queued"
  | "dispatching"
  | "transport_accepted"
  | "session_observed"
  | "acknowledged"
  | "uncertain"
  | "superseded"
  | "stale_cancelled"
  | "failed";

export interface SteerDeliveryRow {
  id: string;
  taskId: string;
  runId: number;
  sessionId: string;
  messageKey: string;
  sequence: number;
  status: SteerDeliveryStatus;
  supersedesId: string | null;
  expectedCancelFence: number;
  observedMessageId: string;
  lastError: string;
  createdAt: number;
  updatedAt: number;
  observedAt: number | null;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
}

/**
 * delivery が現在の task run/session/fence を指すかを表す読み取り専用の判定。
 * lifecycle status とは独立しており、transport_accepted 等を適用済みへ昇格させない。
 */
export type SteerDeliveryTargetState =
  | "current"
  | "stale_run"
  | "stale_session"
  | "stale_cancel_fence";

/**
 * Core/CLI/Web が共有する durable steer の additive read model（docs/contract.md §65.4）。
 * lastError は読み取り境界でも再度 redact し、current target との差分を推測なしで示す。
 */
export interface SteerDeliveryReadModel extends SteerDeliveryRow {
  targetState: SteerDeliveryTargetState;
  currentRunId: number | null;
  currentSessionId: string | null;
  runCancelFence: number;
}

/** types.ts の凍結済み KanbanReadView を変更せず追加する readonly capability。 */
export interface DurableSteerReadView {
  steerDeliveries(taskId?: string): SteerDeliveryReadModel[];
}

export interface CreateSteerDeliveryInput {
  taskId: string;
  runId: number;
  sessionId: string;
  messageKey: string;
  expectedCancelFence: number;
  supersedesId?: string;
  actor: string;
}

export interface ObserveSteerDeliveryInput {
  deliveryId: string;
  expectedRunId: number;
  expectedSessionId: string;
  expectedCancelFence: number;
  observedMessageId: string;
  acknowledged: boolean;
  actor: string;
}

/** types.ts の KanbanStore を変更せず利用する additive capability。 */
export interface DurableSteerStore {
  currentRunCancelFence(runId: number): number;
  createOrGetSteerDelivery(input: CreateSteerDeliveryInput): SteerDeliveryRow;
  getSteerDelivery(id: string): SteerDeliveryRow | null;
  getSteerDeliveryByMessageKey(messageKey: string): SteerDeliveryRow | null;
  listSteerDeliveries(taskId?: string): SteerDeliveryRow[];
  claimSteerDispatch(
    deliveryId: string,
    expectedRunId: number,
    expectedSessionId: string,
    expectedCancelFence: number,
    actor: string,
  ): SteerDeliveryRow;
  markSteerTransportAccepted(
    deliveryId: string,
    expectedRunId: number,
    expectedSessionId: string,
    expectedCancelFence: number,
    actor: string,
  ): SteerDeliveryRow;
  observeSteerDelivery(input: ObserveSteerDeliveryInput): SteerDeliveryRow;
  markSteerDispatchUncertain(deliveryId: string, error: string, actor: string): SteerDeliveryRow;
  failSteerDelivery(deliveryId: string, error: string, actor: string): SteerDeliveryRow;
  staleCancelSteersForRun(runId: number, sessionId: string, actor: string, reason: string): number;
}

export interface SteerEnvelopeV1 {
  schema: "hachi.steer.v1";
  deliveryId: string;
  taskId: string;
  runId: number;
  sessionId: string;
  sequence: number;
  cancelFence: number;
}

export function buildSteerEnvelope(delivery: SteerDeliveryRow, message: string): string {
  const envelope: SteerEnvelopeV1 = {
    schema: "hachi.steer.v1",
    deliveryId: delivery.id,
    taskId: delivery.taskId,
    runId: delivery.runId,
    sessionId: delivery.sessionId,
    sequence: delivery.sequence,
    cancelFence: delivery.expectedCancelFence,
  };
  return ["```hachi-steer-v1", JSON.stringify(envelope), "```", "", message].join("\n");
}
