import type { MainSessionTurn } from "./usage.js";
import type {
  OrchestratorSessionRow,
  Provider,
  SessionBootSampleRow,
  SessionUsageProfileRow,
} from "./types.js";
import type { ModelPrice, ModelPriceSource } from "./usage-pricing.js";

export const SESSION_USAGE_PROFILE_REF = "turnSeries@v1";
export const DEFAULT_SESSION_USAGE_PROFILE_MIN_TURNS = 30;
const SOURCE_SESSION_LIMIT = 20;

export type UsageProfileSessionRow = OrchestratorSessionRow & { provider: Provider };

export interface SessionTurnSeries {
  session: UsageProfileSessionRow;
  turnSeries: readonly MainSessionTurn[];
}

export interface ComputeSessionUsageProfilesOptions {
  minTurns?: number;
}

export interface SessionUsageResolvedPrice {
  price: ModelPrice;
  priceSource: ModelPriceSource | "codex-credits";
}

export type SessionUsagePriceResolver = (model: string) => SessionUsageResolvedPrice | null;

interface ProfileAggregate {
  provider: Provider;
  model: string;
  effort: MainSessionTurn["effort"];
  turns: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
  reasoningObservedForEveryTurn: boolean;
  contextGrowth: number[];
  sourceSessionIds: string[];
  sourceSessionIdSet: Set<string>;
  updatedAt: number;
}

function profileKey(turn: MainSessionTurn): string | null {
  if (turn.model === undefined || turn.model === "") {
    return null;
  }
  return `${turn.provider}\u0000${turn.model}\u0000${turn.effort ?? "unset"}`;
}

function compareProfiles(a: SessionUsageProfileRow, b: SessionUsageProfileRow): number {
  return a.provider.localeCompare(b.provider)
    || a.model.localeCompare(b.model)
    || (a.effort ?? "unset").localeCompare(b.effort ?? "unset");
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle]!;
  }
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function assertMinTurns(minTurns: number): void {
  if (!Number.isInteger(minTurns) || minTurns <= 0) {
    throw new Error(`minTurns は1以上の整数が必須です: ${minTurns}`);
  }
}

/** 契約 §77.4 の三つ組係数を main-chain turn 系列から計算する。 */
export function computeSessionUsageProfiles(
  sessions: readonly SessionTurnSeries[],
  options: ComputeSessionUsageProfilesOptions = {},
): SessionUsageProfileRow[] {
  const minTurns = options.minTurns ?? DEFAULT_SESSION_USAGE_PROFILE_MIN_TURNS;
  assertMinTurns(minTurns);
  const aggregates = new Map<string, ProfileAggregate>();
  const recentFirst = sessions
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      b.entry.session.createdAt - a.entry.session.createdAt
      || b.entry.session.id.localeCompare(a.entry.session.id)
      || a.index - b.index,
    )
    .map(({ entry }) => entry);

  for (const { session, turnSeries } of recentFirst) {
    let previousTurn: MainSessionTurn | null = null;
    let previousKey: string | null = null;
    for (const turn of turnSeries) {
      const key = profileKey(turn);
      if (key === null) {
        previousTurn = turn;
        previousKey = null;
        continue;
      }
      const model = turn.model!;
      let aggregate = aggregates.get(key);
      if (aggregate === undefined) {
        aggregate = {
          provider: turn.provider,
          model,
          effort: turn.effort,
          turns: 0,
          cacheRead: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          output: 0,
          reasoning: 0,
          reasoningObservedForEveryTurn: true,
          contextGrowth: [],
          sourceSessionIds: [],
          sourceSessionIdSet: new Set<string>(),
          updatedAt: session.updatedAt,
        };
        aggregates.set(key, aggregate);
      }

      const cacheWrite1h = turn.cacheCreation1hTokens ?? 0;
      aggregate.turns += 1;
      aggregate.cacheRead += turn.cacheReadTokens;
      aggregate.cacheWrite1h += cacheWrite1h;
      aggregate.cacheWrite5m += turn.cacheCreationTokens - cacheWrite1h;
      aggregate.output += turn.outputTokens;
      if (turn.reasoningOutputTokens === undefined) {
        aggregate.reasoningObservedForEveryTurn = false;
      } else {
        aggregate.reasoning += turn.reasoningOutputTokens;
      }
      if (previousTurn !== null && previousKey === key) {
        const growth = turn.contextTokens - previousTurn.contextTokens;
        if (growth >= 0) {
          aggregate.contextGrowth.push(growth);
        }
      }
      if (!aggregate.sourceSessionIdSet.has(session.providerSessionId)
        && aggregate.sourceSessionIds.length < SOURCE_SESSION_LIMIT) {
        aggregate.sourceSessionIdSet.add(session.providerSessionId);
        aggregate.sourceSessionIds.push(session.providerSessionId);
      }
      aggregate.updatedAt = Math.max(aggregate.updatedAt, session.updatedAt);
      previousTurn = turn;
      previousKey = key;
    }
  }

  return [...aggregates.values()].map((aggregate): SessionUsageProfileRow => ({
    provider: aggregate.provider,
    model: aggregate.model,
    effort: aggregate.effort,
    turns: aggregate.turns,
    measured: aggregate.turns >= minTurns,
    cacheReadPerTurn: aggregate.cacheRead / aggregate.turns,
    cacheWrite5mPerTurn: aggregate.cacheWrite5m / aggregate.turns,
    cacheWrite1hPerTurn: aggregate.cacheWrite1h / aggregate.turns,
    outputPerTurn: aggregate.output / aggregate.turns,
    reasoningPerTurn: aggregate.reasoningObservedForEveryTurn
      ? aggregate.reasoning / aggregate.turns
      : null,
    contextGrowthPerTurn: median(aggregate.contextGrowth),
    sourceSessionIds: aggregate.sourceSessionIds,
    computedFromRef: SESSION_USAGE_PROFILE_REF,
    updatedAt: aggregate.updatedAt,
  })).sort(compareProfiles);
}

function resolveBootPrice(
  turn: MainSessionTurn | undefined,
  resolvePrice: SessionUsagePriceResolver,
): { overhead: number | null; provenance: string } {
  if (turn?.model === undefined) {
    return { overhead: null, provenance: `${SESSION_USAGE_PROFILE_REF};priceSource=unresolved` };
  }
  const resolved = resolvePrice(turn.model);
  if (resolved === null) {
    return { overhead: null, provenance: `${SESSION_USAGE_PROFILE_REF};priceSource=unresolved` };
  }
  const writePrice = resolved.price.cacheCreation1hCostPerToken
    ?? resolved.price.cacheCreationCostPerToken
    ?? resolved.price.inputCostPerToken;
  const writePriceSource = resolved.price.cacheCreation1hCostPerToken !== null
    ? "cacheCreation1h"
    : resolved.price.cacheCreationCostPerToken !== null
      ? "cacheCreation5m"
      : "input";
  const provenance = `${SESSION_USAGE_PROFILE_REF};priceSource=${resolved.priceSource};writePrice=${writePriceSource}`;
  if (turn.cacheReadTokens !== 0 || resolved.price.cacheReadCostPerToken === null) {
    return { overhead: null, provenance };
  }
  return {
    overhead: turn.cacheCreationTokens * (writePrice - resolved.price.cacheReadCostPerToken),
    provenance,
  };
}

/** 契約 §77.5 / §77.9 の identity 別立ち上げ標本を計算する。 */
export function computeSessionBootSample(
  session: UsageProfileSessionRow,
  turnSeries: readonly MainSessionTurn[],
  resolvePrice: SessionUsagePriceResolver,
): SessionBootSampleRow {
  const turn15 = turnSeries[14];
  const boot = resolveBootPrice(turnSeries[1], resolvePrice);
  return {
    orchestratorId: session.orchestratorId,
    sessionId: session.id,
    providerSessionId: session.providerSessionId,
    provider: session.provider,
    model: turn15?.model ?? null,
    contextAtTurn15: turn15?.contextTokens ?? null,
    bootOverheadUsd: boot.overhead,
    provenance: boot.provenance,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
