// =============================================================================
// authority input 用の bounded JSON parser。
// JSON.parse が上書きする重複 object key を、escape decode 後の key で全階層拒否する。
// =============================================================================

export interface StrictJsonParseLimits {
  maxBytes: number;
  maxDepth: number;
  maxTokens: number;
}

/** 構文不正・重複key・上限超過を呼び出し側の既存error codeへ写像するための内部error。 */
export class StrictJsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrictJsonParseError";
  }
}

class StrictJsonParser {
  private index = 0;
  private tokens = 0;
  private readonly numberPattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

  constructor(
    private readonly raw: string,
    private readonly limits: StrictJsonParseLimits,
  ) {}

  parse(): unknown {
    if (!Number.isSafeInteger(this.limits.maxBytes) || this.limits.maxBytes <= 0 ||
        !Number.isSafeInteger(this.limits.maxDepth) || this.limits.maxDepth <= 0 ||
        !Number.isSafeInteger(this.limits.maxTokens) || this.limits.maxTokens <= 0) {
      throw new StrictJsonParseError("JSON parser limit が不正です");
    }
    if (this.raw === "" || Buffer.byteLength(this.raw, "utf8") > this.limits.maxBytes) {
      throw new StrictJsonParseError("JSON byte上限を超えています");
    }
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.raw.length) {
      throw new StrictJsonParseError("JSON root後に余分なtokenがあります");
    }
    return value;
  }

  private bumpToken(): void {
    this.tokens += 1;
    if (this.tokens > this.limits.maxTokens) {
      throw new StrictJsonParseError("JSON token上限を超えています");
    }
  }

  private skipWhitespace(): void {
    while (this.index < this.raw.length) {
      const char = this.raw[this.index];
      if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") return;
      this.index += 1;
    }
  }

  private parseValue(depth: number): unknown {
    this.bumpToken();
    const char = this.raw[this.index];
    if (char === "{") return this.parseObject(depth + 1);
    if (char === "[") return this.parseArray(depth + 1);
    if (char === "\"") return this.parseString();
    if (char === "t") return this.parseLiteral("true", true);
    if (char === "f") return this.parseLiteral("false", false);
    if (char === "n") return this.parseLiteral("null", null);
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) {
      return this.parseNumber();
    }
    throw new StrictJsonParseError("JSON valueが不正です");
  }

  private assertDepth(depth: number): void {
    if (depth > this.limits.maxDepth) {
      throw new StrictJsonParseError("JSON depth上限を超えています");
    }
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.assertDepth(depth);
    this.index += 1;
    this.skipWhitespace();
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    if (this.raw[this.index] === "}") {
      this.index += 1;
      return result;
    }
    while (true) {
      if (this.raw[this.index] !== "\"") {
        throw new StrictJsonParseError("JSON object keyがstringではありません");
      }
      this.bumpToken();
      const key = this.parseString();
      if (keys.has(key)) {
        throw new StrictJsonParseError("JSON object keyが重複しています");
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.raw[this.index] !== ":") {
        throw new StrictJsonParseError("JSON object key後にcolonがありません");
      }
      this.index += 1;
      this.skipWhitespace();
      result[key] = this.parseValue(depth);
      this.skipWhitespace();
      const delimiter = this.raw[this.index];
      if (delimiter === "}") {
        this.index += 1;
        return result;
      }
      if (delimiter !== ",") {
        throw new StrictJsonParseError("JSON object delimiterが不正です");
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): unknown[] {
    this.assertDepth(depth);
    this.index += 1;
    this.skipWhitespace();
    const result: unknown[] = [];
    if (this.raw[this.index] === "]") {
      this.index += 1;
      return result;
    }
    while (true) {
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      const delimiter = this.raw[this.index];
      if (delimiter === "]") {
        this.index += 1;
        return result;
      }
      if (delimiter !== ",") {
        throw new StrictJsonParseError("JSON array delimiterが不正です");
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.raw.length) {
      const char = this.raw[this.index];
      if (char === "\"") {
        this.index += 1;
        const token = this.raw.slice(start, this.index);
        try {
          const decoded = JSON.parse(token) as unknown;
          if (typeof decoded !== "string") throw new Error("not string");
          return decoded;
        } catch {
          throw new StrictJsonParseError("JSON string escapeが不正です");
        }
      }
      if (char === "\\") {
        this.index += 1;
        const escaped = this.raw[this.index];
        if (escaped === "u") {
          const hex = this.raw.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new StrictJsonParseError("JSON unicode escapeが不正です");
          }
          this.index += 5;
          continue;
        }
        if (escaped === undefined || !"\"\\/bfnrt".includes(escaped)) {
          throw new StrictJsonParseError("JSON string escapeが不正です");
        }
        this.index += 1;
        continue;
      }
      if (char === undefined || char.charCodeAt(0) < 0x20) {
        throw new StrictJsonParseError("JSON stringにcontrol文字があります");
      }
      this.index += 1;
    }
    throw new StrictJsonParseError("JSON stringが閉じていません");
  }

  private parseLiteral<T extends boolean | null>(literal: string, value: T): T {
    if (this.raw.slice(this.index, this.index + literal.length) !== literal) {
      throw new StrictJsonParseError("JSON literalが不正です");
    }
    this.index += literal.length;
    return value;
  }

  private parseNumber(): number {
    this.numberPattern.lastIndex = this.index;
    const match = this.numberPattern.exec(this.raw);
    if (match === null) {
      throw new StrictJsonParseError("JSON numberが不正です");
    }
    this.index += match[0].length;
    try {
      return JSON.parse(match[0]) as number;
    } catch {
      throw new StrictJsonParseError("JSON numberが不正です");
    }
  }
}

export function parseStrictJson(raw: string, limits: StrictJsonParseLimits): unknown {
  return new StrictJsonParser(raw, limits).parse();
}
