import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "@hachi/core";
import {
  processCleanupDeliveries,
  STALE_SESSION_SECONDS,
  type CleanupDeliveryAdapter,
  type CleanupDeliveryStore,
} from "./cleanup-delivery.js";

interface Fixture {
  root: string;
  taskId: string;
  orchestratorId: string;
  sessionId: string;
  generation: number;
  leaseId: string;
  fence: number;
}

describe("runtime cleanup durable delivery", () => {
  let root: string;
  let store: SqliteKanbanStore;
  let now: number;

  beforeEach(() => {
    now = Math.floor(Date.now() / 1000);
    root = mkdtempSync(join(tmpdir(), "hachi-cleanup-routing-"));
    store = new SqliteKanbanStore(join(root, "kanban.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function setupFixture(options: { provider?: "codex" | "claude" | ""; providerSessionId?: string } = {}): Fixture {
    const task = store.createTask(
      { title: "cleanup", body: `cwd: ${root}`, tenant: "project-a", status: "ready" },
      "test",
    );
    store.block(task.id, "codex-in-progress: test", "supervisor");
    store.transition({ taskId: task.id, to: "done", actor: "supervisor" });
    const orchestrator = store.registerOrchestrator({ label: "fallback", project: "project-a", repoCommonDir: root });
    const session = store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: options.provider ?? "codex",
      providerSessionId: options.providerSessionId ?? "provider-primary",
    });
    store.heartbeatOrchestratorSession(session.id, session.generation, now);
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
      project: "project-a",
      repoCommonDir: root,
      worktree: root,
      cleanupPolicy: "orchestrator",
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
      cleanupPolicy: "orchestrator",
      managed: true,
      ephemeral: true,
      scopeKey: `docker:${task.id}`,
      nativeId: `container-${task.id}`,
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
    return {
      root,
      taskId: task.id,
      orchestratorId: orchestrator.id,
      sessionId: session.id,
      generation: session.generation,
      leaseId: lease.id,
      fence: active.fence,
    };
  }

  function createRequest(fixture: Fixture, reason = "owner terminal"): string {
    const { lease, request } = store.transitionRuntimeResourceLeaseWithCleanupRequest({
      leaseId: fixture.leaseId,
      expectedFence: fixture.fence,
      from: "active",
      terminalReason: "owner_terminal",
      decisionClass: "orchestrator",
      reason,
      actor: "supervisor",
    });
    fixture.fence = lease.fence;
    return request.id;
  }

  const receiptAdapter: CleanupDeliveryAdapter = (attempt) =>
    Promise.resolve(`receipt:${attempt.mode}:${attempt.session.id}:${attempt.delivery.requestId}`);

  it("provider inject receipt 後だけ delivered と Telegram FYI outbox を記録する", async () => {
    const fixture = setupFixture();
    const requestId = createRequest(fixture);
    expect(store.listPendingRuntimeResourceOutbox()).toHaveLength(0);

    const first = await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now, receiptAdapter);
    expect(first.result).toMatchObject({ delivered: 1, pending: 0, escalated: 0 });
    expect(store.getRuntimeCleanupRequest(requestId)?.status).toBe("delivered");
    expect(store.listPendingRuntimeResourceOutbox()).toEqual([
      expect.objectContaining({ requestId, transport: "macos", dedupeKey: `${requestId}:0:cleanup_decision:macos` }),
      expect.objectContaining({ requestId, transport: "telegram", dedupeKey: `${requestId}:0:cleanup_decision:telegram` }),
    ]);

    const second = await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now, receiptAdapter);
    expect(second.result.delivered).toBe(0);
  });

  it("adapter failure と receipt 未確認を delivered 扱いしない", async () => {
    const fixture = setupFixture();
    const requestId = createRequest(fixture);
    const failed = await processCleanupDeliveries(
      store as unknown as CleanupDeliveryStore,
      true,
      now,
      () => Promise.reject(new Error("provider unavailable")),
    );
    expect(failed.result.pending).toBe(1);
    expect(store.getRuntimeCleanupRequest(requestId)?.status).toBe("queued");
    expect(store.listPendingRuntimeResourceOutbox()).toHaveLength(0);
  });

  it("app-wakeup capability 未構成は構造化診断を残し、poll inbox から claim できる pending を維持する", async () => {
    const fixture = setupFixture({ provider: "codex", providerSessionId: "legacy-app-wakeup" });
    const raw = new DatabaseSync(join(root, "kanban.db"));
    try {
      // migration v23 前の provider-only row は新規作成できないが、既存 row の診断経路は維持する。
      raw.prepare(`UPDATE orchestrator_sessions SET provider_session_id = '' WHERE id = ?`).run(fixture.sessionId);
    } finally {
      raw.close();
    }
    const requestId = createRequest(fixture);

    const first = await processCleanupDeliveries(
      store as unknown as CleanupDeliveryStore,
      true,
      now,
      () => Promise.resolve(null),
    );
    const diagnostic = JSON.parse(first.notes[0] ?? "{}") as Record<string, unknown>;
    expect(first.result).toMatchObject({ delivered: 0, pending: 1, escalated: 0 });
    expect(diagnostic).toMatchObject({
      event: "runtime_cleanup_app_wakeup_unconfigured",
      requestId,
      orchestratorId: fixture.orchestratorId,
      deliveryStatus: "pending",
    });
    expect(store.getRuntimeCleanupRequest(requestId)?.status).toBe("queued");
    expect(store.listRuntimeCleanupInboxDeliveries(fixture.orchestratorId)).toHaveLength(1);

    const second = await processCleanupDeliveries(
      store as unknown as CleanupDeliveryStore,
      true,
      now + 1,
      () => Promise.resolve(null),
    );
    expect(second.result).toMatchObject({ delivered: 0, pending: 1, escalated: 0 });
    expect(store.listRuntimeResourceEvents(fixture.leaseId).filter((event) =>
      event.eventType === "controller_transferred"
    )).toHaveLength(0);

    expect(store.claimRuntimeCleanupRequest({
      requestId,
      orchestratorId: fixture.orchestratorId,
      sessionId: fixture.sessionId,
      generation: fixture.generation,
      claimToken: "app-poll-claim",
      expectedLeaseFence: fixture.fence,
      leaseUntil: now + 600,
      now: now + 2,
    }).status).toBe("claimed");
  });

  it("poll adapter は inbox claim を receipt/ack とし、それ以前は pending を維持する", async () => {
    const fixture = setupFixture({ provider: "", providerSessionId: "" });
    const requestId = createRequest(fixture);
    const result = await processCleanupDeliveries(
      store as unknown as CleanupDeliveryStore,
      true,
      now,
      () => Promise.resolve(null),
    );
    expect(result.result.pending).toBe(1);
    expect(store.getRuntimeCleanupRequest(requestId)?.status).toBe("queued");

    const claimed = store.claimRuntimeCleanupRequest({
      requestId,
      orchestratorId: fixture.orchestratorId,
      sessionId: fixture.sessionId,
      generation: fixture.generation,
      claimToken: "poll-claim",
      expectedLeaseFence: fixture.fence,
      leaseUntil: now + 600,
      now,
    });
    expect(claimed.status).toBe("claimed");
    expect(store.listPendingRuntimeResourceOutbox().map((row) => row.transport)).toEqual(["macos", "telegram"]);
  });

  it("stale primary を外し task collaborator へ controller を CAS route する", async () => {
    const fixture = setupFixture();
    store.heartbeatOrchestratorSession(fixture.sessionId, fixture.generation, now - STALE_SESSION_SECONDS - 1);
    store.bindTaskToOrchestrator(fixture.taskId, fixture.orchestratorId, "primary");
    const collaborator = store.registerOrchestrator({ label: "collaborator", project: "project-a", repoCommonDir: root });
    const collaboratorSession = store.startOrchestratorSession({
      orchestratorId: collaborator.id,
      provider: "claude",
      providerSessionId: "provider-collaborator",
    });
    store.heartbeatOrchestratorSession(collaboratorSession.id, collaboratorSession.generation, now);
    store.bindTaskToOrchestrator(fixture.taskId, collaborator.id, "collaborator");
    const unrelated = store.registerOrchestrator({ label: "unrelated", project: "other", repoCommonDir: root });
    const unrelatedSession = store.startOrchestratorSession({ orchestratorId: unrelated.id });
    store.heartbeatOrchestratorSession(unrelatedSession.id, unrelatedSession.generation, now);
    const requestId = createRequest(fixture);

    const result = await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now, receiptAdapter);
    expect(result.result).toMatchObject({ routed: 1, delivered: 1, escalated: 0 });
    expect(store.getRuntimeResourceLease(fixture.leaseId)?.controllerOrchestratorId).toBe(collaborator.id);
    expect(store.listPendingRuntimeCleanupDeliveries().some((row) => row.orchestratorId === unrelated.id)).toBe(false);
    expect(store.getRuntimeCleanupRequest(requestId)?.status).toBe("delivered");
  });

  it("task/subtree/worktree/project の順で narrow な primary watch を選ぶ", async () => {
    const fixture = setupFixture();
    store.heartbeatOrchestratorSession(fixture.sessionId, fixture.generation, now - STALE_SESSION_SECONDS - 1);
    const projectWatcher = store.registerOrchestrator({ label: "project", project: "project-a", repoCommonDir: root });
    const projectSession = store.startOrchestratorSession({ orchestratorId: projectWatcher.id, provider: "codex", providerSessionId: "project" });
    store.heartbeatOrchestratorSession(projectSession.id, projectSession.generation, now);
    store.addOrchestratorWatch({ orchestratorId: projectWatcher.id, scope: "project", selector: "project-a", role: "primary" });
    const taskWatcher = store.registerOrchestrator({ label: "task", project: "project-a", repoCommonDir: root });
    const taskSession = store.startOrchestratorSession({ orchestratorId: taskWatcher.id, provider: "codex", providerSessionId: "task" });
    store.heartbeatOrchestratorSession(taskSession.id, taskSession.generation, now);
    store.addOrchestratorWatch({ orchestratorId: taskWatcher.id, scope: "task", selector: fixture.taskId, role: "primary" });
    createRequest(fixture);

    await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now, receiptAdapter);
    expect(store.getRuntimeResourceLease(fixture.leaseId)?.controllerOrchestratorId).toBe(taskWatcher.id);
  });

  it("task collaborator は project primary より具体的なので task tier で選ぶ", async () => {
    const fixture = setupFixture({ provider: "", providerSessionId: "" });
    store.heartbeatOrchestratorSession(fixture.sessionId, fixture.generation, now - STALE_SESSION_SECONDS - 1);
    const primary = store.registerOrchestrator({ label: "project-primary", project: "project-a", repoCommonDir: root });
    const primarySession = store.startOrchestratorSession({ orchestratorId: primary.id });
    store.heartbeatOrchestratorSession(primarySession.id, primarySession.generation, now);
    store.addOrchestratorWatch({
      orchestratorId: primary.id,
      scope: "project",
      selector: "project-a",
      role: "primary",
    });
    const collaborator = store.registerOrchestrator({ label: "task-collaborator", project: "project-a", repoCommonDir: root });
    const collaboratorSession = store.startOrchestratorSession({ orchestratorId: collaborator.id });
    store.heartbeatOrchestratorSession(collaboratorSession.id, collaboratorSession.generation, now);
    store.addOrchestratorWatch({
      orchestratorId: collaborator.id,
      scope: "task",
      selector: fixture.taskId,
      role: "collaborator",
    });
    const requestId = createRequest(fixture);

    const result = await processCleanupDeliveries(
      store as unknown as CleanupDeliveryStore,
      true,
      now,
      () => Promise.resolve(null),
    );

    expect(result.result).toMatchObject({ delivered: 0, routed: 1, pending: 1, escalated: 0 });
    expect(store.getRuntimeResourceLease(fixture.leaseId)?.controllerOrchestratorId).toBe(collaborator.id);
    expect(store.listRuntimeCleanupInboxDeliveries(primary.id)).toHaveLength(0);
    expect(store.listRuntimeCleanupInboxDeliveries(collaborator.id)).toHaveLength(1);
    expect(store.getRuntimeCleanupRequest(requestId)?.status).toBe("queued");
  });

  it("同じ exact worktree tier では primary を collaborator より先に選ぶ", async () => {
    const fixture = setupFixture({ provider: "", providerSessionId: "" });
    const canonicalWorktree = store.getRuntimeResourceLease(fixture.leaseId)!.canonicalWorktree;
    store.heartbeatOrchestratorSession(fixture.sessionId, fixture.generation, now - STALE_SESSION_SECONDS - 1);
    const primary = store.registerOrchestrator({ label: "worktree-primary", project: "project-a", repoCommonDir: root });
    const primarySession = store.startOrchestratorSession({ orchestratorId: primary.id });
    store.heartbeatOrchestratorSession(primarySession.id, primarySession.generation, now);
    store.addOrchestratorWatch({
      orchestratorId: primary.id,
      scope: "worktree",
      selector: canonicalWorktree,
      role: "primary",
    });
    const collaborator = store.registerOrchestrator({ label: "worktree-collaborator", project: "project-a", repoCommonDir: root });
    const collaboratorSession = store.startOrchestratorSession({ orchestratorId: collaborator.id });
    store.heartbeatOrchestratorSession(collaboratorSession.id, collaboratorSession.generation, now);
    store.addOrchestratorWatch({
      orchestratorId: collaborator.id,
      scope: "worktree",
      selector: canonicalWorktree,
      role: "collaborator",
    });
    createRequest(fixture);

    await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now, () => Promise.resolve(null));

    expect(store.getRuntimeResourceLease(fixture.leaseId)?.controllerOrchestratorId).toBe(primary.id);
    expect(store.listRuntimeCleanupInboxDeliveries(primary.id)).toHaveLength(1);
    expect(store.listRuntimeCleanupInboxDeliveries(collaborator.id)).toHaveLength(0);
  });

  it("同一 identity の同じ tier は primary role を失わず1候補へ集約する", async () => {
    const fixture = setupFixture({ provider: "", providerSessionId: "" });
    const canonicalWorktree = store.getRuntimeResourceLease(fixture.leaseId)!.canonicalWorktree;
    store.heartbeatOrchestratorSession(fixture.sessionId, fixture.generation, now - STALE_SESSION_SECONDS - 1);
    const watcher = store.registerOrchestrator({ label: "dual-role", project: "project-a", repoCommonDir: root });
    const watcherSession = store.startOrchestratorSession({ orchestratorId: watcher.id });
    store.heartbeatOrchestratorSession(watcherSession.id, watcherSession.generation, now);
    const primaryWatch = store.addOrchestratorWatch({
      orchestratorId: watcher.id,
      scope: "worktree",
      selector: canonicalWorktree,
      role: "primary",
    });
    store.addOrchestratorWatch({
      orchestratorId: watcher.id,
      scope: "worktree",
      selector: canonicalWorktree,
      role: "collaborator",
      priority: 100,
    });
    createRequest(fixture);

    await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now, () => Promise.resolve(null));

    expect(store.getRuntimeResourceLease(fixture.leaseId)?.controllerOrchestratorId).toBe(watcher.id);
    expect(store.listRuntimeCleanupInboxDeliveries(watcher.id)).toEqual([
      expect.objectContaining({ watchId: primaryWatch.id }),
    ]);
  });

  it("明示 task binding がある identity は project/worktree watch を混入させない", async () => {
    const fixture = setupFixture({ provider: "", providerSessionId: "" });
    store.heartbeatOrchestratorSession(fixture.sessionId, fixture.generation, now - STALE_SESSION_SECONDS - 1);
    const bound = store.registerOrchestrator({ label: "bound", project: "project-a", repoCommonDir: root });
    const boundSession = store.startOrchestratorSession({ orchestratorId: bound.id });
    store.heartbeatOrchestratorSession(boundSession.id, boundSession.generation, now);
    store.bindTaskToOrchestrator(fixture.taskId, bound.id, "collaborator");
    store.addOrchestratorWatch({
      orchestratorId: bound.id,
      scope: "worktree",
      selector: root,
      role: "primary",
    });
    store.addOrchestratorWatch({
      orchestratorId: bound.id,
      scope: "project",
      selector: "project-a",
      role: "primary",
    });
    createRequest(fixture);

    await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now, () => Promise.resolve(null));

    expect(store.getRuntimeResourceLease(fixture.leaseId)?.controllerOrchestratorId).toBe(bound.id);
    expect(store.listRuntimeCleanupInboxDeliveries(bound.id)).toEqual([
      expect.objectContaining({ watchId: null }),
    ]);
  });

  it("別 identity の明示 binding が stale でも watch へ移管せず fallback owner で pending を保つ", async () => {
    const fixture = setupFixture({ provider: "", providerSessionId: "" });
    const staleBound = store.registerOrchestrator({ label: "stale-bound", project: "project-a", repoCommonDir: root });
    const staleSession = store.startOrchestratorSession({ orchestratorId: staleBound.id });
    store.heartbeatOrchestratorSession(staleSession.id, staleSession.generation, now - STALE_SESSION_SECONDS - 1);
    store.bindTaskToOrchestrator(fixture.taskId, staleBound.id, "primary");
    const watcher = store.registerOrchestrator({ label: "live-project-watch", project: "project-a", repoCommonDir: root });
    const watcherSession = store.startOrchestratorSession({ orchestratorId: watcher.id });
    store.heartbeatOrchestratorSession(watcherSession.id, watcherSession.generation, now);
    store.addOrchestratorWatch({
      orchestratorId: watcher.id,
      scope: "project",
      selector: "project-a",
      role: "primary",
    });
    const requestId = createRequest(fixture, "stale binding fallback");

    const result = await processCleanupDeliveries(
      store as unknown as CleanupDeliveryStore,
      true,
      now,
      () => Promise.resolve(null),
    );

    expect(result.result).toMatchObject({ delivered: 0, routed: 0, pending: 1, escalated: 0 });
    expect(store.getRuntimeResourceLease(fixture.leaseId)?.controllerOrchestratorId).toBe(fixture.orchestratorId);
    expect(store.getRuntimeCleanupRequest(requestId)?.status).toBe("queued");
    expect(store.listRuntimeCleanupInboxDeliveries(fixture.orchestratorId)).toHaveLength(1);
    expect(store.listRuntimeCleanupInboxDeliveries(watcher.id)).toHaveLength(0);
  });

  it("watch が無い場合は生存中 fallback owner へ配送する", async () => {
    const fixture = setupFixture();
    createRequest(fixture);
    const result = await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now, receiptAdapter);
    expect(result.result).toMatchObject({ delivered: 1, routed: 0, escalated: 0 });
  });

  it("先頭 request の50 stale候補より後ろにある生存 fallback owner を見落とさない", async () => {
    const fixture = setupFixture();
    for (let index = 0; index < 50; index += 1) {
      const stale = store.registerOrchestrator({
        label: `stale-${index}`,
        project: "project-a",
        repoCommonDir: root,
      });
      store.bindTaskToOrchestrator(fixture.taskId, stale.id, "collaborator");
    }
    const requestId = createRequest(fixture, "candidate boundary");
    expect(store.listPendingRuntimeCleanupDeliveries(1).filter((row) => row.requestId === requestId)).toHaveLength(51);

    const result = await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now, receiptAdapter);

    expect(result.result).toMatchObject({ delivered: 1, routed: 0, escalated: 0 });
    expect(store.getRuntimeCleanupRequest(requestId)?.status).toBe("delivered");
    expect(store.getRuntimeResourceLease(fixture.leaseId)?.controllerOrchestratorId).toBe(fixture.orchestratorId);
  });

  it("完全な候補集合で primary、collaborator、fallback owner の順を保つ", async () => {
    const selected: string[] = [];
    const adapter: CleanupDeliveryAdapter = (attempt) => {
      selected.push(attempt.delivery.orchestratorId);
      return Promise.resolve(`receipt:${attempt.delivery.requestId}`);
    };

    const primaryFixture = setupFixture();
    const primary = store.registerOrchestrator({ label: "rank-primary", project: "project-a", repoCommonDir: root });
    const primarySession = store.startOrchestratorSession({ orchestratorId: primary.id });
    store.heartbeatOrchestratorSession(primarySession.id, primarySession.generation, now);
    const collaborator = store.registerOrchestrator({ label: "rank-collaborator", project: "project-a", repoCommonDir: root });
    const collaboratorSession = store.startOrchestratorSession({ orchestratorId: collaborator.id });
    store.heartbeatOrchestratorSession(collaboratorSession.id, collaboratorSession.generation, now);
    store.bindTaskToOrchestrator(primaryFixture.taskId, primary.id, "primary");
    store.bindTaskToOrchestrator(primaryFixture.taskId, collaborator.id, "collaborator");
    createRequest(primaryFixture, "rank primary");
    await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now, adapter);
    expect(selected.pop()).toBe(primary.id);
    store.closeOrchestratorSession(primaryFixture.sessionId, primaryFixture.generation);

    const collaboratorFixture = setupFixture();
    const stalePrimary = store.registerOrchestrator({ label: "rank-stale-primary", project: "project-a", repoCommonDir: root });
    const liveCollaborator = store.registerOrchestrator({ label: "rank-live-collaborator", project: "project-a", repoCommonDir: root });
    const liveCollaboratorSession = store.startOrchestratorSession({ orchestratorId: liveCollaborator.id });
    store.heartbeatOrchestratorSession(liveCollaboratorSession.id, liveCollaboratorSession.generation, now);
    store.bindTaskToOrchestrator(collaboratorFixture.taskId, stalePrimary.id, "primary");
    store.bindTaskToOrchestrator(collaboratorFixture.taskId, liveCollaborator.id, "collaborator");
    createRequest(collaboratorFixture, "rank collaborator");
    await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now, adapter);
    expect(selected.pop()).toBe(liveCollaborator.id);
    store.closeOrchestratorSession(collaboratorFixture.sessionId, collaboratorFixture.generation);

    const fallbackFixture = setupFixture();
    const staleOnly = store.registerOrchestrator({ label: "rank-stale-only", project: "project-a", repoCommonDir: root });
    store.bindTaskToOrchestrator(fallbackFixture.taskId, staleOnly.id, "primary");
    createRequest(fallbackFixture, "rank fallback");
    await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now, adapter);
    expect(selected.pop()).toBe(fallbackFixture.orchestratorId);
  });

  it("primary 生存中は collaborator delivery を dismiss して inbox に露出しない", async () => {
    const fixture = setupFixture({ provider: "", providerSessionId: "" });
    store.bindTaskToOrchestrator(fixture.taskId, fixture.orchestratorId, "primary");
    const collaborator = store.registerOrchestrator({ label: "collaborator-live", project: "project-a", repoCommonDir: root });
    const collaboratorSession = store.startOrchestratorSession({ orchestratorId: collaborator.id });
    store.heartbeatOrchestratorSession(collaboratorSession.id, collaboratorSession.generation, now);
    store.bindTaskToOrchestrator(fixture.taskId, collaborator.id, "collaborator");
    createRequest(fixture);

    await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now, () => Promise.resolve(null));

    expect(store.listRuntimeCleanupInboxDeliveries(fixture.orchestratorId)).toHaveLength(1);
    expect(store.listRuntimeCleanupInboxDeliveries(collaborator.id)).toHaveLength(0);
  });

  it("全宛先不在時だけ waiting_human へ明示 escalation する", async () => {
    const fixture = setupFixture();
    store.heartbeatOrchestratorSession(fixture.sessionId, fixture.generation, now - STALE_SESSION_SECONDS - 1);
    const requestId = createRequest(fixture);
    const result = await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now, receiptAdapter);
    expect(result.result.escalated).toBe(1);
    expect(store.getRuntimeCleanupRequest(requestId)).toMatchObject({ status: "waiting_human", decisionClass: "human" });
    const outbox = store.listPendingRuntimeResourceOutbox();
    expect(outbox).toHaveLength(2);
    expect(outbox.every((row) => JSON.parse(row.payload).route === "human_question")).toBe(true);
  });

  it("planned handoff 中は副作用なく pending を保ち、accept 後の新 generation へ配送する", async () => {
    const fixture = setupFixture({ provider: "", providerSessionId: "" });
    const collaborator = store.registerOrchestrator({ label: "handoff-collaborator", project: "project-a", repoCommonDir: root });
    const collaboratorSession = store.startOrchestratorSession({ orchestratorId: collaborator.id });
    store.heartbeatOrchestratorSession(collaboratorSession.id, collaboratorSession.generation, now);
    store.bindTaskToOrchestrator(fixture.taskId, collaborator.id, "collaborator");
    const tokenHash = "c".repeat(64);
    store.prepareOrchestratorHandoff(fixture.sessionId, fixture.generation, tokenHash, now + 600);
    const requestId = createRequest(fixture);
    const attempts: Array<{ sessionId: string; generation: number }> = [];
    const adapter: CleanupDeliveryAdapter = (attempt) => {
      attempts.push({ sessionId: attempt.session.id, generation: attempt.session.generation });
      return Promise.resolve(`receipt:${attempt.session.id}`);
    };

    const pending = await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now, adapter);

    expect(pending.result).toMatchObject({ delivered: 0, routed: 0, pending: 1, escalated: 0 });
    expect(attempts).toHaveLength(0);
    expect(store.getRuntimeCleanupRequest(requestId)?.status).toBe("queued");
    expect(store.listRuntimeCleanupInboxDeliveries(fixture.orchestratorId)).toHaveLength(1);
    expect(store.listRuntimeCleanupInboxDeliveries(collaborator.id)).toHaveLength(0);
    expect(store.getRuntimeResourceLease(fixture.leaseId)?.controllerOrchestratorId).toBe(fixture.orchestratorId);
    expect(store.listPendingRuntimeResourceOutbox()).toHaveLength(0);

    const next = store.acceptOrchestratorHandoff({ oldSessionId: fixture.sessionId, tokenHash });
    const delivered = await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now + 1, adapter);

    expect(delivered.result).toMatchObject({ delivered: 1, routed: 0, pending: 0, escalated: 0 });
    expect(attempts).toEqual([{ sessionId: next.id, generation: next.generation }]);
    expect(store.getRuntimeCleanupRequest(requestId)?.status).toBe("delivered");
    expect(store.getRuntimeResourceLease(fixture.leaseId)?.controllerOrchestratorId).toBe(fixture.orchestratorId);
  });

  it("planned handoff 期限切れ後は stale 判定から collaborator fallback へ進む", async () => {
    const fixture = setupFixture({ provider: "", providerSessionId: "" });
    store.bindTaskToOrchestrator(fixture.taskId, fixture.orchestratorId, "primary");
    const collaborator = store.registerOrchestrator({ label: "handoff-fallback", project: "project-a", repoCommonDir: root });
    const collaboratorSession = store.startOrchestratorSession({ orchestratorId: collaborator.id });
    store.heartbeatOrchestratorSession(collaboratorSession.id, collaboratorSession.generation, now);
    store.bindTaskToOrchestrator(fixture.taskId, collaborator.id, "collaborator");
    store.prepareOrchestratorHandoff(fixture.sessionId, fixture.generation, "d".repeat(64), now + 10);
    const requestId = createRequest(fixture);

    const pending = await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now + 5, receiptAdapter);
    expect(pending.result).toMatchObject({ delivered: 0, routed: 0, pending: 1, escalated: 0 });
    expect(store.getRuntimeCleanupRequest(requestId)?.status).toBe("queued");

    const delivered = await processCleanupDeliveries(store as unknown as CleanupDeliveryStore, true, now + 11, receiptAdapter);
    expect(delivered.result).toMatchObject({ delivered: 1, routed: 1, pending: 0, escalated: 0 });
    expect(store.getRuntimeResourceLease(fixture.leaseId)?.controllerOrchestratorId).toBe(collaborator.id);
    expect(store.getRuntimeCleanupRequest(requestId)?.status).toBe("delivered");
  });

  it("planned handoff は新 generation を配送先にし stale writer を拒否する", async () => {
    const fixture = setupFixture({ provider: "", providerSessionId: "" });
    const requestId = createRequest(fixture);
    store.claimRuntimeCleanupRequest({
      requestId,
      orchestratorId: fixture.orchestratorId,
      sessionId: fixture.sessionId,
      generation: fixture.generation,
      claimToken: "handoff-token",
      expectedLeaseFence: fixture.fence,
      leaseUntil: now + 600,
      now,
    });
    const tokenHash = "b".repeat(64);
    store.prepareOrchestratorHandoff(fixture.sessionId, fixture.generation, tokenHash, now + 600);
    const next = store.acceptOrchestratorHandoff({ oldSessionId: fixture.sessionId, tokenHash });
    expect(store.getRuntimeCleanupRequest(requestId)).toMatchObject({
      claimantSessionId: next.id,
      claimantGeneration: next.generation,
    });
    expect(() => store.approveRuntimeCleanupRequest({
      requestId,
      orchestratorId: fixture.orchestratorId,
      sessionId: fixture.sessionId,
      generation: fixture.generation,
      claimToken: "handoff-token",
      expectedLeaseFence: fixture.fence,
      now: now + 1,
    })).toThrow(/generation|session/);
  });
});
