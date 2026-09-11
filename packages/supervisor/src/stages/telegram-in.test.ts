import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskInput } from "@hachi/testing";
import type { HachiConfig, Logger, TaskRow } from "@hachi/core";
import { setupHarness, type TestHarness } from "../test-support.js";
import { createTelegramInStage, type TelegramFetch } from "./telegram-in.js";
import {
  computeStateHash,
  readTelegramInState,
  registerNonce,
  writeTelegramInState,
  NONCE_EXPIRY_MS,
  type NonceKind,
  type TelegramInState,
} from "./telegram-nonce.js";
import {
  createNotifyStage,
  createTelegramTransport,
  type NotifyConfig,
  type NotifyFetch,
} from "./notify.js";
import { messagesStage } from "./messages.js";

// ========== テスト用の Telegram API レスポンスビルダー ==========

interface CallbackQueryUpdate {
  updateId: number;
  callbackQueryId: string;
  chatId: number;
  data: string;
  messageText?: string;
}

interface MessageUpdate {
  updateId: number;
  chatId: number;
  text: string;
  replyToText?: string;
}

/** callback_query 形式の update を構築する */
function buildCallbackUpdate(opts: CallbackQueryUpdate): Record<string, unknown> {
  return {
    update_id: opts.updateId,
    callback_query: {
      id: opts.callbackQueryId,
      from: { id: 12345 },
      message: {
        message_id: 100,
        chat: { id: opts.chatId },
        text: opts.messageText ?? "",
      },
      data: opts.data,
    },
  };
}

/** message（テキスト返信）形式の update を構築する */
function buildMessageUpdate(opts: MessageUpdate): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    message_id: 200,
    chat: { id: opts.chatId },
    text: opts.text,
  };
  if (opts.replyToText !== undefined) {
    msg.reply_to_message = {
      message_id: 99,
      chat: { id: opts.chatId },
      text: opts.replyToText,
    };
  }
  return { update_id: opts.updateId, message: msg };
}

/** getUpdates の成功レスポンスを返す */
function okUpdatesResponse(updates: Record<string, unknown>[]): Response {
  return new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 });
}

/** 空の成功レスポンス */
function okEmptyResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

// ========== テスト設定ヘルパー ==========

interface NotifyConfigExt extends HachiConfig {
  notify?: NotifyConfig;
}

interface WarningRecord {
  msg: string;
  fields?: Record<string, unknown>;
}

describe("telegramInStage", () => {
  let harness: TestHarness;
  const TEST_CHAT_ID = "999";
  const TEST_TOKEN = "123456:testBotToken";

  beforeEach(async () => {
    harness = await setupHarness();
    // Telegram 設定を注入
    (harness.deps.config as NotifyConfigExt).notify = {
      transports: ["telegram"],
      telegram: { chatId: TEST_CHAT_ID },
    };
    // token ファイルを作成
    writeTelegramToken(TEST_TOKEN);
  });

  afterEach(async () => {
    await harness.cleanup();
    vi.restoreAllMocks();
  });

  function writeTelegramToken(token: string, mode = 0o600): void {
    const tokenPath = join(harness.deps.env.home, "telegram-token");
    writeFileSync(tokenPath, token, { mode });
    chmodSync(tokenPath, mode);
  }

  /** user-decision blocked なタスクを作成する */
  function createUserDecisionTask(reason = "user-decision: モデル解決に失敗"): TaskRow {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "人間確認要" }), "tester");
    return harness.store.block(task.id, reason, "tester", "human");
  }

  /** タスクに対して有効な nonce を state に登録する */
  function registerApproveNonce(
    task: TaskRow,
    nowMs: number,
    kind: NonceKind = "user-decision",
  ): { nonce: string; state: TelegramInState } {
    const state = readTelegramInState(harness.deps.env);
    const snapshot = computeStateHash(harness.store, task, kind);
    const nonce = registerNonce(state, {
      action: "approve",
      taskId: task.id,
      kind,
      stateHash: snapshot.stateHash,
      taskUpdatedAt: snapshot.taskUpdatedAt,
      mutationEventId: snapshot.mutationEventId,
      proposalEventId: snapshot.proposalEventId,
      createdAt: nowMs,
    });
    writeTelegramInState(harness.deps.env, state);
    return { nonce, state };
  }

  /** fetch のモックを構築する（getUpdates + 他 API のレスポンスを制御） */
  function createFetchMock(
    getUpdatesResponse: Response,
    otherResponses: Response = okEmptyResponse(),
  ): ReturnType<typeof vi.fn<TelegramFetch>> {
    return vi.fn<TelegramFetch>(async (url: string, init: RequestInit): Promise<Response> => {
      void init;
      if (url.includes("/getUpdates")) {
        return getUpdatesResponse;
      }
      return otherResponses;
    });
  }

  function installWarningLogger(): WarningRecord[] {
    const warnings: WarningRecord[] = [];
    const logger: Logger = {
      info(): void {},
      warn(msg: string, fields?: Record<string, unknown>): void {
        warnings.push(fields !== undefined ? { msg, fields } : { msg });
      },
      error(): void {},
      child(): Logger {
        return logger;
      },
    };
    harness.deps.logger = logger;
    return warnings;
  }

  // ========== §42.1 基本動作 ==========

  it("credential 未設定時は skip して何もしない", async () => {
    delete (harness.deps.config as NotifyConfigExt).notify;
    const fetchMock = createFetchMock(okUpdatesResponse([]));
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(0);
    expect(result.notes).toContain("credential 未設定のためスキップ");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("token ファイルが存在しない場合は skip する", async () => {
    // token ファイルを削除（home を再構成）
    const tokenPath = join(harness.deps.env.home, "telegram-token");
    if (existsSync(tokenPath)) {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(tokenPath);
    }
    const fetchMock = createFetchMock(okUpdatesResponse([]));
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(0);
    expect(result.notes).toContain("credential 未設定のためスキップ");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dry-run は getUpdates を呼ばない", async () => {
    const fetchMock = createFetchMock(okUpdatesResponse([]));
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, false, Math.floor(Date.now() / 1000));

    expect(result.skipped).toBe(false);
    expect(result.notes).toContain("dry-run: getUpdates をスキップ");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("更新なしの場合は actions=0 を返す", async () => {
    const fetchMock = createFetchMock(okUpdatesResponse([]));
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getUpdates 失敗時は warn ログのみでクラッシュしない", async () => {
    const warnings = installWarningLogger();
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new Error("network error");
    });
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(0);
    expect(result.notes).toContain("getUpdates 失敗");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toContain("getUpdates");
  });

  it("offset カーソルが state に永続化される（冪等。contract §42.1）", async () => {
    const task = createUserDecisionTask();
    const now = Math.floor(Date.now() / 1000);
    const { nonce } = registerApproveNonce(task, now * 1000);

    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 42,
          callbackQueryId: "cq-1",
          chatId: Number(TEST_CHAT_ID),
          data: `approve:${task.id}:${nonce}`,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    await stage.tick(harness.deps, true, now);

    const state = readTelegramInState(harness.deps.env);
    expect(state.updateOffset).toBe(43); // max update_id + 1
  });

  // ========== §42.1 chat_id allowlist ==========

  it("許可されていない chat_id の callback_query は拒否 + 監査イベント記録（contract §42.1）", async () => {
    const task = createUserDecisionTask();
    const now = Math.floor(Date.now() / 1000);
    const { nonce } = registerApproveNonce(task, now * 1000);
    const warnings = installWarningLogger();

    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 1,
          callbackQueryId: "cq-bad",
          chatId: 666, // 不正な chat_id
          data: `approve:${task.id}:${nonce}`,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(warnings.some((w) => w.msg.includes("許可されていない chat"))).toBe(true);
    // 監査イベントが記録されている
    const events = harness.store.listEvents(task.id, "telegram_rejected");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
    expect(payload.reason).toBe("unauthorized-chat");
    // タスク状態は変わっていない
    expect(harness.store.getTask(task.id)?.status).toBe("blocked");
  });

  it("許可されていない chat_id のメッセージも無視する", async () => {
    const task = createUserDecisionTask();
    const warnings = installWarningLogger();
    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildMessageUpdate({
          updateId: 1,
          chatId: 666,
          text: "hello",
          replyToText: `id: ${task.id}`,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(warnings.some((w) => w.msg.includes("許可されていない chat"))).toBe(true);
    const events = harness.store.listEvents(task.id, "telegram_rejected");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
    expect(payload.reason).toBe("unauthorized-chat");
    expect(payload.updateType).toBe("message");
  });

  // ========== §42.2 approve（user-decision → done） ==========

  it("有効な nonce で user-decision タスクを approve → done に遷移する（contract §42.2）", async () => {
    const task = createUserDecisionTask();
    const now = Math.floor(Date.now() / 1000);
    const { nonce } = registerApproveNonce(task, now * 1000);

    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 10,
          callbackQueryId: "cq-approve",
          chatId: Number(TEST_CHAT_ID),
          data: `approve:${task.id}:${nonce}`,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    // タスクが done に遷移している
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("done");
    // telegram_approve イベントが記録されている
    const events = harness.store.listEvents(task.id, "telegram_approve");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
    expect(payload.kind).toBe("user-decision");
    expect(payload.source).toBe("telegram");
    // answerCallbackQuery と sendMessage が呼ばれている
    expect(fetchMock).toHaveBeenCalledTimes(3); // getUpdates + answerCbQ + sendMessage
  });

  it("同一 nonce の2回目の approve は拒否される（1回限り。contract §42.2）", async () => {
    const task = createUserDecisionTask();
    const now = Math.floor(Date.now() / 1000);
    const { nonce } = registerApproveNonce(task, now * 1000);

    const updates = [
      buildCallbackUpdate({
        updateId: 10,
        callbackQueryId: "cq-1",
        chatId: Number(TEST_CHAT_ID),
        data: `approve:${task.id}:${nonce}`,
      }),
    ];

    // 1回目: 成功
    const fetchMock1 = createFetchMock(okUpdatesResponse(updates));
    const stage1 = createTelegramInStage({ fetch: fetchMock1 as TelegramFetch });
    await stage1.tick(harness.deps, true, now);
    expect(harness.store.getTask(task.id)?.status).toBe("done");

    // 2回目: 同じ nonce で再試行（state は1回目で消費済み）
    const fetchMock2 = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 20,
          callbackQueryId: "cq-2",
          chatId: Number(TEST_CHAT_ID),
          data: `approve:${task.id}:${nonce}`,
        }),
      ]),
    );
    const stage2 = createTelegramInStage({ fetch: fetchMock2 as TelegramFetch });
    const result2 = await stage2.tick(harness.deps, true, now);

    expect(result2.actions).toBe(1);
    expect(result2.notes?.some((n) => n.includes("nonce 無効"))).toBe(true);
  });

  it("期限切れ nonce は拒否される（24h 期限。contract §42.2）", async () => {
    const task = createUserDecisionTask();
    const now = Math.floor(Date.now() / 1000);
    // 25時間前に作成された nonce
    const expiredCreatedAt = now * 1000 - NONCE_EXPIRY_MS - 3600 * 1000;
    const state = readTelegramInState(harness.deps.env);
    const snapshot = computeStateHash(harness.store, task, "user-decision");
    const nonce = registerNonce(state, {
      action: "approve",
      taskId: task.id,
      kind: "user-decision",
      stateHash: snapshot.stateHash,
      taskUpdatedAt: snapshot.taskUpdatedAt,
      mutationEventId: snapshot.mutationEventId,
      proposalEventId: snapshot.proposalEventId,
      createdAt: expiredCreatedAt,
    });
    writeTelegramInState(harness.deps.env, state);

    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 10,
          callbackQueryId: "cq-expired",
          chatId: Number(TEST_CHAT_ID),
          data: `approve:${task.id}:${nonce}`,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("blocked"); // 変わっていない
    const events = harness.store.listEvents(task.id, "telegram_rejected");
    expect(events).toHaveLength(1);
  });

  it("状態が変わったタスクの approve は「適用不能」で拒否される（状態再検証。contract §42.2）", async () => {
    const task = createUserDecisionTask();
    const now = Math.floor(Date.now() / 1000);
    const { nonce } = registerApproveNonce(task, now * 1000);

    // タスクの状態を変更（block_reason を更新 → stateHash が変わる）
    harness.store.updateBlockReason(task.id, "user-decision: 別の理由に変更", "tester", "human");

    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 10,
          callbackQueryId: "cq-stale",
          chatId: Number(TEST_CHAT_ID),
          data: `approve:${task.id}:${nonce}`,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("blocked"); // 遷移していない
    expect(result.notes?.some((n) => n.includes("approve 拒否"))).toBe(true);
    const events = harness.store.listEvents(task.id, "telegram_rejected");
    expect(events).toHaveLength(1);
  });

  it("同じ blocked 表示に戻ったタスクでも古い approve は拒否される", async () => {
    const task = createUserDecisionTask("user-decision: 同じ理由");
    const now = Math.floor(Date.now() / 1000);
    const { nonce } = registerApproveNonce(task, now * 1000);

    harness.store.transition({ taskId: task.id, to: "ready", actor: "tester" });
    harness.store.block(task.id, "user-decision: 同じ理由", "tester", "human");

    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 10,
          callbackQueryId: "cq-same-look-stale",
          chatId: Number(TEST_CHAT_ID),
          data: `approve:${task.id}:${nonce}`,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("blocked");
    expect(result.notes?.some((n) => n.includes("approve 拒否"))).toBe(true);
    const events = harness.store.listEvents(task.id, "telegram_rejected");
    expect(events).toHaveLength(1);
  });

  it("既に done になったタスクの approve は「適用不能」を返す", async () => {
    const task = createUserDecisionTask();
    const now = Math.floor(Date.now() / 1000);
    const { nonce } = registerApproveNonce(task, now * 1000);

    // タスクを先に done に遷移させる
    harness.store.transition({ taskId: task.id, to: "done", actor: "tester" });

    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 10,
          callbackQueryId: "cq-already-done",
          chatId: Number(TEST_CHAT_ID),
          data: `approve:${task.id}:${nonce}`,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(result.notes?.some((n) => n.includes("approve 拒否"))).toBe(true);
  });

  it("存在しないタスクの approve は「適用不能」を返す", async () => {
    const now = Math.floor(Date.now() / 1000);
    const state = readTelegramInState(harness.deps.env);
    const nonce = registerNonce(state, {
      action: "approve",
      taskId: "t_nonexistent0000000",
      kind: "user-decision",
      stateHash: "fakehash",
      taskUpdatedAt: 0,
      mutationEventId: 0,
      proposalEventId: null,
      createdAt: now * 1000,
    });
    writeTelegramInState(harness.deps.env, state);

    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 10,
          callbackQueryId: "cq-noexist",
          chatId: Number(TEST_CHAT_ID),
          data: `approve:t_nonexistent0000000:${nonce}`,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(result.notes?.some((n) => n.includes("approve 拒否"))).toBe(true);
  });

  it("nonce の taskId と callback_data の taskId が不一致の場合は拒否する", async () => {
    const task = createUserDecisionTask();
    const now = Math.floor(Date.now() / 1000);
    const { nonce } = registerApproveNonce(task, now * 1000);

    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 10,
          callbackQueryId: "cq-mismatch",
          chatId: Number(TEST_CHAT_ID),
          data: `approve:t_different0000000:${nonce}`, // 異なる taskId
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(result.notes?.some((n) => n.includes("taskId 不一致"))).toBe(true);
  });

  // ========== §42.2 approve（steward-promote → ready） ==========

  it("steward-promote nonce で blocked → ready に遷移する（contract §40.4/§42.2）", async () => {
    // steward promote シナリオ: blocked タスクを ready に昇格する
    const task = harness.store.createTask(taskInput({ status: "ready", title: "promote候補" }), "tester");
    const blocked = harness.store.block(task.id, "user-decision: promote 提案あり", "tester", "human");
    harness.store.addEvent(task.id, "steward_proposal", "steward", { kind: "promote", reason: "ready 化候補" });

    const now = Math.floor(Date.now() / 1000);
    const { nonce } = registerApproveNonce(blocked, now * 1000, "steward-promote");

    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 10,
          callbackQueryId: "cq-promote",
          chatId: Number(TEST_CHAT_ID),
          data: `approve:${task.id}:${nonce}`,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("ready");
    const events = harness.store.listEvents(task.id, "telegram_approve");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
    expect(payload.kind).toBe("steward-promote");
  });

  it("steward-promote の reject は ready 化せず telegram_rejected を記録する", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "promote却下候補" }), "tester");
    const blocked = harness.store.block(task.id, "user-decision: promote 提案あり", "tester", "human");
    harness.store.addEvent(task.id, "steward_proposal", "steward", { kind: "promote", reason: "ready 化候補" });

    const now = Math.floor(Date.now() / 1000);
    const { nonce } = registerApproveNonce(blocked, now * 1000, "steward-promote");

    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 10,
          callbackQueryId: "cq-promote-reject",
          chatId: Number(TEST_CHAT_ID),
          data: `reject:${task.id}:${nonce}`,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("blocked");
    const events = harness.store.listEvents(task.id, "telegram_rejected");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
    expect(payload.reason).toBe("declined");
    expect(payload.kind).toBe("steward-promote");
  });

  it("steward-promote nonce でも提案時点から状態が変わった場合は拒否する", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "promote stale候補" }), "tester");
    const blocked = harness.store.block(task.id, "user-decision: promote 提案あり", "tester", "human");
    harness.store.addEvent(task.id, "steward_proposal", "steward", { kind: "promote", reason: "ready 化候補" });

    const now = Math.floor(Date.now() / 1000);
    const { nonce } = registerApproveNonce(blocked, now * 1000, "steward-promote");

    harness.store.updateBlockReason(task.id, "user-decision: promote 提案の前提が変化", "tester", "human");

    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 10,
          callbackQueryId: "cq-promote-stale",
          chatId: Number(TEST_CHAT_ID),
          data: `approve:${task.id}:${nonce}`,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("blocked");
    expect(result.notes?.some((n) => n.includes("approve 拒否"))).toBe(true);
    const events = harness.store.listEvents(task.id, "telegram_rejected");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
    expect(payload.kind).toBe("steward-promote");
  });

  // ========== §42.2 answer ==========

  it("返信メッセージのテキストを agent.message.v1 answer として記録する（contract §42.2 answer）", async () => {
    const task = createUserDecisionTask();
    const originalNotifyText = [
      `📋 要判断 — 人間確認要`,
      `id: ${task.id}`,
      `block_reason: user-decision: モデル解決に失敗`,
      `url: http://127.0.0.1:9131/task/${task.id}`,
    ].join("\n");

    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildMessageUpdate({
          updateId: 20,
          chatId: Number(TEST_CHAT_ID),
          text: "承認します。問題ありません。",
          replyToText: originalNotifyText,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(result.notes?.some((n) => n.includes("answer 記録"))).toBe(true);
    // Telegram 入力は agent.message.v1 として記録され、次の messages ステージで既存経路処理される。
    const comments = harness.store.listComments(task.id);
    expect(comments.some((c) => c.body.includes("agent.message.v1") && c.body.includes("承認します"))).toBe(true);
    const messagesResult = await messagesStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(messagesResult.actions).toBe(1);
    expect(harness.store.listComments(task.id).some((c) => !c.body.includes("agent-message-v1") && c.body.includes("承認します"))).toBe(true);
    // telegram_answer イベントが記録されている
    const events = harness.store.listEvents(task.id, "telegram_answer");
    expect(events).toHaveLength(1);
  });

  it("user-questionへのTelegram回答はworkerへ直送せずorchestrator requestへ戻す", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "人間判断待ち" }), "tester");
    harness.store.block(task.id, "worker-question: リリース方針を確認してください", "supervisor");
    const orchestrator = harness.store.registerOrchestrator({ label: "telegram-owner", project: "dev", repoCommonDir: "" });
    const session = harness.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    harness.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    const request = harness.store.createOrGetOrchestratorRequest({
      taskId: task.id,
      questionId: "q_telegram_escalation",
      question: "リリース方針を確認してください",
    });
    harness.store.claimOrchestratorRequest({
      requestId: request.id,
      sessionId: session.id,
      generation: session.generation,
      claimToken: "claim-telegram",
      leaseUntil: Math.floor(Date.now() / 1000) + 600,
    });
    harness.store.escalateOrchestratorRequest({
      requestId: request.id,
      sessionId: session.id,
      generation: session.generation,
      claimToken: "claim-telegram",
      question: "A案でよいですか",
    });
    const originalNotifyText = [
      "📋 人間への質問 — 人間判断待ち",
      `id: ${task.id}`,
      "block_reason: user-question: A案でよいですか",
      `url: http://127.0.0.1:9131/task/${task.id}`,
    ].join("\n");
    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildMessageUpdate({
          updateId: 21,
          chatId: Number(TEST_CHAT_ID),
          text: "A案で進めてください",
          replyToText: originalNotifyText,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.getOrchestratorRequest(request.id)).toMatchObject({
      status: "queued",
      humanAnswer: "A案で進めてください",
    });
    expect(harness.store.getTask(task.id)?.blockReason).toContain("worker-question:");
    expect(harness.store.listMessageFenceComments(0)).toHaveLength(0);
    const event = harness.store.listEvents(task.id, "telegram_answer")[0];
    expect(JSON.parse(event!.payload)).toMatchObject({ requestId: request.id, routedTo: "orchestrator" });
  });

  it("reply_to_message が無いメッセージは無視する（fail-closed）", async () => {
    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildMessageUpdate({
          updateId: 20,
          chatId: Number(TEST_CHAT_ID),
          text: "ただのメッセージ",
          // replyToText なし
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    // reply_to_message なしのメッセージは無視（actions にカウントされない）
    expect(result.actions).toBe(0);
  });

  it("元メッセージから taskId を抽出できない場合は無視する", async () => {
    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildMessageUpdate({
          updateId: 20,
          chatId: Number(TEST_CHAT_ID),
          text: "返信テキスト",
          replyToText: "taskId のない別のメッセージ",
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(0);
  });

  // ========== §42 fail-closed ==========

  it("未知のアクションは拒否される（fail-closed。contract §42）", async () => {
    const task = createUserDecisionTask();
    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 10,
          callbackQueryId: "cq-unknown",
          chatId: Number(TEST_CHAT_ID),
          data: `restart:${task.id}:nonce123`,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(result.notes?.some((n) => n.includes("未知のアクション"))).toBe(true);
    const events = harness.store.listEvents(task.id, "telegram_rejected");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
    expect(payload.reason).toBe("unknown-action");
    expect(payload.action).toBe("restart");
  });

  it("不正な callback_data 形式は拒否される", async () => {
    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 10,
          callbackQueryId: "cq-invalid",
          chatId: Number(TEST_CHAT_ID),
          data: "invalid-format",
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
  });

  // ========== §42.3 応答のセキュリティ ==========

  it("返信メッセージに token を含めない（contract §42.3）", async () => {
    const task = createUserDecisionTask();
    const now = Math.floor(Date.now() / 1000);
    const { nonce } = registerApproveNonce(task, now * 1000);

    const sentBodies: string[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
      if (url.includes("/getUpdates")) {
        return okUpdatesResponse([
          buildCallbackUpdate({
            updateId: 10,
            callbackQueryId: "cq-sec",
            chatId: Number(TEST_CHAT_ID),
            data: `approve:${task.id}:${nonce}`,
          }),
        ]);
      }
      if (init.body !== undefined) {
        sentBodies.push(String(init.body));
      }
      return okEmptyResponse();
    });
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    await stage.tick(harness.deps, true, now);

    // すべての送信 body に token が含まれていないことを確認
    for (const body of sentBodies) {
      expect(body).not.toContain(TEST_TOKEN);
    }
  });

  // ========== nonce 掃除 ==========

  it("期限切れ nonce が自動的に削除される", async () => {
    const now = Math.floor(Date.now() / 1000);
    const state: TelegramInState = { updateOffset: 0, nonces: {} };
    // 期限切れの nonce を3件追加
    for (let i = 0; i < 3; i++) {
      registerNonce(state, {
        action: "approve",
        taskId: `t_expired00000000${i}`,
        kind: "user-decision",
        stateHash: "hash",
        taskUpdatedAt: 0,
        mutationEventId: 0,
        proposalEventId: null,
        createdAt: now * 1000 - NONCE_EXPIRY_MS - 1000,
      });
    }
    // 有効な nonce を1件追加
    registerNonce(state, {
      action: "approve",
      taskId: "t_valid000000000000",
      kind: "user-decision",
      stateHash: "hash",
      taskUpdatedAt: 0,
      mutationEventId: 0,
      proposalEventId: null,
      createdAt: now * 1000,
    });
    writeTelegramInState(harness.deps.env, state);

    const fetchMock = createFetchMock(okUpdatesResponse([]));
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, now);

    expect(result.notes?.some((n) => n.includes("期限切れ nonce 3 件を削除"))).toBe(true);
    // 有効な nonce は残っている（state が永続化されないケース - 更新なしなら pruned > 0 の場合書かれない...
    // 実装を確認: pruned > 0 で updates.length === 0 の場合 writeTelegramInState が呼ばれる
  });

  // ========== 複数更新の一括処理 ==========

  it("1 tick で複数の update を処理する", async () => {
    const task1 = createUserDecisionTask("user-decision: タスク1");
    const task2 = createUserDecisionTask("user-decision: タスク2");
    const now = Math.floor(Date.now() / 1000);
    const { nonce: nonce1 } = registerApproveNonce(task1, now * 1000);
    // task2 用の nonce も登録
    const state2 = readTelegramInState(harness.deps.env);
    const snapshot2 = computeStateHash(harness.store, task2, "user-decision");
    const nonce2 = registerNonce(state2, {
      action: "approve",
      taskId: task2.id,
      kind: "user-decision",
      stateHash: snapshot2.stateHash,
      taskUpdatedAt: snapshot2.taskUpdatedAt,
      mutationEventId: snapshot2.mutationEventId,
      proposalEventId: snapshot2.proposalEventId,
      createdAt: now * 1000,
    });
    writeTelegramInState(harness.deps.env, state2);

    const fetchMock = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 10,
          callbackQueryId: "cq-1",
          chatId: Number(TEST_CHAT_ID),
          data: `approve:${task1.id}:${nonce1}`,
        }),
        buildCallbackUpdate({
          updateId: 11,
          callbackQueryId: "cq-2",
          chatId: Number(TEST_CHAT_ID),
          data: `approve:${task2.id}:${nonce2}`,
        }),
      ]),
    );
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, now);

    expect(result.actions).toBe(2);
    expect(harness.store.getTask(task1.id)?.status).toBe("done");
    expect(harness.store.getTask(task2.id)?.status).toBe("done");
    // offset は最後の update_id + 1
    const state = readTelegramInState(harness.deps.env);
    expect(state.updateOffset).toBe(12);
  });

  // ========== kill-switch ==========

  it("telegram-in.disabled ファイルが存在する場合は skipped を返す", async () => {
    const disabledPath = join(harness.deps.env.home, "telegram-in.disabled");
    writeFileSync(disabledPath, "", "utf8");

    const fetchMock = createFetchMock(okUpdatesResponse([]));
    const stage = createTelegramInStage({ fetch: fetchMock as TelegramFetch });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.skipped).toBe(true);
    expect(result.actions).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ========== notify stage の inline keyboard 統合テスト ==========

describe("notify + telegram-in 統合", () => {
  let harness: TestHarness;
  const TEST_CHAT_ID = "999";
  const TEST_TOKEN = "123456:testBotToken";

  beforeEach(async () => {
    harness = await setupHarness();
    (harness.deps.config as NotifyConfigExt).notify = {
      transports: ["telegram"],
      telegram: { chatId: TEST_CHAT_ID },
    };
    // token ファイルを作成
    const tokenPath = join(harness.deps.env.home, "telegram-token");
    writeFileSync(tokenPath, TEST_TOKEN, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
  });

  afterEach(async () => {
    await harness.cleanup();
    vi.restoreAllMocks();
  });

  it("user-decision 通知に inline keyboard が付与され、対応する nonce が state に保存される", async () => {
    // user-decision タスクを作成
    const task = harness.store.createTask(taskInput({ status: "ready", title: "承認待ち" }), "tester");
    harness.store.block(task.id, "user-decision: レビュー結果の確認が必要", "tester", "human");

    // notify ステージの fetch モック: sendMessage のリクエストボディをキャプチャ
    let capturedBody: Record<string, unknown> | null = null;
    const notifyFetch = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body.reply_markup !== undefined) {
        capturedBody = body;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const notifyStage = createNotifyStage({
      transports: [createTelegramTransport()],
      fetch: notifyFetch as NotifyFetch,
    });
    const now = Math.floor(Date.now() / 1000);

    await notifyStage.tick(harness.deps, true, now);

    // inline keyboard が sendMessage に含まれている
    expect(capturedBody).not.toBeNull();
    const replyMarkup = capturedBody!.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
    };
    expect(replyMarkup.inline_keyboard).toHaveLength(2);
    expect(replyMarkup.inline_keyboard[0]![0]!.text).toBe("✓ 承認して done");
    expect(replyMarkup.inline_keyboard[0]![0]!.callback_data).toMatch(/^approve:/);
    expect(replyMarkup.inline_keyboard[1]![0]!.text).toBe("詳細");
    expect(replyMarkup.inline_keyboard[1]![0]!.url).toContain(task.id);

    // nonce が state ファイルに保存されている
    const state = readTelegramInState(harness.deps.env);
    const nonceEntries = Object.values(state.nonces);
    expect(nonceEntries).toHaveLength(1);
    expect(nonceEntries[0]!.taskId).toBe(task.id);
    expect(nonceEntries[0]!.kind).toBe("user-decision");
    expect(nonceEntries[0]!.action).toBe("approve");
  });

  it("steward promote 提案通知に ready 承認/却下 keyboard が付与され、提案 event に紐付く nonce が保存される", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "promote通知" }), "tester");
    harness.store.block(task.id, "user-decision: steward promote 提案あり", "tester", "human");
    const proposal = harness.store.addEvent(task.id, "steward_proposal", "steward", {
      kind: "promote",
      reason: "ready 化候補",
    });

    let capturedBody: Record<string, unknown> | null = null;
    const notifyFetch = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body.reply_markup !== undefined) {
        capturedBody = body;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const notifyStage = createNotifyStage({
      transports: [createTelegramTransport()],
      fetch: notifyFetch as NotifyFetch,
    });

    await notifyStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(capturedBody).not.toBeNull();
    const replyMarkup = capturedBody!.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data?: string }>>;
    };
    expect(replyMarkup.inline_keyboard).toHaveLength(2);
    expect(replyMarkup.inline_keyboard[0]![0]!.text).toBe("✓ ready 化を承認");
    expect(replyMarkup.inline_keyboard[0]![0]!.callback_data).toMatch(/^approve:/);
    expect(replyMarkup.inline_keyboard[1]![0]!.text).toBe("✕ 却下");
    expect(replyMarkup.inline_keyboard[1]![0]!.callback_data).toMatch(/^reject:/);

    const state = readTelegramInState(harness.deps.env);
    const nonceEntries = Object.values(state.nonces);
    expect(nonceEntries).toHaveLength(1);
    expect(nonceEntries[0]!.taskId).toBe(task.id);
    expect(nonceEntries[0]!.kind).toBe("steward-promote");
    expect(nonceEntries[0]!.proposalEventId).toBe(proposal.id);
  });

  it("user-decision 以外の human_queue 通知には inline keyboard が付かない", async () => {
    // needs-manual タスクを作成
    const task = harness.store.createTask(taskInput({ status: "ready", title: "手動対応" }), "tester");
    harness.store.block(task.id, "needs-manual: cwd が見つかりません", "tester", "human");

    let hasReplyMarkup = false;
    const notifyFetch = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body.reply_markup !== undefined) {
        hasReplyMarkup = true;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const notifyStage = createNotifyStage({
      transports: [createTelegramTransport()],
      fetch: notifyFetch as NotifyFetch,
    });

    await notifyStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(notifyFetch).toHaveBeenCalled();
    expect(hasReplyMarkup).toBe(false);
    // nonce state は空のまま
    const state = readTelegramInState(harness.deps.env);
    expect(Object.keys(state.nonces)).toHaveLength(0);
  });

  it("notify→telegram-in の E2E フロー: 通知→nonce生成→approve→done", async () => {
    // 1. user-decision タスク作成
    const task = harness.store.createTask(taskInput({ status: "ready", title: "E2E承認" }), "tester");
    harness.store.block(task.id, "user-decision: E2Eテスト用", "tester", "human");

    // 2. notify ステージで通知 + nonce 生成
    let capturedCallbackData = "";
    const notifyFetch = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const replyMarkup = body.reply_markup as {
        inline_keyboard?: Array<Array<{ callback_data?: string }>>;
      } | undefined;
      const cbData = replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data;
      if (cbData !== undefined) {
        capturedCallbackData = cbData;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const notifyStage = createNotifyStage({
      transports: [createTelegramTransport()],
      fetch: notifyFetch as NotifyFetch,
    });
    const now = Math.floor(Date.now() / 1000);
    await notifyStage.tick(harness.deps, true, now);
    expect(capturedCallbackData).not.toBe("");

    // 3. telegram-in ステージで approve
    const telegramInFetch = createFetchMock(
      okUpdatesResponse([
        buildCallbackUpdate({
          updateId: 100,
          callbackQueryId: "cq-e2e",
          chatId: Number(TEST_CHAT_ID),
          data: capturedCallbackData,
        }),
      ]),
    );
    const telegramInStage = createTelegramInStage({ fetch: telegramInFetch as TelegramFetch });
    const result = await telegramInStage.tick(harness.deps, true, now);

    // 4. 検証: タスクが done に遷移
    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("done");
    const events = harness.store.listEvents(task.id, "telegram_approve");
    expect(events).toHaveLength(1);
  });

  /** getUpdates 成功レスポンス用ヘルパー */
  function createFetchMock(
    getUpdatesResponse: Response,
  ): ReturnType<typeof vi.fn<TelegramFetch>> {
    return vi.fn<TelegramFetch>(async (url: string, init: RequestInit): Promise<Response> => {
      void init;
      if (url.includes("/getUpdates")) {
        return getUpdatesResponse;
      }
      return okEmptyResponse();
    });
  }
});
