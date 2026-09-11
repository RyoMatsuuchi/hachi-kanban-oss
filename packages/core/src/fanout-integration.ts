import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FanoutApplyMarker } from "./fanout-apply.js";
import type { FanoutPlan, FanoutPlanResult } from "./fanout-plan.js";
import type {
  OrchestratorRow,
  OrchestratorSessionRow,
  LinkRow,
  RunRow,
  TaskOrchestratorBindingRow,
  TaskRow,
} from "./types.js";

export const FANOUT_INTEGRATION_DECISION_VERSION = "fanout-integration-decision.v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID: Readonly<Record<GitObjectFormat, RegExp>> = {
  sha1: /^[0-9a-f]{40}$/,
  sha256: /^[0-9a-f]{64}$/,
};

export type GitObjectFormat = "sha1" | "sha256";

export interface FanoutIntegrationChildBoardEvidence {
  key: string;
  task: TaskRow | null;
  bindings: TaskOrchestratorBindingRow[];
  runs: RunRow[];
  links: LinkRow[];
}

export interface FanoutIntegrationChildGitEvidence {
  key: string;
  worktree: string;
  registeredWorktree: string | null;
  repoCommonDir: string;
  branch: string | null;
  head: string;
  clean: boolean;
  mainIsAncestor: boolean;
  changedPaths: string[];
}

export interface FanoutIntegrationGateInput {
  planResult: FanoutPlanResult;
  approvedPlanHash: string;
  authority: FanoutApplyMarker | null;
  orchestrator: OrchestratorRow | null;
  session: OrchestratorSessionRow | null;
  orchestratorId: string;
  sessionId: string;
  generation: number;
  parentBindings: TaskOrchestratorBindingRow[];
  children: FanoutIntegrationChildBoardEvidence[];
  repoCommonDir: string;
  objectFormat: string;
  mainRef: string;
  mainHead: string;
  mainHeadAfterProbe: string;
  gitChildren: FanoutIntegrationChildGitEvidence[];
}

export interface FanoutIntegrationChildDecision {
  key: string;
  taskId: string;
  verificationRunId: number;
  branch: string;
  head: string;
  worktree: string;
  changedPaths: string[];
}

export interface FanoutIntegrationDecision {
  version: typeof FANOUT_INTEGRATION_DECISION_VERSION;
  ready: true;
  requestedAction: "host-ff-only-integration";
  /** §63.4: snapshotは実行権限ではない。hostは各ff-only直前に全証拠を再検証する。 */
  hostRecheckRequired: true;
  parentTaskId: string;
  planHash: string;
  orchestratorId: string;
  sessionId: string;
  generation: number;
  repoCommonDir: string;
  objectFormat: GitObjectFormat;
  mainRef: string;
  mainHead: string;
  children: FanoutIntegrationChildDecision[];
}

function fail(message: string): never {
  throw new Error(`fan-out integration gate: ${message}`);
}

function gitObjectFormat(value: string): GitObjectFormat {
  if (value !== "sha1" && value !== "sha256") {
    return fail("Git object formatが未知です");
  }
  return value;
}

function assertPlanIntegrity(input: FanoutIntegrationGateInput): void {
  const { planResult } = input;
  const canonicalHash = createHash("sha256").update(planResult.canonicalJson, "utf8").digest("hex");
  if (
    !SHA256.test(input.approvedPlanHash) ||
    input.approvedPlanHash !== planResult.planHash ||
    planResult.plan.planHash !== planResult.planHash ||
    canonicalHash !== planResult.planHash
  ) {
    fail("承認済みplan hashがcanonical planと一致しません");
  }
  let canonicalPayload: unknown;
  try {
    canonicalPayload = JSON.parse(planResult.canonicalJson) as unknown;
  } catch {
    return fail("canonical plan JSONが不正です");
  }
  const planPayload: Partial<FanoutPlan> = { ...planResult.plan };
  delete planPayload.planHash;
  if (!isDeepStrictEqual(canonicalPayload, planPayload)) {
    fail("canonical plan JSONとplan payloadが一致しません");
  }
}

function assertCallerFence(input: FanoutIntegrationGateInput): void {
  const plan = input.planResult.plan;
  if (!Number.isInteger(input.generation) || input.generation <= 0) {
    fail("generationは正の整数である必要があります");
  }
  if (input.orchestrator === null || input.orchestrator.id !== input.orchestratorId) {
    fail("orchestrator identityが見つかりません");
  }
  if (input.orchestrator.repoCommonDir !== plan.repoCommonDir) {
    fail("orchestrator identityがplanのrepositoryを所有していません");
  }
  if (
    input.session === null ||
    input.session.id !== input.sessionId ||
    input.session.orchestratorId !== input.orchestratorId ||
    input.session.generation !== input.generation ||
    input.session.status !== "active"
  ) {
    fail("orchestrator session/generationがactive fenceと一致しません");
  }
  const primary = input.parentBindings.filter((binding) => binding.role === "primary");
  if (primary.length !== 1 || primary[0]?.orchestratorId !== input.orchestratorId) {
    fail("親タスクのprimary ownershipが指定identityと一致しません");
  }
}

function assertAuthority(input: FanoutIntegrationGateInput): Map<string, string> {
  const plan = input.planResult.plan;
  const authority = input.authority;
  if (
    authority === null ||
    authority.parentTaskId !== plan.parentTaskId ||
    authority.planHash !== input.planResult.planHash ||
    authority.orchestratorId !== input.orchestratorId
  ) {
    return fail("F2 apply authorityが同一plan hash/identityと一致しません");
  }
  const byKey = new Map(authority.children.map((child) => [child.key, child.taskId]));
  if (
    byKey.size !== plan.integrationGate.requiredChildren.length ||
    plan.integrationGate.requiredChildren.some((key) => !byKey.has(key))
  ) {
    return fail("integration gateに必要なchildがF2 authorityから欠落しています");
  }
  return byKey;
}

function parseVerifyPassed(run: RunRow): void {
  let meta: unknown;
  try {
    meta = JSON.parse(run.meta) as unknown;
  } catch {
    return fail("最新run metaが不正でverify証拠を確認できません");
  }
  if (typeof meta !== "object" || meta === null || !("verify" in meta)) {
    fail("最新runにverify証拠がありません");
  }
  if ((meta as { role?: unknown }).role !== "reviewer") {
    fail("最新runがreviewer runではありません");
  }
  const verify = (meta as { verify?: unknown }).verify;
  if (typeof verify !== "object" || verify === null || (verify as { status?: unknown }).status !== "passed") {
    fail("最新runのverify証拠がpassedではありません");
  }
}

function pathOwned(path: string, ownership: readonly string[]): boolean {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path === "." ||
    path === ".." ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return false;
  }
  return ownership.some((owned) => path === owned || path.startsWith(`${owned}/`));
}

function assertBoardChild(
  input: FanoutIntegrationGateInput,
  childKey: string,
  expectedTaskId: string,
): { task: TaskRow; run: RunRow } {
  const planChild = input.planResult.plan.children.find((child) => child.key === childKey);
  const evidence = input.children.find((child) => child.key === childKey);
  if (planChild === undefined || evidence === undefined || evidence.task === null || evidence.task.id !== expectedTaskId) {
    return fail(`child ${childKey} が欠落または別taskです`);
  }
  const expectedBody = `cwd: ${planChild.worktree}\n\n${planChild.body}`;
  if (
    evidence.task.title !== planChild.title ||
    evidence.task.body !== expectedBody ||
    evidence.task.tenant !== planChild.tenant ||
    evidence.task.profile !== planChild.profile
  ) {
    fail(`child ${childKey} のspecが承認済みplanからdriftしています`);
  }
  if (evidence.task.status !== "done" || evidence.task.completedAt === null) {
    fail(`child ${childKey} はdoneではありません`);
  }
  const primary = evidence.bindings.filter((binding) => binding.role === "primary");
  if (primary.length !== 1 || primary[0]?.orchestratorId !== input.orchestratorId) {
    fail(`child ${childKey} のprimary ownershipが指定identityと一致しません`);
  }
  const parentLinks = evidence.links.filter(
    (link) => link.linkType === "subtask" && link.childId === evidence.task!.id,
  );
  if (parentLinks.length !== 1 || parentLinks[0]?.parentId !== input.planResult.plan.parentTaskId) {
    fail(`child ${childKey} のparent subtaskが承認済みplanと一致しません`);
  }
  if (evidence.runs.length === 0 || evidence.runs.some((run) => run.status === "running")) {
    fail(`child ${childKey} に完了済み最新run証拠がありません`);
  }
  const runs = [...evidence.runs].sort((left, right) => right.startedAt - left.startedAt || right.id - left.id);
  const latest = runs[0]!;
  if (latest.taskId !== evidence.task.id || latest.status !== "done" || latest.endedAt === null) {
    fail(`child ${childKey} の最新runはdoneではありません`);
  }
  if (evidence.task.completedAt < latest.endedAt) {
    fail(`child ${childKey} のtask完了時刻が最新runより古くlate resultの疑いがあります`);
  }
  parseVerifyPassed(latest);
  return { task: evidence.task, run: latest };
}

function assertGitChild(
  input: FanoutIntegrationGateInput,
  childKey: string,
  objectFormat: GitObjectFormat,
): FanoutIntegrationChildGitEvidence & { branch: string } {
  const planChild = input.planResult.plan.children.find((child) => child.key === childKey);
  const evidence = input.gitChildren.find((child) => child.key === childKey);
  if (planChild === undefined || evidence === undefined) {
    return fail(`child ${childKey} のGit証拠が欠落しています`);
  }
  if (
    evidence.worktree !== planChild.worktree ||
    evidence.registeredWorktree !== planChild.worktree ||
    evidence.repoCommonDir !== input.planResult.plan.repoCommonDir
  ) {
    fail(`child ${childKey} のworktree/Git ownershipがplanと一致しません`);
  }
  if (evidence.branch === null || evidence.branch.length === 0 || evidence.branch === input.mainRef.replace(/^refs\/heads\//, "")) {
    fail(`child ${childKey} は専用branchに接続されていません`);
  }
  if (!GIT_OBJECT_ID[objectFormat].test(evidence.head) || !evidence.clean) {
    fail(`child ${childKey} のworktreeがdirtyまたはHEAD証拠が不正です`);
  }
  if (!evidence.mainIsAncestor) {
    fail(`child ${childKey} はlatest mainを追従していません`);
  }
  const changedPaths = [...new Set(evidence.changedPaths)].sort();
  if (changedPaths.some((path) => !pathOwned(path, planChild.ownership))) {
    fail(`child ${childKey} にownership外の変更があります`);
  }
  return { ...evidence, branch: evidence.branch, changedPaths };
}

/**
 * §63 F3のread-only判定。成功してもGit/boardを変更せず、hostへff-only統合要求を返すだけに留める。
 */
export function evaluateFanoutIntegrationGate(input: FanoutIntegrationGateInput): FanoutIntegrationDecision {
  assertPlanIntegrity(input);
  assertCallerFence(input);
  const authorityByKey = assertAuthority(input);
  const objectFormat = gitObjectFormat(input.objectFormat);
  if (
    input.repoCommonDir !== input.planResult.plan.repoCommonDir ||
    !GIT_OBJECT_ID[objectFormat].test(input.mainHead) ||
    input.mainHeadAfterProbe !== input.mainHead
  ) {
    fail("repo common-dirまたはlatest main snapshotが安定していません");
  }
  const required = input.planResult.plan.integrationGate.requiredChildren;
  if (
    input.children.length !== required.length ||
    input.gitChildren.length !== required.length ||
    new Set(input.children.map((child) => child.key)).size !== required.length ||
    new Set(input.gitChildren.map((child) => child.key)).size !== required.length
  ) {
    fail("integration gateのchild証拠集合がexactではありません");
  }

  const decisions = required.map((key): FanoutIntegrationChildDecision => {
    const taskId = authorityByKey.get(key);
    if (taskId === undefined) {
      return fail(`child ${key} がauthorityから欠落しています`);
    }
    const board = assertBoardChild(input, key, taskId);
    const git = assertGitChild(input, key, objectFormat);
    return {
      key,
      taskId: board.task.id,
      verificationRunId: board.run.id,
      branch: git.branch,
      head: git.head,
      worktree: git.worktree,
      changedPaths: git.changedPaths,
    };
  });
  const expectedTaskByKey = authorityByKey;
  const expectedDependencies = input.planResult.plan.children
    .flatMap((child) =>
      child.dependsOn.map((dependencyKey) => `${expectedTaskByKey.get(dependencyKey)}->${expectedTaskByKey.get(child.key)}`),
    )
    .sort();
  const allTaskIds = new Set(authorityByKey.values());
  const observedDependencyRows = input.children.flatMap((child) =>
    child.links.filter((link) => link.linkType === "depends-on"),
  );
  if (
    observedDependencyRows.some((link) => !allTaskIds.has(link.parentId) || !allTaskIds.has(link.childId)) ||
    !isDeepStrictEqual(
      [...new Set(observedDependencyRows.map((link) => `${link.parentId}->${link.childId}`))].sort(),
      expectedDependencies,
    )
  ) {
    fail("child間depends-on集合が承認済みplanからdriftしています");
  }
  if (new Set(decisions.map((child) => child.branch)).size !== decisions.length) {
    fail("複数childが同じbranchを共有しています");
  }

  return {
    version: FANOUT_INTEGRATION_DECISION_VERSION,
    ready: true,
    requestedAction: "host-ff-only-integration",
    hostRecheckRequired: true,
    parentTaskId: input.planResult.plan.parentTaskId,
    planHash: input.planResult.planHash,
    orchestratorId: input.orchestratorId,
    sessionId: input.sessionId,
    generation: input.generation,
    repoCommonDir: input.repoCommonDir,
    objectFormat,
    mainRef: input.mainRef,
    mainHead: input.mainHead,
    children: decisions,
  };
}
