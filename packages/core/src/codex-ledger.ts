import { readFileSync } from "node:fs";

/** Codex session の課金台帳。unknown は USD 価格表を維持する fail-closed 判定。 */
export type CodexLedger = "api" | "chatgpt" | "unknown";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Codex auth.json から台帳種別だけを返す。
 * credential の値は戻り値・ログ・例外へ載せず、欠如・不正・読取失敗は unknown に閉じる。
 */
export function readCodexLedger(authJsonPath: string): CodexLedger {
  try {
    const parsed: unknown = JSON.parse(readFileSync(authJsonPath, "utf8"));
    if (!isRecord(parsed)) {
      return "unknown";
    }
    const apiKey = parsed["OPENAI_API_KEY"];
    if (typeof apiKey === "string" && apiKey.trim() !== "") {
      return "api";
    }
    const hasEmptyApiKey = Object.hasOwn(parsed, "OPENAI_API_KEY")
      && (apiKey === null || (typeof apiKey === "string" && apiKey.trim() === ""));
    return parsed["auth_mode"] === "chatgpt" && hasEmptyApiKey ? "chatgpt" : "unknown";
  } catch {
    return "unknown";
  }
}
