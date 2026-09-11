import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskInput } from "@hachi/testing";
import { sha256Hex } from "@hachi/core";
import type { HachiConfig, Logger, TaskRow } from "@hachi/core";
import { setupHarness, type TestHarness } from "../test-support.js";
import {
  buildAdHocNotifyMessage,
  buildTelegramText,
  createMacosTransport,
  createNotifyStage,
  createTelegramTransport,
  deriveHumanQueueLabel,
  deriveOperationalLabel,
  deriveStewardLabel,
  deriveWatchedLabel,
  readWatchNotifyState,
  sendOperationalNotification,
  type NotifyConfig,
  type NotifyFetch,
  type NotifyMessage,
  type NotifyTransport,
  type NotifyTransportContext,
  type Notifier,
  type ResolvedNotifyConfig,
  type TelegramTransportClock,
} from "./notify.js";

interface ConfigWithNotify extends HachiConfig {
  notify?: NotifyConfig;
}

interface WarningRecord {
  msg: string;
  fields?: Record<string, unknown>;
}

describe("notifyStage", () => {
  let harness: TestHarness;
  let notifyCalls: Array<{ taskId: string; message: string; title: string }>;
  let notifierResult: boolean;
  let notifier: Notifier;

  beforeEach(async () => {
    harness = await setupHarness();
    notifyCalls = [];
    notifierResult = true;
    // 実通知（osascript）を発火させない fake notifier（契約 §18 実装ノート: notifier DI）
    notifier = (taskId: string, message: string, title: string): boolean => {
      notifyCalls.push({ taskId, message, title });
      return notifierResult;
    };
  });

  afterEach(async () => {
    await harness.cleanup();
    vi.restoreAllMocks();
  });

  /** human_queue 系 prefix で blocked なタスクを構築する */
  function createHumanQueueTask(reason: string): TaskRow {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "人間確認要" }), "tester");
    return harness.store.block(task.id, reason, "tester", "human");
  }

  function createMacosOnlyStage(): ReturnType<typeof createNotifyStage> {
    return createNotifyStage({ transports: [createMacosTransport(notifier)] });
  }

  function createWatchedReadyTask(title = "ウォッチ対象"): TaskRow {
    const task = harness.store.createTask(taskInput({ status: "ready", title }), "tester");
    return harness.store.setWatched(task.id, true, "tester");
  }

  function setNotifyConfig(notify: NotifyConfig): void {
    (harness.deps.config as ConfigWithNotify).notify = notify;
  }

  function writeTelegramToken(token: string, mode = 0o600): string {
    const tokenPath = join(harness.deps.env.home, "telegram-token");
    writeFileSync(tokenPath, token, { mode });
    chmodSync(tokenPath, mode);
    return tokenPath;
  }

  function installWarningLogger(): WarningRecord[] {
    const warnings: WarningRecord[] = [];
    const logger: Logger = {
      info(): void {
        // テストでは不要
      },
      warn(msg: string, fields?: Record<string, unknown>): void {
        if (fields === undefined) {
          warnings.push({ msg });
          return;
        }
        warnings.push({ msg, fields });
      },
      error(): void {
        // テストでは不要
      },
      child(): Logger {
        return logger;
      },
    };
    harness.deps.logger = logger;
    return warnings;
  }

  function createTelegramTransportContext(fetchMock: NotifyFetch): NotifyTransportContext {
    return {
      env: harness.deps.env,
      config: {
        transports: ["telegram"],
        telegram: { chatId: "chat-secret" },
      },
      fetch: fetchMock,
      warnOnce(): void {
        // credential は各テストで設定済み
      },
    };
  }

  function createTelegramMessage(): NotifyMessage {
    return {
      taskId: "t_notify_retry",
      actionLabel: "⚠️ 要対応",
      title: "Telegram retry",
      priority: 0,
      reasonHash: "reason-hash",
      redactedReason: "needs-manual: retry",
      macosTitle: "要対応",
      macosMessage: "retry",
      detailUrl: "https://kanban.example/task/t_notify_retry",
    };
  }

  function createTelegramClock(now = 1_000): {
    clock: TelegramTransportClock;
    sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
  } {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async (): Promise<void> => undefined);
    return {
      clock: { now: (): number => now, sleep },
      sleep,
    };
  }

  it("worker-question通知はoutboxから一度だけ送り、human queue経路とは重複しない", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "routing通知", body: "cwd: /tmp" }),
      "tester",
    );
    harness.store.block(task.id, "worker-question: 方針を確認してください", "supervisor");
    const orchestrator = harness.store.registerOrchestrator({
      label: "notify-owner",
      project: "dev",
      repoCommonDir: "",
    });
    harness.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    harness.store.createOrGetOrchestratorRequest({
      taskId: task.id,
      questionId: "q_notify_outbox",
      question: "方針を確認してください",
    });
    setNotifyConfig({ transports: ["macos"] });
    const stage = createMacosOnlyStage();

    const first = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    const second = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(first.actions).toBe(1);
    expect(second.actions).toBe(0);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.title).toBe("🤖 オーケストレーターへ質問");
    expect(notifyCalls[0]?.message).toContain("返信は不要です");
    expect(harness.store.listPendingNotificationOutbox()).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "human_notified")).toHaveLength(0);
  });

  it("outbox再試行は成功済みtransportを二重送信せず失敗transportだけを再送する", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "部分失敗", body: "cwd: /tmp" }), "tester");
    harness.store.block(task.id, "worker-question: 再送を確認", "supervisor");
    const orchestrator = harness.store.registerOrchestrator({ label: "retry-owner", project: "dev", repoCommonDir: "" });
    harness.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    harness.store.createOrGetOrchestratorRequest({
      taskId: task.id,
      questionId: "q_notify_retry",
      question: "再送を確認",
    });
    setNotifyConfig({ transports: ["macos", "telegram"] });
    let telegramCalls = 0;
    const telegram: NotifyTransport = {
      name: "telegram",
      send(): Promise<{ status: "sent" | "failed" }> {
        telegramCalls += 1;
        return Promise.resolve({ status: telegramCalls === 1 ? "failed" : "sent" });
      },
    };
    const stage = createNotifyStage({ transports: [createMacosTransport(notifier), telegram] });
    const now = Math.floor(Date.now() / 1000);

    await stage.tick(harness.deps, true, now);
    await stage.tick(harness.deps, true, now + 61);

    expect(notifyCalls).toHaveLength(1);
    expect(telegramCalls).toBe(2);
    expect(harness.store.listPendingNotificationOutbox(100, now + 61)).toHaveLength(0);
  });

  describe("actionLabel 導出（契約 §38.5）", () => {
    it.each([
      ["review-required: 指摘あり", "🔍 要レビュー確認"],
      ["user-decision: 判断待ち", "📋 要判断"],
      ["user-feedback: 返信待ち", "💬 要フィードバック"],
      ["needs-manual: 手動対応", "⚠️ 要対応"],
      ["auto-launch-failed: 起動失敗", "🔁 起動失敗"],
      ["worker-question: 質問", "❓ ワーカー質問"],
      ["user-question: 判断待ち", "📋 人間への質問"],
      ["unknown-prefix: 不明", "🔔 通知"],
    ])("human_queue reason %s → %s", (reason, expected) => {
      expect(deriveHumanQueueLabel(reason)).toBe(expected);
    });

    it.each([
      ["done", "", "✅ 完了"],
      ["review", "", "🔍 レビュー入り"],
      ["ready", "", "🆕 起票/着手可"],
      ["blocked", "codex-in-progress: 実行中", "▶️ 進行中"],
      ["blocked", "claude-in-progress: 実行中", "▶️ 進行中"],
      ["blocked", "needs-manual: 確認", "🔄 状態変化"],
      ["archived", "", "🗄 アーカイブ"],
      ["needs-integration", "", "🔄 状態変化"],
    ] as const)("watched to=%s reason=%s → %s", (toStatus, reason, expected) => {
      expect(deriveWatchedLabel(toStatus, reason)).toBe(expected);
    });

    it.each([
      ["brief", "🗓 ブリーフ"],
      ["bridgewatch:codex", "🚨 bridge警告"],
      ["worker-process-hygiene", "🧹 資源警告"],
      ["bridge-orphan-reap:123", "🧹 資源警告"],
      ["run-stalled:sess-1", "⏳ 停滞警告"],
      ["question_asked:t_123:sess", "🔔 通知"],
      ["question_asked:t_123:q_abcd1234", "🔔 通知"],
      ["orchestrator-heartbeat-stale:os_123:57", "🚨 heartbeat警告"],
    ])("operational id %s → %s", (id, expected) => {
      expect(deriveOperationalLabel(id)).toBe(expected);
    });

    it.each([
      ["escalate", "📣 要方針判断"],
      ["promote", "⬆️ 昇格提案"],
      ["archive", "🗄 アーカイブ提案"],
      ["spec-lint", "📝 仕様指摘"],
      ["archive-vetoed", "🚫 アーカイブ見送り"],
      [undefined, "🏛 steward"],
    ] as const)("steward kind %s → %s", (kind, expected) => {
      expect(deriveStewardLabel(kind)).toBe(expected);
    });
  });

  it("buildTelegramText は先頭行を actionLabel と title にする（契約 §38.5）", () => {
    const message: NotifyMessage = {
      taskId: "t_1234567890abcdef",
      actionLabel: "⚠️ 要対応",
      title: "人間確認要",
      priority: 0,
      reasonHash: "12345678",
      redactedReason: "needs-manual: 確認",
      macosTitle: "⚠️ 要対応",
      macosMessage: "人間確認要\nneeds-manual: 確認",
      detailUrl: "http://127.0.0.1:9131/task/t_1234567890abcdef",
    };

    expect(buildTelegramText(message).split("\n")[0]).toBe("⚠️ 要対応 — 人間確認要");
  });

  it("buildAdHocNotifyMessage は steward kind 指定時に専用 actionLabel を先頭行へ出す", () => {
    const task = harness.store.createTask(taskInput({ title: "steward 対象", priority: 1 }), "tester");
    const config: ResolvedNotifyConfig = {
      transports: ["telegram"],
      telegram: { baseUrl: "https://kanban.example" },
    };

    const message = buildAdHocNotifyMessage(
      task,
      "steward promote 提案: steward 対象 — 仕様十分",
      config,
      "promote",
    );

    expect(message.actionLabel).toBe("⬆️ 昇格提案");
    expect(message.macosTitle).toBe("⬆️ 昇格提案");
    expect(buildTelegramText(message).split("\n")[0]).toBe("⬆️ 昇格提案 — steward 対象");
  });

  it("新規 human_queue タスクを通知1回 + human_notified イベント記録する（契約 §18）", async () => {
    const task = createHumanQueueTask("needs-manual: レビュー起動不能 (cwd 無し)");
    const stage = createMacosOnlyStage();

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.taskId).toBe(task.id);
    expect(notifyCalls[0]?.message).toBe("人間確認要\nneeds-manual: レビュー起動不能 (cwd 無し)");
    expect(notifyCalls[0]?.title).toBe("⚠️ 要対応");

    const events = harness.store.listEvents(task.id, "human_notified");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as { reasonHash: string };
    expect(payload.reasonHash).toBe(sha256Hex("needs-manual: レビュー起動不能 (cwd 無し)").slice(0, 8));
  });

  it("2回目 tick では同一 reason での再通知をしない（冪等）", async () => {
    const task = createHumanQueueTask("user-decision: モデル解決に失敗");
    const stage = createMacosOnlyStage();

    await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.title).toBe("📋 要判断");

    const second = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(second.actions).toBe(0);
    expect(notifyCalls).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "human_notified")).toHaveLength(1);
  });

  it("reason が変わると再通知する（reasonHash 不一致）", async () => {
    const task = createHumanQueueTask("review-required: 指摘あり");
    const stage = createMacosOnlyStage();

    await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(notifyCalls).toHaveLength(1);

    harness.store.updateBlockReason(task.id, "review-required: 指摘あり(修正版)", "tester", "human");

    const second = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(second.actions).toBe(1);
    expect(notifyCalls).toHaveLength(2);
    expect(notifyCalls[1]?.message).toBe("人間確認要\nreview-required: 指摘あり(修正版)");
    expect(notifyCalls[1]?.title).toBe("🔍 要レビュー確認");
    expect(harness.store.listEvents(task.id, "human_notified")).toHaveLength(2);
  });

  it("human_queue 以外の blocked（in-progress prefix 等）は対象外", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "進行中" }), "tester");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=sess-1 server=http://x started=2026-07-02T10:00:00+09:00",
      "tester",
    );
    const stage = createMacosOnlyStage();

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(0);
    expect(notifyCalls).toHaveLength(0);
  });

  it("dry-run は通知せず件数のみ計上する", async () => {
    createHumanQueueTask("needs-manual: dry-run確認");
    const stage = createMacosOnlyStage();

    const result = await stage.tick(harness.deps, false, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);
    expect(notifyCalls).toHaveLength(0);
  });

  it("dry-run はイベントを記録しない", async () => {
    const task = createHumanQueueTask("needs-manual: dry-runイベント確認");
    const stage = createMacosOnlyStage();

    await stage.tick(harness.deps, false, Math.floor(Date.now() / 1000));
    expect(harness.store.listEvents(task.id, "human_notified")).toHaveLength(0);
  });

  it("notifier 失敗でもタスク状態は不変（warn のみでクラッシュしない）", async () => {
    notifierResult = false;
    const task = createHumanQueueTask("needs-manual: 通知失敗確認");
    const before = harness.store.getTask(task.id);
    const stage = createMacosOnlyStage();

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(notifyCalls).toHaveLength(1);
    const after = harness.store.getTask(task.id);
    expect(after?.status).toBe(before?.status);
    expect(after?.blockReason).toBe(before?.blockReason);
    expect(after?.assignee).toBe(before?.assignee);
  });

  it("operational notification は既存 transport を使い DB イベントを記録しない", async () => {
    setNotifyConfig({ transports: ["macos"] });

    const result = await sendOperationalNotification(
      harness.deps,
      {
        id: "bridgewatch:codex",
        title: "bridge identity warning",
        body: "codex bridge identity check failed",
      },
      { transports: [createMacosTransport(notifier)] },
    );

    expect(result).toEqual({
      attempted: true,
      sent: true,
      sentTransports: ["macos"],
      failedTransports: [],
    });
    expect(notifyCalls).toEqual([
      {
        taskId: "bridgewatch:codex",
        message: "bridge identity warning\ncodex bridge identity check failed",
        title: "🚨 bridge警告",
      },
    ]);
    expect(harness.store.listEvents("bridgewatch:codex", "human_notified")).toHaveLength(0);
  });

  it("heartbeat stale operational notification は復旧コマンドをmacOS本文で省略しない", async () => {
    setNotifyConfig({ transports: ["macos"] });
    const takeoverCommand = `hachi orchestrator session takeover o_${"b".repeat(16)} --stale-sec 90 ` +
      "--provider codex --provider-session-id 11111111-1111-4111-8111-111111111111 --json";

    await sendOperationalNotification(
      harness.deps,
      {
        id: "orchestrator-heartbeat-stale:os_aaaaaaaaaaaaaaaa:57",
        title: "orchestrator heartbeat stale",
        body: ["stale heartbeat", takeoverCommand].join("\n"),
        fullMacosBody: true,
      },
      { transports: [createMacosTransport(notifier)] },
    );

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.message).toContain(takeoverCommand);
  });

  it("redact 済み reason の先頭100字のみ通知本文に使う", async () => {
    const longReason = `needs-manual: ${"あ".repeat(200)}`;
    const task = harness.store.createTask(taskInput({ status: "ready", title: "長いreason" }), "tester");
    harness.store.block(task.id, longReason, "tester", "human");
    const stage = createMacosOnlyStage();

    await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    const bodyLine = notifyCalls[0]?.message.split("\n")[1] ?? "";
    expect(bodyLine.length).toBe(100);
    expect(longReason.startsWith(bodyLine)).toBe(true);
  });

  it("notify.transports=['telegram'] なら Telegram transport だけを使う（契約 §38.1/§38.2）", async () => {
    const task = createHumanQueueTask("needs-manual: Telegram 送信確認");
    setNotifyConfig({
      transports: ["telegram"],
      telegram: { chatId: "chat-1", baseUrl: "https://kanban.example", minPriority: 0 },
    });
    const token = "123456:telegramSecret";
    writeTelegramToken(token);
    const fetchMock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
      void url;
      void init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const stage = createNotifyStage({ transports: [createTelegramTransport()], fetch: fetchMock as NotifyFetch });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(notifyCalls).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string; disable_web_page_preview: boolean };
    expect(body.chat_id).toBe("chat-1");
    expect(body.disable_web_page_preview).toBe(true);
    expect(body.text.split("\n")[0]).toBe("⚠️ 要対応 — 人間確認要");
    expect(body.text).toContain(`id: ${task.id}`);
    expect(body.text).toContain("block_reason: needs-manual: Telegram 送信確認");
    expect(body.text).toContain(`url: https://kanban.example/task/${task.id}`);
    expect(harness.store.listEvents(task.id, "human_notified")).toHaveLength(1);
  });

  it("Telegram credential 欠如時は skip し、warn は1 tick 1回で human_notified を記録しない", async () => {
    const task1 = createHumanQueueTask("needs-manual: Telegram token 未設定1");
    const task2 = createHumanQueueTask("needs-manual: Telegram token 未設定2");
    setNotifyConfig({ transports: ["telegram"], telegram: {} });
    const warnings = installWarningLogger();
    const fetchMock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
      void url;
      void init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const stage = createNotifyStage({ transports: [createTelegramTransport()], fetch: fetchMock as NotifyFetch });

    const first = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    const second = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(first.actions).toBe(2);
    expect(second.actions).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.msg).toContain("credential");
    expect(warnings[0]?.fields).toMatchObject({ transport: "telegram", chatIdConfigured: false });
    expect(harness.store.listEvents(task1.id, "human_notified")).toHaveLength(0);
    expect(harness.store.listEvents(task2.id, "human_notified")).toHaveLength(0);
  });

  it("Telegram 送信失敗時も token 値を warn ログへ出さない", async () => {
    const secretBody = "needs-manual: secret Telegram body";
    const secretChatId = "secret-chat-id";
    const task = createHumanQueueTask(secretBody);
    setNotifyConfig({ transports: ["telegram"], telegram: { chatId: secretChatId } });
    const secretToken = "123456:superSecretTelegramToken";
    writeTelegramToken(secretToken);
    const warnings = installWarningLogger();
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new Error(`network error ${secretToken}`);
    });
    const { clock, sleep } = createTelegramClock();
    const stage = createNotifyStage({ transports: [createTelegramTransport({ clock })], fetch: fetchMock as NotifyFetch });

    await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(warnings).toHaveLength(1);
    const serializedWarnings = JSON.stringify(warnings);
    expect(serializedWarnings).not.toContain(secretToken);
    expect(serializedWarnings).not.toContain(secretChatId);
    expect(serializedWarnings).not.toContain(secretBody);
    expect(serializedWarnings).not.toContain("api.telegram.org");
    const events = harness.store.listEvents(task.id, "human_notified");
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(secretToken);
    expect(JSON.stringify(events)).not.toContain(secretChatId);
    expect(JSON.stringify(events)).not.toContain(secretBody);
  });

  it.each([
    { name: "network", failure: new Error("fetch failed") },
    { name: "timeout", failure: new DOMException("timed out", "TimeoutError") },
  ])("Telegram $name failure は250ms後に1回だけ再試行して成功する", async ({ failure }) => {
    const secretToken = "123456:retrySecret";
    writeTelegramToken(secretToken);
    const fetchMock = vi.fn<NotifyFetch>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const { clock, sleep } = createTelegramClock();
    const transport = createTelegramTransport({ clock });

    const result = await transport.send(createTelegramMessage(), createTelegramTransportContext(fetchMock));

    expect(result).toEqual({ status: "sent", fields: { attemptCount: 2, finalClassification: "success" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(250);
    expect(JSON.stringify(result)).not.toContain(secretToken);
    expect(JSON.stringify(result)).not.toContain("chat-secret");
  });

  it("Telegram 5xx は1回だけ再試行し、二重失敗では最終分類だけを返す", async () => {
    const secretToken = "123456:retrySecret";
    writeTelegramToken(secretToken);
    const fetchMock = vi.fn<NotifyFetch>()
      .mockResolvedValueOnce(new Response("first secret body", { status: 503 }))
      .mockRejectedValueOnce(new Error(`second secret ${secretToken}`));
    const { clock, sleep } = createTelegramClock();
    const transport = createTelegramTransport({ clock });

    const result = await transport.send(createTelegramMessage(), createTelegramTransportContext(fetchMock));

    expect(result).toEqual({ status: "failed", fields: { attemptCount: 2, finalClassification: "network" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(Object.keys(result.fields ?? {})).toEqual(["attemptCount", "finalClassification"]);
    expect(JSON.stringify(result)).not.toContain(secretToken);
    expect(JSON.stringify(result)).not.toContain("chat-secret");
    expect(JSON.stringify(result)).not.toContain("first secret body");
  });

  it.each([
    { retryAfter: "1", expectedMs: 1_000 },
    { retryAfter: "60", expectedMs: 2_000 },
    { retryAfter: "Thu, 01 Jan 1970 00:00:02 GMT", expectedMs: 1_000 },
    { retryAfter: "invalid", expectedMs: 250 },
    { retryAfter: "-1", expectedMs: 250 },
    { retryAfter: "1.5", expectedMs: 250 },
  ])("Telegram 429 Retry-After=$retryAfter を上限付きで尊重する", async ({ retryAfter, expectedMs }) => {
    writeTelegramToken("123456:retrySecret");
    const fetchMock = vi.fn<NotifyFetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": retryAfter } }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const { clock, sleep } = createTelegramClock();

    const result = await createTelegramTransport({ clock }).send(
      createTelegramMessage(),
      createTelegramTransportContext(fetchMock),
    );

    expect(result).toEqual({ status: "sent", fields: { attemptCount: 2, finalClassification: "success" } });
    expect(sleep).toHaveBeenCalledWith(expectedMs);
  });

  it.each([400, 401, 403, 404, 499])("Telegram HTTP %i は再試行せず即時失敗する", async (status) => {
    writeTelegramToken("123456:retrySecret");
    const fetchMock = vi.fn<NotifyFetch>().mockResolvedValue(new Response("credential URL secret", { status }));
    const { clock, sleep } = createTelegramClock();

    const result = await createTelegramTransport({ clock }).send(
      createTelegramMessage(),
      createTelegramTransportContext(fetchMock),
    );

    expect(result).toEqual({ status: "failed", fields: { attemptCount: 1, finalClassification: "http-4xx" } });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("credential URL secret");
  });

  it("Telegram minPriority 未設定なら負 priority の human_queue も送信する（契約 §38 既定）", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "負優先", priority: -1 }), "tester");
    harness.store.block(task.id, "needs-manual: 負priorityも既定では通知", "tester", "human");
    setNotifyConfig({ transports: ["telegram"], telegram: { chatId: "chat-1" } });
    writeTelegramToken("123456:telegramSecret");
    const fetchMock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
      void url;
      void init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const stage = createNotifyStage({ transports: [createTelegramTransport()], fetch: fetchMock as NotifyFetch });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as { text: string };
    expect(body.text).toContain(`id: ${task.id}`);
    expect(harness.store.listEvents(task.id, "human_notified")).toHaveLength(1);
  });

  it("Telegram minPriority 未満のタスクは送信しない", async () => {
    const low = harness.store.createTask(taskInput({ status: "ready", title: "低優先", priority: 4 }), "tester");
    const high = harness.store.createTask(taskInput({ status: "ready", title: "高優先", priority: 5 }), "tester");
    harness.store.block(low.id, "needs-manual: 優先度不足", "tester", "human");
    harness.store.block(high.id, "needs-manual: 優先度到達", "tester", "human");
    setNotifyConfig({ transports: ["telegram"], telegram: { chatId: "chat-1", minPriority: 5 } });
    writeTelegramToken("123456:telegramSecret");
    const fetchMock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
      void url;
      void init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const stage = createNotifyStage({ transports: [createTelegramTransport()], fetch: fetchMock as NotifyFetch });

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as { text: string };
    expect(body.text).toContain(`id: ${high.id}`);
    expect(harness.store.listEvents(low.id, "human_notified")).toHaveLength(0);
    expect(harness.store.listEvents(high.id, "human_notified")).toHaveLength(1);
  });

  it("watched タスクの状態変化を通知し、成功時だけ cursor を前進する（契約 §46.5）", async () => {
    const task = createWatchedReadyTask("watch成功");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=sess-1 server=http://x started=2026-07-07T10:00:00+09:00",
      "tester",
    );
    const statusEvent = harness.store.listEvents(task.id, "status_changed").at(-1)!;
    const stage = createMacosOnlyStage();

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.taskId).toBe(task.id);
    expect(notifyCalls[0]?.title).toBe("▶️ 進行中");
    expect(notifyCalls[0]?.message).toContain("watch成功");
    expect(notifyCalls[0]?.message).toContain("ready -> blocked");
    expect(notifyCalls[0]?.message).toContain(`http://127.0.0.1:9131/task/${task.id}`);
    expect(readWatchNotifyState(harness.deps.env).lastEventId).toBe(statusEvent.id);
  });

  it("watched 通知は transport 失敗時に cursor を前進しない", async () => {
    notifierResult = false;
    const task = createWatchedReadyTask("watch失敗");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=sess-1 server=http://x started=2026-07-07T10:00:00+09:00",
      "tester",
    );
    const stage = createMacosOnlyStage();

    await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(notifyCalls).toHaveLength(2);
    expect(readWatchNotifyState(harness.deps.env).lastEventId).toBe(0);
  });

  it("human_queue 通知と重複する watched 状態変化は watched 側で送らない", async () => {
    const task = createWatchedReadyTask("watch重複");
    harness.store.block(task.id, "needs-manual: 人間確認を優先", "tester", "human");
    const statusEvent = harness.store.listEvents(task.id, "status_changed").at(-1)!;
    const stage = createMacosOnlyStage();

    await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.message).toBe("watch重複\nneeds-manual: 人間確認を優先");
    expect(harness.store.listEvents(task.id, "human_notified")).toHaveLength(1);
    expect(readWatchNotifyState(harness.deps.env).lastEventId).toBe(statusEvent.id);
  });

  it("watched=0 の状態変化は watched 通知しない", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "非watch" }), "tester");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=sess-1 server=http://x started=2026-07-07T10:00:00+09:00",
      "tester",
    );
    const stage = createMacosOnlyStage();

    const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(0);
    expect(notifyCalls).toHaveLength(0);
    expect(readWatchNotifyState(harness.deps.env).lastEventId).toBe(0);
  });

  it("watched タスクの複数状態変化をタスク単位の1通へ集約する", async () => {
    const task = createWatchedReadyTask("watch集約");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=sess-1 server=http://x started=2026-07-07T10:00:00+09:00",
      "tester",
    );
    harness.store.unblock(task.id, "ready", "tester");
    harness.store.block(
      task.id,
      "claude-in-progress: 実装中 tmux=none even-session=sess-2 server=http://x started=2026-07-07T10:01:00+09:00",
      "tester",
    );
    const lastStatusEvent = harness.store.listEvents(task.id, "status_changed").at(-1)!;
    const stage = createMacosOnlyStage();

    await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.title).toBe("▶️ 進行中");
    expect(notifyCalls[0]?.message).toContain("ready -> blocked, blocked -> ready, ready -> blocked");
    expect(readWatchNotifyState(harness.deps.env).lastEventId).toBe(lastStatusEvent.id);
  });
});
