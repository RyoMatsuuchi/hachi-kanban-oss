// endRun へ渡す meta を組み立てる唯一の入口（契約 §14.5、設計 §4.3 の単一 writer 原則）。
//
// finalize.ts と review.ts に同型の実装が二重化していたため、usage（token/cost 計測）を追加する
// にあたり片方だけ直すと review 経路で終端した run の usage が静かに落ちる。ここへ集約する。
import { redactText } from "@hachi/core";
import type { Logger, RunRow, RunUsage, SessionRef, SessionResultStats, SessionStatus, WorkerAdapter } from "@hachi/core";

/** run 終端時に永続化する統計。lastResult（旧・bridge 由来）と usage（新・§3.2）を並置する。 */
export interface RunEndStats {
  /** bridge の result イベント由来の旧統計。互換のため書き込みを継続する（上書きしない） */
  lastResult?: SessionResultStats;
  /** MetricValue でタグ付けした run 単位の usage（設計 §3.2 / R4） */
  usage?: RunUsage;
}

/**
 * run.meta（JSON文字列）を安全にパースする（endRun 時に既存 meta を保持したまま統計を追加するため）。
 * パース失敗・非オブジェクトの場合は空オブジェクト扱い（fail-closed）。
 */
export function parseExistingRunMeta(meta: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(meta) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** SessionStatus から統計だけを取り出す（exactOptionalPropertyTypes のためキーごと省略する）。 */
export function endStatsFromStatus(status: Pick<SessionStatus, "lastResult" | "usage">): RunEndStats {
  return {
    ...(status.lastResult !== undefined ? { lastResult: status.lastResult } : {}),
    ...(status.usage !== undefined ? { usage: status.usage } : {}),
  };
}

/** 統計を1つも持たない（＝meta へ書くものが無い）か。 */
export function hasNoEndStats(stats: RunEndStats): boolean {
  return stats.lastResult === undefined && stats.usage === undefined;
}

/**
 * endRun 直前に adapter.status(ref) を1回呼び統計（lastResult / usage）を取得する（契約 §14.5）。
 * 失敗時は空を返し endRun 自体はブロックしない（永続化はベストエフォート）。
 * store.transaction() は同期関数のため、この await は必ず Tx の外（呼び出し前）で完了させておくこと。
 */
export async function fetchEndRunStats(
  adapter: WorkerAdapter,
  ref: SessionRef,
  logger: Logger,
  taskId: string,
  stage: string,
): Promise<RunEndStats> {
  try {
    return endStatsFromStatus(await adapter.status(ref));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`${stage}: 統計取得（adapter.status）に失敗しました`, {
      taskId,
      sessionId: ref.sessionId,
      error: redactText(message),
    });
    return {};
  }
}

/**
 * endRun に渡す meta を組み立てる（契約 §14.5）。既存 run.meta（serverUrl/model/modelDelivery 等）を
 * 保持しつつ統計 / verify 証跡等の追加メタ情報をマージする。統計も extraMeta も無い場合は undefined を
 * 返し、endRun は meta 省略のオーバーロードで呼ばれ既存 meta がそのまま保持される。
 */
export function buildEndRunMeta(
  openRun: RunRow,
  stats: RunEndStats,
  extraMeta: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  const hasExtraMeta = Object.keys(extraMeta).length > 0;
  if (hasNoEndStats(stats) && !hasExtraMeta) {
    return undefined;
  }
  const meta = { ...parseExistingRunMeta(openRun.meta), ...extraMeta };
  if (stats.lastResult !== undefined) {
    meta.lastResult = stats.lastResult;
  }
  if (stats.usage !== undefined) {
    meta.usage = stats.usage;
  }
  return meta;
}
