// block_reason（in-progress prefix）の生成/解析。docs/contract.md §4 の書式を厳密に守る。
import type { SessionRef } from "@hachi/core";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** epoch 秒（UTC）を JST の ISO8601（+09:00）文字列 YYYY-MM-DDTHH:mm:ss+09:00 に変換する */
function toJstIso8601(epochSeconds: number): string {
  const jstDate = new Date(epochSeconds * 1000 + JST_OFFSET_MS);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const year = jstDate.getUTCFullYear();
  const month = pad(jstDate.getUTCMonth() + 1);
  const day = pad(jstDate.getUTCDate());
  const hour = pad(jstDate.getUTCHours());
  const minute = pad(jstDate.getUTCMinutes());
  const second = pad(jstDate.getUTCSeconds());
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
}

/**
 * summary（task title 由来の自由文）を block_reason へ埋め込む前に無害化する（docs/contract.md §12.5-2）。
 * - 改行（\r\n, \r, \n）をすべて半角スペース1個に畳む（block_reason を1行に保つ）
 * - even-session= / server= / model= / started= / tmux= の `=` を全角 ＝ に置換し、
 *   外部 G2 monitor のパース（`\S+` マッチ）を title 注入で汚染させない（defense in depth）。
 *   単語境界は付けない（G2 側のパースも境界なしで衝突しうるため、埋め込み位置に関わらず無害化する）。
 */
function sanitizeSummary(summary: string): string {
  const collapsed = summary.replace(/\r\n|\r|\n/g, " ");
  return collapsed.replace(/(even-session|server|model|started|tmux)=/g, "$1＝");
}

/**
 * SessionRef から block_reason（in-progress prefix）文字列を構築する。
 * docs/contract.md §4 の書式を厳密に守る（既存 G2 monitor 互換のため）。
 * summary は sanitizeSummary で無害化してから合成する（docs/contract.md §12.5-2）。
 */
export function buildInProgressReason(ref: SessionRef, summary: string): string {
  const started = toJstIso8601(ref.startedAt);
  const safeSummary = sanitizeSummary(summary);
  if (ref.provider === "codex") {
    return `codex-in-progress: ${safeSummary} tmux=none even-session=${ref.sessionId} server=${ref.serverUrl} started=${started}`;
  }
  return `claude-in-progress: ${safeSummary} tmux=none even-session=${ref.sessionId} server=${ref.serverUrl} model=${ref.model} started=${started}`;
}

/**
 * block_reason 文字列から even-session=<sessionId> を抽出する（互換・デバッグ用）。
 * 見つからない場合は null。
 *
 * 非権威（not authoritative）: 運用メタデータの正本は task_runs である（docs/contract.md §12.5-1）。
 * supervisor の本番ロジックはこの関数の戻り値を信頼してはならない
 * （session の再構築には session-ref.ts の reconstructSessionRef を使うこと）。
 */
export function parseSessionIdFromReason(reason: string): string | null {
  const match = reason.match(/even-session=(\S+)/);
  if (match === null) {
    return null;
  }
  return match[1] ?? null;
}
