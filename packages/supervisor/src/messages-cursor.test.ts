import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@hachi/core";
import { makeTempHome, type TempHome } from "@hachi/testing";
import { readMessagesCursor, writeMessagesCursor } from "./messages-cursor.js";

describe("messages-cursor", () => {
  let home: TempHome;

  afterEach(() => {
    home.cleanup();
  });

  it("ファイルが無い場合は 0 を返す", () => {
    home = makeTempHome();
    expect(readMessagesCursor(home.env)).toBe(0);
  });

  it("write したカーソルを read できる", () => {
    home = makeTempHome();
    const logger = createLogger({ filePath: join(home.home, "test.jsonl") });

    writeMessagesCursor(home.env, 42, logger);

    expect(readMessagesCursor(home.env)).toBe(42);
  });

  it("$home/state/messages-cursor.json へ保存する", () => {
    home = makeTempHome();
    const logger = createLogger({ filePath: join(home.home, "test.jsonl") });

    writeMessagesCursor(home.env, 7, logger);

    const raw = readFileSync(join(home.home, "state", "messages-cursor.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ lastCommentId: 7 });
  });

  it("JSON として不正なファイルは 0 として扱う（fail-open）", () => {
    home = makeTempHome();
    mkdirSync(join(home.home, "state"), { recursive: true });
    writeFileSync(join(home.home, "state", "messages-cursor.json"), "{ not valid json", "utf8");

    expect(readMessagesCursor(home.env)).toBe(0);
  });

  it("lastCommentId が数値でない場合は 0 として扱う（fail-open）", () => {
    home = makeTempHome();
    mkdirSync(join(home.home, "state"), { recursive: true });
    writeFileSync(
      join(home.home, "state", "messages-cursor.json"),
      JSON.stringify({ lastCommentId: "42" }),
      "utf8",
    );

    expect(readMessagesCursor(home.env)).toBe(0);
  });

  it("書き込みに失敗しても例外を投げず warn ログに留める（次tickで再走査される）", () => {
    home = makeTempHome();
    const logger = createLogger({ filePath: join(home.home, "test.jsonl") });
    // state ディレクトリの位置にファイルを置き、mkdirSync を確実に失敗させる
    writeFileSync(join(home.home, "state"), "not a directory", "utf8");

    expect(() => writeMessagesCursor(home.env, 1, logger)).not.toThrow();
    expect(readMessagesCursor(home.env)).toBe(0);
  });
});
