// 人間確認キューの通知ステージ（docs/contract.md §18, §38）
// status='blocked' かつ block_reason が human_queue 系 prefix（user-decision:/user-feedback:/
// review-required:/needs-manual:）のタスクを走査し、未通知（human_notified イベント未記録）の
// ものだけ通知 transport へ渡す。同一 reason（reasonHash 一致）での再通知はしない。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// HUMAN_QUEUE_PREFIXES は core（readview.ts）の export を唯一の定義とする（三重定義の禁止、契約 §36）
import {
  HUMAN_QUEUE_PREFIXES,
  isInProgressReason,
  listWatchedStatusChangedEventsAfter,
  redactText,
  sha256Hex,
} from "@hachi/core";
import type {
  Environment,
  HachiConfig,
  KanbanStore,
  Logger,
  Stage,
  StageDeps,
  StageResult,
  TaskRow,
  TaskStatus,
  RuntimeResourceOutboxRow,
} from "@hachi/core";
import type { WatchedStatusChangedEvent } from "@hachi/core";
import { SUPERVISOR_ACTOR } from "../constants.js";
import {
  computeStateHash,
  findLatestStewardPromoteProposalEventId,
  readTelegramInState,
  registerNonce,
  writeTelegramInState,
  type NonceKind,
  type TelegramInState,
} from "./telegram-nonce.js";

/** 通知本文へ載せる block_reason の切り詰め文字数（契約 §18） */
const REASON_NOTICE_LIMIT = 100;
const DEFAULT_NOTIFY_TRANSPORTS: readonly string[] = ["macos"];
const DEFAULT_WEB_BASE_URL = "http://127.0.0.1:9131";
const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;
const TELEGRAM_RETRY_BACKOFF_MS = 250;
const TELEGRAM_MAX_RETRY_BACKOFF_MS = 2_000;
const RETRY_AFTER_HTTP_DATE_PATTERN = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const TELEGRAM_TOKEN_PATTERN = /^[0-9]+:[A-Za-z0-9_-]+$/;
const WATCH_NOTIFY_SCAN_LIMIT = 200;
const DEFAULT_ACTION_LABEL = "🔔 通知";

export type StewardAdHocKind = "escalate" | "promote" | "archive" | "spec-lint" | "archive-vetoed";

/**
 * 通知を実際に発火する関数の型。既定は osascriptNotifier だが、テストでは実通知を出さない
 * fake を注入する（契約 §18 実装ノート）。true=成功、false=失敗（呼び出し側は warn ログのみ行う）。
 */
export type Notifier = (taskId: string, message: string, title: string) => boolean;

export interface NotifyTelegramConfig {
  chatId?: string;
  baseUrl?: string;
  minPriority?: number;
}

export interface NotifyConfig {
  transports?: string[];
  telegram?: NotifyTelegramConfig;
}

interface ConfigWithNotify extends HachiConfig {
  notify?: NotifyConfig;
}

export interface ResolvedNotifyConfig {
  transports: readonly string[];
  telegram: NotifyTelegramConfig;
}

/** inline keyboard ボタンの定義（Telegram 向け。contract §42.2） */
export interface InlineButton {
  text: string;
  /** callback_data（approve/answer ボタン用） */
  callbackData?: string;
  /** URL リンクボタン用（詳細ボタン等） */
  url?: string;
}

export interface NotifyMessage {
  taskId: string;
  actionLabel: string;
  title: string;
  priority: number;
  reasonHash: string;
  redactedReason: string;
  bodyLabel?: string;
  macosTitle: string;
  macosMessage: string;
  detailUrl: string;
  /** Telegram inline keyboard（contract §42.2。未設定時はボタンなし） */
  inlineKeyboard?: InlineButton[][];
}

export type NotifyTransportStatus = "sent" | "failed" | "skipped";

export interface NotifyTransportResult {
  status: NotifyTransportStatus;
  fields?: Record<string, unknown>;
}

export type NotifyFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TelegramTransportClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface CreateTelegramTransportOptions {
  clock?: TelegramTransportClock;
}

export interface NotifyTransportContext {
  env: Environment;
  config: ResolvedNotifyConfig;
  fetch: NotifyFetch;
  warnOnce(key: string, message: string, fields?: Record<string, unknown>): void;
}

export interface NotifyTransport {
  name: string;
  send(message: NotifyMessage, context: NotifyTransportContext): Promise<NotifyTransportResult>;
}

export interface CreateNotifyStageOptions {
  transports?: readonly NotifyTransport[];
  fetch?: NotifyFetch;
  /** outbox 再試行時に送信済み transport を除外する */
  skipTransports?: readonly string[];
}

export interface OperationalNotifyInput {
  id: string;
  title: string;
  body: string;
  priority?: number;
  detailUrl?: string;
  /** 復旧コマンド等、macOS 通知でも全文が必要な運用メッセージにだけ指定する。 */
  fullMacosBody?: boolean;
}

export interface OperationalNotifyResult {
  attempted: boolean;
  sent: boolean;
  sentTransports?: string[];
  failedTransports?: string[];
}

interface RuntimeResourceOutboxStore {
  listPendingRuntimeResourceOutbox(limit?: number, now?: number): RuntimeResourceOutboxRow[];
  markRuntimeResourceOutbox(
    id: number,
    status: "sent" | "failed",
    nextAttemptAt?: number,
    sentTransports?: readonly string[],
  ): RuntimeResourceOutboxRow;
}

interface RuntimeCleanupNotificationPayload {
  route: "orchestrator_fyi" | "human_question";
  question: string;
  taskId: string | null;
  expectedLeaseFence: number;
  escalationGeneration: number;
  nonce?: string;
}

function parseRuntimeCleanupNotificationPayload(value: string): RuntimeCleanupNotificationPayload | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      (parsed.route !== "orchestrator_fyi" && parsed.route !== "human_question") ||
      typeof parsed.question !== "string" ||
      (parsed.taskId !== null && typeof parsed.taskId !== "string") ||
      !Number.isInteger(parsed.expectedLeaseFence) ||
      !Number.isInteger(parsed.escalationGeneration) ||
      (parsed.nonce !== undefined && typeof parsed.nonce !== "string")
    ) {
      return null;
    }
    return parsed as unknown as RuntimeCleanupNotificationPayload;
  } catch {
    return null;
  }
}

export interface WatchNotifyState {
  lastEventId: number;
}

/**
 * AppleScript の二重引用符文字列リテラルとして安全な形にエスケープする
 * （バックスラッシュを先に、続けてダブルクォートを変換。順序を逆にすると二重エスケープになる）。
 */
function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** osascript の display notification を使った既定の通知実装（契約 §18）。失敗しても throw しない */
export function osascriptNotifier(taskId: string, message: string, title = `hachi-kanban: ${taskId}`): boolean {
  const script = `display notification "${escapeAppleScriptString(message)}" with title "${escapeAppleScriptString(title)}"`;
  try {
    const result = spawnSync("osascript", ["-e", script]);
    return result.status === 0 && result.error === undefined;
  } catch {
    return false;
  }
}

/** macOS 通知 transport（既存 osascript 実装の薄い adapter） */
export function createMacosTransport(notifier: Notifier = osascriptNotifier): NotifyTransport {
  return {
    name: "macos",
    send(message: NotifyMessage): Promise<NotifyTransportResult> {
      const ok = notifier(message.taskId, message.macosMessage, message.macosTitle);
      return Promise.resolve(ok ? { status: "sent" } : { status: "failed" });
    },
  };
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

interface TelegramTokenOk {
  ok: true;
  token: string;
}

interface TelegramTokenNg {
  ok: false;
  fields: Record<string, unknown>;
}

type TelegramTokenResult = TelegramTokenOk | TelegramTokenNg;

/** telegram-token を値非表示で検査し、送信に必要な token だけを返す */
function readTelegramToken(env: Environment): TelegramTokenResult {
  const path = join(env.home, "telegram-token");
  if (!existsSync(path)) {
    return { ok: false, fields: { tokenPath: path, tokenExists: false } };
  }

  let mode: string;
  try {
    mode = formatMode(statSync(path).mode);
  } catch (err) {
    return {
      ok: false,
      fields: { tokenPath: path, tokenExists: "unknown", tokenMode: "unknown", error: (err as Error).message },
    };
  }

  if (mode !== "0600") {
    return { ok: false, fields: { tokenPath: path, tokenExists: true, tokenMode: mode, expectedMode: "0600" } };
  }

  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch (err) {
    return {
      ok: false,
      fields: { tokenPath: path, tokenExists: true, tokenMode: mode, error: (err as Error).message },
    };
  }

  if (token === "" || !TELEGRAM_TOKEN_PATTERN.test(token)) {
    return { ok: false, fields: { tokenPath: path, tokenExists: true, tokenMode: mode, tokenValid: false } };
  }

  return { ok: true, token };
}

function buildTaskUrl(baseUrl: string, taskId: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(`task/${encodeURIComponent(taskId)}`, normalizedBase).toString();
}

export function buildTelegramText(message: NotifyMessage): string {
  return [
    `${message.actionLabel} — ${message.title}`,
    `id: ${message.taskId}`,
    `${message.bodyLabel ?? "block_reason"}: ${message.redactedReason}`,
    `url: ${message.detailUrl}`,
  ].join("\n");
}

function watchNotifyStatePath(env: Environment): string {
  return join(env.home, "state", "watch-notify.json");
}

export function readWatchNotifyState(env: Environment): WatchNotifyState {
  const filePath = watchNotifyStatePath(env);
  if (!existsSync(filePath)) {
    return { lastEventId: 0 };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<WatchNotifyState>;
    if (Number.isInteger(parsed.lastEventId) && parsed.lastEventId !== undefined && parsed.lastEventId >= 0) {
      return { lastEventId: parsed.lastEventId };
    }
  } catch {
    // 壊れた state は取りこぼし防止のため初期値へ戻す
  }
  return { lastEventId: 0 };
}

export function writeWatchNotifyState(env: Environment, state: WatchNotifyState): void {
  const dir = join(env.home, "state");
  mkdirSync(dir, { recursive: true });
  const filePath = watchNotifyStatePath(env);
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmpPath, filePath);
}

type TelegramAttemptClassification = "success" | "network" | "timeout" | "http-429" | "http-4xx" | "http-5xx" | "http-other";

interface TelegramAttemptResult {
  classification: TelegramAttemptClassification;
  retryable: boolean;
  response?: Response;
}

const defaultTelegramClock: TelegramTransportClock = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

function classifyTelegramResponse(response: Response): TelegramAttemptResult {
  if (response.ok) {
    return { classification: "success", retryable: false, response };
  }
  if (response.status === 429) {
    return { classification: "http-429", retryable: true, response };
  }
  if (response.status >= 500 && response.status <= 599) {
    return { classification: "http-5xx", retryable: true, response };
  }
  if (response.status >= 400 && response.status <= 499) {
    return { classification: "http-4xx", retryable: false, response };
  }
  return { classification: "http-other", retryable: false, response };
}

function classifyTelegramFetchError(error: unknown): TelegramAttemptResult {
  const name = error instanceof Error ? error.name : "";
  const classification: TelegramAttemptClassification = name === "AbortError" || name === "TimeoutError" ? "timeout" : "network";
  return { classification, retryable: true };
}

function retryAfterMs(response: Response | undefined, now: number): number {
  const value = response?.headers.get("Retry-After")?.trim();
  if (value === undefined || value === "") {
    return TELEGRAM_RETRY_BACKOFF_MS;
  }
  if (/^\d+$/.test(value)) {
    return Math.min(Number(value) * 1_000, TELEGRAM_MAX_RETRY_BACKOFF_MS);
  }
  if (!RETRY_AFTER_HTTP_DATE_PATTERN.test(value)) {
    return TELEGRAM_RETRY_BACKOFF_MS;
  }
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) {
    return TELEGRAM_RETRY_BACKOFF_MS;
  }
  return Math.min(Math.max(0, retryAt - now), TELEGRAM_MAX_RETRY_BACKOFF_MS);
}

/**
 * Telegram Bot API sendMessage transport（契約 §38.2）。一時故障時は at-least-once を優先して
 * 1回だけ再送するため、応答喪失後には同じ通知が重複して届く可能性がある。
 */
export function createTelegramTransport(options: CreateTelegramTransportOptions = {}): NotifyTransport {
  const clock = options.clock ?? defaultTelegramClock;
  return {
    name: "telegram",
    async send(message: NotifyMessage, context: NotifyTransportContext): Promise<NotifyTransportResult> {
      const telegramConfig = context.config.telegram;
      // 未設定時は契約 §38 の既定動作として全 human_queue を通知する。0 を補完して比較しない。
      const minPriority = telegramConfig.minPriority;
      if (minPriority !== undefined && message.priority < minPriority) {
        return { status: "skipped", fields: { reason: "below-min-priority", minPriority } };
      }

      const chatId = telegramConfig.chatId;
      const tokenResult = readTelegramToken(context.env);
      if (chatId === undefined || chatId === "" || !tokenResult.ok) {
        const fields: Record<string, unknown> = {
          transport: "telegram",
          chatIdConfigured: chatId !== undefined && chatId !== "",
        };
        if (!tokenResult.ok) {
          Object.assign(fields, tokenResult.fields);
        }
        context.warnOnce("telegram-credentials", "notify: telegram 通知をスキップしました（credential 未設定または不正）", fields);
        return { status: "skipped", fields };
      }

      const url = new URL(`/bot${tokenResult.token}/sendMessage`, TELEGRAM_API_BASE_URL).toString();
      // inline keyboard が設定されている場合は reply_markup を付与する（contract §42.2）
      const bodyObj: Record<string, unknown> = {
        chat_id: chatId,
        text: buildTelegramText(message),
        disable_web_page_preview: true,
      };
      if (message.inlineKeyboard !== undefined && message.inlineKeyboard.length > 0) {
        bodyObj.reply_markup = {
          inline_keyboard: message.inlineKeyboard.map((row) =>
            row.map((btn) => {
              if (btn.callbackData !== undefined) {
                return { text: btn.text, callback_data: btn.callbackData };
              }
              if (btn.url !== undefined) {
                return { text: btn.text, url: btn.url };
              }
              return { text: btn.text };
            }),
          ),
        };
      }
      const body = JSON.stringify(bodyObj);

      const requestInit: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        redirect: "manual",
      };

      let attemptCount = 0;
      let result: TelegramAttemptResult;
      do {
        attemptCount += 1;
        try {
          result = classifyTelegramResponse(await context.fetch(url, {
            ...requestInit,
            signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
          }));
        } catch (error) {
          result = classifyTelegramFetchError(error);
        }
        if (result.classification === "success") {
          return { status: "sent", fields: { attemptCount, finalClassification: result.classification } };
        }
        if (!result.retryable || attemptCount === 2) {
          return { status: "failed", fields: { attemptCount, finalClassification: result.classification } };
        }
        const backoffMs = result.classification === "http-429"
          ? retryAfterMs(result.response, clock.now())
          : TELEGRAM_RETRY_BACKOFF_MS;
        await clock.sleep(backoffMs);
      } while (attemptCount < 2);

      return { status: "failed", fields: { attemptCount, finalClassification: result.classification } };
    },
  };
}

function resolveNotifyConfig(config: HachiConfig): ResolvedNotifyConfig {
  const notify = (config as ConfigWithNotify).notify;
  return {
    transports: notify?.transports ?? DEFAULT_NOTIFY_TRANSPORTS,
    telegram: notify?.telegram ?? {},
  };
}

function createDefaultTransports(): readonly NotifyTransport[] {
  return [createMacosTransport(), createTelegramTransport()];
}

function createTransportMap(transports: readonly NotifyTransport[]): Map<string, NotifyTransport> {
  return new Map(transports.map((transport) => [transport.name, transport]));
}

function createWarnOnce(logger: Logger): NotifyTransportContext["warnOnce"] {
  const keys = new Set<string>();
  return (key: string, message: string, fields?: Record<string, unknown>): void => {
    if (keys.has(key)) {
      return;
    }
    keys.add(key);
    logger.warn(message, fields);
  };
}

export function deriveHumanQueueLabel(reason: string): string {
  if (reason.startsWith("review-required:")) {
    return "🔍 要レビュー確認";
  }
  if (reason.startsWith("user-decision:")) {
    return "📋 要判断";
  }
  if (reason.startsWith("user-feedback:")) {
    return "💬 要フィードバック";
  }
  if (reason.startsWith("needs-manual:")) {
    return "⚠️ 要対応";
  }
  if (reason.startsWith("auto-launch-failed:")) {
    return "🔁 起動失敗";
  }
  if (reason.startsWith("worker-question:")) {
    return "❓ ワーカー質問";
  }
  if (reason.startsWith("user-question:")) {
    return "📋 人間への質問";
  }
  return DEFAULT_ACTION_LABEL;
}

export function deriveWatchedLabel(toStatus: TaskStatus, reason = ""): string {
  if (toStatus === "done") {
    return "✅ 完了";
  }
  if (toStatus === "review") {
    return "🔍 レビュー入り";
  }
  if (toStatus === "ready") {
    return "🆕 起票/着手可";
  }
  if (toStatus === "blocked" && isInProgressReason(reason)) {
    return "▶️ 進行中";
  }
  if (toStatus === "archived") {
    return "🗄 アーカイブ";
  }
  return "🔄 状態変化";
}

export function deriveOperationalLabel(id: string): string {
  const normalized = id.toLowerCase();
  if (id === "brief") {
    return "🗓 ブリーフ";
  }
  if (id.startsWith("bridgewatch:")) {
    return "🚨 bridge警告";
  }
  if (normalized.includes("hygiene") || normalized.includes("reap")) {
    return "🧹 資源警告";
  }
  if (normalized.includes("stall")) {
    return "⏳ 停滞警告";
  }
  if (id.startsWith("orchestrator-question:")) {
    return "🤖 オーケストレーターへ質問";
  }
  if (id.startsWith("human-question:")) {
    return "📋 人間への質問";
  }
  if (id.startsWith("orchestrator-unavailable:")) {
    return "⚠️ オーケストレーター未回収";
  }
  if (id.startsWith("orchestrator-heartbeat-stale:")) {
    return "🚨 heartbeat警告";
  }
  return DEFAULT_ACTION_LABEL;
}

export function deriveStewardLabel(kind?: StewardAdHocKind): string {
  switch (kind) {
    case "escalate":
      return "📣 要方針判断";
    case "promote":
      return "⬆️ 昇格提案";
    case "archive":
      return "🗄 アーカイブ提案";
    case "spec-lint":
      return "📝 仕様指摘";
    case "archive-vetoed":
      return "🚫 アーカイブ見送り";
    default:
      return "🏛 steward";
  }
}

function buildMacosMessage(title: string, body: string): string {
  if (body === "") {
    return title;
  }
  return [title, body].join("\n");
}

function buildNotifyMessage(task: TaskRow, reasonHash: string, config: ResolvedNotifyConfig): NotifyMessage {
  const redactedReason = redactText(task.blockReason);
  const redactedTitle = redactText(task.title);
  const actionLabel = deriveHumanQueueLabel(task.blockReason);
  const baseUrl = config.telegram.baseUrl ?? DEFAULT_WEB_BASE_URL;
  return {
    taskId: task.id,
    actionLabel,
    title: redactedTitle,
    priority: task.priority,
    reasonHash,
    redactedReason,
    macosTitle: actionLabel,
    macosMessage: buildMacosMessage(redactedTitle, redactedReason.slice(0, REASON_NOTICE_LIMIT)),
    detailUrl: buildTaskUrl(baseUrl, task.id),
  };
}

export function buildAdHocNotifyMessage(
  task: TaskRow,
  messageText: string,
  config: ResolvedNotifyConfig,
  stewardKind?: StewardAdHocKind,
): NotifyMessage {
  const redactedReason = redactText(messageText);
  const redactedTitle = redactText(task.title);
  const actionLabel = deriveStewardLabel(stewardKind);
  const baseUrl = config.telegram.baseUrl ?? DEFAULT_WEB_BASE_URL;
  return {
    taskId: task.id,
    actionLabel,
    title: redactedTitle,
    priority: task.priority,
    reasonHash: sha256Hex(redactedReason).slice(0, 8),
    redactedReason,
    macosTitle: actionLabel,
    macosMessage: buildMacosMessage(redactedTitle, redactedReason.slice(0, REASON_NOTICE_LIMIT)),
    detailUrl: buildTaskUrl(baseUrl, task.id),
  };
}

function buildOperationalNotifyMessage(input: OperationalNotifyInput, config: ResolvedNotifyConfig): NotifyMessage {
  const redactedReason = redactText(input.body);
  const redactedTitle = redactText(input.title);
  const actionLabel = deriveOperationalLabel(input.id);
  const macosBody = input.fullMacosBody === true
    ? redactedReason
    : redactedReason.slice(0, REASON_NOTICE_LIMIT);
  return {
    taskId: input.id,
    actionLabel,
    title: redactedTitle,
    priority: input.priority ?? 1_000_000,
    reasonHash: sha256Hex(input.body).slice(0, 8),
    redactedReason,
    macosTitle: actionLabel,
    macosMessage: buildMacosMessage(redactedTitle, macosBody),
    detailUrl: input.detailUrl ?? config.telegram.baseUrl ?? DEFAULT_WEB_BASE_URL,
  };
}

interface WatchedTaskChangeGroup {
  task: TaskRow;
  changes: WatchedStatusChangedEvent[];
}

function watchedChangeText(changes: readonly WatchedStatusChangedEvent[]): string {
  if (changes.length === 1) {
    const change = changes[0]!;
    return `${change.from} -> ${change.to}`;
  }
  return changes.map((change) => `${change.from} -> ${change.to}`).join(", ");
}

function buildWatchedNotifyMessage(
  task: TaskRow,
  changes: readonly WatchedStatusChangedEvent[],
  config: ResolvedNotifyConfig,
): NotifyMessage {
  const baseUrl = config.telegram.baseUrl ?? DEFAULT_WEB_BASE_URL;
  const detailUrl = buildTaskUrl(baseUrl, task.id);
  const redactedTitle = redactText(task.title);
  const redactedStatus = redactText(watchedChangeText(changes));
  const lastChange = changes[changes.length - 1];
  const actionLabel =
    lastChange === undefined ? DEFAULT_ACTION_LABEL : deriveWatchedLabel(lastChange.to, lastChange.reason);
  return {
    taskId: task.id,
    actionLabel,
    title: redactedTitle,
    priority: task.priority,
    reasonHash: sha256Hex(changes.map((change) => change.event.id).join(",")).slice(0, 8),
    redactedReason: redactedStatus,
    bodyLabel: "status",
    macosTitle: actionLabel,
    macosMessage: [redactedTitle, redactedStatus, detailUrl].join("\n"),
    detailUrl,
  };
}

function isHumanQueueStatusChange(change: WatchedStatusChangedEvent): boolean {
  return change.to === "blocked" && isHumanQueueReason(change.reason);
}

function groupWatchedChanges(changes: readonly WatchedStatusChangedEvent[]): WatchedTaskChangeGroup[] {
  const groups = new Map<string, WatchedTaskChangeGroup>();
  for (const change of changes) {
    const existing = groups.get(change.task.id);
    if (existing === undefined) {
      groups.set(change.task.id, { task: change.task, changes: [change] });
      continue;
    }
    existing.changes.push(change);
  }
  return [...groups.values()].sort((left, right) => left.changes[0]!.event.id - right.changes[0]!.event.id);
}

async function sendWatchedMessageViaTransports(
  deps: StageDeps,
  message: NotifyMessage,
  transportMap: Map<string, NotifyTransport>,
  context: NotifyTransportContext,
): Promise<{ attempted: boolean; sent: boolean }> {
  let attempted = false;
  let sent = false;

  for (const transportName of context.config.transports) {
    const transport = transportMap.get(transportName);
    if (transport === undefined) {
      context.warnOnce(
        `unknown-transport:${transportName}`,
        "notify: 未実装の transport をスキップしました",
        { transport: transportName },
      );
      continue;
    }

    try {
      const result = await transport.send(message, context);
      if (result.status !== "skipped") {
        attempted = true;
      }
      if (result.status === "sent") {
        sent = true;
      }
      if (result.status === "failed") {
        deps.logger.warn("notify: watched transport 通知に失敗しました", {
          taskId: message.taskId,
          transport: transport.name,
          ...result.fields,
        });
      }
    } catch {
      attempted = true;
      deps.logger.warn("notify: watched transport 通知に失敗しました", {
        taskId: message.taskId,
        transport: transport.name,
      });
    }
  }

  return { attempted, sent };
}

/**
 * human_queue 以外の運用警告を §38 transport へ送る。DB イベントは記録せず、
 * transport の失敗は warn ログのみに留める。
 */
export async function sendOperationalNotification(
  deps: StageDeps,
  input: OperationalNotifyInput,
  options: CreateNotifyStageOptions = {},
): Promise<OperationalNotifyResult> {
  const transportMap = createTransportMap(options.transports ?? createDefaultTransports());
  const fetchImpl: NotifyFetch = options.fetch ?? fetch;
  const notifyConfig = resolveNotifyConfig(deps.config);
  const context: NotifyTransportContext = {
    env: deps.env,
    config: notifyConfig,
    fetch: fetchImpl,
    warnOnce: createWarnOnce(deps.logger),
  };
  const message = buildOperationalNotifyMessage(input, notifyConfig);
  let attempted = false;
  let sent = false;
  const sentTransports: string[] = [];
  const failedTransports: string[] = [];

  for (const transportName of notifyConfig.transports) {
    if (options.skipTransports?.includes(transportName) === true) {
      continue;
    }
    const transport = transportMap.get(transportName);
    if (transport === undefined) {
      context.warnOnce(
        `unknown-transport:${transportName}`,
        "notify: 未実装の transport をスキップしました",
        { transport: transportName },
      );
      failedTransports.push(transportName);
      continue;
    }

    try {
      const result = await transport.send(message, context);
      if (result.status !== "skipped") {
        attempted = true;
      }
      if (result.status === "sent") {
        sent = true;
        sentTransports.push(transportName);
      }
      if (result.status === "skipped") {
        // minPriority 等の意図的 skip は再送しても変わらないため、outbox 上はsettledとして扱う。
        sentTransports.push(transportName);
      }
      if (result.status === "failed") {
        failedTransports.push(transportName);
        deps.logger.warn("notify: operational transport 通知に失敗しました", {
          notificationId: input.id,
          transport: transport.name,
          ...result.fields,
        });
      }
    } catch {
      attempted = true;
      failedTransports.push(transportName);
      deps.logger.warn("notify: operational transport 通知に失敗しました", {
        notificationId: input.id,
        transport: transport.name,
      });
    }
  }

  return { attempted, sent, sentTransports, failedTransports };
}

/** block_reason が human_queue 系 prefix のいずれかで始まるかを判定する */
function isHumanQueueReason(reason: string): boolean {
  return HUMAN_QUEUE_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

/** block_reason の reasonHash（sha256 先頭8hex）を計算する */
function reasonHashOf(reason: string): string {
  return sha256Hex(reason).slice(0, 8);
}

/** 指定 reasonHash で既に human_notified イベントが記録済みかどうかを判定する */
function alreadyNotified(store: KanbanStore, taskId: string, reasonHash: string): boolean {
  return store.listEvents(taskId, "human_notified").some((event) => {
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      return payload.reasonHash === reasonHash;
    } catch {
      return false;
    }
  });
}

function resolveTelegramApprovalKind(store: KanbanStore, task: TaskRow): NonceKind | null {
  if (findLatestStewardPromoteProposalEventId(store, task) !== null) {
    return "steward-promote";
  }
  if (task.blockReason.startsWith("user-decision:")) {
    return "user-decision";
  }
  return null;
}

function buildInlineKeyboard(taskId: string, kind: NonceKind, nonce: string, detailUrl: string): InlineButton[][] {
  if (kind === "steward-promote") {
    return [
      [{ text: "✓ ready 化を承認", callbackData: `approve:${taskId}:${nonce}` }],
      [{ text: "✕ 却下", callbackData: `reject:${taskId}:${nonce}` }],
    ];
  }
  return [
    [{ text: "✓ 承認して done", callbackData: `approve:${taskId}:${nonce}` }],
    [{ text: "詳細", url: detailUrl }],
  ];
}

async function sendViaConfiguredTransports(
  deps: StageDeps,
  message: NotifyMessage,
  transportMap: Map<string, NotifyTransport>,
): Promise<boolean> {
  const { logger } = deps;
  const notifyConfig = resolveNotifyConfig(deps.config);
  const context: NotifyTransportContext = {
    env: deps.env,
    config: notifyConfig,
    fetch,
    warnOnce: createWarnOnce(logger),
  };
  let attempted = false;

  for (const transportName of notifyConfig.transports) {
    const transport = transportMap.get(transportName);
    if (transport === undefined) {
      context.warnOnce(
        `unknown-transport:${transportName}`,
        "notify: 未実装の transport をスキップしました",
        { transport: transportName },
      );
      continue;
    }

    try {
      const result = await transport.send(message, context);
      if (result.status !== "skipped") {
        attempted = true;
      }
      if (result.status === "failed") {
        logger.warn("notify: transport 通知に失敗しました", {
          taskId: message.taskId,
          transport: transport.name,
          ...result.fields,
        });
      }
    } catch {
      attempted = true;
      logger.warn("notify: transport 通知に失敗しました", { taskId: message.taskId, transport: transport.name });
    }
  }

  return attempted;
}

/** steward 等の human_queue 以外の通知を §38 transport 設定で送る（イベント記録は呼び出し側の責務） */
export async function sendAdHocNotification(
  deps: StageDeps,
  task: TaskRow,
  messageText: string,
  stewardKind?: StewardAdHocKind,
): Promise<boolean> {
  const notifyConfig = resolveNotifyConfig(deps.config);
  const message = buildAdHocNotifyMessage(task, messageText, notifyConfig, stewardKind);
  return sendViaConfiguredTransports(deps, message, createTransportMap(createDefaultTransports()));
}

/**
 * notify ステージの factory。transport/fetch を差し替え可能にすることで、テストが実通知や
 * 実 Telegram API を発火しない構造にする（契約 §18, §38 実装ノート）。
 */
export function createNotifyStage(options: CreateNotifyStageOptions = {}): Stage {
  const transportMap = createTransportMap(options.transports ?? createDefaultTransports());
  const fetchImpl: NotifyFetch = options.fetch ?? fetch;

  return {
    name: "notify",

    async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
      const { store, logger } = deps;
      const notifyConfig = resolveNotifyConfig(deps.config);
      const context: NotifyTransportContext = {
        env: deps.env,
        config: notifyConfig,
        fetch: fetchImpl,
        warnOnce: createWarnOnce(logger),
      };
      const notes: string[] = [];
      let actions = 0;

      // Telegram inline keyboard 用の nonce state を管理する（contract §42.2）
      const hasTelegram = notifyConfig.transports.includes("telegram");
      let telegramState: TelegramInState | null = null;
      let telegramStateModified = false;
      if (hasTelegram && apply) {
        telegramState = readTelegramInState(deps.env);
      }

      // contract §55.4: worker question / human escalation 通知は outbox を唯一の正本にする。
      for (const outbox of store.listPendingNotificationOutbox(100, now)) {
        actions += 1;
        if (!apply) {
          notes.push(`dry-run: notification outbox#${outbox.id} (${outbox.kind}) を送信予定`);
          continue;
        }
        const task = store.getTask(outbox.taskId);
        if (task === null) {
          store.markNotificationOutbox(outbox.id, "failed", now + 300);
          notes.push(`outbox#${outbox.id}: task 不在のため送信延期`);
          continue;
        }
        let question = task.blockReason;
        try {
          const payload = JSON.parse(outbox.payload) as Record<string, unknown>;
          if (typeof payload.question === "string") {
            question = payload.question;
          }
        } catch {
          // payload 不正時も blockReason を使って通知自体は継続する（値は後段で redact）。
        }
        const idPrefix = outbox.kind === "orchestrator_fyi"
          ? "orchestrator-question"
          : outbox.kind === "human_question"
            ? "human-question"
            : "orchestrator-unavailable";
        const body = outbox.kind === "orchestrator_fyi"
          ? `ワーカー質問をオーケストレーター回収キューへ登録しました。返信は不要です。\n${question}`
          : outbox.kind === "human_question"
            ? question
            : `質問を受け取れるオーケストレーターが登録されていません。\n${question}`;
        const result = await sendOperationalNotification(
          deps,
          {
            id: `${idPrefix}:${outbox.requestId}`,
            title: `${task.title} (${task.id})`,
            body,
            priority: task.priority,
            detailUrl: `http://127.0.0.1:9131/task/${task.id}`,
          },
          { ...options, skipTransports: outbox.sentTransports },
        );
        const settledTransports = [...new Set([...outbox.sentTransports, ...(result.sentTransports ?? [])])];
        const configuredTransports = notifyConfig.transports;
        const allSettled = configuredTransports.length > 0 && configuredTransports.every((name) => settledTransports.includes(name));
        store.markNotificationOutbox(
          outbox.id,
          allSettled ? "sent" : "failed",
          allSettled ? 0 : now + 60,
          settledTransports,
        );
        notes.push(`outbox#${outbox.id}: ${allSettled ? "送信" : "再試行待ち"} (${outbox.kind})`);
      }

      // contract §56.5: cleanup 通知も専用 outbox のみを正本にし、transport 別に再試行する。
      const runtimeStoreCandidate = store as unknown as Partial<RuntimeResourceOutboxStore>;
      if (
        typeof runtimeStoreCandidate.listPendingRuntimeResourceOutbox === "function" &&
        typeof runtimeStoreCandidate.markRuntimeResourceOutbox === "function"
      ) {
        const runtimeStore = runtimeStoreCandidate as RuntimeResourceOutboxStore;
        for (const outbox of runtimeStore.listPendingRuntimeResourceOutbox(100, now)) {
          actions += 1;
          if (!apply) {
            notes.push(`dry-run: runtime resource outbox#${outbox.id} (${outbox.transport}) を送信予定`);
            continue;
          }
          const payload = parseRuntimeCleanupNotificationPayload(outbox.payload);
          if (payload === null || outbox.requestId === null) {
            runtimeStore.markRuntimeResourceOutbox(outbox.id, "failed", now + 300, outbox.sentTransports);
            notes.push(`runtime outbox#${outbox.id}: payload 不正のため送信延期`);
            continue;
          }
          if (!notifyConfig.transports.includes(outbox.transport)) {
            runtimeStore.markRuntimeResourceOutbox(outbox.id, "sent", 0, [outbox.transport]);
            notes.push(`runtime outbox#${outbox.id}: 未設定 transport=${outbox.transport} をsettled`);
            continue;
          }
          const task = payload.taskId === null ? null : store.getTask(payload.taskId);
          const replyFence = payload.route === "human_question" && payload.nonce !== undefined
            ? `\ncleanup_request: ${outbox.requestId}\ncleanup_nonce: ${payload.nonce}`
            : "";
          const body = payload.route === "orchestrator_fyi"
            ? `cleanup 判断をオーケストレーターへ配送しました。返信は不要です。\n${payload.question}`
            : `${payload.question}${replyFence}`;
          const result = await sendOperationalNotification(
            deps,
            {
              id: `runtime-cleanup:${outbox.requestId}`,
              title: task === null ? `Runtime cleanup (${outbox.requestId})` : `${task.title} (${task.id})`,
              body,
              ...(task === null
                ? {}
                : { priority: task.priority, detailUrl: `http://127.0.0.1:9131/task/${task.id}` }),
            },
            {
              ...options,
              skipTransports: notifyConfig.transports.filter((transport) => transport !== outbox.transport),
            },
          );
          const sent = result.sentTransports?.includes(outbox.transport) === true;
          runtimeStore.markRuntimeResourceOutbox(
            outbox.id,
            sent ? "sent" : "failed",
            sent ? 0 : now + 60,
            sent ? [outbox.transport] : outbox.sentTransports,
          );
          notes.push(`runtime outbox#${outbox.id}: ${sent ? "送信" : "再試行待ち"} (${outbox.transport})`);
        }
      }

      for (const task of store.listByStatus("blocked")) {
        if (task.blockReason.startsWith("worker-question:") || task.blockReason.startsWith("user-question:")) {
          continue;
        }
        if (!isHumanQueueReason(task.blockReason)) {
          continue;
        }

        const reasonHash = reasonHashOf(task.blockReason);
        if (alreadyNotified(store, task.id, reasonHash)) {
          continue;
        }

        actions += 1;

        if (!apply) {
          notes.push(`dry-run: ${task.id} を通知予定 (reasonHash=${reasonHash})`);
          continue;
        }

        const message = buildNotifyMessage(task, reasonHash, notifyConfig);
        let registeredTelegramNonce: string | null = null;

        // user-decision / steward promote 提案に inline keyboard を付与する（contract §42.2）
        const approvalKind = hasTelegram && telegramState !== null ? resolveTelegramApprovalKind(store, task) : null;
        if (telegramState !== null && approvalKind !== null) {
          const snapshot = computeStateHash(store, task, approvalKind);
          const nonce = registerNonce(telegramState, {
            action: "approve",
            taskId: task.id,
            kind: approvalKind,
            stateHash: snapshot.stateHash,
            taskUpdatedAt: snapshot.taskUpdatedAt,
            mutationEventId: snapshot.mutationEventId,
            proposalEventId: snapshot.proposalEventId,
            createdAt: now * 1000,
          });
          message.inlineKeyboard = buildInlineKeyboard(task.id, approvalKind, nonce, message.detailUrl);
          registeredTelegramNonce = nonce;
          telegramStateModified = true;
        }

        let attempted = false;
        let telegramSent = false;
        for (const transportName of notifyConfig.transports) {
          const transport = transportMap.get(transportName);
          if (transport === undefined) {
            context.warnOnce(
              `unknown-transport:${transportName}`,
              "notify: 未実装の transport をスキップしました",
              { transport: transportName },
            );
            continue;
          }

          try {
            const result = await transport.send(message, context);
            if (result.status !== "skipped") {
              attempted = true;
            }
            if (transport.name === "telegram" && result.status === "sent") {
              telegramSent = true;
            }
            if (result.status === "failed") {
              // 通知はベストエフォート。失敗してもタスク状態は壊さず warn ログのみに留める（契約 §18, §38）。
              logger.warn("notify: transport 通知に失敗しました", {
                taskId: task.id,
                transport: transport.name,
                ...result.fields,
              });
            }
          } catch {
            attempted = true;
            logger.warn("notify: transport 通知に失敗しました", { taskId: task.id, transport: transport.name });
          }
        }

        if (registeredTelegramNonce !== null && !telegramSent && telegramState !== null) {
          delete telegramState.nonces[registeredTelegramNonce];
          telegramStateModified = true;
        }

        if (!attempted) {
          notes.push(`${task.id}: 通知 transport がすべて skip されたため human_notified を記録しませんでした (reasonHash=${reasonHash})`);
          continue;
        }
        store.addEvent(task.id, "human_notified", SUPERVISOR_ACTOR, { reasonHash });
        notes.push(`${task.id}: 人間確認キュー通知を実行しました (reasonHash=${reasonHash})`);
      }

      const watchState = readWatchNotifyState(deps.env);
      const watchedChanges = listWatchedStatusChangedEventsAfter(store, watchState.lastEventId, WATCH_NOTIFY_SCAN_LIMIT);
      const processedWatchEventIds = new Set<number>();

      for (const group of groupWatchedChanges(watchedChanges)) {
        const notifyChanges = group.changes.filter((change) => !isHumanQueueStatusChange(change));
        if (notifyChanges.length === 0) {
          for (const change of group.changes) {
            processedWatchEventIds.add(change.event.id);
          }
          notes.push(`${group.task.id}: human_queue と重複する watched 通知をスキップしました`);
          continue;
        }

        actions += 1;

        if (!apply) {
          notes.push(`${group.task.id}: watched 状態変化を通知予定 (${watchedChangeText(notifyChanges)})`);
          continue;
        }

        const message = buildWatchedNotifyMessage(group.task, notifyChanges, notifyConfig);
        const result = await sendWatchedMessageViaTransports(deps, message, transportMap, context);
        if (!result.sent) {
          const reason = result.attempted ? "transport 送信成功なし" : "通知 transport がすべて skip";
          notes.push(`${group.task.id}: watched 通知の cursor を進めませんでした (${reason})`);
          continue;
        }

        for (const change of group.changes) {
          processedWatchEventIds.add(change.event.id);
        }
        notes.push(`${group.task.id}: watched 状態変化を通知しました (${watchedChangeText(notifyChanges)})`);
      }

      if (apply && processedWatchEventIds.size > 0) {
        let nextLastEventId = watchState.lastEventId;
        for (const change of watchedChanges) {
          if (!processedWatchEventIds.has(change.event.id)) {
            break;
          }
          nextLastEventId = change.event.id;
        }
        if (nextLastEventId > watchState.lastEventId) {
          writeWatchNotifyState(deps.env, { lastEventId: nextLastEventId });
        }
      }

      // nonce state の永続化（inline keyboard を生成した場合のみ）
      if (telegramStateModified && telegramState !== null) {
        writeTelegramInState(deps.env, telegramState);
      }

      return { name: "notify", actions, skipped: false, notes };
    },
  };
}

/** supervisor 本体が使う既定 notify ステージ（osascript 通知） */
export const notifyStage: Stage = createNotifyStage();
