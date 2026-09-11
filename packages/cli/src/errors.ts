// =============================================================================
// action ハンドラ共通のエラーハンドリング。
// 業務ロジックの例外を catch し、日本語メッセージを stderr へ出して fail-closed で exit(1) する。
// commander 自体のパースエラー（未知オプション等）はここでは扱わない（program.ts の exitOverride 側）。
// =============================================================================

import type { CliDeps } from "./deps.js";

interface StructuredCliError {
  code: string;
  details: unknown;
}

function isStructuredCliError(error: unknown): error is StructuredCliError {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; details?: unknown };
  return typeof candidate.code === "string" && "details" in candidate;
}

function wantsJson(args: readonly unknown[]): boolean {
  for (const arg of args) {
    if (typeof arg !== "object" || arg === null) {
      continue;
    }
    const candidate = arg as { json?: unknown };
    if (candidate.json === true) {
      return true;
    }
  }
  return false;
}

/**
 * commander の action ハンドラを共通のエラーハンドリングでラップする。
 * 例外は catch して deps.stderr へ書き、deps.exit(1) を呼ぶ（deps.exit は呼び出し後も
 * 制御を戻すだけなので、この関数自身はそのまま正常終了する＝該当コマンドの処理はそこで打ち切られる）。
 */
export function withErrorHandling<Args extends unknown[]>(
  deps: CliDeps,
  fn: (...args: Args) => void | Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const structured = isStructuredCliError(err) ? err : null;
      if (structured !== null && wantsJson(args)) {
        deps.stderr.write(`${JSON.stringify({ error: { code: structured.code, message, details: structured.details } })}\n`);
      } else {
        const code = structured === null ? "" : ` [${structured.code}]`;
        const details = structured === null ? "" : ` details=${JSON.stringify(structured.details)}`;
        deps.stderr.write(`エラー${code}: ${message}${details}\n`);
      }
      if (deps.debug && err instanceof Error && err.stack !== undefined) {
        deps.stderr.write(`${err.stack}\n`);
      }
      deps.exit(1);
    }
  };
}
