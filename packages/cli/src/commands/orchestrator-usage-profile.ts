import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import {
  collectClaudeNativeUsage,
  collectCodexNativeUsage,
  resolveClaudeProjectsRoot,
  resolveCodexSessionsRoot,
} from "@hachi/adapters";
import {
  computeSessionBootSample,
  computeSessionUsageProfiles,
  readCodexLedger,
  resolveModelPrice,
  type NativeUsageObservation,
  type SessionTurnSeries,
  type SessionUsagePriceResolver,
  type UsageProfileSessionRow,
} from "@hachi/core";
import type { CliDeps } from "../deps.js";
import { withErrorHandling } from "../errors.js";
import { emit } from "../output.js";

const DEFAULT_PROFILE_SESSIONS = 50;
const DEFAULT_MIN_TURNS = 30;

interface RefreshOptions {
  sessions?: number;
  json?: boolean;
}

interface SkippedSession {
  sessionId: string;
  reason: string;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} は1以上の整数が必須です: ${value}`);
  }
  return parsed;
}

function isUsageProfileSession(session: ReturnType<CliDeps["store"]["listOrchestratorSessions"]>[number]): session is UsageProfileSessionRow {
  return session.provider !== "" && session.providerSessionId !== "";
}

async function observe(deps: CliDeps, session: UsageProfileSessionRow): Promise<NativeUsageObservation> {
  if (session.provider === "claude") {
    return collectClaudeNativeUsage({
      projectsRoot: deps.nativeUsageRoots?.claudeProjectsRoot ?? resolveClaudeProjectsRoot(),
      sessionId: session.providerSessionId,
    });
  }
  return collectCodexNativeUsage({
    sessionsRoot: deps.nativeUsageRoots?.codexSessionsRoot ?? resolveCodexSessionsRoot(),
    sessionId: session.providerSessionId,
  });
}

function apiPriceResolver(deps: CliDeps): SessionUsagePriceResolver {
  const overrides = deps.config.orchestrator?.pricing?.overrides;
  return (model) => resolveModelPrice(model, overrides);
}

function codexCreditPriceResolver(deps: CliDeps): SessionUsagePriceResolver {
  const pricing = deps.config.orchestrator?.pricing;
  const usdRate = pricing?.codexCreditUsdRate;
  return (model) => {
    const credits = pricing?.codexCredits?.[model];
    if (credits === undefined || usdRate === undefined) {
      return null;
    }
    return {
      price: {
        inputCostPerToken: credits.input * usdRate / 1_000_000,
        outputCostPerToken: credits.output * usdRate / 1_000_000,
        cacheCreationCostPerToken: null,
        cacheCreation1hCostPerToken: null,
        cacheReadCostPerToken: credits.cached * usdRate / 1_000_000,
      },
      priceSource: "codex-credits",
    };
  };
}

function resolvePriceForProvider(
  deps: CliDeps,
  provider: UsageProfileSessionRow["provider"],
  codexLedger: ReturnType<typeof readCodexLedger>,
): SessionUsagePriceResolver {
  if (provider === "codex" && codexLedger === "chatgpt") {
    return codexCreditPriceResolver(deps);
  }
  return apiPriceResolver(deps);
}

async function runRefresh(deps: CliDeps, options: RefreshOptions): Promise<void> {
  const costModel = deps.config.orchestrator?.sessionBudget?.costModel;
  const sessionLimit = options.sessions ?? costModel?.profileSessions ?? DEFAULT_PROFILE_SESSIONS;
  const minTurns = costModel?.minTurns ?? DEFAULT_MIN_TURNS;
  const sessions = deps.store.listOrchestratorSessions()
    .filter(isUsageProfileSession)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    .slice(0, sessionLimit);
  const observations = await Promise.all(sessions.map(async (session) => ({
    session,
    observation: await observe(deps, session),
  })));
  const collected: SessionTurnSeries[] = [];
  const skipped: SkippedSession[] = [];
  for (const { session, observation } of observations) {
    if (!observation.observed) {
      skipped.push({ sessionId: session.id, reason: observation.reason });
      continue;
    }
    if (observation.mainSession === undefined) {
      skipped.push({ sessionId: session.id, reason: "main-session-unavailable" });
      continue;
    }
    collected.push({ session, turnSeries: observation.mainSession.turnSeries });
  }

  const profiles = computeSessionUsageProfiles(collected, { minTurns });
  const codexLedger = readCodexLedger(
    deps.nativeUsageRoots?.codexAuthPath ?? join(homedir(), ".codex", "auth.json"),
  );
  const bootSamples = collected.map(({ session, turnSeries }) => computeSessionBootSample(
    session,
    turnSeries,
    resolvePriceForProvider(deps, session.provider, codexLedger),
  ));
  deps.store.transaction(() => {
    for (const profile of profiles) {
      deps.store.upsertSessionUsageProfile(profile);
    }
    for (const sample of bootSamples) {
      deps.store.upsertSessionBootSample(sample);
    }
  });

  const result = {
    requestedSessions: sessionLimit,
    selectedSessions: sessions.length,
    collectedSessions: collected.length,
    skippedSessions: skipped,
    minTurns,
    profilesUpserted: profiles.length,
    bootSamplesUpserted: bootSamples.length,
  };
  emit(deps, options.json === true, result, [
    `usage profile refresh: selected=${result.selectedSessions} collected=${result.collectedSessions}`,
    `profiles=${result.profilesUpserted} bootSamples=${result.bootSamplesUpserted} skipped=${skipped.length}`,
  ]);
}

export function registerOrchestratorUsageProfileCommand(orchestrator: Command, deps: CliDeps): void {
  orchestrator.command("usage-profile")
    .description("契約 §77.4 の session usage profile を管理する")
    .command("refresh")
    .description("直近の orchestrator transcript から係数と立ち上げ標本を更新する")
    .option("--sessions <n>", "読む直近 session 数", (value) => parsePositiveInteger(value, "sessions"))
    .option("--json")
    .action(withErrorHandling(deps, (options: RefreshOptions) => runRefresh(deps, options)));
}
