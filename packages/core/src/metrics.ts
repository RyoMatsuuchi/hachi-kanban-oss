// =============================================================================
// メトリクス集計クエリ（docs/contract.md §43.2）。
// tick_metrics テーブルと task_runs/task_events からの集計ビューを提供する。
// KanbanReadView と同様の readonly 接続で使う（types.ts 凍結のため独立モジュール）。
// =============================================================================

import Database from "better-sqlite3";
import {
  classifyDoneSignal,
  deriveDoneOrigin,
  summarizeDoneOrigins,
  type DoneOriginStats,
} from "./done-origin.js";
import { mapEventRow, type RawEventRow } from "./row-mapping.js";

/** tick_metrics の1レコード */
export interface TickMetricRow {
  ts: number;
  stage: string;
  actions: number;
  durationMs: number;
}

/** 日別スループット（done 数） */
export interface DailyThroughput {
  /** YYYY-MM-DD（JST） */
  date: string;
  count: number;
}

/** run 成功率 */
export interface RunSuccessRate {
  total: number;
  succeeded: number;
  failed: number;
  rate: number;
}

/** rework 率 */
export interface ReworkRate {
  totalDone: number;
  reworked: number;
  rate: number;
}

/** human_queue 滞留時間の分布 */
export interface HumanQueueDwell {
  /** 滞留区間ラベル（例: "<1h", "1-4h", "4-12h", "12-24h", ">24h"） */
  bucket: string;
  count: number;
}

type HumanQueueDwellBucket = "<1h" | "1-4h" | "4-12h" | "12-24h" | ">24h";

const HUMAN_QUEUE_DWELL_BUCKETS: readonly HumanQueueDwellBucket[] = ["<1h", "1-4h", "4-12h", "12-24h", ">24h"];

/** profile x provider 別の件数とコスト */
export interface ProfileProviderStat {
  profile: string;
  provider: string;
  runCount: number;
  totalCostUsd: number;
}

/** GET /api/metrics のレスポンス全体 */
export interface MetricsData {
  period: { from: number; to: number };
  throughput: DailyThroughput[];
  runSuccess: RunSuccessRate;
  rework: ReworkRate;
  humanQueueDwell: HumanQueueDwell[];
  profileProviderStats: ProfileProviderStat[];
  tickMetrics: TickMetricRow[];
  /** 確定event列から導出したdone origin集計。 */
  doneOrigins: DoneOriginStats;
}

/**
 * メトリクス集計の readonly リーダー。
 * 既存の KanbanReadView とは別に、tick_metrics + task_runs/task_events からの
 * 集計クエリを提供する（types.ts 凍結のため KanbanReadView を拡張しない）。
 */
export class MetricsReader {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.db.pragma("busy_timeout = 5000");
  }

  /** 指定期間のメトリクスを集計する */
  query(fromTs: number, toTs: number): MetricsData {
    if (!Number.isInteger(fromTs) || !Number.isInteger(toTs) || fromTs < 0 || toTs < fromTs) {
      throw new Error(`不正なメトリクス集計期間です: from=${fromTs}, to=${toTs}`);
    }
    return {
      period: { from: fromTs, to: toTs },
      throughput: this.dailyThroughput(fromTs, toTs),
      runSuccess: this.runSuccessRate(fromTs, toTs),
      rework: this.reworkRate(fromTs, toTs),
      humanQueueDwell: this.humanQueueDwellDistribution(fromTs, toTs),
      profileProviderStats: this.profileProviderStats(fromTs, toTs),
      tickMetrics: this.recentTickMetrics(fromTs, toTs),
      doneOrigins: this.doneOriginStats(fromTs, toTs),
    };
  }

  /**
   * 指定期間内にdoneシグナルを持つtask IDを分母として選び、由来分類にはtaskの全event列を渡す。
   * 期間外との重複や壊れたterminal eventもpure導出側でunknownに閉じる。
   */
  private doneOriginStats(fromTs: number, toTs: number): DoneOriginStats {
    const rows = this.db
      .prepare(
        `WITH period_candidates AS (
           SELECT DISTINCT task_id
           FROM task_events
           WHERE created_at >= ? AND created_at <= ?
             AND (
               event_type IN ('finalized', 'verdict_finalized', 'telegram_approve')
               OR (json_valid(payload) AND json_extract(payload, '$.to') = 'done')
             )
         )
         SELECT e.*
         FROM task_events e
         INNER JOIN period_candidates p ON p.task_id = e.task_id
         ORDER BY e.task_id ASC, e.created_at ASC, e.id ASC`,
      )
      .all(fromTs, toTs) as RawEventRow[];

    const byTask = new Map<string, ReturnType<typeof mapEventRow>[]>();
    for (const row of rows) {
      const event = mapEventRow(row);
      const current = byTask.get(event.taskId);
      if (current === undefined) {
        byTask.set(event.taskId, [event]);
      } else {
        current.push(event);
      }
    }
    const origins = [...byTask.values()]
      .filter((events) => events.some((event) =>
        event.createdAt >= fromTs && event.createdAt <= toTs && classifyDoneSignal(event) !== "irrelevant",
      ))
      .map(deriveDoneOrigin);
    return summarizeDoneOrigins(origins);
  }

  /**
   * 日別スループット: done に遷移したタスク数を日別に集計する。
   * task_events から payload.to='done' の遷移イベントを使う。
   * event_type は finalized / verdict_finalized / status_changed など呼び出し元で異なるため固定しない。
   * 日付は JST（UTC+9）で計算する。
   */
  private dailyThroughput(fromTs: number, toTs: number): DailyThroughput[] {
    // JST オフセット: +9時間 = 32400秒
    const JST_OFFSET = 9 * 3600;
    const rows = this.db
      .prepare(
        `SELECT date(created_at + ${JST_OFFSET}, 'unixepoch') AS date, COUNT(DISTINCT task_id) AS count
         FROM task_events
         WHERE json_valid(payload)
           AND json_extract(payload, '$.to') = 'done'
           AND created_at >= ? AND created_at <= ?
         GROUP BY date
         ORDER BY date`,
      )
      .all(fromTs, toTs) as Array<{ date: string; count: number }>;
    return rows;
  }

  /**
   * run 成功率: task_runs の done/failed の比率を返す。
   */
  private runSuccessRate(fromTs: number, toTs: number): RunSuccessRate {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS succeeded,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM task_runs
         WHERE started_at >= ? AND started_at <= ?
           AND status IN ('done', 'failed')`,
      )
      .get(fromTs, toTs) as { total: number; succeeded: number; failed: number } | undefined;
    if (row === undefined || row.total === 0) {
      return { total: 0, succeeded: 0, failed: 0, rate: 0 };
    }
    return {
      total: row.total,
      succeeded: row.succeeded,
      failed: row.failed,
      rate: row.total > 0 ? row.succeeded / row.total : 0,
    };
  }

  /**
   * rework 率: done になったタスクのうち、review fail / rework 起動を経験した割合。
   * done 遷移は finalized / verdict_finalized / status_changed など event_type が分かれるため payload.to で拾う。
   */
  private reworkRate(fromTs: number, toTs: number): ReworkRate {
    const row = this.db
      .prepare(
        `WITH done_tasks AS (
           SELECT task_id, MIN(created_at) AS done_at
           FROM task_events
           WHERE json_valid(payload)
             AND json_extract(payload, '$.to') = 'done'
             AND created_at >= ? AND created_at <= ?
           GROUP BY task_id
         )
         SELECT
           (SELECT COUNT(*) FROM done_tasks) AS total_done,
           COUNT(DISTINCT d.task_id) AS reworked
         FROM done_tasks d
         JOIN task_events e ON e.task_id = d.task_id
         WHERE e.event_type IN ('verdict_failed', 'rework_launched')
           AND e.created_at <= d.done_at`,
      )
      .get(fromTs, toTs) as { total_done: number; reworked: number } | undefined;
    const totalDone = row?.total_done ?? 0;
    const reworked = row?.reworked ?? 0;

    return {
      totalDone,
      reworked,
      rate: totalDone > 0 ? reworked / totalDone : 0,
    };
  }

  /**
   * human_queue 滞留時間分布: blocked -> unblock/transition 間の時間を集計する。
   * user-decision/user-feedback/review-required/needs-manual の block_reason を持つイベントの
   * ペアから計算する。
   */
  private humanQueueDwellDistribution(fromTs: number, toTs: number): HumanQueueDwell[] {
    // human_queue に入ったイベント（blocked に遷移 + 人間確認系 reason）と
    // そこから出たイベント（status_changed で from='blocked'）のペアを検索
    const rows = this.db
      .prepare(
        `SELECT
           e1.task_id,
           e1.created_at AS entered_at,
           MIN(e2.created_at) AS exited_at
         FROM task_events e1
         LEFT JOIN task_events e2
           ON e2.task_id = e1.task_id
           AND e2.event_type = 'status_changed'
           AND e2.created_at > e1.created_at
           AND e2.created_at <= ?
           AND json_valid(e2.payload)
           AND json_extract(e2.payload, '$.from') = 'blocked'
         WHERE e1.event_type = 'status_changed'
           AND json_valid(e1.payload)
           AND json_extract(e1.payload, '$.to') = 'blocked'
           AND (json_extract(e1.payload, '$.reason') LIKE 'user-decision:%'
                OR json_extract(e1.payload, '$.reason') LIKE 'user-feedback:%'
                OR json_extract(e1.payload, '$.reason') LIKE 'review-required:%'
                OR json_extract(e1.payload, '$.reason') LIKE 'needs-manual:%')
           AND e1.created_at >= ? AND e1.created_at <= ?
         GROUP BY e1.task_id, e1.created_at`,
      )
      .all(toTs, fromTs, toTs) as Array<{
      task_id: string;
      entered_at: number;
      exited_at: number | null;
    }>;

    // バケット分類
    const buckets: Record<HumanQueueDwellBucket, number> = {
      "<1h": 0,
      "1-4h": 0,
      "4-12h": 0,
      "12-24h": 0,
      ">24h": 0,
    };
    for (const row of rows) {
      const exit = row.exited_at ?? toTs; // 期間内に出ていない場合は期間終端までの滞留として扱う
      const dwellSec = exit - row.entered_at;
      const dwellHours = dwellSec / 3600;
      if (dwellHours < 1) {
        buckets["<1h"]++;
      } else if (dwellHours < 4) {
        buckets["1-4h"]++;
      } else if (dwellHours < 12) {
        buckets["4-12h"]++;
      } else if (dwellHours < 24) {
        buckets["12-24h"]++;
      } else {
        buckets[">24h"]++;
      }
    }

    return HUMAN_QUEUE_DWELL_BUCKETS.map((bucket) => ({ bucket, count: buckets[bucket] }));
  }

  /**
   * profile x provider 別の run 件数とコスト集計。
   * task_runs.meta から costUsd を抽出する。
   */
  private profileProviderStats(fromTs: number, toTs: number): ProfileProviderStat[] {
    // task_runs に profile 列は無いので、tasks テーブルと join して profile を取得する
    const rows = this.db
      .prepare(
        `SELECT
           COALESCE(t.profile, '') AS profile,
           r.provider,
           COUNT(*) AS run_count,
           SUM(
             CASE
               WHEN json_valid(r.meta) AND json_extract(r.meta, '$.lastResult.costUsd') IS NOT NULL
               THEN json_extract(r.meta, '$.lastResult.costUsd')
               ELSE 0
             END
           ) AS total_cost_usd
         FROM task_runs r
         JOIN tasks t ON t.id = r.task_id
         WHERE r.started_at >= ? AND r.started_at <= ?
           AND r.status IN ('done', 'failed')
         GROUP BY t.profile, r.provider
         ORDER BY total_cost_usd DESC`,
      )
      .all(fromTs, toTs) as Array<{
      profile: string;
      provider: string;
      run_count: number;
      total_cost_usd: number;
    }>;

    return rows.map((r) => ({
      profile: r.profile,
      provider: r.provider,
      runCount: r.run_count,
      totalCostUsd: r.total_cost_usd,
    }));
  }

  /** tick_metrics の直近レコード */
  private recentTickMetrics(fromTs: number, toTs: number): TickMetricRow[] {
    const rows = this.db
      .prepare(
        `SELECT ts, stage, actions, duration_ms
         FROM tick_metrics
         WHERE ts >= ? AND ts <= ?
         ORDER BY ts DESC
         LIMIT 500`,
      )
      .all(fromTs, toTs) as Array<{
      ts: number;
      stage: string;
      actions: number;
      duration_ms: number;
    }>;
    return rows.map((r) => ({
      ts: r.ts,
      stage: r.stage,
      actions: r.actions,
      durationMs: r.duration_ms,
    }));
  }

  close(): void {
    this.db.close();
  }
}
