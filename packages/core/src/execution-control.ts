import type { ActorProvenance } from "./types.js";

export interface DirectRestartIntentRow {
  id: number;
  intentKey: string;
  taskId: string;
  runId: number;
  sessionId: string;
  expectedCancelFence: number;
  provenance: ActorProvenance;
  createdAt: number;
}

export interface CreateDirectRestartIntentInput {
  intentKey: string;
  taskId: string;
  runId: number;
  sessionId: string;
  expectedCancelFence: number;
  actor: string;
  provenance: ActorProvenance;
}

export interface AssertDirectRestartIntentInput {
  intentId: number;
  taskId: string;
  runId: number;
  sessionId: string;
  expectedCancelFence: number;
  actor: string;
  provenance: ActorProvenance;
}

/** direct restart の外部停止前後に使うadditive authority capability。 */
export interface DirectRestartAuthorityStore {
  createOrGetDirectRestartIntent(input: CreateDirectRestartIntentInput): DirectRestartIntentRow;
  assertDirectRestartIntentCurrent(input: AssertDirectRestartIntentInput): DirectRestartIntentRow;
}
