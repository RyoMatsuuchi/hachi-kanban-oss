import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { hashFanoutParentBody, type FanoutPlan, type FanoutPlanResult } from "./fanout-plan.js";
import type { KanbanStore, TaskRow } from "./types.js";

export const FANOUT_APPLY_MARKER_VERSION = "fanout-apply.v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const APPLY_MARKER_PREFIX = "```hachi-fanout-apply-v1\n";
const APPLY_MARKER_SUFFIX = "\n```";
const FANOUT_APPLIED_EVENT = "fanout_plan_applied";
const ALLOWED_MATERIALIZED_STATUSES = new Set([
  "todo",
  "ready",
  "blocked",
  "review",
  "needs-integration",
  "done",
  "archived",
]);

const markerSchema = z
  .object({
    version: z.literal(FANOUT_APPLY_MARKER_VERSION),
    parentTaskId: z.string().min(1),
    planHash: z.string().regex(SHA256),
    orchestratorId: z.string().min(1),
    sessionId: z.string().min(1),
    generation: z.number().int().positive(),
    children: z
      .array(
        z
          .object({
            key: z.string().min(1),
            taskId: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export interface FanoutApplyMarker {
  version: typeof FANOUT_APPLY_MARKER_VERSION;
  parentTaskId: string;
  planHash: string;
  orchestratorId: string;
  sessionId: string;
  generation: number;
  children: Array<{ key: string; taskId: string }>;
}

export interface ApplyFanoutPlanInput {
  planResult: FanoutPlanResult;
  approvedPlanHash: string;
  orchestratorId: string;
  sessionId: string;
  generation: number;
  actor: string;
}

export interface ApplyFanoutPlanResult {
  applied: boolean;
  planHash: string;
  parentTaskId: string;
  children: Array<{ key: string; task: TaskRow }>;
}

function fail(message: string): never {
  throw new Error(`fan-out apply: ${message}`);
}

function serializeMarker(marker: FanoutApplyMarker): string {
  return `${APPLY_MARKER_PREFIX}${JSON.stringify(marker)}${APPLY_MARKER_SUFFIX}`;
}

function parseAuthority(payload: string): FanoutApplyMarker {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    return fail("適用authority eventが破損しています");
  }
  const parsed = markerSchema.safeParse(value);
  if (!parsed.success) {
    return fail("適用authority eventが破損しています");
  }
  const keys = parsed.data.children.map((child) => child.key);
  const taskIds = parsed.data.children.map((child) => child.taskId);
  if (new Set(keys).size !== keys.length || new Set(taskIds).size !== taskIds.length) {
    return fail("適用authority eventのchild key/task IDが重複しています");
  }
  return parsed.data;
}

function findExistingAuthority(store: KanbanStore, parentTaskId: string): FanoutApplyMarker | null {
  const events = store.listEvents(parentTaskId, FANOUT_APPLIED_EVENT);
  if (events.length > 1) {
    return fail("親タスクに複数の適用authority eventがあります");
  }
  return events[0] === undefined ? null : parseAuthority(events[0].payload);
}

/** F3のread-only判定がF2のdurable authorityを再利用するための公開reader。 */
export function getFanoutApplyAuthority(store: KanbanStore, parentTaskId: string): FanoutApplyMarker | null {
  return findExistingAuthority(store, parentTaskId);
}

function childBody(worktree: string, body: string): string {
  return `cwd: ${worktree}\n\n${body}`;
}

function assertApprovalFence(input: ApplyFanoutPlanInput): void {
  const canonicalHash = createHash("sha256").update(input.planResult.canonicalJson, "utf8").digest("hex");
  if (
    !SHA256.test(input.approvedPlanHash) ||
    input.approvedPlanHash !== input.planResult.planHash ||
    canonicalHash !== input.planResult.planHash
  ) {
    fail("承認済みplan hashがcanonical planと一致しません");
  }
  if (input.planResult.plan.planHash !== input.planResult.planHash) {
    fail("plan内部のhashがcanonical結果と一致しません");
  }
  let canonicalPayload: unknown;
  try {
    canonicalPayload = JSON.parse(input.planResult.canonicalJson) as unknown;
  } catch {
    return fail("canonical plan JSONが不正です");
  }
  const planPayload: Partial<FanoutPlan> = { ...input.planResult.plan };
  delete planPayload.planHash;
  if (!isDeepStrictEqual(canonicalPayload, planPayload)) {
    fail("canonical plan JSONとplan payloadが一致しません");
  }
  if (!Number.isInteger(input.generation) || input.generation <= 0) {
    fail("generationは正の整数である必要があります");
  }
}

function assertParentSnapshot(store: KanbanStore, input: ApplyFanoutPlanInput): TaskRow {
  const plan = input.planResult.plan;
  const parent = store.getTask(plan.parentTaskId);
  if (parent === null) {
    return fail("親タスクが見つかりません");
  }
  if (
    plan.parentSnapshot.taskId !== parent.id ||
    plan.parentSnapshot.updatedAt !== parent.updatedAt ||
    plan.parentSnapshot.bodyHash !== hashFanoutParentBody(parent.body)
  ) {
    return fail("親タスクsnapshotが現在値と一致しません");
  }
  return parent;
}

function assertOrchestratorFence(store: KanbanStore, input: ApplyFanoutPlanInput): void {
  const plan = input.planResult.plan;
  const orchestrator = store.getOrchestrator(input.orchestratorId);
  if (orchestrator === null || orchestrator.repoCommonDir !== plan.repoCommonDir) {
    fail("orchestrator identityがplanのrepositoryを所有していません");
  }
  const session = store.getOrchestratorSession(input.sessionId);
  if (
    session === null ||
    session.orchestratorId !== input.orchestratorId ||
    session.generation !== input.generation ||
    session.status !== "active"
  ) {
    fail("orchestrator session/generationがactive fenceと一致しません");
  }
  const primaryBindings = store
    .listTaskOrchestratorBindings(plan.parentTaskId)
    .filter((binding) => binding.role === "primary");
  if (
    primaryBindings.length !== 1 ||
    primaryBindings[0]?.orchestratorId !== input.orchestratorId
  ) {
    fail("親タスクのprimary ownershipが指定identityと一致しません");
  }
}

function materializedResult(
  store: KanbanStore,
  input: ApplyFanoutPlanInput,
  marker: FanoutApplyMarker,
): ApplyFanoutPlanResult {
  const plan = input.planResult.plan;
  if (
    marker.parentTaskId !== plan.parentTaskId ||
    marker.planHash !== input.planResult.planHash ||
    marker.orchestratorId !== input.orchestratorId
  ) {
    fail("既存適用は別plan hashまたは別identityに所有されています");
  }
  const markerByKey = new Map(marker.children.map((child) => [child.key, child.taskId]));
  if (markerByKey.size !== plan.children.length || plan.children.some((child) => !markerByKey.has(child.key))) {
    fail("既存適用markerのchild集合がplanと一致しません");
  }

  const allTaskIds = new Set(marker.children.map((child) => child.taskId));
  const expectedDependencies = new Set(
    plan.children.flatMap((child) =>
      child.dependsOn.map((dependencyKey) => `${markerByKey.get(dependencyKey)}->${markerByKey.get(child.key)}`),
    ),
  );
  const expectedChildTaskIds = [...allTaskIds].sort();
  const observedChildTaskIds = store
    .listLinks(plan.parentTaskId)
    .filter((link) => link.linkType === "subtask" && link.parentId === plan.parentTaskId)
    .map((link) => link.childId)
    .sort();
  if (!isDeepStrictEqual(observedChildTaskIds, expectedChildTaskIds)) {
    fail("親タスクのsubtask集合がplanと一致しません");
  }
  const observedDependencies = new Set<string>();
  const children = plan.children.map((child) => {
    const taskId = markerByKey.get(child.key);
    const task = taskId === undefined ? null : store.getTask(taskId);
    if (task === null) {
      return fail("既存適用のchild taskが見つかりません");
    }
    if (
      task.title !== child.title ||
      task.body !== childBody(child.worktree, child.body) ||
      task.tenant !== child.tenant ||
      task.profile !== child.profile ||
      !ALLOWED_MATERIALIZED_STATUSES.has(task.status)
    ) {
      return fail("既存適用のchild task specがplanと一致しません");
    }
    const links = store.listLinks(task.id);
    const incomingParents = links.filter((link) => link.linkType === "subtask" && link.childId === task.id);
    if (
      incomingParents.length !== 1 ||
      incomingParents[0]?.parentId !== plan.parentTaskId
    ) {
      return fail("既存適用のchild parent subtaskがplanと一致しません");
    }
    for (const link of links) {
      if (link.linkType !== "depends-on") {
        continue;
      }
      if (!allTaskIds.has(link.parentId) || !allTaskIds.has(link.childId)) {
        return fail("既存適用のchildに予定外dependencyがあります");
      }
      observedDependencies.add(`${link.parentId}->${link.childId}`);
    }
    const primaryBindings = store
      .listTaskOrchestratorBindings(task.id)
      .filter((binding) => binding.role === "primary");
    if (primaryBindings.some((binding) => binding.orchestratorId !== input.orchestratorId)) {
      return fail("child taskが別identityに所有されています");
    }
    store.bindTaskToOrchestrator(task.id, input.orchestratorId, "primary");
    return { key: child.key, task };
  });
  if (!isDeepStrictEqual([...observedDependencies].sort(), [...expectedDependencies].sort())) {
    fail("既存適用のdepends-on集合がplanと一致しません");
  }
  return {
    applied: false,
    planHash: input.planResult.planHash,
    parentTaskId: plan.parentTaskId,
    children,
  };
}

/** 承認済みplanをgeneration fence付きで原子的かつ冪等にboardへ適用する。 */
export function applyFanoutPlan(store: KanbanStore, input: ApplyFanoutPlanInput): ApplyFanoutPlanResult {
  assertApprovalFence(input);
  return store.transaction((): ApplyFanoutPlanResult => {
    assertOrchestratorFence(store, input);
    const existing = findExistingAuthority(store, input.planResult.plan.parentTaskId);
    if (existing !== null) {
      return materializedResult(store, input, existing);
    }
    // snapshotは初回materializeのフェンス。同一markerがあるretryでは、その後の親更新より
    // durable markerの整合性と既存childの再収束を優先する。
    assertParentSnapshot(store, input);
    if (
      store
        .listLinks(input.planResult.plan.parentTaskId)
        .some((link) => link.linkType === "subtask" && link.parentId === input.planResult.plan.parentTaskId)
    ) {
      fail("初回適用前の親タスクに既存subtaskがあります");
    }

    const taskByKey = new Map<string, TaskRow>();
    for (const child of input.planResult.plan.children) {
      const task = store.createTask(
        {
          title: child.title,
          body: childBody(child.worktree, child.body),
          tenant: child.tenant,
          profile: child.profile,
          status: "todo",
        },
        input.actor,
      );
      store.link(input.planResult.plan.parentTaskId, task.id, "subtask");
      store.bindTaskToOrchestrator(task.id, input.orchestratorId, "primary");
      taskByKey.set(child.key, task);
    }
    for (const child of input.planResult.plan.children) {
      const task = taskByKey.get(child.key);
      if (task === undefined) {
        return fail("作成済みchild taskを解決できません");
      }
      for (const dependencyKey of child.dependsOn) {
        const dependency = taskByKey.get(dependencyKey);
        if (dependency === undefined) {
          return fail("作成済みdependency taskを解決できません");
        }
        store.link(dependency.id, task.id, "depends-on");
      }
    }

    const marker: FanoutApplyMarker = {
      version: FANOUT_APPLY_MARKER_VERSION,
      parentTaskId: input.planResult.plan.parentTaskId,
      planHash: input.planResult.planHash,
      orchestratorId: input.orchestratorId,
      sessionId: input.sessionId,
      generation: input.generation,
      children: input.planResult.plan.children.map((child) => ({
        key: child.key,
        taskId: taskByKey.get(child.key)!.id,
      })),
    };
    store.addComment(input.planResult.plan.parentTaskId, input.actor, serializeMarker(marker));
    store.addEvent(input.planResult.plan.parentTaskId, FANOUT_APPLIED_EVENT, input.actor, {
      version: marker.version,
      parentTaskId: marker.parentTaskId,
      planHash: marker.planHash,
      orchestratorId: marker.orchestratorId,
      sessionId: marker.sessionId,
      generation: marker.generation,
      children: marker.children,
    });
    return {
      applied: true,
      planHash: input.planResult.planHash,
      parentTaskId: input.planResult.plan.parentTaskId,
      children: input.planResult.plan.children.map((child) => ({
        key: child.key,
        task: taskByKey.get(child.key)!,
      })),
    };
  });
}
