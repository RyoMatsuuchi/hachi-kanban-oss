import { createHash } from "node:crypto";
import type { ActorProvenance } from "./types.js";

export const HUMAN_DECISION_SCHEMA_VERSION = 32;
export const HUMAN_DECISION_PAYLOAD_VERSION = 1;

export const HUMAN_DECISION_KINDS = ["approval", "decision", "review"] as const;
export const HUMAN_DECISION_STATUSES = [
  "waiting_human",
  "answered",
  "claimed",
  "resolved",
  "cancelled",
] as const;

export type HumanDecisionKind = (typeof HUMAN_DECISION_KINDS)[number];
export type HumanDecisionStatus = (typeof HUMAN_DECISION_STATUSES)[number];
export type HumanDecisionDefaultOutcome = "deny" | "retain_current_state" | "not_accepted";
export type HumanDecisionErrorCode =
  | "INVALID_INPUT"
  | "TASK_NOT_FOUND"
  | "REQUEST_NOT_FOUND"
  | "REFERENCE_NOT_FOUND"
  | "ACTOR_UNAUTHORIZED"
  | "SESSION_SUPERSEDED"
  | "OWNER_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "REVISION_CONFLICT"
  | "STATE_CONFLICT"
  | "CLAIM_CONFLICT"
  | "SCHEMA_UNAVAILABLE";

export class HumanDecisionError extends Error {
  readonly code: HumanDecisionErrorCode;

  constructor(code: HumanDecisionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "HumanDecisionError";
    this.code = code;
  }
}

export interface HumanDecisionTargetRevision {
  kind: "git_commit" | "sha256";
  value: string;
}

export interface HumanDecisionChoice {
  id: string;
  label: string;
}

export type HumanDecisionLink =
  | { type: "url"; label: string; url: string }
  | { type: "artifact"; label: string; artifactName: string }
  | { type: "task"; label: string; taskId: string };

interface CreateHumanDecisionCommonInput {
  taskId: string;
  title: string;
  question: string;
  idempotencyKey: string;
  deadlineAt?: number | null;
  links?: readonly HumanDecisionLink[];
  relatedRequestId?: string | null;
  provenance: ActorProvenance;
  now?: number;
}

export type CreateHumanDecisionRequestInput =
  | (CreateHumanDecisionCommonInput & {
      kind: "approval";
      action: string;
      targetRevision: HumanDecisionTargetRevision;
      choices?: never;
    })
  | (CreateHumanDecisionCommonInput & {
      kind: "decision";
      choices?: readonly HumanDecisionChoice[];
      action?: never;
      targetRevision?: never;
    })
  | (CreateHumanDecisionCommonInput & {
      kind: "review";
      targetRevision: HumanDecisionTargetRevision;
      action?: never;
      choices?: never;
    });

export type HumanDecisionAnswer =
  | { kind: "approval"; outcome: "approve" | "reject" }
  | { kind: "review"; outcome: "accepted" | "changes_requested" }
  | { kind: "decision"; choiceId: string }
  | { kind: "decision"; text: string };

export interface AnswerHumanDecisionRequestInput {
  requestId: string;
  expectedRevision: 0;
  answerIdempotencyKey: string;
  answer: HumanDecisionAnswer;
  comment?: string | null;
  provenance: ActorProvenance;
  now?: number;
}

export interface CancelHumanDecisionRequestInput {
  requestId: string;
  expectedRevision: 0;
  reason: string;
  provenance: ActorProvenance;
  now?: number;
}

export interface ClaimHumanDecisionResponseInput {
  requestId: string;
  expectedRevision: 1;
  claimToken: string;
  leaseUntil: number;
  provenance: ActorProvenance;
  now?: number;
}

export interface ReleaseHumanDecisionResponseInput {
  requestId: string;
  expectedRevision: 1;
  claimToken: string;
  provenance: ActorProvenance;
  now?: number;
}

export type HumanDecisionResolution =
  | { outcome: "handled"; note?: string | null }
  | { outcome: "obsolete"; reason: string };

export interface ResolveHumanDecisionResponseInput {
  requestId: string;
  expectedRevision: 1;
  claimToken: string;
  resolution: HumanDecisionResolution;
  provenance: ActorProvenance;
  now?: number;
}

export interface HumanDecisionRequestRow {
  id: string;
  taskId: string;
  ownerOrchestratorId: string;
  kind: HumanDecisionKind;
  title: string;
  question: string;
  action: string | null;
  targetRevision: HumanDecisionTargetRevision | null;
  choices: HumanDecisionChoice[];
  links: HumanDecisionLink[];
  defaultOutcome: HumanDecisionDefaultOutcome;
  relatedRequestId: string | null;
  deadlineAt: number | null;
  status: HumanDecisionStatus;
  answerRevision: 0 | 1;
  answer: HumanDecisionAnswer | null;
  answerComment: string | null;
  requestProvenance: ActorProvenance;
  answerProvenance: ActorProvenance | null;
  cancelProvenance: ActorProvenance | null;
  resolveProvenance: ActorProvenance | null;
  answeredAt: number | null;
  claimantOrchestratorId: string | null;
  claimantSessionId: string | null;
  claimantGeneration: number | null;
  claimLeaseUntil: number | null;
  resolution: HumanDecisionResolution | null;
  resolvedAt: number | null;
  cancelReason: string | null;
  cancelledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ListHumanDecisionRequestsOptions {
  taskId?: string;
  tenant?: string;
  statuses?: readonly HumanDecisionStatus[];
  limit?: number;
}

export interface ListHumanDecisionResponsesOptions {
  ownerOrchestratorId: string;
  limit?: number;
}

export interface HumanDecisionRequestStore {
  createHumanDecisionRequest(input: CreateHumanDecisionRequestInput): HumanDecisionRequestRow;
  answerHumanDecisionRequest(input: AnswerHumanDecisionRequestInput): HumanDecisionRequestRow;
  cancelHumanDecisionRequest(input: CancelHumanDecisionRequestInput): HumanDecisionRequestRow;
  claimHumanDecisionResponse(input: ClaimHumanDecisionResponseInput): HumanDecisionRequestRow;
  releaseHumanDecisionResponse(input: ReleaseHumanDecisionResponseInput): HumanDecisionRequestRow;
  resolveHumanDecisionResponse(input: ResolveHumanDecisionResponseInput): HumanDecisionRequestRow;
}

export interface HumanDecisionReadView {
  getHumanDecisionRequest(id: string): HumanDecisionRequestRow | null;
  listHumanDecisionRequests(options?: ListHumanDecisionRequestsOptions): HumanDecisionRequestRow[];
  listHumanDecisionResponses(options: ListHumanDecisionResponsesOptions): HumanDecisionRequestRow[];
}

export interface CanonicalHumanDecisionAsk {
  version: 1;
  taskId: string;
  kind: HumanDecisionKind;
  title: string;
  question: string;
  action: string | null;
  targetRevision: HumanDecisionTargetRevision | null;
  choices: HumanDecisionChoice[];
  links: HumanDecisionLink[];
  defaultOutcome: HumanDecisionDefaultOutcome;
  deadlineAt: number | null;
  relatedRequestId: string | null;
  idempotencyKey: string;
}

export interface RawHumanDecisionRequestRow {
  id: string;
  task_id: string;
  owner_orchestrator_id: string;
  kind: string;
  title: string;
  question: string;
  action: string | null;
  target_revision_kind: string | null;
  target_revision_value: string | null;
  choices_json: string;
  links_json: string;
  default_outcome: string;
  related_request_id: string | null;
  deadline_at: number | null;
  ask_idempotency_key: string;
  ask_payload_hash: string;
  status: string;
  answer_revision: number;
  answer_idempotency_key: string | null;
  answer_payload_hash: string | null;
  answer_payload_json: string | null;
  answer_comment: string | null;
  answered_at: number | null;
  claimant_orchestrator_id: string | null;
  claimant_session_id: string | null;
  claimant_generation: number | null;
  claim_token_hash: string | null;
  claim_lease_until: number | null;
  resolution_outcome: string | null;
  resolution_reason: string | null;
  resolved_at: number | null;
  cancel_reason: string | null;
  cancelled_at: number | null;
  request_actor_kind: string;
  request_actor_id: string;
  request_actor_session_id: string;
  request_actor_generation: number | null;
  answer_actor_kind: string | null;
  answer_actor_id: string | null;
  answer_actor_session_id: string | null;
  answer_actor_generation: number | null;
  cancel_actor_kind: string | null;
  cancel_actor_id: string | null;
  cancel_actor_session_id: string | null;
  cancel_actor_generation: number | null;
  resolve_actor_kind: string | null;
  resolve_actor_id: string | null;
  resolve_actor_session_id: string | null;
  resolve_actor_generation: number | null;
  created_at: number;
  updated_at: number;
}

function invalid(message: string): never {
  throw new HumanDecisionError("INVALID_INPUT", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${label} はobjectが必須です`);
  return value;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) invalid(`${label} に未定義fieldがあります: ${key}`);
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") invalid(`${label} は文字列が必須です`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum) {
    invalid(`${label} は1..${maximum}文字が必須です`);
  }
  return normalized;
}

function nullableBoundedString(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maximum) invalid(`${label} は最大${maximum}文字です`);
  return value.trim() === "" ? null : value.trim();
}

export function requireHumanDecisionTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${label} は非負safe integerのUnix秒が必須です`);
  }
  return value as number;
}

export function requireHumanDecisionLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1000) {
    invalid("limit は1..1000の整数が必須です");
  }
  return value as number;
}

function canonicalTargetRevision(value: unknown): HumanDecisionTargetRevision {
  const record = requireRecord(value, "targetRevision");
  assertKeys(record, ["kind", "value"], "targetRevision");
  const kind = record.kind;
  const revision = record.value;
  if (kind !== "git_commit" && kind !== "sha256") invalid("targetRevision.kind が不正です");
  if (typeof revision !== "string") invalid("targetRevision.value は文字列が必須です");
  const pattern = kind === "git_commit" ? /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/ : /^[0-9a-f]{64}$/;
  if (!pattern.test(revision)) invalid("targetRevision.value は固定lowerhex revisionが必須です");
  return { kind, value: revision };
}

function canonicalChoices(value: unknown): HumanDecisionChoice[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) invalid("choices は最大10件の配列が必須です");
  const ids = new Set<string>();
  return value.map((item, index): HumanDecisionChoice => {
    const record = requireRecord(item, `choices[${index}]`);
    assertKeys(record, ["id", "label"], `choices[${index}]`);
    const id = boundedString(record.id, `choices[${index}].id`, 128);
    if (ids.has(id)) invalid(`choice id が重複しています: ${id}`);
    ids.add(id);
    return { id, label: boundedString(record.label, `choices[${index}].label`, 200) };
  });
}

function canonicalLink(value: unknown, index: number): HumanDecisionLink {
  const record = requireRecord(value, `links[${index}]`);
  const label = boundedString(record.label, `links[${index}].label`, 200);
  if (record.type === "url") {
    assertKeys(record, ["type", "label", "url"], `links[${index}]`);
    if (typeof record.url !== "string") invalid(`links[${index}].url は文字列が必須です`);
    let parsed: URL;
    try {
      parsed = new URL(record.url.trim());
    } catch {
      return invalid(`links[${index}].url が不正です`);
    }
    if (!(["http:", "https:"] as string[]).includes(parsed.protocol) || parsed.username !== "" || parsed.password !== "") {
      invalid(`links[${index}].url はuserinfo無しのhttp(s)が必須です`);
    }
    return { type: "url", label, url: parsed.toString() };
  }
  if (record.type === "artifact") {
    assertKeys(record, ["type", "label", "artifactName"], `links[${index}]`);
    const artifactName = boundedString(record.artifactName, `links[${index}].artifactName`, 255);
    if (artifactName === "." || artifactName === ".." || artifactName.includes("/") || artifactName.includes("\\") ||
        artifactName.includes("\0")) {
      invalid(`links[${index}].artifactName は安全なbasenameが必須です`);
    }
    return { type: "artifact", label, artifactName };
  }
  if (record.type === "task") {
    assertKeys(record, ["type", "label", "taskId"], `links[${index}]`);
    return { type: "task", label, taskId: boundedString(record.taskId, `links[${index}].taskId`, 128) };
  }
  return invalid(`links[${index}].type が不正です`);
}

function canonicalLinks(value: unknown): HumanDecisionLink[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) invalid("links は最大10件の配列が必須です");
  return value.map(canonicalLink);
}

export function humanDecisionDefaultOutcome(kind: HumanDecisionKind): HumanDecisionDefaultOutcome {
  if (kind === "approval") return "deny";
  if (kind === "decision") return "retain_current_state";
  return "not_accepted";
}

export function canonicalizeHumanDecisionAsk(input: CreateHumanDecisionRequestInput): CanonicalHumanDecisionAsk {
  const record = requireRecord(input, "create input");
  assertKeys(record, [
    "taskId", "kind", "title", "question", "idempotencyKey", "deadlineAt", "links", "relatedRequestId",
    "action", "targetRevision", "choices", "provenance", "now",
  ], "create input");
  if (!HUMAN_DECISION_KINDS.includes(record.kind as HumanDecisionKind)) invalid("kind が不正です");
  const kind = record.kind as HumanDecisionKind;
  let action: string | null = null;
  let targetRevision: HumanDecisionTargetRevision | null = null;
  let choices: HumanDecisionChoice[] = [];
  if (kind === "approval") {
    if (!hasOwn(record, "action") || !hasOwn(record, "targetRevision") || hasOwn(record, "choices")) {
      invalid("approval はaction/targetRevisionだけをkind固有fieldとして要求します");
    }
    action = boundedString(record.action, "action", 200);
    targetRevision = canonicalTargetRevision(record.targetRevision);
  } else if (kind === "review") {
    if (!hasOwn(record, "targetRevision") || hasOwn(record, "action") || hasOwn(record, "choices")) {
      invalid("review はtargetRevisionだけをkind固有fieldとして要求します");
    }
    targetRevision = canonicalTargetRevision(record.targetRevision);
  } else {
    if (hasOwn(record, "action") || hasOwn(record, "targetRevision")) {
      invalid("decision はaction/targetRevisionを持てません");
    }
    choices = canonicalChoices(record.choices);
  }
  const deadlineAt = record.deadlineAt === undefined || record.deadlineAt === null
    ? null
    : requireHumanDecisionTimestamp(record.deadlineAt, "deadlineAt");
  const relatedRequestId = record.relatedRequestId === undefined || record.relatedRequestId === null
    ? null
    : boundedString(record.relatedRequestId, "relatedRequestId", 128);
  return {
    version: HUMAN_DECISION_PAYLOAD_VERSION,
    taskId: boundedString(record.taskId, "taskId", 128),
    kind,
    title: boundedString(record.title, "title", 200),
    question: boundedString(record.question, "question", 12000),
    action,
    targetRevision,
    choices,
    links: canonicalLinks(record.links),
    defaultOutcome: humanDecisionDefaultOutcome(kind),
    deadlineAt,
    relatedRequestId,
    idempotencyKey: boundedString(record.idempotencyKey, "idempotencyKey", 128),
  };
}

export function canonicalizeHumanDecisionAnswer(
  kind: HumanDecisionKind,
  choices: readonly HumanDecisionChoice[],
  value: unknown,
): HumanDecisionAnswer {
  const record = requireRecord(value, "answer");
  if (record.kind !== kind) invalid("answer.kind がrequest kindと一致しません");
  if (kind === "approval") {
    assertKeys(record, ["kind", "outcome"], "answer");
    if (record.outcome !== "approve" && record.outcome !== "reject") invalid("approval answer が不正です");
    return { kind, outcome: record.outcome };
  }
  if (kind === "review") {
    assertKeys(record, ["kind", "outcome"], "answer");
    if (record.outcome !== "accepted" && record.outcome !== "changes_requested") invalid("review answer が不正です");
    return { kind, outcome: record.outcome };
  }
  if (choices.length > 0) {
    assertKeys(record, ["kind", "choiceId"], "answer");
    const choiceId = boundedString(record.choiceId, "answer.choiceId", 128);
    if (!choices.some((choice) => choice.id === choiceId)) invalid("answer.choiceId がchoicesに存在しません");
    return { kind, choiceId };
  }
  assertKeys(record, ["kind", "text"], "answer");
  return { kind, text: boundedString(record.text, "answer.text", 12000) };
}

export function canonicalizeHumanDecisionResolution(value: unknown): HumanDecisionResolution {
  const record = requireRecord(value, "resolution");
  if (record.outcome === "handled") {
    assertKeys(record, ["outcome", "note"], "resolution");
    const note = nullableBoundedString(record.note, "resolution.note", 12000);
    return note === null ? { outcome: "handled" } : { outcome: "handled", note };
  }
  if (record.outcome === "obsolete") {
    assertKeys(record, ["outcome", "reason"], "resolution");
    return { outcome: "obsolete", reason: boundedString(record.reason, "resolution.reason", 12000) };
  }
  return invalid("resolution.outcome が不正です");
}

export function canonicalHumanDecisionJson(value: unknown): string {
  return JSON.stringify(value);
}

export function humanDecisionSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function humanDecisionAskPayloadHash(
  ask: CanonicalHumanDecisionAsk,
  ownerOrchestratorId: string,
): string {
  return humanDecisionSha256(canonicalHumanDecisionJson({
    version: ask.version,
    taskId: ask.taskId,
    ownerOrchestratorId,
    kind: ask.kind,
    title: ask.title,
    question: ask.question,
    action: ask.action,
    targetRevision: ask.targetRevision,
    choices: ask.choices,
    links: ask.links,
    defaultOutcome: ask.defaultOutcome,
    deadlineAt: ask.deadlineAt,
    relatedRequestId: ask.relatedRequestId,
  }));
}

export function humanDecisionAnswerPayloadHash(input: {
  requestId: string;
  answer: HumanDecisionAnswer;
  comment: string | null;
  humanActorId: string;
}): string {
  return humanDecisionSha256(canonicalHumanDecisionJson({
    version: HUMAN_DECISION_PAYLOAD_VERSION,
    requestId: input.requestId,
    revision: 1,
    answer: input.answer,
    comment: input.comment,
    humanActorId: input.humanActorId,
  }));
}

function mapProvenance(
  kind: string | null,
  actorId: string | null,
  sessionId: string | null,
  generation: number | null,
): ActorProvenance | null {
  if (kind === null) {
    if (actorId !== null || sessionId !== null || generation !== null) invalid("provenance nullable group が不整合です");
    return null;
  }
  if (kind !== "human" && kind !== "orchestrator" && kind !== "service" && kind !== "unknown") {
    invalid("保存済みprovenance.kindが不正です");
  }
  return { kind, actorId: actorId ?? "", actorSessionId: sessionId ?? "", actorGeneration: generation };
}

function parseCanonicalArray(raw: string, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return invalid(`保存済み${label} JSONが不正です`);
  }
  if (!Array.isArray(parsed) || JSON.stringify(parsed) !== raw) invalid(`保存済み${label} JSONがcanonicalではありません`);
  return parsed;
}

export function mapHumanDecisionRequestRow(row: RawHumanDecisionRequestRow): HumanDecisionRequestRow {
  if (!/^hd_[0-9a-f]{16}$/.test(row.id)) invalid("保存済みrequest idが不正です");
  if (!HUMAN_DECISION_KINDS.includes(row.kind as HumanDecisionKind)) invalid("保存済みkindが不正です");
  if (!HUMAN_DECISION_STATUSES.includes(row.status as HumanDecisionStatus)) invalid("保存済みstatusが不正です");
  const kind = row.kind as HumanDecisionKind;
  const choices = canonicalChoices(parseCanonicalArray(row.choices_json, "choices"));
  const links = canonicalLinks(parseCanonicalArray(row.links_json, "links"));
  const targetRevision = row.target_revision_kind === null && row.target_revision_value === null
    ? null
    : canonicalTargetRevision({ kind: row.target_revision_kind, value: row.target_revision_value });
  let answer: HumanDecisionAnswer | null = null;
  if (row.answer_payload_json !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.answer_payload_json) as unknown;
    } catch {
      return invalid("保存済みanswer JSONが不正です");
    }
    answer = canonicalizeHumanDecisionAnswer(kind, choices, parsed);
    if (JSON.stringify(answer) !== row.answer_payload_json) invalid("保存済みanswer JSONがcanonicalではありません");
  }
  let resolution: HumanDecisionResolution | null = null;
  if (row.resolution_outcome === "handled") {
    resolution = row.resolution_reason === null ? { outcome: "handled" } : { outcome: "handled", note: row.resolution_reason };
  } else if (row.resolution_outcome === "obsolete" && row.resolution_reason !== null) {
    resolution = { outcome: "obsolete", reason: row.resolution_reason };
  } else if (row.resolution_outcome !== null || row.resolution_reason !== null) {
    invalid("保存済みresolutionが不整合です");
  }
  return {
    id: row.id,
    taskId: row.task_id,
    ownerOrchestratorId: row.owner_orchestrator_id,
    kind,
    title: row.title,
    question: row.question,
    action: row.action,
    targetRevision,
    choices,
    links,
    defaultOutcome: row.default_outcome as HumanDecisionDefaultOutcome,
    relatedRequestId: row.related_request_id,
    deadlineAt: row.deadline_at,
    status: row.status as HumanDecisionStatus,
    answerRevision: row.answer_revision as 0 | 1,
    answer,
    answerComment: row.answer_comment,
    requestProvenance: mapProvenance(
      row.request_actor_kind,
      row.request_actor_id,
      row.request_actor_session_id,
      row.request_actor_generation,
    )!,
    answerProvenance: mapProvenance(
      row.answer_actor_kind,
      row.answer_actor_id,
      row.answer_actor_session_id,
      row.answer_actor_generation,
    ),
    cancelProvenance: mapProvenance(
      row.cancel_actor_kind,
      row.cancel_actor_id,
      row.cancel_actor_session_id,
      row.cancel_actor_generation,
    ),
    resolveProvenance: mapProvenance(
      row.resolve_actor_kind,
      row.resolve_actor_id,
      row.resolve_actor_session_id,
      row.resolve_actor_generation,
    ),
    answeredAt: row.answered_at,
    claimantOrchestratorId: row.claimant_orchestrator_id,
    claimantSessionId: row.claimant_session_id,
    claimantGeneration: row.claimant_generation,
    claimLeaseUntil: row.claim_lease_until,
    resolution,
    resolvedAt: row.resolved_at,
    cancelReason: row.cancel_reason,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeHumanDecisionComment(value: unknown): string | null {
  return nullableBoundedString(value, "comment", 12000);
}

export function requireHumanDecisionText(value: unknown, label: string, maximum = 12000): string {
  return boundedString(value, label, maximum);
}

export function assertHumanDecisionInputKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  assertKeys(record, allowed, label);
  return record;
}
