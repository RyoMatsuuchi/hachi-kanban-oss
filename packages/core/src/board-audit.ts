// =============================================================================
// board 全体に対する管理操作の durable 監査面（docs/contract.md §40.6）。
// task に属さない操作を架空 task event へ寄せず、構造化 actor provenance とともに保持する。
// =============================================================================

import type { ActorProvenance } from "./types.js";

export interface BoardAuditEventRow {
  id: number;
  eventType: string;
  actor: string;
  payload: Record<string, unknown>;
  provenance: ActorProvenance;
  createdAt: number;
}

export interface AddBoardAuditEventInput {
  eventType: string;
  actor: string;
  payload: Record<string, unknown>;
  provenance: ActorProvenance;
}

/**
 * types.ts の凍結契約へ影響させない additive Store 面。
 * CLI は実 Store がこの面を実装していることを fail-closed で確認してから利用する。
 */
export interface BoardAuditStore {
  assertActiveOrchestratorPrincipal(provenance: ActorProvenance): void;
  addBoardAuditEvent(input: AddBoardAuditEventInput): BoardAuditEventRow;
  listBoardAuditEvents(eventType?: string, limit?: number): BoardAuditEventRow[];
}
