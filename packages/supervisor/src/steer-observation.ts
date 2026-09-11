import type { DurableSteerStore, KanbanStore, Provider, SessionStatus } from "@hachi/core";

const STEER_OBSERVATION_CAPABILITY = "steer-observation-v1";

interface RawSteerObservation {
  deliveryId: string;
  runId: number;
  sessionId: string;
  cancelFence: number;
  messageId: string;
  acknowledged: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function capabilitiesAdvertise(raw: Record<string, unknown>, provider: Provider): boolean {
  const capabilities = raw["capabilities"];
  if (Array.isArray(capabilities)) {
    return capabilities.includes(STEER_OBSERVATION_CAPABILITY);
  }
  if (!isRecord(capabilities)) {
    return false;
  }
  const providerCapabilities = capabilities[provider];
  return Array.isArray(providerCapabilities) && providerCapabilities.includes(STEER_OBSERVATION_CAPABILITY);
}

function parseObservation(value: unknown): RawSteerObservation | null {
  if (!isRecord(value)) {
    return null;
  }
  const deliveryId = value["deliveryId"];
  const runId = value["runId"];
  const sessionId = value["sessionId"];
  const cancelFence = value["cancelFence"];
  const messageId = value["messageId"];
  const acknowledged = value["acknowledged"];
  if (
    typeof deliveryId !== "string" || deliveryId === "" || typeof runId !== "number" || !Number.isInteger(runId) ||
    typeof sessionId !== "string" || sessionId === "" || typeof cancelFence !== "number" ||
    !Number.isInteger(cancelFence) || cancelFence < 0 || typeof messageId !== "string" || messageId === "" ||
    typeof acknowledged !== "boolean"
  ) {
    return null;
  }
  return { deliveryId, runId, sessionId, cancelFence, messageId, acknowledged };
}

/** capability広告済み bridge の構造化ackだけを適用する。本文やmessage_processedからは推測しない。 */
export function applySteerObservations(
  store: KanbanStore,
  provider: Provider,
  status: SessionStatus,
  actor: string,
): number {
  if (!isRecord(status.raw) || !capabilitiesAdvertise(status.raw, provider)) {
    return 0;
  }
  const rawObservations = status.raw["steerObservations"];
  if (!Array.isArray(rawObservations)) {
    return 0;
  }
  const steerStore = store as KanbanStore & DurableSteerStore;
  let applied = 0;
  for (const candidate of rawObservations) {
    const observation = parseObservation(candidate);
    if (observation === null) {
      continue;
    }
    const delivery = steerStore.getSteerDelivery(observation.deliveryId);
    if (
      delivery === null || delivery.status === "acknowledged" ||
      !["transport_accepted", "session_observed", "uncertain"].includes(delivery.status)
    ) {
      continue;
    }
    try {
      steerStore.observeSteerDelivery({
        deliveryId: observation.deliveryId,
        expectedRunId: observation.runId,
        expectedSessionId: observation.sessionId,
        expectedCancelFence: observation.cancelFence,
        observedMessageId: observation.messageId,
        acknowledged: observation.acknowledged,
        actor,
      });
      applied += 1;
    } catch (error) {
      store.addEvent(delivery.taskId, "steer_observation_rejected", actor, {
        deliveryId: delivery.id,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  return applied;
}
