import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decideArchiveIntegration,
  type ArchiveIntegrationObservation,
  type ArchiveIntegrationVerdict,
  type IntegrationEvidence,
} from "./steward-archive-integration.js";

interface FixtureRow {
  row: number;
  name: string;
  observation: ArchiveIntegrationObservation;
  verdict: ArchiveIntegrationVerdict;
  integrationEvidence: IntegrationEvidence;
}

interface FixtureDriftVariant {
  name: string;
  observation: ArchiveIntegrationObservation;
}

interface Fixture {
  rows: FixtureRow[];
  driftVariants: FixtureDriftVariant[];
}

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/steward-archive-integration.json", import.meta.url),
  "utf8",
)) as Fixture;

describe("steward archive integration pure decision table (§74.2)", () => {
  it("fixtureが決定表の全13行を過不足なく網羅している", () => {
    const rows = fixture.rows.map((entry) => entry.row).sort((a, b) => a - b);
    expect(rows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it.each(fixture.rows.map((entry) => [entry.row, entry.name, entry] as const))(
    "行%s(%s): verdict/integrationEvidenceが決定表どおりになる",
    (_row, _name, entry) => {
      expect(decideArchiveIntegration(entry.observation)).toEqual({
        verdict: entry.verdict,
        integrationEvidence: entry.integrationEvidence,
      });
    },
  );

  it("allowになるのは行3・4・5・10・11の5行だけである", () => {
    const allowRows = fixture.rows.filter((entry) => entry.verdict === "allow").map((entry) => entry.row);
    expect(allowRows.sort((a, b) => a - b)).toEqual([3, 4, 5, 10, 11]);
  });

  it.each(fixture.driftVariants.map((entry) => [entry.name, entry] as const))(
    "drift=trueは他フィールドの値に関わらず常に行13(%s)になる",
    (_name, entry) => {
      expect(decideArchiveIntegration(entry.observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:observation-drift",
      });
    },
  );

  it("clean-patch-equivalentとclean-head-reachableは異なる値であり、それぞれproofに対応する", () => {
    const ancestor = decideArchiveIntegration({
      cwd: { kind: "worktree-present" },
      integrationTarget: { state: "resolved", ref: "refs/remotes/origin/main", oid: "a".repeat(40) },
      integrationProof: { kind: "clean", proof: "ancestor" },
      drift: false,
    });
    const patchEquivalent = decideArchiveIntegration({
      cwd: { kind: "worktree-present" },
      integrationTarget: { state: "resolved", ref: "refs/remotes/origin/main", oid: "a".repeat(40) },
      integrationProof: { kind: "clean", proof: "patch-equivalent" },
      drift: false,
    });

    expect(ancestor.integrationEvidence).toBe("clean-head-reachable");
    expect(patchEquivalent.integrationEvidence).toBe("clean-patch-equivalent");
    expect(ancestor.integrationEvidence).not.toBe(patchEquivalent.integrationEvidence);
  });

  it("unobservable:no-cwdはallowに一切ならない", () => {
    const decision = decideArchiveIntegration({ cwd: { kind: "no-cwd" }, drift: false });
    expect(decision.verdict).toBe("veto");
    expect(decision.integrationEvidence).toBe("unobservable:no-cwd");
  });

  it("unobservable:no-integration-refはallowに一切ならない", () => {
    const decision = decideArchiveIntegration({
      cwd: { kind: "worktree-present" },
      integrationTarget: { state: "unresolved" },
      drift: false,
    });
    expect(decision.verdict).toBe("veto");
    expect(decision.integrationEvidence).toBe("unobservable:no-integration-ref");
  });

  it("行6はcwd-not-a-worktreeと同じevidenceでveto側へ倒れる（canonical root配下でない不在パス）", () => {
    const decision = decideArchiveIntegration({
      cwd: { kind: "worktree-missing", underCanonicalRoot: false },
      drift: false,
    });
    expect(decision).toEqual({ verdict: "veto", integrationEvidence: "unobservable:cwd-not-a-worktree" });
  });

  it("integrationTarget/integrationProofが未定義のworktree-presentはprobe未実行として行8へ倒れる", () => {
    const decision = decideArchiveIntegration({
      cwd: { kind: "worktree-present" },
      integrationTarget: { state: "resolved", ref: "refs/heads/main", oid: "b".repeat(40) },
      drift: false,
    });
    expect(decision).toEqual({ verdict: "veto", integrationEvidence: "unobservable:probe-failed" });
  });

  it("統合先ref解決自体が失敗した場合はtargetがunresolvedでも行7ではなく行8になる（symbolic-refのその他終了等）", () => {
    const decision = decideArchiveIntegration({
      cwd: { kind: "worktree-present" },
      integrationTarget: { state: "unresolved" },
      integrationProof: { kind: "probe-failed" },
      drift: false,
    });
    expect(decision).toEqual({ verdict: "veto", integrationEvidence: "unobservable:probe-failed" });
  });
});
