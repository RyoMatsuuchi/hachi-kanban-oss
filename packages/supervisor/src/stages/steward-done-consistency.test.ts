import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ActorProvenance, EventRow } from "@hachi/core";
import { decideDoneConsistency } from "./steward-done-consistency.js";

const UNKNOWN: ActorProvenance = {
  kind: "unknown",
  actorId: "",
  actorSessionId: "",
  actorGeneration: null,
};

interface FixtureEvent {
  eventType: string;
  payload: Record<string, unknown>;
  provenance?: ActorProvenance;
}

interface IncidentFixture {
  recoveredHostFinalize: FixtureEvent[];
  recoveredReviewGate: FixtureEvent[];
  impossibleTransition: FixtureEvent[];
  evidenceMissing: FixtureEvent[];
  staleFenceOnly: FixtureEvent[];
}

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/steward-done-consistency.json", import.meta.url),
  "utf8",
)) as IncidentFixture;

function events(entries: readonly FixtureEvent[]): EventRow[] {
  return entries.map((entry, index) => ({
    id: index + 1,
    taskId: "t_fixture00000001",
    eventType: entry.eventType,
    actor: "untrusted-display",
    payload: JSON.stringify(entry.payload),
    provenance: entry.provenance ?? UNKNOWN,
    createdAt: 100 + index,
  }));
}

describe("steward done consistency pure decision table", () => {
  it("実incident同型のlegacy host-finalizeをunknownのまま正当回復として警告しない", () => {
    expect(decideDoneConsistency(
      { status: "done" },
      events(fixture.recoveredHostFinalize),
    )).toMatchObject({
      verdict: "consistent",
      code: "consistent",
      origin: "unknown",
    });
  });

  it("handoff失敗後の構造化host-finalizeも正当回復として警告しない", () => {
    const history = events(fixture.recoveredHostFinalize);
    history[history.length - 1] = {
      ...history[history.length - 1]!,
      provenance: {
        kind: "orchestrator",
        actorId: "o_fixture",
        actorSessionId: "os_fixture",
        actorGeneration: 4,
      },
    };
    expect(decideDoneConsistency({ status: "done" }, history)).toMatchObject({
      verdict: "consistent",
      code: "consistent",
      origin: "orchestrator_host_finalize",
    });
  });

  it("legacy unknown originが38件あっても全件consistentで通知storm候補を作らない", () => {
    const decisions = Array.from({ length: 38 }, () => decideDoneConsistency(
      { status: "done" },
      events(fixture.recoveredHostFinalize),
    ));
    expect(decisions).toHaveLength(38);
    expect(decisions.every((decision) => (
      decision.verdict === "consistent" && decision.origin === "unknown"
    ))).toBe(true);
  });

  it("verdict_missing後の独立review passを正当gate完走として警告しない", () => {
    const history = [
      ...events(fixture.recoveredReviewGate),
      {
        ...events(fixture.staleFenceOnly)[0]!,
        id: 99,
        createdAt: 999,
      },
    ];
    expect(decideDoneConsistency({ status: "done" }, history)).toMatchObject({
      verdict: "consistent",
      code: "consistent",
      origin: "gate_passed",
    });
  });

  it.each([
    ["impossibleTransition", "impossible-transition"],
    ["evidenceMissing", "evidence-missing"],
    ["staleFenceOnly", "stale-fence-only"],
  ] as const)("真の矛盾fixture %sを一意のescalate理由へ分類する", (fixtureKey, code) => {
    const decision = decideDoneConsistency({ status: "done" }, events(fixture[fixtureKey]));
    expect(decision).toMatchObject({ verdict: "escalate", code, origin: "unknown" });
  });

  it("multiple valid done signalをevidence-missingへ閉じる", () => {
    const first = events(fixture.recoveredHostFinalize).at(-1)!;
    const second = { ...first, id: first.id + 1, createdAt: first.createdAt + 1 };
    expect(decideDoneConsistency({ status: "done" }, [first, second])).toMatchObject({
      verdict: "escalate",
      code: "evidence-missing",
    });
  });

  it("valid doneとinvalid done signalの混在をevidence-missingへ閉じる", () => {
    const valid = events(fixture.recoveredHostFinalize).at(-1)!;
    const invalid = events(fixture.evidenceMissing).at(-1)!;
    expect(decideDoneConsistency({ status: "done" }, [valid, invalid])).toMatchObject({
      verdict: "escalate",
      code: "evidence-missing",
    });
  });

  it("valid done 0かつstale証拠なしをevidence-missingへ閉じる", () => {
    const ordinary = events([{
      eventType: "handoff_evidence_failed",
      payload: { sessionId: "worker-only" },
    }]);
    expect(decideDoneConsistency({ status: "done" }, ordinary)).toMatchObject({
      verdict: "escalate",
      code: "evidence-missing",
    });
  });

  it("done以外は検査対象外にする", () => {
    expect(decideDoneConsistency(
      { status: "review" },
      events(fixture.evidenceMissing),
    )).toMatchObject({ verdict: "not-applicable", code: "not-done" });
  });
});
