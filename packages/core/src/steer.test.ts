import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import type { SteerDeliveryRow } from "./steer.js";

describe("durable steer lifecycle contract §58", () => {
  let store: SqliteKanbanStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  function setup(): { taskId: string; runId: number; sessionId: string } {
    store = new SqliteKanbanStore(":memory:");
    const task = store.createTask({ title: "steer", body: "cwd: /tmp/steer", tenant: "dev", status: "ready" }, "test");
    const run = store.startRun(task.id, "codex", "session-current", { transport: "bridge" });
    return { taskId: task.id, runId: run.id, sessionId: run.sessionId };
  }

  function queue(key: string, target: ReturnType<typeof setup>, supersedesId?: string): SteerDeliveryRow {
    return store!.createOrGetSteerDelivery({
      taskId: target.taskId,
      runId: target.runId,
      sessionId: target.sessionId,
      messageKey: key,
      expectedCancelFence: 0,
      ...(supersedesId === undefined ? {} : { supersedesId }),
      actor: "orchestrator",
    });
  }

  it("migration v15 を冪等適用し欠落tableを自己修復する", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-steer-migration-"));
    const path = join(dir, "kanban.db");
    try {
      new SqliteKanbanStore(path).close();
      const raw = new Database(path);
      raw.exec(`DROP TABLE steer_deliveries`);
      raw.close();
      new SqliteKanbanStore(path).close();
      const check = new Database(path, { readonly: true });
      expect(check.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15`).get()).toEqual({ count: 1 });
      expect(check.prepare(`SELECT COUNT(*) AS count FROM steer_deliveries`).get()).toEqual({ count: 0 });
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("busy中 A→明示訂正B は未acknowledged Aだけsuperseded、Bだけ有効にする", () => {
    const target = setup();
    const a = queue("steer-a", target);
    const b = queue("steer-b", target, a.id);
    expect(store!.listSteerDeliveries(target.taskId)).toMatchObject([
      { id: a.id, sequence: 1, status: "superseded" },
      { id: b.id, sequence: 2, status: "queued", supersedesId: a.id },
    ]);
    expect(store!.listEvents(target.taskId, "steer_superseded")).toHaveLength(1);
  });

  it("acknowledged済みAは取り消したと偽装せず、Bを新sequenceで作る", () => {
    const target = setup();
    const a = queue("steer-a", target);
    store!.claimSteerDispatch(a.id, target.runId, target.sessionId, 0, "supervisor");
    store!.markSteerTransportAccepted(a.id, target.runId, target.sessionId, 0, "supervisor");
    store!.observeSteerDelivery({
      deliveryId: a.id,
      expectedRunId: target.runId,
      expectedSessionId: target.sessionId,
      expectedCancelFence: 0,
      observedMessageId: "bridge-message-10",
      acknowledged: true,
      actor: "worker",
    });
    const b = queue("steer-b", target, a.id);
    expect(store!.getSteerDelivery(a.id)?.status).toBe("acknowledged");
    expect(b).toMatchObject({ sequence: 2, status: "queued" });
    expect(store!.listEvents(target.taskId, "steer_superseded")).toHaveLength(0);
  });

  it("session終了とrun closeで未観測だけstale_cancelledにし、観測済みは維持する", () => {
    const target = setup();
    const queued = queue("queued", target);
    const observed = queue("observed", target);
    store!.claimSteerDispatch(observed.id, target.runId, target.sessionId, 0, "supervisor");
    store!.markSteerTransportAccepted(observed.id, target.runId, target.sessionId, 0, "supervisor");
    store!.observeSteerDelivery({
      deliveryId: observed.id,
      expectedRunId: target.runId,
      expectedSessionId: target.sessionId,
      expectedCancelFence: 0,
      observedMessageId: "bridge-message-11",
      acknowledged: false,
      actor: "worker",
    });
    store!.addEvent(target.taskId, "session_ended", "supervisor", { sessionId: target.sessionId });
    expect(store!.getSteerDelivery(queued.id)?.status).toBe("stale_cancelled");
    expect(store!.getSteerDelivery(observed.id)?.status).toBe("session_observed");
    expect(() => queue("handoff-after-session-end", target)).toThrow(/session終了確定後/);
    store!.endRun(target.runId, "done");
    expect(store!.getSteerDelivery(observed.id)?.status).toBe("session_observed");
  });

  it("transport accepted後のAは取消済みにせず、訂正Bを新sequenceで作る", () => {
    const target = setup();
    const a = queue("accepted-a", target);
    store!.claimSteerDispatch(a.id, target.runId, target.sessionId, 0, "supervisor");
    store!.markSteerTransportAccepted(a.id, target.runId, target.sessionId, 0, "supervisor");

    const b = queue("accepted-b", target, a.id);

    expect(store!.getSteerDelivery(a.id)?.status).toBe("transport_accepted");
    expect(b).toMatchObject({ sequence: 2, status: "queued", supersedesId: a.id });
    expect(store!.listEvents(target.taskId, "steer_superseded")).toHaveLength(0);
  });

  it("dispatch中にcancel fenceが進んでもinject成功はtransport acceptedとして保存する", () => {
    const target = setup();
    const delivery = queue("dispatch-race", target);
    store!.claimSteerDispatch(delivery.id, target.runId, target.sessionId, 0, "supervisor");
    store!.createOrGetRunCancelRequest({
      taskId: target.taskId,
      runId: target.runId,
      sessionId: target.sessionId,
      provider: "codex",
      requestNonce: "cancel-during-dispatch",
      actor: "supervisor",
      reason: "race",
      deadlineAt: 2_000_000_000,
    });

    expect(store!.markSteerTransportAccepted(delivery.id, target.runId, target.sessionId, 0, "supervisor").status)
      .toBe("transport_accepted");
    const event = store!.listEvents(target.taskId, "steer_transport_accepted").at(-1);
    expect(event === undefined ? null : JSON.parse(event.payload)).toMatchObject({ fenceStillCurrent: false });
  });

  it("inject結果が曖昧な失敗はuncertainで残し、queued取消と区別する", () => {
    const target = setup();
    const delivery = queue("dispatch-uncertain", target);
    store!.claimSteerDispatch(delivery.id, target.runId, target.sessionId, 0, "supervisor");

    expect(store!.markSteerDispatchUncertain(delivery.id, "timeout token=secret", "supervisor").status)
      .toBe("uncertain");
    store!.staleCancelSteersForRun(target.runId, target.sessionId, "supervisor", "run-close");
    expect(store!.getSteerDelivery(delivery.id)?.status).toBe("uncertain");
  });

  it("transport acceptedをfailedへ縮退させない", () => {
    const target = setup();
    const delivery = queue("accepted-not-failed", target);
    store!.claimSteerDispatch(delivery.id, target.runId, target.sessionId, 0, "supervisor");
    store!.markSteerTransportAccepted(delivery.id, target.runId, target.sessionId, 0, "supervisor");

    expect(() => store!.failSteerDelivery(delivery.id, "late error", "supervisor")).toThrow(/queued CAS/);
    expect(store!.getSteerDelivery(delivery.id)?.status).toBe("transport_accepted");
  });

  it("初回観測message IDを固定し別IDへの上書きを拒否する", () => {
    const target = setup();
    const delivery = queue("observed-id-fixed", target);
    store!.claimSteerDispatch(delivery.id, target.runId, target.sessionId, 0, "supervisor");
    store!.markSteerTransportAccepted(delivery.id, target.runId, target.sessionId, 0, "supervisor");
    store!.observeSteerDelivery({
      deliveryId: delivery.id,
      expectedRunId: target.runId,
      expectedSessionId: target.sessionId,
      expectedCancelFence: 0,
      observedMessageId: "message-first",
      acknowledged: false,
      actor: "worker",
    });

    expect(() => store!.observeSteerDelivery({
      deliveryId: delivery.id,
      expectedRunId: target.runId,
      expectedSessionId: target.sessionId,
      expectedCancelFence: 0,
      observedMessageId: "message-other",
      acknowledged: true,
      actor: "worker",
    })).toThrow(/初回観測値/);
    expect(store!.getSteerDelivery(delivery.id)).toMatchObject({
      status: "session_observed",
      observedMessageId: "message-first",
    });
  });

  it("replacement runへ旧deliveryを誤配送せず task/run/session/fence不一致をfail-closedにする", () => {
    const target = setup();
    const delivery = queue("old", target);
    store!.endRun(target.runId, "released");
    const replacement = store!.startRun(target.taskId, "codex", "session-replacement", { transport: "bridge" });
    const replacementDelivery = store!.createOrGetSteerDelivery({
      taskId: target.taskId,
      runId: replacement.id,
      sessionId: replacement.sessionId,
      messageKey: "replacement-current",
      expectedCancelFence: 0,
      actor: "orchestrator",
    });
    store!.addEvent(target.taskId, "session_ended", "supervisor", { sessionId: target.sessionId });
    expect(store!.getSteerDelivery(replacementDelivery.id)?.status).toBe("queued");
    expect(() => store!.markSteerTransportAccepted(delivery.id, replacement.id, replacement.sessionId, 0, "supervisor"))
      .toThrow(/CAS|current open/);
    expect(() => store!.createOrGetSteerDelivery({
      taskId: target.taskId,
      runId: target.runId,
      sessionId: target.sessionId,
      messageKey: "late-old",
      expectedCancelFence: 0,
      actor: "orchestrator",
    })).toThrow(/current open/);
  });

  it("cancel intentを優先し、pendingをstale_cancelled化して後続通常steerを拒否する", () => {
    const target = setup();
    const pending = queue("before-cancel", target);
    store!.createOrGetRunCancelRequest({
      taskId: target.taskId,
      runId: target.runId,
      sessionId: target.sessionId,
      provider: "codex",
      requestNonce: "cancel-steer-race",
      actor: "supervisor",
      reason: "cancel wins",
      deadlineAt: 2_000_000_000,
    });
    expect(store!.getSteerDelivery(pending.id)?.status).toBe("stale_cancelled");
    expect(() => store!.createOrGetSteerDelivery({
      taskId: target.taskId,
      runId: target.runId,
      sessionId: target.sessionId,
      messageKey: "after-cancel",
      expectedCancelFence: 1,
      actor: "orchestrator",
    })).toThrow(/cancel 開始後/);
  });
});
