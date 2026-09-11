import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import {
  assessOrchestratorSession,
  DEFAULT_SESSION_BOOT_GENERATIONS,
  DEFAULT_SESSION_BOOT_OVERHEAD_USD,
  DEFAULT_SESSION_CACHE_TTL_SECONDS,
  DEFAULT_SESSION_TURNS_PER_TASK,
} from "./orchestrator-session-assessment.js";
import type {
  HachiConfig,
  OrchestratorSessionRow,
  SessionBudgetCostModelOverride,
  SessionUsageProfileRow,
} from "./types.js";
import type { MainSessionUsage } from "./usage.js";

const NOW = 1_800_000_000;
const MODEL = "assessment-test-model";

function config(costModel: SessionBudgetCostModelOverride = {}): HachiConfig {
  return {
    profiles: {},
    allowlist: { codex: [], claude: [] },
    resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
    defaultProfile: "",
    orchestrator: {
      sessionBudget: { costModel },
      pricing: {
        overrides: {
          [MODEL]: {
            inputCostPerToken: 0.005,
            outputCostPerToken: 0.02,
            cacheCreationCostPerToken: 0.008,
            cacheCreation1hCostPerToken: 0.01,
            cacheReadCostPerToken: 0.01,
            source: "assessment test",
          },
        },
      },
    },
  };
}

function usage(contextTokens: number, effort: MainSessionUsage["contextEffort"] = "high"): MainSessionUsage {
  return {
    turns: 10,
    inputTokens: contextTokens,
    contextTokens,
    contextModel: MODEL,
    contextEffort: effort,
    elapsedMs: 1_000,
    perModel: [{
      model: MODEL,
      inputTokens: 10,
      outputTokens: 10,
      cacheCreationTokens: 0,
      cacheReadTokens: 10,
    }],
    perExecution: [],
    turnSeries: [],
  };
}

describe("assessOrchestratorSession（契約 §77.5〜§77.7, §77.10）", () => {
  let store: SqliteKanbanStore;
  let session: OrchestratorSessionRow;

  beforeEach(() => {
    store = new SqliteKanbanStore(":memory:");
    const orchestrator = store.registerOrchestrator({
      label: "assessment",
      project: "hachi",
      repoCommonDir: "/repo/.git",
    });
    session = store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "claude",
      providerSessionId: "provider-session",
    });
  });

  afterEach(() => {
    store.close();
  });

  function addBootSample(
    id: string,
    contextAtTurn15: number | null,
    bootOverheadUsd: number | null,
    createdAt: number,
  ): void {
    store.upsertSessionBootSample({
      orchestratorId: session.orchestratorId,
      sessionId: id,
      providerSessionId: `provider-${id}`,
      provider: "claude",
      model: MODEL,
      contextAtTurn15,
      bootOverheadUsd,
      provenance: "turnSeries@v1;test",
      createdAt,
      updatedAt: createdAt,
    });
  }

  function addProfile(effort: "medium" | "high", measured: boolean, multiplier: number): void {
    const row: SessionUsageProfileRow = {
      provider: "claude",
      model: MODEL,
      effort,
      turns: measured ? 30 : 29,
      measured,
      cacheReadPerTurn: 100 * multiplier,
      cacheWrite5mPerTurn: 10 * multiplier,
      cacheWrite1hPerTurn: 20 * multiplier,
      outputPerTurn: 5 * multiplier,
      reasoningPerTurn: 1,
      contextGrowthPerTurn: 1,
      sourceSessionIds: ["provider-session"],
      computedFromRef: "turnSeries@v1",
      updatedAt: NOW,
    };
    store.upsertSessionUsageProfile(row);
  }

  it("C0 と boot overhead は直近 K 世代の中央値を使い、標本 0 なら config へ縮退する", () => {
    const fallback = assessOrchestratorSession(
      session,
      usage(200),
      store,
      config({ c0: 100, bootOverheadUsd: 0.5 }),
      "api",
      NOW,
    );
    expect(fallback.costModel).toMatchObject({
      c0: 100,
      c0Source: "config",
      s: 1.5,
      sSource: "config",
      bootOverheadUsd: 0.5,
      bootOverheadSource: "config",
      writePriceUsdPerToken: 0.01,
      writePriceSource: "cacheCreation1h",
      generations: DEFAULT_SESSION_BOOT_GENERATIONS,
    });
    expect(fallback.recommendation).toMatchObject({
      action: "continue",
      reasons: ["R<N"],
    });

    addBootSample("os-old", 100, 1, NOW - 2);
    addBootSample("os-middle", 200, null, NOW - 1);
    addBootSample("os-new", null, 3, NOW);
    const measured = assessOrchestratorSession(session, usage(300), store, config(), "api", NOW);
    expect(measured.costModel).toMatchObject({
      c0: 150,
      c0Source: "measured",
      s: 3.5,
      sSource: "measured",
      bootOverheadUsd: 2,
      bootOverheadSource: "measured",
    });
  });

  it("idle の write 単価を TTL ごとに解決し、節約額の符号で action を決める", () => {
    const oneHour = assessOrchestratorSession(
      session,
      usage(200),
      store,
      config({ c0: 100, bootOverheadUsd: 0.5 }),
      "api",
      NOW,
    );
    expect(oneHour.recommendation.idle).toEqual({
      ttlSeconds: DEFAULT_SESSION_CACHE_TTL_SECONDS,
      rewriteUsd: 2,
      savingsUsd: 0.5,
      action: "handoff-before-idle",
    });

    const fiveMinutes = assessOrchestratorSession(
      session,
      usage(200),
      store,
      config({ c0: 100, bootOverheadUsd: 0.5, cacheTtlSeconds: 300 }),
      "api",
      NOW,
    );
    expect(fiveMinutes.recommendation.idle).toMatchObject({
      ttlSeconds: 300,
      action: "handoff-before-idle",
    });
    expect(fiveMinutes.recommendation.idle.rewriteUsd).toBeCloseTo(1.6, 12);
    expect(fiveMinutes.recommendation.idle.savingsUsd).toBeCloseTo(0.1, 12);

    const inputFallbackConfig = config({ c0: 100, bootOverheadUsd: 0.5, cacheTtlSeconds: 300 });
    inputFallbackConfig.orchestrator!.pricing!.overrides![MODEL] = {
      inputCostPerToken: 0.005,
      outputCostPerToken: 0.02,
      cacheCreationCostPerToken: null,
      cacheCreation1hCostPerToken: null,
      cacheReadCostPerToken: 0.01,
      source: "assessment input fallback test",
    };
    const inputFallback = assessOrchestratorSession(
      session,
      usage(200),
      store,
      inputFallbackConfig,
      "api",
      NOW,
    );
    expect(inputFallback.recommendation.idle).toEqual({
      ttlSeconds: 300,
      rewriteUsd: 1,
      savingsUsd: 0,
      action: "continue",
    });
  });

  it("legacy costModel.s は導出 S だけを上書きし source を明示する", () => {
    const assessment = assessOrchestratorSession(
      session,
      usage(200),
      store,
      config({ c0: 100, s: 7, bootOverheadUsd: 0.5 }),
      "api",
      NOW,
    );
    expect(assessment.costModel).toMatchObject({ s: 7, sSource: "config-legacy" });
    expect(assessment.recommendation.nSource.sSource).toBe("config-legacy");
  });

  it("書込単価を解決できなければ S/N を未計測のままにして推奨へ使わない", () => {
    const unpricedUsage = usage(200);
    unpricedUsage.contextModel = "unpriced-model";
    unpricedUsage.perModel = [{
      model: "unpriced-model",
      inputTokens: 10,
      outputTokens: 10,
      cacheCreationTokens: 0,
      cacheReadTokens: 10,
    }];
    const assessment = assessOrchestratorSession(
      session,
      unpricedUsage,
      store,
      config({ c0: 100 }),
      "api",
      NOW,
    );
    expect(assessment.costModel).toMatchObject({ s: null, sSource: "unmeasured" });
    expect(assessment.recommendation).toMatchObject({
      action: "continue",
      n: null,
      reasons: ["N-unmeasured"],
      idle: {
        ttlSeconds: DEFAULT_SESSION_CACHE_TTL_SECONDS,
        rewriteUsd: null,
        savingsUsd: null,
        action: "continue",
      },
    });
  });

  it("過去モデルの credits 単価が欠けても現在モデルの S/r から N と推奨を算出する", () => {
    const readyTasks = ["a", "b"].map((suffix) => store.createTask(
      { title: `ready-${suffix}`, body: `cwd: /repo/${suffix}`, tenant: "dev", status: "ready" },
      "test",
    ));
    for (const task of readyTasks) {
      store.bindTaskToOrchestrator(task.id, session.orchestratorId, "primary");
    }
    const mixedUsage = usage(176_561);
    mixedUsage.perModel.push({
      model: "past-unpriced-model",
      inputTokens: 10,
      outputTokens: 10,
      cacheCreationTokens: 0,
      cacheReadTokens: 10,
    });
    const chatgptConfig = config({ c0: 100, bootOverheadUsd: 0.4 });
    chatgptConfig.orchestrator = {
      ...chatgptConfig.orchestrator,
      pricing: {
        codexCreditUsdRate: 0.25,
        codexCredits: {
          [MODEL]: { input: 2, cached: 1, output: 4, source: "assessment test" },
        },
      },
    };

    const assessment = assessOrchestratorSession(
      { ...session, provider: "codex" },
      mixedUsage,
      store,
      chatgptConfig,
      "chatgpt",
      NOW,
    );
    const expectedN = (100 * 0.5e-6 + 0.4) / ((176_561 - 100) * 0.25e-6);

    expect(assessment.effectiveCostCredits).toBeUndefined();
    expect(assessment.effectiveCostUsd).toBeUndefined();
    expect(assessment.unpricedModels).toEqual(["past-unpriced-model"]);
    expect(assessment.handoffCacheReadPrice).toEqual({
      cacheReadCostPerToken: 0.25e-6,
      source: "context-model",
    });
    expect(assessment.recommendation).toMatchObject({
      action: "handoff-at-boundary",
      n: expectedN,
      r: 16,
      reasons: ["R>=N"],
    });
    expect(assessment.evaluation.axes.find((axis) => axis.axis === "handoffValue")?.unmeasured).toBeUndefined();
    expect(assessment.evaluation.axes.find((axis) => axis.axis === "effectiveCostUsd")?.unmeasured).toEqual({
      reason: "codex-credit-ledger-unpriced",
    });
  });

  it("scoped な todo/ready/review/in-progress と未処理 inbox から R と重複のない内訳を作る", () => {
    const todo = store.createTask(
      { title: "todo", body: "cwd: /repo/todo", tenant: "dev", status: "todo" },
      "test",
    );
    const titleMission = store.createTask(
      { title: "[mission] title root", body: "cwd: /repo/title-mission", tenant: "dev", status: "todo" },
      "test",
    );
    const watchMission = store.createTask(
      { title: "watch root", body: "cwd: /repo/watch-mission", tenant: "dev", status: "todo" },
      "test",
    );
    const triage = store.createTask(
      { title: "triage", body: "cwd: /repo/triage", tenant: "dev", status: "triage" },
      "test",
    );
    const ready = store.createTask(
      { title: "ready", body: "cwd: /repo/a", tenant: "dev", status: "ready" },
      "test",
    );
    const review = store.createTask(
      { title: "review", body: "cwd: /repo/b", tenant: "dev", status: "ready" },
      "test",
    );
    store.block(review.id, "review-required: test", "test");
    store.transition({ taskId: review.id, to: "review", actor: "test" });
    const inProgress = store.createTask(
      { title: "in progress", body: "cwd: /repo/c", tenant: "dev", status: "ready" },
      "test",
    );
    store.block(inProgress.id, "codex-in-progress: test", "supervisor");
    const outside = store.createTask(
      { title: "outside", body: "cwd: /repo/d", tenant: "dev", status: "ready" },
      "test",
    );
    for (const task of [todo, titleMission, triage, ready, review, inProgress]) {
      store.bindTaskToOrchestrator(task.id, session.orchestratorId, "primary");
    }
    store.addOrchestratorWatch({
      orchestratorId: session.orchestratorId,
      scope: "subtree",
      selector: watchMission.id,
      role: "primary",
    });
    store.createOrGetOrchestratorRequest({
      taskId: ready.id,
      questionId: "question-1",
      question: "確認",
    });

    const boundary = assessOrchestratorSession(
      session,
      usage(110),
      store,
      config({ c0: 100, bootOverheadUsd: 0.5 }),
      "api",
      NOW,
    );
    expect(boundary.remaining).toEqual({
      r: 34,
      rBasis: "scoped-with-todo",
      breakdown: { todo: 1, ready: 1, inProgress: 1, review: 1, inbox: 1 },
      turnsPerTask: DEFAULT_SESSION_TURNS_PER_TASK,
      inboxTurnsPerRequest: 2,
      todoTaskCount: 1,
      readyTaskCount: 1,
      reviewTaskCount: 1,
      inProgressTaskCount: 1,
      scopedTaskCount: 4,
      pendingInboxRequestCount: 1,
    });
    expect(boundary.recommendation).toMatchObject({
      action: "handoff-at-boundary",
      n: 15,
      r: 34,
      reasons: ["R>=N"],
    });
    expect(boundary.remaining.scopedTaskCount).toBe(
      boundary.remaining.breakdown.todo
      + boundary.remaining.breakdown.ready
      + boundary.remaining.breakdown.inProgress
      + boundary.remaining.breakdown.review,
    );
    expect(boundary.remaining.scopedTaskCount).not.toBe(7);
    expect(outside.id).not.toBe("");

    const urgent = assessOrchestratorSession(
      session,
      usage(250),
      store,
      config({ c0: 100, bootOverheadUsd: 0.5 }),
      "api",
      NOW,
    );
    expect(urgent.evaluation.stage).toBe("urgent");
    expect(urgent.recommendation).toMatchObject({
      action: "handoff-now",
      n: 1,
      reasons: ["R>=2N", "stage=urgent"],
    });
  });

  it("同一 model の現在 effort と低い effort が両方 measured の場合だけ USD/turn 差を返す", () => {
    addProfile("high", true, 2);
    addProfile("medium", false, 1);
    expect(
      assessOrchestratorSession(session, usage(200, "high"), store, config(), "api", NOW).effortAdvisory,
    ).toBeNull();

    addProfile("medium", true, 1);
    const advisory = assessOrchestratorSession(
      session,
      usage(200, "high"),
      store,
      config(),
      "api",
      NOW,
    ).effortAdvisory;
    expect(advisory).toMatchObject({
      model: MODEL,
      currentEffort: "high",
      suggestedEffort: "medium",
      priceSource: "override",
    });
    expect(advisory?.savingsUsdPerTurn).toBeCloseTo(advisory?.suggested.totalUsd ?? Number.NaN, 12);
  });

  it("既定値は boot overhead / generations / turnsPerTask だけで S 定数を持たない", () => {
    const assessment = assessOrchestratorSession(session, usage(200), store, config(), "api", NOW);
    expect(assessment.costModel.bootOverheadUsd).toBe(DEFAULT_SESSION_BOOT_OVERHEAD_USD);
    expect(assessment.costModel.generations).toBe(DEFAULT_SESSION_BOOT_GENERATIONS);
    expect(assessment.remaining.turnsPerTask).toBe(DEFAULT_SESSION_TURNS_PER_TASK);
    expect(assessment.costModel.s).toBe(101_231 * 0.01 + DEFAULT_SESSION_BOOT_OVERHEAD_USD);
  });
});
