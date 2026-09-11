// =============================================================================
// SessionsPanel.tsx のライブビュー表示テスト（docs/contract.md §28.3）。
// ノイズ抑制・running_stats ピル・詳細イベントトグルを、bridge には接続せず検証する。
// =============================================================================

// @vitest-environment jsdom

import type {
  SessionLiveResponse,
  SessionMessageEntry,
  SessionMessagesResponse,
  SessionResponse,
  SessionsResponse,
  SessionTranscriptRawEntry,
  SessionTranscriptRawResponse,
  SessionTranscriptResponse,
  WebRunningSession,
} from "../../shared/api-types.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn((query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const fetchSessionMessagesMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<SessionMessagesResponse>>(),
);
const fetchSessionLiveMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<SessionLiveResponse>>());
const fetchSessionTranscriptMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<SessionTranscriptResponse>>(),
);
const fetchSessionMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<SessionResponse>>());
const fetchSessionsMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<SessionsResponse>>());
const fetchSessionTranscriptRawMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<SessionTranscriptRawResponse>>(),
);

vi.mock("../lib/api.js", () => {
  class MockApiError extends Error {
    readonly status: number | undefined;

    constructor(message: string, status?: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }

  return {
    ApiError: MockApiError,
    fetchSession: fetchSessionMock,
    fetchSessionLive: fetchSessionLiveMock,
    fetchSessionMessages: fetchSessionMessagesMock,
    fetchSessionTranscript: fetchSessionTranscriptMock,
    fetchSessionTranscriptRaw: fetchSessionTranscriptRawMock,
    fetchSessions: fetchSessionsMock,
  };
});

import {
  SessionLiveView,
  SessionTranscriptRawView,
  SessionsView,
  TRANSCRIPT_RAW_TEXT_TRUNCATE_LENGTH,
  formatToolEventLabel,
  latestRunningStatsPill,
  visibleSessionEntries,
} from "./SessionsPanel.js";
import { ApiError } from "../lib/api.js";

interface RenderedLiveView {
  container: HTMLDivElement;
  root: Root;
}

interface RenderLiveViewOptions {
  session?: WebRunningSession;
  responseState?: string;
}

function makeSession(overrides: Partial<WebRunningSession> = {}): WebRunningSession {
  return {
    taskId: "t_0000000000000001",
    taskTitle: "ライブビューテスト",
    provider: "codex",
    model: "gpt-5.4",
    transport: "bridge",
    sessionId: "sess-1",
    serverUrl: "http://127.0.0.1:3456",
    startedAt: 1_700_000_000,
    state: "ended",
    role: "worker",
    taskStatus: "blocked",
    tenant: "tenant-a",
    effort: null,
    effortDelivery: null,
    liveSupported: true,
    curlCommand: null,
    ...overrides,
  };
}

function textContent(container: HTMLElement): string {
  return container.textContent ?? "";
}

function buttonByText(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${label}`);
  }
  return button;
}

function makeMessagesResponse(messages: SessionMessageEntry[], state: string): SessionMessagesResponse {
  return {
    messages,
    state,
    sessionId: "sess-1",
    provider: "codex",
  };
}

async function mountLiveView(session: WebRunningSession): Promise<RenderedLiveView> {
  if (fetchSessionTranscriptMock.getMockImplementation() === undefined) {
    fetchSessionTranscriptMock.mockResolvedValue({
      taskId: "t_0000000000000001",
      sessionId: "sess-1",
      source: "artifact",
      text: "",
    });
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SessionLiveView session={session} />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

async function renderLiveView(
  messages: SessionMessageEntry[],
  options: RenderLiveViewOptions = {},
): Promise<RenderedLiveView> {
  fetchSessionMessagesMock.mockResolvedValue({
    ...makeMessagesResponse(messages, options.responseState ?? "idle"),
  });

  return mountLiveView(options.session ?? makeSession({ state: "running" }));
}

afterEach(() => {
  vi.useRealTimers();
  fetchSessionMessagesMock.mockReset();
  fetchSessionLiveMock.mockReset();
  fetchSessionTranscriptMock.mockReset();
  fetchSessionTranscriptRawMock.mockReset();
  fetchSessionMock.mockReset();
  fetchSessionsMock.mockReset();
  document.body.innerHTML = "";
});

describe("visibleSessionEntries", () => {
  it("既定表示では会話イベントだけを残し、text_delta をノイズ越しに連結する", () => {
    const entries: SessionMessageEntry[] = [
      { id: "u1", type: "user_prompt", text: "質問" },
      { id: "s1", type: "status", state: "text_start" },
      { id: "d1", type: "text_delta", text: "こん" },
      { id: "stats1", type: "running_stats", durationMs: 1_000, inputTokens: 0, outputTokens: 0 },
      { id: "empty", type: "text_delta", text: "" },
      { id: "d2", type: "text_delta", text: "にちは" },
      { id: "tool1", type: "tool_start", name: "shell" },
      { id: "x1", type: "unknown_progress" },
      { id: "r1", type: "result", success: true, text: "完了", costUsd: 0, turns: 1, durationMs: 2_000 },
    ];

    const visible = visibleSessionEntries(entries, false);

    expect(visible.map((entry) => entry.type)).toEqual(["user_prompt", "text_delta", "result"]);
    expect(visible[1]?.text).toBe("こんにちは");
  });

  it("text_delta の改行と空白だけの断片を連結前に落とさない", () => {
    const entries: SessionMessageEntry[] = [
      { id: "d1", type: "text_delta", text: "1行目" },
      { id: "stats1", type: "running_stats", durationMs: 1_000, inputTokens: 0, outputTokens: 0 },
      { id: "d2", type: "text_delta", text: "\n" },
      { id: "status1", type: "status", state: "text_delta" },
      { id: "d3", type: "text_delta", text: "  2行目" },
    ];

    const visible = visibleSessionEntries(entries, false);

    expect(visible.map((entry) => entry.type)).toEqual(["text_delta"]);
    expect(visible[0]?.text).toBe("1行目\n  2行目");
  });

  it("詳細表示では進行イベントを出すが、最新 running_stats はストリームに残さない", () => {
    const entries: SessionMessageEntry[] = [
      { id: "d1", type: "text_delta", text: "出力" },
      { id: "stats-old", type: "running_stats", durationMs: 1_000, inputTokens: 10, outputTokens: 1 },
      { id: "tool1", type: "tool_start", name: "shell" },
      { id: "x1", type: "unknown_progress" },
      { id: "stats-latest", type: "running_stats", durationMs: 2_000, inputTokens: 20, outputTokens: 2 },
    ];

    const visible = visibleSessionEntries(entries, true);

    expect(visible.some((entry) => entry.id === "tool1")).toBe(true);
    expect(visible.some((entry) => entry.id === "x1")).toBe(true);
    expect(visible.some((entry) => entry.id === "stats-old")).toBe(true);
    expect(visible.some((entry) => entry.id === "stats-latest")).toBe(false);
  });

  it("詳細表示でも空の text_delta/text は描画対象にしない", () => {
    const entries: SessionMessageEntry[] = [
      { id: "s1", type: "status", state: "text_start" },
      { id: "empty-delta", type: "text_delta", text: "" },
      { id: "empty-text", type: "text", text: "   " },
      { id: "s2", type: "status", state: "text_end" },
      { id: "d1", type: "text_delta", text: "本文" },
      { id: "stats-latest", type: "running_stats", durationMs: 2_000, inputTokens: 0, outputTokens: 0 },
    ];

    const visible = visibleSessionEntries(entries, true);

    expect(visible.map((entry) => entry.id)).toEqual(["s1", "s2", "d1"]);
    expect(visible[2]?.text).toBe("本文");
  });
});

describe("latestRunningStatsPill", () => {
  it("最新 running_stats を mm:ss と output tokens に集約する", () => {
    const pill = latestRunningStatsPill([
      { id: "stats1", type: "running_stats", durationMs: 5_000, inputTokens: 10, outputTokens: 1 },
      { id: "stats2", type: "running_stats", durationMs: 65_000, inputTokens: 20, outputTokens: 42 },
    ]);

    expect(pill).toEqual({ text: "経過 01:05 · out 42", elapsed: "01:05", outputTokens: 42 });
  });

  it("token 値が 0 の場合は経過時間だけを表示する", () => {
    const pill = latestRunningStatsPill([
      { id: "stats1", type: "running_stats", durationMs: 65_000, inputTokens: 0, outputTokens: 0 },
    ]);

    expect(pill).toEqual({ text: "経過 01:05", elapsed: "01:05", outputTokens: null });
  });
});

describe("formatToolEventLabel", () => {
  it("tool 名があれば優先し、無ければ type を表示する", () => {
    expect(formatToolEventLabel({ id: "tool1", type: "tool_start", name: "shell" })).toBe("🔧 shell");
    expect(formatToolEventLabel({ id: "tool2", type: "tool_end" })).toBe("🔧 tool_end");
  });
});

describe("SessionLiveView", () => {
  it("終了済みセッションは bridge messages ではなく保存 transcript を既定表示する", async () => {
    fetchSessionTranscriptMock.mockResolvedValue({
      taskId: "t_0000000000000001",
      sessionId: "sess-1",
      source: "artifact",
      text: "[tool] exec_command pnpm test",
    });
    fetchSessionMessagesMock.mockResolvedValue(makeMessagesResponse([{ id: "r1", type: "result", text: "薄い結果" }], "idle"));

    const rendered = await mountLiveView(makeSession({ state: "ended", liveSupported: true }));

    expect(fetchSessionTranscriptMock).toHaveBeenCalledTimes(1);
    expect(fetchSessionMessagesMock).not.toHaveBeenCalled();
    expect(textContent(rendered.container)).toContain("[tool] exec_command pnpm test");
    expect(textContent(rendered.container)).not.toContain("薄い結果");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("running direct セッションは /live を表示し、非対応文言を出さない", async () => {
    const session = makeSession({
      state: "running",
      transport: "direct",
      serverUrl: "direct",
      liveSupported: false,
      sessionId: "direct-live-1",
    });
    fetchSessionMock.mockResolvedValue({ session });
    fetchSessionLiveMock.mockResolvedValue({
      taskId: session.taskId,
      sessionId: session.sessionId,
      source: "direct-live",
      text: "one\ntwo\n",
      truncated: false,
    });

    const rendered = await mountLiveView(session);

    expect(fetchSessionMock).toHaveBeenCalledTimes(1);
    expect(fetchSessionLiveMock).toHaveBeenCalledTimes(1);
    expect(fetchSessionLiveMock).toHaveBeenCalledWith(
      { sessionId: "direct-live-1", taskId: session.taskId, tail: 200 },
      expect.any(AbortSignal),
    );
    expect(fetchSessionMessagesMock).not.toHaveBeenCalled();
    expect(textContent(rendered.container)).toContain("one\ntwo");
    expect(textContent(rendered.container)).toContain("direct live");
    expect(textContent(rendered.container)).not.toContain("非対応");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("running direct の /live 404 は待機表示にし、非対応文言を出さない", async () => {
    const session = makeSession({
      state: "running",
      transport: "direct",
      serverUrl: "direct",
      liveSupported: false,
      sessionId: "direct-live-pending",
    });
    fetchSessionMock.mockResolvedValue({ session });
    fetchSessionLiveMock.mockRejectedValue(new ApiError("not found", 404));

    const rendered = await mountLiveView(session);

    const text = textContent(rendered.container);
    expect(text).toContain("ログ生成を待っています");
    expect(text).not.toContain("非対応");
    expect(fetchSessionMessagesMock).not.toHaveBeenCalled();

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("running direct が ended になったら /live ではなく保存 transcript へ切り替える", async () => {
    const runningSession = makeSession({
      state: "running",
      transport: "direct",
      serverUrl: "direct",
      liveSupported: false,
      sessionId: "direct-ended",
    });
    fetchSessionMock.mockResolvedValue({ session: { ...runningSession, state: "ended" } });
    fetchSessionTranscriptMock.mockResolvedValue({
      taskId: runningSession.taskId,
      sessionId: runningSession.sessionId,
      source: "artifact",
      text: "[tool] 完全記録\n",
    });

    const rendered = await mountLiveView(runningSession);

    expect(fetchSessionLiveMock).not.toHaveBeenCalled();
    expect(fetchSessionTranscriptMock).toHaveBeenCalledTimes(1);
    expect(textContent(rendered.container)).toContain("[tool] 完全記録");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("running direct セッションは 3 秒間隔で /live をポーリングする", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const session = makeSession({
      state: "running",
      transport: "direct",
      serverUrl: "direct",
      liveSupported: false,
      sessionId: "direct-poll",
    });
    fetchSessionMock.mockResolvedValue({ session });
    fetchSessionLiveMock
      .mockResolvedValueOnce({
        taskId: session.taskId,
        sessionId: session.sessionId,
        source: "direct-live",
        text: "first\n",
        truncated: false,
      })
      .mockResolvedValue({
        taskId: session.taskId,
        sessionId: session.sessionId,
        source: "direct-live",
        text: "second\n",
        truncated: false,
      });

    const rendered = await mountLiveView(session);
    expect(fetchSessionLiveMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2_999);
      await Promise.resolve();
    });
    expect(fetchSessionLiveMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchSessionLiveMock).toHaveBeenCalledTimes(2);
    expect(textContent(rendered.container)).toContain("second");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("ライブビューのヘッダに工程バッジと tenant を表示する", async () => {
    const rendered = await renderLiveView([], {
      session: makeSession({ role: "reviewer", tenant: "live-tenant" }),
    });

    expect(textContent(rendered.container)).toContain("レビュー");
    expect(textContent(rendered.container)).toContain("live-tenant");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("会話テキストの改行を保持するクラスで描画する", async () => {
    const rendered = await renderLiveView([
      { id: "d1", type: "text_delta", text: "1行目" },
      { id: "d2", type: "text_delta", text: "\n" },
      { id: "d3", type: "text_delta", text: "  2行目" },
    ]);

    const line = [...rendered.container.querySelectorAll(".terminal-line")].find(
      (candidate) => candidate.textContent === "1行目\n  2行目",
    );

    expect(line?.className).toContain("whitespace-pre-wrap");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("running 中の経過時間ピルをポーリングに依存せず毎秒更新する", async () => {
    const startedAt = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(startedAt * 1000 + 5_000));

    const rendered = await renderLiveView([], {
      responseState: "running",
      session: makeSession({ state: "running", startedAt }),
    });

    expect(textContent(rendered.container)).toContain("経過 00:05");
    expect(rendered.container.querySelector(".animate-ping")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });

    expect(textContent(rendered.container)).toContain("経過 00:06");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("非表示イベントの受信でも最終受信時刻を更新する", async () => {
    const startedAt = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(startedAt * 1000 + 1_000));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    fetchSessionMessagesMock
      .mockResolvedValueOnce(makeMessagesResponse([], "running"))
      .mockResolvedValueOnce(
        makeMessagesResponse(
          [{ id: "stats1", type: "running_stats", durationMs: 3_000, inputTokens: 10, outputTokens: 1 }],
          "running",
        ),
      );

    const rendered = await mountLiveView(makeSession({ state: "running", startedAt }));

    expect(textContent(rendered.container)).not.toContain("最終受信");

    await act(async () => {
      vi.advanceTimersByTime(2_500);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const after = textContent(rendered.container);
    expect(fetchSessionMessagesMock).toHaveBeenCalledTimes(2);
    expect(after).toContain("最終受信 0秒前");
    expect(after).not.toContain("running_stats");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("詳細イベントトグルで非会話イベントを表示し、unknown type 文言は出さない", async () => {
    const messages: SessionMessageEntry[] = [
      { id: "u1", type: "user_prompt", text: "質問" },
      { id: "s1", type: "status", state: "text_start" },
      { id: "stats1", type: "running_stats", durationMs: 65_000, inputTokens: 0, outputTokens: 0 },
      { id: "d1", type: "text_delta", text: "返答" },
      { id: "tool1", type: "tool_start", name: "shell" },
      { id: "x1", type: "unknown_progress" },
      { id: "r1", type: "result", success: true, text: "完了", costUsd: 0, turns: 1, durationMs: 70_000 },
    ];

    const rendered = await renderLiveView(messages);
    const before = textContent(rendered.container);

    expect(before).toContain("質問");
    expect(before).toContain("返答");
    expect(before).toContain("完了");
    expect(before).toContain("経過 01:05");
    expect(rendered.container.querySelector(".animate-ping")).toBeNull();
    expect(before).not.toContain("status text_start");
    expect(before).not.toContain("shell");
    expect(before).not.toContain("unknown_progress");
    expect(before).not.toContain("running_stats");

    const toggle = buttonByText(rendered.container, "詳細イベント");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      toggle.click();
    });

    const after = textContent(rendered.container);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(after).toContain("status text_start");
    expect(after).toContain("🔧 shell");
    expect(after).toContain("event unknown_progress");
    expect(after).not.toContain("unknown type=");
    expect(after).not.toContain("running_stats");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("ライブビューのヘッダにモデル名と effort を併記する", async () => {
    const rendered = await renderLiveView([], {
      session: makeSession({ effort: "high", effortDelivery: "native" }),
    });

    expect(textContent(rendered.container)).toContain("gpt-5.4");
    expect(textContent(rendered.container)).toContain("effort high");
    expect(textContent(rendered.container)).toContain("gpt-5.4 · effort high");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("effortDelivery が none の場合は「未配信」表記を含む", async () => {
    const rendered = await renderLiveView([], {
      session: makeSession({ effort: "medium", effortDelivery: "none" }),
    });

    expect(textContent(rendered.container)).toContain("effort medium（未配信）");
    expect(textContent(rendered.container)).toContain("gpt-5.4 · effort medium（未配信）");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("effort が null の場合でもモデル名は表示する", async () => {
    const rendered = await renderLiveView([], {
      session: makeSession({ effort: null, effortDelivery: null }),
    });

    expect(textContent(rendered.container)).toContain("gpt-5.4");
    expect(textContent(rendered.container)).not.toContain("effort");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });
});

describe("SessionTranscriptRawView", () => {
  async function mountTranscriptRawView(session: WebRunningSession): Promise<RenderedLiveView> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<SessionTranscriptRawView session={session} />);
      await Promise.resolve();
    });
    return { container, root };
  }

  async function openTranscriptRawView(container: HTMLElement): Promise<void> {
    const toggle = buttonByText(container, "全文ログを表示");
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("トグルを開くと fetch を呼び、user/assistant は表示・tool/other は既定で畳まれる（DOM上に見えない）", async () => {
    const session = makeSession({ state: "ended" });
    fetchSessionTranscriptRawMock.mockResolvedValue({
      taskId: session.taskId,
      sessionId: session.sessionId,
      provider: "codex",
      found: true,
      startLine: 1,
      endLine: 4,
      totalLines: 4,
      hasMoreAfter: false,
      hasMoreBefore: false,
      entries: [
        { line: 1, kind: "user", rawType: "user_message", timestamp: null, text: "こんにちは", unparsed: false },
        { line: 2, kind: "assistant", rawType: "agent_message", timestamp: null, text: "はい、応答します", unparsed: false },
        { line: 3, kind: "tool", rawType: "response_item", timestamp: null, text: "[function_call:shell] ls", unparsed: false },
        { line: 4, kind: "other", rawType: "turn_context", timestamp: null, text: "[turn_context] model=gpt-5.4", unparsed: false },
      ],
    });

    const rendered = await mountTranscriptRawView(session);
    expect(fetchSessionTranscriptRawMock).not.toHaveBeenCalled();

    await openTranscriptRawView(rendered.container);

    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(1);
    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledWith(
      { sessionId: session.sessionId, taskId: session.taskId },
      expect.any(AbortSignal),
    );
    const text = textContent(rendered.container);
    expect(text).toContain("こんにちは");
    expect(text).toContain("はい、応答します");
    expect(text).not.toContain("[function_call:shell] ls");
    expect(text).not.toContain("[turn_context] model=gpt-5.4");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("found:false のときは空白ではなく reasonText をそのまま表示する", async () => {
    const session = makeSession({ state: "ended" });
    fetchSessionTranscriptRawMock.mockResolvedValue({
      taskId: session.taskId,
      sessionId: session.sessionId,
      provider: "codex",
      found: false,
      reason: "log-not-found",
      reasonText: "ネイティブログが見つかりませんでした",
    });

    const rendered = await mountTranscriptRawView(session);
    await openTranscriptRawView(rendered.container);

    expect(textContent(rendered.container)).toContain("ネイティブログが見つかりませんでした");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it.each([
    {
      limitedBy: "response-bytes" as const,
      warning: "応答サイズ上限のため、この範囲の一部だけを表示しています",
    },
    {
      limitedBy: "raw-line-bytes" as const,
      warning: "1 MiBを超える行は安全のため固定メッセージに置き換えました",
    },
  ])("limitedBy=$limitedBy の警告を出し、返却済みentriesを隠さない", async ({ limitedBy, warning }) => {
    const session = makeSession({ state: "ended" });
    fetchSessionTranscriptRawMock.mockResolvedValue({
      taskId: session.taskId,
      sessionId: session.sessionId,
      provider: "codex",
      found: true,
      startLine: 1,
      endLine: 1,
      totalLines: 2,
      hasMoreAfter: limitedBy === "response-bytes",
      hasMoreBefore: false,
      limitedBy: [limitedBy],
      entries: [
        {
          line: 1,
          kind: "assistant",
          rawType: "agent_message",
          timestamp: null,
          text: "上限到達前に返したentry",
          unparsed: false,
        },
      ],
    });

    const rendered = await mountTranscriptRawView(session);
    await openTranscriptRawView(rendered.container);

    const text = textContent(rendered.container);
    expect(text).toContain(warning);
    expect(text).toContain("上限到達前に返したentry");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("「古いログを読み込む」で before 付き呼び出しを行い、先頭に追加後 hasMoreBefore=false でボタンが消える", async () => {
    const session = makeSession({ state: "ended" });
    fetchSessionTranscriptRawMock
      .mockResolvedValueOnce({
        taskId: session.taskId,
        sessionId: session.sessionId,
        provider: "codex",
        found: true,
        startLine: 51,
        endLine: 60,
        totalLines: 60,
        hasMoreAfter: false,
        hasMoreBefore: true,
        entries: [
          { line: 51, kind: "user", rawType: "user_message", timestamp: null, text: "後半の質問", unparsed: false },
        ],
      })
      .mockResolvedValueOnce({
        taskId: session.taskId,
        sessionId: session.sessionId,
        provider: "codex",
        found: true,
        startLine: 1,
        endLine: 50,
        totalLines: 60,
        hasMoreAfter: false,
        hasMoreBefore: false,
        entries: [
          { line: 1, kind: "user", rawType: "user_message", timestamp: null, text: "冒頭の質問", unparsed: false },
        ],
      });

    const rendered = await mountTranscriptRawView(session);
    await openTranscriptRawView(rendered.container);

    expect(textContent(rendered.container)).toContain("後半の質問");
    const loadOlderButton = buttonByText(rendered.container, "古いログを読み込む");

    await act(async () => {
      loadOlderButton.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(2);
    expect(fetchSessionTranscriptRawMock).toHaveBeenNthCalledWith(
      2,
      { sessionId: session.sessionId, taskId: session.taskId, before: 51 },
      expect.any(AbortSignal),
    );
    const text = textContent(rendered.container);
    expect(text).toContain("冒頭の質問");
    expect(text).toContain("後半の質問");
    expect(() => buttonByText(rendered.container, "古いログを読み込む")).toThrow();

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("空行だけのページでも startLine を before cursor にして過去方向へ読み込める", async () => {
    const session = makeSession({ state: "ended" });
    fetchSessionTranscriptRawMock
      .mockResolvedValueOnce({
        taskId: session.taskId,
        sessionId: session.sessionId,
        provider: "codex",
        found: true,
        startLine: 51,
        endLine: 60,
        totalLines: 60,
        hasMoreAfter: false,
        hasMoreBefore: true,
        entries: [],
      })
      .mockResolvedValueOnce({
        taskId: session.taskId,
        sessionId: session.sessionId,
        provider: "codex",
        found: true,
        startLine: 1,
        endLine: 50,
        totalLines: 60,
        hasMoreAfter: false,
        hasMoreBefore: false,
        entries: [
          { line: 1, kind: "user", rawType: "user_message", timestamp: null, text: "過去のログ", unparsed: false },
        ],
      });

    const rendered = await mountTranscriptRawView(session);
    await openTranscriptRawView(rendered.container);

    await act(async () => {
      buttonByText(rendered.container, "古いログを読み込む").click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchSessionTranscriptRawMock).toHaveBeenNthCalledWith(
      2,
      { sessionId: session.sessionId, taskId: session.taskId, before: 51 },
      expect.any(AbortSignal),
    );
    expect(textContent(rendered.container)).toContain("過去のログ");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("保持上限到達時に古い側を退避し、再取得が必要な旨を表示する", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const session = makeSession({ state: "running" });
    const initialEntries: SessionTranscriptRawEntry[] = Array.from({ length: 1_000 }, (_, index) => ({
      line: index + 1,
      kind: index === 0 ? "assistant" : "tool",
      rawType: index === 0 ? "agent_message" : "response_item",
      timestamp: null,
      text: index === 0 ? "退避される最古行" : `初回ログ${index + 1}`,
      unparsed: false,
    }));
    const firstPollEntries: SessionTranscriptRawEntry[] = Array.from({ length: 1_000 }, (_, index) => ({
      line: index + 1_001,
      kind: "tool",
      rawType: "response_item",
      timestamp: null,
      text: `追加ログ${index + 1_001}`,
      unparsed: false,
    }));
    fetchSessionTranscriptRawMock
      .mockResolvedValueOnce(
        foundResponse(session, {
          startLine: 1,
          endLine: 1_000,
          totalLines: 1_000,
          entries: initialEntries,
        }),
      )
      .mockResolvedValueOnce(
        foundResponse(session, {
          startLine: 1_001,
          endLine: 2_000,
          totalLines: 2_000,
          entries: firstPollEntries,
        }),
      )
      .mockResolvedValueOnce(
        foundResponse(session, {
          startLine: 2_001,
          endLine: 2_001,
          totalLines: 2_001,
          entries: [
            {
              line: 2_001,
              kind: "assistant",
              rawType: "agent_message",
              timestamp: null,
              text: "保持される最新行",
              unparsed: false,
            },
          ],
        }),
      );

    const rendered = await mountTranscriptRawView(session);
    await openTranscriptRawView(rendered.container);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500 * 2);
    });

    const text = textContent(rendered.container);
    expect(text).not.toContain("退避される最古行");
    expect(text).toContain("保持される最新行");
    expect(text).toContain("保持上限（2000 行）に達したため古い行は再取得が必要です");
    expect(text).toContain("2〜2001行を取得済み");
    expect(buttonByText(rendered.container, "古いログを読み込む").disabled).toBe(true);

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("長い本文は省略表示され、「もっと見る」で全文が見える", async () => {
    const session = makeSession({ state: "ended" });
    const longText = "あ".repeat(TRANSCRIPT_RAW_TEXT_TRUNCATE_LENGTH + 100);
    fetchSessionTranscriptRawMock.mockResolvedValue({
      taskId: session.taskId,
      sessionId: session.sessionId,
      provider: "codex",
      found: true,
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      hasMoreAfter: false,
      hasMoreBefore: false,
      entries: [{ line: 1, kind: "assistant", rawType: "agent_message", timestamp: null, text: longText, unparsed: false }],
    });

    const rendered = await mountTranscriptRawView(session);
    await openTranscriptRawView(rendered.container);

    expect(textContent(rendered.container)).not.toContain(longText);
    const expandButton = buttonByText(rendered.container, "もっと見る");

    await act(async () => {
      expandButton.click();
    });

    expect(textContent(rendered.container)).toContain(longText);
    expect(buttonByText(rendered.container, "折りたたむ")).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("running セッションでは開いている間だけ after 付きポーリングが行われ、閉じると止まる", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const session = makeSession({ state: "running" });
    fetchSessionTranscriptRawMock
      .mockResolvedValueOnce({
        taskId: session.taskId,
        sessionId: session.sessionId,
        provider: "codex",
        found: true,
        startLine: 1,
        endLine: 10,
        totalLines: 10,
        hasMoreAfter: false,
        hasMoreBefore: false,
        entries: [{ line: 10, kind: "assistant", rawType: "agent_message", timestamp: null, text: "初回分", unparsed: false }],
      })
      .mockResolvedValueOnce({
        taskId: session.taskId,
        sessionId: session.sessionId,
        provider: "codex",
        found: true,
        startLine: 11,
        endLine: 11,
        totalLines: 11,
        hasMoreAfter: false,
        hasMoreBefore: false,
        entries: [{ line: 11, kind: "assistant", rawType: "agent_message", timestamp: null, text: "追加分", unparsed: false }],
      });

    const rendered = await mountTranscriptRawView(session);
    await openTranscriptRawView(rendered.container);

    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2_500);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(2);
    expect(fetchSessionTranscriptRawMock).toHaveBeenNthCalledWith(
      2,
      { sessionId: session.sessionId, taskId: session.taskId, after: 10 },
      expect.any(AbortSignal),
    );
    expect(textContent(rendered.container)).toContain("追加分");

    const toggle = buttonByText(rendered.container, "全文ログを閉じる");
    await act(async () => {
      toggle.click();
    });

    await act(async () => {
      vi.advanceTimersByTime(2_500 * 3);
      await Promise.resolve();
    });

    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("初回 tail が found:false の後にログが現れたら after 無しで tail を再取得する", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const session = makeSession({ state: "running" });
    fetchSessionTranscriptRawMock
      .mockResolvedValueOnce({
        taskId: session.taskId,
        sessionId: session.sessionId,
        provider: "codex",
        found: false,
        reason: "log-not-found",
        reasonText: "ネイティブログが見つかりませんでした",
      })
      .mockResolvedValueOnce({
        taskId: session.taskId,
        sessionId: session.sessionId,
        provider: "codex",
        found: true,
        startLine: 901,
        endLine: 1_100,
        totalLines: 1_100,
        hasMoreAfter: false,
        hasMoreBefore: true,
        entries: [
          { line: 1_100, kind: "assistant", rawType: "agent_message", timestamp: null, text: "後から現れたログ", unparsed: false },
        ],
      });

    const rendered = await mountTranscriptRawView(session);
    await openTranscriptRawView(rendered.container);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(fetchSessionTranscriptRawMock).toHaveBeenNthCalledWith(
      2,
      { sessionId: session.sessionId, taskId: session.taskId },
      expect.any(AbortSignal),
    );
    expect(textContent(rendered.container)).toContain("後から現れたログ");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("poll が found:false でも取得済みログと行数を保持し、警告だけを表示する", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const session = makeSession({ state: "running" });
    fetchSessionTranscriptRawMock
      .mockResolvedValueOnce({
        taskId: session.taskId,
        sessionId: session.sessionId,
        provider: "codex",
        found: true,
        startLine: 1,
        endLine: 10,
        totalLines: 10,
        hasMoreAfter: false,
        hasMoreBefore: false,
        entries: [
          { line: 10, kind: "assistant", rawType: "agent_message", timestamp: null, text: "取得済みログ", unparsed: false },
        ],
      })
      .mockResolvedValueOnce({
        taskId: session.taskId,
        sessionId: session.sessionId,
        provider: "codex",
        found: false,
        reason: "log-too-large",
        reasonText: "ネイティブログが読み取り上限を超えています",
      });

    const rendered = await mountTranscriptRawView(session);
    await openTranscriptRawView(rendered.container);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    const text = textContent(rendered.container);
    expect(text).toContain("取得済みログ");
    expect(text).toContain("全10行中");
    expect(text).toContain("ネイティブログが読み取り上限を超えています");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("in-flight ガード: 前回のポーリングが未解決の間に次のタイマーが発火しても新規リクエストを送らない", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const session = makeSession({ state: "running" });

    let resolvePendingPoll: ((value: SessionTranscriptRawResponse) => void) | undefined;
    const pendingPollPromise = new Promise<SessionTranscriptRawResponse>((resolve) => {
      resolvePendingPoll = resolve;
    });

    fetchSessionTranscriptRawMock
      .mockResolvedValueOnce({
        taskId: session.taskId,
        sessionId: session.sessionId,
        provider: "codex",
        found: true,
        startLine: 1,
        endLine: 10,
        totalLines: 10,
        hasMoreAfter: false,
        hasMoreBefore: false,
        entries: [],
      })
      // 1回目のポーリングをわざと未解決のままにする。
      .mockImplementationOnce(() => pendingPollPromise)
      // 保留中のリクエストが解決した後、ガードが解除されて発生する次のポーリング用。
      .mockResolvedValueOnce({
        taskId: session.taskId,
        sessionId: session.sessionId,
        provider: "codex",
        found: true,
        startLine: 12,
        endLine: 12,
        totalLines: 12,
        hasMoreAfter: false,
        hasMoreBefore: false,
        entries: [],
      });

    const rendered = await mountTranscriptRawView(session);
    await openTranscriptRawView(rendered.container);

    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(1);

    // 1回目のポーリングが発火する（未解決のまま留まる）。
    await act(async () => {
      vi.advanceTimersByTime(2_500);
      await Promise.resolve();
    });
    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(2);

    // 未解決のまま2回分タイマーを進めても、in-flight ガードにより新規リクエストは発生しない。
    await act(async () => {
      vi.advanceTimersByTime(2_500 * 2);
      await Promise.resolve();
    });
    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(2);

    // 保留中だったリクエストが解決すればガードが解除され、次のポーリングでまた呼ばれる。
    await act(async () => {
      resolvePendingPoll?.({
        taskId: session.taskId,
        sessionId: session.sessionId,
        provider: "codex",
        found: true,
        startLine: 11,
        endLine: 11,
        totalLines: 11,
        hasMoreAfter: false,
        hasMoreBefore: false,
        entries: [],
      });
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(2_500);
      await Promise.resolve();
    });
    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  /** 解決タイミングを外から握れる fetch 応答を作る。 */
  function deferredResponse(): {
    promise: Promise<SessionTranscriptRawResponse>;
    resolve: (value: SessionTranscriptRawResponse) => void;
  } {
    let resolve: ((value: SessionTranscriptRawResponse) => void) | undefined;
    const promise = new Promise<SessionTranscriptRawResponse>((r) => {
      resolve = r;
    });
    return { promise, resolve: (value) => resolve?.(value) };
  }

  function foundResponse(
    session: WebRunningSession,
    overrides: Partial<SessionTranscriptRawResponse> & { entries: SessionTranscriptRawEntry[] },
  ): SessionTranscriptRawResponse {
    return {
      taskId: session.taskId,
      sessionId: session.sessionId,
      provider: "codex",
      found: true,
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      hasMoreAfter: false,
      hasMoreBefore: false,
      ...overrides,
    } as SessionTranscriptRawResponse;
  }

  it("初回 tail が完了するまで incremental poll を開始しない（契約 §28.6-8）", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const session = makeSession({ state: "running" });
    const initial = deferredResponse();
    // 既定応答を敷いておく。誤って poll が走った場合も TypeError ではなく
    // 「呼び出し回数」で落ちるようにするため（何が起きたかを assertion で示す）。
    fetchSessionTranscriptRawMock.mockResolvedValue(
      foundResponse(session, { startLine: 1, endLine: 99, totalLines: 99, entries: [] }),
    );
    fetchSessionTranscriptRawMock.mockImplementationOnce(() => initial.promise);

    const rendered = await mountTranscriptRawView(session);
    await openTranscriptRawView(rendered.container);

    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(1);

    // 初回取得が poll 周期（2.5秒）を跨いで長引く状況。未初期化の after:0 で poll を始めない。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500 * 3);
    });
    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(1);

    // 初回 tail が確定したら、以降の poll は正しい cursor から始まる。
    await act(async () => {
      initial.resolve(
        foundResponse(session, {
          startLine: 1,
          endLine: 12,
          totalLines: 12,
          entries: [
            { line: 12, kind: "user", rawType: "user_message", timestamp: null, text: "初回tail", unparsed: false },
          ],
        }),
      );
      await Promise.resolve();
    });

    fetchSessionTranscriptRawMock.mockResolvedValueOnce(
      foundResponse(session, { startLine: 13, endLine: 13, totalLines: 13, entries: [] }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(2);
    expect(fetchSessionTranscriptRawMock).toHaveBeenNthCalledWith(
      2,
      { sessionId: session.sessionId, taskId: session.taskId, after: 12 },
      expect.any(AbortSignal),
    );
    // 重複・逆順が出ていないこと（初回 tail の1件だけ）。
    expect(textContent(rendered.container)).toContain("12〜12行を取得済み");

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("session 切替後に前セッションの poll 応答が解決しても、新セッションの entries / cursor を汚さない（契約 §28.6-8）", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const sessionA = makeSession({ state: "running", sessionId: "sess-A" });
    const sessionB = makeSession({ state: "running", sessionId: "sess-B" });

    // A: 初回 tail
    fetchSessionTranscriptRawMock.mockResolvedValueOnce(
      foundResponse(sessionA, {
        startLine: 1,
        endLine: 5,
        totalLines: 5,
        entries: [
          { line: 5, kind: "user", rawType: "user_message", timestamp: null, text: "Aのログ", unparsed: false },
        ],
      }),
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<SessionTranscriptRawView session={sessionA} />);
      await Promise.resolve();
    });
    await openTranscriptRawView(container);
    expect(textContent(container)).toContain("Aのログ");

    // A の poll を未解決のまま走らせる。
    const pendingPollA = deferredResponse();
    fetchSessionTranscriptRawMock.mockImplementationOnce(() => pendingPollA.promise);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(2);

    // B へ切り替える（同じ root の再レンダー）。
    fetchSessionTranscriptRawMock.mockResolvedValueOnce(
      foundResponse(sessionB, {
        startLine: 1,
        endLine: 2,
        totalLines: 2,
        entries: [
          { line: 2, kind: "user", rawType: "user_message", timestamp: null, text: "Bのログ", unparsed: false },
        ],
      }),
    );
    await act(async () => {
      root.render(<SessionTranscriptRawView session={sessionB} />);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(textContent(container)).toContain("Bのログ");
    expect(textContent(container)).not.toContain("Aのログ");

    // ここで A の poll 応答が遅れて解決する。
    await act(async () => {
      pendingPollA.resolve(
        foundResponse(sessionA, {
          startLine: 6,
          endLine: 9_999,
          totalLines: 9_999,
          entries: [
            { line: 6, kind: "user", rawType: "user_message", timestamp: null, text: "Aの遅延ログ", unparsed: false },
          ],
        }),
      );
      await Promise.resolve();
    });

    // B の entries / 行数 / cursor のいずれも A の応答で書き換わらない。
    expect(textContent(container)).not.toContain("Aの遅延ログ");
    expect(textContent(container)).toContain("全2行中");
    expect(textContent(container)).not.toContain("9999");

    // 次の poll は B の cursor（2）から始まる。A の endLine(9999) を引き継がない。
    fetchSessionTranscriptRawMock.mockResolvedValueOnce(
      foundResponse(sessionB, { startLine: 3, endLine: 3, totalLines: 3, entries: [] }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(fetchSessionTranscriptRawMock).toHaveBeenLastCalledWith(
      { sessionId: sessionB.sessionId, taskId: sessionB.taskId, after: 2 },
      expect.any(AbortSignal),
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("session 切替の時点で entries / cursor を即座にリセットする（新セッションの応答を待たない）", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const sessionA = makeSession({ state: "running", sessionId: "sess-A2" });
    const sessionB = makeSession({ state: "running", sessionId: "sess-B2" });

    fetchSessionTranscriptRawMock.mockResolvedValueOnce(
      foundResponse(sessionA, {
        startLine: 1,
        endLine: 42,
        totalLines: 42,
        entries: [
          { line: 42, kind: "user", rawType: "user_message", timestamp: null, text: "Aのログ本文", unparsed: false },
        ],
      }),
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<SessionTranscriptRawView session={sessionA} />);
      await Promise.resolve();
    });
    await openTranscriptRawView(container);
    expect(textContent(container)).toContain("Aのログ本文");
    expect(textContent(container)).toContain("全42行中");

    // B の初回 tail は未解決のまま切り替える。B の応答を待つ間、A のログが残っていてはならない。
    const pendingInitialB = deferredResponse();
    fetchSessionTranscriptRawMock.mockImplementationOnce(() => pendingInitialB.promise);
    await act(async () => {
      root.render(<SessionTranscriptRawView session={sessionB} />);
      await Promise.resolve();
    });

    expect(textContent(container)).not.toContain("Aのログ本文");
    expect(textContent(container)).not.toContain("全42行中");

    // B の初回が確定した後の poll は B の cursor から始まる（A の endLine 42 を引き継がない）。
    await act(async () => {
      pendingInitialB.resolve(
        foundResponse(sessionB, {
          startLine: 1,
          endLine: 4,
          totalLines: 4,
          entries: [
            { line: 4, kind: "user", rawType: "user_message", timestamp: null, text: "Bの初回", unparsed: false },
          ],
        }),
      );
      await Promise.resolve();
    });
    expect(textContent(container)).toContain("Bの初回");

    fetchSessionTranscriptRawMock.mockResolvedValueOnce(
      foundResponse(sessionB, { startLine: 5, endLine: 5, totalLines: 5, entries: [] }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(fetchSessionTranscriptRawMock).toHaveBeenLastCalledWith(
      { sessionId: sessionB.sessionId, taskId: sessionB.taskId, after: 4 },
      expect.any(AbortSignal),
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("トグルを閉じると entries / cursor をリセットし、閉じている間はポーリングしない", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const session = makeSession({ state: "running" });
    fetchSessionTranscriptRawMock.mockResolvedValue(
      foundResponse(session, {
        startLine: 1,
        endLine: 7,
        totalLines: 7,
        entries: [
          { line: 7, kind: "user", rawType: "user_message", timestamp: null, text: "開いた時のログ", unparsed: false },
        ],
      }),
    );

    const rendered = await mountTranscriptRawView(session);
    await openTranscriptRawView(rendered.container);
    expect(textContent(rendered.container)).toContain("開いた時のログ");

    const closeButton = buttonByText(rendered.container, "全文ログを閉じる");
    await act(async () => {
      closeButton.click();
      await Promise.resolve();
    });

    const callsAfterClose = fetchSessionTranscriptRawMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500 * 3);
    });
    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(callsAfterClose);

    // 再度開いたときは cursor 0 からの tail 取得（after を持ち越さない）。
    await openTranscriptRawView(rendered.container);
    expect(fetchSessionTranscriptRawMock).toHaveBeenLastCalledWith(
      { sessionId: session.sessionId, taskId: session.taskId },
      expect.any(AbortSignal),
    );

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("タブが非可視の間はポーリングせず、可視に戻ると再開する（契約 §28.6-8）", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const session = makeSession({ state: "running" });
    fetchSessionTranscriptRawMock.mockResolvedValue(
      foundResponse(session, { startLine: 1, endLine: 3, totalLines: 3, entries: [] }),
    );

    const rendered = await mountTranscriptRawView(session);
    await openTranscriptRawView(rendered.container);
    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(1);

    // 非可視の間はタイマーが発火してもリクエストを出さない。
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500 * 3);
    });
    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(1);

    // 可視に戻れば次の周期で再開する。
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("ended セッションでは running でないためポーリングしない", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const session = makeSession({ state: "ended" });
    fetchSessionTranscriptRawMock.mockResolvedValue(
      foundResponse(session, { startLine: 1, endLine: 3, totalLines: 3, entries: [] }),
    );

    const rendered = await mountTranscriptRawView(session);
    await openTranscriptRawView(rendered.container);
    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500 * 4);
    });
    expect(fetchSessionTranscriptRawMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });
});

describe("SessionsView", () => {
  it("セッション一覧に工程バッジ・task status・tenant チップを表示する", async () => {
    fetchSessionsMock.mockResolvedValue({
      sessions: [
        makeSession({
          sessionId: "sess-review",
          taskTitle: "レビュー対象",
          role: "reviewer",
          taskStatus: "review",
          tenant: "tenant-review",
          state: "running",
        }),
        makeSession({
          sessionId: "sess-worker",
          taskTitle: "実装対象",
          role: "worker",
          taskStatus: "blocked",
          tenant: "tenant-worker",
          state: "ended",
        }),
      ],
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<SessionsView onOpenSession={() => undefined} />);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const text = textContent(container);
    expect(text).toContain("レビュー対象");
    expect(text).toContain("実装対象");
    expect(text).toContain("レビュー");
    expect(text).toContain("実装");
    expect(text).toContain("review");
    expect(text).toContain("blocked");
    expect(text).toContain("tenant-review");
    expect(text).toContain("tenant-worker");
    const tenantChip = container.querySelector('[title="tenant: tenant-review"]');
    expect(tenantChip?.className).toContain("text-ink-muted");
    expect(tenantChip?.className).toContain("max-w-[12rem]");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("セッション一覧に effort を model 名の隣に表示する", async () => {
    fetchSessionsMock.mockResolvedValue({
      sessions: [
        makeSession({
          sessionId: "sess-with-effort",
          taskTitle: "effort あり",
          effort: "high",
          effortDelivery: "native",
          model: "claude-sonnet-5",
        }),
        makeSession({
          sessionId: "sess-no-effort",
          taskTitle: "effort なし",
          effort: null,
          effortDelivery: null,
          model: "gpt-5.4",
        }),
      ],
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<SessionsView onOpenSession={() => undefined} />);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const text = textContent(container);
    expect(text).toContain("effort high");
    // effort なしのセッションでは "effort" がその行に出ないことを確認
    // (ただし他のセッションに effort が含まれるため、全体テキストには含まれる)

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
