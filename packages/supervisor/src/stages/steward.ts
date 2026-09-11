// steward ステージ — 判断面の自動化（docs/contract.md §40）
// 短命判断セッションで board を走査し、triage 仕分け・閉じ忘れ検出・spec 不足指摘・escalate を
// 提案として出力する。適用権限は「低リスクのみ自動・他は人間承認」（two-party gate）。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  HUMAN_QUEUE_PREFIXES,
  acquireStewardStateLock,
  redactText,
  resolveModel,
  sha256Hex,
  writeFileAtomic0600Durable,
} from "@hachi/core";
import type {
  KanbanStore,
  Logger,
  ModelResolution,
  Stage,
  StageDeps,
  StageResult,
  TaskRow,
  WorkerAdapter,
} from "@hachi/core";
import { SUPERVISOR_ACTOR } from "../constants.js";
import {
  sendAdHocNotification,
  sendOperationalNotification,
  type OperationalNotifyInput,
  type OperationalNotifyResult,
  type StewardAdHocKind,
} from "./notify.js";
import {
  decideAutoDisableFailure,
  decideAutoDisableRun,
  decideAutoDisableSuccess,
  runUnderAutoDisableHalfOpenClaimFence,
  tryAcquireAutoDisableHalfOpenClaim,
  type AutoDisableCircuitStateStore,
} from "./auto-disable-circuit-breaker.js";
import {
  INTEGRATION_EVIDENCE_VALUES,
  decideArchiveIntegration,
  type ArchiveIntegrationObservation,
  type IntegrationEvidence,
} from "./steward-archive-integration.js";
import { stewardArchiveIntegrationProbe } from "./steward-archive-integration-probe.js";
import {
  decideDoneConsistency,
  type DoneConsistencyDecision,
} from "./steward-done-consistency.js";

// --- 定数 ---

/** cadence gating の既定間隔（分。§40.1） */
const DEFAULT_INTERVAL_MINUTES = 30;

/**
 * 同一 (kind, taskId) 提案の冪等窓（秒。§40.4）
 *
 * §69 で request 面へ移った提案の抑止は §69.4（core 側）が唯一の正本。この窓は request を持たない
 * 2 経路（done の auto-archive / 配送先0件の unrouted フォールスルー）だけに残す。
 */
const IDEMPOTENCY_WINDOW_SEC = 24 * 60 * 60;

/** task body の cwd 行。§69.3 の配送先解決へ worktree scope として渡す */
const CWD_LINE_REGEX = /^cwd:\s*(\S+)\s*$/m;

/** steward コメントの author 識別子（§40.4: steward 名義） */
const STEWARD_AUTHOR = "steward";

/** board スナップショットの body 先頭文字数（§40.2） */
const BODY_HEAD_LIMIT = 200;

/** direct steward セッション完了待ちの既定 timeout（秒）。short-lived 判断セッション用 */
const DEFAULT_SESSION_TIMEOUT_SEC = 300;

/** direct steward セッション status ポーリング間隔（ms） */
const DEFAULT_SESSION_POLL_INTERVAL_MS = 1_000;

/** 1 claim で扱う提案数。git probe 最大約35秒/件と通知最大約20秒/件を有界化する。 */
const HALF_OPEN_PROPOSAL_LIMIT = 20;

/** claim expiry 3600秒の半分。session 300秒 + 20提案の最悪時見積り約1100秒へ余白を残す。 */
const HALF_OPEN_CLAIM_MAX_ELAPSED_MS = 30 * 60 * 1_000;

// --- 型定義 ---

/** state/steward.json の構造（§40.5 / §69.7） */
export interface StewardState {
  lastRunAt: number;
  lastProposalCount: number;
  lastAppliedCount: number;
  lastProposedCount: number;
  /** §69.7: durable request として発行した提案数 */
  lastRequestedCount: number;
  /** §69.7: §69.4 の判定で抑止した再提案数 */
  lastSuppressedCount: number;
  /** §74.3: 直近 tick で integrationEvidence 別に自動 archive した件数（計数・可視化の下地） */
  lastArchivedByEvidence: Partial<Record<IntegrationEvidence, number>>;
  lastError: string;
  consecutiveFailures: number;
  autoDisabled: boolean;
  autoDisabledReason: string;
  /** auto-disable へ遷移した時刻。0 は legacy state から即座に half-open 可を表す */
  autoDisabledAt: number;
  /** half-open claim の単調増加世代。legacy state の欠落は 0 とする */
  claimGeneration: number;
}

/** state/steward.json に書き込む field の全集合。CLI の strict parser との同期にも使う。 */
export const SUPERVISOR_STEWARD_STATE_KEYS = [
  "lastRunAt",
  "lastProposalCount",
  "lastAppliedCount",
  "lastProposedCount",
  "lastRequestedCount",
  "lastSuppressedCount",
  "lastArchivedByEvidence",
  "lastError",
  "consecutiveFailures",
  "autoDisabled",
  "autoDisabledReason",
  "autoDisabledAt",
  "claimGeneration",
] as const satisfies readonly (keyof StewardState)[];

type ExactKeySet<Expected, Actual> = Exclude<Expected, Actual> extends never
  ? Exclude<Actual, Expected> extends never
    ? true
    : false
  : false;
type Assert<T extends true> = T;

/** interface と runtime key 一覧の片側だけが変われば typecheck を失敗させる。 */
export type SupervisorStewardStateKeysMatch = Assert<
  ExactKeySet<keyof StewardState, (typeof SUPERVISOR_STEWARD_STATE_KEYS)[number]>
>;

const DEFAULT_STATE: StewardState = {
  lastRunAt: 0,
  lastProposalCount: 0,
  lastAppliedCount: 0,
  lastProposedCount: 0,
  lastRequestedCount: 0,
  lastSuppressedCount: 0,
  lastArchivedByEvidence: {},
  lastError: "",
  consecutiveFailures: 0,
  autoDisabled: false,
  autoDisabledReason: "",
  autoDisabledAt: 0,
  claimGeneration: 0,
};

/** §74.2 決定表の enum 全12値（drift を含む）。state 読込時の型検証に使う */
export const KNOWN_INTEGRATION_EVIDENCE: ReadonlySet<string> =
  new Set<IntegrationEvidence>(INTEGRATION_EVIDENCE_VALUES);

/** state/steward.json の lastArchivedByEvidence を防御的にパースする。壊れたキー/値は既定値へ落とす */
function parseArchivedByEvidence(value: unknown): Partial<Record<IntegrationEvidence, number>> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const result: Partial<Record<IntegrationEvidence, number>> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (KNOWN_INTEGRATION_EVIDENCE.has(key) && typeof count === "number") {
      result[key as IntegrationEvidence] = count;
    }
  }
  return result;
}

/**
 * steward_auto_archive イベントの payload から integrationEvidence を安全に取り出す。
 * §74.3 の朝夕ブリーフ集計など、steward.ts の外から直接イベントを読む場合に使う。
 * 壊れた値・未知の evidence 文字列は null に倒す。
 */
export function parseArchiveEventIntegrationEvidence(payload: unknown): IntegrationEvidence | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const value = (payload as Record<string, unknown>).integrationEvidence;
  if (typeof value === "string" && KNOWN_INTEGRATION_EVIDENCE.has(value)) {
    return value as IntegrationEvidence;
  }
  return null;
}

/** 提案の kind（§40.3） */
const PROPOSAL_KINDS = ["promote", "archive", "spec-lint", "escalate"] as const;
type ProposalKind = (typeof PROPOSAL_KINDS)[number];

interface Proposal {
  kind: ProposalKind;
  taskId: string;
  reason: string;
}

interface DoneConsistencyEntry {
  task: TaskRow;
  decision: DoneConsistencyDecision;
}

// --- zod スキーマ（hachi-steward-v1 フェンスのパース） ---

const proposalSchema = z.object({
  kind: z.enum(PROPOSAL_KINDS),
  taskId: z.string().min(1),
  // core の createStewardProposalRequest は空 reason を throw する。ここで弾かないと
  // LLM の 1 提案で tick 全体が落ち、writeStewardState へ到達せず auto-disable が働かなくなる
  reason: z.string().trim().min(1),
});

const stewardOutputSchema = z.object({
  proposals: z.array(z.unknown()),
});

// --- DI インターフェース ---

/**
 * 判断セッションの実行抽象。テストでは fake を注入し、実 LLM を起動しない（§40 実装ノート）。
 * 戻り値はセッションの最終出力テキスト（hachi-steward-v1 フェンスを含む）。
 */
export interface StewardSessionRunner {
  run(prompt: string): Promise<string>;
}

/** steward ステージの通知関数型。false は transport 全 skip など通知未試行を表す（§40.4 notify 経路） */
export type StewardNotifyFn = (taskId: string, message: string, kind: StewardAdHocKind) => Promise<boolean | void>;

/** auto-disable / half-open 復帰を既存 ad-hoc notify 経路へ渡す関数型。 */
export type StewardLifecycleNotifyFn = (
  deps: StageDeps,
  task: TaskRow,
  message: string,
) => Promise<boolean>;

/** production stewardStage だけが実 notify transport を使う。half-open は outbox へ同期記録する。 */
type StewardNotifyMode = "none" | "transport" | "outbox";

export interface StewardStageOptions {
  /** 判断セッション実行（DI。未設定時は profile 有無で skip/warn） */
  sessionRunner?: StewardSessionRunner;
  /** 時刻ソース（epoch 秒。テスト DI） */
  nowFn?: () => number;
  /** 通知関数（§40.4 notify 経路。未設定時は通知スキップ） */
  notifyFn?: StewardNotifyFn;
  /** auto-disable / half-open 復帰通知（production は sendAdHocNotification）。 */
  lifecycleNotifyFn?: StewardLifecycleNotifyFn;
  /** notifyFn 未指定時に §38 transport を使うかどうか */
  notifyMode?: StewardNotifyMode;
  /** direct session の完了待ち timeout（秒。テスト DI） */
  sessionTimeoutSec?: number;
  /** direct session の status ポーリング間隔（ms。テスト DI） */
  sessionPollIntervalMs?: number;
  /** half-open claim の経過時間計測用 monotonic clock（ms。テスト DI） */
  elapsedNowFn?: () => number;
}

interface StewardOutboxNotification {
  task: TaskRow;
  message: string;
  kind: StewardAdHocKind;
}

type StewardMutationFence = <Result>(
  operation: () => Result,
  notificationForResult?: (result: Result) => StewardOutboxNotification | undefined,
) => Result;

class HalfOpenClaimFenceError extends Error {
  constructor(readonly status: "lock-contended" | "claim-mismatch") {
    super(`steward half-open claim fence を通過できませんでした: ${status}`);
  }
}

function runStewardMutationUnfenced<Result>(operation: () => Result): Result {
  return operation();
}

// --- state I/O ---

function stewardStatePath(home: string): string {
  return join(home, "state", "steward.json");
}

/** state/steward.json を読み取る。ファイル不在・壊れた JSON は既定値にフォールバック */
export function readStewardState(home: string): StewardState {
  const path = stewardStatePath(home);
  if (!existsSync(path)) {
    return { ...DEFAULT_STATE };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return { ...DEFAULT_STATE };
    }
    const obj = parsed as Record<string, unknown>;
    return {
      lastRunAt: typeof obj.lastRunAt === "number" ? obj.lastRunAt : 0,
      lastProposalCount: typeof obj.lastProposalCount === "number" ? obj.lastProposalCount : 0,
      lastAppliedCount: typeof obj.lastAppliedCount === "number" ? obj.lastAppliedCount : 0,
      lastProposedCount: typeof obj.lastProposedCount === "number" ? obj.lastProposedCount : 0,
      lastRequestedCount: typeof obj.lastRequestedCount === "number" ? obj.lastRequestedCount : 0,
      lastSuppressedCount: typeof obj.lastSuppressedCount === "number" ? obj.lastSuppressedCount : 0,
      lastArchivedByEvidence: parseArchivedByEvidence(obj.lastArchivedByEvidence),
      lastError: typeof obj.lastError === "string" ? obj.lastError : "",
      consecutiveFailures: typeof obj.consecutiveFailures === "number" ? obj.consecutiveFailures : 0,
      autoDisabled: typeof obj.autoDisabled === "boolean" ? obj.autoDisabled : false,
      autoDisabledReason: typeof obj.autoDisabledReason === "string" ? obj.autoDisabledReason : "",
      autoDisabledAt: typeof obj.autoDisabledAt === "number" ? obj.autoDisabledAt : 0,
      claimGeneration: obj.claimGeneration === undefined
        ? 0
        : typeof obj.claimGeneration === "number"
          ? obj.claimGeneration
          : Number.NaN,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeStewardStateUnderLock(home: string, state: StewardState): void {
  const stateDir = join(home, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileAtomic0600Durable(stewardStatePath(home), JSON.stringify(state));
}

function areStewardStatesEqual(left: StewardState, right: StewardState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stewardCircuitStateStore(home: string): AutoDisableCircuitStateStore<StewardState> {
  return {
    home,
    lockOwner: "supervisor-steward",
    readState: () => readStewardState(home),
    writeStateUnderLock: (state) => writeStewardStateUnderLock(home, state),
  };
}

/** state/steward.json を排他下で durable atomic 0600 書き込みする。 */
export function writeStewardState(home: string, state: StewardState, expectedState?: StewardState): void {
  const lock = acquireStewardStateLock(home, "supervisor-steward");
  if (lock === null) {
    throw new Error("steward state は別processが操作中のため次tickへ延期します");
  }
  try {
    if (expectedState !== undefined) {
      const current = readStewardState(home);
      if (!areStewardStatesEqual(current, expectedState)) {
        throw new Error("steward state がtick開始後に変更されたためstale writeを拒否しました");
      }
    }
    writeStewardStateUnderLock(home, state);
  } finally {
    lock.release();
  }
}

// --- config ---

interface StewardConfig {
  intervalMinutes?: number;
}

interface ConfigWithSteward {
  steward?: StewardConfig;
}

interface ConfigWithOrchestratorTenantDefaults {
  orchestrator?: {
    tenantDefaults?: Record<string, string>;
  };
}

function resolveIntervalMinutes(config: StageDeps["config"]): number {
  const steward = (config as StageDeps["config"] & ConfigWithSteward).steward;
  return steward?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
}

// --- board スナップショットプロンプト構築（§40.2） ---

function isHumanQueueReason(reason: string): boolean {
  return HUMAN_QUEUE_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

function elapsedHours(fromSec: number, nowSec: number): number {
  return Math.max(0, Math.floor((nowSec - fromSec) / 3600));
}

function taskLine(task: TaskRow, nowSec: number): string {
  const elapsed = elapsedHours(task.createdAt, nowSec);
  const bodyHead = redactText(task.body).replace(/\n/g, " ").slice(0, BODY_HEAD_LIMIT);
  return `- ${task.id} | ${redactText(task.title)} | tenant=${task.tenant} | priority=${task.priority} | ${elapsed}h経過 | ${bodyHead}`;
}

/** status=doneの全件をO2 read modelに基づくpure決定表で検査する。 */
export function scanDoneConsistency(store: KanbanStore): DoneConsistencyEntry[] {
  return store.listByStatus("done").map((task) => ({
    task,
    decision: decideDoneConsistency(task, store.listEvents(task.id)),
  }));
}

/** §40.2: board スナップショットを構築する（redact 済み） */
export function buildBoardSnapshot(store: KanbanStore, nowSec: number): string {
  const sections: string[] = [];

  // triage/todo/ready の一覧
  for (const status of ["triage", "todo", "ready"] as const) {
    const tasks = store.listByStatus(status);
    if (tasks.length > 0) {
      sections.push(`## ${status} (${tasks.length}件)`);
      for (const task of tasks) {
        sections.push(taskLine(task, nowSec));
      }
    }
  }

  // human_queue
  const blocked = store.listByStatus("blocked");
  const humanQueue = blocked.filter((t) => isHumanQueueReason(t.blockReason));
  if (humanQueue.length > 0) {
    sections.push(`## human_queue (${humanQueue.length}件)`);
    for (const task of humanQueue) {
      sections.push(
        `- ${task.id} | ${redactText(task.title)} | reason=${redactText(task.blockReason)}`,
      );
    }
  }

  // done だが archive されていない一覧
  const doneConsistency = scanDoneConsistency(store);
  const done = doneConsistency.map((entry) => entry.task);
  if (done.length > 0) {
    sections.push(`## done (未archive, ${done.length}件)`);
    for (const { task, decision } of doneConsistency) {
      const elapsed = task.completedAt !== null ? elapsedHours(task.completedAt, nowSec) : 0;
      sections.push(
        `- ${task.id} | ${redactText(task.title)} | tenant=${task.tenant} | 完了${elapsed}h経過 | done-consistency=${decision.verdict}/${decision.code} | origin=${decision.origin}`,
      );
    }
  }

  // 直近 task_events 要約（最新50件をまとめて表示）
  // listEvents は taskId 必須のため、done/triage/todo/ready タスクの最新イベントを収集する
  const recentEventSummaries: string[] = [];
  const allTasks = [
    ...store.listByStatus("triage"),
    ...store.listByStatus("todo"),
    ...store.listByStatus("ready"),
    ...done,
  ];
  for (const task of allTasks.slice(0, 20)) {
    const events = store.listEvents(task.id, undefined, 3);
    for (const event of events) {
      recentEventSummaries.push(
        `- ${task.id} | ${event.eventType} | ${event.actor} | ${new Date(event.createdAt * 1000).toISOString()}`,
      );
    }
  }
  if (recentEventSummaries.length > 0) {
    sections.push(`## 直近イベント要約`);
    sections.push(...recentEventSummaries.slice(0, 30));
  }

  return sections.join("\n");
}

/** 判断セッションに渡すプロンプトを構築する */
function buildStewardPrompt(boardSnapshot: string): string {
  return `あなたは hachi-kanban の steward（判断セッション）です。以下のボードスナップショットを確認し、判断提案を出してください。

## 判断基準
- archive: status=done のタスクで、完了後一定時間経過したものはアーカイブを提案
- archive: done 以外でも明らかに不要なタスクはアーカイブを提案（ただし人間承認が必要）
- promote: triage にあるタスクで、仕様が十分明確なものは todo/ready への昇格を提案
- spec-lint: 仕様不足のタスクに指摘コメントを提案
- escalate: 人間の判断が必要な緊急の問題を通知
- status=doneの整合性はdone-consistencyのpure決定表が正本です。直近eventの並びや過去の
  evidence_failed/verdict_missing/handoff_rejectedだけから矛盾を推測してescalateしないでください。
  done向けescalateはstageが機械判定へ置換するため、判断セッションから重複提案しないでください。

## ボードスナップショット
${boardSnapshot}

## 出力形式
以下のフェンスドブロックで提案を出力してください。提案がない場合は空配列を出してください。

\`\`\`hachi-steward-v1
{"proposals": [{"kind": "archive"|"promote"|"spec-lint"|"escalate", "taskId": "t_xxx", "reason": "理由"}]}
\`\`\``;
}

/**
 * done向けescalateはpure決定表だけを正本にする。LLMの時刻・event順序推測を除き、異常doneは
 * 他proposal（archiveを含む）より先にexactly-onceのescalateへ置換する。
 */
export function reconcileDoneConsistencyProposals(
  store: KanbanStore,
  proposals: readonly Proposal[],
): Proposal[] {
  const entries = scanDoneConsistency(store);
  const decisions = new Map(entries.map((entry) => [entry.task.id, entry.decision]));
  const deterministic: Proposal[] = entries
    .filter((entry) => entry.decision.verdict === "escalate")
    .map((entry) => ({
      kind: "escalate",
      taskId: entry.task.id,
      reason: `[done-consistency:${entry.decision.code}] ${entry.decision.reason}`,
    }));
  const retained = proposals.filter((proposal) => {
    const decision = decisions.get(proposal.taskId);
    if (decision === undefined) {
      return true;
    }
    if (decision.verdict === "escalate") {
      return false;
    }
    return proposal.kind !== "escalate";
  });
  return [...deterministic, ...retained];
}

// --- 出力パース（§40.3） ---

const STEWARD_FENCE_REGEX_GLOBAL = /```hachi-steward-v1\s*\n([\s\S]*?)```/g;

interface StewardParseResult {
  proposals: Proposal[];
  parseOk: boolean;
}

/** hachi-steward-v1 フェンスから proposals を抽出する。不正な kind / 不明な taskId は破棄＋warn */
function parseStewardOutputDetailed(
  output: string,
  store: KanbanStore,
  logger: Logger,
): StewardParseResult {
  const matches = [...output.matchAll(STEWARD_FENCE_REGEX_GLOBAL)];
  if (matches.length === 0) {
    logger.warn("steward: hachi-steward-v1 フェンスが見つかりません");
    return { proposals: [], parseOk: false };
  }

  // 最後のフェンスを使用する
  const lastMatch = matches[matches.length - 1];
  const jsonStr = lastMatch?.[1];
  if (jsonStr === undefined) {
    return { proposals: [], parseOk: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    logger.warn("steward: フェンス内の JSON パースに失敗しました");
    return { proposals: [], parseOk: false };
  }

  const result = stewardOutputSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn("steward: 出力スキーマの検証に失敗しました", { error: result.error.message });
    return { proposals: [], parseOk: false };
  }

  // taskId の存在検証（§40.3: 不明 taskId は破棄+warn）
  const valid: Proposal[] = [];
  for (const rawProposal of result.data.proposals) {
    const proposalResult = proposalSchema.safeParse(rawProposal);
    if (!proposalResult.success) {
      logger.warn("steward: 不正な proposal を破棄しました", {
        error: proposalResult.error.message,
      });
      continue;
    }
    const proposal = proposalResult.data;
    const task = store.getTask(proposal.taskId);
    if (task === null) {
      logger.warn("steward: 不明な taskId を破棄しました", {
        kind: proposal.kind,
        taskId: proposal.taskId,
      });
      continue;
    }
    valid.push(proposal);
  }

  return { proposals: valid, parseOk: true };
}

/** hachi-steward-v1 フェンスから proposals を抽出する。不正な kind / 不明な taskId は破棄＋warn */
export function parseStewardOutput(
  output: string,
  store: KanbanStore,
  logger: Logger,
): Proposal[] {
  return parseStewardOutputDetailed(output, store, logger).proposals;
}

// --- 24h 冪等（§40.4） ---

/** 同一 (kind, taskId) の提案が IDEMPOTENCY_WINDOW_SEC 以内に既出かどうかを判定する */
function hasRecentStewardComment(
  store: KanbanStore,
  kind: ProposalKind,
  taskId: string,
  nowSec: number,
): boolean {
  const cutoff = nowSec - IDEMPOTENCY_WINDOW_SEC;
  const prefix = kind === "spec-lint"
    ? "[steward 指摘] spec-lint:"
    : `[steward 提案] ${kind}:`;
  return store.listComments(taskId).some((comment) => (
    comment.author === STEWARD_AUTHOR &&
    comment.createdAt >= cutoff &&
    comment.body.startsWith(prefix)
  ));
}

function hasRecentProposalEvent(
  store: KanbanStore,
  kind: ProposalKind,
  taskId: string,
  nowSec: number,
  requireNotificationAttempted: boolean,
): boolean {
  const cutoff = nowSec - IDEMPOTENCY_WINDOW_SEC;
  const events = store.listEvents(taskId, "steward_proposal");
  for (const event of events) {
    if (event.createdAt < cutoff) {
      continue;
    }
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      if (payload.kind !== kind) {
        continue;
      }
      if (requireNotificationAttempted && payload.notificationAttempted === false) {
        continue;
      }
      return true;
    } catch {
      // JSON パース失敗は無視
    }
  }
  return false;
}

function hasRecentAutoArchiveEvent(
  store: KanbanStore,
  taskId: string,
  nowSec: number,
): boolean {
  const cutoff = nowSec - IDEMPOTENCY_WINDOW_SEC;
  const events = store.listEvents(taskId, "steward_auto_archive");
  for (const event of events) {
    if (event.createdAt < cutoff) {
      continue;
    }
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      if (payload.kind === "archive") {
        return true;
      }
    } catch {
      // JSON パース失敗は無視
    }
  }
  return false;
}

/**
 * §74.4: 同一 (taskId, integrationEvidence) の veto イベントが IDEMPOTENCY_WINDOW_SEC 以内に
 * 既出かどうかを判定する。抑止するのはイベント記録・通知だけであり、ゲート評価（probe呼び出し）
 * 自体は呼び出し元が毎tick必ず実行する。
 */
function hasRecentAutoArchiveVetoEvent(
  store: KanbanStore,
  taskId: string,
  integrationEvidence: IntegrationEvidence,
  nowSec: number,
): boolean {
  const cutoff = nowSec - IDEMPOTENCY_WINDOW_SEC;
  const events = store.listEvents(taskId, "steward_auto_archive_vetoed");
  for (const event of events) {
    if (event.createdAt < cutoff) {
      continue;
    }
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      if (payload.integrationEvidence === integrationEvidence) {
        return true;
      }
    } catch {
      // JSON パース失敗は無視
    }
  }
  return false;
}

/**
 * §74.3: board 可視の reason は integrationEvidence から機械的に生成する。
 * allow になる evidence は5つだけで、いずれも「統合済み」を主張しない文言にする
 * （clean-head-reachable / clean-patch-equivalent は未統合の成果が残っていないことの証明に留まる）。
 */
const ALLOW_EVIDENCE_REASON_TEXT: Partial<Record<IntegrationEvidence, string>> = {
  "clean-head-reachable":
    "worktree は clean で、未統合の成果は残っていません（成果が統合されたことの証明ではありません）",
  "clean-patch-equivalent":
    "worktree は clean で、ブランチの commit は統合先と patch 等価かつ内容一致です",
  "not-observable:repo-root":
    "repo root 直下の作業のため worktree 単位で統合を観測できません（repo root は clean でした）",
  "not-observable:repo-root-dirty":
    "repo root 直下の作業のため統合を観測できません（repo root に未コミットの変更がありました）",
  "not-observable:worktree-missing": "worktree が既に存在せず統合を確認できません",
};

/** allow evidence を board 可視の reason 文字列へ変換する。判断 session の自由文はここでは使わない */
function archiveEvidenceReasonText(integrationEvidence: IntegrationEvidence): string {
  const text = ALLOW_EVIDENCE_REASON_TEXT[integrationEvidence];
  if (text !== undefined) {
    return text;
  }
  // veto evidence が allow経路に来ることは decideArchiveIntegration の契約上あり得ないが、
  // 防御的に evidence 値自体だけを残す（欠落値・架空の統合主張は入れない）
  return `integrationEvidence=${integrationEvidence} により archive を適用しました`;
}

/**
 * §74.4: veto 通知本文に使う evidence 別の文言。§74.3 の allow 側と同じく、判断 session の
 * 自由文（proposal.reason）は使わず、integrationEvidence から機械的に生成する。「見送った」
 * 以上の主張（統合状況の断定等）をしないことで、事実と異なる通知を出さないようにする。
 */
function vetoEvidenceNoticeText(integrationEvidence: IntegrationEvidence): string {
  return `archive 提案を見送りました（integrationEvidence=${integrationEvidence}）。必要であれば手動で確認してください`;
}

/**
 * §74.4: veto イベントの integrationTarget。resolved はそのまま反映し、unresolved の理由は
 * cwd 正規化の結果から「統合先評価に到達しなかった」か「解決を試みて見つからなかった」かを区別する。
 */
function buildVetoIntegrationTarget(
  observation: ArchiveIntegrationObservation,
): { state: "resolved"; ref: string; oid: string } | { state: "unresolved"; reason: string } {
  const target = observation.integrationTarget;
  if (target !== undefined && target.state === "resolved") {
    return { state: "resolved", ref: target.ref, oid: target.oid };
  }
  const reason = observation.cwd.kind === "worktree-present"
    ? "worktree はあるが統合先 ref を1つも解決できなかった"
    : "cwd 正規化の結果、統合先 ref の評価に到達しなかった";
  return { state: "unresolved", reason };
}

/** 同一 (kind, taskId) の完了済み提案が IDEMPOTENCY_WINDOW_SEC 以内に既出かどうかを判定する */
function isIdempotent(
  store: KanbanStore,
  kind: ProposalKind,
  taskId: string,
  nowSec: number,
): boolean {
  if (kind === "spec-lint") {
    return hasRecentStewardComment(store, kind, taskId, nowSec);
  }
  if (kind === "archive" && hasRecentAutoArchiveEvent(store, taskId, nowSec)) {
    return true;
  }
  return hasRecentProposalEvent(store, kind, taskId, nowSec, true);
}

async function notifyStewardProposal(
  deps: StageDeps,
  task: TaskRow,
  message: string,
  kind: StewardAdHocKind,
  notifyFn: StewardNotifyFn | undefined,
  notifyMode: StewardNotifyMode,
): Promise<boolean> {
  if (notifyMode === "outbox") {
    return true;
  }
  if (notifyFn !== undefined) {
    const result = await notifyFn(task.id, message, kind);
    return result !== false;
  }
  if (notifyMode !== "transport") {
    return false;
  }
  return sendAdHocNotification(deps, task, message, kind);
}

const STEWARD_AD_HOC_KINDS = [
  "escalate",
  "promote",
  "archive",
  "spec-lint",
  "archive-vetoed",
] as const satisfies readonly StewardAdHocKind[];

interface StewardHalfOpenDrainResult {
  budgetExceeded: boolean;
}

type DeadlineResult<Result> =
  | { status: "completed"; value: Result }
  | { status: "timed-out" };

function parseOperationalNotifyInput(payload: string): OperationalNotifyInput | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const input = parsed as Record<string, unknown>;
    if (
      typeof input.id !== "string" ||
      typeof input.title !== "string" ||
      typeof input.body !== "string" ||
      (input.priority !== undefined && typeof input.priority !== "number") ||
      (input.detailUrl !== undefined && typeof input.detailUrl !== "string") ||
      (input.fullMacosBody !== undefined && typeof input.fullMacosBody !== "boolean")
    ) {
      return null;
    }
    return input as unknown as OperationalNotifyInput;
  } catch {
    return null;
  }
}

function isStewardAdHocKind(value: string): value is StewardAdHocKind {
  return (STEWARD_AD_HOC_KINDS as readonly string[]).includes(value);
}

function enqueueStewardHalfOpenNotification(
  store: KanbanStore,
  claimGeneration: number,
  nowSec: number,
  notification: StewardOutboxNotification,
): void {
  const input: OperationalNotifyInput = {
    id: notification.task.id,
    title: notification.task.title,
    body: notification.message,
    priority: notification.task.priority,
  };
  const payload = JSON.stringify(input);
  store.enqueueHalfOpenOutbox({
    stage: "steward",
    claimGeneration,
    dedupeKey: `half-open:steward:${claimGeneration}:${notification.kind}:${sha256Hex(payload)}`,
    kind: notification.kind,
    payload,
    now: nowSec,
  });
}

async function awaitWithinDeadline<Result>(
  promise: Promise<Result>,
  remainingMs: number,
): Promise<DeadlineResult<Result>> {
  if (remainingMs <= 0) {
    return { status: "timed-out" };
  }
  let timeout: NodeJS.Timeout | undefined;
  const timed = new Promise<DeadlineResult<Result>>((resolve) => {
    timeout = setTimeout(() => resolve({ status: "timed-out" }), remainingMs);
  });
  const completed = promise.then<DeadlineResult<Result>>((value) => ({ status: "completed", value }));
  try {
    return await Promise.race([completed, timed]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/** §40.1.1: state lock 外で current generation の配送予定だけを drain する。 */
async function drainStewardHalfOpenOutbox(
  deps: StageDeps,
  currentGeneration: number,
  nowSec: number,
  notifyFn: StewardNotifyFn | undefined,
  notifyMode: StewardNotifyMode,
  elapsedNowFn: () => number,
  deadlineMs?: number,
): Promise<StewardHalfOpenDrainResult> {
  deps.store.discardStaleHalfOpenOutbox({ stage: "steward", currentGeneration, now: nowSec });
  if (notifyFn === undefined && notifyMode !== "transport") {
    return { budgetExceeded: false };
  }

  const rows = deps.store.listPendingHalfOpenOutbox({ stage: "steward", now: nowSec });
  for (const row of rows) {
    const latestGeneration = readStewardState(deps.env.home).claimGeneration;
    deps.store.discardStaleHalfOpenOutbox({
      stage: "steward",
      currentGeneration: latestGeneration,
      now: nowSec,
    });
    if (row.claimGeneration !== latestGeneration) {
      continue;
    }
    const remainingMs = deadlineMs === undefined
      ? Number.POSITIVE_INFINITY
      : deadlineMs - elapsedNowFn();
    if (remainingMs <= 0) {
      return { budgetExceeded: true };
    }
    const input = parseOperationalNotifyInput(row.payload);
    const stewardKind = isStewardAdHocKind(row.kind) ? row.kind : null;
    if (input === null || (notifyFn !== undefined && stewardKind === null)) {
      deps.logger.warn("steward: half-open outbox payload が不正なため配送しません", { outboxId: row.id });
      deps.store.markHalfOpenOutbox({ id: row.id, result: "failed", now: nowSec });
      continue;
    }

    try {
      const delivery: Promise<OperationalNotifyResult> = notifyFn === undefined
        ? sendOperationalNotification(deps, input, { skipTransports: row.sentTransports })
        : notifyFn(input.id, input.body, stewardKind!).then((result) => ({
          attempted: result !== false,
          sent: result !== false,
        }));
      const outcome = deadlineMs === undefined
        ? { status: "completed" as const, value: await delivery }
        : await awaitWithinDeadline(delivery, remainingMs);
      if (outcome.status === "timed-out") {
        deps.store.markHalfOpenOutbox({
          id: row.id,
          result: "failed",
          sentTransports: row.sentTransports,
          now: nowSec,
        });
        return { budgetExceeded: true };
      }
      const sentTransports = [...new Set([
        ...row.sentTransports,
        ...(outcome.value.sentTransports ?? []),
      ])];
      const settled = (
        outcome.value.sent || (outcome.value.sentTransports?.length ?? 0) > 0
      ) && (outcome.value.failedTransports?.length ?? 0) === 0;
      const generationAfterDelivery = readStewardState(deps.env.home).claimGeneration;
      deps.store.discardStaleHalfOpenOutbox({
        stage: "steward",
        currentGeneration: generationAfterDelivery,
        now: nowSec,
      });
      deps.store.markHalfOpenOutbox({
        id: row.id,
        result: settled ? "sent" : "failed",
        sentTransports,
        now: nowSec,
      });
    } catch (err) {
      deps.logger.warn("steward: half-open outbox の配送に失敗しました", {
        outboxId: row.id,
        error: redactText(err instanceof Error ? err.message : String(err)),
      });
      deps.store.markHalfOpenOutbox({
        id: row.id,
        result: "failed",
        sentTransports: row.sentTransports,
        now: nowSec,
      });
    }
  }
  return { budgetExceeded: false };
}

// --- 適用規則（§40.4: two-party gate） ---

interface ApplyResult {
  /** 今回の claim で選択した提案数。上限境界のタスクグループは丸ごと次 claim へ送る。 */
  proposalCount: number;
  applied: number;
  proposed: number;
  commented: number;
  notified: number;
  /** §69.7: durable request として発行できた提案数 */
  requested: number;
  /** §69.7: §69.4 の判定で抑止された再提案数 */
  suppressed: number;
  /** コメントも通知も伴わなかった request 発行数（actions の二重計上を避けるための内部カウンタ） */
  silentRequests: number;
  /** §74.3: allow で自動 archive した件数を integrationEvidence 別に集計する */
  archivedByEvidence: Partial<Record<IntegrationEvidence, number>>;
  /** half-open の件数または経過時間上限で未処理提案を次 claim へ送った */
  stoppedEarly: boolean;
  notes: string[];
}

/** §69.3: 配送先解決へ渡す worktree。task body の cwd 行が唯一の出所 */
function extractCwd(body: string): string {
  return body.match(CWD_LINE_REGEX)?.[1] ?? "";
}

/** active な subtree watch の selector は、常設ミッションとして auto-archive から除外する */
function isActiveOrchestratorMission(store: KanbanStore, taskId: string): boolean {
  return store.listOrchestratorWatches().some((watch) =>
    watch.active && watch.scope === "subtree" && watch.selector === taskId
  );
}

/** 提案コメントの本文（§40.4 の文面を維持し、監査の可読性を保つ） */
function proposalCommentBody(kind: ProposalKind, reason: string): string {
  return kind === "spec-lint"
    ? `[steward 指摘] spec-lint: ${reason}`
    : `[steward 提案] ${kind}: ${reason}`;
}

/**
 * 抑止元 request が作られて以降、その escalate が人へ届いたかを返す。
 *
 * IDEMPOTENCY_WINDOW_SEC を使わないのは、窓で判定すると未解決 request が窓の切り替わりごとに
 * 再通知され、durable request が消すはずの通知スパムが戻るため。
 */
function hasNotifiedSinceRequest(
  store: KanbanStore,
  taskId: string,
  blockingRequestId: string,
): boolean {
  const request = store.getStewardProposalRequest(blockingRequestId);
  if (request === null) {
    return false;
  }
  return store.listEvents(taskId, "steward_proposal").some((event) => {
    if (event.createdAt < request.createdAt) {
      return false;
    }
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      return payload.kind === "escalate" && payload.notificationAttempted === true;
    } catch {
      return false;
    }
  });
}

/**
 * §69.5: escalate の §38 通知を送り、到達可否を steward_proposal イベントへ残す。
 *
 * ここで見ているのは「人間へ通知が届いたか」だけで、提案そのものの再提案抑止は §69.4 が唯一の
 * 正本。escalate は inbox に積まれるだけでは足りず即時に人を呼ぶ種別なので、transport が落ちた
 * 回は §40.4 と同じく次 tick で拾い直せるようにする。
 */
async function notifyEscalation(
  deps: StageDeps,
  logger: Logger,
  task: TaskRow,
  reason: string,
  nowSec: number,
  notifyFn: StewardNotifyFn | undefined,
  notifyMode: StewardNotifyMode,
  notes: string[],
  mutate: StewardMutationFence,
): Promise<boolean> {
  const message = `steward escalate: ${redactText(task.title)} — ${reason}`;
  if (notifyMode === "outbox") {
    mutate(
      () => {
        deps.store.addEvent(task.id, "steward_proposal", SUPERVISOR_ACTOR, {
          kind: "escalate",
          reason,
          notificationAttempted: true,
        });
      },
      () => ({ task, message, kind: "escalate" }),
    );
    notes.push(`${task.id}: escalate を通知しました`);
    return true;
  }

  let notificationAttempted = false;
  try {
    notificationAttempted = await notifyStewardProposal(
      deps,
      task,
      message,
      "escalate",
      notifyFn,
      notifyMode,
    );
    notes.push(
      notificationAttempted
        ? `${task.id}: escalate を通知しました`
        : `${task.id}: escalate 通知は transport skip のため未完了です`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("steward: escalate 通知に失敗しました", {
      taskId: task.id,
      error: redactText(message),
    });
  }
  // 成功は毎回記録し、失敗は窓内に記録が無いときだけ残す（§40.4 と同じ event 抑制）
  const proposalEventExists = hasRecentProposalEvent(deps.store, "escalate", task.id, nowSec, false);
  if (notificationAttempted || !proposalEventExists) {
    mutate(() => {
      deps.store.addEvent(task.id, "steward_proposal", SUPERVISOR_ACTOR, {
        kind: "escalate",
        reason,
        notificationAttempted,
      });
    });
  }
  return notificationAttempted;
}

interface DeterministicDoneApplyResult {
  proposalCount: number;
  result: ApplyResult;
}

/**
 * §40.4 の適用規則に従い、提案をコメント/イベント/遷移に変換する。
 *
 * §74.4: kind=archive かつ status=done の提案（archive gate 対象）は、他の即時適用提案と分離して
 * 2パスで処理する。Step A は git を呼ばず taskId を集めるだけ（順序制御専用）、Step B は非対象の
 * 提案を従来どおり即時処理し、Step C が対象タスクごとに gate を評価する。veto の場合は同一タスクの
 * 他提案を同 tick で一切適用しない（mutation holding）。
 */
async function applyProposals(
  proposals: Proposal[],
  deps: StageDeps,
  logger: Logger,
  nowSec: number,
  notifyFn: StewardNotifyFn | undefined,
  notifyMode: StewardNotifyMode,
  mutate: StewardMutationFence = runStewardMutationUnfenced,
  proposalLimit?: number,
  shouldContinue: () => boolean = () => true,
): Promise<ApplyResult> {
  const { store } = deps;
  let applied = 0;
  let proposed = 0;
  let commented = 0;
  let notified = 0;
  let requested = 0;
  let suppressed = 0;
  let silentRequests = 0;
  const archivedByEvidence: Partial<Record<IntegrationEvidence, number>> = {};
  const notes: string[] = [];

  // §74.4: 先に全提案をタスク単位へまとめ、末尾の archive も同一タスクの先行提案と一緒に扱う。
  const proposalGroups = new Map<string, Proposal[]>();
  for (const proposal of proposals) {
    const group = proposalGroups.get(proposal.taskId);
    if (group === undefined) {
      proposalGroups.set(proposal.taskId, [proposal]);
    } else {
      group.push(proposal);
    }
  }

  // archive pre-scan は上限選択より前に全グループへ行う。実際の git 再観測は適用直前に行う。
  const archiveGatedTaskIds = new Set<string>();
  for (const [taskId, group] of proposalGroups) {
    if (!group.some((proposal) => proposal.kind === "archive")) {
      continue;
    }
    const task = store.getTask(taskId);
    if (task !== null && task.status === "done") {
      archiveGatedTaskIds.add(taskId);
    }
  }

  const selectedTaskIds = new Set<string>();
  let proposalCount = 0;
  for (const [taskId, group] of proposalGroups) {
    if (proposalLimit !== undefined && proposalCount + group.length > proposalLimit) {
      break;
    }
    selectedTaskIds.add(taskId);
    proposalCount += group.length;
  }
  const boundedProposals = proposals.filter((proposal) => selectedTaskIds.has(proposal.taskId));
  let stoppedEarly = proposalCount < proposals.length;
  if (stoppedEarly) {
    notes.push(
      `steward half-open claim は提案上限${proposalLimit}件で打ち切り、残り${proposals.length - proposalCount}件を次claimへ送りました`,
    );
  }
  const canContinue = (): boolean => {
    if (shouldContinue()) {
      return true;
    }
    if (!stoppedEarly) {
      notes.push("steward half-open claim は経過時間上限30分で提案適用を打ち切りました");
    }
    stoppedEarly = true;
    return false;
  };

  /**
   * §74.2 統合観測ゲートを1タスク分評価し、archive適用またはveto記録を行う共通ロジック。
   * Step C（通常経路）と processProposal のフォールバック（理論上到達しないはずの安全網）の
   * 両方から呼ぶ。F1: フォールバック側が直接 archived へ遷移してゲートを迂回できると、
   * Step A の pre-scan がここへ来る前提を壊しただけで fail-open になってしまうため、
   * 経路を1本化して常にゲートを経由させる（フォールバックであってもフェイルクローズ）。
   *
   * 戻り値: "allowed"（gate allow で archive 適用）/ "vetoed"（gate veto。§74.4 により同tickの
   * 他提案も一切適用しない）/ "suppressed"（24h 冪等で archive 適用自体を抑制。ゲート評価は
   * 実行していないため他提案の扱いは allowed と同様でよい）。
   */
  async function evaluateArchiveGate(
    task: TaskRow,
    archiveProposal: Proposal,
  ): Promise<"allowed" | "vetoed" | "suppressed"> {
    const taskId = task.id;
    if (isActiveOrchestratorMission(store, taskId)) {
      notes.push(`${taskId}: archive 提案は active な subtree watch の selector のため抑制しました`);
      return "suppressed";
    }
    if (isIdempotent(store, "archive", taskId, nowSec)) {
      notes.push(`${taskId}: archive 提案は24h以内に既出のため抑制しました`);
      return "suppressed";
    }

    // ゲート評価（probe 呼び出し + 決定表）自体は毎tick必ず実行する（§74.4）。
    // 抑止するのはイベント記録・通知だけ。
    const probe = stewardArchiveIntegrationProbe(deps);
    const canonicalWorktreeRoot = join(deps.env.home, "worktrees");
    const cwd = extractCwd(task.body);
    const observation = await probe.observe({ cwd, canonicalWorktreeRoot });
    const decision = decideArchiveIntegration(observation);

    if (decision.verdict === "allow") {
      // §74.3: board 可視の reason は evidence から機械生成する。判断 session の自由文は
      // proposalReason へ退避し、統合主張には使わない
      mutate(() => {
        store.transition({
          taskId,
          to: "archived",
          actor: SUPERVISOR_ACTOR,
          eventType: "steward_auto_archive",
          payload: {
            kind: "archive",
            reason: archiveEvidenceReasonText(decision.integrationEvidence),
            proposalReason: archiveProposal.reason,
            integrationEvidence: decision.integrationEvidence,
          },
        });
      });
      applied += 1;
      archivedByEvidence[decision.integrationEvidence] =
        (archivedByEvidence[decision.integrationEvidence] ?? 0) + 1;
      notes.push(
        `${taskId}: steward_auto_archive を自動適用しました（integrationEvidence=${decision.integrationEvidence}）`,
      );
      return "allowed";
    }

    // veto: 同一 (taskId, integrationEvidence) の重複イベント・通知だけを24h窓で抑止する（§74.4）。
    // イベントと通知は同じキー・同じ窓で1回に畳む契約のため、通知もこの if の内側でだけ送る
    // （イベントを独立窓にすると「窓内で1回」の契約から外れ、通知だけ別窓で再送され得る）。
    if (!hasRecentAutoArchiveVetoEvent(store, taskId, decision.integrationEvidence, nowSec)) {
      const message =
        `steward archive 見送り: ${redactText(task.title)} — ${vetoEvidenceNoticeText(decision.integrationEvidence)}`;
      mutate(
        () => {
          store.addEvent(taskId, "steward_auto_archive_vetoed", SUPERVISOR_ACTOR, {
            integrationEvidence: decision.integrationEvidence,
            integrationTarget: buildVetoIntegrationTarget(observation),
          });
        },
        notifyMode === "outbox"
          ? () => ({ task, message, kind: "archive-vetoed" })
          : undefined,
      );
      try {
        const notificationAttempted = await notifyStewardProposal(
          deps,
          task,
          message,
          "archive-vetoed",
          notifyFn,
          notifyMode,
        );
        if (notificationAttempted) {
          notified += 1;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("steward: archive veto 通知に失敗しました", {
          taskId,
          error: redactText(message),
        });
      }
    }
    notes.push(
      `${taskId}: archive を integrationEvidence=${decision.integrationEvidence} により見送りました`,
    );
    return "vetoed";
  }

  /**
   * gate 対象外（非 archive×done）の提案の既存処理。archive×done の提案も理論上ここへ来ることは
   * ない（Step A で除外済み）が、安全なフォールバックとして分岐だけは残す。
   */
  async function processProposal(proposal: Proposal): Promise<void> {
    const task = store.getTask(proposal.taskId);
    if (task === null) {
      return;
    }

    // §69.6 / §74: done の auto-archive は Step C の gate 評価を経由するのが正規経路であり、
    // ここへ到達するのは理論上あり得ない。壊れても evaluateArchiveGate() を経由させ、
    // ゲートを迂回した直接 archive 遷移をしない（F1）。
    if (proposal.kind === "archive" && task.status === "done") {
      await evaluateArchiveGate(task, proposal);
      return;
    }

    // §69.3: 残りの提案は durable request 面へ発行し、戻り値で3分岐する
    const tenantDefaults = (deps.config as StageDeps["config"] & ConfigWithOrchestratorTenantDefaults)
      .orchestrator?.tenantDefaults;
    const requestInput = {
      taskId: proposal.taskId,
      kind: proposal.kind,
      reason: proposal.reason,
      worktree: extractCwd(task.body),
      project: task.tenant,
      tenantDefaults,
      now: nowSec,
    };
    // §40.1.1: 提案 request の発行も claim fence の内側（mutate）で行う。tenant 既定（§69.3.1）は main 側の入力をそのまま渡す
    const escalationMessage = `steward escalate: ${redactText(task.title)} — ${proposal.reason}`;
    const routedMutation = mutate(
      () => {
        const routing = store.createStewardProposalRequest(requestInput);
        const queueEscalation = notifyMode === "outbox" && proposal.kind === "escalate" && (
          routing.outcome === "created" || (
            routing.outcome === "suppressed" &&
            !hasNotifiedSinceRequest(store, proposal.taskId, routing.blockingRequestId)
          )
        );
        if (queueEscalation) {
          store.addEvent(task.id, "steward_proposal", SUPERVISOR_ACTOR, {
            kind: "escalate",
            reason: proposal.reason,
            notificationAttempted: true,
          });
        }
        return { routing, queueEscalation };
      },
      ({ queueEscalation }) => queueEscalation
        ? { task, message: escalationMessage, kind: "escalate" }
        : undefined,
    );
    const { routing, queueEscalation } = routedMutation;

    if (routing.outcome === "suppressed") {
      // §69.4 が抑止した再提案。コメントも通知も出さない
      suppressed += 1;
      notes.push(
        `${proposal.taskId}: ${proposal.kind} 提案は §69.4 (${routing.suppressedBy}) により抑止しました`,
      );
      // 例外は escalate の未達通知だけ。抑止の判断は §69.4 のままで、抑止元 request がまだ
      // 人へ届いていない場合に限り §38 を再試行する。判定は時間窓ではなく request 単位なので、
      // 長期間未解決の request が一定周期で再通知されることはない
      if (queueEscalation) {
        notified += 1;
        notes.push(`${task.id}: escalate を通知しました`);
      } else if (
        proposal.kind === "escalate" &&
        !hasNotifiedSinceRequest(store, proposal.taskId, routing.blockingRequestId)
      ) {
        const retried = await notifyEscalation(
          deps, logger, task, proposal.reason, nowSec, notifyFn, notifyMode, notes, mutate,
        );
        if (retried) {
          notified += 1;
        }
      }
      return;
    }

    if (routing.outcome === "created") {
      requested += 1;
      notes.push(
        `${proposal.taskId}: ${proposal.kind} 提案を request ${routing.request.id} として発行しました（配送先${routing.targetCount}件）`,
      );
      // 監査の可読性のため、コメントを持つ kind は従来どおりコメントを残す
      let commentAdded = false;
      if (proposal.kind !== "escalate") {
        mutate(() => {
          store.addComment(
            proposal.taskId,
            STEWARD_AUTHOR,
            proposalCommentBody(proposal.kind, proposal.reason),
          );
        });
        commentAdded = true;
        if (proposal.kind === "spec-lint") {
          commented += 1;
        } else {
          proposed += 1;
        }
      }
      // §69.6: §69.5 が止めたのは §38 通知だけで、§40.4 の steward_proposal イベントは routed 経路でも残す。
      // これを削ると telegram-nonce の提案 event 探索が空振りし、§42.2 の promote 承認 keyboard が
      // 出なくなる。notificationAttempted は必ず false を明示すること。省略すると §40.4 の 24h 冪等
      // （requireNotificationAttempted=true）が「通知済み」と誤認し、後で配送先を失った同一提案の
      // unrouted フォールスルーまで抑止してしまう。
      if (proposal.kind === "promote" || proposal.kind === "archive") {
        mutate(() => {
          store.addEvent(proposal.taskId, "steward_proposal", SUPERVISOR_ACTOR, {
            kind: proposal.kind,
            reason: proposal.reason,
            taskStatus: task.status,
            notificationAttempted: false,
            requestId: routing.request.id,
          });
        });
      }
      // §69.5: promote / archive / spec-lint は per-proposal 通知を出さない。escalate だけ §38 を維持する
      let notifiedHere = queueEscalation;
      if (queueEscalation) {
        notified += 1;
        notes.push(`${task.id}: escalate を通知しました`);
      } else if (proposal.kind === "escalate") {
        const notificationAttempted = await notifyEscalation(
          deps, logger, task, proposal.reason, nowSec, notifyFn, notifyMode, notes, mutate,
        );
        if (notificationAttempted) {
          notified += 1;
          notifiedHere = true;
        }
      }
      if (!commentAdded && !notifiedHere) {
        silentRequests += 1;
      }
      return;
    }

    // §69.3: 配送先0件（unrouted）は request を持たないため、従来のコメント + §38 通知へフォールスルーする。
    // この経路だけが 24h 冪等（§40.4）の適用対象として残る。
    if (isIdempotent(store, proposal.kind, proposal.taskId, nowSec)) {
      notes.push(
        `${proposal.taskId}: ${proposal.kind} 提案は24h以内に既出のため抑制しました`,
      );
      return;
    }

    switch (proposal.kind) {
      case "archive": {
        // §40.4: done 以外の archive は提案コメント + イベント + notify
        const commentExists = hasRecentStewardComment(store, "archive", proposal.taskId, nowSec);
        if (notifyMode === "outbox") {
          const message = `steward archive 提案: ${redactText(task.title)} — ${proposal.reason}`;
          mutate(
            () => {
              if (!commentExists) {
                store.addComment(
                  proposal.taskId,
                  STEWARD_AUTHOR,
                  `[steward 提案] archive: ${proposal.reason}`,
                );
              }
              store.addEvent(proposal.taskId, "steward_proposal", SUPERVISOR_ACTOR, {
                kind: "archive",
                reason: proposal.reason,
                taskStatus: task.status,
                notificationAttempted: true,
              });
            },
            () => ({ task, message, kind: "archive" }),
          );
          if (!commentExists) {
            proposed += 1;
            notes.push(
              `${proposal.taskId}: archive 提案をコメントしました（status=${task.status}、自動適用対象外）`,
            );
          } else {
            notes.push(`${proposal.taskId}: archive 提案コメントは24h以内に既出です`);
          }
          notified += 1;
          break;
        }
        if (!commentExists) {
          mutate(() => {
            store.addComment(
              proposal.taskId,
              STEWARD_AUTHOR,
              `[steward 提案] archive: ${proposal.reason}`,
            );
          });
          proposed += 1;
          notes.push(
            `${proposal.taskId}: archive 提案をコメントしました（status=${task.status}、自動適用対象外）`,
          );
        } else {
          notes.push(`${proposal.taskId}: archive 提案コメントは24h以内に既出です`);
        }
        let notificationAttempted = false;
        try {
          notificationAttempted = await notifyStewardProposal(
            deps,
            task,
            `steward archive 提案: ${redactText(task.title)} — ${proposal.reason}`,
            "archive",
            notifyFn,
            notifyMode,
          );
          if (notificationAttempted) {
            notified += 1;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("steward: archive 提案通知に失敗しました", {
            taskId: proposal.taskId,
            error: redactText(message),
          });
        }
        const proposalEventExists = hasRecentProposalEvent(store, "archive", proposal.taskId, nowSec, false);
        if (notificationAttempted || !proposalEventExists) {
          mutate(() => {
            store.addEvent(proposal.taskId, "steward_proposal", SUPERVISOR_ACTOR, {
              kind: "archive",
              reason: proposal.reason,
              taskStatus: task.status,
              notificationAttempted,
            });
          });
        }
        if (!notificationAttempted) {
          notes.push(`${proposal.taskId}: archive 提案通知は transport skip のため未完了です`);
        }
        break;
      }
      case "promote": {
        // §40.4: promote は常に提案コメント + イベント + notify（自動適用しない）
        const commentExists = hasRecentStewardComment(store, "promote", proposal.taskId, nowSec);
        if (notifyMode === "outbox") {
          const message = `steward promote 提案: ${redactText(task.title)} — ${proposal.reason}`;
          mutate(
            () => {
              if (!commentExists) {
                store.addComment(
                  proposal.taskId,
                  STEWARD_AUTHOR,
                  `[steward 提案] promote: ${proposal.reason}`,
                );
              }
              store.addEvent(proposal.taskId, "steward_proposal", SUPERVISOR_ACTOR, {
                kind: "promote",
                reason: proposal.reason,
                taskStatus: task.status,
                notificationAttempted: true,
              });
            },
            () => ({ task, message, kind: "promote" }),
          );
          if (!commentExists) {
            proposed += 1;
            notes.push(`${proposal.taskId}: promote 提案をコメントしました`);
          } else {
            notes.push(`${proposal.taskId}: promote 提案コメントは24h以内に既出です`);
          }
          notified += 1;
          break;
        }
        if (!commentExists) {
          mutate(() => {
            store.addComment(
              proposal.taskId,
              STEWARD_AUTHOR,
              `[steward 提案] promote: ${proposal.reason}`,
            );
          });
          proposed += 1;
          notes.push(`${proposal.taskId}: promote 提案をコメントしました`);
        } else {
          notes.push(`${proposal.taskId}: promote 提案コメントは24h以内に既出です`);
        }
        let notificationAttempted = false;
        try {
          notificationAttempted = await notifyStewardProposal(
            deps,
            task,
            `steward promote 提案: ${redactText(task.title)} — ${proposal.reason}`,
            "promote",
            notifyFn,
            notifyMode,
          );
          if (notificationAttempted) {
            notified += 1;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("steward: promote 提案通知に失敗しました", {
            taskId: proposal.taskId,
            error: redactText(message),
          });
        }
        const proposalEventExists = hasRecentProposalEvent(store, "promote", proposal.taskId, nowSec, false);
        if (notificationAttempted || !proposalEventExists) {
          mutate(() => {
            store.addEvent(proposal.taskId, "steward_proposal", SUPERVISOR_ACTOR, {
              kind: "promote",
              reason: proposal.reason,
              taskStatus: task.status,
              notificationAttempted,
            });
          });
        }
        if (!notificationAttempted) {
          notes.push(`${proposal.taskId}: promote 提案通知は transport skip のため未完了です`);
        }
        break;
      }
      case "spec-lint": {
        // §40.4: spec-lint は対象タスクへ指摘コメントのみ
        mutate(() => {
          store.addComment(
            proposal.taskId,
            STEWARD_AUTHOR,
            `[steward 指摘] spec-lint: ${proposal.reason}`,
          );
        });
        commented += 1;
        notes.push(`${proposal.taskId}: spec-lint 指摘をコメントしました`);
        break;
      }
      case "escalate": {
        // §40.4: escalate は notify 経路で人間へ通知（routed 経路と同じ helper）
        if (await notifyEscalation(
          deps, logger, task, proposal.reason, nowSec, notifyFn, notifyMode, notes, mutate,
        )) {
          notified += 1;
        }
        break;
      }
    }
  }

  // Step B（immediate）: gate 対象でない提案は既存ロジックのまま即時処理する
  for (const proposal of boundedProposals) {
    if (archiveGatedTaskIds.has(proposal.taskId)) {
      continue;
    }
    if (!canContinue()) {
      break;
    }
    await processProposal(proposal);
  }

  // Step C（gated）: gate 対象タスクを、proposals 内で最初に現れた順（Set の insertion order）で
  // グループ処理する。同一タスクの全提案（kind 問わず、元の相対順序を保持）をまとめて扱う。
  for (const taskId of archiveGatedTaskIds) {
    if (!selectedTaskIds.has(taskId)) {
      continue;
    }
    if (!canContinue()) {
      break;
    }
    const groupProposals = boundedProposals.filter((p) => p.taskId === taskId);
    const task = store.getTask(taskId);
    if (task === null) {
      continue;
    }

    const archiveIndex = groupProposals.findIndex((p) => p.kind === "archive");
    const archiveProposal = archiveIndex >= 0 ? groupProposals[archiveIndex] : undefined;
    const otherProposals = groupProposals.filter((_, idx) => idx !== archiveIndex);

    if (archiveProposal === undefined) {
      // Step A の集合と矛盾する状態（理論上到達しない）。安全側で通常処理へ流す
      for (const proposal of groupProposals) {
        if (!canContinue()) {
          break;
        }
        await processProposal(proposal);
      }
      continue;
    }

    // F1: ゲート評価（24h冪等・probe・決定表・archive適用/veto記録）は processProposal の
    // フォールバックと共通の evaluateArchiveGate() に一本化してある。
    const gateResult = await evaluateArchiveGate(task, archiveProposal);
    if (gateResult === "vetoed") {
      // §74.4: veto したタスクへは同 tick で他の全提案（archive以外も含む）を一切適用しない
      continue;
    }
    // allowed（gate allow で archive 適用）/ suppressed（24h冪等で archive 適用自体を抑制）は
    // いずれも同タスクの他提案を保留する理由が無いため、通常どおり適用する
    for (const proposal of otherProposals) {
      if (!canContinue()) {
        break;
      }
      await processProposal(proposal);
    }
  }

  return {
    proposalCount,
    applied,
    proposed,
    commented,
    notified,
    requested,
    suppressed,
    silentRequests,
    archivedByEvidence,
    stoppedEarly,
    notes,
  };
}

/** LLM出力に依存しないdone整合escalateだけを適用する（cadence等のgate後に呼ぶ）。 */
async function applyDeterministicDoneEscalations(
  deps: StageDeps,
  logger: Logger,
  nowSec: number,
  notifyFn: StewardNotifyFn | undefined,
  notifyMode: StewardNotifyMode,
  mutate: StewardMutationFence = runStewardMutationUnfenced,
  proposalLimit?: number,
  shouldContinue: () => boolean = () => true,
): Promise<DeterministicDoneApplyResult> {
  const proposals = reconcileDoneConsistencyProposals(deps.store, []);
  const result = await applyProposals(
    proposals,
    deps,
    logger,
    nowSec,
    notifyFn,
    notifyMode,
    mutate,
    proposalLimit,
    shouldContinue,
  );
  return {
    proposalCount: result.proposalCount,
    result,
  };
}

function actionCount(result: ApplyResult): number {
  // §69.7: durable request の発行も stage が行った実作用。これを数えないと、通知を伴わない
  // escalate request だけを出した run が actions=0（無作用）として記録されてしまう。
  // ただし加算するのはコメントも通知も伴わなかった request だけ。routed 提案は proposed /
  // commented / notified 側で既に数えているので、requested をそのまま足すと同じ作用を二重に数える。
  return result.applied + result.proposed + result.commented + result.notified + result.silentRequests;
}

// --- direct steward session runner ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Steward 判断専用の fresh Git workspace を作る。
 *
 * 判断入力には task body が含まれるため、前回実行が残した AGENTS.md 等を次回へ持ち越さない。
 * OS の tmp 配下へ原子的に 0700 directory を作り、通常の trusted-repository 検査を迂回せず満たす。
 */
function createEphemeralStewardWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "hachi-steward-"));
  try {
    chmodSync(workspace, 0o700);
    execFileSync("git", ["init", "--quiet", workspace], { stdio: "ignore" });
    return workspace;
  } catch (err) {
    rmSync(workspace, { recursive: true, force: true });
    throw err;
  }
}

function buildVirtualStewardTask(nowSec: number): TaskRow {
  return {
    id: "steward",
    title: "steward 判断セッション",
    body: "",
    status: "blocked",
    priority: 0,
    tenant: "system",
    assignee: "",
    provider: "",
    profile: "steward",
    modelOverride: "",
    effortOverride: "",
    speedOverride: "",
    reviewProfileOverride: "",
    reviewProviderOverride: "",
    reviewModelOverride: "",
    reviewEffortOverride: "",
    reviewSpeedOverride: "",
    blockReason: "",
    claimLock: "",
    watched: false,
    consecutiveFailures: 0,
    lastFailureError: "",
    lastHeartbeatAt: null,
    maxRetries: 0,
    createdAt: nowSec,
    updatedAt: nowSec,
    startedAt: null,
    completedAt: null,
  };
}

function pickDirectStewardAdapter(deps: StageDeps, resolution: Extract<ModelResolution, { ok: true }>): WorkerAdapter {
  if (resolution.transport !== "direct") {
    throw new Error(`steward profile は transport=direct 必須です (actual=${resolution.transport})`);
  }
  const adapter = deps.directAdapters?.[resolution.provider];
  if (adapter === undefined) {
    throw new Error(`direct transport の adapter が未構成です (provider=${resolution.provider})`);
  }
  if (adapter.stop === undefined) {
    throw new Error(`steward direct adapter は stop capability 必須です (provider=${resolution.provider})`);
  }
  return adapter;
}

function isSessionComplete(resultCount: number | undefined, state: string): boolean {
  return state === "idle" && (resultCount ?? 0) >= 1;
}

function createDirectStewardSessionRunner(
  deps: StageDeps,
  resolution: Extract<ModelResolution, { ok: true }>,
  nowSec: number,
  timeoutSec: number,
  pollIntervalMs: number,
): StewardSessionRunner {
  const adapter = pickDirectStewardAdapter(deps, resolution);
  const virtualTask = buildVirtualStewardTask(nowSec);

  return {
    async run(prompt: string): Promise<string> {
      const workspace = createEphemeralStewardWorkspace();
      let ref: Awaited<ReturnType<WorkerAdapter["launch"]>> | undefined;
      let terminal = false;
      try {
        ref = await adapter.launch(virtualTask, {
          model: resolution.model,
          cwd: workspace,
          promptText: prompt,
          ...(resolution.effort !== undefined ? { effort: resolution.effort } : {}),
        });
        const deadlineMs = Date.now() + timeoutSec * 1000;
        while (Date.now() <= deadlineMs) {
          const status = await adapter.status(ref);
          if (isSessionComplete(status.resultCount, status.state)) {
            terminal = true;
            return adapter.fetchTranscript(ref);
          }
          await sleep(pollIntervalMs);
        }

        throw new Error(`steward direct session timeout (sessionId=${redactText(ref.sessionId)})`);
      } finally {
        if (!terminal && ref !== undefined) {
          try {
            // 契約 §34.2.1: stop() は例外を投げなくても stopped:false（already-exited/
            // unsupported/unsignalable/kill-unconfirmed）を返しうる。**戻り値の reason は
            // stopped の値に関わらず必ず証拠として記録する。** unsignalable/kill-unconfirmed
            // （＝停止未確認）は warn、already-exited/unsupported（＝想定内の結果）は info。
            const result = await adapter.stop?.(ref);
            if (result !== undefined) {
              if (!result.stopped) {
                if (result.reason === "unsignalable" || result.reason === "kill-unconfirmed") {
                  deps.logger.warn("steward: 未完了 direct session の停止を確認できませんでした", {
                    reason: result.reason,
                  });
                } else {
                  deps.logger.info("steward: 未完了 direct session の cleanup は停止呼び出し不要でした（想定内）", {
                    reason: result.reason,
                  });
                }
              } else {
                // 契約 §34.2.1: 成功2値（terminated/killed）も stopped:false の4値と同じく reason を
                // 証拠として記録する。stopped:false のときだけ記録すると成功経路の reason が欠落する。
                deps.logger.info("steward: 未完了 direct session の停止が完了しました", {
                  reason: result.reason,
                });
              }
            }
          } catch (err) {
            deps.logger.warn("steward: 未完了 direct session の停止に失敗しました", {
              error: redactText(err instanceof Error ? err.message : String(err)),
            });
          }
        }
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  };
}

function applyStewardFailureCircuit(
  state: StewardState,
  nowSec: number,
  message: string,
  notes: string[],
): boolean {
  const failure = decideAutoDisableFailure(state, nowSec, redactText(message));
  Object.assign(state, failure.nextState);
  if (failure.transitionedToAutoDisabled) {
    notes.push(`steward: 連続${state.consecutiveFailures}回失敗により auto-disable しました`);
  }
  return failure.transitionedToAutoDisabled;
}

async function notifyStewardLifecycle(
  deps: StageDeps,
  nowSec: number,
  message: string,
  notifyFn: StewardLifecycleNotifyFn | undefined,
): Promise<void> {
  if (notifyFn === undefined) {
    return;
  }
  const attempted = await notifyFn(deps, buildVirtualStewardTask(nowSec), message);
  if (!attempted) {
    deps.logger.warn("steward: lifecycle notification が試行されませんでした");
  }
}

// --- factory ---

/**
 * steward ステージの factory。sessionRunner/nowFn/notifyFn を差し替え可能にすることで、
 * テストが実 LLM セッションや通知を発火しない構造にする（docs/contract.md §40）。
 */
export function createStewardStage(options: StewardStageOptions = {}): Stage {
  const nowFn = options.nowFn ?? ((): number => Math.floor(Date.now() / 1000));
  const injectedSessionRunner = options.sessionRunner;
  const notifyFn = options.notifyFn;
  const lifecycleNotifyFn = options.lifecycleNotifyFn;
  const notifyMode = options.notifyMode ?? "none";
  const sessionTimeoutSec = options.sessionTimeoutSec ?? DEFAULT_SESSION_TIMEOUT_SEC;
  const sessionPollIntervalMs = options.sessionPollIntervalMs ?? DEFAULT_SESSION_POLL_INTERVAL_MS;
  const elapsedNowFn = options.elapsedNowFn ?? ((): number => performance.now());

  return {
    name: "steward",

    async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
      void now; // steward は nowFn() を時刻ソースとして使う（Stage インターフェース契約上の引数）
      const { store, config, logger } = deps;
      const home = deps.env.home;
      const notes: string[] = [];

      // supervisor 本体の kill-switch 判定とは別に、stage 単体呼び出しでも fail-closed に停止する
      if (existsSync(join(home, "steward.disabled"))) {
        notes.push("steward.disabled が存在するためスキップしました");
        logger.warn("steward: kill-switch によりスキップしました", {
          path: join(home, "steward.disabled"),
        });
        return { name: "steward", actions: 0, skipped: true, notes };
      }

      // §40.1: apply=false では起動しない
      if (!apply) {
        return {
          name: "steward",
          actions: 0,
          skipped: false,
          notes: ["dry-run: steward セッションは起動しません"],
        };
      }

      // state 読み込み
      let state = readStewardState(home);
      let stateBaseline: StewardState = { ...state };
      const currentSec = nowFn();
      await drainStewardHalfOpenOutbox(
        deps,
        state.claimGeneration,
        currentSec,
        notifyFn,
        notifyMode,
        elapsedNowFn,
      );
      state = readStewardState(home);
      stateBaseline = { ...state };

      // auto-disable 中は待機時間経過後の1回だけ half-open として通す。
      const autoDisableRun = decideAutoDisableRun(state, currentSec);
      if (!autoDisableRun.shouldRun) {
        notes.push(`steward は auto-disable されています: ${state.autoDisabledReason}`);
        logger.warn("steward: auto-disable 状態のためスキップしました", {
          reason: state.autoDisabledReason,
          retryAfterSec: autoDisableRun.retryAfterSec,
        });
        return { name: "steward", actions: 0, skipped: true, notes };
      }

      // §40.1: cadence gating（intervalMinutes 経過時のみ実行）
      const intervalMinutes = resolveIntervalMinutes(config);
      const intervalSec = intervalMinutes * 60;
      if (state.lastRunAt > 0 && currentSec - state.lastRunAt < intervalSec) {
        const remainingSec = intervalSec - (currentSec - state.lastRunAt);
        notes.push(`cadence gating: 残り${remainingSec}秒のためスキップしました`);
        return { name: "steward", actions: 0, skipped: false, notes };
      }

      // §40.1: profile 検査（未定義なら skip + warn = fail-closed）
      if (config.profiles["steward"] === undefined) {
        notes.push("steward profile が未定義のためスキップしました");
        logger.warn(
          'steward: profiles["steward"] が config.json に定義されていません',
        );
        return { name: "steward", actions: 0, skipped: false, notes };
      }

      const circuitStore = stewardCircuitStateStore(home);
      let halfOpenClaimGeneration: number | undefined;
      let halfOpenDeadlineMs: number | undefined;
      if (autoDisableRun.halfOpen) {
        const claim = tryAcquireAutoDisableHalfOpenClaim(circuitStore, currentSec);
        if (claim.status !== "acquired") {
          notes.push(
            claim.status === "lock-contended"
              ? "steward half-open claim は別processがstate lockを保持中のため延期しました"
              : "steward half-open claim は別processが先に獲得したため延期しました",
          );
          return { name: "steward", actions: 0, skipped: true, notes };
        }
        halfOpenClaimGeneration = claim.claimGeneration;
        halfOpenDeadlineMs = elapsedNowFn() + HALF_OPEN_CLAIM_MAX_ELAPSED_MS;
        state = readStewardState(home);
        stateBaseline = { ...state };
      }

      const mutate: StewardMutationFence = <Result>(
        operation: () => Result,
        notificationForResult?: (result: Result) => StewardOutboxNotification | undefined,
      ): Result => {
        if (halfOpenClaimGeneration === undefined) {
          return operation();
        }
        const claimGeneration = halfOpenClaimGeneration;
        const fenced = runUnderAutoDisableHalfOpenClaimFence<StewardState, unknown>(
          circuitStore,
          claimGeneration,
          () => store.transaction(() => {
            const result = operation();
            const notification = notificationForResult?.(result);
            if (notification !== undefined) {
              enqueueStewardHalfOpenNotification(store, claimGeneration, currentSec, notification);
            }
            return result;
          }),
        );
        if (fenced.status !== "executed") {
          throw new HalfOpenClaimFenceError(fenced.status);
        }
        return fenced.value as Result;
      };

      const proposalNotifyFn: StewardNotifyFn | undefined = halfOpenClaimGeneration === undefined
        ? notifyFn
        : undefined;
      const proposalNotifyMode: StewardNotifyMode = halfOpenClaimGeneration === undefined
        ? notifyMode
        : "outbox";
      const proposalLimit = halfOpenClaimGeneration === undefined
        ? undefined
        : HALF_OPEN_PROPOSAL_LIMIT;
      const shouldContinueProposals = (): boolean =>
        halfOpenDeadlineMs === undefined || elapsedNowFn() < halfOpenDeadlineMs;

      const drainClaimOutbox = async (): Promise<boolean> => {
        if (halfOpenClaimGeneration === undefined) {
          return false;
        }
        const drained = await drainStewardHalfOpenOutbox(
          deps,
          halfOpenClaimGeneration,
          currentSec,
          notifyFn,
          notifyMode,
          elapsedNowFn,
          halfOpenDeadlineMs,
        );
        if (drained.budgetExceeded) {
          notes.push("steward half-open claim が経過時間上限30分に達したため配送を打ち切りました");
        }
        return drained.budgetExceeded;
      };

      const runFencedEffects = async <Result>(
        operation: () => Promise<Result>,
      ): Promise<Result | null> => {
        try {
          return await operation();
        } catch (err) {
          if (!(err instanceof HalfOpenClaimFenceError)) {
            throw err;
          }
          notes.push(`steward half-open claim を失ったため副作用を中止しました (${err.status})`);
          return null;
        }
      };

      const commitState = (nextState: StewardState, expectedState: StewardState): boolean => {
        if (halfOpenClaimGeneration === undefined) {
          writeStewardState(home, nextState, expectedState);
          return true;
        }
        try {
          const fenced = runUnderAutoDisableHalfOpenClaimFence(
            circuitStore,
            halfOpenClaimGeneration,
            (currentState, writeStateUnderLock) => {
              if (!areStewardStatesEqual(currentState, expectedState)) {
                throw new HalfOpenClaimFenceError("claim-mismatch");
              }
              writeStateUnderLock(nextState);
            },
          );
          if (fenced.status !== "executed") {
            throw new HalfOpenClaimFenceError(fenced.status);
          }
          return true;
        } catch (err) {
          if (!(err instanceof HalfOpenClaimFenceError)) {
            throw err;
          }
          notes.push(`steward half-open claim を失ったためstate更新を中止しました (${err.status})`);
          return false;
        }
      };

      const failureAtSec = halfOpenClaimGeneration === undefined
        ? currentSec
        : state.autoDisabledAt;

      const resolution = resolveModel(buildVirtualStewardTask(currentSec), config);
      if (!resolution.ok) {
        notes.push(`steward profile のモデル解決に失敗しました: ${resolution.reason}`);
        logger.warn("steward: モデル解決に失敗しました", {
          reason: resolution.reason,
          detail: resolution.detail,
        });
        return { name: "steward", actions: 0, skipped: false, notes };
      }

      let sessionRunner = injectedSessionRunner;
      if (sessionRunner === undefined) {
        try {
          sessionRunner = createDirectStewardSessionRunner(
            deps,
            resolution,
            currentSec,
            sessionTimeoutSec,
            sessionPollIntervalMs,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("steward: direct session runner の構築に失敗しました", {
            error: redactText(message),
          });
          notes.push(`steward session runner 構築失敗: ${redactText(message)}`);
          state.lastRunAt = currentSec;
          state.lastProposalCount = 0;
          state.lastAppliedCount = 0;
          state.lastProposedCount = 0;
          state.lastRequestedCount = 0;
          state.lastSuppressedCount = 0;
          state.lastArchivedByEvidence = {};
          state.lastError = redactText(message);
          const transitionedToAutoDisabled = applyStewardFailureCircuit(
            state,
            failureAtSec,
            message,
            notes,
          );
          const deterministic = await runFencedEffects(() =>
            applyDeterministicDoneEscalations(
              deps,
              logger,
              currentSec,
              proposalNotifyFn,
              proposalNotifyMode,
              mutate,
              proposalLimit,
              shouldContinueProposals,
            )
          );
          if (deterministic === null) {
            return { name: "steward", actions: 0, skipped: true, notes };
          }
          notes.push(...deterministic.result.notes);
          state.lastProposalCount = deterministic.proposalCount;
          state.lastAppliedCount = deterministic.result.applied;
          state.lastProposedCount = deterministic.result.proposed;
          state.lastRequestedCount = deterministic.result.requested;
          state.lastSuppressedCount = deterministic.result.suppressed;
          state.lastArchivedByEvidence = deterministic.result.archivedByEvidence;
          await drainClaimOutbox();
          const committed = commitState(state, stateBaseline);
          if (transitionedToAutoDisabled) {
            if (committed) {
              await notifyStewardLifecycle(
                deps,
                currentSec,
                `steward: 連続${state.consecutiveFailures}回失敗により auto-disable しました`,
                lifecycleNotifyFn,
              );
            }
          }
          return {
            name: "steward",
            actions: actionCount(deterministic.result),
            skipped: !committed,
            notes,
          };
        }
      }

      // §40.2: board スナップショット構築（redact 済み）
      const boardSnapshot = buildBoardSnapshot(store, currentSec);
      const prompt = buildStewardPrompt(boardSnapshot);

      // 判断セッション実行
      let output: string;
      try {
        const session = sessionRunner.run(prompt);
        if (halfOpenDeadlineMs === undefined) {
          output = await session;
        } else {
          const outcome = await awaitWithinDeadline(session, halfOpenDeadlineMs - elapsedNowFn());
          if (outcome.status === "timed-out") {
            throw new Error("steward half-open claim が経過時間上限30分に達しました");
          }
          output = outcome.value;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("steward: セッション起動に失敗しました", {
          error: redactText(message),
        });
        // 連続失敗カウント + auto-disable 検査
        state.lastRunAt = currentSec;
        state.lastProposalCount = 0;
        state.lastAppliedCount = 0;
        state.lastProposedCount = 0;
        state.lastRequestedCount = 0;
        state.lastSuppressedCount = 0;
        state.lastArchivedByEvidence = {};
        state.lastError = redactText(message);
        const transitionedToAutoDisabled = applyStewardFailureCircuit(
          state,
          failureAtSec,
          message,
          notes,
        );
        if (transitionedToAutoDisabled) {
          logger.error("steward: 連続失敗により auto-disable しました", {
            consecutiveFailures: state.consecutiveFailures,
          });
        }
        const deterministic = await runFencedEffects(() =>
          applyDeterministicDoneEscalations(
            deps,
            logger,
            currentSec,
            proposalNotifyFn,
            proposalNotifyMode,
            mutate,
            proposalLimit,
            shouldContinueProposals,
          )
        );
        if (deterministic === null) {
          return { name: "steward", actions: 0, skipped: true, notes };
        }
        notes.push(...deterministic.result.notes);
        state.lastProposalCount = deterministic.proposalCount;
        state.lastAppliedCount = deterministic.result.applied;
        state.lastProposedCount = deterministic.result.proposed;
        state.lastRequestedCount = deterministic.result.requested;
        state.lastSuppressedCount = deterministic.result.suppressed;
        state.lastArchivedByEvidence = deterministic.result.archivedByEvidence;
        await drainClaimOutbox();
        const committed = commitState(state, stateBaseline);
        if (transitionedToAutoDisabled) {
          if (committed) {
            await notifyStewardLifecycle(
              deps,
              currentSec,
              `steward: 連続${state.consecutiveFailures}回失敗により auto-disable しました`,
              lifecycleNotifyFn,
            );
          }
        }
        return {
          name: "steward",
          actions: actionCount(deterministic.result),
          skipped: !committed,
          notes,
        };
      }

      // §40.3: 出力パース
      const parseResult = parseStewardOutputDetailed(output, store, logger);
      const parsedProposals = parseResult.proposals;

      // フェンス欠如・JSON不正・トップレベルスキーマ不正はパース不能として連続失敗カウント
      if (!parseResult.parseOk) {
        state.lastRunAt = currentSec;
        state.lastProposalCount = 0;
        state.lastAppliedCount = 0;
        state.lastProposedCount = 0;
        state.lastRequestedCount = 0;
        state.lastSuppressedCount = 0;
        state.lastArchivedByEvidence = {};
        state.lastError = "出力パース不能";
        const transitionedToAutoDisabled = applyStewardFailureCircuit(
          state,
          failureAtSec,
          "出力パース不能",
          notes,
        );
        if (transitionedToAutoDisabled) {
          logger.error("steward: 連続失敗（パース不能）により auto-disable しました", {
            consecutiveFailures: state.consecutiveFailures,
          });
        }
        const deterministic = await runFencedEffects(() =>
          applyDeterministicDoneEscalations(
            deps,
            logger,
            currentSec,
            proposalNotifyFn,
            proposalNotifyMode,
            mutate,
            proposalLimit,
            shouldContinueProposals,
          )
        );
        if (deterministic === null) {
          return { name: "steward", actions: 0, skipped: true, notes };
        }
        notes.push(...deterministic.result.notes);
        state.lastProposalCount = deterministic.proposalCount;
        state.lastAppliedCount = deterministic.result.applied;
        state.lastProposedCount = deterministic.result.proposed;
        state.lastRequestedCount = deterministic.result.requested;
        state.lastSuppressedCount = deterministic.result.suppressed;
        state.lastArchivedByEvidence = deterministic.result.archivedByEvidence;
        await drainClaimOutbox();
        const committed = commitState(state, stateBaseline);
        if (transitionedToAutoDisabled) {
          if (committed) {
            await notifyStewardLifecycle(
              deps,
              currentSec,
              `steward: 連続${state.consecutiveFailures}回失敗により auto-disable しました`,
              lifecycleNotifyFn,
            );
          }
        }
        return {
          name: "steward",
          actions: actionCount(deterministic.result),
          skipped: !committed,
          notes: [...notes, "steward: 出力パース不能"],
        };
      }

      // パース成功。half-open は提案適用・outbox drain が上限内で終わった場合だけ完全復帰する。
      state.lastRunAt = currentSec;

      // done向けescalateはLLM推測を使わず、freshな全event履歴のpure決定表へ置換する。
      const proposals = reconcileDoneConsistencyProposals(store, parsedProposals);

      // §40.4: 適用規則
      const result = await runFencedEffects(() =>
        applyProposals(
          proposals,
          deps,
          logger,
          currentSec,
          proposalNotifyFn,
          proposalNotifyMode,
          mutate,
          proposalLimit,
          shouldContinueProposals,
        )
      );
      if (result === null) {
        return { name: "steward", actions: 0, skipped: true, notes };
      }
      notes.push(...result.notes);
      state.lastProposalCount = result.proposalCount;
      state.lastAppliedCount = result.applied;
      state.lastProposedCount = result.proposed;
      state.lastRequestedCount = result.requested;
      state.lastSuppressedCount = result.suppressed;
      state.lastArchivedByEvidence = result.archivedByEvidence;

      const drainBudgetExceeded = await drainClaimOutbox();
      const halfOpenStopped = halfOpenClaimGeneration !== undefined && (
        result.stoppedEarly ||
        drainBudgetExceeded ||
        !shouldContinueProposals()
      );
      let recoveredFromAutoDisabled = false;
      if (halfOpenStopped) {
        const message = result.stoppedEarly
          ? `half-open 提案適用を上限（${HALF_OPEN_PROPOSAL_LIMIT}件または30分）で打ち切りました`
          : "half-open claim が経過時間上限30分に達しました";
        state.lastError = message;
        applyStewardFailureCircuit(state, failureAtSec, message, notes);
      } else {
        const success = decideAutoDisableSuccess(state);
        Object.assign(state, success.nextState);
        recoveredFromAutoDisabled = success.recoveredFromAutoDisabled;
        state.lastError = "";
      }

      // §40.5: state 書き込み
      const committed = commitState(state, stateBaseline);
      if (recoveredFromAutoDisabled && committed) {
        await notifyStewardLifecycle(
          deps,
          currentSec,
          "steward: half-open 再試行に成功し auto-disable から復帰しました",
          lifecycleNotifyFn,
        );
      }

      const totalActions = actionCount(result);
      notes.push(
        `steward: 提案${proposals.length}件、自動適用${result.applied}件、request発行${result.requested}件、再提案抑止${result.suppressed}件、提案コメント${result.proposed}件、指摘コメント${result.commented}件、通知${result.notified}件`,
      );

      return { name: "steward", actions: totalActions, skipped: !committed, notes };
    },
  };
}

/**
 * supervisor 本体が使う既定 steward ステージ。sessionRunner 未指定時は direct adapter で短命起動し、
 * proposal/escalate 通知は §38 notify transport へ渡す。
 */
export const stewardStage: Stage = createStewardStage({
  notifyMode: "transport",
  lifecycleNotifyFn: sendAdHocNotification,
});
