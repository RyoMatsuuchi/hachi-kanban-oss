import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OrchestratorSessionRow } from "@hachi/core";
import { taskInput } from "@hachi/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupHarness, type TestHarness } from "../test-support.js";
import {
  createSessionBudgetMonitorStage,
  type SessionBudgetMonitorNotify,
} from "./session-budget-monitor.js";
import type { OperationalNotifyInput } from "./notify.js";

const CLAUDE_SESSION_ID = "199a85b5-5975-4998-8dc0-9f4d4d29508c";
const UNKNOWN_SESSION_ID = "299a85b5-5975-4998-8dc0-9f4d4d29508c";

describe("session-budget-monitor", () => {
  let harness: TestHarness;
  let projectsRoot: string;
  let notifications: OperationalNotifyInput[];
  let notify: SessionBudgetMonitorNotify;

  beforeEach(async () => {
    harness = await setupHarness();
    projectsRoot = join(harness.home.home, "claude-projects");
    notifications = [];
    notify = (_deps, input) => {
      notifications.push(input);
      return Promise.resolve({ attempted: true, sent: true });
    };
    setBudgetConfig("propose", 1);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function setBudgetConfig(autoHandover: "off" | "propose" | "apply", intervalMinutes: number): void {
    harness.deps.config.orchestrator = {
      sessionBudget: {
        autoHandover,
        monitor: { intervalMinutes },
        contextWindowTokens: 10_000,
        costModel: { c0: 1_000, s: 1 },
      },
    };
  }

  function claudeLogPath(sessionId = CLAUDE_SESSION_ID): string {
    return join(projectsRoot, "-Users-test-worktree", `${sessionId}.jsonl`);
  }

  function seedClaudeLog(contextTokens: number): void {
    const path = claudeLogPath();
    mkdirSync(join(projectsRoot, "-Users-test-worktree"), { recursive: true });
    const row = {
      parentUuid: null,
      isSidechain: false,
      type: "assistant",
      uuid: "usage-row",
      requestId: "usage-request",
      timestamp: "2026-09-03T00:00:00.000Z",
      message: {
        id: "usage-message",
        model: "claude-opus-5",
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: contextTokens - 1,
          output_tokens: 10,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      },
    };
    writeFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
  }

  function setClaudeLogMtime(epochSeconds: number): void {
    utimesSync(claudeLogPath(), epochSeconds, epochSeconds);
  }

  function enableIdleRecommendation(cacheTtlSeconds = 3_600, idleWarnRatio?: number): void {
    const orchestrator = harness.deps.config.orchestrator;
    const sessionBudget = orchestrator?.sessionBudget;
    if (orchestrator === undefined || sessionBudget === undefined) {
      throw new Error("session budget test config がありません");
    }
    sessionBudget.monitor = {
      ...sessionBudget.monitor,
      ...(idleWarnRatio === undefined ? {} : { idleWarnRatio }),
    };
    sessionBudget.costModel = { ...sessionBudget.costModel, cacheTtlSeconds };
    orchestrator.pricing = {
      overrides: {
        "claude-opus-5": {
          inputCostPerToken: 0.01,
          outputCostPerToken: 0.02,
          cacheCreationCostPerToken: 0.02,
          cacheCreation1hCostPerToken: 0.02,
          cacheReadCostPerToken: 0.001,
          source: "session-budget-monitor idle test",
        },
      },
    };
  }

  function startSession(withMission: boolean, providerSessionId = CLAUDE_SESSION_ID): OrchestratorSessionRow {
    const orchestrator = harness.store.registerOrchestrator({
      label: `budget-${providerSessionId}`,
      project: "hachi-kanban",
      repoCommonDir: `/repo/${providerSessionId}.git`,
    });
    if (withMission) {
      const mission = harness.store.createTask(
        taskInput({
          status: "triage",
          title: "session budget mission",
          body: "cwd: /worktrees/session-budget\nミッション",
          tenant: "hachi-kanban",
        }),
        "tester",
      );
      harness.store.addOrchestratorWatch({
        orchestratorId: orchestrator.id,
        scope: "subtree",
        selector: mission.id,
        role: "primary",
      });
    }
    return harness.store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "claude",
      providerSessionId,
    });
  }

  function createStage(): ReturnType<typeof createSessionBudgetMonitorStage> {
    return createSessionBudgetMonitorStage({ nativeUsageRoots: { claudeProjectsRoot: projectsRoot }, notify });
  }

  it("monitor.intervalMinutes 未満では active session を再評価しない", async () => {
    setBudgetConfig("propose", 2);
    seedClaudeLog(1_000);
    startSession(true);
    const stage = createStage();
    const now = 1_800_000_000;

    const first = await stage.tick(harness.deps, true, now);
    const withinInterval = await stage.tick(harness.deps, true, now + 119);
    const dueButUnchanged = await stage.tick(harness.deps, true, now + 120);

    expect(first.actions).toBe(1);
    expect(withinInterval).toMatchObject({ actions: 0, skipped: true });
    expect(dueButUnchanged).toMatchObject({ actions: 0, skipped: false });
    expect(notifications).toHaveLength(1);
    expect(harness.store.listOrchestratorRequests()).toHaveLength(1);
  });

  it("同じ stage/action は窓を超えても再通知せず、変化時だけ通知する", async () => {
    seedClaudeLog(1_000);
    startSession(true);
    const stage = createStage();
    const now = 1_800_000_000;

    await stage.tick(harness.deps, true, now);
    await stage.tick(harness.deps, true, now + 901);
    seedClaudeLog(9_000);
    await stage.tick(harness.deps, true, now + 1_802);

    expect(notifications).toHaveLength(2);
    expect(notifications[0]?.id).toContain(":ok:continue");
    expect(notifications[1]?.id).toContain(":urgent:continue");
    expect(harness.store.listOrchestratorRequests()).toHaveLength(2);
  });

  it("同じ session/stage/action key の再登場だけを 900 秒 dedupe する", async () => {
    seedClaudeLog(1_000);
    startSession(true);
    const stage = createStage();
    const now = 1_800_000_000;

    await stage.tick(harness.deps, true, now);
    seedClaudeLog(9_000);
    const differentKey = await stage.tick(harness.deps, true, now + 60);
    seedClaudeLog(1_000);
    const sameKeyWithinWindow = await stage.tick(harness.deps, true, now + 120);
    seedClaudeLog(9_000);
    await stage.tick(harness.deps, true, now + 961);
    seedClaudeLog(1_000);
    const sameKeyAfterWindow = await stage.tick(harness.deps, true, now + 1_022);

    expect(differentKey.actions).toBe(1);
    expect(sameKeyWithinWindow.notes?.join("\n")).toContain("900秒 dedupe");
    expect(sameKeyAfterWindow.actions).toBe(1);
    expect(notifications).toHaveLength(4);
    expect(harness.store.listOrchestratorRequests()).toHaveLength(4);
  });

  it("mission task が無い session は運用通知だけを送り、観測不能 session は unknown note にする", async () => {
    seedClaudeLog(1_000);
    const session = startSession(false);
    const unknown = startSession(false, UNKNOWN_SESSION_ID);
    const stage = createStage();

    const result = await stage.tick(harness.deps, true, 1_800_000_000);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.id).toBe(`session-budget:${session.id}:ok:continue`);
    expect(harness.store.listOrchestratorRequests()).toEqual([]);
    expect(result.notes).toContain(`session-budget ${unknown.id}: idle skip (native-log-mtime-unavailable)`);
  });

  it("idle が閾値未満なら handoff-before-idle を通知しない", async () => {
    const now = 1_800_000_000;
    enableIdleRecommendation();
    seedClaudeLog(1_000);
    setClaudeLogMtime(now - 1_799);
    startSession(true);

    await createStage().tick(harness.deps, true, now);

    expect(notifications.filter((input) => input.id.includes(":idle:"))).toEqual([]);
    expect(harness.store.listOrchestratorRequests().filter((request) => request.questionId.includes(":idle:"))).toEqual([]);
  });

  it("idle が閾値以上かつ TTL 未満なら handoff-before-idle を 1 回通知する", async () => {
    const now = 1_800_000_000;
    enableIdleRecommendation();
    seedClaudeLog(1_000);
    setClaudeLogMtime(now - 1_800);
    const session = startSession(true);

    await createStage().tick(harness.deps, true, now);

    expect(notifications.filter((input) => input.id.includes(":idle:"))).toEqual([
      expect.objectContaining({ id: `session-budget:${session.id}:idle:handoff-before-idle` }),
    ]);
    expect(harness.store.listOrchestratorRequests().map((request) => request.questionId)).toContain(
      `session-budget:${session.id}:idle:handoff-before-idle:${Math.floor(now / 900)}`,
    );
    expect(JSON.parse(readFileSync(join(harness.home.home, "state", "session-budget-monitor.json"), "utf8"))).toMatchObject({
      idleSessions: {
        [session.id]: {
          stage: "idle",
          action: "handoff-before-idle",
          notifiedAt: now,
          active: true,
        },
      },
    });
  });

  it("idle が TTL 以上なら失効後の handoff-before-idle を通知しない", async () => {
    const now = 1_800_000_000;
    enableIdleRecommendation();
    seedClaudeLog(1_000);
    setClaudeLogMtime(now - 3_600);
    startSession(true);

    await createStage().tick(harness.deps, true, now);

    expect(notifications.filter((input) => input.id.includes(":idle:"))).toEqual([]);
    expect(harness.store.listOrchestratorRequests().filter((request) => request.questionId.includes(":idle:"))).toEqual([]);
  });

  it("idle の再検知は 900 秒 dedupe し、窓を超えた再検知だけ通知する", async () => {
    const now = 1_800_000_000;
    enableIdleRecommendation();
    seedClaudeLog(1_000);
    setClaudeLogMtime(now - 1_800);
    startSession(true);
    const stage = createStage();

    await stage.tick(harness.deps, true, now);
    setClaudeLogMtime(now + 60);
    await stage.tick(harness.deps, true, now + 60);
    setClaudeLogMtime(now + 120 - 1_800);
    const withinWindow = await stage.tick(harness.deps, true, now + 120);
    setClaudeLogMtime(now + 180);
    await stage.tick(harness.deps, true, now + 180);
    setClaudeLogMtime(now + 901 - 1_800);
    await stage.tick(harness.deps, true, now + 901);

    expect(withinWindow.notes?.join("\n")).toContain("idle 900秒 dedupe");
    expect(notifications.filter((input) => input.id.includes(":idle:"))).toHaveLength(2);
    expect(harness.store.listOrchestratorRequests().filter((request) => request.questionId.includes(":idle:"))).toHaveLength(2);
  });

  it("ネイティブログの mtime が不明な session は skip note を 1 回だけ出す", async () => {
    const session = startSession(true, UNKNOWN_SESSION_ID);
    const stage = createStage();
    const now = 1_800_000_000;

    const first = await stage.tick(harness.deps, true, now);
    const second = await stage.tick(harness.deps, true, now + 60);

    expect(first.notes).toContain(`session-budget ${session.id}: idle skip (native-log-mtime-unavailable)`);
    expect(second.notes).not.toContain(`session-budget ${session.id}: idle skip (native-log-mtime-unavailable)`);
    expect(notifications).toEqual([]);
    expect(harness.store.listOrchestratorRequests()).toEqual([]);
  });

  it("autoHandover=apply は warn を出して propose 扱いにし、handover を起動しない", async () => {
    setBudgetConfig("apply", 1);
    seedClaudeLog(1_000);
    startSession(false);
    const launch = vi.spyOn(harness.deps.adapters.claude, "launch");
    const stage = createStage();

    const result = await stage.tick(harness.deps, true, 1_800_000_000);

    expect(launch).not.toHaveBeenCalled();
    expect(result.notes).toContain("session-budget autoHandover=apply は未実装。propose 扱いにします");
    expect(readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8")).toContain(
      "session-budget autoHandover=apply は未実装。propose 扱いにします",
    );
  });

  it("dry-run は判定結果だけを返し、state・request・通知を作らない", async () => {
    seedClaudeLog(1_000);
    startSession(true);
    const stage = createStage();

    const result = await stage.tick(harness.deps, false, 1_800_000_000);

    expect(result.actions).toBe(1);
    expect(result.notes?.join("\n")).toContain("dry-run");
    expect(notifications).toEqual([]);
    expect(harness.store.listOrchestratorRequests()).toEqual([]);
    expect(existsSync(join(harness.home.home, "state", "session-budget-monitor.json"))).toBe(false);
  });
});
