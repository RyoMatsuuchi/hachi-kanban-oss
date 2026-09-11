import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FakeHostResourceAdapter,
  HostResourceAdapterError,
  type CommandRunner,
  type CommandRunnerResult,
  type ProvisionContainerParams,
} from "@hachi/adapters";
import {
  createRuntimeProjectHostAdapterSnapshot,
  createRuntimeResourceReadView,
  runtimeResourcesSchema,
  type StageDeps,
  type StageResult,
} from "@hachi/core";
import { taskInput } from "@hachi/testing";
import { createRuntimeResourceReconcileConfigReloader } from "./runtime-resource-config.js";
import { setupHarness, type TestHarness } from "./test-support.js";
import { Supervisor, type TickMetricsRecorder } from "./supervisor.js";
import { dispatchStage } from "./stages/dispatch.js";
import { sessionBudgetMonitorStage } from "./stages/session-budget-monitor.js";
import type { RuntimeResourceCleanupConfig } from "./stages/resource-cleanup.js";
import type { RuntimeResourceReconcileConfig } from "./stages/resource-reconcile.js";
import { webwatchStage } from "./stages/webwatch.js";

/** 指定ミリ秒だけ待つ（実時間の短い sleep で tick 重なり禁止を検証するために使う） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("条件成立を待機中にタイムアウトしました");
    }
    await sleep(10);
  }
}

interface RecordedTickMetrics {
  tickTs: number;
  metrics: Array<{ stage: string; actions: number; durationMs: number }>;
}

interface ResourceE2EDeps extends StageDeps {
  runtimeResourceReconcile: RuntimeResourceReconcileConfig;
  runtimeResourceCleanup?: RuntimeResourceCleanupConfig;
}

interface ReloadingResourceE2EDeps extends ResourceE2EDeps {
  reloadRuntimeResourceReconcile: () => RuntimeResourceReconcileConfig | undefined;
}

class RecordingCommandRunner implements CommandRunner {
  readonly calls: string[][] = [];

  run(argv: readonly string[]): Promise<CommandRunnerResult> {
    this.calls.push([...argv]);
    return Promise.resolve({ exitCode: 1, stdout: "", stderr: "unexpected adapter side effect" });
  }
}

describe("Supervisor", () => {
  let harness: TestHarness;
  const originalWebwatchTick = webwatchStage.tick;
  const originalSessionBudgetMonitorTick = sessionBudgetMonitorStage.tick;

  beforeEach(async () => {
    harness = await setupHarness();
    // supervisor 単体テストでは実 fetch を呼ばない。webwatch 固有挙動は webwatch.test.ts で DI 検証する。
    webwatchStage.tick = async (): Promise<StageResult> => ({
      name: "webwatch",
      actions: 0,
      skipped: false,
      notes: [],
    });
    // supervisor 配線テストでは実ネイティブログを走査しない。stage 固有挙動は専用テストで検証する。
    sessionBudgetMonitorStage.tick = async (): Promise<StageResult> => ({
      name: "session-budget-monitor",
      actions: 0,
      skipped: false,
      notes: [],
    });
  });

  afterEach(async () => {
    webwatchStage.tick = originalWebwatchTick;
    sessionBudgetMonitorStage.tick = originalSessionBudgetMonitorTick;
    await harness.cleanup();
  });

  it("ステージを scheduler → resource-reconcile → cancel → native-recovery → dispatch → monitor → finalize → review → orchestrator-routing → messages → reap → resource-cleanup → notify → webwatch → telegram-in → steward → brief → session-budget-monitor の順に実行する", async () => {
    const supervisor = new Supervisor(harness.deps, { apply: false });
    const results = await supervisor.runTick();
    expect(results.map((r) => r.name)).toEqual([
      "scheduler",
      "resource-reconcile",
      "cancel",
      "native-recovery",
      "dispatch",
      "monitor",
      "finalize",
      "review",
      "orchestrator-routing",
      "messages",
      "reap",
      "resource-cleanup",
      "notify",
      "webwatch",
      "telegram-in",
      "steward",
      "brief",
      "session-budget-monitor",
    ]);
    expect(results.every((r) => r.skipped === false)).toBe(true);
  });

  it("host resource 枯渇を claim 前に backpressure し、回復後の次 tick でだけ dispatch する", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cwd = join(harness.home.home, "resource-e2e-worktree");
    mkdirSync(cwd, { recursive: true });
    const adapter = new FakeHostResourceAdapter({ scopeKey: "resource-e2e", clock: () => now * 1_000 });

    // legacy 32 network と予約済み listener 相当は unmanaged observation であり、削除・port 横取りしない。
    for (let index = 1; index <= 32; index += 1) {
      adapter.addLegacyNetwork(index.toString(16).padStart(64, "0"), "resource-e2e", `legacy-${String(index)}`);
    }
    const reservedContainers = [3190, 8977, 5432].map((hostPort, index) => {
      const nativeId = (100 + index).toString(16).padStart(64, "0");
      adapter.addContainer({
        nativeId,
        scopeKey: "resource-e2e",
        labels: { "com.docker.compose.project": `reserved-${String(hostPort)}` },
        portMappings: [{ containerPort: hostPort, hostIp: "127.0.0.1", hostPort }],
      });
      return { nativeId, hostPort };
    });

    let exhausted = true;
    let provisionCalls = 0;
    const provision = adapter.provisionContainer.bind(adapter);
    adapter.provisionContainer = async (params: ProvisionContainerParams) => {
      provisionCalls += 1;
      if (exhausted) {
        throw new HostResourceAdapterError("Docker address pool / host port が枯渇しています", "invalid_port");
      }
      return provision(params);
    };
    (harness.deps as ResourceE2EDeps).runtimeResourceReconcile = {
      mode: "enforce",
      provisioningEnabled: true,
      leaseTtlSeconds: 300,
      rolloutGeneration: 1,
      scopeKey: "resource-e2e",
      worktreePostgres: {
        image: "postgres:test",
        containerPort: 5432,
        healthCheck: { command: ["pg_isready"], intervalMs: 1, timeoutMs: 1, retries: 1 },
      },
      runtimeResources: {
        mode: "enforce",
        provisioningEnabled: true,
        leaseTtlSeconds: 300,
        rolloutGeneration: 1,
        dockerContext: "resource-e2e",
        worktreePostgres: {
          image: "postgres:test",
          containerPort: 5432,
          healthCheck: { command: ["pg_isready"], intervalMs: 1, timeoutMs: 1, retries: 1 },
        },
      },
      adapter,
    };
    (harness.deps as ResourceE2EDeps).runtimeResourceCleanup = {
      mode: "enforce",
      maxRequestsPerTick: 5,
      maxContainerRemovalsPerTick: 5,
      maxNetworkRemovalsPerTick: 5,
      maxWallSecondsPerTick: 30,
      baseBackoffSeconds: 1,
      maxBackoffSeconds: 60,
      maxAttempts: 5,
      autoCleanupRolloutGeneration: 1,
      executorId: "resource-e2e-cleanup",
      adapter,
      clockMs: () => now * 1_000,
    };

    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "resource backpressure E2E", body: `cwd: ${cwd}` }),
      "tester",
    );
    const orchestrator = harness.store.registerOrchestrator({
      label: "resource-e2e-owner",
      project: "hachi-kanban",
      repoCommonDir: cwd,
    });
    harness.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    const requirement = harness.store.createOrGetRuntimeResourceRequirement({
      taskId: task.id,
      name: "postgres",
      bundleKind: "worktree_postgres",
      spec: { version: 1, requiredMembers: ["docker_container", "tcp_port", "postgres_endpoint"] },
      idempotencyKey: `${task.id}:postgres`,
    });
    const recorded: RecordedTickMetrics[] = [];
    const metricsRecorder: TickMetricsRecorder = {
      recordTickMetrics(metrics, tickTs): void {
        recorded.push({ tickTs, metrics: metrics.map((metric) => ({ ...metric })) });
      },
    };
    const supervisor = new Supervisor(harness.deps, {
      apply: true,
      metricsRecorder,
    });

    const exhaustedTick = await supervisor.runTick(now);

    expect(provisionCalls).toBe(1);
    expect(harness.store.getTask(task.id)).toMatchObject({ status: "ready", claimLock: "" });
    expect(harness.store.listOpenRuns()).toHaveLength(0);
    expect(harness.codexBridge.requests.some((request) => request.path === "/api/prompt")).toBe(false);
    expect(exhaustedTick.find((result) => result.name === "resource-reconcile")?.actions).toBe(1);
    expect(exhaustedTick.find((result) => result.name === "dispatch")?.actions).toBe(0);
    expect(harness.store.getRuntimeResourceRequirement(requirement.id)?.status).toBe("failed");
    expect(recorded[0]?.metrics.find((metric) => metric.stage === "resource-reconcile")?.actions).toBe(1);
    const backpressureLogs = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
    expect(backpressureLogs).toContain("runtime resource provision を backpressure しました");
    expect(adapter.removeHistory).toHaveLength(0);
    expect(adapter.networkCount).toBe(32);

    exhausted = false;
    // daemon 再起動を模擬し、回復可否がプロセスメモリではなく durable requirement/lease に依存することを固定する。
    const restartedSupervisor = new Supervisor(harness.deps, { apply: true, metricsRecorder });
    const recoveredTick = await restartedSupervisor.runTick(now + 30);

    expect(provisionCalls).toBe(2);
    expect(harness.store.getTask(task.id)?.blockReason).toMatch(/^codex-in-progress:/);
    expect(harness.store.listOpenRuns()).toHaveLength(1);
    expect(recoveredTick.find((result) => result.name === "resource-reconcile")?.actions).toBe(1);
    expect(recoveredTick.find((result) => result.name === "dispatch")?.actions).toBe(1);
    expect(adapter.removeHistory).toHaveLength(0);
    expect(adapter.networkCount).toBe(32);
    const resourceView = createRuntimeResourceReadView(harness.deps.env.dbPath);
    const activeRequirement = resourceView.requirementsForTask(task.id).find((candidate) => candidate.status === "ready");
    resourceView.close();
    const activeLease = activeRequirement === undefined
      ? null
      : harness.store.getRuntimeResourceLease(activeRequirement.leaseId);
    const endpoint = activeLease === null
      ? undefined
      : harness.store.listRuntimeResourceMembers(activeLease.id).find((member) => member.kind === "postgres_endpoint");
    expect(endpoint).toMatchObject({ hostIp: "127.0.0.1", containerPort: 5432 });
    expect([3190, 8977, 5432]).not.toContain(endpoint?.hostPort);
    for (const reserved of reservedContainers) {
      const inspection = await adapter.inspectContainer(reserved.nativeId, "resource-e2e");
      expect(inspection?.portMappings).toEqual([
        { containerPort: reserved.hostPort, hostIp: "127.0.0.1", hostPort: reserved.hostPort },
      ]);
    }

    const run = harness.store.listOpenRuns()[0]!;
    const cancel = harness.store.createOrGetRunCancelRequest({
      taskId: task.id,
      runId: run.id,
      sessionId: run.sessionId,
      provider: run.provider,
      requestNonce: "resource-e2e-cancel-stopped",
      actor: "supervisor",
      reason: "resource lifecycle E2E",
      deadlineAt: now + 90,
    });
    harness.store.transitionRunCancelRequest({
      requestId: cancel.id,
      expectedStatus: cancel.status,
      to: "stopped",
      expectedRunId: run.id,
      expectedSessionId: run.sessionId,
      expectedCancelFence: cancel.cancelFence,
      requestNonce: cancel.requestNonce,
      actor: "supervisor",
      stopEvidence: { observedSessionState: "ended", evidenceId: "test:resource-e2e-stop" },
      now: now + 31,
    });
    harness.store.endRun(run.id, "failed");
    harness.store.updateBlockReason(task.id, "needs-manual: cancel stopped", "supervisor", "human");

    const cleanupTick = await restartedSupervisor.runTick(now + 60);

    expect(harness.store.getRuntimeResourceLease(activeLease!.id)?.state).toBe("released");
    const cleanupView = createRuntimeResourceReadView(harness.deps.env.dbPath);
    expect(cleanupView.cleanupRequests(activeLease!.id)).toContainEqual(expect.objectContaining({ status: "succeeded" }));
    expect(cleanupView.requirementsForTask(task.id)).toContainEqual(expect.objectContaining({
      name: `retry-${activeLease!.id}`,
      status: "pending",
    }));
    cleanupView.close();
    expect(cleanupTick.find((result) => result.name === "resource-reconcile")?.notes?.join(" ")).toContain(
      "durable cleanup request",
    );
    expect(cleanupTick.find((result) => result.name === "resource-cleanup")?.actions).toBeGreaterThanOrEqual(1);
    expect(adapter.removeHistory).toContainEqual(expect.objectContaining({
      kind: "container",
      nativeId: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    for (const reserved of reservedContainers) {
      expect(await adapter.inspectContainer(reserved.nativeId, "resource-e2e")).not.toBeNull();
    }
  }, 15_000);

  it("常駐中のconfig.json変更を次tickで再読込し、起動時snapshotではprovisionしない", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cwd = join(harness.home.home, "resource-config-reload-worktree");
    mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "--quiet", cwd], {
      stdio: "ignore",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: process.env["HOME"] ?? "/",
      },
    });
    const repoCommonDir = realpathSync.native(join(cwd, ".git"));
    const configPath = join(harness.home.home, "config.json");
    const runtimeResources = runtimeResourcesSchema.parse({
      mode: "enforce",
      provisioningEnabled: true,
      leaseTtlSeconds: 300,
      rolloutGeneration: 1,
      dockerContext: "resource-config-reload",
      worktreePostgres: {
        image: "postgres:test",
        containerPort: 5432,
        healthCheck: { command: ["pg_isready"], intervalMs: 1, timeoutMs: 1, retries: 1 },
      },
      projects: [
        {
          project: "hachi-kanban",
          repoCommonDir,
          profiles: [
            {
              id: "postgres-v1",
              bundleKind: "worktree_postgres",
              hostAdapter: "worktreePostgres",
            },
          ],
        },
      ],
    });
    writeFileSync(configPath, JSON.stringify({ runtimeResources }), "utf8");
    const commandRunner = new RecordingCommandRunner();
    const reloadRuntimeResourceReconcile = createRuntimeResourceReconcileConfigReloader(
      configPath,
      commandRunner,
    );
    const startupSnapshot = reloadRuntimeResourceReconcile();
    if (startupSnapshot === undefined) {
      throw new Error("テスト用 runtime resource config を解決できません");
    }
    const reloadDeps = harness.deps as ReloadingResourceE2EDeps;
    reloadDeps.runtimeResourceReconcile = startupSnapshot;
    reloadDeps.reloadRuntimeResourceReconcile = reloadRuntimeResourceReconcile;
    const supervisor = new Supervisor(harness.deps, { apply: true });

    // 常駐 supervisor の起動後 first tick を通し、起動時 snapshot を保持させた状態を作る。
    await supervisor.runTick(now);

    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "resource config reload E2E", body: `cwd: ${cwd}` }),
      "tester",
    );
    const orchestrator = harness.store.registerOrchestrator({
      label: "resource-config-reload-owner",
      project: "hachi-kanban",
      repoCommonDir,
    });
    harness.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    const requirement = harness.store.createOrGetRuntimeResourceRequirement({
      taskId: task.id,
      name: "runtime-profile:postgres-v1",
      bundleKind: "worktree_postgres",
      spec: {
        version: 1,
        requiredMembers: ["docker_container", "tcp_port", "postgres_endpoint"],
        ownershipSnapshot: {
          version: 1,
          profileId: "postgres-v1",
          orchestratorId: orchestrator.id,
          project: "hachi-kanban",
          repoCommonDir,
          canonicalWorktree: realpathSync.native(cwd),
        },
        hostAdapterSnapshot: createRuntimeProjectHostAdapterSnapshot(
          runtimeResources,
          "worktreePostgres",
        ),
      },
      idempotencyKey: `${task.id}:runtime-profile:postgres-v1`,
    });

    // dependency object は差し替えず、host-owned config file から profile だけを削除する。
    writeFileSync(configPath, JSON.stringify({
      runtimeResources: {
        ...runtimeResources,
        projects: [],
      },
    }), "utf8");

    const changedTick = await supervisor.runTick(now + 30);

    expect(commandRunner.calls).toEqual([]);
    expect(harness.store.getRuntimeResourceRequirement(requirement.id)).toMatchObject({
      status: "pending",
      leaseId: "",
    });
    expect(changedTick.find((result) => result.name === "resource-reconcile")?.notes?.join(" ")).toContain(
      "snapshot/config drift",
    );
    expect(changedTick.find((result) => result.name === "dispatch")?.actions).toBe(0);
  }, 15_000);

  it("session generation の handoff 後に cleanup decision を新 generation の inbox へ routing する", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cwd = join(harness.home.home, "cleanup-routing-e2e");
    mkdirSync(cwd, { recursive: true });
    const task = harness.store.createTask(
      taskInput({ status: "todo", title: "cleanup routing E2E", body: `cwd: ${cwd}`, tenant: "project-a" }),
      "tester",
    );
    const orchestrator = harness.store.registerOrchestrator({
      label: "cleanup-routing-owner",
      project: "project-a",
      repoCommonDir: cwd,
    });
    harness.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    const oldSession = harness.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    harness.store.heartbeatOrchestratorSession(oldSession.id, oldSession.generation, now);
    const requirement = harness.store.createOrGetRuntimeResourceRequirement({
      taskId: task.id,
      name: "preview",
      bundleKind: "worktree_preview",
      spec: { version: 1, requiredMembers: ["docker_container"] },
      idempotencyKey: `${task.id}:preview`,
    });
    const reserved = harness.store.reserveRuntimeResourceLease({
      requirementId: requirement.id,
      controllerOrchestratorId: orchestrator.id,
      board: harness.deps.env.board,
      project: "project-a",
      repoCommonDir: cwd,
      worktree: cwd,
      cleanupPolicy: "orchestrator",
      managed: true,
      ephemeral: true,
      expiresAt: now + 600,
      provenanceVersion: 1,
      rolloutGeneration: 1,
      actor: "tester",
    });
    const provisioning = harness.store.claimRuntimeResourceLease(reserved.id, reserved.fence, "tester");
    harness.store.addRuntimeResourceMember({
      leaseId: provisioning.id,
      expectedLeaseFence: provisioning.fence,
      kind: "docker_container",
      state: "active",
      cleanupPolicy: "orchestrator",
      managed: true,
      ephemeral: true,
      scopeKey: "cleanup-routing-e2e",
      nativeId: "a".repeat(64),
      labelsHash: "b".repeat(64),
      provenance: { version: 1, labels: {} },
      observedAt: now,
      actor: "tester",
    });
    const active = harness.store.transitionRuntimeResourceLease({
      leaseId: provisioning.id,
      expectedFence: provisioning.fence,
      from: "provisioning",
      to: "active",
      actor: "tester",
    });
    harness.store.transition({ taskId: task.id, to: "done", actor: "tester" });
    const pending = harness.store.transitionRuntimeResourceLeaseWithCleanupRequest({
      leaseId: active.id,
      expectedFence: active.fence,
      from: "active",
      terminalReason: "owner_terminal",
      decisionClass: "orchestrator",
      reason: "owner terminal cleanup",
      actor: "tester",
    });

    const handoffHash = "c".repeat(64);
    harness.store.prepareOrchestratorHandoff(oldSession.id, oldSession.generation, handoffHash, now + 300);
    const newSession = harness.store.acceptOrchestratorHandoff({
      oldSessionId: oldSession.id,
      tokenHash: handoffHash,
    });
    harness.store.heartbeatOrchestratorSession(newSession.id, newSession.generation, now);

    const supervisor = new Supervisor(harness.deps, { apply: true });
    const results = await supervisor.runTick(now);

    expect(harness.store.getOrchestratorSession(oldSession.id)?.status).toBe("superseded");
    expect(harness.store.getOrchestratorSession(newSession.id)).toMatchObject({
      status: "active",
      generation: oldSession.generation + 1,
    });
    expect(harness.store.listRuntimeCleanupInboxDeliveries(orchestrator.id)).toEqual([
      expect.objectContaining({
        requestId: pending.request.id,
        orchestratorId: orchestrator.id,
        requestStatus: "queued",
      }),
    ]);
    expect(harness.store.getRuntimeCleanupRequest(pending.request.id)?.status).toBe("queued");
    expect(results.find((result) => result.name === "orchestrator-routing")?.notes?.join(" ")).toContain(
      "poll receipt 未確認のため pending 維持",
    );
    expect(results.find((result) => result.name === "resource-cleanup")?.notes?.join(" ")).toContain("observe-only");
  });

  it("apply tick の各ステージ結果を metricsRecorder に記録する（docs/contract.md §43.1）", async () => {
    const recorded: RecordedTickMetrics[] = [];
    const recorder: TickMetricsRecorder = {
      recordTickMetrics(metrics, tickTs): void {
        recorded.push({ tickTs, metrics: metrics.map((metric) => ({ ...metric })) });
      },
    };
    const supervisor = new Supervisor(harness.deps, { apply: true, metricsRecorder: recorder });

    const results = await supervisor.runTick(1_800_000_000);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.tickTs).toBe(1_800_000_000);
    expect(recorded[0]?.metrics.map((metric) => metric.stage)).toEqual(results.map((result) => result.name));
    expect(recorded[0]?.metrics.map((metric) => metric.actions)).toEqual(results.map((result) => result.actions));
    expect(recorded[0]?.metrics.every((metric) => Number.isInteger(metric.durationMs) && metric.durationMs >= 0)).toBe(
      true,
    );
  });

  it("dry-run tick では metricsRecorder に書き込まない", async () => {
    const recorded: RecordedTickMetrics[] = [];
    const recorder: TickMetricsRecorder = {
      recordTickMetrics(metrics, tickTs): void {
        recorded.push({ tickTs, metrics: metrics.map((metric) => ({ ...metric })) });
      },
    };
    const supervisor = new Supervisor(harness.deps, { apply: false, metricsRecorder: recorder });

    await supervisor.runTick(1_800_000_000);

    expect(recorded).toEqual([]);
  });

  it("supervisor.disabled が存在する場合は全ステージを skip する", async () => {
    writeFileSync(join(harness.home.home, "supervisor.disabled"), "");

    const supervisor = new Supervisor(harness.deps, { apply: false });
    const results = await supervisor.runTick();

    expect(results).toHaveLength(18);
    expect(results.every((r) => r.skipped === true)).toBe(true);
    expect(results.every((r) => r.actions === 0)).toBe(true);
  });

  it("<stage>.disabled が存在する場合はそのステージのみ skip する", async () => {
    writeFileSync(join(harness.home.home, "dispatch.disabled"), "");

    const supervisor = new Supervisor(harness.deps, { apply: false });
    const results = await supervisor.runTick();

    const dispatchResult = results.find((r) => r.name === "dispatch");
    expect(dispatchResult?.skipped).toBe(true);

    const others = results.filter((r) => r.name !== "dispatch");
    expect(others.every((r) => r.skipped === false)).toBe(true);
  });

  it("scheduler.disabled が存在する場合は scheduler ステージのみ skip する", async () => {
    writeFileSync(join(harness.home.home, "scheduler.disabled"), "");

    const supervisor = new Supervisor(harness.deps, { apply: false });
    const results = await supervisor.runTick();

    const schedulerResult = results.find((r) => r.name === "scheduler");
    expect(schedulerResult?.skipped).toBe(true);

    const others = results.filter((r) => r.name !== "scheduler");
    expect(others.every((r) => r.skipped === false)).toBe(true);
  });

  it("cancel.disabled が存在する場合は cancel engine のみ skip する", async () => {
    writeFileSync(join(harness.home.home, "cancel.disabled"), "");

    const supervisor = new Supervisor(harness.deps, { apply: false });
    const results = await supervisor.runTick();

    expect(results.find((result) => result.name === "cancel")?.skipped).toBe(true);
    expect(results.filter((result) => result.name !== "cancel").every((result) => !result.skipped)).toBe(true);
  });

  it("1つのステージが例外を投げても他ステージの実行を妨げない", async () => {
    // store.listByStatus を一時的に壊し、dispatch ステージ内で例外を発生させる
    const original = harness.store.listByStatus.bind(harness.store);
    harness.store.listByStatus = ((): never => {
      throw new Error("boom");
    }) as typeof harness.store.listByStatus;

    const supervisor = new Supervisor(harness.deps, { apply: false });
    const results = await supervisor.runTick();

    harness.store.listByStatus = original;

    const dispatchResult = results.find((r) => r.name === "dispatch");
    expect(dispatchResult?.skipped).toBe(false);
    expect(dispatchResult?.notes?.some((n) => n.includes("boom"))).toBe(true);

    // dispatch 以外は正常に実行される
    const others = results.filter((r) => r.name !== "dispatch");
    expect(others).toHaveLength(17);
  });

  it("stop() は startLoop() で設定した interval を止める", async () => {
    const supervisor = new Supervisor(harness.deps, { apply: false });
    supervisor.startLoop(3600);
    // 例外を投げずに停止できることのみ確認する（タイマーの実発火は待たない）
    await expect(supervisor.stop()).resolves.toBeUndefined();
  });

  describe("tick の重なり禁止（docs/contract.md §12.9-2）", () => {
    it("runTick 実行中は次回 tick が開始されない（実時間の短い sleep で検証）", async () => {
      let dispatchCallCount = 0;
      // Promise executor は同期実行されるため、コンストラクタ呼び出しが終わった時点で必ず代入済み
      let releaseFirstCall!: () => void;
      let firstCallReleased = false;
      const firstCallGate = new Promise<void>((resolve) => {
        releaseFirstCall = resolve;
      });
      const releaseFirstCallOnce = (): void => {
        if (firstCallReleased) {
          return;
        }
        firstCallReleased = true;
        releaseFirstCall();
      };
      const originalTick = dispatchStage.tick;
      dispatchStage.tick = async (deps, apply, now) => {
        dispatchCallCount += 1;
        if (dispatchCallCount === 1) {
          await firstCallGate;
        }
        return originalTick(deps, apply, now);
      };

      const supervisor = new Supervisor(harness.deps, { apply: false });
      try {
        // interval を極端に短くし、1回目の tick が足止めされている間に何度も次回起動タイミングが
        // 訪れるようにする。running ガード + 完了後スケジュールにより、2回目の呼び出しは起きないはず。
        supervisor.startLoop(0.01);

        await waitUntil(() => dispatchCallCount === 1, 5_000);
        await sleep(150);
        expect(dispatchCallCount).toBe(1);

        releaseFirstCallOnce();
        await waitUntil(() => dispatchCallCount >= 2, 5_000);
      } finally {
        releaseFirstCallOnce();
        await supervisor.stop();
        dispatchStage.tick = originalTick;
      }
    });
  });

  describe("heartbeat（docs/contract.md §33.1）", () => {
    interface HeartbeatPayload {
      ts: number;
      pid: number;
      tickCount: number;
      intervalSec: number;
    }

    function heartbeatPath(h: TestHarness): string {
      return join(h.deps.env.home, "state", "supervisor-heartbeat.json");
    }

    function readHeartbeat(h: TestHarness): HeartbeatPayload {
      const raw = readFileSync(heartbeatPath(h), "utf8");
      return JSON.parse(raw) as HeartbeatPayload;
    }

    it("writeStartupHeartbeat() は tickCount=0 の heartbeat を原子的に書く", () => {
      const supervisor = new Supervisor(harness.deps, { apply: false });
      supervisor.writeStartupHeartbeat(1234567890);

      const heartbeat = readHeartbeat(harness);
      expect(heartbeat.ts).toBe(1234567890);
      expect(heartbeat.pid).toBe(process.pid);
      expect(heartbeat.tickCount).toBe(0);
      expect(heartbeat.intervalSec).toBe(30);
    });

    it("intervalSec を options で指定するとheartbeatに反映される", () => {
      const supervisor = new Supervisor(harness.deps, { apply: false, intervalSec: 45 });
      supervisor.writeStartupHeartbeat(1000);
      expect(readHeartbeat(harness).intervalSec).toBe(45);
    });

    it("startLoop() の intervalSec がheartbeatのintervalSec欄を上書きする", async () => {
      const supervisor = new Supervisor(harness.deps, { apply: false, intervalSec: 30 });
      supervisor.startLoop(45);
      supervisor.writeStartupHeartbeat(1000);
      expect(readHeartbeat(harness).intervalSec).toBe(45);
      await supervisor.stop();
    });

    it("runTick() の完了ごとに heartbeat の ts / tickCount が更新される", async () => {
      const supervisor = new Supervisor(harness.deps, { apply: false });

      await supervisor.runTick(1000);
      expect(readHeartbeat(harness)).toMatchObject({ ts: 1000, tickCount: 1 });

      await supervisor.runTick(2000);
      expect(readHeartbeat(harness)).toMatchObject({ ts: 2000, tickCount: 2 });
    });

    it("heartbeat 書き込みに失敗しても tick は継続する（state パスがディレクトリを作れない場合）", async () => {
      // state ディレクトリの位置に「ファイル」を事前に置き、mkdirSync(recursive) が失敗する状況を作る
      writeFileSync(join(harness.deps.env.home, "state"), "not a directory");

      const supervisor = new Supervisor(harness.deps, { apply: false });
      const results = await supervisor.runTick();

      expect(results).toHaveLength(18);
      expect(results.every((r) => r.skipped === false)).toBe(true);
    });
  });

  describe("tick 観測（docs/contract.md §34.4）", () => {
    function readLogLines(h: TestHarness): Array<Record<string, unknown>> {
      const logPath = join(h.home.home, "test-supervisor.jsonl");
      return readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    }

    it("tick完了ログに tickCount / tickDurationMs が記録される", async () => {
      const supervisor = new Supervisor(harness.deps, { apply: false });
      await supervisor.runTick();

      const tickCompleted = readLogLines(harness).filter((entry) => entry.msg === "tick completed");
      expect(tickCompleted).toHaveLength(1);
      expect(tickCompleted[0]?.tickCount).toBe(1);
      expect(typeof tickCompleted[0]?.tickDurationMs).toBe("number");
    });

    it("stage completedログに durationMs が記録される", async () => {
      const supervisor = new Supervisor(harness.deps, { apply: false });
      await supervisor.runTick();

      const stageCompleted = readLogLines(harness).filter((entry) => entry.msg === "stage completed");
      expect(stageCompleted.length).toBeGreaterThan(0);
      for (const entry of stageCompleted) {
        expect(typeof entry.durationMs).toBe("number");
      }
    });

    it("stage failedログにも durationMs が記録される", async () => {
      const original = harness.store.listByStatus.bind(harness.store);
      harness.store.listByStatus = ((): never => {
        throw new Error("boom");
      }) as typeof harness.store.listByStatus;

      const supervisor = new Supervisor(harness.deps, { apply: false });
      await supervisor.runTick();
      harness.store.listByStatus = original;

      const stageFailed = readLogLines(harness).filter((entry) => entry.msg === "stage failed");
      expect(stageFailed.length).toBeGreaterThan(0);
      expect(typeof stageFailed[0]?.durationMs).toBe("number");
    });
  });
});
