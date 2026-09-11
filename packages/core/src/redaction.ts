// =============================================================================
// redaction（機密情報マスキング）
// ログ・コメントに書き込む前に共通で通す処理。credential 代入・Bearer トークン・
// APIキーパターン（sk-/ghp_ 等）・32文字以上の連続 hex を [REDACTED] に置換する。
// =============================================================================

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|token|authorization|password|passwd|secret|credential|private[_-]?key|database[_-]?url)/i;
const SENSITIVE_ASSIGNMENT_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|credential|private[_-]?key|database[_-]?url)/i;
const ASSIGNMENT_PREFIX_PATTERN = /(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|\b([A-Za-z0-9_-]+)\b)[ \t]*[:=][ \t]*/g;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** Authorization 値では既存どおり scheme を残し、credential をマスクする */
function redactAuthorizationValue(rawValue: string): string {
  const value = rawValue.replace(/^["']/, "");
  if (value.startsWith(REDACTED)) return REDACTED;
  const scheme = /^(\S+)[ \t]+/.exec(value)?.[1];
  return scheme === undefined ? REDACTED : `${scheme} ${REDACTED}`;
}

/** 自由文の機密な代入は、値の終端を推測せず行末までマスクする */
function redactSensitiveAssignments(text: string): string {
  return text.replace(/[^\r\n]+/g, (line: string): string => {
    for (const match of line.matchAll(ASSIGNMENT_PREFIX_PATTERN)) {
      const key = match[1] ?? match[2] ?? match[3];
      if (key === undefined || !SENSITIVE_ASSIGNMENT_KEY_PATTERN.test(key) || match.index === undefined) continue;
      const valueStart = match.index + match[0].length;
      const prefix = line.slice(0, valueStart);
      return /authorization/i.test(key)
        ? `${prefix}${redactAuthorizationValue(line.slice(valueStart))}`
        : `${prefix}${REDACTED}`;
    }
    return line;
  });
}

/** マスク対象パターンと置換方法の組。順序はより具体的なパターンを先に適用する */
const REDACTION_RULES: ReadonlyArray<{ pattern: RegExp; replace: (match: string) => string }> = [
  // Authorization: Bearer <token>
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, replace: (): string => `Bearer ${REDACTED}` },
  // URL クエリの token= パラメータ
  { pattern: /(token=)[^&\s"']+/gi, replace: (match: string): string => match.replace(/=.+$/, `=${REDACTED}`) },
  // OpenAI 系 APIキー sk-...
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replace: (): string => REDACTED },
  // GitHub 系トークン ghp_/gho_/ghu_/ghs_/ghr_...
  { pattern: /\bgh[oprsu]_[A-Za-z0-9]{8,}\b/g, replace: (): string => REDACTED },
  // 32文字以上の連続 hex（セッション ID・ハッシュ等の生値）
  { pattern: /\b[0-9a-fA-F]{32,}\b/g, replace: (): string => REDACTED },
];

/** テキスト中の機密情報らしきパターンを [REDACTED] にマスクして返す */
export function redactText(text: string): string {
  let result = redactSensitiveAssignments(text);
  for (const rule of REDACTION_RULES) {
    result = result.replace(rule.pattern, rule.replace);
  }
  return result;
}

/**
 * JSON 由来の値（object / 配列 / プリミティブの任意深さのネスト）に含まれる全ての文字列リーフと
 * object key を再帰的に leafRule でマスクして返す。payload を board へ書き込む全ての境界
 * （msg send 等）で共通利用する（docs/contract.md §12.13-2, §79.8）。JSON.parse 由来の値を
 * 想定しており循環参照は考慮しない。
 */
export function redactJsonStrings(
  value: unknown,
  leafRule: (text: string) => string = redactText,
): unknown {
  if (typeof value === "string") {
    return leafRule(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonStrings(item, leafRule));
  }
  if (typeof value === "object" && value !== null) {
    const resultEntries: Array<[string, unknown]> = [];
    const usedKeys = new Set<string>();
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const redactedKey = leafRule(key);
      let resultKey = redactedKey;
      let suffix = 2;
      while (usedKeys.has(resultKey)) {
        resultKey = `${redactedKey}#${suffix}`;
        suffix += 1;
      }
      usedKeys.add(resultKey);

      let redactedNested: unknown;
      if (isSensitiveKey(key) && typeof nested === "string") {
        if (/^authorization$/i.test(key)) {
          redactedNested = redactAuthorizationValue(nested);
        } else {
          redactedNested = REDACTED;
        }
      } else {
        redactedNested = redactJsonStrings(nested, leafRule);
      }
      resultEntries.push([resultKey, redactedNested]);
    }
    return Object.fromEntries(resultEntries);
  }
  return value;
}

/**
 * §79.2 の振り分けを行う唯一の入口。parse できる文字列は構造経路（リーフへ leafRule を
 * 当ててから直列化）、それ以外は自由文経路（leafRule を全体へ当てる）。
 * §79.7 により、構造経路の直列化結果へ leafRule を重ねて当ててはならない。
 */
export function redactMaybeJsonText(
  value: string,
  leafRule: (text: string) => string = redactText,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return leafRule(value);
  }
  return JSON.stringify(redactJsonStrings(parsed, leafRule));
}
