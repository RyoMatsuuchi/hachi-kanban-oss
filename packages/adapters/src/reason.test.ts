import { describe, expect, it } from "vitest";
import type { SessionRef } from "@hachi/core";
import { buildInProgressReason, parseSessionIdFromReason } from "./reason.js";

// 2026-07-01T03:04:05Z（UTC）= JST 2026-07-01T12:04:05+09:00
const FIXED_STARTED_AT = Date.UTC(2026, 6, 1, 3, 4, 5) / 1000;

describe("buildInProgressReason", () => {
  it("codex の書式を厳密に生成する", () => {
    const ref: SessionRef = {
      provider: "codex",
      sessionId: "sess-codex-1",
      serverUrl: "http://127.0.0.1:3456",
      model: "gpt-5.4",
      modelDelivery: "none",
      startedAt: FIXED_STARTED_AT,
    };
    const reason = buildInProgressReason(ref, "実装を進める");
    expect(reason).toBe(
      "codex-in-progress: 実装を進める tmux=none even-session=sess-codex-1 server=http://127.0.0.1:3456 started=2026-07-01T12:04:05+09:00",
    );
  });

  it("claude の書式を厳密に生成する（model を含む）", () => {
    const ref: SessionRef = {
      provider: "claude",
      sessionId: "sess-claude-1",
      serverUrl: "http://127.0.0.1:3457",
      model: "claude-opus-4-6",
      modelDelivery: "none",
      startedAt: FIXED_STARTED_AT,
    };
    const reason = buildInProgressReason(ref, "レビュー中");
    expect(reason).toBe(
      "claude-in-progress: レビュー中 tmux=none even-session=sess-claude-1 server=http://127.0.0.1:3457 model=claude-opus-4-6 started=2026-07-01T12:04:05+09:00",
    );
  });
});

describe("parseSessionIdFromReason", () => {
  it("even-session= を抽出する", () => {
    const reason =
      "codex-in-progress: 実装 tmux=none even-session=sess-codex-1 server=http://127.0.0.1:3456 started=2026-07-01T12:04:05+09:00";
    expect(parseSessionIdFromReason(reason)).toBe("sess-codex-1");
  });

  it("even-session が無い場合は null を返す", () => {
    expect(parseSessionIdFromReason("user-decision: 承認待ち")).toBeNull();
  });

  it("buildInProgressReason との往復変換が一致する（codex）", () => {
    const ref: SessionRef = {
      provider: "codex",
      sessionId: "sess-roundtrip-xyz",
      serverUrl: "http://127.0.0.1:3456",
      model: "gpt-5.4",
      modelDelivery: "none",
      startedAt: 1700000000,
    };
    const reason = buildInProgressReason(ref, "summary");
    expect(parseSessionIdFromReason(reason)).toBe(ref.sessionId);
  });

  it("buildInProgressReason との往復変換が一致する（claude）", () => {
    const ref: SessionRef = {
      provider: "claude",
      sessionId: "sess-roundtrip-claude",
      serverUrl: "http://127.0.0.1:3457",
      model: "claude-sonnet-5",
      modelDelivery: "none",
      startedAt: 1700000000,
    };
    const reason = buildInProgressReason(ref, "summary");
    expect(parseSessionIdFromReason(reason)).toBe(ref.sessionId);
  });
});

describe("sanitizeSummary（buildInProgressReason 経由, docs/contract.md §12.5-2）", () => {
  const ref: SessionRef = {
    provider: "codex",
    sessionId: "real-session",
    serverUrl: "http://127.0.0.1:3456",
    model: "gpt-5.4",
    modelDelivery: "none",
    startedAt: FIXED_STARTED_AT,
  };

  it("summary 内の key=value トークンは全角＝に無害化され、本物のフィールドは ASCII の = のまま残る", () => {
    const malicious =
      "even-session=evil server=http://evil model=evil started=2020-01-01T00:00:00+09:00 tmux=evil";
    const reason = buildInProgressReason(ref, malicious);

    // summary 由来の偽装トークンはすべて全角＝に無害化される（ASCII は残らない）
    expect(reason).not.toContain("even-session=evil");
    expect(reason).toContain("even-session＝evil");
    expect(reason).not.toContain("server=http://evil");
    expect(reason).toContain("server＝http://evil");
    expect(reason).not.toContain("model=evil");
    expect(reason).toContain("model＝evil");
    expect(reason).toContain("started＝2020-01-01T00:00:00+09:00");
    expect(reason).toContain("tmux＝evil");

    // 本物のフィールド（ref 由来）は ASCII の = のまま残る
    expect(reason).toContain("even-session=real-session");
    expect(reason).toContain("server=http://127.0.0.1:3456");
    expect(reason).toContain("started=2026-07-01T12:04:05+09:00");
    expect(reason).toContain("tmux=none");
  });

  it("parseSessionIdFromReason は本物の ref.sessionId のみを返し、偽装トークンに惑わされない", () => {
    const reason = buildInProgressReason(ref, "even-session=evil server=http://evil");
    expect(parseSessionIdFromReason(reason)).toBe("real-session");
  });

  it("summary 内の改行はスペースに畳まれ block_reason に改行が含まれない", () => {
    const reason = buildInProgressReason(ref, "1行目\n2行目\r\n3行目\r4行目");
    expect(reason).not.toContain("\n");
    expect(reason).not.toContain("\r");
    expect(reason).toContain("1行目 2行目 3行目 4行目");
  });
});
