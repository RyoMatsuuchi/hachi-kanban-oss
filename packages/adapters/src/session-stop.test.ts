import { beforeEach, describe, expect, it } from "vitest";
import type { BridgeConfig, ExactSessionStopInput, SessionRef } from "@hachi/core";
import type { BridgeCapabilitiesResult } from "./http.js";
import {
  ExactSessionStopFacade,
  FakeExactSessionStopTransport,
  probeSessionStopCapability,
} from "./session-stop.js";

describe("session-stop-v1 facade/fake", () => {
  let bridge: BridgeConfig;
  let advertisedCapabilities: readonly string[];
  let probeFailure: boolean;
  let probeThrows: boolean;
  let infoRequestCount: number;

  beforeEach(() => {
    advertisedCapabilities = ["session-stop-v1"];
    probeFailure = false;
    probeThrows = false;
    infoRequestCount = 0;
    bridge = {
      url: "http://127.0.0.1:1",
      tokenFile: "/unused/session-stop-test-token",
    };
  });

  async function probeCapabilities(): Promise<BridgeCapabilitiesResult> {
    infoRequestCount += 1;
    if (probeThrows) {
      throw new Error("fixture probe exception");
    }
    if (probeFailure) {
      return {
        ok: false,
        provider: "codex",
        failure: { kind: "http", detail: "fixture failure", status: 503 },
      };
    }
    return { ok: true, provider: "codex", capabilities: advertisedCapabilities };
  }

  function facade(fake: FakeExactSessionStopTransport): ExactSessionStopFacade {
    return new ExactSessionStopFacade(bridge, fake, { probeCapabilities });
  }

  function ref(sessionId: string): SessionRef {
    return {
      provider: "codex",
      sessionId,
      serverUrl: bridge.url,
      model: "gpt-5.4",
      modelDelivery: "none",
      startedAt: 1,
    };
  }

  function input(
    sessionId: string,
    overrides: Partial<ExactSessionStopInput> = {},
  ): ExactSessionStopInput {
    return {
      requestNonce: "cancel-nonce-1",
      expectedRunId: 101,
      expectedSessionId: sessionId,
      ...overrides,
    };
  }

  function registeredFake(): FakeExactSessionStopTransport {
    const fake = new FakeExactSessionStopTransport(true);
    fake.registerSession({
      provider: "codex",
      sessionId: "session-target",
      runId: 101,
      requestNonce: "cancel-nonce-1",
    });
    fake.registerSession({
      provider: "codex",
      sessionId: "session-other",
      runId: 202,
      requestNonce: "cancel-nonce-2",
    });
    return fake;
  }

  describe("capability probe", () => {
    it("広告と exact transport が揃う場合だけ session-stop-v1 を返す", async () => {
      const result = await probeSessionStopCapability(bridge, registeredFake(), { probeCapabilities });

      expect(result).toEqual({
        protocol: "session-stop-v1",
        exactSession: true,
        childProcessTree: true,
      });
      expect(infoRequestCount).toBe(1);
    });

    it("capability 未広告は unsupported として pending 維持可能な構造を返す", async () => {
      advertisedCapabilities = [];

      await expect(
        probeSessionStopCapability(bridge, registeredFake(), { probeCapabilities }),
      ).resolves.toEqual({
        protocol: "unsupported",
        exactSession: false,
        childProcessTree: false,
      });
    });

    it("probe 失敗・未知 protocol・transport 不在は fail-closed で unsupported", async () => {
      probeFailure = true;
      await expect(
        probeSessionStopCapability(bridge, registeredFake(), { probeCapabilities }),
      ).resolves.toMatchObject({
        protocol: "unsupported",
      });

      probeFailure = false;
      advertisedCapabilities = ["session-stop-v999"];
      await expect(
        probeSessionStopCapability(bridge, registeredFake(), { probeCapabilities }),
      ).resolves.toMatchObject({
        protocol: "unsupported",
      });

      probeThrows = true;
      await expect(
        probeSessionStopCapability(bridge, registeredFake(), { probeCapabilities }),
      ).resolves.toMatchObject({ protocol: "unsupported" });
      probeThrows = false;

      infoRequestCount = 0;
      await expect(probeSessionStopCapability(bridge, undefined, { probeCapabilities })).resolves.toMatchObject({
        protocol: "unsupported",
      });
      expect(infoRequestCount).toBe(0);
    });
  });

  describe("exact-session stop", () => {
    it("対象 session だけを停止し、別 session は active のまま維持する", async () => {
      const fake = registeredFake();
      const stopFacade = facade(fake);

      const result = await stopFacade.stopExact(ref("session-target"), input("session-target"));

      expect(result).toMatchObject({
        state: "stopped",
        observedSessionState: "ended",
        childProcessTreeCovered: true,
      });
      expect(fake.sessionState("session-target")).toBe("stopped");
      expect(fake.sessionState("session-other")).toBe("active");
      expect(fake.requests).toEqual([
        {
          provider: "codex",
          sessionId: "session-target",
          requestNonce: "cancel-nonce-1",
          expectedRunId: 101,
        },
      ]);
    });

    it("ref と expected session が不一致なら probe/transport を呼ばず rejected", async () => {
      const fake = registeredFake();
      const stopFacade = facade(fake);

      await expect(
        stopFacade.stopExact(ref("session-target"), input("session-other")),
      ).resolves.toMatchObject({ state: "rejected", evidenceId: "adapter:session-mismatch" });
      expect(fake.requests).toEqual([]);
      expect(infoRequestCount).toBe(0);
      expect(fake.sessionState("session-target")).toBe("active");
      expect(fake.sessionState("session-other")).toBe("active");
    });

    it.each([
      ["run", { expectedRunId: 999 }],
      ["request nonce", { requestNonce: "wrong-nonce" }],
    ])("expected %s fence 不一致は rejected で mutation 0", async (_label, overrides) => {
      const fake = registeredFake();
      const stopFacade = facade(fake);

      const result = await stopFacade.stopExact(ref("session-target"), input("session-target", overrides));

      expect(result).toMatchObject({ state: "rejected", evidenceId: "fake:fence-mismatch" });
      expect(fake.sessionState("session-target")).toBe("active");
      expect(fake.sessionState("session-other")).toBe("active");
    });

    it("capability 不在なら transport を呼ばず unsupported を返す", async () => {
      advertisedCapabilities = [];
      const fake = registeredFake();
      const stopFacade = facade(fake);

      await expect(
        stopFacade.stopExact(ref("session-target"), input("session-target")),
      ).resolves.toMatchObject({
        state: "unsupported",
        evidenceId: "adapter:session-stop-unsupported",
      });
      expect(fake.requests).toEqual([]);
      expect(fake.sessionState("session-target")).toBe("active");
    });

    it.each([
      ["reject", "rejected", "fake:stop-rejected"],
      ["timeout", "unknown", "adapter:stop-transport-failure"],
      ["missing-response", "unknown", "adapter:stop-response-missing"],
    ] as const)("transport %s を構造化された %s として返す", async (mode, state, evidenceId) => {
      const fake = registeredFake();
      fake.setMode(mode);
      const stopFacade = facade(fake);

      const result = await stopFacade.stopExact(ref("session-target"), input("session-target"));

      expect(result).toMatchObject({ state, evidenceId });
      expect(fake.sessionState("session-target")).toBe("active");
      expect(fake.sessionState("session-other")).toBe("active");
    });

    it("同じ fence で二度停止すると already-stopped を返す", async () => {
      const fake = registeredFake();
      const stopFacade = facade(fake);

      await expect(stopFacade.stopExact(ref("session-target"), input("session-target"))).resolves.toMatchObject({
        state: "stopped",
      });
      await expect(stopFacade.stopExact(ref("session-target"), input("session-target"))).resolves.toMatchObject({
        state: "already-stopped",
        observedSessionState: "ended",
      });
      expect(fake.sessionState("session-other")).toBe("active");
    });
  });
});
