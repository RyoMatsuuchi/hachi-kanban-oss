import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OrchestratorRequestRow,
  OrchestratorRow,
  OrchestratorSessionRow,
  RuntimeCleanupRequestRow,
} from "@hachi/core";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

interface RegisterOutput {
  id: string;
  orchestrator: OrchestratorRow;
  session: OrchestratorSessionRow;
}

interface AwaitOutput {
  id: string;
  status: string;
  request: OrchestratorRequestRow;
  claimToken: string;
}

interface CleanupAwaitOutput {
  id: string;
  status: string;
  kind: "runtime_cleanup";
  request: RuntimeCleanupRequestRow;
  claimTokenPath: string;
}

interface CleanupFixtureStore {
  createOrGetRuntimeResourceRequirement(input: {
    taskId: string;
    name: string;
    bundleKind: "worktree_preview";
    spec: unknown;
    idempotencyKey: string;
  }): { id: string };
  reserveRuntimeResourceLease(input: {
    requirementId: string;
    controllerOrchestratorId: string;
    board: string;
    project: string;
    repoCommonDir: string;
    worktree: string;
    cleanupPolicy: "auto";
    managed: boolean;
    ephemeral: boolean;
    expiresAt: number;
    provenanceVersion: number;
    rolloutGeneration: number;
    actor: string;
  }): { id: string; fence: number };
  claimRuntimeResourceLease(leaseId: string, expectedFence: number, actor: string): { fence: number };
  addRuntimeResourceMember(input: {
    leaseId: string;
    expectedLeaseFence: number;
    kind: "docker_container";
    state: "active";
    cleanupPolicy: "auto";
    managed: boolean;
    ephemeral: boolean;
    scopeKey: string;
    nativeId: string;
    labelsHash: string;
    provenance: unknown;
    observedAt: number;
    actor: string;
  }): unknown;
  transitionRuntimeResourceLease(input: {
    leaseId: string;
    expectedFence: number;
    from: "provisioning";
    to: "active";
    actor: string;
  }): { fence: number };
  requestRuntimeResourceRelease(input: {
    leaseId: string;
    expectedLeaseFence: number;
    reason: string;
    actor: string;
  }): RuntimeCleanupRequestRow;
  claimRuntimeCleanupRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    expectedLeaseFence: number;
    leaseUntil: number;
    now?: number;
  }): RuntimeCleanupRequestRow;
}

describe("hachi orchestrator", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
    vi.useRealTimers();
  });

  async function register(provider?: "codex"): Promise<RegisterOutput> {
    const args = [
      "orchestrator",
      "register",
      "--label",
      "cli-test",
      "--project",
      "dev",
      "--cwd",
      process.cwd(),
      ...(provider === undefined ? [] : [
        "--provider", provider,
        "--provider-session-id", "codex-cli-test-session",
      ]),
      "--json",
    ];
    await buildProgram(ctx.deps).parseAsync(
      args,
      { from: "user" },
    );
    return JSON.parse(ctx.stdout.text()) as RegisterOutput;
  }

  it("register は stable identity・session generation・canonical worktree watch を作る", async () => {
    ctx = createTestDeps();
    const output = await register();

    expect(output.id).toBe(output.orchestrator.id);
    expect(output.orchestrator.id).toMatch(/^o_/);
    expect(output.orchestrator.repoCommonDir).not.toBe("");
    expect(output.session).toMatchObject({ orchestratorId: output.orchestrator.id, generation: 1, status: "active" });
    expect(ctx.deps.store.listOrchestratorWatches(output.orchestrator.id)).toEqual([
      expect.objectContaining({ scope: "worktree", role: "primary" }),
    ]);

    ctx.stdout.clear();
    const repeated = await register();
    expect(repeated.orchestrator.id).toBe(output.orchestrator.id);
    expect(repeated.session.id).toBe(output.session.id);
    expect(ctx.deps.store.listOrchestrators()).toHaveLength(1);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["orchestrator", "list", "--json"], { from: "user" });
    const listed = JSON.parse(ctx.stdout.text()) as {
      orchestrators: Array<{ orchestrator: OrchestratorRow; liveSession: OrchestratorSessionRow | null }>;
    };
    expect(listed).not.toHaveProperty("id");
    expect(listed).not.toHaveProperty("status");
    expect(listed.orchestrators).toEqual([
      expect.objectContaining({
        orchestrator: expect.objectContaining({ id: output.orchestrator.id }),
        liveSession: expect.objectContaining({ id: output.session.id }),
      }),
    ]);
  });

  it("await→answer は session generation と claim token でfenceしてworker回答をenqueueする", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-12T00:00:00Z") });
    ctx = createTestDeps();
    const registered = await register();
    ctx.stdout.clear();
    const task = ctx.deps.store.createTask(
      { title: "質問", body: `cwd: ${process.cwd()}`, tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(task.id, registered.orchestrator.id, "primary");
    ctx.deps.store.block(task.id, "worker-question: 方針を確認してください", "supervisor");
    ctx.deps.store.createOrGetOrchestratorRequest({
      taskId: task.id,
      questionId: "q_cli_answer",
      question: "方針を確認してください",
    });

    const heartbeat = vi.spyOn(ctx.deps.store, "heartbeatOrchestratorSession");
    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator",
        "await",
        "--session",
        registered.session.id,
        "--generation",
        String(registered.session.generation),
        "--max-wait",
        "1",
        "--json",
      ],
      { from: "user" },
    );
    const claimed = JSON.parse(ctx.stdout.text()) as AwaitOutput;
    expect(claimed).toMatchObject({ id: claimed.request.id, status: "claimed" });
    expect(claimed.request.status).toBe("claimed");
    expect(heartbeat).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(heartbeat).toHaveBeenCalledOnce();

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator",
        "answer",
        claimed.request.id,
        "A案で進めてください",
        "--session",
        registered.session.id,
        "--generation",
        String(registered.session.generation),
        "--claim",
        claimed.claimToken,
        "--json",
      ],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([]);
    expect(ctx.deps.store.getOrchestratorRequest(claimed.request.id)?.status).toBe("answering");
    expect(ctx.deps.store.listMessageFenceComments(0)).toHaveLength(1);
    const expectedProvenance = {
      kind: "orchestrator",
      actorId: registered.orchestrator.id,
      actorSessionId: registered.session.id,
      actorGeneration: registered.session.generation,
    };
    expect(ctx.deps.store.listComments(task.id).at(-1)?.provenance).toEqual(expectedProvenance);
    expect(ctx.deps.store.listEvents(task.id, "orchestrator_answer_enqueued")[0]?.provenance).toEqual(
      expectedProvenance,
    );
    const result = JSON.parse(ctx.stdout.text()) as {
      id: string;
      status: string;
      message: { to: { taskId: string } };
    };
    expect(result).toMatchObject({ id: claimed.request.id, status: "answering" });
    expect(result.message.to.taskId).toBe(task.id);
  });

  it("run_stalled は answer/escalate を拒否して専用resolveだけを許し、worker_question の answer は維持する", async () => {
    ctx = createTestDeps();
    const registered = await register();
    ctx.stdout.clear();
    const task = ctx.deps.store.createTask(
      { title: "stall確認", body: `cwd: ${process.cwd()}\n本文は変更しない`, tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(task.id, registered.orchestrator.id, "primary");
    const stalled = ctx.deps.store.createOrGetOrchestratorRequest({
      taskId: task.id,
      questionId: "run-stalled:77:cli-stalled-session",
      question: "direct run stalled",
    });
    ctx.deps.store.claimOrchestratorRequest({
      requestId: stalled.id,
      sessionId: registered.session.id,
      generation: registered.session.generation,
      claimToken: "stall-claim",
      leaseUntil: Math.floor(Date.now() / 1000) + 600,
    });

    const fencedArgs = [
      "--session",
      registered.session.id,
      "--generation",
      String(registered.session.generation),
      "--claim",
      "stall-claim",
      "--json",
    ];
    await buildProgram(ctx.deps).parseAsync(
      ["orchestrator", "answer", stalled.id, "workerへ送らない", ...fencedArgs],
      { from: "user" },
    );
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("kind=worker_question 専用");
    expect(ctx.deps.store.getOrchestratorRequest(stalled.id)?.status).toBe("claimed");
    expect(ctx.deps.store.listMessageFenceComments(0)).toHaveLength(0);

    ctx.exitCodes.length = 0;
    ctx.stderr.clear();
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      ["orchestrator", "escalate", stalled.id, "humanへ送らない", ...fencedArgs],
      { from: "user" },
    );
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("kind=worker_question 専用");
    expect(ctx.deps.store.getOrchestratorRequest(stalled.id)?.status).toBe("claimed");

    ctx.exitCodes.length = 0;
    ctx.stderr.clear();
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      ["orchestrator", "resolve", stalled.id, "handled", "停止を確認済み", ...fencedArgs],
      { from: "user" },
    );
    expect(ctx.exitCodes).toEqual([]);
    expect(ctx.deps.store.getOrchestratorRequest(stalled.id)?.status).toBe("resolved");
    expect(ctx.deps.store.getTask(task.id)?.body).toBe(task.body);
    expect(ctx.deps.store.getOrchestratorSession(registered.session.id)?.status).toBe("active");
    const resolvedEvent = ctx.deps.store.listEvents(task.id, "orchestrator_run_stalled_resolved")[0];
    expect(JSON.parse(resolvedEvent!.payload)).toEqual({
      requestId: stalled.id,
      resolution: "handled",
      reason: "停止を確認済み",
    });
    expect(resolvedEvent?.provenance).toEqual({
      kind: "orchestrator",
      actorId: registered.orchestrator.id,
      actorSessionId: registered.session.id,
      actorGeneration: registered.session.generation,
    });

    const workerQuestion = ctx.deps.store.createOrGetOrchestratorRequest({
      taskId: task.id,
      questionId: "q_cli_worker_question_after_stall",
      question: "従来のworker質問",
    });
    ctx.deps.store.claimOrchestratorRequest({
      requestId: workerQuestion.id,
      sessionId: registered.session.id,
      generation: registered.session.generation,
      claimToken: "worker-question-claim",
      leaseUntil: Math.floor(Date.now() / 1000) + 600,
    });
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator",
        "answer",
        workerQuestion.id,
        "従来どおり回答する",
        "--session",
        registered.session.id,
        "--generation",
        String(registered.session.generation),
        "--claim",
        "worker-question-claim",
        "--json",
      ],
      { from: "user" },
    );
    expect(ctx.exitCodes).toEqual([]);
    expect(ctx.deps.store.getOrchestratorRequest(workerQuestion.id)?.status).toBe("answering");
  });

  it.each([
    ["handled", "引き継ぎ推奨を処理済み", "session-budget-handled-claim"],
    ["false_positive", "推奨が誤っていた", "session-budget-false-positive-claim"],
  ] as const)("session_budget は orchestrator resolve で %s として閉じられる", async (
    resolution,
    reason,
    claimToken,
  ) => {
    ctx = createTestDeps();
    const registered = await register();
    ctx.stdout.clear();
    const task = ctx.deps.store.createTask(
      { title: "session budget確認", body: `cwd: ${process.cwd()}\n本文は変更しない`, tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(task.id, registered.orchestrator.id, "primary");
    const request = ctx.deps.store.createOrGetOrchestratorRequest({
      taskId: task.id,
      questionId: `session-budget:${resolution}:cli-session-budget`,
      question: "session budget recommendation",
    });
    ctx.deps.store.claimOrchestratorRequest({
      requestId: request.id,
      sessionId: registered.session.id,
      generation: registered.session.generation,
      claimToken,
      leaseUntil: Math.floor(Date.now() / 1000) + 600,
    });

    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator",
        "resolve",
        request.id,
        resolution,
        reason,
        "--session",
        registered.session.id,
        "--generation",
        String(registered.session.generation),
        "--claim",
        claimToken,
        "--json",
      ],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([]);
    expect(ctx.deps.store.getOrchestratorRequest(request.id)).toMatchObject({
      kind: "session_budget",
      status: "resolved",
    });
    expect(ctx.deps.store.getTask(task.id)?.body).toBe(task.body);
    expect(ctx.deps.store.getOrchestratorSession(registered.session.id)?.status).toBe("active");
    const resolvedEvent = ctx.deps.store.listEvents(task.id, "orchestrator_session_budget_resolved")[0];
    expect(JSON.parse(resolvedEvent!.payload)).toEqual({
      requestId: request.id,
      resolution,
      reason,
    });
  });

  it("awaitは長いpoll間隔でも独立heartbeatを維持し、timeout return後はtimerを止める", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-12T00:00:00Z") });
    ctx = createTestDeps();
    const registered = await register();
    ctx.stdout.clear();
    const initialHeartbeat = registered.session.heartbeatAt;
    const heartbeat = vi.spyOn(ctx.deps.store, "heartbeatOrchestratorSession");

    const awaiting = buildProgram(ctx.deps).parseAsync([
      "orchestrator",
      "await",
      "--session",
      registered.session.id,
      "--generation",
      String(registered.session.generation),
      "--interval",
      "120",
      "--max-wait",
      "101",
      "--json",
    ], { from: "user" });

    // 実障害の約98秒を越えても、30/60/90秒の更新で90秒TTLを跨いでactiveを維持する。
    await vi.advanceTimersByTimeAsync(98_000);
    const duringWait = ctx.deps.store.getOrchestratorSession(registered.session.id);
    expect(duringWait?.heartbeatAt).toBeGreaterThan(initialHeartbeat);
    expect(Math.floor(Date.now() / 1000) - (duringWait?.heartbeatAt ?? 0)).toBeLessThan(30);
    expect(heartbeat).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(3_000);
    await awaiting;
    expect(ctx.exitCodes).toContain(2);
    const returnedHeartbeat = ctx.deps.store.getOrchestratorSession(registered.session.id)?.heartbeatAt;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.deps.store.getOrchestratorSession(registered.session.id)?.heartbeatAt).toBe(returnedHeartbeat);
  });

  it("同一session/generationの並行awaitはclaim競合の敗者が待機を継続する", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-12T00:00:00Z") });
    ctx = createTestDeps();
    const registered = await register();
    ctx.stdout.clear();
    const task = ctx.deps.store.createTask(
      { title: "並行質問", body: `cwd: ${process.cwd()}`, tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(task.id, registered.orchestrator.id, "primary");
    const originalClaim = ctx.deps.store.claimOrchestratorRequest.bind(ctx.deps.store);
    let injectConflict = true;
    const claim = vi.spyOn(ctx.deps.store, "claimOrchestratorRequest").mockImplementation((input) => {
      if (injectConflict) {
        injectConflict = false;
        throw new Error("request は他の session が claim 済みです");
      }
      return originalClaim(input);
    });
    const heartbeat = vi.spyOn(ctx.deps.store, "heartbeatOrchestratorSession");
    const args = [
      "orchestrator",
      "await",
      "--session",
      registered.session.id,
      "--generation",
      String(registered.session.generation),
      "--interval",
      "1",
      "--max-wait",
      "101",
      "--json",
    ];
    const first = buildProgram(ctx.deps).parseAsync(args, { from: "user" });
    const second = buildProgram(ctx.deps).parseAsync(args, { from: "user" });
    const request = ctx.deps.store.createOrGetOrchestratorRequest({
      taskId: task.id,
      questionId: "q_concurrent_await",
      question: "並行claimを確認してください",
    });

    await vi.advanceTimersByTimeAsync(1_100);
    expect(ctx.deps.store.getOrchestratorRequest(request.id)?.status).toBe("claimed");
    expect(claim).toHaveBeenCalledTimes(2);
    expect(ctx.exitCodes).not.toContain(1);

    // 勝者のtimerは終了し、敗者だけが30/60/90秒にheartbeatして98秒障害点を越える。
    await vi.advanceTimersByTimeAsync(96_900);
    expect(heartbeat).toHaveBeenCalledTimes(5);
    const live = ctx.deps.store.getOrchestratorSession(registered.session.id);
    expect(Math.floor(Date.now() / 1000) - (live?.heartbeatAt ?? 0)).toBeLessThan(30);

    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all([first, second]);
    expect(ctx.exitCodes).toEqual([2]);
    expect(ctx.stderr.text()).not.toContain("claim 済み");
    const returnedHeartbeat = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(heartbeat).toHaveBeenCalledTimes(returnedHeartbeat);
  });

  it("handoff accept後は旧generationのawaitがSESSION_SUPERSEDEDで停止する", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-12T00:00:00Z") });
    ctx = createTestDeps();
    const registered = await register();
    ctx.stdout.clear();
    const awaiting = buildProgram(ctx.deps).parseAsync([
      "orchestrator",
      "await",
      "--session",
      registered.session.id,
      "--generation",
      String(registered.session.generation),
      "--interval",
      "120",
      "--json",
    ], { from: "user" });
    const tokenHash = "a".repeat(64);
    ctx.deps.store.prepareOrchestratorHandoff(
      registered.session.id,
      registered.session.generation,
      tokenHash,
      Math.floor(Date.now() / 1000) + 600,
    );
    ctx.deps.store.acceptOrchestratorHandoff({ oldSessionId: registered.session.id, tokenHash });

    await vi.advanceTimersByTimeAsync(31_000);
    await awaiting;

    expect(ctx.exitCodes).toContain(1);
    expect(ctx.stderr.text()).toContain("SESSION_SUPERSEDED");
  });

  it("stale takeover後は旧generationのawaitがSESSION_SUPERSEDEDで停止する", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-12T00:00:00Z") });
    ctx = createTestDeps();
    const registered = await register();
    ctx.stdout.clear();
    const awaiting = buildProgram(ctx.deps).parseAsync([
      "orchestrator",
      "await",
      "--session",
      registered.session.id,
      "--generation",
      String(registered.session.generation),
      "--interval",
      "120",
      "--json",
    ], { from: "user" });
    const now = Math.floor(Date.now() / 1000);
    ctx.deps.store.heartbeatOrchestratorSession(registered.session.id, registered.session.generation, now - 91);
    ctx.deps.store.takeoverStaleOrchestratorSession({
      orchestratorId: registered.orchestrator.id,
      staleBefore: now - 90,
    });

    await vi.advanceTimersByTimeAsync(31_000);
    await awaiting;

    expect(ctx.exitCodes).toContain(1);
    expect(ctx.stderr.text()).toContain("SESSION_SUPERSEDED");
  });

  it("旧session generationではhandoff後のmutationを拒否する", async () => {
    ctx = createTestDeps();
    const registered = await register();
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator",
        "session",
        "close",
        registered.session.id,
        "--generation",
        String(registered.session.generation),
      ],
      { from: "user" },
    );

    ctx.stderr.clear();
    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator",
        "session",
        "heartbeat",
        registered.session.id,
        "--generation",
        String(registered.session.generation),
      ],
      { from: "user" },
    );
    expect(ctx.exitCodes).toContain(1);
    expect(ctx.stderr.text()).toContain("SESSION_SUPERSEDED");
  });

  it("await は app-wakeup cleanup inbox を claim し token を0600 fileで返す", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-12T00:00:00Z") });
    ctx = createTestDeps();
    const registered = await register("codex");
    const task = ctx.deps.store.createTask(
      { title: "cleanup", body: `cwd: ${process.cwd()}`, tenant: "dev", status: "ready" },
      "tester",
    );
    const cleanupStore = ctx.deps.store as unknown as CleanupFixtureStore;
    const requirement = cleanupStore.createOrGetRuntimeResourceRequirement({
      taskId: task.id,
      name: "preview",
      bundleKind: "worktree_preview",
      spec: { version: 1, requiredMembers: ["docker_container"] },
      idempotencyKey: `${task.id}:preview`,
    });
    const lease = cleanupStore.reserveRuntimeResourceLease({
      requirementId: requirement.id,
      controllerOrchestratorId: registered.orchestrator.id,
      board: "dev",
      project: "dev",
      repoCommonDir: registered.orchestrator.repoCommonDir,
      worktree: process.cwd(),
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      provenanceVersion: 1,
      rolloutGeneration: 1,
      actor: "supervisor",
    });
    const provisioning = cleanupStore.claimRuntimeResourceLease(lease.id, lease.fence, "supervisor");
    cleanupStore.addRuntimeResourceMember({
      leaseId: lease.id,
      expectedLeaseFence: provisioning.fence,
      kind: "docker_container",
      state: "active",
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      scopeKey: `docker:${task.id}`,
      nativeId: `container-${task.id}`,
      labelsHash: "a".repeat(64),
      provenance: { version: 1, labels: {} },
      observedAt: Math.floor(Date.now() / 1000),
      actor: "supervisor",
    });
    const active = cleanupStore.transitionRuntimeResourceLease({
      leaseId: lease.id,
      expectedFence: provisioning.fence,
      from: "provisioning",
      to: "active",
      actor: "supervisor",
    });
    const cleanupRequest = cleanupStore.requestRuntimeResourceRelease({
      leaseId: lease.id,
      expectedLeaseFence: active.fence,
      reason: "poll inbox",
      actor: "test",
    });
    ctx.stdout.clear();
    const originalCleanupClaim = cleanupStore.claimRuntimeCleanupRequest.bind(cleanupStore);
    let injectConflict = true;
    const cleanupClaim = vi.spyOn(cleanupStore, "claimRuntimeCleanupRequest").mockImplementation((input) => {
      if (injectConflict) {
        injectConflict = false;
        throw new Error("runtime cleanup request は既に claim 済みです");
      }
      return originalCleanupClaim(input);
    });

    const awaiting = buildProgram(ctx.deps).parseAsync([
      "orchestrator",
      "await",
      "--session",
      registered.session.id,
      "--generation",
      String(registered.session.generation),
      "--interval",
      "1",
      "--max-wait",
      "3",
      "--json",
    ], { from: "user" });
    await vi.advanceTimersByTimeAsync(1_100);
    await awaiting;

    const outputText = ctx.stdout.text();
    const output = JSON.parse(outputText) as CleanupAwaitOutput;
    expect(output).toMatchObject({
      id: cleanupRequest.id,
      status: "claimed",
      kind: "runtime_cleanup",
      request: { id: cleanupRequest.id, status: "claimed", expectedLeaseFence: active.fence },
    });
    expect(existsSync(output.claimTokenPath)).toBe(true);
    expect(statSync(output.claimTokenPath).mode & 0o077).toBe(0);
    expect(outputText).not.toContain(readFileSync(output.claimTokenPath, "utf8").trim());
    expect(readdirSync(join(ctx.deps.env.home, "runtime-secrets", lease.id))).toEqual([
      basename(output.claimTokenPath),
    ]);
    expect(cleanupClaim).toHaveBeenCalledTimes(2);
    expect(ctx.exitCodes).not.toContain(1);
  });
});
