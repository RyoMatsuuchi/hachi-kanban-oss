// ready → worker 起動ステージ（docs/contract.md §10）
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  extractTaskBodyCwd,
  findTaskBodyValidationError,
  newNonce,
  redactText,
  resolveModel,
  sha256Hex,
  isExternalRuntimeGenerationStore,
} from "@hachi/core";
import type { ExternalRuntimeGenerationReadResult, ExternalRuntimeGenerationReader } from "../external-runtime-generation-reader.js";
import type {
  EventRow,
  HachiConfig,
  KanbanStore,
  LaunchOptions,
  LessonRow,
  ModelResolution,
  Provider,
  RuntimeResourcesConfig,
  SessionRef,
  Stage,
  StageDeps,
  StageResult,
  StopResult,
  TaskRow,
  Transport,
  WorkerAdapter,
} from "@hachi/core";
import {
  BridgeError,
  buildInProgressReason,
  probeBridgeCapabilities,
  probeBridgeExecutionCapabilities,
  type BridgeCapabilitiesResult,
  type BridgeLaunchOptions,
  type BridgeLaunchSessionRef,
} from "@hachi/adapters";
import { savePromptArtifact } from "../artifacts.js";
import {
  bridgeNativeDeliveryRequirements,
  executionOverrideRequirements,
  hasRequiredNativeDelivery,
  probeExecutionCompatibility,
  resolveExecutionTransport,
  type ExecutionBridgeCapabilities,
  type ExecutionCompatibilityDecision,
  type ExecutionOverrideRequirements,
  type ExecutionTransportDecision,
  type StageDepsWithExecutionPreflight,
} from "../execution-preflight.js";
import {
  CONFIG_FILE_SNAPSHOT_META_KEY,
  reloadDispatchConfig,
  tryReadConfigFileSnapshot,
  type ConfigFileSnapshot,
} from "../config-protection.js";
import { SUPERVISOR_ACTOR } from "../constants.js";
import { classifyProviderFailureDiagnostic } from "../fence-extraction.js";
import {
  captureLaunchSnapshotBestEffort,
  HANDOFF_GIT_LAUNCH_META_KEY,
  handoffGitEvidenceProbe,
  type HandoffGitLaunchSnapshot,
} from "../handoff-git-evidence.js";
import { buildWorkerPrompt } from "../prompt.js";
import { countOpenQuestionAwaitingRuns } from "../question-awaiting.js";
import { readRuntimeResourcePromptContext } from "../runtime-resource-prompt-context.js";
import { loadRuntimeResourcesConfig } from "../runtime-resource-config.js";
import { synchronizeRuntimeResourceManifestFence } from "../runtime-resource-manifest.js";
import {
  evaluateRuntimeResourceDispatchGate,
  requestExactRuntimeResourceCleanup,
  requestRuntimeResourceCleanup,
  validateRuntimeResourceBindings,
  type RuntimeResourceBinding,
  type RuntimeResourceStore,
} from "../runtime-resource-dispatch.js";
import { countOpenReviewerRuns } from "./review.js";
import { cancelledOpenRunForTaskOrWorktree } from "./cancel.js";
import {
  isIndeterminateLaunchFailure,
  LAUNCH_INDETERMINATE_PREFIX,
  probeIndeterminateLaunch,
} from "./launch-outcome.js";
import { nativeLaunchSelected, persistNativeTargetBinding, pickNativeWorkerAdapter } from "../native-delivery.js";

const AUTO_LAUNCH_FAILED_PREFIX = "auto-launch-failed:";
const AUTO_LAUNCH_RETRY_MAX_ATTEMPTS = 2;
const AUTO_LAUNCH_RETRY_BACKOFF_SECONDS: readonly number[] = [0, 60];
const DEFAULT_CLAUDE_LAUNCHES_PER_TICK = 1;
const BRIDGE_NATIVE_MISSING_REASON = "needs-manual: bridge native 確認欠落";
const BRIDGE_NATIVE_MISSING_INTERRUPT =
  "【supervisor】bridge native 確認が欠落したため、この run は採用されません。直ちに全ての作業を中止し、" +
  'hachi-handoff-v1 (outcome="review", summary="bridge native 確認欠落のため中止") を出力して終了してください。';
const EXECUTION_FENCE_DRIFT_REASON = "needs-manual: worker execution設定/configがlaunch中に変更されました";
const EXECUTION_FENCE_DRIFT_INTERRUPT =
  "【supervisor】worker起動後にexecution設定/configの競合を検知したため、このrunは採用されません。直ちに終了してください。";

interface ResolvedDispatchPreflight {
  transportDecision: TransportDecision;
  compatibility: ExecutionCompatibilityDecision;
}

/** task.body から作業ディレクトリを抽出する。行が無い場合は null */
function extractCwd(body: string): string | null {
  return extractTaskBodyCwd(body);
}

function invalidTaskBodyReason(
  error: NonNullable<ReturnType<typeof findTaskBodyValidationError>>,
): string {
  const details = error.details;
  return `needs-manual: task body validation failed (code=${error.code}, escape=${details.escape}, physicalLine=${details.physicalLine}, trigger=${details.trigger})`;
}

/**
 * task body validation 失敗の分類結果。
 * - blocked: 現在の body も不正で、block reason と監査 event を記録した
 * - body-now-valid: 並行 edit-body で本文が修正済みだったため block しなかった
 * - cas-lost: 観測時と状態が変わっており、この tick では分類しない
 */
type TaskBodyValidationClassification =
  | { status: "blocked"; reason: string }
  | { status: "body-now-valid" }
  | { status: "cas-lost" };

function recordTaskBodyValidationFailure(
  store: KanbanStore,
  task: TaskRow,
  retryPlan: AutoLaunchRetryPlan | undefined,
): TaskBodyValidationClassification {
  // 現在 body の再検証・retry候補の再検査・block reason更新・監査eventを一つのTxに束ねる。
  // 事前に取得した body で block すると、並行 edit-body で修正済みの task を stale error で
  // block してしまうため、CAS 対象は必ず transaction 内で読み直した body にする。
  return store.transaction<TaskBodyValidationClassification>(() => {
    const current = store.getTask(task.id);
    if (current === null) {
      return { status: "cas-lost" };
    }
    const currentError = findTaskBodyValidationError(current.body);
    if (currentError === null) {
      return { status: "body-now-valid" };
    }
    const reason = invalidTaskBodyReason(currentError);

    let classified = false;
    if (retryPlan === undefined) {
      classified = store.blockIfReadyUnclaimed(task.id, reason, SUPERVISOR_ACTOR);
    } else if (
      isAutoLaunchFailedTask(current) &&
      current.blockReason === retryPlan.previousReason &&
      // 秒精度の updatedAt だけでは同一秒内の body 更新を検出できないため、
      // 観測時の body ハッシュ一致も CAS 条件に加える。
      sha256Hex(current.body) === retryPlan.failureBodyHash &&
      current.updatedAt === retryPlan.failureUpdatedAt &&
      store.getLatestOpenRun(task.id) === null
    ) {
      store.updateBlockReason(task.id, reason, SUPERVISOR_ACTOR);
      classified = true;
    }
    if (!classified) {
      return { status: "cas-lost" };
    }
    store.addEvent(task.id, "task_body_validation_failed", SUPERVISOR_ACTOR, {
      ...currentError.details,
    });
    return { status: "blocked", reason };
  });
}

/**
 * direct adapter の stop() を呼び出し、StopResult を検査する（契約 §34.2.1）。
 * stop() は例外を投げなくても stopped:false（already-exited/unsupported/unsignalable/
 * kill-unconfirmed）を返しうる。**戻り値の reason は stopped の値に関わらず必ず証拠として
 * 記録する**（契約 §34.2.1「戻り値を検査し、reason を証拠へ残すこと」）。
 * `unsignalable`/`kill-unconfirmed`（＝この呼び出しで停止を確認できなかった）は warn、
 * `already-exited`/`unsupported`（＝ベストエフォート cleanup の想定内の結果）は info で残し、
 * ログレベルだけを分ける。context には呼び出し元の状況を表す短い日本語ラベルを渡す。
 */
async function stopDirectSessionAndWarn(
  adapter: WorkerAdapter,
  ref: SessionRef,
  logger: StageDeps["logger"],
  taskId: string,
  context: string,
): Promise<void> {
  if (adapter.stop === undefined) {
    return;
  }
  try {
    const result = await adapter.stop(ref);
    const fields = { taskId, sessionId: redactText(ref.sessionId), reason: result.reason };
    if (!result.stopped) {
      if (result.reason === "unsignalable" || result.reason === "kill-unconfirmed") {
        logger.warn(`dispatch: ${context}の停止を確認できませんでした`, fields);
      } else {
        logger.info(`dispatch: ${context}は停止呼び出し不要でした（想定内）`, fields);
      }
    } else {
      // 契約 §34.2.1: 成功2値（terminated/killed）も stopped:false の4値と同じく reason を
      // 証拠として記録する。stopped:false のときだけ記録すると成功経路の reason が欠落する。
      logger.info(`dispatch: ${context}が完了しました`, fields);
    }
  } catch (error) {
    logger.warn(`dispatch: ${context}に失敗しました`, {
      taskId,
      sessionId: redactText(ref.sessionId),
      error: redactText(error instanceof Error ? error.message : String(error)),
    });
  }
}

/** resource profile taskの各launch fenceでcurrent host configを読み直す。 */
function currentRuntimeResources(deps: StageDeps): RuntimeResourcesConfig | undefined {
  try {
    return loadRuntimeResourcesConfig(join(deps.env.home, "config.json"));
  } catch (error) {
    deps.logger.warn("dispatch: current runtime resource config を解決できません", {
      error: redactText(error instanceof Error ? error.message : String(error)),
    });
    return undefined;
  }
}

interface LessonReadableStore {
  listRecentLessons(tenant: string, cwd: string, limit: number): LessonRow[];
}

interface DispatchProviderLaunchLimitsConfig {
  dispatch?: {
    providerLaunchLimits?: Partial<Record<Provider, number>>;
  };
}

interface StageDepsWithExternalRuntimeGenerationReader extends StageDeps {
  externalRuntimeGenerationReader?: ExternalRuntimeGenerationReader;
}

interface AutoLaunchRetryPlan {
  expectedRetryCount: number;
  attempt: number;
  previousReason: string;
  failureUpdatedAt: number;
  /** 観測時 body の sha256。秒精度 updatedAt では拾えない同一秒内の body 更新を検出する。 */
  failureBodyHash: string;
  seriesStartEventId: number;
}

interface DispatchCandidate {
  task: TaskRow;
  autoLaunchRetry?: AutoLaunchRetryPlan;
}

export type DispatchBridgeCapabilities = ExecutionBridgeCapabilities;
export type TransportDecision = ExecutionTransportDecision;

class RetryClaimRollback extends Error {
  constructor() {
    super("auto-launch retry claim rollback");
  }
}

function hasLessonReader(store: KanbanStore): store is KanbanStore & LessonReadableStore {
  return "listRecentLessons" in store && typeof store.listRecentLessons === "function";
}

function recentLessonsForTask(store: KanbanStore, task: TaskRow, cwd: string): LessonRow[] {
  if (!hasLessonReader(store)) {
    return [];
  }
  return store.listRecentLessons(task.tenant, cwd, 3);
}

/** cwd パスのディレクトリ検証。存在しない / ディレクトリではない場合はエラー理由を返す */
function validateCwdDirectory(cwdPath: string): string | null {
  try {
    const stat = statSync(cwdPath);
    if (!stat.isDirectory()) {
      return `user-decision: cwd がディレクトリではありません (${cwdPath})`;
    }
    return null;
  } catch {
    return `user-decision: cwd ディレクトリが存在しません (${cwdPath})`;
  }
}

interface DependencyWaitPayload {
  dependencyIds: string[];
  payloadHash: string;
}

/** done/archived は依存ゲート上の充足済み前提として扱う（docs/contract.md §24.2） */
function isDependencyFulfilled(task: TaskRow): boolean {
  return task.status === "done" || task.status === "archived";
}

/** 未充足前提 ID を「集合」として扱うため、ソート済み ID リストに正規化する */
function unmetDependencyIds(task: TaskRow, store: KanbanStore): string[] {
  return store
    .dependencies(task.id)
    .filter((dependency) => !isDependencyFulfilled(dependency))
    .map((dependency) => dependency.id)
    .sort();
}

function dependencyWaitPayloadHash(dependencyIds: string[]): string {
  return sha256Hex(JSON.stringify({ dependencyIds }));
}

function dependencyWaitPayload(dependencyIds: string[]): DependencyWaitPayload {
  return {
    dependencyIds,
    payloadHash: dependencyWaitPayloadHash(dependencyIds),
  };
}

function normalizeDependencyIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (!value.every((item): item is string => typeof item === "string")) {
    return null;
  }
  return [...value].sort();
}

/** 同一未充足集合の dependency_wait を重複記録しない */
function hasDependencyWaitEvent(store: KanbanStore, taskId: string, payload: DependencyWaitPayload): boolean {
  return store.listEvents(taskId, "dependency_wait").some((event) => {
    try {
      const parsed = JSON.parse(event.payload) as { dependencyIds?: unknown; payloadHash?: unknown };
      if (typeof parsed.payloadHash === "string") {
        return parsed.payloadHash === payload.payloadHash;
      }

      const dependencyIds = normalizeDependencyIds(parsed.dependencyIds);
      return dependencyIds !== null && dependencyWaitPayloadHash(dependencyIds) === payload.payloadHash;
    } catch {
      return false;
    }
  });
}

function recordDependencyWaitIfNeeded(store: KanbanStore, taskId: string, dependencyIds: string[]): boolean {
  const payload = dependencyWaitPayload(dependencyIds);
  return store.transaction(() => {
    if (hasDependencyWaitEvent(store, taskId, payload)) {
      return false;
    }
    store.addEvent(taskId, "dependency_wait", SUPERVISOR_ACTOR, {
      dependencyIds: payload.dependencyIds,
      payloadHash: payload.payloadHash,
    });
    return true;
  });
}

function configuredProviderLaunchLimit(config: HachiConfig, provider: Provider): number {
  const dispatchConfig = (config as HachiConfig & DispatchProviderLaunchLimitsConfig).dispatch;
  const configuredLimit = dispatchConfig?.providerLaunchLimits?.[provider];
  if (configuredLimit !== undefined) {
    return configuredLimit;
  }
  return provider === "claude" ? DEFAULT_CLAUDE_LAUNCHES_PER_TICK : config.resourceGuard.maxLaunchesPerTick;
}

function providerLaunchLimitReached(
  config: HachiConfig,
  provider: Provider,
  providerLaunchesThisTick: Record<Provider, number>,
): boolean {
  return providerLaunchesThisTick[provider] >= configuredProviderLaunchLimit(config, provider);
}

function providerLimitNote(config: HachiConfig, provider: Provider, taskId: string): string {
  return `${taskId}: resource guard: dispatch.providerLaunchLimits.${provider}(${configuredProviderLaunchLimit(
    config,
    provider,
  )}) に到達したため provider 別起動をスキップします`;
}

function hasOverrideRequirement(requirements: ExecutionOverrideRequirements): boolean {
  return requirements.model || requirements.effort || requirements.speed === true || requirements.maxTurns === true;
}

/** 現行 Claude bridge adapter が固定 maxTurns を送る起動だけ事前 capability 対象にする。 */
function bridgeMaxTurnsRequested(
  resolution: Extract<ModelResolution, { ok: true }>,
  useNativeLaunch: boolean,
): boolean {
  return resolution.provider === "claude" && resolution.transport === "bridge" && !useNativeLaunch;
}

export function resolveTransport(
  resolution: Extract<ModelResolution, { ok: true }>,
  capabilities: DispatchBridgeCapabilities,
  requirements: ExecutionOverrideRequirements,
): TransportDecision {
  return resolveExecutionTransport(resolution, capabilities, requirements);
}

function bridgeCapabilitiesFromProbe(result: BridgeCapabilitiesResult): DispatchBridgeCapabilities {
  if (result.ok) {
    return { status: "known", capabilities: result.capabilities };
  }
  return {
    status: "unknown",
    detail: `${result.failure.kind}${result.failure.status !== undefined ? `:${result.failure.status}` : ""}`,
  };
}

function compatibilityBlockReason(decision: Exclude<ExecutionCompatibilityDecision, { status: "supported" }>): string {
  const detail = redactText(decision.detail).slice(0, 300);
  if (decision.status === "unsupported") {
    return `needs-manual: incompatible_model_transport (${decision.reason}: ${detail})`;
  }
  return `needs-manual: model_transport_compatibility_unknown (${decision.reason}: ${detail})`;
}

function compatibilityEventType(
  decision: Exclude<ExecutionCompatibilityDecision, { status: "supported" }>,
): "incompatible_model_transport" | "model_transport_compatibility_unknown" {
  return decision.status === "unsupported"
    ? "incompatible_model_transport"
    : "model_transport_compatibility_unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isModelPassthroughRejected(error: unknown): boolean {
  if (!(error instanceof BridgeError) || error.status !== 409 || !isRecord(error.body)) {
    return false;
  }
  return error.body["code"] === "model-passthrough-rejected" && error.body["sessionCreated"] === false;
}

function runMeta(
  ref: BridgeLaunchSessionRef,
  resolution: Extract<ModelResolution, { ok: true }>,
  transport: Transport,
  profile: string,
  configSnapshot: unknown,
  gitLaunchSnapshot: HandoffGitLaunchSnapshot,
): Record<string, unknown> {
  return {
    role: "worker",
    profile,
    source: resolution.source,
    serverUrl: ref.serverUrl,
    model: resolution.model,
    modelDelivery: ref.modelDelivery,
    transport,
    ...(resolution.effort !== undefined ? { effort: resolution.effort } : {}),
    ...(ref.effortDelivery !== undefined ? { effortDelivery: ref.effortDelivery } : {}),
    ...(resolution.speed !== undefined ? { speed: resolution.speed } : {}),
    ...(ref.speedDelivery !== undefined ? { speedDelivery: ref.speedDelivery } : {}),
    ...(ref.requestedMaxTurns !== undefined ? { requestedMaxTurns: ref.requestedMaxTurns } : {}),
    ...(ref.maxTurnsDelivery !== undefined ? { maxTurnsDelivery: ref.maxTurnsDelivery } : {}),
    ...(ref.appliedModel !== undefined ? { appliedModel: ref.appliedModel } : {}),
    ...(ref.appliedEffort !== undefined ? { appliedEffort: ref.appliedEffort } : {}),
    ...(ref.appliedSpeed !== undefined ? { appliedSpeed: ref.appliedSpeed } : {}),
    ...(ref.appliedMaxTurns !== undefined ? { appliedMaxTurns: ref.appliedMaxTurns } : {}),
    ...(ref.nativeCommunication === undefined ? {} : { nativeCommunication: ref.nativeCommunication }),
    ...(configSnapshot !== null ? { [CONFIG_FILE_SNAPSHOT_META_KEY]: configSnapshot } : {}),
    [HANDOFF_GIT_LAUNCH_META_KEY]: gitLaunchSnapshot,
  };
}

/** worker launchへ影響するtask側入力のsecret-free fingerprint。claim_lock/updated_atは除外する。 */
function workerExecutionSettingsFingerprint(task: TaskRow, config: HachiConfig): string {
  const profile = task.profile !== "" ? task.profile : config.defaultProfile;
  return sha256Hex(JSON.stringify({
    role: "worker",
    title: task.title,
    bodyHash: sha256Hex(task.body),
    tenant: task.tenant,
    profile,
    profileEntry: config.profiles[profile] ?? null,
    provider: task.provider,
    model: task.modelOverride,
    effort: task.effortOverride,
    speed: task.speedOverride,
  }));
}

/** file snapshot外のin-memory policy差替えも検知する。 */
function executionPolicyFingerprint(config: HachiConfig): string {
  return sha256Hex(JSON.stringify(config));
}

function sameConfigSnapshot(left: ConfigFileSnapshot, right: ConfigFileSnapshot | null): boolean {
  return right !== null &&
    left.exists === right.exists &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size &&
    left.hash === right.hash;
}

function isAutoLaunchFailedTask(task: TaskRow): boolean {
  return task.status === "blocked" && task.blockReason.startsWith(AUTO_LAUNCH_FAILED_PREFIX);
}

function eventPayloadObject(event: EventRow): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(event.payload);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isCurrentBlockStatusEvent(event: EventRow, task: TaskRow): boolean {
  const payload = eventPayloadObject(event);
  return payload?.to === "blocked" && payload.reason === task.blockReason;
}

function latestCurrentBlockStatusEventFromEvents(events: EventRow[], task: TaskRow): EventRow | null {
  let latest: EventRow | null = null;
  for (const event of events) {
    if (isCurrentBlockStatusEvent(event, task)) {
      latest = event;
    }
  }
  return latest;
}

function latestCurrentBlockStatusEvent(store: KanbanStore, task: TaskRow): EventRow | null {
  return latestCurrentBlockStatusEventFromEvents(store.listEvents(task.id, "status_changed"), task);
}

function isReviewOrReworkLaunchFailedEvent(event: EventRow): boolean {
  return event.eventType === "reviewer_launch_failed" || event.eventType === "rework_launch_failed";
}

function isReviewOrReworkAutoLaunchFailedTask(store: KanbanStore, task: TaskRow): boolean {
  if (!isAutoLaunchFailedTask(task)) {
    return false;
  }

  const blockEvent = latestCurrentBlockStatusEvent(store, task);
  if (blockEvent !== null) {
    return store.listEvents(task.id).some(
      (event) => event.id > blockEvent.id && isReviewOrReworkLaunchFailedEvent(event),
    );
  }

  // 旧データや手動投入で origin event が欠けた場合も、review/rework 固有の理由は worker retry に混ぜない。
  return (
    task.blockReason.startsWith("auto-launch-failed: レビュー起動に失敗しました") ||
    task.blockReason.startsWith("auto-launch-failed: rework 起動に失敗しました")
  );
}

function isAutoLaunchFailedBlockStatusEvent(event: EventRow): boolean {
  const payload = eventPayloadObject(event);
  return (
    event.eventType === "status_changed" &&
    payload?.to === "blocked" &&
    typeof payload.reason === "string" &&
    payload.reason.startsWith(AUTO_LAUNCH_FAILED_PREFIX)
  );
}

function isRetryReadyStatusEvent(event: EventRow): boolean {
  const payload = eventPayloadObject(event);
  return (
    event.eventType === "status_changed" &&
    event.actor === SUPERVISOR_ACTOR &&
    payload?.from === "blocked" &&
    payload.to === "ready"
  );
}

function previousStatusEventIndex(events: EventRow[], beforeIndex: number): number {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    if (events[index]?.eventType === "status_changed") {
      return index;
    }
  }
  return -1;
}

function linkedPreviousAutoLaunchFailedBlockIndex(events: EventRow[], currentBlockIndex: number): number | null {
  let retryStartedIndex = -1;
  for (let index = currentBlockIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) {
      continue;
    }
    if (event.eventType === "status_changed") {
      return null;
    }
    if (event.eventType === "auto_launch_retry_started") {
      retryStartedIndex = index;
      break;
    }
  }
  if (retryStartedIndex === -1) {
    return null;
  }

  const retryReadyIndex = previousStatusEventIndex(events, retryStartedIndex);
  if (retryReadyIndex === -1 || !isRetryReadyStatusEvent(events[retryReadyIndex]!)) {
    return null;
  }

  const previousBlockIndex = previousStatusEventIndex(events, retryReadyIndex);
  if (previousBlockIndex === -1 || !isAutoLaunchFailedBlockStatusEvent(events[previousBlockIndex]!)) {
    return null;
  }
  return previousBlockIndex;
}

function isCurrentAutoLaunchFailureEstablishingEvent(event: EventRow, task: TaskRow): boolean {
  const payload = eventPayloadObject(event);
  if (payload === null) {
    return false;
  }
  if (event.eventType === "status_changed") {
    return payload.to === "blocked" && payload.reason === task.blockReason;
  }
  return event.eventType === "block_reason_updated" && payload.reason === task.blockReason;
}

function latestCurrentAutoLaunchFailureEvent(events: EventRow[], task: TaskRow): EventRow | null {
  let latest: EventRow | null = null;
  for (const event of events) {
    if (isCurrentAutoLaunchFailureEstablishingEvent(event, task)) {
      latest = event;
    }
  }
  return latest;
}

function autoLaunchRetrySeriesStartEventId(store: KanbanStore, task: TaskRow): number {
  const events = store.listEvents(task.id);
  const currentFailureEvent = latestCurrentAutoLaunchFailureEvent(events, task);
  if (currentFailureEvent === null) {
    return events.at(-1)?.id ?? 0;
  }

  let seriesStartIndex = events.findIndex((event) => event.id === currentFailureEvent.id);
  if (seriesStartIndex === -1) {
    return currentFailureEvent.id;
  }

  while (events[seriesStartIndex]?.eventType === "status_changed") {
    const previousBlockIndex = linkedPreviousAutoLaunchFailedBlockIndex(events, seriesStartIndex);
    if (previousBlockIndex === null) {
      break;
    }
    seriesStartIndex = previousBlockIndex;
  }

  return events[seriesStartIndex]?.id ?? currentFailureEvent.id;
}

function autoLaunchRetryStartedCountAfterEvent(store: KanbanStore, taskId: string, eventId: number): number {
  return store.listEvents(taskId, "auto_launch_retry_started").filter((event) => event.id > eventId).length;
}

function autoLaunchRetryStartedCount(store: KanbanStore, task: TaskRow): number {
  return autoLaunchRetryStartedCountAfterEvent(store, task.id, autoLaunchRetrySeriesStartEventId(store, task));
}

function autoLaunchRetryBackoffSeconds(attempt: number): number {
  const lastIndex = AUTO_LAUNCH_RETRY_BACKOFF_SECONDS.length - 1;
  return AUTO_LAUNCH_RETRY_BACKOFF_SECONDS[attempt - 1] ?? AUTO_LAUNCH_RETRY_BACKOFF_SECONDS[lastIndex] ?? 0;
}

function moveAutoLaunchRetryToNeedsManual(store: KanbanStore, task: TaskRow): boolean {
  return store.transaction(() => {
    const current = store.getTask(task.id);
    if (current === null || !isAutoLaunchFailedTask(current) || store.getLatestOpenRun(task.id) !== null) {
      return false;
    }
    const currentRetryCount = autoLaunchRetryStartedCount(store, current);
    if (currentRetryCount < AUTO_LAUNCH_RETRY_MAX_ATTEMPTS) {
      return false;
    }

    const reason = `needs-manual: auto-launch-failed retry 上限到達 (${currentRetryCount}回)`;
    store.addEvent(task.id, "auto_launch_retry_exhausted", SUPERVISOR_ACTOR, {
      attempts: currentRetryCount,
      previousReason: current.blockReason,
    });
    store.updateBlockReason(task.id, reason, SUPERVISOR_ACTOR, "human");
    return true;
  });
}

function collectAutoLaunchRetryCandidates(
  store: KanbanStore,
  apply: boolean,
  now: number,
  notes: string[],
): { actions: number; candidates: DispatchCandidate[] } {
  let actions = 0;
  const candidates: DispatchCandidate[] = [];
  const blockedTasks = store.listByStatus("blocked");
  for (const task of blockedTasks) {
    if (!isAutoLaunchFailedTask(task)) {
      continue;
    }
    if (isReviewOrReworkAutoLaunchFailedTask(store, task)) {
      notes.push(`${task.id}: review/rework 起動失敗の auto-launch-failed は dispatch retry 対象外です`);
      continue;
    }
    if (store.getLatestOpenRun(task.id) !== null) {
      notes.push(`${task.id}: open run が残っているため auto-launch retry は reap に任せます`);
      continue;
    }

    const seriesStartEventId = autoLaunchRetrySeriesStartEventId(store, task);
    const retryCount = autoLaunchRetryStartedCountAfterEvent(store, task.id, seriesStartEventId);
    if (retryCount >= AUTO_LAUNCH_RETRY_MAX_ATTEMPTS) {
      const reason = `needs-manual: auto-launch-failed retry 上限到達 (${retryCount}回)`;
      if (!apply) {
        actions += 1;
        notes.push(`${task.id}: dry-run: ${reason} へ付け替え予定`);
        continue;
      }
      if (moveAutoLaunchRetryToNeedsManual(store, task)) {
        actions += 1;
        notes.push(`${task.id}: ${reason}`);
      }
      continue;
    }

    const attempt = retryCount + 1;
    const backoffSeconds = autoLaunchRetryBackoffSeconds(attempt);
    const elapsedSeconds = now - task.updatedAt;
    if (elapsedSeconds < backoffSeconds) {
      notes.push(
        `${task.id}: auto-launch retry backoff 待機中 (attempt=${attempt}/${AUTO_LAUNCH_RETRY_MAX_ATTEMPTS}, remaining=${
          backoffSeconds - elapsedSeconds
        }s)`,
      );
      continue;
    }

    if (!apply) {
      notes.push(
        `${task.id}: dry-run: auto-launch retry ${attempt}/${AUTO_LAUNCH_RETRY_MAX_ATTEMPTS} の起動候補として扱います`,
      );
    }

    candidates.push({
      task,
      autoLaunchRetry: {
        expectedRetryCount: retryCount,
        attempt,
        previousReason: task.blockReason,
        failureUpdatedAt: task.updatedAt,
        failureBodyHash: sha256Hex(task.body),
        seriesStartEventId,
      },
    });
  }
  return { actions, candidates };
}

function compareDispatchCandidates(left: DispatchCandidate, right: DispatchCandidate): number {
  if (left.task.priority !== right.task.priority) {
    return right.task.priority - left.task.priority;
  }
  if (left.task.createdAt !== right.task.createdAt) {
    return left.task.createdAt - right.task.createdAt;
  }
  return left.task.id.localeCompare(right.task.id);
}

function claimAutoLaunchRetry(
  store: KanbanStore,
  task: TaskRow,
  claimToken: string,
  plan: AutoLaunchRetryPlan,
): boolean {
  try {
    return store.transaction(() => {
      const current = store.getTask(task.id);
      if (
        current === null ||
        !isAutoLaunchFailedTask(current) ||
        current.blockReason !== plan.previousReason ||
        current.updatedAt !== plan.failureUpdatedAt ||
        store.getLatestOpenRun(task.id) !== null
      ) {
        return false;
      }

      const currentRetryCount = autoLaunchRetryStartedCount(store, current);
      if (
        currentRetryCount !== plan.expectedRetryCount ||
        currentRetryCount >= AUTO_LAUNCH_RETRY_MAX_ATTEMPTS
      ) {
        return false;
      }

      store.unblock(task.id, "ready", SUPERVISOR_ACTOR);
      if (!store.claimTask(task.id, claimToken, SUPERVISOR_ACTOR)) {
        throw new RetryClaimRollback();
      }
      return true;
    });
  } catch (err) {
    if (err instanceof RetryClaimRollback) {
      return false;
    }
    throw err;
  }
}

function restoreAutoLaunchRetryBlock(
  store: KanbanStore,
  taskId: string,
  claimToken: string,
  plan: AutoLaunchRetryPlan,
): boolean {
  return store.blockClaimedTask(taskId, claimToken, plan.previousReason, SUPERVISOR_ACTOR);
}

function recordAutoLaunchRetryStarted(
  store: KanbanStore,
  taskId: string,
  claimToken: string,
  plan: AutoLaunchRetryPlan,
): boolean {
  return store.transaction(() => {
    const current = store.getTask(taskId);
    if (current === null || current.status !== "ready" || current.claimLock !== claimToken) {
      return false;
    }
    if (store.getLatestOpenRun(taskId) !== null) {
      return false;
    }

    const currentRetryCount = autoLaunchRetryStartedCountAfterEvent(store, taskId, plan.seriesStartEventId);
    if (
      currentRetryCount !== plan.expectedRetryCount ||
      currentRetryCount >= AUTO_LAUNCH_RETRY_MAX_ATTEMPTS
    ) {
      return false;
    }

    store.addEvent(taskId, "auto_launch_retry_started", SUPERVISOR_ACTOR, {
      attempt: plan.attempt,
      maxAttempts: AUTO_LAUNCH_RETRY_MAX_ATTEMPTS,
      failureUpdatedAt: plan.failureUpdatedAt,
      previousReason: plan.previousReason,
      seriesStartEventId: plan.seriesStartEventId,
    });
    return true;
  });
}

function ensureAutoLaunchRetryStarted(
  store: KanbanStore,
  taskId: string,
  claimToken: string,
  plan: AutoLaunchRetryPlan,
  logger: StageDeps["logger"],
  notes: string[],
): boolean {
  if (recordAutoLaunchRetryStarted(store, taskId, claimToken, plan)) {
    return true;
  }

  const restored = restoreAutoLaunchRetryBlock(store, taskId, claimToken, plan);
  if (!restored) {
    logger.warn("dispatch: auto-launch retry 開始記録時に claim 状態が変化していました", {
      taskId,
    });
  }
  notes.push(`${taskId}: auto-launch retry 開始記録に失敗したため起動をスキップしました`);
  return false;
}

function blockCompatibilityBeforeClaim(
  store: KanbanStore,
  task: TaskRow,
  retryPlan: AutoLaunchRetryPlan | undefined,
  decision: Exclude<ExecutionCompatibilityDecision, { status: "supported" }>,
  resolution: Extract<ModelResolution, { ok: true }>,
  transport: Transport,
): boolean {
  const reason = compatibilityBlockReason(decision);
  return store.transaction(() => {
    let blocked = false;
    if (retryPlan === undefined) {
      blocked = store.blockIfReadyUnclaimed(task.id, reason, SUPERVISOR_ACTOR, "human");
    } else {
      const current = store.getTask(task.id);
      if (
        current !== null &&
        isAutoLaunchFailedTask(current) &&
        current.blockReason === retryPlan.previousReason &&
        current.updatedAt === retryPlan.failureUpdatedAt &&
        store.getLatestOpenRun(task.id) === null
      ) {
        store.updateBlockReason(task.id, reason, SUPERVISOR_ACTOR, "human");
        blocked = true;
      }
    }
    if (!blocked) {
      return false;
    }
    store.addEvent(task.id, compatibilityEventType(decision), SUPERVISOR_ACTOR, {
      provider: resolution.provider,
      model: resolution.model,
      transport,
      status: decision.status,
      reason: decision.reason,
      detail: redactText(decision.detail),
      expectation: decision.expectation,
      observed: decision.observed,
    });
    return true;
  });
}

function blockClaimedCompatibility(
  store: KanbanStore,
  taskId: string,
  claimToken: string,
  decision: Exclude<ExecutionCompatibilityDecision, { status: "supported" }>,
  resolution: Extract<ModelResolution, { ok: true }>,
  transport: Transport,
): boolean {
  const reason = compatibilityBlockReason(decision);
  return store.transaction(() => {
    if (!store.blockClaimedTask(taskId, claimToken, reason, SUPERVISOR_ACTOR, "human")) {
      return false;
    }
    store.addEvent(taskId, compatibilityEventType(decision), SUPERVISOR_ACTOR, {
      provider: resolution.provider,
      model: resolution.model,
      transport,
      status: decision.status,
      reason: decision.reason,
      detail: redactText(decision.detail),
      expectation: decision.expectation,
      observed: decision.observed,
    });
    return true;
  });
}

/**
 * claim 後に確定した supported 判定だけを durable event として記録する。
 * pre-claim 判定はここでは記録せず、claim fence を再検証した最終判定を1回だけ残す。
 */
function recordClaimedSupportedCompatibility(
  store: KanbanStore,
  taskId: string,
  claimToken: string,
  decision: Extract<ExecutionCompatibilityDecision, { status: "supported" }>,
  resolution: Extract<ModelResolution, { ok: true }>,
  transport: Transport,
): boolean {
  return store.transaction(() => {
    const current = store.getTask(taskId);
    if (current === null || current.status !== "ready" || current.claimLock !== claimToken) {
      return false;
    }
    store.addEvent(taskId, "model_transport_compatibility_checked", SUPERVISOR_ACTOR, {
      provider: resolution.provider,
      model: resolution.model,
      transport,
      status: decision.status,
      evidence: decision.evidence,
      expectation: decision.expectation,
      observed: decision.observed,
    });
    return true;
  });
}

export const dispatchStage: Stage = {
  name: "dispatch",

  async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
    const { store, env, adapters, directAdapters, logger } = deps;
    const preflightDeps = deps as StageDepsWithExecutionPreflight;
    const runtimeStore = store as RuntimeResourceStore;
    const notes: string[] = [];
    const config = reloadDispatchConfig(deps, notes);
    const configSnapshot = tryReadConfigFileSnapshot(env, logger, { stage: "dispatch" });
    if (configSnapshot === null) {
      notes.push("dispatch: config snapshotを取得できないためworker起動をfail-closedしました");
      return { name: "dispatch", actions: 0, skipped: false, notes };
    }
    const configPolicyFingerprint = executionPolicyFingerprint(config);
    const retryPreparation = collectAutoLaunchRetryCandidates(store, apply, now, notes);
    let actions = retryPreparation.actions;

    const candidates: DispatchCandidate[] = [
      ...store.listByStatus("ready").map((task) => ({ task })),
      ...retryPreparation.candidates,
    ].sort(compareDispatchCandidates);
    // 契約 §15.1/§52.4: maxInFlight は reviewer run と question_awaiting run も枠消費に含める。
    let inFlightCount =
      store.listInProgress().length + countOpenReviewerRuns(store) + countOpenQuestionAwaitingRuns(store, now);
    let launchesThisTick = 0;
    const providerLaunchesThisTick: Record<Provider, number> = { codex: 0, claude: 0 };
    let processed = 0;
    const capabilitiesCache = new Map<Provider, DispatchBridgeCapabilities>();

    const capabilitiesForProvider = async (provider: Provider): Promise<DispatchBridgeCapabilities> => {
      const cached = capabilitiesCache.get(provider);
      if (cached !== undefined) {
        return cached;
      }
      const probed = provider === "codex"
        ? bridgeCapabilitiesFromProbe(await probeBridgeCapabilities(env.bridges.codex))
        : await probeBridgeExecutionCapabilities(env.bridges[provider], provider).then((result) =>
            result.ok
              ? { status: "known" as const, capabilities: result.snapshot.capabilities }
              : {
                  status: "unknown" as const,
                  detail: `${result.failure.kind}${
                    result.failure.status !== undefined ? `:${result.failure.status}` : ""
                  }`,
                });
      capabilitiesCache.set(provider, probed);
      if (probed.status === "unknown") {
        logger.warn("dispatch: bridge capability probe が不明のため direct transport を選択します", {
          provider,
          detail: probed.detail,
        });
      }
      return probed;
    };

    for (const candidate of candidates) {
      const task = candidate.task;
      const retryPlan = candidate.autoLaunchRetry;
      processed += 1;

      // tick開始時にreloadしたpolicyとfile snapshotが変わった後は、同じtickのstale configで
      // preflight/claimを継続しない。次tickでreloadし直す。
      if (
        executionPolicyFingerprint(deps.config) !== configPolicyFingerprint ||
        !sameConfigSnapshot(
          configSnapshot,
          tryReadConfigFileSnapshot(env, logger, { stage: "dispatch", taskId: task.id }),
        )
      ) {
        notes.push(`${task.id}: configがdispatch tick中に変更されたため以降の起動をスキップしました`);
        break;
      }

      const cancelledWorktreeRun = cancelledOpenRunForTaskOrWorktree(store, task.id, extractCwd(task.body));
      if (cancelledWorktreeRun !== null) {
        notes.push(
          `${task.id}: cancel stop 証拠待ちの同一 worktree run があるため replacement を拒否します ` +
            `(runId=${cancelledWorktreeRun.id})`,
        );
        continue;
      }

      if (inFlightCount >= config.resourceGuard.maxInFlight) {
        const remaining = candidates.length - processed + 1;
        notes.push(
          `resource guard: maxInFlight(${config.resourceGuard.maxInFlight}) に到達したため残り ${remaining} 件をスキップします`,
        );
        break;
      }
      if (launchesThisTick >= config.resourceGuard.maxLaunchesPerTick) {
        const remaining = candidates.length - processed + 1;
        notes.push(
          `resource guard: maxLaunchesPerTick(${config.resourceGuard.maxLaunchesPerTick}) に到達したため残り ${remaining} 件をスキップします`,
        );
        break;
      }

      // 契約 §12.8-2: 既に claim_lock が付いている ready 行は他 supervisor が処理中 or stale の
      // いずれかであり、claim を試みずスキップする。起動予算（launchesThisTick）も actions も
      // 消費しない（何も実行していないため）。stale claim は reap ステージが定期的に解放する。
      if (task.claimLock !== "") {
        notes.push(`${task.id}: 既に claim 済みのためスキップします (claim_lock=${task.claimLock})`);
        continue;
      }

      const taskBodyError = findTaskBodyValidationError(task.body);
      if (taskBodyError !== null) {
        if (!apply) {
          actions += 1;
          notes.push(`${task.id}: dry-run: ${invalidTaskBodyReason(taskBodyError)}`);
          continue;
        }
        // 分類は transaction 内で読み直した body に対して行う。ここで保持している task.body は
        // 並行 edit-body 後には stale になり得るため、修正済みなら起動せず次 tick へ送る。
        const classification = recordTaskBodyValidationFailure(store, task, retryPlan);
        if (classification.status === "blocked") {
          actions += 1;
          notes.push(`${task.id}: ${classification.reason}`);
        } else if (classification.status === "body-now-valid") {
          notes.push(`${task.id}: 並行 edit-body で本文が修正済みのため block せず次 tick に委ねます`);
        } else {
          notes.push(`${task.id}: task body validation failure の分類 CAS が不成立でした`);
        }
        continue;
      }

      const blockedDependencyIds = unmetDependencyIds(task, store);
      if (blockedDependencyIds.length > 0) {
        const dependencyList = blockedDependencyIds.join(",");
        if (!apply) {
          notes.push(`${task.id}: dry-run: 依存未充足のため起動スキップ予定 (dependencies=${dependencyList})`);
          continue;
        }

        const recorded = recordDependencyWaitIfNeeded(store, task.id, blockedDependencyIds);
        notes.push(
          `${task.id}: 依存未充足のため起動スキップ (dependencies=${dependencyList}${
            recorded ? ", event=dependency_wait" : ""
          })`,
        );
        continue;
      }

      // 契約 §56.3: required resource が active/ready になる前は task claim 自体を行わない。
      // requirement が無い既存タスクは unconfigured として従来経路を維持する。
      const resourceGate = evaluateRuntimeResourceDispatchGate(
        env.dbPath,
        task.id,
        extractCwd(task.body),
        now,
        currentRuntimeResources(deps),
      );
      if (resourceGate.status === "waiting") {
        notes.push(`${task.id}: ${resourceGate.reason}。dispatch claim をスキップします`);
        continue;
      }
      if (resourceGate.status === "failed") {
        if (!apply) {
          actions += 1;
          notes.push(`${task.id}: dry-run: ${resourceGate.reason}`);
          continue;
        }
        if (retryPlan !== undefined) {
          notes.push(`${task.id}: ${resourceGate.reason}。auto-launch retry は現状の block を維持します`);
          continue;
        }
        if (store.blockIfReadyUnclaimed(task.id, resourceGate.reason, SUPERVISOR_ACTOR, "human")) {
          actions += 1;
          notes.push(`${task.id}: ${resourceGate.reason}`);
        } else {
          notes.push(`${task.id}: runtime resource failure block の CAS が不成立でした`);
        }
        continue;
      }

      const preClaimResolution = resolveModel(task, config);
      if (
        preClaimResolution.ok &&
        providerLaunchLimitReached(config, preClaimResolution.provider, providerLaunchesThisTick)
      ) {
        notes.push(providerLimitNote(config, preClaimResolution.provider, task.id));
        continue;
      }

      let preClaimPreflight: ResolvedDispatchPreflight | null = null;
      if (preClaimResolution.ok) {
        const preClaimUseNativeLaunch = nativeLaunchSelected(
          config,
          preClaimResolution.provider,
          task.id,
        );
        const preClaimRequirements: ExecutionOverrideRequirements = {
          ...executionOverrideRequirements(task, "worker"),
          ...(bridgeMaxTurnsRequested(preClaimResolution, preClaimUseNativeLaunch)
            ? { maxTurns: true }
            : {}),
        };
        const preClaimCapabilityState = hasOverrideRequirement(preClaimRequirements)
          ? await capabilitiesForProvider(preClaimResolution.provider)
          : ({ status: "known", capabilities: [] } as const);
        const preClaimTransportDecision = resolveTransport(
          preClaimResolution,
          preClaimCapabilityState,
          preClaimRequirements,
        );
        preClaimPreflight = {
          transportDecision: preClaimTransportDecision,
          compatibility: await probeExecutionCompatibility(
            preflightDeps,
            config,
            preClaimResolution,
            preClaimTransportDecision.transport,
            {
              ...preClaimRequirements,
              model: true,
              maxTurns: preClaimTransportDecision.transport === "bridge" &&
                preClaimRequirements.maxTurns === true,
            },
          ),
        };
        if (preClaimPreflight.compatibility.status !== "supported") {
          const reason = compatibilityBlockReason(preClaimPreflight.compatibility);
          if (!apply) {
            actions += 1;
            notes.push(`${task.id}: dry-run: ${reason}`);
          } else if (blockCompatibilityBeforeClaim(
            store,
            task,
            retryPlan,
            preClaimPreflight.compatibility,
            preClaimResolution,
            preClaimTransportDecision.transport,
          )) {
            actions += 1;
            notes.push(`${task.id}: ${reason}。worker claim/run/session は作成していません`);
          } else {
            notes.push(`${task.id}: model×transport preflight block の CAS が不成立でした`);
          }
          continue;
        }
      }

      if (!apply) {
        // dry-run は実際に claim せず DB へ書き込まないため、pre-claim スナップショット（task）で
        // 見積り判定する（claim 後の再読込は apply 時のみ意味を持つ）。
        const dryRunResolution = preClaimResolution;
        if (!dryRunResolution.ok) {
          actions += 1;
          notes.push(
            `${task.id}: user-decision: モデル解決に失敗 (${dryRunResolution.reason}: ${dryRunResolution.detail})`,
          );
          continue;
        }

        const dryRunCwd = extractCwd(task.body);
        if (dryRunCwd === null) {
          actions += 1;
          notes.push(`${task.id}: user-decision: cwd 未指定のため起動できません`);
          continue;
        }

        // cwd は絶対パス必須（docs/contract.md §12.4-5, fail-closed）
        if (!isAbsolute(dryRunCwd)) {
          actions += 1;
          notes.push(`${task.id}: user-decision: cwd が絶対パスではありません (${dryRunCwd})`);
          continue;
        }

        // cwd ディレクトリの実在・種別チェック（fail-closed）
        const dryRunCwdError = validateCwdDirectory(dryRunCwd);
        if (dryRunCwdError !== null) {
          actions += 1;
          notes.push(`${task.id}: ${dryRunCwdError}`);
          continue;
        }

        actions += 1;
        if (retryPlan !== undefined) {
          notes.push(
            `dry-run: ${task.id} を auto-launch retry ${retryPlan.attempt}/${AUTO_LAUNCH_RETRY_MAX_ATTEMPTS} で起動予定 (provider=${dryRunResolution.provider} model=${dryRunResolution.model})`,
          );
        } else {
          notes.push(
            `dry-run: ${task.id} を起動予定 (provider=${dryRunResolution.provider} model=${dryRunResolution.model})`,
          );
        }
        inFlightCount += 1;
        launchesThisTick += 1;
        providerLaunchesThisTick[dryRunResolution.provider] += 1;
        continue;
      }

      // 起動前の durable claim（docs/contract.md §12.7-1）。CAS（status='ready' かつ claim_lock=''）
      // により、並行 tick / 複数 supervisor インスタンスからの二重起動を防ぐ。
      // claim に失敗した場合は他プロセスが既に処理中とみなしこのタスクを skip する（fail-closed）。
      const claimToken = newNonce();
      const claimed =
        retryPlan !== undefined
          ? claimAutoLaunchRetry(store, task, claimToken, retryPlan)
          : store.claimTask(task.id, claimToken, SUPERVISOR_ACTOR);
      if (!claimed) {
        // 契約 §12.14-3: claim 失敗によるスキップは actions を消費しない（notes 記録のみ。
        // メトリクスの誤誘導防止）。
        notes.push(
          retryPlan !== undefined
            ? `${task.id}: auto-launch retry claim失敗のためスキップ（並行変更の可能性）`
            : `${task.id}: claim失敗のためスキップ（並行変更の可能性）`,
        );
        continue;
      }
      // 契約 §12.14-3: actions は claim 成功後にのみ加算する。
      actions += 1;
      // 契約 §12.8-2: 起動予算（launchesThisTick）は claim 成功後にのみ消費する。
      // claim 失敗・事前スキップは予算を消費しない。
      launchesThisTick += 1;

      // 契約 §12.11-1: claim 成功後にタスクを再読込し、以降の resolveModel / cwd 抽出 /
      // buildWorkerPrompt はこの最新行に対して行う（claim 前の pre-claim スナップショットで launch しない）。
      const claimedTask = store.getTask(task.id);
      if (claimedTask === null) {
        // claim 直後にタスクが消失する状況は通常起こらないが、防御的に fail-closed skip する
        // （claim_lock は行自体が無いため解放不要）。
        logger.warn("dispatch: claim直後にタスクが見つかりません", { taskId: task.id });
        notes.push(`${task.id}: claim直後にタスクが見つかりません`);
        continue;
      }

      // claimTask() 成功から再読込までの極小window（複数 supervisor インスタンス運用時）で、
      // 別 writer が status を遷移させた（claim_lock は runTransition により自動でクリアされる）
      // か、reap の stale claim 解放で claim_lock だけが失われた場合を検知する。
      // まだ launch していないため block/orphan_session は不要。何もせず skip するだけでよい
      // （status が変わっていれば他 writer の状態を尊重、claim_lock だけ失われていれば ready のまま
      // 次 tick で再 claim される）。
      if (claimedTask.status !== "ready" || claimedTask.claimLock !== claimToken) {
        notes.push(`${task.id}: claim後の再検証で状態不一致のためスキップ（並行変更の可能性）`);
        continue;
      }

      // claim前preflight中のconfig/policy driftを、stale configでresolve/probeする前に遮断する。
      if (
        executionPolicyFingerprint(deps.config) !== configPolicyFingerprint ||
        !sameConfigSnapshot(
          configSnapshot,
          tryReadConfigFileSnapshot(env, logger, { stage: "dispatch", taskId: task.id }),
        )
      ) {
        store.blockClaimedTask(
          task.id,
          claimToken,
          "needs-manual: execution policy snapshot/config drift after claim",
          SUPERVISOR_ACTOR,
          "human",
        );
        notes.push(`${task.id}: preflight中のsnapshot/config driftを検知したため起動をfail-closedしました`);
        continue;
      }

      const executionSettingsFingerprint = workerExecutionSettingsFingerprint(claimedTask, config);

      // 契約 §12.19-2: model 解決失敗・cwd 検証失敗・launch 失敗の block は blockClaimedTask
      // （単一 Tx CAS: status='ready' AND claim_lock=claimToken）に統一する。claim 直後の再検証
      // （上の claimedTask チェック）は同一プロセス内の窓を塞ぐが、複数 supervisor インスタンス運用時は
      // 別プロセスの割込みが依然としてありうるため、block 適用そのものも CAS で保護する。
      // CAS 不成立（他 writer が既に claim/遷移させた）の場合は false のまま状態を変更せず、
      // warn ログ + notes 記録のみに留める（fail-closed。他 writer の状態を上書きしない）。

      const resolution = resolveModel(claimedTask, config);
      if (!resolution.ok) {
        const reason = `user-decision: モデル解決に失敗 (${resolution.reason}: ${resolution.detail})`;
        const blocked = store.blockClaimedTask(task.id, claimToken, reason, SUPERVISOR_ACTOR, "human");
        if (blocked) {
          notes.push(`${task.id}: ${reason}`);
        } else {
          logger.warn("dispatch: モデル解決失敗の block 時に claim 状態が変化していました", { taskId: task.id });
          notes.push(`${task.id}: モデル解決失敗の block 試行時に claim 状態が変化していたためスキップしました`);
        }
        continue;
      }

      if (providerLaunchLimitReached(config, resolution.provider, providerLaunchesThisTick)) {
        if (retryPlan !== undefined) {
          restoreAutoLaunchRetryBlock(store, task.id, claimToken, retryPlan);
        } else {
          store.releaseClaim(task.id, claimToken, SUPERVISOR_ACTOR);
        }
        notes.push(providerLimitNote(config, resolution.provider, task.id));
        continue;
      }
      providerLaunchesThisTick[resolution.provider] += 1;

      const cwd = extractCwd(claimedTask.body);
      if (cwd === null) {
        const reason = "user-decision: cwd 未指定のため起動できません";
        const blocked = store.blockClaimedTask(task.id, claimToken, reason, SUPERVISOR_ACTOR, "human");
        if (blocked) {
          notes.push(`${task.id}: ${reason}`);
        } else {
          logger.warn("dispatch: cwd未指定block時に claim 状態が変化していました", { taskId: task.id });
          notes.push(`${task.id}: cwd未指定の block 試行時に claim 状態が変化していたためスキップしました`);
        }
        continue;
      }

      // cwd は絶対パス必須（docs/contract.md §12.4-5, fail-closed）
      if (!isAbsolute(cwd)) {
        const reason = `user-decision: cwd が絶対パスではありません (${cwd})`;
        const blocked = store.blockClaimedTask(task.id, claimToken, reason, SUPERVISOR_ACTOR, "human");
        if (blocked) {
          notes.push(`${task.id}: ${reason}`);
        } else {
          logger.warn("dispatch: cwd絶対パス検証block時に claim 状態が変化していました", { taskId: task.id });
          notes.push(`${task.id}: cwd絶対パス検証の block 試行時に claim 状態が変化していたためスキップしました`);
        }
        continue;
      }

      // cwd ディレクトリの実在・種別チェック（fail-closed）
      const cwdValidationError = validateCwdDirectory(cwd);
      if (cwdValidationError !== null) {
        const blocked = store.blockClaimedTask(task.id, claimToken, cwdValidationError, SUPERVISOR_ACTOR, "human");
        if (blocked) {
          notes.push(`${task.id}: ${cwdValidationError}`);
        } else {
          logger.warn("dispatch: cwd検証block時に claim 状態が変化していました", { taskId: task.id });
          notes.push(`${task.id}: cwd検証の block 試行時に claim 状態が変化していたためスキップしました`);
        }
        continue;
      }

      let runtimeBindings: RuntimeResourceBinding[] = [];
      const postClaimResourceGate = evaluateRuntimeResourceDispatchGate(
        env.dbPath,
        task.id,
        cwd,
        now,
        currentRuntimeResources(deps),
      );
      if (postClaimResourceGate.status === "ready") {
        runtimeBindings = postClaimResourceGate.bindings;
      }
      const resourceSnapshotValid =
        (resourceGate.status === "unconfigured" && postClaimResourceGate.status === "unconfigured") ||
        (resourceGate.status === "ready" &&
          postClaimResourceGate.status === "ready" &&
          validateRuntimeResourceBindings(
            runtimeStore,
            task.id,
            runtimeBindings,
            now,
            false,
            currentRuntimeResources(deps),
          ));
      if (!resourceSnapshotValid) {
        if (retryPlan !== undefined) {
          restoreAutoLaunchRetryBlock(store, task.id, claimToken, retryPlan);
        } else if (postClaimResourceGate.status === "failed") {
          store.blockClaimedTask(task.id, claimToken, postClaimResourceGate.reason, SUPERVISOR_ACTOR, "human");
        } else {
          store.releaseClaim(task.id, claimToken, SUPERVISOR_ACTOR);
        }
        notes.push(`${task.id}: claim 後の runtime resource 再検証が不成立のため launch をスキップしました`);
        continue;
      }

      const useNativeLaunch = nativeLaunchSelected(config, resolution.provider, task.id);
      const requirements: ExecutionOverrideRequirements = {
        ...executionOverrideRequirements(claimedTask, "worker"),
        ...(bridgeMaxTurnsRequested(resolution, useNativeLaunch) ? { maxTurns: true } : {}),
      };
      const capabilityState = hasOverrideRequirement(requirements)
        ? await capabilitiesForProvider(resolution.provider)
        : ({ status: "known", capabilities: [] } as const);
      const transportDecision = resolveTransport(resolution, capabilityState, requirements);
      let selectedTransport = transportDecision.transport;

      const resolutionUnchanged =
        preClaimResolution.ok &&
        preClaimResolution.provider === resolution.provider &&
        preClaimResolution.model === resolution.model &&
        preClaimResolution.effort === resolution.effort &&
        preClaimResolution.speed === resolution.speed &&
        preClaimPreflight?.transportDecision.transport === selectedTransport;
      const compatibility = resolutionUnchanged && preClaimPreflight !== null
        ? preClaimPreflight.compatibility
        // 起動前ゲートにも model の native 配送を要求する。起動後の検査だけでは、advertise が
        // none の runtime に対して外部 session を起こしてから block することになる。bridge は
        // 協調的な inject しか持たず強制停止できないため、誤ったモデルの session が走り続けうる。
        // transport 昇格の判定には override 由来の requirements をそのまま使う（別の関心事）。
        : await probeExecutionCompatibility(preflightDeps, config, resolution, selectedTransport, {
            ...requirements,
            model: true,
            maxTurns: selectedTransport === "bridge" && requirements.maxTurns === true,
          });
      if (compatibility.status !== "supported") {
        const reason = compatibilityBlockReason(compatibility);
        const blocked = blockClaimedCompatibility(
          store,
          task.id,
          claimToken,
          compatibility,
          resolution,
          selectedTransport,
        );
        if (blocked) {
          notes.push(`${task.id}: claim 後の再検証で ${reason}。run/session/worker は作成していません`);
        } else {
          logger.warn("dispatch: model×transport preflight block 時に claim 状態が変化していました", {
            taskId: task.id,
          });
          notes.push(`${task.id}: model×transport preflight block の claim CAS が不成立でした`);
        }
        continue;
      }
      // pre-claim と post-claim の両方で probe しても、durable event は claim fence 内の
      // 最終判定だけを1回記録する。CAS 不成立時は外部 worker を起動しない。
      if (!recordClaimedSupportedCompatibility(
        store,
        task.id,
        claimToken,
        compatibility,
        resolution,
        selectedTransport,
      )) {
        logger.warn("dispatch: supported互換性記録時に claim 状態が変化していました", {
          taskId: task.id,
        });
        notes.push(`${task.id}: supported互換性記録の claim CAS が不成立のため起動をスキップしました`);
        continue;
      }

      // 契約 §17.3: transport に応じて起動 adapter を選択する。transport==="direct" で directAdapters が
      // 未構成の場合は bridge へ silent fallback せず auto-launch-failed で fail-closed に block する。
      let launchAdapter: WorkerAdapter;
      const nativeLaunchAdapter = pickNativeWorkerAdapter(deps, resolution.provider, useNativeLaunch);
      if (useNativeLaunch && nativeLaunchAdapter === null) {
        const reason = "auto-launch-failed: native communication adapter 未構成";
        if (
          retryPlan !== undefined &&
          !ensureAutoLaunchRetryStarted(store, task.id, claimToken, retryPlan, logger, notes)
        ) {
          continue;
        }
        const blocked = store.blockClaimedTask(task.id, claimToken, reason, SUPERVISOR_ACTOR, "human");
        if (blocked) {
          notes.push(`${task.id}: ${reason}`);
        } else {
          logger.warn("dispatch: native communication adapter 未構成の block 時に claim 状態が変化していました", {
            taskId: task.id,
          });
          notes.push(`${task.id}: native communication adapter 未構成の block 試行時に claim 状態が変化していたためスキップしました`);
        }
        continue;
      }
      if (nativeLaunchAdapter !== null) {
        launchAdapter = nativeLaunchAdapter;
      } else if (selectedTransport === "direct") {
        const directAdapter = directAdapters?.[resolution.provider];
        if (directAdapter === undefined) {
          const reason = "auto-launch-failed: direct transport 未構成";
          if (
            retryPlan !== undefined &&
            !ensureAutoLaunchRetryStarted(store, task.id, claimToken, retryPlan, logger, notes)
          ) {
            continue;
          }
          const blocked = store.blockClaimedTask(task.id, claimToken, reason, SUPERVISOR_ACTOR, "human");
          if (blocked) {
            notes.push(`${task.id}: ${reason}`);
          } else {
            logger.warn("dispatch: direct transport 未構成の block 時に claim 状態が変化していました", {
              taskId: task.id,
            });
            notes.push(`${task.id}: direct transport 未構成の block 試行時に claim 状態が変化していたためスキップしました`);
          }
          continue;
        }
        launchAdapter = directAdapter;
      } else {
        launchAdapter = adapters[resolution.provider];
      }

      const lessons = recentLessonsForTask(store, claimedTask, cwd);
      let runtimeResources;
      try {
        runtimeResources = readRuntimeResourcePromptContext(env.dbPath, env.home, claimedTask, cwd);
      } catch {
        const reason = "needs-manual: runtime resource manifest/secret reference の検証に失敗しました";
        const blocked = store.blockClaimedTask(task.id, claimToken, reason, SUPERVISOR_ACTOR, "human");
        if (blocked) {
          notes.push(`${task.id}: ${reason}`);
        } else {
          logger.warn("dispatch: runtime resource manifest 検証 block 時に claim 状態が変化していました", {
            taskId: task.id,
          });
          notes.push(`${task.id}: runtime resource manifest 検証の block 試行時に claim 状態が変化していました`);
        }
        continue;
      }
      const promptText = buildWorkerPrompt(claimedTask, resolution.model, lessons, {
        transport: selectedTransport,
        ...(runtimeResources === undefined ? {} : { runtimeResources }),
      });

      // prompt artifact は launch 前に保存する（docs/contract.md §12.6-3）。
      // 保存に失敗した場合はワーカーを起動せずこのタスクを skip する（起動したのに artifact が
      // 残らない不整合を避ける。fail-closed。claim は解放し次 tick で再試行できるようにする）。
      try {
        // sessionId は launch 前で未確定のため claimToken でスコープする（docs/contract.md §12.17-2）。
        savePromptArtifact(env, task.id, claimToken, promptText);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (retryPlan !== undefined) {
          restoreAutoLaunchRetryBlock(store, task.id, claimToken, retryPlan);
        } else {
          store.releaseClaim(task.id, claimToken, SUPERVISOR_ACTOR);
        }
        logger.warn("worker起動前の prompt artifact 保存に失敗しました。起動をスキップします", {
          taskId: task.id,
          error: redactText(message),
        });
        notes.push(`${task.id}: artifact保存失敗のため起動スキップ (${redactText(message)})`);
        continue;
      }

      let ref: BridgeLaunchSessionRef;
      if (
        retryPlan !== undefined &&
        !ensureAutoLaunchRetryStarted(store, task.id, claimToken, retryPlan, logger, notes)
      ) {
        continue;
      }

      // worker が変更を開始する前の bounded Git snapshot を取得する（contract §65.3）。
      // Git外・timeout・取得失敗も unavailable snapshot として run meta へ残し、launch 自体は妨げない。
      let gitLaunchSnapshot = await captureLaunchSnapshotBestEffort(handoffGitEvidenceProbe(deps), cwd);

      const prelaunchTask = store.getTask(task.id);
      const prelaunchConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
        stage: "dispatch",
        taskId: task.id,
      });
      if (
        prelaunchTask === null || prelaunchTask.status !== "ready" || prelaunchTask.claimLock !== claimToken ||
        workerExecutionSettingsFingerprint(prelaunchTask, config) !== executionSettingsFingerprint ||
        executionPolicyFingerprint(deps.config) !== configPolicyFingerprint ||
        !sameConfigSnapshot(configSnapshot, prelaunchConfigSnapshot)
      ) {
        if (retryPlan !== undefined) {
          restoreAutoLaunchRetryBlock(store, task.id, claimToken, retryPlan);
        } else {
          store.releaseClaim(task.id, claimToken, SUPERVISOR_ACTOR);
        }
        notes.push(`${task.id}: execution設定/configがlaunch直前に変更されたため起動をスキップしました`);
        continue;
      }

      // adapter.launch の直前に fence/owner/worktree/member を再検証する。prompt 構築や artifact 保存中に
      // Git snapshot 取得中に lease が失効・更新された場合も外部 worker を起動しない。
      if (!validateRuntimeResourceBindings(
        runtimeStore,
        task.id,
        runtimeBindings,
        Math.floor(Date.now() / 1000),
        false,
        currentRuntimeResources(deps),
      )) {
        if (retryPlan !== undefined) {
          restoreAutoLaunchRetryBlock(store, task.id, claimToken, retryPlan);
        } else {
          store.releaseClaim(task.id, claimToken, SUPERVISOR_ACTOR);
        }
        notes.push(`${task.id}: launch 直前の runtime resource fence 再検証が不成立のため起動をスキップしました`);
        continue;
      }
      const launchCancelGate = cancelledOpenRunForTaskOrWorktree(store, task.id, cwd);
      if (launchCancelGate !== null) {
        if (retryPlan !== undefined) {
          restoreAutoLaunchRetryBlock(store, task.id, claimToken, retryPlan);
        } else {
          store.releaseClaim(task.id, claimToken, SUPERVISOR_ACTOR);
        }
        notes.push(
          `${task.id}: launch 直前に cancel stop 証拠待ち run#${launchCancelGate.id} を検知したため起動を拒否しました`,
        );
        continue;
      }

      let attemptedAt = new Date().toISOString();

      // try/catch は adapter.launch() のみを包む（docs/contract.md §12.6-3）。
      try {
        // 契約 §12.11-1: launch には claim 後に再読込した最新行（claimedTask）を渡す（pre-claim スナップショットで launch しない）
        // 契約 §17.3: adapter は transport に応じて上で選択済み（bridge/direct）。
        // 契約 §35.3: profile 由来の effort を LaunchOptions へ伝える。未指定はキー自体を省略する
        // （exactOptionalPropertyTypes のため undefined の明示代入はしない。各 CLI の既定に任せる）。
        const launchOptions: LaunchOptions & BridgeLaunchOptions = {
          model: resolution.model,
          cwd,
          promptText,
          ...(resolution.effort !== undefined ? { effort: resolution.effort } : {}),
          ...(resolution.speed !== undefined ? { speed: resolution.speed } : {}),
          ...(selectedTransport === "bridge"
            ? {
                bridgePassthrough: {
                  ...(transportDecision.passthrough ?? {}),
                  ...(resolution.effort !== undefined ? { effort: true } : {}),
                  ...(resolution.speed !== undefined ? { speed: true } : {}),
                },
              }
            : {}),
        };
        attemptedAt = new Date().toISOString();
        ref = (await launchAdapter.launch(claimedTask, launchOptions)) as BridgeLaunchSessionRef;
      } catch (err) {
        if (transportDecision.reason === "passthrough-promoted" && isModelPassthroughRejected(err)) {
          const directAdapter = directAdapters?.[resolution.provider];
          if (directAdapter === undefined) {
            const reason = "auto-launch-failed: direct transport 未構成";
            const blocked = store.blockClaimedTask(task.id, claimToken, reason, SUPERVISOR_ACTOR, "human");
            if (blocked) {
              notes.push(`${task.id}: bridge passthrough 拒否後の ${reason}`);
            } else {
              logger.warn("dispatch: bridge passthrough 拒否後の direct 未構成 block 時に claim 状態が変化していました", {
                taskId: task.id,
              });
              notes.push(`${task.id}: bridge passthrough 拒否後の block 試行時に claim 状態が変化していたためスキップしました`);
            }
            continue;
          }

          const preFallbackTask = store.getTask(task.id);
          const preFallbackConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
            stage: "dispatch-direct-fallback",
            taskId: task.id,
          });
          if (
            preFallbackTask === null || preFallbackTask.status !== "ready" ||
            preFallbackTask.claimLock !== claimToken ||
            workerExecutionSettingsFingerprint(preFallbackTask, config) !== executionSettingsFingerprint ||
            executionPolicyFingerprint(deps.config) !== configPolicyFingerprint ||
            !sameConfigSnapshot(configSnapshot, preFallbackConfigSnapshot)
          ) {
            if (retryPlan !== undefined) {
              restoreAutoLaunchRetryBlock(store, task.id, claimToken, retryPlan);
            } else {
              store.releaseClaim(task.id, claimToken, SUPERVISOR_ACTOR);
            }
            notes.push(`${task.id}: bridge拒否後にexecution設定/config driftを検知したためdirect fallbackを中止しました`);
            continue;
          }

          selectedTransport = "direct";
          launchAdapter = directAdapter;
          const fallbackCompatibility = await probeExecutionCompatibility(
            preflightDeps,
            config,
            resolution,
            selectedTransport,
            { ...requirements, model: true, maxTurns: false },
          );
          if (fallbackCompatibility.status !== "supported") {
            const reason = compatibilityBlockReason(fallbackCompatibility);
            blockClaimedCompatibility(
              store,
              task.id,
              claimToken,
              fallbackCompatibility,
              resolution,
              selectedTransport,
            );
            notes.push(`${task.id}: bridge passthrough 拒否後の direct preflight で ${reason}`);
            continue;
          }
          if (!recordClaimedSupportedCompatibility(
            store,
            task.id,
            claimToken,
            fallbackCompatibility,
            resolution,
            selectedTransport,
          )) {
            logger.warn("dispatch: direct fallback互換性記録時に claim 状態が変化していました", {
              taskId: task.id,
            });
            notes.push(`${task.id}: direct fallback互換性記録の claim CAS が不成立のため起動をスキップしました`);
            continue;
          }
          const directPromptText = buildWorkerPrompt(claimedTask, resolution.model, lessons, {
            transport: "direct",
            ...(runtimeResources === undefined ? {} : { runtimeResources }),
          });
          try {
            savePromptArtifact(env, task.id, claimToken, directPromptText);
          } catch (directArtifactErr) {
            const message = directArtifactErr instanceof Error ? directArtifactErr.message : String(directArtifactErr);
            store.releaseClaim(task.id, claimToken, SUPERVISOR_ACTOR);
            notes.push(`${task.id}: direct fallback artifact保存失敗のため起動をスキップしました (${redactText(message)})`);
            continue;
          }
          // bridge が session 未作成で拒否した後は、direct worker の実 launch に最も近い base を採り直す。
          gitLaunchSnapshot = await captureLaunchSnapshotBestEffort(handoffGitEvidenceProbe(deps), cwd);
          const directPrelaunchTask = store.getTask(task.id);
          const directPrelaunchConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
            stage: "dispatch-direct-fallback",
            taskId: task.id,
          });
          if (
            directPrelaunchTask === null || directPrelaunchTask.status !== "ready" ||
            directPrelaunchTask.claimLock !== claimToken ||
            workerExecutionSettingsFingerprint(directPrelaunchTask, config) !== executionSettingsFingerprint ||
            executionPolicyFingerprint(deps.config) !== configPolicyFingerprint ||
            !sameConfigSnapshot(configSnapshot, directPrelaunchConfigSnapshot)
          ) {
            if (retryPlan !== undefined) {
              restoreAutoLaunchRetryBlock(store, task.id, claimToken, retryPlan);
            } else {
              store.releaseClaim(task.id, claimToken, SUPERVISOR_ACTOR);
            }
            notes.push(`${task.id}: direct fallback launch直前にexecution設定/config driftを検知したため中止しました`);
            continue;
          }
          // fallback 用 prompt/artifact の準備中にも owner/path/fence は変わり得るため、外部 launch の
          // Git snapshot 取得後、直前に改めて全 runtime snapshot を取得・検証する。
          if (!validateRuntimeResourceBindings(
            runtimeStore,
            task.id,
            runtimeBindings,
            Math.floor(Date.now() / 1000),
            false,
            currentRuntimeResources(deps),
          )) {
            const reason = "needs-manual: direct fallback launch 直前の runtime resource ownership/fence が不一致です";
            let cleanupRecorded = false;
            try {
              store.transaction(() => {
                for (const binding of runtimeBindings) {
                  requestExactRuntimeResourceCleanup(
                    runtimeStore,
                    binding,
                    "direct fallback launch blocked by runtime resource ownership mismatch",
                  );
                }
                if (!store.blockClaimedTask(task.id, claimToken, reason, SUPERVISOR_ACTOR, "human")) {
                  throw new Error("direct fallback ownership mismatch block の claim CAS に失敗しました");
                }
              });
              cleanupRecorded = true;
            } catch (cleanupError) {
              // cleanup request を exact identity で作れなくても、再 dispatch を止める block を優先する。
              store.blockClaimedTask(task.id, claimToken, reason, SUPERVISOR_ACTOR, "human");
              logger.warn("direct fallback ownership mismatch の cleanup request 作成に失敗しました", {
                taskId: task.id,
                error: redactText(cleanupError instanceof Error ? cleanupError.message : String(cleanupError)),
              });
            }
            notes.push(
              `${task.id}: direct fallback launch 直前の runtime resource 再検証が不成立でした` +
                (cleanupRecorded ? "。cleanup request を記録して task を block しました" : "。task を fail-closed block しました"),
            );
            continue;
          }
          const directCancelGate = cancelledOpenRunForTaskOrWorktree(store, task.id, cwd);
          if (directCancelGate !== null) {
            if (retryPlan !== undefined) {
              restoreAutoLaunchRetryBlock(store, task.id, claimToken, retryPlan);
            } else {
              store.releaseClaim(task.id, claimToken, SUPERVISOR_ACTOR);
            }
            notes.push(
              `${task.id}: cancel stop 証拠待ち run#${directCancelGate.id} のため direct fallback を拒否しました`,
            );
            continue;
          }
          try {
            ref = (await directAdapter.launch(claimedTask, {
              model: resolution.model,
              cwd,
              promptText: directPromptText,
              ...(resolution.effort !== undefined ? { effort: resolution.effort } : {}),
              ...(resolution.speed !== undefined ? { speed: resolution.speed } : {}),
            })) as BridgeLaunchSessionRef;
            notes.push(`${task.id}: bridge passthrough 拒否のため direct へフォールバックしました`);
          } catch (directErr) {
            const message = directErr instanceof Error ? directErr.message : String(directErr);
            const redactedMessage = redactText(message);
            const incompatible = classifyProviderFailureDiagnostic(redactedMessage) === "incompatible_model_transport";
            const reason = incompatible
              ? `needs-manual: incompatible_model_transport (${redactedMessage})`
              : `auto-launch-failed: ${redactedMessage}`;
            let stale = false;
            store.transaction(() => {
              const blocked = store.blockClaimedTask(task.id, claimToken, reason, SUPERVISOR_ACTOR);
              if (!blocked) {
                stale = true;
                store.addEvent(task.id, "stale_launch_failure", SUPERVISOR_ACTOR, { error: redactedMessage });
                return;
              }
              store.addEvent(
                task.id,
                incompatible ? "incompatible_model_transport" : "launch_failed",
                SUPERVISOR_ACTOR,
                { error: redactedMessage, source: "launch" },
              );
            });
            if (stale) {
              logger.warn("direct fallback 起動失敗時の claim 再検証で状態不一致でした", {
                taskId: task.id,
                error: redactedMessage,
              });
              notes.push(`${task.id}: direct fallback 起動失敗時の claim 再検証で状態不一致のため stale_launch_failure を記録しました`);
            } else {
              logger.warn("direct fallback 起動に失敗しました", { taskId: task.id, error: redactedMessage });
              notes.push(`${task.id}: direct fallback 起動失敗 (${redactedMessage})`);
            }
            const cleanupRequests = requestRuntimeResourceCleanup(
              runtimeStore,
              runtimeBindings,
              `worker launch failed: ${redactedMessage}`,
              true,
            );
            if (cleanupRequests > 0) {
              notes.push(`${task.id}: launch 部分失敗の cleanup request を ${cleanupRequests} 件記録しました`);
            }
            continue;
          }
        } else {
          const message = err instanceof Error ? err.message : String(err);
          const redactedMessage = redactText(message);
          const incompatible = classifyProviderFailureDiagnostic(redactedMessage) === "incompatible_model_transport";
          const indeterminate = !incompatible && isIndeterminateLaunchFailure(err);
          const probePayload = indeterminate
            ? await probeIndeterminateLaunch(deps, cwd, resolution.provider, attemptedAt)
            : null;
          const reason = incompatible
            ? `needs-manual: incompatible_model_transport (${redactedMessage})`
            : indeterminate
              ? `${LAUNCH_INDETERMINATE_PREFIX}${redactedMessage}`
              : `auto-launch-failed: ${redactedMessage}`;
          // launch 失敗パスでは releaseClaim を挟まず直接 block する（docs/contract.md §12.9-3）。
          // ready→blocked 遷移が同一 Tx で claim_lock をクリアするため二度手間にならない。
          // releaseClaim は「タスクを ready のまま残す」巻き戻し（artifact 保存失敗等）専用とする。
          // 契約 §12.15-3 / §12.19-2: adapter.launch() の await 中に別 writer がタスクを遷移させている
          // 可能性があるため、block は blockClaimedTask（単一 Tx CAS: status='ready' AND
          // claim_lock=claimToken）で行う。CAS 不成立なら他 writer の状態を上書きせず、状態を変更せず
          // stale_launch_failure イベントのみ記録する（redact 済みエラーのみを payload に載せる）。
          let stale = false;
          store.transaction(() => {
            const blocked = store.blockClaimedTask(task.id, claimToken, reason, SUPERVISOR_ACTOR);
            if (!blocked) {
              stale = true;
              store.addEvent(task.id, "stale_launch_failure", SUPERVISOR_ACTOR, { error: redactedMessage });
              return;
            }
            store.addEvent(
              task.id,
              incompatible
                ? "incompatible_model_transport"
                : indeterminate
                  ? "launch_indeterminate"
                  : "launch_failed",
              SUPERVISOR_ACTOR,
              {
                error: redactedMessage,
                source: "launch",
                ...(probePayload ?? {}),
              },
            );
          });

          if (stale) {
            logger.warn("worker起動失敗時の claim 再検証で状態不一致でした（stale_launch_failure）", {
              taskId: task.id,
              error: redactedMessage,
            });
            notes.push(`${task.id}: 起動失敗時の claim 再検証で状態不一致のため stale_launch_failure を記録しました`);
          } else {
            logger.warn("worker起動に失敗しました", { taskId: task.id, error: redactedMessage });
            notes.push(`${task.id}: 起動失敗 (${redactedMessage})`);
          }
          if (indeterminate) {
            notes.push(`${task.id}: indeterminate のため cleanup request を作成しませんでした`);
          } else {
            const cleanupRequests = requestRuntimeResourceCleanup(
              runtimeStore,
              runtimeBindings,
              `worker launch failed: ${redactedMessage}`,
              true,
            );
            if (cleanupRequests > 0) {
              notes.push(`${task.id}: launch 部分失敗の cleanup request を ${cleanupRequests} 件記録しました`);
            }
          }
          continue;
        }
      }

      const requireBridgeAppliedValues = selectedTransport === "bridge" && !useNativeLaunch;
      const deliveryRequirements = bridgeNativeDeliveryRequirements(resolution);
      const nativeMissing = !hasRequiredNativeDelivery(ref, deliveryRequirements, requireBridgeAppliedValues);
      let externalGenerationRead: ExternalRuntimeGenerationReadResult | null = null;
      const externalGenerationReader = (deps as StageDepsWithExternalRuntimeGenerationReader)
        .externalRuntimeGenerationReader;
      if (
        !nativeMissing && selectedTransport === "bridge" && !useNativeLaunch &&
        externalGenerationReader !== undefined && ref.runtimeGenerationAttestation !== undefined
      ) {
        try {
          externalGenerationRead = await externalGenerationReader.read(
            resolution.provider,
            Date.now(),
            ref.runtimeGenerationAttestation,
          );
        } catch {
          externalGenerationRead = { state: "unknown", code: "read_failed" };
        }
        if (externalGenerationRead.state === "unknown") {
          logger.warn("dispatch: external runtime generation attestation をbindできません", {
            taskId: task.id,
            code: externalGenerationRead.code,
          });
        }
      }

      // launch 成功後の startRun + transition は単一 Tx で原子化する（docs/contract.md §12.6-3）。
      // 途中で例外が起きても task_runs / tasks の不整合（blocked に遷移したのに run が無い等）を残さない。
      // 契約 §12.8-3: Tx 内で改めて getTask し、status='ready' かつ claim_lock=claimToken であることを
      // 再検証する。adapter.launch() 実行中（awaitしている間）に別 writer がタスクを書き換えた場合、
      // 起動済みセッションが DB に紐付かない「孤児」になるため、throw で握り潰さず orphan_session として
      // 人間に可視化する（外部セッションだけが走り DB に記録が無い状態を作らない）。
      let orphaned = false;
      let orphanedByCancel = false;
      let orphanedByExecutionDrift = false;
      let launchBindFailed = false;
      try {
        store.transaction(() => {
          const current = store.getTask(task.id);
          if (current === null || current.status !== "ready" || current.claimLock !== claimToken) {
            orphaned = true;
            store.addEvent(task.id, "orphan_session", SUPERVISOR_ACTOR, {
              sessionId: ref.sessionId,
              serverUrl: ref.serverUrl,
            });
            store.addComment(
              task.id,
              SUPERVISOR_ACTOR,
              redactText(
                `起動済みセッションが孤児化しました: session=${ref.sessionId} server=${ref.serverUrl}（手動確認要）`,
              ),
            );
            return;
          }
          const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
            stage: "dispatch-bind",
            taskId: task.id,
            sessionId: ref.sessionId,
          });
          const settingsChanged =
            workerExecutionSettingsFingerprint(current, config) !== executionSettingsFingerprint;
          const policyChanged = executionPolicyFingerprint(deps.config) !== configPolicyFingerprint;
          const configFileChanged = !sameConfigSnapshot(configSnapshot, currentConfigSnapshot);
          if (settingsChanged || policyChanged || configFileChanged) {
            orphaned = true;
            orphanedByExecutionDrift = true;
            store.addEvent(task.id, "orphan_session", SUPERVISOR_ACTOR, {
              sessionId: ref.sessionId,
              serverUrl: ref.serverUrl,
              reason: "execution-settings-or-config-drift",
              settingsChanged,
              policyChanged,
              configFileChanged,
            });
            store.addComment(
              task.id,
              SUPERVISOR_ACTOR,
              `起動中にexecution設定/configが変更された session=${redactText(ref.sessionId)} は run/resourceへbindせず隔離しました。`,
            );
            store.blockClaimedTask(
              task.id,
              claimToken,
              `${EXECUTION_FENCE_DRIFT_REASON} (session=${ref.sessionId})`,
              SUPERVISOR_ACTOR,
              "human",
            );
            return;
          }
          const commitCancelGate = cancelledOpenRunForTaskOrWorktree(store, task.id, cwd);
          if (commitCancelGate !== null) {
            orphaned = true;
            orphanedByCancel = true;
            store.addEvent(task.id, "orphan_session", SUPERVISOR_ACTOR, {
              sessionId: ref.sessionId,
              serverUrl: ref.serverUrl,
              reason: "cancel-fence-race",
              cancelledRunId: commitCancelGate.id,
            });
            store.addComment(
              task.id,
              SUPERVISOR_ACTOR,
              `cancel fence と競合した起動済み session=${redactText(ref.sessionId)} は run に bind せず孤児として隔離しました。`,
            );
            store.blockClaimedTask(
              task.id,
              claimToken,
              `needs-manual: cancel fence 競合で起動 session が孤児化しました (session=${ref.sessionId})`,
              SUPERVISOR_ACTOR,
              "human",
            );
            return;
          }
          if (!validateRuntimeResourceBindings(
            runtimeStore,
            task.id,
            runtimeBindings,
            Math.floor(Date.now() / 1000),
            false,
            currentRuntimeResources(deps),
          )) {
            throw new Error("launch transaction の runtime resource fence 再検証に失敗しました");
          }

          // preflight時点のcapability snapshotだけでは、実launchが要求値をnativeに配送した証拠に
          // ならない。adapter echoが欠落したsessionはrun/resourceへbindせず、外部sessionだけを
          // 停止対象として監査する。
          if (nativeMissing) {
            store.blockClaimedTask(task.id, claimToken, BRIDGE_NATIVE_MISSING_REASON, SUPERVISOR_ACTOR, "human");
            store.addEvent(task.id, "bridge_native_missing", SUPERVISOR_ACTOR, {
              sessionId: ref.sessionId,
              provider: resolution.provider,
              model: resolution.model,
              modelDelivery: ref.modelDelivery,
              ...(resolution.effort !== undefined ? { effort: resolution.effort } : {}),
              ...(ref.effortDelivery !== undefined ? { effortDelivery: ref.effortDelivery } : {}),
              ...(resolution.speed !== undefined ? { speed: resolution.speed } : {}),
              ...(ref.speedDelivery !== undefined ? { speedDelivery: ref.speedDelivery } : {}),
              ...(ref.requestedMaxTurns !== undefined ? { requestedMaxTurns: ref.requestedMaxTurns } : {}),
              ...(ref.maxTurnsDelivery !== undefined ? { maxTurnsDelivery: ref.maxTurnsDelivery } : {}),
              ...(ref.appliedModel !== undefined ? { appliedModel: ref.appliedModel } : {}),
              ...(ref.appliedEffort !== undefined ? { appliedEffort: ref.appliedEffort } : {}),
              ...(ref.appliedSpeed !== undefined ? { appliedSpeed: ref.appliedSpeed } : {}),
              ...(ref.appliedMaxTurns !== undefined ? { appliedMaxTurns: ref.appliedMaxTurns } : {}),
            });
            return;
          }

          const run = store.startRun(
            task.id,
            resolution.provider,
            ref.sessionId,
            runMeta(
              ref,
              resolution,
              selectedTransport,
              claimedTask.profile !== "" ? claimedTask.profile : config.defaultProfile,
              configSnapshot,
              gitLaunchSnapshot,
            ),
          );
          if (
            externalGenerationRead?.state === "valid" &&
            externalGenerationRead.launchAttestation !== undefined &&
            isExternalRuntimeGenerationStore(store)
          ) {
            const boundAt = Date.now();
            const acceptance = store.acceptExternalRuntimeGenerationStatus(externalGenerationRead.sample, boundAt);
            if (acceptance === "accepted" || acceptance === "idempotent") {
              store.bindExternalRuntimeGenerationLaunch({
                taskId: task.id,
                runId: run.id,
                sessionId: ref.sessionId,
                role: "worker",
                provider: resolution.provider,
                transport: selectedTransport,
                attestation: externalGenerationRead.launchAttestation,
                statusRevision: externalGenerationRead.sample.status.revision,
                statusDigest: externalGenerationRead.sample.canonicalDigest,
                boundAt,
              });
            }
          }
          if (useNativeLaunch) {
            const nativeBinding = persistNativeTargetBinding(store, {
              task: claimedTask,
              run,
              ref,
              role: "worker",
              expectedCancelFence: 0,
              now: Math.floor(Date.now() / 1000),
            });
            if (nativeBinding.binding === null) {
              throw new Error(`native target bindingをrunへbindできません: ${nativeBinding.reason ?? "unknown"}`);
            }
          }
          for (const binding of runtimeBindings) {
            const boundLease = runtimeStore.bindRuntimeResourceLeaseRun({
              leaseId: binding.leaseId,
              expectedFence: binding.fence,
              runId: run.id,
              actor: SUPERVISOR_ACTOR,
            });
            if (!synchronizeRuntimeResourceManifestFence(env.home, boundLease)) {
              throw new Error("runtime resource bind後の manifest fence 同期に失敗しました");
            }
          }
          store.transition({
            taskId: task.id,
            to: "blocked",
            reason: buildInProgressReason(ref, claimedTask.title),
            actor: SUPERVISOR_ACTOR,
            eventType: "launched",
            payload: {
              sessionId: ref.sessionId,
              provider: resolution.provider,
              model: resolution.model,
              modelDelivery: ref.modelDelivery,
              transport: selectedTransport,
              ...(resolution.speed !== undefined ? { speed: resolution.speed } : {}),
              ...(ref.speedDelivery !== undefined ? { speedDelivery: ref.speedDelivery } : {}),
            },
          });
          // 契約 §17.3: direct 実行は G2（even-terminal）に表示されないため、その旨を1行コメントで明記する。
          if (selectedTransport === "direct") {
            store.addComment(
              task.id,
              SUPERVISOR_ACTOR,
              "direct 実行のため G2（even-terminal）非表示です。進捗は artifacts/transcript で確認してください。",
            );
          }
        });
      } catch (error) {
        launchBindFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("worker起動後の runtime resource bind に失敗しました", {
          taskId: task.id,
          sessionId: redactText(ref.sessionId),
          error: redactText(message),
        });
        store.addEvent(task.id, "orphan_session", SUPERVISOR_ACTOR, {
          sessionId: ref.sessionId,
          serverUrl: ref.serverUrl,
          reason: "runtime-resource-bind-failed",
        });
        store.blockClaimedTask(
          task.id,
          claimToken,
          `needs-manual: 起動後の runtime resource bind に失敗しました (session=${ref.sessionId})`,
          SUPERVISOR_ACTOR,
          "human",
        );
        const cleanupRequests = requestRuntimeResourceCleanup(
          runtimeStore,
          runtimeBindings,
          "worker launch succeeded but runtime resource bind failed",
          false,
          "human",
        );
        notes.push(`${task.id}: 起動後の resource bind 失敗。cleanup request=${cleanupRequests}`);
      }

      if (launchBindFailed) {
        continue;
      }

      if (orphaned) {
        const cleanupRequests = orphanedByCancel
          ? 0
          : requestRuntimeResourceCleanup(
              runtimeStore,
              runtimeBindings,
              "worker launch succeeded but task claim no longer matched",
              false,
              "human",
            );
        if (orphanedByExecutionDrift) {
          if (ref.serverUrl === "direct") {
            await stopDirectSessionAndWarn(
              launchAdapter,
              ref,
              logger,
              task.id,
              "execution設定/config driftで孤児化したsessionの停止",
            );
          } else {
            try {
              await launchAdapter.inject(ref, EXECUTION_FENCE_DRIFT_INTERRUPT);
            } catch (error) {
              logger.warn("execution設定/config driftで孤児化したsessionの停止に失敗しました", {
                taskId: task.id,
                sessionId: redactText(ref.sessionId),
                error: redactText(error instanceof Error ? error.message : String(error)),
              });
            }
          }
        } else if (orphanedByCancel && ref.serverUrl === "direct") {
          const directAdapter = directAdapters?.[resolution.provider];
          if (directAdapter !== undefined) {
            await stopDirectSessionAndWarn(
              directAdapter,
              ref,
              logger,
              task.id,
              "cancel fence 競合で孤児化した direct session の exact stop",
            );
          }
        }
        logger.warn("worker起動後にタスクの状態が不整合でした（孤児セッション）", {
          taskId: task.id,
          sessionId: redactText(ref.sessionId),
        });
        notes.push(`${task.id}: 起動済みセッションが孤児化しました (sessionId=${redactText(ref.sessionId)})`);
        if (cleanupRequests > 0) {
          notes.push(`${task.id}: 孤児化した launch の cleanup request を ${cleanupRequests} 件記録しました`);
        }

        // orphan_session 記録後も status='ready' かつ claim_lock=''（未 claim）のままだと、次 tick の
        // dispatch が同じタスクを再度 claim して起動し、孤児セッションが増殖し続ける。
        // blockIfReadyUnclaimed（docs/contract.md §12.17-1）で「status='ready' かつ claim_lock=''」の
        // 検証と block 遷移を単一 Tx（CAS）で行い、check-then-block の窓を排除する
        // （docs/contract.md §12.10-2）。他 token が既に claim 済み / 既に他 writer が遷移済みの場合は
        // false が返り、他者の claim / 起動経路には触れない（docs/contract.md §12.14-2）。
        const blocked = store.blockIfReadyUnclaimed(
          task.id,
          `needs-manual: 起動セッション孤児化のため手動確認要 (session=${ref.sessionId})`,
          SUPERVISOR_ACTOR,
          "human",
        );
        if (!blocked) {
          // block できなかった理由の可視化のみを目的とした読み取り（決定には使わない）。
          const current = store.getTask(task.id);
          if (current !== null && current.status === "ready") {
            logger.warn("worker起動後の孤児セッション: 他 writer が claim 済みのため block しません", {
              taskId: task.id,
              sessionId: redactText(ref.sessionId),
            });
            notes.push(
              `${task.id}: 他 token が claim 済みのため孤児セッションを block せず記録のみ行いました (sessionId=${redactText(ref.sessionId)})`,
            );
          }
        }
        continue;
      }

      if (nativeMissing) {
        // 契約 §34.2.1: direct stop() は例外を投げなくても stopped:false（already-exited/
        // unsupported/unsignalable/kill-unconfirmed）を返しうる。injected は「中断シーケンスを
        // 実行できたか」を示す値であり停止確認の成否とは意味が異なるため、例外が無ければ
        // injected:true のまま維持しつつ、stopResult.reason は stopped の値に関わらず必ず
        // イベントへ格納する（戻り値を証拠として残す）。
        let stopResult: StopResult | undefined;
        try {
          if (ref.serverUrl === "direct") {
            stopResult = await launchAdapter.stop?.(ref);
          } else {
            await launchAdapter.inject(ref, BRIDGE_NATIVE_MISSING_INTERRUPT);
          }
          store.addEvent(task.id, "bridge_native_missing_interrupt", SUPERVISOR_ACTOR, {
            sessionId: ref.sessionId,
            injected: true,
            ...(stopResult !== undefined ? { stopReason: stopResult.reason } : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("dispatch: bridge native 確認欠落 run への中断注入に失敗しました", {
            taskId: task.id,
            sessionId: redactText(ref.sessionId),
            error: redactText(message),
          });
          store.addEvent(task.id, "bridge_native_missing_interrupt", SUPERVISOR_ACTOR, {
            sessionId: ref.sessionId,
            injected: false,
            error: redactText(message),
          });
        }
        if (stopResult !== undefined && !stopResult.stopped) {
          const fields = { taskId: task.id, sessionId: redactText(ref.sessionId), reason: stopResult.reason };
          if (stopResult.reason === "unsignalable" || stopResult.reason === "kill-unconfirmed") {
            logger.warn("dispatch: bridge native 確認欠落 run（direct）の停止を確認できませんでした", fields);
          } else {
            logger.info("dispatch: bridge native 確認欠落 run（direct）は停止呼び出し不要でした（想定内）", fields);
          }
        }
        const cleanupRequests = requestRuntimeResourceCleanup(
          runtimeStore,
          runtimeBindings,
          "worker launch native delivery confirmation missing",
          false,
          "human",
        );
        if (cleanupRequests > 0) {
          notes.push(`${task.id}: native delivery欠落launchのcleanup requestを${cleanupRequests}件記録しました`);
        }
        notes.push(`${task.id}: ${BRIDGE_NATIVE_MISSING_REASON} (sessionId=${ref.sessionId})`);
        continue;
      }

      inFlightCount += 1;
      notes.push(`${task.id}: 起動しました (sessionId=${ref.sessionId})`);
    }

    return { name: "dispatch", actions, skipped: false, notes };
  },
};
