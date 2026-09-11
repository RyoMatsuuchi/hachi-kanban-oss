import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import { createKanbanReadView } from "./readview.js";
import type {
  OrchestratorSessionRow,
  Provider,
  RunCancelRequestRow,
  RunRow,
  TaskRow,
} from "./types.js";

interface CancelFixture {
  task: TaskRow;
  run: RunRow;
  orchestratorId: string;
  session: OrchestratorSessionRow;
}

function createFixture(store: SqliteKanbanStore, provider: Provider = "codex"): CancelFixture {
  const task = store.createTask(
    { title: "durable cancel", body: "cwd: /worktrees/cancel", tenant: "cancel-project", status: "ready" },
    "test",
  );
  const run = store.startRun(task.id, provider, "worker-session-current", { transport: "direct" });
  const orchestrator = store.registerOrchestrator({
    label: "cancel-primary",
    project: "cancel-project",
    repoCommonDir: "/repo/.git",
  });
  const session = store.startOrchestratorSession({
    orchestratorId: orchestrator.id,
    provider,
    providerSessionId: `${provider}-cancel-orchestrator-session`,
  });
  store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
  return { task, run, orchestratorId: orchestrator.id, session };
}

function requestCancel(
  store: SqliteKanbanStore,
  fixture: CancelFixture,
  overrides: Partial<Parameters<SqliteKanbanStore["createOrGetRunCancelRequest"]>[0]> = {},
): RunCancelRequestRow {
  return store.createOrGetRunCancelRequest({
    taskId: fixture.task.id,
    runId: fixture.run.id,
    sessionId: fixture.run.sessionId,
    provider: fixture.run.provider,
    requestNonce: "cancel-nonce-1",
    actor: "orchestrator",
    reason: "worker stalled",
    orchestratorId: fixture.orchestratorId,
    requesterSessionId: fixture.session.id,
    requesterGeneration: fixture.session.generation,
    deadlineAt: 2_000_000_000,
    ...overrides,
  });
}

function transition(
  store: SqliteKanbanStore,
  request: RunCancelRequestRow,
  to: Parameters<SqliteKanbanStore["transitionRunCancelRequest"]>[0]["to"],
  overrides: Partial<Parameters<SqliteKanbanStore["transitionRunCancelRequest"]>[0]> = {},
): RunCancelRequestRow {
  return store.transitionRunCancelRequest({
    requestId: request.id,
    expectedStatus: request.status,
    to,
    expectedRunId: request.runId,
    expectedSessionId: request.sessionId,
    expectedCancelFence: request.cancelFence,
    requestNonce: request.requestNonce,
    actor: "cancel-engine",
    ...overrides,
  });
}

describe("durable run cancel contract §57", () => {
  let store: SqliteKanbanStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it("migration v14 を冪等適用し ReadView から cancel request を参照できる", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-cancel-migration-"));
    const path = join(dir, "kanban.db");
    try {
      const first = new SqliteKanbanStore(path);
      first.close();

      // v14 記録済みだが cancel table 実体だけ欠けた import/旧 DB を再現する。
      const incomplete = new Database(path);
      incomplete.exec(`DROP TABLE run_cancel_requests`);
      incomplete.close();

      const second = new SqliteKanbanStore(path);
      const fixture = createFixture(second);
      const request = requestCancel(second, fixture);
      second.close();

      const raw = new Database(path, { readonly: true });
      expect(raw.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 14`).get()).toEqual({ count: 1 });
      expect(raw.prepare(`SELECT COUNT(*) AS count FROM run_cancel_requests`).get()).toEqual({ count: 1 });
      raw.close();

      const view = createKanbanReadView(path);
      expect(view.cancelRequests(fixture.task.id)).toEqual([request]);
      view.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("current open run/session/provider の完全一致だけで request を作る", () => {
    store = new SqliteKanbanStore(":memory:");
    const fixture = createFixture(store);
    store.endRun(fixture.run.id, "released");
    const current = store.startRun(fixture.task.id, "codex", "worker-session-next", { transport: "direct" });

    expect(() => requestCancel(store!, fixture)).toThrow(/current open run/);
    expect(() => requestCancel(store!, { ...fixture, run: current }, { sessionId: "worker-session-old" })).toThrow(
      /current open run/,
    );
    expect(() => requestCancel(store!, { ...fixture, run: current }, { provider: "claude" })).toThrow(
      /current open run/,
    );
    expect(requestCancel(store, { ...fixture, run: current })).toMatchObject({
      runId: current.id,
      sessionId: current.sessionId,
      provider: "codex",
      cancelFence: 1,
    });
  });

  it("fenced cancel は expected run/session を transaction 内で照合し不一致時は DB mutation 0 にする", () => {
    store = new SqliteKanbanStore(":memory:");
    const fixture = createFixture(store);
    store.endRun(fixture.run.id, "released");
    const current = store.startRun(fixture.task.id, "codex", "worker-session-replacement", {
      transport: "direct",
    });
    const common = {
      taskId: fixture.task.id,
      requestNonce: "fenced-cancel-nonce",
      actor: "orchestrator",
      reason: "suspected stall",
      orchestratorId: fixture.orchestratorId,
      requesterSessionId: fixture.session.id,
      requesterGeneration: fixture.session.generation,
      deadlineAt: 2_000_000_000,
    };

    expect(store.createOrGetFencedRunCancelRequest({
      ...common,
      expectedRunId: fixture.run.id,
    })).toEqual({ targetMatched: "no", request: null });
    expect(store.createOrGetFencedRunCancelRequest({
      ...common,
      expectedSessionId: fixture.run.sessionId,
    })).toEqual({ targetMatched: "no", request: null });
    expect(store.listRunCancelRequests(fixture.task.id)).toHaveLength(0);
    expect(store.listEvents(fixture.task.id, "cancel_requested")).toHaveLength(0);

    const matched = store.createOrGetFencedRunCancelRequest({
      ...common,
      expectedRunId: current.id,
      expectedSessionId: current.sessionId,
    });
    expect(matched.targetMatched).toBe("yes");
    expect(matched.request).toMatchObject({ runId: current.id, sessionId: current.sessionId });
    expect(store.listRunCancelRequests(fixture.task.id)).toHaveLength(1);
  });

  it("active primary session generation を検証し takeover 後の旧 generation を拒否する", () => {
    store = new SqliteKanbanStore(":memory:");
    const fixture = createFixture(store);
    const next = store.takeoverStaleOrchestratorSession({
      orchestratorId: fixture.orchestratorId,
      staleBefore: fixture.session.heartbeatAt + 1,
    });

    expect(() => requestCancel(store!, fixture)).toThrow(/generation.*stale/);
    expect(requestCancel(store, { ...fixture, session: next })).toMatchObject({
      requesterSessionId: next.id,
      requesterGeneration: next.generation,
    });
  });

  it("primary binding がある場合は collaborator/watch に cancel authority を与えない", () => {
    store = new SqliteKanbanStore(":memory:");
    const fixture = createFixture(store);
    const other = store.registerOrchestrator({
      label: "cancel-collaborator",
      project: "cancel-project",
      repoCommonDir: "/repo/.git",
    });
    const otherSession = store.startOrchestratorSession({ orchestratorId: other.id });
    store.bindTaskToOrchestrator(fixture.task.id, other.id, "collaborator");
    store.addOrchestratorWatch({
      orchestratorId: other.id,
      scope: "task",
      selector: fixture.task.id,
      role: "primary",
    });

    expect(() => requestCancel(store!, fixture, {
      orchestratorId: other.id,
      requesterSessionId: otherSession.id,
      requesterGeneration: otherSession.generation,
    })).toThrow(/primary orchestrator/);
  });

  it("binding が無い task は active primary watch を cancel authority として認める", () => {
    store = new SqliteKanbanStore(":memory:");
    const task = store.createTask(
      { title: "watch-owned", body: "cwd: /worktrees/watch-owned", tenant: "watch-project", status: "ready" },
      "test",
    );
    const run = store.startRun(task.id, "claude", "watch-worker-session", { transport: "bridge" });
    const orchestrator = store.registerOrchestrator({ label: "watch-primary", project: "watch-project", repoCommonDir: "" });
    const session = store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "claude",
      providerSessionId: "claude-watch-orchestrator-session",
    });
    store.addOrchestratorWatch({
      orchestratorId: orchestrator.id,
      scope: "worktree",
      selector: "/worktrees/watch-owned",
      role: "primary",
    });

    expect(requestCancel(store, { task, run, orchestratorId: orchestrator.id, session })).toMatchObject({
      provider: "claude",
      requesterGeneration: session.generation,
    });
  });

  it("host supervisor 起点は requester identity 無しでも current run を fence できる", () => {
    store = new SqliteKanbanStore(":memory:");
    const fixture = createFixture(store);
    const request = store.createOrGetRunCancelRequest({
      taskId: fixture.task.id,
      runId: fixture.run.id,
      sessionId: fixture.run.sessionId,
      provider: fixture.run.provider,
      requestNonce: "host-cancel-nonce",
      actor: "supervisor",
      reason: "host observed stall",
      deadlineAt: 2_000_000_000,
    });
    expect(request).toMatchObject({ orchestratorId: "", requesterSessionId: "", requesterGeneration: null });
  });

  it("nonce 再送は同じ row、異なる入力と二重 cancel は拒否する", () => {
    store = new SqliteKanbanStore(":memory:");
    const fixture = createFixture(store);
    const first = requestCancel(store, fixture);
    expect(requestCancel(store, fixture)).toEqual(first);
    expect(() => requestCancel(store!, fixture, { reason: "different reason" })).toThrow(/nonce.*衝突/);
    expect(() => requestCancel(store!, fixture, { requestNonce: "cancel-nonce-2" })).toThrow(/既に進行中/);
    expect(store.listEvents(fixture.task.id, "cancel_requested")).toHaveLength(1);
  });

  it("failed/expired 後だけ新 nonce と単調増加 fence で再試行する", () => {
    store = new SqliteKanbanStore(":memory:");
    const fixture = createFixture(store);
    const first = requestCancel(store, fixture, { deadlineAt: 100 });
    const expired = transition(store, first, "expired", { now: 100 });
    expect(expired.resolvedAt).toBe(100);

    const retry = requestCancel(store, fixture, { requestNonce: "cancel-nonce-2" });
    expect(retry.cancelFence).toBe(2);
    const stopped = transition(store, retry, "stopped", {
      stopEvidence: { evidenceId: "safe-evidence", credential: "Bearer secret-value" },
      now: 200,
    });
    expect(stopped.stopEvidence).toContain("[REDACTED]");
    expect(() => requestCancel(store!, fixture, { requestNonce: "cancel-nonce-3" })).toThrow(/停止済み/);
  });

  it("状態機械、deadline、ack nonce、run/session/fence/nonce CAS を fail-closed にする", () => {
    store = new SqliteKanbanStore(":memory:");
    const fixture = createFixture(store);
    const requested = requestCancel(store, fixture, { deadlineAt: 1_000 });
    expect(() => transition(store!, requested, "acknowledged")).toThrow(/許可されていない/);
    expect(() => transition(store!, requested, "forcing", { now: 999 })).toThrow(/deadline/);
    expect(() => transition(store!, requested, "expired", { now: 999 })).toThrow(/deadline/);
    expect(() => transition(store!, requested, "cooperative_sent", { expectedRunId: requested.runId + 1 })).toThrow(/CAS/);
    expect(() => transition(store!, requested, "cooperative_sent", { expectedSessionId: "other-session" })).toThrow(/CAS/);
    expect(() => transition(store!, requested, "cooperative_sent", { expectedCancelFence: 2 })).toThrow(/CAS/);
    expect(() => transition(store!, requested, "cooperative_sent", { requestNonce: "wrong" })).toThrow(/CAS/);

    const sent = transition(store, requested, "cooperative_sent", { now: 900 });
    expect(() => transition(store!, sent, "acknowledged", { acknowledgedNonce: "wrong", now: 901 })).toThrow(
      /acknowledgement nonce/,
    );
    const acknowledged = transition(store, sent, "acknowledged", {
      acknowledgedNonce: sent.requestNonce,
      now: 901,
    });
    const forcing = transition(store, acknowledged, "forcing", {
      capabilitySnapshot: { protocol: "direct-stop-v1", token: "sk-1234567890" },
      now: 1_000,
    });
    expect(forcing.capabilitySnapshot).toContain("[REDACTED]");
    const stopped = transition(store, forcing, "stopped", { now: 1_001 });
    expect(() => transition(store!, stopped, "failed", { now: 1_002 })).toThrow(/許可されていない/);
    expect(store.listEvents(fixture.task.id).map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "cancel_requested",
        "cancel_injected",
        "cancel_acknowledged",
        "cancel_force_started",
        "cancel_stopped",
      ]),
    );
  });

  it("cancel 後の late result/handoff は task mutation 0で拒否し監査 event だけを残す", () => {
    store = new SqliteKanbanStore(":memory:");
    const fixture = createFixture(store);
    const request = requestCancel(store, fixture);
    const taskBefore = store.getTask(fixture.task.id);

    expect(store.runMutationGate(fixture.run.id, fixture.run.sessionId)).toEqual({
      allowed: false,
      cancelRequestId: request.id,
      cancelFence: request.cancelFence,
      reason: "cancel-fenced",
    });
    expect(store.runMutationGate(fixture.run.id, "late-other-session")).toEqual({
      allowed: false,
      cancelRequestId: null,
      cancelFence: null,
      reason: "run-session-mismatch",
    });
    expect(store.getTask(fixture.task.id)).toEqual(taskBefore);
    expect(store.listEvents(fixture.task.id, "late_result_rejected")).toHaveLength(2);
  });

  it("cancel の無い direct run は既存 stop/release 状態契約を維持する", () => {
    store = new SqliteKanbanStore(":memory:");
    const fixture = createFixture(store);
    expect(store.runMutationGate(fixture.run.id, fixture.run.sessionId)).toEqual({
      allowed: true,
      cancelRequestId: null,
      cancelFence: null,
      reason: "not-cancelled",
    });
    store.endRun(fixture.run.id, "released", { stopReason: "terminated" });
    expect(store.getRun(fixture.run.id)).toMatchObject({ status: "released" });
    expect(store.listEvents(fixture.task.id, "late_result_rejected")).toHaveLength(0);
  });

  it("planned handoff の旧 generation は cancel 作成 authority を失う", () => {
    store = new SqliteKanbanStore(":memory:");
    const fixture = createFixture(store);
    const tokenHash = createHash("sha256").update("handoff-token").digest("hex");
    store.prepareOrchestratorHandoff(fixture.session.id, fixture.session.generation, tokenHash, 2_000_000_000);
    const next = store.acceptOrchestratorHandoff({ oldSessionId: fixture.session.id, tokenHash });
    expect(() => requestCancel(store!, fixture)).toThrow(/generation.*stale/);
    expect(requestCancel(store, { ...fixture, session: next })).toMatchObject({ requesterGeneration: next.generation });
  });
});
