import { describe, expect, it } from "vitest";
import { newNonce, sha256Hex } from "./provenance.js";

describe("newNonce", () => {
  it("16 hex 文字のランダム値を返す", () => {
    const nonce = newNonce();
    expect(nonce).toMatch(/^[0-9a-f]{16}$/);
  });

  it("呼び出しごとに異なる値を返す", () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).not.toBe(b);
  });
});

describe("sha256Hex", () => {
  it("既知のテストベクタと一致する（NIST 'abc'）", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("空文字列のハッシュも既知値と一致する", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("入力が異なれば出力も異なる", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});
