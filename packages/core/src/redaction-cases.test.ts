import { describe, expect, it } from "vitest";
import { generateRedactionCases } from "./redaction-cases.js";

function isAlreadyStructuredSerializedJsonInput(input: string): boolean {
  try {
    const parsed = JSON.parse(input) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>)["alreadyStructured"] === "[REDACTED]";
  } catch {
    return false;
  }
}

describe("generateRedactionCases", () => {
  const cases = generateRedactionCases();

  it("成立する 4 軸の直積を重複なく生成する", () => {
    expect(cases).toHaveLength(4 * 6 * (1 + 2 + 2 + 2 + 1 + 1));
    expect(new Set(cases.map(({ id }) => id)).size).toBe(cases.length);
    expect(cases.some(({ id }) => id.startsWith("validJson/bare/"))).toBe(false);
  });

  it("各軸の各値が最低 1 件に現れる", () => {
    const axes = cases.map(({ id }) => id.split("/"));
    expect([...new Set(axes.map((parts) => parts[0]))].sort()).toEqual([
      "alreadyStructuredSerializedJson",
      "brokenJson",
      "freeText",
      "secretInObjectKeyJson",
      "stdoutPrefixedBrokenJson",
      "validJson",
    ]);
    expect([...new Set(axes.map((parts) => parts[1]))].sort()).toEqual(["bare", "quoted"]);
    expect([...new Set(axes.map((parts) => parts[2]))].sort()).toEqual([
      "api_key",
      "authorization",
      "database_url",
      "password",
    ]);
    expect([...new Set(axes.map((parts) => parts[3]))].sort()).toEqual([
      "alreadyRedactedPrefix",
      "commaContinuation",
      "escapedQuote",
      "plain",
      "recognizedSecretAndUrlUserinfo",
      "urlUserinfo",
    ]);
  });

  it("stdoutPrefixedBrokenJson の全 input に stdout 接頭辞がある", () => {
    const prefixedCases = cases.filter(({ id }) => id.startsWith("stdoutPrefixedBrokenJson/"));
    expect(prefixedCases.length).toBeGreaterThan(0);
    for (const redactionCase of prefixedCases) {
      expect(redactionCase.input).toMatch(/^stdout: /);
    }
  });

  it("brokenJson 系の全 input は JSON.parse に失敗する", () => {
    const brokenCases = cases.filter(({ id }) => (
      id.startsWith("brokenJson/") || id.startsWith("stdoutPrefixedBrokenJson/")
    ));
    expect(brokenCases.length).toBeGreaterThan(0);
    for (const redactionCase of brokenCases) {
      expect(() => JSON.parse(redactionCase.input) as unknown).toThrow();
    }
  });

  it("validJson の全 input は JSON.parse に成功し、1 段入れ子である", () => {
    const validCases = cases.filter(({ id }) => id.startsWith("validJson/"));
    expect(validCases.length).toBeGreaterThan(0);
    for (const redactionCase of validCases) {
      const parsed = JSON.parse(redactionCase.input) as { nested?: unknown };
      expect(parsed.nested).toBeTypeOf("object");
    }
  });

  it("alreadyStructuredSerializedJson は input 自体が既マスクJSONと別の生きた秘密を持つ", () => {
    const structuredCases = cases.filter(({ input }) => isAlreadyStructuredSerializedJsonInput(input));
    expect(structuredCases).toHaveLength(4 * 6);
    for (const redactionCase of structuredCases) {
      expect(() => JSON.parse(redactionCase.input) as unknown).not.toThrow();
      expect(redactionCase.input).toContain("[REDACTED]");
      for (const secret of redactionCase.secrets) {
        expect(redactionCase.input).toContain(secret);
      }
    }
  });

  it("secretInObjectKeyJson は目印を値ではなく key に持ち、同じ object に非機密 key を持つ", () => {
    const objectKeyCases = cases.filter(({ id }) => id.startsWith("secretInObjectKeyJson/"));
    expect(objectKeyCases).toHaveLength(4 * 6);
    for (const redactionCase of objectKeyCases) {
      const parsed = JSON.parse(redactionCase.input) as { nested?: unknown };
      expect(parsed.nested).toBeTypeOf("object");
      const nested = parsed.nested as Record<string, unknown>;
      expect(nested.publicSibling).toBe("preserved");
      const keys = Object.keys(nested);
      for (const secret of redactionCase.secrets) {
        expect(keys.some((key) => key.includes(secret))).toBe(true);
        expect(JSON.stringify(Object.values(nested))).not.toContain(secret);
      }
    }
  });
});
