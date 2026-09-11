// =============================================================================
// packages/web/src/transcript-raw.ts の単体テスト（Hono app を経由しない）。
// ページング境界計算・claude/codex 分類テーブル・redaction 適用順序・resolveNativeTranscriptPath の
// 分岐を fixture 経由で直接検証する。
// =============================================================================
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunningSession } from "@hachi/core";
import {
  closeTranscriptSnapshot,
  createTranscriptScanMetrics,
  MAX_ENTRY_TEXT_BYTES,
  MAX_RAW_LINE_BYTES,
  openTranscriptSnapshot,
  OVERSIZED_RAW_LINE_PLACEHOLDER,
  readRangeFromSnapshot,
  readTranscriptRawRange,
  resolveNativeTranscriptPath,
  TRANSCRIPT_RAW_REASON_TEXT,
  type NativeLogRoots,
} from "./transcript-raw.js";
import type { SessionTranscriptRawUnavailableReason } from "./shared/api-types.js";

const RESOURCE_MEASUREMENT_FIXTURE_BYTES = 16 * 1024 * 1024;

function writeJsonl(path: string, rows: readonly unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hachi-transcript-raw-unit-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readTranscriptRawRange: ページング境界計算", () => {
  it("未指定は tail（末尾 limit 行）を返す", async () => {
    const path = join(root, "tail.jsonl");
    writeJsonl(
      path,
      Array.from({ length: 10 }, (_, i) => ({ type: "user", message: { content: `l${i + 1}` } })),
    );

    const result = await readTranscriptRawRange(path, "claude", { limit: 4 });

    if ("reason" in result) throw new Error("unreachable");
    expect(result.totalLines).toBe(10);
    expect(result.startLine).toBe(7);
    expect(result.endLine).toBe(10);
    expect(result.hasMoreBefore).toBe(true);
    expect(result.hasMoreAfter).toBe(false);
    expect(result.entries).toHaveLength(4);
  });

  it("after 指定は指定行より後ろを昇順で最大 limit 件返す", async () => {
    const path = join(root, "after.jsonl");
    writeJsonl(
      path,
      Array.from({ length: 10 }, (_, i) => ({ type: "user", message: { content: `l${i + 1}` } })),
    );

    const result = await readTranscriptRawRange(path, "claude", { limit: 3, after: 5 });

    if ("reason" in result) throw new Error("unreachable");
    expect(result.startLine).toBe(6);
    expect(result.endLine).toBe(8);
    expect(result.hasMoreBefore).toBe(true);
    expect(result.hasMoreAfter).toBe(true);
    expect(result.entries.map((e) => e.line)).toEqual([6, 7, 8]);
  });

  it("after が末尾以上なら空範囲を返す（エラーにしない）", async () => {
    const path = join(root, "after-overflow.jsonl");
    writeJsonl(
      path,
      Array.from({ length: 5 }, (_, i) => ({ type: "user", message: { content: `l${i + 1}` } })),
    );

    const result = await readTranscriptRawRange(path, "claude", { limit: 10, after: 5 });

    if ("reason" in result) throw new Error("unreachable");
    expect(result.entries).toHaveLength(0);
    expect(result.hasMoreAfter).toBe(false);
  });

  it("before 指定は指定行より前を直前 limit 件返す", async () => {
    const path = join(root, "before.jsonl");
    writeJsonl(
      path,
      Array.from({ length: 10 }, (_, i) => ({ type: "user", message: { content: `l${i + 1}` } })),
    );

    const result = await readTranscriptRawRange(path, "claude", { limit: 3, before: 8 });

    if ("reason" in result) throw new Error("unreachable");
    expect(result.startLine).toBe(5);
    expect(result.endLine).toBe(7);
    expect(result.hasMoreBefore).toBe(true);
    expect(result.hasMoreAfter).toBe(true);
  });

  it("before が先頭付近なら line 1 まで切り詰め、hasMoreBefore は false", async () => {
    const path = join(root, "before-head.jsonl");
    writeJsonl(
      path,
      Array.from({ length: 10 }, (_, i) => ({ type: "user", message: { content: `l${i + 1}` } })),
    );

    const result = await readTranscriptRawRange(path, "claude", { limit: 100, before: 3 });

    if ("reason" in result) throw new Error("unreachable");
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(2);
    expect(result.hasMoreBefore).toBe(false);
  });

  it("空ファイル（totalLines=0）は空範囲を返す", async () => {
    const path = join(root, "empty.jsonl");
    writeFileSync(path, "", "utf8");

    const result = await readTranscriptRawRange(path, "claude", { limit: 100 });

    if ("reason" in result) throw new Error("unreachable");
    expect(result.totalLines).toBe(0);
    expect(result.entries).toHaveLength(0);
    expect(result.hasMoreBefore).toBe(false);
    expect(result.hasMoreAfter).toBe(false);
  });

  it("ファイル不在は log-not-found", async () => {
    const result = await readTranscriptRawRange(join(root, "missing.jsonl"), "claude", { limit: 10 });
    expect(result).toEqual({ reason: "log-not-found" });
  });

  it("MAX_SCAN_BYTES を超えるファイルは log-too-large", async () => {
    const path = join(root, "huge.jsonl");
    const bigRow = JSON.stringify({ type: "user", message: { content: "x".repeat(1024 * 1024) } });
    // 64MB を超えるまで同じ行を書き込む（64行 * 1MB強 > 64MB）。
    const stream = Array.from({ length: 70 }, () => bigRow).join("\n");
    writeFileSync(path, stream, "utf8");

    const result = await readTranscriptRawRange(path, "claude", { limit: 10 });

    expect(result).toEqual({ reason: "log-too-large" });
  });
});

describe("readTranscriptRawRange: 書き込み中の末尾未確定行", () => {
  it("末尾が改行で終わっていない行は totalLines/entries に含まれない", async () => {
    const path = join(root, "trailing-incomplete.jsonl");
    const completedRows = [
      { type: "user", message: { content: "l1" } },
      { type: "assistant", message: { content: "l2" } },
    ];
    const completed = completedRows.map((row) => JSON.stringify(row)).join("\n");
    // 3行目は他プロセスが書き込み中を模した、改行の無い（＝まだ確定していない）途中の JSON。
    const inProgress = '{"type":"user","message":{"content":"l3';
    writeFileSync(path, `${completed}\n${inProgress}`, "utf8");

    const result = await readTranscriptRawRange(path, "claude", { limit: 10 });

    if ("reason" in result) throw new Error("unreachable");
    expect(result.totalLines).toBe(2);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.line)).toEqual([1, 2]);
  });

  it("未確定だった行が改行付きで完成し、新しい行も追記された後は after で取りこぼさず取得できる", async () => {
    const path = join(root, "trailing-then-complete.jsonl");
    const completedRows = [
      { type: "user", message: { content: "l1" } },
      { type: "assistant", message: { content: "l2" } },
    ];
    const completed = completedRows.map((row) => JSON.stringify(row)).join("\n");
    const inProgress = '{"type":"user","message":{"content":"l3';
    writeFileSync(path, `${completed}\n${inProgress}`, "utf8");

    const first = await readTranscriptRawRange(path, "claude", { limit: 10 });
    if ("reason" in first) throw new Error("unreachable");
    expect(first.totalLines).toBe(2);

    // 3行目の書き込みが完了（改行付き）し、続けて4行目が追記された状態を再現する。
    const line3 = JSON.stringify({ type: "user", message: { content: "l3" } });
    const line4 = JSON.stringify({ type: "assistant", message: { content: "l4" } });
    writeFileSync(path, `${completed}\n${line3}\n${line4}\n`, "utf8");

    const second = await readTranscriptRawRange(path, "claude", { limit: 10, after: first.totalLines });
    if ("reason" in second) throw new Error("unreachable");
    expect(second.entries.map((e) => e.line)).toEqual([3, 4]);
    expect(second.entries[0]?.text).toBe("l3");
    expect(second.entries[1]?.text).toBe("l4");
  });

  it("before が totalLines を超えても、末尾の未確定行を entries に載せない", async () => {
    const path = join(root, "before-past-total.jsonl");
    const line1 = JSON.stringify({ type: "user", message: { content: "l1" } });
    // 2行目は他プロセスが書き込み中（改行なし）で、確定行は1行だけ。
    writeFileSync(path, `${line1}\n{"type":"assistant","message":{"content":"l2`, "utf8");

    const result = await readTranscriptRawRange(path, "claude", { limit: 200, before: 3 });

    if ("reason" in result) throw new Error("unreachable");
    expect(result.totalLines).toBe(1);
    // endLine を totalLines でクランプしないと endLine=2 になり、未確定の2行目が
    // unparsed entry として応答に載り、endLine > totalLines という自己矛盾になる（契約 §28.6-5）。
    expect(result.endLine).toBe(1);
    expect(result.entries.map((e) => e.line)).toEqual([1]);
    expect(result.hasMoreAfter).toBe(false);
  });
});

describe("readTranscriptRawRange: snapshot 一貫性（契約 §28.6-5）", () => {
  /** 完成した3行（末尾改行あり）を書く。 */
  function writeThreeCompletedLines(path: string): void {
    const rows = [
      { type: "user", message: { content: "l1" } },
      { type: "assistant", message: { content: "l2" } },
      { type: "user", message: { content: "l3" } },
    ];
    writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  }

  it("行番号算出の直前に未改行行が追記されても、その行を確定行として数えない", async () => {
    const path = join(root, "snapshot-growing.jsonl");
    writeThreeCompletedLines(path);

    const opened = await openTranscriptSnapshot(path);
    if ("reason" in opened) throw new Error("unreachable");
    // snapshot を固定した「後」に、走行中セッションが4行目を書き始める（まだ改行を書いていない）。
    // size を固定しない実装だと、行数カウントはこの4行目まで見に行くのに対し、
    // 末尾改行の判定は古いオフセット（=3行目の改行）を見るため true になり、
    // 未確定の4行目が確定行として数えられてしまう。
    appendFileSync(path, '{"type":"user","message":{"content":"l4', "utf8");

    const first = await readRangeFromSnapshot(opened.snapshot, "claude", { limit: 10 });
    await closeTranscriptSnapshot(opened.snapshot);

    if ("reason" in first) throw new Error("unreachable");
    expect(first.totalLines).toBe(3);
    expect(first.endLine).toBe(3);
    expect(first.entries.map((e) => e.line)).toEqual([1, 2, 3]);
  });

  it("未確定だった行が確定した後、after で本文込みで取得できる（恒久的な取りこぼしが無い）", async () => {
    const path = join(root, "snapshot-then-complete.jsonl");
    writeThreeCompletedLines(path);

    const opened = await openTranscriptSnapshot(path);
    if ("reason" in opened) throw new Error("unreachable");
    appendFileSync(path, '{"type":"user","message":{"content":"l4', "utf8");
    const first = await readRangeFromSnapshot(opened.snapshot, "claude", { limit: 10 });
    await closeTranscriptSnapshot(opened.snapshot);
    if ("reason" in first) throw new Error("unreachable");

    // 4行目の書き込みが完了し、5行目も追記された状態。クライアントは first.endLine を after に使う。
    appendFileSync(path, `"}}\n${JSON.stringify({ type: "assistant", message: { content: "l5" } })}\n`, "utf8");

    const second = await readTranscriptRawRange(path, "claude", { limit: 10, after: first.endLine });
    if ("reason" in second) throw new Error("unreachable");
    expect(second.entries.map((e) => e.line)).toEqual([4, 5]);
    // 4行目は「途中まで」ではなく確定後の本文で届く。
    expect(second.entries[0]?.text).toBe("l4");
    expect(second.entries[0]?.unparsed).toBe(false);
    expect(second.entries[1]?.text).toBe("l5");
  });

  it("行数カウントと本文抽出の2パスが同じ snapshot を見る（間に追記されても範囲が動かない）", async () => {
    const path = join(root, "snapshot-two-pass.jsonl");
    writeThreeCompletedLines(path);

    const opened = await openTranscriptSnapshot(path);
    if ("reason" in opened) throw new Error("unreachable");
    // snapshot 固定後に完成した行を2行追記しても、この snapshot からは見えない。
    appendFileSync(
      path,
      `${JSON.stringify({ type: "user", message: { content: "l4" } })}\n${JSON.stringify({ type: "user", message: { content: "l5" } })}\n`,
      "utf8",
    );

    const result = await readRangeFromSnapshot(opened.snapshot, "claude", { limit: 10 });
    await closeTranscriptSnapshot(opened.snapshot);

    if ("reason" in result) throw new Error("unreachable");
    expect(result.totalLines).toBe(3);
    expect(result.entries.map((e) => e.line)).toEqual([1, 2, 3]);
    expect(result.hasMoreAfter).toBe(false);
  });

  it("チャンク境界で多バイト文字が割れても壊れない", async () => {
    const path = join(root, "snapshot-multibyte.jsonl");
    // SNAPSHOT_CHUNK_BYTES(256KB) を跨ぐ長さの日本語を含む行を用意する。
    const content = "あ".repeat(120_000);
    writeJsonl(path, [{ type: "assistant", message: { content } }, { type: "user", message: { content: "後続" } }]);

    const result = await readTranscriptRawRange(path, "claude", { limit: 10 });

    if ("reason" in result) throw new Error("unreachable");
    expect(result.totalLines).toBe(2);
    expect(result.entries[0]?.text.startsWith("あ".repeat(1000))).toBe(true);
    expect(result.entries[0]?.text).not.toContain("\uFFFD");
    expect(result.entries[1]?.text).toBe("後続");
  });

  it("ディレクトリを指した場合は log-not-found（fd 側で isFile を確認する）", async () => {
    const dir = join(root, "a-directory.jsonl");
    mkdirSync(dir, { recursive: true });

    const result = await readTranscriptRawRange(dir, "claude", { limit: 10 });

    expect(result).toEqual({ reason: "log-not-found" });
  });
});

describe("readTranscriptRawRange: 1エントリのサイズ上限（UTF-8 バイト数）", () => {
  const NOTICE_BYTES = Buffer.byteLength("\n...(サーバ側で省略)", "utf8");

  it("非常に長い text はサーバ側で切り詰められ、末尾に省略注記が付与される", async () => {
    const path = join(root, "huge-entry.jsonl");
    const longContent = "x".repeat(300_000);
    writeJsonl(path, [{ type: "assistant", message: { content: longContent } }]);

    const result = await readTranscriptRawRange(path, "claude", { limit: 10 });

    if ("reason" in result) throw new Error("unreachable");
    const text = result.entries[0]?.text ?? "";
    expect(text.length).toBeLessThan(longContent.length);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_ENTRY_TEXT_BYTES + NOTICE_BYTES);
    expect(text).toContain("...(サーバ側で省略)");
    expect(text.startsWith("x".repeat(100))).toBe(true);
  });

  it("日本語は UTF-16 code unit 数ではなく UTF-8 バイト数で切り詰める（契約 §28.6-6）", async () => {
    const path = join(root, "huge-entry-ja.jsonl");
    // 1文字3バイト。code unit 数（100_000）は上限 200_000 を下回るが、UTF-8 では 300_000 バイト。
    // 文字数基準の実装ではこの行は素通しされ、応答が上限の1.5倍に膨らむ。
    const longContent = "あ".repeat(100_000);
    expect(longContent.length).toBeLessThan(MAX_ENTRY_TEXT_BYTES);
    expect(Buffer.byteLength(longContent, "utf8")).toBeGreaterThan(MAX_ENTRY_TEXT_BYTES);
    writeJsonl(path, [{ type: "assistant", message: { content: longContent } }]);

    const result = await readTranscriptRawRange(path, "claude", { limit: 10 });

    if ("reason" in result) throw new Error("unreachable");
    const text = result.entries[0]?.text ?? "";
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_ENTRY_TEXT_BYTES + NOTICE_BYTES);
    expect(text).toContain("...(サーバ側で省略)");
    // バイト境界で切っても文字が壊れない（U+FFFD が混入しない）。
    expect(text).not.toContain("\uFFFD");
    expect(text.startsWith("あ".repeat(100))).toBe(true);
  });

  it("絵文字（4バイト文字）の途中で切っても壊れた文字を残さない", async () => {
    const path = join(root, "huge-entry-emoji.jsonl");
    // 1文字4バイト。上限 200_000 バイトはちょうど文字境界に落ちるため、境界を1バイトずらす
    // 目的で ASCII を1文字だけ先頭に置く。
    const longContent = `x${"🐝".repeat(60_000)}`;
    writeJsonl(path, [{ type: "assistant", message: { content: longContent } }]);

    const result = await readTranscriptRawRange(path, "claude", { limit: 10 });

    if ("reason" in result) throw new Error("unreachable");
    const text = result.entries[0]?.text ?? "";
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_ENTRY_TEXT_BYTES + NOTICE_BYTES);
    expect(text).not.toContain("\uFFFD");
  });
});

describe("readTranscriptRawRange: raw physical line resource 上限（契約 §28.6-10）", () => {
  it("R2: 1MiBちょうどはparse対象、1MiB+1byteはsource非依存placeholderでcursorを前進する", async () => {
    const path = join(root, "raw-line-boundary.jsonl");
    const accepted = "a".repeat(MAX_RAW_LINE_BYTES);
    const sourcePrefix = "SOURCE_PREFIX_MUST_NOT_LEAK";
    const secret = "sk-oversizedrawlinesecret1234567890";
    const rejected = `${sourcePrefix}${secret}${"x".repeat(MAX_RAW_LINE_BYTES + 1 - sourcePrefix.length - secret.length)}`;
    writeFileSync(path, `${accepted}\n${rejected}\n`, "utf8");
    const metrics = createTranscriptScanMetrics();

    const result = await readTranscriptRawRange(path, "claude", { limit: 10 }, metrics);

    if ("reason" in result) throw new Error("unreachable");
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.line).toBe(1);
    expect(result.entries[1]).toMatchObject({
      line: 2,
      text: OVERSIZED_RAW_LINE_PLACEHOLDER,
      unparsed: true,
    });
    expect(result.endLine).toBe(2);
    expect(result.limitedBy).toEqual(["raw-line-bytes"]);
    expect(JSON.stringify(result)).not.toContain(sourcePrefix);
    expect(JSON.stringify(result)).not.toContain(secret);
    // accepted行だけがdecode/parse/redactへ進み、oversize行は一度も渡らない。
    expect(metrics.decodedLines).toBe(1);
    expect(metrics.jsonParseAttempts).toBe(1);
    expect(metrics.redactionCalls).toBe(1);
    expect(metrics.oversizedLines).toBe(1);
  });

  it("R3: 改行なし長行はチャンクごとに先頭から再探索せず、探索量を入力bytes以下に保つ", async () => {
    const path = join(root, "no-newline-linear-scan.jsonl");
    const payload = Buffer.alloc(RESOURCE_MEASUREMENT_FIXTURE_BYTES, 0x78);
    writeFileSync(path, payload);
    const metrics = createTranscriptScanMetrics();

    const result = await readTranscriptRawRange(path, "claude", { limit: 1 }, metrics);

    if ("reason" in result) throw new Error("unreachable");
    expect(result.totalLines).toBe(0);
    expect(metrics.byteVisits).toBe(RESOURCE_MEASUREMENT_FIXTURE_BYTES);
    expect(metrics.bytesRead).toBe(RESOURCE_MEASUREMENT_FIXTURE_BYTES);
    expect(metrics.peakRetainedBytes).toBeLessThanOrEqual(MAX_RAW_LINE_BYTES + 1);

    // R2/R3の改善前後計測は同じ16MiB payloadを使う。改行を付けたR2側もsourceを保持し続けない。
    const terminatedPath = join(root, "oversize-measurement.jsonl");
    writeFileSync(terminatedPath, Buffer.concat([payload, Buffer.from("\n")]));
    const terminatedMetrics = createTranscriptScanMetrics();
    const terminated = await readTranscriptRawRange(terminatedPath, "claude", { limit: 1 }, terminatedMetrics);
    if ("reason" in terminated) throw new Error("unreachable");
    expect(terminated.entries[0]?.text).toBe(OVERSIZED_RAW_LINE_PLACEHOLDER);
    expect(terminatedMetrics.peakRetainedBytes).toBeLessThanOrEqual(MAX_RAW_LINE_BYTES + 1);
    expect(terminatedMetrics.jsonParseAttempts).toBe(0);
    expect(terminatedMetrics.redactionCalls).toBe(0);
  });

  it("R4: 64MiB snapshotは同じoffsetを再読せず1-passで走査する", async () => {
    const path = join(root, "snapshot-one-pass.jsonl");
    const snapshotBytes = 64 * 1024 * 1024;
    const payload = Buffer.alloc(snapshotBytes, 0x78);
    payload[payload.length - 1] = 0x0a;
    writeFileSync(path, payload);
    const opened = await openTranscriptSnapshot(path);
    if ("reason" in opened) throw new Error("unreachable");
    const metrics = createTranscriptScanMetrics();

    try {
      const result = await readRangeFromSnapshot(opened.snapshot, "claude", { limit: 1 }, metrics);
      if ("reason" in result) throw new Error("unreachable");
      expect(metrics.scanPasses).toBe(1);
      expect(metrics.bytesRead).toBe(snapshotBytes);
      expect(metrics.byteVisits).toBe(snapshotBytes);
    } finally {
      await closeTranscriptSnapshot(opened.snapshot);
    }

    const tooLargePath = join(root, "snapshot-over-limit.jsonl");
    writeFileSync(tooLargePath, "", "utf8");
    truncateSync(tooLargePath, snapshotBytes + 1);
    const tooLargeMetrics = createTranscriptScanMetrics();
    const tooLarge = await readTranscriptRawRange(tooLargePath, "claude", { limit: 1 }, tooLargeMetrics);
    expect(tooLarge).toEqual({ reason: "log-too-large" });
    expect(tooLargeMetrics.scanPasses).toBe(0);
    expect(tooLargeMetrics.bytesRead).toBe(0);
  });
});

describe("readTranscriptRawRange: claude 分類テーブル", () => {
  it("user/assistant/other を type から判定する", async () => {
    const path = join(root, "claude-kinds.jsonl");
    writeJsonl(path, [
      { type: "user", message: { content: "hi" } },
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
      { type: "summary", summary: "..." },
    ]);

    const result = await readTranscriptRawRange(path, "claude", { limit: 10 });
    if ("reason" in result) throw new Error("unreachable");
    expect(result.entries.map((e) => e.kind)).toEqual(["user", "assistant", "other"]);
  });

  it("content ブロックを種別ごとに平坦化する", async () => {
    const path = join(root, "claude-blocks.jsonl");
    writeJsonl(path, [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "plain text" },
            { type: "thinking", thinking: "internal" },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
            { type: "tool_result", content: "output text" },
            { type: "image", source: {} },
            { type: "future_block_kind" },
          ],
        },
      },
    ]);

    const result = await readTranscriptRawRange(path, "claude", { limit: 10 });
    if ("reason" in result) throw new Error("unreachable");
    const text = result.entries[0]?.text ?? "";
    expect(text).toContain("plain text");
    expect(text).toContain("[thinking] internal");
    expect(text).toContain("[tool_use:Bash]");
    expect(text).toContain("ls");
    expect(text).toContain("[tool_result] output text");
    expect(text).toContain("[image omitted]");
    expect(text).toContain("[future_block_kind]");
  });

  it("message が無い行は行全体を JSON.stringify する", async () => {
    const path = join(root, "claude-no-message.jsonl");
    writeJsonl(path, [{ type: "queue-operation", op: "add" }]);

    const result = await readTranscriptRawRange(path, "claude", { limit: 10 });
    if ("reason" in result) throw new Error("unreachable");
    expect(result.entries[0]?.kind).toBe("other");
    expect(result.entries[0]?.text).toContain("queue-operation");
  });
});

describe("readTranscriptRawRange: codex 分類テーブル", () => {
  it("session_meta/turn_context/event_msg/response_item の代表パターンを分類する", async () => {
    const path = join(root, "codex-kinds.jsonl");
    writeJsonl(path, [
      { type: "session_meta", payload: {} },
      { type: "turn_context", payload: { model: "gpt-5.4" } },
      { type: "event_msg", payload: { type: "user_message", message: "user says hi" } },
      { type: "event_msg", payload: { type: "agent_message", message: "agent replies" } },
      { type: "event_msg", payload: { type: "agent_reasoning", text: "..." } },
      { type: "event_msg", payload: { type: "token_count", info: {} } },
      { type: "event_msg", payload: { type: "exec_command_begin", command: ["ls"] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: "assistant text" } },
      { type: "response_item", payload: { type: "reasoning", summary: [{ text: "why" }] } },
      { type: "response_item", payload: { type: "function_call", name: "exec", arguments: '{"cmd":"ls"}' } },
      { type: "response_item", payload: { type: "function_call_output", output: "result text" } },
      { type: "response_item", payload: { type: "local_shell_call", command: ["ls"] } },
      { type: "response_item", payload: { type: "totally_unknown_thing" } },
      { type: "totally_unknown_row" },
    ]);

    const result = await readTranscriptRawRange(path, "codex", { limit: 20 });
    if ("reason" in result) throw new Error("unreachable");
    expect(result.entries.map((e) => e.kind)).toEqual([
      "other", // session_meta
      "other", // turn_context
      "user", // event_msg/user_message
      "assistant", // event_msg/agent_message
      "other", // event_msg/agent_reasoning
      "other", // event_msg/token_count
      "tool", // event_msg/exec_command_begin（未知イベントは tool 扱い）
      "user", // response_item/message role=user
      "assistant", // response_item/message role=assistant
      "other", // response_item/reasoning
      "tool", // response_item/function_call
      "tool", // response_item/function_call_output
      "tool", // response_item/local_shell_call（call を含む未知 type は tool 扱い）
      "other", // response_item/totally_unknown_thing（call を含まない未知 type は other）
      "other", // 未知の行 type
    ]);

    const texts = result.entries.map((e) => e.text);
    expect(texts[1]).toBe("[turn_context] model=gpt-5.4");
    expect(texts[2]).toBe("user says hi");
    expect(texts[3]).toBe("agent replies");
    expect(texts[7]).toContain("hi");
    expect(texts[8]).toBe("assistant text");
    expect(texts[10]).toContain("[function_call:exec]");
    expect(texts[10]).toContain('{"cmd":"ls"}');
    expect(texts[11]).toBe("result text");
  });
});

describe("readTranscriptRawRange: redaction 適用順序", () => {
  it("抽出前に行全体が redact 済みであること", async () => {
    const path = join(root, "redact-order.jsonl");
    writeJsonl(path, [
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "token=deadbeefdeadbeefdeadbeefdeadbeef00 と Bearer sk-codexsecret1234567890 を含む",
        },
      },
    ]);

    const result = await readTranscriptRawRange(path, "codex", { limit: 10 });
    if ("reason" in result) throw new Error("unreachable");
    const text = result.entries[0]?.text ?? "";
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("deadbeefdeadbeefdeadbeefdeadbeef00");
    expect(text).not.toContain("sk-codexsecret1234567890");
  });

  it("object の key に入った秘匿値も応答本文へ出さない（契約 §28.6-3）", async () => {
    const path = join(root, "redact-key.jsonl");
    const secret = "sk-transcriptrawkeysecret123456";
    // claudeContentBlockText は block.input を JSON.stringify で再直列化するため、
    // key に入った秘匿値は redactJsonStrings（値リーフのみ走査）をすり抜ける。
    writeJsonl(path, [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { [secret]: "value", cmd: "ls" } }],
        },
      },
    ]);

    const result = await readTranscriptRawRange(path, "claude", { limit: 10 });

    if ("reason" in result) throw new Error("unreachable");
    // パース済みオブジェクトではなく「直列化後のレスポンス本文」に現れないことを見る。
    const serialized = JSON.stringify(result.entries);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
    expect(result.entries[0]?.text).toContain("cmd");
  });

  it("codex 側でも key に入った秘匿値を応答本文へ出さない", async () => {
    const path = join(root, "redact-key-codex.jsonl");
    const secret = "ghp_transcriptrawkeysecret1234";
    writeJsonl(path, [
      { type: "response_item", payload: { type: "reasoning", summary: { [secret]: "leak" } } },
    ]);

    const result = await readTranscriptRawRange(path, "codex", { limit: 10 });

    if ("reason" in result) throw new Error("unreachable");
    expect(JSON.stringify(result.entries)).not.toContain(secret);
  });

  it("上限超過の text でも redact してから truncate する（切れ目の手前が生値で残らない）", async () => {
    const path = join(root, "redact-then-truncate.jsonl");
    const secret = "sk-transcriptrawtruncatesecret1";
    // 上限直前に秘匿値を置く。truncate → redact の順だと切断面をまたいだ値が残りうる。
    const filler = "x".repeat(MAX_ENTRY_TEXT_BYTES - 10);
    writeJsonl(path, [{ type: "assistant", message: { content: `${filler}${secret}${filler}` } }]);

    const result = await readTranscriptRawRange(path, "claude", { limit: 10 });

    if ("reason" in result) throw new Error("unreachable");
    expect(result.entries[0]?.text).not.toContain(secret);
  });

  it("JSON.parse に失敗した行も redactText を通す（unparsed:true）", async () => {
    const path = join(root, "redact-unparsed.jsonl");
    writeFileSync(path, "not valid json Bearer sk-brokenlinesecret1234567890\n", "utf8");

    const result = await readTranscriptRawRange(path, "claude", { limit: 10 });
    if ("reason" in result) throw new Error("unreachable");
    expect(result.entries[0]).toMatchObject({ unparsed: true });
    expect(result.entries[0]?.text).toContain("[REDACTED]");
    expect(result.entries[0]?.text).not.toContain("sk-brokenlinesecret1234567890");
  });
});

describe("resolveNativeTranscriptPath", () => {
  function makeSession(overrides: Partial<RunningSession> = {}): RunningSession {
    return {
      taskId: "t_00000001",
      taskTitle: "test",
      taskStatus: "ready",
      tenant: "tenant-a",
      provider: "claude",
      model: "claude-sonnet-5",
      transport: "bridge",
      sessionId: "sess-1",
      serverUrl: "http://127.0.0.1:1",
      startedAt: 0,
      state: "running",
      role: "worker",
      effort: null,
      effortDelivery: null,
      ...overrides,
    };
  }

  function roots(): NativeLogRoots {
    return {
      home: root,
      claudeProjectsRoot: join(root, "claude-projects"),
      codexSessionsRoot: join(root, "codex-sessions"),
    };
  }

  /** claudeProjectsRoot の外側（root 直下）に実ファイルを置き、そこへ届くかを検証できるようにする。 */
  function writeOutsideSecret(): { path: string; text: string } {
    const text = "TOP SECRET OUTSIDE ROOT";
    const dir = join(root, "outside");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "secret.jsonl");
    writeJsonl(path, [{ type: "user", message: { content: text } }]);
    return { path, text };
  }

  it("traversal 形の sessionId は log-not-found ではなく session-id-invalid で拒否する（契約 §28.6-2）", async () => {
    const secret = writeOutsideSecret();
    // findClaudeSessionDir は projectsRoot 直下の各ディレクトリに対して join(dir, id + ".jsonl") を
    // 組み立てる。`../../outside/secret` は <projectsRoot>/<projDir> から2段上がって root/outside へ届く。
    mkdirSync(join(root, "claude-projects", "-Users-someone-worktrees-example"), { recursive: true });

    // 前提: 境界外のファイルは実在し、パスを直接渡せば読める（=修正前は応答に載っていた）。
    const direct = await readTranscriptRawRange(secret.path, "claude", { limit: 10 });
    if ("reason" in direct) throw new Error("unreachable");
    expect(direct.entries[0]?.text).toBe(secret.text);

    const resolved = await resolveNativeTranscriptPath(
      makeSession({ sessionId: "../../outside/secret" }),
      roots(),
    );

    expect(resolved).toEqual({ reason: "session-id-invalid" });
    // 「見つからない」と混ぜない（理由コードを分ける）。
    expect(resolved).not.toEqual({ reason: "log-not-found" });
  });

  it("traversal 形の sessionId は codex 側でも session-id-invalid で拒否する", async () => {
    mkdirSync(join(root, "codex-sessions", "2026"), { recursive: true });

    const resolved = await resolveNativeTranscriptPath(
      makeSession({ provider: "codex", sessionId: "../../outside/secret" }),
      roots(),
    );

    expect(resolved).toEqual({ reason: "session-id-invalid" });
  });

  it("direct: board sessionId が traversal 形なら state JSON を読む前に拒否する", async () => {
    const resolved = await resolveNativeTranscriptPath(
      makeSession({ transport: "direct", sessionId: "../../outside/secret" }),
      roots(),
    );

    expect(resolved).toEqual({ reason: "session-id-invalid" });
  });

  it("direct-claude: state JSON の nativeSessionId が traversal 形なら session-id-invalid", async () => {
    const boardSessionId = "direct-invalid-native";
    const stateDir = join(root, "state", "direct-sessions");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, `${boardSessionId}.json`),
      JSON.stringify({
        pid: 1234,
        taskId: "t_00000001",
        outFile: join(stateDir, `${boardSessionId}.out`),
        exitFile: join(stateDir, `${boardSessionId}.exit`),
        model: "claude-sonnet-5",
        startedAt: 0,
        nativeSessionId: "../../outside/secret",
      }),
      "utf8",
    );

    const resolved = await resolveNativeTranscriptPath(
      makeSession({ transport: "direct", sessionId: boardSessionId }),
      roots(),
    );

    expect(resolved).toEqual({ reason: "session-id-invalid" });
  });

  it("128文字を超える sessionId / 空文字も session-id-invalid で拒否する", async () => {
    const tooLong = "a".repeat(129);
    expect(await resolveNativeTranscriptPath(makeSession({ sessionId: tooLong }), roots())).toEqual({
      reason: "session-id-invalid",
    });
    expect(await resolveNativeTranscriptPath(makeSession({ sessionId: "" }), roots())).toEqual({
      reason: "session-id-invalid",
    });
    // 絶対パス形・ドット単体も拒否する。
    expect(await resolveNativeTranscriptPath(makeSession({ sessionId: "/etc/passwd" }), roots())).toEqual({
      reason: "session-id-invalid",
    });
    expect(await resolveNativeTranscriptPath(makeSession({ sessionId: ".." }), roots())).toEqual({
      reason: "session-id-invalid",
    });
  });

  it("形式検証を通る通常の uuid はこれまで通り解決できる（過剰拒否していない）", async () => {
    const sessionId = "199a85b5-5975-4998-8dc0-9f4d4d29508c";
    const dir = join(root, "claude-projects", "-Users-someone-worktrees-example");
    mkdirSync(dir, { recursive: true });
    writeJsonl(join(dir, `${sessionId}.jsonl`), [{ type: "user", message: { content: "ok" } }]);

    const resolved = await resolveNativeTranscriptPath(makeSession({ sessionId }), roots());

    expect(resolved).toEqual({ path: join(dir, `${sessionId}.jsonl`) });
  });

  it("direct-claude: nativeSessionId 未登録なら session-id-unknown", async () => {
    const session = makeSession({ transport: "direct", sessionId: "direct-x" });
    const result = await resolveNativeTranscriptPath(session, roots());
    expect(result).toEqual({ reason: "session-id-unknown" });
  });

  it("direct-codex: nativeLogsDisabled なら log-not-persisted", async () => {
    const stateDir = join(root, "state", "direct-sessions");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "direct-y.json"),
      JSON.stringify({
        pid: 999,
        taskId: "t_00000001",
        outFile: join(stateDir, "direct-y.out"),
        exitFile: join(stateDir, "direct-y.exit"),
        model: "gpt-5.4",
        startedAt: 0,
        nativeLogsDisabled: true,
      }),
      "utf8",
    );
    const session = makeSession({ transport: "direct", provider: "codex", sessionId: "direct-y" });
    const result = await resolveNativeTranscriptPath(session, roots());
    expect(result).toEqual({ reason: "log-not-persisted" });
  });

  it("direct-codex: .out ファイル自体が存在しなければ log-not-found", async () => {
    const stateDir = join(root, "state", "direct-sessions");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "direct-z.json"),
      JSON.stringify({
        pid: 999,
        taskId: "t_00000001",
        outFile: join(stateDir, "direct-z.out"),
        exitFile: join(stateDir, "direct-z.exit"),
        model: "gpt-5.4",
        startedAt: 0,
      }),
      "utf8",
    );
    // direct-z.out はあえて作成しない（プロセス起動直後で未生成のケースを再現する）。
    const session = makeSession({ transport: "direct", provider: "codex", sessionId: "direct-z" });
    const result = await resolveNativeTranscriptPath(session, roots());
    expect(result).toEqual({ reason: "log-not-found" });
  });

  it("bridge: session.sessionId をそのままネイティブ session id とみなす", async () => {
    const dir = join(root, "claude-projects", "-proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess-1.jsonl"), '{"type":"user","message":{"content":"hi"}}\n', "utf8");
    const session = makeSession();
    const result = await resolveNativeTranscriptPath(session, roots());
    expect(result).toEqual({ path: join(dir, "sess-1.jsonl") });
  });

  it("bridge: 見つからなければ log-not-found", async () => {
    const session = makeSession({ provider: "codex", sessionId: "no-such-session" });
    const result = await resolveNativeTranscriptPath(session, roots());
    expect(result).toEqual({ reason: "log-not-found" });
  });
});

describe("TRANSCRIPT_RAW_REASON_TEXT", () => {
  it("すべての reason に空でない文言を持つ", () => {
    const reasons: SessionTranscriptRawUnavailableReason[] = [
      "log-not-found",
      "log-unreadable",
      "log-not-persisted",
      "log-too-large",
      "session-id-unknown",
    ];
    for (const reason of reasons) {
      expect(TRANSCRIPT_RAW_REASON_TEXT[reason].length).toBeGreaterThan(0);
    }
  });
});
