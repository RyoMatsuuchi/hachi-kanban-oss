import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKanbanReadView,
  type Environment,
  type HachiConfig,
  type SqliteKanbanStore,
  type Stage,
  type StageDeps,
} from "@hachi/core";
import { taskInput } from "@hachi/testing";
import type { CliDeps } from "./deps.js";
import { buildProgram } from "./program.js";
import { createBufferWriter } from "./test-support.js";

interface SupervisorHarnessModule {
  setupHarness(): Promise<SupervisorHarness>;
}

interface SupervisorHarness {
  store: SqliteKanbanStore;
  deps: StageDeps;
  home: { env: Environment };
  cleanup(): Promise<void>;
}

interface CancelStageModule {
  cancelStage: Stage;
}

interface WebAppModule {
  buildApp(deps: {
    view: ReturnType<typeof createKanbanReadView>;
    store: SqliteKanbanStore;
    artifactsDir: string;
    home: string;
    launchdLabel: string;
    bridges: Environment["bridges"];
    config: HachiConfig;
    writeToken: string;
  }): { request(path: string): Promise<Response> };
}

async function loadExternalModule<T>(relativePath: string): Promise<T> {
  const moduleUrl = new URL(relativePath, import.meta.url).href;
  return await import(/* @vite-ignore */ moduleUrl) as T;
}

describe("durable cancel wiring integration", () => {
  let harness: SupervisorHarness | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    await harness?.cleanup();
    harness = null;
  });

  it("CLI cancelから実cancelStage・orchestrator inbox・await・Web API summaryまで同じDBで繋がる", async () => {
    const supervisorHarness = await loadExternalModule<SupervisorHarnessModule>(
      "../../supervisor/src/test-support.ts",
    );
    const cancelModule = await loadExternalModule<CancelStageModule>("../../supervisor/src/stages/cancel.ts");
    const webModule = await loadExternalModule<WebAppModule>("../../web/src/app.ts");
    harness = await supervisorHarness.setupHarness();

    const task = harness.store.createTask(taskInput({
      status: "ready",
      title: "cancel integration",
      body: "cwd: /worktrees/cancel-integration",
    }), "tester");
    const ref = await harness.deps.adapters.codex.launch(task, {
      model: "gpt-5.4",
      cwd: "/worktrees/cancel-integration",
      promptText: "作業開始",
    });
    const run = harness.store.startRun(task.id, "codex", ref.sessionId, {
      serverUrl: ref.serverUrl,
      model: ref.model,
      modelDelivery: ref.modelDelivery,
      transport: "bridge",
    });
    harness.store.block(
      task.id,
      `codex-in-progress: cancel integration session=${ref.sessionId} server=${ref.serverUrl}`,
      "supervisor",
    );
    const orchestrator = harness.store.registerOrchestrator({
      label: "cancel integration owner",
      project: "dev",
      repoCommonDir: "/repo/cancel-integration",
    });
    const orchestratorSession = harness.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    harness.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");

    const stdout = createBufferWriter();
    const stderr = createBufferWriter();
    const exitCodes: number[] = [];
    const cliDeps: CliDeps = {
      store: harness.store,
      config: harness.deps.config,
      env: harness.deps.env,
      hermesHome: harness.deps.env.home,
      adapters: harness.deps.adapters,
      stdin: { read: async () => "" },
      processEnv: {},
      successorTmuxReadback: {
        readExactPane: () => ({ ok: false, reason: "unavailable" }),
        initializeServerLifetimeAndReadExactPane: () => ({ ok: false, reason: "unavailable" }),
      },
      currentHostId: () => "host-cancel-integration",
      canonicalizeSuccessorCwd: (path: string) => path,
      successorAttestationHashProbe: {
        readInstalledHashes: () => ({
          hookDefinitionHash: "a".repeat(64),
          hookExecutableHash: "b".repeat(64),
        }),
      },
      stdout,
      stderr,
      debug: false,
      exit: (code): void => { exitCodes.push(code); },
    };
    const principalArgs = [
      "--actor-kind", "orchestrator",
      "--orchestrator", orchestrator.id,
      "--session", orchestratorSession.id,
      "--generation", String(orchestratorSession.generation),
    ];

    await buildProgram(cliDeps).parseAsync([
      "task", "cancel", task.id,
      "--reason", "integration stop",
      "--force-if-supported",
      ...principalArgs,
      "--json",
    ], { from: "user" });
    expect(harness.store.listRunCancelRequests(task.id)).toHaveLength(1);

    const now = Math.floor(Date.now() / 1_000);
    await cancelModule.cancelStage.tick(harness.deps, true, now);

    const cancel = harness.store.listRunCancelRequests(task.id)[0]!;
    expect(cancel).toMatchObject({ runId: run.id, status: "cancel_requested" });
    expect(harness.store.getLatestOpenRun(task.id)?.id).toBe(run.id);
    expect(harness.store.getTask(task.id)).toMatchObject({
      status: "blocked",
      blockReason: expect.stringContaining("codex-in-progress:"),
    });
    const requests = harness.store.listOrchestratorRequests(orchestrator.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ questionId: `cancel-failure:${cancel.id}`, status: "queued" });
    expect(harness.store.listPendingNotificationOutbox()).toEqual([
      expect.objectContaining({ requestId: requests[0]!.id, kind: "orchestrator_fyi" }),
    ]);

    stdout.clear();
    await buildProgram(cliDeps).parseAsync([
      "orchestrator", "await",
      "--session", orchestratorSession.id,
      "--generation", String(orchestratorSession.generation),
      "--json",
    ], { from: "user" });
    const inbox = JSON.parse(stdout.text()) as { request: { id: string; taskId: string } };
    expect(inbox.request).toMatchObject({ id: requests[0]!.id, taskId: task.id });
    expect(harness.store.listOrchestratorRequests(orchestrator.id)).toHaveLength(1);

    stdout.clear();
    vi.useFakeTimers();
    const awaiting = buildProgram(cliDeps).parseAsync([
      "task", "await", task.id, "--interval", "2", "--max-wait", "2", "--json",
    ], { from: "user" });
    await vi.advanceTimersByTimeAsync(2_000);
    await awaiting;
    vi.useRealTimers();
    expect(exitCodes).toContain(2);
    expect(stdout.text()).toBe("");

    const view = createKanbanReadView(harness.home.env.dbPath);
    try {
      const app = webModule.buildApp({
        view,
        store: harness.store,
        artifactsDir: harness.home.env.artifactsDir,
        home: harness.home.env.home,
        launchdLabel: "com.hachi-kanban.cancel-integration",
        bridges: harness.home.env.bridges,
        config: harness.deps.config,
        writeToken: "integration-token",
      });
      const response = await app.request(`/api/task/${task.id}`);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        cancelRequests: Array<{ requestId: string; status: string; stopped: string }>;
      };
      expect(body.cancelRequests).toEqual([
        expect.objectContaining({ requestId: cancel.id, status: "cancel_requested", stopped: "no" }),
      ]);
    } finally {
      view.close();
    }
  });
});
