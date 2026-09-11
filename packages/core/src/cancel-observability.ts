// durable cancel の共有読み取りモデル（docs/contract.md §57.5）。
// 凍結契約 types.ts は変更せず、CLI/Webが同じ証拠判定・redaction・順序を使う。

import { redactRuntimeObservationText } from "./model-transport-observability.js";
import { redactMaybeJsonText, redactText } from "./redaction.js";
import type { EventRow, RunCancelRequestRow } from "./types.js";

export type CancelEvidenceState = "yes" | "no" | "unknown";

export interface CancelLifecycleSummary {
  requestId: string;
  runId: number;
  sessionId: string;
  provider: RunCancelRequestRow["provider"];
  status: RunCancelRequestRow["status"];
  reason: string;
  orchestratorId: string;
  requesterSessionId: string;
  requesterGeneration: number | null;
  cancelFence: number;
  deadlineAt: number;
  delivered: CancelEvidenceState;
  observed: CancelEvidenceState;
  acknowledged: CancelEvidenceState;
  stopped: CancelEvidenceState;
  capabilitySnapshot: string;
  stopEvidence: string;
  lastError: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

const HOST_STOP_ID_PATTERN = /^[A-Za-z0-9._:+@/-]{1,256}$/;
const HOST_STOP_SENSITIVE_PATTERN = /(?:authorization|bearer|credential|secret|token)/i;

function isHostStopId(value: unknown): value is string {
  return typeof value === "string" && HOST_STOP_ID_PATTERN.test(value) &&
    !HOST_STOP_SENSITIVE_PATTERN.test(value) && redactText(value) === value;
}

function isHttpServerUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function hasHostProcessGenerationEvidence(
  request: RunCancelRequestRow,
  evidence: Record<string, unknown>,
): boolean {
  const attestedBy = evidence["attestedBy"];
  if (typeof attestedBy !== "object" || attestedBy === null || Array.isArray(attestedBy)) {
    return false;
  }
  const attestation = attestedBy as Record<string, unknown>;
  return request.orchestratorId.length > 0 &&
    isHostStopId(evidence["evidenceId"]) &&
    isHostStopId(evidence["processGeneration"]) &&
    isHttpServerUrl(evidence["serverUrl"]) &&
    evidence["provider"] === request.provider &&
    evidence["sessionId"] === request.sessionId &&
    evidence["runId"] === request.runId &&
    evidence["cancelFence"] === request.cancelFence &&
    evidence["childProcessTreeCovered"] === true &&
    attestation["orchestratorId"] === request.orchestratorId &&
    isHostStopId(attestation["sessionId"]) &&
    typeof attestation["generation"] === "number" &&
    Number.isSafeInteger(attestation["generation"]) &&
    attestation["generation"] > 0;
}

/** reviewerで確定したexact stop evidence shape以外はunknownへ倒す。 */
export function hasExactCancelStopEvidence(request: RunCancelRequestRow): boolean {
  if (request.status !== "stopped") {
    return false;
  }
  const evidence = parseRecord(request.stopEvidence);
  if (evidence === null) {
    return false;
  }
  if (evidence["source"] === "host-process-generation") {
    return hasHostProcessGenerationEvidence(request, evidence);
  }
  if (!["natural", "forced"].includes(String(evidence["source"]))) {
    return false;
  }
  if (!["idle", "ended"].includes(String(evidence["observedSessionState"]))) {
    return false;
  }
  if (typeof evidence["resultWatermark"] !== "number" ||
      !Number.isSafeInteger(evidence["resultWatermark"]) || evidence["resultWatermark"] < 0 ||
      typeof evidence["lastEntryId"] !== "number" ||
      !Number.isSafeInteger(evidence["lastEntryId"]) || evidence["lastEntryId"] < 0) {
    return false;
  }
  if (evidence["source"] === "natural") {
    return true;
  }
  return ["stopped", "already-stopped"].includes(String(evidence["stopState"])) &&
    typeof evidence["evidenceId"] === "string" && evidence["evidenceId"].trim() !== "" &&
    typeof evidence["childProcessTreeCovered"] === "boolean";
}

/** deep JSON文字列を再帰redactし、absolute path suffixも除去する。 */
export function redactCancelJson(value: string): string {
  return redactMaybeJsonText(value, redactRuntimeObservationText);
}

const CANCEL_EVENT_TYPES = new Set([
  "cancel_requested",
  "cancel_injected",
  "cancel_acknowledged",
  "cancel_force_started",
  "cancel_force_attempted",
  "cancel_stop_candidate",
  "cancel_stopped",
  "cancel_failed",
  "cancel_expired",
  "cancel_host_stop_attested",
  "late_result_rejected",
]);

export function redactCancelEvent(event: EventRow): EventRow {
  if (!CANCEL_EVENT_TYPES.has(event.eventType)) {
    return event;
  }
  return { ...event, payload: redactCancelJson(event.payload) };
}

/** authority nonceを除き、CLI/Web共通のtri-stateへ写像する。 */
export function summarizeCancelRequest(request: RunCancelRequestRow): CancelLifecycleSummary {
  const acknowledged = request.acknowledgedNonce.length > 0;
  const stopped = hasExactCancelStopEvidence(request);
  return {
    requestId: redactText(request.id),
    runId: request.runId,
    sessionId: redactText(request.sessionId),
    provider: request.provider,
    status: request.status,
    reason: redactRuntimeObservationText(redactText(request.reason)),
    orchestratorId: redactText(request.orchestratorId),
    requesterSessionId: redactText(request.requesterSessionId),
    requesterGeneration: request.requesterGeneration,
    cancelFence: request.cancelFence,
    deadlineAt: request.deadlineAt,
    delivered: acknowledged ? "yes" : request.status === "cancel_requested" ? "no" : "unknown",
    observed: acknowledged ? "yes" : "unknown",
    acknowledged: acknowledged ? "yes" : "no",
    stopped: stopped
      ? "yes"
      : request.status === "stopped" || ["failed", "expired"].includes(request.status) ? "unknown" : "no",
    capabilitySnapshot: redactCancelJson(request.capabilitySnapshot),
    stopEvidence: redactCancelJson(request.stopEvidence),
    lastError: redactRuntimeObservationText(redactText(request.lastError)),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    resolvedAt: request.resolvedAt,
  };
}

/** cancelFenceを正本に新しい順へ並べ、同値時もrandom request idへ依存しない。 */
export function sortCancelRequestsDescending(
  requests: readonly RunCancelRequestRow[],
): RunCancelRequestRow[] {
  return [...requests].sort((left, right) =>
    right.cancelFence - left.cancelFence ||
    right.runId - left.runId ||
    right.updatedAt - left.updatedAt ||
    right.createdAt - left.createdAt);
}
