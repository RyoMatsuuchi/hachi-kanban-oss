import {
  computeContextSaturation,
  computeHandoffBreakEvenTurns,
  DEFAULT_SESSION_BUDGET_C0,
  evaluateSessionBudget,
  HANDOFF_CACHE_READ_USD_PER_TOKEN,
  resolveSessionBudgetThresholds,
  type SessionBudgetAxis,
  type SessionBudgetEvaluation,
  type SessionBudgetStage,
} from "./orchestrator-session-budget.js";
import type { CodexLedger } from "./codex-ledger.js";
import type { MainSessionUsage } from "./usage.js";
import {
  estimateCostUsd,
  PRICE_TABLE_REF,
  resolveHandoffCacheReadPrice,
  resolveModelPrice,
  type HandoffCacheReadPriceResolution,
  type ModelPrice,
  type ModelPriceSource,
  type ModelTokenUsage,
} from "./usage-pricing.js";
import type {
  CodexCreditsPerMTok,
  EffortLevel,
  HachiConfig,
  KanbanStore,
  OrchestratorSessionRow,
  Provider,
  SessionBudgetAxisUnmeasuredReason,
  SessionUsageProfileRow,
} from "./types.js";

export const DEFAULT_SESSION_BOOT_OVERHEAD_USD = 0.40;
export const DEFAULT_SESSION_BOOT_GENERATIONS = 5;
export const DEFAULT_SESSION_TURNS_PER_TASK = 8;
export const DEFAULT_SESSION_CACHE_TTL_SECONDS = 3_600;
const INBOX_TURNS_PER_REQUEST = 2;
const EFFORT_ORDER: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export type SessionAssessmentC0Source = "measured" | "config";
export type SessionAssessmentSSource = "measured" | "config" | "config-legacy" | "unmeasured";
export type SessionAssessmentWritePriceSource = "cacheCreation1h" | "cacheCreation5m" | "input";
export type SessionAssessmentRecommendationAction = "continue" | "handoff-at-boundary" | "handoff-now";
export type SessionAssessmentIdleAction = "continue" | "handoff-before-idle";

export interface OrchestratorSessionAssessmentCostModel {
  c0: number;
  c0Source: SessionAssessmentC0Source;
  /** 導出不能は null。0 で埋めない。 */
  s: number | null;
  sSource: SessionAssessmentSSource;
  bootOverheadUsd: number;
  bootOverheadSource: "measured" | "config";
  writePriceUsdPerToken: number | null;
  writePriceSource: SessionAssessmentWritePriceSource | null;
  priceSource: ModelPriceSource | "codex-credits" | null;
  generations: number;
}

export interface OrchestratorSessionRemainingWork {
  r: number;
  rBasis: "scoped-with-todo";
  breakdown: {
    todo: number;
    ready: number;
    inProgress: number;
    review: number;
    inbox: number;
  };
  turnsPerTask: number;
  inboxTurnsPerRequest: 2;
  todoTaskCount: number;
  readyTaskCount: number;
  reviewTaskCount: number;
  inProgressTaskCount: number;
  scopedTaskCount: number;
  pendingInboxRequestCount: number;
}

export interface OrchestratorSessionRecommendation {
  action: SessionAssessmentRecommendationAction;
  n: number | null;
  r: number;
  model: string | null;
  effort: EffortLevel | null;
  nSource: {
    c0Source: SessionAssessmentC0Source;
    sSource: SessionAssessmentSSource;
    priceSource: HandoffCacheReadPriceResolution["source"] | null;
  };
  reasons: string[];
  idle: {
    ttlSeconds: number;
    rewriteUsd: number | null;
    savingsUsd: number | null;
    action: SessionAssessmentIdleAction;
  };
}

export interface SessionEffortCostPerTurn {
  effort: EffortLevel;
  cacheReadUsd: number;
  cacheWrite5mUsd: number;
  cacheWrite1hUsd: number;
  outputUsd: number;
  totalUsd: number;
}

export interface OrchestratorSessionEffortAdvisory {
  model: string;
  currentEffort: EffortLevel;
  suggestedEffort: EffortLevel;
  savingsUsdPerTurn: number;
  current: SessionEffortCostPerTurn;
  suggested: SessionEffortCostPerTurn;
  priceSource: ModelPriceSource | "codex-credits";
}

export interface OrchestratorSessionAssessment {
  assessedAt: number;
  contextWindowTokens: number | undefined;
  costModel: OrchestratorSessionAssessmentCostModel;
  effectiveCostUsd: number | undefined;
  effectiveCostCredits: number | undefined;
  priceSource: ModelPriceSource | "codex-credits" | undefined;
  priceTableRef: string | undefined;
  ledger: CodexLedger;
  unpricedModels: string[];
  handoffCacheReadPrice: HandoffCacheReadPriceResolution | null;
  evaluation: SessionBudgetEvaluation;
  remaining: OrchestratorSessionRemainingWork;
  recommendation: OrchestratorSessionRecommendation;
  effortAdvisory: OrchestratorSessionEffortAdvisory | null;
}

export type OrchestratorSessionAssessmentStore = Pick<
  KanbanStore,
  | "listSessionBootSamples"
  | "listSessionUsageProfiles"
  | "listScopedTasks"
  | "listInProgress"
  | "isOrchestratorScopedToTask"
  | "listOrchestratorWatches"
  | "listOrchestratorRequests"
>;

interface ResolvedAssessmentPrice {
  price: ModelPrice;
  priceSource: ModelPriceSource | "codex-credits";
}

interface CodexCreditEstimate {
  credits: number | undefined;
  unpricedModels: string[];
}

function ownEntry<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} は正数が必須です: ${value}`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} は1以上の整数が必須です: ${value}`);
  }
  return value;
}

function dominantModel(perModel: readonly ModelTokenUsage[]): string | null {
  if (perModel.length === 0) {
    return null;
  }
  const activity = (usage: ModelTokenUsage): number =>
    usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  const dominant = perModel.reduce((max, usage) => (activity(usage) > activity(max) ? usage : max));
  return activity(dominant) > 0 ? dominant.model : null;
}

function resolveAssessmentPrice(
  provider: Provider,
  model: string,
  ledger: CodexLedger,
  config: HachiConfig,
): ResolvedAssessmentPrice | null {
  const pricing = config.orchestrator?.pricing;
  if (provider === "codex" && ledger === "chatgpt") {
    const creditRate = pricing?.codexCreditUsdRate;
    const credits = ownEntry(pricing?.codexCredits, model);
    if (creditRate === undefined || credits === undefined) {
      return null;
    }
    return {
      price: {
        inputCostPerToken: credits.input * creditRate / 1_000_000,
        outputCostPerToken: credits.output * creditRate / 1_000_000,
        cacheCreationCostPerToken: null,
        cacheCreation1hCostPerToken: null,
        cacheReadCostPerToken: credits.cached * creditRate / 1_000_000,
      },
      priceSource: "codex-credits",
    };
  }
  return resolveModelPrice(model, pricing?.overrides);
}

function resolveWritePrice(resolved: ResolvedAssessmentPrice | null, ttlSeconds: number): {
  usdPerToken: number | null;
  source: SessionAssessmentWritePriceSource | null;
} {
  if (resolved === null) {
    return { usdPerToken: null, source: null };
  }
  if (ttlSeconds >= DEFAULT_SESSION_CACHE_TTL_SECONDS && resolved.price.cacheCreation1hCostPerToken !== null) {
    return { usdPerToken: resolved.price.cacheCreation1hCostPerToken, source: "cacheCreation1h" };
  }
  if (resolved.price.cacheCreationCostPerToken !== null) {
    return { usdPerToken: resolved.price.cacheCreationCostPerToken, source: "cacheCreation5m" };
  }
  return { usdPerToken: resolved.price.inputCostPerToken, source: "input" };
}

function idleRecommendationFor(
  contextTokens: number,
  s: number | null,
  ttlSeconds: number,
  writePriceUsdPerToken: number | null,
): OrchestratorSessionRecommendation["idle"] {
  if (s === null || writePriceUsdPerToken === null) {
    return { ttlSeconds, rewriteUsd: null, savingsUsd: null, action: "continue" };
  }
  const rewriteUsd = contextTokens * writePriceUsdPerToken;
  const savingsUsd = rewriteUsd - s;
  return {
    ttlSeconds,
    rewriteUsd,
    savingsUsd,
    action: savingsUsd > 0 ? "handoff-before-idle" : "continue",
  };
}

function estimateCodexCredits(
  perModel: readonly ModelTokenUsage[],
  prices: Readonly<Record<string, CodexCreditsPerMTok>> | undefined,
): CodexCreditEstimate {
  const unpricedModels: string[] = [];
  let credits = 0;
  for (const usage of perModel) {
    const price = ownEntry(prices, usage.model);
    if (price === undefined || usage.cacheCreationTokens !== 0) {
      unpricedModels.push(usage.model);
      continue;
    }
    credits += (
      usage.inputTokens * price.input
      + usage.cacheReadTokens * price.cached
      + usage.outputTokens * price.output
    ) / 1_000_000;
  }
  if (unpricedModels.length > 0) {
    return { credits: undefined, unpricedModels: [...new Set(unpricedModels)].sort() };
  }
  return { credits, unpricedModels: [] };
}

function resolveCodexCreditCacheReadPrice(
  contextModel: string | undefined,
  perModel: readonly ModelTokenUsage[],
  config: HachiConfig,
): HandoffCacheReadPriceResolution | null {
  const rate = config.orchestrator?.pricing?.codexCreditUsdRate;
  const prices = config.orchestrator?.pricing?.codexCredits;
  if (rate === undefined) {
    return null;
  }
  const resolve = (model: string, source: "context-model" | "dominant"): HandoffCacheReadPriceResolution | null => {
    const price = ownEntry(prices, model);
    return price === undefined
      ? null
      : { cacheReadCostPerToken: price.cached * rate / 1_000_000, source };
  };
  if (contextModel !== undefined) {
    const contextPrice = resolve(contextModel, "context-model");
    if (contextPrice !== null) {
      return contextPrice;
    }
  }
  const dominant = dominantModel(perModel);
  return dominant === null ? null : resolve(dominant, "dominant");
}

function resolveRemainingWork(
  store: OrchestratorSessionAssessmentStore,
  orchestratorId: string,
  turnsPerTask: number,
): OrchestratorSessionRemainingWork {
  const todoTasks = store.listScopedTasks({ orchestratorId, status: "todo" });
  const readyTasks = store.listScopedTasks({ orchestratorId, status: "ready" });
  const reviewTasks = store.listScopedTasks({ orchestratorId, status: "review" });
  const inProgressTasks = store.listInProgress()
    .filter((task) => store.isOrchestratorScopedToTask(orchestratorId, task.id));
  // session-budget-monitor と同じ解決で、優先順の最初の非 observer subtree watch をミッションとする。
  const missionTaskId = store.listOrchestratorWatches(orchestratorId)
    .find((watch) => watch.active && watch.scope === "subtree" && watch.role !== "observer")
    ?.selector;
  const scopedTaskIds = new Set<string>();
  const countUniqueTasks = (tasks: typeof todoTasks): number => {
    let count = 0;
    for (const task of tasks) {
      if (task.title.startsWith("[mission]") || task.id === missionTaskId || scopedTaskIds.has(task.id)) {
        continue;
      }
      scopedTaskIds.add(task.id);
      count += 1;
    }
    return count;
  };
  const todoTaskCount = countUniqueTasks(todoTasks);
  const readyTaskCount = countUniqueTasks(readyTasks);
  const inProgressTaskCount = countUniqueTasks(inProgressTasks);
  const reviewTaskCount = countUniqueTasks(reviewTasks);
  const pendingInboxRequestCount = store.listOrchestratorRequests(orchestratorId)
    .filter((request) =>
      request.kind !== "session_budget"
      && (request.status === "queued" || request.status === "delivered"),
    ).length;
  return {
    r: scopedTaskIds.size * turnsPerTask + pendingInboxRequestCount * INBOX_TURNS_PER_REQUEST,
    rBasis: "scoped-with-todo",
    breakdown: {
      todo: todoTaskCount,
      ready: readyTaskCount,
      inProgress: inProgressTaskCount,
      review: reviewTaskCount,
      inbox: pendingInboxRequestCount,
    },
    turnsPerTask,
    inboxTurnsPerRequest: INBOX_TURNS_PER_REQUEST,
    todoTaskCount,
    readyTaskCount,
    reviewTaskCount,
    inProgressTaskCount,
    scopedTaskCount: scopedTaskIds.size,
    pendingInboxRequestCount,
  };
}

function recommendationFor(
  n: number | undefined,
  remaining: OrchestratorSessionRemainingWork,
  stage: SessionBudgetStage | null,
  model: string | null,
  effort: EffortLevel | null,
  costModel: OrchestratorSessionAssessmentCostModel,
  handoffCacheReadPrice: HandoffCacheReadPriceResolution | null,
  idle: OrchestratorSessionRecommendation["idle"],
): OrchestratorSessionRecommendation {
  let action: SessionAssessmentRecommendationAction;
  let reasons: string[];
  if (n === undefined) {
    action = "continue";
    reasons = costModel.s === null || handoffCacheReadPrice === null
      ? ["N-unmeasured"]
      : ["N-undefined"];
  } else if (remaining.r >= 2 * n && stage === "urgent") {
    action = "handoff-now";
    reasons = ["R>=2N", "stage=urgent"];
  } else if (remaining.r >= n) {
    action = "handoff-at-boundary";
    reasons = ["R>=N"];
  } else {
    action = "continue";
    reasons = ["R<N"];
  }
  return {
    action,
    n: n ?? null,
    r: remaining.r,
    model,
    effort,
    nSource: {
      c0Source: costModel.c0Source,
      sSource: costModel.sSource,
      priceSource: handoffCacheReadPrice?.source ?? null,
    },
    reasons,
    idle,
  };
}

function pricedComponent(price: number | null, amount: number): number | null {
  if (price !== null) {
    return price * amount;
  }
  return amount === 0 ? 0 : null;
}

function profileCost(
  profile: SessionUsageProfileRow,
  resolved: ResolvedAssessmentPrice,
): SessionEffortCostPerTurn | null {
  if (profile.effort === null) {
    return null;
  }
  const cacheReadUsd = pricedComponent(resolved.price.cacheReadCostPerToken, profile.cacheReadPerTurn);
  const cacheWrite5mUsd = pricedComponent(
    resolved.price.cacheCreationCostPerToken,
    profile.cacheWrite5mPerTurn,
  );
  const cacheWrite1hUsd = pricedComponent(
    resolved.price.cacheCreation1hCostPerToken,
    profile.cacheWrite1hPerTurn,
  );
  if (cacheReadUsd === null || cacheWrite5mUsd === null || cacheWrite1hUsd === null) {
    return null;
  }
  const outputUsd = profile.outputPerTurn * resolved.price.outputCostPerToken;
  return {
    effort: profile.effort,
    cacheReadUsd,
    cacheWrite5mUsd,
    cacheWrite1hUsd,
    outputUsd,
    totalUsd: cacheReadUsd + cacheWrite5mUsd + cacheWrite1hUsd + outputUsd,
  };
}

function resolveEffortAdvisory(
  store: OrchestratorSessionAssessmentStore,
  provider: Provider,
  model: string | null,
  currentEffort: EffortLevel | null,
  ledger: CodexLedger,
  config: HachiConfig,
): OrchestratorSessionEffortAdvisory | null {
  if (model === null || currentEffort === null) {
    return null;
  }
  const currentRank = EFFORT_ORDER.indexOf(currentEffort);
  const profiles = store.listSessionUsageProfiles({ provider, model });
  const currentProfile = profiles.find((profile) => profile.effort === currentEffort && profile.measured);
  const resolved = resolveAssessmentPrice(provider, model, ledger, config);
  if (currentProfile === undefined || resolved === null) {
    return null;
  }
  const current = profileCost(currentProfile, resolved);
  if (current === null) {
    return null;
  }
  const alternatives = profiles
    .filter((profile): profile is SessionUsageProfileRow & { effort: EffortLevel } =>
      profile.measured
      && profile.effort !== null
      && EFFORT_ORDER.indexOf(profile.effort) < currentRank,
    )
    .sort((a, b) => EFFORT_ORDER.indexOf(b.effort) - EFFORT_ORDER.indexOf(a.effort));
  for (const alternative of alternatives) {
    const suggested = profileCost(alternative, resolved);
    if (suggested === null || suggested.totalUsd >= current.totalUsd) {
      continue;
    }
    return {
      model,
      currentEffort,
      suggestedEffort: alternative.effort,
      savingsUsdPerTurn: current.totalUsd - suggested.totalUsd,
      current,
      suggested,
      priceSource: resolved.priceSource,
    };
  }
  return null;
}

/** 契約 §77.5〜§77.7 のセッション判定を core の単一経路で行う。 */
export function assessOrchestratorSession(
  session: OrchestratorSessionRow,
  mainSession: MainSessionUsage,
  store: OrchestratorSessionAssessmentStore,
  config: HachiConfig,
  ledger: CodexLedger,
  now: number,
): OrchestratorSessionAssessment {
  if (session.provider === "") {
    throw new Error("orchestrator session の provider が未登録です");
  }
  if (!Number.isFinite(now)) {
    throw new Error(`assessment now は有限値が必須です: ${now}`);
  }
  const override = config.orchestrator?.sessionBudget;
  const thresholds = resolveSessionBudgetThresholds(override);
  const configuredCostModel = override?.costModel;
  const generations = positiveInteger(
    configuredCostModel?.generations ?? DEFAULT_SESSION_BOOT_GENERATIONS,
    "orchestrator.sessionBudget.costModel.generations",
  );
  const turnsPerTask = positiveInteger(
    configuredCostModel?.turnsPerTask ?? DEFAULT_SESSION_TURNS_PER_TASK,
    "orchestrator.sessionBudget.costModel.turnsPerTask",
  );
  const cacheTtlSeconds = positiveInteger(
    configuredCostModel?.cacheTtlSeconds ?? DEFAULT_SESSION_CACHE_TTL_SECONDS,
    "orchestrator.sessionBudget.costModel.cacheTtlSeconds",
  );
  const configuredC0 = positiveNumber(
    configuredCostModel?.c0 ?? DEFAULT_SESSION_BUDGET_C0,
    "orchestrator.sessionBudget.costModel.c0",
  );
  const configuredBootOverhead = positiveNumber(
    configuredCostModel?.bootOverheadUsd ?? DEFAULT_SESSION_BOOT_OVERHEAD_USD,
    "orchestrator.sessionBudget.costModel.bootOverheadUsd",
  );
  const legacyS = configuredCostModel?.s === undefined
    ? undefined
    : positiveNumber(configuredCostModel.s, "orchestrator.sessionBudget.costModel.s");
  if (override?.contextWindowTokens !== undefined) {
    positiveInteger(override.contextWindowTokens, "orchestrator.sessionBudget.contextWindowTokens");
  }

  const samples = store.listSessionBootSamples({ orchestratorId: session.orchestratorId, limit: generations });
  const measuredC0 = median(samples.flatMap((sample) =>
    sample.contextAtTurn15 !== null && Number.isFinite(sample.contextAtTurn15) && sample.contextAtTurn15 > 0
      ? [sample.contextAtTurn15]
      : [],
  ));
  const measuredBootOverhead = median(samples.flatMap((sample) =>
    sample.bootOverheadUsd !== null && Number.isFinite(sample.bootOverheadUsd) && sample.bootOverheadUsd >= 0
      ? [sample.bootOverheadUsd]
      : [],
  ));
  const c0 = measuredC0 ?? configuredC0;
  const c0Source: SessionAssessmentC0Source = measuredC0 === null ? "config" : "measured";
  const bootOverheadUsd = measuredBootOverhead ?? configuredBootOverhead;
  const bootOverheadSource = measuredBootOverhead === null ? "config" : "measured";
  const model = mainSession.contextModel ?? dominantModel(mainSession.perModel);
  const effort = mainSession.contextEffort ?? null;
  const resolvedCurrentPrice = model === null
    ? null
    : resolveAssessmentPrice(session.provider, model, ledger, config);
  const writePrice = resolveWritePrice(resolvedCurrentPrice, DEFAULT_SESSION_CACHE_TTL_SECONDS);
  const s = legacyS ?? (writePrice.usdPerToken === null ? null : c0 * writePrice.usdPerToken + bootOverheadUsd);
  const sSource: SessionAssessmentSSource = legacyS !== undefined
    ? "config-legacy"
    : writePrice.usdPerToken === null
      ? "unmeasured"
      : bootOverheadSource;
  const costModel: OrchestratorSessionAssessmentCostModel = {
    c0,
    c0Source,
    s,
    sSource,
    bootOverheadUsd,
    bootOverheadSource,
    writePriceUsdPerToken: writePrice.usdPerToken,
    writePriceSource: writePrice.source,
    priceSource: resolvedCurrentPrice?.priceSource ?? null,
    generations,
  };
  const idleWritePrice = resolveWritePrice(resolvedCurrentPrice, cacheTtlSeconds);
  const idle = idleRecommendationFor(
    mainSession.contextTokens,
    s,
    cacheTtlSeconds,
    idleWritePrice.usdPerToken,
  );

  const pricing = config.orchestrator?.pricing;
  let effectiveCostUsd: number | undefined;
  let effectiveCostCredits: number | undefined;
  let effectivePriceSource: ModelPriceSource | "codex-credits" | undefined;
  let priceTableRef: string | undefined;
  let unpricedModels: string[];
  let handoffCacheReadPrice: HandoffCacheReadPriceResolution | null;
  let unmeasuredReasons: Partial<Record<SessionBudgetAxis, SessionBudgetAxisUnmeasuredReason>> | undefined;
  if (session.provider === "codex" && ledger === "chatgpt") {
    const creditEstimate = estimateCodexCredits(mainSession.perModel, pricing?.codexCredits);
    effectiveCostCredits = creditEstimate.credits;
    effectivePriceSource = "codex-credits";
    priceTableRef = undefined;
    unpricedModels = creditEstimate.unpricedModels;
    handoffCacheReadPrice = resolveCodexCreditCacheReadPrice(
      mainSession.contextModel,
      mainSession.perModel,
      config,
    );
    const creditUsdRate = pricing?.codexCreditUsdRate;
    if (creditEstimate.credits !== undefined && creditUsdRate !== undefined) {
      effectiveCostUsd = creditEstimate.credits * creditUsdRate;
    } else {
      effectiveCostUsd = undefined;
      unmeasuredReasons = {
        effectiveCostUsd: "codex-credit-ledger-unpriced",
      };
    }
    if (s === null || handoffCacheReadPrice === null) {
      unmeasuredReasons = {
        ...unmeasuredReasons,
        handoffValue: "codex-credit-ledger-unpriced",
      };
    }
  } else {
    const costEstimate = estimateCostUsd(mainSession.perModel, pricing?.overrides);
    effectiveCostUsd = costEstimate.priced ? costEstimate.usd : undefined;
    effectiveCostCredits = undefined;
    effectivePriceSource = costEstimate.priced ? costEstimate.priceSource : undefined;
    priceTableRef = costEstimate.priced ? costEstimate.priceTableRef : undefined;
    unpricedModels = costEstimate.priced ? [] : costEstimate.unpricedModels;
    handoffCacheReadPrice = resolveHandoffCacheReadPrice(
      mainSession.contextModel,
      mainSession.perModel,
      HANDOFF_CACHE_READ_USD_PER_TOKEN,
      pricing?.overrides,
    );
    if (s === null) {
      unmeasuredReasons = { handoffValue: "cost-model-unpriced" };
    }
  }
  const n = s === null || handoffCacheReadPrice === null
    ? undefined
    : computeHandoffBreakEvenTurns(
        mainSession.contextTokens,
        { c0, s },
        handoffCacheReadPrice.cacheReadCostPerToken,
      );
  const contextWindowTokens = mainSession.contextWindowTokens ?? override?.contextWindowTokens;
  const evaluation = evaluateSessionBudget({
    turns: mainSession.turns,
    contextSaturation: computeContextSaturation(mainSession.contextTokens, contextWindowTokens),
    handoffValue: n,
    effectiveCostUsd,
  }, thresholds, unmeasuredReasons);
  const remaining = resolveRemainingWork(store, session.orchestratorId, turnsPerTask);
  const recommendation = recommendationFor(
    n,
    remaining,
    evaluation.stage,
    model,
    effort,
    costModel,
    handoffCacheReadPrice,
    idle,
  );
  return {
    assessedAt: now,
    contextWindowTokens,
    costModel,
    effectiveCostUsd,
    effectiveCostCredits,
    priceSource: effectivePriceSource,
    priceTableRef: priceTableRef ?? (effectivePriceSource === "table" ? PRICE_TABLE_REF : undefined),
    ledger,
    unpricedModels,
    handoffCacheReadPrice,
    evaluation,
    remaining,
    recommendation,
    effortAdvisory: resolveEffortAdvisory(store, session.provider, model, effort, ledger, config),
  };
}
