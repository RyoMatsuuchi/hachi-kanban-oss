import {
  probeBridgeExecutionCapabilities,
  probeDirectRuntimeCapabilities,
} from "@hachi/adapters";
import {
  buildModelTransportRequirement,
  evaluateModelTransportCompatibility,
  redactRuntimeObservationText,
  type ExecutionCapabilitySnapshot,
  type ExecutionRole,
  type ModelResolution,
  type ModelTransportCompatibilityDecision,
  type ModelTransportRequirement,
  type TaskRow,
  type Transport,
} from "@hachi/core";
import type { CliDeps } from "./deps.js";

export type ObservableCompatibilityDecision =
  | ModelTransportCompatibilityDecision
  | { status: "unknown"; reason: "capability-probe-failed"; detail: string };

export interface ModelTransportObservation {
  expectation: ModelTransportRequirement;
  observed: ExecutionCapabilitySnapshot | null;
  decision: ObservableCompatibilityDecision;
}

const MODEL_PASSTHROUGH_CAPABILITY = "model-passthrough-v1";
const EFFORT_PASSTHROUGH_CAPABILITY = "effort-passthrough-v1";
const SPEED_PASSTHROUGH_CAPABILITY = "speed-passthrough-v1";

function nativeRequirements(task: TaskRow, role: ExecutionRole): { model: boolean; effort: boolean; speed: boolean } {
  if (role === "reviewer") {
    return {
      model: task.reviewModelOverride !== "",
      effort: task.reviewEffortOverride !== "",
      speed: task.reviewSpeedOverride !== "",
    };
  }
  return {
    model: task.modelOverride !== "",
    effort: task.effortOverride !== "",
    speed: task.speedOverride !== "",
  };
}

/** 解決済み model/transport を実 runtime に対して read-only probe し、表示用の閉じた結果へ正規化する。 */
export async function observeModelTransportCompatibility(
  deps: CliDeps,
  task: TaskRow,
  resolution: Extract<ModelResolution, { ok: true }>,
  transport: Transport = resolution.transport,
  role: ExecutionRole = "worker",
): Promise<ModelTransportObservation> {
  const requirements = nativeRequirements(task, role);
  // §49.4 と同じく、全 override を native 配送できる広告がある場合だけ bridge を実効 transport とする。
  if (
    role === "worker" && resolution.provider === "codex" && resolution.transport === "direct" &&
    (requirements.model || requirements.effort || requirements.speed)
  ) {
    const bridgeResult = await probeRuntime(deps, resolution.provider, "bridge");
    if (bridgeResult.ok) {
      const capabilities = new Set(bridgeResult.snapshot.capabilities);
      const canPromote = (!requirements.model || capabilities.has(MODEL_PASSTHROUGH_CAPABILITY)) &&
        (!requirements.effort || capabilities.has(EFFORT_PASSTHROUGH_CAPABILITY)) &&
        (!requirements.speed || capabilities.has(SPEED_PASSTHROUGH_CAPABILITY));
      if (canPromote) {
        const expectation = buildModelTransportRequirement(deps.config, resolution, "bridge", requirements);
        return {
          expectation,
          observed: bridgeResult.snapshot,
          decision: evaluateModelTransportCompatibility(bridgeResult.snapshot, expectation),
        };
      }
    }
  }
  return observeResolvedModelTransportCompatibility(
    deps,
    resolution,
    requirements,
    transport,
  );
}

async function probeRuntime(
  deps: CliDeps,
  provider: Extract<ModelResolution, { ok: true }>["provider"],
  transport: Transport,
): Promise<
  | { ok: true; snapshot: ExecutionCapabilitySnapshot }
  | { ok: false; detail: string }
> {
  if (deps.modelTransportProbe !== undefined) {
    return deps.modelTransportProbe(provider, transport);
  }
  if (transport === "bridge") {
    const result = await probeBridgeExecutionCapabilities(deps.env.bridges[provider], provider);
    return result.ok ? result : { ok: false, detail: result.failure.detail };
  }
  const result = await probeDirectRuntimeCapabilities({ provider });
  return result.ok ? result : { ok: false, detail: result.failure.detail };
}

export async function observeResolvedModelTransportCompatibility(
  deps: CliDeps,
  resolution: Extract<ModelResolution, { ok: true }>,
  requirements: { model: boolean; effort: boolean; speed?: boolean },
  transport: Transport = resolution.transport,
): Promise<ModelTransportObservation> {
  const expectation = buildModelTransportRequirement(
    deps.config,
    resolution,
    transport,
    requirements,
  );
  const result = await probeRuntime(deps, resolution.provider, transport);
  if (!result.ok) {
    return {
      expectation,
      observed: null,
      decision: {
        status: "unknown",
        reason: "capability-probe-failed",
        detail: redactRuntimeObservationText(result.detail),
      },
    };
  }
  return {
    expectation,
    observed: result.snapshot,
    decision: evaluateModelTransportCompatibility(result.snapshot, expectation),
  };
}
