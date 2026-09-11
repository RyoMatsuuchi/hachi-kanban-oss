import { describe, expect, it } from "vitest";
import { parseStrictJson } from "./strict-json.js";

const LIMITS = { maxBytes: 1_024, maxDepth: 8, maxTokens: 128 };

describe("parseStrictJson", () => {
  it("正規JSONを非回帰でparseする", () => {
    expect(parseStrictJson('{"root":{"items":[true,false,null,1.5,"text"]}}', LIMITS)).toEqual({
      root: { items: [true, false, null, 1.5, "text"] },
    });
  });

  it.each([
    ['{"key":1,"key":2}'],
    ['{"outer":{"key":1,"key":2}}'],
    ['{"items":[{"key":1,"key":2}]}'],
    ['{"command":1,"comm\\u0061nd":2}'],
  ])("全nestingとescape decode後の重複object keyを拒否する", (raw) => {
    expect(() => parseStrictJson(raw, LIMITS)).toThrow("重複");
  });

  it("byte/depth/token上限をそれぞれfail-closedにする", () => {
    expect(() => parseStrictJson('{"long":"value"}', { ...LIMITS, maxBytes: 4 })).toThrow("byte");
    expect(() => parseStrictJson('{"a":{"b":1}}', { ...LIMITS, maxDepth: 1 })).toThrow("depth");
    expect(() => parseStrictJson('[1,2,3]', { ...LIMITS, maxTokens: 3 })).toThrow("token");
  });
});
