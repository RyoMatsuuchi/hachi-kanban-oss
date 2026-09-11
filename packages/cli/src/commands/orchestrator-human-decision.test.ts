import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKanbanReadView,
  HumanDecisionError,
  type HumanDecisionErrorCode,
  type HumanDecisionRequestRow,
  type ListHumanDecisionResponsesOptions,
  type OrchestratorRequestRow,
  type OrchestratorRow,
  type OrchestratorSessionRow,
  type RuntimeCleanupRequestRow,
} from "@hachi/core";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

interface RegisteredOrchestrator {
  orchestrator: OrchestratorRow;
  session: OrchestratorSessionRow;
}

interface AwaitCandidateSummary {
  kind: "orchestrator" | "runtime_cleanup" | "human_decision";
  id: string;
  claimableAt: number;
}

interface AwaitOutput {
  id: string;
  status: string;
  kind?: "runtime_cleanup" | "human_decision";
  request: OrchestratorRequestRow | RuntimeCleanupRequestRow | HumanDecisionRequestRow;
  claimToken?: string;
  claimTokenPath?: string;
  otherCandidates: AwaitCandidateSummary[];
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
  peekRuntimeCleanupAwaitCandidate(orchestratorId: string, now?: number): {
    requestId: string;
    claimableAt: number;
    expectedLeaseFence: number;
    leaseId: string;
    reason: string;
    ownerTaskId: string | null;
    humanAnswer: string;
  } | null;
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

interface CleanupFixture {
  store: CleanupFixtureStore;
  request: RuntimeCleanupRequestRow;
  leaseId: string;
}

interface ReadViewPrototype {
  close(): void;
  listHumanDecisionResponses(options: ListHumanDecisionResponsesOptions): HumanDecisionRequestRow[];
}

describe("hachi orchestrator await/inbox human decision", () => {
  const contexts: TestDeps[] = [];
  const baseTime = 1_788_739_200;

  afterEach(() => {
    for (const ctx of contexts.splice(0)) {
      ctx.cleanup();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createContext(): TestDeps {
    const ctx = createTestDeps();
    contexts.push(ctx);
    return ctx;
  }

  function setNow(seconds: number): void {
    vi.setSystemTime(new Date(seconds * 1000));
  }

  async function register(
    ctx: TestDeps,
    label = "human-await-test",
  ): Promise<RegisteredOrchestrator> {
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([
      "orchestrator",
      "register",
      "--label",
      label,
      "--project",
      "dev",
      "--cwd",
      process.cwd(),
      "--json",
    ], { from: "user" });
    const output = JSON.parse(ctx.stdout.text()) as RegisteredOrchestrator;
    ctx.stdout.clear();
    return output;
  }

  function createTask(ctx: TestDeps, registered: RegisteredOrchestrator, title: string): string {
    const task = ctx.deps.store.createTask(
      { title, body: `cwd: ${process.cwd()}`, tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(task.id, registered.orchestrator.id, "primary");
    return task.id;
  }

  function createOrchestratorRequest(
    ctx: TestDeps,
    taskId: string,
    key: string,
  ): OrchestratorRequestRow {
    return ctx.deps.store.createOrGetOrchestratorRequest({
      taskId,
      questionId: `q_${key}`,
      question: `orchestrator question ${key}`,
    });
  }

  function orchestratorProvenance(registered: RegisteredOrchestrator): {
    kind: "orchestrator";
    actorId: string;
    actorSessionId: string;
    actorGeneration: number;
  } {
    return {
      kind: "orchestrator",
      actorId: registered.orchestrator.id,
      actorSessionId: registered.session.id,
      actorGeneration: registered.session.generation,
    };
  }

  function createAnsweredHuman(
    ctx: TestDeps,
    registered: RegisteredOrchestrator,
    taskId: string,
    key: string,
    askedAt: number,
    answeredAt: number,
  ): HumanDecisionRequestRow {
    const request = ctx.deps.store.createHumanDecisionRequest({
      taskId,
      kind: "decision",
      title: `decision ${key}`,
      question: `human question ${key}`,
      idempotencyKey: `ask-${key}`,
      provenance: orchestratorProvenance(registered),
      now: askedAt,
    });
    return ctx.deps.store.answerHumanDecisionRequest({
      requestId: request.id,
      expectedRevision: 0,
      answerIdempotencyKey: `answer-${key}`,
      answer: { kind: "decision", text: `answer ${key}` },
      provenance: {
        kind: "human",
        actorId: `human-${key}`,
        actorSessionId: "",
        actorGeneration: null,
      },
      now: answeredAt,
    });
  }

  function createWaitingHuman(
    ctx: TestDeps,
    registered: RegisteredOrchestrator,
    taskId: string,
    key: string,
    askedAt: number,
  ): HumanDecisionRequestRow {
    return ctx.deps.store.createHumanDecisionRequest({
      taskId,
      kind: "decision",
      title: `waiting ${key}`,
      question: `waiting question ${key}`,
      idempotencyKey: `waiting-${key}`,
      provenance: orchestratorProvenance(registered),
      now: askedAt,
    });
  }

  function createCleanup(
    ctx: TestDeps,
    registered: RegisteredOrchestrator,
    taskId: string,
    key: string,
  ): CleanupFixture {
    const store = ctx.deps.store as unknown as CleanupFixtureStore;
    const now = Math.floor(Date.now() / 1000);
    const requirement = store.createOrGetRuntimeResourceRequirement({
      taskId,
      name: `preview-${key}`,
      bundleKind: "worktree_preview",
      spec: { version: 1, requiredMembers: ["docker_container"] },
      idempotencyKey: `${taskId}:preview:${key}`,
    });
    const lease = store.reserveRuntimeResourceLease({
      requirementId: requirement.id,
      controllerOrchestratorId: registered.orchestrator.id,
      board: "dev",
      project: "dev",
      repoCommonDir: registered.orchestrator.repoCommonDir,
      worktree: process.cwd(),
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      expiresAt: now + 600,
      provenanceVersion: 1,
      rolloutGeneration: 1,
      actor: "supervisor",
    });
    const provisioning = store.claimRuntimeResourceLease(lease.id, lease.fence, "supervisor");
    store.addRuntimeResourceMember({
      leaseId: lease.id,
      expectedLeaseFence: provisioning.fence,
      kind: "docker_container",
      state: "active",
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      scopeKey: `docker:${taskId}:${key}`,
      nativeId: `container-${taskId}-${key}`,
      labelsHash: "a".repeat(64),
      provenance: { version: 1, labels: {} },
      observedAt: now,
      actor: "supervisor",
    });
    const active = store.transitionRuntimeResourceLease({
      leaseId: lease.id,
      expectedFence: provisioning.fence,
      from: "provisioning",
      to: "active",
      actor: "supervisor",
    });
    const request = store.requestRuntimeResourceRelease({
      leaseId: lease.id,
      expectedLeaseFence: active.fence,
      reason: `cleanup ${key}`,
      actor: "tester",
    });
    return { store, request, leaseId: lease.id };
  }

  function awaitArgs(
    registered: RegisteredOrchestrator,
    additions: readonly string[] = [],
  ): string[] {
    return [
      "orchestrator",
      "await",
      "--session",
      registered.session.id,
      "--generation",
      String(registered.session.generation),
      "--interval",
      "1",
      "--lease",
      "60",
      "--json",
      ...additions,
    ];
  }

  async function runAwait(
    ctx: TestDeps,
    registered: RegisteredOrchestrator,
    additions: readonly string[] = [],
  ): Promise<AwaitOutput> {
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(awaitArgs(registered, additions), { from: "user" });
    return JSON.parse(ctx.stdout.text()) as AwaitOutput;
  }

  function readViewPrototype(ctx: TestDeps): ReadViewPrototype {
    const probe = createKanbanReadView(ctx.deps.env.dbPath);
    const prototype = Object.getPrototypeOf(probe) as ReadViewPrototype;
    probe.close();
    return prototype;
  }

  it("3familyを元時刻順に1件ずつclaimし、未選択summaryとcredential生成を限定する", async () => {
    vi.useFakeTimers();
    setNow(baseTime);
    const ctx = createContext();
    const registered = await register(ctx);
    const taskId = createTask(ctx, registered, "three families");

    setNow(baseTime + 10);
    const orchestratorRequest = createOrchestratorRequest(ctx, taskId, "oldest");
    setNow(baseTime + 20);
    const cleanup = createCleanup(ctx, registered, taskId, "middle");
    const cleanupCandidate = cleanup.store.peekRuntimeCleanupAwaitCandidate(registered.orchestrator.id);
    setNow(baseTime + 30);
    const human = createAnsweredHuman(ctx, registered, taskId, "newest", baseTime + 29, baseTime + 30);
    setNow(baseTime + 40);

    const orchestratorClaim = vi.spyOn(ctx.deps.store, "claimOrchestratorRequest");
    const cleanupClaim = vi.spyOn(cleanup.store, "claimRuntimeCleanupRequest");
    const humanClaim = vi.spyOn(ctx.deps.store, "claimHumanDecisionResponse");
    const secretRoot = join(ctx.deps.env.home, "runtime-secrets");

    const first = await runAwait(ctx, registered);
    expect(first).toMatchObject({ id: orchestratorRequest.id, status: "claimed" });
    expect(first.kind).toBeUndefined();
    expect(first.otherCandidates).toEqual([
      { kind: "runtime_cleanup", id: cleanup.request.id, claimableAt: cleanupCandidate?.claimableAt },
      { kind: "human_decision", id: human.id, claimableAt: human.answeredAt },
    ]);
    expect(first.otherCandidates.every((candidate) => Object.keys(candidate).sort().join(",") === "claimableAt,id,kind"))
      .toBe(true);
    expect(JSON.stringify(first.otherCandidates)).not.toMatch(/token|hash|path|question|answer/i);
    expect(orchestratorClaim).toHaveBeenCalledTimes(1);
    expect(cleanupClaim).not.toHaveBeenCalled();
    expect(humanClaim).not.toHaveBeenCalled();
    expect(existsSync(secretRoot)).toBe(false);

    const second = await runAwait(ctx, registered);
    expect(second).toMatchObject({ id: cleanup.request.id, status: "claimed", kind: "runtime_cleanup" });
    expect(second.otherCandidates).toEqual([
      { kind: "human_decision", id: human.id, claimableAt: human.answeredAt },
    ]);
    expect(second.claimTokenPath).toBeTypeOf("string");
    expect(readdirSync(join(secretRoot, cleanup.leaseId))).toHaveLength(1);
    expect(orchestratorClaim).toHaveBeenCalledTimes(1);
    expect(cleanupClaim).toHaveBeenCalledTimes(1);
    expect(humanClaim).not.toHaveBeenCalled();

    const third = await runAwait(ctx, registered);
    expect(third).toMatchObject({ id: human.id, status: "claimed", kind: "human_decision" });
    expect(third.claimToken).toBeTypeOf("string");
    expect(third.otherCandidates).toEqual([]);
    expect(cleanupClaim).toHaveBeenCalledTimes(1);
    expect(humanClaim).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(secretRoot, cleanup.leaseId))).toHaveLength(1);
  });

  it("同時刻はkindのcode-unit順、同familyはid順の最古1件を選ぶ", async () => {
    vi.useFakeTimers();
    setNow(baseTime);
    const ctx = createContext();
    const registered = await register(ctx);
    const taskId = createTask(ctx, registered, "tie ordering");

    setNow(baseTime + 10);
    const orchestratorRequest = createOrchestratorRequest(ctx, taskId, "tie");
    const cleanup = createCleanup(ctx, registered, taskId, "tie");
    const firstHuman = createAnsweredHuman(ctx, registered, taskId, "tie-a", baseTime + 10, baseTime + 10);
    const secondHuman = createAnsweredHuman(ctx, registered, taskId, "tie-b", baseTime + 10, baseTime + 10);
    const expectedHumanId = [firstHuman.id, secondHuman.id].sort()[0]!;

    const output = await runAwait(ctx, registered);
    expect(output).toMatchObject({ id: expectedHumanId, kind: "human_decision", status: "claimed" });
    expect(output.otherCandidates).toEqual([
      { kind: "orchestrator", id: orchestratorRequest.id, claimableAt: baseTime + 10 },
      { kind: "runtime_cleanup", id: cleanup.request.id, claimableAt: baseTime + 10 },
    ]);
  });

  it.each(["orchestrator", "runtime_cleanup", "human_decision"] as const)(
    "%s family単独でも公開await経路からclaimする",
    async (family) => {
      vi.useFakeTimers();
      setNow(baseTime);
      const ctx = createContext();
      const registered = await register(ctx, `single-${family}`);
      const taskId = createTask(ctx, registered, `single ${family}`);
      let expectedId: string;
      if (family === "orchestrator") {
        expectedId = createOrchestratorRequest(ctx, taskId, family).id;
      } else if (family === "runtime_cleanup") {
        expectedId = createCleanup(ctx, registered, taskId, family).request.id;
      } else {
        expectedId = createAnsweredHuman(ctx, registered, taskId, family, baseTime, baseTime).id;
      }

      const output = await runAwait(ctx, registered);
      expect(output.id).toBe(expectedId);
      expect(output.status).toBe("claimed");
      expect(output.kind).toBe(family === "orchestrator" ? undefined : family);
      expect(output.otherCandidates).toEqual([]);
    },
  );

  it("human CLAIM_CONFLICT後は同pollの他familyをclaimせず3familyを再取得する", async () => {
    vi.useFakeTimers();
    setNow(baseTime);
    const ctx = createContext();
    const registered = await register(ctx);
    const taskId = createTask(ctx, registered, "human conflict");
    const human = createAnsweredHuman(ctx, registered, taskId, "conflict", baseTime, baseTime);
    setNow(baseTime + 1);
    createOrchestratorRequest(ctx, taskId, "conflict-other");
    setNow(baseTime + 2);
    const cleanup = createCleanup(ctx, registered, taskId, "conflict-other");
    setNow(baseTime + 3);

    const prototype = readViewPrototype(ctx);
    const humanPoll = vi.spyOn(prototype, "listHumanDecisionResponses");
    const orchestratorPoll = vi.spyOn(ctx.deps.store, "listOrchestratorRequests");
    const cleanupPoll = vi.spyOn(cleanup.store, "peekRuntimeCleanupAwaitCandidate");
    const orchestratorClaim = vi.spyOn(ctx.deps.store, "claimOrchestratorRequest");
    const cleanupClaim = vi.spyOn(cleanup.store, "claimRuntimeCleanupRequest");
    const humanClaim = vi.spyOn(ctx.deps.store, "claimHumanDecisionResponse")
      .mockImplementationOnce(() => {
        throw new HumanDecisionError("CLAIM_CONFLICT", "injected human conflict");
      });

    const awaiting = buildProgram(ctx.deps).parseAsync(awaitArgs(registered), { from: "user" });
    await vi.advanceTimersByTimeAsync(0);
    expect(humanClaim).toHaveBeenCalledTimes(1);
    expect(orchestratorClaim).not.toHaveBeenCalled();
    expect(cleanupClaim).not.toHaveBeenCalled();
    expect(orchestratorPoll).toHaveBeenCalledTimes(1);
    expect(cleanupPoll).toHaveBeenCalledTimes(1);
    expect(humanPoll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_100);
    await awaiting;
    const output = JSON.parse(ctx.stdout.text()) as AwaitOutput;
    expect(output).toMatchObject({ id: human.id, kind: "human_decision", status: "claimed" });
    expect(humanClaim).toHaveBeenCalledTimes(2);
    expect(orchestratorPoll).toHaveBeenCalledTimes(2);
    expect(cleanupPoll).toHaveBeenCalledTimes(2);
    expect(humanPoll).toHaveBeenCalledTimes(2);
    expect(orchestratorClaim).not.toHaveBeenCalled();
    expect(cleanupClaim).not.toHaveBeenCalled();
  });

  it.each([
    "ACTOR_UNAUTHORIZED",
    "SESSION_SUPERSEDED",
    "REVISION_CONFLICT",
  ] as const)("human %sはfatalで他familyをclaimしない", async (code: HumanDecisionErrorCode) => {
    vi.useFakeTimers();
    setNow(baseTime);
    const ctx = createContext();
    const registered = await register(ctx, `fatal-${code}`);
    const taskId = createTask(ctx, registered, `fatal ${code}`);
    createAnsweredHuman(ctx, registered, taskId, `fatal-${code}`, baseTime, baseTime);
    setNow(baseTime + 1);
    createOrchestratorRequest(ctx, taskId, `fatal-${code}`);
    const cleanup = createCleanup(ctx, registered, taskId, `fatal-${code}`);
    const prototype = readViewPrototype(ctx);
    const close = vi.spyOn(prototype, "close");
    const heartbeat = vi.spyOn(ctx.deps.store, "heartbeatOrchestratorSession");
    const orchestratorClaim = vi.spyOn(ctx.deps.store, "claimOrchestratorRequest");
    const cleanupClaim = vi.spyOn(cleanup.store, "claimRuntimeCleanupRequest");
    vi.spyOn(ctx.deps.store, "claimHumanDecisionResponse").mockImplementationOnce(() => {
      throw new HumanDecisionError(code, `fatal ${code}`);
    });

    await buildProgram(ctx.deps).parseAsync(awaitArgs(registered), { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain(`fatal ${code}`);
    expect(orchestratorClaim).not.toHaveBeenCalled();
    expect(cleanupClaim).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    const heartbeatCalls = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(heartbeat).toHaveBeenCalledTimes(heartbeatCalls);
  });

  it("cleanup claim fatal時はtoken fileを削除する", async () => {
    vi.useFakeTimers();
    setNow(baseTime);
    const ctx = createContext();
    const registered = await register(ctx);
    const taskId = createTask(ctx, registered, "cleanup fatal");
    const cleanup = createCleanup(ctx, registered, taskId, "fatal");
    vi.spyOn(cleanup.store, "claimRuntimeCleanupRequest").mockImplementationOnce(() => {
      throw new Error("cleanup injected fatal");
    });

    await buildProgram(ctx.deps).parseAsync(awaitArgs(registered), { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("cleanup injected fatal");
    expect(readdirSync(join(ctx.deps.env.home, "runtime-secrets", cleanup.leaseId))).toEqual([]);
  });

  it("cleanup CAS後のtoken file削除不能は再pollせずfatalにする", async () => {
    vi.useFakeTimers();
    setNow(baseTime);
    const ctx = createContext();
    const registered = await register(ctx);
    const taskId = createTask(ctx, registered, "cleanup removal fatal");
    const cleanup = createCleanup(ctx, registered, taskId, "removal-fatal");
    const claim = vi.spyOn(cleanup.store, "claimRuntimeCleanupRequest").mockImplementationOnce(() => {
      const directory = join(ctx.deps.env.home, "runtime-secrets", cleanup.leaseId);
      const tokenFile = readdirSync(directory)[0]!;
      rmSync(join(directory, tokenFile));
      throw new Error("runtime cleanup request は既に claim 済みです");
    });

    await buildProgram(ctx.deps).parseAsync(awaitArgs(registered), { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("token file を削除できないため await を継続できません");
    expect(claim).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(claim).toHaveBeenCalledOnce();
  });

  it("orchestratorはlease境界を除外しhumanは境界を含める", async () => {
    vi.useFakeTimers();
    setNow(baseTime);
    const ctx = createContext();
    const registered = await register(ctx);
    const taskId = createTask(ctx, registered, "deadline boundary");
    const orchestratorRequest = createOrchestratorRequest(ctx, taskId, "boundary");
    ctx.deps.store.claimOrchestratorRequest({
      requestId: orchestratorRequest.id,
      sessionId: registered.session.id,
      generation: registered.session.generation,
      claimToken: "original-orchestrator-token",
      leaseUntil: baseTime + 10,
    });
    const human = createAnsweredHuman(ctx, registered, taskId, "boundary", baseTime, baseTime);
    ctx.deps.store.claimHumanDecisionResponse({
      requestId: human.id,
      expectedRevision: 1,
      claimToken: "original-human-token",
      leaseUntil: baseTime + 10,
      provenance: orchestratorProvenance(registered),
      now: baseTime,
    });
    setNow(baseTime + 10);

    const output = await runAwait(ctx, registered);
    expect(output).toMatchObject({ id: human.id, kind: "human_decision", status: "claimed" });
    expect(ctx.deps.store.getOrchestratorRequest(orchestratorRequest.id)).toMatchObject({
      status: "claimed",
      claimToken: "original-orchestrator-token",
      leaseUntil: baseTime + 10,
    });
  });

  it("cleanupはlease期限と同時刻に再claimできる", async () => {
    vi.useFakeTimers();
    setNow(baseTime);
    const ctx = createContext();
    const registered = await register(ctx);
    const taskId = createTask(ctx, registered, "cleanup boundary");
    const cleanup = createCleanup(ctx, registered, taskId, "boundary");
    cleanup.store.claimRuntimeCleanupRequest({
      requestId: cleanup.request.id,
      orchestratorId: registered.orchestrator.id,
      sessionId: registered.session.id,
      generation: registered.session.generation,
      claimToken: "original-cleanup-token",
      expectedLeaseFence: cleanup.request.expectedLeaseFence,
      leaseUntil: baseTime + 10,
      now: baseTime,
    });
    setNow(baseTime + 10);

    const output = await runAwait(ctx, registered);
    expect(output).toMatchObject({ id: cleanup.request.id, kind: "runtime_cleanup", status: "claimed" });
  });

  it("先頭の未失効human claimを飛ばして後方answeredをclaimする", async () => {
    vi.useFakeTimers();
    setNow(baseTime);
    const ctx = createContext();
    const registered = await register(ctx);
    const taskId = createTask(ctx, registered, "claimed head");
    const first = createAnsweredHuman(ctx, registered, taskId, "head", baseTime, baseTime + 1);
    ctx.deps.store.claimHumanDecisionResponse({
      requestId: first.id,
      expectedRevision: 1,
      claimToken: "unexpired-head-token",
      leaseUntil: baseTime + 100,
      provenance: orchestratorProvenance(registered),
      now: baseTime + 1,
    });
    const second = createAnsweredHuman(ctx, registered, taskId, "tail", baseTime + 2, baseTime + 3);
    setNow(baseTime + 10);

    const output = await runAwait(ctx, registered);
    expect(output).toMatchObject({ id: second.id, kind: "human_decision", status: "claimed" });
    const view = createKanbanReadView(ctx.deps.env.dbPath);
    try {
      expect(view.getHumanDecisionRequest(first.id)).toMatchObject({
        status: "claimed",
        claimLeaseUntil: baseTime + 100,
      });
    } finally {
      view.close();
    }
  });

  it("inboxはowner有無でanswered/claimed全件を返しwaiting_humanを除外する", async () => {
    vi.useFakeTimers();
    setNow(baseTime);
    const ctx = createContext();
    const owner = await register(ctx, "inbox-owner");
    const other = await register(ctx, "inbox-other");
    const ownerTask = createTask(ctx, owner, "owner inbox");
    const otherTask = createTask(ctx, other, "other inbox");
    const legacy = createOrchestratorRequest(ctx, ownerTask, "inbox-legacy");
    const ownerAnswered = createAnsweredHuman(ctx, owner, ownerTask, "owner-answered", baseTime, baseTime + 30);
    const ownerClaimed = createAnsweredHuman(ctx, owner, ownerTask, "owner-claimed", baseTime, baseTime + 10);
    ctx.deps.store.claimHumanDecisionResponse({
      requestId: ownerClaimed.id,
      expectedRevision: 1,
      claimToken: "owner-claimed-token",
      leaseUntil: baseTime + 100,
      provenance: orchestratorProvenance(owner),
      now: baseTime + 10,
    });
    const otherAnswered = createAnsweredHuman(ctx, other, otherTask, "other-answered", baseTime, baseTime + 20);
    const waiting = createWaitingHuman(ctx, owner, ownerTask, "excluded", baseTime + 40);
    setNow(baseTime + 50);
    const prototype = readViewPrototype(ctx);
    const close = vi.spyOn(prototype, "close");

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([
      "orchestrator", "inbox", "--orchestrator", owner.orchestrator.id, "--json",
    ], { from: "user" });
    const owned = JSON.parse(ctx.stdout.text()) as {
      requests: OrchestratorRequestRow[];
      cleanupRequests: unknown[];
      humanResponses: HumanDecisionRequestRow[];
    };
    expect(Object.keys(owned).sort()).toEqual(["cleanupRequests", "humanResponses", "requests"]);
    expect(owned.requests.map((request) => request.id)).toContain(legacy.id);
    expect(owned.cleanupRequests).toEqual([]);
    expect(owned.humanResponses.map((request) => request.id)).toEqual([ownerClaimed.id, ownerAnswered.id]);
    expect(owned.humanResponses.map((request) => request.status)).toEqual(["claimed", "answered"]);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["orchestrator", "inbox", "--json"], { from: "user" });
    const all = JSON.parse(ctx.stdout.text()) as {
      requests: OrchestratorRequestRow[];
      cleanupRequests: unknown[];
      humanResponses: HumanDecisionRequestRow[];
    };
    expect(all.humanResponses.map((request) => request.id)).toEqual([
      ownerClaimed.id,
      otherAnswered.id,
      ownerAnswered.id,
    ]);
    expect(all.humanResponses.map((request) => request.id)).not.toContain(waiting.id);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("await成功・timeout・fatal・signalでread viewをcloseしheartbeatを止める", async () => {
    vi.useFakeTimers();
    setNow(baseTime);

    const successCtx = createContext();
    const successRegistered = await register(successCtx, "lifecycle-success");
    const successTask = createTask(successCtx, successRegistered, "lifecycle success");
    createAnsweredHuman(successCtx, successRegistered, successTask, "lifecycle-success", baseTime, baseTime);
    const successPrototype = readViewPrototype(successCtx);
    const successClose = vi.spyOn(successPrototype, "close");
    const successHeartbeat = vi.spyOn(successCtx.deps.store, "heartbeatOrchestratorSession");
    await runAwait(successCtx, successRegistered);
    expect(successClose).toHaveBeenCalledOnce();
    const successHeartbeatCount = successHeartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(successHeartbeat).toHaveBeenCalledTimes(successHeartbeatCount);
    successClose.mockRestore();

    setNow(baseTime);
    const timeoutCtx = createContext();
    const timeoutRegistered = await register(timeoutCtx, "lifecycle-timeout");
    const timeoutPrototype = readViewPrototype(timeoutCtx);
    const timeoutClose = vi.spyOn(timeoutPrototype, "close");
    const timeoutHeartbeat = vi.spyOn(timeoutCtx.deps.store, "heartbeatOrchestratorSession");
    const timeout = buildProgram(timeoutCtx.deps).parseAsync(
      awaitArgs(timeoutRegistered, ["--max-wait", "1"]),
      { from: "user" },
    );
    await vi.advanceTimersByTimeAsync(1_100);
    await timeout;
    expect(timeoutCtx.exitCodes).toEqual([2]);
    expect(timeoutClose).toHaveBeenCalledOnce();
    const timeoutHeartbeatCount = timeoutHeartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(timeoutHeartbeat).toHaveBeenCalledTimes(timeoutHeartbeatCount);
    timeoutClose.mockRestore();

    setNow(baseTime);
    const fatalCtx = createContext();
    const fatalRegistered = await register(fatalCtx, "lifecycle-fatal");
    const fatalPrototype = readViewPrototype(fatalCtx);
    const fatalClose = vi.spyOn(fatalPrototype, "close");
    const fatalResponses = vi.spyOn(fatalPrototype, "listHumanDecisionResponses").mockImplementationOnce(() => {
      throw new Error("read view injected fatal");
    });
    const fatalHeartbeat = vi.spyOn(fatalCtx.deps.store, "heartbeatOrchestratorSession");
    await buildProgram(fatalCtx.deps).parseAsync(awaitArgs(fatalRegistered), { from: "user" });
    expect(fatalCtx.exitCodes).toEqual([1]);
    expect(fatalClose).toHaveBeenCalledOnce();
    const fatalHeartbeatCount = fatalHeartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fatalHeartbeat).toHaveBeenCalledTimes(fatalHeartbeatCount);
    fatalResponses.mockRestore();
    fatalClose.mockRestore();

    setNow(baseTime);
    const signalCtx = createContext();
    const signalRegistered = await register(signalCtx, "lifecycle-signal");
    const signalPrototype = readViewPrototype(signalCtx);
    const signalClose = vi.spyOn(signalPrototype, "close");
    const signalHeartbeat = vi.spyOn(signalCtx.deps.store, "heartbeatOrchestratorSession");
    const existingSignalListeners = new Set(process.listeners("SIGTERM"));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const signalled = buildProgram(signalCtx.deps).parseAsync(awaitArgs(signalRegistered), { from: "user" });
    await vi.advanceTimersByTimeAsync(0);
    const signalListener = process.listeners("SIGTERM").find((listener) => !existingSignalListeners.has(listener));
    expect(signalListener).toBeDefined();
    signalListener!("SIGTERM");
    await signalled;
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(signalClose).toHaveBeenCalledOnce();
    expect(process.listeners("SIGTERM").every((listener) => existingSignalListeners.has(listener))).toBe(true);
    const signalHeartbeatCount = signalHeartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(signalHeartbeat).toHaveBeenCalledTimes(signalHeartbeatCount);
  });

  it("read view生成失敗でもheartbeatとsignal listenerを解除する", async () => {
    vi.useFakeTimers();
    setNow(baseTime);
    const ctx = createContext();
    const registered = await register(ctx, "view-open-fatal");
    const heartbeat = vi.spyOn(ctx.deps.store, "heartbeatOrchestratorSession");
    const sigintListeners = new Set(process.listeners("SIGINT"));
    const sigtermListeners = new Set(process.listeners("SIGTERM"));
    ctx.deps.env.dbPath = join(ctx.deps.env.home, "missing", "kanban.db");

    await buildProgram(ctx.deps).parseAsync(awaitArgs(registered), { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(process.listeners("SIGINT").every((listener) => sigintListeners.has(listener))).toBe(true);
    expect(process.listeners("SIGTERM").every((listener) => sigtermListeners.has(listener))).toBe(true);
    const heartbeatCount = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(heartbeat).toHaveBeenCalledTimes(heartbeatCount);
  });

  it("cleanup capabilityにpeekだけ無い場合は空queueへ縮退しない", async () => {
    vi.useFakeTimers();
    setNow(baseTime);
    const ctx = createContext();
    const registered = await register(ctx, "missing-peek");
    const prototype = readViewPrototype(ctx);
    const close = vi.spyOn(prototype, "close");
    Object.defineProperty(ctx.deps.store, "peekRuntimeCleanupAwaitCandidate", {
      configurable: true,
      value: undefined,
    });

    await buildProgram(ctx.deps).parseAsync(awaitArgs(registered), { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("await candidate peek がありません");
    expect(close).toHaveBeenCalledOnce();
  });
});
