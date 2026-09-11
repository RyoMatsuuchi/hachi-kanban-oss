import { describe, expect, it } from "vitest";
import { classifyDoneSignal, deriveDoneOrigin, summarizeDoneOrigins } from "./done-origin.js";
import type { ActorProvenance, EventRow } from "./types.js";

const UNKNOWN: ActorProvenance = { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null };

function event(
  eventType: string,
  payload: Record<string, unknown>,
  provenance: ActorProvenance = UNKNOWN,
  actor = "untrusted-display",
): EventRow {
  return {
    id: 1,
    taskId: "t_0000000000000001",
    eventType,
    actor,
    payload: JSON.stringify(payload),
    provenance,
    createdAt: 100,
  };
}

describe("done origin read model", () => {
  it("direct/reviewの完全なgate eventだけをgate_passedにする", () => {
    expect(deriveDoneOrigin([
      event("finalized", { from: "blocked", to: "done", outcome: "done", sessionId: "sess-1" }),
    ])).toBe("gate_passed");
    expect(deriveDoneOrigin([
      event("verdict_finalized", {
        from: "review",
        to: "done",
        verdict: "pass",
        confidence: "high",
        sessionId: "review-1",
      }),
    ])).toBe("gate_passed");
  });

  it("構造化human/orchestrator provenanceでmanual originを分け、表示actorを無視する", () => {
    expect(deriveDoneOrigin([
      event("status_changed", { from: "todo", to: "done" }, {
        kind: "human",
        actorId: "local-human",
        actorSessionId: "",
        actorGeneration: null,
      }, "orchestrator"),
    ])).toBe("human_decision");
    expect(deriveDoneOrigin([
      event("status_changed", { from: "todo", to: "done" }, {
        kind: "orchestrator",
        actorId: "o_1",
        actorSessionId: "os_1",
        actorGeneration: 2,
      }, "human"),
    ])).toBe("orchestrator_host_finalize");
    expect(deriveDoneOrigin([
      event("status_changed", { from: "todo", to: "done" }, UNKNOWN, "human"),
    ])).toBe("unknown");
    expect(deriveDoneOrigin([
      event("status_changed", { from: "todo", to: "done" }, {
        kind: "service",
        actorId: "supervisor",
        actorSessionId: "",
        actorGeneration: null,
      }, "orchestrator"),
    ])).toBe("unknown");
  });

  it("Telegram承認は専用eventと完全なpayloadだけをhuman_decisionにする", () => {
    expect(deriveDoneOrigin([
      event("telegram_approve", {
        from: "blocked",
        to: "done",
        kind: "user-decision",
        source: "telegram",
        nonce: "nonce-1",
      }),
    ])).toBe("human_decision");
    expect(deriveDoneOrigin([
      event("telegram_approve", { from: "blocked", to: "done", kind: "user-decision", source: "telegram" }),
    ])).toBe("unknown");
  });

  it.each([
    [
      "finalized",
      { from: "blocked", to: "done", outcome: "done" },
      { kind: "human", actorId: "local-human", actorSessionId: "", actorGeneration: null },
    ],
    [
      "verdict_finalized",
      { from: "review", to: "done", verdict: "pass", confidence: "medium", sessionId: "review-1" },
      { kind: "orchestrator", actorId: "o_1", actorSessionId: "os_1", actorGeneration: 2 },
    ],
    [
      "telegram_approve",
      { from: "blocked", to: "done", kind: "steward-promote", source: "telegram", nonce: "nonce-1" },
      { kind: "human", actorId: "local-human", actorSessionId: "", actorGeneration: null },
    ],
  ] satisfies Array<[string, Record<string, unknown>, ActorProvenance]>) (
    "%sの不完全・値違いcanonical payloadは正当provenance付きでもinvalid/unknownに閉じる",
    (eventType, payload, provenance) => {
      const incomplete = event(eventType, payload, provenance);
      expect(classifyDoneSignal(incomplete)).toBe("invalid-done-signal");
      expect(deriveDoneOrigin([incomplete])).toBe("unknown");
    },
  );

  it("不完全payload、壊れたJSON、done遷移の重複をunknownに閉じる", () => {
    expect(deriveDoneOrigin([event("finalized", { from: "blocked", to: "done", outcome: "done" })])).toBe("unknown");
    expect(deriveDoneOrigin([{ ...event("finalized", {}), payload: "{" }])).toBe("unknown");
    expect(deriveDoneOrigin([
      event("finalized", { from: "blocked", to: "done", outcome: "done", sessionId: "sess-1" }),
      { ...event("status_changed", { from: "todo", to: "done" }), id: 2 },
    ])).toBe("unknown");
  });

  it("doneシグナルをirrelevant/valid/invalidへ分け、invalidが1件でもあればunknownにする", () => {
    const complete = event("finalized", {
      from: "blocked", to: "done", outcome: "done", sessionId: "sess-1",
    });
    const incompleteDone = event("status_changed", { to: "done" });
    const brokenTerminal = { ...event("verdict_finalized", {}), payload: "{" };
    const brokenIrrelevant = { ...event("progress_note", {}), payload: "{" };

    expect(classifyDoneSignal(complete)).toBe("valid-done");
    expect(classifyDoneSignal(incompleteDone)).toBe("invalid-done-signal");
    expect(classifyDoneSignal(brokenTerminal)).toBe("invalid-done-signal");
    expect(classifyDoneSignal(brokenIrrelevant)).toBe("irrelevant");
    expect(deriveDoneOrigin([complete, incompleteDone])).toBe("unknown");
    expect(deriveDoneOrigin([complete, brokenTerminal])).toBe("unknown");
    expect(deriveDoneOrigin([complete, brokenIrrelevant])).toBe("gate_passed");
  });

  it("完全なfinalized(review)は後続review gateのdone判定へ影響しない", () => {
    const workerReview = event("finalized", {
      from: "blocked", to: "review", outcome: "review", sessionId: "worker-1",
    });
    const reviewDone = event("verdict_finalized", {
      from: "review", to: "done", verdict: "pass", confidence: "high", sessionId: "review-1",
    });
    expect(classifyDoneSignal(workerReview)).toBe("irrelevant");
    expect(deriveDoneOrigin([workerReview, reviewDone])).toBe("gate_passed");
  });

  it("review policy で review へ倒した finalized(workerOutcome=done) も後続review gateへ影響しない", () => {
    const policyReview = event("finalized", {
      from: "blocked", to: "review", outcome: "review", workerOutcome: "done", sessionId: "s",
    });
    const reviewDone = event("verdict_finalized", {
      from: "review", to: "done", verdict: "pass", confidence: "high", sessionId: "review-1",
    });
    expect(classifyDoneSignal(policyReview)).toBe("irrelevant");
    expect(deriveDoneOrigin([policyReview, reviewDone])).toBe("gate_passed");
  });

  it("完全なTelegram steward-promoteは後続done判定へ影響しない", () => {
    const promoted = event("telegram_approve", {
      from: "blocked",
      to: "ready",
      kind: "steward-promote",
      source: "telegram",
      nonce: "promote-1",
    });
    const completed = event("status_changed", { from: "todo", to: "done" }, {
      kind: "orchestrator",
      actorId: "o_1",
      actorSessionId: "os_1",
      actorGeneration: 1,
    });
    expect(classifyDoneSignal(promoted)).toBe("irrelevant");
    expect(deriveDoneOrigin([promoted, completed])).toBe("orchestrator_host_finalize");
  });

  it("自動完走率/manual recovery率/unknown率を同じ分母で再現する", () => {
    expect(summarizeDoneOrigins([
      "gate_passed",
      "gate_passed",
      "orchestrator_host_finalize",
      "human_decision",
      "unknown",
    ])).toEqual({
      total: 5,
      counts: { gatePassed: 2, orchestratorHostFinalize: 1, humanDecision: 1, unknown: 1 },
      automaticCompletionRate: 0.4,
      manualRecoveryRate: 0.4,
      unknownRate: 0.2,
    });
  });
});
