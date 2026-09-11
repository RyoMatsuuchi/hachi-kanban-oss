import { describe, expect, it } from "vitest";
import type { EventRow, RunCancelRequestRow } from "./types.js";
import {
  hasExactCancelStopEvidence,
  redactCancelEvent,
  sortCancelRequestsDescending,
  summarizeCancelRequest,
} from "./cancel-observability.js";

function request(overrides: Partial<RunCancelRequestRow> = {}): RunCancelRequestRow {
  return {
    id: "rc_default",
    taskId: "t_0000000000000001",
    runId: 10,
    sessionId: "worker-session",
    provider: "codex",
    status: "stopped",
    requestNonce: "secret-request-nonce",
    actor: "orchestrator",
    reason: "停止",
    orchestratorId: "o_owner",
    requesterSessionId: "os_owner",
    requesterGeneration: 3,
    cancelFence: 1,
    deadlineAt: 1_700_000_060,
    acknowledgedNonce: "",
    capabilitySnapshot: "{}",
    stopEvidence: JSON.stringify({
      source: "natural",
      observedSessionState: "ended",
      resultWatermark: 1,
      lastEntryId: 42,
    }),
    lastError: "",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_010,
    resolvedAt: 1_700_000_010,
    ...overrides,
  };
}

describe("cancel observability", () => {
  it("natural/forced/host-process-generationの厳格shapeだけをexact stopped evidenceとして肯定する", () => {
    expect(hasExactCancelStopEvidence(request())).toBe(true);
    expect(hasExactCancelStopEvidence(request({
      stopEvidence: JSON.stringify({
        source: "forced",
        observedSessionState: "idle",
        resultWatermark: 0,
        lastEntryId: 0,
        stopState: "already-stopped",
        evidenceId: "direct:already-exited",
        childProcessTreeCovered: true,
      }),
    }))).toBe(true);
    const host = request({
      stopEvidence: JSON.stringify({
        source: "host-process-generation",
        evidenceId: "launchctl:bootout:ok",
        processGeneration: "launchctl:pid-94017",
        serverUrl: "http://127.0.0.1:3456",
        provider: "codex",
        sessionId: "worker-session",
        runId: 10,
        cancelFence: 1,
        childProcessTreeCovered: true,
        attestedBy: { orchestratorId: "o_owner", sessionId: "os_takeover", generation: 4 },
      }),
    });
    expect(hasExactCancelStopEvidence(host)).toBe(true);
    expect(summarizeCancelRequest(host).stopped).toBe("yes");
  });

  it.each([
    {},
    [],
    { source: "cooperative", observedSessionState: "ended", resultWatermark: 1, lastEntryId: 1 },
    { source: "natural", sessionState: "ended", resultWatermark: 1, lastEntryId: 1 },
    { source: "natural", observedSessionState: "unknown", resultWatermark: 1, lastEntryId: 1 },
    { source: "natural", observedSessionState: "ended", resultWatermark: -1, lastEntryId: 1 },
    { source: "natural", observedSessionState: "ended", resultWatermark: 1 },
    {
      source: "forced", observedSessionState: "ended", resultWatermark: 1, lastEntryId: 1,
      stopState: "unknown", evidenceId: "e", childProcessTreeCovered: true,
    },
    {
      source: "forced", observedSessionState: "ended", resultWatermark: 1, lastEntryId: 1,
      stopState: "stopped", evidenceId: "", childProcessTreeCovered: true,
    },
    {
      source: "forced", observedSessionState: "ended", resultWatermark: 1, lastEntryId: 1,
      stopState: "stopped", evidenceId: "e",
    },
    {
      source: "host-process-generation", evidenceId: "host:e", processGeneration: "generation:1",
      serverUrl: "http://127.0.0.1:3456", provider: "codex", sessionId: "worker-session", runId: 10,
      cancelFence: 1, childProcessTreeCovered: true,
      attestedBy: { orchestratorId: "o_other", sessionId: "os_owner", generation: 3 },
    },
    {
      source: "host-process-generation", evidenceId: "host:e", processGeneration: "generation:1",
      serverUrl: "file:///tmp/bridge", provider: "codex", sessionId: "worker-session", runId: 10,
      cancelFence: 1, childProcessTreeCovered: true,
      attestedBy: { orchestratorId: "o_owner", sessionId: "os_owner", generation: 3 },
    },
    {
      source: "host-process-generation", evidenceId: "Authorization:Bearer:secret", processGeneration: "generation:1",
      serverUrl: "http://127.0.0.1:3456", provider: "codex", sessionId: "worker-session", runId: 10,
      cancelFence: 1, childProcessTreeCovered: true,
      attestedBy: { orchestratorId: "o_owner", sessionId: "os_owner", generation: 3 },
    },
  ])("不完全・未知stop evidence %# はunknownへ倒す", (evidence) => {
    const row = request({ stopEvidence: JSON.stringify(evidence) });
    expect(hasExactCancelStopEvidence(row)).toBe(false);
    expect(summarizeCancelRequest(row).stopped).toBe("unknown");
  });

  it("深いJSON・Bearer/token・空白を含むabsolute pathを全surface向けにredactする", () => {
    const secret = {
      outer: {
        nested: [
          "Authorization: Bearer bearer-secret-value",
          "token=plain-secret-token",
          "/Users/private/Application Support/cancel/runtime-token suffix",
        ],
      },
    };
    const row = request({
      reason: "Authorization: Bearer reason-secret /Users/private/My Project/reason.txt suffix",
      capabilitySnapshot: JSON.stringify(secret),
      stopEvidence: JSON.stringify(secret),
      lastError: "token=error-secret /private/tmp/My Folder/error.log suffix",
    });
    const summary = summarizeCancelRequest(row);
    const serialized = JSON.stringify(summary);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("[REDACTED_PATH]");
    expect(serialized).not.toContain("bearer-secret-value");
    expect(serialized).not.toContain("plain-secret-token");
    expect(serialized).not.toContain("runtime-token");
    expect(serialized).not.toContain("reason.txt");
    expect(serialized).not.toContain("error.log");

    const event: EventRow = {
      id: 1,
      taskId: row.taskId,
      eventType: "cancel_failed",
      actor: "supervisor",
      payload: JSON.stringify(secret),
      provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
      createdAt: row.createdAt,
    };
    const payload = redactCancelEvent(event).payload;
    expect(payload).toContain("[REDACTED]");
    expect(payload).toContain("[REDACTED_PATH]");
    expect(payload).not.toContain("runtime-token");
  });

  it("cancelFence最大・降順を正本とし同秒random id順へ依存しない", () => {
    const rows = [
      request({ id: "rc_z_random", runId: 10, cancelFence: 1, createdAt: 100, updatedAt: 100 }),
      request({ id: "rc_a_random", runId: 10, cancelFence: 3, createdAt: 100, updatedAt: 100 }),
      request({ id: "rc_m_random", runId: 10, cancelFence: 2, createdAt: 100, updatedAt: 100 }),
      request({ id: "rc_0_random", runId: 11, cancelFence: 2, createdAt: 100, updatedAt: 100 }),
    ];
    expect(sortCancelRequestsDescending(rows).map((row) => row.id)).toEqual([
      "rc_a_random",
      "rc_0_random",
      "rc_m_random",
      "rc_z_random",
    ]);
  });
});
