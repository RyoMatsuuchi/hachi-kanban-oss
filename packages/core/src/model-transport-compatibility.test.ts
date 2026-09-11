import { describe, expect, it } from "vitest";
import type { ExecutionCapabilitySnapshot, ModelTransportRequirement } from "./types.js";
import { evaluateModelTransportCompatibility } from "./model-transport-compatibility.js";

function snapshot(overrides: Partial<ExecutionCapabilitySnapshot> = {}): ExecutionCapabilitySnapshot {
  return {
    schemaVersion: "execution-capability.v1",
    provider: "codex",
    transport: "direct",
    runtime: { name: "codex-cli", version: "1.2.3", source: "local-probe" },
    capabilities: ["model-selection-v1"],
    modelCatalog: { knowledge: "known", models: ["gpt-5.6"], source: "advertised" },
    delivery: { model: "native", effort: "native" },
    observedAt: 1,
    ...overrides,
  };
}

function requirement(overrides: Partial<ModelTransportRequirement> = {}): ModelTransportRequirement {
  return {
    provider: "codex",
    model: "gpt-5.6",
    transport: "direct",
    requiredCapabilities: [],
    requireNativeModelDelivery: false,
    requireNativeEffortDelivery: false,
    requireNativeSpeedDelivery: false,
    ...overrides,
  };
}

describe("evaluateModelTransportCompatibility", () => {
  it("明示catalogのmodel有無とknown emptyを判定する", () => {
    expect(evaluateModelTransportCompatibility(snapshot(), requirement())).toMatchObject({
      status: "supported", evidence: "advertised-model",
    });
    expect(evaluateModelTransportCompatibility(snapshot(), requirement({ model: "gpt-unknown" }))).toMatchObject({
      status: "unsupported", reason: "model-not-advertised",
    });
    expect(evaluateModelTransportCompatibility(snapshot({
      modelCatalog: { knowledge: "known", models: [], source: "advertised" },
    }), requirement())).toMatchObject({ status: "unsupported", reason: "model-not-advertised" });
  });

  it("unknown catalogは証拠が無ければunknownのまま返す", () => {
    expect(evaluateModelTransportCompatibility(snapshot({
      modelCatalog: { knowledge: "unknown", detail: "not advertised" },
    }), requirement())).toMatchObject({ status: "unknown", reason: "compatibility-policy-missing" });
  });

  it("strict semverの境界とprereleaseを比較する", () => {
    const unknownCatalog = { knowledge: "unknown" as const, detail: "not advertised" };
    const policy = requirement({ policyId: "codex-1", minimumRuntimeVersion: "1.2.3" });
    expect(evaluateModelTransportCompatibility(snapshot({ modelCatalog: unknownCatalog }), policy)).toMatchObject({
      status: "supported", evidence: "runtime-version-policy", policyId: "codex-1",
    });
    expect(evaluateModelTransportCompatibility(snapshot({
      runtime: { name: "codex-cli", version: "1.2.3-beta.1", source: "local-probe" },
      modelCatalog: unknownCatalog,
    }), policy)).toMatchObject({ status: "unsupported", reason: "runtime-version-too-old" });
    expect(evaluateModelTransportCompatibility(snapshot({
      runtime: { name: "codex-cli", version: "1.2", source: "local-probe" },
      modelCatalog: unknownCatalog,
    }), policy)).toMatchObject({ status: "unknown", reason: "invalid-runtime-version" });
  });

  it("明示catalogはversion policyとの矛盾時も優先する", () => {
    expect(evaluateModelTransportCompatibility(snapshot({
      runtime: { name: "codex-cli", version: "0.1.0", source: "local-probe" },
    }), requirement({ minimumRuntimeVersion: "9.0.0" }))).toMatchObject({
      status: "supported", evidence: "advertised-model",
    });
  });

  it("provider/transport/capability/native delivery不足を先に拒否する", () => {
    expect(evaluateModelTransportCompatibility(snapshot({ provider: "claude" }), requirement())).toMatchObject({
      status: "unsupported", reason: "provider-mismatch",
    });
    expect(evaluateModelTransportCompatibility(snapshot({ transport: "bridge" }), requirement())).toMatchObject({
      status: "unsupported", reason: "transport-mismatch",
    });
    expect(evaluateModelTransportCompatibility(snapshot(), requirement({
      requiredCapabilities: ["z-v1", "z-v1"],
    }))).toMatchObject({ status: "unsupported", reason: "required-capability-missing" });
    expect(evaluateModelTransportCompatibility(snapshot({ delivery: { model: "none", effort: "native" } }), requirement({
      requireNativeModelDelivery: true,
    }))).toMatchObject({ status: "unsupported", reason: "native-model-delivery-missing" });
    expect(evaluateModelTransportCompatibility(snapshot({ delivery: { model: "native", effort: "unknown" } }), requirement({
      requireNativeEffortDelivery: true,
    }))).toMatchObject({ status: "unsupported", reason: "native-effort-delivery-missing" });
    expect(evaluateModelTransportCompatibility(snapshot({
      delivery: { model: "native", effort: "native", speed: "unknown" },
    }), requirement({
      requireNativeSpeedDelivery: true,
    }))).toMatchObject({ status: "unsupported", reason: "native-speed-delivery-missing" });
  });

  it("maxとspeedはtrusted policyの明示対応が無ければfail-closedで拒否する", () => {
    expect(evaluateModelTransportCompatibility(snapshot(), requirement({
      requestedEffort: "max",
    }))).toMatchObject({ status: "unsupported", reason: "effort-not-supported" });
    expect(evaluateModelTransportCompatibility(snapshot(), requirement({
      requestedSpeed: "fast",
    }))).toMatchObject({ status: "unsupported", reason: "speed-not-supported" });
  });

  it("Sol directは明示standardだけを許可し、fastと速度省略を区別する", () => {
    const solSnapshot = snapshot({
      modelCatalog: { knowledge: "known", models: ["gpt-5.6-sol"], source: "advertised" },
      delivery: { model: "native", effort: "native", speed: "native" },
    });
    const solStandard = requirement({
      model: "gpt-5.6-sol",
      requestedSpeed: "standard",
      supportedSpeeds: ["standard"],
      requireNativeSpeedDelivery: true,
    });
    expect(evaluateModelTransportCompatibility(solSnapshot, solStandard)).toMatchObject({
      status: "supported", evidence: "advertised-model",
    });
    expect(evaluateModelTransportCompatibility(solSnapshot, {
      ...solStandard,
      requestedSpeed: "fast",
    })).toMatchObject({ status: "unsupported", reason: "speed-not-supported" });
    expect(evaluateModelTransportCompatibility(snapshot({
      modelCatalog: { knowledge: "known", models: ["gpt-5.6-sol"], source: "advertised" },
      delivery: { model: "native", effort: "native" },
    }), requirement({ model: "gpt-5.6-sol" }))).toMatchObject({
      status: "supported", evidence: "advertised-model",
    });
  });

  it("Luna directは明示standardとfastをともに許可する", () => {
    const lunaSnapshot = snapshot({
      modelCatalog: { knowledge: "known", models: ["gpt-5.6-luna"], source: "advertised" },
      delivery: { model: "native", effort: "native", speed: "native" },
    });
    for (const speed of ["standard", "fast"] as const) {
      expect(evaluateModelTransportCompatibility(lunaSnapshot, requirement({
        model: "gpt-5.6-luna",
        requestedSpeed: speed,
        supportedSpeeds: ["standard", "fast"],
        requireNativeSpeedDelivery: true,
      }))).toMatchObject({ status: "supported", evidence: "advertised-model" });
    }
  });

  it("trusted policyとruntime deliveryが揃ったmax/fastだけを許可する", () => {
    const maxFast = requirement({
      policyId: "codex-max-fast",
      requestedEffort: "max",
      requestedSpeed: "fast",
      supportedEfforts: ["max"],
      supportedSpeeds: ["fast"],
      requireNativeEffortDelivery: true,
      requireNativeSpeedDelivery: true,
    });
    expect(evaluateModelTransportCompatibility(snapshot({
      delivery: { model: "native", effort: "native", speed: "native" },
    }), maxFast)).toMatchObject({ status: "supported", policyId: "codex-max-fast" });
    expect(evaluateModelTransportCompatibility(snapshot({
      delivery: { model: "native", effort: "none", speed: "native" },
    }), maxFast)).toMatchObject({ status: "unsupported", reason: "native-effort-delivery-missing" });
  });

  it("旧policyとの互換性としてlow..xhighはsupportedEfforts欠落時もruntime deliveryで判定する", () => {
    expect(evaluateModelTransportCompatibility(snapshot(), requirement({
      requestedEffort: "high",
      requireNativeEffortDelivery: true,
    }))).toMatchObject({ status: "supported" });
  });

  it.each(["codex", "claude"] as const)("%sでtransportに依らず同じmodel判定語彙を返す", (provider) => {
    for (const transport of ["direct", "bridge"] as const) {
      expect(evaluateModelTransportCompatibility(
        snapshot({ provider, transport }),
        requirement({ provider, transport }),
      )).toMatchObject({ status: "supported", evidence: "advertised-model" });
    }
  });
});
