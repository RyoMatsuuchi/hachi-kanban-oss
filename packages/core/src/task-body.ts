// =============================================================================
// task body 共通検証と cwd parser
// CLI と supervisor が同じ本文契約を参照するための共有モジュール。
// =============================================================================

/** task body の入力不備を識別する安定したエラーコード。 */
export const TASK_BODY_LITERAL_NEWLINE_ESCAPE_CODE = "literal-newline-escape" as const;

export type TaskBodyValidationCode = typeof TASK_BODY_LITERAL_NEWLINE_ESCAPE_CODE;
export type TaskBodyLiteralNewlineEscape = "\\n" | "\\r\\n";
export type TaskBodyValidationTrigger = "cwd" | "multiple-lines";

export interface TaskBodyValidationDetails {
  code: TaskBodyValidationCode;
  escape: TaskBodyLiteralNewlineEscape;
  physicalLine: number;
  logicalLineCount: number;
  trigger: TaskBodyValidationTrigger;
}

interface JsonStringifiedTaskBody {
  body: string;
  escape: TaskBodyLiteralNewlineEscape;
}

interface LiteralNewlineEscapeOccurrence {
  escape: TaskBodyLiteralNewlineEscape;
  start: number;
  end: number;
}

/** task body の入力検証に失敗したときの構造化エラー。 */
export class TaskBodyValidationError extends Error {
  readonly code: TaskBodyValidationCode;
  readonly details: TaskBodyValidationDetails;

  constructor(details: TaskBodyValidationDetails) {
    super(
      `本文に literal ${details.escape} が含まれ、同一物理行に ${describeTrigger(details.trigger)} が埋め込まれています。` +
        "実改行を渡してください（JSON.stringify の結果を --body に渡さず、複数行は file-based 入力を使用してください。自動unescapeはしません）",
    );
    this.name = "TaskBodyValidationError";
    this.code = details.code;
    this.details = details;
  }
}

/** 契約 §12.1 の cwd 独立行 parser。literal newline escape は独立行にならない。 */
export function extractTaskBodyCwd(body: string): string | null {
  // `\S+` は literal `\\n` も path の一部として拾うため、parser単体でも入力不備を再解釈しない。
  if (findTaskBodyValidationError(body) !== null) {
    return null;
  }
  const match = /^cwd:\s*(\S+)\s*$/m.exec(body);
  const value = match?.[1];
  return value !== undefined && value !== "" ? value : null;
}

/** task body の入力不備を検出し、該当しなければ null を返す。 */
export function findTaskBodyValidationError(body: string): TaskBodyValidationError | null {
  const jsonStringified = parseJsonStringifiedTaskBody(body);
  if (jsonStringified !== null) {
    const logicalLines = jsonStringified.body.split(/\r\n|\n|\r/u);
    const trigger = validationTrigger(logicalLines, true);
    if (trigger === null) {
      return null;
    }
    return new TaskBodyValidationError({
      code: TASK_BODY_LITERAL_NEWLINE_ESCAPE_CODE,
      escape: jsonStringified.escape,
      physicalLine: 1,
      logicalLineCount: logicalLines.length,
      trigger,
    });
  }

  const physicalLines = body.split(/\r\n|\n|\r/u);
  for (const [index, physicalLine] of physicalLines.entries()) {
    const firstBreak = firstLiteralNewlineEscape(physicalLine);
    if (firstBreak === null) {
      continue;
    }

    const logicalLines = physicalLine.split(/\\r\\n|\\n/g);
    const trigger = validationTrigger(logicalLines, hasStructuralLineBoundary(physicalLine));
    if (trigger === null) {
      continue;
    }

    return new TaskBodyValidationError({
      code: TASK_BODY_LITERAL_NEWLINE_ESCAPE_CODE,
      escape: firstBreak,
      physicalLine: index + 1,
      logicalLineCount: logicalLines.length,
      trigger,
    });
  }
  return null;
}

/** task body が受理可能であることを検証する。 */
export function assertTaskBodyValid(body: string): void {
  const error = findTaskBodyValidationError(body);
  if (error !== null) {
    throw error;
  }
}

function isSectionMarker(line: string): boolean {
  return /^#{1,6}\s+\S/u.test(line.trimStart());
}

function isCwdMarker(line: string): boolean {
  return /^cwd:\s*/u.test(line.trimStart());
}

function validationTrigger(
  logicalLines: readonly string[],
  sectionCandidate: boolean,
): TaskBodyValidationTrigger | null {
  if (logicalLines.some((logicalLine) => isCwdMarker(logicalLine))) {
    return "cwd";
  }
  // section の literal newline は、見出しと本文の境界にあるものだけを検出する。
  // 見出し内の `literal \\n` のような通常表記は同じ物理行に残し、本文を壊さない。
  if (
    !sectionCandidate ||
    logicalLines.length < 2 ||
    !logicalLines.some((logicalLine) => isSectionMarker(logicalLine))
  ) {
    return null;
  }
  return "multiple-lines";
}

function firstLiteralNewlineEscape(line: string): TaskBodyLiteralNewlineEscape | null {
  return literalNewlineEscapeOccurrences(line)[0]?.escape ?? null;
}

function literalNewlineEscapeOccurrences(line: string): LiteralNewlineEscapeOccurrence[] {
  const occurrences: LiteralNewlineEscapeOccurrence[] = [];
  const pattern = /\\r\\n|\\n/gu;
  for (const match of line.matchAll(pattern)) {
    const start = match.index;
    if (start === undefined || isEscapedBackslash(line, start)) {
      continue;
    }
    const escape = match[0] === "\\r\\n" ? "\\r\\n" : "\\n";
    occurrences.push({ escape, start, end: start + match[0].length });
  }
  return occurrences;
}

/**
 * 直前に連続する backslash が奇数個なら、この backslash 自体が escape 済みのリテラル文字であり
 * 続く `n` は改行ではない（JSON escape 上の `\\n` = 文字列としての `\n`）。
 */
function isEscapedBackslash(line: string, index: number): boolean {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

/**
 * escape 位置が論理行の構造境界かどうかを判定する。
 * 「escape で物理行を分割したとき、切れ目の前後どちらかが section 見出しまたは cwd 契約行として
 * 成立するか」を見る。断片が markdown の行構造を成さない場合（`C:\\new\\name` の path 区切り等）は
 * 行境界とみなさない。
 */
function hasStructuralLineBoundary(line: string): boolean {
  return literalNewlineEscapeOccurrences(line).some((occurrence) => {
    if (isInsideInlineCode(line, occurrence.start) || isWindowsPathSeparator(line, occurrence.start)) {
      return false;
    }

    // 前後どちらも空白で挟まれた escape だけを `literal \\n 表記` のような意図的表記として除外する。
    // 片側だけの空白は行境界として普通に現れる（行末の markdown hard break、次行の行頭インデント）ため、
    // 直前の空白だけで除外すると `## 見出し  \\n本文` の collapsed section を取りこぼす。
    // 制限: 両側が空白の `## 見出し  \\n  本文` は意図的表記と区別できないため受理側へ倒す。
    // 逆に `## 改行は \\nです`（直前だけ空白 + 直前断片が見出し）は行境界として拒否する。
    // 曖昧な見出しは fail-fast に倒す。受理側へ倒すと `cwd:` 行が独立行にならず worker が別 cwd で走る。
    if (isWhitespaceAt(line, occurrence.start - 1) && isWhitespaceAt(line, occurrence.end)) {
      return false;
    }

    const before = line.slice(0, occurrence.start);
    const after = line.slice(occurrence.end);
    return isSectionMarker(before) || isSectionMarker(after) || isCwdMarker(after);
  });
}

/** drive letter (`C:\\...`) または UNC prefix (`\\\\server\\...`) を持つ path token。 */
const WINDOWS_PATH_TOKEN_PATTERN = /^(?:[A-Za-z]:|\\\\[^\\/:*?"<>|\s]+)(?:\\[^\\/:*?"<>|\s]+)+\\?$/u;

/**
 * escape の backslash が Windows path の区切りなら行境界として扱わない。
 * 制限: drive letter も UNC prefix も持たない裸の `\\new` は通常の backslash と行境界を区別できないため、
 * 従来どおり行境界として扱う（複数行は file-based 入力を使う運用で回避する）。
 */
function isWindowsPathSeparator(line: string, backslashIndex: number): boolean {
  // backslash を含む空白区切り token を切り出して path 形式かどうかを見る。
  let start = backslashIndex;
  while (start > 0 && !isWhitespaceAt(line, start - 1)) {
    start -= 1;
  }
  let end = backslashIndex;
  while (end < line.length && !isWhitespaceAt(line, end)) {
    end += 1;
  }
  return WINDOWS_PATH_TOKEN_PATTERN.test(line.slice(start, end));
}

function isWhitespaceAt(line: string, index: number): boolean {
  const character = line[index];
  return character !== undefined && /\s/u.test(character);
}

function isInsideInlineCode(line: string, position: number): boolean {
  let open = false;
  for (let index = 0; index < position; index += 1) {
    if (line[index] !== "`" || line[index - 1] === "\\") {
      continue;
    }
    open = !open;
  }
  return open;
}

function parseJsonStringifiedTaskBody(body: string): JsonStringifiedTaskBody | null {
  // JSON.parse は JSON 値の後ろに実改行（shell の command substitution / file output
  // 由来の末尾改行）がある入力を受理できるため、末尾の引用符を事前に要求しない。
  if (!body.startsWith('"')) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "string" || !/(?:\r\n|\n|\r)/u.test(parsed)) {
    return null;
  }

  const escape = firstLiteralNewlineEscape(body);
  if (escape === null) {
    return null;
  }
  return { body: parsed, escape };
}

function describeTrigger(trigger: TaskBodyValidationTrigger): string {
  if (trigger === "cwd") {
    return "見かけ上の cwd 行";
  }
  return "複数行相当の本文";
}
