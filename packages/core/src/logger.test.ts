import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

class CapturingStream extends Writable {
  chunks: string[] = [];

  override _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    callback();
  }
}

describe("createLogger", () => {
  it("stream へ構造化 JSONL を出力する", () => {
    const stream = new CapturingStream();
    const logger = createLogger({ stream });

    logger.info("hello", { taskId: "t_abc12345" });

    expect(stream.chunks).toHaveLength(1);
    const entry = JSON.parse(stream.chunks[0]!.trim()) as Record<string, unknown>;
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("hello");
    expect(entry.taskId).toBe("t_abc12345");
    expect(typeof entry.ts).toBe("string");
  });

  it("warn / error レベルも出力する", () => {
    const stream = new CapturingStream();
    const logger = createLogger({ stream });

    logger.warn("careful");
    logger.error("boom");

    expect(JSON.parse(stream.chunks[0]!.trim()) as Record<string, unknown>).toMatchObject({
      level: "warn",
      msg: "careful",
    });
    expect(JSON.parse(stream.chunks[1]!.trim()) as Record<string, unknown>).toMatchObject({
      level: "error",
      msg: "boom",
    });
  });

  it("child() は固定フィールドをマージする", () => {
    const stream = new CapturingStream();
    const logger = createLogger({ stream });
    const child = logger.child({ stage: "dispatch" });

    child.info("tick", { actions: 2 });

    const entry = JSON.parse(stream.chunks[0]!.trim()) as Record<string, unknown>;
    expect(entry.stage).toBe("dispatch");
    expect(entry.actions).toBe(2);
    expect(entry.msg).toBe("tick");
  });

  it("呼び出し時の fields が child の固定フィールドを上書きできる", () => {
    const stream = new CapturingStream();
    const logger = createLogger({ stream }).child({ stage: "dispatch" });

    logger.info("override", { stage: "monitor" });

    const entry = JSON.parse(stream.chunks[0]!.trim()) as Record<string, unknown>;
    expect(entry.stage).toBe("monitor");
  });
});

describe("createLogger with filePath", () => {
  let tempRoot: string;

  afterEach(() => {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("filePath 指定時はファイルへ追記する", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-logger-"));
    const filePath = join(tempRoot, "hermes.log");
    const logger = createLogger({ filePath });

    logger.info("first");
    logger.info("second");

    const content = readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]!) as Record<string, unknown>).msg).toBe("first");
    expect((JSON.parse(lines[1]!) as Record<string, unknown>).msg).toBe("second");
  });

  it("rotation 未指定なら閾値を超えても rotate しない（既存呼び出し元の挙動を変えない）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-logger-"));
    const filePath = join(tempRoot, "hermes.log");
    const logger = createLogger({ filePath });

    for (let i = 0; i < 5; i += 1) {
      logger.info("line", { i });
    }

    expect(existsSync(`${filePath}.1`)).toBe(false);
    expect(readFileSync(filePath, "utf8").trim().split("\n")).toHaveLength(5);
  });

  it("rotation 指定時は閾値超過で現行ファイルを .1 へ退避し、1行も欠落させずに書き続ける", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-logger-"));
    const filePath = join(tempRoot, "hermes.log");
    // 1行(msg+ts+level のJSON)が数十バイトになるよう、極小閾値で毎行rotateさせる
    const logger = createLogger({ filePath, rotation: { maxSizeBytes: 1, maxGenerations: 2 } });

    for (let i = 0; i < 5; i += 1) {
      logger.info("line", { i });
    }

    // 現行ファイルは直近1行だけを持ち、.1 / .2 に過去分が退避されている
    const current = readFileSync(filePath, "utf8").trim().split("\n");
    const gen1 = readFileSync(`${filePath}.1`, "utf8").trim().split("\n");
    const gen2 = readFileSync(`${filePath}.2`, "utf8").trim().split("\n");
    expect(existsSync(`${filePath}.3`)).toBe(false);

    const allMessages = [...gen2, ...gen1, ...current].map(
      (line) => (JSON.parse(line) as Record<string, unknown>).i,
    );
    // 世代保持数(2)を超えた最古行は削除される想定なので、直近3行分(2,3,4)が残っていればよい
    expect(allMessages).toEqual([2, 3, 4]);
  });
});
