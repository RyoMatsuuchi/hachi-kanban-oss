// 朝夕ブリーフステージ（docs/contract.md §48）
// board/knowledge の差分を短命判断セッションへ渡し、プレーンテキスト要約を §38 operational notify へ配信する。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  acquireStewardStateLock,
  humanQueueLaneOfReason,
  redactText,
  resolveModel,
  writeFileAtomic0600Durable,
} from "@hachi/core";
import type {
  EffortLevel,
  HachiConfig,
  KanbanStore,
  KnowledgeRow,
  ModelResolution,
  Provider,
  Stage,
  StageDeps,
  StageResult,
  TaskRow,
  WorkerAdapter,
} from "@hachi/core";
import {
  sendAdHocNotification,
  sendOperationalNotification,
  type CreateNotifyStageOptions,
  type OperationalNotifyInput,
  type OperationalNotifyResult,
} from "./notify.js";
import {
  decideAutoDisableFailure,
  decideAutoDisableRun,
  decideAutoDisableSuccess,
  runUnderAutoDisableHalfOpenClaimFence,
  tryAcquireAutoDisableHalfOpenClaim,
  type AutoDisableCircuitStateStore,
} from "./auto-disable-circuit-breaker.js";
import { parseArchiveEventIntegrationEvidence } from "./steward.js";
import type { IntegrationEvidence } from "./steward-archive-integration.js";

const DEFAULT_SESSION_TIMEOUT_SEC = 300;
const DEFAULT_SESSION_POLL_INTERVAL_MS = 1_000;
/** claim expiry 3600秒の半分。session 300秒 + brief配送最大約20秒へ十分な余白を残す。 */
const HALF_OPEN_CLAIM_MAX_ELAPSED_MS = 30 * 60 * 1_000;
const KNOWLEDGE_SCAN_LIMIT = Number.MAX_SAFE_INTEGER;
const MISSING_DIRECT_TRANSCRIPT = "(出力ファイルなし)";
const DEFAULT_BRIEF_PROFILE = {
  provider: "claude" as Provider,
  model: "claude-sonnet-5",
  transport: "direct" as const,
  effort: "medium" as EffortLevel,
};

export interface BriefState {
  lastRunAt: number;
  lastError: string;
  consecutiveFailures: number;
  autoDisabled: boolean;
  autoDisabledReason: string;
  /** auto-disable へ遷移した時刻。0 は legacy state から即座に half-open 可を表す */
  autoDisabledAt: number;
  /** half-open claim の単調増加世代。legacy state の欠落は 0 とする */
  claimGeneration: number;
}

const DEFAULT_STATE: BriefState = {
  lastRunAt: 0,
  lastError: "",
  consecutiveFailures: 0,
  autoDisabled: false,
  autoDisabledReason: "",
  autoDisabledAt: 0,
  claimGeneration: 0,
};

export interface BriefSessionRunner {
  run(prompt: string): Promise<string>;
}

export type BriefNotifyFn = (
  deps: StageDeps,
  input: OperationalNotifyInput,
  options?: CreateNotifyStageOptions,
) => Promise<OperationalNotifyResult>;

/** auto-disable / half-open 復帰を既存 ad-hoc notify 経路へ渡す関数型。 */
export type BriefLifecycleNotifyFn = (
  deps: StageDeps,
  task: TaskRow,
  message: string,
) => Promise<boolean>;

export interface BriefStageOptions {
  sessionRunner?: BriefSessionRunner;
  nowFn?: () => number;
  notifyFn?: BriefNotifyFn;
  lifecycleNotifyFn?: BriefLifecycleNotifyFn;
  sessionTimeoutSec?: number;
  sessionPollIntervalMs?: number;
  /** half-open claim の経過時間計測用 monotonic clock（ms。テスト DI） */
  elapsedNowFn?: () => number;
}

interface BriefConfig {
  times: string[];
}

interface ConfigWithBrief extends HachiConfig {
  brief?: BriefConfig;
}

interface KnowledgeReadableStore {
  listKnowledge(options?: { includeExpired?: boolean; limit?: number }): KnowledgeRow[];
}

export interface BriefTaskSummary {
  id: string;
  title: string;
  priority: number;
  reason?: string;
}

export interface BriefKnowledgeSummary {
  id: string;
  title: string;
  tags: string[];
}

export interface BriefMaterials {
  since: number;
  now: number;
  doneTitles: string[];
  humanDecisionQueue: BriefTaskSummary[];
  orchestratorRecoveryQueue: BriefTaskSummary[];
  autonomousInProgress: BriefTaskSummary[];
  knowledge: BriefKnowledgeSummary[];
  /** §74.3: [since, now) の間に integrationEvidence 別に自動 archive された件数（可視化のみ） */
  archivedByEvidence: Partial<Record<IntegrationEvidence, number>>;
}

function briefStatePath(home: string): string {
  return join(home, "state", "brief.json");
}

export function readBriefState(home: string): BriefState {
  const path = briefStatePath(home);
  if (!existsSync(path)) {
    return { ...DEFAULT_STATE };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return { ...DEFAULT_STATE };
    }
    const obj = parsed as Record<string, unknown>;
    return {
      lastRunAt: typeof obj.lastRunAt === "number" ? obj.lastRunAt : 0,
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

function writeBriefStateUnderLock(home: string, state: BriefState): void {
  const stateDir = join(home, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileAtomic0600Durable(briefStatePath(home), JSON.stringify(state));
}

function areBriefStatesEqual(left: BriefState, right: BriefState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function briefCircuitStateStore(home: string): AutoDisableCircuitStateStore<BriefState> {
  return {
    home,
    lockOwner: "supervisor-brief",
    readState: () => readBriefState(home),
    writeStateUnderLock: (state) => writeBriefStateUnderLock(home, state),
  };
}

export function writeBriefState(home: string, state: BriefState, expectedState?: BriefState): void {
  const lock = acquireStewardStateLock(home, "supervisor-brief");
  if (lock === null) {
    throw new Error("brief state は別processが操作中のため次tickへ延期します");
  }
  try {
    if (expectedState !== undefined) {
      const current = readBriefState(home);
      if (!areBriefStatesEqual(current, expectedState)) {
        throw new Error("brief state がtick開始後に変更されたためstale writeを拒否しました");
      }
    }
    writeBriefStateUnderLock(home, state);
  } finally {
    lock.release();
  }
}

function parseBriefTime(time: string): { hour: number; minute: number } {
  const [hourRaw, minuteRaw] = time.split(":");
  return {
    hour: Number(hourRaw),
    minute: Number(minuteRaw),
  };
}

function localDayStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function scheduledEpochSec(day: Date, time: string): number {
  const parsed = parseBriefTime(time);
  return Math.floor(
    new Date(day.getFullYear(), day.getMonth(), day.getDate(), parsed.hour, parsed.minute).getTime() / 1000,
  );
}

export function computeDueBriefSlots(lastRunAt: number, nowSec: number, times: readonly string[]): number[] {
  if (times.length === 0 || nowSec <= 0) {
    return [];
  }
  if (lastRunAt > nowSec) {
    return [];
  }

  const sortedTimes = [...new Set(times)].sort();
  const nowDate = new Date(nowSec * 1000);
  const startDate = lastRunAt > 0 ? new Date(lastRunAt * 1000) : nowDate;
  const day = localDayStart(startDate);
  const endDay = localDayStart(nowDate);
  const slots = new Set<number>();

  while (day.getTime() <= endDay.getTime()) {
    for (const time of sortedTimes) {
      const slot = scheduledEpochSec(day, time);
      if (slot > lastRunAt && slot <= nowSec) {
        slots.add(slot);
      }
    }
    day.setDate(day.getDate() + 1);
  }

  return [...slots].sort((a, b) => a - b);
}

function taskSummary(task: TaskRow, includeReason: boolean): BriefTaskSummary {
  const summary: BriefTaskSummary = {
    id: task.id,
    title: redactText(task.title),
    priority: task.priority,
  };
  if (includeReason) {
    summary.reason = redactText(task.blockReason);
  }
  return summary;
}

function listFreshKnowledge(store: KanbanStore, since: number, now: number): BriefKnowledgeSummary[] {
  const readable = store as KanbanStore & Partial<KnowledgeReadableStore>;
  if (typeof readable.listKnowledge !== "function") {
    return [];
  }
  return readable
    .listKnowledge({ includeExpired: true, limit: KNOWLEDGE_SCAN_LIMIT })
    .filter((row) => row.createdAt > since && row.createdAt <= now)
    .filter((row) => row.expiresAt === null || row.expiresAt >= now)
    .map((row) => ({
      id: row.id,
      title: redactText(row.title),
      tags: row.tags.map((tag) => redactText(tag)),
    }));
}

/**
 * §74.3: (since, now] の間に archived へ遷移したタスクについて、steward_auto_archive イベントの
 * integrationEvidence を集計する。doneTitles（(task.completedAt ?? task.updatedAt) のウィンドウ判定）
 * と揃えたいところだが、archived は done から遷移するため completedAt は done化した時刻のまま
 * 更新されない（archive された時刻は反映されない）。archive 遷移時刻を正しく捉えられるのは
 * updatedAt だけであり（archived は terminal 状態のため以降の遷移で上書きされる心配もない）、
 * ここでは updatedAt を使う。
 *
 * これにより「steward の直近1tickしか反映しない」という精度不足（state/steward.json の
 * lastArchivedByEvidence を毎tick上書きで読んでいた過去の実装ミス）を避け、ブリーフ配信間隔を
 * またいで発生した全 tick 分の archive を正しく合算する。
 */
function aggregateArchivedByEvidence(
  store: KanbanStore,
  since: number,
  now: number,
): Partial<Record<IntegrationEvidence, number>> {
  const result: Partial<Record<IntegrationEvidence, number>> = {};
  for (const task of store.listByStatus("archived")) {
    if (task.updatedAt <= since || task.updatedAt > now) {
      continue;
    }
    const events = store.listEvents(task.id, "steward_auto_archive");
    for (const event of events) {
      if (event.createdAt <= since || event.createdAt > now) {
        continue;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(event.payload);
      } catch {
        continue;
      }
      const evidence = parseArchiveEventIntegrationEvidence(payload);
      if (evidence !== null) {
        result[evidence] = (result[evidence] ?? 0) + 1;
      }
    }
  }
  return result;
}

export function collectBriefMaterials(
  store: KanbanStore,
  since: number,
  now: number,
): BriefMaterials {
  const autonomousInProgressTasks = store.listInProgress();
  const autonomousInProgressIds = new Set(autonomousInProgressTasks.map((task) => task.id));
  const doneTitles = store
    .listByStatus("done")
    .filter((task) => (task.completedAt ?? task.updatedAt) > since)
    .filter((task) => (task.completedAt ?? task.updatedAt) <= now)
    .map((task) => redactText(task.title));

  const humanDecisionQueue: BriefTaskSummary[] = [];
  const orchestratorRecoveryQueue: BriefTaskSummary[] = [];
  for (const task of store.listByStatus("blocked")) {
    if (autonomousInProgressIds.has(task.id)) {
      continue;
    }
    const lane = humanQueueLaneOfReason(task.blockReason);
    if (lane === "human_decision") {
      humanDecisionQueue.push(taskSummary(task, true));
    } else {
      orchestratorRecoveryQueue.push(taskSummary(task, true));
    }
  }

  // §74.3: [since, now) のウィンドウで evidence 別自動 archive 件数を store から直接集計する
  const archivedByEvidence = aggregateArchivedByEvidence(store, since, now);

  return {
    since,
    now,
    doneTitles,
    humanDecisionQueue,
    orchestratorRecoveryQueue,
    autonomousInProgress: autonomousInProgressTasks.map((task) => taskSummary(task, true)),
    knowledge: listFreshKnowledge(store, since, now),
    archivedByEvidence,
  };
}

function formatTaskSummaries(tasks: readonly BriefTaskSummary[]): string {
  if (tasks.length === 0) {
    return "- なし";
  }
  return tasks
    .map((task) => {
      const reason = task.reason !== undefined ? ` | reason=${task.reason}` : "";
      return `- ${task.id} | ${task.title} | priority=${task.priority}${reason}`;
    })
    .join("\n");
}

function formatKnowledgeSummaries(items: readonly BriefKnowledgeSummary[]): string {
  if (items.length === 0) {
    return "- なし";
  }
  return items
    .map((item) => `- ${item.id} | ${item.title} | tags=${item.tags.join(",")}`)
    .join("\n");
}

/**
 * §74.3: 統合を観測せずに archive した件数（evidence 別）のセクションを組み立てる。
 * `not-observable:*` の evidence のみが対象。`clean-head-reachable` /
 * `clean-patch-equivalent` は「統合を観測した上で」archive したケースであり、
 * ここに混ぜると「統合を観測せずに archive した件数」という見出しと矛盾する事実誤認になる。
 * 絞り込んだ結果が0件のときはセクション自体を省略し、通常運転時のノイズを増やさない。
 */
function formatArchivedByEvidenceSection(
  archivedByEvidence: Partial<Record<IntegrationEvidence, number>>,
): string {
  const entries = Object.entries(archivedByEvidence)
    .filter(([evidence]) => evidence.startsWith("not-observable:"))
    .filter(([, count]) => (count ?? 0) > 0);
  if (entries.length === 0) {
    return "";
  }
  const lines = entries.map(([evidence, count]) => `- ${evidence}: ${count}件`).join("\n");
  return `\n\n## 統合を観測せずに archive した件数（board が統合済みに見えても実際は確認できていない可能性があります）\n${lines}`;
}

export function buildBriefPrompt(materials: BriefMaterials, dueSlots: readonly number[]): string {
  const dueTimes = dueSlots.map((slot) => new Date(slot * 1000).toISOString()).join(", ");
  const doneLines = materials.doneTitles.length === 0
    ? "- なし"
    : materials.doneTitles.map((title) => `- ${title}`).join("\n");
  const archivedByEvidenceSection = formatArchivedByEvidenceSection(materials.archivedByEvidence);

  return `あなたは hachi-kanban の朝夕ブリーフ担当です。以下の材料だけを使い、400字目安の日本語プレーンテキストで要約してください。
見出し1行と短い箇条書きにしてください。提案、状態遷移、フェンス、JSON、未確認の断定は出力しないでください。

対象配信時刻: ${dueTimes}
集計範囲: ${new Date(materials.since * 1000).toISOString()} 以降、${new Date(materials.now * 1000).toISOString()} まで

## 前回以降に完了したタスク
${doneLines}

## 人間確認キュー（判断待ち）
${formatTaskSummaries(materials.humanDecisionQueue)}

## 人間確認キュー（回収待ち）
${formatTaskSummaries(materials.orchestratorRecoveryQueue)}

## 自律進行中
${formatTaskSummaries(materials.autonomousInProgress)}

## 新着 knowledge（期限内）
${formatKnowledgeSummaries(materials.knowledge)}${archivedByEvidenceSection}`;
}

function buildVirtualBriefTask(nowSec: number): TaskRow {
  return {
    id: "brief",
    title: "朝夕ブリーフ",
    body: "",
    status: "blocked",
    priority: 0,
    tenant: "system",
    assignee: "",
    provider: "",
    profile: "brief",
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

function resolveBriefModel(config: HachiConfig, nowSec: number): ModelResolution {
  if (config.profiles["brief"] !== undefined) {
    return resolveModel(buildVirtualBriefTask(nowSec), config);
  }
  if (!config.allowlist[DEFAULT_BRIEF_PROFILE.provider].includes(DEFAULT_BRIEF_PROFILE.model)) {
    return {
      ok: false,
      reason: "model-not-allowlisted",
      detail: `brief 既定 profile の model が allowlist 外です（provider=${DEFAULT_BRIEF_PROFILE.provider}）: ${DEFAULT_BRIEF_PROFILE.model}`,
    };
  }
  return {
    ok: true,
    provider: DEFAULT_BRIEF_PROFILE.provider,
    model: DEFAULT_BRIEF_PROFILE.model,
    source: "default",
    transport: DEFAULT_BRIEF_PROFILE.transport,
    effort: DEFAULT_BRIEF_PROFILE.effort,
  };
}

function pickDirectBriefAdapter(deps: StageDeps, resolution: Extract<ModelResolution, { ok: true }>): WorkerAdapter {
  if (resolution.transport !== "direct") {
    throw new Error(`brief profile は transport=direct 必須です (actual=${resolution.transport})`);
  }
  const adapter = deps.directAdapters?.[resolution.provider];
  if (adapter === undefined) {
    throw new Error(`direct transport の adapter が未構成です (provider=${resolution.provider})`);
  }
  if (adapter.stop === undefined) {
    throw new Error(`brief direct adapter は stop capability 必須です (provider=${resolution.provider})`);
  }
  return adapter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSessionComplete(resultCount: number | undefined, state: string): boolean {
  return state === "idle" && (resultCount ?? 0) >= 1;
}

function assertUsableBriefTranscript(transcript: string, sessionId: string): string {
  const trimmed = transcript.trim();
  if (trimmed === "" || trimmed === MISSING_DIRECT_TRANSCRIPT) {
    throw new Error(`brief direct session transcript が取得できませんでした (sessionId=${redactText(sessionId)})`);
  }
  return trimmed;
}

function createEphemeralBriefWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "hachi-brief-"));
  try {
    chmodSync(workspace, 0o700);
    execFileSync("git", ["init", "--quiet", workspace], { stdio: "ignore" });
    return workspace;
  } catch (error) {
    rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

function createDirectBriefSessionRunner(
  deps: StageDeps,
  resolution: Extract<ModelResolution, { ok: true }>,
  nowSec: number,
  timeoutSec: number,
  pollIntervalMs: number,
): BriefSessionRunner {
  const adapter = pickDirectBriefAdapter(deps, resolution);
  const virtualTask = buildVirtualBriefTask(nowSec);

  return {
    async run(prompt: string): Promise<string> {
      const workspace = createEphemeralBriefWorkspace();
      let ref: Awaited<ReturnType<WorkerAdapter["launch"]>> | undefined;
      let terminal = false;
      try {
        ref = await adapter.launch(virtualTask, {
          model: resolution.model,
          cwd: workspace,
          promptText: prompt,
          ...(resolution.effort !== undefined ? { effort: resolution.effort } : {}),
        });
        deps.logger.info("brief: direct session を開始しました", {
          sessionId: redactText(ref.sessionId),
          provider: resolution.provider,
          model: resolution.model,
          timeoutSec,
        });
        const deadlineMs = Date.now() + timeoutSec * 1000;
        while (Date.now() <= deadlineMs) {
          const status = await adapter.status(ref);
          if (isSessionComplete(status.resultCount, status.state)) {
            const transcript = assertUsableBriefTranscript(
              await adapter.fetchTranscript(ref),
              ref.sessionId,
            );
            terminal = true;
            deps.logger.info("brief: direct session が正常終端しました", {
              sessionId: redactText(ref.sessionId),
              state: status.state,
              resultCount: status.resultCount ?? 0,
            });
            return transcript;
          }
          await sleep(pollIntervalMs);
        }

        deps.logger.error("brief: direct session がtimeoutしました", {
          sessionId: redactText(ref.sessionId),
          timeoutSec,
        });
        throw new Error(`brief direct session timeout (sessionId=${redactText(ref.sessionId)})`);
      } finally {
        if (!terminal && ref !== undefined) {
          try {
            const stopResult = await adapter.stop!(ref);
            let postStopState = "unknown";
            try {
              postStopState = (await adapter.status(ref)).state;
            } catch (error) {
              deps.logger.warn("brief: stop後のdirect session状態を確認できませんでした", {
                sessionId: redactText(ref.sessionId),
                error: redactText(error instanceof Error ? error.message : String(error)),
              });
            }
            const residual = postStopState === "active" || postStopState === "awaiting-input";
            deps.logger.warn("brief: 未完了direct sessionの停止を試行しました", {
              sessionId: redactText(ref.sessionId),
              stopped: stopResult.stopped,
              reason: stopResult.reason,
              postStopState,
              residual,
            });
          } catch (error) {
            deps.logger.error("brief: 未完了direct sessionの停止に失敗しました", {
              sessionId: redactText(ref.sessionId),
              error: redactText(error instanceof Error ? error.message : String(error)),
            });
          }
        }
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  };
}

async function notifyBriefLifecycle(
  deps: StageDeps,
  nowSec: number,
  message: string,
  notifyFn: BriefLifecycleNotifyFn | undefined,
): Promise<void> {
  if (notifyFn === undefined) {
    return;
  }
  const attempted = await notifyFn(deps, buildVirtualBriefTask(nowSec), message);
  if (!attempted) {
    deps.logger.warn("brief: lifecycle notification が試行されませんでした");
  }
}

interface BriefHalfOpenOutboxWrite {
  input: OperationalNotifyInput;
  onEnqueued(id: string, alreadySent: boolean): void;
}

type BriefStateCommit = (
  state: BriefState,
  expectedState: BriefState,
  outboxWrite?: BriefHalfOpenOutboxWrite,
) => boolean;

class HalfOpenClaimFenceError extends Error {
  constructor(readonly status: "lock-contended" | "claim-mismatch") {
    super(`brief half-open claim fence を通過できませんでした: ${status}`);
  }
}

interface BriefHalfOpenDrainResult {
  sentIds: Set<string>;
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
async function drainBriefHalfOpenOutbox(
  deps: StageDeps,
  currentGeneration: number,
  nowSec: number,
  notifyFn: BriefNotifyFn | undefined,
  elapsedNowFn: () => number,
  deadlineMs?: number,
): Promise<BriefHalfOpenDrainResult> {
  const sentIds = new Set<string>();
  deps.store.discardStaleHalfOpenOutbox({ stage: "brief", currentGeneration, now: nowSec });
  if (notifyFn === undefined) {
    return { sentIds, budgetExceeded: false };
  }

  const rows = deps.store.listPendingHalfOpenOutbox({ stage: "brief", now: nowSec });
  for (const row of rows) {
    const latestGeneration = readBriefState(deps.env.home).claimGeneration;
    deps.store.discardStaleHalfOpenOutbox({
      stage: "brief",
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
      return { sentIds, budgetExceeded: true };
    }
    const input = parseOperationalNotifyInput(row.payload);
    if (input === null) {
      deps.logger.warn("brief: half-open outbox payload が不正なため配送しません", { outboxId: row.id });
      deps.store.markHalfOpenOutbox({ id: row.id, result: "failed", now: nowSec });
      continue;
    }

    try {
      const delivery = notifyFn(deps, input, { skipTransports: row.sentTransports });
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
        return { sentIds, budgetExceeded: true };
      }
      const sentTransports = [...new Set([
        ...row.sentTransports,
        ...(outcome.value.sentTransports ?? []),
      ])];
      const settled = (
        outcome.value.sent || (outcome.value.sentTransports?.length ?? 0) > 0
      ) && (outcome.value.failedTransports?.length ?? 0) === 0;
      const generationAfterDelivery = readBriefState(deps.env.home).claimGeneration;
      deps.store.discardStaleHalfOpenOutbox({
        stage: "brief",
        currentGeneration: generationAfterDelivery,
        now: nowSec,
      });
      const marked = deps.store.markHalfOpenOutbox({
        id: row.id,
        result: settled ? "sent" : "failed",
        sentTransports,
        now: nowSec,
      });
      if (marked?.status === "sent") {
        sentIds.add(row.id);
      }
    } catch (err) {
      deps.logger.warn("brief: half-open outbox の配送に失敗しました", {
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
  return { sentIds, budgetExceeded: false };
}

async function failBriefRun(
  deps: StageDeps,
  state: BriefState,
  expectedState: BriefState,
  nowSec: number,
  failureAtSec: number,
  message: string,
  notes: string[],
  lifecycleNotifyFn: BriefLifecycleNotifyFn | undefined,
  commitState: BriefStateCommit,
): Promise<boolean> {
  const failure = decideAutoDisableFailure(state, failureAtSec, redactText(message));
  Object.assign(state, failure.nextState);
  state.lastError = redactText(message);
  if (failure.transitionedToAutoDisabled) {
    notes.push(`brief: 連続${state.consecutiveFailures}回失敗により auto-disable しました`);
  }
  const committed = commitState(state, expectedState);
  if (failure.transitionedToAutoDisabled && committed) {
    await notifyBriefLifecycle(
      deps,
      nowSec,
      `brief: 連続${state.consecutiveFailures}回失敗により auto-disable しました`,
      lifecycleNotifyFn,
    );
  }
  return committed;
}

export function createBriefStage(options: BriefStageOptions = {}): Stage {
  const nowFn = options.nowFn ?? ((): number => Math.floor(Date.now() / 1000));
  const injectedSessionRunner = options.sessionRunner;
  const notifyFn = options.notifyFn;
  const lifecycleNotifyFn = options.lifecycleNotifyFn;
  const sessionTimeoutSec = options.sessionTimeoutSec ?? DEFAULT_SESSION_TIMEOUT_SEC;
  const sessionPollIntervalMs = options.sessionPollIntervalMs ?? DEFAULT_SESSION_POLL_INTERVAL_MS;
  const elapsedNowFn = options.elapsedNowFn ?? ((): number => performance.now());

  return {
    name: "brief",

    async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
      void now;
      const home = deps.env.home;
      const notes: string[] = [];

      if (existsSync(join(home, "brief.disabled"))) {
        notes.push("brief.disabled が存在するためスキップしました");
        deps.logger.warn("brief: kill-switch によりスキップしました", {
          path: join(home, "brief.disabled"),
        });
        return { name: "brief", actions: 0, skipped: true, notes };
      }

      const briefConfig = (deps.config as ConfigWithBrief).brief;
      if (briefConfig === undefined) {
        return { name: "brief", actions: 0, skipped: false, notes: ["brief config 未定義のため no-op"] };
      }

      let state = readBriefState(home);
      let stateBaseline: BriefState = { ...state };
      const currentSec = nowFn();
      if (apply) {
        await drainBriefHalfOpenOutbox(
          deps,
          state.claimGeneration,
          currentSec,
          notifyFn,
          elapsedNowFn,
        );
        state = readBriefState(home);
        stateBaseline = { ...state };
      }
      const autoDisableRun = decideAutoDisableRun(state, currentSec);
      if (!autoDisableRun.shouldRun) {
        notes.push(`brief は auto-disable されています: ${state.autoDisabledReason}`);
        deps.logger.warn("brief: auto-disable 状態のためスキップしました", {
          reason: state.autoDisabledReason,
          retryAfterSec: autoDisableRun.retryAfterSec,
        });
        return { name: "brief", actions: 0, skipped: true, notes };
      }

      const dueSlots = computeDueBriefSlots(state.lastRunAt, currentSec, briefConfig.times);
      if (dueSlots.length === 0) {
        return { name: "brief", actions: 0, skipped: false, notes: ["配信予定時刻を跨いでいないためスキップしました"] };
      }

      if (!apply) {
        return {
          name: "brief",
          actions: 0,
          skipped: false,
          notes: [`dry-run: brief 配信予定 (${dueSlots.length}時刻分を1回に集約)`],
        };
      }

      const circuitStore = briefCircuitStateStore(home);
      let halfOpenClaimGeneration: number | undefined;
      let halfOpenDeadlineMs: number | undefined;
      if (autoDisableRun.halfOpen) {
        const claim = tryAcquireAutoDisableHalfOpenClaim(circuitStore, currentSec);
        if (claim.status !== "acquired") {
          notes.push(
            claim.status === "lock-contended"
              ? "brief half-open claim は別processがstate lockを保持中のため延期しました"
              : "brief half-open claim は別processが先に獲得したため延期しました",
          );
          return { name: "brief", actions: 0, skipped: true, notes };
        }
        halfOpenClaimGeneration = claim.claimGeneration;
        halfOpenDeadlineMs = elapsedNowFn() + HALF_OPEN_CLAIM_MAX_ELAPSED_MS;
        state = readBriefState(home);
        stateBaseline = { ...state };
      }

      const commitState: BriefStateCommit = (nextState, expectedState, outboxWrite) => {
        if (halfOpenClaimGeneration === undefined) {
          writeBriefState(home, nextState, expectedState);
          return true;
        }
        try {
          const fenced = runUnderAutoDisableHalfOpenClaimFence(
            circuitStore,
            halfOpenClaimGeneration,
            (currentState, writeStateUnderLock) => {
              if (!areBriefStatesEqual(currentState, expectedState)) {
                throw new HalfOpenClaimFenceError("claim-mismatch");
              }
              writeStateUnderLock(nextState);
              if (outboxWrite !== undefined) {
                const payload = JSON.stringify(outboxWrite.input);
                const enqueued = deps.store.enqueueHalfOpenOutbox({
                  stage: "brief",
                  claimGeneration: halfOpenClaimGeneration,
                  dedupeKey: `half-open:brief:${halfOpenClaimGeneration}:brief`,
                  kind: "brief",
                  payload,
                  now: currentSec,
                });
                outboxWrite.onEnqueued(enqueued.row.id, enqueued.row.status === "sent");
              }
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
          notes.push(`brief half-open claim を失ったためstate更新を中止しました (${err.status})`);
          return false;
        }
      };

      const failureAtSec = halfOpenClaimGeneration === undefined
        ? currentSec
        : state.autoDisabledAt;

      const resolution = resolveBriefModel(deps.config, currentSec);
      if (!resolution.ok) {
        const message = `brief profile のモデル解決に失敗しました: ${resolution.reason}`;
        deps.logger.warn("brief: モデル解決に失敗しました", {
          reason: resolution.reason,
          detail: resolution.detail,
        });
        notes.push(message);
        const committed = await failBriefRun(
          deps,
          state,
          stateBaseline,
          currentSec,
          failureAtSec,
          message,
          notes,
          lifecycleNotifyFn,
          commitState,
        );
        return { name: "brief", actions: 0, skipped: !committed, notes };
      }

      let sessionRunner = injectedSessionRunner;
      if (sessionRunner === undefined) {
        try {
          sessionRunner = createDirectBriefSessionRunner(
            deps,
            resolution,
            currentSec,
            sessionTimeoutSec,
            sessionPollIntervalMs,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.logger.warn("brief: direct session runner の構築に失敗しました", {
            error: redactText(message),
          });
          notes.push(`brief session runner 構築失敗: ${redactText(message)}`);
          const committed = await failBriefRun(
            deps,
            state,
            stateBaseline,
            currentSec,
            failureAtSec,
            message,
            notes,
            lifecycleNotifyFn,
            commitState,
          );
          return { name: "brief", actions: 0, skipped: !committed, notes };
        }
      }

      const materials = collectBriefMaterials(deps.store, state.lastRunAt, currentSec);
      const prompt = buildBriefPrompt(materials, dueSlots);

      let summary: string;
      try {
        const session = sessionRunner.run(prompt);
        if (halfOpenDeadlineMs === undefined) {
          summary = (await session).trim();
        } else {
          const outcome = await awaitWithinDeadline(session, halfOpenDeadlineMs - elapsedNowFn());
          if (outcome.status === "timed-out") {
            throw new Error("brief half-open claim が経過時間上限30分に達しました");
          }
          summary = outcome.value.trim();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger.error("brief: セッション起動に失敗しました", {
          error: redactText(message),
        });
        notes.push(`brief セッション失敗: ${redactText(message)}`);
        const committed = await failBriefRun(
          deps,
          state,
          stateBaseline,
          currentSec,
          failureAtSec,
          message,
          notes,
          lifecycleNotifyFn,
          commitState,
        );
        return { name: "brief", actions: 0, skipped: !committed, notes };
      }

      if (summary === "") {
        const message = "brief セッション出力が空です";
        deps.logger.warn("brief: セッション出力が空です");
        notes.push(message);
        const committed = await failBriefRun(
          deps,
          state,
          stateBaseline,
          currentSec,
          failureAtSec,
          message,
          notes,
          lifecycleNotifyFn,
          commitState,
        );
        return { name: "brief", actions: 0, skipped: !committed, notes };
      }

      if (notifyFn === undefined) {
        const message = "brief notifyFn が未設定です";
        deps.logger.warn("brief: notifyFn 未設定のため配信できません");
        notes.push(message);
        const committed = await failBriefRun(
          deps,
          state,
          stateBaseline,
          currentSec,
          failureAtSec,
          message,
          notes,
          lifecycleNotifyFn,
          commitState,
        );
        return { name: "brief", actions: 0, skipped: !committed, notes };
      }

      const notifyInput: OperationalNotifyInput = {
        id: "brief",
        title: "hachi-kanban brief",
        body: summary,
        priority: 1_000_000,
      };
      let notifyResult: OperationalNotifyResult;
      if (halfOpenClaimGeneration === undefined) {
        notifyResult = await notifyFn(deps, notifyInput);
      } else {
        if (halfOpenDeadlineMs !== undefined && elapsedNowFn() >= halfOpenDeadlineMs) {
          const message = "brief half-open claim が経過時間上限30分に達しました";
          notes.push(message);
          const committed = await failBriefRun(
            deps,
            state,
            stateBaseline,
            currentSec,
            failureAtSec,
            message,
            notes,
            lifecycleNotifyFn,
            commitState,
          );
          return { name: "brief", actions: 0, skipped: !committed, notes };
        }

        let outboxId = "";
        let outboxAlreadySent = false;
        state.lastRunAt = currentSec;
        const prepared = commitState(state, stateBaseline, {
          input: notifyInput,
          onEnqueued: (id, alreadySent) => {
            outboxId = id;
            outboxAlreadySent = alreadySent;
          },
        });
        if (!prepared) {
          return { name: "brief", actions: 0, skipped: true, notes };
        }
        stateBaseline = { ...state };

        const drained = await drainBriefHalfOpenOutbox(
          deps,
          halfOpenClaimGeneration,
          currentSec,
          notifyFn,
          elapsedNowFn,
          halfOpenDeadlineMs,
        );
        notifyResult = {
          attempted: drained.sentIds.has(outboxId) || outboxAlreadySent,
          sent: drained.sentIds.has(outboxId) || outboxAlreadySent,
        };
        if (drained.budgetExceeded) {
          notes.push("brief half-open claim が経過時間上限30分に達したため配送を打ち切りました");
        }
      }
      if (!notifyResult.sent) {
        const message = halfOpenDeadlineMs !== undefined && elapsedNowFn() >= halfOpenDeadlineMs
          ? "brief half-open claim が経過時間上限30分に達しました"
          : notifyResult.attempted
          ? "brief operational notify が失敗しました"
          : "brief operational notify が試行されませんでした";
        deps.logger.warn("brief: operational notify に失敗しました", {
          attempted: notifyResult.attempted,
          sent: notifyResult.sent,
        });
        notes.push(message);
        const committed = await failBriefRun(
          deps,
          state,
          stateBaseline,
          currentSec,
          failureAtSec,
          message,
          notes,
          lifecycleNotifyFn,
          commitState,
        );
        return { name: "brief", actions: 0, skipped: !committed, notes };
      }

      if (halfOpenDeadlineMs !== undefined && elapsedNowFn() >= halfOpenDeadlineMs) {
        const message = "brief half-open claim が経過時間上限30分に達しました";
        notes.push(message);
        const committed = await failBriefRun(
          deps,
          state,
          stateBaseline,
          currentSec,
          failureAtSec,
          message,
          notes,
          lifecycleNotifyFn,
          commitState,
        );
        return { name: "brief", actions: 0, skipped: !committed, notes };
      }

      state.lastRunAt = currentSec;
      state.lastError = "";
      const success = decideAutoDisableSuccess(state);
      Object.assign(state, success.nextState);
      const committed = commitState(state, stateBaseline);
      if (success.recoveredFromAutoDisabled && committed) {
        await notifyBriefLifecycle(
          deps,
          currentSec,
          "brief: half-open 再試行に成功し auto-disable から復帰しました",
          lifecycleNotifyFn,
        );
      }
      notes.push(`brief: ${dueSlots.length}時刻分を1回に集約して配信しました`);
      return { name: "brief", actions: 1, skipped: !committed, notes };
    },
  };
}

export const briefStage: Stage = createBriefStage({
  notifyFn: sendOperationalNotification,
  lifecycleNotifyFn: sendAdHocNotification,
});
