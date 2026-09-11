import { describe, expect, it } from "vitest";
import { parseArgs, parseIntervalSec, stripLeadingSeparators } from "./argv.js";

describe("stripLeadingSeparators", () => {
  it("先頭の単一の -- を取り除く", () => {
    expect(stripLeadingSeparators(["--", "--once"])).toEqual(["--once"]);
  });

  it("先頭に連続する複数の -- を全て取り除く（docs/contract.md §12.9-4）", () => {
    expect(stripLeadingSeparators(["--", "--", "--once"])).toEqual(["--once"]);
  });

  it("-- が無ければそのまま返す", () => {
    expect(stripLeadingSeparators(["--once"])).toEqual(["--once"]);
  });

  it("途中の -- は取り除かない（先頭のみ対象）", () => {
    expect(stripLeadingSeparators(["--once", "--", "--apply"])).toEqual(["--once", "--", "--apply"]);
  });

  it("空配列はそのまま返す", () => {
    expect(stripLeadingSeparators([])).toEqual([]);
  });
});

describe("parseIntervalSec（docs/contract.md §12.9-6）", () => {
  it("正の整数文字列を受理する", () => {
    expect(parseIntervalSec("1")).toBe(1);
    expect(parseIntervalSec("30")).toBe(30);
    expect(parseIntervalSec("3600")).toBe(3600);
  });

  it("'0' は拒否する", () => {
    expect(() => parseIntervalSec("0")).toThrow(/--interval の値が不正です/);
  });

  it("部分数値文字列 '1abc' は拒否する", () => {
    expect(() => parseIntervalSec("1abc")).toThrow(/--interval の値が不正です/);
  });

  it("負の数は拒否する", () => {
    expect(() => parseIntervalSec("-1")).toThrow(/--interval の値が不正です/);
  });

  it("小数は拒否する", () => {
    expect(() => parseIntervalSec("1.5")).toThrow(/--interval の値が不正です/);
  });

  it("空文字列は拒否する", () => {
    expect(() => parseIntervalSec("")).toThrow(/--interval の値が不正です/);
  });

  it("前後に空白を含む文字列は拒否する", () => {
    expect(() => parseIntervalSec(" 5")).toThrow(/--interval の値が不正です/);
    expect(() => parseIntervalSec("5 ")).toThrow(/--interval の値が不正です/);
  });
});

describe("parseArgs", () => {
  it("既定値: apply=false, once=false, intervalSec=30, board=undefined", () => {
    const options = parseArgs([]);
    expect(options).toEqual({ apply: false, once: false, intervalSec: 30, board: undefined });
  });

  it("--apply / --once を解釈する", () => {
    const options = parseArgs(["--apply", "--once"]);
    expect(options.apply).toBe(true);
    expect(options.once).toBe(true);
  });

  it("--interval <sec> を解釈する", () => {
    const options = parseArgs(["--interval", "60"]);
    expect(options.intervalSec).toBe(60);
  });

  it("--interval に不正な値を渡すと throw する", () => {
    expect(() => parseArgs(["--interval", "1abc"])).toThrow(/--interval の値が不正です/);
  });

  it("--board <name> を解釈する", () => {
    const options = parseArgs(["--board", "qa"]);
    expect(options.board).toBe("qa");
  });

  it("--board の次トークンが欠落している場合は throw する（docs/contract.md §12.10-4）", () => {
    expect(() => parseArgs(["--board"])).toThrow(/--board には値が必要です/);
  });

  it("--board の次トークンが - 始まりの場合は throw する（黙って次トークンを消費しない, docs/contract.md §12.10-4）", () => {
    expect(() => parseArgs(["--board", "--apply"])).toThrow(/--board には値が必要です/);
  });

  it("先頭の連続する -- セパレータを除去してから解析する（docs/contract.md §12.9-4）", () => {
    const options = parseArgs(["--", "--", "--apply", "--once"]);
    expect(options.apply).toBe(true);
    expect(options.once).toBe(true);
  });

  it("未知のフラグは throw する（typo による意図しない dry-run 起動を防ぐ, docs/contract.md §12.11-5, fail-closed）", () => {
    expect(() => parseArgs(["--unknown-flag"])).toThrow(/未知のフラグです: --unknown-flag/);
  });

  it("既知フラグと未知フラグが混在していても throw する", () => {
    expect(() => parseArgs(["--apply", "--oncee"])).toThrow(/未知のフラグです: --oncee/);
  });
});
