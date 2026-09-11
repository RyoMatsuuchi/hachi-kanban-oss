// =============================================================================
// 表示整形ユーティリティ（経過時間・タイムスタンプ・reason prefix 抽出等）。
// 旧 SSR 版（packages/web/src/format.ts、削除済み）のロジックを踏襲する。
// =============================================================================

import type { Provider } from "@hachi/core";
import { PROVIDERS, REASON_PREFIXES } from "./constants.js";

/** epoch 秒（null 可）を日本時間 "YYYY-MM-DD HH:mm:ss" 形式へ整形する */
export function formatTimestamp(epochSeconds: number | null): string {
  if (epochSeconds === null) {
    return "-";
  }
  // sv-SE ロケールは "YYYY-MM-DD HH:mm:ss" 形式を返すため、JST 固定表示に流用する
  return new Date(epochSeconds * 1000)
    .toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" })
    .slice(0, 19);
}

/** epoch 秒からの経過時間を "3分前" 等の日本語表現へ整形する */
export function formatElapsed(epochSeconds: number, nowMs: number = Date.now()): string {
  const diffSec = Math.max(0, Math.floor(nowMs / 1000) - epochSeconds);
  if (diffSec < 60) {
    return `${diffSec}秒前`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}分前`;
  }
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) {
    return `${diffHour}時間${diffMin % 60}分前`;
  }
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}日${diffHour % 24}時間前`;
}

/** block_reason の先頭に一致する既知 prefix を返す（コロン抜き）。一致無しは null */
export function reasonPrefixLabel(reason: string): string | null {
  for (const prefix of REASON_PREFIXES) {
    if (reason.startsWith(prefix)) {
      return prefix.slice(0, -1);
    }
  }
  return null;
}

/** 詳細画面で表示する人間確認キューの所属レーン名。未知 prefix は回収待ちへ倒す。 */
export function humanQueueLaneLabel(status: string, reason: string): "判断待ち" | "回収待ち" | null {
  if (status !== "blocked" || reason.trim() === "") {
    return null;
  }
  if (reason.startsWith("user-decision:") || reason.startsWith("user-feedback:")) {
    return "判断待ち";
  }
  if (reason.startsWith("codex-in-progress:") || reason.startsWith("claude-in-progress:")) {
    return null;
  }
  return "回収待ち";
}

/** provider（''も許容）を日本語表示ラベルへ変換する */
export function providerLabel(provider: Provider | ""): string {
  if (provider === "") {
    return "未設定";
  }
  if ((PROVIDERS as readonly string[]).includes(provider)) {
    return provider === "codex" ? "Codex" : "Claude";
  }
  return provider;
}

/** 数値統計を表示用文字列へ整形する。undefined/null は「-」 */
export function formatStat(value: number | undefined | null): string {
  return value === undefined || value === null ? "-" : String(value);
}

/** ISO8601 文字列（supervisor.jsonl の ts 等）を日本時間 "YYYY-MM-DD HH:mm:ss" 形式へ整形する */
export function formatIsoTimestamp(iso: string): string {
  if (iso === "") {
    return "-";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 19);
}
