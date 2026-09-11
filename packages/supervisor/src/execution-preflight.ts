// worker / reviewer / rework が共有する execution capability preflight。
// 値を解決できたことと runtime へ確実に配送できることを分離し、unknown は起動不可とする。
import {
  buildModelTransportRequirement,
  evaluateModelTransportCompatibility,
  MAX_TURNS_PASSTHROUGH_CAPABILITY,
  redactRuntimeObservationText,
} from "@hachi/core";
import type {
  EffortLevel,
  ExecutionCapabilitySnapshot,
  ExecutionSpeed,
  ExecutionRole,
  HachiConfig,
  ModelResolution,
  ModelTransportCompatibilityDecision,
  ModelTransportRequirement,
  Provider,
  StageDeps,
  TaskRow,
  Transport,
} from "@hachi/core";
import {
  probeBridgeExecutionCapabilities,
  probeDirectRuntimeCapabilities,
  type BridgeLaunchSessionRef,
  type BridgePassthroughRequest,
} from "@hachi/adapters";

const MODEL_PASSTHROUGH_CAPABILITY = "model-passthrough-v1";
const EFFORT_PASSTHROUGH_CAPABILITY = "effort-passthrough-v1";
const SPEED_PASSTHROUGH_CAPABILITY = "speed-passthrough-v1";

export interface ExecutionOverrideRequirements {
  model: boolean;
  effort: boolean;
  /** 省略は false。旧callerとのsource互換を維持する。 */
  speed?: boolean;
  /** 現在選ぶ bridge adapter が maxTurns を送る場合だけ true。 */
  maxTurns?: boolean;
}

export interface NativeDeliveryRequirements {
  model?: string;
  effort?: EffortLevel;
  speed?: ExecutionSpeed;
}

export type ExecutionBridgeCapabilities =
  | { status: "known"; capabilities: readonly string[] }
  | { status: "unknown"; detail: string };

export interface ExecutionTransportDecision {
  transport: Transport;
  passthrough?: BridgePassthroughRequest;
  reason: "configured" | "passthrough-promoted" | "passthrough-unavailable" | "passthrough-unknown";
}

export interface ExecutionPreflightProbe {
  probe(provider: Provider, transport: Transport): Promise<
    | { ok: true; snapshot: ExecutionCapabilitySnapshot }
    | { ok: false; detail: string }
  >;
}

export interface StageDepsWithExecutionPreflight extends StageDeps {
  /** テスト・埋め込み環境向け。未指定時は adapter の実 runtime probe を使う。 */
  modelTransportPreflight?: ExecutionPreflightProbe;
}

export type ExecutionCompatibilityDecision =
  | (ModelTransportCompatibilityDecision & {
      expectation: ModelTransportRequirement;
      observed: ExecutionCapabilitySnapshot;
    })
  | {
      status: "unknown";
      reason: "capability-probe-failed";
      detail: string;
      expectation: ModelTransportRequirement;
      observed: null;
    };

export function executionOverrideRequirements(
  task: TaskRow,
  role: ExecutionRole,
): ExecutionOverrideRequirements {
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

/**
 * supervisor が LaunchOptions へ載せる値から、202 応答で照合すべき要求値を組み立てる。
 * adapter 固有の maxTurns は launch 後の ref.requestedMaxTurns を正本として判定する。
 */
export function bridgeNativeDeliveryRequirements(
  resolution: Extract<ModelResolution, { ok: true }>,
): NativeDeliveryRequirements {
  return {
    model: resolution.model,
    ...(resolution.effort !== undefined ? { effort: resolution.effort } : {}),
    ...(resolution.speed !== undefined ? { speed: resolution.speed } : {}),
  };
}

function hasCapability(capabilities: readonly string[], capability: string): boolean {
  return capabilities.includes(capability);
}

export function resolveExecutionTransport(
  resolution: Extract<ModelResolution, { ok: true }>,
  capabilities: ExecutionBridgeCapabilities,
  requirements: ExecutionOverrideRequirements,
): ExecutionTransportDecision {
  const hasOverride = requirements.model || requirements.effort || requirements.speed === true;
  if (resolution.transport === "bridge" && requirements.maxTurns === true) {
    if (capabilities.status === "unknown") {
      return { transport: "direct", reason: "passthrough-unknown" };
    }
    if (!hasCapability(capabilities.capabilities, MAX_TURNS_PASSTHROUGH_CAPABILITY)) {
      return { transport: "direct", reason: "passthrough-unavailable" };
    }
    return { transport: "bridge", reason: "configured" };
  }
  if (resolution.transport !== "direct" || !hasOverride || resolution.provider !== "codex") {
    return { transport: resolution.transport, reason: "configured" };
  }
  if (capabilities.status === "unknown") {
    return { transport: "direct", reason: "passthrough-unknown" };
  }
  const modelReady = !requirements.model || hasCapability(capabilities.capabilities, MODEL_PASSTHROUGH_CAPABILITY);
  const effortReady = !requirements.effort || hasCapability(capabilities.capabilities, EFFORT_PASSTHROUGH_CAPABILITY);
  const speedReady = requirements.speed !== true || hasCapability(capabilities.capabilities, SPEED_PASSTHROUGH_CAPABILITY);
  if (!modelReady || !effortReady || !speedReady) {
    return { transport: "direct", reason: "passthrough-unavailable" };
  }
  return {
    transport: "bridge",
    reason: "passthrough-promoted",
    passthrough: {
      ...(requirements.model ? { model: true } : {}),
      ...(requirements.effort ? { effort: true } : {}),
      ...(requirements.speed === true ? { speed: true } : {}),
    },
  };
}

export async function probeExecutionCompatibility(
  deps: StageDepsWithExecutionPreflight,
  config: HachiConfig,
  resolution: Extract<ModelResolution, { ok: true }>,
  transport: Transport,
  overrides: ExecutionOverrideRequirements,
): Promise<ExecutionCompatibilityDecision> {
  const expectation = buildModelTransportRequirement(config, resolution, transport, overrides);
  const injectedProbe = deps.modelTransportPreflight;
  const probeResult = injectedProbe !== undefined
    ? await injectedProbe.probe(resolution.provider, transport)
    : transport === "bridge"
      ? await probeBridgeExecutionCapabilities(deps.env.bridges[resolution.provider], resolution.provider)
      : await probeDirectRuntimeCapabilities({ provider: resolution.provider });
  if (!probeResult.ok) {
    const detail = "detail" in probeResult ? probeResult.detail : probeResult.failure.detail;
    return {
      status: "unknown",
      reason: "capability-probe-failed",
      detail: redactRuntimeObservationText(detail),
      expectation,
      observed: null,
    };
  }
  return {
    ...evaluateModelTransportCompatibility(probeResult.snapshot, expectation),
    expectation,
    observed: probeResult.snapshot,
  };
}

export function hasRequiredNativeDelivery(
  ref: BridgeLaunchSessionRef,
  requirements: NativeDeliveryRequirements,
  requireAppliedValues = true,
): boolean {
  const stringConfirmed = (
    delivery: "native" | "none" | undefined,
    applied: string | undefined,
    requested: string,
  ): boolean => delivery === "native" && (
    !requireAppliedValues || (applied !== undefined && applied.trim() === requested.trim())
  );
  const modelConfirmed = requirements.model === undefined ||
    stringConfirmed(ref.modelDelivery, ref.appliedModel, requirements.model);
  const effortConfirmed = requirements.effort === undefined ||
    stringConfirmed(ref.effortDelivery, ref.appliedEffort, requirements.effort);
  const speedConfirmed = requirements.speed === undefined ||
    stringConfirmed(ref.speedDelivery, ref.appliedSpeed, requirements.speed);
  const maxTurnsConfirmed = ref.requestedMaxTurns === undefined || (
    ref.maxTurnsDelivery === "native" && (
      !requireAppliedValues ||
      (ref.appliedMaxTurns !== undefined && ref.appliedMaxTurns === ref.requestedMaxTurns)
    )
  );
  return (
    modelConfirmed &&
    effortConfirmed &&
    speedConfirmed &&
    maxTurnsConfirmed
  );
}
