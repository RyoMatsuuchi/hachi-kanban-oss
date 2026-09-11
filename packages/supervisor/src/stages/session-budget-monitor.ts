// active orchestrator session の budget 段階を定期評価し、変化時だけ inbox と §38 通知へ流す。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  collectClaudeNativeUsage,
  collectCodexNativeUsage,
  findClaudeSessionDir,
  findCodexRollout,
  resolveClaudeProjectsRoot,
  resolveCodexSessionsRoot,
} from "@hachi/adapters";
import {
  assessOrchestratorSession,
  DEFAULT_SESSION_BUDGET_AUTO_HANDOVER,
  readCodexLedger,
  redactText,
  SESSION_BUDGET_STAGES,
  type NativeUsageObservation,
  type OrchestratorSessionRow,
  type SessionAssessmentRecommendationAction,
  type SessionBudgetStage,
  type Stage,
  type StageDeps,
  type StageResult,
} from "@hachi/core";
import {
  sendOperationalNotification,
  type OperationalNotifyInput,
  type OperationalNotifyResult,
} from "./notify.js";

const DEFAULT_MONITOR_INTERVAL_MINUTES = 15;
const DEFAULT_IDLE_WARN_RATIO = 0.5;
const NOTIFICATION_DEDUPE_SECONDS = 900;

export interface SessionBudgetMonitorNativeUsageRoots {
  claudeProjectsRoot?: string;
  codexSessionsRoot?: string;
  codexAuthPath?: string;
}

export type SessionBudgetMonitorNotify = (
  deps: StageDeps,
  input: OperationalNotifyInput,
) => Promise<OperationalNotifyResult>;

export interface SessionBudgetMonitorStageOptions {
  nativeUsageRoots?: SessionBudgetMonitorNativeUsageRoots;
  notify?: SessionBudgetMonitorNotify;
}

interface SessionBudgetMonitorSessionState {
  stage: SessionBudgetStage;
  action: SessionAssessmentRecommendationAction;
  notifiedAt: number;
  /** dedupe key (stage/action) ごとの最終通知時刻。組合せは最大 12 個で bounded。 */
  notifiedByKey: Record<string, number>;
}

interface SessionBudgetMonitorIdleState {
  stage: "idle";
  action: "handoff-before-idle";
  notifiedAt: number;
  active: boolean;
}

interface SessionBudgetMonitorState {
  lastRunAt: number;
  sessions: Record<string, SessionBudgetMonitorSessionState>;
  idleSessions: Record<string, SessionBudgetMonitorIdleState>;
  idleMtimeUnavailableSessions: Record<string, true>;
}

const DEFAULT_STATE: SessionBudgetMonitorState = {
  lastRunAt: 0,
  sessions: {},
  idleSessions: {},
  idleMtimeUnavailableSessions: {},
};

function statePath(home: string): string {
  return join(home, "state", "session-budget-monitor.json");
}

function isSessionBudgetStage(value: unknown): value is SessionBudgetStage {
  return typeof value === "string" && SESSION_BUDGET_STAGES.some((stage) => stage === value);
}

function isRecommendationAction(value: unknown): value is SessionAssessmentRecommendationAction {
  return value === "continue" || value === "handoff-at-boundary" || value === "handoff-now";
}

function notificationStateKey(stage: SessionBudgetStage, action: SessionAssessmentRecommendationAction): string {
  return `${stage}:${action}`;
}

function readState(home: string): SessionBudgetMonitorState {
  const path = statePath(home);
  if (!existsSync(path)) {
    return { ...DEFAULT_STATE, sessions: {}, idleSessions: {}, idleMtimeUnavailableSessions: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_STATE, sessions: {}, idleSessions: {}, idleMtimeUnavailableSessions: {} };
    }
    const object = parsed as Record<string, unknown>;
    const sessions: Record<string, SessionBudgetMonitorSessionState> = {};
    if (typeof object.sessions === "object" && object.sessions !== null && !Array.isArray(object.sessions)) {
      for (const [sessionId, value] of Object.entries(object.sessions as Record<string, unknown>)) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          continue;
        }
        const entry = value as Record<string, unknown>;
        if (
          isSessionBudgetStage(entry.stage)
          && isRecommendationAction(entry.action)
          && typeof entry.notifiedAt === "number"
          && Number.isFinite(entry.notifiedAt)
          && entry.notifiedAt >= 0
        ) {
          const notifiedByKey: Record<string, number> = {};
          if (
            typeof entry.notifiedByKey === "object"
            && entry.notifiedByKey !== null
            && !Array.isArray(entry.notifiedByKey)
          ) {
            for (const [key, timestamp] of Object.entries(entry.notifiedByKey as Record<string, unknown>)) {
              if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0) {
                notifiedByKey[key] = timestamp;
              }
            }
          }
          const currentKey = notificationStateKey(entry.stage, entry.action);
          notifiedByKey[currentKey] ??= entry.notifiedAt;
          sessions[sessionId] = {
            stage: entry.stage,
            action: entry.action,
            notifiedAt: entry.notifiedAt,
            notifiedByKey,
          };
        }
      }
    }
    const idleSessions: Record<string, SessionBudgetMonitorIdleState> = {};
    if (typeof object.idleSessions === "object" && object.idleSessions !== null && !Array.isArray(object.idleSessions)) {
      for (const [sessionId, value] of Object.entries(object.idleSessions as Record<string, unknown>)) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          continue;
        }
        const entry = value as Record<string, unknown>;
        if (
          entry.stage === "idle"
          && entry.action === "handoff-before-idle"
          && typeof entry.notifiedAt === "number"
          && Number.isFinite(entry.notifiedAt)
          && entry.notifiedAt >= 0
          && typeof entry.active === "boolean"
        ) {
          idleSessions[sessionId] = {
            stage: "idle",
            action: "handoff-before-idle",
            notifiedAt: entry.notifiedAt,
            active: entry.active,
          };
        }
      }
    }
    const idleMtimeUnavailableSessions: Record<string, true> = {};
    if (
      typeof object.idleMtimeUnavailableSessions === "object"
      && object.idleMtimeUnavailableSessions !== null
      && !Array.isArray(object.idleMtimeUnavailableSessions)
    ) {
      for (const [sessionId, value] of Object.entries(
        object.idleMtimeUnavailableSessions as Record<string, unknown>,
      )) {
        if (value === true) {
          idleMtimeUnavailableSessions[sessionId] = true;
        }
      }
    }
    return {
      lastRunAt: typeof object.lastRunAt === "number" && Number.isFinite(object.lastRunAt)
        ? object.lastRunAt
        : 0,
      sessions,
      idleSessions,
      idleMtimeUnavailableSessions,
    };
  } catch {
    return { ...DEFAULT_STATE, sessions: {}, idleSessions: {}, idleMtimeUnavailableSessions: {} };
  }
}

function writeState(home: string, state: SessionBudgetMonitorState): void {
  const dir = join(home, "state");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = statePath(home);
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function resolveIntervalSeconds(deps: StageDeps): number {
  const intervalMinutes = deps.config.orchestrator?.sessionBudget?.monitor?.intervalMinutes
    ?? DEFAULT_MONITOR_INTERVAL_MINUTES;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
    throw new Error(`orchestrator.sessionBudget.monitor.intervalMinutes は正の整数が必須です: ${intervalMinutes}`);
  }
  return intervalMinutes * 60;
}

function resolveIdleWarnRatio(deps: StageDeps): number {
  const ratio = deps.config.orchestrator?.sessionBudget?.monitor?.idleWarnRatio
    ?? DEFAULT_IDLE_WARN_RATIO;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    throw new Error(`orchestrator.sessionBudget.monitor.idleWarnRatio は 0 より大きく 1 未満が必須です: ${ratio}`);
  }
  return ratio;
}

async function resolveNativeLogMtimeMs(
  session: OrchestratorSessionRow & { provider: "codex" | "claude" },
  roots: SessionBudgetMonitorNativeUsageRoots,
): Promise<number | null> {
  let path: string | null;
  if (session.provider === "claude") {
    const dir = await findClaudeSessionDir(
      roots.claudeProjectsRoot ?? resolveClaudeProjectsRoot(),
      session.providerSessionId,
    );
    path = dir === null ? null : join(dir, `${session.providerSessionId}.jsonl`);
  } else {
    path = await findCodexRollout(
      roots.codexSessionsRoot ?? resolveCodexSessionsRoot(),
      session.providerSessionId,
    );
  }
  if (path === null) {
    return null;
  }
  try {
    const info = await stat(path);
    return info.isFile() && Number.isFinite(info.mtimeMs) ? info.mtimeMs : null;
  } catch {
    return null;
  }
}

async function observeSession(
  session: OrchestratorSessionRow & { provider: "codex" | "claude" },
  roots: SessionBudgetMonitorNativeUsageRoots,
): Promise<NativeUsageObservation> {
  if (session.provider === "claude") {
    return collectClaudeNativeUsage({
      projectsRoot: roots.claudeProjectsRoot ?? resolveClaudeProjectsRoot(),
      sessionId: session.providerSessionId,
    });
  }
  return collectCodexNativeUsage({
    sessionsRoot: roots.codexSessionsRoot ?? resolveCodexSessionsRoot(),
    sessionId: session.providerSessionId,
  });
}

function missionTaskId(deps: StageDeps, orchestratorId: string): string | null {
  return deps.store
    .listOrchestratorWatches(orchestratorId)
    .find((watch) => watch.active && watch.scope === "subtree" && watch.role !== "observer")
    ?.selector ?? null;
}

function unknownNote(sessionId: string, reason: string): string {
  return `session-budget ${sessionId}: unknown (${reason})`;
}

/** 契約 §77.7 の session-budget-monitor stage を生成する。 */
export function createSessionBudgetMonitorStage(options: SessionBudgetMonitorStageOptions = {}): Stage {
  const roots = options.nativeUsageRoots ?? {};
  const notify = options.notify ?? sendOperationalNotification;

  return {
    name: "session-budget-monitor",

    async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
      const notes: string[] = [];
      const autoHandover = deps.config.orchestrator?.sessionBudget?.autoHandover
        ?? DEFAULT_SESSION_BUDGET_AUTO_HANDOVER;
      if (autoHandover === "off") {
        return { name: "session-budget-monitor", actions: 0, skipped: true, notes: ["autoHandover=off のため評価をスキップしました"] };
      }

      const state = readState(deps.env.home);
      const intervalSeconds = resolveIntervalSeconds(deps);
      const idleWarnRatio = resolveIdleWarnRatio(deps);
      if (state.lastRunAt > 0 && now - state.lastRunAt < intervalSeconds) {
        return { name: "session-budget-monitor", actions: 0, skipped: true, notes: ["monitor interval 未満のため評価をスキップしました"] };
      }

      if (autoHandover === "apply") {
        const message = "session-budget autoHandover=apply は未実装。propose 扱いにします";
        deps.logger.warn(message);
        notes.push(message);
      }

      let actions = 0;
      const sessions = deps.store
        .listOrchestratorSessions()
        .filter((session) => session.status === "active" && session.providerSessionId !== "");

      for (const session of sessions) {
        try {
          if (session.provider === "") {
            notes.push(unknownNote(session.id, "provider-unregistered"));
            continue;
          }
          const measurableSession = session as OrchestratorSessionRow & { provider: "codex" | "claude" };
          const nativeLogMtimeMs = await resolveNativeLogMtimeMs(measurableSession, roots);
          if (nativeLogMtimeMs === null) {
            if (state.idleMtimeUnavailableSessions[session.id] !== true) {
              notes.push(`session-budget ${session.id}: idle skip (native-log-mtime-unavailable)`);
              if (apply) {
                state.idleMtimeUnavailableSessions[session.id] = true;
              }
            }
            continue;
          }
          const observation = await observeSession(measurableSession, roots);
          if (!observation.observed) {
            notes.push(unknownNote(session.id, observation.reason));
            continue;
          }
          if (observation.mainSession === undefined) {
            notes.push(unknownNote(session.id, "main-session-unavailable"));
            continue;
          }
          const ledger = measurableSession.provider === "codex"
            ? readCodexLedger(roots.codexAuthPath ?? join(homedir(), ".codex", "auth.json"))
            : "unknown";
          const assessment = assessOrchestratorSession(
            measurableSession,
            observation.mainSession,
            deps.store,
            deps.config,
            ledger,
            now,
          );
          const stage = assessment.evaluation.stage;
          const idle = assessment.recommendation.idle;
          const idleSeconds = Math.max(0, now - nativeLogMtimeMs / 1_000);
          const idleEligible = idleSeconds >= idle.ttlSeconds * idleWarnRatio
            && idleSeconds < idle.ttlSeconds
            && idle.action === "handoff-before-idle";
          const previousIdle = state.idleSessions[session.id];
          if (!idleEligible) {
            if (apply && previousIdle?.active === true) {
              state.idleSessions[session.id] = { ...previousIdle, active: false };
            }
          } else if (previousIdle?.active === true) {
            // 同じ idle 状態が続く間は、stage/action の変化通知と同じく再通知しない。
          } else if (previousIdle !== undefined && now - previousIdle.notifiedAt <= NOTIFICATION_DEDUPE_SECONDS) {
            notes.push(`session-budget ${session.id}: idle 900秒 dedupe 窓内のため通知を抑止しました`);
            if (apply) {
              state.idleSessions[session.id] = { ...previousIdle, active: true };
            }
          } else {
            actions += 1;
            if (!apply) {
              notes.push(`dry-run: session-budget ${session.id} idle/handoff-before-idle を通知予定`);
            } else {
              const recommendationJson = JSON.stringify(assessment.recommendation);
              const missionTask = missionTaskId(deps, session.orchestratorId);
              if (missionTask !== null) {
                deps.store.createOrGetOrchestratorRequest({
                  taskId: missionTask,
                  questionId: `session-budget:${session.id}:idle:handoff-before-idle:${Math.floor(now / NOTIFICATION_DEDUPE_SECONDS)}`,
                  question: "session budget が idle/handoff-before-idle へ変化しました",
                  context: recommendationJson,
                });
              }
              await notify(deps, {
                id: `session-budget:${session.id}:idle:handoff-before-idle`,
                title: "orchestrator session budget idle warning",
                body: `session=${session.id} stage=idle action=handoff-before-idle\nrecommendation=${recommendationJson}`,
                fullMacosBody: true,
              });
              state.idleSessions[session.id] = {
                stage: "idle",
                action: "handoff-before-idle",
                notifiedAt: now,
                active: true,
              };
            }
          }

          if (stage === null) {
            notes.push(unknownNote(session.id, "all-aggregated-axes-unmeasured"));
            continue;
          }
          const action = assessment.recommendation.action;
          const previous = state.sessions[session.id];
          if (previous !== undefined && previous.stage === stage && previous.action === action) {
            continue;
          }
          const currentKey = notificationStateKey(stage, action);
          const sameKeyNotifiedAt = previous?.notifiedByKey[currentKey];
          if (previous !== undefined && sameKeyNotifiedAt !== undefined && now - sameKeyNotifiedAt <= NOTIFICATION_DEDUPE_SECONDS) {
            notes.push(`session-budget ${session.id}: 900秒 dedupe 窓内のため変化通知を抑止しました`);
            if (apply) {
              state.sessions[session.id] = {
                ...previous,
                stage,
                action,
                notifiedAt: sameKeyNotifiedAt,
              };
            }
            continue;
          }

          actions += 1;
          if (!apply) {
            notes.push(`dry-run: session-budget ${session.id} ${stage}/${action} を通知予定`);
            continue;
          }

          const recommendationJson = JSON.stringify(assessment.recommendation);
          const missionTask = missionTaskId(deps, session.orchestratorId);
          if (missionTask !== null) {
            deps.store.createOrGetOrchestratorRequest({
              taskId: missionTask,
              questionId: `session-budget:${session.id}:${stage}:${action}:${Math.floor(now / NOTIFICATION_DEDUPE_SECONDS)}`,
              question: `session budget が ${stage}/${action} へ変化しました`,
              context: recommendationJson,
            });
          }
          await notify(deps, {
            id: `session-budget:${session.id}:${stage}:${action}`,
            title: "orchestrator session budget changed",
            body: `session=${session.id} stage=${stage} action=${action}\nrecommendation=${recommendationJson}`,
            fullMacosBody: true,
          });
          state.sessions[session.id] = {
            stage,
            action,
            notifiedAt: now,
            notifiedByKey: { ...previous?.notifiedByKey, [currentKey]: now },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notes.push(unknownNote(session.id, redactText(message)));
        }
      }

      if (apply) {
        state.lastRunAt = now;
        writeState(deps.env.home, state);
      }
      return { name: "session-budget-monitor", actions, skipped: false, notes };
    },
  };
}

export const sessionBudgetMonitorStage: Stage = createSessionBudgetMonitorStage();
