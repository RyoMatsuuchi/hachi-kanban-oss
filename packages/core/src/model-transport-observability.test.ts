import { describe, expect, it } from "vitest";
import type { HachiConfig } from "./types.js";
import {
  buildModelTransportRequirement,
  MAX_TURNS_PASSTHROUGH_CAPABILITY,
  redactRuntimeObservationText,
} from "./model-transport-observability.js";

describe("redactRuntimeObservationText", () => {
  it("空白を含む引用付きPOSIX絶対pathをsuffixごとredactする", () => {
    const result = redactRuntimeObservationText(
      "ENOENT: open '/Users/private/Library/Application Support/hachi/runtime token.json': failed",
    );

    expect(result).toBe("ENOENT: open '[REDACTED_PATH]': failed");
    expect(result).not.toContain("Application Support");
    expect(result).not.toContain("runtime token.json");
  });

  it("終端が曖昧な非引用POSIX絶対pathは行末まで安全側にredactする", () => {
    const result = redactRuntimeObservationText(
      "open /Users/private/My Project/runtime-token failed\nnext detail",
    );

    expect(result).toBe("open [REDACTED_PATH]\nnext detail");
    expect(result).not.toContain("Project/runtime-token");
  });

  it("JSON文字列内のpathをredactしてもJSON構造を壊さない", () => {
    const raw = JSON.stringify({ detail: "open /Users/private/My Project/runtime-token failed" });
    const result = redactRuntimeObservationText(raw);

    expect(() => JSON.parse(result) as unknown).not.toThrow();
    expect(result).toContain("[REDACTED_PATH]");
    expect(result).not.toContain("Project/runtime-token");
  });
});

describe("buildModelTransportRequirement", () => {
  it("解決値とtrusted policyのmax/fast対応をruntime検証要件へ保持する", () => {
    const config: HachiConfig = {
      profiles: { implement: { provider: "codex", model: "gpt-5.6-luna" } },
      allowlist: { codex: ["gpt-5.6-luna"], claude: [] },
      modelTransportPolicies: [{
        id: "codex-max-fast",
        provider: "codex",
        model: "gpt-5.6-luna",
        transport: "direct",
        minimumRuntimeVersion: "0.144.1",
        supportedEfforts: ["max"],
        supportedSpeeds: ["fast"],
      }],
      resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
      defaultProfile: "implement",
    };

    expect(buildModelTransportRequirement(config, {
      ok: true,
      provider: "codex",
      model: "gpt-5.6-luna",
      source: "override",
      transport: "direct",
      effort: "max",
      speed: "fast",
    }, "direct", { model: true, effort: true, speed: true })).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
      transport: "direct",
      requestedEffort: "max",
      requestedSpeed: "fast",
      requiredCapabilities: [],
      requireNativeModelDelivery: true,
      requireNativeEffortDelivery: true,
      requireNativeSpeedDelivery: true,
      policyId: "codex-max-fast",
      minimumRuntimeVersion: "0.144.1",
      supportedEfforts: ["max"],
      supportedSpeeds: ["fast"],
    });
  });

  it("effort/speed未指定ならruntime defaultへ委譲し配送を要求しない", () => {
    const config: HachiConfig = {
      profiles: { implement: { provider: "codex", model: "gpt-5.4" } },
      allowlist: { codex: ["gpt-5.4"], claude: [] },
      resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
      defaultProfile: "implement",
    };

    expect(buildModelTransportRequirement(config, {
      ok: true,
      provider: "codex",
      model: "gpt-5.4",
      source: "default",
      transport: "bridge",
    }, "bridge", { model: false, effort: false })).toMatchObject({
      requireNativeEffortDelivery: false,
      requireNativeSpeedDelivery: false,
    });
  });

  it("maxTurns を送る bridge 構成だけ capability を事前要件にする", () => {
    const config: HachiConfig = {
      profiles: { plan: { provider: "claude", model: "claude-opus-4-6" } },
      allowlist: { codex: [], claude: ["claude-opus-4-6"] },
      resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
      defaultProfile: "plan",
    };
    const resolution = {
      ok: true,
      provider: "claude",
      model: "claude-opus-4-6",
      source: "default",
      transport: "bridge",
    } as const;

    expect(buildModelTransportRequirement(
      config,
      resolution,
      "bridge",
      { model: true, effort: false, maxTurns: true },
    ).requiredCapabilities).toEqual([MAX_TURNS_PASSTHROUGH_CAPABILITY]);
    expect(buildModelTransportRequirement(
      config,
      resolution,
      "bridge",
      { model: true, effort: false },
    ).requiredCapabilities).toEqual([]);
  });
});
