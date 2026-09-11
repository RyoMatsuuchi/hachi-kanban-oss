// task body の verify directive を解釈する共有 helper。
// 書込境界・doctor・supervisor が同じ抽出規則と予約語判定を使うため Core に置く。

/** task.body 中の `verify: <command>` 行を検出する（独立行のみ）。 */
const VERIFY_DIRECTIVE_REGEX = /^verify:\s*(.*?)\s*$/m;

/** シェルコマンドと誤認されやすいため、完全一致時に拒否する予約語。 */
export const VERIFY_DIRECTIVE_RESERVED_WORDS = [
  "focused",
  "full",
  "test",
  "skip",
  "all",
  "default",
  "auto",
] as const;

export type VerifyDirectiveReservedWord = (typeof VERIFY_DIRECTIVE_RESERVED_WORDS)[number];

const VERIFY_DIRECTIVE_RESERVED_WORD_SET: ReadonlySet<string> = new Set(VERIFY_DIRECTIVE_RESERVED_WORDS);

/** task.body から verify directive の値を抽出する。行が無い場合は null、空行は空文字を返す。 */
export function extractVerifyDirective(body: string): string | null {
  const match = body.match(VERIFY_DIRECTIVE_REGEX);
  const value = match?.[1];
  return value === undefined ? null : value.trim();
}

/** 予約語に trim・case-insensitive の完全一致をした場合、その正規化済み予約語を返す。 */
export function findReservedVerifyDirective(body: string): VerifyDirectiveReservedWord | null {
  const value = extractVerifyDirective(body);
  if (value === null) {
    return null;
  }
  const normalized = value.toLowerCase();
  return VERIFY_DIRECTIVE_RESERVED_WORD_SET.has(normalized)
    ? (normalized as VerifyDirectiveReservedWord)
    : null;
}

/** Core 書込境界で予約語を fail-fast する。 */
export function assertVerifyDirectiveAllowed(body: string): void {
  const reservedWord = findReservedVerifyDirective(body);
  if (reservedWord !== null) {
    throw new Error(
      `verify: に予約語 '${reservedWord}' は指定できません。シェルコマンドを指定するか、検証を省略する場合は none を指定してください`,
    );
  }
}
