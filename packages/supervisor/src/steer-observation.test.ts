import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteKanbanStore,
  type RunRow,
  type SessionStatus,
  type SteerDeliveryRow,
  type TaskRow,
} from "@hachi/core";
import { applySteerObservations } from "./steer-observation.js";

describe("steer observation protocol", () => {
  let store: SqliteKanbanStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  function setup(): { task: TaskRow; run: RunRow; delivery: SteerDeliveryRow } {
    store = new SqliteKanbanStore(":memory:");
    const task = store.createTask({ title: "ack", body: "cwd: /tmp", tenant: "dev", status: "ready" }, "test");
    const run = store.startRun(task.id, "codex", "session-ack", { transport: "bridge" });
    const delivery = store.createOrGetSteerDelivery({
      taskId: task.id,
      runId: run.id,
      sessionId: run.sessionId,
      messageKey: "ack-key",
      expectedCancelFence: 0,
      actor: "orchestrator",
    });
    store.claimSteerDispatch(delivery.id, run.id, run.sessionId, 0, "supervisor");
    store.markSteerTransportAccepted(delivery.id, run.id, run.sessionId, 0, "supervisor");
    return { task, run, delivery };
  }

  it("capability広告が無ければ transport_accepted を観測済みと推測しない", () => {
    const { delivery } = setup();
    const status: SessionStatus = {
      state: "active",
      lastActivityAt: null,
      raw: { steerObservations: [{ deliveryId: delivery.id }] },
    };
    expect(applySteerObservations(store!, "codex", status, "supervisor")).toBe(0);
    expect(store!.getSteerDelivery(delivery.id)?.status).toBe("transport_accepted");
  });

  it("広告済みprotocolの構造化run/session/fence/message IDだけをacknowledgedにする", () => {
    const { run, delivery } = setup();
    const status: SessionStatus = {
      state: "active",
      lastActivityAt: null,
      raw: {
        capabilities: { codex: ["steer-observation-v1"] },
        steerObservations: [{
          deliveryId: delivery.id,
          runId: run.id,
          sessionId: run.sessionId,
          cancelFence: 0,
          messageId: "worker-observation-1",
          acknowledged: true,
        }],
      },
    };
    expect(applySteerObservations(store!, "codex", status, "supervisor")).toBe(1);
    expect(store!.getSteerDelivery(delivery.id)).toMatchObject({
      status: "acknowledged",
      observedMessageId: "worker-observation-1",
    });
  });

  it("別sessionのackを拒否しても同batchの後続する正しいackを処理する", () => {
    const { run, delivery } = setup();
    const status: SessionStatus = {
      state: "active",
      lastActivityAt: null,
      raw: {
        capabilities: ["steer-observation-v1"],
        steerObservations: [
          {
            deliveryId: delivery.id,
            runId: run.id,
            sessionId: "replacement-session",
            cancelFence: 0,
            messageId: "wrong-session-ack",
            acknowledged: true,
          },
          {
            deliveryId: delivery.id,
            runId: run.id,
            sessionId: run.sessionId,
            cancelFence: 0,
            messageId: "correct-session-ack",
            acknowledged: true,
          },
        ],
      },
    };
    expect(applySteerObservations(store!, "codex", status, "supervisor")).toBe(1);
    expect(store!.getSteerDelivery(delivery.id)).toMatchObject({
      status: "acknowledged",
      observedMessageId: "correct-session-ack",
    });
    expect(store!.listEvents(run.taskId, "steer_observation_rejected")).toHaveLength(1);
  });
});
