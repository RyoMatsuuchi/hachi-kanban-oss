import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const readViewClose = vi.hoisted(() => vi.fn());
vi.mock("@hachi/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hachi/core")>();
  return {
    ...actual,
    createKanbanReadView: (dbPath: string) => {
      const view = actual.createKanbanReadView(dbPath);
      const close = view.close.bind(view);
      view.close = (): void => {
        readViewClose();
        close();
      };
      return view;
    },
  };
});

import {
  createKanbanReadView,
  type ActorProvenance,
  type HumanDecisionRequestRow,
  type OrchestratorRow,
  type OrchestratorSessionRow,
} from "@hachi/core";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

interface RequestOutput {
  id: string;
  status: string;
  request: HumanDecisionRequestRow;
}

interface OwnerFixture {
  orchestrator: OrchestratorRow;
  session: OrchestratorSessionRow;
  provenance: ActorProvenance & { kind: "orchestrator"; actorGeneration: number };
  flags: string[];
}

describe("hachi human decision", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
    vi.clearAllMocks();
  });

  function createOwner(label: string): OwnerFixture {
    const orchestrator = ctx.deps.store.registerOrchestrator({
      label,
      project: "dev",
      repoCommonDir: join(ctx.deps.env.home, `${label}.git`),
    });
    const session = ctx.deps.store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "codex",
      providerSessionId: `${label}-provider-session`,
    });
    const provenance = {
      kind: "orchestrator" as const,
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    };
    return {
      orchestrator,
      session,
      provenance,
      flags: [
        "--actor-kind",
        "orchestrator",
        "--orchestrator",
        orchestrator.id,
        "--session",
        session.id,
        "--generation",
        String(session.generation),
      ],
    };
  }

  function writeJson(name: string, value: unknown): string {
    const path = join(ctx.deps.env.home, name);
    writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
    return path;
  }

  function resetOutput(): void {
    ctx.stdout.clear();
    ctx.stderr.clear();
    ctx.exitCodes.length = 0;
  }

  async function run(args: string[]): Promise<void> {
    resetOutput();
    await buildProgram(ctx.deps).parseAsync(args, { from: "user" });
  }

  async function expectFailure(args: string[], message: string): Promise<void> {
    await run(args);
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain(message);
    expect(ctx.stdout.text()).toBe("");
  }

  function output(): RequestOutput {
    return JSON.parse(ctx.stdout.text()) as RequestOutput;
  }

  function currentRequest(requestId: string): HumanDecisionRequestRow {
    const view = createKanbanReadView(ctx.deps.env.dbPath);
    try {
      const request = view.getHumanDecisionRequest(requestId);
      if (request === null) throw new Error(`test request not found: ${requestId}`);
      return request;
    } finally {
      view.close();
    }
  }

  function requestsForTask(taskId: string): HumanDecisionRequestRow[] {
    const view = createKanbanReadView(ctx.deps.env.dbPath);
    try {
      return view.listHumanDecisionRequests({ taskId });
    } finally {
      view.close();
    }
  }

  function decisionAsk(taskId: string, idempotencyKey: string): Record<string, unknown> {
    return {
      taskId,
      kind: "decision",
      title: "公開方針",
      question: "どちらの方針を選びますか",
      idempotencyKey,
      choices: [
        { id: "publish", label: "公開する" },
        { id: "retain", label: "現状維持" },
      ],
      links: [],
    };
  }

  async function ask(
    taskId: string,
    owner: OwnerFixture,
    idempotencyKey: string,
    name = `${idempotencyKey}.json`,
  ): Promise<RequestOutput> {
    const input = writeJson(name, decisionAsk(taskId, idempotencyKey));
    await run(["orchestrator", "ask", "--input", input, ...owner.flags, "--json"]);
    expect(ctx.exitCodes).toEqual([]);
    return output();
  }

  it("ask→answer→core claim→release/resolveと終端後のexact retryを公開CLIで実行する", async () => {
    ctx = createTestDeps();
    const owner = createOwner("owner-flow");
    const task = ctx.deps.store.createTask(
      { title: "人間判断", body: `cwd: ${process.cwd()}`, tenant: "dev", status: "ready" },
      "tester",
    );
    const taskBefore = ctx.deps.store.getTask(task.id);

    const created = await ask(task.id, owner, "ask-flow");
    expect(created).toMatchObject({
      id: created.request.id,
      status: "waiting_human",
      request: {
        taskId: task.id,
        ownerOrchestratorId: owner.orchestrator.id,
        kind: "decision",
        choices: [{ id: "publish", label: "公開する" }, { id: "retain", label: "現状維持" }],
      },
    });
    expect(JSON.stringify(created)).not.toContain("claimToken");
    expect(JSON.stringify(created)).not.toContain("claim_token_hash");

    const repeatedAsk = await ask(task.id, owner, "ask-flow", "ask-flow-retry.json");
    expect(repeatedAsk.request.id).toBe(created.request.id);
    expect(requestsForTask(task.id)).toHaveLength(1);
    const conflictingAsk = writeJson("ask-flow-conflict.json", {
      ...decisionAsk(task.id, "ask-flow"),
      question: "同じkeyの異なる質問",
    });
    await expectFailure(
      ["orchestrator", "ask", "--input", conflictingAsk, ...owner.flags, "--json"],
      "IDEMPOTENCY_CONFLICT",
    );
    expect(requestsForTask(task.id)).toHaveLength(1);

    const answerInput = writeJson("answer-flow.json", {
      expectedRevision: 0,
      answerIdempotencyKey: "answer-flow",
      answer: { kind: "decision", choiceId: "publish" },
      comment: "人間が確認しました",
    });
    const answerArgs = [
      "human-decision",
      "answer",
      created.request.id,
      "--input",
      answerInput,
      "--author",
      "human-local-1",
      "--actor-kind",
      "human",
      "--json",
    ];
    await run(answerArgs);
    expect(output().request).toMatchObject({
      status: "answered",
      answerRevision: 1,
      answer: { kind: "decision", choiceId: "publish" },
      answerComment: "人間が確認しました",
      answerProvenance: {
        kind: "human",
        actorId: "human-local-1",
        actorSessionId: "",
        actorGeneration: null,
      },
    });

    await run(answerArgs);
    expect(output().request.status).toBe("answered");
    const conflictingAnswer = writeJson("answer-flow-conflict.json", {
      expectedRevision: 0,
      answerIdempotencyKey: "answer-flow",
      answer: { kind: "decision", choiceId: "retain" },
      comment: "人間が確認しました",
    });
    await expectFailure([
      "human-decision",
      "answer",
      created.request.id,
      "--input",
      conflictingAnswer,
      "--author",
      "human-local-1",
      "--actor-kind",
      "human",
      "--json",
    ], "IDEMPOTENCY_CONFLICT");
    expect(currentRequest(created.request.id).status).toBe("answered");

    const now = Math.floor(Date.now() / 1000);
    ctx.deps.store.claimHumanDecisionResponse({
      requestId: created.request.id,
      expectedRevision: 1,
      claimToken: "release-token",
      leaseUntil: now + 600,
      provenance: owner.provenance,
      now,
    });
    await run(answerArgs);
    expect(output().request.status).toBe("claimed");

    await run([
      "human-decision",
      "release",
      created.request.id,
      "--expected-revision",
      "1",
      "--claim",
      "release-token",
      ...owner.flags,
      "--json",
    ]);
    expect(output().request).toMatchObject({ status: "answered", claimantSessionId: null, claimLeaseUntil: null });

    ctx.deps.store.claimHumanDecisionResponse({
      requestId: created.request.id,
      expectedRevision: 1,
      claimToken: "resolve-token",
      leaseUntil: now + 600,
      provenance: owner.provenance,
      now,
    });
    await run([
      "human-decision",
      "resolve",
      created.request.id,
      "--expected-revision",
      "1",
      "--claim",
      "resolve-token",
      "--resolution",
      JSON.stringify({ outcome: "handled", note: "公開反映済み" }),
      ...owner.flags,
      "--json",
    ]);
    expect(output().request).toMatchObject({
      status: "resolved",
      resolution: { outcome: "handled", note: "公開反映済み" },
      claimantSessionId: null,
      claimLeaseUntil: null,
    });

    await run(answerArgs);
    expect(output().request.status).toBe("resolved");
    expect(ctx.deps.store.getTask(task.id)).toEqual(taskBefore);
  });

  it("showは成功時も不存在時もreadonly viewをcloseし、cancelはowner fenceで実行する", async () => {
    ctx = createTestDeps();
    const owner = createOwner("owner-show-cancel");
    const task = ctx.deps.store.createTask(
      { title: "cancel", body: `cwd: ${process.cwd()}`, tenant: "dev" },
      "tester",
    );
    const taskBefore = ctx.deps.store.getTask(task.id);
    const input = writeJson("ask-approval.json", {
      taskId: task.id,
      kind: "approval",
      title: "承認",
      question: "このrevisionを承認しますか",
      idempotencyKey: "ask-approval",
      action: "publish",
      targetRevision: { kind: "git_commit", value: "a".repeat(40) },
    });
    await run(["orchestrator", "ask", "--input", input, ...owner.flags, "--json"]);
    const requestId = output().request.id;

    readViewClose.mockClear();
    await run(["human-decision", "show", requestId, "--json"]);
    expect(output().request).toMatchObject({ id: requestId, kind: "approval", status: "waiting_human" });
    expect(readViewClose).toHaveBeenCalledTimes(1);

    await run(["human-decision", "show", requestId]);
    expect(ctx.stdout.text()).toContain(`request: ${requestId}`);
    expect(ctx.stdout.text()).toContain("kind: approval");
    expect(ctx.stdout.text()).toContain("status: waiting_human");
    expect(ctx.stdout.text()).toContain("question: このrevisionを承認しますか");
    expect(ctx.stdout.text()).toContain("answer: -");
    expect(readViewClose).toHaveBeenCalledTimes(2);

    await expectFailure(["human-decision", "show", "hd_0000000000000000", "--json"], "REQUEST_NOT_FOUND");
    expect(readViewClose).toHaveBeenCalledTimes(3);

    await run([
      "human-decision",
      "cancel",
      requestId,
      "--expected-revision",
      "0",
      "--reason",
      "別の依頼で訂正するため",
      ...owner.flags,
      "--json",
    ]);
    expect(output().request).toMatchObject({
      status: "cancelled",
      cancelReason: "別の依頼で訂正するため",
      cancelProvenance: owner.provenance,
    });
    expect(ctx.deps.store.getTask(task.id)).toEqual(taskBefore);
  });

  it("ask/answerのJSON境界はobject・既知field・型・actor注入をmutation前に検証する", async () => {
    ctx = createTestDeps();
    const owner = createOwner("owner-input");
    const task = ctx.deps.store.createTask(
      { title: "input", body: `cwd: ${process.cwd()}`, tenant: "dev" },
      "tester",
    );
    const base = decisionAsk(task.id, "invalid-ask");
    const invalidAsks: Array<{ value: unknown; message: string }> = [
      { value: [], message: "objectが必須" },
      { value: null, message: "objectが必須" },
      { value: { ...base, unexpected: true }, message: "未定義field" },
      { value: { ...base, provenance: owner.provenance }, message: "未定義field" },
      { value: { ...base, now: 0 }, message: "未定義field" },
      { value: { ...base, title: 42 }, message: "title は文字列" },
    ];
    for (const [index, candidate] of invalidAsks.entries()) {
      const input = writeJson(`invalid-ask-${index}.json`, candidate.value);
      await expectFailure(
        ["orchestrator", "ask", "--input", input, ...owner.flags, "--json"],
        candidate.message,
      );
      expect(requestsForTask(task.id)).toEqual([]);
    }

    const created = await ask(task.id, owner, "answer-boundary");
    const answerBase = {
      expectedRevision: 0,
      answerIdempotencyKey: "answer-boundary",
      answer: { kind: "decision", choiceId: "publish" },
    };
    const invalidAnswers: Array<{ value: unknown; message: string }> = [
      { value: [], message: "objectが必須" },
      { value: null, message: "objectが必須" },
      { value: { ...answerBase, requestId: created.request.id }, message: "未定義field" },
      { value: { ...answerBase, provenance: { kind: "human" } }, message: "未定義field" },
      { value: { ...answerBase, now: 0 }, message: "未定義field" },
      { value: { ...answerBase, expectedRevision: 1 }, message: "expectedRevisionは0" },
      {
        value: { ...answerBase, answer: { kind: "approval", outcome: "approve" } },
        message: "request kindと一致しません",
      },
    ];
    for (const [index, candidate] of invalidAnswers.entries()) {
      const input = writeJson(`invalid-answer-${index}.json`, candidate.value);
      await expectFailure([
        "human-decision",
        "answer",
        created.request.id,
        "--input",
        input,
        "--author",
        "human-local-input",
        "--actor-kind",
        "human",
        "--json",
      ], candidate.message);
      expect(currentRequest(created.request.id).status).toBe("waiting_human");
    }
  });

  it("owner/session/generation/revision/tokenの誤りはrequestとtaskを不変のまま拒否する", async () => {
    ctx = createTestDeps();
    const owner = createOwner("owner-fence");
    const other = createOwner("other-fence");
    const task = ctx.deps.store.createTask(
      { title: "fence", body: `cwd: ${process.cwd()}`, tenant: "dev", status: "todo" },
      "tester",
    );
    const taskBefore = ctx.deps.store.getTask(task.id);
    const created = await ask(task.id, owner, "fence-request");
    const waiting = currentRequest(created.request.id);

    const unauthorizedAsk = writeJson("unauthorized-ask.json", decisionAsk(task.id, "unauthorized-ask"));
    await expectFailure(
      ["orchestrator", "ask", "--input", unauthorizedAsk, "--json"],
      "--actor-kind orchestrator",
    );
    await expectFailure(
      ["orchestrator", "ask", "--input", unauthorizedAsk, "--actor-kind", "human", "--json"],
      "--actor-kind orchestrator",
    );
    expect(requestsForTask(task.id)).toEqual([waiting]);

    await expectFailure([
      "human-decision",
      "cancel",
      created.request.id,
      "--expected-revision",
      "0",
      "--reason",
      "other owner",
      ...other.flags,
      "--json",
    ], "OWNER_MISMATCH");
    expect(currentRequest(created.request.id)).toEqual(waiting);

    ctx.deps.store.closeOrchestratorSession(owner.session.id, owner.session.generation);
    const currentSession = ctx.deps.store.startOrchestratorSession({
      orchestratorId: owner.orchestrator.id,
      provider: "codex",
      providerSessionId: "owner-fence-current-provider-session",
    });
    const currentOwner: OwnerFixture = {
      orchestrator: owner.orchestrator,
      session: currentSession,
      provenance: {
        kind: "orchestrator",
        actorId: owner.orchestrator.id,
        actorSessionId: currentSession.id,
        actorGeneration: currentSession.generation,
      },
      flags: [
        "--actor-kind",
        "orchestrator",
        "--orchestrator",
        owner.orchestrator.id,
        "--session",
        currentSession.id,
        "--generation",
        String(currentSession.generation),
      ],
    };
    await expectFailure([
      "human-decision",
      "cancel",
      created.request.id,
      "--expected-revision",
      "0",
      "--reason",
      "old session",
      ...owner.flags,
      "--json",
    ], "SESSION_SUPERSEDED");
    expect(currentRequest(created.request.id)).toEqual(waiting);

    const wrongGenerationFlags = currentOwner.flags.slice();
    wrongGenerationFlags[wrongGenerationFlags.length - 1] = String(currentSession.generation + 1);
    await expectFailure([
      "human-decision",
      "cancel",
      created.request.id,
      "--expected-revision",
      "0",
      "--reason",
      "old generation",
      ...wrongGenerationFlags,
      "--json",
    ], "SESSION_SUPERSEDED");
    expect(currentRequest(created.request.id)).toEqual(waiting);

    const answerInput = writeJson("fence-answer.json", {
      expectedRevision: 0,
      answerIdempotencyKey: "fence-answer",
      answer: { kind: "decision", choiceId: "retain" },
    });
    await expectFailure([
      "human-decision",
      "answer",
      created.request.id,
      "--input",
      answerInput,
      "--author",
      "display-only",
      "--json",
    ], "--actor-kind human");
    expect(currentRequest(created.request.id)).toEqual(waiting);

    await expectFailure([
      "human-decision",
      "answer",
      created.request.id,
      "--input",
      answerInput,
      "--author",
      "display-only",
      ...owner.flags,
      "--json",
    ], "--actor-kind human");
    expect(currentRequest(created.request.id)).toEqual(waiting);

    await run([
      "human-decision",
      "answer",
      created.request.id,
      "--input",
      answerInput,
      "--author",
      "human-fence",
      "--actor-kind",
      "human",
      "--json",
    ]);
    const now = Math.floor(Date.now() / 1000);
    ctx.deps.store.claimHumanDecisionResponse({
      requestId: created.request.id,
      expectedRevision: 1,
      claimToken: "correct-token",
      leaseUntil: now + 600,
      provenance: currentOwner.provenance,
      now,
    });
    const claimed = currentRequest(created.request.id);

    await expectFailure([
      "human-decision",
      "release",
      created.request.id,
      "--expected-revision",
      "1",
      "--claim",
      "wrong-token",
      ...currentOwner.flags,
      "--json",
    ], "CLAIM_CONFLICT");
    expect(currentRequest(created.request.id)).toEqual(claimed);

    await expectFailure([
      "human-decision",
      "resolve",
      created.request.id,
      "--expected-revision",
      "1",
      "--claim",
      "correct-token",
      "--resolution",
      JSON.stringify({ outcome: "handled", extra: true }),
      ...currentOwner.flags,
      "--json",
    ], "未定義field");
    expect(currentRequest(created.request.id)).toEqual(claimed);

    resetOutput();
    await expect(buildProgram(ctx.deps).parseAsync([
      "human-decision",
      "release",
      created.request.id,
      "--expected-revision",
      "0",
      "--claim",
      "correct-token",
      ...currentOwner.flags,
      "--json",
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });
    expect(currentRequest(created.request.id)).toEqual(claimed);
    expect(ctx.deps.store.getTask(task.id)).toEqual(taskBefore);
  });

  it("既存orchestrator worker-question/stall commandはhuman decision IDを受理しない", async () => {
    ctx = createTestDeps();
    const owner = createOwner("owner-command-boundary");
    const task = ctx.deps.store.createTask(
      { title: "boundary", body: `cwd: ${process.cwd()}`, tenant: "dev", status: "ready" },
      "tester",
    );
    const taskBefore = ctx.deps.store.getTask(task.id);
    const created = await ask(task.id, owner, "command-boundary");
    const requestBefore = currentRequest(created.request.id);
    const legacyFence = [
      "--session",
      owner.session.id,
      "--generation",
      String(owner.session.generation),
      "--claim",
      "not-a-human-decision-claim",
      "--json",
    ];

    await expectFailure([
      "orchestrator",
      "answer",
      created.request.id,
      "既存worker回答に混ぜない",
      ...legacyFence,
    ], "request が見つかりません");
    expect(currentRequest(created.request.id)).toEqual(requestBefore);

    await expectFailure([
      "orchestrator",
      "resolve",
      created.request.id,
      "handled",
      "stall解決に混ぜない",
      ...legacyFence,
    ], "request が見つかりません");
    expect(currentRequest(created.request.id)).toEqual(requestBefore);
    expect(ctx.deps.store.getTask(task.id)).toEqual(taskBefore);
  });
});
