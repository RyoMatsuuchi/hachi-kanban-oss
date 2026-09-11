import { afterEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import type { ActorProvenance } from "./types.js";

describe("direct restart authority", () => {
  let store: SqliteKanbanStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  function createAuthority(label: string): ActorProvenance {
    const orchestrator = store!.registerOrchestrator({
      label,
      project: "hachi-kanban",
      repoCommonDir: "/repo/.git",
    });
    const session = store!.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "codex",
      providerSessionId: `${label}-provider-session`,
    });
    return {
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    };
  }

  function setup(transport: "direct" | "bridge" = "direct"): {
    provenance: ActorProvenance;
    task: ReturnType<SqliteKanbanStore["createTask"]>;
    run: ReturnType<SqliteKanbanStore["startRun"]>;
  } {
    store = new SqliteKanbanStore(":memory:");
    const provenance = createAuthority("restart-owner");
    const task = store.createTask({
      title: "restart target",
      body: "cwd: /tmp/restart-target",
      tenant: "dev",
      status: "ready",
    }, "orch", provenance);
    store.bindTaskToOrchestrator(task.id, provenance.actorId, "primary");
    const run = store.startRun(task.id, "codex", "restart-worker-session", { transport, role: "worker" });
    return { provenance, task, run };
  }

  it("external stop前にdurable intentを冪等作成し、post-stop Tx入口でexact targetを再検証する", () => {
    const target = setup();
    const input = {
      intentKey: "direct-restart-1",
      taskId: target.task.id,
      runId: target.run.id,
      sessionId: target.run.sessionId,
      expectedCancelFence: 0,
      actor: "orch",
      provenance: target.provenance,
    } as const;
    const intent = store!.createOrGetDirectRestartIntent(input);
    expect(intent).toMatchObject({
      intentKey: input.intentKey,
      taskId: target.task.id,
      runId: target.run.id,
      sessionId: target.run.sessionId,
      expectedCancelFence: 0,
      provenance: target.provenance,
    });
    expect(store!.createOrGetDirectRestartIntent(input)).toEqual(intent);
    expect(store!.listEvents(target.task.id, "direct_restart_intent_created")).toHaveLength(1);
    expect(store!.assertDirectRestartIntentCurrent({
      intentId: intent.id,
      taskId: target.task.id,
      runId: target.run.id,
      sessionId: target.run.sessionId,
      expectedCancelFence: 0,
      actor: "orch",
      provenance: target.provenance,
    })).toEqual(intent);
  });

  it("別ownerはpreflight intentを作れず、direct stop authorityを取得できない", () => {
    const target = setup();
    const other = createAuthority("restart-other");
    expect(() => store!.createOrGetDirectRestartIntent({
      intentKey: "direct-restart-cross-owner",
      taskId: target.task.id,
      runId: target.run.id,
      sessionId: target.run.sessionId,
      expectedCancelFence: 0,
      actor: "other",
      provenance: other,
    })).toThrow(/primary orchestrator authority/);
    expect(store!.listEvents(target.task.id, "direct_restart_intent_created")).toHaveLength(0);
  });

  it("bridge run・不一致fenceをpreflightで拒否する", () => {
    const target = setup("bridge");
    expect(() => store!.createOrGetDirectRestartIntent({
      intentKey: "bridge-restart-refused",
      taskId: target.task.id,
      runId: target.run.id,
      sessionId: target.run.sessionId,
      expectedCancelFence: 0,
      actor: "orch",
      provenance: target.provenance,
    })).toThrow(/transportがdirectではありません/);

    store!.endRun(target.run.id, "failed");
    const directRun = store!.startRun(target.task.id, "codex", "restart-worker-session-2", {
      transport: "direct",
      role: "worker",
    });
    expect(() => store!.createOrGetDirectRestartIntent({
      intentKey: "wrong-fence-refused",
      taskId: target.task.id,
      runId: directRun.id,
      sessionId: directRun.sessionId,
      expectedCancelFence: 1,
      actor: "orch",
      provenance: target.provenance,
    })).toThrow(/cancel fence/);
  });

  it("intent作成後にrunがcurrentでなくなればpost-stop再検証を拒否する", () => {
    const target = setup();
    const intent = store!.createOrGetDirectRestartIntent({
      intentKey: "direct-restart-stale-after-stop",
      taskId: target.task.id,
      runId: target.run.id,
      sessionId: target.run.sessionId,
      expectedCancelFence: 0,
      actor: "orch",
      provenance: target.provenance,
    });
    store!.endRun(target.run.id, "failed");
    expect(() => store!.assertDirectRestartIntentCurrent({
      intentId: intent.id,
      taskId: target.task.id,
      runId: target.run.id,
      sessionId: target.run.sessionId,
      expectedCancelFence: 0,
      actor: "orch",
      provenance: target.provenance,
    })).toThrow(/current open run\/session/);
  });

  it("重複open run異常時もlatest runだけをcurrent authorityとして扱う", () => {
    const target = setup();
    const latest = store!.startRun(target.task.id, "codex", "restart-newer-open-session", {
      transport: "direct",
      role: "worker",
    });
    expect(() => store!.createOrGetDirectRestartIntent({
      intentKey: "direct-restart-old-open-run",
      taskId: target.task.id,
      runId: target.run.id,
      sessionId: target.run.sessionId,
      expectedCancelFence: 0,
      actor: "orch",
      provenance: target.provenance,
    })).toThrow(/current open run\/session/);

    expect(store!.createOrGetDirectRestartIntent({
      intentKey: "direct-restart-latest-open-run",
      taskId: target.task.id,
      runId: latest.id,
      sessionId: latest.sessionId,
      expectedCancelFence: 0,
      actor: "orch",
      provenance: target.provenance,
    })).toMatchObject({ runId: latest.id, sessionId: latest.sessionId });
  });
});
