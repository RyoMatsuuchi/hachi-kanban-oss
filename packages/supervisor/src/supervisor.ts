// 単一常駐デーモンの tick ループ本体（docs/contract.md §10）
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "@hachi/core";
import type { Stage, StageDeps, StageResult } from "@hachi/core";
import { dispatchStage } from "./stages/dispatch.js";
import { finalizeStage } from "./stages/finalize.js";
import { messagesStage } from "./stages/messages.js";
import { monitorStage } from "./stages/monitor.js";
import { notifyStage } from "./stages/notify.js";
import { orchestratorRoutingStage } from "./stages/orchestrator-routing.js";
import { reapStage } from "./stages/reap.js";
import { reviewStage } from "./stages/review.js";
import { schedulerStage } from "./stages/scheduler.js";
import { resourceReconcileStage } from "./stages/resource-reconcile.js";
import { resourceCleanupStage } from "./stages/resource-cleanup.js";
import { telegramInStage } from "./stages/telegram-in.js";
import { webwatchStage } from "./stages/webwatch.js";
import { stewardStage } from "./stages/steward.js";
import { briefStage } from "./stages/brief.js";
import { cancelStage } from "./stages/cancel.js";
import { nativeRecoveryStage } from "./stages/native-recovery.js";
import { sessionBudgetMonitorStage } from "./stages/session-budget-monitor.js";

/** tick メトリクス記録用のインターフェース（docs/contract.md §43.1）。
 * types.ts 凍結のため KanbanStore とは独立に定義する */
export interface TickMetricsRecorder {
  recordTickMetrics(
    metrics: ReadonlyArray<{ stage: string; actions: number; durationMs: number }>,
    tickTs: number,
  ): void;
}

/**
 * ステージ実行順（docs/contract.md §10, §15.3, §18, §29, §30, §40, §42, §48）:
 * scheduler → resource-reconcile → cancel → native-recovery → dispatch → monitor → finalize → review → orchestrator-routing → messages → reap → resource-cleanup → notify → webwatch → telegram-in → steward → brief → session-budget-monitor
 */
const STAGES: readonly Stage[] = [
  schedulerStage,
  resourceReconcileStage,
  cancelStage,
  nativeRecoveryStage,
  dispatchStage,
  monitorStage,
  finalizeStage,
  reviewStage,
  orchestratorRoutingStage,
  messagesStage,
  reapStage,
  resourceCleanupStage,
  notifyStage,
  webwatchStage,
  telegramInStage,
  stewardStage,
  briefStage,
  sessionBudgetMonitorStage,
];

export interface SupervisorOptions {
  /** true の場合のみ副作用を伴う操作を実行する。既定は dry-run（判定のみログ） */
  apply: boolean;
  /**
   * heartbeat（docs/contract.md §33.1）の intervalSec 欄に使う参考値。
   * `--once` 実行時など startLoop() を呼ばない場合の既定は 30（CLI 既定 --interval と同じ）。
   * startLoop() 呼び出し時はその引数値で上書きされる。
   */
  intervalSec?: number;
  /** tick メトリクス記録先（省略時は記録しない。docs/contract.md §43.1） */
  metricsRecorder?: TickMetricsRecorder;
}

/**
 * 単一常駐デーモン。tick ごとに全ステージを順に実行する。
 * kill-switch（$home/supervisor.disabled / $home/<stage>.disabled）と
 * ステージ単位の例外隔離を担う（1つの失敗が他ステージの実行を妨げない）。
 */
export class Supervisor {
  private readonly deps: StageDeps;
  private readonly apply: boolean;
  /** §43.1: tick メトリクス記録先（省略時は記録しない） */
  private readonly metricsRecorder: TickMetricsRecorder | undefined;
  private timer: NodeJS.Timeout | null = null;
  /** startLoop() 呼び出し後、stop() が呼ばれるまで true。次回 tick を予約してよいかの判定に使う */
  private loopActive = false;
  /** running ガード。tick 実行中は true にし、同一デーモン内での tick 重なりを防ぐ（docs/contract.md §12.9-2） */
  private running = false;
  /** 進行中の tick を stop() から待機できるようにする */
  private inFlightTick: Promise<void> | null = null;
  /** 完了した tick 数（docs/contract.md §33.1 heartbeat の tickCount 欄 / §34.4 tick 観測ログに使う） */
  private tickCount = 0;
  /** heartbeat の intervalSec 欄に使う値。startLoop() 呼び出し時に実際の interval で上書きされる */
  private heartbeatIntervalSec: number;

  constructor(deps: StageDeps, options: SupervisorOptions) {
    this.deps = deps;
    this.apply = options.apply;
    this.metricsRecorder = options.metricsRecorder;
    this.heartbeatIntervalSec = options.intervalSec ?? 30;
  }

  private isDisabled(stageName: string): boolean {
    const home = this.deps.env.home;
    return existsSync(join(home, "supervisor.disabled")) || existsSync(join(home, `${stageName}.disabled`));
  }

  /**
   * heartbeat（docs/contract.md §33.1）を原子的に書く（tmp へ書いて rename）。
   * 書き込み失敗は warn ログのみに留め throw しない（heartbeat は可観測性でありDBには触れない）。
   */
  private writeHeartbeat(now: number): void {
    const stateDir = join(this.deps.env.home, "state");
    const targetPath = join(stateDir, "supervisor-heartbeat.json");
    const tmpPath = join(stateDir, `.supervisor-heartbeat.json.tmp-${process.pid}`);
    const payload = {
      ts: now,
      pid: process.pid,
      tickCount: this.tickCount,
      intervalSec: this.heartbeatIntervalSec,
    };
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(tmpPath, JSON.stringify(payload), "utf8");
      renameSync(tmpPath, targetPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn("supervisor: heartbeat 書き込みに失敗しました", { error: redactText(message) });
    }
  }

  /**
   * 起動直後の heartbeat を書く（docs/contract.md §33.1）。tickCount=0 の状態で書く。
   * main.ts が起動直後（--once / 常駐ループどちらのモードでも）に1回だけ呼ぶ想定。
   */
  writeStartupHeartbeat(now: number = Math.floor(Date.now() / 1000)): void {
    this.writeHeartbeat(now);
  }

  /** 1 tick を実行し、各ステージの StageResult を実行順の配列で返す */
  async runTick(now: number = Math.floor(Date.now() / 1000)): Promise<StageResult[]> {
    const tickStartMs = Date.now();
    const results: StageResult[] = [];
    // §43.1: ステージごとの実行時間を収集する
    const stageTimings: Array<{ stage: string; actions: number; durationMs: number }> = [];

    for (const stage of STAGES) {
      if (this.isDisabled(stage.name)) {
        const result: StageResult = { name: stage.name, actions: 0, skipped: true };
        results.push(result);
        stageTimings.push({ stage: stage.name, actions: 0, durationMs: 0 });
        this.deps.logger.info("stage skipped (kill-switch)", { stage: stage.name });
        continue;
      }

      const stageStartMs = Date.now();
      try {
        const result = await stage.tick(this.deps, this.apply, now);
        const durationMs = Date.now() - stageStartMs;
        results.push(result);
        stageTimings.push({ stage: stage.name, actions: result.actions, durationMs });
        this.deps.logger.info("stage completed", {
          stage: stage.name,
          actions: result.actions,
          notes: result.notes,
          durationMs,
        });
      } catch (err) {
        const durationMs = Date.now() - stageStartMs;
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger.error("stage failed", { stage: stage.name, error: redactText(message), durationMs });
        results.push({
          name: stage.name,
          actions: 0,
          skipped: false,
          notes: [`エラー: ${redactText(message)}`],
        });
        stageTimings.push({ stage: stage.name, actions: 0, durationMs });
      }
    }

    this.tickCount += 1;
    const tickDurationMs = Date.now() - tickStartMs;
    this.deps.logger.info("tick completed", { tickCount: this.tickCount, tickDurationMs });
    this.writeHeartbeat(now);

    // §43.1: tick メトリクスを永続化する（apply モード時のみ）
    if (this.apply && this.metricsRecorder !== undefined) {
      try {
        this.metricsRecorder.recordTickMetrics(stageTimings, now);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger.warn("tick メトリクス記録に失敗しました", { error: redactText(message) });
      }
    }

    return results;
  }

  /**
   * runTick 完了後に次回を setTimeout する async ループを開始する（docs/contract.md §12.9-2）。
   * setInterval と異なり、tick の実行時間が interval を超えても次 tick が重ねて起動されることはない。
   * 既に稼働中なら何もしない。
   */
  startLoop(intervalSec: number): void {
    if (this.loopActive) {
      return;
    }
    this.loopActive = true;
    // heartbeat の intervalSec 欄をループ開始時の実際の interval で上書きする（docs/contract.md §33.1）
    this.heartbeatIntervalSec = intervalSec;
    this.scheduleNext(intervalSec);
  }

  private scheduleNext(intervalSec: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runGuarded(intervalSec);
    }, intervalSec * 1000);
  }

  /** running ガード付きで tick を実行し、完了後に次回を予約する（tick 重なり禁止, docs/contract.md §12.9-2） */
  private async runGuarded(intervalSec: number): Promise<void> {
    if (this.running) {
      // setTimeout ベースの通常経路では到達しないはずだが、念のための保険（外部からの並行起動対策）。
      // 前回 tick が終わるまで今回は何もせず、次回の予約のみ行う。
      if (this.loopActive) {
        this.scheduleNext(intervalSec);
      }
      return;
    }

    this.running = true;
    const tick = this.runTick()
      .then((): void => undefined)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger.error("tick failed", { error: redactText(message) });
      });
    this.inFlightTick = tick;

    await tick;

    this.inFlightTick = null;
    this.running = false;
    if (this.loopActive) {
      this.scheduleNext(intervalSec);
    }
  }

  /**
   * 定期実行を停止する。次回予約をキャンセルし、進行中の tick があれば完了を待ってから返る
   * （docs/contract.md §12.9-2）。
   */
  async stop(): Promise<void> {
    this.loopActive = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlightTick !== null) {
      await this.inFlightTick;
    }
  }
}
