// 孤児 run（親タスクが done/archived、または進行中でなくなった run）の清掃ステージ
// stale claim（ready のまま長時間 claim_lock が残った行）の定期解放も担う（docs/contract.md §12.8-2）。
import { injectSession } from "@hachi/adapters";
import {
  evaluateBridgeProcessHygiene,
  isInProgressReason,
  listSystemProcesses,
  redactText,
  signalProcess,
} from "@hachi/core";
import type { KanbanStore, RunRow, SessionRef, Stage, StageDeps, StageResult, TaskRow } from "@hachi/core";
import type { ProcessEntry, ProcessListProvider, ProcessSignalSender } from "@hachi/core";
import { SUPERVISOR_ACTOR } from "../constants.js";
import {
  activeAnswerLease,
  isLiveQuestionAwaiting,
  latestQuestionAwaitingPayload,
  QUESTION_AWAITING_EVENT_TYPE,
  QUESTION_EXPIRED_EVENT_TYPE,
} from "../question-awaiting.js";
import { parseRunMeta } from "../session-ref.js";
import { sendOperationalNotification } from "./notify.js";
import { cancellationForRun } from "./cancel.js";

/** stale claim とみなす経過秒数（docs/contract.md §12.8-2, 10分） */
const STALE_CLAIM_THRESHOLD_SEC = 600;

function runMetaRecord(run: RunRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(run.meta) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isReviewerRun(run: RunRow): boolean {
  return runMetaRecord(run).role === "reviewer";
}

function isCurrentInProgressRun(store: KanbanStore, task: TaskRow | null, run: RunRow): boolean {
  if (task === null || task.status !== "blocked" || !isInProgressReason(task.blockReason)) {
    return false;
  }
  const latestRun = store.getLatestOpenRun(task.id);
  return latestRun !== null && latestRun.id === run.id;
}

function getLatestOpenReviewerRun(store: KanbanStore, taskId: string): RunRow | null {
  const runs = store.listOpenRuns().filter((candidate) => candidate.taskId === taskId && isReviewerRun(candidate));
  if (runs.length === 0) {
    return null;
  }
  return runs.reduce((latest, candidate) => {
    if (candidate.startedAt > latest.startedAt) {
      return candidate;
    }
    if (candidate.startedAt === latest.startedAt && candidate.id > latest.id) {
      return candidate;
    }
    return latest;
  });
}

function isCurrentReviewerRun(store: KanbanStore, task: TaskRow | null, run: RunRow): boolean {
  if (task === null || task.status !== "review" || !isReviewerRun(run)) {
    return false;
  }
  const latestRun = getLatestOpenReviewerRun(store, task.id);
  return latestRun !== null && latestRun.id === run.id;
}
const DEFAULT_MAX_RUN_SECONDS = 7200;
const BRIDGE_ORPHAN_MARGIN_SECONDS = 1800;
const BRIDGE_ORPHAN_LIMIT = 50;
const BRIDGE_ORPHAN_NOTIFY_THRESHOLD = 10;
const BRIDGE_ORPHAN_KILL_GRACE_MS = 10_000;
const BRIDGE_ORPHAN_REAP_EVENT = "bridge_orphan_subtree_reaped";
const BRIDGE_ORPHAN_COMMAND_MAX_CHARS = 200;

const RELEASED_INTERRUPT_MESSAGE =
  "【supervisor】あなたの run は released されました（親タスクは終端）。直ちに全ての作業を中止し、" +
  'hachi-handoff-v1 (outcome=failed, summary="run released のため中止") を出力して終了してください。';

interface ProcessSnapshotEntry {
  pid: number;
  startTime: string;
}

export interface ReapStageOptions {
  listProcesses?: ProcessListProvider;
  signalProcess?: ProcessSignalSender;
  delay?: (ms: number) => Promise<void>;
  notifyOperational?: typeof sendOperationalNotification;
}

/** reap が走査中の run 行そのものから SessionRef を復元する（最新 run への取り違え防止）。 */
function sessionRefFromRun(run: RunRow): SessionRef {
  const { serverUrl, model, modelDelivery, nativeCommunication } = parseRunMeta(run.meta);
  return {
    provider: run.provider,
    sessionId: run.sessionId,
    serverUrl,
    model,
    modelDelivery,
    ...(nativeCommunication === undefined ? {} : { nativeCommunication }),
    startedAt: run.startedAt,
  };
}

/** bridge 接続先が記録されている run のみ中断注入対象にする。direct/旧データは skip。 */
function shouldInject(ref: SessionRef): boolean {
  return ref.serverUrl !== "" && ref.serverUrl !== "direct";
}

async function injectReleasedInterrupt(deps: StageDeps, run: RunRow): Promise<boolean> {
  const ref = sessionRefFromRun(run);
  if (!shouldInject(ref)) {
    return false;
  }

  try {
    await injectSession(deps.env.bridges[ref.provider], ref, RELEASED_INTERRUPT_MESSAGE);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn("reap: released run への中断注入に失敗しました", {
      taskId: run.taskId,
      runId: run.id,
      sessionId: ref.sessionId,
      error: redactText(message),
    });
    return false;
  }
}

interface DirectRunCleanupResult {
  /** 契約 §34.2.1 の StopResult.stopped をそのまま写す（terminated/killed のみ true）。 */
  directCleanup: boolean;
  /** StopResult.reason、または stop() を呼べなかった/例外を投げた場合の診断ラベル。契約 §34.2.1 の証拠キーは reason 固定。 */
  reason: string;
}

async function cleanupReleasedDirectRun(deps: StageDeps, run: RunRow): Promise<DirectRunCleanupResult> {
  const ref = sessionRefFromRun(run);
  if (ref.serverUrl !== "direct") {
    return { directCleanup: false, reason: "not-direct" };
  }

  const adapter = deps.directAdapters?.[ref.provider];
  if (adapter?.stop === undefined) {
    deps.logger.warn("reap: direct released run の process group cleanup が未構成です", {
      taskId: run.taskId,
      runId: run.id,
      sessionId: ref.sessionId,
      provider: ref.provider,
    });
    return { directCleanup: false, reason: "adapter-unavailable" };
  }

  try {
    // 契約 §34.2.1: stop() は例外を投げなくても stopped:false（already-exited/unsupported/
    // unsignalable/kill-unconfirmed）を返しうる。process 停止の「確認」を意味するのは
    // stopped:true の場合のみであり、例外が無いことをもって cleanup 成功とみなしてはならない。
    // reason は stopped の値に関わらず必ず run_released イベントへ reason キーで格納する
    // （呼び出し元）。ここでのログレベルは unsignalable/kill-unconfirmed（＝停止未確認）
    // が warn、already-exited/unsupported（＝想定内）が info。
    const result = await adapter.stop(ref);
    if (!result.stopped) {
      const fields = { taskId: run.taskId, runId: run.id, sessionId: ref.sessionId, reason: result.reason };
      if (result.reason === "unsignalable" || result.reason === "kill-unconfirmed") {
        deps.logger.warn("reap: direct released run の process group 停止を確認できませんでした", fields);
      } else {
        deps.logger.info("reap: direct released run の process group cleanup は停止呼び出し不要でした（想定内）", fields);
      }
    }
    return { directCleanup: result.stopped, reason: result.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn("reap: direct released run の process group cleanup に失敗しました", {
      taskId: run.taskId,
      runId: run.id,
      sessionId: ref.sessionId,
      error: redactText(message),
    });
    return { directCleanup: false, reason: "stop-threw" };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processMapByPid(processes: readonly ProcessEntry[]): Map<number, ProcessEntry> {
  return new Map(processes.map((entry) => [entry.pid, entry]));
}

function snapshotPids(pids: readonly number[], processes: readonly ProcessEntry[]): ProcessSnapshotEntry[] {
  const byPid = processMapByPid(processes);
  return pids.flatMap((pid) => {
    const entry = byPid.get(pid);
    return entry === undefined ? [] : [{ pid, startTime: entry.startTime }];
  });
}

async function signalAll(
  pids: readonly number[],
  signal: NodeJS.Signals,
  sendSignal: ProcessSignalSender,
  deps: StageDeps,
): Promise<number[]> {
  const failedPids: number[] = [];
  for (const pid of pids) {
    try {
      await sendSignal(pid, signal);
    } catch (error) {
      failedPids.push(pid);
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn("reap: bridge 孤児プロセスへの signal 試行に失敗しました", {
        pid,
        signal,
        error: redactText(message),
      });
    }
  }
  return failedPids;
}

async function isSameLiveProcess(
  snapshot: ProcessSnapshotEntry,
  currentByPid: ReadonlyMap<number, ProcessEntry>,
  sendSignal: ProcessSignalSender,
  deps: StageDeps,
): Promise<boolean> {
  const current = currentByPid.get(snapshot.pid);
  if (current === undefined || current.startTime !== snapshot.startTime) {
    return false;
  }

  try {
    await sendSignal(snapshot.pid, 0);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn("reap: bridge 孤児プロセスの生存確認に失敗しました", {
      pid: snapshot.pid,
      error: redactText(message),
    });
    return false;
  }
}

export async function reapBridgeProcessHygiene(
  deps: StageDeps,
  apply: boolean,
  options: ReapStageOptions = {},
): Promise<{ actions: number; notes: string[]; reaped: number }> {
  const notes: string[] = [];
  const listProcesses = options.listProcesses ?? listSystemProcesses;
  const sendSignal = options.signalProcess ?? signalProcess;
  const wait = options.delay ?? delay;
  const notifyOperational = options.notifyOperational ?? sendOperationalNotification;
  const maxRunSeconds = deps.config.resourceGuard.maxRunSeconds ?? DEFAULT_MAX_RUN_SECONDS;

  let processes: ProcessEntry[];
  try {
    processes = await listProcesses();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn("reap: プロセス走査に失敗しました（bridge 孤児回収は fail-open でスキップ）", {
      error: redactText(message),
    });
    notes.push("bridge 孤児プロセス走査に失敗したためスキップしました");
    return { actions: 0, notes, reaped: 0 };
  }

  const report = evaluateBridgeProcessHygiene(processes, maxRunSeconds, BRIDGE_ORPHAN_LIMIT);
  if (report.failOpenReason !== "") {
    return { actions: 0, notes, reaped: 0 };
  }

  if (report.orphanCount === 0) {
    return { actions: 0, notes, reaped: 0 };
  }

  const thresholdSeconds = maxRunSeconds + BRIDGE_ORPHAN_MARGIN_SECONDS;
  const capped = report.targets.length < report.orphanCount ? `（上限${BRIDGE_ORPHAN_LIMIT}件まで）` : "";
  notes.push(
    `bridge 孤児プロセス ${report.orphanCount} 件を検出しました（閾値>${thresholdSeconds}s）${capped}`,
  );

  if (apply) {
    const snapshots = report.targets.map((target) => snapshotPids(target.pids, processes));
    for (const target of report.targets) {
      notes.push(`bridge 孤児 subtree root pid=${target.root.pid} を回収します`);
      const failedPids = await signalAll(target.pids, "SIGTERM", sendSignal, deps);
      // signalProcess は ESRCH を正常 return にするため、成功とは区別せず試行と catch した失敗だけを記録する。
      deps.logger.info(BRIDGE_ORPHAN_REAP_EVENT, {
        rootPid: target.root.pid,
        attemptedPids: target.pids,
        failedPids,
        rootCommand: target.root.command.slice(0, BRIDGE_ORPHAN_COMMAND_MAX_CHARS),
        rootEtime: target.root.etime,
        thresholdSeconds,
      });
    }
    await wait(BRIDGE_ORPHAN_KILL_GRACE_MS);

    let refreshedProcessMap: Map<number, ProcessEntry> | null;
    try {
      refreshedProcessMap = processMapByPid(await listProcesses());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn("reap: SIGKILL 前の PID 識別子照合に失敗しました（PID 再利用防止のため SIGKILL はスキップ）", {
        error: redactText(message),
      });
      notes.push("SIGKILL 前の PID 識別子照合に失敗したため、bridge 孤児への SIGKILL をスキップしました");
      refreshedProcessMap = null;
    }

    if (refreshedProcessMap !== null) {
      for (const target of snapshots) {
        const killPids: number[] = [];
        for (const snapshot of target) {
          if (await isSameLiveProcess(snapshot, refreshedProcessMap, sendSignal, deps)) {
            killPids.push(snapshot.pid);
          }
        }
        await signalAll(killPids, "SIGKILL", sendSignal, deps);
      }
    }

    if (report.targets.length > BRIDGE_ORPHAN_NOTIFY_THRESHOLD) {
      await notifyOperational(deps, {
        id: `bridge-orphan-reap:${Date.now()}`,
        title: "bridge orphan processes reaped",
        body: `bridge 孤児プロセスを ${report.targets.length} 件回収しました（descendants=${report.bridgeDescendantCount}, detected=${report.orphanCount}）`,
      });
    }
  } else {
    notes.push(`dry-run: bridge 孤児プロセス ${report.targets.length} 件を回収予定`);
  }

  return { actions: report.targets.length, notes, reaped: apply ? report.targets.length : 0 };
}

export function createReapStage(options: ReapStageOptions = {}): Stage {
  return {
    name: "reap",

    async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
      const { store } = deps;
      const notes: string[] = [];
      let actions = 0;

      for (const run of store.listOpenRuns()) {
        if (cancellationForRun(store, run.id) !== null) {
          notes.push(`run#${run.id} (task=${run.taskId}) は cancel stop 証拠待ちのため reap しません`);
          continue;
        }
        const task = store.getTask(run.taskId);
        const questionEvents = store.listEvents(run.taskId, QUESTION_AWAITING_EVENT_TYPE);
        const answerLease = activeAnswerLease(store.listEvents(run.taskId), run.sessionId, now);
        if (isLiveQuestionAwaiting(task, run, questionEvents, now)) {
          continue;
        }
        if (answerLease !== null) {
          continue;
        }
        const expiredQuestion = latestQuestionAwaitingPayload(questionEvents, run.sessionId);
        if (
          task !== null &&
          task.status === "blocked" &&
          task.blockReason.startsWith("worker-question:") &&
          expiredQuestion !== null &&
          expiredQuestion.deadline <= now
        ) {
          if (!apply) {
            actions += 1;
            notes.push(`run#${run.id} (task=${run.taskId}) の question_awaiting が期限切れのため released します`);
          } else {
            const released = store.transaction((): boolean => {
              const currentTask = store.getTask(run.taskId);
              const currentRun = store.getOpenRunByTaskSession(run.taskId, run.sessionId);
              const currentQuestionEvents = store.listEvents(run.taskId, QUESTION_AWAITING_EVENT_TYPE);
              const currentQuestion = latestQuestionAwaitingPayload(currentQuestionEvents, run.sessionId);
              const currentAnswerLease = activeAnswerLease(store.listEvents(run.taskId), run.sessionId, now);
              if (
                currentTask !== null &&
                currentTask.status === "blocked" &&
                currentTask.blockReason.startsWith("worker-question:") &&
                currentRun !== null &&
                currentQuestion !== null &&
                currentQuestion.deadline <= now &&
                currentAnswerLease === null
              ) {
                store.addEvent(run.taskId, QUESTION_EXPIRED_EVENT_TYPE, SUPERVISOR_ACTOR, {
                  sessionId: run.sessionId,
                  runId: run.id,
                  questionId: currentQuestion.questionId,
                  baselineResultCount: currentQuestion.baselineResultCount,
                  deadline: currentQuestion.deadline,
                });
                store.endRun(currentRun.id, "released");
                return true;
              }
              return false;
            });
            if (released) {
              actions += 1;
              notes.push(`run#${run.id} (task=${run.taskId}) の question_awaiting が期限切れのため released します`);
            }
          }
          continue;
        }
        // review ステージ（docs/contract.md §15）は status='review' のまま reviewer run を open で
        // 持つ（block しない設計）。isInProgressReason は blocked タスクの block_reason にしか
        // 意味を持たないため、review 状態のタスクは別途「進行中」として扱い誤って released しない。
        const isOrphan =
          task === null ||
          task.status === "done" ||
          task.status === "archived" ||
          !(isCurrentInProgressRun(store, task, run) || isCurrentReviewerRun(store, task, run));

        if (!isOrphan) {
          continue;
        }

        actions += 1;
        notes.push(`run#${run.id} (task=${run.taskId}) を released します`);
        if (apply) {
          const injected = await injectReleasedInterrupt(deps, run);
          // 契約 §34.2.1: run_released イベントの証拠キーは reason 固定（directCleanupReason ではない）。
          const { directCleanup, reason } = await cleanupReleasedDirectRun(deps, run);
          store.endRun(run.id, "released");
          if (task !== null) {
            store.addEvent(task.id, "run_released", SUPERVISOR_ACTOR, {
              runId: run.id,
              injected,
              directCleanup,
              reason,
            });
          }
        }
      }

      // stale claim の定期清掃（docs/contract.md §12.8-2）。
      // apply 時のみ実際に解放する。dry-run は対象件数のみ note に記録する（listByStatus は副作用が無いため
      // 冪等に見積り可能。dispatch の claim_lock 除外フィルタと同じ判定基準を使う）。
      if (apply) {
        const cleared = store.clearStaleClaims(STALE_CLAIM_THRESHOLD_SEC, now, SUPERVISOR_ACTOR);
        if (cleared > 0) {
          actions += cleared;
          notes.push(`stale claim を ${cleared} 件解放しました`);
        }
      } else {
        const staleCount = store
          .listByStatus("ready")
          .filter((task) => task.claimLock !== "" && task.updatedAt < now - STALE_CLAIM_THRESHOLD_SEC).length;
        if (staleCount > 0) {
          actions += staleCount;
          notes.push(`dry-run: stale claim ${staleCount} 件を解放予定`);
        }
      }

      const processHygiene = await reapBridgeProcessHygiene(deps, apply, options);
      actions += processHygiene.actions;
      notes.push(...processHygiene.notes);

      return { name: "reap", actions, skipped: false, notes };
    },
  };
}

export const reapStage: Stage = createReapStage();
