// brief ステージのテスト（docs/contract.md §48）
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskInput } from "@hachi/testing";
import { acquireStewardStateLock } from "@hachi/core";
import type { HachiConfig, StageDeps, TaskRow } from "@hachi/core";
import { FakeAdapter, setupHarness, type TestHarness } from "../test-support.js";
import {
  buildBriefPrompt,
  collectBriefMaterials,
  computeDueBriefSlots,
  createBriefStage,
  readBriefState,
  writeBriefState,
  type BriefNotifyFn,
  type BriefSessionRunner,
} from "./brief.js";
import type { OperationalNotifyInput, OperationalNotifyResult } from "./notify.js";
import type { IntegrationEvidence } from "./steward-archive-integration.js";

interface HachiConfigWithBrief extends HachiConfig {
  brief?: {
    times: string[];
  };
}

interface TestSqliteStoreAccess {
  readonly db: {
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
    };
  };
}

function localEpoch(year: number, monthIndex: number, day: number, hour: number, minute: number): number {
  return Math.floor(new Date(year, monthIndex, day, hour, minute).getTime() / 1000);
}

function setBriefTimes(config: HachiConfig, times: string[]): void {
  (config as HachiConfigWithBrief).brief = { times };
}

function fakeRunner(output: string, prompts: string[] = []): BriefSessionRunner {
  return {
    run: async (prompt) => {
      prompts.push(prompt);
      return output;
    },
  };
}

function failingRunner(error: Error): BriefSessionRunner {
  return {
    run: async () => {
      throw error;
    },
  };
}

function successfulNotify(calls: OperationalNotifyInput[]): BriefNotifyFn {
  return async (_deps: StageDeps, input: OperationalNotifyInput): Promise<OperationalNotifyResult> => {
    calls.push(input);
    return { attempted: true, sent: true };
  };
}

function makeDone(harness: TestHarness, taskId: string): TaskRow {
  harness.store.block(taskId, "codex-in-progress: テスト", "tester");
  return harness.store.transition({ taskId, to: "done", actor: "tester" });
}

/**
 * §74.3 集計テスト用: done タスクを steward_auto_archive イベント付きで archived へ遷移させ、
 * 遷移直後の updated_at / event created_at を archivedAt（境界テストで制御したい任意の秒数）へ
 * 上書きする。steward.ts 1116-1127行目付近の実際の呼び出しパターン（transition の eventType /
 * payload 構造）に揃える。
 */
function makeArchivedWithEvidence(
  harness: TestHarness,
  title: string,
  evidence: IntegrationEvidence,
  archivedAt: number,
): TaskRow {
  const task = harness.store.createTask(taskInput({ status: "ready", title }), "tester");
  makeDone(harness, task.id);
  harness.store.transition({
    taskId: task.id,
    to: "archived",
    actor: "steward",
    eventType: "steward_auto_archive",
    payload: {
      kind: "archive",
      reason: `${evidence} により archive しました`,
      proposalReason: "テスト用の提案理由",
      integrationEvidence: evidence,
    },
  });
  const store = harness.store as unknown as TestSqliteStoreAccess;
  store.db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(archivedAt, task.id);
  store.db
    .prepare(`UPDATE task_events SET created_at = ? WHERE task_id = ? AND event_type = 'steward_auto_archive'`)
    .run(archivedAt, task.id);
  return harness.store.getTask(task.id)!;
}

function forceUnknownBlockedReason(harness: TestHarness, taskId: string, reason: string): void {
  // 通常 API は未知 prefix を fail-closed で拒否するため、読み取り防御の検証だけ legacy 行として注入する。
  const store = harness.store as unknown as TestSqliteStoreAccess;
  store.db
    .prepare(`UPDATE tasks SET status = 'blocked', block_reason = ?, updated_at = ? WHERE id = ?`)
    .run(reason, Math.floor(Date.now() / 1000), taskId);
}

describe("brief", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe("配信時刻判定（§48.1）", () => {
    it("未処理の配信時刻を跨いだ場合だけ due にする", () => {
      const lastRunAt = localEpoch(2026, 0, 2, 7, 29);
      const before = localEpoch(2026, 0, 2, 7, 29);
      const after = localEpoch(2026, 0, 2, 7, 31);

      expect(computeDueBriefSlots(lastRunAt, before, ["07:30"])).toEqual([]);
      expect(computeDueBriefSlots(lastRunAt, after, ["07:30"])).toEqual([
        localEpoch(2026, 0, 2, 7, 30),
      ]);
    });

    it("同一時刻は lastRunAt により二重配信しない", () => {
      const lastRunAt = localEpoch(2026, 0, 2, 7, 31);
      const now = localEpoch(2026, 0, 2, 7, 32);

      expect(computeDueBriefSlots(lastRunAt, now, ["07:30"])).toEqual([]);
    });

    it("複数の配信時刻を跨いだ場合は slot を列挙し、stage 側で1回に集約できる", () => {
      const lastRunAt = localEpoch(2026, 0, 1, 7, 0);
      const now = localEpoch(2026, 0, 2, 20, 0);

      expect(computeDueBriefSlots(lastRunAt, now, ["07:30", "19:30"])).toEqual([
        localEpoch(2026, 0, 1, 7, 30),
        localEpoch(2026, 0, 1, 19, 30),
        localEpoch(2026, 0, 2, 7, 30),
        localEpoch(2026, 0, 2, 19, 30),
      ]);
    });
  });

  describe("stage 実行（§48.1/§48.2）", () => {
    it("due のとき LLM 出力を operational notify へ送り、lastRunAt を更新する", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      const prompts: string[] = [];
      const notifyCalls: OperationalNotifyInput[] = [];
      const stage = createBriefStage({
        nowFn: () => currentSec,
        sessionRunner: fakeRunner("朝のブリーフ\n- 完了1件", prompts),
        notifyFn: successfulNotify(notifyCalls),
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(result.actions).toBe(1);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("フェンス、JSON");
      expect(notifyCalls).toEqual([
        {
          id: "brief",
          title: "hachi-kanban brief",
          body: "朝のブリーフ\n- 完了1件",
          priority: 1_000_000,
        },
      ]);
      expect(readBriefState(harness.home.home).lastRunAt).toBe(currentSec);

      const second = await stage.tick(harness.deps, true, currentSec + 60);
      expect(second.actions).toBe(0);
      expect(notifyCalls).toHaveLength(1);
    });

    it("brief.disabled が存在する場合は起動しない", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      writeFileSync(join(harness.home.home, "brief.disabled"), "", "utf8");
      const prompts: string[] = [];
      const stage = createBriefStage({
        nowFn: () => localEpoch(2026, 0, 2, 7, 31),
        sessionRunner: fakeRunner("送られない", prompts),
        notifyFn: successfulNotify([]),
      });

      const result = await stage.tick(harness.deps, true, localEpoch(2026, 0, 2, 7, 31));

      expect(result.skipped).toBe(true);
      expect(prompts).toEqual([]);
    });

    it("連続3失敗で auto-disable する", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      let currentSec = localEpoch(2026, 0, 2, 7, 31);
      const lifecycleNotifications: string[] = [];
      const stage = createBriefStage({
        nowFn: () => currentSec,
        sessionRunner: failingRunner(new Error("LLM failed")),
        notifyFn: successfulNotify([]),
        lifecycleNotifyFn: async (_deps, _task, message) => {
          lifecycleNotifications.push(message);
          return true;
        },
      });

      await stage.tick(harness.deps, true, currentSec);
      currentSec += 60;
      await stage.tick(harness.deps, true, currentSec);
      currentSec += 60;
      const third = await stage.tick(harness.deps, true, currentSec);

      const state = readBriefState(harness.home.home);
      expect(state.consecutiveFailures).toBe(3);
      expect(state.autoDisabled).toBe(true);
      expect(state.autoDisabledAt).toBe(currentSec);
      expect(third.notes?.some((note) => note.includes("auto-disable"))).toBe(true);
      expect(lifecycleNotifications).toEqual([
        "brief: 連続3回失敗により auto-disable しました",
      ]);
    });

    it("auto-disable の待機時間未満ではセッションを起動しない", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      writeBriefState(harness.home.home, {
        lastRunAt: 0,
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_599,
        claimGeneration: 0,
      });
      const prompts: string[] = [];
      const stage = createBriefStage({
        nowFn: () => currentSec,
        sessionRunner: fakeRunner("送られない", prompts),
        notifyFn: successfulNotify([]),
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(result.skipped).toBe(true);
      expect(prompts).toEqual([]);
    });

    it("待機時間経過後は half-open を1回実行し、成功すると完全復帰を通知する", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      writeBriefState(harness.home.home, {
        lastRunAt: 0,
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      const prompts: string[] = [];
      const lifecycleNotifications: string[] = [];
      const stage = createBriefStage({
        nowFn: () => currentSec,
        sessionRunner: fakeRunner("復帰ブリーフ", prompts),
        notifyFn: successfulNotify([]),
        lifecycleNotifyFn: async (_deps, _task, message) => {
          lifecycleNotifications.push(message);
          return true;
        },
      });

      await stage.tick(harness.deps, true, currentSec);

      expect(prompts).toHaveLength(1);
      expect(readBriefState(harness.home.home)).toMatchObject({
        consecutiveFailures: 0,
        autoDisabled: false,
        autoDisabledReason: "",
        autoDisabledAt: 0,
      });
      expect(lifecycleNotifications).toEqual([
        "brief: half-open 再試行に成功し auto-disable から復帰しました",
      ]);
    });

    it("half-open outbox は state lock 解放後に配送する", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      writeBriefState(harness.home.home, {
        lastRunAt: 0,
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      let lockAvailableDuringNotify = false;
      let pendingDuringNotify = 0;
      const stage = createBriefStage({
        nowFn: () => currentSec,
        elapsedNowFn: () => 0,
        sessionRunner: fakeRunner("復帰ブリーフ"),
        notifyFn: async (): Promise<OperationalNotifyResult> => {
          const lock = acquireStewardStateLock(harness.home.home, "cli-brief-enable");
          lockAvailableDuringNotify = lock !== null;
          lock?.release();
          pendingDuringNotify = harness.store.listPendingHalfOpenOutbox({
            stage: "brief",
            now: currentSec,
          }).length;
          return { attempted: true, sent: true };
        },
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect({ lockAvailableDuringNotify, pendingDuringNotify, notes: result.notes }).toEqual({
        lockAvailableDuringNotify: true,
        pendingDuringNotify: 1,
        notes: expect.any(Array),
      });
      expect(harness.store.listPendingHalfOpenOutbox({ stage: "brief", now: currentSec })).toEqual([]);
    });

    it("enqueue を含む fence が baseline 不一致なら brief state と outbox を残さない", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      writeBriefState(harness.home.home, {
        lastRunAt: 0,
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      const notifyCalls: OperationalNotifyInput[] = [];
      const stage = createBriefStage({
        nowFn: () => currentSec,
        elapsedNowFn: () => 0,
        sessionRunner: {
          run: async (): Promise<string> => {
            const claimed = readBriefState(harness.home.home);
            writeBriefState(harness.home.home, {
              ...claimed,
              lastError: "同一generationの外部 writer state",
            });
            return "配送されないブリーフ";
          },
        },
        notifyFn: successfulNotify(notifyCalls),
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(result.skipped).toBe(true);
      expect(readBriefState(harness.home.home)).toMatchObject({
        lastRunAt: 0,
        lastError: "同一generationの外部 writer state",
        claimGeneration: 1,
      });
      expect(harness.store.listPendingHalfOpenOutbox({ stage: "brief", now: currentSec })).toEqual([]);
      expect(notifyCalls).toEqual([]);
    });

    it("brief の旧世代 half-open outbox は配送せず discarded にする", async () => {
      setBriefTimes(harness.deps.config, []);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      writeBriefState(harness.home.home, {
        lastRunAt: 0,
        lastError: "",
        consecutiveFailures: 0,
        autoDisabled: false,
        autoDisabledReason: "",
        autoDisabledAt: 0,
        claimGeneration: 2,
      });
      const old = harness.store.enqueueHalfOpenOutbox({
        stage: "brief",
        claimGeneration: 1,
        dedupeKey: "brief-old-generation",
        kind: "brief",
        payload: JSON.stringify({ id: "brief", title: "旧世代", body: "送らない" }),
        now: currentSec,
      });
      const notifyCalls: OperationalNotifyInput[] = [];
      const stage = createBriefStage({
        nowFn: () => currentSec,
        notifyFn: successfulNotify(notifyCalls),
      });

      await stage.tick(harness.deps, true, currentSec);

      expect(notifyCalls).toEqual([]);
      expect(harness.store.markHalfOpenOutbox({ id: old.row.id, result: "sent", now: currentSec })?.status)
        .toBe("discarded");
    });

    it("brief half-open は claim 経過30分で配送前に打ち切る", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      writeBriefState(harness.home.home, {
        lastRunAt: 0,
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      let elapsedMs = 0;
      const notifyCalls: OperationalNotifyInput[] = [];
      const stage = createBriefStage({
        nowFn: () => currentSec,
        elapsedNowFn: () => elapsedMs,
        sessionRunner: {
          run: async (): Promise<string> => {
            elapsedMs = 30 * 60 * 1_000;
            return "上限到達ブリーフ";
          },
        },
        notifyFn: successfulNotify(notifyCalls),
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(notifyCalls).toEqual([]);
      expect(result.notes?.some((note) => note.includes("経過時間上限30分"))).toBe(true);
      expect(readBriefState(harness.home.home)).toMatchObject({
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledAt: currentSec,
        claimGeneration: 1,
      });
    });

    it("half-open が失敗すると回数を増やさず再試行起点だけを更新する", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      writeBriefState(harness.home.home, {
        lastRunAt: 0,
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      const stage = createBriefStage({
        nowFn: () => currentSec,
        sessionRunner: failingRunner(new Error("half-open failure")),
        notifyFn: successfulNotify([]),
      });

      await stage.tick(harness.deps, true, currentSec);

      expect(readBriefState(harness.home.home)).toMatchObject({
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledAt: currentSec,
      });
    });

    it("half-open の model 解決失敗より前に claim を永続化する", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      harness.deps.config.profiles["brief"] = {
        provider: "claude",
        model: "not-allowlisted",
        transport: "direct",
        effort: "medium",
      };
      writeBriefState(harness.home.home, {
        lastRunAt: 0,
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 7,
      });
      const stage = createBriefStage({
        nowFn: () => currentSec,
        notifyFn: successfulNotify([]),
      });

      await stage.tick(harness.deps, true, currentSec);

      expect(readBriefState(harness.home.home)).toMatchObject({
        autoDisabledAt: currentSec,
        claimGeneration: 8,
        consecutiveFailures: 3,
        lastError: expect.stringContaining("モデル解決に失敗"),
      });
    });

    it("half-open 実行中に generation が進んだ場合は失敗stateの上書きを止める", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      writeBriefState(harness.home.home, {
        lastRunAt: 0,
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      const stage = createBriefStage({
        nowFn: () => currentSec,
        notifyFn: successfulNotify([]),
        sessionRunner: {
          run: async (): Promise<string> => {
            const claimed = readBriefState(harness.home.home);
            writeBriefState(harness.home.home, {
              ...claimed,
              claimGeneration: claimed.claimGeneration + 1,
              lastError: "外部 writer の state",
            });
            throw new Error("上書きされない失敗");
          },
        },
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(result.skipped).toBe(true);
      expect(readBriefState(harness.home.home)).toMatchObject({
        claimGeneration: 2,
        lastError: "外部 writer の state",
        consecutiveFailures: 3,
        autoDisabledAt: currentSec,
      });
    });

    it("half-open 実行中に同じgenerationでbaselineが変わった場合は失敗stateを上書きしない", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      writeBriefState(harness.home.home, {
        lastRunAt: 0,
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      const stage = createBriefStage({
        nowFn: () => currentSec,
        notifyFn: successfulNotify([]),
        sessionRunner: {
          run: async (): Promise<string> => {
            const claimed = readBriefState(harness.home.home);
            writeBriefState(harness.home.home, {
              ...claimed,
              lastError: "同一generationの外部 writer state",
            });
            throw new Error("上書きされない失敗");
          },
        },
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(result.skipped).toBe(true);
      expect(result.notes).toContain(
        "brief half-open claim を失ったためstate更新を中止しました (claim-mismatch)",
      );
      expect(readBriefState(harness.home.home)).toMatchObject({
        claimGeneration: 1,
        lastError: "同一generationの外部 writer state",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledAt: currentSec,
      });
    });

    it("2 process 相当の並行 tick でも half-open session は1回しか走らない", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      writeBriefState(harness.home.home, {
        lastRunAt: 0,
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      let releaseRun: (() => void) | undefined;
      const runGate = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      const prompts: string[] = [];
      const stage = createBriefStage({
        nowFn: () => currentSec,
        notifyFn: successfulNotify([]),
        sessionRunner: {
          run: async (prompt): Promise<string> => {
            prompts.push(prompt);
            await runGate;
            return "復帰ブリーフ";
          },
        },
      });

      const first = stage.tick(harness.deps, true, currentSec);
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      const second = await stage.tick(harness.deps, true, currentSec);
      releaseRun?.();
      await first;

      expect(second.skipped).toBe(true);
      expect(prompts).toHaveLength(1);
      expect(readBriefState(harness.home.home).claimGeneration).toBe(1);
    });

    it("複数時刻を跨いでも notify は1回だけ呼ぶ", async () => {
      setBriefTimes(harness.deps.config, ["07:30", "19:30"]);
      const lastRunAt = localEpoch(2026, 0, 1, 7, 0);
      const currentSec = localEpoch(2026, 0, 2, 20, 0);
      const notifyCalls: OperationalNotifyInput[] = [];
      const stage = createBriefStage({
        nowFn: () => currentSec,
        sessionRunner: fakeRunner("まとめブリーフ"),
        notifyFn: successfulNotify(notifyCalls),
      });
      writeBriefState(
        harness.home.home,
        {
          lastRunAt,
          lastError: "",
          consecutiveFailures: 0,
          autoDisabled: false,
          autoDisabledReason: "",
          autoDisabledAt: 0,
          claimGeneration: 0,
        },
      );

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(result.actions).toBe(1);
      expect(notifyCalls).toHaveLength(1);
      expect(result.notes?.some((note) => note.includes("4時刻分を1回に集約"))).toBe(true);
    });

    it("direct session成功時は隔離workspaceを破棄し、terminal証跡を残してstopしない", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      const fakeDirect = new FakeAdapter("claude");
      fakeDirect.launchResponse = {
        provider: "claude",
        sessionId: "direct-brief-success",
        serverUrl: "direct",
        model: "claude-sonnet-5",
        modelDelivery: "native",
        startedAt: currentSec,
      };
      fakeDirect.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      fakeDirect.transcriptResponse = "朝のブリーフ\n- 正常";
      harness.deps.directAdapters = { claude: fakeDirect };
      const stage = createBriefStage({
        nowFn: () => currentSec,
        notifyFn: successfulNotify([]),
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(result.actions).toBe(1);
      expect(fakeDirect.stopCalls).toHaveLength(0);
      const isolatedCwd = fakeDirect.launchCalls[0]?.options.cwd;
      expect(isolatedCwd).toBeDefined();
      expect(isolatedCwd).not.toBe(harness.home.home);
      expect(existsSync(isolatedCwd!)).toBe(false);
      const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
      expect(log).toContain("brief: direct session を開始しました");
      expect(log).toContain("brief: direct session が正常終端しました");
    });

    it("direct session の out ファイル欠落固定文言は失敗扱いにし、notify せず lastRunAt を進めない", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      const fakeDirect = new FakeAdapter("claude");
      fakeDirect.launchResponse = {
        provider: "claude",
        sessionId: "direct-brief-missing",
        serverUrl: "direct",
        model: "claude-sonnet-5",
        modelDelivery: "native",
        startedAt: currentSec,
      };
      fakeDirect.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      fakeDirect.transcriptResponse = "(出力ファイルなし)";
      harness.deps.directAdapters = { claude: fakeDirect };
      const notifyCalls: OperationalNotifyInput[] = [];
      const stage = createBriefStage({
        nowFn: () => currentSec,
        notifyFn: successfulNotify(notifyCalls),
      });

      const result = await stage.tick(harness.deps, true, currentSec);
      const state = readBriefState(harness.home.home);

      expect(result.actions).toBe(0);
      expect(fakeDirect.transcriptCalls).toHaveLength(1);
      expect(fakeDirect.stopCalls).toHaveLength(1);
      const isolatedCwd = fakeDirect.launchCalls[0]?.options.cwd;
      expect(isolatedCwd).toBeDefined();
      expect(isolatedCwd).not.toBe(harness.home.home);
      expect(existsSync(isolatedCwd!)).toBe(false);
      expect(notifyCalls).toEqual([]);
      expect(state.lastRunAt).toBe(0);
      expect(state.consecutiveFailures).toBe(1);
      expect(state.lastError).toContain("transcript が取得できませんでした");
    });

    it("timeoutは未完了sessionをstopし、stop結果と残留stateを構造化ログへ残す", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      const fakeDirect = new FakeAdapter("claude");
      fakeDirect.launchResponse = {
        provider: "claude",
        sessionId: "direct-brief-timeout",
        serverUrl: "direct",
        model: "claude-sonnet-5",
        modelDelivery: "native",
        startedAt: currentSec,
      };
      fakeDirect.statusResponse = { state: "active", lastActivityAt: null };
      fakeDirect.stopResponse = { stopped: true, reason: "killed" };
      harness.deps.directAdapters = { claude: fakeDirect };
      const stage = createBriefStage({
        nowFn: () => currentSec,
        notifyFn: successfulNotify([]),
        sessionTimeoutSec: 0,
        sessionPollIntervalMs: 1,
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(result.actions).toBe(0);
      expect(fakeDirect.stopCalls).toHaveLength(1);
      expect(fakeDirect.statusCalls.length).toBeGreaterThanOrEqual(2);
      const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
      expect(log).toContain("brief: direct session を開始しました");
      expect(log).toContain("brief: direct session がtimeoutしました");
      expect(log).toContain('"reason":"killed"');
      expect(log).toContain('"postStopState":"active"');
      expect(log).toContain('"residual":true');
    });

    it("stop capabilityのないdirect adapterはlaunch前にfail-closedで拒否する", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      const fakeDirect = new FakeAdapter("claude", { supportsStop: false });
      harness.deps.directAdapters = { claude: fakeDirect };
      const stage = createBriefStage({
        nowFn: () => currentSec,
        notifyFn: successfulNotify([]),
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(result.actions).toBe(0);
      expect(fakeDirect.launchCalls).toHaveLength(0);
      expect(readBriefState(harness.home.home).lastError).toContain("stop capability 必須");
    });
  });

  describe("state I/O（§48.3）", () => {
    it("0600 durable writeを行い、CLI lock中は上書きしない", () => {
      const before = {
        lastRunAt: 10,
        lastError: "",
        consecutiveFailures: 0,
        autoDisabled: false,
        autoDisabledReason: "",
        autoDisabledAt: 0,
        claimGeneration: 0,
      };
      writeBriefState(harness.home.home, before);
      expect(statSync(join(harness.home.home, "state", "brief.json")).mode & 0o777).toBe(0o600);
      const lock = acquireStewardStateLock(harness.home.home, "cli-brief-enable");
      expect(lock).not.toBeNull();
      expect(() => writeBriefState(harness.home.home, { ...before, lastRunAt: 20 }))
        .toThrow(/別process/);
      expect(readBriefState(harness.home.home)).toEqual(before);
      lock!.release();
    });

    it("tick中にstateが置換された場合はbaseline CASでstale writeを拒否する", async () => {
      setBriefTimes(harness.deps.config, ["07:30"]);
      const currentSec = localEpoch(2026, 0, 2, 7, 31);
      const initial = {
        lastRunAt: 0,
        lastError: "",
        consecutiveFailures: 0,
        autoDisabled: false,
        autoDisabledReason: "",
        autoDisabledAt: 0,
        claimGeneration: 0,
      };
      const external = {
        ...initial,
        lastRunAt: 99,
        autoDisabled: true,
        autoDisabledReason: "external update",
      };
      writeBriefState(harness.home.home, initial);
      const stage = createBriefStage({
        nowFn: () => currentSec,
        sessionRunner: {
          run: async (): Promise<string> => {
            writeBriefState(harness.home.home, external);
            return "送信予定のbrief";
          },
        },
        notifyFn: successfulNotify([]),
      });

      await expect(stage.tick(harness.deps, true, currentSec)).rejects.toThrow(/stale write/);
      expect(readBriefState(harness.home.home)).toEqual(external);
    });
  });

  describe("材料収集（§48.2）", () => {
    it("done、人間確認2レーン、自律進行中、新着knowledgeを集める", () => {
      const doneTask = harness.store.createTask(taskInput({ status: "ready", title: "完了した作業" }), "tester");
      makeDone(harness, doneTask.id);
      const decision = harness.store.createTask(taskInput({ status: "ready", title: "判断待ち" }), "tester");
      harness.store.block(decision.id, "user-decision: 方針確認", "tester");
      const recovery = harness.store.createTask(taskInput({ status: "ready", title: "レビュー回収" }), "tester");
      harness.store.block(recovery.id, "review-required: 修正確認", "tester");
      const launchFailed = harness.store.createTask(taskInput({ status: "ready", title: "起動失敗" }), "tester");
      harness.store.block(launchFailed.id, "auto-launch-failed: direct transport 未構成", "tester");
      const unknown = harness.store.createTask(taskInput({ status: "ready", title: "未知prefix" }), "tester");
      forceUnknownBlockedReason(harness, unknown.id, "unexpected-prefix: 調査待ち");
      const running = harness.store.createTask(taskInput({ status: "ready", title: "進行中" }), "tester");
      harness.store.block(running.id, "codex-in-progress: 作業中", "tester");
      const now = Math.floor(Date.now() / 1000) + 10;
      harness.store.addKnowledge(
        {
          title: "新しい知識",
          body: "body",
          tags: ["brief"],
          createdAt: now - 5,
        },
        "tester",
      );

      const materials = collectBriefMaterials(harness.store, 0, now);

      expect(materials.doneTitles).toContain("完了した作業");
      expect(materials.humanDecisionQueue.map((task) => task.id)).toEqual([decision.id]);
      expect(materials.orchestratorRecoveryQueue.map((task) => task.id)).toHaveLength(3);
      expect(materials.orchestratorRecoveryQueue.map((task) => task.id)).toEqual(
        expect.arrayContaining([recovery.id, launchFailed.id, unknown.id]),
      );
      expect(materials.autonomousInProgress.map((task) => task.id)).toEqual([running.id]);
      expect(materials.knowledge.map((item) => item.title)).toContain("新しい知識");
    });

    it("100件超の既存knowledgeがあっても前回以降の新着を取りこぼさない", () => {
      const now = 2_000;
      for (let index = 0; index < 120; index += 1) {
        harness.store.addKnowledge(
          {
            title: `古い知識${index}`,
            body: `old body ${index}`,
            tags: ["old"],
            importance: 100,
            createdAt: 1_000 - index,
          },
          "tester",
        );
      }
      harness.store.addKnowledge(
        {
          title: "低重要度の新着知識",
          body: "fresh body",
          tags: ["brief"],
          importance: 1,
          createdAt: now - 10,
        },
        "tester",
      );

      const materials = collectBriefMaterials(harness.store, now - 100, now);

      expect(materials.knowledge.map((item) => item.title)).toEqual(["低重要度の新着知識"]);
    });

    it("§74.3: window内でarchivedされたタスクのintegrationEvidenceを集計し、プロンプトには not-observable:* だけを出す（clean-head-reachable は統合を観測済みのため除外する）", () => {
      const since = 1_000;
      const now = 2_000;
      makeArchivedWithEvidence(harness, "repo root直下のarchive1", "not-observable:repo-root", 1_500);
      makeArchivedWithEvidence(harness, "repo root直下のarchive2", "not-observable:repo-root", 1_600);
      makeArchivedWithEvidence(harness, "統合済みarchive", "clean-head-reachable", 1_700);

      const materials = collectBriefMaterials(harness.store, since, now);

      expect(materials.archivedByEvidence).toEqual({
        "not-observable:repo-root": 2,
        "clean-head-reachable": 1,
      });

      const prompt = buildBriefPrompt(materials, [now]);
      expect(prompt).toContain("統合を観測せずに archive した件数");
      expect(prompt).toContain("- not-observable:repo-root: 2件");
      // clean-head-reachable は merge-base --is-ancestor で統合先への到達を証明した上での archive であり、
      // 「統合を観測せずに」archive したケースではないためセクションに出してはいけない
      expect(prompt).not.toContain("clean-head-reachable");
    });

    it("§74.3: not-observable:* が無く clean-head-reachable のみのときはセクション自体を省略する（観測済み archive は『観測せず』の見出しに矛盾するため）", () => {
      const since = 1_000;
      const now = 2_000;
      makeArchivedWithEvidence(harness, "統合済みarchive1", "clean-head-reachable", 1_500);
      makeArchivedWithEvidence(harness, "統合済みarchive2-a", "clean-patch-equivalent", 1_600);
      makeArchivedWithEvidence(harness, "統合済みarchive2-b", "clean-patch-equivalent", 1_700);

      const materials = collectBriefMaterials(harness.store, since, now);

      expect(materials.archivedByEvidence).toEqual({
        "clean-head-reachable": 1,
        "clean-patch-equivalent": 2,
      });

      const prompt = buildBriefPrompt(materials, [now]);
      expect(prompt).not.toContain("統合を観測せずに archive した件数");
      expect(prompt).not.toContain("clean-head-reachable");
      expect(prompt).not.toContain("clean-patch-equivalent");
    });

    it("§74.3: window内に archived タスクが無ければ材料は空で、プロンプトへセクションを出さない", () => {
      const now = Math.floor(Date.now() / 1000) + 10;

      const materials = collectBriefMaterials(harness.store, 0, now);

      expect(materials.archivedByEvidence).toEqual({});

      const prompt = buildBriefPrompt(materials, [now]);
      expect(prompt).not.toContain("統合を観測せずに archive した件数");
    });

    describe("§74.3: archivedByEvidence のウィンドウ境界（steward の直近1tickだけを反映していた過去の実装ミスの再発防止）", () => {
      it("since と同時刻に archived されたタスクは含めない（sinceは排他下限）", () => {
        const since = 1_000;
        const now = 2_000;
        makeArchivedWithEvidence(harness, "since境界ちょうど", "not-observable:repo-root", since);

        const materials = collectBriefMaterials(harness.store, since, now);

        expect(materials.archivedByEvidence).toEqual({});
      });

      it("since より前に archived されたタスクは含めない", () => {
        const since = 1_000;
        const now = 2_000;
        makeArchivedWithEvidence(harness, "since以前", "not-observable:repo-root", since - 1);

        const materials = collectBriefMaterials(harness.store, since, now);

        expect(materials.archivedByEvidence).toEqual({});
      });

      it("now と同時刻に archived されたタスクは含める（nowは包含上限）", () => {
        const since = 1_000;
        const now = 2_000;
        makeArchivedWithEvidence(harness, "now境界ちょうど", "not-observable:repo-root", now);

        const materials = collectBriefMaterials(harness.store, since, now);

        expect(materials.archivedByEvidence).toEqual({ "not-observable:repo-root": 1 });
      });

      it("now より後（未来）に archived されたタスクは含めない", () => {
        const since = 1_000;
        const now = 2_000;
        makeArchivedWithEvidence(harness, "now以降", "not-observable:repo-root", now + 1);

        const materials = collectBriefMaterials(harness.store, since, now);

        expect(materials.archivedByEvidence).toEqual({});
      });

      it("(since, now] の範囲内で複数tick分のarchiveが正しく合算される（steward 30分間隔 × ブリーフ12時間間隔を想定）", () => {
        const since = 1_000;
        const now = 1_000 + 12 * 60 * 60;
        // steward の複数 tick に相当するタイムスタンプ（30分間隔）で archive されたタスクを複数用意する
        makeArchivedWithEvidence(harness, "tick1", "not-observable:repo-root", since + 30 * 60);
        makeArchivedWithEvidence(harness, "tick2", "not-observable:repo-root", since + 60 * 60);
        makeArchivedWithEvidence(harness, "tick3", "not-observable:repo-root", since + 90 * 60);
        makeArchivedWithEvidence(harness, "tick4-別evidence", "unobservable:probe-failed", since + 120 * 60);

        const materials = collectBriefMaterials(harness.store, since, now);

        // 同じ evidence を持つタスクが複数tickに渡って発生しても正しく合算される
        expect(materials.archivedByEvidence).toEqual({
          "not-observable:repo-root": 3,
          "unobservable:probe-failed": 1,
        });
      });
    });
  });
});
