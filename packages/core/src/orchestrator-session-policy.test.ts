import { describe, expect, it } from "vitest";
import {
  assertOrchestratorSessionHeartbeatPolicy,
  ORCHESTRATOR_AWAIT_HEARTBEAT_INTERVAL_SECONDS,
  ORCHESTRATOR_SESSION_STALE_SECONDS,
} from "./orchestrator-session-policy.js";

describe("orchestrator session heartbeat policy", () => {
  it("既定heartbeat間隔はstale TTL未満である", () => {
    expect(ORCHESTRATOR_AWAIT_HEARTBEAT_INTERVAL_SECONDS).toBeLessThan(ORCHESTRATOR_SESSION_STALE_SECONDS);
    expect(() => assertOrchestratorSessionHeartbeatPolicy()).not.toThrow();
  });

  it.each([
    [0, 1],
    [90, 0],
    [90, 90],
    [90, 91],
    [90.5, 30],
  ])("不正またはTTL以上の間隔をfail-closedで拒否する (%s, %s)", (staleSeconds, intervalSeconds) => {
    expect(() => assertOrchestratorSessionHeartbeatPolicy(staleSeconds, intervalSeconds)).toThrow();
  });
});
