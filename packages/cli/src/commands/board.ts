// =============================================================================
// hachi board: 状態別件数・done origin・in-progress（blocked かつ進行中 prefix）・
// human_queue（blocked かつ要対応 prefix。docs/contract.md §36）の一覧を表示する
// =============================================================================

import type { Command } from "commander";
import {
  deriveDoneOrigin,
  HUMAN_QUEUE_PREFIXES,
  summarizeDoneOrigins,
  TASK_STATUSES,
  type DoneOriginStats,
  type TaskRow,
  type TaskStatus,
} from "@hachi/core";
import type { CliDeps } from "../deps.js";
import { withErrorHandling } from "../errors.js";
import { emit, truncate } from "../output.js";

const REASON_MAX_LENGTH = 80;
/** human_queue 一覧の reason 表示は契約上「60字程度」で切る（docs/contract.md §36） */
const HUMAN_QUEUE_REASON_MAX_LENGTH = 60;

interface BoardOptions {
  json?: boolean;
  tenant?: string;
}

/** in-progress 一覧の表示要素（id/title/reason 先頭 80 字） */
interface InProgressSummary {
  id: string;
  title: string;
  reason: string;
}

/** human_queue 一覧の表示要素（id/priority/reason 先頭 60 字/title。docs/contract.md §36） */
interface HumanQueueSummary {
  id: string;
  priority: number;
  reason: string;
  title: string;
}

function summarizeInProgress(task: TaskRow): InProgressSummary {
  return { id: task.id, title: task.title, reason: truncate(task.blockReason, REASON_MAX_LENGTH) };
}

function summarizeHumanQueue(task: TaskRow): HumanQueueSummary {
  return {
    id: task.id,
    priority: task.priority,
    reason: truncate(task.blockReason, HUMAN_QUEUE_REASON_MAX_LENGTH),
    title: task.title,
  };
}

/**
 * block_reason が human_queue prefix（HUMAN_QUEUE_PREFIXES）のいずれかで始まるか判定する。
 * prefix 定義は core（readview.ts）の export 定数を唯一の定義とし、ここでは import するのみ
 * （docs/contract.md §36「三重定義の禁止」）。
 */
function isHumanQueueTask(task: TaskRow): boolean {
  return HUMAN_QUEUE_PREFIXES.some((prefix) => task.blockReason.startsWith(prefix));
}

/** tenant 指定時のみ絞り込む（未指定時はそのまま返す） */
function filterByTenant(tasks: TaskRow[], tenant: string | undefined): TaskRow[] {
  return tenant === undefined ? tasks : tasks.filter((task) => task.tenant === tenant);
}

/** human_queue の表示順（priority 降順→更新古い順。KanbanReadView.humanQueue と同じ並び） */
function compareHumanQueue(a: TaskRow, b: TaskRow): number {
  return b.priority - a.priority || a.updatedAt - b.updatedAt;
}

/**
 * 状態別件数を算出する。KanbanStore.counts() は tenant 引数を持たないため、
 * tenant 指定時は全状態を listByStatus で取得し JS 側で絞り込んでから再集計する。
 */
function computeCounts(deps: CliDeps, tenant: string | undefined): Record<TaskStatus, number> {
  if (tenant === undefined) {
    return deps.store.counts();
  }
  const base = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<TaskStatus, number>;
  for (const status of TASK_STATUSES) {
    base[status] = filterByTenant(deps.store.listByStatus(status), tenant).length;
  }
  return base;
}

/** 現在doneのtaskを、各taskの確定event列から集約する。 */
function computeDoneOrigins(deps: CliDeps, tenant: string | undefined): DoneOriginStats {
  const doneTasks = filterByTenant(deps.store.listByStatus("done"), tenant);
  return summarizeDoneOrigins(doneTasks.map((task) => deriveDoneOrigin(deps.store.listEvents(task.id))));
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** hachi board コマンドを登録する */
export function registerBoardCommand(program: Command, deps: CliDeps): void {
  program
    .command("board")
    .description("状態別件数・done origin・進行中・要対応タスクの一覧を表示する")
    .option("--json", "JSON 形式で出力する")
    .option("--tenant <tenant>", "指定 tenant のタスクのみに絞り込む")
    .action(
      withErrorHandling(deps, (options: BoardOptions): void => {
        const tenant = options.tenant;
        const json = options.json === true;

        const counts = computeCounts(deps, tenant);
        const doneOrigins = computeDoneOrigins(deps, tenant);
        const inProgress = filterByTenant(deps.store.listInProgress(), tenant).map(summarizeInProgress);
        const humanQueue = filterByTenant(deps.store.listByStatus("blocked").filter(isHumanQueueTask), tenant)
          .sort(compareHumanQueue)
          .map(summarizeHumanQueue);

        const textLines: string[] = ["=== 状態別件数 ==="];
        for (const [status, count] of Object.entries(counts)) {
          textLines.push(`${status}: ${count}`);
        }
        textLines.push("", "=== Done origin ===");
        textLines.push(
          `gate_passed: ${doneOrigins.counts.gatePassed} (${formatRate(doneOrigins.automaticCompletionRate)})`,
          `orchestrator_host_finalize: ${doneOrigins.counts.orchestratorHostFinalize}`,
          `human_decision: ${doneOrigins.counts.humanDecision}`,
          `manual recovery: ${formatRate(doneOrigins.manualRecoveryRate)}`,
          `unknown: ${doneOrigins.counts.unknown} (${formatRate(doneOrigins.unknownRate)})`,
        );
        textLines.push("", "=== 進行中 (in-progress) ===");
        if (inProgress.length === 0) {
          textLines.push("(進行中のタスクはありません)");
        } else {
          for (const item of inProgress) {
            textLines.push(`${item.id}  ${item.title}  ${item.reason}`);
          }
        }
        textLines.push("", "=== 要対応 (human_queue) ===");
        if (humanQueue.length === 0) {
          textLines.push("(要対応のタスクはありません)");
        } else {
          for (const item of humanQueue) {
            textLines.push(`${item.id}  p${item.priority}  ${item.reason}  ${item.title}`);
          }
        }

        emit(deps, json, { counts, doneOrigins, inProgress, humanQueue }, textLines);
      }),
    );
}
