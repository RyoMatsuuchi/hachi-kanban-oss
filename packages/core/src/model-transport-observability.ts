import type {
  HachiConfig,
  ModelResolution,
  ModelTransportRequirement,
  Transport,
} from "./types.js";
import { redactText } from "./redaction.js";

export interface ModelTransportNativeRequirements {
  model: boolean;
  effort: boolean;
  speed?: boolean;
  /** bridge adapter が maxTurns を送る起動構成だけ true。 */
  maxTurns?: boolean;
}

export const MAX_TURNS_PASSTHROUGH_CAPABILITY = "max-turns-passthrough-v1";

/** runtime probe 診断から credential に加えて host の絶対 path も除く。 */
export function redactRuntimeObservationText(value: string): string {
  // POSIX path は空白を含み得るため segment の文字集合で終端を推測しない。引用符内なら
  // 対応する文字列終端まで、非引用なら行末までを安全側に広くマスクする。
  return redactText(value).replace(
    /(^|[\s"'=(])\/[^"'\\\r\n]*/g,
    (_match: string, prefix: string): string => `${prefix}[REDACTED_PATH]`,
  );
}

/** dispatch / CLI の観測面で共有する trusted requirement 組み立て。 */
export function buildModelTransportRequirement(
  config: HachiConfig,
  resolution: Extract<ModelResolution, { ok: true }>,
  transport: Transport,
  nativeRequirements: ModelTransportNativeRequirements,
): ModelTransportRequirement {
  const policy = config.modelTransportPolicies?.find((candidate) =>
    candidate.provider === resolution.provider &&
    candidate.model === resolution.model &&
    candidate.transport === transport);
  return {
    provider: resolution.provider,
    model: resolution.model,
    transport,
    ...(resolution.effort === undefined ? {} : { requestedEffort: resolution.effort }),
    ...(resolution.speed === undefined ? {} : { requestedSpeed: resolution.speed }),
    requiredCapabilities: nativeRequirements.maxTurns === true
      ? [MAX_TURNS_PASSTHROUGH_CAPABILITY]
      : [],
    requireNativeModelDelivery: transport === "direct" || nativeRequirements.model,
    // profile由来も含め、指定値をruntimeへ運べなければ起動しない。省略時だけruntime defaultへ委譲する。
    requireNativeEffortDelivery: resolution.effort !== undefined,
    requireNativeSpeedDelivery: resolution.speed !== undefined,
    ...(policy === undefined ? {} : {
      policyId: policy.id,
      minimumRuntimeVersion: policy.minimumRuntimeVersion,
      ...(policy.supportedEfforts === undefined ? {} : { supportedEfforts: policy.supportedEfforts }),
      ...(policy.supportedSpeeds === undefined ? {} : { supportedSpeeds: policy.supportedSpeeds }),
    }),
  };
}
