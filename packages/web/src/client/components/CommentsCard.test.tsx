// =============================================================================
// CommentsCard.tsx の run 帰属・グルーピング・折りたたみ・絞り込みテスト（docs/contract.md §32.5）。
// =============================================================================

// @vitest-environment jsdom

import type { AgentMessageV1, CommentRow, RunRow } from "@hachi/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CommentMessages } from "../../shared/api-types.js";
import { CommentsCard, groupCommentsByRun } from "./CommentsCard.js";

const TASK_ID = "t_0000000000000001";

function makeComment(overrides: Partial<CommentRow> & Pick<CommentRow, "id" | "body">): CommentRow {
  return {
    taskId: TASK_ID,
    author: "worker",
    provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
    createdAt: 1_780_000_000,
    ...overrides,
    id: overrides.id,
    body: overrides.body,
  };
}

function makeRun(overrides: Partial<RunRow> & Pick<RunRow, "id" | "sessionId">): RunRow {
  return {
    taskId: TASK_ID,
    provider: "codex",
    status: "done",
    meta: JSON.stringify({ role: "worker" }),
    startedAt: 1_780_000_000,
    endedAt: 1_780_000_100,
    ...overrides,
    id: overrides.id,
    sessionId: overrides.sessionId,
  };
}

function makeMessage(sessionId: string, idempotencyKey: string): AgentMessageV1 {
  return {
    schema: "agent.message.v1",
    from: { role: "worker", provider: "codex", sessionId },
    to: { role: "orchestrator", taskId: TASK_ID },
    intent: "steer",
    payload: { message: "続けて" },
    idempotencyKey,
    createdAt: 1_780_000_000,
  };
}

function messageBody(message: AgentMessageV1): string {
  return `メッセージ本文\n\n\`\`\`agent-message-v1\n${JSON.stringify(message)}\n\`\`\``;
}

function parsedMessage(message: AgentMessageV1): CommentMessages {
  return { messages: [message], errors: [] };
}

afterEach(() => {
  cleanup();
});

describe("groupCommentsByRun", () => {
  it("sessionId を interval より優先し、重複 interval は開始が最も遅い run、範囲外は run 外にする", () => {
    const oldRun = makeRun({
      id: 111111111,
      sessionId: "session-old-12345678",
      startedAt: 100,
      endedAt: 300,
    });
    const newRun = makeRun({
      id: 222222222,
      sessionId: "session-new-12345678",
      startedAt: 200,
      endedAt: null,
    });
    const sessionMessage = makeMessage(newRun.sessionId, "session-priority");
    const comments = [
      makeComment({ id: 1, body: messageBody(sessionMessage), createdAt: 150 }),
      makeComment({ id: 2, body: "重複 interval", createdAt: 250 }),
      makeComment({ id: 3, body: "run 外", createdAt: 500 }),
    ];

    const groups = groupCommentsByRun(
      comments,
      { 1: parsedMessage(sessionMessage) },
      [oldRun, newRun],
      400,
    );

    expect(groups.map((group) => group.key)).toEqual(["run:222222222", "outside"]);
    expect(groups[0]?.comments.map(({ comment }) => comment.id)).toEqual([1, 2]);
    expect(groups[0]?.comments.map(({ attributionSource }) => attributionSource)).toEqual([
      "message-session",
      "interval",
    ]);
    expect(groups[1]?.comments[0]?.attributionSource).toBe("none");
  });
});

describe("CommentsCard", () => {
  it("グループを最新コメント順に並べ、run 外を末尾にして最新グループだけを開く", () => {
    const comments = [
      makeComment({ id: 1, body: "old first", createdAt: 110 }),
      makeComment({ id: 2, body: "old second", createdAt: 120 }),
      makeComment({ id: 3, body: "new comment", createdAt: 310 }),
      makeComment({ id: 4, body: "outside newest", createdAt: 900 }),
    ];
    const runs = [
      makeRun({ id: 111111111, sessionId: "session-old-12345678", startedAt: 100, endedAt: 200 }),
      makeRun({
        id: 222222222,
        sessionId: "session-new-12345678",
        meta: JSON.stringify({ role: "reviewer" }),
        startedAt: 300,
        endedAt: 400,
      }),
    ];

    const { container } = render(<CommentsCard comments={comments} messages={{}} runs={runs} />);
    const groups = Array.from(container.querySelectorAll<HTMLElement>("[data-comment-group]"));

    expect(groups.map((group) => group.dataset.commentGroup)).toEqual([
      "run:222222222",
      "run:111111111",
      "outside",
    ]);
    expect(groups.map((group) => group.dataset.state)).toEqual(["open", "closed", "closed"]);
    expect(within(groups[0]!).getByText("new comment")).toBeTruthy();
    expect(screen.getByText("reviewer")).toBeTruthy();
    expect(screen.getByText("run 22222222")).toBeTruthy();
    expect(within(groups[0]!).getByText("session session-")).toBeTruthy();

    fireEvent.click(within(groups[1]!).getByRole("button"));
    expect(within(groups[1]!).getAllByText(/old (first|second)/).map((node) => node.textContent)).toEqual([
      "old first",
      "old second",
    ]);
  });

  it("すべて・最新の run・メッセージのみを切り替え、メッセージのグループ構造を維持する", () => {
    const latestMessage = makeMessage("session-new-12345678", "latest-message");
    const outsideMessage = makeMessage("session-missing", "outside-message");
    const comments = [
      makeComment({ id: 1, body: "older plain", createdAt: 110 }),
      makeComment({ id: 2, body: messageBody(latestMessage), createdAt: 310 }),
      makeComment({ id: 3, body: "latest plain", createdAt: 320 }),
      makeComment({ id: 4, body: messageBody(outsideMessage), createdAt: 900 }),
    ];
    const runs = [
      makeRun({ id: 111111111, sessionId: "session-old-12345678", startedAt: 100, endedAt: 200 }),
      makeRun({ id: 222222222, sessionId: "session-new-12345678", startedAt: 300, endedAt: 400 }),
    ];
    const messages = {
      2: parsedMessage(latestMessage),
      4: parsedMessage(outsideMessage),
    };

    const { container } = render(
      <CommentsCard comments={comments} messages={messages} runs={runs} />,
    );
    expect(container.querySelectorAll("[data-comment-group]")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "すべて" }).getAttribute("data-state")).toBe("on");

    fireEvent.click(screen.getByRole("radio", { name: "最新の run" }));
    expect(container.querySelectorAll("[data-comment-group]")).toHaveLength(1);
    expect(screen.getByText("latest plain")).toBeTruthy();
    expect(screen.queryByText("older plain")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "メッセージのみ" }));
    const messageGroups = Array.from(container.querySelectorAll<HTMLElement>("[data-comment-group]"));
    expect(messageGroups.map((group) => group.dataset.commentGroup)).toEqual([
      "run:222222222",
      "outside",
    ]);
    expect(screen.getByText("メッセージ本文")).toBeTruthy();
    expect(screen.queryByText("latest plain")).toBeNull();
    expect(screen.queryByText("older plain")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "すべて" }));
    expect(container.querySelectorAll("[data-comment-group]")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "すべて" }).getAttribute("data-state")).toBe("on");
  });
});
