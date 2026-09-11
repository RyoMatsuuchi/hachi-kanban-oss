import type {
  ExecutionCapabilitySnapshot,
  ModelTransportCompatibilityDecision,
  ModelTransportRequirement,
} from "./types.js";

interface SemverIdentifier {
  numeric: boolean;
  value: string;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly SemverIdentifier[];
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(value: string): Semver | null {
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return null;
  }
  const prerelease = match[4]?.split(".").map((identifier) => ({
    numeric: /^\d+$/.test(identifier),
    value: identifier,
  })) ?? [];
  return { major, minor, patch, prerelease };
}

/** config schemaとpure evaluatorが共有するstrict semver境界。 */
export function isStrictSemver(value: string): boolean {
  return parseSemver(value) !== null;
}

function compareSemver(left: Semver, right: Semver): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier.value === rightIdentifier.value) {
      continue;
    }
    if (leftIdentifier.numeric !== rightIdentifier.numeric) {
      return leftIdentifier.numeric ? -1 : 1;
    }
    if (leftIdentifier.numeric) {
      if (leftIdentifier.value.length !== rightIdentifier.value.length) {
        return leftIdentifier.value.length < rightIdentifier.value.length ? -1 : 1;
      }
      return leftIdentifier.value < rightIdentifier.value ? -1 : 1;
    }
    return leftIdentifier.value < rightIdentifier.value ? -1 : 1;
  }
  return 0;
}

function withPolicyId<T extends ModelTransportCompatibilityDecision>(
  decision: T,
  requirement: ModelTransportRequirement,
): T {
  if (requirement.policyId === undefined || decision.status === "unknown") {
    return decision;
  }
  return { ...decision, policyId: requirement.policyId };
}

/** contract §59.2 の provider 非依存・副作用なし互換判定。 */
export function evaluateModelTransportCompatibility(
  snapshot: ExecutionCapabilitySnapshot,
  requirement: ModelTransportRequirement,
): ModelTransportCompatibilityDecision {
  if (snapshot.provider !== requirement.provider) {
    return withPolicyId({
      status: "unsupported",
      reason: "provider-mismatch",
      detail: `required=${requirement.provider}, observed=${snapshot.provider}`,
    }, requirement);
  }
  if (snapshot.transport !== requirement.transport) {
    return withPolicyId({
      status: "unsupported",
      reason: "transport-mismatch",
      detail: `required=${requirement.transport}, observed=${snapshot.transport}`,
    }, requirement);
  }

  const advertisedCapabilities = new Set(snapshot.capabilities);
  const missingCapability = [...new Set(requirement.requiredCapabilities)]
    .sort()
    .find((capability) => !advertisedCapabilities.has(capability));
  if (missingCapability !== undefined) {
    return withPolicyId({
      status: "unsupported",
      reason: "required-capability-missing",
      detail: `missing capability=${missingCapability}`,
    }, requirement);
  }
  if (requirement.requestedEffort !== undefined) {
    const supportedEfforts = requirement.supportedEfforts;
    // 旧policyとの互換性は low..xhigh に限る。max は明示policyが無ければ対応不明のため拒否する。
    if (
      (supportedEfforts !== undefined && !supportedEfforts.includes(requirement.requestedEffort)) ||
      (requirement.requestedEffort === "max" && supportedEfforts === undefined)
    ) {
      return withPolicyId({
        status: "unsupported",
        reason: "effort-not-supported",
        detail: `requested effort=${requirement.requestedEffort} is not supported by the trusted policy`,
      }, requirement);
    }
  }
  if (
    requirement.requestedSpeed !== undefined &&
    !requirement.supportedSpeeds?.includes(requirement.requestedSpeed)
  ) {
    return withPolicyId({
      status: "unsupported",
      reason: "speed-not-supported",
      detail: `requested speed=${requirement.requestedSpeed} is not supported by the trusted policy`,
    }, requirement);
  }
  if (requirement.requireNativeModelDelivery && snapshot.delivery.model !== "native") {
    return withPolicyId({
      status: "unsupported",
      reason: "native-model-delivery-missing",
      detail: `observed model delivery=${snapshot.delivery.model}`,
    }, requirement);
  }
  if (requirement.requireNativeEffortDelivery && snapshot.delivery.effort !== "native") {
    return withPolicyId({
      status: "unsupported",
      reason: "native-effort-delivery-missing",
      detail: `observed effort delivery=${snapshot.delivery.effort}`,
    }, requirement);
  }
  if (requirement.requireNativeSpeedDelivery && snapshot.delivery.speed !== "native") {
    return withPolicyId({
      status: "unsupported",
      reason: "native-speed-delivery-missing",
      detail: `observed speed delivery=${snapshot.delivery.speed ?? "unknown"}`,
    }, requirement);
  }

  if (snapshot.modelCatalog.knowledge === "known") {
    if (!new Set(snapshot.modelCatalog.models).has(requirement.model)) {
      return withPolicyId({
        status: "unsupported",
        reason: "model-not-advertised",
        detail: `model=${requirement.model} is absent from advertised catalog`,
      }, requirement);
    }
    return withPolicyId({ status: "supported", evidence: "advertised-model" }, requirement);
  }

  if (requirement.minimumRuntimeVersion === undefined) {
    return requirement.policyId === undefined
      ? {
          status: "unknown",
          reason: "compatibility-policy-missing",
          detail: "model catalog is unknown and no minimum runtime version policy is configured",
        }
      : {
          status: "unknown",
          reason: "model-catalog-unknown",
          detail: snapshot.modelCatalog.detail,
        };
  }
  const minimumVersion = parseSemver(requirement.minimumRuntimeVersion);
  if (minimumVersion === null) {
    return {
      status: "unknown",
      reason: "compatibility-policy-missing",
      detail: "minimum runtime version policy is not strict semver",
    };
  }
  if (snapshot.runtime.version === null) {
    return {
      status: "unknown",
      reason: "runtime-version-unknown",
      detail: "runtime version was not observed",
    };
  }
  const runtimeVersion = parseSemver(snapshot.runtime.version);
  if (runtimeVersion === null) {
    return {
      status: "unknown",
      reason: "invalid-runtime-version",
      detail: "observed runtime version is not strict semver",
    };
  }
  if (compareSemver(runtimeVersion, minimumVersion) < 0) {
    return withPolicyId({
      status: "unsupported",
      reason: "runtime-version-too-old",
      detail: `runtime=${snapshot.runtime.version}, minimum=${requirement.minimumRuntimeVersion}`,
    }, requirement);
  }
  return withPolicyId({ status: "supported", evidence: "runtime-version-policy" }, requirement);
}
