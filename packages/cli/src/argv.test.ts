import { describe, expect, it } from "vitest";
import { extractGlobalFlags, stripLeadingSeparators } from "./argv.js";

describe("stripLeadingSeparators（docs/contract.md §12.9-4）", () => {
  it("先頭の単一の -- を取り除く", () => {
    expect(stripLeadingSeparators(["--", "board"])).toEqual(["board"]);
  });

  it("先頭に連続する複数の -- を全て取り除く（pnpm hachi -- board のような二重呼び出し対策）", () => {
    expect(stripLeadingSeparators(["--", "--", "board"])).toEqual(["board"]);
  });

  it("-- が無ければそのまま返す", () => {
    expect(stripLeadingSeparators(["board"])).toEqual(["board"]);
  });

  it("途中の -- は取り除かない（先頭のみ対象）", () => {
    expect(stripLeadingSeparators(["board", "--", "list"])).toEqual(["board", "--", "list"]);
  });

  it("空配列はそのまま返す", () => {
    expect(stripLeadingSeparators([])).toEqual([]);
  });
});

describe("extractGlobalFlags", () => {
  it("--board <value> 形式を抽出し rest から取り除く", () => {
    const result = extractGlobalFlags(["task", "list", "--board", "prod", "--status", "ready"]);
    expect(result.boardOverride).toBe("prod");
    expect(result.debug).toBe(false);
    expect(result.rest).toEqual(["task", "list", "--status", "ready"]);
  });

  it("--board=<value> 形式を抽出する", () => {
    const result = extractGlobalFlags(["board", "--board=prod"]);
    expect(result.boardOverride).toBe("prod");
    expect(result.rest).toEqual(["board"]);
  });

  it("--debug を抽出する", () => {
    const result = extractGlobalFlags(["doctor", "--debug", "--offline"]);
    expect(result.debug).toBe(true);
    expect(result.rest).toEqual(["doctor", "--offline"]);
  });

  it("指定が無ければ boardOverride は undefined, debug は false", () => {
    const result = extractGlobalFlags(["board", "--json"]);
    expect(result.boardOverride).toBeUndefined();
    expect(result.debug).toBe(false);
    expect(result.rest).toEqual(["board", "--json"]);
  });

  it("--board と --debug が両方あっても正しく分離する", () => {
    const result = extractGlobalFlags(["--debug", "task", "show", "t_x", "--board", "qa"]);
    expect(result.boardOverride).toBe("qa");
    expect(result.debug).toBe(true);
    expect(result.rest).toEqual(["task", "show", "t_x"]);
  });

  describe("--board の値検証（docs/contract.md §12.10-4）", () => {
    it("次トークンが欠落している場合は throw する（黙って次トークンを消費しない）", () => {
      expect(() => extractGlobalFlags(["task", "list", "--board"])).toThrow(
        /--board オプションには値を指定してください/,
      );
    });

    it("次トークンが - 始まりの場合は throw する（別フラグを取り違えて消費しない）", () => {
      expect(() => extractGlobalFlags(["task", "list", "--board", "--json"])).toThrow(
        /--board オプションには値を指定してください/,
      );
    });

    it("--board=<value> が空文字の場合は throw する", () => {
      expect(() => extractGlobalFlags(["board", "--board="])).toThrow(
        /--board オプションには値を指定してください/,
      );
    });
  });
});
