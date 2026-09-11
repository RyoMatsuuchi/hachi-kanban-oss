import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveRunStalledOrchestratorRequest, SqliteKanbanStore } from "./db.js";

function setup(): { store: SqliteKanbanStore; taskId: string } {
  const store = new SqliteKanbanStore(":memory:");
  const task = store.createTask(
    { title: "質問テスト", body: "cwd: /worktrees/a", tenant: "project-a", status: "ready" },
    "test",
  );
  store.block(task.id, "worker-question: どちらで進めますか", "supervisor");
  return { store, taskId: task.id };
}

describe("orchestrator routing contract §55", () => {
  it("request作成後に追加されたwatchへ不足deliveryだけを冪等再配送する", () => {
    const { store, taskId } = setup();
    const request = store.createOrGetOrchestratorRequest({
      taskId,
      questionId: "q_late_watch",
      question: "後から担当を登録します",
      worktree: "/worktrees/a",
      project: "project-a",
    });
    const orchestrator = store.registerOrchestrator({ label: "late", project: "project-a", repoCommonDir: "" });
    store.addOrchestratorWatch({
      orchestratorId: orchestrator.id,
      scope: "worktree",
      selector: "/worktrees/a",
      role: "primary",
    });

    expect(store.listOrchestratorRequests(orchestrator.id)).toEqual([]);
    expect(store.reconcileOrchestratorRequestRouting(request.id)).toEqual({
      requestId: request.id,
      addedDeliveries: 1,
      cancelled: false,
    });
    expect(store.listOrchestratorRequests(orchestrator.id).map((row) => row.id)).toEqual([request.id]);
    expect(store.reconcileOrchestratorRequestRouting(request.id).addedDeliveries).toBe(0);
    expect(store.listEvents(taskId, "orchestrator_request_rerouted")).toHaveLength(1);
    store.close();
  });

  it("observer bindingだけのidentityにはrequestを配送しない", () => {
    const { store, taskId } = setup();
    const observer = store.registerOrchestrator({ label: "observer-binding", project: "project-a", repoCommonDir: "" });
    store.bindTaskToOrchestrator(taskId, observer.id, "observer");

    store.createOrGetOrchestratorRequest({
      taskId,
      questionId: "q_observer_binding",
      question: "observer bindingの配送確認",
      worktree: "/worktrees/a",
      project: "project-a",
    });

    expect(store.listOrchestratorRequests(observer.id)).toEqual([]);
    store.close();
  });

  it("primary bindingがあるtaskでは一致する無関係なwatchへrequestを配送しない", () => {
    const { store, taskId } = setup();
    const primary = store.registerOrchestrator({ label: "bound-primary", project: "project-a", repoCommonDir: "" });
    const unrelated = store.registerOrchestrator({ label: "unrelated-watch", project: "project-a", repoCommonDir: "" });
    store.bindTaskToOrchestrator(taskId, primary.id, "primary");
    store.addOrchestratorWatch({
      orchestratorId: unrelated.id,
      scope: "worktree",
      selector: "/worktrees/a",
      role: "primary",
    });

    const request = store.createOrGetOrchestratorRequest({
      taskId,
      questionId: "q_binding_precedes_watch",
      question: "binding優先の配送確認",
      worktree: "/worktrees/a",
      project: "project-a",
    });

    expect(store.listOrchestratorRequests(primary.id).map((row) => row.id)).toEqual([request.id]);
    expect(store.listOrchestratorRequests(unrelated.id)).toEqual([]);
    store.close();
  });

  it("bindingがないtaskはwatchから解決しobserver watchを除外する", () => {
    const { store, taskId } = setup();
    const primary = store.registerOrchestrator({ label: "primary-watch", project: "project-a", repoCommonDir: "" });
    const observer = store.registerOrchestrator({ label: "observer-watch", project: "project-a", repoCommonDir: "" });
    store.addOrchestratorWatch({
      orchestratorId: primary.id,
      scope: "worktree",
      selector: "/worktrees/a",
      role: "primary",
    });
    store.addOrchestratorWatch({
      orchestratorId: observer.id,
      scope: "worktree",
      selector: "/worktrees/a",
      role: "observer",
    });

    const request = store.createOrGetOrchestratorRequest({
      taskId,
      questionId: "q_watch_without_binding",
      question: "watch fallbackの配送確認",
      worktree: "/worktrees/a",
      project: "project-a",
    });

    expect(store.listOrchestratorRequests(primary.id).map((row) => row.id)).toEqual([request.id]);
    expect(store.listOrchestratorRequests(observer.id)).toEqual([]);
    store.close();
  });

  it("終端taskの未claim queued requestだけをcancelへ収束する", () => {
    const store = new SqliteKanbanStore(":memory:");
    const task = store.createTask(
      { title: "終端質問", body: "cwd: /worktrees/terminal", tenant: "project-a", status: "todo" },
      "tester",
    );
    const request = store.createOrGetOrchestratorRequest({
      taskId: task.id,
      questionId: "q_terminal_unclaimed",
      question: "未claimの質問",
    });
    store.transition({ taskId: task.id, to: "done", actor: "tester" });

    expect(store.reconcileOrchestratorRequestRouting(request.id)).toEqual({
      requestId: request.id,
      addedDeliveries: 0,
      cancelled: true,
    });
    expect(store.getOrchestratorRequest(request.id)?.status).toBe("cancelled");
    expect(store.listEvents(task.id, "orchestrator_request_terminal_cancelled")).toHaveLength(1);
    store.close();
  });

  it("明示worktree watchへ配送し、1 sessionだけがCAS claimできる", () => {
    const { store, taskId } = setup();
    const orchestrator = store.registerOrchestrator({ label: "a", project: "project-a", repoCommonDir: "/repo/.git" });
    const session = store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "codex",
      providerSessionId: "routing-orchestrator-session",
    });
    store.addOrchestratorWatch({
      orchestratorId: orchestrator.id,
      scope: "worktree",
      selector: "/worktrees/a",
      role: "primary",
    });

    const request = store.createOrGetOrchestratorRequest({
      taskId,
      questionId: "q_one",
      question: "どちらで進めますか",
      worktree: "/worktrees/a",
      project: "project-a",
    });
    expect(store.listOrchestratorRequests(orchestrator.id).map((row) => row.id)).toEqual([request.id]);
    expect(store.markOrchestratorDeliveriesDelivered(orchestrator.id)).toBe(1);
    expect(store.getOrchestratorRequest(request.id)?.status).toBe("delivered");

    const claimed = store.claimOrchestratorRequest({
      requestId: request.id,
      sessionId: session.id,
      generation: session.generation,
      claimToken: "claim-a",
      leaseUntil: Math.floor(Date.now() / 1000) + 600,
    });
    expect(claimed.status).toBe("claimed");
    expect(() => store.claimOrchestratorRequest({
      requestId: request.id,
      sessionId: session.id,
      generation: session.generation,
      claimToken: "claim-b",
      leaseUntil: Math.floor(Date.now() / 1000) + 600,
    })).toThrow("claim 済み");
    store.close();
  });

  it("run_stalled は live session 不在でもidentity宛てpending deliveryを残し、次世代sessionがclaimできる", () => {
    const { store, taskId } = setup();
    const orchestrator = store.registerOrchestrator({
      label: "stalled-owner",
      project: "project-a",
      repoCommonDir: "/repo/.git",
    });
    store.bindTaskToOrchestrator(taskId, orchestrator.id, "primary");

    const stalled = store.createOrGetOrchestratorRequest({
      taskId,
      questionId: "run-stalled:42:direct-session-42",
      question: "direct run stalled",
      worktree: "/worktrees/a",
      project: "project-a",
    });

    expect(stalled).toMatchObject({ kind: "run_stalled", status: "queued" });
    expect(store.listOrchestratorSessions(orchestrator.id)).toEqual([]);
    expect(store.listOrchestratorRequests(orchestrator.id).map((row) => row.id)).toEqual([stalled.id]);
    // delivered 化できることが、live session に依存せず pending delivery が作られた証拠になる。
    expect(store.markOrchestratorDeliveriesDelivered(orchestrator.id)).toBe(1);

    const workerQuestion = store.createOrGetOrchestratorRequest({
      taskId,
      questionId: "q_after_run_stalled",
      question: "worker question",
    });
    expect(store.getActiveOrchestratorRequestByTask(taskId)?.id).toBe(workerQuestion.id);

    const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    expect(store.claimOrchestratorRequest({
      requestId: stalled.id,
      sessionId: session.id,
      generation: session.generation,
      claimToken: "claim-run-stalled",
      leaseUntil: Math.floor(Date.now() / 1000) + 600,
    })).toMatchObject({ id: stalled.id, kind: "run_stalled", status: "claimed" });
    store.close();
  });

  it("run_stall_suspected は run_stalled と別kind・別冪等キーで作られ、共通resolveを使える", () => {
    const { store, taskId } = setup();
    const orchestrator = store.registerOrchestrator({
      label: "stall-suspected-owner",
      project: "project-a",
      repoCommonDir: "/repo/.git",
    });
    store.bindTaskToOrchestrator(taskId, orchestrator.id, "primary");
    const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });

    const stalled = store.createOrGetOrchestratorRequest({
      taskId,
      questionId: "run-stalled:51:direct-session-51",
      question: "confirmed crash",
    });
    const suspected = store.createOrGetOrchestratorRequest({
      taskId,
      questionId: "run-stall-suspected:51:direct-session-51",
      question: "suspected live stall",
    });

    expect(stalled).toMatchObject({ kind: "run_stalled" });
    expect(suspected).toMatchObject({ kind: "run_stall_suspected" });
    expect(suspected.id).not.toBe(stalled.id);
    store.claimOrchestratorRequest({
      requestId: suspected.id,
      sessionId: session.id,
      generation: session.generation,
      claimToken: "claim-suspected",
      leaseUntil: Math.floor(Date.now() / 1000) + 600,
    });

    expect(resolveRunStalledOrchestratorRequest(store, {
      requestId: suspected.id,
      sessionId: session.id,
      generation: session.generation,
      claimToken: "claim-suspected",
      resolution: "handled",
      reason: "exact-session を確認済み",
    })).toMatchObject({ kind: "run_stall_suspected", status: "resolved" });
    expect(store.listEvents(taskId, "orchestrator_run_stall_suspected_resolved")).toHaveLength(1);
    store.close();
  });

  it("生存中primaryをcollaboratorが横取りせず、primary stale後はclaimできる", () => {
    const { store, taskId } = setup();
    const primary = store.registerOrchestrator({ label: "primary", project: "project-a", repoCommonDir: "" });
    const collaborator = store.registerOrchestrator({ label: "collaborator", project: "project-a", repoCommonDir: "" });
    const primarySession = store.startOrchestratorSession({ orchestratorId: primary.id });
    const collaboratorSession = store.startOrchestratorSession({ orchestratorId: collaborator.id });
    store.bindTaskToOrchestrator(taskId, primary.id, "primary");
    store.bindTaskToOrchestrator(taskId, collaborator.id, "collaborator");
    const request = store.createOrGetOrchestratorRequest({ taskId, questionId: "q_roles", question: "確認" });

    expect(() => store.claimOrchestratorRequest({
      requestId: request.id,
      sessionId: collaboratorSession.id,
      generation: collaboratorSession.generation,
      claimToken: "claim-collaborator",
      leaseUntil: Math.floor(Date.now() / 1000) + 600,
    })).toThrow("primary orchestrator");

    store.heartbeatOrchestratorSession(primarySession.id, primarySession.generation, Math.floor(Date.now() / 1000) - 91);
    expect(store.claimOrchestratorRequest({
      requestId: request.id,
      sessionId: collaboratorSession.id,
      generation: collaboratorSession.generation,
      claimToken: "claim-collaborator",
      leaseUntil: Math.floor(Date.now() / 1000) + 600,
    }).status).toBe("claimed");
    store.close();
  });

  it("復帰heartbeatはstale gapを更新前にdurable incidentへ固定する", () => {
    const store = new SqliteKanbanStore(":memory:");
    const orchestrator = store.registerOrchestrator({ label: "gap", project: "project-a", repoCommonDir: "" });
    const session = store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "codex",
      providerSessionId: "11111111-1111-4111-8111-111111111111",
    });
    store.heartbeatOrchestratorSession(session.id, session.generation, 1_000);

    const resumed = store.heartbeatOrchestratorSession(session.id, session.generation, 1_091);

    expect(resumed).toMatchObject({ status: "active", heartbeatAt: 1_091 });
    expect(store.getOrchestratorLivenessIncident(session.id, session.generation)).toMatchObject({
      orchestratorId: orchestrator.id,
      provider: "codex",
      providerSessionId: "11111111-1111-4111-8111-111111111111",
      gapSeconds: 91,
      detectedAt: 1_091,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 1_091,
    });

    store.heartbeatOrchestratorSession(session.id, session.generation, 1_200);
    expect(store.getOrchestratorLivenessIncident(session.id, session.generation)?.gapSeconds).toBe(91);
    store.close();
  });

  it("90秒以内のheartbeatはincidentを作らず、stale化はincident記録後に従来どおり行う", () => {
    const store = new SqliteKanbanStore(":memory:");
    const orchestrator = store.registerOrchestrator({ label: "expiry-gap", project: "project-a", repoCommonDir: "" });
    const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    store.heartbeatOrchestratorSession(session.id, session.generation, 1_000);
    store.heartbeatOrchestratorSession(session.id, session.generation, 1_090);
    expect(store.getOrchestratorLivenessIncident(session.id, session.generation)).toBeNull();

    expect(store.expireStaleOrchestratorSessions(1_181, 1_181)).toBe(1);
    expect(store.getOrchestratorSession(session.id)?.status).toBe("stale");
    expect(store.getOrchestratorLivenessIncident(session.id, session.generation)).toMatchObject({
      gapSeconds: 91,
      detectedAt: 1_181,
      status: "pending",
    });
    store.close();
  });

  it("liveness incident通知結果はattempts CASとdue時刻でbounded retryできる", () => {
    const store = new SqliteKanbanStore(":memory:");
    const orchestrator = store.registerOrchestrator({ label: "gap-retry", project: "project-a", repoCommonDir: "" });
    const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    store.heartbeatOrchestratorSession(session.id, session.generation, 1_000);
    store.heartbeatOrchestratorSession(session.id, session.generation, 1_091);
    const incident = store.getOrchestratorLivenessIncident(session.id, session.generation)!;

    expect(store.listPendingOrchestratorLivenessIncidents(1_091)).toHaveLength(1);
    expect(store.markOrchestratorLivenessIncident(
      incident.id,
      0,
      "pending",
      1_200,
      "transport failed",
      1_100,
    )).toMatchObject({ attempts: 1, status: "pending", nextAttemptAt: 1_200, lastError: "transport failed" });
    expect(store.listPendingOrchestratorLivenessIncidents(1_199)).toHaveLength(0);
    expect(store.markOrchestratorLivenessIncident(incident.id, 0, "sent", 0, "", 1_201)).toBeNull();
    expect(store.markOrchestratorLivenessIncident(incident.id, 1, "sent", 0, "", 1_201)).toMatchObject({
      attempts: 2,
      status: "sent",
      sentAt: 1_201,
    });
    expect(store.listPendingOrchestratorLivenessIncidents(2_000)).toHaveLength(0);
    store.close();
  });

  it("planned handoffはclaimを新generationへ移し、旧sessionをfenceする", () => {
    const { store, taskId } = setup();
    const orchestrator = store.registerOrchestrator({ label: "a", project: "project-a", repoCommonDir: "" });
    const old = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    store.bindTaskToOrchestrator(taskId, orchestrator.id, "primary");
    const request = store.createOrGetOrchestratorRequest({ taskId, questionId: "q_handoff", question: "確認" });
    store.claimOrchestratorRequest({
      requestId: request.id,
      sessionId: old.id,
      generation: old.generation,
      claimToken: "claim",
      leaseUntil: Math.floor(Date.now() / 1000) + 600,
    });
    const token = "handoff-secret";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    store.prepareOrchestratorHandoff(old.id, old.generation, tokenHash, Math.floor(Date.now() / 1000) + 600);
    const next = store.acceptOrchestratorHandoff({ oldSessionId: old.id, tokenHash });

    expect(store.getOrchestratorSession(old.id)?.status).toBe("superseded");
    expect(store.getOrchestratorRequest(request.id)).toMatchObject({
      claimantSessionId: next.id,
      claimantGeneration: next.generation,
    });
    expect(() => store.heartbeatOrchestratorSession(old.id, old.generation)).toThrow("SESSION_SUPERSEDED");
    store.close();
  });

  it("handoff token fenceはhashだけをCAS回転し、TTLを維持して元tokenのacceptを拒否する", () => {
    const store = new SqliteKanbanStore(":memory:");
    const orchestrator = store.registerOrchestrator({ label: "fence", project: "project-a", repoCommonDir: "" });
    const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    const expectedTokenHash = "a".repeat(64);
    const replacementTokenHash = "b".repeat(64);
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    store.prepareOrchestratorHandoff(session.id, session.generation, expectedTokenHash, expiresAt);

    const result = store.fenceOrchestratorHandoffToken(
      session.id,
      session.generation,
      expectedTokenHash,
      replacementTokenHash,
    );

    expect(result).toMatchObject({
      fenced: true,
      session: {
        status: "handoff_pending",
        handoffTokenHash: replacementTokenHash,
        handoffExpiresAt: expiresAt,
      },
    });
    expect(() => store.acceptOrchestratorHandoff({
      oldSessionId: session.id,
      tokenHash: expectedTokenHash,
    })).toThrow("handoff token が無効");
    store.close();
  });

  it("handoff token fenceはstatus不一致なら変更せず再読行を返す", () => {
    const store = new SqliteKanbanStore(":memory:");
    const orchestrator = store.registerOrchestrator({ label: "fence-status", project: "project-a", repoCommonDir: "" });
    const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    const expectedTokenHash = "a".repeat(64);
    store.prepareOrchestratorHandoff(
      session.id,
      session.generation,
      expectedTokenHash,
      Math.floor(Date.now() / 1000) + 600,
    );
    store.acceptOrchestratorHandoff({ oldSessionId: session.id, tokenHash: expectedTokenHash });

    const result = store.fenceOrchestratorHandoffToken(
      session.id,
      session.generation,
      expectedTokenHash,
      "b".repeat(64),
    );

    expect(result.fenced).toBe(false);
    expect(result.session?.status).toBe("superseded");
    expect(result.session?.handoffTokenHash).toBe(expectedTokenHash);
    store.close();
  });

  it("handoff token fenceはhash不一致なら変更せず再読行を返す", () => {
    const store = new SqliteKanbanStore(":memory:");
    const orchestrator = store.registerOrchestrator({ label: "fence-hash", project: "project-a", repoCommonDir: "" });
    const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    const storedTokenHash = "a".repeat(64);
    store.prepareOrchestratorHandoff(
      session.id,
      session.generation,
      storedTokenHash,
      Math.floor(Date.now() / 1000) + 600,
    );

    const result = store.fenceOrchestratorHandoffToken(
      session.id,
      session.generation,
      "c".repeat(64),
      "b".repeat(64),
    );

    expect(result.fenced).toBe(false);
    expect(result.session).toMatchObject({ status: "handoff_pending", handoffTokenHash: storedTokenHash });
    store.close();
  });

  it("handoff token fenceはgeneration不一致なら変更せず再読行を返す", () => {
    const store = new SqliteKanbanStore(":memory:");
    const orchestrator = store.registerOrchestrator({ label: "fence-generation", project: "project-a", repoCommonDir: "" });
    const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    const expectedTokenHash = "a".repeat(64);
    store.prepareOrchestratorHandoff(
      session.id,
      session.generation,
      expectedTokenHash,
      Math.floor(Date.now() / 1000) + 600,
    );

    const result = store.fenceOrchestratorHandoffToken(
      session.id,
      session.generation + 1,
      expectedTokenHash,
      "b".repeat(64),
    );

    expect(result.fenced).toBe(false);
    expect(result.session).toMatchObject({ status: "handoff_pending", handoffTokenHash: expectedTokenHash });
    store.close();
  });

  it("handoff token fenceは両方のhashに64桁SHA-256 hexを要求する", () => {
    const store = new SqliteKanbanStore(":memory:");
    const orchestrator = store.registerOrchestrator({ label: "fence-validation", project: "project-a", repoCommonDir: "" });
    const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });

    expect(() => store.fenceOrchestratorHandoffToken(
      session.id,
      session.generation,
      "not-hex".padEnd(64, "z"),
      "b".repeat(64),
    )).toThrow("SHA-256 hex");
    expect(() => store.fenceOrchestratorHandoffToken(
      session.id,
      session.generation,
      "a".repeat(64),
      "short",
    )).toThrow("SHA-256 hex");
    store.close();
  });

  it("handoff cancelはheartbeat_atも更新し、直後にstale判定されないようにする", () => {
    const { store, taskId } = setup();
    const orchestrator = store.registerOrchestrator({ label: "a", project: "project-a", repoCommonDir: "" });
    const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    store.bindTaskToOrchestrator(taskId, orchestrator.id, "primary");
    store.heartbeatOrchestratorSession(session.id, session.generation, Math.floor(Date.now() / 1000) - 500);
    const token = "cancel-secret";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    store.prepareOrchestratorHandoff(session.id, session.generation, tokenHash, Math.floor(Date.now() / 1000) + 600);
    const beforeCancel = Math.floor(Date.now() / 1000);

    const cancelled = store.cancelOrchestratorHandoff(session.id, session.generation, tokenHash);

    expect(cancelled.status).toBe("active");
    expect(cancelled.heartbeatAt).toBeGreaterThanOrEqual(beforeCancel);
    store.close();
  });

  it("stale takeoverは旧claimを移管せずqueuedへ戻す", () => {
    const { store, taskId } = setup();
    const orchestrator = store.registerOrchestrator({ label: "a", project: "project-a", repoCommonDir: "" });
    const old = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    store.bindTaskToOrchestrator(taskId, orchestrator.id, "primary");
    const request = store.createOrGetOrchestratorRequest({ taskId, questionId: "q_stale", question: "確認" });
    store.claimOrchestratorRequest({
      requestId: request.id,
      sessionId: old.id,
      generation: old.generation,
      claimToken: "claim",
      leaseUntil: Math.floor(Date.now() / 1000) + 600,
    });
    const next = store.takeoverStaleOrchestratorSession({
      orchestratorId: orchestrator.id,
      staleBefore: old.heartbeatAt + 1,
    });

    expect(next.generation).toBe(old.generation + 1);
    expect(store.getOrchestratorRequest(request.id)).toMatchObject({
      status: "queued",
      claimantSessionId: "",
      claimToken: "",
    });
    store.close();
  });

  it("human escalationの回答はworkerへ直送せずrequestをqueuedへ戻す", () => {
    const { store, taskId } = setup();
    const orchestrator = store.registerOrchestrator({ label: "a", project: "project-a", repoCommonDir: "" });
    const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    store.bindTaskToOrchestrator(taskId, orchestrator.id, "primary");
    const request = store.createOrGetOrchestratorRequest({ taskId, questionId: "q_human", question: "確認" });
    store.claimOrchestratorRequest({
      requestId: request.id,
      sessionId: session.id,
      generation: session.generation,
      claimToken: "claim",
      leaseUntil: Math.floor(Date.now() / 1000) + 600,
    });
    store.escalateOrchestratorRequest({
      requestId: request.id,
      sessionId: session.id,
      generation: session.generation,
      claimToken: "claim",
      question: "人間の判断が必要です",
    });
    expect(store.getTask(taskId)?.blockReason).toContain("user-question:");
    expect(store.listEvents(taskId, "block_reason_updated")[0]?.provenance).toEqual({
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    });

    const routed = store.recordHumanAnswerForRequest(taskId, "A案で進める");
    expect(routed).toMatchObject({ status: "queued", humanAnswer: "A案で進める" });
    expect(store.getTask(taskId)?.blockReason).toContain("worker-question:");
    expect(store.listMessageFenceComments(0)).toHaveLength(0);
    store.close();
  });
});
