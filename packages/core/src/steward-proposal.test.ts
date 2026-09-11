import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import type { StewardProposalCreateResult, StewardProposalRequestRow } from "./types.js";

/** §69.4-3 のバックオフ窓（秒）。1 回目 24h → 4 回目以降 720h で頭打ち */
const WINDOW_24H = 86400;
const WINDOW_72H = 259200;
const WINDOW_168H = 604800;
const WINDOW_720H = 2592000;

const BASE_NOW = 1_800_000_000;

describe("steward 提案 request family（contract §69）", () => {
  let root: string;
  let dbPath: string;
  let store: SqliteKanbanStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hachi-steward-proposal-"));
    dbPath = join(root, "kanban.db");
    store = new SqliteKanbanStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function createTask(status: "triage" | "todo" | "ready" | "done" = "triage"): string {
    return store.createTask({ title: "proposal target", body: `cwd: ${root}`, tenant: "dev", status }, "test").id;
  }

  function registerOrchestrator(label: string): { id: string; sessionId: string; generation: number } {
    const orchestrator = store.registerOrchestrator({ label, project: "hachi", repoCommonDir: root });
    const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    return { id: orchestrator.id, sessionId: session.id, generation: session.generation };
  }

  /** binding 1 件を持つ task と、その担当 orchestrator を用意する */
  function setupBoundTask(status: "triage" | "todo" | "ready" | "done" = "triage"): {
    taskId: string;
    owner: { id: string; sessionId: string; generation: number };
  } {
    const taskId = createTask(status);
    const owner = registerOrchestrator("owner");
    store.bindTaskToOrchestrator(taskId, owner.id, "primary");
    return { taskId, owner };
  }

  function createProposal(
    taskId: string,
    now: number,
    kind: "promote" | "archive" = "promote",
    reason = "triage 滞留",
  ): StewardProposalCreateResult {
    return store.createStewardProposalRequest({ taskId, kind, reason, now });
  }

  /** queued → claimed まで進めた request の ID を返す */
  function claimed(
    taskId: string,
    owner: { id: string; sessionId: string; generation: number },
    now: number,
    token = "tok-1",
  ): string {
    const created = createProposal(taskId, now);
    if (created.outcome !== "created") {
      throw new Error(`created を期待しましたが ${created.outcome} でした`);
    }
    store.claimStewardProposalRequest({
      requestId: created.request.id,
      orchestratorId: owner.id,
      sessionId: owner.sessionId,
      generation: owner.generation,
      claimToken: token,
      leaseUntil: now + 600,
      now,
    });
    return created.request.id;
  }

  function rawCount(table: string): number {
    store.close();
    const raw = new Database(dbPath);
    const row = raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    raw.close();
    store = new SqliteKanbanStore(dbPath);
    return row.count;
  }

  describe("migration v21", () => {
    it("fresh DB で v21 が適用され、期待する table/index が揃う", () => {
      store.close();
      const raw = new Database(dbPath);
      expect(raw.prepare(`SELECT version FROM schema_migrations WHERE version = 21`).get()).toEqual({ version: 21 });
      const tables = raw
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'steward_proposal%' ORDER BY name`)
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual(["steward_proposal_deliveries", "steward_proposal_requests"]);
      const indexes = raw
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_steward_proposal%' ORDER BY name`)
        .all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual([
        "idx_steward_proposal_delivery_target",
        "idx_steward_proposal_requests_status",
        "idx_steward_proposal_requests_task_kind",
      ]);
      const columns = (raw.prepare(`PRAGMA table_info(steward_proposal_requests)`).all() as Array<{ name: string }>)
        .map((row) => row.name);
      expect(columns).toEqual([
        "id", "task_id", "kind", "reason", "routed_by", "status",
        "claimant_session_id", "claimant_generation", "claim_token_hash", "claim_lease_until",
        "defer_until", "dismissed_at", "dismiss_count", "accepted_task_status", "resolution_reason",
        "created_at", "updated_at", "resolved_at",
      ]);
      // 平文 claim token は列に持たない（hash 列だけ）
      expect(columns).not.toContain("claim_token");
      raw.close();
      store = new SqliteKanbanStore(dbPath);
    });

    it("v20 相当の既存 DB から upgrade しても既存行が壊れない", () => {
      const { taskId, owner } = setupBoundTask();
      const request = store.createOrGetOrchestratorRequest({
        taskId,
        questionId: "q-upgrade-1",
        question: "既存 request は維持されるか",
      });
      store.addComment(taskId, "tester", "upgrade 前のコメント");
      store.close();

      // v21 だけを剥がして v20 の DB を再現する
      const raw = new Database(dbPath);
      raw.exec(`DROP TABLE steward_proposal_deliveries; DROP TABLE steward_proposal_requests;`);
      raw.prepare(`DELETE FROM schema_migrations WHERE version = 21`).run();
      const beforeTasks = raw.prepare(`SELECT COUNT(*) AS count FROM tasks`).get() as { count: number };
      raw.close();

      store = new SqliteKanbanStore(dbPath);
      const check = new Database(dbPath);
      expect(check.prepare(`SELECT version FROM schema_migrations WHERE version = 21`).get()).toEqual({ version: 21 });
      expect(check.prepare(`SELECT COUNT(*) AS count FROM tasks`).get()).toEqual(beforeTasks);
      check.close();

      expect(store.getTask(taskId)?.id).toBe(taskId);
      expect(store.getOrchestratorRequest(request.id)?.questionId).toBe("q-upgrade-1");
      expect(store.listComments(taskId).map((row) => row.body)).toContain("upgrade 前のコメント");
      expect(store.listOrchestratorWatches(owner.id)).toBeDefined();
      // upgrade 後の DB でも提案面が使える
      expect(createProposal(taskId, BASE_NOW).outcome).toBe("created");
    });
  });

  describe("発行と配送", () => {
    it("binding/watch 無しでも tenant 既定に fresh active session があれば request を配送する", () => {
      const taskId = createTask();
      const tenantDefault = registerOrchestrator("tenant-default");
      store.heartbeatOrchestratorSession(tenantDefault.sessionId, tenantDefault.generation, BASE_NOW);

      const result = store.createStewardProposalRequest({
        taskId,
        kind: "promote",
        reason: "tenant 既定へ配送",
        tenantDefaults: { dev: tenantDefault.id },
        now: BASE_NOW,
      });

      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") {
        return;
      }
      expect(store.listStewardProposalDeliveries(result.request.id).map((row) => row.orchestratorId))
        .toEqual([tenantDefault.id]);
      expect(result.request.routedBy).toBe("tenant-default");
      expect(store.listStewardProposalRequests()[0]?.routedBy).toBe("tenant-default");
      const events = store.listEvents(taskId, "steward_proposal_requested");
      expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({ routedBy: "tenant-default" });
    });

    it("tenant 既定 identity に active session が無ければ unrouted のままにする", () => {
      const taskId = createTask();
      const tenantDefault = store.registerOrchestrator({ label: "tenant-default", project: "hachi", repoCommonDir: root });

      const result = store.createStewardProposalRequest({
        taskId,
        kind: "promote",
        reason: "live session 無し",
        tenantDefaults: { dev: tenantDefault.id },
        now: BASE_NOW,
      });

      expect(result).toEqual({ outcome: "unrouted" });
      expect(store.listStewardProposalRequests()).toEqual([]);
      expect(rawCount("steward_proposal_requests")).toBe(0);
    });

    it("primary binding があれば tenant 既定を使わず routedBy を付けない", () => {
      const taskId = createTask();
      const owner = registerOrchestrator("owner");
      const tenantDefault = registerOrchestrator("tenant-default");
      store.bindTaskToOrchestrator(taskId, owner.id, "primary");
      store.heartbeatOrchestratorSession(owner.sessionId, owner.generation, BASE_NOW);
      store.heartbeatOrchestratorSession(tenantDefault.sessionId, tenantDefault.generation, BASE_NOW);

      const result = store.createStewardProposalRequest({
        taskId,
        kind: "promote",
        reason: "binding 優先",
        tenantDefaults: { dev: tenantDefault.id },
        now: BASE_NOW,
      });

      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") {
        return;
      }
      expect(store.listStewardProposalDeliveries(result.request.id).map((row) => row.orchestratorId))
        .toEqual([owner.id]);
      expect(result.request.routedBy).toBeNull();
      const events = store.listEvents(taskId, "steward_proposal_requested");
      expect(JSON.parse(events[0]?.payload ?? "{}")).not.toHaveProperty("routedBy");
    });

    it("observer-only binding があれば tenant 既定を使わず unrouted にする", () => {
      const taskId = createTask();
      const observer = registerOrchestrator("observer");
      const tenantDefault = registerOrchestrator("tenant-default");
      store.bindTaskToOrchestrator(taskId, observer.id, "observer");
      store.heartbeatOrchestratorSession(observer.sessionId, observer.generation, BASE_NOW);
      store.heartbeatOrchestratorSession(tenantDefault.sessionId, tenantDefault.generation, BASE_NOW);

      const result = store.createStewardProposalRequest({
        taskId,
        kind: "promote",
        reason: "observer-only binding を優先",
        tenantDefaults: { dev: tenantDefault.id },
        now: BASE_NOW,
      });

      expect(result).toEqual({ outcome: "unrouted" });
      expect(store.listStewardProposalRequests()).toEqual([]);
      expect(rawCount("steward_proposal_requests")).toBe(0);
      expect(store.listEvents(taskId, "steward_proposal_unrouted")).toHaveLength(1);
    });

    it("binding 済み task では request と全宛先の delivery が同一 Tx で作られる", () => {
      const taskId = createTask();
      const primary = registerOrchestrator("primary");
      const collaborator = registerOrchestrator("collaborator");
      const observer = registerOrchestrator("observer");
      store.bindTaskToOrchestrator(taskId, primary.id, "primary");
      store.bindTaskToOrchestrator(taskId, collaborator.id, "collaborator");
      store.bindTaskToOrchestrator(taskId, observer.id, "observer");

      const result = createProposal(taskId, BASE_NOW);
      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") {
        return;
      }
      expect(result.targetCount).toBe(2);
      expect(result.request).toMatchObject({
        taskId,
        kind: "promote",
        status: "queued",
        dismissCount: 0,
        dismissedAt: null,
        deferUntil: null,
        resolvedAt: null,
      });
      // observer は閲覧のみで宛先に含めない
      expect(store.listStewardProposalDeliveries(result.request.id).map((row) => row.orchestratorId).sort())
        .toEqual([collaborator.id, primary.id].sort());
      expect(store.listStewardProposalRequests(observer.id)).toEqual([]);
      expect(store.listStewardProposalRequests(primary.id).map((row) => row.id)).toEqual([result.request.id]);
    });

    it("配送先 0 件では request も delivery も作らず unrouted を返す", () => {
      const taskId = createTask();
      registerOrchestrator("unrelated"); // watch も binding も張らない

      const result = store.createStewardProposalRequest({ taskId, kind: "promote", reason: "宛先なし", now: BASE_NOW });

      expect(result).toEqual({ outcome: "unrouted" });
      expect(store.listStewardProposalRequests()).toEqual([]);
      expect(rawCount("steward_proposal_requests")).toBe(0);
      expect(rawCount("steward_proposal_deliveries")).toBe(0);
      expect(store.getStewardProposalHealth({ now: BASE_NOW })).toMatchObject({ pendingCount: 0, unroutedCount: 1 });
      // 既定は 24h 窓。窓の外まで進めると数えない（累計にしない）
      expect(store.getStewardProposalHealth({ now: BASE_NOW + WINDOW_24H + 1 }).unroutedCount).toBe(0);
      expect(store.getStewardProposalHealth({ now: BASE_NOW + WINDOW_24H + 1, unroutedSince: 0 }).unroutedCount).toBe(1);
    });

    it("配送先解決が既存 cleanup request の宛先と同一の結果を返す", () => {
      const canonicalRoot = realpathSync(root);
      const controller = registerOrchestrator("controller");
      const collaborator = registerOrchestrator("collab");
      const observer = registerOrchestrator("observer");

      // シナリオ1: 明示 binding（非 observer 優先）
      const boundTask = createTask("ready");
      store.bindTaskToOrchestrator(boundTask, controller.id, "primary");
      store.bindTaskToOrchestrator(boundTask, collaborator.id, "collaborator");
      store.bindTaskToOrchestrator(boundTask, observer.id, "observer");

      // シナリオ2: binding 0 件で scope tier 順に watch を辿る
      const watchedTask = createTask("ready");
      store.addOrchestratorWatch({ orchestratorId: controller.id, scope: "task", selector: watchedTask, role: "primary" });
      store.addOrchestratorWatch({ orchestratorId: collaborator.id, scope: "worktree", selector: canonicalRoot, role: "collaborator" });
      store.addOrchestratorWatch({ orchestratorId: observer.id, scope: "project", selector: "hachi", role: "observer" });

      for (const taskId of [boundTask, watchedTask]) {
        const requirement = store.createOrGetRuntimeResourceRequirement({
          taskId,
          name: "preview",
          bundleKind: "worktree_preview",
          spec: { version: 1, requiredMembers: ["docker_container"] },
          idempotencyKey: `${taskId}:preview`,
        });
        const lease = store.reserveRuntimeResourceLease({
          requirementId: requirement.id,
          controllerOrchestratorId: controller.id,
          board: "dev",
          project: "hachi",
          repoCommonDir: root,
          worktree: root,
          cleanupPolicy: "auto",
          managed: true,
          ephemeral: true,
          expiresAt: BASE_NOW + 600,
          provenanceVersion: 1,
          rolloutGeneration: 1,
          actor: "supervisor",
        });
        const provisioning = store.claimRuntimeResourceLease(lease.id, 1, "supervisor");
        store.addRuntimeResourceMember({
          leaseId: lease.id,
          expectedLeaseFence: provisioning.fence,
          kind: "docker_container",
          state: "active",
          cleanupPolicy: "auto",
          managed: true,
          ephemeral: true,
          scopeKey: `docker:${taskId}`,
          nativeId: `native-${taskId}`,
          labelsHash: "a".repeat(64),
          provenance: { version: 1, labels: {} },
          observedAt: BASE_NOW,
          actor: "supervisor",
        });
        const active = store.transitionRuntimeResourceLease({
          leaseId: lease.id,
          expectedFence: provisioning.fence,
          from: "provisioning",
          to: "active",
          actor: "supervisor",
        });
        const cleanup = store.transitionRuntimeResourceLeaseWithCleanupRequest({
          leaseId: lease.id,
          expectedFence: active.fence,
          from: "active",
          terminalReason: "explicit_release",
          decisionClass: "orchestrator",
          reason: "worktree 終了",
          actor: "supervisor",
        });
        const proposal = store.createStewardProposalRequest({
          taskId,
          kind: "archive",
          reason: "done 相当",
          worktree: canonicalRoot,
          project: "hachi",
          now: BASE_NOW,
        });
        expect(proposal.outcome).toBe("created");
        if (proposal.outcome !== "created") {
          return;
        }

        const stewardTargets = store
          .listStewardProposalDeliveries(proposal.request.id)
          .map((row) => `${row.orchestratorId}:${row.watchId ?? ""}`)
          .sort();
        store.close();
        const raw = new Database(dbPath);
        const cleanupTargets = (raw
          .prepare(`SELECT orchestrator_id, watch_id FROM runtime_cleanup_deliveries WHERE request_id = ?`)
          .all(cleanup.request.id) as Array<{ orchestrator_id: string; watch_id: string | null }>)
          .map((row) => `${row.orchestrator_id}:${row.watch_id ?? ""}`)
          .sort();
        raw.close();
        store = new SqliteKanbanStore(dbPath);

        expect(stewardTargets).toEqual(cleanupTargets);
        // binding シナリオ / watch シナリオとも非 observer 2 件が宛先になる（空集合同士の一致で通らないこと）
        expect(stewardTargets).toHaveLength(2);
        expect(stewardTargets.some((entry) => entry.startsWith(observer.id))).toBe(false);
      }
    });

    it("inbox の観測で pending→delivered、request も queued→delivered へ進む", () => {
      const { taskId, owner } = setupBoundTask();
      const created = createProposal(taskId, BASE_NOW);
      if (created.outcome !== "created") {
        throw new Error("created を期待しました");
      }

      expect(store.markStewardProposalDeliveriesDelivered(owner.id, BASE_NOW + 1)).toBe(1);

      expect(store.getStewardProposalRequest(created.request.id)?.status).toBe("delivered");
      expect(store.listStewardProposalDeliveries(created.request.id)[0]?.status).toBe("delivered");
    });
  });

  describe("§69.4 再提案の抑止", () => {
    it("1. 未終端（queued|delivered|claimed）があれば抑止する", () => {
      const { taskId, owner } = setupBoundTask();
      const created = createProposal(taskId, BASE_NOW);
      if (created.outcome !== "created") {
        throw new Error("created を期待しました");
      }

      expect(createProposal(taskId, BASE_NOW + 10)).toEqual({
        outcome: "suppressed",
        suppressedBy: "active_request",
        suppressedUntil: null,
        blockingRequestId: created.request.id,
      });
      // 別 kind は独立して発行できる
      expect(createProposal(taskId, BASE_NOW + 10, "archive").outcome).toBe("created");

      store.markStewardProposalDeliveriesDelivered(owner.id, BASE_NOW + 11);
      expect(createProposal(taskId, BASE_NOW + 12)).toMatchObject({ suppressedBy: "active_request" });

      store.claimStewardProposalRequest({
        requestId: created.request.id,
        orchestratorId: owner.id,
        sessionId: owner.sessionId,
        generation: owner.generation,
        claimToken: "tok",
        leaseUntil: BASE_NOW + 600,
        now: BASE_NOW + 13,
      });
      expect(createProposal(taskId, BASE_NOW + 14)).toMatchObject({ suppressedBy: "active_request" });
    });

    it("2. deferred は defer_until まで抑止し、経過後は再提案できる", () => {
      const { taskId, owner } = setupBoundTask();
      const requestId = claimed(taskId, owner, BASE_NOW);
      const deferUntil = BASE_NOW + 3600;
      store.deferStewardProposalRequest({
        requestId,
        orchestratorId: owner.id,
        sessionId: owner.sessionId,
        generation: owner.generation,
        claimToken: "tok-1",
        deferUntil,
        now: BASE_NOW + 1,
      });

      expect(createProposal(taskId, deferUntil - 1)).toEqual({
        outcome: "suppressed",
        suppressedBy: "deferred",
        suppressedUntil: deferUntil,
        blockingRequestId: requestId,
      });
      expect(createProposal(taskId, deferUntil).outcome).toBe("created");
    });

    it("3. dismissed のバックオフ窓は境界の直前で抑止し、直後に解ける", () => {
      const { taskId, owner } = setupBoundTask();
      const requestId = claimed(taskId, owner, BASE_NOW);
      const dismissedAt = BASE_NOW + 5;
      store.dismissStewardProposalRequest({
        requestId,
        orchestratorId: owner.id,
        sessionId: owner.sessionId,
        generation: owner.generation,
        claimToken: "tok-1",
        reason: "今回は採らない",
        now: dismissedAt,
      });

      expect(createProposal(taskId, dismissedAt + WINDOW_24H - 1)).toEqual({
        outcome: "suppressed",
        suppressedBy: "dismiss_backoff",
        suppressedUntil: dismissedAt + WINDOW_24H,
        blockingRequestId: requestId,
      });
      expect(createProposal(taskId, dismissedAt + WINDOW_24H).outcome).toBe("created");
    });

    it("3b. dismiss_count が 1→2→3→4 と増えるにつれ窓が 24h→72h→168h→720h へ伸びる", () => {
      const { taskId, owner } = setupBoundTask();
      const windows = [WINDOW_24H, WINDOW_72H, WINDOW_168H, WINDOW_720H];
      let now = BASE_NOW;

      for (const [index, expectedWindow] of windows.entries()) {
        const token = `tok-${index}`;
        const requestId = claimed(taskId, owner, now, token);
        const dismissedAt = now + 1;
        const dismissed = store.dismissStewardProposalRequest({
          requestId,
          orchestratorId: owner.id,
          sessionId: owner.sessionId,
          generation: owner.generation,
          claimToken: token,
          reason: `${index + 1} 回目の却下`,
          now: dismissedAt,
        });

        expect(dismissed.dismissCount).toBe(index + 1);
        expect(dismissed.dismissedAt).toBe(dismissedAt);
        expect(createProposal(taskId, dismissedAt + expectedWindow - 1)).toMatchObject({
          suppressedBy: "dismiss_backoff",
          suppressedUntil: dismissedAt + expectedWindow,
        });
        now = dismissedAt + expectedWindow;
      }
      // 5 回目以降も 720h で頭打ちのまま
      const token = "tok-final";
      const requestId = claimed(taskId, owner, now, token);
      const dismissedAt = now + 1;
      const dismissed = store.dismissStewardProposalRequest({
        requestId,
        orchestratorId: owner.id,
        sessionId: owner.sessionId,
        generation: owner.generation,
        claimToken: token,
        reason: "5 回目の却下",
        now: dismissedAt,
      });
      expect(dismissed.dismissCount).toBe(5);
      expect(createProposal(taskId, dismissedAt + WINDOW_720H - 1)).toMatchObject({
        suppressedBy: "dismiss_backoff",
        suppressedUntil: dismissedAt + WINDOW_720H,
      });
    });

    it("3c. 窓判定は dismissed_at だけを見る（無関係な updated_at 更新で窓が延びない）", () => {
      const { taskId, owner } = setupBoundTask();
      const requestId = claimed(taskId, owner, BASE_NOW);
      const dismissedAt = BASE_NOW + 5;
      store.dismissStewardProposalRequest({
        requestId,
        orchestratorId: owner.id,
        sessionId: owner.sessionId,
        generation: owner.generation,
        claimToken: "tok-1",
        reason: "今回は採らない",
        now: dismissedAt,
      });

      // 窓の外まで updated_at だけを進める（dismissed_at は据え置き）
      const bumpedUpdatedAt = dismissedAt + WINDOW_720H;
      store.close();
      const raw = new Database(dbPath);
      raw.prepare(`UPDATE steward_proposal_requests SET updated_at = ? WHERE id = ?`).run(bumpedUpdatedAt, requestId);
      raw.close();
      store = new SqliteKanbanStore(dbPath);
      expect(store.getStewardProposalRequest(requestId)).toMatchObject({
        updatedAt: bumpedUpdatedAt,
        dismissedAt,
      });

      // updated_at 基準なら 24h 窓はまだ開いていないが、dismissed_at 基準なら既に解けている
      expect(createProposal(taskId, dismissedAt + WINDOW_24H).outcome).toBe("created");
    });

    it("4. accepted は task status が変わるまで抑止し、変わったら再提案できる", () => {
      const { taskId, owner } = setupBoundTask("triage");
      const requestId = claimed(taskId, owner, BASE_NOW);
      const accepted = store.acceptStewardProposalRequest({
        requestId,
        orchestratorId: owner.id,
        sessionId: owner.sessionId,
        generation: owner.generation,
        claimToken: "tok-1",
        now: BASE_NOW + 1,
      });

      expect(accepted).toMatchObject({ status: "accepted", acceptedTaskStatus: "triage" });
      // accept は採用の記録であって遷移の実行ではない（§69.2 / §69.6）
      expect(store.getTask(taskId)?.status).toBe("triage");
      expect(createProposal(taskId, BASE_NOW + WINDOW_720H)).toEqual({
        outcome: "suppressed",
        suppressedBy: "accepted",
        suppressedUntil: null,
        blockingRequestId: requestId,
      });

      store.transition({ taskId, to: "todo", actor: "human" });
      expect(createProposal(taskId, BASE_NOW + 2).outcome).toBe("created");
    });

    it("抑止判定は 1→2→3→4 の順で、先に当たったものを返す", () => {
      const { taskId, owner } = setupBoundTask();
      // 先に dismissed 履歴を作る
      const first = claimed(taskId, owner, BASE_NOW);
      store.dismissStewardProposalRequest({
        requestId: first,
        orchestratorId: owner.id,
        sessionId: owner.sessionId,
        generation: owner.generation,
        claimToken: "tok-1",
        reason: "1 回目",
        now: BASE_NOW + 1,
      });
      // 窓明け後に新しい request を作ると、未終端が優先される
      const openAt = BASE_NOW + 1 + WINDOW_24H;
      const second = createProposal(taskId, openAt);
      if (second.outcome !== "created") {
        throw new Error("created を期待しました");
      }
      expect(createProposal(taskId, openAt + 1)).toMatchObject({
        suppressedBy: "active_request",
        blockingRequestId: second.request.id,
      });
    });
  });

  describe("状態遷移", () => {
    it("同時 claim では resolver が 1 つだけになり、lease 切れ後だけ再 claim できる", () => {
      const taskId = createTask();
      const first = registerOrchestrator("first");
      const second = registerOrchestrator("second");
      store.bindTaskToOrchestrator(taskId, first.id, "primary");
      store.bindTaskToOrchestrator(taskId, second.id, "collaborator");
      const created = createProposal(taskId, BASE_NOW);
      if (created.outcome !== "created") {
        throw new Error("created を期待しました");
      }
      const requestId = created.request.id;

      const claim = (
        owner: { id: string; sessionId: string; generation: number },
        token: string,
        now: number,
      ): StewardProposalRequestRow =>
        store.claimStewardProposalRequest({
          requestId,
          orchestratorId: owner.id,
          sessionId: owner.sessionId,
          generation: owner.generation,
          claimToken: token,
          leaseUntil: now + 60,
          now,
        });

      expect(claim(first, "tok-first", BASE_NOW).claimantSessionId).toBe(first.sessionId);
      expect(() => claim(second, "tok-second", BASE_NOW)).toThrow(/既に claim 済み/);
      expect(store.getStewardProposalRequest(requestId)?.claimantSessionId).toBe(first.sessionId);

      // lease 期限切れ後は別 identity が回収できる
      const afterLease = BASE_NOW + 61;
      expect(claim(second, "tok-second", afterLease).claimantSessionId).toBe(second.sessionId);
    });

    it("配送されていない orchestrator は claim できない", () => {
      const { taskId, owner } = setupBoundTask();
      const outsider = registerOrchestrator("outsider");
      const created = createProposal(taskId, BASE_NOW);
      if (created.outcome !== "created") {
        throw new Error("created を期待しました");
      }

      expect(() => store.claimStewardProposalRequest({
        requestId: created.request.id,
        orchestratorId: outsider.id,
        sessionId: outsider.sessionId,
        generation: outsider.generation,
        claimToken: "tok",
        leaseUntil: BASE_NOW + 60,
        now: BASE_NOW,
      })).toThrow(/配送されていません/);
      expect(store.getStewardProposalRequest(created.request.id)?.status).toBe("queued");
      expect(owner.id).not.toBe(outsider.id);
    });

    it("accept / dismiss / defer は claim 保持者の exact session/generation/token を再照合する", () => {
      const { taskId, owner } = setupBoundTask();
      const requestId = claimed(taskId, owner, BASE_NOW);
      const other = registerOrchestrator("other");
      const base = {
        requestId,
        orchestratorId: owner.id,
        sessionId: owner.sessionId,
        generation: owner.generation,
        claimToken: "tok-1",
        now: BASE_NOW + 1,
      };

      // token 不一致
      expect(() => store.acceptStewardProposalRequest({ ...base, claimToken: "wrong" })).toThrow(/claim CAS/);
      // generation 不一致（active session 照合で落ちる）
      expect(() => store.dismissStewardProposalRequest({ ...base, generation: owner.generation + 1, reason: "x" }))
        .toThrow(/session generation\/identity/);
      // 別 identity
      expect(() => store.deferStewardProposalRequest({
        ...base,
        orchestratorId: other.id,
        sessionId: other.sessionId,
        generation: other.generation,
        deferUntil: BASE_NOW + 100,
      })).toThrow(/claim CAS/);
      // lease 切れ
      expect(() => store.acceptStewardProposalRequest({ ...base, now: BASE_NOW + 601 })).toThrow(/claim CAS/);

      expect(store.getStewardProposalRequest(requestId)?.status).toBe("claimed");
      // 正しい claim 保持者だけが通る
      expect(store.dismissStewardProposalRequest({ ...base, reason: "採らない" }).status).toBe("dismissed");
      // 決着後は未処理 delivery を inbox に残さない
      expect(store.listStewardProposalDeliveries(requestId).every((row) => row.status !== "pending")).toBe(true);
    });

    it("dismiss は理由必須、defer は未来時刻必須", () => {
      const { taskId, owner } = setupBoundTask();
      const requestId = claimed(taskId, owner, BASE_NOW);
      const base = {
        requestId,
        orchestratorId: owner.id,
        sessionId: owner.sessionId,
        generation: owner.generation,
        claimToken: "tok-1",
        now: BASE_NOW + 1,
      };

      expect(() => store.dismissStewardProposalRequest({ ...base, reason: "   " })).toThrow(/reason は必須/);
      expect(() => store.deferStewardProposalRequest({ ...base, deferUntil: BASE_NOW + 1 })).toThrow(/未来の秒指定/);
      expect(store.getStewardProposalRequest(requestId)?.status).toBe("claimed");
    });

    it("supersede は未 claim だけを対象にし、claimed 以降には効かない", () => {
      const { taskId, owner } = setupBoundTask();
      const created = createProposal(taskId, BASE_NOW);
      if (created.outcome !== "created") {
        throw new Error("created を期待しました");
      }

      const superseded = store.supersedeStewardProposalRequest({
        requestId: created.request.id,
        reason: "より新しい reason で再評価",
        now: BASE_NOW + 1,
      });
      expect(superseded).toMatchObject({ status: "superseded", resolvedAt: BASE_NOW + 1 });
      expect(store.listStewardProposalDeliveries(created.request.id).map((row) => row.status)).toEqual(["dismissed"]);

      // 未終端が消えたので再提案できる
      const next = createProposal(taskId, BASE_NOW + 2);
      if (next.outcome !== "created") {
        throw new Error("created を期待しました");
      }
      store.claimStewardProposalRequest({
        requestId: next.request.id,
        orchestratorId: owner.id,
        sessionId: owner.sessionId,
        generation: owner.generation,
        claimToken: "tok-1",
        leaseUntil: BASE_NOW + 600,
        now: BASE_NOW + 3,
      });
      expect(() => store.supersedeStewardProposalRequest({ requestId: next.request.id, now: BASE_NOW + 4 }))
        .toThrow(/未 claim/);
      expect(store.getStewardProposalRequest(next.request.id)?.status).toBe("claimed");
    });

    it("cancel は done/archived 先行時の未 claim だけを回収し、claimed 以降は維持する", () => {
      const taskId = createTask("todo");
      const owner = registerOrchestrator("owner");
      store.bindTaskToOrchestrator(taskId, owner.id, "primary");
      const unclaimed = createProposal(taskId, BASE_NOW, "promote");
      const toClaim = createProposal(taskId, BASE_NOW, "archive");
      if (unclaimed.outcome !== "created" || toClaim.outcome !== "created") {
        throw new Error("created を期待しました");
      }
      store.claimStewardProposalRequest({
        requestId: toClaim.request.id,
        orchestratorId: owner.id,
        sessionId: owner.sessionId,
        generation: owner.generation,
        claimToken: "tok-1",
        leaseUntil: BASE_NOW + 600,
        now: BASE_NOW,
      });

      // 非終端 task では何も回収しない
      expect(store.cancelStewardProposalRequestsForTerminalTask(taskId, BASE_NOW + 1)).toEqual([]);

      store.transition({ taskId, to: "done", actor: "human" });
      expect(store.cancelStewardProposalRequestsForTerminalTask(taskId, BASE_NOW + 2)).toEqual([unclaimed.request.id]);

      expect(store.getStewardProposalRequest(unclaimed.request.id)).toMatchObject({
        status: "cancelled",
        resolvedAt: BASE_NOW + 2,
      });
      expect(store.getStewardProposalRequest(toClaim.request.id)).toMatchObject({
        status: "claimed",
        claimantSessionId: owner.sessionId,
      });
      // 冪等: 2 回目は 0 件
      expect(store.cancelStewardProposalRequestsForTerminalTask(taskId, BASE_NOW + 3)).toEqual([]);
    });
  });

  describe("読み取り面（§69.7）", () => {
    it("未終端提案の最古滞留時間と配送先ゼロ件数を返す", () => {
      const { taskId, owner } = setupBoundTask();
      const otherTask = createTask();
      store.bindTaskToOrchestrator(otherTask, owner.id, "primary");
      const unroutedTask = createTask();

      const oldest = createProposal(taskId, BASE_NOW);
      createProposal(otherTask, BASE_NOW + 100);
      expect(store.createStewardProposalRequest({ taskId: unroutedTask, kind: "promote", reason: "宛先なし", now: BASE_NOW }))
        .toEqual({ outcome: "unrouted" });

      expect(store.getStewardProposalHealth({ now: BASE_NOW + 500 })).toEqual({
        pendingCount: 2,
        oldestPendingCreatedAt: BASE_NOW,
        oldestPendingAgeSeconds: 500,
        unroutedCount: 1,
      });

      if (oldest.outcome !== "created") {
        throw new Error("created を期待しました");
      }
      store.supersedeStewardProposalRequest({ requestId: oldest.request.id, now: BASE_NOW + 1 });
      expect(store.getStewardProposalHealth({ now: BASE_NOW + 500 })).toMatchObject({
        pendingCount: 1,
        oldestPendingCreatedAt: BASE_NOW + 100,
        oldestPendingAgeSeconds: 400,
      });
    });

    it("reason は redact され、空 reason と未知 kind は拒否する", () => {
      const { taskId } = setupBoundTask();

      expect(() => store.createStewardProposalRequest({ taskId, kind: "promote", reason: "  ", now: BASE_NOW }))
        .toThrow(/reason は必須/);
      expect(() => store.createStewardProposalRequest({
        taskId,
        kind: "unknown" as "promote",
        reason: "x",
        now: BASE_NOW,
      })).toThrow(/kind が不正/);

      const created = store.createStewardProposalRequest({
        taskId,
        kind: "promote",
        reason: "token は Bearer abcdef123456 です",
        now: BASE_NOW,
      });
      if (created.outcome !== "created") {
        throw new Error("created を期待しました");
      }
      expect(created.request.reason).not.toContain("abcdef123456");
    });
  });
});
