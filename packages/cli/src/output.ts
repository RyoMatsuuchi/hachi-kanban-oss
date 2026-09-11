// =============================================================================
// 出力共通ヘルパー。--json 指定時は機械可読な JSON を、無指定時は簡潔なテキスト表を出力する。
// =============================================================================

import type { CliDeps } from "./deps.js";

interface IdentifiedResource {
  id: string | number;
  status?: unknown;
}

/** json=true なら jsonValue を整形 JSON で、false なら textLines を改行結合してテキストで出力する */
export function emit(deps: CliDeps, json: boolean, jsonValue: unknown, textLines: string[]): void {
  if (json) {
    deps.stdout.write(`${JSON.stringify(jsonValue, null, 2)}\n`);
    return;
  }
  deps.stdout.write(`${textLines.join("\n")}\n`);
}

/**
 * 単一resourceの既存payloadを維持しつつ、機械抽出用のid/statusを最上位へ加える。
 * statusを持たないresourceへ値を推測で補わず、文字列statusがある場合だけ公開する。
 */
export function singularResourceEnvelope<TPayload extends object>(
  resource: IdentifiedResource,
  payload: TPayload,
): TPayload & { id: string | number; status?: string } {
  const envelope = { ...payload, id: resource.id };
  if (typeof resource.status !== "string") {
    return envelope;
  }
  return { ...envelope, status: resource.status };
}

/** 文字列を先頭 max 文字で切り詰める（docs/contract.md の「先頭N字」表記を厳密に満たすため省略記号は付けない） */
export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}
