// =============================================================================
// done 到達由来の pure read model（docs/contract.md §62）。
// 表示 actor 文字列を権威として扱わず、確定 event payload と構造化 provenance だけから導出する。
// =============================================================================

import type { EventRow } from "./types.js";

export type DoneOrigin = "gate_passed" | "orchestrator_host_finalize" | "human_decision" | "unknown";
export type DoneSignalKind = "irrelevant" | "valid-done" | "invalid-done-signal";

export interface DoneOriginCounts {
  gatePassed: number;
  orchestratorHostFinalize: number;
  humanDecision: number;
  unknown: number;
}

export interface DoneOriginStats {
  total: number;
  counts: DoneOriginCounts;
  /** gate_passed / total。分母0なら0。 */
  automaticCompletionRate: number;
  /** (orchestrator_host_finalize + human_decision) / total。分母0なら0。 */
  manualRecoveryRate: number;
  /** unknown / total。分母0なら0。 */
  unknownRate: number;
}

interface DoneTransitionPayload {
  from: string;
  to: "done";
  sessionId?: string;
  outcome?: string;
  verdict?: string;
  confidence?: string;
  kind?: string;
  source?: string;
  nonce?: string;
}

interface DoneSignalAnalysis {
  kind: DoneSignalKind;
  payload: DoneTransitionPayload | null;
}

const TERMINAL_DONE_EVENT_TYPES = new Set(["finalized", "verdict_finalized", "telegram_approve"]);

function isCompleteNonDoneFinalized(record: Record<string, unknown>): boolean {
  return record.from === "blocked" &&
    record.to === "review" &&
    record.outcome === "review" &&
    typeof record.sessionId === "string" &&
    record.sessionId !== "";
}

function isCompleteNonDoneTelegramApprove(record: Record<string, unknown>): boolean {
  return record.from === "blocked" &&
    record.to === "ready" &&
    record.kind === "steward-promote" &&
    record.source === "telegram" &&
    typeof record.nonce === "string" &&
    record.nonce !== "";
}

function analyzeDoneSignal(event: EventRow): DoneSignalAnalysis {
  const terminalEvent = TERMINAL_DONE_EVENT_TYPES.has(event.eventType);
  let value: unknown;
  try {
    value = JSON.parse(event.payload);
  } catch {
    return { kind: terminalEvent ? "invalid-done-signal" : "irrelevant", payload: null };
  }
  if (typeof value !== "object" || value === null) {
    return { kind: terminalEvent ? "invalid-done-signal" : "irrelevant", payload: null };
  }
  const record = value as Record<string, unknown>;
  if (record.to !== "done") {
    // finalized(outcome=review) は worker gate の正常な非done遷移であり、後続review完走の
    // done origin を汚染しない。それ以外のterminal event異形は楽観的に無視しない。
    if (event.eventType === "finalized" && isCompleteNonDoneFinalized(record)) {
      return { kind: "irrelevant", payload: null };
    }
    if (event.eventType === "telegram_approve" && isCompleteNonDoneTelegramApprove(record)) {
      return { kind: "irrelevant", payload: null };
    }
    return { kind: terminalEvent ? "invalid-done-signal" : "irrelevant", payload: null };
  }
  if (typeof record.from !== "string" || record.from === "") {
    return { kind: "invalid-done-signal", payload: null };
  }
  const payload: DoneTransitionPayload = {
    from: record.from,
    to: "done",
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
    ...(typeof record.outcome === "string" ? { outcome: record.outcome } : {}),
    ...(typeof record.verdict === "string" ? { verdict: record.verdict } : {}),
    ...(typeof record.confidence === "string" ? { confidence: record.confidence } : {}),
    ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    ...(typeof record.nonce === "string" ? { nonce: record.nonce } : {}),
  };
  if (terminalEvent &&
      !isDirectGatePassed(event, payload) &&
      !isReviewGatePassed(event, payload) &&
      !isTelegramHumanDecision(event, payload)) {
    // terminal event名は確定経路を表すため、provenanceが正当でもevent固有canonical shapeを
    // 満たさないto=doneをmanual originへ昇格しない。
    return { kind: "invalid-done-signal", payload: null };
  }
  return { kind: "valid-done", payload };
}

/** event単体をirrelevant / valid-done / invalid-done-signalへpure分類する。 */
export function classifyDoneSignal(event: EventRow): DoneSignalKind {
  return analyzeDoneSignal(event).kind;
}

function isDirectGatePassed(event: EventRow, payload: DoneTransitionPayload): boolean {
  return event.eventType === "finalized" &&
    payload.from === "blocked" &&
    payload.outcome === "done" &&
    typeof payload.sessionId === "string" &&
    payload.sessionId !== "";
}

function isReviewGatePassed(event: EventRow, payload: DoneTransitionPayload): boolean {
  return event.eventType === "verdict_finalized" &&
    payload.from === "review" &&
    payload.verdict === "pass" &&
    payload.confidence === "high" &&
    typeof payload.sessionId === "string" &&
    payload.sessionId !== "";
}

function isTelegramHumanDecision(event: EventRow, payload: DoneTransitionPayload): boolean {
  return event.eventType === "telegram_approve" &&
    payload.from === "blocked" &&
    payload.kind === "user-decision" &&
    payload.source === "telegram" &&
    typeof payload.nonce === "string" &&
    payload.nonce !== "";
}

/**
 * 1タスクの event 列から done origin を導出する。
 * done 遷移が0件または複数件なら、破損・再投入履歴を楽観解釈せず unknown に閉じる。
 */
export function deriveDoneOrigin(events: readonly EventRow[]): DoneOrigin {
  const analyses = events.map((event) => ({ event, analysis: analyzeDoneSignal(event) }));
  if (analyses.some(({ analysis }) => analysis.kind === "invalid-done-signal")) {
    return "unknown";
  }
  const candidates = analyses.filter(
    (candidate): candidate is { event: EventRow; analysis: DoneSignalAnalysis & { payload: DoneTransitionPayload } } =>
      candidate.analysis.kind === "valid-done" && candidate.analysis.payload !== null,
  );
  if (candidates.length !== 1) {
    return "unknown";
  }

  const { event, analysis } = candidates[0]!;
  const payload = analysis.payload;
  if (isDirectGatePassed(event, payload) || isReviewGatePassed(event, payload)) {
    return "gate_passed";
  }
  if (isTelegramHumanDecision(event, payload) || event.provenance.kind === "human") {
    return "human_decision";
  }
  if (event.provenance.kind === "orchestrator") {
    return "orchestrator_host_finalize";
  }
  return "unknown";
}

/** origin 群を再現可能な件数・率へ集約する。 */
export function summarizeDoneOrigins(origins: readonly DoneOrigin[]): DoneOriginStats {
  const counts: DoneOriginCounts = {
    gatePassed: 0,
    orchestratorHostFinalize: 0,
    humanDecision: 0,
    unknown: 0,
  };
  for (const origin of origins) {
    if (origin === "gate_passed") {
      counts.gatePassed += 1;
    } else if (origin === "orchestrator_host_finalize") {
      counts.orchestratorHostFinalize += 1;
    } else if (origin === "human_decision") {
      counts.humanDecision += 1;
    } else {
      counts.unknown += 1;
    }
  }
  const total = origins.length;
  return {
    total,
    counts,
    automaticCompletionRate: total === 0 ? 0 : counts.gatePassed / total,
    manualRecoveryRate: total === 0 ? 0 : (counts.orchestratorHostFinalize + counts.humanDecision) / total,
    unknownRate: total === 0 ? 0 : counts.unknown / total,
  };
}
