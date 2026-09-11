// =============================================================================
// hachi human-decision / orchestrator ask: contract §80 の人間判断依頼 CLI。
// CLI は利用者 payload だけを受け取り、provenance は構造化 principal flags から構成する。
// =============================================================================

import { readFileSync } from "node:fs";
import { Command, InvalidArgumentError } from "commander";
import {
  HumanDecisionError,
  assertHumanDecisionInputKeys,
  canonicalizeHumanDecisionAnswer,
  canonicalizeHumanDecisionAsk,
  canonicalizeHumanDecisionResolution,
  createKanbanReadView,
  normalizeHumanDecisionComment,
  requireHumanDecisionText,
  type ActorProvenance,
  type CanonicalHumanDecisionAsk,
  type CreateHumanDecisionRequestInput,
  type HumanDecisionRequestRow,
} from "@hachi/core";
import type { CliDeps } from "../deps.js";
import { withErrorHandling } from "../errors.js";
import { emit, singularResourceEnvelope } from "../output.js";
import {
  addActorPrincipalOptions,
  resolveActorProvenance,
  type ActorPrincipalOptions,
} from "../actor-provenance.js";

const ASK_INPUT_KEYS = [
  "taskId",
  "kind",
  "title",
  "question",
  "idempotencyKey",
  "deadlineAt",
  "links",
  "relatedRequestId",
  "action",
  "targetRevision",
  "choices",
] as const;

const ANSWER_INPUT_KEYS = ["expectedRevision", "answerIdempotencyKey", "answer", "comment"] as const;

interface JsonOption {
  json?: boolean;
}

interface AskOptions extends JsonOption, ActorPrincipalOptions {
  input: string;
}

interface AnswerOptions extends JsonOption, ActorPrincipalOptions {
  input: string;
  author: string;
}

interface CancelOptions extends JsonOption, ActorPrincipalOptions {
  expectedRevision: 0;
  reason: string;
}

interface ReleaseOptions extends JsonOption, ActorPrincipalOptions {
  expectedRevision: 1;
  claim: string;
}

interface ResolveOptions extends JsonOption, ActorPrincipalOptions {
  expectedRevision: 1;
  claim: string;
  resolution: string;
}

function readJsonFile(path: string, label: string): unknown {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${label}の読み込みに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`${label}のJSONパースに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonText(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`${label}のJSONパースに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseExpectedRevision(expected: 0 | 1): (value: string) => 0 | 1 {
  return (value: string): 0 | 1 => {
    if (value !== String(expected)) {
      throw new InvalidArgumentError(`--expected-revision は${expected}が必須です: ${value}`);
    }
    return expected;
  };
}

function requireOrchestratorProvenance(options: ActorPrincipalOptions): ActorProvenance & {
  kind: "orchestrator";
  actorGeneration: number;
} {
  const provenance = resolveActorProvenance(options, "orchestrator");
  if (provenance?.kind !== "orchestrator" || provenance.actorGeneration === null) {
    throw new Error("--actor-kind orchestrator と complete identity/session/generation が必須です");
  }
  return {
    kind: "orchestrator",
    actorId: provenance.actorId,
    actorSessionId: provenance.actorSessionId,
    actorGeneration: provenance.actorGeneration,
  };
}

function requireHumanProvenance(options: AnswerOptions): ActorProvenance & { kind: "human" } {
  const provenance = resolveActorProvenance(options, options.author);
  if (provenance?.kind !== "human") {
    throw new Error("--actor-kind human が必須です");
  }
  return {
    kind: "human",
    actorId: provenance.actorId,
    actorSessionId: "",
    actorGeneration: null,
  };
}

function createRequestInput(
  ask: CanonicalHumanDecisionAsk,
  provenance: ActorProvenance & { kind: "orchestrator"; actorGeneration: number },
): CreateHumanDecisionRequestInput {
  const common = {
    taskId: ask.taskId,
    title: ask.title,
    question: ask.question,
    idempotencyKey: ask.idempotencyKey,
    deadlineAt: ask.deadlineAt,
    links: ask.links,
    relatedRequestId: ask.relatedRequestId,
    provenance,
  };
  if (ask.kind === "approval") {
    if (ask.action === null || ask.targetRevision === null) {
      throw new HumanDecisionError("INVALID_INPUT", "approvalのcanonical inputが不完全です");
    }
    return { ...common, kind: "approval", action: ask.action, targetRevision: ask.targetRevision };
  }
  if (ask.kind === "review") {
    if (ask.targetRevision === null) {
      throw new HumanDecisionError("INVALID_INPUT", "reviewのcanonical inputが不完全です");
    }
    return { ...common, kind: "review", targetRevision: ask.targetRevision };
  }
  return { ...common, kind: "decision", choices: ask.choices };
}

function requestText(request: HumanDecisionRequestRow): string[] {
  return [
    `request: ${request.id}`,
    `kind: ${request.kind}`,
    `status: ${request.status}`,
    `question: ${request.question}`,
    `answer: ${request.answer === null ? "-" : JSON.stringify(request.answer)}`,
  ];
}

function emitRequest(deps: CliDeps, request: HumanDecisionRequestRow, json: boolean): void {
  emit(deps, json, singularResourceEnvelope(request, { request }), requestText(request));
}

function runAsk(deps: CliDeps, options: AskOptions): void {
  const provenance = requireOrchestratorProvenance(options);
  const raw = readJsonFile(options.input, "ask input");
  const record = assertHumanDecisionInputKeys(raw, ASK_INPUT_KEYS, "ask input");
  // この cast は core validator への境界だけに限定する。全 field は canonicalize 側で検証される。
  const ask = canonicalizeHumanDecisionAsk(record as unknown as CreateHumanDecisionRequestInput);
  const request = deps.store.createHumanDecisionRequest(createRequestInput(ask, provenance));
  emitRequest(deps, request, options.json === true);
}

function getHumanDecisionRequest(deps: CliDeps, requestId: string): HumanDecisionRequestRow {
  const view = createKanbanReadView(deps.env.dbPath);
  try {
    const request = view.getHumanDecisionRequest(requestId);
    if (request === null) {
      throw new HumanDecisionError("REQUEST_NOT_FOUND", `requestがありません: ${requestId}`);
    }
    return request;
  } finally {
    view.close();
  }
}

function runShow(deps: CliDeps, requestId: string, options: JsonOption): void {
  emitRequest(deps, getHumanDecisionRequest(deps, requestId), options.json === true);
}

function runAnswer(deps: CliDeps, requestId: string, options: AnswerOptions): void {
  const provenance = requireHumanProvenance(options);
  const raw = readJsonFile(options.input, "answer input");
  const record = assertHumanDecisionInputKeys(raw, ANSWER_INPUT_KEYS, "answer input");
  if (record.expectedRevision !== 0) {
    throw new HumanDecisionError("REVISION_CONFLICT", "expectedRevisionは0が必須です");
  }
  const answerIdempotencyKey = requireHumanDecisionText(
    record.answerIdempotencyKey,
    "answerIdempotencyKey",
    128,
  );
  const comment = normalizeHumanDecisionComment(record.comment);
  const current = getHumanDecisionRequest(deps, requestId);
  const answer = canonicalizeHumanDecisionAnswer(current.kind, current.choices, record.answer);
  const request = deps.store.answerHumanDecisionRequest({
    requestId,
    expectedRevision: 0,
    answerIdempotencyKey,
    answer,
    comment,
    provenance,
  });
  emitRequest(deps, request, options.json === true);
}

function runCancel(deps: CliDeps, requestId: string, options: CancelOptions): void {
  const request = deps.store.cancelHumanDecisionRequest({
    requestId,
    expectedRevision: options.expectedRevision,
    reason: options.reason,
    provenance: requireOrchestratorProvenance(options),
  });
  emitRequest(deps, request, options.json === true);
}

function runRelease(deps: CliDeps, requestId: string, options: ReleaseOptions): void {
  const request = deps.store.releaseHumanDecisionResponse({
    requestId,
    expectedRevision: options.expectedRevision,
    claimToken: options.claim,
    provenance: requireOrchestratorProvenance(options),
  });
  emitRequest(deps, request, options.json === true);
}

function runResolve(deps: CliDeps, requestId: string, options: ResolveOptions): void {
  const resolution = canonicalizeHumanDecisionResolution(parseJsonText(options.resolution, "resolution"));
  const request = deps.store.resolveHumanDecisionResponse({
    requestId,
    expectedRevision: options.expectedRevision,
    claimToken: options.claim,
    resolution,
    provenance: requireOrchestratorProvenance(options),
  });
  emitRequest(deps, request, options.json === true);
}

/** 既存 orchestrator root に ask だけを登録する。 */
export function registerHumanDecisionAskCommand(orchestrator: Command, deps: CliDeps): void {
  const ask = orchestrator.command("ask")
    .description("task状態に依存しない人間判断依頼を作成する")
    .requiredOption("--input <file>", "CreateHumanDecisionRequestInputの利用者JSON")
    .option("--json", "JSON形式で出力する");
  addActorPrincipalOptions(ask)
    .action(withErrorHandling(deps, (options: AskOptions): void => runAsk(deps, options)));
}

/** human-decision 専用のread/answer/cancel/release/resolveを登録する。 */
export function registerHumanDecisionCommand(program: Command, deps: CliDeps): void {
  const humanDecision = program.command("human-decision").description("人間判断依頼（contract §80）");

  humanDecision.command("show")
    .argument("<request-id>")
    .option("--json", "JSON形式で出力する")
    .action(withErrorHandling(deps, (requestId: string, options: JsonOption): void =>
      runShow(deps, requestId, options)
    ));

  const answer = humanDecision.command("answer")
    .argument("<request-id>")
    .requiredOption("--input <file>", "answer payload JSON")
    .requiredOption("--author <human-id>", "local human actor ID")
    .option("--json", "JSON形式で出力する");
  addActorPrincipalOptions(answer)
    .action(withErrorHandling(deps, (requestId: string, options: AnswerOptions): void =>
      runAnswer(deps, requestId, options)
    ));

  const cancel = humanDecision.command("cancel")
    .argument("<request-id>")
    .requiredOption("--expected-revision <n>", "expected answer revision", parseExpectedRevision(0))
    .requiredOption("--reason <text>", "cancel理由")
    .option("--json", "JSON形式で出力する");
  addActorPrincipalOptions(cancel)
    .action(withErrorHandling(deps, (requestId: string, options: CancelOptions): void =>
      runCancel(deps, requestId, options)
    ));

  const release = humanDecision.command("release")
    .argument("<request-id>")
    .requiredOption("--expected-revision <n>", "expected answer revision", parseExpectedRevision(1))
    .requiredOption("--claim <token>", "response claim token")
    .option("--json", "JSON形式で出力する");
  addActorPrincipalOptions(release)
    .action(withErrorHandling(deps, (requestId: string, options: ReleaseOptions): void =>
      runRelease(deps, requestId, options)
    ));

  const resolve = humanDecision.command("resolve")
    .argument("<request-id>")
    .requiredOption("--expected-revision <n>", "expected answer revision", parseExpectedRevision(1))
    .requiredOption("--claim <token>", "response claim token")
    .requiredOption("--resolution <json>", "handled/obsolete resolution JSON")
    .option("--json", "JSON形式で出力する");
  addActorPrincipalOptions(resolve)
    .action(withErrorHandling(deps, (requestId: string, options: ResolveOptions): void =>
      runResolve(deps, requestId, options)
    ));
}
