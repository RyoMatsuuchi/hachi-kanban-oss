import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchSession, type BridgeLaunchSessionRef } from "@hachi/adapters";
import type { BridgeConfig } from "@hachi/core";
import { makeTempHome, MockBridgeServer, type TempHome } from "@hachi/testing";
import {
  hasRequiredNativeDelivery,
  type NativeDeliveryRequirements,
} from "./execution-preflight.js";

type NativeField = "model" | "effort" | "speed" | "maxTurns";

const NATIVE_FIELDS: readonly NativeField[] = ["model", "effort", "speed", "maxTurns"];
const STRING_NATIVE_FIELDS: readonly Exclude<NativeField, "maxTurns">[] = ["model", "effort", "speed"];

describe("hasRequiredNativeDelivery applied 一致判定", () => {
  let home: TempHome;
  let server: MockBridgeServer;
  let bridge: BridgeConfig;

  beforeEach(async () => {
    home = makeTempHome();
    server = new MockBridgeServer({ token: "mock-codex-token", passthroughMode: "native" });
    await server.start();
    bridge = { url: server.url, tokenFile: home.env.bridges.codex.tokenFile };
  });

  afterEach(async () => {
    await server.close();
    home.cleanup();
  });

  function requirementsFor(field: NativeField): NativeDeliveryRequirements {
    switch (field) {
      case "model":
        return { model: "claude-opus-5" };
      case "effort":
        return { effort: "low" };
      case "speed":
        return { speed: "fast" };
      case "maxTurns":
        return {};
    }
  }

  function requestedValueFor(field: NativeField): string | number {
    switch (field) {
      case "model":
        return "claude-opus-5";
      case "effort":
        return "low";
      case "speed":
        return "fast";
      case "maxTurns":
        return 1000;
    }
  }

  function mismatchedValueFor(field: NativeField): string | number {
    switch (field) {
      case "model":
        return "claude-sonnet-5";
      case "effort":
        return "high";
      case "speed":
        return "standard";
      case "maxTurns":
        return 50;
    }
  }

  async function launchFor(field: NativeField): Promise<BridgeLaunchSessionRef> {
    switch (field) {
      case "model":
        return launchSession(bridge, "claude", {
          model: "claude-opus-5", cwd: "/work", promptText: "x",
        }, { passthrough: { model: true } });
      case "effort":
        return launchSession(bridge, "codex", {
          model: "gpt-5.6-sol", cwd: "/work", promptText: "x", effort: "low",
        }, { passthrough: { effort: true } });
      case "speed":
        return launchSession(bridge, "codex", {
          model: "gpt-5.6-sol", cwd: "/work", promptText: "x", speed: "fast",
        }, { passthrough: { speed: true } });
      case "maxTurns":
        return launchSession(bridge, "claude", {
          model: "claude-opus-5", cwd: "/work", promptText: "x",
        }, { maxTurns: 1000 });
    }
  }

  it.each(NATIVE_FIELDS)("%s: applied 欠落は native 確認欠落にする", async (field) => {
    server.setAppliedResponse(field, { kind: "omit" });

    const ref = await launchFor(field);

    expect(hasRequiredNativeDelivery(ref, requirementsFor(field))).toBe(false);
  });

  it.each(NATIVE_FIELDS)("%s: applied null は native 確認欠落にする", async (field) => {
    server.setAppliedResponse(field, { kind: "null" });

    const ref = await launchFor(field);

    expect(hasRequiredNativeDelivery(ref, requirementsFor(field))).toBe(false);
  });

  it.each(NATIVE_FIELDS)("%s: applied 不一致は native 確認欠落にする", async (field) => {
    server.setAppliedResponse(field, { kind: "value", value: mismatchedValueFor(field) });

    const ref = await launchFor(field);

    expect(hasRequiredNativeDelivery(ref, requirementsFor(field))).toBe(false);
  });

  it.each(NATIVE_FIELDS)("%s: applied 一致は native 確認を通過する", async (field) => {
    server.setAppliedResponse(field, { kind: "value", value: requestedValueFor(field) });

    const ref = await launchFor(field);

    expect(hasRequiredNativeDelivery(ref, requirementsFor(field))).toBe(true);
  });

  it.each(STRING_NATIVE_FIELDS)("%s: applied の前後空白だけが違う場合は一致とみなす", async (field) => {
    server.setAppliedResponse(field, { kind: "value", value: `  ${requestedValueFor(field)}  ` });

    const ref = await launchFor(field);

    expect(hasRequiredNativeDelivery(ref, requirementsFor(field))).toBe(true);
  });

  it("codex が maxTurns を送り始めても appliedMaxTurns 欠落を検査し fail-closed にする", async () => {
    server.setAppliedResponse("maxTurns", { kind: "omit" });
    const ref = await launchSession(bridge, "codex", {
      model: "gpt-5.6-sol", cwd: "/work", promptText: "x",
    }, {
      passthrough: { model: true },
      maxTurns: 1000,
    });

    expect(hasRequiredNativeDelivery(ref, { model: "gpt-5.6-sol" })).toBe(false);
    expect(ref.requestedMaxTurns).toBe(1000);
    expect(ref.maxTurnsDelivery).toBe("native");
  });

  it("direct 相当の ref（applied 無し）は requireAppliedValues=false で通る", () => {
    const ref: BridgeLaunchSessionRef = {
      provider: "codex",
      sessionId: "direct-no-applied",
      serverUrl: "direct",
      model: "gpt-5.6-sol",
      modelDelivery: "native",
      startedAt: 1_800_000_000,
    };

    expect(hasRequiredNativeDelivery(ref, { model: "gpt-5.6-sol" }, false)).toBe(true);
  });
});
