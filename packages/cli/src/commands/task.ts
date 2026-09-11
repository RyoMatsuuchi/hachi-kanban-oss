// =============================================================================
// hachi task: create / show / list / block / unblock / watch / unwatch / comment / set-cwd / edit-body サブコマンド群
// =============================================================================

import { constants as fsConstants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { Command, InvalidArgumentError, Option } from "commander";
import {
  EFFORT_LEVELS,
  EXECUTION_SPEEDS,
  PROVIDERS,
  TASK_STATUSES,
  assertRuntimeProjectOwnershipSnapshot,
  createKanbanReadView,
  isInProgressReason,
  isEffortLevel,
  isExecutionSpeed,
  listAllowlistedModels,
  matchesAwaitTenantFilter,
  newNonce,
  normalizeAwaitTenantFilter,
  normalizeAwaitOrchestratorFilter,
  openTaskAwaitCheckpointStore,
  readBoardInstanceId,
  redactCancelEvent,
  redactText,
  resolveRuntimeProjectProfile,
  resolveCommunicationRoute,
  resolveExecution,
  assertTaskBodyValid,
  serializeAgentMessage,
  sortCancelRequestsDescending,
  summarizeCancelRequest,
  TASK_AWAIT_CHECKPOINT_SCHEMA_VERSION,
  TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION,
  TASK_AWAIT_ORCHESTRATOR_CHECKPOINT_SCHEMA_VERSION,
  type KanbanReadViewCapabilities,
  type AgentMessageV1,
  type ActorProvenance,
  type CancelLifecycleSummary,
  type CommentRow,
  type CommunicationDeliveryAttemptRow,
  type CommunicationPreference,
  type CommunicationRouteDecision,
  type DirectRestartAuthorityStore,
  type DirectRestartIntentRow,
  type DurableSteerStore,
  type EffortLevel,
  type ExecutionOverridePatch,
  type ExecutionSpeed,
  type FencedRunCancelRequestStore,
  type NativeCommunicationStore,
  type NativeCommunicationSessionRef,
  type NativeCommunicationSocketSnapshot,
  type Provider,
  type ResolveCommunicationRouteInput,
  type RunCancelRequestRow,
  type RunRow,
  type RunStatus,
  type RuntimeResourceRequirementRow,
  type SessionRef,
  type SteerDeliveryRow,
  type SteerDeliveryReadModel,
  type TaskCreateInput,
  type TaskAwaitCheckpoint,
  type TaskAwaitCheckpointStore,
  type TaskRow,
  type TaskStatus,
  type WorkerAdapter,
} from "@hachi/core";
import type { CliDeps } from "../deps.js";
import { withErrorHandling } from "../errors.js";
import { emit, singularResourceEnvelope } from "../output.js";
import { formatComment, formatEvent, formatTaskLine, requireTask } from "../task-helpers.js";
import {
  addActorPrincipalOptions,
  resolveActorProvenance,
  type ActorPrincipalOptions,
} from "../actor-provenance.js";
import { runTaskLogs, type TaskLogsOptions } from "./task-logs.js";
import { formatCancelSummary } from "../cancel-observability.js";

const DEFAULT_SHOW_COMMENTS = 5;
const DEFAULT_SHOW_EVENTS = 5;
const DEFAULT_ACTOR = "human";
const ORCHESTRATOR_ACTOR = "orchestrator";
const DEFAULT_AWAIT_INTERVAL_SEC = 5;
const MIN_AWAIT_INTERVAL_SEC = 2;
const AWAIT_EVENT_SCAN_LIMIT = 200;
const DEFAULT_STEER_WAIT_POLL_SEC = 1;
const DEFAULT_CANCEL_GRACE_SEC = 60;
// §52.1 の契約値。凍結 types.ts の更新はオーケストレーター管理のため、CLI 側で明示して保存する。
const STOPPED_RUN_STATUS = "stopped" as RunStatus;
const ACCEPTABLE_RESTART_STOP_REASONS = ["terminated", "killed", "already-exited"] as const;
/** task link で --type 省略時に使う既定のリンク種別 */
const DEFAULT_LINK_TYPE = "subtask";
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const ATTACH_ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".txt", ".md", ".log"] as const;
const SAFE_ATTACHMENT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * `task list` で --limit も --all も省略された場合の既定上限（docs/contract.md §12.19-4）。
 * 大規模ボードでの誤った全件取得（意図しない大量出力）を避けるための既定値。
 */
const DEFAULT_LIST_LIMIT = 100;

/**
 * `task list --all` 指定時に listByStatus / listRecent へ渡す上限。
 * 「全件表示」を実現するための実質無制限値（Number.MAX_SAFE_INTEGER）。
 */
const LIST_RECENT_UNLIMITED = Number.MAX_SAFE_INTEGER;

/**
 * hachi task create で許可される初期 status（docs/contract.md §12.6-4）。
 * blocked/done 等、不変条件を満たさない初期状態を作らせない（fail-closed）。
 */
const CREATABLE_STATUSES: readonly TaskStatus[] = ["triage", "todo", "ready"];

function isCreatableStatus(value: string): value is TaskStatus {
  return (CREATABLE_STATUSES as readonly string[]).includes(value);
}

/**
 * --limit / --comments / --events 用の正の整数専用パーサ（docs/contract.md §12.8-6）。
 * 0・負値・小数・非数値はすべて fail-closed で InvalidArgumentError を投げる（exit 1）。
 */
function parsePositiveIntArg(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new InvalidArgumentError(`正の整数を指定してください: ${value}`);
  }
  return Number.parseInt(value, 10);
}

/**
 * --tail など、0 を「無制限」の明示値として使うオプション用の非負整数パーサ。
 */
function parseNonNegativeIntArg(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new InvalidArgumentError(`0以上の整数を指定してください: ${value}`);
  }
  return Number.parseInt(value, 10);
}

function parseCancelGraceArg(value: string): number {
  const parsed = parseNonNegativeIntArg(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(`--grace は安全な0以上の整数を指定してください: ${value}`);
  }
  return parsed;
}

function parseExpectedRunArg(value: string): number {
  const parsed = parsePositiveIntArg(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(`--expect-run は正の安全な整数を指定してください: ${value}`);
  }
  return parsed;
}

/**
 * --priority 専用の厳格パーサ（docs/contract.md §12.10-5）。
 * Number.parseInt は '1abc' → 1 のように部分数値文字列を許してしまうため、
 * 符号任意の整数の完全一致（^-?[0-9]+$）のみ受理する（fail-closed）。
 */
function parsePriorityArg(value: string): number {
  if (!/^-?[0-9]+$/.test(value)) {
    throw new InvalidArgumentError(`--priority は整数のみ指定できます: ${value}`);
  }
  return Number.parseInt(value, 10);
}

function parseAwaitIntervalArg(value: string): number {
  const parsed = parsePositiveIntArg(value);
  if (parsed < MIN_AWAIT_INTERVAL_SEC) {
    throw new InvalidArgumentError(`--interval は ${MIN_AWAIT_INTERVAL_SEC} 秒以上を指定してください: ${value}`);
  }
  return parsed;
}

function isAllowedAttachmentExtension(extension: string): boolean {
  return (ATTACH_ALLOWED_EXTENSIONS as readonly string[]).includes(extension.toLowerCase());
}

function sanitizeAttachmentName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

function validateAttachmentName(name: string): void {
  if (!SAFE_ATTACHMENT_NAME_PATTERN.test(name) || name === "." || name === "..") {
    throw new Error(`保存名は [A-Za-z0-9._-]+ のみ指定できます: ${name}`);
  }
  const extension = extname(name).toLowerCase();
  if (!isAllowedAttachmentExtension(extension)) {
    throw new Error(`保存名の拡張子が許可されていません: ${name}`);
  }
}

function resolveRequestedAttachmentName(filePath: string, requestedName?: string): string {
  const name = requestedName ?? sanitizeAttachmentName(basename(filePath));
  validateAttachmentName(name);
  return name;
}

function assertArtifactContained(artifactsDir: string, targetPath: string): void {
  const base = resolve(artifactsDir);
  const target = resolve(targetPath);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`artifact 保存先が artifactsDir 配下に収まりません: ${target}`);
  }
}

function withCollisionSuffix(name: string, suffix: number): string {
  const extension = extname(name);
  const stem = extension.length > 0 ? name.slice(0, -extension.length) : name;
  return `${stem}-${suffix}${extension}`;
}

function resolveAttachmentTarget(artifactsDir: string, taskId: string, requestedName: string): string {
  const dir = join(artifactsDir, taskId);
  assertArtifactContained(artifactsDir, dir);
  mkdirSync(dir, { recursive: true });

  for (let index = 1; index <= 10_000; index += 1) {
    const name = index === 1 ? requestedName : withCollisionSuffix(requestedName, index);
    const filePath = join(dir, name);
    assertArtifactContained(artifactsDir, filePath);
    if (!existsSync(filePath)) {
      return filePath;
    }
  }

  throw new Error(`artifact 保存名の連番が上限に達しました: ${requestedName}`);
}

function buildAttachmentCommentBody(body: string, artifactName: string): string {
  return body.length > 0 ? `${body}\n\n添付: ${artifactName}` : `添付: ${artifactName}`;
}

interface TaskCreateOptions extends ActorPrincipalOptions {
  title: string;
  body: string;
  tenant: string;
  profile?: string;
  priority?: number;
  /** commander からは未検証の生の文字列で渡ってくる（許可値は runCreate 内で検証する） */
  status?: string;
  provider?: Provider;
  model?: string;
  effort?: string;
  speed?: string;
  reviewProfile?: string;
  reviewProvider?: Provider;
  reviewModel?: string;
  reviewEffort?: string;
  reviewSpeed?: string;
  orchestrator?: string;
  bindOrchestrator?: string;
  dependsOn?: string[];
  runtimeProfile?: string[];
  json?: boolean;
}

interface TaskShowOptions {
  comments?: number;
  events?: number;
  json?: boolean;
}

interface TaskSteerListOptions {
  json?: boolean;
}

interface TaskCancelOptions extends ActorPrincipalOptions {
  reason: string;
  grace?: number;
  forceIfSupported?: boolean;
  expectRun?: number;
  expectSession?: string;
  json?: boolean;
}

interface TaskCancelStatusOptions {
  all?: boolean;
  json?: boolean;
}

interface TaskCancelHostStopOptions extends ActorPrincipalOptions {
  request: string;
  evidenceId: string;
  processGeneration: string;
  confirm?: boolean;
  json?: boolean;
}

interface TaskListOptions {
  status?: TaskStatus;
  limit?: number;
  all?: boolean;
  json?: boolean;
  /** 担当 orchestrator identity（docs/contract.md §69.3 の配送先解決で判定する） */
  orchestrator?: string;
  /** subtask リンクの親タスク ID。自身と子孫だけを返す */
  subtree?: string;
}

interface TaskAwaitOptions {
  includeOrchestrator?: string;
  all?: boolean;
  tenant?: string[];
  followNew?: boolean;
  cursorFile?: string;
  interval?: number;
  maxWait?: number;
  json?: boolean;
}

interface TaskDepsOptions {
  json?: boolean;
}

interface TaskBlockOptions extends ActorPrincipalOptions {
  reason: string;
  assignee?: string;
  json?: boolean;
}

interface TaskUnblockOptions extends ActorPrincipalOptions {
  to: TaskStatus;
  json?: boolean;
}

interface TaskWatchOptions extends ActorPrincipalOptions {
  json?: boolean;
}

interface WatchableStore {
  setWatched: CliDeps["store"]["setWatched"];
}

interface ActiveOrchestratorStore {
  assertActiveOrchestratorPrincipal(provenance: ActorProvenance): void;
}

function requireActiveOrchestratorStore(store: CliDeps["store"]): ActiveOrchestratorStore {
  const candidate = store as CliDeps["store"] & Partial<ActiveOrchestratorStore>;
  if (typeof candidate.assertActiveOrchestratorPrincipal !== "function") {
    throw new Error("store がactive orchestrator principal検証に対応していません");
  }
  return candidate as ActiveOrchestratorStore;
}

interface TaskMoveOptions extends ActorPrincipalOptions {
  to: TaskStatus;
  author?: string;
  json?: boolean;
}

interface TaskCommentOptions extends ActorPrincipalOptions {
  body: string;
  author?: string;
  json?: boolean;
}

interface TaskAttachOptions extends ActorPrincipalOptions {
  file: string;
  name?: string;
  comment?: string;
  author?: string;
  json?: boolean;
}

interface TaskSetCwdOptions extends ActorPrincipalOptions {
  json?: boolean;
}

interface TaskEditBodyOptions extends ActorPrincipalOptions {
  file: string;
  json?: boolean;
}

interface TaskSteerOptions extends ActorPrincipalOptions {
  file?: string;
  wait?: number;
  supersedes?: string;
  restart?: boolean;
  communication?: CommunicationPreference;
  json?: boolean;
}

interface TaskAnswerOptions {
  file?: string;
  json?: boolean;
}

interface TaskLinkOptions {
  type?: string;
  json?: boolean;
}

interface DependencySummary {
  id: string;
  title: string;
  status: TaskStatus;
  fulfilled: boolean;
}

interface AttachmentArtifact {
  name: string;
  path: string;
  sizeBytes: number;
}

interface TaskAttachPayload {
  taskId: string;
  artifact: AttachmentArtifact;
  comment?: CommentRow;
}

interface RunMetaForTransport {
  serverUrl: string;
  transport: string;
  model: string;
  modelDelivery: "none" | "native";
}

interface CurrentRunSummary {
  id: number;
  sessionId: string;
  provider: Provider;
  transport: string;
  startedAt: number;
  status: RunStatus;
}

interface SteerBridgePayload {
  task: TaskRow;
  message: AgentMessageV1;
  routeDecision: CommunicationRouteDecision;
  communicationAttempt?: CommunicationDeliveryAttemptRow;
  delivery: SteerDeliveryRow;
  processed: boolean;
  delivered: boolean | "unknown";
  observed: boolean | "unknown";
  acknowledged: boolean | "unknown";
}

interface SteerRestartPayload {
  task: TaskRow;
  run: RunRow;
  restartIntent: DirectRestartIntentRow;
  stop: { stopped: boolean; reason: string };
  routeDecision: CommunicationRouteDecision;
}

interface AnswerPayload {
  task: TaskRow;
  question: string;
  message: AgentMessageV1;
}

interface AwaitResult {
  id: string;
  status: TaskStatus;
  blockReason: string;
  tenant?: string;
  cancel?: CancelLifecycleSummary;
}

interface AwaitFollowArm {
  targetIds: string[];
  eventCursor: number;
}

interface AwaitFollowSnapshot {
  tasks: RawAwaitTaskState[];
  eventCursor: number;
}

interface RawAwaitTaskState {
  id: string;
  status: string;
  block_reason: string;
}

interface RawAwaitEvent {
  id: number;
  task_id: string;
  event_type: string;
  payload: string;
}

interface AwaitTaskCreatedEvent {
  kind: "created";
  status: TaskStatus;
}

interface AwaitTaskTransitionEvent {
  kind: "transition";
  from: TaskStatus;
  to: TaskStatus;
  reason: string;
}

type AwaitTaskEvent = AwaitTaskCreatedEvent | AwaitTaskTransitionEvent;

interface AwaitTaskBlockReasonEvent {
  kind: "block-reason";
  previous: string;
  reason: string;
}

interface InvalidAwaitTaskEvent {
  kind: "invalid";
}

type AwaitCheckpointTaskEvent = AwaitTaskEvent | AwaitTaskBlockReasonEvent | InvalidAwaitTaskEvent;

interface AwaitCheckpointTerminal {
  eventId: number;
  result: AwaitResult;
}

/** --follow-new 専用の read-only DB view。arm snapshot とイベントカーソルを同じ接続で扱う。 */
class AwaitFollowReadView {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.db.pragma("busy_timeout = 5000");
  }

  arm(): AwaitFollowArm {
    const read = this.db.transaction((): AwaitFollowArm => {
      const watermark = this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS event_cursor FROM task_events`).get() as
        | { event_cursor: number }
        | undefined;
      const rows = this.db
        .prepare(`SELECT id, status, block_reason FROM tasks ORDER BY id ASC`)
        .all() as RawAwaitTaskState[];
      const targetIds = rows.flatMap((row) => {
        const status = parseAwaitTaskStatus(row.status);
        if (status === null || typeof row.block_reason !== "string") {
          throw new Error(`task await の arm snapshot が不正です: ${row.id}`);
        }
        return isAwaitRunningState(status, row.block_reason) ? [row.id] : [];
      });
      const eventCursor = watermark?.event_cursor ?? 0;
      if (!Number.isSafeInteger(eventCursor) || eventCursor < 0) {
        throw new Error(`task await の event cursor が不正です: ${eventCursor}`);
      }
      return { targetIds, eventCursor };
    });
    return read();
  }

  eventsAfter(eventCursor: number): RawAwaitEvent[] {
    return this.db
      .prepare(
        `SELECT id, task_id, event_type, payload
         FROM task_events
         WHERE id > ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(eventCursor, AWAIT_EVENT_SCAN_LIMIT) as RawAwaitEvent[];
  }

  snapshot(): AwaitFollowSnapshot {
    const read = this.db.transaction((): AwaitFollowSnapshot => {
      const watermark = this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS event_cursor FROM task_events`).get() as
        | { event_cursor: number }
        | undefined;
      const tasks = this.db
        .prepare(`SELECT id, status, block_reason FROM tasks ORDER BY id ASC`)
        .all() as RawAwaitTaskState[];
      const eventCursor = watermark?.event_cursor ?? 0;
      if (!Number.isSafeInteger(eventCursor) || eventCursor < 0) {
        throw new Error(`task await の event cursor が不正です: ${eventCursor}`);
      }
      return { tasks, eventCursor };
    });
    return read();
  }

  taskEventsThrough(taskId: string, eventCursor: number): RawAwaitEvent[] {
    return this.db
      .prepare(
        `SELECT id, task_id, event_type, payload
         FROM task_events
         WHERE task_id = ? AND id <= ?
         ORDER BY id ASC`,
      )
      .all(taskId, eventCursor) as RawAwaitEvent[];
  }

  close(): void {
    this.db.close();
  }
}

/** 表示用に body の先頭 N 行を切り出す（set-cwd / edit-body 実行後の確認表示用） */
const BODY_PREVIEW_LINES = 5;

/**
 * body 内の `cwd: <path>` 行を検出する行頭パターン。dispatch.ts / review.ts の
 * `/^cwd:\s*(\S+)\s*$/m` と同じ意図だが、除去用途では中身の妥当性を問わず
 * `cwd:` で始まる行そのものを対象にする（不正な既存行も確実に置き換えるため）。
 * supervisor は別エージェントが並行編集中のため import せず、CLI 側で独立して保持する。
 */
const CWD_LINE_PREFIX_REGEX = /^cwd:.*$/;

/**
 * 既存 body から cwd: 行を取り除く。除去によって生じた先頭の空行は畳み、
 * 繰り返し set-cwd を呼んでも空行が積み重ならないようにする（冪等な整形）。
 */
function stripCwdLine(body: string): string {
  const remaining = body.split("\n").filter((line) => !CWD_LINE_PREFIX_REGEX.test(line));
  while (remaining.length > 0 && remaining[0] === "") {
    remaining.shift();
  }
  return remaining.join("\n");
}

/** 先頭に `cwd: <path>` 行 + 空行を付与した新しい body を組み立てる */
function buildBodyWithCwd(currentBody: string, cwdPath: string): string {
  const rest = stripCwdLine(currentBody);
  return rest.length > 0 ? `cwd: ${cwdPath}\n\n${rest}` : `cwd: ${cwdPath}\n`;
}

/** body の先頭5行を表示用テキストに整形する */
function formatBodyPreview(body: string): string[] {
  return ["--- body 先頭5行 ---", ...body.split("\n").slice(0, BODY_PREVIEW_LINES)];
}

/** 反復指定された --depends-on を順序維持のまま検証する。 */
function validateDependencyIds(values: readonly string[] | undefined): string[] {
  const dependencyIds = values ?? [];
  const seen = new Set<string>();
  for (const dependencyId of dependencyIds) {
    if (dependencyId.trim().length === 0) {
      throw new Error("--depends-on に空のタスク ID は指定できません");
    }
    if (seen.has(dependencyId)) {
      throw new Error(`--depends-on に同じタスク ID を重複指定できません: ${dependencyId}`);
    }
    seen.add(dependencyId);
  }
  return [...dependencyIds];
}

/** commander の反復可能 option parser。入力順を保って新しい配列へ追加する。 */
function collectDependencyId(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** singular option の重複指定も明示的に検出するため、commander では配列として収集する。 */
function collectRuntimeProfileId(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** task await --tenant の反復指定を入力順のまま収集する。 */
function collectAwaitTenant(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function validateRuntimeProfileId(values: readonly string[] | undefined): string | undefined {
  const profileIds = values ?? [];
  if (profileIds.length === 0) {
    return undefined;
  }
  if (profileIds.length !== 1) {
    throw new Error("--runtime-profile は重複指定できません");
  }
  const profileId = profileIds[0]!;
  if (profileId === "" || profileId !== profileId.trim()) {
    throw new Error("--runtime-profile は空でない exact ID が必要です");
  }
  return profileId;
}

interface RuntimeRequirementStore {
  createOrGetRuntimeResourceRequirement(input: {
    taskId: string;
    name: string;
    bundleKind: "worktree_postgres";
    spec: unknown;
    idempotencyKey: string;
  }): RuntimeResourceRequirementRow;
}

function requireRuntimeRequirementStore(deps: CliDeps): RuntimeRequirementStore {
  const candidate = deps.store as CliDeps["store"] & Partial<RuntimeRequirementStore>;
  if (typeof candidate.createOrGetRuntimeResourceRequirement !== "function") {
    throw new Error("store がruntime resource requirement永続化に対応していません");
  }
  return candidate as RuntimeRequirementStore;
}

/** hachi task create の action 本体 */
function runCreate(deps: CliDeps, options: TaskCreateOptions): void {
  assertTaskBodyValid(options.body);
  const input: TaskCreateInput = { title: options.title, body: options.body, tenant: options.tenant };
  if (options.status !== undefined) {
    if (!isCreatableStatus(options.status)) {
      throw new Error(
        `--status は triage / todo / ready のみ指定できます（不変条件を満たさない初期状態は作成できません）: ${options.status}`,
      );
    }
    input.status = options.status;
  }
  if (options.priority !== undefined) {
    input.priority = options.priority;
  }
  if (options.profile !== undefined) {
    input.profile = options.profile;
  }
  if (options.provider !== undefined) {
    input.provider = options.provider;
  }
  let effortOverride: EffortLevel | undefined;
  if (options.effort !== undefined) {
    if (!isEffortLevel(options.effort)) {
      throw new Error(`--effort は ${EFFORT_LEVELS.join(" / ")} のみ指定できます: ${options.effort}`);
    }
    effortOverride = options.effort;
  }
  let speedOverride: ExecutionSpeed | undefined;
  if (options.speed !== undefined) {
    if (!isExecutionSpeed(options.speed)) {
      throw new Error(`--speed は ${EXECUTION_SPEEDS.join(" / ")} のみ指定できます: ${options.speed}`);
    }
    speedOverride = options.speed;
  }
  let reviewEffortOverride: EffortLevel | undefined;
  if (options.reviewEffort !== undefined) {
    if (!isEffortLevel(options.reviewEffort)) {
      throw new Error(
        `--review-effort は ${EFFORT_LEVELS.join(" / ")} のみ指定できます: ${options.reviewEffort}`,
      );
    }
    reviewEffortOverride = options.reviewEffort;
  }
  let reviewSpeedOverride: ExecutionSpeed | undefined;
  if (options.reviewSpeed !== undefined) {
    if (!isExecutionSpeed(options.reviewSpeed)) {
      throw new Error(
        `--review-speed は ${EXECUTION_SPEEDS.join(" / ")} のみ指定できます: ${options.reviewSpeed}`,
      );
    }
    reviewSpeedOverride = options.reviewSpeed;
  }
  const dependencyIds = validateDependencyIds(options.dependsOn);
  const runtimeProfileId = validateRuntimeProfileId(options.runtimeProfile);

  // 既存の task create --orchestrator はprimary binding指定だったため、principal flagsを伴わない
  // 単独指定だけはlegacy bindingとして維持する。新規の明示bindingは--bind-orchestratorを使う。
  const legacyBinding = options.actorKind === undefined && options.session === undefined &&
    options.generation === undefined ? options.orchestrator : undefined;
  const provenance = legacyBinding === undefined
    ? resolveActorProvenance(options, DEFAULT_ACTOR)
    : resolveActorProvenance({}, DEFAULT_ACTOR);
  const hasExecutionSelection = options.profile !== undefined || options.provider !== undefined ||
    options.model !== undefined || options.effort !== undefined || options.speed !== undefined ||
    options.reviewProfile !== undefined || options.reviewProvider !== undefined ||
    options.reviewModel !== undefined || options.reviewEffort !== undefined || options.reviewSpeed !== undefined;
  if (hasExecutionSelection && provenance?.kind !== "orchestrator") {
    throw new Error(
      "task create のexecution指定は --actor-kind orchestrator と --orchestrator/--session/--generation が必須です",
    );
  }
  if (legacyBinding !== undefined && options.bindOrchestrator !== undefined &&
      legacyBinding !== options.bindOrchestrator) {
    throw new Error("legacy --orchestratorと--bind-orchestratorに異なるidentityは指定できません");
  }
  // execution指定が無いlegacy createでは、操作主体とrouting ownerを引き続き独立させる。
  const requestedBindingOrchestrator = options.bindOrchestrator ?? legacyBinding;
  if (
    hasExecutionSelection &&
    requestedBindingOrchestrator !== undefined &&
    requestedBindingOrchestrator !== provenance!.actorId
  ) {
    throw new Error("task create のexecution指定では--bind-orchestratorをactor orchestratorと一致させてください");
  }
  // execution override の変更権限はtask primary ownerに限定される。新規taskでは
  // structured actor自身を同じtransaction内でprimary bindしてからoverrideを保存する。
  const bindingOrchestrator = requestedBindingOrchestrator ??
    (hasExecutionSelection ? provenance!.actorId : undefined);
  let resolvedRuntimeProfile: ReturnType<typeof resolveRuntimeProjectProfile> | undefined;
  if (runtimeProfileId !== undefined) {
    if (
      provenance?.kind !== "orchestrator" ||
      bindingOrchestrator === undefined ||
      bindingOrchestrator !== provenance.actorId
    ) {
      throw new Error(
        "--runtime-profile はactive exact orchestrator principalと同一identityの--bind-orchestratorが必須です",
      );
    }
    const orchestrator = deps.store.getOrchestrator(bindingOrchestrator);
    if (orchestrator === null) {
      throw new Error(`orchestrator が見つかりません: ${bindingOrchestrator}`);
    }
    resolvedRuntimeProfile = resolveRuntimeProjectProfile({
      config: deps.config,
      profileId: runtimeProfileId,
      orchestrator,
      taskBody: options.body,
    });
  }

  let runtimeRequirement: RuntimeResourceRequirementRow | undefined;
  const task = deps.store.transaction((): TaskRow => {
    if (resolvedRuntimeProfile !== undefined) {
      requireActiveOrchestratorStore(deps.store).assertActiveOrchestratorPrincipal(provenance!);
      const currentOrchestrator = deps.store.getOrchestrator(bindingOrchestrator!);
      if (
        currentOrchestrator === null ||
        currentOrchestrator.id !== provenance!.actorId ||
        currentOrchestrator.project !== resolvedRuntimeProfile.project ||
        currentOrchestrator.repoCommonDir !== resolvedRuntimeProfile.repoCommonDir
      ) {
        throw new Error("runtime profile のprincipal/binding/project snapshotが一致しません");
      }
      assertRuntimeProjectOwnershipSnapshot({
        snapshot: resolvedRuntimeProfile.requirement.spec.ownershipSnapshot,
        orchestrator: currentOrchestrator,
        taskBody: options.body,
      });
    }
    for (const dependencyId of dependencyIds) {
      requireTask(deps, dependencyId);
    }
    let created = deps.store.createTask(input, DEFAULT_ACTOR, provenance);
    if (bindingOrchestrator !== undefined) {
      deps.store.bindTaskToOrchestrator(created.id, bindingOrchestrator, "primary");
    }
    const workerPatch: ExecutionOverridePatch = {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(effortOverride === undefined ? {} : { effort: effortOverride }),
      ...(speedOverride === undefined ? {} : { speed: speedOverride }),
    };
    if (Object.keys(workerPatch).length > 0) {
      created = deps.store.setExecutionOverrides(created.id, "worker", workerPatch, DEFAULT_ACTOR, provenance);
    }
    const reviewerPatch: ExecutionOverridePatch = {
      ...(options.reviewProfile === undefined ? {} : { profile: options.reviewProfile }),
      ...(options.reviewProvider === undefined ? {} : { provider: options.reviewProvider }),
      ...(options.reviewModel === undefined ? {} : { model: options.reviewModel }),
      ...(reviewEffortOverride === undefined ? {} : { effort: reviewEffortOverride }),
      ...(reviewSpeedOverride === undefined ? {} : { speed: reviewSpeedOverride }),
    };
    if (Object.keys(reviewerPatch).length > 0) {
      created = deps.store.setExecutionOverrides(created.id, "reviewer", reviewerPatch, DEFAULT_ACTOR, provenance);
    }
    if (resolvedRuntimeProfile !== undefined) {
      const primaryBindings = deps.store
        .listTaskOrchestratorBindings(created.id)
        .filter((binding) => binding.role === "primary");
      if (
        primaryBindings.length !== 1 ||
        primaryBindings[0]?.orchestratorId !== bindingOrchestrator
      ) {
        throw new Error("runtime profile task は単一のexact primary bindingが必須です");
      }
      runtimeRequirement = requireRuntimeRequirementStore(deps).createOrGetRuntimeResourceRequirement({
        taskId: created.id,
        name: resolvedRuntimeProfile.requirement.name,
        bundleKind: resolvedRuntimeProfile.requirement.bundleKind,
        spec: resolvedRuntimeProfile.requirement.spec,
        idempotencyKey: `${created.id}:runtime-profile:${resolvedRuntimeProfile.profileId}`,
      });
    }
    for (const dependencyId of dependencyIds) {
      linkTasks(deps, dependencyId, created.id, "depends-on");
    }
    const workerResolution = resolveExecution(created, deps.config, "worker");
    if (!workerResolution.ok) {
      throw new Error(
        `worker override 指定後の resolveExecution に失敗しました: ${workerResolution.reason} ${workerResolution.detail}`,
      );
    }
    if (Object.keys(reviewerPatch).length > 0) {
      const reviewerResolution = resolveExecution(created, deps.config, "reviewer");
      if (!reviewerResolution.ok) {
        throw new Error(
          `reviewer override 指定後の resolveExecution に失敗しました: ${reviewerResolution.reason} ${reviewerResolution.detail}`,
        );
      }
    }
    return created;
  });
  const json = options.json === true;
  const runtimeRequirementOutput = runtimeRequirement === undefined
    ? undefined
    : {
        id: runtimeRequirement.id,
        taskId: runtimeRequirement.taskId,
        name: runtimeRequirement.name,
        bundleKind: runtimeRequirement.bundleKind,
        status: runtimeRequirement.status,
        leaseId: runtimeRequirement.leaseId,
        idempotencyKey: runtimeRequirement.idempotencyKey,
        createdAt: runtimeRequirement.createdAt,
        updatedAt: runtimeRequirement.updatedAt,
      };
  emit(
    deps,
    json,
    singularResourceEnvelope(task, {
      task,
      dependencyIds,
      ...(resolvedRuntimeProfile === undefined || runtimeRequirementOutput === undefined
        ? {}
        : {
          runtimeProfile: {
            id: resolvedRuntimeProfile.profileId,
            project: resolvedRuntimeProfile.project,
            bundleKind: resolvedRuntimeProfile.requirement.bundleKind,
          },
          runtimeRequirement: runtimeRequirementOutput,
        }),
    }),
    [
      `タスクを作成しました: ${task.id} (status=${task.status})`,
      ...(runtimeRequirement === undefined
        ? []
        : [`runtime requirementを作成しました: ${runtimeRequirement.id}`]),
    ],
  );
}

/** hachi task show の action 本体 */
function runShow(deps: CliDeps, id: string, options: TaskShowOptions): void {
  const task = requireTask(deps, id);
  const commentLimit = options.comments ?? DEFAULT_SHOW_COMMENTS;
  const eventLimit = options.events ?? DEFAULT_SHOW_EVENTS;
  const comments = deps.store.listComments(id, commentLimit);
  const events = deps.store.listEvents(id, undefined, eventLimit).map(redactCancelEvent);
  const cancelRequests = sortCancelRequestsDescending(deps.store.listRunCancelRequests(id)).map(summarizeCancelRequest);
  const steerDeliveries = readSteerDeliveries(deps, id);
  const currentRun = summarizeCurrentRun(deps.store.getLatestOpenRun(id));
  const json = options.json === true;

  const textLines: string[] = [
    formatTaskLine(task),
    ...(currentRun === null ? [] : [formatCurrentRun(currentRun)]),
    `body: ${task.body}`,
    "",
    "=== comments ===",
  ];
  if (comments.length === 0) {
    textLines.push("(コメントはありません)");
  } else {
    textLines.push(...comments.map(formatComment));
  }
  textLines.push("", "=== events ===");
  if (events.length === 0) {
    textLines.push("(イベントはありません)");
  } else {
    textLines.push(...events.map(formatEvent));
  }

  textLines.push("", "=== cancel requests ===");
  if (cancelRequests.length === 0) {
    textLines.push("(cancel request はありません)");
  } else {
    textLines.push(...cancelRequests.map(formatCancelSummary));
  }

  textLines.push("", "=== steer deliveries ===");
  if (steerDeliveries.length === 0) {
    textLines.push("(steer delivery はありません)");
  } else {
    textLines.push(...steerDeliveries.map(formatSteerDelivery));
  }

  emit(
    deps,
    json,
    singularResourceEnvelope(task, { task, comments, events, cancelRequests, steerDeliveries, currentRun }),
    textLines,
  );
}

function summarizeCurrentRun(run: RunRow | null): CurrentRunSummary | null {
  if (run === null) {
    return null;
  }
  return {
    id: run.id,
    sessionId: run.sessionId,
    provider: run.provider,
    transport: parseRunMetaForTransport(run.meta).transport,
    startedAt: run.startedAt,
    status: run.status,
  };
}

function formatCurrentRun(run: CurrentRunSummary): string {
  return [
    "currentRun:",
    `id=${run.id}`,
    `sessionId=${run.sessionId}`,
    `provider=${run.provider}`,
    `transport=${run.transport}`,
    `startedAt=${run.startedAt}`,
    `status=${run.status}`,
  ].join(" ");
}

function readSteerDeliveries(deps: CliDeps, taskId: string): SteerDeliveryReadModel[] {
  const view = createKanbanReadView(deps.env.dbPath);
  try {
    return view.steerDeliveries(taskId);
  } finally {
    view.close();
  }
}

function formatOptionalEpoch(value: number | null): string {
  return value === null ? "-" : String(value);
}

function formatSteerDelivery(delivery: SteerDeliveryReadModel): string {
  return [
    `id=${delivery.id}`,
    `key=${delivery.messageKey}`,
    `sequence=${delivery.sequence}`,
    `status=${delivery.status}`,
    `target=${delivery.targetState}`,
    `run=${delivery.runId}`,
    `session=${delivery.sessionId}`,
    `fence=${delivery.expectedCancelFence}/${delivery.runCancelFence}`,
    `currentRun=${delivery.currentRunId ?? "-"}`,
    `currentSession=${delivery.currentSessionId ?? "-"}`,
    `supersedes=${delivery.supersedesId ?? "-"}`,
    `message=${delivery.observedMessageId || "-"}`,
    `created=${delivery.createdAt}`,
    `updated=${delivery.updatedAt}`,
    `observed=${formatOptionalEpoch(delivery.observedAt)}`,
    `acknowledged=${formatOptionalEpoch(delivery.acknowledgedAt)}`,
    `resolved=${formatOptionalEpoch(delivery.resolvedAt)}`,
    `lastError=${delivery.lastError || "-"}`,
  ].join(" ");
}

function runSteerList(deps: CliDeps, id: string, options: TaskSteerListOptions): void {
  requireTask(deps, id);
  const steerDeliveries = readSteerDeliveries(deps, id);
  const lines = steerDeliveries.length === 0
    ? ["(steer delivery はありません)"]
    : steerDeliveries.map(formatSteerDelivery);
  emit(deps, options.json === true, { taskId: id, steerDeliveries }, lines);
}

function latestCancelRequest(deps: CliDeps, taskId: string): RunCancelRequestRow | null {
  return sortCancelRequestsDescending(deps.store.listRunCancelRequests(taskId))[0] ?? null;
}

function requireCancelOrchestrator(options: TaskCancelOptions): {
  orchestratorId: string;
  requesterSessionId: string;
  requesterGeneration: number;
} {
  const provenance = resolveActorProvenance(options, ORCHESTRATOR_ACTOR);
  if (provenance?.kind !== "orchestrator" || provenance.actorGeneration === null) {
    throw new Error(
      "task cancel は --actor-kind orchestrator と --orchestrator/--session/--generation を必要とします",
    );
  }
  return {
    orchestratorId: provenance.actorId,
    requesterSessionId: provenance.actorSessionId,
    requesterGeneration: provenance.actorGeneration,
  };
}

function requireFencedRunCancelStore(store: CliDeps["store"]): FencedRunCancelRequestStore {
  const candidate = store as CliDeps["store"] & Partial<FencedRunCancelRequestStore>;
  if (typeof candidate.createOrGetFencedRunCancelRequest !== "function") {
    throw new Error("store が fenced cancel に対応していません");
  }
  return candidate as FencedRunCancelRequestStore;
}

function runCancel(deps: CliDeps, id: string, options: TaskCancelOptions): void {
  const task = requireTask(deps, id);
  const reason = options.reason.trim();
  if (reason.length === 0) {
    throw new Error("--reason は空にできません");
  }
  const requester = requireCancelOrchestrator(options);
  const now = Math.floor(Date.now() / 1000);
  const grace = options.grace ?? (options.forceIfSupported === true ? 0 : DEFAULT_CANCEL_GRACE_SEC);
  const expectedSessionId = options.expectSession?.trim();
  if (options.expectSession !== undefined && expectedSessionId === "") {
    throw new Error("--expect-session は空にできません");
  }
  const hasExpectedTarget = options.expectRun !== undefined || expectedSessionId !== undefined;
  let request: RunCancelRequestRow;
  if (hasExpectedTarget) {
    const result = requireFencedRunCancelStore(deps.store).createOrGetFencedRunCancelRequest({
      taskId: task.id,
      ...(options.expectRun === undefined ? {} : { expectedRunId: options.expectRun }),
      ...(expectedSessionId === undefined ? {} : { expectedSessionId }),
      requestNonce: newNonce(),
      actor: ORCHESTRATOR_ACTOR,
      reason: redactText(reason),
      orchestratorId: requester.orchestratorId,
      requesterSessionId: requester.requesterSessionId,
      requesterGeneration: requester.requesterGeneration,
      deadlineAt: now + grace,
    });
    if (result.targetMatched === "no") {
      emit(
        deps,
        options.json === true,
        singularResourceEnvelope(task, {
          task,
          cancel: null,
          created: false,
          targetMatched: "no",
          expectedRunId: options.expectRun ?? null,
          expectedSessionId: expectedSessionId ?? null,
        }),
        [
          "cancel request は作成されませんでした: expected target matched=no",
          `expected run=${options.expectRun ?? "-"} session=${expectedSessionId ?? "-"}`,
        ],
      );
      deps.exit(1);
      return;
    }
    request = result.request;
  } else {
    const run = deps.store.getLatestOpenRun(task.id);
    if (run === null) {
      throw new Error("open run が無いため cancel request を作成できません");
    }
    request = deps.store.createOrGetRunCancelRequest({
      taskId: task.id,
      runId: run.id,
      sessionId: run.sessionId,
      provider: run.provider,
      requestNonce: newNonce(),
      actor: ORCHESTRATOR_ACTOR,
      reason: redactText(reason),
      orchestratorId: requester.orchestratorId,
      requesterSessionId: requester.requesterSessionId,
      requesterGeneration: requester.requesterGeneration,
      deadlineAt: now + grace,
    });
  }
  const cancel = summarizeCancelRequest(request);
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(task, {
      task,
      cancel,
      created: true,
      ...(hasExpectedTarget ? { targetMatched: "yes" } : {}),
      forceIfSupported: options.forceIfSupported === true,
    }),
    [
      `cancel request を作成しました: ${formatCancelSummary(cancel)}`,
      options.forceIfSupported === true
        ? "exact-session stop capability が無い場合は停止を推測せず pending/escalation になります"
        : `cooperative grace=${grace}s（期限後も exact-session capability がある場合だけ force）`,
    ],
  );
}

function runCancelStatus(deps: CliDeps, id: string, options: TaskCancelStatusOptions): void {
  requireTask(deps, id);
  const all = sortCancelRequestsDescending(deps.store.listRunCancelRequests(id));
  const selected = options.all === true ? all : all.slice(0, 1);
  const cancelRequests = selected.map(summarizeCancelRequest);
  const lines = cancelRequests.length === 0
    ? ["(cancel request はありません)"]
    : cancelRequests.map(formatCancelSummary);
  emit(deps, options.json === true, { taskId: id, cancelRequests }, lines);
}

const HOST_STOP_ACTIVE_CANCEL_STATUSES = new Set<RunCancelRequestRow["status"]>([
  "cancel_requested",
  "cooperative_sent",
  "acknowledged",
  "forcing",
]);

const HOST_STOP_ID_PATTERN = /^[A-Za-z0-9._:+@/-]+$/;
const HOST_STOP_SENSITIVE_PATTERN = /(?:authorization|bearer|credential|secret|token)/i;

function requireHostStopText(value: string, option: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${option} は空にできません`);
  }
  if (normalized.length > 256) {
    throw new Error(`${option} は256文字以内で指定してください`);
  }
  if (
    !HOST_STOP_ID_PATTERN.test(normalized) || HOST_STOP_SENSITIVE_PATTERN.test(normalized) ||
    redactText(normalized) !== normalized
  ) {
    throw new Error(`${option} は非秘密の安全なASCII識別子で指定してください`);
  }
  return normalized;
}

function canonicalBridgeServerUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username !== "" || parsed.password !== "") {
      return null;
    }
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function conflictsWithHostStoppedBridge(candidate: RunRow, targetRunId: number, serverUrl: string): boolean {
  if (candidate.id === targetRunId) {
    return false;
  }
  const meta = parseRunMetaForTransport(candidate.meta);
  if (meta.transport === "direct" && meta.serverUrl === "direct") {
    return false;
  }
  if (meta.transport !== "bridge") {
    return true;
  }
  const candidateUrl = canonicalBridgeServerUrl(meta.serverUrl);
  return candidateUrl === null || candidateUrl === serverUrl;
}

/**
 * exact-session stop transport が無い bridge を process generation ごと停止した後の host recovery。
 * このコマンド自体は process を停止せず、同一 bridge に他の open run が無いことを確認して
 * fenced cancel/run を構造化証拠付きで収束させる（通常の cancel force の代替には使わない）。
 */
function runCancelHostStop(deps: CliDeps, id: string, options: TaskCancelHostStopOptions): void {
  const task = requireTask(deps, id);
  const provenance = resolveActorProvenance(options, ORCHESTRATOR_ACTOR);
  if (provenance?.kind !== "orchestrator" || provenance.actorGeneration === null) {
    throw new Error(
      "cancel-host-stop は --actor-kind orchestrator と --orchestrator/--session/--generation を必要とします",
    );
  }
  const authorityStore = requireActiveOrchestratorStore(deps.store);
  authorityStore.assertActiveOrchestratorPrincipal(provenance);

  if (task.status !== "blocked" || !isInProgressReason(task.blockReason)) {
    throw new Error("cancel-host-stop は blocked in-progress タスクにのみ使用できます");
  }

  const requestId = requireHostStopText(options.request, "--request");
  const evidenceId = requireHostStopText(options.evidenceId, "--evidence-id");
  const processGeneration = requireHostStopText(options.processGeneration, "--process-generation");
  const request = deps.store.getRunCancelRequest(requestId);
  if (request === null || request.taskId !== task.id) {
    throw new Error("--request が対象タスクの cancel request と一致しません");
  }
  if (!HOST_STOP_ACTIVE_CANCEL_STATUSES.has(request.status)) {
    throw new Error(`cancel request はactiveではありません（status=${request.status}）`);
  }
  const activeRequest = deps.store.getActiveRunCancelRequestByTask(task.id);
  if (activeRequest?.id !== request.id) {
    throw new Error("--request がcurrent active cancel requestではありません");
  }
  if (request.orchestratorId.length === 0 || request.orchestratorId !== provenance.actorId) {
    throw new Error("cancel requestを要求したstable orchestrator identityと一致しません");
  }

  const run = deps.store.getLatestOpenRun(task.id);
  if (
    run === null || run.id !== request.runId || run.sessionId !== request.sessionId || run.provider !== request.provider
  ) {
    throw new Error("cancel request とcurrent open run/session/providerが一致しません");
  }
  const meta = parseRunMetaForTransport(run.meta);
  const canonicalServerUrl = canonicalBridgeServerUrl(meta.serverUrl);
  if (meta.transport !== "bridge" || canonicalServerUrl === null) {
    throw new Error("cancel-host-stop はserverUrlを持つbridge run限定です");
  }

  const competingRuns = deps.store.listOpenRuns().filter((candidate) =>
    conflictsWithHostStoppedBridge(candidate, run.id, canonicalServerUrl));
  if (competingRuns.length > 0) {
    throw new Error(
      `同一bridgeに他のopen runがあるためhost stopを証明できません（runIds=${competingRuns.map((row) => row.id).join(",")}）`,
    );
  }

  const stopEvidence = {
    source: "host-process-generation",
    evidenceId,
    processGeneration,
    serverUrl: canonicalServerUrl,
    provider: run.provider,
    sessionId: run.sessionId,
    runId: run.id,
    cancelFence: request.cancelFence,
    childProcessTreeCovered: true,
    attestedBy: {
      orchestratorId: provenance.actorId,
      sessionId: provenance.actorSessionId,
      generation: provenance.actorGeneration,
    },
  };

  if (options.confirm !== true) {
    emit(
      deps,
      options.json === true,
      singularResourceEnvelope(task, {
        taskId: task.id,
        requestId: request.id,
        runId: run.id,
        dryRun: true,
        stopEvidence,
      }),
      [
        `dry-run: host process-generation stopのfence検証に成功しました task=${task.id} request=${request.id}`,
        `run=${run.id} session=${run.sessionId} provider=${run.provider} fence=${request.cancelFence} ` +
        `server=${canonicalServerUrl} processGeneration=${processGeneration} evidenceId=${evidenceId}`,
        "mutationするには --confirm を付けて再実行してください",
      ],
    );
    return;
  }

  let stoppedRequest: RunCancelRequestRow | null = null;
  let updatedTask: TaskRow | null = null;
  deps.store.transaction((): void => {
    authorityStore.assertActiveOrchestratorPrincipal(provenance);
    const currentTask = deps.store.getTask(task.id);
    const currentRequest = deps.store.getRunCancelRequest(request.id);
    const currentRun = deps.store.getLatestOpenRun(task.id);
    const currentActive = deps.store.getActiveRunCancelRequestByTask(task.id);
    if (
      currentTask?.status !== "blocked" || !isInProgressReason(currentTask.blockReason) ||
      currentRequest === null || !HOST_STOP_ACTIVE_CANCEL_STATUSES.has(currentRequest.status) ||
      currentActive?.id !== currentRequest.id || currentRun === null || currentRun.id !== currentRequest.runId ||
      currentRun.sessionId !== currentRequest.sessionId || currentRun.provider !== currentRequest.provider ||
      currentRequest.cancelFence !== request.cancelFence || currentRequest.orchestratorId !== provenance.actorId
    ) {
      throw new Error("cancel-host-stop のtransaction内fence再検証に失敗しました");
    }
    const currentMeta = parseRunMetaForTransport(currentRun.meta);
    const currentServerUrl = canonicalBridgeServerUrl(currentMeta.serverUrl);
    const hasCompetingRun = deps.store.listOpenRuns().some((candidate) =>
      conflictsWithHostStoppedBridge(candidate, currentRun.id, canonicalServerUrl));
    if (currentMeta.transport !== "bridge" || currentServerUrl !== canonicalServerUrl || hasCompetingRun) {
      throw new Error("cancel-host-stop のbridge process-generation再検証に失敗しました");
    }

    stoppedRequest = deps.store.transitionRunCancelRequest({
      requestId: currentRequest.id,
      expectedStatus: currentRequest.status,
      to: "stopped",
      expectedRunId: currentRequest.runId,
      expectedSessionId: currentRequest.sessionId,
      expectedCancelFence: currentRequest.cancelFence,
      requestNonce: currentRequest.requestNonce,
      actor: "orchestrator:host-process-generation-stop",
      stopEvidence,
    });
    deps.store.endRun(currentRun.id, "failed", {
      ...parseRunMetaRecord(currentRun.meta),
      cancelRecovery: {
        cancelRequestId: currentRequest.id,
        cancelFence: currentRequest.cancelFence,
        stopEvidence,
      },
    });
    updatedTask = deps.store.updateBlockReason(
      task.id,
      `needs-manual: cancel stopped (${redactText(currentRequest.reason)})`,
      ORCHESTRATOR_ACTOR,
      "human",
      provenance,
    );
    deps.store.addEvent(
      task.id,
      "cancel_host_stop_attested",
      ORCHESTRATOR_ACTOR,
      { requestId: currentRequest.id, runId: currentRun.id, sessionId: currentRun.sessionId, stopEvidence },
      provenance,
    );
  });

  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(updatedTask!, {
      task: updatedTask,
      cancel: summarizeCancelRequest(stoppedRequest!),
      runId: run.id,
      dryRun: false,
      stopEvidence,
    }),
    [`host process-generation stopを記録しました: task=${task.id} request=${request.id} run=${run.id}`],
  );
}

/**
 * task list の実効 limit を決定する（docs/contract.md §12.19-4）。
 * --all 指定時は実質無制限、それ以外は --limit（省略時は既定 100 件）を使う。
 */
function resolveListLimit(options: TaskListOptions): number {
  if (options.all === true) {
    return LIST_RECENT_UNLIMITED;
  }
  return options.limit ?? DEFAULT_LIST_LIMIT;
}

/** hachi task list の action 本体 */
function runList(deps: CliDeps, options: TaskListOptions): void {
  const limit = resolveListLimit(options);
  const scoped = options.orchestrator !== undefined || options.subtree !== undefined;
  // --status 無指定時は全 status を個別走査せず listRecent（updated_at 降順）を使う（docs/contract.md §12.12-4）
  // --orchestrator / --subtree 指定時は core 側で絞り込んでから limit を掛ける（先に limit を掛けると取りこぼす）
  const tasks = scoped
    ? deps.store.listScopedTasks({
        limit,
        ...(options.orchestrator !== undefined ? { orchestratorId: options.orchestrator } : {}),
        ...(options.subtree !== undefined ? { subtreeRootId: options.subtree } : {}),
        ...(options.status !== undefined ? { status: options.status } : {}),
      })
    : options.status !== undefined
      ? deps.store.listByStatus(options.status, limit)
      : deps.store.listRecent(limit);
  const json = options.json === true;

  const textLines =
    tasks.length === 0 ? ["(該当するタスクはありません)"] : tasks.map(formatTaskLine);

  emit(deps, json, { tasks }, textLines);
}

function isAwaitRunning(task: TaskRow): boolean {
  return isAwaitRunningState(task.status, task.blockReason);
}

function isAwaitRunningState(status: TaskStatus, blockReason: string): boolean {
  return status === "ready" || status === "review" || (status === "blocked" && isInProgressReason(blockReason));
}

function wasAwaitRunningTransitionSource(status: TaskStatus, wasTarget: boolean): boolean {
  return wasTarget && (status === "ready" || status === "review" || status === "blocked");
}

function parseAwaitTaskStatus(value: unknown): TaskStatus | null {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)
    ? value as TaskStatus
    : null;
}

function parseAwaitTaskEvent(row: RawAwaitEvent): AwaitTaskEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const payload = parsed as Record<string, unknown>;
  if (row.event_type === "task_created") {
    const status = parseAwaitTaskStatus(payload["status"]);
    return status === null ? null : { kind: "created", status };
  }

  const from = parseAwaitTaskStatus(payload["from"]);
  const to = parseAwaitTaskStatus(payload["to"]);
  if (from === null || to === null) {
    return null;
  }
  return {
    kind: "transition",
    from,
    to,
    reason: typeof payload["reason"] === "string" ? payload["reason"] : "",
  };
}

function parseAwaitCheckpointTaskEvent(row: RawAwaitEvent): AwaitCheckpointTaskEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload) as unknown;
  } catch {
    return ["task_created", "status_changed", "block_reason_updated"].includes(row.event_type)
      ? { kind: "invalid" }
      : null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return ["task_created", "status_changed", "block_reason_updated"].includes(row.event_type)
      ? { kind: "invalid" }
      : null;
  }
  const payload = parsed as Record<string, unknown>;
  if (row.event_type === "task_created") {
    const status = parseAwaitTaskStatus(payload["status"]);
    return status === null ? { kind: "invalid" } : { kind: "created", status };
  }
  if (row.event_type === "block_reason_updated") {
    const previous = payload["previous"];
    const reason = payload["reason"];
    return typeof previous === "string" && typeof reason === "string"
      ? { kind: "block-reason", previous, reason }
      : { kind: "invalid" };
  }

  const from = parseAwaitTaskStatus(payload["from"]);
  const to = parseAwaitTaskStatus(payload["to"]);
  if (from === null || to === null) {
    return row.event_type === "status_changed" ? { kind: "invalid" } : null;
  }
  return {
    kind: "transition",
    from,
    to,
    reason: typeof payload["reason"] === "string" ? payload["reason"] : "",
  };
}

function toAwaitResult(task: TaskRow, cancel?: RunCancelRequestRow | null): AwaitResult {
  const result: AwaitResult = { id: task.id, status: task.status, blockReason: task.blockReason };
  if (cancel !== undefined && cancel !== null) {
    result.cancel = summarizeCancelRequest(cancel);
  }
  return result;
}

interface AwaitFilter {
  tenants: readonly string[] | undefined;
  orchestratorId: string | undefined;
  scopeView: KanbanReadViewCapabilities | undefined;
}

/** 担当指定時はtenant未指定を全件一致にせず、現在の正本scopeを毎回評価する。 */
function matchesAwaitFilter(task: TaskRow, filter: AwaitFilter): boolean {
  if (filter.orchestratorId === undefined) {
    return matchesAwaitTenantFilter(task.tenant, filter.tenants);
  }
  if (filter.scopeView === undefined) {
    throw new Error("task await の担当scope接続がありません");
  }
  const scoped = filter.scopeView.isOrchestratorScopedToTask(filter.orchestratorId, task.id);
  return scoped || (filter.tenants !== undefined && matchesAwaitTenantFilter(task.tenant, filter.tenants));
}

function awaitResultForFilter(
  task: TaskRow,
  result: AwaitResult,
  filter: AwaitFilter,
): AwaitResult | null {
  if (!matchesAwaitFilter(task, filter)) {
    return null;
  }
  return filter.tenants === undefined && filter.orchestratorId === undefined
    ? result
    : { ...result, tenant: task.tenant };
}

function uniqueTasks(tasks: TaskRow[]): TaskRow[] {
  const seen = new Set<string>();
  const result: TaskRow[] = [];
  for (const task of tasks) {
    if (seen.has(task.id)) {
      continue;
    }
    seen.add(task.id);
    result.push(task);
  }
  return result;
}

function assertAwaitTargetSelection(ids: string[], options: TaskAwaitOptions): void {
  const all = options.all === true;
  if (options.cursorFile !== undefined && (!all || options.followNew !== true || ids.length > 0)) {
    throw new Error("task await --cursor-file は --all --follow-new とだけ併用できます");
  }
  if (options.cursorFile !== undefined && options.json !== true) {
    throw new Error("task await --cursor-file は --json が必須です");
  }
  if (all && ids.length > 0) {
    throw new Error("task await は id 指定と --all を同時には使えません");
  }
  if (options.includeOrchestrator !== undefined && (!all || ids.length > 0)) {
    throw new Error("task await --include-orchestrator は --all とだけ併用できます");
  }
  if (options.tenant !== undefined && (!all || ids.length > 0)) {
    throw new Error("task await --tenant は --all とだけ併用できます");
  }
  if (options.followNew === true && !all) {
    throw new Error("task await --follow-new は --all とだけ併用できます");
  }
  if (!all && ids.length === 0) {
    throw new Error("task await は id または --all のどちらかを指定してください");
  }
}

function resolveAwaitInitialTargets(deps: CliDeps, ids: string[], options: TaskAwaitOptions): TaskRow[] {
  assertAwaitTargetSelection(ids, options);
  const all = options.all === true;

  if (all) {
    return uniqueTasks([
      ...deps.store.listByStatus("ready", LIST_RECENT_UNLIMITED),
      ...deps.store.listByStatus("review", LIST_RECENT_UNLIMITED),
      ...deps.store.listInProgress(),
    ]);
  }

  return ids.map((id) => requireTask(deps, id));
}

function currentAwaitTerminalTasks(
  deps: CliDeps,
  targetIds: Set<string>,
  filter: AwaitFilter,
  dropMismatchedRunning: boolean,
): AwaitResult[] {
  const results: AwaitResult[] = [];
  for (const id of [...targetIds]) {
    const task = requireTask(deps, id);
    const matchesTenant = matchesAwaitFilter(task, filter);
    if (isAwaitRunning(task)) {
      if (!matchesTenant && dropMismatchedRunning) {
        targetIds.delete(id);
      }
      continue;
    }
    targetIds.delete(id);
    if (matchesTenant) {
      const cancel = latestCancelRequest(deps, id);
      const result = awaitResultForFilter(task, toAwaitResult(task, cancel), filter);
      if (result !== null) {
        results.push(result);
      }
    }
  }
  return results;
}

function emitAwaitResults(deps: CliDeps, json: boolean, results: AwaitResult[]): void {
  if (json) {
    for (const result of results) {
      deps.stdout.write(`${JSON.stringify(result)}\n`);
    }
    return;
  }
  for (const result of results) {
    deps.stdout.write(`${result.id} [${result.status}] blockReason=${result.blockReason}\n`);
    if (result.cancel !== undefined) {
      deps.stdout.write(`${formatCancelSummary(result.cancel)}\n`);
    }
  }
}

function awaitResultFromTransition(
  deps: CliDeps,
  taskId: string,
  transition: AwaitTaskTransitionEvent,
): AwaitResult {
  const result: AwaitResult = {
    id: taskId,
    status: transition.to,
    blockReason: transition.to === "blocked" ? transition.reason : "",
  };
  const cancel = latestCancelRequest(deps, taskId);
  if (cancel !== null) {
    result.cancel = summarizeCancelRequest(cancel);
  }
  return result;
}

function awaitResultFromState(
  deps: CliDeps,
  taskId: string,
  status: TaskStatus,
  blockReason: string,
): AwaitResult {
  const result: AwaitResult = { id: taskId, status, blockReason };
  const cancel = latestCancelRequest(deps, taskId);
  if (cancel !== null) {
    result.cancel = summarizeCancelRequest(cancel);
  }
  return result;
}

function consumeAwaitFollowEvents(
  deps: CliDeps,
  targetIds: Set<string>,
  rows: readonly RawAwaitEvent[],
  filter: AwaitFilter,
): AwaitResult[] {
  const results: AwaitResult[] = [];
  const terminalIds = new Set<string>();
  for (const row of rows) {
    const event = parseAwaitTaskEvent(row);
    if (event === null) {
      continue;
    }
    if (event.kind === "created") {
      if (isAwaitRunningState(event.status, "")) {
        targetIds.add(row.task_id);
      }
      continue;
    }

    const wasTarget = targetIds.has(row.task_id);
    if (isAwaitRunningState(event.to, event.reason)) {
      targetIds.add(row.task_id);
      continue;
    }
    targetIds.delete(row.task_id);
    if (wasTarget && !terminalIds.has(row.task_id)) {
      terminalIds.add(row.task_id);
      const task = requireTask(deps, row.task_id);
      const result = awaitResultForFilter(
        task,
        awaitResultFromTransition(deps, row.task_id, event),
        filter,
      );
      if (result !== null) {
        results.push(result);
      }
    }
  }
  return results;
}

function consumeAwaitCheckpointEvents(
  deps: CliDeps,
  targetIds: Set<string>,
  rows: readonly RawAwaitEvent[],
): Map<string, AwaitCheckpointTerminal> {
  const terminals = new Map<string, AwaitCheckpointTerminal>();
  for (const row of rows) {
    const event = parseAwaitCheckpointTaskEvent(row);
    if (event === null) {
      continue;
    }
    if (event.kind === "invalid") {
      throw new Error(`task await が終端イベントを解釈できません: task=${row.task_id} event=${row.id}`);
    }
    if (event.kind === "created") {
      if (isAwaitRunningState(event.status, "")) {
        targetIds.add(row.task_id);
      } else {
        targetIds.delete(row.task_id);
      }
      continue;
    }

    const wasTarget = targetIds.has(row.task_id);
    if (event.kind === "block-reason") {
      const remainsRunning = isAwaitRunningState("blocked", event.reason);
      if (remainsRunning) {
        targetIds.add(row.task_id);
        continue;
      }
      targetIds.delete(row.task_id);
      if (wasTarget && isAwaitRunningState("blocked", event.previous)) {
        terminals.set(row.task_id, {
          eventId: row.id,
          result: awaitResultFromState(deps, row.task_id, "blocked", event.reason),
        });
      }
      continue;
    }

    if (isAwaitRunningState(event.to, event.reason)) {
      targetIds.add(row.task_id);
      continue;
    }
    targetIds.delete(row.task_id);
    if (wasAwaitRunningTransitionSource(event.from, wasTarget)) {
      terminals.set(row.task_id, {
        eventId: row.id,
        result: awaitResultFromTransition(deps, row.task_id, event),
      });
    }
  }
  return terminals;
}

interface ReconstructedAwaitTaskState {
  status: TaskStatus;
  blockReason: string;
}

interface ReconstructedAwaitTask {
  state: ReconstructedAwaitTaskState;
  lastTerminalEventId: number | null;
}

function reconstructAwaitTask(
  taskId: string,
  rows: readonly RawAwaitEvent[],
): ReconstructedAwaitTask {
  let state: ReconstructedAwaitTaskState | null = null;
  let lastTerminalEventId: number | null = null;
  for (const row of rows) {
    const event = parseAwaitCheckpointTaskEvent(row);
    if (event === null) {
      continue;
    }
    if (event.kind === "invalid") {
      throw new Error(`task await が終端イベントを解釈できません: task=${taskId} event=${row.id}`);
    }
    if (event.kind === "created") {
      if (state !== null) {
        throw new Error(`task await の task_created が重複しています: task=${taskId} event=${row.id}`);
      }
      state = { status: event.status, blockReason: "" };
      continue;
    }
    if (state === null) {
      throw new Error(`task await の task_created が見つかりません: task=${taskId}`);
    }

    const before = state;
    let after: ReconstructedAwaitTaskState;
    if (event.kind === "block-reason") {
      if (before.status !== "blocked" || before.blockReason !== event.previous) {
        throw new Error(`task await の block_reason 履歴が連続していません: task=${taskId} event=${row.id}`);
      }
      after = { status: "blocked", blockReason: event.reason };
    } else {
      if (before.status !== event.from) {
        throw new Error(`task await の status 履歴が連続していません: task=${taskId} event=${row.id}`);
      }
      after = {
        status: event.to,
        blockReason: event.to === "blocked" ? event.reason : "",
      };
    }
    if (
      isAwaitRunningState(before.status, before.blockReason) &&
      !isAwaitRunningState(after.status, after.blockReason)
    ) {
      lastTerminalEventId = row.id;
    }
    state = after;
  }
  if (state === null) {
    throw new Error(`task await の task_created が見つかりません: task=${taskId}`);
  }
  return { state, lastTerminalEventId };
}

function reconcileAwaitCheckpointSnapshot(
  deps: CliDeps,
  view: AwaitFollowReadView,
  snapshot: AwaitFollowSnapshot,
  targetIds: Set<string>,
  terminals: Map<string, AwaitCheckpointTerminal>,
): void {
  const rowsById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  for (const row of snapshot.tasks) {
    const status = parseAwaitTaskStatus(row.status);
    if (status === null || typeof row.block_reason !== "string") {
      throw new Error(`task await の snapshot が不正です: ${row.id}`);
    }
    if (isAwaitRunningState(status, row.block_reason)) {
      targetIds.add(row.id);
    }
  }

  for (const taskId of [...targetIds]) {
    const row = rowsById.get(taskId);
    if (row === undefined) {
      throw new Error(`task await の snapshot に対象タスクがありません: ${taskId}`);
    }
    const status = parseAwaitTaskStatus(row.status);
    if (status === null || typeof row.block_reason !== "string") {
      throw new Error(`task await の snapshot が不正です: ${taskId}`);
    }
    if (isAwaitRunningState(status, row.block_reason)) {
      continue;
    }

    const reconstructed = reconstructAwaitTask(
      taskId,
      view.taskEventsThrough(taskId, snapshot.eventCursor),
    );
    if (
      reconstructed.state.status !== status ||
      reconstructed.state.blockReason !== row.block_reason ||
      reconstructed.lastTerminalEventId === null
    ) {
      throw new Error(`task await の終端イベントを一意に解決できません: ${taskId}`);
    }
    targetIds.delete(taskId);
    terminals.set(taskId, {
      eventId: reconstructed.lastTerminalEventId,
      result: awaitResultFromState(deps, taskId, status, row.block_reason),
    });
  }
}

function sortedAwaitTargetIds(targetIds: ReadonlySet<string>): string[] {
  return [...targetIds].sort((left, right) => left.localeCompare(right));
}

function awaitCheckpointValue(
  boardInstanceId: string,
  eventCursor: number,
  targetIds: ReadonlySet<string>,
  filter: AwaitFilter,
): TaskAwaitCheckpoint {
  const { tenants, orchestratorId } = filter;
  const sortedTargetIds = sortedAwaitTargetIds(targetIds);
  if (orchestratorId !== undefined) {
    return {
      schemaVersion: TASK_AWAIT_ORCHESTRATOR_CHECKPOINT_SCHEMA_VERSION,
      boardInstanceId,
      eventCursor,
      targetIds: sortedTargetIds,
      tenants: [...(tenants ?? [])],
      orchestratorId,
      filterRevision: 1,
    };
  }
  return tenants === undefined
    ? {
        schemaVersion: TASK_AWAIT_CHECKPOINT_SCHEMA_VERSION,
        boardInstanceId,
        eventCursor,
        targetIds: sortedTargetIds,
      }
    : {
        schemaVersion: TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION,
        boardInstanceId,
        eventCursor,
        targetIds: sortedTargetIds,
        tenants: [...tenants],
        filterRevision: 1,
      };
}

function filterAwaitCheckpointTerminals(
  deps: CliDeps,
  terminals: ReadonlyMap<string, AwaitCheckpointTerminal>,
  filter: AwaitFilter,
): Map<string, AwaitCheckpointTerminal> {
  if (filter.tenants === undefined && filter.orchestratorId === undefined) {
    return new Map(terminals);
  }
  const filtered = new Map<string, AwaitCheckpointTerminal>();
  for (const [taskId, terminal] of terminals) {
    const task = requireTask(deps, taskId);
    const result = awaitResultForFilter(task, terminal.result, filter);
    if (result !== null) {
      filtered.set(taskId, { ...terminal, result });
    }
  }
  return filtered;
}

function writeAwaitJsonLine(deps: CliDeps, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  return new Promise((resolveWrite, rejectWrite) => {
    try {
      deps.stdout.write(line, (error?: Error | null): void => {
        if (error !== undefined && error !== null) {
          rejectWrite(error);
          return;
        }
        resolveWrite();
      });
    } catch (error) {
      rejectWrite(error);
    }
  });
}

async function emitAwaitCheckpointResults(
  deps: CliDeps,
  boardInstanceId: string,
  terminals: ReadonlyMap<string, AwaitCheckpointTerminal>,
): Promise<void> {
  const ordered = [...terminals.values()].sort((left, right) =>
    left.eventId - right.eventId || left.result.id.localeCompare(right.result.id)
  );
  for (const terminal of ordered) {
    await writeAwaitJsonLine(deps, {
      ...terminal.result,
      dedupeKey: `${boardInstanceId}:${terminal.result.id}:e${terminal.eventId}`,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function requireTextOrFile(text: string | undefined, file: string | undefined): string {
  if (text !== undefined && file !== undefined) {
    throw new Error("本文と --file は同時には指定できません");
  }
  if (text === undefined && file === undefined) {
    throw new Error("本文または --file のどちらかを指定してください");
  }
  if (file !== undefined) {
    if (!existsSync(file)) {
      throw new Error(`--file で指定したファイルが見つかりません: ${file}`);
    }
    return readFileSync(file, "utf8").trim();
  }
  return text?.trim() ?? "";
}

function parseRunMetaForTransport(meta: string): RunMetaForTransport {
  const record = parseRunMetaRecord(meta);
  const serverUrl = typeof record.serverUrl === "string" ? record.serverUrl : "";
  const transport = typeof record.transport === "string" ? record.transport : "";
  const model = typeof record.model === "string" ? record.model : "";
  const modelDelivery = record.modelDelivery === "native" ? "native" : "none";
  return { serverUrl, transport, model, modelDelivery };
}

function parseRunMetaRecord(meta: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(meta);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function sessionRefFromRun(run: RunRow): SessionRef {
  const meta = parseRunMetaForTransport(run.meta);
  const nativeCommunication = nativeCommunicationFromRun(run);
  return {
    provider: run.provider,
    sessionId: run.sessionId,
    serverUrl: meta.serverUrl,
    model: meta.model,
    modelDelivery: meta.modelDelivery,
    ...(nativeCommunication === null ? {} : { nativeCommunication }),
    startedAt: run.startedAt,
  };
}

function parseNativeSocketSnapshot(value: unknown): NativeCommunicationSocketSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const canonicalPath = record.canonicalPath;
  const parentCanonicalPath = record.parentCanonicalPath;
  if (
    typeof canonicalPath !== "string" || !canonicalPath.startsWith("/") ||
    typeof parentCanonicalPath !== "string" || !parentCanonicalPath.startsWith("/")
  ) {
    return null;
  }
  const numberFields = [
    "parentDev",
    "parentIno",
    "parentUid",
    "parentMode",
    "dev",
    "ino",
    "uid",
    "gid",
    "mode",
  ] as const;
  for (const field of numberFields) {
    const number = record[field];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) return null;
  }
  const parentMode = record.parentMode as number;
  const mode = record.mode as number;
  if (parentMode > 0o777 || mode > 0o777 || (parentMode & 0o077) !== 0 || (mode & 0o077) !== 0) return null;
  return {
    canonicalPath,
    parentCanonicalPath,
    parentDev: record.parentDev as number,
    parentIno: record.parentIno as number,
    parentUid: record.parentUid as number,
    parentMode,
    dev: record.dev as number,
    ino: record.ino as number,
    uid: record.uid as number,
    gid: record.gid as number,
    mode,
  };
}

/**
 * Reconstruct provider-owned exact native address fields from run.meta.
 * Display names and providerSessionId are not sufficient target authority;
 * durable binding/claim code rechecks the exact address before dispatch.
 */
function nativeCommunicationFromRun(run: RunRow): NativeCommunicationSessionRef | null {
  const record = parseRunMetaRecord(run.meta);
  const value = record.nativeCommunication;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const native = value as Record<string, unknown>;
  const providerSessionId = native.providerSessionId;
  const runtimeVersion = native.runtimeVersion;
  const capabilityHash = native.capabilityHash;
  const hostId = native.hostId;
  const observedAt = native.observedAt;
  const expiresAt = native.expiresAt;
  if (
    typeof providerSessionId !== "string" || providerSessionId.trim() === "" ||
    typeof runtimeVersion !== "string" || runtimeVersion.trim() === "" ||
    typeof capabilityHash !== "string" || capabilityHash.trim() === "" ||
    typeof hostId !== "string" || hostId.trim() === "" ||
    typeof observedAt !== "number" || !Number.isSafeInteger(observedAt) || observedAt <= 0 ||
    typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= observedAt
  ) {
    return null;
  }
  // The provider's exact session evidence must describe this durable run;
  // a caller-supplied session ID from another run is not a native address.
  if (providerSessionId !== run.sessionId) {
    return null;
  }
  if (native.route === "codex-app-server") {
    const threadId = native.threadId;
    const activeTurnId = native.activeTurnId;
    const socketSnapshot = parseNativeSocketSnapshot(native.socketSnapshot);
    if (
      run.provider !== "codex" ||
      typeof threadId !== "string" || threadId.trim() === "" ||
      typeof activeTurnId !== "string" || activeTurnId.trim() === "" ||
      socketSnapshot === null
    ) {
      return null;
    }
    return {
      route: "codex-app-server",
      providerSessionId,
      runtimeVersion,
      capabilityHash,
      hostId,
      observedAt,
      expiresAt,
      threadId,
      activeTurnId,
      socketSnapshot,
    };
  }
  if (native.route === "claude-cross-session") {
    const agentRef = native.agentRef;
    if (run.provider !== "claude" || typeof agentRef !== "string" || agentRef.trim() === "") return null;
    return {
      route: "claude-cross-session",
      providerSessionId,
      runtimeVersion,
      capabilityHash,
      hostId,
      observedAt,
      expiresAt,
      agentRef,
    };
  }
  return null;
}

function isDirectRun(run: RunRow): boolean {
  const meta = parseRunMetaForTransport(run.meta);
  return meta.transport === "direct" || meta.serverUrl === "direct";
}

function isAcceptableRestartStopReason(reason: string): boolean {
  return ACCEPTABLE_RESTART_STOP_REASONS.some((acceptable) => acceptable === reason);
}

function formatCommandTimestamp(): string {
  return new Date().toISOString();
}

function buildSteerPrepend(message: string): string {
  return [
    `## ⚠ オーケストレーター介入 (${formatCommandTimestamp()})`,
    "",
    message,
    "",
  ].join("\n");
}

function prependBody(prefix: string, body: string): string {
  return body.length > 0 ? `${prefix}${body}` : prefix.trimEnd();
}

interface SteerRouteContext {
  provenance?: ActorProvenance;
  sourceProvider: Provider | "";
  sourceSessionId: string;
  preference: CommunicationPreference;
  routing: ResolveCommunicationRouteInput;
  decision: CommunicationRouteDecision;
}

/**
 * v0.18 の structured steer intent を同じ DB transaction へ渡す additive input。
 * Core の v20 API がこの payload を redacted snapshot として保存する。古い Core
 * でも型互換を保てるよう、追加 field は CLI の call site でのみ保持する。
 */
type StructuredCommunicationAttemptInput =
  Parameters<NativeCommunicationStore["createOrGetCommunicationAttempt"]>[0] & {
    payload?: unknown;
    intent?: "steer";
    sourcePrincipal?: ActorProvenance;
  };

/** structured principal と current run だけから安全側のcommunication routeを解決する。 */
function resolveSteerRouteContext(
  deps: CliDeps,
  run: RunRow,
  options: TaskSteerOptions,
  allowNativeIntent = false,
): SteerRouteContext {
  const provenance = resolveActorProvenance(options, ORCHESTRATOR_ACTOR);
  if (provenance !== undefined && provenance.kind !== "orchestrator") {
    throw new Error("task steer の構造化操作主体は orchestrator のみ指定できます");
  }
  if (options.communication === "native" && provenance?.kind !== "orchestrator") {
    throw new Error(
      "--communication native は --actor-kind orchestrator と --orchestrator/--session/--generation が必須です",
    );
  }

  let sourceProvider: Provider | "" = "";
  let sourceSessionId = "";
  if (provenance?.kind === "orchestrator") {
    requireActiveOrchestratorStore(deps.store).assertActiveOrchestratorPrincipal(provenance);
    const session = deps.store.getOrchestratorSession(provenance.actorSessionId);
    if (
      session !== null && session.orchestratorId === provenance.actorId &&
      session.generation === provenance.actorGeneration && session.provider !== "" &&
      session.providerSessionId !== ""
    ) {
      sourceProvider = session.provider;
      sourceSessionId = session.providerSessionId;
    }
  }

  const preference = options.communication ?? "auto";
  const rollout = deps.config.communication?.[run.provider]?.rollout ?? "off";
  const routing: ResolveCommunicationRouteInput = {
    // legacy provenance無しではnative候補にしない。off/observeのHachi経路だけを維持する。
    sourceProvider: sourceProvider === "" ? run.provider : sourceProvider,
    targetProvider: run.provider,
    rollout,
    preference,
    sameHost: false,
    exactSourceBinding: false,
    // v0.17 CLIはdurable native binding作成を行わないため、既存Hachi配送以外をclaimしない。
    exactTargetBinding: false,
    capability: "unknown",
  };
  const decision = resolveCommunicationRoute(routing);
  if (decision.status === "refused") {
    // Native direct runs record an intent here. Core claim/adapter code owns
    // final route selection after fresh binding evidence; the caller must not
    // self-assert a native route in this transaction.
    if (
      allowNativeIntent &&
      sourceProvider !== "" &&
      sourceProvider === run.provider &&
      (rollout === "on" || rollout === "canary") &&
      options.communication !== "hachi" &&
      decision.nativeCandidate !== null
    ) {
      return {
        ...(provenance === undefined ? {} : { provenance }),
        sourceProvider,
        sourceSessionId,
        preference,
        routing,
        // Preserve Core's recomputable refused decision. The structured
        // intent API records it neutrally as route=hachi, then trusted service
        // promotion may attach fresh exact bindings and select native later.
        decision,
      };
    }
    throw new Error(`communication route を選択できません: reason=${decision.reason}`);
  }
  if (decision.route !== "hachi") {
    throw new Error(`native communication delivery は未有効です: route=${decision.route}`);
  }
  return {
    ...(provenance === undefined ? {} : { provenance }),
    sourceProvider,
    sourceSessionId,
    preference,
    routing,
    decision,
  };
}

function requireLatestOpenRun(deps: CliDeps, task: TaskRow): RunRow {
  const run = deps.store.getLatestOpenRun(task.id);
  if (run === null) {
    throw new Error(
      "open run が無いため steer できません。body を編集してから ready へ戻す場合は task edit-body / task move を使ってください",
    );
  }
  return run;
}

function requireDirectAdapter(deps: CliDeps, provider: Provider): WorkerAdapter {
  const adapter = deps.directAdapters?.[provider];
  if (adapter === undefined) {
    throw new Error(`direct transport の adapter が未構成です (provider=${provider})`);
  }
  if (adapter.stop === undefined) {
    throw new Error(`direct transport の stop が未実装です (provider=${provider})`);
  }
  return adapter;
}

async function waitForSteerLifecycle(
  store: DurableSteerStore,
  deliveryId: string,
  waitSec: number,
): Promise<SteerDeliveryRow> {
  const startedAt = Date.now();
  const deadline = startedAt + waitSec * 1000;
  while (Date.now() <= deadline) {
    const delivery = store.getSteerDelivery(deliveryId);
    if (delivery === null) {
      throw new Error(`steer delivery が見つかりません: ${deliveryId}`);
    }
    if (!["queued", "dispatching"].includes(delivery.status)) {
      return delivery;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await sleep(Math.min(DEFAULT_STEER_WAIT_POLL_SEC * 1000, remaining));
  }
  const delivery = store.getSteerDelivery(deliveryId);
  if (delivery === null) {
    throw new Error(`steer delivery が見つかりません: ${deliveryId}`);
  }
  return delivery;
}

async function runAwait(deps: CliDeps, ids: string[], options: TaskAwaitOptions): Promise<void> {
  assertAwaitTargetSelection(ids, options);
  const tenants = options.tenant === undefined
    ? undefined
    : normalizeAwaitTenantFilter(options.tenant);
  const orchestratorId = options.includeOrchestrator === undefined
    ? undefined
    : normalizeAwaitOrchestratorFilter(options.includeOrchestrator);
  if (orchestratorId !== undefined && deps.store.getOrchestrator(orchestratorId) === null) {
    throw new Error(`未知のorchestrator identity: ${orchestratorId}`);
  }
  const scopeView = orchestratorId === undefined ? undefined : createKanbanReadView(deps.env.dbPath);
  const filter: AwaitFilter = { tenants, orchestratorId, scopeView };
  try {
    if (options.followNew === true) {
      await runFollowNewAwait(deps, options, filter);
      return;
    }

    const initialTargets = resolveAwaitInitialTargets(deps, ids, options).filter((task) =>
      matchesAwaitFilter(task, filter)
    );
    const targetIds = new Set(initialTargets.map((task) => task.id));
    const json = options.json === true;
    const startedAt = Date.now();
    const intervalSec = options.interval ?? DEFAULT_AWAIT_INTERVAL_SEC;
    const intervalMs = intervalSec * 1000;
    const maxWaitMs = options.maxWait === undefined ? undefined : options.maxWait * 1000;

    let terminal = currentAwaitTerminalTasks(deps, targetIds, filter, true);
    if (terminal.length > 0 || targetIds.size === 0) {
      emitAwaitResults(deps, json, terminal);
      return;
    }

    while (true) {
      const elapsedMs = Date.now() - startedAt;
      if (maxWaitMs !== undefined && elapsedMs >= maxWaitMs) {
        deps.exit(2);
        return;
      }

      const sleepMs = maxWaitMs === undefined ? intervalMs : Math.min(intervalMs, maxWaitMs - elapsedMs);
      await sleep(sleepMs);

      terminal = currentAwaitTerminalTasks(deps, targetIds, filter, true);
      if (terminal.length > 0) {
        emitAwaitResults(deps, json, terminal);
        return;
      }
      if (targetIds.size === 0) {
        return;
      }
    }
  } finally {
    scopeView?.close();
  }
}

async function runFollowNewAwait(
  deps: CliDeps,
  options: TaskAwaitOptions,
  filter: AwaitFilter,
): Promise<void> {
  if (options.cursorFile !== undefined) {
    await runCheckpointedFollowNewAwait(deps, options.cursorFile, options, filter);
    return;
  }

  const view = new AwaitFollowReadView(deps.env.dbPath);
  try {
    const arm = view.arm();
    const targetIds = new Set(arm.targetIds);
    const json = options.json === true;
    const startedAt = Date.now();
    const intervalSec = options.interval ?? DEFAULT_AWAIT_INTERVAL_SEC;
    const intervalMs = intervalSec * 1000;
    const maxWaitMs = options.maxWait === undefined ? undefined : options.maxWait * 1000;
    let eventCursor = arm.eventCursor;

    while (true) {
      const elapsedMs = Date.now() - startedAt;
      if (maxWaitMs !== undefined && elapsedMs >= maxWaitMs) {
        deps.exit(2);
        return;
      }

      const sleepMs = maxWaitMs === undefined ? intervalMs : Math.min(intervalMs, maxWaitMs - elapsedMs);
      await sleep(sleepMs);

      while (true) {
        const rows = view.eventsAfter(eventCursor);
        if (rows.length === 0) {
          break;
        }
        const lastEventId = rows.at(-1)?.id;
        if (lastEventId === undefined || !Number.isSafeInteger(lastEventId) || lastEventId <= eventCursor) {
          throw new Error(`task await の event cursor が前進しません: ${lastEventId ?? "undefined"}`);
        }
        eventCursor = lastEventId;
        const terminal = consumeAwaitFollowEvents(deps, targetIds, rows, filter);
        if (terminal.length > 0) {
          emitAwaitResults(deps, json, terminal);
          return;
        }
        if (rows.length < AWAIT_EVENT_SCAN_LIMIT) {
          break;
        }
      }

      const terminal = currentAwaitTerminalTasks(deps, targetIds, filter, false);
      if (terminal.length > 0) {
        emitAwaitResults(deps, json, terminal);
        return;
      }
    }
  } finally {
    view.close();
  }
}

async function runCheckpointedFollowNewAwait(
  deps: CliDeps,
  cursorFile: string,
  options: TaskAwaitOptions,
  filter: AwaitFilter,
): Promise<void> {
  const { tenants, orchestratorId } = filter;
  const boardInstanceId = readBoardInstanceId(deps.env.dbPath);
  const checkpointStore: TaskAwaitCheckpointStore = openTaskAwaitCheckpointStore({
    home: deps.env.home,
    relativePath: cursorFile,
    boardInstanceId,
    ...(tenants !== undefined ? { tenants } : {}),
    ...(orchestratorId !== undefined ? { orchestratorId } : {}),
  });
  let view: AwaitFollowReadView | undefined;
  try {
    view = new AwaitFollowReadView(deps.env.dbPath);
    const stored = checkpointStore.read();
    const arm = view.arm();
    if (stored !== null && stored.eventCursor > arm.eventCursor) {
      throw new Error(
        `task await checkpoint のeventCursorがboardの高水位を超えています: ${stored.eventCursor}`,
      );
    }

    let eventCursor: number;
    let targetIds: Set<string>;
    let pendingArmTargetIds: Set<string> | null = null;
    if (stored === null) {
      eventCursor = arm.eventCursor;
      targetIds = new Set(arm.targetIds);
      checkpointStore.write(awaitCheckpointValue(boardInstanceId, eventCursor, targetIds, filter));
    } else {
      eventCursor = stored.eventCursor;
      targetIds = new Set(stored.targetIds);
      if (eventCursor === arm.eventCursor) {
        for (const taskId of arm.targetIds) {
          targetIds.add(taskId);
        }
        const mergedTargetIds = sortedAwaitTargetIds(targetIds);
        if (
          mergedTargetIds.length !== stored.targetIds.length ||
          mergedTargetIds.some((taskId, index) => taskId !== stored.targetIds[index])
        ) {
          checkpointStore.write(awaitCheckpointValue(boardInstanceId, eventCursor, targetIds, filter));
        }
      } else {
        pendingArmTargetIds = new Set(arm.targetIds);
      }
    }

    const startedAt = Date.now();
    const intervalSec = options.interval ?? DEFAULT_AWAIT_INTERVAL_SEC;
    const intervalMs = intervalSec * 1000;
    const maxWaitMs = options.maxWait === undefined ? undefined : options.maxWait * 1000;

    while (true) {
      const elapsedMs = Date.now() - startedAt;
      if (maxWaitMs !== undefined && elapsedMs >= maxWaitMs) {
        deps.exit(2);
        return;
      }

      const sleepMs = maxWaitMs === undefined ? intervalMs : Math.min(intervalMs, maxWaitMs - elapsedMs);
      await sleep(sleepMs);

      while (true) {
        const rows = view.eventsAfter(eventCursor);
        if (rows.length === 0) {
          const snapshot = view.snapshot();
          if (snapshot.eventCursor > eventCursor) {
            continue;
          }
          if (snapshot.eventCursor < eventCursor) {
            throw new Error(`task await の event cursor がboardの高水位を超えています: ${eventCursor}`);
          }
          const reconciledTargets = new Set(targetIds);
          const terminals = new Map<string, AwaitCheckpointTerminal>();
          reconcileAwaitCheckpointSnapshot(deps, view, snapshot, reconciledTargets, terminals);
          if (terminals.size > 0) {
            throw new Error("task await checkpoint の保存cursor以前に未配送の終端があります");
          }
          const reconciledIds = sortedAwaitTargetIds(reconciledTargets);
          const currentIds = sortedAwaitTargetIds(targetIds);
          if (
            reconciledIds.length !== currentIds.length ||
            reconciledIds.some((taskId, index) => taskId !== currentIds[index])
          ) {
            checkpointStore.write(awaitCheckpointValue(boardInstanceId, eventCursor, reconciledTargets, filter));
            targetIds = reconciledTargets;
          }
          break;
        }

        let previousEventId = eventCursor;
        for (const row of rows) {
          if (!Number.isSafeInteger(row.id) || row.id <= previousEventId) {
            throw new Error(`task await の event cursor が前進しません: ${row.id}`);
          }
          previousEventId = row.id;
        }
        const lastEventId = previousEventId;
        const nextTargetIds = new Set(targetIds);
        let terminals: Map<string, AwaitCheckpointTerminal>;
        if (pendingArmTargetIds !== null && lastEventId >= arm.eventCursor) {
          const afterArmIndex = rows.findIndex((row) => row.id > arm.eventCursor);
          const throughArmRows = afterArmIndex === -1 ? rows : rows.slice(0, afterArmIndex);
          terminals = consumeAwaitCheckpointEvents(deps, nextTargetIds, throughArmRows);
          for (const taskId of pendingArmTargetIds) {
            nextTargetIds.add(taskId);
          }
          pendingArmTargetIds = null;
          if (afterArmIndex !== -1) {
            const afterArmTerminals = consumeAwaitCheckpointEvents(
              deps,
              nextTargetIds,
              rows.slice(afterArmIndex),
            );
            for (const [taskId, terminal] of afterArmTerminals) {
              terminals.set(taskId, terminal);
            }
          }
        } else {
          terminals = consumeAwaitCheckpointEvents(deps, nextTargetIds, rows);
        }
        let snapshotCursor: number | null = null;
        if (rows.length < AWAIT_EVENT_SCAN_LIMIT) {
          const snapshot = view.snapshot();
          snapshotCursor = snapshot.eventCursor;
          if (snapshot.eventCursor < lastEventId) {
            throw new Error(`task await の snapshot cursor が逆行しました: ${snapshot.eventCursor}`);
          }
          if (snapshot.eventCursor === lastEventId) {
            reconcileAwaitCheckpointSnapshot(deps, view, snapshot, nextTargetIds, terminals);
          }
        }
        for (const terminal of terminals.values()) {
          if (terminal.eventId <= eventCursor) {
            throw new Error(`task await の未配送終端が保存cursor以前にあります: ${terminal.result.id}`);
          }
        }

        const deliverableTerminals = filterAwaitCheckpointTerminals(deps, terminals, filter);
        if (deliverableTerminals.size > 0) {
          await emitAwaitCheckpointResults(deps, boardInstanceId, deliverableTerminals);
        }
        checkpointStore.write(awaitCheckpointValue(boardInstanceId, lastEventId, nextTargetIds, filter));
        eventCursor = lastEventId;
        targetIds = nextTargetIds;
        if (deliverableTerminals.size > 0) {
          return;
        }
        if (rows.length < AWAIT_EVENT_SCAN_LIMIT && snapshotCursor === lastEventId) {
          break;
        }
      }
    }
  } finally {
    try {
      view?.close();
    } finally {
      checkpointStore.close();
    }
  }
}

/** done/archived は依存ゲート上の充足済み前提として扱う（docs/contract.md §24.1） */
function isDependencyFulfilled(task: TaskRow): boolean {
  return task.status === "done" || task.status === "archived";
}

function toDependencySummary(task: TaskRow): DependencySummary {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    fulfilled: isDependencyFulfilled(task),
  };
}

function formatDependencyLine(dependency: DependencySummary): string {
  const marker = dependency.fulfilled ? "充足" : "未充足";
  return `${dependency.id} [${dependency.status}] ${marker} ${dependency.title}`;
}

/** hachi task deps の action 本体 */
function runDeps(deps: CliDeps, id: string, options: TaskDepsOptions): void {
  requireTask(deps, id);
  const dependencies = deps.store.dependencies(id).map(toDependencySummary);
  const unmetDependencies = dependencies.filter((dependency) => !dependency.fulfilled);
  const json = options.json === true;
  const textLines =
    dependencies.length === 0 ? ["(前提タスクはありません)"] : dependencies.map(formatDependencyLine);

  emit(deps, json, { taskId: id, dependencies, unmetDependencies }, textLines);
}

/**
 * in-progress prefix（codex-in-progress: / claude-in-progress:）は dispatch ステージのみが作れる
 * （docs/contract.md §12.11-2）。CLI 経由の block はこれを fail-closed で拒否する。
 */
function runBlock(deps: CliDeps, id: string, options: TaskBlockOptions): void {
  if (isInProgressReason(options.reason)) {
    throw new Error(
      "--reason に codex-in-progress: / claude-in-progress: は指定できません（in-progress は supervisor 専有です）",
    );
  }
  const provenance = resolveActorProvenance(options, DEFAULT_ACTOR);
  const task = deps.store.block(id, options.reason, DEFAULT_ACTOR, options.assignee, provenance);
  const json = options.json === true;
  emit(
    deps,
    json,
    singularResourceEnvelope(task, { task }),
    [`タスクを blocked にしました: ${task.id} reason=${task.blockReason}`],
  );
}

/** hachi task unblock の action 本体 */
function runUnblock(deps: CliDeps, id: string, options: TaskUnblockOptions): void {
  const provenance = resolveActorProvenance(options, DEFAULT_ACTOR);
  const task = deps.store.unblock(id, options.to, DEFAULT_ACTOR, provenance);
  const json = options.json === true;
  emit(deps, json, singularResourceEnvelope(task, { task }), [`タスクを ${task.status} に戻しました: ${task.id}`]);
}

function isWatchableStore(store: CliDeps["store"]): store is CliDeps["store"] & WatchableStore {
  return "setWatched" in store && typeof store.setWatched === "function";
}

function requireWatchableStore(store: CliDeps["store"]): WatchableStore {
  if (!isWatchableStore(store)) {
    throw new Error("この store は watched 更新に対応していません");
  }
  return store;
}

/** hachi task watch / unwatch の action 本体 */
function runWatch(deps: CliDeps, id: string, watched: boolean, options: TaskWatchOptions): void {
  requireTask(deps, id);
  const provenance = resolveActorProvenance(options, DEFAULT_ACTOR);
  const task = requireWatchableStore(deps.store).setWatched(id, watched, DEFAULT_ACTOR, provenance);
  const json = options.json === true;
  const text = watched ? `タスクをウォッチしました: ${task.id}` : `タスクのウォッチを解除しました: ${task.id}`;
  emit(deps, json, singularResourceEnvelope(task, { task }), [text]);
}

/**
 * hachi task move の action 本体。
 * triage/todo → ready の promote 等、blocked を除く汎用状態遷移の薄い入口。
 * 遷移の妥当性検証（許可遷移マップ）は core の statemachine（assertTransition）に委ね、
 * CLI 側では許可リストを二重定義しない。不正遷移は store.transition が throw し、
 * withErrorHandling が日本語エラー + exit 1 にする。
 * ただし --to blocked のみは reason 必須のため専用エラーで拒否し、task block へ誘導する。
 */
function runMove(deps: CliDeps, id: string, options: TaskMoveOptions): void {
  if (options.to === "blocked") {
    throw new Error(
      "--to blocked は task move では指定できません（block_reason が必須のため task block コマンドを使ってください）",
    );
  }
  const actor = options.author ?? DEFAULT_ACTOR;
  const provenance = resolveActorProvenance(options, actor);
  const task = deps.store.transition({
    taskId: id,
    to: options.to,
    actor,
    eventType: "status_changed",
    ...(provenance === undefined ? {} : { provenance }),
  });
  const json = options.json === true;
  emit(
    deps,
    json,
    singularResourceEnvelope(task, { task }),
    [`タスクの状態を ${task.status} に変更しました: ${task.id}`],
  );
}

/** hachi task comment の action 本体 */
function runComment(deps: CliDeps, id: string, options: TaskCommentOptions): void {
  requireTask(deps, id);
  const author = options.author ?? DEFAULT_ACTOR;
  const provenance = resolveActorProvenance(options, author);
  const comment = deps.store.addComment(id, author, options.body, provenance);
  const json = options.json === true;
  emit(deps, json, singularResourceEnvelope(comment, { comment }), [`コメントを追加しました: #${comment.id}`]);
}

/** hachi task attach の action 本体（docs/contract.md §32.1） */
function runAttach(deps: CliDeps, id: string, options: TaskAttachOptions): void {
  requireTask(deps, id);
  const author = options.author ?? DEFAULT_ACTOR;
  // validation errorでもartifact残骸を作らないよう、file copyより先にprincipalを解決する。
  const provenance = resolveActorProvenance(options, author);
  if (!existsSync(options.file)) {
    throw new Error(`--file で指定したファイルが見つかりません: ${options.file}`);
  }
  const stats = statSync(options.file);
  if (!stats.isFile()) {
    throw new Error(`--file は通常ファイルのみ指定できます: ${options.file}`);
  }
  if (!isAllowedAttachmentExtension(extname(options.file))) {
    throw new Error(`添付ファイルの拡張子が許可されていません: ${options.file}`);
  }
  if (stats.size > ATTACH_MAX_BYTES) {
    throw new Error(`添付ファイルは 10MB 以下のみ指定できます: ${options.file}`);
  }

  const requestedName = resolveRequestedAttachmentName(options.file, options.name);
  const targetPath = resolveAttachmentTarget(deps.env.artifactsDir, id, requestedName);
  copyFileSync(options.file, targetPath, fsConstants.COPYFILE_EXCL);

  const artifact: AttachmentArtifact = {
    name: basename(targetPath),
    path: targetPath,
    sizeBytes: stats.size,
  };
  const payload: TaskAttachPayload = { taskId: id, artifact };
  try {
    deps.store.transaction((): void => {
      const currentRun = deps.store.getLatestOpenRun(id);
      deps.store.addEvent(
        id,
        "artifact_attached",
        author,
        {
          name: artifact.name,
          sizeBytes: artifact.sizeBytes,
          runId: currentRun?.id ?? null,
          sessionId: currentRun?.sessionId ?? null,
        },
        provenance,
      );
      if (options.comment !== undefined) {
        payload.comment = deps.store.addComment(
          id,
          author,
          buildAttachmentCommentBody(options.comment, artifact.name),
          provenance,
        );
      }
    });
  } catch (err) {
    rmSync(targetPath, { force: true });
    throw err;
  }

  const json = options.json === true;
  const textLines = [`artifact を添付しました: ${id} ${artifact.name}`];
  if (payload.comment !== undefined) {
    textLines.push(`コメントを追加しました: #${payload.comment.id}`);
  }
  emit(deps, json, payload, textLines);
}

/**
 * hachi task set-cwd の action 本体。
 * 既存 body から cwd: 行を除去し、先頭に `cwd: <path>` 行 + 空行を付与して updateBody する。
 * パスは絶対パスのみ受理（fail-closed）。実在チェックは warn のみで、無くてもセット自体は成功させる
 * （import 直後などファイル実体がまだ無い状況でも cwd を先に記録できるようにするため）。
 */
function runSetCwd(deps: CliDeps, id: string, cwdPath: string, options: TaskSetCwdOptions): void {
  if (!isAbsolute(cwdPath)) {
    throw new Error(`cwd は絶対パスのみ指定できます（相対パスは拒否します。fail-closed）: ${cwdPath}`);
  }

  const task = requireTask(deps, id);
  const newBody = buildBodyWithCwd(task.body, cwdPath);
  const provenance = resolveActorProvenance(options, DEFAULT_ACTOR);
  const updated = deps.store.updateBody(id, newBody, DEFAULT_ACTOR, provenance);
  const json = options.json === true;

  if (!existsSync(cwdPath)) {
    deps.stderr.write(
      `警告: 指定した cwd はファイルシステム上に存在しません（存在しなくてもセット自体は可能です）: ${cwdPath}\n`,
    );
  }

  emit(deps, json, singularResourceEnvelope(updated, { task: updated }), [
    `body の cwd を更新しました: ${updated.id}`,
    ...formatBodyPreview(updated.body),
  ]);
}

/**
 * hachi task edit-body の action 本体。
 * --file で指定したファイルの内容で body を全置換する（stdin 経由の入力は受け付けない）。
 */
function runEditBody(deps: CliDeps, id: string, options: TaskEditBodyOptions): void {
  requireTask(deps, id);
  if (!existsSync(options.file)) {
    throw new Error(`--file で指定したファイルが見つかりません: ${options.file}`);
  }

  const content = readFileSync(options.file, "utf8");
  assertTaskBodyValid(content);
  const provenance = resolveActorProvenance(options, DEFAULT_ACTOR);
  const updated = deps.store.updateBody(id, content, DEFAULT_ACTOR, provenance);
  const json = options.json === true;

  emit(deps, json, singularResourceEnvelope(updated, { task: updated }), [
    `body をファイル内容で全置換しました: ${updated.id} (source=${options.file})`,
    ...formatBodyPreview(updated.body),
  ]);
}

/** task link と create --depends-on で共有する検証・Store委譲。 */
function linkTasks(deps: CliDeps, parentId: string, childId: string, type: string): void {
  if (parentId === childId) {
    throw new Error(`自分自身へのリンクはできません: ${parentId}`);
  }
  requireTask(deps, parentId);
  requireTask(deps, childId);
  deps.store.link(parentId, childId, type);
}

/**
 * hachi task link の action 本体。
 * parentId/childId が共に既存タスクであることを検証してから
 * core の KanbanStore.link へ委譲する薄いラッパー（link は void を返すため LinkRow は組み立てない）。
 */
function runLink(deps: CliDeps, parentId: string, childId: string, options: TaskLinkOptions): void {
  const type = options.type ?? DEFAULT_LINK_TYPE;
  linkTasks(deps, parentId, childId, type);
  const json = options.json === true;

  emit(deps, json, { parentId, childId, type }, [`${parentId} → ${childId} (${type})`]);
}

async function runSteer(deps: CliDeps, id: string, text: string | undefined, options: TaskSteerOptions): Promise<void> {
  const task = requireTask(deps, id);
  const run = requireLatestOpenRun(deps, task);
  const messageText = requireTextOrFile(text, options.file);
  if (messageText.length === 0) {
    throw new Error("steer の本文は空にできません");
  }
  if (task.status !== "blocked" || !isInProgressReason(task.blockReason)) {
    throw new Error("対象タスクが進行中ではないため steer できません");
  }

  const nativeRef = nativeCommunicationFromRun(run);
  const requestedPreference = options.communication ?? "auto";
  const configuredRollout = deps.config.communication?.[run.provider]?.rollout ?? "off";
  const nativeRolloutEnabled = configuredRollout === "on" || configuredRollout === "canary";
  const nativeIntentPrincipal = resolveActorProvenance(options, ORCHESTRATOR_ACTOR);
  const nativeIntentSourceProvider = nativeIntentPrincipal?.kind === "orchestrator"
    ? deps.store.getOrchestratorSession(nativeIntentPrincipal.actorSessionId)?.provider ?? ""
    : "";
  const sameProviderNativeIntent = nativeIntentSourceProvider === run.provider;
  // `--restart` is an explicit lifecycle choice and keeps its pre-native
  // meaning even when a direct run carries native evidence/configuration.
  const explicitDirectRestart = isDirectRun(run) && options.restart === true;
  const activeNativeRollout =
    !explicitDirectRestart &&
    isDirectRun(run) &&
    nativeRolloutEnabled &&
    sameProviderNativeIntent &&
    requestedPreference !== "hachi";
  const nativeIntentRequested = !explicitDirectRestart &&
    nativeRolloutEnabled &&
    sameProviderNativeIntent && requestedPreference !== "hachi" &&
    (nativeRef !== null || activeNativeRollout);
  const useDurableSteerQueue = !isDirectRun(run) || nativeIntentRequested;
  if (useDurableSteerQueue) {
    const steerStore = deps.store as CliDeps["store"] & DurableSteerStore;
    const idempotencyKey = newNonce();
    const routeContext = resolveSteerRouteContext(deps, run, options, nativeIntentRequested);
    if (nativeIntentRequested && routeContext.provenance?.kind !== "orchestrator") {
      throw new Error(
        "native communication intentには --actor-kind orchestrator と --orchestrator/--session/--generation が必須です",
      );
    }
    let delivery!: SteerDeliveryRow;
    let communicationAttempt: CommunicationDeliveryAttemptRow | undefined;
    const message: AgentMessageV1 = {
      schema: "agent.message.v1",
      from: {
        role: ORCHESTRATOR_ACTOR,
        provider: routeContext.sourceProvider,
        sessionId: routeContext.sourceSessionId,
      },
      to: { role: "worker", taskId: id },
      intent: "steer",
      payload: {
        message: redactText(messageText),
        communication: {
          preference: routeContext.preference,
          decision: routeContext.decision,
        },
      },
      idempotencyKey,
      createdAt: Math.floor(Date.now() / 1000),
    };

    deps.store.transaction(() => {
      const currentRun = requireLatestOpenRun(deps, requireTask(deps, id));
      if (currentRun.id !== run.id || currentRun.sessionId !== run.sessionId) {
        throw new Error("communication route 判定後にopen runが変化したため steer を中止しました");
      }
      delivery = steerStore.createOrGetSteerDelivery({
        taskId: id,
        runId: run.id,
        sessionId: run.sessionId,
        messageKey: idempotencyKey,
        expectedCancelFence: steerStore.currentRunCancelFence(run.id),
        ...(options.supersedes === undefined ? {} : { supersedesId: options.supersedes }),
        actor: ORCHESTRATOR_ACTOR,
      });
      message.payload["deliveryId"] = delivery.id;
      message.payload["runId"] = delivery.runId;
      message.payload["sessionId"] = delivery.sessionId;
      message.payload["cancelFence"] = delivery.expectedCancelFence;
      if (routeContext.provenance !== undefined) {
        const communicationStore = deps.store as CliDeps["store"] & NativeCommunicationStore;
        communicationAttempt = communicationStore.createOrGetCommunicationAttempt({
          attemptKey: `route:${idempotencyKey}`,
          steerDeliveryId: delivery.id,
          preference: routeContext.preference,
          routing: routeContext.routing,
          decision: routeContext.decision,
          actor: ORCHESTRATOR_ACTOR,
          provenance: routeContext.provenance,
          // Final native routeはここで決めない。runtime evidenceを持つ claim/adapterが
          // 後段で決定するため、ここではredact済みのstructured intentだけを記録する。
          payload: { message: redactText(messageText) },
          intent: "steer",
          sourcePrincipal: routeContext.provenance,
        } as StructuredCommunicationAttemptInput);
        message.payload["communicationAttemptId"] = communicationAttempt.id;
      }
      deps.store.addEvent(
        id,
        "communication_route_decided",
        ORCHESTRATOR_ACTOR,
        {
          messageKey: idempotencyKey,
          runId: run.id,
          sessionId: run.sessionId,
          sourceProvider: routeContext.sourceProvider,
          sourceSessionId: routeContext.sourceSessionId,
          preference: routeContext.preference,
          decision: routeContext.decision,
        },
        routeContext.provenance,
      );
      deps.store.addComment(
        id,
        ORCHESTRATOR_ACTOR,
        serializeAgentMessage(message),
        routeContext.provenance,
      );
      deps.store.addComment(
        id,
        ORCHESTRATOR_ACTOR,
        `steer 送信: key=${idempotencyKey} route=${routeContext.decision.route}`,
        routeContext.provenance,
      );
    });

    let currentDelivery = delivery;
    if (options.wait !== undefined) {
      currentDelivery = await waitForSteerLifecycle(steerStore, delivery.id, options.wait);
      if (["queued", "dispatching"].includes(currentDelivery.status)) {
        deps.exit(2);
      }
    }

    const delivered = ["dispatching", "uncertain"].includes(currentDelivery.status)
      ? "unknown"
      : ["transport_accepted", "session_observed", "acknowledged"].includes(currentDelivery.status);
    const observed = currentDelivery.status === "session_observed" || currentDelivery.status === "acknowledged"
      ? true
      : ["dispatching", "transport_accepted", "uncertain"].includes(currentDelivery.status) ? "unknown" : false;
    const acknowledged = currentDelivery.status === "acknowledged"
      ? true
      : ["dispatching", "transport_accepted", "uncertain"].includes(currentDelivery.status) ? "unknown" : false;
    const payload: SteerBridgePayload = {
      task,
      message,
      routeDecision: routeContext.decision,
      ...(communicationAttempt === undefined ? {} : { communicationAttempt }),
      delivery: currentDelivery,
      processed: deps.store.hasProcessedMessage(idempotencyKey),
      delivered,
      observed,
      acknowledged,
    };
    const json = options.json === true;
    emit(deps, json, singularResourceEnvelope(task, payload), [
      `steer を送信しました: ${id} key=${idempotencyKey}`,
      ...(options.wait !== undefined
        ? [`delivery=${currentDelivery.status} delivered=${delivered === "unknown" ? "unknown" : delivered ? "yes" : "no"} observed=${String(observed)} acknowledged=${String(acknowledged)}`]
        : []),
    ]);
    return;
  }

  if (options.restart !== true) {
    throw new Error("direct run は実行中プロセスへの steer 注入に対応していません。再投入する場合は --restart を指定してください");
  }

  // An explicit direct restart is still a lifecycle operation, not a native
  // delivery. Allow the active native rollout's neutral decision to pass
  // through so the restart authority check can run instead of failing during
  // route selection.
  const routeContext = resolveSteerRouteContext(deps, run, options, nativeRolloutEnabled);
  if (routeContext.provenance?.kind !== "orchestrator") {
    throw new Error(
      "task steer --restart は --actor-kind orchestrator と --orchestrator/--session/--generation が必須です",
    );
  }
  const restartStore = deps.store as CliDeps["store"] & DurableSteerStore & DirectRestartAuthorityStore;
  const expectedCancelFence = restartStore.currentRunCancelFence(run.id);
  const restartIntent = restartStore.createOrGetDirectRestartIntent({
    intentKey: `steer-restart:${newNonce()}`,
    taskId: id,
    runId: run.id,
    sessionId: run.sessionId,
    expectedCancelFence,
    actor: ORCHESTRATOR_ACTOR,
    provenance: routeContext.provenance,
  });
  const adapter = requireDirectAdapter(deps, run.provider);
  const stop = await adapter.stop!(sessionRefFromRun(run));
  if (!isAcceptableRestartStopReason(stop.reason)) {
    throw new Error(`direct run の停止に失敗しました: ${stop.reason}`);
  }

  const intervention = buildSteerPrepend(redactText(messageText));

  deps.store.transaction(() => {
    restartStore.assertDirectRestartIntentCurrent({
      intentId: restartIntent.id,
      taskId: id,
      runId: run.id,
      sessionId: run.sessionId,
      expectedCancelFence,
      actor: ORCHESTRATOR_ACTOR,
      provenance: routeContext.provenance!,
    });
    const current = requireTask(deps, id);
    const currentRun = requireLatestOpenRun(deps, current);
    if (currentRun.id !== run.id) {
      throw new Error("open run が変化したため restart steer を中止しました");
    }
    if (current.status !== "blocked" || !isInProgressReason(current.blockReason)) {
      throw new Error("対象タスクが進行中ではないため restart steer を中止しました");
    }

    deps.store.endRun(currentRun.id, STOPPED_RUN_STATUS, {
      ...parseRunMetaRecord(currentRun.meta),
      steerRestart: { stoppedAt: Math.floor(Date.now() / 1000), stop },
    });
    deps.store.updateBody(
      id,
      prependBody(intervention, current.body),
      ORCHESTRATOR_ACTOR,
      routeContext.provenance,
    );
    deps.store.addComment(
      id,
      ORCHESTRATOR_ACTOR,
      [
        `direct run を停止し、オーケストレーター介入として ready へ再投入しました: session=${currentRun.sessionId} stop=${stop.reason}`,
        "",
        intervention.trimEnd(),
      ].join("\n"),
      routeContext.provenance,
    );
    deps.store.addEvent(
      id,
      "communication_route_decided",
      ORCHESTRATOR_ACTOR,
      {
        runId: currentRun.id,
        sessionId: currentRun.sessionId,
        sourceProvider: routeContext.sourceProvider,
        sourceSessionId: routeContext.sourceSessionId,
        preference: routeContext.preference,
        decision: routeContext.decision,
        restart: true,
      },
      routeContext.provenance,
    );
    deps.store.addEvent(id, "task_steer_restarted", ORCHESTRATOR_ACTOR, {
      sessionId: currentRun.sessionId,
      runId: currentRun.id,
      stop,
    }, routeContext.provenance);
    deps.store.unblock(id, "ready", ORCHESTRATOR_ACTOR, routeContext.provenance);
  });

  const payload: SteerRestartPayload = {
    task: requireTask(deps, id),
    run,
    restartIntent,
    stop,
    routeDecision: routeContext.decision,
  };
  const json = options.json === true;
  emit(
    deps,
    json,
    singularResourceEnvelope(payload.task, payload),
    [`direct run を停止して ready へ再投入しました: ${id} stop=${stop.reason}`],
  );
}

function runAnswer(deps: CliDeps, id: string, text: string | undefined, options: TaskAnswerOptions): void {
  const task = requireTask(deps, id);
  const routedRequest = deps.store.getActiveOrchestratorRequestByTask(id);
  if (routedRequest !== null) {
    throw new Error(
      `active orchestrator request (${routedRequest.id}) があるため task answer は使えません。orchestrator answer を使ってください`,
    );
  }
  const answer = requireTextOrFile(text, options.file);
  if (answer.length === 0) {
    throw new Error("answer の本文は空にできません");
  }
  if (task.status !== "blocked" || !task.blockReason.startsWith("worker-question:")) {
    throw new Error("task answer は worker-question: で blocked のタスクにのみ使えます");
  }

  const question = task.blockReason.slice("worker-question:".length).trim();
  const idempotencyKey = newNonce();
  const message: AgentMessageV1 = {
    schema: "agent.message.v1",
    from: { role: ORCHESTRATOR_ACTOR, provider: "", sessionId: "" },
    to: { role: "worker", taskId: id },
    intent: "answer",
    payload: { message: redactText(answer) },
    idempotencyKey,
    createdAt: Math.floor(Date.now() / 1000),
  };
  deps.store.transaction(() => {
    const current = requireTask(deps, id);
    if (current.status !== "blocked" || !current.blockReason.startsWith("worker-question:")) {
      throw new Error("task answer は worker-question: で blocked のタスクにのみ使えます");
    }
    deps.store.addComment(id, ORCHESTRATOR_ACTOR, serializeAgentMessage(message));
    deps.store.addComment(id, ORCHESTRATOR_ACTOR, `answer 送信: key=${idempotencyKey}`);
  });

  const payload: AnswerPayload = { task: requireTask(deps, id), question, message };
  const json = options.json === true;
  emit(deps, json, singularResourceEnvelope(payload.task, payload), [
    `answer を送信しました: ${id} key=${idempotencyKey}`,
  ]);
}

/** hachi task サブコマンド群を登録する */
export function registerTaskCommand(program: Command, deps: CliDeps): void {
  const task = program.command("task").description("タスク操作");

  const create = task
    .command("create")
    .description("タスクを作成する")
    .requiredOption("--title <title>", "タイトル")
    .requiredOption(
      "--body <body>",
      "本文（複数行は --body \"$(cat body.md)\" で実改行を渡す。" +
        "行構造を壊す literal \\n / \\r\\n や JSON.stringify の結果は展開せず code=literal-newline-escape で拒否）",
    )
    .requiredOption("--tenant <tenant>", "テナント")
    .option("--profile <profile>", "profile 名")
    .option("--priority <n>", "優先度", parsePriorityArg)
    .option("--status <status>", "初期状態（triage / todo / ready のみ許可）")
    .addOption(new Option("--provider <provider>", "実行プロバイダ").choices(PROVIDERS))
    .addOption(
      new Option("--model <model>", "作成と同時に model_override を設定する").choices(
        listAllowlistedModels(deps.config),
      ),
    )
    .option("--effort <effort>", `作成と同時に effort_override を設定する（${EFFORT_LEVELS.join(" / ")}）`)
    .addOption(new Option("--speed <speed>", "worker の処理速度 override（policy非対応は起動前にfail-closed）").choices(EXECUTION_SPEEDS))
    .option("--review-profile <profile>", "自動 reviewer の profile override")
    .addOption(new Option("--review-provider <provider>", "自動 reviewer の provider override").choices(PROVIDERS))
    .addOption(
      new Option("--review-model <model>", "自動 reviewer の model override").choices(
        listAllowlistedModels(deps.config),
      ),
    )
    .option(
      "--review-effort <effort>",
      `自動 reviewer の effort override（${EFFORT_LEVELS.join(" / ")}）`,
    )
    .addOption(
      new Option("--review-speed <speed>", "自動 reviewer の処理速度 override（policy非対応は起動前にfail-closed）").choices(EXECUTION_SPEEDS),
    )
    .option("--bind-orchestrator <identity-id>", "担当オーケストレーターへprimary bindingする")
    .option("--depends-on <taskId>", "前提タスク ID（反復指定可）", collectDependencyId, [])
    .option(
      "--runtime-profile <profileId>",
      "host-owned project-scoped runtime resource profile",
      collectRuntimeProfileId,
      [],
    );
  addActorPrincipalOptions(create)
    .option("--json", "JSON 形式で出力する")
    .action(withErrorHandling(deps, (options: TaskCreateOptions): void => runCreate(deps, options)));

  task
    .command("show")
    .description("タスク詳細と直近コメント/イベントを表示する")
    .argument("<id>", "タスク ID")
    .option("--comments <n>", "表示するコメント件数", parsePositiveIntArg)
    .option("--events <n>", "表示するイベント件数", parsePositiveIntArg)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(deps, (id: string, options: TaskShowOptions): void => runShow(deps, id, options)),
    );

  task
    .command("list")
    .description("タスク一覧を表示する")
    .addOption(new Option("--status <status>", "絞り込む状態").choices(TASK_STATUSES))
    .option("--limit <n>", `最大件数（省略時 ${DEFAULT_LIST_LIMIT} 件）`, parsePositiveIntArg)
    .option("--all", "全件表示する（--limit を無視する）")
    .option("--orchestrator <id>", "担当 orchestrator の binding / active watch に合致するタスクだけを表示する")
    .option("--subtree <task-id>", "指定タスクと subtask 子孫だけを表示する")
    .option("--json", "JSON 形式で出力する")
    .action(withErrorHandling(deps, (options: TaskListOptions): void => runList(deps, options)));

  task
    .command("await")
    .description("指定タスクまたは開始時点の稼働タスクが終端に達するまで待機する（docs/contract.md §50.1）")
    .argument("[ids...]", "タスク ID")
    .option("--all", "開始時点の稼働タスク（ready/review/blocked+in-progress）を対象にする")
    .option("--include-orchestrator <stable-id>", "担当scopeとのOR購読（--all 専用）")
    .option("--tenant <tenant>", "配送対象tenant（反復指定可・--all 専用）", collectAwaitTenant)
    .option("--follow-new", "arm 後に稼働状態へ入るタスクもイベントカーソルで追跡する（--all 専用）")
    .option("--cursor-file <path>", "follow-new の再開checkpoint（task-await配下の相対path）")
    .option(
      "--interval <sec>",
      `ポーリング間隔秒（既定 ${DEFAULT_AWAIT_INTERVAL_SEC}、下限 ${MIN_AWAIT_INTERVAL_SEC}）`,
      parseAwaitIntervalArg,
    )
    .option("--max-wait <sec>", "最大待機秒。超過時は何も出力せず exit 2", parsePositiveIntArg)
    .option("--json", "JSON Lines 形式で出力する")
    .action(
      withErrorHandling(deps, (ids: string[], options: TaskAwaitOptions): Promise<void> =>
        runAwait(deps, ids, options),
      ),
    );

  task
    .command("logs")
    .description("ワーカーログを direct / bridge / transcript artifact から表示する（docs/contract.md §50.3）")
    .argument("<id>", "タスク ID")
    .option("--follow", "ログを追尾する")
    .option("--head <n>", "冒頭から表示する行数", parsePositiveIntArg)
    .option("--tail <n>", `末尾から表示する行数（既定 40。0 は全量）`, parseNonNegativeIntArg)
    .option("--json", "JSON Lines 形式で出力する")
    .action(
      withErrorHandling(deps, (id: string, options: TaskLogsOptions): Promise<void> =>
        runTaskLogs(deps, id, options),
      ),
    );

  const cancel = task
    .command("cancel")
    .description("current open run へ durable cancel request を作成する（docs/contract.md §57.5）")
    .argument("<id>", "タスク ID")
    .requiredOption("--reason <text>", "cancel 理由")
    .option("--expect-run <runId>", "current open run に期待する run ID", parseExpectedRunArg)
    .option("--expect-session <workerSessionId>", "current open run に期待する worker session ID")
    .option("--grace <sec>", `cooperative grace 秒（既定 ${DEFAULT_CANCEL_GRACE_SEC}）`, parseCancelGraceArg)
    .option(
      "--force-if-supported",
      "exact-session stop を要求する（--grace 省略時は0秒、capability 無しは fail-closed）",
    );
  addActorPrincipalOptions(cancel)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(deps, (id: string, options: TaskCancelOptions): void => runCancel(deps, id, options)),
    );

  task
    .command("cancel-status")
    .description("durable cancel lifecycle と exact-session 証拠を読み取り専用で表示する")
    .argument("<id>", "タスク ID")
    .option("--all", "履歴をすべて表示する（省略時は最新のみ）")
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(
        deps,
        (id: string, options: TaskCancelStatusOptions): void => runCancelStatus(deps, id, options),
      ),
    );

  task
    .command("steer-list")
    .description("durable steer lifecycle と current run/session/fence を読み取り専用で表示する")
    .argument("<id>", "タスク ID")
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(
        deps,
        (id: string, options: TaskSteerListOptions): void => runSteerList(deps, id, options),
      ),
    );

  const cancelHostStop = task
    .command("cancel-host-stop")
    .description("bridge process generation停止済み証拠でpending durable cancelをhost収束する（既定dry-run）")
    .argument("<id>", "タスク ID")
    .requiredOption("--request <id>", "current active cancel request ID")
    .requiredOption("--evidence-id <id>", "外部停止証拠の非秘密識別子")
    .requiredOption("--process-generation <id>", "停止済みbridge process generation識別子")
    .option("--confirm", "fence再検証後にcancel/run/taskをmutationする");
  addActorPrincipalOptions(cancelHostStop)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(
        deps,
        (id: string, options: TaskCancelHostStopOptions): void => runCancelHostStop(deps, id, options),
      ),
    );

  task
    .command("deps")
    .description("前提タスク（depends-on）を status 付きで表示する")
    .argument("<id>", "タスク ID")
    .option("--json", "JSON 形式で出力する")
    .action(withErrorHandling(deps, (id: string, options: TaskDepsOptions): void => runDeps(deps, id, options)));

  const block = task
    .command("block")
    .description("タスクを blocked にする（block_reason は既知 prefix 必須）")
    .argument("<id>", "タスク ID")
    .requiredOption("--reason <reason>", "block_reason（既知 prefix 必須）")
    .option("--assignee <assignee>", "割当先");
  addActorPrincipalOptions(block)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(deps, (id: string, options: TaskBlockOptions): void => runBlock(deps, id, options)),
    );

  const unblock = task
    .command("unblock")
    .description("blocked から指定状態へ戻す")
    .argument("<id>", "タスク ID")
    .addOption(new Option("--to <status>", "遷移先の状態").choices(TASK_STATUSES).makeOptionMandatory());
  addActorPrincipalOptions(unblock)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(deps, (id: string, options: TaskUnblockOptions): void => runUnblock(deps, id, options)),
    );

  const watch = task
    .command("watch")
    .description("タスクにウォッチフラグを付ける")
    .argument("<id>", "タスク ID");
  addActorPrincipalOptions(watch)
    .option("--json", "JSON 形式で出力する")
    .action(withErrorHandling(deps, (id: string, options: TaskWatchOptions): void => runWatch(deps, id, true, options)));

  const unwatch = task
    .command("unwatch")
    .description("タスクのウォッチフラグを外す")
    .argument("<id>", "タスク ID");
  addActorPrincipalOptions(unwatch)
    .option("--json", "JSON 形式で出力する")
    .action(withErrorHandling(deps, (id: string, options: TaskWatchOptions): void => runWatch(deps, id, false, options)));

  const move = task
    .command("move")
    .description("状態を遷移する（triage/todo → ready 等の汎用遷移。blocked は task block を使う）")
    .argument("<id>", "タスク ID")
    .addOption(new Option("--to <status>", "遷移先の状態").choices(TASK_STATUSES).makeOptionMandatory())
    .option("--author <author>", "実行者", DEFAULT_ACTOR);
  addActorPrincipalOptions(move)
    .option("--json", "JSON 形式で出力する")
    .action(withErrorHandling(deps, (id: string, options: TaskMoveOptions): void => runMove(deps, id, options)));

  const comment = task
    .command("comment")
    .description("タスクにコメントを追加する")
    .argument("<id>", "タスク ID")
    .requiredOption("--body <text>", "コメント本文")
    .option("--author <author>", "投稿者", DEFAULT_ACTOR);
  addActorPrincipalOptions(comment)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(deps, (id: string, options: TaskCommentOptions): void => runComment(deps, id, options)),
    );

  const attach = task
    .command("attach")
    .description("タスクに artifact ファイルを添付する（docs/contract.md §32.1）")
    .argument("<id>", "タスク ID")
    .requiredOption("--file <path>", "添付するファイル")
    .option("--name <name>", "artifact として保存するファイル名")
    .option("--comment <text>", "添付と同時に追加するコメント本文")
    .option("--author <author>", "表示上の実行者/投稿者", DEFAULT_ACTOR);
  addActorPrincipalOptions(attach)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(deps, (id: string, options: TaskAttachOptions): void => runAttach(deps, id, options)),
    );

  const setCwd = task
    .command("set-cwd")
    .description("body 先頭に `cwd: <絶対パス>` 行を設定する（既存の cwd 行があれば置き換える）")
    .argument("<id>", "タスク ID")
    .argument("<path>", "作業ディレクトリの絶対パス");
  addActorPrincipalOptions(setCwd)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(
        deps,
        (id: string, cwdPath: string, options: TaskSetCwdOptions): void => runSetCwd(deps, id, cwdPath, options),
      ),
    );

  const editBody = task
    .command("edit-body")
    .description(
      "body をファイル内容で全置換する（stdin 不可、--file 必須。" +
        "ファイル内容も行構造を壊す literal \\n / \\r\\n は展開せず code=literal-newline-escape で拒否）",
    )
    .argument("<id>", "タスク ID")
    .requiredOption("--file <path>", "置換後の body を含むファイルパス");
  addActorPrincipalOptions(editBody)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(deps, (id: string, options: TaskEditBodyOptions): void => runEditBody(deps, id, options)),
    );

  const steer = task
    .command("steer")
    .description("進行中タスクへ追加指示を送る（bridge は注入、direct は --restart で再投入）")
    .argument("<id>", "タスク ID")
    .argument("[text]", "追加指示本文")
    .option("--file <path>", "追加指示本文を読むファイル")
    .option("--wait <sec>", "bridge 配送 lifecycle の変化を待つ秒数", parsePositiveIntArg)
    .option("--supersedes <deliveryId>", "未acknowledgedの旧 steer delivery を明示訂正する")
    .addOption(
      new Option("--communication <mode>", "通信経路の選択").choices(["auto", "hachi", "native"]),
    )
    .option("--restart", "direct run を停止し body へ介入文を prepend して ready へ再投入する")
    ;
  addActorPrincipalOptions(steer)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(
        deps,
        (id: string, text: string | undefined, options: TaskSteerOptions): Promise<void> =>
          runSteer(deps, id, text, options),
      ),
    );

  task
    .command("answer")
    .description("worker-question に agent.message.v1 answer を送る")
    .argument("<id>", "タスク ID")
    .argument("[text]", "回答本文")
    .option("--file <path>", "回答本文を読むファイル")
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(
        deps,
        (id: string, text: string | undefined, options: TaskAnswerOptions): void => runAnswer(deps, id, text, options),
      ),
    );

  task
    .command("link")
    .description("タスクをリンクする（既定 type=subtask。depends-on は <parentId>=前提, <childId>=依存先）")
    .argument("<parentId>", "親タスク ID / depends-on の前提タスク ID")
    .argument("<childId>", "子タスク ID / depends-on の依存先タスク ID")
    .option("--type <type>", "リンク種別（subtask / depends-on）", DEFAULT_LINK_TYPE)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(
        deps,
        (parentId: string, childId: string, options: TaskLinkOptions): void =>
          runLink(deps, parentId, childId, options),
      ),
    );
}
