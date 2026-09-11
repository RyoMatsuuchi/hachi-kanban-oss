import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import { applyFanoutPlan, type FanoutApplyMarker } from "./fanout-apply.js";
import {
  createFanoutPlan,
  hashFanoutParentBody,
  type FanoutPlanInput,
  type FanoutPlanResult,
} from "./fanout-plan.js";
import type { OrchestratorRow, OrchestratorSessionRow, TaskRow } from "./types.js";

interface ConcurrentApplyOutcome {
  ok: boolean;
  applied?: boolean;
  error?: string;
}

function writeConcurrentApplyRunner(directory: string): string {
  const path = join(directory, "apply-runner.mjs");
  const dbModule = pathToFileURL(resolve(process.cwd(), "src/db.ts")).href;
  const planModule = pathToFileURL(resolve(process.cwd(), "src/fanout-plan.ts")).href;
  const applyModule = pathToFileURL(resolve(process.cwd(), "src/fanout-apply.ts")).href;
  writeFileSync(
    path,
    `import { existsSync, readFileSync, writeFileSync } from "node:fs";\n` +
      `import { SqliteKanbanStore } from ${JSON.stringify(dbModule)};\n` +
      `import { createFanoutPlan } from ${JSON.stringify(planModule)};\n` +
      `import { applyFanoutPlan } from ${JSON.stringify(applyModule)};\n` +
      `const [dbPath,inputPath,readReadyPath,releasePath,orchestratorId,sessionId,generation] = process.argv.slice(2);\n` +
      `let store;\n` +
      `try {\n` +
      `  store = new SqliteKanbanStore(dbPath);\n` +
      `  const originalListEvents = store.listEvents.bind(store);\n` +
      `  let authorityReadFenced = false;\n` +
      `  store.listEvents = (taskId, eventType, limit) => {\n` +
      `    const events = originalListEvents(taskId, eventType, limit);\n` +
      `    if (!authorityReadFenced && eventType === "fanout_plan_applied") {\n` +
      `      if (events.length !== 0) throw new Error("critical barrier前にauthorityが存在します");\n` +
      `      authorityReadFenced = true;\n` +
      `      writeFileSync(readReadyPath, "read-ready");\n` +
      `      while (!existsSync(releasePath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);\n` +
      `    }\n` +
      `    return events;\n` +
      `  };\n` +
      `  const planResult = createFanoutPlan(JSON.parse(readFileSync(inputPath, "utf8")));\n` +
      `  const result = applyFanoutPlan(store, { planResult, approvedPlanHash: planResult.planHash, orchestratorId, sessionId, generation: Number(generation), actor: "orchestrator" });\n` +
      `  process.stdout.write(JSON.stringify({ ok: true, applied: result.applied }));\n` +
      `} catch (error) {\n` +
      `  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }));\n` +
      `} finally { store?.close(); }\n`,
  );
  return path;
}

function spawnConcurrentApply(
  runner: string,
  args: string[],
): Promise<ConcurrentApplyOutcome> {
  const child = spawn(process.execPath, ["--import", "tsx", runner, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0 || stdout.length === 0) {
        rejectPromise(new Error(`concurrent apply process failed (${code}): ${stderr}`));
        return;
      }
      resolvePromise(JSON.parse(stdout) as ConcurrentApplyOutcome);
    });
  });
}

async function waitForReadyFiles(paths: string[]): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (paths.every((path) => existsSync(path))) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("concurrent apply processのbarrier準備がtimeoutしました");
}

describe("applyFanoutPlan", () => {
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
    session = store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "codex",
      providerSessionId: "fanout-orchestrator-session",
    });
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
      children: [
        {
          key: "a",
          title: "A",
          body: "Aを実装",
          tenant: "dev",
          profile: "implement",
          worktree: join(root, "fanout-a"),
          ownership: ["a"],
          dependsOn: [],
        },
        {
          key: "b",
          title: "B",
          body: "Bを実装",
          tenant: "dev",
          profile: "implement",
          worktree: join(root, "fanout-b"),
          ownership: ["b"],
          dependsOn: ["a"],
        },
        {
          key: "c",
          title: "C",
          body: "Cを実装",
          tenant: "dev",
          profile: "review",
          worktree: join(root, "fanout-c"),
          ownership: ["c"],
          dependsOn: ["b"],
        },
      ],
      integrationGate: { requiredChildren: ["a", "b", "c"] },
    };
  }

  function apply(
    planResult: FanoutPlanResult = createFanoutPlan(planInput()),
  ): ReturnType<typeof applyFanoutPlan> {
    return applyFanoutPlan(store, {
      planResult,
      approvedPlanHash: planResult.planHash,
      orchestratorId: orchestrator.id,
      sessionId: session.id,
      generation: session.generation,
      actor: "orchestrator",
    });
  }

  it("子task・subtask・depends-on・primary bindingをtodoで原子的に生成する", () => {
    const result = apply();

    expect(result.applied).toBe(true);
    expect(result.children.map((child) => child.key)).toEqual(["a", "b", "c"]);
    for (const child of result.children) {
      expect(child.task.status).toBe("todo");
      expect(child.task.body).toContain(`cwd: ${planInput().children.find((item) => item.key === child.key)!.worktree}`);
      expect(store.listTaskOrchestratorBindings(child.task.id)).toEqual([
        expect.objectContaining({ orchestratorId: orchestrator.id, role: "primary" }),
      ]);
      expect(store.listLinks(child.task.id)).toContainEqual(
        expect.objectContaining({ parentId: parent.id, childId: child.task.id, linkType: "subtask" }),
      );
    }
    expect(store.dependencies(result.children[1]!.task.id).map((task) => task.id)).toEqual([
      result.children[0]!.task.id,
    ]);
    expect(store.dependencies(result.children[2]!.task.id).map((task) => task.id)).toEqual([
      result.children[1]!.task.id,
    ]);
  });

  it("同一planを再適用してもtask・link・bindingを重複生成しない", () => {
    const planResult = createFanoutPlan(planInput());
    const first = apply(planResult);
    const taskCount = store.listRecent(100).length;

    const second = apply(planResult);

    expect(second.applied).toBe(false);
    expect(second.children.map((child) => child.task.id)).toEqual(first.children.map((child) => child.task.id));
    expect(store.listRecent(100)).toHaveLength(taskCount);
    expect(store.listComments(parent.id).filter((comment) => comment.body.startsWith("```hachi-fanout-apply-v1"))).toHaveLength(1);
  });

  it("通常commentの偽markerはauthorityとして扱わない", () => {
    const planResult = createFanoutPlan(planInput());
    store.addComment(
      parent.id,
      "human",
      `\`\`\`hachi-fanout-apply-v1\n${JSON.stringify({
        version: "fanout-apply.v1",
        parentTaskId: parent.id,
        planHash: planResult.planHash,
        orchestratorId: orchestrator.id,
        sessionId: session.id,
        generation: session.generation,
        children: planResult.plan.children.map((child) => ({ key: child.key, taskId: parent.id })),
      })}\n\`\`\``,
    );

    const result = apply(planResult);

    expect(result.applied).toBe(true);
    expect(result.children).toHaveLength(3);
    expect(store.listEvents(parent.id, "fanout_plan_applied")).toHaveLength(1);
  });

  it("authority eventのvictim mappingはchild spec照合で拒否する", () => {
    const planResult = createFanoutPlan(planInput());
    const victims = planResult.plan.children.map((child) =>
      store.createTask(
        {
          title: `victim-${child.title}`,
          body: `cwd: ${child.worktree}\n\n${child.body}`,
          tenant: child.tenant,
          profile: child.profile,
          status: "todo",
        },
        "test",
      ),
    );
    for (const victim of victims) {
      store.link(parent.id, victim.id, "subtask");
    }
    store.addEvent(parent.id, "fanout_plan_applied", "test", {
      version: "fanout-apply.v1",
      parentTaskId: parent.id,
      planHash: planResult.planHash,
      orchestratorId: orchestrator.id,
      sessionId: session.id,
      generation: session.generation,
      children: planResult.plan.children.map((child, index) => ({ key: child.key, taskId: victims[index]!.id })),
    });

    expect(() => apply(planResult)).toThrow(/child task spec/);
    expect(store.listRecent(100)).toHaveLength(4);
  });

  it("破損または複数authority eventをfail-closedで拒否する", () => {
    const planResult = createFanoutPlan(planInput());
    store.addEvent(parent.id, "fanout_plan_applied", "test", { version: "broken" });
    expect(() => apply(planResult)).toThrow(/authority eventが破損/);
    expect(store.listRecent(100)).toHaveLength(1);
    store.addEvent(parent.id, "fanout_plan_applied", "test", { version: "broken" });
    expect(() => apply(planResult)).toThrow(/複数の適用authority/);
  });

  it("親更新とsession交代後も同一identity・markerのretryは既存childへ収束する", () => {
    const planResult = createFanoutPlan(planInput());
    const first = apply(planResult);
    store.updateBody(parent.id, `${parent.body}追記\n`, "test");
    store.closeOrchestratorSession(session.id, session.generation);
    session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });

    const retried = apply(planResult);

    expect(retried.applied).toBe(false);
    expect(retried.children.map((child) => child.task.id)).toEqual(first.children.map((child) => child.task.id));
    expect(store.listRecent(100)).toHaveLength(4);
  });

  it("進行status変更は許容するがchild body driftは拒否する", () => {
    const planResult = createFanoutPlan(planInput());
    const first = apply(planResult);
    store.transition({ taskId: first.children[0]!.task.id, to: "ready", actor: "test" });
    expect(apply(planResult).applied).toBe(false);

    store.updateBody(first.children[0]!.task.id, "cwd: /other\n\nrework", "test");
    expect(() => apply(planResult)).toThrow(/child task spec/);
  });

  it("予定外dependencyと別parent subtaskをdriftとして拒否する", () => {
    const planResult = createFanoutPlan(planInput());
    const first = apply(planResult);
    const external = store.createTask({ title: "external", body: "x", tenant: "dev" }, "test");
    store.link(external.id, first.children[0]!.task.id, "depends-on");
    expect(() => apply(planResult)).toThrow(/予定外dependency/);
  });

  it("別parentからの予定外subtaskをdriftとして拒否する", () => {
    const planResult = createFanoutPlan(planInput());
    const first = apply(planResult);
    const external = store.createTask({ title: "external", body: "x", tenant: "dev" }, "test");
    store.link(external.id, first.children[0]!.task.id, "subtask");
    expect(() => apply(planResult)).toThrow(/parent subtask/);
  });

  it("親からauthority外taskへの予定外subtaskをdriftとして拒否する", () => {
    const planResult = createFanoutPlan(planInput());
    apply(planResult);
    const external = store.createTask({ title: "external", body: "x", tenant: "dev" }, "test");
    store.link(parent.id, external.id, "subtask");
    expect(() => apply(planResult)).toThrow(/subtask集合/);
  });

  it("初回適用前に親が既存subtaskを持つ場合はmutation 0で拒否する", () => {
    const preexisting = store.createTask({ title: "preexisting", body: "x", tenant: "dev" }, "test");
    store.link(parent.id, preexisting.id, "subtask");
    expect(() => apply()).toThrow(/既存subtask/);
    expect(store.listRecent(100)).toHaveLength(2);
    expect(store.listEvents(parent.id, "fanout_plan_applied")).toHaveLength(0);
  });

  it("途中例外は全mutationをrollbackし、再実行で完全な状態へ収束する", () => {
    const planResult = createFanoutPlan(planInput());
    const originalCreate = store.createTask.bind(store);
    let calls = 0;
    const spy = vi.spyOn(store, "createTask").mockImplementation((input, actor) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("injected failure");
      }
      return originalCreate(input, actor);
    });

    expect(() => apply(planResult)).toThrow(/injected failure/);
    expect(store.listRecent(100)).toHaveLength(1);
    expect(store.listLinks(parent.id)).toHaveLength(0);
    expect(store.listComments(parent.id)).toHaveLength(0);

    spy.mockRestore();
    const recovered = apply(planResult);
    expect(recovered.applied).toBe(true);
    expect(recovered.children).toHaveLength(3);
  });

  it("承認hash不一致はmutation 0で拒否する", () => {
    const planResult = createFanoutPlan(planInput());
    expect(() =>
      applyFanoutPlan(store, {
        planResult,
        approvedPlanHash: "f".repeat(64),
        orchestratorId: orchestrator.id,
        sessionId: session.id,
        generation: session.generation,
        actor: "orchestrator",
      }),
    ).toThrow(/承認済みplan hash/);
    expect(store.listRecent(100)).toHaveLength(1);
  });

  it("canonical JSONとplan payloadの改ざんはmutation 0で拒否する", () => {
    const planResult = createFanoutPlan(planInput());
    const tampered: FanoutPlanResult = {
      ...planResult,
      plan: {
        ...planResult.plan,
        children: planResult.plan.children.map((child, index) =>
          index === 0 ? { ...child, body: "改ざん" } : child,
        ),
      },
    };
    expect(() => apply(tampered)).toThrow(/canonical plan JSONとplan payload/);
    expect(store.listRecent(100)).toHaveLength(1);
  });

  it("既存適用と異なるplanは拒否する", () => {
    apply();
    const changed = planInput();
    changed.children[0]!.body = "異なる実装";
    expect(() => apply(createFanoutPlan(changed))).toThrow(/別plan hash/);
    expect(store.listRecent(100)).toHaveLength(4);
  });

  it("別identity・stale generation・stale parent snapshotを拒否する", () => {
    const planResult = createFanoutPlan(planInput());
    const other = store.registerOrchestrator({ label: "other", project: "hachi-kanban", repoCommonDir: "/repo/.git" });
    const otherSession = store.startOrchestratorSession({ orchestratorId: other.id });
    expect(() =>
      applyFanoutPlan(store, {
        planResult,
        approvedPlanHash: planResult.planHash,
        orchestratorId: other.id,
        sessionId: otherSession.id,
        generation: otherSession.generation,
        actor: "orchestrator",
      }),
    ).toThrow(/primary ownership/);

    store.closeOrchestratorSession(session.id, session.generation);
    expect(() => apply(planResult)).toThrow(/active fence/);

    session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    store.updateBody(parent.id, `${parent.body}変更`, "test");
    expect(() => apply(planResult)).toThrow(/snapshot/);
    expect(store.listRecent(100)).toHaveLength(1);
  });

  it("別processの同時applyは同一plan/異planとも一組のauthorityへ収束する", async () => {
    for (const differentPlan of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), "hachi-fanout-concurrency-"));
      const dbPath = join(dir, "kanban.db");
      const setupStore = new SqliteKanbanStore(dbPath);
      let verifier: SqliteKanbanStore | undefined;
      try {
        const sharedParent = setupStore.createTask(
          { title: "shared-parent", body: "shared", tenant: "dev", status: "todo" },
          "test",
        );
        const sharedOrchestrator = setupStore.registerOrchestrator({
          label: "shared-owner",
          project: "hachi-kanban",
          repoCommonDir: "/repo/.git",
        });
        const sharedSession = setupStore.startOrchestratorSession({ orchestratorId: sharedOrchestrator.id });
        setupStore.bindTaskToOrchestrator(sharedParent.id, sharedOrchestrator.id, "primary");
        const firstInput = planInput();
        firstInput.parentTaskId = sharedParent.id;
        firstInput.parentSnapshot = {
          taskId: sharedParent.id,
          updatedAt: sharedParent.updatedAt,
          bodyHash: hashFanoutParentBody(sharedParent.body),
        };
        const secondInput = structuredClone(firstInput);
        if (differentPlan) {
          secondInput.children[0]!.body = "競合する別plan";
        }
        const firstInputPath = join(dir, "first.json");
        const secondInputPath = join(dir, "second.json");
        const firstReadReady = join(dir, "first.read-ready");
        const secondReadReady = join(dir, "second.read-ready");
        const release = join(dir, "release");
        writeFileSync(firstInputPath, JSON.stringify(firstInput));
        writeFileSync(secondInputPath, JSON.stringify(secondInput));
        const runner = writeConcurrentApplyRunner(dir);
        setupStore.close();

        const commonArgs = [
          sharedOrchestrator.id,
          sharedSession.id,
          String(sharedSession.generation),
        ];
        const firstRun = spawnConcurrentApply(runner, [
          dbPath,
          firstInputPath,
          firstReadReady,
          release,
          ...commonArgs,
        ]);
        const secondRun = spawnConcurrentApply(runner, [
          dbPath,
          secondInputPath,
          secondReadReady,
          release,
          ...commonArgs,
        ]);
        await waitForReadyFiles([firstReadReady, secondReadReady]);
        writeFileSync(release, "write");
        const outcomes = await Promise.all([firstRun, secondRun]);
        expect(outcomes.some((outcome) => outcome.ok && outcome.applied === true)).toBe(true);
        for (const outcome of outcomes.filter((item) => !item.ok)) {
          expect(outcome.error).toMatch(
            differentPlan ? /database is locked|SQLITE_BUSY|別plan hash/ : /database is locked|SQLITE_BUSY/,
          );
        }

        verifier = new SqliteKanbanStore(dbPath);
        const authorityEvents = verifier.listEvents(sharedParent.id, "fanout_plan_applied");
        expect(authorityEvents).toHaveLength(1);
        expect(verifier.listRecent(100)).toHaveLength(4);
        const authority = JSON.parse(authorityEvents[0]!.payload) as FanoutApplyMarker;
        const childIds = authority.children.map((child) => child.taskId);
        expect(new Set(childIds).size).toBe(3);
        const links = new Map(
          childIds.flatMap((taskId) => verifier!.listLinks(taskId)).map((link) => [link.id, link]),
        );
        expect([...links.values()].filter((link) => link.linkType === "subtask")).toHaveLength(3);
        expect([...links.values()].filter((link) => link.linkType === "depends-on")).toHaveLength(2);
        for (const childId of childIds) {
          expect(verifier.listTaskOrchestratorBindings(childId)).toEqual([
            expect.objectContaining({ orchestratorId: sharedOrchestrator.id, role: "primary" }),
          ]);
        }

        const firstPlan = createFanoutPlan(firstInput);
        const secondPlan = createFanoutPlan(secondInput);
        const retry = (planResult: FanoutPlanResult): ReturnType<typeof applyFanoutPlan> =>
          applyFanoutPlan(verifier!, {
            planResult,
            approvedPlanHash: planResult.planHash,
            orchestratorId: sharedOrchestrator.id,
            sessionId: sharedSession.id,
            generation: sharedSession.generation,
            actor: "orchestrator",
          });
        const winner = authority.planHash === firstPlan.planHash ? firstPlan : secondPlan;
        const loser = authority.planHash === firstPlan.planHash ? secondPlan : firstPlan;
        expect(retry(winner).applied).toBe(false);
        if (differentPlan) {
          expect(() => retry(loser)).toThrow(/別plan hash/);
        } else {
          expect(retry(loser).applied).toBe(false);
        }
        expect(verifier.listEvents(sharedParent.id, "fanout_plan_applied")).toHaveLength(1);
        expect(verifier.listRecent(100)).toHaveLength(4);
      } finally {
        verifier?.close();
        try {
          setupStore.close();
        } catch {
          // 同時実行前にclose済みの場合はno-op。
        }
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 20_000);
});
