// Telegram 双方向ゲートウェイ（in）ステージ（contract §42）
// Bot API getUpdates の tick 内増分取得で、inline keyboard の approve/answer callback を処理する。
// 許可範囲は approve + answer のみ（fail-closed）。自由コマンド・任意遷移は受けない。
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactText, serializeAgentMessage } from "@hachi/core";
import type { AgentMessageV1, HachiConfig, KanbanStore, Stage, StageDeps, StageResult } from "@hachi/core";
import { SUPERVISOR_ACTOR } from "../constants.js";
import {
  computeStateHash,
  consumeNonce,
  pruneExpiredNonces,
  readTelegramInState,
  writeTelegramInState,
  type NonceEntry,
} from "./telegram-nonce.js";

// ========== 定数 ==========

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;
const TELEGRAM_TOKEN_PATTERN = /^[0-9]+:[A-Za-z0-9_-]+$/;
const GET_UPDATES_LIMIT = 100;

// ========== Telegram API レスポンス型 ==========

interface TelegramChat {
  id: number;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  text?: string;
  reply_to_message?: TelegramMessage;
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
  message?: TelegramMessage;
}

interface TelegramApiResponse {
  ok: boolean;
  result?: TelegramUpdate[];
}

// ========== callback_data パーサー ==========

interface ParsedCallback {
  action: string;
  taskId: string;
  nonce: string;
}

interface RuntimeCleanupHumanAnswerStore {
  recordHumanAnswerForRuntimeCleanupRequest(
    requestId: string,
    nonce: string,
    answer: string,
    now?: number,
  ): { id: string; status: string } | null;
}

interface RuntimeCleanupReplyFence {
  requestId: string;
  nonce: string;
}

function extractRuntimeCleanupReplyFence(text: string): RuntimeCleanupReplyFence | null {
  const requestId = text.match(/^cleanup_request:\s*([A-Za-z0-9_-]+)\s*$/m)?.[1];
  const nonce = text.match(/^cleanup_nonce:\s*([0-9a-f]{32,128})\s*$/m)?.[1];
  return requestId === undefined || nonce === undefined ? null : { requestId, nonce };
}

/** callback_data をパースする。形式: <action>:<taskId>:<nonce>（contract §42.2） */
function parseCallbackData(data: string): ParsedCallback | null {
  const parts = data.split(":");
  if (parts.length !== 3) {
    return null;
  }
  const [action, taskId, nonce] = parts as [string, string, string];
  if (action === "" || taskId === "" || nonce === "") {
    return null;
  }
  return { action, taskId, nonce };
}

/** 通知メッセージ本文から taskId を抽出する（notify が送信した定型フォーマット） */
function extractTaskIdFromText(text: string): string | null {
  const match = /^id: (t_[a-f0-9]+)$/m.exec(text);
  return match !== null ? match[1]! : null;
}

// ========== credential 読み取り ==========

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

interface TelegramCredentials {
  token: string;
  chatId: string;
}

interface TelegramInConfig {
  chatId?: string;
}

interface NotifySection {
  telegram?: TelegramInConfig;
}

interface ConfigWithNotify extends HachiConfig {
  notify?: NotifySection;
}

function resolveChatId(config: HachiConfig): string | undefined {
  return (config as ConfigWithNotify).notify?.telegram?.chatId;
}

/** Telegram token と chatId を読み込む。未設定・不正の場合は null を返す */
function readCredentials(home: string, chatId: string | undefined): TelegramCredentials | null {
  if (chatId === undefined || chatId === "") {
    return null;
  }

  const tokenPath = join(home, "telegram-token");
  if (!existsSync(tokenPath)) {
    return null;
  }

  try {
    const mode = formatMode(statSync(tokenPath).mode);
    if (mode !== "0600") {
      return null;
    }
  } catch {
    return null;
  }

  let token: string;
  try {
    token = readFileSync(tokenPath, "utf8").trim();
  } catch {
    return null;
  }

  if (token === "" || !TELEGRAM_TOKEN_PATTERN.test(token)) {
    return null;
  }

  return { token, chatId };
}

// ========== fetch DI 型 ==========

/** テスト用に差し替え可能な fetch 型（contract §42 実装ノート: 実 API 呼び出し禁止） */
export type TelegramFetch = (url: string, init: RequestInit) => Promise<Response>;

// ========== Telegram API ヘルパー ==========

/** Bot API getUpdates を呼び出す（timeout=0 で即時応答、tick 内増分取得） */
async function fetchUpdates(
  token: string,
  offset: number,
  fetchImpl: TelegramFetch,
): Promise<TelegramUpdate[]> {
  const url = `${TELEGRAM_API_BASE_URL}/bot${token}/getUpdates?offset=${offset}&limit=${GET_UPDATES_LIMIT}&timeout=0`;
  const response = await fetchImpl(url, {
    method: "GET",
    signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return [];
  }
  const data = (await response.json()) as TelegramApiResponse;
  if (!data.ok || !Array.isArray(data.result)) {
    return [];
  }
  return data.result;
}

/** answerCallbackQuery でボタンのローディング表示を解除する */
async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text: string,
  fetchImpl: TelegramFetch,
): Promise<void> {
  const url = `${TELEGRAM_API_BASE_URL}/bot${token}/answerCallbackQuery`;
  await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
  }).catch(() => {
    // answerCallbackQuery の失敗はベストエフォート（返信が出ないだけで状態は壊れない）
  });
}

/** 操作結果を同一 chat に返信する（contract §42.3: token・秘密値は返信に含めない） */
async function sendReply(
  token: string,
  chatId: string,
  text: string,
  fetchImpl: TelegramFetch,
): Promise<void> {
  const url = `${TELEGRAM_API_BASE_URL}/bot${token}/sendMessage`;
  await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
  }).catch(() => {
    // 返信の失敗はベストエフォート
  });
}

// ========== approve 処理（contract §42.2） ==========

interface ApproveResult {
  applied: boolean;
  message: string;
}

function hasCompleteSnapshot(entry: NonceEntry): boolean {
  return (
    typeof entry.taskUpdatedAt === "number" &&
    typeof entry.mutationEventId === "number" &&
    (entry.kind === "steward-promote"
      ? typeof entry.proposalEventId === "number"
      : entry.proposalEventId === null)
  );
}

/**
 * approve アクションを実行する。supervisor が状態を再検証してから遷移する。
 * すでに動いた/消えたタスクは「適用不能」を返信する（contract §42.2）。
 */
function executeApprove(store: KanbanStore, entry: NonceEntry, nonce: string): ApproveResult {
  if (entry.action !== "approve") {
    return { applied: false, message: "適用不能: nonce の操作種別が一致しません" };
  }

  if (!hasCompleteSnapshot(entry)) {
    return { applied: false, message: "適用不能: nonce の提案スナップショットが不足しています" };
  }

  const task = store.getTask(entry.taskId);

  // タスクが存在しない
  if (task === null) {
    return { applied: false, message: `適用不能: タスク ${entry.taskId} が見つかりません` };
  }

  // タスクが blocked でない（既に動いた）
  if (task.status !== "blocked") {
    return { applied: false, message: `適用不能: タスク ${entry.taskId} は既に ${task.status} 状態です` };
  }

  // 状態再検証: 提案時点の snapshot と現在の snapshot を比較（stale 検出）
  const currentSnapshot = computeStateHash(store, task, entry.kind);
  if (
    currentSnapshot.stateHash !== entry.stateHash ||
    currentSnapshot.taskUpdatedAt !== entry.taskUpdatedAt ||
    currentSnapshot.mutationEventId !== entry.mutationEventId ||
    currentSnapshot.proposalEventId !== entry.proposalEventId
  ) {
    return { applied: false, message: `適用不能: タスク ${entry.taskId} の状態が変更されています` };
  }

  // kind に応じた遷移
  if (entry.kind === "user-decision") {
    // user-decision の解消（blocked→done）。Telegram 操作 = 人間承認として two-party gate を満たす
    store.transition({
      taskId: entry.taskId,
      to: "done",
      actor: SUPERVISOR_ACTOR,
      eventType: "telegram_approve",
      payload: { kind: "user-decision", nonce, source: "telegram" },
    });
    return { applied: true, message: `✓ ${entry.taskId} を done に遷移しました` };
  }

  if (entry.kind === "steward-promote") {
    // steward promote 提案の適用（blocked→ready）。contract §40.4
    store.transition({
      taskId: entry.taskId,
      to: "ready",
      actor: SUPERVISOR_ACTOR,
      eventType: "telegram_approve",
      payload: { kind: "steward-promote", nonce, source: "telegram" },
    });
    return { applied: true, message: `✓ ${entry.taskId} を ready に遷移しました` };
  }

  // 未知の kind（fail-closed）
  return { applied: false, message: `適用不能: 未知の承認種別です` };
}

function executeReject(store: KanbanStore, entry: NonceEntry, nonce: string): ApproveResult {
  if (entry.kind !== "steward-promote") {
    return { applied: false, message: "適用不能: 却下できる提案ではありません" };
  }
  if (!hasCompleteSnapshot(entry)) {
    return { applied: false, message: "適用不能: nonce の提案スナップショットが不足しています" };
  }

  const task = store.getTask(entry.taskId);
  if (task === null) {
    return { applied: false, message: `適用不能: タスク ${entry.taskId} が見つかりません` };
  }
  if (task.status !== "blocked") {
    return { applied: false, message: `適用不能: タスク ${entry.taskId} は既に ${task.status} 状態です` };
  }

  const currentSnapshot = computeStateHash(store, task, entry.kind);
  if (
    currentSnapshot.stateHash !== entry.stateHash ||
    currentSnapshot.taskUpdatedAt !== entry.taskUpdatedAt ||
    currentSnapshot.mutationEventId !== entry.mutationEventId ||
    currentSnapshot.proposalEventId !== entry.proposalEventId
  ) {
    return { applied: false, message: `適用不能: タスク ${entry.taskId} の状態が変更されています` };
  }

  store.addEvent(entry.taskId, "telegram_rejected", SUPERVISOR_ACTOR, {
    reason: "declined",
    kind: entry.kind,
    nonce,
    source: "telegram",
  });
  return { applied: true, message: `✓ ${entry.taskId} の ready 化提案を却下しました` };
}

// ========== answer 処理（contract §42.2） ==========

/**
 * answer アクションを実行する。返信テキストをタスクのコメントとして記録し、
 * telegram_answer 監査イベントを書く（contract §42.2）。
 */
function executeAnswer(
  store: KanbanStore,
  taskId: string,
  text: string,
  idempotencyKey: string,
  createdAt: number,
): { applied: boolean; message: string } {
  const task = store.getTask(taskId);
  if (task === null) {
    return { applied: false, message: `適用不能: タスク ${taskId} が見つかりません` };
  }

  const routedRequest = store.getActiveOrchestratorRequestByTask(taskId);
  if (routedRequest !== null) {
    if (routedRequest.status !== "waiting_human") {
      store.addEvent(taskId, "telegram_rejected", SUPERVISOR_ACTOR, {
        reason: "orchestrator-request-not-waiting-human",
        requestId: routedRequest.id,
        source: "telegram",
      });
      return { applied: false, message: `適用不能: ${taskId} はオーケストレーター処理中です` };
    }
    const routed = store.recordHumanAnswerForRequest(taskId, redactText(text));
    if (routed === null) {
      return { applied: false, message: `適用不能: ${taskId} の人間回答待ちが見つかりません` };
    }
    store.addEvent(taskId, "telegram_answer", SUPERVISOR_ACTOR, {
      source: "telegram",
      textLength: text.length,
      idempotencyKey,
      requestId: routed.id,
      routedTo: "orchestrator",
    });
    return { applied: true, message: `✓ ${taskId} の回答をオーケストレーターへ返しました` };
  }

  // Telegram 入力を既存 messages 経路に乗せるため、agent.message.v1 としてコメントへ記録する。
  const redacted = redactText(text);
  const msg: AgentMessageV1 = {
    schema: "agent.message.v1",
    from: { role: "human", provider: "", sessionId: "" },
    to: { role: "worker", taskId },
    intent: "answer",
    payload: { message: redacted },
    idempotencyKey,
    createdAt,
  };
  store.addComment(taskId, "human", serializeAgentMessage(msg));
  store.addEvent(taskId, "telegram_answer", SUPERVISOR_ACTOR, {
    source: "telegram",
    textLength: text.length,
    idempotencyKey,
  });

  return { applied: true, message: `✓ ${taskId} に answer を記録しました` };
}

// ========== ステージ本体 ==========

export interface CreateTelegramInStageOptions {
  /** テスト用 fetch 注入（実 Telegram API をテストから呼ばない。contract §42 実装ノート） */
  fetch?: TelegramFetch;
}

/**
 * telegram-in ステージの factory（contract §42）。
 * supervisor STAGES 末尾に配置し、notify（§38）が送った inline keyboard への
 * 応答を増分取得・処理する。
 */
export function createTelegramInStage(options: CreateTelegramInStageOptions = {}): Stage {
  const fetchImpl: TelegramFetch = options.fetch ?? fetch;

  return {
    name: "telegram-in",

    async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
      const { store, logger, env, config } = deps;
      const notes: string[] = [];
      let actions = 0;
      const nowMs = now * 1000;

      if (existsSync(join(env.home, "telegram-in.disabled"))) {
        return { name: "telegram-in", actions: 0, skipped: true, notes: ["telegram-in.disabled のためスキップ"] };
      }

      // credential の読み込み（token/chatId は §38.2 と同一のもの。未設定なら skip）
      const chatId = resolveChatId(config);
      const credentials = readCredentials(env.home, chatId);
      if (credentials === null) {
        return { name: "telegram-in", actions: 0, skipped: false, notes: ["credential 未設定のためスキップ"] };
      }

      // state 読み込み + 期限切れ nonce の掃除
      const state = readTelegramInState(env);
      const pruned = pruneExpiredNonces(state, nowMs);
      if (pruned > 0) {
        notes.push(`期限切れ nonce ${pruned} 件を削除`);
      }

      // dry-run は getUpdates を呼ばない（副作用なし）
      if (!apply) {
        notes.push("dry-run: getUpdates をスキップ");
        return { name: "telegram-in", actions: 0, skipped: false, notes };
      }

      // getUpdates 呼び出し（tick 内増分取得。contract §42.1）
      let updates: TelegramUpdate[];
      try {
        updates = await fetchUpdates(credentials.token, state.updateOffset, fetchImpl);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("telegram-in: getUpdates に失敗しました", { error: redactText(message) });
        writeTelegramInState(env, state);
        return { name: "telegram-in", actions: 0, skipped: false, notes: ["getUpdates 失敗"] };
      }

      if (updates.length === 0) {
        if (pruned > 0) {
          writeTelegramInState(env, state);
        }
        return { name: "telegram-in", actions: 0, skipped: false, notes };
      }

      // offset を更新（max update_id + 1。contract §42.1 冪等カーソル）
      let maxUpdateId = state.updateOffset;
      for (const update of updates) {
        if (update.update_id >= maxUpdateId) {
          maxUpdateId = update.update_id + 1;
        }
      }
      state.updateOffset = maxUpdateId;

      // 各 update を処理
      for (const update of updates) {
        // ---- callback_query の処理（approve ボタン押下） ----
        if (update.callback_query !== undefined) {
          const cq = update.callback_query;
          const cqChatId = cq.message?.chat?.id;

          // chat_id allowlist チェック（contract §42.1: 盗聴的試行は warn + 監査イベント記録）
          if (cqChatId === undefined || String(cqChatId) !== credentials.chatId) {
            logger.warn("telegram-in: 許可されていない chat からの callback を無視しました", {
              chatId: cqChatId !== undefined ? String(cqChatId) : "unknown",
            });
            const parsed = cq.data !== undefined ? parseCallbackData(cq.data) : null;
            if (parsed !== null) {
              safeAddEvent(store, parsed.taskId, "telegram_rejected", {
                reason: "unauthorized-chat",
                chatId: cqChatId !== undefined ? String(cqChatId) : "unknown",
              });
            }
            await answerCallbackQuery(credentials.token, cq.id, "権限がありません", fetchImpl);
            actions += 1;
            continue;
          }

          // callback_data のパース
          if (cq.data === undefined || cq.data === "") {
            await answerCallbackQuery(credentials.token, cq.id, "不正なデータ", fetchImpl);
            actions += 1;
            continue;
          }

          const parsed = parseCallbackData(cq.data);
          if (parsed === null) {
            await answerCallbackQuery(credentials.token, cq.id, "不正なデータ形式", fetchImpl);
            actions += 1;
            continue;
          }

          // approve アクション
          if (parsed.action === "approve") {
            actions += 1;
            const notePrefix = `${parsed.taskId}:`;

            // nonce の消費・検証
            const entry = consumeNonce(state, parsed.nonce, nowMs);
            if (entry === null) {
              logger.warn("telegram-in: 無効な nonce による approve を拒否しました", { taskId: parsed.taskId });
              safeAddEvent(store, parsed.taskId, "telegram_rejected", {
                reason: "invalid-nonce",
                source: "telegram",
              });
              await answerCallbackQuery(credentials.token, cq.id, "期限切れまたは無効な操作です", fetchImpl);
              await sendReply(
                credentials.token,
                credentials.chatId,
                `適用不能: nonce が無効または期限切れです (${parsed.taskId})`,
                fetchImpl,
              );
              notes.push(`${notePrefix} nonce 無効のため approve を拒否`);
              continue;
            }

            // taskId 一致確認（callback_data と nonce 登録時の紐付け検証）
            if (entry.taskId !== parsed.taskId) {
              logger.warn("telegram-in: nonce の taskId 不一致により approve を拒否しました", {
                expected: entry.taskId,
                actual: parsed.taskId,
              });
              safeAddEvent(store, parsed.taskId, "telegram_rejected", {
                reason: "taskId-mismatch",
                source: "telegram",
              });
              await answerCallbackQuery(credentials.token, cq.id, "不正な操作です", fetchImpl);
              notes.push(`${notePrefix} nonce taskId 不一致のため approve を拒否`);
              continue;
            }

            // approve 実行（状態再検証 → 遷移）
            const result = executeApprove(store, entry, parsed.nonce);
            if (!result.applied) {
              safeAddEvent(store, entry.taskId, "telegram_rejected", {
                reason: "state-changed",
                kind: entry.kind,
                source: "telegram",
              });
            }
            await answerCallbackQuery(
              credentials.token,
              cq.id,
              result.applied ? "適用しました" : "適用不能",
              fetchImpl,
            );
            await sendReply(credentials.token, credentials.chatId, result.message, fetchImpl);
            notes.push(`${notePrefix} ${result.applied ? "approve 適用" : "approve 拒否"} (${entry.kind})`);
            continue;
          }

          // steward promote 提案の却下。状態は動かさず、監査イベントだけを残す。
          if (parsed.action === "reject") {
            actions += 1;
            const notePrefix = `${parsed.taskId}:`;
            const entry = consumeNonce(state, parsed.nonce, nowMs);
            if (entry === null) {
              logger.warn("telegram-in: 無効な nonce による reject を拒否しました", { taskId: parsed.taskId });
              safeAddEvent(store, parsed.taskId, "telegram_rejected", {
                reason: "invalid-nonce",
                action: "reject",
                source: "telegram",
              });
              await answerCallbackQuery(credentials.token, cq.id, "期限切れまたは無効な操作です", fetchImpl);
              notes.push(`${notePrefix} nonce 無効のため reject を拒否`);
              continue;
            }
            if (entry.taskId !== parsed.taskId) {
              logger.warn("telegram-in: nonce の taskId 不一致により reject を拒否しました", {
                expected: entry.taskId,
                actual: parsed.taskId,
              });
              safeAddEvent(store, parsed.taskId, "telegram_rejected", {
                reason: "taskId-mismatch",
                action: "reject",
                source: "telegram",
              });
              await answerCallbackQuery(credentials.token, cq.id, "不正な操作です", fetchImpl);
              notes.push(`${notePrefix} nonce taskId 不一致のため reject を拒否`);
              continue;
            }

            const result = executeReject(store, entry, parsed.nonce);
            if (!result.applied) {
              safeAddEvent(store, entry.taskId, "telegram_rejected", {
                reason: "reject-not-applicable",
                kind: entry.kind,
                source: "telegram",
              });
            }
            await answerCallbackQuery(
              credentials.token,
              cq.id,
              result.applied ? "却下しました" : "適用不能",
              fetchImpl,
            );
            await sendReply(credentials.token, credentials.chatId, result.message, fetchImpl);
            notes.push(`${notePrefix} ${result.applied ? "reject 記録" : "reject 拒否"} (${entry.kind})`);
            continue;
          }

          logger.warn("telegram-in: 未知のアクションを拒否しました", { action: parsed.action });
          safeAddEvent(store, parsed.taskId, "telegram_rejected", {
            reason: "unknown-action",
            action: parsed.action,
            source: "telegram",
          });
          await answerCallbackQuery(credentials.token, cq.id, "未対応の操作です", fetchImpl);
          actions += 1;
          notes.push(`${parsed.taskId}: 未知のアクション ${parsed.action} を拒否`);
          continue;
        }

        // ---- message の処理（answer: テキスト返信） ----
        if (update.message !== undefined) {
          const msg = update.message;

          // chat_id allowlist チェック
          if (String(msg.chat.id) !== credentials.chatId) {
            logger.warn("telegram-in: 許可されていない chat からのメッセージを無視しました", {
              chatId: String(msg.chat.id),
            });
            const taskId = extractTaskIdFromText(msg.reply_to_message?.text ?? msg.text ?? "");
            if (taskId !== null) {
              safeAddEvent(store, taskId, "telegram_rejected", {
                reason: "unauthorized-chat",
                source: "telegram",
                updateType: "message",
              });
            }
            actions += 1;
            continue;
          }

          // reply_to_message が無い、またはテキストが無い場合は無視（fail-closed）
          const originalText = msg.reply_to_message?.text;
          if (originalText === undefined || msg.text === undefined || msg.text === "") {
            continue;
          }

          // runtime cleanup の human answer は request-scoped nonce で request に保存する。
          // worker への agent.message.v1 は生成せず、再 claim する orchestrator に解釈させる。
          const cleanupFence = extractRuntimeCleanupReplyFence(originalText);
          if (cleanupFence !== null) {
            const cleanupStore = store as unknown as Partial<RuntimeCleanupHumanAnswerStore>;
            const routed = typeof cleanupStore.recordHumanAnswerForRuntimeCleanupRequest === "function"
              ? cleanupStore.recordHumanAnswerForRuntimeCleanupRequest(
                  cleanupFence.requestId,
                  cleanupFence.nonce,
                  msg.text,
                  now,
                )
              : null;
            await sendReply(
              credentials.token,
              credentials.chatId,
              routed === null
                ? `適用不能: cleanup request ${cleanupFence.requestId} の nonce が無効または期限切れです`
                : `✓ cleanup request ${cleanupFence.requestId} の回答をオーケストレーター inbox へ返しました`,
              fetchImpl,
            );
            actions += 1;
            notes.push(`${cleanupFence.requestId}: ${routed === null ? "cleanup answer 拒否" : "cleanup answer 記録"}`);
            continue;
          }

          // 元メッセージから taskId を抽出
          const taskId = extractTaskIdFromText(originalText);
          if (taskId === null) {
            continue;
          }

          const idempotencyKey = `telegram-answer:${update.update_id}:${msg.message_id}`;
          const answerResult = executeAnswer(store, taskId, msg.text, idempotencyKey, now);
          await sendReply(credentials.token, credentials.chatId, answerResult.message, fetchImpl);
          actions += 1;
          notes.push(`${taskId}: ${answerResult.applied ? "answer 記録" : "answer 失敗"}`);
        }
      }

      // state 永続化（offset + 消費済み nonce の反映）
      writeTelegramInState(env, state);

      return { name: "telegram-in", actions, skipped: false, notes };
    },
  };
}

/**
 * store.addEvent のラッパー。タスクが存在しない場合のエラーを握り潰す。
 * 盗聴的試行や不正 callback の監査イベント記録で、タスク不在時にクラッシュしないようにする。
 */
function safeAddEvent(
  store: KanbanStore,
  taskId: string,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  try {
    store.addEvent(taskId, eventType, SUPERVISOR_ACTOR, payload);
  } catch {
    // タスクが存在しない場合は監査イベント記録をスキップ
  }
}

/** supervisor 本体が使う既定 telegram-in ステージ */
export const telegramInStage: Stage = createTelegramInStage();
