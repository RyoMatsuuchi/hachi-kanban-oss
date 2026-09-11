import { describe, expect, it } from "vitest";
import { assertTransition, hasKnownReasonPrefix, isInProgressReason } from "./statemachine.js";

describe("assertTransition", () => {
  it("許可された遷移は throw しない", () => {
    expect(() => assertTransition("triage", "todo")).not.toThrow();
    expect(() => assertTransition("triage", "ready")).not.toThrow();
    expect(() => assertTransition("triage", "archived")).not.toThrow();
    expect(() => assertTransition("todo", "ready")).not.toThrow();
    expect(() => assertTransition("todo", "triage")).not.toThrow();
    expect(() => assertTransition("todo", "done")).not.toThrow();
    expect(() => assertTransition("ready", "blocked")).not.toThrow();
    expect(() => assertTransition("ready", "todo")).not.toThrow();
    expect(() => assertTransition("blocked", "ready")).not.toThrow();
    expect(() => assertTransition("blocked", "review")).not.toThrow();
    expect(() => assertTransition("blocked", "needs-integration")).not.toThrow();
    expect(() => assertTransition("blocked", "done")).not.toThrow();
    expect(() => assertTransition("review", "blocked")).not.toThrow();
    expect(() => assertTransition("review", "needs-integration")).not.toThrow();
    expect(() => assertTransition("review", "done")).not.toThrow();
    expect(() => assertTransition("needs-integration", "done")).not.toThrow();
    expect(() => assertTransition("needs-integration", "blocked")).not.toThrow();
    expect(() => assertTransition("done", "archived")).not.toThrow();
  });

  it("不正な遷移は throw する（fail-closed）", () => {
    expect(() => assertTransition("triage", "blocked")).toThrow(/不正な状態遷移/);
    expect(() => assertTransition("triage", "done")).toThrow();
    expect(() => assertTransition("done", "todo")).toThrow();
    expect(() => assertTransition("archived", "triage")).toThrow();
    expect(() => assertTransition("blocked", "blocked")).toThrow();
    expect(() => assertTransition("blocked", "triage")).toThrow();
  });

  it("archived からはどこにも遷移できない", () => {
    const targets = ["triage", "todo", "ready", "blocked", "review", "needs-integration", "done", "archived"] as const;
    for (const to of targets) {
      expect(() => assertTransition("archived", to)).toThrow();
    }
  });
});

describe("isInProgressReason", () => {
  it("codex-in-progress: / claude-in-progress: prefix を true と判定する", () => {
    expect(isInProgressReason("codex-in-progress: something")).toBe(true);
    expect(isInProgressReason("claude-in-progress: something")).toBe(true);
  });

  it("それ以外の prefix は false と判定する", () => {
    expect(isInProgressReason("user-decision: waiting")).toBe(false);
    expect(isInProgressReason("")).toBe(false);
    expect(isInProgressReason("codex-in-progress")).toBe(false);
  });
});

describe("hasKnownReasonPrefix", () => {
  it("REASON_PREFIXES のいずれかで始まる場合 true", () => {
    expect(hasKnownReasonPrefix("user-decision: waiting for human")).toBe(true);
    expect(hasKnownReasonPrefix("needs-manual: integration required")).toBe(true);
    expect(hasKnownReasonPrefix("auto-launch-failed: timeout")).toBe(true);
  });

  it("未知の prefix は false（fail-closed 判定材料）", () => {
    expect(hasKnownReasonPrefix("random-reason: nope")).toBe(false);
    expect(hasKnownReasonPrefix("")).toBe(false);
  });
});
