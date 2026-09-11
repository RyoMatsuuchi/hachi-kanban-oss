import { describe, expect, it } from "vitest";
import { generateRedactionCases } from "./redaction-cases.js";
import { redactJsonStrings, redactMaybeJsonText, redactText } from "./redaction.js";

function isAlreadyStructuredSerializedJsonInput(input: string): boolean {
  try {
    const parsed = JSON.parse(input) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>)["alreadyStructured"] === "[REDACTED]";
  } catch {
    return false;
  }
}

describe("§79 redaction cases", () => {
  it.each(generateRedactionCases())("$id", (redactionCase) => {
    const freeTextRedacted = redactText(redactionCase.input);
    const maybeJsonRedacted = redactMaybeJsonText(redactionCase.input);
    for (const secret of redactionCase.secrets) {
      expect(freeTextRedacted).not.toContain(secret);
      expect(maybeJsonRedacted).not.toContain(secret);
    }

    if (isAlreadyStructuredSerializedJsonInput(redactionCase.input)) {
      expect(() => JSON.parse(maybeJsonRedacted) as unknown).not.toThrow();
    }
    if (redactionCase.parsesAsJson) {
      const structuredRedacted = JSON.stringify(
        redactJsonStrings(JSON.parse(redactionCase.input) as unknown),
      );
      for (const secret of redactionCase.secrets) {
        expect(structuredRedacted).not.toContain(secret);
      }
    }
    if (redactionCase.id.startsWith("secretInObjectKeyJson/")) {
      const parsed = JSON.parse(maybeJsonRedacted) as { nested?: unknown };
      expect(parsed.nested).toBeTypeOf("object");
      expect((parsed.nested as Record<string, unknown>).publicSibling).toBe("preserved");
      for (const secret of redactionCase.secrets) {
        expect(maybeJsonRedacted).not.toContain(secret);
      }
    }
  });
});

describe("redactText", () => {
  it("Bearer トークンをマスクする", () => {
    const input = "Authorization: Bearer abc123.def-456_ghi";
    expect(redactText(input)).toBe("Authorization: Bearer [REDACTED]");
  });

  it("token= クエリパラメータをマスクする", () => {
    const input = "https://example.com/api?token=supersecretvalue&x=1";
    expect(redactText(input)).toBe("https://example.com/api?token=[REDACTED]&x=1");
  });

  it("機密な代入より後ろの散文も意図的に行末まで過剰マスクする", () => {
    const input = "Authorization: Bearer overmask-secret, その後ユーザーが保存を押した";
    expect(redactText(input)).toBe("Authorization: Bearer [REDACTED]");
  });

  it("sk- 形式の APIキーをマスクする", () => {
    const input = "key is sk-abcdefghijklmnop end";
    expect(redactText(input)).toBe("key is [REDACTED] end");
  });

  it("ghp_ 形式の GitHub トークンをマスクする", () => {
    const input = "token ghp_1234567890abcdEFGH used";
    expect(redactText(input)).toBe("token [REDACTED] used");
  });

  it("32文字以上の連続 hex をマスクする", () => {
    const hex = "a".repeat(40);
    const input = `session=${hex} done`;
    expect(redactText(input)).toBe("session=[REDACTED] done");
  });

  it("32文字未満の hex はマスクしない", () => {
    const hex = "a".repeat(31);
    const input = `id=${hex}`;
    expect(redactText(input)).toBe(input);
  });

  it("機密情報を含まないテキストはそのまま返す", () => {
    const input = "これは通常のログメッセージです";
    expect(redactText(input)).toBe(input);
  });

  it("複数パターンが混在していても全てマスクする", () => {
    const hex = "b".repeat(32);
    const input = `Bearer xyz789 token=abcd sk-topsecretkey123 ${hex}`;
    const result = redactText(input);
    expect(result).not.toContain("xyz789");
    expect(result).not.toContain("token=abcd");
    expect(result).not.toContain("topsecretkey123");
    expect(result).not.toContain(hex);
  });
});

describe("redactJsonStrings", () => {
  it("トップレベルの文字列リーフをマスクする", () => {
    const result = redactJsonStrings("Authorization: Bearer abc123defghi");
    expect(result).toBe("Authorization: Bearer [REDACTED]");
  });

  it("文字列以外のプリミティブは変更しない", () => {
    expect(redactJsonStrings(42)).toBe(42);
    expect(redactJsonStrings(true)).toBe(true);
    expect(redactJsonStrings(null)).toBeNull();
  });

  it("配列内の文字列リーフを再帰的にマスクする（docs/contract.md §12.13-2）", () => {
    const input = { detail: { logs: ["Authorization: Bearer xyz789...", "通常のログ"] } };
    const result = redactJsonStrings(input) as { detail: { logs: string[] } };
    // redactText の Bearer パターンは [A-Za-z0-9._~+/=-] を貪欲にマッチするため末尾の "..." も含めてマスクされる
    expect(result.detail.logs[0]).toBe("Authorization: Bearer [REDACTED]");
    expect(result.detail.logs[1]).toBe("通常のログ");
  });

  it("任意深さのネストした object/array の混在を再帰的にマスクする", () => {
    const input = {
      a: [{ b: { c: ["sk-topsecretkey123", { d: "ghp_1234567890abcdEFGH" }] } }],
    };
    const result = redactJsonStrings(input) as {
      a: Array<{ b: { c: [string, { d: string }] } }>;
    };
    expect(result.a[0]?.b.c[0]).toBe("[REDACTED]");
    expect(result.a[0]?.b.c[1]?.d).toBe("[REDACTED]");
  });

  it("マスク対象を含まない値はそのまま返す", () => {
    const input = { title: "普通のタイトル", count: 3, tags: ["a", "b"] };
    expect(redactJsonStrings(input)).toEqual(input);
  });

  it("指定された leafRule を object の key にも再帰的に適用する", () => {
    const input = { "marker-key": { "marker-child": "public-value" } };
    const result = redactJsonStrings(
      input,
      (text) => text.replaceAll("marker", "masked"),
    );
    expect(result).toEqual({ "masked-key": { "masked-child": "public-value" } });
  });

  it("key のマスク結果が衝突しても suffix で全要素を保持する", () => {
    const input = {
      "sk-objectkeyvalue111": "first",
      "sk-objectkeyvalue222": "second",
      "[REDACTED]": "third",
    };
    const result = redactJsonStrings(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["[REDACTED]", "[REDACTED]#2", "[REDACTED]#3"]);
    expect(Object.values(result)).toEqual(["first", "second", "third"]);
  });
});
