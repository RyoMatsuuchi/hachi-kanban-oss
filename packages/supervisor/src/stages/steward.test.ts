// steward ステージのテスト（docs/contract.md §40）
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskInput } from "@hachi/testing";
import { acquireStewardStateLock } from "@hachi/core";
import type {
  EventRow,
  HachiConfig,
  KanbanStore,
  Logger,
  StageResult,
  StewardProposalRequestRow,
  TaskRow,
} from "@hachi/core";
import { FakeAdapter, setupHarness, type TestHarness } from "../test-support.js";
import {
  buildBoardSnapshot,
  createStewardStage,
  parseStewardOutput,
  reconcileDoneConsistencyProposals,
  readStewardState,
  scanDoneConsistency,
  writeStewardState,
  type StewardNotifyFn,
  type StewardSessionRunner,
  type StewardState,
} from "./steward.js";
import type { ArchiveIntegrationObservation } from "./steward-archive-integration.js";
import type { StewardArchiveIntegrationProbe } from "./steward-archive-integration-probe.js";
import { findLatestStewardPromoteProposalEventId } from "./telegram-nonce.js";

// --- テストヘルパー ---

/** セッション出力テキストを返す fake runner */
function fakeRunner(output: string): StewardSessionRunner {
  return { run: async () => output };
}

/** セッション起動で例外を投げる fake runner */
function failingRunner(error: Error): StewardSessionRunner {
  return {
    run: async () => {
      throw error;
    },
  };
}

/** 有効な hachi-steward-v1 フェンスを組み立てる */
function stewardFence(proposals: Array<{ kind: string; taskId: string; reason: string }>): string {
  return [
    "判断セッション結果:",
    "```hachi-steward-v1",
    JSON.stringify({ proposals }),
    "```",
  ].join("\n");
}

/** config に steward profile を追加する */
function addStewardProfile(config: HachiConfig): void {
  config.profiles["steward"] = {
    provider: "claude",
    model: "claude-sonnet-5",
    transport: "direct",
    effort: "medium",
  };
}

/** タスクを done 状態にする（triage → ready → blocked → done） */
function makeDone(harness: TestHarness, taskId: string): TaskRow {
  harness.store.transition({ taskId, to: "ready", actor: "tester" });
  harness.store.block(taskId, "codex-in-progress: テスト", "tester");
  return harness.store.transition({
    taskId,
    to: "done",
    actor: "tester",
    eventType: "finalized",
    payload: { outcome: "done", sessionId: "sess-steward-test" },
  });
}

function syntheticEvent(taskId: string, id: number, eventType: string, payload: Record<string, unknown>): EventRow {
  return {
    id,
    taskId,
    eventType,
    actor: "supervisor",
    payload: JSON.stringify(payload),
    provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
    createdAt: 100 + id,
  };
}

/** 特定taskの監査履歴だけをincident fixtureへ差し替え、mutationは実Storeへ委譲する。 */
function storeWithSyntheticTaskEvents(
  store: KanbanStore,
  taskId: string,
  synthetic: readonly EventRow[],
): KanbanStore {
  return new Proxy(store, {
    get(target, property): unknown {
      if (property === "listEvents") {
        return (queriedTaskId: string, eventType?: string, limit?: number): EventRow[] => {
          if (queriedTaskId !== taskId) {
            return target.listEvents(queriedTaskId, eventType, limit);
          }
          const durableProposals = target.listEvents(taskId, "steward_proposal");
          const combined = [...synthetic, ...durableProposals];
          const filtered = eventType === undefined
            ? combined
            : combined.filter((event) => event.eventType === eventType);
          return limit === undefined ? filtered : filtered.slice(-limit);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// --- テスト本体 ---

describe("steward", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
    vi.restoreAllMocks();
  });

  // ========================================================================
  // §40.1: cadence gating — intervalMinutes 未経過ならスキップ
  // ========================================================================
  describe("cadence gating（§40.1）", () => {
    it("intervalMinutes 未経過のときはセッションを起動しない", async () => {
      addStewardProfile(harness.deps.config);
      const runCalls: string[] = [];
      const runner: StewardSessionRunner = {
        run: async (prompt) => {
          runCalls.push(prompt);
          return stewardFence([]);
        },
      };

      const baseSec = 1_700_000_000;
      let currentSec = baseSec;
      const stage = createStewardStage({
        sessionRunner: runner,
        nowFn: () => currentSec,
      });

      // 初回実行（lastRunAt=0 なので実行される）
      const first = await stage.tick(harness.deps, true, currentSec);
      expect(runCalls).toHaveLength(1);
      expect(first.actions).toBe(0);

      // 10分後（既定 30分未経過）→ スキップ
      currentSec = baseSec + 10 * 60;
      const second = await stage.tick(harness.deps, true, currentSec);
      expect(runCalls).toHaveLength(1); // 追加呼び出しなし
      expect(second.notes?.some((n) => n.includes("cadence gating"))).toBe(true);
    });

    it("intervalMinutes 経過後はセッションを起動する", async () => {
      addStewardProfile(harness.deps.config);
      const runCalls: string[] = [];
      const runner: StewardSessionRunner = {
        run: async (prompt) => {
          runCalls.push(prompt);
          return stewardFence([]);
        },
      };

      const baseSec = 1_700_000_000;
      let currentSec = baseSec;
      const stage = createStewardStage({
        sessionRunner: runner,
        nowFn: () => currentSec,
      });

      // 初回
      await stage.tick(harness.deps, true, currentSec);
      expect(runCalls).toHaveLength(1);

      // 31分後（既定 30分を超過）→ 実行される
      currentSec = baseSec + 31 * 60;
      await stage.tick(harness.deps, true, currentSec);
      expect(runCalls).toHaveLength(2);
    });
  });

  // ========================================================================
  // §40.1: apply=false → dry-run（セッション未起動）
  // ========================================================================
  describe("dry-run（apply=false）", () => {
    it("apply=false ではセッションを起動せず dry-run ノートを返す", async () => {
      addStewardProfile(harness.deps.config);
      const runCalls: string[] = [];
      const runner: StewardSessionRunner = {
        run: async (prompt) => {
          runCalls.push(prompt);
          return stewardFence([]);
        },
      };
      const stage = createStewardStage({ sessionRunner: runner });

      const result = await stage.tick(harness.deps, false, Math.floor(Date.now() / 1000));

      expect(runCalls).toHaveLength(0);
      expect(result.actions).toBe(0);
      expect(result.notes?.some((n) => n.includes("dry-run"))).toBe(true);
    });
  });

  // ========================================================================
  // §40.1: production direct runner の fresh trusted workspace
  // ========================================================================
  describe("direct判断workspace（§40.1）", () => {
    function configureDirectAdapter(adapter: FakeAdapter): void {
      addStewardProfile(harness.deps.config);
      harness.deps.directAdapters = { claude: adapter };
      adapter.launchResponse = {
        provider: "claude",
        sessionId: "direct-steward-test",
        serverUrl: "direct",
        model: "claude-sonnet-5",
        modelDelivery: "native",
        effortDelivery: "native",
        startedAt: 1_700_000_000,
      };
      adapter.statusResponse = { state: "idle", resultCount: 1, lastActivityAt: null };
      adapter.transcriptResponse = stewardFence([]);
    }

    it("実行ごとに0700のfresh Git workspaceを使い、成功後に破棄する", async () => {
      const adapter = new FakeAdapter("claude");
      configureDirectAdapter(adapter);
      const observedWorkspaces: string[] = [];
      adapter.launchHook = () => {
        const call = adapter.launchCalls.at(-1);
        if (call === undefined) {
          throw new Error("launch call がありません");
        }
        observedWorkspaces.push(call.options.cwd);
        expect(existsSync(join(call.options.cwd, ".git"))).toBe(true);
        expect(statSync(call.options.cwd).mode & 0o777).toBe(0o700);
      };

      let currentSec = 1_700_000_000;
      const stage = createStewardStage({ nowFn: () => currentSec });
      await stage.tick(harness.deps, true, currentSec);
      currentSec += 31 * 60;
      await stage.tick(harness.deps, true, currentSec);

      expect(observedWorkspaces).toHaveLength(2);
      expect(new Set(observedWorkspaces).size).toBe(2);
      expect(observedWorkspaces.every((workspace) => !existsSync(workspace))).toBe(true);
      expect(adapter.launchCalls[0]?.task).toMatchObject({
        id: "steward",
        tenant: "system",
        profile: "steward",
        status: "blocked",
      });
    });

    it("adapter launch失敗でもworkspaceを破棄する", async () => {
      const adapter = new FakeAdapter("claude");
      configureDirectAdapter(adapter);
      let observedWorkspace = "";
      adapter.launchHook = () => {
        observedWorkspace = adapter.launchCalls.at(-1)?.options.cwd ?? "";
      };
      adapter.launchError = new Error("launch failed");

      const stage = createStewardStage();
      await stage.tick(harness.deps, true, 1_700_000_000);

      expect(observedWorkspace).not.toBe("");
      expect(existsSync(observedWorkspace)).toBe(false);
      expect(readStewardState(harness.home.home).lastError).toContain("launch failed");
    });

    it("adapter status失敗でもworkspaceを破棄する", async () => {
      const adapter = new FakeAdapter("claude");
      configureDirectAdapter(adapter);
      let observedWorkspace = "";
      adapter.launchHook = () => {
        observedWorkspace = adapter.launchCalls.at(-1)?.options.cwd ?? "";
      };
      adapter.statusError = new Error("status failed");

      const stage = createStewardStage();
      await stage.tick(harness.deps, true, 1_700_000_000);

      expect(adapter.stopCalls).toHaveLength(1);
      expect(observedWorkspace).not.toBe("");
      expect(existsSync(observedWorkspace)).toBe(false);
      expect(readStewardState(harness.home.home).lastError).toContain("status failed");
    });

    it("未完了sessionのstop失敗を記録しつつworkspaceを破棄する", async () => {
      const adapter = new FakeAdapter("claude");
      configureDirectAdapter(adapter);
      let observedWorkspace = "";
      adapter.launchHook = () => {
        observedWorkspace = adapter.launchCalls.at(-1)?.options.cwd ?? "";
      };
      adapter.statusError = new Error("status failed");
      adapter.stopError = new Error("stop failed");

      const stage = createStewardStage();
      await stage.tick(harness.deps, true, 1_700_000_000);

      expect(adapter.stopCalls).toHaveLength(1);
      expect(observedWorkspace).not.toBe("");
      expect(existsSync(observedWorkspace)).toBe(false);
      expect(readStewardState(harness.home.home).lastError).toContain("status failed");
    });

    it("stop capabilityが無いdirect adapterは起動前にfail-closedする", async () => {
      const adapter = new FakeAdapter("claude", { supportsStop: false });
      configureDirectAdapter(adapter);

      const stage = createStewardStage();
      await stage.tick(harness.deps, true, 1_700_000_000);

      expect(adapter.launchCalls).toHaveLength(0);
      expect(readStewardState(harness.home.home).lastError).toContain("stop capability 必須");
    });

    it("timeout後にstopしてworkspaceを破棄する", async () => {
      const adapter = new FakeAdapter("claude");
      configureDirectAdapter(adapter);
      adapter.statusResponse = { state: "active", lastActivityAt: null };
      let observedWorkspace = "";
      adapter.launchHook = () => {
        observedWorkspace = adapter.launchCalls.at(-1)?.options.cwd ?? "";
      };

      const stage = createStewardStage({ sessionTimeoutSec: 0, sessionPollIntervalMs: 1 });
      await stage.tick(harness.deps, true, 1_700_000_000);

      expect(adapter.stopCalls).toHaveLength(1);
      expect(observedWorkspace).not.toBe("");
      expect(existsSync(observedWorkspace)).toBe(false);
      expect(readStewardState(harness.home.home).lastError).toContain("timeout");
      // 契約 §34.2.1: 成功2値（terminated/killed）も reason を証拠として記録する（デフォルトの
      // stopResponse は stopped:true, reason:"terminated"）。stopped:false のときだけ記録すると
      // 成功経路の reason が欠落するため、成功経路でも記録されることをここで確認する。
      const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
      expect(log).toContain("未完了 direct session の停止が完了しました");
      expect(log).toContain('"reason":"terminated"');
    });

    it("timeout後のstopがunsignalableを返した場合は例外扱いにせず停止未確認をwarnしつつworkspaceを破棄する（契約 §34.2.1）", async () => {
      const adapter = new FakeAdapter("claude");
      configureDirectAdapter(adapter);
      adapter.statusResponse = { state: "active", lastActivityAt: null };
      adapter.stopResponse = { stopped: false, reason: "unsignalable" };
      let observedWorkspace = "";
      adapter.launchHook = () => {
        observedWorkspace = adapter.launchCalls.at(-1)?.options.cwd ?? "";
      };

      const stage = createStewardStage({ sessionTimeoutSec: 0, sessionPollIntervalMs: 1 });
      await stage.tick(harness.deps, true, 1_700_000_000);

      expect(adapter.stopCalls).toHaveLength(1);
      expect(observedWorkspace).not.toBe("");
      expect(existsSync(observedWorkspace)).toBe(false);
      expect(readStewardState(harness.home.home).lastError).toContain("timeout");
      const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
      expect(log).toContain("停止を確認できませんでした");
      expect(log).toContain('"reason":"unsignalable"');
    });
  });

  // ========================================================================
  // §40.1: kill-switch steward.disabled
  // ========================================================================
  describe("kill-switch（§40.1）", () => {
    it("steward.disabled が存在する場合はセッションを起動せず skipped=true を返す", async () => {
      addStewardProfile(harness.deps.config);
      writeFileSync(join(harness.home.home, "steward.disabled"), "", "utf8");
      const runCalls: string[] = [];
      const runner: StewardSessionRunner = {
        run: async (prompt) => {
          runCalls.push(prompt);
          return stewardFence([]);
        },
      };

      const stage = createStewardStage({ sessionRunner: runner });
      const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(runCalls).toHaveLength(0);
      expect(result.skipped).toBe(true);
      expect(result.notes?.some((n) => n.includes("steward.disabled"))).toBe(true);
    });
  });

  // ========================================================================
  // §40.1: profile 未定義 → skip + warn（fail-closed）
  // ========================================================================
  describe("profile 未定義チェック（§40.1）", () => {
    it("steward profile が未定義ならスキップして warn する", async () => {
      // DEFAULT_TEST_CONFIG には steward profile が含まれていない
      const warnings: string[] = [];
      const origLogger = harness.deps.logger;
      const logger: Logger = {
        info: origLogger.info.bind(origLogger),
        warn: (msg: string) => {
          warnings.push(msg);
        },
        error: origLogger.error.bind(origLogger),
        child: () => logger,
      };
      harness.deps.logger = logger;

      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([])),
      });

      const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(0);
      expect(result.notes?.some((n) => n.includes("steward profile が未定義"))).toBe(true);
      expect(warnings.some((w) => w.includes("profiles"))).toBe(true);
    });
  });

  // ========================================================================
  // §40.2: prompt redaction — redact 後に body 先頭を切り詰める
  // ========================================================================
  describe("board snapshot redaction（§40.2）", () => {
    it("body の切り詰め境界にかかる token 断片を prompt に出さない", () => {
      const prefix = `${"x".repeat(189)} `;
      harness.store.createTask(
        taskInput({
          title: "redaction",
          body: `${prefix}sk-abcdefghijklmnop 後続テキスト`,
        }),
        "tester",
      );

      const snapshot = buildBoardSnapshot(harness.store, Math.floor(Date.now() / 1000));

      expect(snapshot).not.toContain("sk-abcdefg");
      expect(snapshot).toContain("[REDACTED]");
    });
  });

  // ========================================================================
  // O3: done整合決定表 — recovery false positiveと真の矛盾を分離
  // ========================================================================
  describe("done整合判定（O3）", () => {
    it("実incident同型のlegacy host-finalizeはLLMの誤escalateを抑止し警告0にする", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(taskInput({ title: "incident recovery" }), "tester");
      harness.store.transition({ taskId: task.id, to: "ready", actor: "tester" });
      harness.store.block(task.id, "codex-in-progress: fixture", "supervisor");
      harness.store.addEvent(task.id, "handoff_rejected", "supervisor", {
        sessionId: "worker-old",
        reason: "placeholder_summary",
      });
      harness.store.addEvent(task.id, "handoff_evidence_failed", "supervisor", {
        sessionId: "worker-new",
        failures: [{ kind: "working-tree" }],
      });
      harness.store.transition({
        taskId: task.id,
        to: "done",
        actor: "human",
      });

      const prompts: string[] = [];
      const notifyCalls: string[] = [];
      const stage = createStewardStage({
        sessionRunner: {
          run: async (prompt) => {
            prompts.push(prompt);
            return stewardFence([{
              kind: "escalate",
              taskId: task.id,
              reason: "完了前に失敗eventがあるので矛盾",
            }]);
          },
        },
        notifyFn: async (taskId) => {
          notifyCalls.push(taskId);
        },
        nowFn: () => 1_700_000_000,
      });

      const result = await stage.tick(harness.deps, true, 1_700_000_000);

      expect(scanDoneConsistency(harness.store)[0]?.decision).toMatchObject({
        verdict: "consistent",
        origin: "unknown",
      });
      expect(reconcileDoneConsistencyProposals(harness.store, [{
        kind: "escalate",
        taskId: task.id,
        reason: "誤検知",
      }])).toEqual([]);
      expect(prompts[0]).toContain("done-consistency=consistent/consistent");
      expect(result.actions).toBe(0);
      expect(notifyCalls).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "steward_proposal")).toHaveLength(0);
    });

    it("異常doneへのLLM archive/escalate重複を一意のdeterministic escalateへ置換する", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(taskInput({ title: "evidence missing" }), "tester");
      harness.store.transition({ taskId: task.id, to: "ready", actor: "tester" });
      harness.store.block(task.id, "codex-in-progress: fixture", "tester");
      harness.store.transition({ taskId: task.id, to: "done", actor: "legacy" });
      harness.store.addEvent(task.id, "verdict_finalized", "legacy", {
        from: "review",
        to: "done",
        verdict: "pass",
        confidence: "low",
        sessionId: "broken-review-evidence",
      });
      const notifyCalls: Array<{ taskId: string; message: string }> = [];
      let currentSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "archive", taskId: task.id, reason: "異常doneをarchive" },
          { kind: "escalate", taskId: task.id, reason: "LLM矛盾1" },
          { kind: "escalate", taskId: task.id, reason: "LLM矛盾2" },
        ])),
        notifyFn: async (taskId, message) => {
          notifyCalls.push({ taskId, message });
        },
        nowFn: () => currentSec,
      });

      const first = await stage.tick(harness.deps, true, currentSec);
      currentSec += 31 * 60;
      const second = await stage.tick(harness.deps, true, currentSec);

      expect(first.actions).toBe(1);
      expect(second.actions).toBe(0);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "steward_auto_archive")).toHaveLength(0);
      expect(notifyCalls).toHaveLength(1);
      expect(notifyCalls[0]).toMatchObject({ taskId: task.id });
      expect(notifyCalls[0]?.message).toContain("done-consistency:evidence-missing");
      const events = harness.store.listEvents(task.id, "steward_proposal");
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
      expect(payload.kind).toBe("escalate");
      expect(payload.reason).toContain("done-consistency:evidence-missing");
    });

    it.each([
      ["impossible", "impossible-transition"],
      ["multiple", "evidence-missing"],
      ["stale-only", "stale-fence-only"],
    ] as const)("%s doneは一意通知・archive 0・24h dedupへ収束する", async (kind, expectedCode) => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(taskInput({ title: `${kind} done` }), "legacy");
      harness.store.transition({ taskId: task.id, to: "ready", actor: "legacy" });
      harness.store.block(task.id, "codex-in-progress: fixture", "legacy");
      harness.store.transition({ taskId: task.id, to: "done", actor: "legacy" });

      let store: KanbanStore = harness.store;
      if (kind === "impossible") {
        harness.store.addEvent(task.id, "status_changed", "legacy", { from: "ready", to: "done" });
      } else if (kind === "multiple") {
        harness.store.addEvent(task.id, "status_changed", "legacy", { from: "blocked", to: "done" });
      } else {
        store = storeWithSyntheticTaskEvents(harness.store, task.id, [
          syntheticEvent(task.id, 90, "stale_finalize_skipped", {
            sessionId: "worker-stale",
            phase: "handoff_success",
          }),
          syntheticEvent(task.id, 91, "stale_review_skipped", {
            sessionId: "review-stale",
            phase: "verdict_finalized",
          }),
          syntheticEvent(task.id, 92, "stale_max_runtime_skip", {
            taskId: task.id,
            sessionId: "worker-max-runtime-stale",
          }),
        ]);
      }

      const notifyCalls: Array<{ taskId: string; message: string }> = [];
      let currentSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "archive", taskId: task.id, reason: "LLM archive" },
          { kind: "escalate", taskId: task.id, reason: "LLM escalate 1" },
          { kind: "escalate", taskId: task.id, reason: "LLM escalate 2" },
        ])),
        notifyFn: async (taskId, message) => {
          notifyCalls.push({ taskId, message });
        },
        nowFn: () => currentSec,
      });
      const deps = { ...harness.deps, store };

      const first = await stage.tick(deps, true, currentSec);
      currentSec += 31 * 60;
      const second = await stage.tick(deps, true, currentSec);

      expect(first.actions).toBe(1);
      expect(second.actions).toBe(0);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "steward_auto_archive")).toHaveLength(0);
      expect(notifyCalls).toHaveLength(1);
      expect(notifyCalls[0]).toMatchObject({ taskId: task.id });
      expect(notifyCalls[0]?.message).toContain(`done-consistency:${expectedCode}`);
      const proposals = harness.store.listEvents(task.id, "steward_proposal");
      expect(proposals).toHaveLength(1);
      const payload = JSON.parse(proposals[0]!.payload) as Record<string, unknown>;
      expect(payload.reason).toContain(`done-consistency:${expectedCode}`);
    });

    it("現board同数のlegacy unknown origin 38件を通知stormへ変換しない", async () => {
      addStewardProfile(harness.deps.config);
      const taskIds: string[] = [];
      for (let index = 0; index < 38; index += 1) {
        const task = harness.store.createTask(taskInput({ title: `legacy done ${index}` }), "legacy");
        harness.store.transition({ taskId: task.id, to: "ready", actor: "legacy" });
        harness.store.block(task.id, "codex-in-progress: legacy fixture", "legacy");
        harness.store.transition({ taskId: task.id, to: "done", actor: "human" });
        taskIds.push(task.id);
      }
      const notifyCalls: string[] = [];
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([])),
        notifyFn: async (taskId) => {
          notifyCalls.push(taskId);
        },
        nowFn: () => 1_700_000_000,
      });

      const result = await stage.tick(harness.deps, true, 1_700_000_000);

      expect(scanDoneConsistency(harness.store)).toHaveLength(38);
      expect(scanDoneConsistency(harness.store).every((entry) => (
        entry.decision.verdict === "consistent" && entry.decision.origin === "unknown"
      ))).toBe(true);
      expect(result.actions).toBe(0);
      expect(notifyCalls).toHaveLength(0);
      expect(taskIds.flatMap((taskId) => harness.store.listEvents(taskId, "steward_proposal")))
        .toHaveLength(0);
    });

    it("LLM出力がparse不能でもfailure accountingを維持して真矛盾を通知する", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(taskInput({ title: "parse failure anomaly" }), "tester");
      harness.store.transition({ taskId: task.id, to: "ready", actor: "tester" });
      harness.store.block(task.id, "codex-in-progress: fixture", "tester");
      harness.store.transition({ taskId: task.id, to: "done", actor: "legacy" });
      harness.store.addEvent(task.id, "verdict_finalized", "legacy", { to: "done" });
      const notifyCalls: string[] = [];
      const stage = createStewardStage({
        sessionRunner: fakeRunner("フェンスなし出力"),
        notifyFn: async (taskId) => {
          notifyCalls.push(taskId);
        },
        nowFn: () => 1_700_000_000,
      });

      const result = await stage.tick(harness.deps, true, 1_700_000_000);
      const state = readStewardState(harness.home.home);

      expect(result.actions).toBe(1);
      expect(result.notes).toContain("steward: 出力パース不能");
      expect(state).toMatchObject({
        consecutiveFailures: 1,
        lastError: "出力パース不能",
        lastProposalCount: 1,
      });
      expect(notifyCalls).toEqual([task.id]);
      expect(harness.store.listEvents(task.id, "steward_proposal")).toHaveLength(1);
    });

    it("LLM session失敗でもfailure accountingを維持して真矛盾を通知する", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(taskInput({ title: "session failure anomaly" }), "tester");
      harness.store.transition({ taskId: task.id, to: "ready", actor: "tester" });
      harness.store.block(task.id, "codex-in-progress: fixture", "tester");
      harness.store.transition({ taskId: task.id, to: "done", actor: "legacy" });
      harness.store.addEvent(task.id, "verdict_finalized", "legacy", { to: "done" });
      const notifyCalls: string[] = [];
      const stage = createStewardStage({
        sessionRunner: failingRunner(new Error("session timeout")),
        notifyFn: async (taskId) => {
          notifyCalls.push(taskId);
        },
        nowFn: () => 1_700_000_000,
      });

      const result = await stage.tick(harness.deps, true, 1_700_000_000);
      const state = readStewardState(harness.home.home);

      expect(result.actions).toBe(1);
      expect(state).toMatchObject({
        consecutiveFailures: 1,
        lastError: "session timeout",
        lastProposalCount: 1,
      });
      expect(notifyCalls).toEqual([task.id]);
      expect(harness.store.listEvents(task.id, "steward_proposal")).toHaveLength(1);
    });
  });

  // ========================================================================
  // §40.3: 出力パース — 不正 kind / 不明 taskId は破棄 + warn
  // ========================================================================
  describe("parseStewardOutput（§40.3）", () => {
    it("有効な提案を正しくパースする", () => {
      const task = harness.store.createTask(taskInput({ title: "パース対象" }), "tester");
      const output = stewardFence([
        { kind: "archive", taskId: task.id, reason: "完了済み" },
      ]);

      const proposals = parseStewardOutput(output, harness.store, harness.deps.logger);

      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({
        kind: "archive",
        taskId: task.id,
        reason: "完了済み",
      });
    });

    it("不明な taskId は破棄して warn する", () => {
      const warnings: string[] = [];
      const logger: Logger = {
        info: () => {},
        warn: (msg: string) => {
          warnings.push(msg);
        },
        error: () => {},
        child() {
          return logger;
        },
      };
      const output = stewardFence([
        { kind: "promote", taskId: "t_nonexistent", reason: "仕様十分" },
      ]);

      const proposals = parseStewardOutput(output, harness.store, logger);

      expect(proposals).toHaveLength(0);
      expect(warnings.some((w) => w.includes("不明な taskId"))).toBe(true);
    });

    it("不正な kind は該当 proposal だけを破棄する", () => {
      const warnings: string[] = [];
      const logger: Logger = {
        info: () => {},
        warn: (msg: string) => {
          warnings.push(msg);
        },
        error: () => {},
        child() {
          return logger;
        },
      };
      const task = harness.store.createTask(taskInput({ title: "パース対象" }), "tester");
      const output = [
        "```hachi-steward-v1",
        JSON.stringify({
          proposals: [
            { kind: "invalid-kind", taskId: task.id, reason: "不正" },
            { kind: "promote", taskId: task.id, reason: "有効" },
          ],
        }),
        "```",
      ].join("\n");

      const proposals = parseStewardOutput(output, harness.store, logger);

      expect(proposals).toHaveLength(1);
      expect(proposals[0]?.kind).toBe("promote");
      expect(warnings.some((w) => w.includes("不正な proposal"))).toBe(true);
    });

    it("フェンスが見つからない場合は空配列 + warn", () => {
      const warnings: string[] = [];
      const logger: Logger = {
        info: () => {},
        warn: (msg: string) => {
          warnings.push(msg);
        },
        error: () => {},
        child() {
          return logger;
        },
      };

      const proposals = parseStewardOutput("フェンスなし出力", harness.store, logger);

      expect(proposals).toHaveLength(0);
      expect(warnings.some((w) => w.includes("フェンスが見つかりません"))).toBe(true);
    });

    it("有効な提案と不明 taskId が混在する場合、有効なものだけ返す", () => {
      const task = harness.store.createTask(taskInput({ title: "有効タスク" }), "tester");
      const output = stewardFence([
        { kind: "archive", taskId: task.id, reason: "有効" },
        { kind: "promote", taskId: "t_ghost", reason: "不明" },
      ]);

      const proposals = parseStewardOutput(output, harness.store, harness.deps.logger);

      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.taskId).toBe(task.id);
    });
  });

  // ========================================================================
  // §40.1 / §40.2: 既定 direct runner
  // ========================================================================
  describe("direct runner（§40.1, §40.2）", () => {
    it("sessionRunner 未注入時は steward profile を resolveModel し direct adapter で短命起動する", async () => {
      addStewardProfile(harness.deps.config);
      const baseSec = 1_700_000_000;
      const task = harness.store.createTask(taskInput({ title: "スナップショット対象" }), "tester");
      const fakeDirect = new FakeAdapter("claude");
      fakeDirect.launchResponse = {
        provider: "claude",
        sessionId: "direct-steward",
        serverUrl: "direct",
        model: "claude-sonnet-5",
        modelDelivery: "native",
        effortDelivery: "native",
        startedAt: baseSec,
      };
      fakeDirect.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      fakeDirect.transcriptResponse = stewardFence([
        { kind: "promote", taskId: task.id, reason: "仕様十分" },
      ]);
      harness.deps.directAdapters = { claude: fakeDirect };

      const stage = createStewardStage({ nowFn: () => baseSec });
      const result = await stage.tick(harness.deps, true, baseSec);

      expect(result.actions).toBe(1);
      expect(fakeDirect.launchCalls).toHaveLength(1);
      expect(fakeDirect.launchCalls[0]?.task.profile).toBe("steward");
      const launchedOptions = fakeDirect.launchCalls[0]?.options;
      if (launchedOptions === undefined) {
        throw new Error("Steward launch options がありません");
      }
      expect(launchedOptions).toMatchObject({
        model: "claude-sonnet-5",
        effort: "medium",
      });
      expect(launchedOptions.cwd).not.toBe(harness.deps.env.home);
      expect(existsSync(launchedOptions.cwd)).toBe(false);
      expect(launchedOptions.promptText).toContain("hachi-steward-v1");
      expect(launchedOptions.promptText).toContain("スナップショット対象");
      expect(fakeDirect.statusCalls).toHaveLength(1);
      expect(fakeDirect.transcriptCalls).toHaveLength(1);
    });
  });

  // ========================================================================
  // §40.4: archive × done → 自動適用（steward_auto_archive）
  // ========================================================================
  describe("自動適用: archive × done（§40.4）", () => {
    it("status=done のタスクに archive 提案 → archived に自動遷移 + steward_auto_archive イベント", async () => {
      addStewardProfile(harness.deps.config);

      const task = harness.store.createTask(taskInput({ title: "完了タスク" }), "tester");
      makeDone(harness, task.id);

      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "archive", taskId: task.id, reason: "完了済み" }]),
        ),
        nowFn: () => Math.floor(Date.now() / 1000),
      });

      const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      // 自動適用されたので actions >= 1
      expect(result.actions).toBeGreaterThanOrEqual(1);
      expect(result.notes?.some((n) => n.includes("steward_auto_archive"))).toBe(true);

      // タスクが archived になっている
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("archived");

      // steward_auto_archive イベントが記録されている
      const events = harness.store.listEvents(task.id, "steward_auto_archive");
      expect(events).toHaveLength(1);
    });

    it("status!=done のタスクに archive 提案 → コメント + steward_proposal イベント（自動遷移しない）", async () => {
      addStewardProfile(harness.deps.config);

      // triage 状態のタスク
      const task = harness.store.createTask(taskInput({ title: "未完了タスク" }), "tester");

      const notifyCalls: Array<{ taskId: string; message: string; kind: string }> = [];
      const notifyFn: StewardNotifyFn = async (taskId, message, kind) => {
        notifyCalls.push({ taskId, message, kind });
      };

      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "archive", taskId: task.id, reason: "不要タスク" }]),
        ),
        nowFn: () => Math.floor(Date.now() / 1000),
        notifyFn,
      });

      const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBeGreaterThanOrEqual(1);

      // タスクは triage のまま（自動遷移されていない）
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("triage");

      // steward_proposal イベントが記録されている
      const events = harness.store.listEvents(task.id, "steward_proposal");
      expect(events).toHaveLength(1);

      // コメントが追加されている
      const comments = harness.store.listComments(task.id);
      expect(comments.some((c) => c.body.includes("[steward 提案] archive"))).toBe(true);

      // notify 経路へ kind=archive が伝搬している
      expect(notifyCalls).toHaveLength(1);
      expect(notifyCalls[0]).toMatchObject({ taskId: task.id, kind: "archive" });
    });

    describe("orchestrator mission の除外", () => {
      function addWatch(
        taskId: string,
        scope: "task" | "subtree" | "worktree",
        active = true,
      ): void {
        const orchestrator = harness.store.registerOrchestrator({
          label: `mission-${scope}-${taskId}`,
          project: "hachi",
          repoCommonDir: harness.home.home,
        });
        const watch = harness.store.addOrchestratorWatch({
          orchestratorId: orchestrator.id,
          scope,
          selector: taskId,
          role: "primary",
        });
        if (!active) {
          harness.store.setOrchestratorWatchActive(watch.id, false);
        }
      }

      async function proposeArchive(taskId: string): Promise<StageResult> {
        addStewardProfile(harness.deps.config);
        const nowSec = 1_700_000_000;
        const stage = createStewardStage({
          sessionRunner: fakeRunner(
            stewardFence([{ kind: "archive", taskId, reason: "完了済み" }]),
          ),
          nowFn: () => nowSec,
        });
        return stage.tick(harness.deps, true, nowSec);
      }

      it("active な subtree watch の selector は auto-archive しない", async () => {
        const task = harness.store.createTask(taskInput({ title: "active mission" }), "tester");
        makeDone(harness, task.id);
        addWatch(task.id, "subtree");

        const result = await proposeArchive(task.id);

        expect(harness.store.getTask(task.id)?.status).toBe("done");
        expect(harness.store.listEvents(task.id, "steward_auto_archive")).toHaveLength(0);
        expect(result.notes).toContain(
          `${task.id}: archive 提案は active な subtree watch の selector のため抑制しました`,
        );
      });

      it("inactive な subtree watch の selector は従来どおり auto-archive する", async () => {
        const task = harness.store.createTask(taskInput({ title: "inactive mission" }), "tester");
        makeDone(harness, task.id);
        addWatch(task.id, "subtree", false);

        await proposeArchive(task.id);

        expect(harness.store.getTask(task.id)?.status).toBe("archived");
        expect(harness.store.listEvents(task.id, "steward_auto_archive")).toHaveLength(1);
      });

      it.each(["task", "worktree"] as const)(
        "%s scope の watch selector は従来どおり auto-archive する",
        async (scope) => {
          const task = harness.store.createTask(taskInput({ title: `${scope} watch` }), "tester");
          makeDone(harness, task.id);
          addWatch(task.id, scope);

          await proposeArchive(task.id);

          expect(harness.store.getTask(task.id)?.status).toBe("archived");
          expect(harness.store.listEvents(task.id, "steward_auto_archive")).toHaveLength(1);
        },
      );

      it("watch が無い task は従来どおり auto-archive する", async () => {
        const task = harness.store.createTask(taskInput({ title: "no watch" }), "tester");
        makeDone(harness, task.id);

        await proposeArchive(task.id);

        expect(harness.store.getTask(task.id)?.status).toBe("archived");
        expect(harness.store.listEvents(task.id, "steward_auto_archive")).toHaveLength(1);
      });
    });
  });

  // ========================================================================
  // §74: auto-archive の統合観測ゲート
  // ========================================================================
  describe("archive integration gate（§74）", () => {
    /** worktree が dirty（統合先へは未統合）という観測を返す固定 probe */
    function dirtyWorktreeProbe(ref: string, oid: string): StewardArchiveIntegrationProbe {
      return {
        observe: async () => ({
          cwd: { kind: "worktree-present" },
          integrationTarget: { state: "resolved", ref, oid },
          integrationProof: { kind: "dirty" },
          drift: false,
        }),
      };
    }

    it("worktree が dirty なら archive を見送り、steward_auto_archive_vetoed イベントを記録する（§74.2 行9）", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(
        taskInput({ title: "dirty worktree タスク", body: "cwd: /work/dirty-task" }),
        "tester",
      );
      makeDone(harness, task.id);

      const ref = "refs/remotes/origin/main";
      const oid = "a".repeat(40);
      const gatedDeps = { ...harness.deps, stewardArchiveIntegrationProbe: dirtyWorktreeProbe(ref, oid) };

      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "archive", taskId: task.id, reason: "完了済み" }]),
        ),
        nowFn: () => nowSec,
      });

      await stage.tick(gatedDeps, true, nowSec);

      // archived に遷移していない（veto された）
      expect(harness.store.getTask(task.id)?.status).toBe("done");

      // steward_auto_archive は記録されない
      expect(harness.store.listEvents(task.id, "steward_auto_archive")).toHaveLength(0);

      // steward_auto_archive_vetoed が integrationEvidence / integrationTarget 付きで記録される
      const vetoEvents = harness.store.listEvents(task.id, "steward_auto_archive_vetoed");
      expect(vetoEvents).toHaveLength(1);
      const payload = JSON.parse(vetoEvents[0]!.payload) as Record<string, unknown>;
      expect(payload.integrationEvidence).toBe("unintegrated:worktree-dirty");
      expect(payload.integrationTarget).toEqual({ state: "resolved", ref, oid });
    });

    /**
     * F1: Step A の pre-scan（archiveGatedTaskIds 構築）は「どのタスクを Step C の gate へ回すか」の
     * 順序制御に過ぎない。他プロセスとの並行書き込み等で、Step A 時点ではまだ done でなかった
     * タスクが Step B 到達時には done に変わっている、というレースが理論上あり得る。
     * その場合 processProposal() のフォールバック分岐（kind==="archive" && status==="done"）に
     * 到達するが、F1 修正前はここで直接 archived へ遷移しゲートを迂回していた（fail-open）。
     * store.getTask() をラップし、Step A の判定にだけ「done でない」stale な値を返すことで
     * このレースを再現し、フォールバック経路でも probe が呼ばれ veto されることを確認する。
     */
    it("Step A/B間のレースでフォールバック分岐に入っても統合観測ゲートを経由し、直接archived遷移しない（F1）", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(
        taskInput({ title: "race フォールバックタスク", body: "cwd: /work/race-fallback" }),
        "tester",
      );
      makeDone(harness, task.id);

      // 呼び出し順: 1回目 = parseStewardOutput の存在確認（status不問）、
      // 2回目 = Step A の pre-scan（ここだけ stale な非done値を返す）、
      // 3回目以降 = processProposal 内の取得（実値の done を返す）。
      let getTaskCalls = 0;
      const racyStore = new Proxy(harness.store, {
        get(target, property, receiver): unknown {
          if (property === "getTask") {
            return (queriedTaskId: string): TaskRow | null => {
              const real = target.getTask(queriedTaskId);
              if (queriedTaskId === task.id && real !== null) {
                getTaskCalls += 1;
                if (getTaskCalls === 2) {
                  return { ...real, status: "ready" };
                }
              }
              return real;
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      let probeCalls = 0;
      const probe: StewardArchiveIntegrationProbe = {
        observe: async () => {
          probeCalls += 1;
          return {
            cwd: { kind: "worktree-present" },
            integrationTarget: { state: "resolved", ref: "refs/remotes/origin/main", oid: "c".repeat(40) },
            integrationProof: { kind: "dirty" },
            drift: false,
          };
        },
      };
      const gatedDeps = { ...harness.deps, store: racyStore, stewardArchiveIntegrationProbe: probe };

      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "archive", taskId: task.id, reason: "完了済み" }]),
        ),
        nowFn: () => nowSec,
      });

      await stage.tick(gatedDeps, true, nowSec);

      // Step A が gate 対象外と誤認したこと自体は前提条件（このレースが再現できたことの確認）
      expect(getTaskCalls).toBeGreaterThanOrEqual(2);
      // フォールバック分岐でも probe が実際に呼ばれ、ゲートを迂回していないこと
      expect(probeCalls).toBeGreaterThan(0);
      // dirty veto のため archived へ直接遷移していないこと（実データを直接確認する）
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "steward_auto_archive")).toHaveLength(0);
      const vetoEvents = harness.store.listEvents(task.id, "steward_auto_archive_vetoed");
      expect(vetoEvents).toHaveLength(1);
      const payload = JSON.parse(vetoEvents[0]!.payload) as Record<string, unknown>;
      expect(payload.integrationEvidence).toBe("unintegrated:worktree-dirty");
    });

    it("cwd: 行が無い done タスクは veto され、integrationTarget が state:unresolved で架空のref/OIDを持たない（§74.4）", async () => {
      addStewardProfile(harness.deps.config);
      // body に cwd: 行を含めない（taskInput の既定 body は空文字）
      const task = harness.store.createTask(taskInput({ title: "cwd無しタスク" }), "tester");
      makeDone(harness, task.id);

      // harness の既定 fake probe は常に allow（repo-root）を返すため、no-cwd を明示的に注入する
      const probe: StewardArchiveIntegrationProbe = {
        observe: async () => ({ cwd: { kind: "no-cwd" }, drift: false }),
      };
      const gatedDeps = { ...harness.deps, stewardArchiveIntegrationProbe: probe };

      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "archive", taskId: task.id, reason: "完了済み" }]),
        ),
        nowFn: () => nowSec,
      });

      await stage.tick(gatedDeps, true, nowSec);

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      const vetoEvents = harness.store.listEvents(task.id, "steward_auto_archive_vetoed");
      expect(vetoEvents).toHaveLength(1);
      const payload = JSON.parse(vetoEvents[0]!.payload) as Record<string, unknown>;
      expect(payload.integrationEvidence).toBe("unobservable:no-cwd");
      expect(payload.integrationTarget).toEqual({
        state: "unresolved",
        reason: "cwd 正規化の結果、統合先 ref の評価に到達しなかった",
      });
    });

    it("統合先 ref を1つも解決できない場合は veto され、integrationTarget が state:unresolved で架空のref/OIDを持たない（§74.4）", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(
        taskInput({ title: "統合先ref解決不能タスク", body: "cwd: /work/no-integration-ref" }),
        "tester",
      );
      makeDone(harness, task.id);

      const probe: StewardArchiveIntegrationProbe = {
        observe: async () => ({
          cwd: { kind: "worktree-present" },
          integrationTarget: { state: "unresolved" },
          drift: false,
        }),
      };
      const gatedDeps = { ...harness.deps, stewardArchiveIntegrationProbe: probe };

      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "archive", taskId: task.id, reason: "完了済み" }]),
        ),
        nowFn: () => nowSec,
      });

      await stage.tick(gatedDeps, true, nowSec);

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      const vetoEvents = harness.store.listEvents(task.id, "steward_auto_archive_vetoed");
      expect(vetoEvents).toHaveLength(1);
      const payload = JSON.parse(vetoEvents[0]!.payload) as Record<string, unknown>;
      expect(payload.integrationEvidence).toBe("unobservable:no-integration-ref");
      expect(payload.integrationTarget).toEqual({
        state: "unresolved",
        reason: "worktree はあるが統合先 ref を1つも解決できなかった",
      });
    });

    it("board 可視の reason は integrationEvidence から機械生成し、LLM の矛盾する自由文を出さない（§74.3）", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(
        taskInput({ title: "reason 機械化タスク", body: "cwd: /work/clean-task" }),
        "tester",
      );
      makeDone(harness, task.id);

      const probe: StewardArchiveIntegrationProbe = {
        observe: async () => ({
          cwd: { kind: "worktree-present" },
          integrationTarget: { state: "resolved", ref: "refs/remotes/origin/main", oid: "b".repeat(40) },
          integrationProof: { kind: "clean", proof: "ancestor" },
          drift: false,
        }),
      };
      const gatedDeps = { ...harness.deps, stewardArchiveIntegrationProbe: probe };

      // 判断セッションの自由文は「統合済み」を主張しているが、board へはそのまま出してはならない
      const misleadingReason = "全て統合済みです。マージも完了しています";
      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "archive", taskId: task.id, reason: misleadingReason }]),
        ),
        nowFn: () => nowSec,
      });

      await stage.tick(gatedDeps, true, nowSec);

      expect(harness.store.getTask(task.id)?.status).toBe("archived");

      const events = harness.store.listEvents(task.id, "steward_auto_archive");
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
      expect(payload.integrationEvidence).toBe("clean-head-reachable");
      // LLM の自由文は proposalReason へ退避されるだけで、board 可視の reason には出ない
      expect(payload.proposalReason).toBe(misleadingReason);
      expect(payload.reason).not.toBe(misleadingReason);
      expect(payload.reason).not.toContain("統合済み");
      expect(payload.reason).toContain("証明ではありません");
    });

    it("archive 提案が veto されたら、同 tick の他提案（archive→promote順）も保留する（§74.4）", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(
        taskInput({ title: "mutation holding タスク A", body: "cwd: /work/holding-a" }),
        "tester",
      );
      makeDone(harness, task.id);

      const gatedDeps = {
        ...harness.deps,
        stewardArchiveIntegrationProbe: dirtyWorktreeProbe("refs/remotes/origin/main", "e".repeat(40)),
      };

      const notifyCalls: Array<{ taskId: string; kind: string }> = [];
      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([
            { kind: "archive", taskId: task.id, reason: "完了済み" },
            { kind: "promote", taskId: task.id, reason: "ready 化候補" },
          ]),
        ),
        nowFn: () => nowSec,
        notifyFn: async (taskId, _message, kind) => {
          notifyCalls.push({ taskId, kind });
        },
      });

      await stage.tick(gatedDeps, true, nowSec);

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "steward_auto_archive_vetoed")).toHaveLength(1);
      // promote 側は一切処理されていない（コメント・イベント・通知いずれも無し）
      expect(harness.store.listEvents(task.id, "steward_proposal")).toHaveLength(0);
      const comments = harness.store.listComments(task.id);
      expect(comments.some((c) => c.body.includes("[steward 提案] promote"))).toBe(false);
      // veto 自体はF6により通知される。promote 側は保留されているため通知は無い
      expect(notifyCalls).toEqual([{ taskId: task.id, kind: "archive-vetoed" }]);
    });

    it("archive 提案が veto されたら、同 tick の他提案（promote→archive順）も保留する（§74.4）", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(
        taskInput({ title: "mutation holding タスク B", body: "cwd: /work/holding-b" }),
        "tester",
      );
      makeDone(harness, task.id);

      const gatedDeps = {
        ...harness.deps,
        stewardArchiveIntegrationProbe: dirtyWorktreeProbe("refs/remotes/origin/main", "f".repeat(40)),
      };

      const notifyCalls: Array<{ taskId: string; kind: string }> = [];
      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([
            { kind: "promote", taskId: task.id, reason: "ready 化候補" },
            { kind: "archive", taskId: task.id, reason: "完了済み" },
          ]),
        ),
        nowFn: () => nowSec,
        notifyFn: async (taskId, _message, kind) => {
          notifyCalls.push({ taskId, kind });
        },
      });

      await stage.tick(gatedDeps, true, nowSec);

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "steward_auto_archive_vetoed")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "steward_proposal")).toHaveLength(0);
      const comments = harness.store.listComments(task.id);
      expect(comments.some((c) => c.body.includes("[steward 提案] promote"))).toBe(false);
      // veto 自体はF6により通知される。promote 側は保留されているため通知は無い
      expect(notifyCalls).toEqual([{ taskId: task.id, kind: "archive-vetoed" }]);
    });

    it("適用直前の観測でdriftを検出したら行13(observation-drift)としてvetoし、同tickの他提案（promote）も保留する（§74.4 再観測）", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(
        taskInput({ title: "drift検出タスク", body: "cwd: /work/drift-task" }),
        "tester",
      );
      makeDone(harness, task.id);

      // cwd/統合先/porcelainは一見cleanに見えるが drift:true → 他フィールドを無視して行13へ倒れる
      const probe: StewardArchiveIntegrationProbe = {
        observe: async () => ({
          cwd: { kind: "worktree-present" },
          integrationTarget: { state: "resolved", ref: "refs/remotes/origin/main", oid: "2".repeat(40) },
          integrationProof: { kind: "clean", proof: "ancestor" },
          drift: true,
        }),
      };
      const gatedDeps = { ...harness.deps, stewardArchiveIntegrationProbe: probe };

      const notifyCalls: Array<{ taskId: string; kind: string }> = [];
      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([
            { kind: "archive", taskId: task.id, reason: "完了済み" },
            { kind: "promote", taskId: task.id, reason: "ready 化候補" },
          ]),
        ),
        nowFn: () => nowSec,
        notifyFn: async (taskId, _message, kind) => {
          notifyCalls.push({ taskId, kind });
        },
      });

      await stage.tick(gatedDeps, true, nowSec);

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      const vetoEvents = harness.store.listEvents(task.id, "steward_auto_archive_vetoed");
      expect(vetoEvents).toHaveLength(1);
      const payload = JSON.parse(vetoEvents[0]!.payload) as Record<string, unknown>;
      expect(payload.integrationEvidence).toBe("unobservable:observation-drift");
      // promote 側は一切処理されていない（コメント・イベント・通知いずれも無し）
      expect(harness.store.listEvents(task.id, "steward_proposal")).toHaveLength(0);
      const comments = harness.store.listComments(task.id);
      expect(comments.some((c) => c.body.includes("[steward 提案] promote"))).toBe(false);
      // veto 自体はF6により通知される。promote 側は保留されているため通知は無い
      expect(notifyCalls).toEqual([{ taskId: task.id, kind: "archive-vetoed" }]);
    });

    it("適用直前の観測でdriftを検出したら行13(observation-drift)としてvetoし、同tickの他提案（spec-lint）も保留する（§74.4 再観測）", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(
        taskInput({ title: "drift検出タスク（spec-lint併存）", body: "cwd: /work/drift-task-spec-lint" }),
        "tester",
      );
      makeDone(harness, task.id);

      const probe: StewardArchiveIntegrationProbe = {
        observe: async () => ({
          cwd: { kind: "worktree-present" },
          integrationTarget: { state: "resolved", ref: "refs/remotes/origin/main", oid: "3".repeat(40) },
          integrationProof: { kind: "clean", proof: "ancestor" },
          drift: true,
        }),
      };
      const gatedDeps = { ...harness.deps, stewardArchiveIntegrationProbe: probe };

      const notifyCalls: Array<{ taskId: string; kind: string }> = [];
      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([
            { kind: "archive", taskId: task.id, reason: "完了済み" },
            { kind: "spec-lint", taskId: task.id, reason: "仕様不足" },
          ]),
        ),
        nowFn: () => nowSec,
        notifyFn: async (taskId, _message, kind) => {
          notifyCalls.push({ taskId, kind });
        },
      });

      await stage.tick(gatedDeps, true, nowSec);

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      const vetoEvents = harness.store.listEvents(task.id, "steward_auto_archive_vetoed");
      expect(vetoEvents).toHaveLength(1);
      const payload = JSON.parse(vetoEvents[0]!.payload) as Record<string, unknown>;
      expect(payload.integrationEvidence).toBe("unobservable:observation-drift");
      // spec-lint 側は一切処理されていない（指摘コメント・通知いずれも無し）
      const comments = harness.store.listComments(task.id);
      expect(comments.some((c) => c.body.includes("[steward 指摘] spec-lint:"))).toBe(false);
      // veto 自体はF6により通知される。spec-lint 側は保留されているため通知は無い
      expect(notifyCalls).toEqual([{ taskId: task.id, kind: "archive-vetoed" }]);
    });

    it("veto は同一 (taskId, integrationEvidence) を24h窓で1回だけ記録するが、gate評価自体は毎tick必ず実行する（§74.4）", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(
        taskInput({ title: "veto 冪等タスク", body: "cwd: /work/veto-idempotent" }),
        "tester",
      );
      makeDone(harness, task.id);

      let observeCallCount = 0;
      let currentObservation: ArchiveIntegrationObservation = {
        cwd: { kind: "worktree-present" },
        integrationTarget: { state: "resolved", ref: "refs/remotes/origin/main", oid: "c".repeat(40) },
        integrationProof: { kind: "dirty" },
        drift: false,
      };
      const probe: StewardArchiveIntegrationProbe = {
        observe: async () => {
          observeCallCount += 1;
          return currentObservation;
        },
      };
      const gatedDeps = { ...harness.deps, stewardArchiveIntegrationProbe: probe };

      const baseSec = 1_700_000_000;
      const stage1 = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "archive", taskId: task.id, reason: "完了済み" }]),
        ),
        nowFn: () => baseSec,
      });
      await stage1.tick(gatedDeps, true, baseSec);
      expect(observeCallCount).toBe(1);
      expect(harness.store.listEvents(task.id, "steward_auto_archive_vetoed")).toHaveLength(1);

      // 31分後（cadence gating 通過）・evidence 不変 → probe は毎tick呼ばれるが、イベントは重複記録しない
      const secondSec = baseSec + 31 * 60;
      const stage2 = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "archive", taskId: task.id, reason: "完了済み" }]),
        ),
        nowFn: () => secondSec,
      });
      await stage2.tick(gatedDeps, true, secondSec);
      expect(observeCallCount).toBe(2);
      expect(harness.store.listEvents(task.id, "steward_auto_archive_vetoed")).toHaveLength(1);

      // evidence が変化（worktree-dirty → branch-commits-not-in-main）→ 24h以内でも新規イベントを記録する
      currentObservation = {
        cwd: { kind: "worktree-present" },
        integrationTarget: { state: "resolved", ref: "refs/remotes/origin/main", oid: "c".repeat(40) },
        integrationProof: { kind: "clean", proof: "none" },
        drift: false,
      };
      const thirdSec = secondSec + 31 * 60;
      const stage3 = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "archive", taskId: task.id, reason: "完了済み" }]),
        ),
        nowFn: () => thirdSec,
      });
      await stage3.tick(gatedDeps, true, thirdSec);
      expect(observeCallCount).toBe(3);
      const vetoEvents = harness.store.listEvents(task.id, "steward_auto_archive_vetoed");
      expect(vetoEvents).toHaveLength(2);
      const evidences = vetoEvents.map(
        (e) => (JSON.parse(e.payload) as Record<string, unknown>).integrationEvidence,
      );
      expect(evidences).toEqual([
        "unintegrated:worktree-dirty",
        "unintegrated:branch-commits-not-in-main",
      ]);
    });

    it("veto通知は同一 (taskId, integrationEvidence) を24h窓で1回だけ送るが、evidenceが変われば窓内でも再送する（§74.4, F6）", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(
        taskInput({ title: "veto通知冪等タスク", body: "cwd: /work/veto-notify-idempotent" }),
        "tester",
      );
      makeDone(harness, task.id);

      let currentObservation: ArchiveIntegrationObservation = {
        cwd: { kind: "worktree-present" },
        integrationTarget: { state: "resolved", ref: "refs/remotes/origin/main", oid: "d".repeat(40) },
        integrationProof: { kind: "dirty" },
        drift: false,
      };
      const probe: StewardArchiveIntegrationProbe = {
        observe: async () => currentObservation,
      };
      const gatedDeps = { ...harness.deps, stewardArchiveIntegrationProbe: probe };

      const notifyCalls: Array<{ taskId: string; kind: string }> = [];
      const notifyFn = async (taskId: string, _message: string, kind: string): Promise<void> => {
        notifyCalls.push({ taskId, kind });
      };

      const baseSec = 1_700_000_000;
      const stage1 = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "archive", taskId: task.id, reason: "完了済み" }]),
        ),
        nowFn: () => baseSec,
        notifyFn,
      });
      await stage1.tick(gatedDeps, true, baseSec);
      expect(harness.store.listEvents(task.id, "steward_auto_archive_vetoed")).toHaveLength(1);
      expect(notifyCalls).toEqual([{ taskId: task.id, kind: "archive-vetoed" }]);

      // 31分後（cadence gating 通過・24h以内）・evidence 不変 → gate評価もイベントも通る仕様だが、
      // 通知はイベントと同じ (taskId, integrationEvidence) 24h窓で1回に畳まれるため再送しない
      const secondSec = baseSec + 31 * 60;
      const stage2 = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "archive", taskId: task.id, reason: "完了済み" }]),
        ),
        nowFn: () => secondSec,
        notifyFn,
      });
      await stage2.tick(gatedDeps, true, secondSec);
      expect(harness.store.listEvents(task.id, "steward_auto_archive_vetoed")).toHaveLength(1);
      expect(notifyCalls).toEqual([{ taskId: task.id, kind: "archive-vetoed" }]);

      // evidence が変化（worktree-dirty → branch-commits-not-in-main）→ 24h以内でも新規イベント・新規通知を出す
      currentObservation = {
        cwd: { kind: "worktree-present" },
        integrationTarget: { state: "resolved", ref: "refs/remotes/origin/main", oid: "d".repeat(40) },
        integrationProof: { kind: "clean", proof: "none" },
        drift: false,
      };
      const thirdSec = secondSec + 31 * 60;
      const stage3 = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "archive", taskId: task.id, reason: "完了済み" }]),
        ),
        nowFn: () => thirdSec,
        notifyFn,
      });
      await stage3.tick(gatedDeps, true, thirdSec);
      expect(harness.store.listEvents(task.id, "steward_auto_archive_vetoed")).toHaveLength(2);
      expect(notifyCalls).toEqual([
        { taskId: task.id, kind: "archive-vetoed" },
        { taskId: task.id, kind: "archive-vetoed" },
      ]);
    });

    it("24h以内にvetoされたタスクが後続tickでclean判定になった場合、gate評価が毎tick走ることでarchiveが適用される（§74.4 再観測）", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(
        taskInput({ title: "veto後clean遷移タスク", body: "cwd: /work/veto-then-clean" }),
        "tester",
      );
      makeDone(harness, task.id);

      let observeCallCount = 0;
      let currentObservation: ArchiveIntegrationObservation = {
        cwd: { kind: "worktree-present" },
        integrationTarget: { state: "resolved", ref: "refs/remotes/origin/main", oid: "1".repeat(40) },
        integrationProof: { kind: "dirty" },
        drift: false,
      };
      const probe: StewardArchiveIntegrationProbe = {
        observe: async () => {
          observeCallCount += 1;
          return currentObservation;
        },
      };
      const gatedDeps = { ...harness.deps, stewardArchiveIntegrationProbe: probe };

      const baseSec = 1_700_000_000;
      const stage1 = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "archive", taskId: task.id, reason: "完了済み" }]),
        ),
        nowFn: () => baseSec,
      });
      await stage1.tick(gatedDeps, true, baseSec);
      expect(observeCallCount).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "steward_auto_archive_vetoed")).toHaveLength(1);

      // 31分後（cadence gating通過・24h以内）に worktree が統合済み(clean)へ遷移
      currentObservation = {
        cwd: { kind: "worktree-present" },
        integrationTarget: { state: "resolved", ref: "refs/remotes/origin/main", oid: "1".repeat(40) },
        integrationProof: { kind: "clean", proof: "ancestor" },
        drift: false,
      };
      const secondSec = baseSec + 31 * 60;
      const stage2 = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "archive", taskId: task.id, reason: "完了済み" }]),
        ),
        nowFn: () => secondSec,
      });
      await stage2.tick(gatedDeps, true, secondSec);

      expect(observeCallCount).toBe(2); // veto後もgate評価自体は毎tick走る
      expect(harness.store.getTask(task.id)?.status).toBe("archived");
      const archiveEvents = harness.store.listEvents(task.id, "steward_auto_archive");
      expect(archiveEvents).toHaveLength(1);
      const payload = JSON.parse(archiveEvents[0]!.payload) as Record<string, unknown>;
      expect(payload.integrationEvidence).toBe("clean-head-reachable");
      // veto イベントは増えない（今回はallowなので）
      expect(harness.store.listEvents(task.id, "steward_auto_archive_vetoed")).toHaveLength(1);
    });

    it("archivedByEvidence と state.lastArchivedByEvidence が evidence 別に集計される（§74.3）", async () => {
      addStewardProfile(harness.deps.config);

      const taskAncestor = harness.store.createTask(
        taskInput({ title: "ancestor 統合タスク", body: "cwd: /work/ancestor" }),
        "tester",
      );
      makeDone(harness, taskAncestor.id);

      const taskRepoRootDirty = harness.store.createTask(
        taskInput({ title: "repo-root dirty タスク", body: "cwd: /work/repo-root-dirty" }),
        "tester",
      );
      makeDone(harness, taskRepoRootDirty.id);

      const probe: StewardArchiveIntegrationProbe = {
        observe: async (input) => {
          if (input.cwd === "/work/ancestor") {
            return {
              cwd: { kind: "worktree-present" },
              integrationTarget: { state: "resolved", ref: "refs/remotes/origin/main", oid: "d".repeat(40) },
              integrationProof: { kind: "clean", proof: "ancestor" },
              drift: false,
            };
          }
          return { cwd: { kind: "repo-root", dirty: true }, drift: false };
        },
      };
      const gatedDeps = { ...harness.deps, stewardArchiveIntegrationProbe: probe };

      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([
            { kind: "archive", taskId: taskAncestor.id, reason: "完了済み" },
            { kind: "archive", taskId: taskRepoRootDirty.id, reason: "完了済み" },
          ]),
        ),
        nowFn: () => nowSec,
      });

      await stage.tick(gatedDeps, true, nowSec);

      expect(harness.store.getTask(taskAncestor.id)?.status).toBe("archived");
      expect(harness.store.getTask(taskRepoRootDirty.id)?.status).toBe("archived");

      const state = readStewardState(harness.home.home);
      expect(state.lastArchivedByEvidence["clean-head-reachable"]).toBe(1);
      expect(state.lastArchivedByEvidence["not-observable:repo-root-dirty"]).toBe(1);
    });

    it("not-observable:repo-root(-dirty) の reason 文言は「worktree が無い」ではなく repo root 由来であることを明示する（§74.3）", async () => {
      addStewardProfile(harness.deps.config);

      const cleanTask = harness.store.createTask(
        taskInput({ title: "repo-root clean タスク", body: "cwd: /work/repo-root-clean" }),
        "tester",
      );
      makeDone(harness, cleanTask.id);

      const dirtyTask = harness.store.createTask(
        taskInput({ title: "repo-root dirty タスク2", body: "cwd: /work/repo-root-dirty-2" }),
        "tester",
      );
      makeDone(harness, dirtyTask.id);

      const probe: StewardArchiveIntegrationProbe = {
        observe: async (input) => ({
          cwd: { kind: "repo-root", dirty: input.cwd === "/work/repo-root-dirty-2" },
          drift: false,
        }),
      };
      const gatedDeps = { ...harness.deps, stewardArchiveIntegrationProbe: probe };

      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([
            { kind: "archive", taskId: cleanTask.id, reason: "完了済み" },
            { kind: "archive", taskId: dirtyTask.id, reason: "完了済み" },
          ]),
        ),
        nowFn: () => nowSec,
      });

      await stage.tick(gatedDeps, true, nowSec);

      expect(harness.store.getTask(cleanTask.id)?.status).toBe("archived");
      expect(harness.store.getTask(dirtyTask.id)?.status).toBe("archived");

      const cleanEvents = harness.store.listEvents(cleanTask.id, "steward_auto_archive");
      const cleanPayload = JSON.parse(cleanEvents[0]!.payload) as Record<string, unknown>;
      expect(cleanPayload.integrationEvidence).toBe("not-observable:repo-root");
      expect(cleanPayload.reason).not.toContain("worktree が無い");
      expect(cleanPayload.reason).toContain("repo root");

      const dirtyEvents = harness.store.listEvents(dirtyTask.id, "steward_auto_archive");
      const dirtyPayload = JSON.parse(dirtyEvents[0]!.payload) as Record<string, unknown>;
      expect(dirtyPayload.integrationEvidence).toBe("not-observable:repo-root-dirty");
      expect(dirtyPayload.reason).not.toContain("worktree が無い");
      expect(dirtyPayload.reason).toContain("repo root");

      // clean と dirty で文言が異なり、それぞれ固有の状況を説明していることを確認する
      expect(cleanPayload.reason).not.toBe(dirtyPayload.reason);
    });
  });

  // ========================================================================
  // §40.4: promote → コメントのみ（自動遷移しない）
  // ========================================================================
  describe("promote 提案（§40.4）", () => {
    it("promote 提案はコメント + steward_proposal イベントのみ（ステータス遷移しない）", async () => {
      addStewardProfile(harness.deps.config);

      const task = harness.store.createTask(taskInput({ title: "triage タスク" }), "tester");

      const notifyCalls: Array<{ taskId: string; message: string; kind: string }> = [];
      const notifyFn: StewardNotifyFn = async (taskId, message, kind) => {
        notifyCalls.push({ taskId, message, kind });
      };

      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "promote", taskId: task.id, reason: "仕様十分" }]),
        ),
        nowFn: () => Math.floor(Date.now() / 1000),
        notifyFn,
      });

      const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBeGreaterThanOrEqual(1);

      // タスクは triage のまま（自動遷移されていない）
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("triage");

      // steward_proposal イベントが記録されている
      const events = harness.store.listEvents(task.id, "steward_proposal");
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
      expect(payload.kind).toBe("promote");

      // コメントが追加されている
      const comments = harness.store.listComments(task.id);
      expect(comments.some((c) => c.body.includes("[steward 提案] promote"))).toBe(true);

      // notify 経路で通知されている
      expect(notifyCalls).toHaveLength(1);
      expect(notifyCalls[0]!.taskId).toBe(task.id);
      expect(notifyCalls[0]!.kind).toBe("promote");
    });
  });

  // ========================================================================
  // §40.4: 24h 冪等 — 同一 (kind, taskId) は抑制
  // ========================================================================
  describe("24h 冪等（§40.4）", () => {
    it("同一 (kind, taskId) の提案は 24h 以内に再度適用されない", async () => {
      addStewardProfile(harness.deps.config);

      const task = harness.store.createTask(taskInput({ title: "冪等テスト" }), "tester");
      makeDone(harness, task.id);

      const baseSec = 1_700_000_000;
      let currentSec = baseSec;

      const proposals = [{ kind: "archive", taskId: task.id, reason: "完了済み" }];
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence(proposals)),
        nowFn: () => currentSec,
      });

      // 初回: 適用される
      const first = await stage.tick(harness.deps, true, currentSec);
      expect(first.actions).toBeGreaterThanOrEqual(1);

      // タスクは archived になっている
      expect(harness.store.getTask(task.id)?.status).toBe("archived");

      // 新しいタスクを done にして同じ kind の提案を再発行
      const task2 = harness.store.createTask(taskInput({ title: "冪等テスト2" }), "tester");
      makeDone(harness, task2.id);

      // 31分後（cadence gating 通過）だが 24h 以内
      currentSec = baseSec + 31 * 60;
      const stage2 = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([
            // task.id は archived なので store.getTask は見つからない可能性があるが、
            // task2.id に同じ kind を再発行して、task2 は初めてなので適用される
            { kind: "archive", taskId: task2.id, reason: "完了済み" },
          ]),
        ),
        nowFn: () => currentSec,
      });

      const second = await stage2.tick(harness.deps, true, currentSec);
      // task2 は初めてなので適用される
      expect(second.actions).toBeGreaterThanOrEqual(1);
      expect(harness.store.getTask(task2.id)?.status).toBe("archived");
    });

    it("同一タスクに同一 kind の提案が 24h 以内に来た場合は抑制される", async () => {
      addStewardProfile(harness.deps.config);

      // triage タスク（archive 提案は自動適用されないので done にしない）
      const task = harness.store.createTask(taskInput({ title: "抑制テスト" }), "tester");

      const baseSec = 1_700_000_000;
      let currentSec = baseSec;

      const proposals = [{ kind: "promote", taskId: task.id, reason: "仕様十分" }];
      const notifyFn: StewardNotifyFn = async () => true;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence(proposals)),
        nowFn: () => currentSec,
        notifyFn,
      });

      // 初回: promote コメントが記録される
      const first = await stage.tick(harness.deps, true, currentSec);
      expect(first.actions).toBeGreaterThanOrEqual(1);

      const commentsAfterFirst = harness.store.listComments(task.id);
      expect(commentsAfterFirst.some((c) => c.body.includes("[steward 提案] promote"))).toBe(true);

      // 31分後（cadence gating 通過）に同じ提案 → 24h 以内なので抑制
      currentSec = baseSec + 31 * 60;
      const stage2 = createStewardStage({
        sessionRunner: fakeRunner(stewardFence(proposals)),
        nowFn: () => currentSec,
        notifyFn,
      });

      const second = await stage2.tick(harness.deps, true, currentSec);

      // 抑制されたので notes に「抑制」メッセージがある
      expect(second.notes?.some((n) => n.includes("抑制"))).toBe(true);

      // コメント数は増えていない（初回の 1 件のみ）
      const commentsAfterSecond = harness.store.listComments(task.id);
      const promoteComments = commentsAfterSecond.filter((c) =>
        c.body.includes("[steward 提案] promote"),
      );
      expect(promoteComments).toHaveLength(1);
    });

    it("proposal 通知が skip された場合はコメントを重複させず次回も通知を再試行する", async () => {
      addStewardProfile(harness.deps.config);

      const task = harness.store.createTask(taskInput({ title: "通知 skip テスト" }), "tester");
      const notifyCalls: Array<{ taskId: string; message: string }> = [];
      const notifyFn: StewardNotifyFn = async (taskId, message) => {
        notifyCalls.push({ taskId, message });
        return false;
      };

      const baseSec = 1_700_000_000;
      let currentSec = baseSec;
      const proposals = [{ kind: "promote", taskId: task.id, reason: "仕様十分" }];
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence(proposals)),
        nowFn: () => currentSec,
        notifyFn,
      });

      await stage.tick(harness.deps, true, currentSec);
      currentSec = baseSec + 31 * 60;
      await stage.tick(harness.deps, true, currentSec);

      expect(notifyCalls).toHaveLength(2);
      const comments = harness.store
        .listComments(task.id)
        .filter((comment) => comment.body.includes("[steward 提案] promote"));
      expect(comments).toHaveLength(1);
      const events = harness.store.listEvents(task.id, "steward_proposal");
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
      expect(payload.notificationAttempted).toBe(false);
    });

    it("escalate 通知が skip された場合は 24h 冪等で再通知を抑止しない", async () => {
      addStewardProfile(harness.deps.config);

      const task = harness.store.createTask(taskInput({ title: "escalate skip テスト" }), "tester");
      const notifyCalls: Array<{ taskId: string; message: string }> = [];
      const notifyFn: StewardNotifyFn = async (taskId, message) => {
        notifyCalls.push({ taskId, message });
        return false;
      };

      const baseSec = 1_700_000_000;
      let currentSec = baseSec;
      const proposals = [{ kind: "escalate", taskId: task.id, reason: "人間判断が必要" }];
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence(proposals)),
        nowFn: () => currentSec,
        notifyFn,
      });

      await stage.tick(harness.deps, true, currentSec);
      currentSec = baseSec + 31 * 60;
      await stage.tick(harness.deps, true, currentSec);

      expect(notifyCalls).toHaveLength(2);
      const events = harness.store.listEvents(task.id, "steward_proposal");
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
      expect(payload.kind).toBe("escalate");
      expect(payload.notificationAttempted).toBe(false);
    });
  });

  // ========================================================================
  // §40.1: auto-disable — 連続 3 回失敗で自動無効化
  // ========================================================================
  describe("auto-disable（§40.1）", () => {
    it("セッション例外が連続 3 回発生すると auto-disable される", async () => {
      addStewardProfile(harness.deps.config);

      const baseSec = 1_700_000_000;
      let currentSec = baseSec;
      const lifecycleNotifications: string[] = [];

      const stage = createStewardStage({
        sessionRunner: failingRunner(new Error("LLM 接続エラー")),
        nowFn: () => currentSec,
        lifecycleNotifyFn: async (_deps, _task, message) => {
          lifecycleNotifications.push(message);
          return true;
        },
      });

      // 1回目の失敗
      await stage.tick(harness.deps, true, currentSec);
      let state = readStewardState(harness.home.home);
      expect(state.consecutiveFailures).toBe(1);
      expect(state.autoDisabled).toBe(false);

      // 2回目の失敗（cadence gating 通過させる）
      currentSec = baseSec + 31 * 60;
      await stage.tick(harness.deps, true, currentSec);
      state = readStewardState(harness.home.home);
      expect(state.consecutiveFailures).toBe(2);
      expect(state.autoDisabled).toBe(false);

      // 3回目の失敗 → auto-disable 発動
      currentSec = baseSec + 62 * 60;
      const result = await stage.tick(harness.deps, true, currentSec);
      state = readStewardState(harness.home.home);
      expect(state.consecutiveFailures).toBe(3);
      expect(state.autoDisabled).toBe(true);
      expect(state.autoDisabledReason).toContain("連続3回失敗");
      expect(state.autoDisabledAt).toBe(currentSec);
      expect(result.notes?.some((n) => n.includes("auto-disable"))).toBe(true);
      expect(lifecycleNotifications).toEqual([
        "steward: 連続3回失敗により auto-disable しました",
      ]);
    });

    it("パース不能（フェンスなし）が連続 3 回でも auto-disable される", async () => {
      addStewardProfile(harness.deps.config);

      const baseSec = 1_700_000_000;
      let currentSec = baseSec;

      // フェンスを含まない出力を返す runner
      const stage = createStewardStage({
        sessionRunner: fakeRunner("フェンスなしの出力テキスト"),
        nowFn: () => currentSec,
      });

      for (let i = 0; i < 3; i++) {
        currentSec = baseSec + (i * 31) * 60;
        await stage.tick(harness.deps, true, currentSec);
      }

      const state = readStewardState(harness.home.home);
      expect(state.autoDisabled).toBe(true);
      expect(state.autoDisabledReason).toContain("パース不能");
    });

    it("auto-disable 状態ではセッションを起動せずスキップする", async () => {
      addStewardProfile(harness.deps.config);
      const currentSec = 1_700_000_000;

      // state を直接書き込んで auto-disable 状態にする
      writeStewardState(harness.home.home, {
        lastRunAt: 0,
        lastProposalCount: 0,
        lastAppliedCount: 0,
        lastProposedCount: 0,
        lastRequestedCount: 0,
        lastSuppressedCount: 0,
        lastArchivedByEvidence: {},
        lastError: "",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "テスト用 auto-disable",
        autoDisabledAt: currentSec - 3_599,
        claimGeneration: 0,
      });

      const runCalls: string[] = [];
      const runner: StewardSessionRunner = {
        run: async (prompt) => {
          runCalls.push(prompt);
          return stewardFence([]);
        },
      };
      const stage = createStewardStage({ sessionRunner: runner, nowFn: () => currentSec });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(runCalls).toHaveLength(0);
      expect(result.skipped).toBe(true);
      expect(result.notes?.some((n) => n.includes("auto-disable"))).toBe(true);
    });

    it("待機時間経過後は half-open を1回実行し、成功すると完全復帰を通知する", async () => {
      addStewardProfile(harness.deps.config);
      const currentSec = 1_700_000_000;
      writeStewardState(harness.home.home, {
        lastRunAt: currentSec - 4_000,
        lastProposalCount: 0,
        lastAppliedCount: 0,
        lastProposedCount: 0,
        lastRequestedCount: 0,
        lastSuppressedCount: 0,
        lastArchivedByEvidence: {},
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      const runCalls: string[] = [];
      const lifecycleNotifications: string[] = [];
      const stage = createStewardStage({
        nowFn: () => currentSec,
        sessionRunner: {
          run: async (prompt): Promise<string> => {
            runCalls.push(prompt);
            return stewardFence([]);
          },
        },
        lifecycleNotifyFn: async (_deps, _task, message) => {
          lifecycleNotifications.push(message);
          return true;
        },
      });

      await stage.tick(harness.deps, true, currentSec);

      expect(runCalls).toHaveLength(1);
      expect(readStewardState(harness.home.home)).toMatchObject({
        consecutiveFailures: 0,
        autoDisabled: false,
        autoDisabledReason: "",
        autoDisabledAt: 0,
      });
      expect(lifecycleNotifications).toEqual([
        "steward: half-open 再試行に成功し auto-disable から復帰しました",
      ]);
    });

    it("half-open outbox は state lock 解放後に配送する", async () => {
      addStewardProfile(harness.deps.config);
      const currentSec = 1_700_000_000;
      const task = harness.store.createTask(taskInput({ title: "lock外配送" }), "tester");
      writeStewardState(harness.home.home, {
        lastRunAt: currentSec - 4_000,
        lastProposalCount: 0,
        lastAppliedCount: 0,
        lastProposedCount: 0,
        lastRequestedCount: 0,
        lastSuppressedCount: 0,
        lastArchivedByEvidence: {},
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      let lockAvailableDuringNotify = false;
      let pendingDuringNotify = 0;
      const stage = createStewardStage({
        nowFn: () => currentSec,
        elapsedNowFn: () => 0,
        sessionRunner: fakeRunner(stewardFence([{
          kind: "escalate",
          taskId: task.id,
          reason: "人間判断が必要",
        }])),
        notifyFn: async (): Promise<boolean> => {
          const lock = acquireStewardStateLock(harness.home.home, "cli-steward-enable");
          lockAvailableDuringNotify = lock !== null;
          lock?.release();
          pendingDuringNotify = harness.store.listPendingHalfOpenOutbox({
            stage: "steward",
            now: currentSec,
          }).length;
          return true;
        },
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect({ lockAvailableDuringNotify, pendingDuringNotify, notes: result.notes }).toEqual({
        lockAvailableDuringNotify: true,
        pendingDuringNotify: 1,
        notes: expect.any(Array),
      });
      expect(harness.store.listPendingHalfOpenOutbox({ stage: "steward", now: currentSec })).toEqual([]);
    });

    it("enqueue を含む fence が世代不一致なら steward mutation と outbox を残さない", async () => {
      addStewardProfile(harness.deps.config);
      const currentSec = 1_700_000_000;
      const task = harness.store.createTask(taskInput({ title: "原子性確認" }), "tester");
      writeStewardState(harness.home.home, {
        lastRunAt: currentSec - 4_000,
        lastProposalCount: 0,
        lastAppliedCount: 0,
        lastProposedCount: 0,
        lastRequestedCount: 0,
        lastSuppressedCount: 0,
        lastArchivedByEvidence: {},
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      const notifyCalls: string[] = [];
      const stage = createStewardStage({
        nowFn: () => currentSec,
        elapsedNowFn: () => 0,
        sessionRunner: {
          run: async (): Promise<string> => {
            const claimed = readStewardState(harness.home.home);
            writeStewardState(harness.home.home, {
              ...claimed,
              claimGeneration: claimed.claimGeneration + 1,
              autoDisabledReason: "外部 writer が claim を無効化",
            });
            return stewardFence([{
              kind: "escalate",
              taskId: task.id,
              reason: "配送しない",
            }]);
          },
        },
        notifyFn: async (taskId): Promise<boolean> => {
          notifyCalls.push(taskId);
          return true;
        },
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(result.skipped).toBe(true);
      expect(harness.store.listStewardProposalRequests()).toEqual([]);
      expect(harness.store.listEvents(task.id, "steward_proposal")).toEqual([]);
      expect(harness.store.listPendingHalfOpenOutbox({ stage: "steward", now: currentSec })).toEqual([]);
      expect(notifyCalls).toEqual([]);
      expect(readStewardState(harness.home.home)).toMatchObject({
        lastProposalCount: 0,
        claimGeneration: 2,
        autoDisabledReason: "外部 writer が claim を無効化",
      });
    });

    it("steward の旧世代 half-open outbox は配送せず discarded にする", async () => {
      const currentSec = 1_700_000_000;
      writeStewardState(harness.home.home, {
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
        claimGeneration: 2,
      });
      const old = harness.store.enqueueHalfOpenOutbox({
        stage: "steward",
        claimGeneration: 1,
        dedupeKey: "steward-old-generation",
        kind: "escalate",
        payload: JSON.stringify({ id: "t_old", title: "旧世代", body: "送らない" }),
        now: currentSec,
      });
      const notifyCalls: string[] = [];
      const stage = createStewardStage({
        nowFn: () => currentSec,
        notifyFn: async (taskId): Promise<boolean> => {
          notifyCalls.push(taskId);
          return true;
        },
      });

      await stage.tick(harness.deps, true, currentSec);

      expect(notifyCalls).toEqual([]);
      expect(harness.store.markHalfOpenOutbox({ id: old.row.id, result: "sent", now: currentSec })?.status)
        .toBe("discarded");
    });

    it("steward half-open は1 claim 20提案で打ち切る", async () => {
      addStewardProfile(harness.deps.config);
      const currentSec = 1_700_000_000;
      const tasks = Array.from({ length: 21 }, (_, index) =>
        harness.store.createTask(taskInput({ title: `上限対象${index}` }), "tester")
      );
      writeStewardState(harness.home.home, {
        lastRunAt: currentSec - 4_000,
        lastProposalCount: 0,
        lastAppliedCount: 0,
        lastProposedCount: 0,
        lastRequestedCount: 0,
        lastSuppressedCount: 0,
        lastArchivedByEvidence: {},
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      const stage = createStewardStage({
        nowFn: () => currentSec,
        elapsedNowFn: () => 0,
        sessionRunner: fakeRunner(stewardFence(tasks.map((task) => ({
          kind: "spec-lint",
          taskId: task.id,
          reason: "仕様を補強する",
        })))),
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(tasks.reduce((count, task) => count + harness.store.listComments(task.id).length, 0)).toBe(20);
      expect(result.notes?.some((note) => note.includes("提案上限20件"))).toBe(true);
      expect(readStewardState(harness.home.home)).toMatchObject({
        lastProposalCount: 20,
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledAt: currentSec,
        claimGeneration: 1,
      });
    });

    it("21件目の archive と同一タスクの先行提案は上限境界でまとめて次 claim へ送る", async () => {
      addStewardProfile(harness.deps.config);
      const currentSec = 1_700_000_000;
      const precedingTasks = Array.from({ length: 19 }, (_, index) =>
        harness.store.createTask(taskInput({ title: `先行上限対象${index}` }), "tester")
      );
      const groupedTask = harness.store.createTask(taskInput({ title: "archive 境界対象" }), "tester");
      makeDone(harness, groupedTask.id);
      writeStewardState(harness.home.home, {
        lastRunAt: currentSec - 4_000,
        lastProposalCount: 0,
        lastAppliedCount: 0,
        lastProposedCount: 0,
        lastRequestedCount: 0,
        lastSuppressedCount: 0,
        lastArchivedByEvidence: {},
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      const proposals = [
        ...precedingTasks.map((task) => ({
          kind: "spec-lint",
          taskId: task.id,
          reason: "仕様を補強する",
        })),
        { kind: "promote", taskId: groupedTask.id, reason: "先行提案" },
        { kind: "archive", taskId: groupedTask.id, reason: "末尾の veto 対象" },
      ];
      const stage = createStewardStage({
        nowFn: () => currentSec,
        elapsedNowFn: () => 0,
        sessionRunner: fakeRunner(stewardFence(proposals)),
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(precedingTasks.reduce(
        (count, task) => count + harness.store.listComments(task.id).length,
        0,
      )).toBe(19);
      expect(harness.store.listComments(groupedTask.id)).toEqual([]);
      expect(harness.store.getTask(groupedTask.id)?.status).toBe("done");
      expect(harness.store.listEvents(groupedTask.id, "steward_auto_archive_vetoed")).toEqual([]);
      expect(result.notes?.some((note) => note.includes("提案上限20件"))).toBe(true);
      expect(readStewardState(harness.home.home)).toMatchObject({
        lastProposalCount: 19,
        consecutiveFailures: 3,
        autoDisabled: true,
        claimGeneration: 1,
      });
    });

    it("half-open が失敗すると回数を増やさず再試行起点だけを更新する", async () => {
      addStewardProfile(harness.deps.config);
      const currentSec = 1_700_000_000;
      writeStewardState(harness.home.home, {
        lastRunAt: currentSec - 4_000,
        lastProposalCount: 0,
        lastAppliedCount: 0,
        lastProposedCount: 0,
        lastRequestedCount: 0,
        lastSuppressedCount: 0,
        lastArchivedByEvidence: {},
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      const stage = createStewardStage({
        nowFn: () => currentSec,
        sessionRunner: failingRunner(new Error("half-open failure")),
      });

      await stage.tick(harness.deps, true, currentSec);

      expect(readStewardState(harness.home.home)).toMatchObject({
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledAt: currentSec,
      });
    });

    it("half-open の runner 構築失敗より前に claim を永続化する", async () => {
      addStewardProfile(harness.deps.config);
      const currentSec = 1_700_000_000;
      writeStewardState(harness.home.home, {
        lastRunAt: currentSec - 4_000,
        lastProposalCount: 0,
        lastAppliedCount: 0,
        lastProposedCount: 0,
        lastRequestedCount: 0,
        lastSuppressedCount: 0,
        lastArchivedByEvidence: {},
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 7,
      });
      harness.deps.directAdapters = {
        claude: new FakeAdapter("claude", { supportsStop: false }),
      };

      const stage = createStewardStage({ nowFn: () => currentSec });
      await stage.tick(harness.deps, true, currentSec);

      expect(readStewardState(harness.home.home)).toMatchObject({
        autoDisabledAt: currentSec,
        claimGeneration: 8,
        consecutiveFailures: 3,
        lastError: expect.stringContaining("stop capability 必須"),
      });
    });

    it("half-open 実行中に generation が進んだ場合は提案副作用を止める", async () => {
      addStewardProfile(harness.deps.config);
      const currentSec = 1_700_000_000;
      const task = harness.store.createTask(taskInput({ title: "fence対象" }), "tester");
      writeStewardState(harness.home.home, {
        lastRunAt: currentSec - 4_000,
        lastProposalCount: 0,
        lastAppliedCount: 0,
        lastProposedCount: 0,
        lastRequestedCount: 0,
        lastSuppressedCount: 0,
        lastArchivedByEvidence: {},
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      const stage = createStewardStage({
        nowFn: () => currentSec,
        sessionRunner: {
          run: async (): Promise<string> => {
            const claimed = readStewardState(harness.home.home);
            writeStewardState(harness.home.home, {
              ...claimed,
              claimGeneration: claimed.claimGeneration + 1,
              autoDisabledReason: "外部 writer が claim を無効化",
            });
            return stewardFence([{
              kind: "spec-lint",
              taskId: task.id,
              reason: "適用されない指摘",
            }]);
          },
        },
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(result.skipped).toBe(true);
      expect(harness.store.listStewardProposalRequests()).toEqual([]);
      expect(harness.store.listComments(task.id)).toEqual([]);
      expect(readStewardState(harness.home.home)).toMatchObject({
        claimGeneration: 2,
        autoDisabledReason: "外部 writer が claim を無効化",
      });
    });

    it("half-open 実行中に同じgenerationでbaselineが変わった場合は成功stateを上書きしない", async () => {
      addStewardProfile(harness.deps.config);
      const currentSec = 1_700_000_000;
      writeStewardState(harness.home.home, {
        lastRunAt: currentSec - 4_000,
        lastProposalCount: 0,
        lastAppliedCount: 0,
        lastProposedCount: 0,
        lastRequestedCount: 0,
        lastSuppressedCount: 0,
        lastArchivedByEvidence: {},
        lastError: "一時障害",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledReason: "連続3回失敗: 一時障害",
        autoDisabledAt: currentSec - 3_600,
        claimGeneration: 0,
      });
      const lifecycleNotifications: string[] = [];
      const stage = createStewardStage({
        nowFn: () => currentSec,
        sessionRunner: {
          run: async (): Promise<string> => {
            const claimed = readStewardState(harness.home.home);
            writeStewardState(harness.home.home, {
              ...claimed,
              lastError: "同一generationの外部 writer state",
            });
            return stewardFence([]);
          },
        },
        lifecycleNotifyFn: async (_deps, _task, message) => {
          lifecycleNotifications.push(message);
          return true;
        },
      });

      const result = await stage.tick(harness.deps, true, currentSec);

      expect(result.skipped).toBe(true);
      expect(result.notes).toContain(
        "steward half-open claim を失ったためstate更新を中止しました (claim-mismatch)",
      );
      expect(readStewardState(harness.home.home)).toMatchObject({
        claimGeneration: 1,
        lastError: "同一generationの外部 writer state",
        consecutiveFailures: 3,
        autoDisabled: true,
        autoDisabledAt: currentSec,
      });
      expect(lifecycleNotifications).toEqual([]);
    });

    it("2 process 相当の並行 tick でも half-open session は1回しか走らない", async () => {
      addStewardProfile(harness.deps.config);
      const currentSec = 1_700_000_000;
      writeStewardState(harness.home.home, {
        lastRunAt: currentSec - 4_000,
        lastProposalCount: 0,
        lastAppliedCount: 0,
        lastProposedCount: 0,
        lastRequestedCount: 0,
        lastSuppressedCount: 0,
        lastArchivedByEvidence: {},
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
      const runCalls: string[] = [];
      const stage = createStewardStage({
        nowFn: () => currentSec,
        sessionRunner: {
          run: async (prompt): Promise<string> => {
            runCalls.push(prompt);
            await runGate;
            return stewardFence([]);
          },
        },
      });

      const first = stage.tick(harness.deps, true, currentSec);
      await vi.waitFor(() => expect(runCalls).toHaveLength(1));
      const second = await stage.tick(harness.deps, true, currentSec);
      releaseRun?.();
      await first;

      expect(second.skipped).toBe(true);
      expect(runCalls).toHaveLength(1);
      expect(readStewardState(harness.home.home).claimGeneration).toBe(1);
    });

    it("成功すると consecutiveFailures がリセットされる", async () => {
      addStewardProfile(harness.deps.config);

      const baseSec = 1_700_000_000;
      let currentSec = baseSec;

      // 最初に 2 回失敗させてから成功させる
      const stage1 = createStewardStage({
        sessionRunner: failingRunner(new Error("一時エラー")),
        nowFn: () => currentSec,
      });

      await stage1.tick(harness.deps, true, currentSec);
      currentSec = baseSec + 31 * 60;
      await stage1.tick(harness.deps, true, currentSec);

      let state = readStewardState(harness.home.home);
      expect(state.consecutiveFailures).toBe(2);
      const statePath = join(harness.home.home, "state", "steward.json");
      chmodSync(statePath, 0o644);

      // 成功する runner で実行
      currentSec = baseSec + 62 * 60;
      const stage2 = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([])),
        nowFn: () => currentSec,
      });

      await stage2.tick(harness.deps, true, currentSec);

      state = readStewardState(harness.home.home);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.autoDisabled).toBe(false);
      expect(statSync(statePath).mode & 0o777).toBe(0o600);
    });
  });

  // ========================================================================
  // §40.4: spec-lint → コメントのみ
  // ========================================================================
  describe("spec-lint 提案（§40.4）", () => {
    it("spec-lint 提案はコメントのみ", async () => {
      addStewardProfile(harness.deps.config);

      const task = harness.store.createTask(
        taskInput({ title: "仕様不足タスク", body: "TODO: 詳細未定" }),
        "tester",
      );

      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "spec-lint", taskId: task.id, reason: "受入条件が未記載です" }]),
        ),
        nowFn: () => Math.floor(Date.now() / 1000),
      });

      const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.notes?.some((n) => n.includes("spec-lint"))).toBe(true);

      // タスクのステータスは変わらない
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("triage");

      // spec-lint はコメントのみで、steward_proposal イベントは記録しない
      const events = harness.store.listEvents(task.id, "steward_spec_lint");
      expect(events).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "steward_proposal")).toHaveLength(0);

      // コメントが追加されている
      const comments = harness.store.listComments(task.id);
      expect(comments.some((c) => c.body.includes("[steward 指摘] spec-lint"))).toBe(true);
    });
  });

  // ========================================================================
  // §40.4: escalate → steward_proposal イベント + notify
  // ========================================================================
  describe("escalate 提案（§40.4）", () => {
    it("escalate 提案は steward_proposal イベント + notify 経路", async () => {
      addStewardProfile(harness.deps.config);

      const task = harness.store.createTask(taskInput({ title: "緊急タスク" }), "tester");

      const notifyCalls: Array<{ taskId: string; message: string; kind: string }> = [];
      const notifyFn: StewardNotifyFn = async (taskId, message, kind) => {
        notifyCalls.push({ taskId, message, kind });
      };

      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([{ kind: "escalate", taskId: task.id, reason: "人間判断が必要" }]),
        ),
        nowFn: () => Math.floor(Date.now() / 1000),
        notifyFn,
      });

      await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      // steward_proposal イベント（escalate）
      const events = harness.store.listEvents(task.id, "steward_proposal");
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
      expect(payload.kind).toBe("escalate");

      // notify が呼ばれている
      expect(notifyCalls).toHaveLength(1);
      expect(notifyCalls[0]!.message).toContain("escalate");
      expect(notifyCalls[0]!.kind).toBe("escalate");
    });
  });

  // ========================================================================
  // state I/O（readStewardState / writeStewardState）
  // ========================================================================
  describe("state I/O", () => {
    it("state ファイルがない場合は既定値を返す", () => {
      const state = readStewardState(harness.home.home);
      expect(state.lastRunAt).toBe(0);
      expect(state.lastProposalCount).toBe(0);
      expect(state.lastAppliedCount).toBe(0);
      expect(state.lastProposedCount).toBe(0);
      expect(state.lastError).toBe("");
      expect(state.consecutiveFailures).toBe(0);
      expect(state.autoDisabled).toBe(false);
      expect(state.autoDisabledReason).toBe("");
      expect(state.autoDisabledAt).toBe(0);
      expect(state.claimGeneration).toBe(0);
    });

    it("書き込んだ state を読み戻せる", () => {
      const expected: StewardState = {
        lastRunAt: 1_700_000_000,
        lastProposalCount: 3,
        lastAppliedCount: 1,
        lastProposedCount: 2,
        lastRequestedCount: 0,
        lastSuppressedCount: 0,
        lastError: "テストエラー",
        consecutiveFailures: 2,
        autoDisabled: true,
        autoDisabledReason: "テスト",
        autoDisabledAt: 123,
        claimGeneration: 0,
        lastArchivedByEvidence: {},
      };
      writeStewardState(harness.home.home, expected);

      const actual = readStewardState(harness.home.home);
      expect(actual).toEqual(expected);
      expect(statSync(join(harness.home.home, "state", "steward.json")).mode & 0o777).toBe(0o600);
    });

    it("CLI lock中はsupervisor writerがstateを上書きしない", () => {
      const before: StewardState = {
        lastRunAt: 10,
        lastProposalCount: 1,
        lastAppliedCount: 1,
        lastProposedCount: 0,
        lastRequestedCount: 0,
        lastSuppressedCount: 0,
        lastError: "",
        consecutiveFailures: 0,
        autoDisabled: false,
        autoDisabledReason: "",
        autoDisabledAt: 0,
        claimGeneration: 0,
        lastArchivedByEvidence: {},
      };
      writeStewardState(harness.home.home, before);
      const lock = acquireStewardStateLock(harness.home.home, "cli-steward-enable");
      expect(lock).not.toBeNull();

      expect(() => writeStewardState(harness.home.home, { ...before, lastRunAt: 20 }))
        .toThrow(/別process/);
      expect(readStewardState(harness.home.home)).toEqual(before);
      lock!.release();
    });

    it("tick開始後にCLI相当のstate更新が入った場合はbaseline CASでstale writeを拒否する", async () => {
      addStewardProfile(harness.deps.config);
      const initial: StewardState = {
        lastRunAt: 0,
        lastProposalCount: 0,
        lastAppliedCount: 0,
        lastProposedCount: 0,
        lastRequestedCount: 0,
        lastSuppressedCount: 0,
        lastError: "",
        consecutiveFailures: 0,
        autoDisabled: false,
        autoDisabledReason: "",
        autoDisabledAt: 0,
        claimGeneration: 0,
        lastArchivedByEvidence: {},
      };
      const external: StewardState = {
        ...initial,
        lastRunAt: 99,
        autoDisabled: true,
        autoDisabledReason: "external update",
      };
      writeStewardState(harness.home.home, initial);
      const stage = createStewardStage({
        nowFn: () => 1_700_000_000,
        sessionRunner: {
          run: async (): Promise<string> => {
            writeStewardState(harness.home.home, external);
            return stewardFence([]);
          },
        },
      });

      await expect(stage.tick(harness.deps, true, 1_700_000_000)).rejects.toThrow(/stale write/);
      expect(readStewardState(harness.home.home)).toEqual(external);
    });
  });

  // ========================================================================
  // 複合シナリオ: 複数提案の混在処理
  // ========================================================================
  describe("複合シナリオ", () => {
    it("archive(done) + promote + spec-lint の混在提案を正しく処理する", async () => {
      addStewardProfile(harness.deps.config);

      // done タスク（archive 自動適用対象）
      const doneTask = harness.store.createTask(taskInput({ title: "完了タスク" }), "tester");
      makeDone(harness, doneTask.id);

      // triage タスク（promote 対象）
      const triageTask = harness.store.createTask(taskInput({ title: "仕分け待ち" }), "tester");

      // triage タスク（spec-lint 対象）
      const specTask = harness.store.createTask(
        taskInput({ title: "仕様不足" }),
        "tester",
      );

      const stage = createStewardStage({
        sessionRunner: fakeRunner(
          stewardFence([
            { kind: "archive", taskId: doneTask.id, reason: "完了済み" },
            { kind: "promote", taskId: triageTask.id, reason: "仕様十分" },
            { kind: "spec-lint", taskId: specTask.id, reason: "受入条件なし" },
          ]),
        ),
        nowFn: () => Math.floor(Date.now() / 1000),
      });

      const result = await stage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      // archive(done) → 自動適用、promote → 提案、spec-lint → 指摘
      expect(result.actions).toBeGreaterThanOrEqual(2); // 自動適用 1 + 提案 1

      // done タスクは archived に
      expect(harness.store.getTask(doneTask.id)?.status).toBe("archived");

      // triage タスクは triage のまま
      expect(harness.store.getTask(triageTask.id)?.status).toBe("triage");

      // spec-lint コメントあり
      const specComments = harness.store.listComments(specTask.id);
      expect(specComments.some((c) => c.body.includes("[steward 指摘] spec-lint"))).toBe(true);
    });
  });

  // --- §69: steward 提案の orchestrator inbox ルーティング ---

  describe("提案の request ルーティング（§69）", () => {
    /** 配送先になる orchestrator を1件登録する */
    function registerOrchestrator(label: string): { id: string; sessionId: string; generation: number } {
      const orchestrator = harness.store.registerOrchestrator({
        label,
        project: "hachi",
        repoCommonDir: harness.home.home,
      });
      const session = harness.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
      return { id: orchestrator.id, sessionId: session.id, generation: session.generation };
    }

    /** binding を1件持つ = 配送先が解決できるタスクを作る */
    function boundTask(overrides: Parameters<typeof taskInput>[0] = {}): TaskRow {
      const task = harness.store.createTask(taskInput(overrides), "tester");
      const owner = registerOrchestrator(`owner-${task.id}`);
      harness.store.bindTaskToOrchestrator(task.id, owner.id, "primary");
      return task;
    }

    function requestsFor(taskId: string, kind: string): StewardProposalRequestRow[] {
      return harness.store.listStewardProposalRequests().filter(
        (request) => request.taskId === taskId && request.kind === kind,
      );
    }

    it("promote / archive(done以外) / spec-lint を request として発行し per-proposal 通知を出さない", async () => {
      addStewardProfile(harness.deps.config);
      const promoteTask = boundTask({ title: "promote 対象" });
      const archiveTask = boundTask({ title: "archive 対象" });
      const specTask = boundTask({ title: "spec-lint 対象" });
      const notifyCalls: Array<{ taskId: string; kind: string }> = [];
      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "promote", taskId: promoteTask.id, reason: "ready 化候補" },
          { kind: "archive", taskId: archiveTask.id, reason: "陳腐化" },
          { kind: "spec-lint", taskId: specTask.id, reason: "受入条件が無い" },
        ])),
        notifyFn: async (taskId, _message, kind) => {
          notifyCalls.push({ taskId, kind });
        },
        nowFn: () => nowSec,
      });

      const result = await stage.tick(harness.deps, true, nowSec);

      // 提案コメント2件 + 指摘コメント1件。request 発行を別枠で足すと同じ作用を二重に数える
      expect(result.actions).toBe(3);

      // §69.3: 3種とも durable request になる
      expect(requestsFor(promoteTask.id, "promote")).toHaveLength(1);
      expect(requestsFor(archiveTask.id, "archive")).toHaveLength(1);
      expect(requestsFor(specTask.id, "spec-lint")).toHaveLength(1);
      expect(requestsFor(promoteTask.id, "promote")[0]?.status).toBe("queued");
      // 配送先 delivery が張られている
      const requestId = requestsFor(promoteTask.id, "promote")[0]!.id;
      expect(harness.store.listStewardProposalDeliveries(requestId)).toHaveLength(1);

      // §69.5: promote / archive / spec-lint は per-proposal 通知を出さない
      expect(notifyCalls).toEqual([]);

      // 監査の可読性のため提案コメントは残る
      expect(harness.store.listComments(promoteTask.id).some((c) => c.body.startsWith("[steward 提案] promote:"))).toBe(true);
      expect(harness.store.listComments(archiveTask.id).some((c) => c.body.startsWith("[steward 提案] archive:"))).toBe(true);
      expect(harness.store.listComments(specTask.id).some((c) => c.body.startsWith("[steward 指摘] spec-lint:"))).toBe(true);

      // §69.7: 発行数が state に載る
      const state = readStewardState(harness.home.home);
      expect(state.lastRequestedCount).toBe(3);
      expect(state.lastSuppressedCount).toBe(0);
    });

    it("escalate は request 発行後も §38 通知を維持する", async () => {
      addStewardProfile(harness.deps.config);
      const task = boundTask({ title: "escalate 対象" });
      const notifyCalls: Array<{ taskId: string; kind: string }> = [];
      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "escalate", taskId: task.id, reason: "方針判断が要る" },
        ])),
        notifyFn: async (taskId, _message, kind) => {
          notifyCalls.push({ taskId, kind });
          return true;
        },
        nowFn: () => nowSec,
      });

      await stage.tick(harness.deps, true, nowSec);

      expect(requestsFor(task.id, "escalate")).toHaveLength(1);
      expect(notifyCalls).toEqual([{ taskId: task.id, kind: "escalate" }]);
      expect(readStewardState(harness.home.home).lastRequestedCount).toBe(1);
    });

    it("§69.7: 通知が skip されても request 発行は stage の actions に載る", async () => {
      addStewardProfile(harness.deps.config);
      const task = boundTask({ title: "通知skipのescalate対象" });
      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "escalate", taskId: task.id, reason: "方針判断が要る" },
        ])),
        // transport skip 相当。notified は増えないが durable request は作られる
        notifyFn: async () => false,
        nowFn: () => nowSec,
      });

      const result = await stage.tick(harness.deps, true, nowSec);

      expect(requestsFor(task.id, "escalate")).toHaveLength(1);
      const state = readStewardState(harness.home.home);
      expect(state.lastRequestedCount).toBe(1);
      // request を数えないと無作用（actions=0）に見えてしまう run
      expect(result.actions).toBe(1);
    });

    it("§69.4 が抑止した再提案ではコメントも通知も出さない", async () => {
      addStewardProfile(harness.deps.config);
      const task = boundTask({ title: "再提案対象" });
      const notifyCalls: string[] = [];
      let currentSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "promote", taskId: task.id, reason: "ready 化候補" },
        ])),
        notifyFn: async (taskId) => {
          notifyCalls.push(taskId);
        },
        nowFn: () => currentSec,
      });

      await stage.tick(harness.deps, true, currentSec);
      const commentsAfterFirst = harness.store.listComments(task.id).length;

      // 24h 冪等窓の外へ出しても、未終端 request があるかぎり §69.4 が抑止する
      currentSec += 48 * 60 * 60;
      await stage.tick(harness.deps, true, currentSec);

      // 未終端 request が居ることによる抑止（§69.4-1）であることを status で固定する。
      // dismiss_backoff や accepted が先に効いていれば queued では無くなる
      expect(requestsFor(task.id, "promote")).toHaveLength(1);
      expect(requestsFor(task.id, "promote")[0]?.status).toBe("queued");
      expect(harness.store.listComments(task.id)).toHaveLength(commentsAfterFirst);
      expect(notifyCalls).toEqual([]);
      const state = readStewardState(harness.home.home);
      expect(state.lastRequestedCount).toBe(0);
      expect(state.lastSuppressedCount).toBe(1);
    });

    it("配送先0件では request を作らず従来のコメント + 通知へフォールスルーする", async () => {
      addStewardProfile(harness.deps.config);
      // binding も watch も張らない = 配送先0件
      const task = harness.store.createTask(taskInput({ title: "unrouted 対象" }), "tester");
      const notifyCalls: Array<{ taskId: string; kind: string }> = [];
      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "promote", taskId: task.id, reason: "ready 化候補" },
        ])),
        notifyFn: async (taskId, _message, kind) => {
          notifyCalls.push({ taskId, kind });
          return true;
        },
        nowFn: () => nowSec,
      });

      await stage.tick(harness.deps, true, nowSec);

      // §69.3: request は作らない
      expect(harness.store.listStewardProposalRequests()).toEqual([]);
      // 従来どおりコメント + §38 通知
      expect(harness.store.listComments(task.id).some((c) => c.body.startsWith("[steward 提案] promote:"))).toBe(true);
      expect(notifyCalls).toEqual([{ taskId: task.id, kind: "promote" }]);
      expect(harness.store.listEvents(task.id, "steward_proposal")).toHaveLength(1);
      const state = readStewardState(harness.home.home);
      expect(state.lastRequestedCount).toBe(0);
      expect(state.lastSuppressedCount).toBe(0);
    });

    it("§69.3: unrouted 後に配送先が現れたら、24h 冪等窓の内側でも request を発行する", async () => {
      addStewardProfile(harness.deps.config);
      // 最初は binding も watch も無い = 配送先0件
      const task = harness.store.createTask(taskInput({ title: "後から配送先が付く" }), "tester");
      let currentSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "promote", taskId: task.id, reason: "ready 化候補" },
        ])),
        notifyFn: async () => true,
        nowFn: () => currentSec,
      });

      await stage.tick(harness.deps, true, currentSec);
      expect(harness.store.listStewardProposalRequests()).toEqual([]);

      // 配送先は可変。unrouted の結果をキャッシュすると、この binding へ 24h 届かなくなる
      const owner = registerOrchestrator("late-owner");
      harness.store.bindTaskToOrchestrator(task.id, owner.id, "primary");

      currentSec += 31 * 60;
      await stage.tick(harness.deps, true, currentSec);

      expect(requestsFor(task.id, "promote")).toHaveLength(1);
      expect(readStewardState(harness.home.home).lastRequestedCount).toBe(1);
    });

    it("§69.5: routed escalate の通知が transport 失敗した回は次 tick で再通知する", async () => {
      addStewardProfile(harness.deps.config);
      const task = boundTask({ title: "通知失敗のescalate対象" });
      let transportUp = false;
      const notifyCalls: string[] = [];
      let currentSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "escalate", taskId: task.id, reason: "方針判断が要る" },
        ])),
        notifyFn: async (taskId) => {
          notifyCalls.push(taskId);
          return transportUp;
        },
        nowFn: () => currentSec,
      });

      // 1回目: request は作られるが transport が落ちていて人へ届かない
      await stage.tick(harness.deps, true, currentSec);
      expect(requestsFor(task.id, "escalate")).toHaveLength(1);
      expect(notifyCalls).toHaveLength(1);

      // 2回目: §69.4 は再提案を抑止するが、未達の escalate 通知は拾い直す
      currentSec += 31 * 60;
      transportUp = true;
      await stage.tick(harness.deps, true, currentSec);
      expect(requestsFor(task.id, "escalate")).toHaveLength(1);
      expect(notifyCalls).toHaveLength(2);

      // 3回目: 既に届いているので再通知しない
      currentSec += 31 * 60;
      await stage.tick(harness.deps, true, currentSec);
      expect(notifyCalls).toHaveLength(2);

      // tick を重ねても、同じ request が未解決である限り再通知しない。
      // なお 24h 窓そのものの失効は再現できない（store.addEvent は実クロックで刻むため、
      // 擬似時刻の cutoff から見た event は常に「最近」になる）。窓を使わない設計であることは
      // 下の不変条件 test で固定する
      currentSec += 25 * 60 * 60;
      await stage.tick(harness.deps, true, currentSec);
      expect(requestsFor(task.id, "escalate")[0]?.status).toBe("queued");
      expect(notifyCalls).toHaveLength(2);
    });

    it("unrouted フォールスルーでは従来の 24h 冪等が残る", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(taskInput({ title: "unrouted 冪等" }), "tester");
      const notifyCalls: string[] = [];
      let currentSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "promote", taskId: task.id, reason: "ready 化候補" },
        ])),
        notifyFn: async (taskId) => {
          notifyCalls.push(taskId);
          return true;
        },
        nowFn: () => currentSec,
      });

      await stage.tick(harness.deps, true, currentSec);
      currentSec += 31 * 60;
      await stage.tick(harness.deps, true, currentSec);

      // 24h 以内の再提案はコメントも通知も増えない
      expect(notifyCalls).toHaveLength(1);
      expect(
        harness.store.listComments(task.id).filter((c) => c.body.startsWith("[steward 提案] promote:")),
      ).toHaveLength(1);
    });

    it("§69.6: done の auto-archive は request 化せず従来どおり自動適用する（非回帰）", async () => {
      addStewardProfile(harness.deps.config);
      const task = boundTask({ title: "done auto-archive" });
      makeDone(harness, task.id);
      const notifyCalls: string[] = [];
      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "archive", taskId: task.id, reason: "done なので archive" },
        ])),
        notifyFn: async (taskId) => {
          notifyCalls.push(taskId);
        },
        nowFn: () => nowSec,
      });

      const result = await stage.tick(harness.deps, true, nowSec);

      expect(harness.store.getTask(task.id)?.status).toBe("archived");
      expect(harness.store.listEvents(task.id, "steward_auto_archive")).toHaveLength(1);
      // request 面には載せない
      expect(harness.store.listStewardProposalRequests()).toEqual([]);
      expect(notifyCalls).toEqual([]);
      expect(result.actions).toBe(1);
      const state = readStewardState(harness.home.home);
      expect(state.lastAppliedCount).toBe(1);
      expect(state.lastRequestedCount).toBe(0);
    });

    it("§69.3: 配送先解決へ task body の cwd と tenant を渡す", async () => {
      addStewardProfile(harness.deps.config);
      const worktree = "/tmp/hachi-steward-proposal-worktree";
      // binding は張らず、worktree scope の watch だけで解決させる
      const task = harness.store.createTask(
        taskInput({ title: "worktree watch 対象", body: `cwd: ${worktree}` }),
        "tester",
      );
      const watcher = registerOrchestrator("worktree-watcher");
      harness.store.addOrchestratorWatch({
        orchestratorId: watcher.id,
        scope: "worktree",
        selector: worktree,
        role: "primary",
      });
      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "promote", taskId: task.id, reason: "ready 化候補" },
        ])),
        nowFn: () => nowSec,
      });

      await stage.tick(harness.deps, true, nowSec);

      // cwd を渡していなければ配送先0件になり unrouted へ落ちる
      const requests = requestsFor(task.id, "promote");
      expect(requests).toHaveLength(1);
      const deliveries = harness.store.listStewardProposalDeliveries(requests[0]!.id);
      expect(deliveries.map((delivery) => delivery.orchestratorId)).toEqual([watcher.id]);
    });

    it("§69.6: tenant=hachi-kanban の promote は accept されてもタスクを遷移させない", async () => {
      addStewardProfile(harness.deps.config);
      const task = harness.store.createTask(
        taskInput({ title: "自己改変ハザード", tenant: "hachi-kanban" }),
        "tester",
      );
      const owner = registerOrchestrator("hachi-kanban-owner");
      harness.store.bindTaskToOrchestrator(task.id, owner.id, "primary");
      const notifyCalls: string[] = [];
      let currentSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "promote", taskId: task.id, reason: "ready 化候補" },
        ])),
        notifyFn: async (taskId) => {
          notifyCalls.push(taskId);
        },
        nowFn: () => currentSec,
      });

      await stage.tick(harness.deps, true, currentSec);
      const request = requestsFor(task.id, "promote")[0];
      expect(request).toBeDefined();

      // orchestrator が claim → accept まで進める
      harness.store.claimStewardProposalRequest({
        requestId: request!.id,
        orchestratorId: owner.id,
        sessionId: owner.sessionId,
        generation: owner.generation,
        claimToken: "tok-hachi-kanban",
        leaseUntil: currentSec + 600,
        now: currentSec,
      });
      harness.store.acceptStewardProposalRequest({
        requestId: request!.id,
        orchestratorId: owner.id,
        sessionId: owner.sessionId,
        generation: owner.generation,
        claimToken: "tok-hachi-kanban",
        now: currentSec,
      });
      expect(harness.store.getStewardProposalRequest(request!.id)?.status).toBe("accepted");

      // accept 後に steward を再実行しても、supervisor は accept を遷移へ変換しない
      currentSec += 31 * 60;
      await stage.tick(harness.deps, true, currentSec);

      expect(harness.store.getTask(task.id)?.status).toBe("triage");
      expect(notifyCalls).toEqual([]);
    });

    it("LLM parse 失敗時の deterministic done-escalate も request 化し §38 通知を1回だけ出す", async () => {
      addStewardProfile(harness.deps.config);
      // done 整合が壊れた task を作り、binding で配送先を与える
      const task = harness.store.createTask(taskInput({ title: "deterministic escalate 対象" }), "tester");
      harness.store.transition({ taskId: task.id, to: "ready", actor: "tester" });
      harness.store.block(task.id, "codex-in-progress: fixture", "tester");
      harness.store.transition({ taskId: task.id, to: "done", actor: "legacy" });
      harness.store.addEvent(task.id, "verdict_finalized", "legacy", { to: "done" });
      const owner = registerOrchestrator("deterministic-owner");
      harness.store.bindTaskToOrchestrator(task.id, owner.id, "primary");
      const notifyCalls: Array<{ taskId: string; kind: string }> = [];
      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        // フェンス無し出力 → parse 不能 → applyDeterministicDoneEscalations 経路へ入る
        sessionRunner: fakeRunner("フェンスなし出力"),
        notifyFn: async (taskId, _message, kind) => {
          notifyCalls.push({ taskId, kind });
          return true;
        },
        nowFn: () => nowSec,
      });

      await stage.tick(harness.deps, true, nowSec);

      // LLM 経路と同じく request 面へ載る
      expect(requestsFor(task.id, "escalate")).toHaveLength(1);
      // §69.5: escalate は §38 通知を維持し、二重には出さない
      expect(notifyCalls).toEqual([{ taskId: task.id, kind: "escalate" }]);
      // §69.7: parse 失敗経路でも counter が記録される
      const state = readStewardState(harness.home.home);
      expect(state.lastRequestedCount).toBe(1);
      expect(state.lastSuppressedCount).toBe(0);
    });

    // --- routed 経路の §40.4 非回帰（既存 §40.4 test は binding が無く unrouted しか通らない） ---

    it("§40.4 非回帰: routed の promote / archive も steward_proposal イベントを残す", async () => {
      addStewardProfile(harness.deps.config);
      const promoteTask = boundTask({ title: "routed promote" });
      const archiveTask = boundTask({ title: "routed archive" });
      const notifyCalls: string[] = [];
      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "promote", taskId: promoteTask.id, reason: "ready 化候補" },
          { kind: "archive", taskId: archiveTask.id, reason: "陳腐化" },
        ])),
        notifyFn: async (taskId) => {
          notifyCalls.push(taskId);
        },
        nowFn: () => nowSec,
      });

      await stage.tick(harness.deps, true, nowSec);

      // §69.5 が止めたのは §38 通知だけ。§40.4 のイベントは routed でも残る
      expect(notifyCalls).toEqual([]);
      for (const [task, kind] of [[promoteTask, "promote"], [archiveTask, "archive"]] as const) {
        const events = harness.store.listEvents(task.id, "steward_proposal");
        expect(events).toHaveLength(1);
        const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
        expect(payload.kind).toBe(kind);
        // notificationAttempted の明示が §40.4 の 24h 冪等（notify 済みのみ抑止）との境界を保つ
        expect(payload.notificationAttempted).toBe(false);
        expect(payload.requestId).toBe(requestsFor(task.id, kind)[0]!.id);
        // 自動遷移はしない
        expect(harness.store.getTask(task.id)?.status).toBe("triage");
      }
    });

    it("§42.2: routed promote でも telegram の promote 承認 keyboard 判定入力が残る", async () => {
      addStewardProfile(harness.deps.config);
      // user-decision で blocked のタスク。イベントが無いと keyboard が done 承認側へ降格する
      const task = boundTask({ title: "承認 keyboard 対象" });
      harness.store.transition({ taskId: task.id, to: "ready", actor: "tester" });
      harness.store.block(task.id, "user-decision: ready 化してよいか", "tester");
      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "promote", taskId: task.id, reason: "ready 化候補" },
        ])),
        nowFn: () => nowSec,
      });

      await stage.tick(harness.deps, true, nowSec);

      expect(requestsFor(task.id, "promote")).toHaveLength(1);
      const blocked = harness.store.getTask(task.id)!;
      expect(blocked.status).toBe("blocked");
      // notify.ts の resolveTelegramApprovalKind はこの helper の戻り値で steward-promote を選ぶ
      expect(findLatestStewardPromoteProposalEventId(harness.store, blocked)).not.toBeNull();
    });

    it("routed 提案のイベントは done auto-archive の 24h 冪等を誤発火させない", async () => {
      addStewardProfile(harness.deps.config);
      const task = boundTask({ title: "routed の後で done になる" });
      let currentSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "archive", taskId: task.id, reason: "陳腐化" },
        ])),
        nowFn: () => currentSec,
      });

      // 1 tick 目: status!=done なので request 化され、notificationAttempted=false のイベントが残る
      await stage.tick(harness.deps, true, currentSec);
      expect(requestsFor(task.id, "archive")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "steward_proposal")).toHaveLength(1);

      // 2 tick 目: done になった同一タスクの auto-archive（§69.6）は routed イベントに抑止されない
      makeDone(harness, task.id);
      currentSec += 31 * 60;
      await stage.tick(harness.deps, true, currentSec);

      expect(harness.store.getTask(task.id)?.status).toBe("archived");
      expect(harness.store.listEvents(task.id, "steward_auto_archive")).toHaveLength(1);
    });

    it("空白のみの reason を持つ提案は破棄され、tick は落ちずに state を書く", async () => {
      addStewardProfile(harness.deps.config);
      // core の createStewardProposalRequest は空 reason を throw する。ここで弾かないと
      // tick が落ち、writeStewardState へ到達せず auto-disable が働かなくなる
      const task = boundTask({ title: "空 reason 提案" });
      const nowSec = 1_700_000_000;
      const stage = createStewardStage({
        sessionRunner: fakeRunner(stewardFence([
          { kind: "promote", taskId: task.id, reason: "   " },
        ])),
        nowFn: () => nowSec,
      });

      const result = await stage.tick(harness.deps, true, nowSec);

      expect(result.actions).toBe(0);
      expect(harness.store.listStewardProposalRequests()).toEqual([]);
      expect(harness.store.listComments(task.id)).toEqual([]);
      const state = readStewardState(harness.home.home);
      expect(state.lastRunAt).toBe(nowSec);
      expect(state.lastProposalCount).toBe(0);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.autoDisabled).toBe(false);
    });

    it("steward stage は accept/claim の解決 API を一切呼ばない（§69.2 の不変条件）", () => {
      const source = readFileSync(
        new URL("./steward.ts", import.meta.url),
        "utf8",
      );
      // accept を契機にタスクを遷移させる経路を steward stage 側へ作らない
      expect(source).not.toContain("acceptStewardProposalRequest");
      expect(source).not.toContain("claimStewardProposalRequest");
      expect(source).not.toContain("dismissStewardProposalRequest");
      expect(source).not.toContain("deferStewardProposalRequest");
      // 提案発行は createStewardProposalRequest だけ
      expect(source).toContain("createStewardProposalRequest");
      // §69.5 の escalate 再通知は抑止元 request を基準にする。時間窓で判定すると、未解決の
      // request が窓の切り替わりごとに再通知され、durable request が消すはずの通知スパムが戻る
      expect(source).toContain(
        "!hasNotifiedSinceRequest(store, proposal.taskId, routing.blockingRequestId)",
      );
    });
  });
});
