import { describe, expect, it } from "vitest";
import type { EventRow, RunRow, TaskRow } from "@hachi/core";
import {
  isLiveQuestionAwaiting,
  maxSessionEndedResultCount,
  maxSessionEndedResultWatermark,
  parseQuestionAwaitingPayload,
  sessionEndedResultCount,
} from "./question-awaiting.js";

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t_question",
    title: "質問",
    body: "",
    status: "blocked",
    priority: 0,
    tenant: "dev",
    assignee: "",
    provider: "",
    profile: "",
    modelOverride: "",
    effortOverride: "",
    speedOverride: "",
    reviewProfileOverride: "",
    reviewProviderOverride: "",
    reviewModelOverride: "",
    reviewEffortOverride: "",
    reviewSpeedOverride: "",
    blockReason: "worker-question: 仕様確認",
    claimLock: "",
    watched: false,
    consecutiveFailures: 0,
    lastFailureError: "",
    lastHeartbeatAt: null,
    maxRetries: 3,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function run(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: 1,
    taskId: "t_question",
    provider: "codex",
    sessionId: "sess-question",
    status: "running",
    meta: "{}",
    startedAt: 10,
    endedAt: null,
    ...overrides,
  };
}

function event(payload: Record<string, unknown>): EventRow {
  return {
    id: 1,
    taskId: "t_question",
    eventType: "question_awaiting",
    actor: "supervisor",
    payload: JSON.stringify(payload),
    provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
    createdAt: 10,
  };
}

describe("question-awaiting helpers", () => {
  it("isLiveQuestionAwaiting は worker-question + open run + deadline 内の payload だけ true にする", () => {
    const events = [
      event({
        sessionId: "sess-question",
        baselineResultCount: 1,
        deadline: 200,
        questionId: "q_1",
      }),
    ];

    expect(isLiveQuestionAwaiting(task(), run(), events, 100)).toBe(true);
    expect(isLiveQuestionAwaiting(task({ blockReason: "codex-in-progress: 実行中" }), run(), events, 100)).toBe(false);
    expect(isLiveQuestionAwaiting(task(), run({ sessionId: "other" }), events, 100)).toBe(false);
    expect(isLiveQuestionAwaiting(task(), run(), events, 200)).toBe(false);
  });

  it("parseQuestionAwaitingPayload は不正 payload を null にする", () => {
    expect(parseQuestionAwaitingPayload(JSON.stringify({ sessionId: "sess" }))).toBeNull();
    expect(parseQuestionAwaitingPayload("{")).toBeNull();
  });

  it("parseQuestionAwaitingPayload は baselineResultWatermark と baselineLastResultId を読む", () => {
    expect(
      parseQuestionAwaitingPayload(
        JSON.stringify({
          sessionId: "sess",
          baselineResultCount: 480,
          baselineResultWatermark: 4420,
          baselineLastResultId: 4420,
          deadline: 200,
          questionId: "q_1",
        }),
      ),
    ).toMatchObject({
      baselineResultCount: 480,
      baselineResultWatermark: 4420,
      baselineLastResultId: 4420,
    });
  });

  it("session_ended の legacy payload は resultCount=1 相当として扱う", () => {
    const legacy = event({ sessionId: "sess-question", provider: "codex" });
    const newer = event({ sessionId: "sess-question", provider: "codex", resultCount: 3 });

    expect(sessionEndedResultCount(legacy)).toBe(1);
    expect(maxSessionEndedResultCount([legacy, newer], "sess-question")).toBe(3);
  });

  it("session_ended の watermark は lastResultId を resultCount より優先する", () => {
    const first = event({ sessionId: "sess-question", provider: "codex", resultCount: 500, lastResultId: 4420 });
    const second = event({ sessionId: "sess-question", provider: "codex", resultCount: 480, lastResultId: 4421 });

    expect(maxSessionEndedResultWatermark([first, second], "sess-question")).toBe(4421);
  });
});
