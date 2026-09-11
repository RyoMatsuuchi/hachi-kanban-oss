import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFanoutPlan, getFanoutApplyAuthority } from "./fanout-apply.js";
import {
  evaluateFanoutIntegrationGate,
  type FanoutIntegrationGateInput,
} from "./fanout-integration.js";
import { createFanoutPlan, hashFanoutParentBody, type FanoutPlanInput } from "./fanout-plan.js";
import { SqliteKanbanStore } from "./db.js";
import type { OrchestratorRow, OrchestratorSessionRow, RunRow, TaskRow } from "./types.js";

describe("evaluateFanoutIntegrationGate", () => {
  let store: SqliteKanbanStore;
  let parent: TaskRow;
  let orchestrator: OrchestratorRow;
  let session: OrchestratorSessionRow;

  beforeEach(() => {
    store = new SqliteKanbanStore(":memory:");
    parent = store.createTask(
      { title: "親", body: "cwd: /repo\n\n親scope\n", tenant: "dev", profile: "plan", status: "todo" },
      "test",
    );
    orchestrator = store.registerOrchestrator({
      label: "fanout-owner",
      project: "hachi-kanban",
      repoCommonDir: "/repo/.git",
    });
    session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    store.bindTaskToOrchestrator(parent.id, orchestrator.id, "primary");
  });

  afterEach(() => {
    store.close();
  });

  function planInput(): FanoutPlanInput {
    const root = join(homedir(), ".hachi-kanban", "worktrees");
    return {
      version: "fanout-plan-input.v1",
      parentTaskId: parent.id,
      parentSnapshot: {
        taskId: parent.id,
        updatedAt: parent.updatedAt,
        bodyHash: hashFanoutParentBody(parent.body),
      },
      repoCommonDir: "/repo/.git",
      scopeRoots: ["a", "b", "c"],
      children: ["a", "b", "c"].map((key) => ({
        key,
        title: key.toUpperCase(),
        body: `${key}を実装`,
        tenant: "dev",
        profile: "implement",
        worktree: join(root, `fanout-${key}`),
        ownership: [key],
        dependsOn: [],
      })),
      integrationGate: { requiredChildren: ["a", "b", "c"] },
    };
  }

  function passingInput(): FanoutIntegrationGateInput {
    const planResult = createFanoutPlan(planInput());
    const applied = applyFanoutPlan(store, {
      planResult,
      approvedPlanHash: planResult.planHash,
      orchestratorId: orchestrator.id,
      sessionId: session.id,
      generation: session.generation,
      actor: "orchestrator",
    });
    const children = applied.children.map((child) => {
      const run = store.startRun(child.task.id, "codex", `session-${child.key}`, { role: "reviewer" });
      store.endRun(run.id, "done", {
        role: "reviewer",
        verify: { status: "passed", exitCode: 0 },
      });
      store.transition({ taskId: child.task.id, to: "done", actor: "test" });
      return {
        key: child.key,
        task: store.getTask(child.task.id),
        bindings: store.listTaskOrchestratorBindings(child.task.id),
        runs: [store.getRun(run.id)!],
        links: store.listLinks(child.task.id),
      };
    });
    return {
      planResult,
      approvedPlanHash: planResult.planHash,
      authority: getFanoutApplyAuthority(store, parent.id),
      orchestrator,
      session,
      orchestratorId: orchestrator.id,
      sessionId: session.id,
      generation: session.generation,
      parentBindings: store.listTaskOrchestratorBindings(parent.id),
      children,
      repoCommonDir: planResult.plan.repoCommonDir,
      objectFormat: "sha256",
      mainRef: "refs/heads/main",
      mainHead: "a".repeat(64),
      mainHeadAfterProbe: "a".repeat(64),
      gitChildren: planResult.plan.children.map((child) => ({
        key: child.key,
        worktree: child.worktree,
        registeredWorktree: child.worktree,
        repoCommonDir: planResult.plan.repoCommonDir,
        branch: `codex/${child.key}`,
        head: child.key.repeat(64),
        clean: true,
        mainIsAncestor: true,
        changedPaths: [`${child.key}/file.ts`],
      })),
    };
  }

  function expectRejectedWithoutInputMutation(
    input: FanoutIntegrationGateInput,
    pattern: RegExp,
  ): void {
    const before = structuredClone(input);
    expect(() => evaluateFanoutIntegrationGate(input)).toThrow(pattern);
    expect(input).toEqual(before);
  }

  it("全child done・同一authority・active generation・clean/ownership/verify証拠でff-only要求だけ返す", () => {
    const input = passingInput();

    const result = evaluateFanoutIntegrationGate(input);

    expect(result).toMatchObject({
      version: "fanout-integration-decision.v1",
      ready: true,
      requestedAction: "host-ff-only-integration",
      hostRecheckRequired: true,
      planHash: input.planResult.planHash,
      mainHead: "a".repeat(64),
    });
    expect(result.children.map((child) => child.key)).toEqual(["a", "b", "c"]);
    expect(store.listEvents(parent.id, "fanout_integration_requested")).toHaveLength(0);
  });

  it.each([
    ["child未done", (input: FanoutIntegrationGateInput): void => { input.children[0]!.task!.status = "review"; }, /doneではありません/],
    ["欠落child", (input: FanoutIntegrationGateInput): void => { input.children.pop(); }, /child証拠集合/],
    ["dirty共有worktree", (input: FanoutIntegrationGateInput): void => { input.gitChildren[0]!.clean = false; }, /dirty/],
    ["未登録worktree", (input: FanoutIntegrationGateInput): void => { input.gitChildren[0]!.registeredWorktree = null; }, /worktree\/Git ownership/],
    ["ownership外変更", (input: FanoutIntegrationGateInput): void => { input.gitChildren[0]!.changedPaths = ["outside/file.ts"]; }, /ownership外/],
    ["latest main未追従", (input: FanoutIntegrationGateInput): void => { input.gitChildren[0]!.mainIsAncestor = false; }, /latest main/],
    ["main probe中更新", (input: FanoutIntegrationGateInput): void => { input.mainHeadAfterProbe = "f".repeat(64); }, /snapshot/],
    ["verify欠落", (input: FanoutIntegrationGateInput): void => { input.children[0]!.runs[0]!.meta = "{}"; }, /verify証拠/],
    ["verify失敗", (input: FanoutIntegrationGateInput): void => { input.children[0]!.runs[0]!.meta = JSON.stringify({ role: "reviewer", verify: { status: "failed" } }); }, /passedではありません/],
    ["verify skipped", (input: FanoutIntegrationGateInput): void => { input.children[0]!.runs[0]!.meta = JSON.stringify({ role: "reviewer", verify: { skipped: "no-command" } }); }, /passedではありません/],
    ["latest run failed", (input: FanoutIntegrationGateInput): void => { input.children[0]!.runs[0]!.status = "failed"; }, /最新runはdone/],
    ["別primary", (input: FanoutIntegrationGateInput): void => { input.children[0]!.bindings[0]!.orchestratorId = "o_other"; }, /primary ownership/],
    ["spec drift", (input: FanoutIntegrationGateInput): void => { input.children[0]!.task!.title = "drift"; }, /spec/],
    ["detached", (input: FanoutIntegrationGateInput): void => { input.gitChildren[0]!.branch = null; }, /専用branch/],
    ["別common-dir", (input: FanoutIntegrationGateInput): void => { input.gitChildren[0]!.repoCommonDir = "/other/.git"; }, /worktree\/Git ownership/],
    ["異形changed path", (input: FanoutIntegrationGateInput): void => { input.gitChildren[0]!.changedPaths = ["a/../secret.ts"]; }, /ownership外/],
    ["同一branch共有", (input: FanoutIntegrationGateInput): void => { input.gitChildren[1]!.branch = input.gitChildren[0]!.branch; }, /同じbranch/],
    ["dependency drift", (input: FanoutIntegrationGateInput): void => { input.children[0]!.links.push({ id: 999, parentId: input.children[0]!.task!.id, childId: input.children[1]!.task!.id, linkType: "depends-on", createdAt: 1 }); }, /depends-on集合/],
    ["別plan hash", (input: FanoutIntegrationGateInput): void => { input.approvedPlanHash = "f".repeat(64); }, /plan hash/],
    ["format不一致", (input: FanoutIntegrationGateInput): void => { input.objectFormat = "sha1"; input.mainHead = "a".repeat(40); input.mainHeadAfterProbe = input.mainHead; }, /HEAD証拠/],
    ["短縮OID", (input: FanoutIntegrationGateInput): void => { input.gitChildren[0]!.head = "a".repeat(12); }, /HEAD証拠/],
    ["未知format", (input: FanoutIntegrationGateInput): void => { input.objectFormat = "sha512"; }, /object format/],
  ])("%sをmutation 0で拒否する", (_label, mutate, pattern) => {
    const input = passingInput();
    mutate(input);
    expectRejectedWithoutInputMutation(input, pattern);
  });

  it("handoff後の旧session generationをmutation 0で拒否する", () => {
    const input = passingInput();
    store.prepareOrchestratorHandoff(session.id, session.generation, "a".repeat(64), 9_999_999_999);
    input.session = store.getOrchestratorSession(session.id);

    expectRejectedWithoutInputMutation(input, /active fence/);
  });

  it("最新runよりtask完了時刻が古いlate resultとopen runを拒否する", () => {
    const base = passingInput();
    const late = structuredClone(base);
    late.children[0]!.task!.completedAt = late.children[0]!.runs[0]!.endedAt! - 1;
    expectRejectedWithoutInputMutation(late, /late result/);

    const open = structuredClone(base);
    const running: RunRow = { ...open.children[0]!.runs[0]!, id: 999, status: "running", endedAt: null };
    open.children[0]!.runs.unshift(running);
    expectRejectedWithoutInputMutation(open, /完了済み最新run証拠/);
  });
});
