import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import { createRuntimeResourceReadView } from "./runtime-resource-readview.js";

describe("runtime resource lease store", () => {
  let root: string;
  let dbPath: string;
  let store: SqliteKanbanStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hachi-runtime-db-"));
    dbPath = join(root, "kanban.db");
    store = new SqliteKanbanStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function setupLease(expiresAt: number | null = Math.floor(Date.now() / 1000) + 600): {
    taskId: string;
    orchestratorId: string;
    requirementId: string;
    leaseId: string;
  } {
    const task = store.createTask({ title: "resource", body: `cwd: ${root}`, tenant: "dev", status: "ready" }, "test");
    const orchestrator = store.registerOrchestrator({ label: "owner", project: "hachi", repoCommonDir: root });
    const requirement = store.createOrGetRuntimeResourceRequirement({
      taskId: task.id,
      name: "preview",
      bundleKind: "worktree_preview",
      spec: { version: 1, requiredMembers: ["docker_container"] },
      idempotencyKey: `${task.id}:preview`,
    });
    const lease = store.reserveRuntimeResourceLease({
      requirementId: requirement.id,
      controllerOrchestratorId: orchestrator.id,
      board: "dev",
      project: "hachi",
      repoCommonDir: root,
      worktree: root,
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      expiresAt,
      provenanceVersion: 1,
      rolloutGeneration: 1,
      actor: "supervisor",
    });
    return { taskId: task.id, orchestratorId: orchestrator.id, requirementId: requirement.id, leaseId: lease.id };
  }

  function activateWithMember(leaseId: string): number {
    const provisioning = store.claimRuntimeResourceLease(leaseId, 1, "supervisor");
    store.addRuntimeResourceMember({
      leaseId,
      expectedLeaseFence: provisioning.fence,
      kind: "docker_container",
      state: "active",
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      scopeKey: "docker:test",
      nativeId: `native-${leaseId}`,
      labelsHash: "a".repeat(64),
      provenance: { version: 1, labels: {} },
      observedAt: Math.floor(Date.now() / 1000),
      actor: "supervisor",
    });
    const active = store.transitionRuntimeResourceLease({
      leaseId,
      expectedFence: provisioning.fence,
      from: "provisioning",
      to: "active",
      actor: "supervisor",
    });
    return active.fence;
  }

  it("migration v13 を既存DBへ冪等適用し read view で参照できる", () => {
    const setup = setupLease();
    store.close();
    store = new SqliteKanbanStore(dbPath);
    store.close();

    const raw = new Database(dbPath, { readonly: true });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 13`).get()).toEqual({ count: 1 });
    expect(
      raw.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'runtime_%'`).get(),
    ).toEqual({ count: 9 });
    raw.close();

    const view = createRuntimeResourceReadView(dbPath);
    expect(view.leasesForTask(setup.taskId)).toHaveLength(1);
    expect(view.lease(setup.leaseId)?.repoCommonDir).toBe(realpathSync.native(root));
    view.close();
    store = new SqliteKanbanStore(dbPath);
  });

  it("並行 reserve/claim は最初の CAS だけが成功する", () => {
    const setup = setupLease();
    expect(() =>
      store.reserveRuntimeResourceLease({
        requirementId: setup.requirementId,
        controllerOrchestratorId: setup.orchestratorId,
        board: "dev",
        repoCommonDir: root,
        worktree: root,
        cleanupPolicy: "auto",
        managed: true,
        ephemeral: true,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        provenanceVersion: 1,
        rolloutGeneration: 1,
        actor: "second",
      }),
    ).toThrow(/reserve/);
    expect(() => store.claimRuntimeResourceLease(setup.leaseId, 1, "first")).not.toThrow();
    expect(() => store.claimRuntimeResourceLease(setup.leaseId, 1, "second")).toThrow(/CAS/);
  });

  it("canonical worktree は symlink spelling を同一 owner とし、別 worktree を拒否する", () => {
    const link = join(root, "worktree-link");
    symlinkSync(root, link);
    const setup = setupLease();
    const claimed = store.claimRuntimeResourceLease(setup.leaseId, 1, "supervisor");
    const renewed = store.renewRuntimeResourceLease({
      leaseId: setup.leaseId,
      expectedFence: claimed.fence,
      controllerOrchestratorId: setup.orchestratorId,
      repoCommonDir: link,
      worktree: link,
      heartbeatAt: 100,
      expiresAt: 200,
      actor: "supervisor",
    });
    expect(renewed.repoCommonDir).toBe(realpathSync.native(root));
    const other = mkdtempSync(join(tmpdir(), "hachi-other-worktree-"));
    try {
      expect(() =>
        store.renewRuntimeResourceLease({
          leaseId: setup.leaseId,
          expectedFence: renewed.fence,
          controllerOrchestratorId: setup.orchestratorId,
          repoCommonDir: other,
          worktree: other,
          heartbeatAt: 200,
          expiresAt: 300,
          actor: "supervisor",
        }),
      ).toThrow(/owner/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("期限切れでも task/run が live なら拒否し、terminal 後だけ expired にする", () => {
    const now = Math.floor(Date.now() / 1000);
    const setup = setupLease(now + 1);
    const activeFence = activateWithMember(setup.leaseId);
    expect(store.getRuntimeResourceRequirement(setup.requirementId)?.status).toBe("ready");
    expect(() => store.expireRuntimeResourceLease(setup.leaseId, activeFence, now + 2, "supervisor")).toThrow(/live task/);
    store.block(setup.taskId, "codex-in-progress: test", "supervisor");
    store.transition({ taskId: setup.taskId, to: "done", actor: "supervisor" });
    expect(store.expireRuntimeResourceLease(setup.leaseId, activeFence, now + 2, "supervisor").state).toBe("expired");
  });

  it("explicit release request は active lease の state/fence を担当者の承認前後とも変更しない", () => {
    const setup = setupLease();
    const activeFence = activateWithMember(setup.leaseId);

    const request = store.requestRuntimeResourceRelease({
      leaseId: setup.leaseId,
      expectedLeaseFence: activeFence,
      reason: "作業完了",
      actor: "cli",
    });
    expect(request).toMatchObject({
      decisionClass: "orchestrator",
      status: "queued",
      expectedLeaseFence: activeFence,
    });
    expect(store.getRuntimeResourceLease(setup.leaseId)).toMatchObject({
      state: "active",
      fence: activeFence,
      terminalReason: "",
    });

    const session = store.startOrchestratorSession({ orchestratorId: setup.orchestratorId });
    store.claimRuntimeCleanupRequest({
      requestId: request.id,
      orchestratorId: setup.orchestratorId,
      sessionId: session.id,
      generation: session.generation,
      claimToken: "approval-token",
      expectedLeaseFence: activeFence,
      leaseUntil: 200,
      now: 100,
    });
    expect(store.approveRuntimeCleanupRequest({
      requestId: request.id,
      orchestratorId: setup.orchestratorId,
      sessionId: session.id,
      generation: session.generation,
      claimToken: "approval-token",
      expectedLeaseFence: activeFence,
      now: 110,
    }).status).toBe("approved");
    expect(store.getRuntimeResourceLease(setup.leaseId)).toMatchObject({
      state: "active",
      fence: activeFence,
      terminalReason: "",
    });
  });

  it("explicit release request は task binding の collaborator delivery も同一Txで作る", () => {
    const setup = setupLease();
    const activeFence = activateWithMember(setup.leaseId);
    store.bindTaskToOrchestrator(setup.taskId, setup.orchestratorId, "primary");
    const collaborator = store.registerOrchestrator({ label: "collaborator", project: "hachi", repoCommonDir: root });
    store.bindTaskToOrchestrator(setup.taskId, collaborator.id, "collaborator");

    const request = store.requestRuntimeResourceRelease({
      leaseId: setup.leaseId,
      expectedLeaseFence: activeFence,
      reason: "watch routing",
      actor: "cli",
    });

    expect(store.listPendingRuntimeCleanupDeliveries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: request.id, orchestratorId: setup.orchestratorId }),
      expect.objectContaining({ requestId: request.id, orchestratorId: collaborator.id }),
    ]));
  });

  it("明示 task binding があれば別 identity の project/worktree watch を候補へ混入させない", () => {
    const setup = setupLease();
    const activeFence = activateWithMember(setup.leaseId);
    const bound = store.registerOrchestrator({ label: "bound", project: "hachi", repoCommonDir: root });
    store.bindTaskToOrchestrator(setup.taskId, bound.id, "primary");
    const projectWatcher = store.registerOrchestrator({ label: "project-watch", project: "hachi", repoCommonDir: root });
    store.addOrchestratorWatch({
      orchestratorId: projectWatcher.id,
      scope: "project",
      selector: "hachi",
      role: "primary",
    });
    const worktreeWatcher = store.registerOrchestrator({ label: "worktree-watch", project: "hachi", repoCommonDir: root });
    store.addOrchestratorWatch({
      orchestratorId: worktreeWatcher.id,
      scope: "worktree",
      selector: realpathSync.native(root),
      role: "primary",
    });

    const request = store.requestRuntimeResourceRelease({
      leaseId: setup.leaseId,
      expectedLeaseFence: activeFence,
      reason: "binding is authoritative",
      actor: "cli",
    });
    const deliveries = store.listPendingRuntimeCleanupDeliveries()
      .filter((delivery) => delivery.requestId === request.id);

    expect(deliveries.map((delivery) => delivery.orchestratorId)).toEqual([
      bound.id,
      setup.orchestratorId,
    ]);
    expect(deliveries.filter((delivery) => delivery.watchId !== null)).toHaveLength(0);
    expect(deliveries.some((delivery) => delivery.orchestratorId === projectWatcher.id)).toBe(false);
    expect(deliveries.some((delivery) => delivery.orchestratorId === worktreeWatcher.id)).toBe(false);
  });

  it("pending delivery の limit は delivery行数でなく request 件数へ適用する", () => {
    const setup = setupLease();
    const activeFence = activateWithMember(setup.leaseId);
    const requestIds = new Set<string>();
    for (let index = 0; index < 51; index += 1) {
      requestIds.add(store.requestRuntimeResourceRelease({
        leaseId: setup.leaseId,
        expectedLeaseFence: activeFence,
        reason: `request budget ${index}`,
        actor: "cli",
      }).id);
    }

    const pending = store.listPendingRuntimeCleanupDeliveries(50);
    expect(new Set(pending.map((delivery) => delivery.requestId)).size).toBe(50);
    expect(pending.every((delivery) => requestIds.has(delivery.requestId))).toBe(true);
  });

  it("初期 human cleanup request は nonce 付き transport outbox を同一Txで作る", () => {
    const setup = setupLease();
    const activeFence = activateWithMember(setup.leaseId);
    const collaborator = store.registerOrchestrator({ label: "human-collaborator", project: "hachi", repoCommonDir: root });
    store.bindTaskToOrchestrator(setup.taskId, collaborator.id, "collaborator");
    store.block(setup.taskId, "codex-in-progress: test", "supervisor");
    store.transition({ taskId: setup.taskId, to: "done", actor: "supervisor" });
    const { request } = store.transitionRuntimeResourceLeaseWithCleanupRequest({
      leaseId: setup.leaseId,
      expectedFence: activeFence,
      from: "active",
      terminalReason: "owner_terminal",
      decisionClass: "human",
      reason: "人間の確認が必要です",
      actor: "supervisor",
    });
    const outbox = store.listPendingRuntimeResourceOutbox();

    expect(request).toMatchObject({ status: "waiting_human", decisionClass: "human", escalationGeneration: 0 });
    expect(outbox).toEqual([
      expect.objectContaining({ requestId: request.id, dedupeKey: `${request.id}:0:cleanup_decision:macos` }),
      expect.objectContaining({ requestId: request.id, dedupeKey: `${request.id}:0:cleanup_decision:telegram` }),
    ]);
    expect(outbox.every((row) => {
      const payload = JSON.parse(row.payload) as { route: string; nonce?: string };
      return payload.route === "human_question" && typeof payload.nonce === "string" && payload.nonce.length > 0;
    })).toBe(true);
    const nonce = (JSON.parse(outbox[0]!.payload) as { nonce: string }).nonce;
    expect(store.recordHumanAnswerForRuntimeCleanupRequest(request.id, nonce, "保持してください")).toMatchObject({
      status: "queued",
      decisionClass: "orchestrator",
      humanAnswer: "保持してください",
    });
    expect(store.listPendingRuntimeCleanupDeliveries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: request.id, orchestratorId: setup.orchestratorId }),
      expect.objectContaining({ requestId: request.id, orchestratorId: collaborator.id }),
    ]));
  });

  it("cleanup claim/approval は active session generation と token/fence を要求する", () => {
    const setup = setupLease();
    const activeFence = activateWithMember(setup.leaseId);
    store.block(setup.taskId, "codex-in-progress: test", "supervisor");
    store.transition({ taskId: setup.taskId, to: "done", actor: "supervisor" });
    const { lease: pending, request } = store.transitionRuntimeResourceLeaseWithCleanupRequest({
      leaseId: setup.leaseId,
      expectedFence: activeFence,
      from: "active",
      terminalReason: "owner_terminal",
      decisionClass: "orchestrator",
      reason: "owner terminal",
      actor: "supervisor",
    });
    const unrelatedOrchestrator = store.registerOrchestrator({ label: "unrelated", project: "hachi", repoCommonDir: root });
    const unrelatedSession = store.startOrchestratorSession({ orchestratorId: unrelatedOrchestrator.id });
    expect(() =>
      store.claimRuntimeCleanupRequest({
        requestId: request.id,
        orchestratorId: unrelatedOrchestrator.id,
        sessionId: unrelatedSession.id,
        generation: unrelatedSession.generation,
        claimToken: "unrelated",
        expectedLeaseFence: pending.fence,
        leaseUntil: 200,
        now: 100,
      }),
    ).toThrow(/controller/);
    const oldSession = store.startOrchestratorSession({ orchestratorId: setup.orchestratorId });
    const handoffHash = "a".repeat(64);
    store.prepareOrchestratorHandoff(oldSession.id, oldSession.generation, handoffHash, Date.now() + 1000);
    const currentSession = store.acceptOrchestratorHandoff({
      oldSessionId: oldSession.id,
      tokenHash: handoffHash,
    });

    expect(() =>
      store.claimRuntimeCleanupRequest({
        requestId: request.id,
        orchestratorId: setup.orchestratorId,
        sessionId: oldSession.id,
        generation: oldSession.generation,
        claimToken: "old",
        expectedLeaseFence: pending.fence,
        leaseUntil: 200,
        now: 100,
      }),
    ).toThrow(/generation/);
    store.claimRuntimeCleanupRequest({
      requestId: request.id,
      orchestratorId: setup.orchestratorId,
      sessionId: currentSession.id,
      generation: currentSession.generation,
      claimToken: "current",
      expectedLeaseFence: pending.fence,
      leaseUntil: 200,
      now: 100,
    });
    expect(() =>
      store.approveRuntimeCleanupRequest({
        requestId: request.id,
        orchestratorId: setup.orchestratorId,
        sessionId: oldSession.id,
        generation: oldSession.generation,
        claimToken: "current",
        expectedLeaseFence: pending.fence,
        now: 110,
      }),
    ).toThrow(/generation/);
    expect(
      store.approveRuntimeCleanupRequest({
        requestId: request.id,
        orchestratorId: setup.orchestratorId,
        sessionId: currentSession.id,
        generation: currentSession.generation,
        claimToken: "current",
        expectedLeaseFence: pending.fence,
        now: 110,
      }).status,
    ).toBe("approved");
    expect(store.listRuntimeResourceEvents(setup.leaseId).map((event) => event.eventType)).toContain("cleanup_approved");
  });

  it("cleanup release/reject も claim token・fence・lease expiry を同時に検証する", () => {
    const setup = setupLease();
    const activeFence = activateWithMember(setup.leaseId);
    store.block(setup.taskId, "codex-in-progress: test", "supervisor");
    store.transition({ taskId: setup.taskId, to: "done", actor: "supervisor" });
    const { lease: pending, request } = store.transitionRuntimeResourceLeaseWithCleanupRequest({
      leaseId: setup.leaseId,
      expectedFence: activeFence,
      from: "active",
      terminalReason: "owner_terminal",
      decisionClass: "orchestrator",
      reason: "owner terminal release/reject",
      actor: "supervisor",
    });
    const session = store.startOrchestratorSession({ orchestratorId: setup.orchestratorId });
    store.claimRuntimeCleanupRequest({
      requestId: request.id,
      orchestratorId: setup.orchestratorId,
      sessionId: session.id,
      generation: session.generation,
      claimToken: "first",
      expectedLeaseFence: pending.fence,
      leaseUntil: 200,
      now: 100,
    });
    expect(() =>
      store.releaseRuntimeCleanupRequest({
        requestId: request.id,
        orchestratorId: setup.orchestratorId,
        sessionId: session.id,
        generation: session.generation,
        claimToken: "first",
        expectedLeaseFence: pending.fence + 1,
        now: 110,
      }),
    ).toThrow(/fence/);
    expect(
      store.releaseRuntimeCleanupRequest({
        requestId: request.id,
        orchestratorId: setup.orchestratorId,
        sessionId: session.id,
        generation: session.generation,
        claimToken: "first",
        expectedLeaseFence: pending.fence,
        now: 110,
      }).status,
    ).toBe("queued");
    store.claimRuntimeCleanupRequest({
      requestId: request.id,
      orchestratorId: setup.orchestratorId,
      sessionId: session.id,
      generation: session.generation,
      claimToken: "expired",
      expectedLeaseFence: pending.fence,
      leaseUntil: 120,
      now: 110,
    });
    expect(() =>
      store.rejectRuntimeCleanupRequest({
        requestId: request.id,
        orchestratorId: setup.orchestratorId,
        sessionId: session.id,
        generation: session.generation,
        claimToken: "expired",
        expectedLeaseFence: pending.fence,
        reason: "期限切れ",
        now: 121,
      }),
    ).toThrow(/CAS/);
  });

  it("planned handoff は runtime cleanup の未承認 claim を新 generation へ移管する", () => {
    const setup = setupLease();
    const activeFence = activateWithMember(setup.leaseId);
    const { lease: pending, request } = store.transitionRuntimeResourceLeaseWithCleanupRequest({
      leaseId: setup.leaseId,
      expectedFence: activeFence,
      from: "active",
      terminalReason: "explicit_release",
      decisionClass: "orchestrator",
      reason: "handoff cleanup claim",
      actor: "supervisor",
    });
    const old = store.startOrchestratorSession({ orchestratorId: setup.orchestratorId });
    store.claimRuntimeCleanupRequest({
      requestId: request.id,
      orchestratorId: setup.orchestratorId,
      sessionId: old.id,
      generation: old.generation,
      claimToken: "handoff-cleanup-claim",
      expectedLeaseFence: pending.fence,
      leaseUntil: 200,
      now: 100,
    });
    const handoffHash = "b".repeat(64);
    store.prepareOrchestratorHandoff(old.id, old.generation, handoffHash, Date.now() + 60_000);
    const next = store.acceptOrchestratorHandoff({ oldSessionId: old.id, tokenHash: handoffHash });

    expect(store.getRuntimeCleanupRequest(request.id)).toMatchObject({
      status: "claimed",
      claimantSessionId: next.id,
      claimantGeneration: next.generation,
    });
    expect(() => store.approveRuntimeCleanupRequest({
      requestId: request.id,
      orchestratorId: setup.orchestratorId,
      sessionId: old.id,
      generation: old.generation,
      claimToken: "handoff-cleanup-claim",
      expectedLeaseFence: pending.fence,
      now: 110,
    })).toThrow(/generation/);
    expect(store.approveRuntimeCleanupRequest({
      requestId: request.id,
      orchestratorId: setup.orchestratorId,
      sessionId: next.id,
      generation: next.generation,
      claimToken: "handoff-cleanup-claim",
      expectedLeaseFence: pending.fence,
      now: 110,
    }).status).toBe("approved");
    expect(store.listRuntimeResourceEvents(setup.leaseId).map((event) => event.eventType)).toContain("cleanup_claim_transferred");
  });

  it("stale takeover は runtime cleanup の claim と approval を再queueし、新 generationへ渡さない", () => {
    const setup = setupLease();
    const activeFence = activateWithMember(setup.leaseId);
    const { lease: pending, request } = store.transitionRuntimeResourceLeaseWithCleanupRequest({
      leaseId: setup.leaseId,
      expectedFence: activeFence,
      from: "active",
      terminalReason: "explicit_release",
      decisionClass: "orchestrator",
      reason: "stale cleanup approval",
      actor: "supervisor",
    });
    const old = store.startOrchestratorSession({ orchestratorId: setup.orchestratorId });
    store.claimRuntimeCleanupRequest({
      requestId: request.id,
      orchestratorId: setup.orchestratorId,
      sessionId: old.id,
      generation: old.generation,
      claimToken: "stale-cleanup-claim",
      expectedLeaseFence: pending.fence,
      leaseUntil: 200,
      now: 100,
    });
    store.approveRuntimeCleanupRequest({
      requestId: request.id,
      orchestratorId: setup.orchestratorId,
      sessionId: old.id,
      generation: old.generation,
      claimToken: "stale-cleanup-claim",
      expectedLeaseFence: pending.fence,
      now: 110,
    });
    const next = store.takeoverStaleOrchestratorSession({
      orchestratorId: setup.orchestratorId,
      staleBefore: old.heartbeatAt + 1,
    });

    expect(next.generation).toBe(old.generation + 1);
    expect(store.getRuntimeCleanupRequest(request.id)).toMatchObject({
      status: "queued",
      claimantSessionId: "",
      claimantGeneration: null,
      claimTokenHash: "",
      approvedBy: "",
      approvalGeneration: null,
    });
    expect(store.listRuntimeResourceEvents(setup.leaseId).map((event) => event.eventType)).toContain("cleanup_claim_requeued");
  });

  it("volume member と volume を含む auto request を fail-closed で拒否する", () => {
    const setup = setupLease();
    const provisioning = store.claimRuntimeResourceLease(setup.leaseId, 1, "supervisor");
    expect(() =>
      store.addRuntimeResourceMember({
        leaseId: setup.leaseId,
        expectedLeaseFence: provisioning.fence,
        kind: "docker_volume",
        state: "active",
        cleanupPolicy: "auto",
        managed: true,
        ephemeral: true,
        scopeKey: "docker:test",
        nativeId: "volume-1",
        labelsHash: "a".repeat(64),
        provenance: { version: 1, labels: {} },
        observedAt: 1,
        actor: "supervisor",
      }),
    ).toThrow(/docker_volume/);
  });

  it("cleanup_pending 遷移と request 作成は request 失敗時に一括 rollback する", () => {
    const setup = setupLease();
    const activeFence = activateWithMember(setup.leaseId);

    expect(() => store.transitionRuntimeResourceLeaseWithCleanupRequest({
      leaseId: setup.leaseId,
      expectedFence: activeFence,
      from: "active",
      terminalReason: "explicit_release",
      decisionClass: "auto",
      reason: "   ",
      actor: "test",
    })).toThrow(/reason/);

    expect(store.getRuntimeResourceLease(setup.leaseId)).toMatchObject({ state: "active", fence: activeFence });
    const view = createRuntimeResourceReadView(dbPath);
    expect(view.cleanupRequests(setup.leaseId)).toHaveLength(0);
    view.close();
  });

  it("汎用 transition は request を伴わない cleanup_pending 遷移を拒否する", () => {
    const setup = setupLease();
    const activeFence = activateWithMember(setup.leaseId);

    expect(() => store.transitionRuntimeResourceLease({
      leaseId: setup.leaseId,
      expectedFence: activeFence,
      from: "active",
      to: "cleanup_pending",
      terminalReason: "explicit_release",
      actor: "test",
    })).toThrow(/transitionRuntimeResourceLeaseWithCleanupRequest/);

    expect(store.getRuntimeResourceLease(setup.leaseId)).toMatchObject({ state: "active", fence: activeFence });
  });

  it("終了済み旧 run の lease だけを同一 task の新 rework run へ原子的に rebind する", () => {
    const setup = setupLease();
    const activeFence = activateWithMember(setup.leaseId);
    const oldRun = store.startRun(setup.taskId, "codex", "old-worker", {});
    const bound = store.bindRuntimeResourceLeaseRun({
      leaseId: setup.leaseId,
      expectedFence: activeFence,
      runId: oldRun.id,
      actor: "supervisor",
    });
    store.endRun(oldRun.id, "done");
    const newRun = store.startRun(setup.taskId, "codex", "new-rework", {});

    const rebound = store.rebindRuntimeResourceLeaseRun({
      leaseId: setup.leaseId,
      expectedFence: bound.fence,
      expectedOwnerRunId: oldRun.id,
      runId: newRun.id,
      actor: "supervisor",
    });

    expect(rebound).toMatchObject({ ownerRunId: newRun.id, fence: bound.fence + 1 });
    expect(store.listRuntimeResourceEvents(setup.leaseId).map((event) => event.eventType)).toContain(
      "lease_run_rebound",
    );
  });

  it("旧 owner run が active の間は rework run rebind を拒否する", () => {
    const setup = setupLease();
    const activeFence = activateWithMember(setup.leaseId);
    const oldRun = store.startRun(setup.taskId, "codex", "old-live-worker", {});
    const bound = store.bindRuntimeResourceLeaseRun({
      leaseId: setup.leaseId,
      expectedFence: activeFence,
      runId: oldRun.id,
      actor: "supervisor",
    });
    const newRun = store.startRun(setup.taskId, "codex", "new-rework", {});

    expect(() => store.rebindRuntimeResourceLeaseRun({
      leaseId: setup.leaseId,
      expectedFence: bound.fence,
      expectedOwnerRunId: oldRun.id,
      runId: newRun.id,
      actor: "supervisor",
    })).toThrow(/旧 run が終了済み/);
    expect(store.getRuntimeResourceLease(setup.leaseId)).toMatchObject({
      ownerRunId: oldRun.id,
      fence: bound.fence,
    });
  });
});
