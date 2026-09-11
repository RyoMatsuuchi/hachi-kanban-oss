// =============================================================================
// hachi orchestrator: contract §55 の identity/session/watch/request porcelain。
// session generation と claim token を全 mutation で明示し、旧 session の迂回を fail-closed にする。
// =============================================================================

import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { Command, Option } from "commander";
import { findClaudeSessionDir, resolveClaudeProjectsRoot } from "@hachi/adapters";
import {
  createKanbanReadView,
  HumanDecisionError,
  newNonce,
  DEFAULT_CODEX_SUCCESSOR_ATTESTATION_MODE,
  ORCHESTRATOR_AWAIT_HEARTBEAT_INTERVAL_SECONDS,
  ORCHESTRATOR_SESSION_STALE_SECONDS,
  redactText,
  resolveRunStalledOrchestratorRequest,
  serializeAgentMessage,
  type AgentMessageV1,
  type HumanDecisionRequestRow,
  type OrchestratorRow,
  type OrchestratorRequestRow,
  type OrchestratorSessionRow,
  type OrchestratorSuccessorLaunchKind,
  type OrchestratorSuccessorLaunchRow,
  type OrchestratorWatchRole,
  type OrchestratorWatchRow,
  type OrchestratorWatchScope,
  type Provider,
  type RuntimeCleanupRequestRow,
  type TaskRow,
} from "@hachi/core";
import type { CliDeps, SuccessorLaunchRuntimeReadback, TmuxLauncher, TmuxProbe } from "../deps.js";
import { withErrorHandling } from "../errors.js";
import { emit, singularResourceEnvelope } from "../output.js";
import {
  assertCleanupClaimTokenRemoved,
  installAwaitSignalCleanup,
  isOrchestratorAwaitClaimConflict,
  OrchestratorAwaitHeartbeat,
} from "../orchestrator-await-heartbeat.js";
import {
  DEFAULT_ORCHESTRATOR_HEARTBEAT_LIFECYCLE,
  heartbeatDaemonEnvironment,
  type HeartbeatStopResult,
} from "../orchestrator-heartbeat-lifecycle.js";
import {
  defaultClaudeTrustProbe,
  defaultHandoverDeliveryGateProbe,
  type HandoverDeliveryGateProbe,
} from "../orchestrator-handoff-delivery.js";
import { runSuccessorLaunchAttest } from "../successor-attestation.js";
import {
  recoverSuccessorLaunch,
  runClaudeHandoverSuccessorLaunch,
  runSuccessorLaunchFencedClose,
  runSuccessorLaunchRollbackComplete,
  runSuccessorLaunchStart,
} from "./orchestrator-successor-launch.js";
import { registerOrchestratorUsageCommand } from "./orchestrator-usage.js";
import { registerOrchestratorUsageProfileCommand } from "./orchestrator-usage-profile.js";
import { registerHumanDecisionAskCommand } from "./human-decision.js";
import { removeCleanupClaimToken, writeCleanupClaimToken } from "./resource.js";

const DEFAULT_INTERVAL_SEC = 5;
const DEFAULT_LEASE_SEC = 600;
const DEFAULT_STALE_SEC = ORCHESTRATOR_SESSION_STALE_SECONDS;
const HANDOFF_TTL_SEC = 600;
const DEFAULT_HANDOVER_MAX_ATTEMPTS = 3;
const HANDOVER_MAX_ATTEMPTS_LIMIT = 5;
const SUCCESSOR_SESSION_RESOLVE_MAX_ATTEMPTS = 30;
/** tmux 3.6a の実測下限（16KB）より安全側に置く、実行コマンド argv 全体の UTF-8 byte 上限 */
export const TMUX_COMMAND_MAX_BYTES = 15_000;

function parseNonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} は0以上の整数が必須です: ${value}`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = parseNonNegativeInteger(value, label);
  if (parsed === 0) {
    throw new Error(`${label} は1以上の整数が必須です`);
  }
  return parsed;
}

function parseGeneration(value: string): number {
  return parsePositiveInteger(value, "generation");
}

function parseHandoverMaxAttempts(value: string): number {
  const parsed = parsePositiveInteger(value, "max-attempts");
  if (parsed > HANDOVER_MAX_ATTEMPTS_LIMIT) {
    throw new Error(`max-attempts は1〜${HANDOVER_MAX_ATTEMPTS_LIMIT}の整数が必須です: ${value}`);
  }
  return parsed;
}

function parseProvider(value: string | undefined): Provider | "" {
  if (value === undefined || value === "") {
    return "";
  }
  if (value !== "codex" && value !== "claude") {
    throw new Error(`provider は codex / claude のみです: ${value}`);
  }
  return value;
}

interface ProviderIdentityOptions {
  provider?: string;
  providerSessionId?: string;
  attestationHandle?: string;
}

type ParsedProviderAuthority =
  | { kind: "generic"; provider: Provider | ""; providerSessionId: string }
  | { kind: "trusted-codex"; attestationHandle: string };

/** contract §73.1 の provider/ID/handle 行列を Store mutation より前に固定する。 */
function parseProviderAuthority(
  deps: CliDeps,
  options: ProviderIdentityOptions,
  allowTrustedCodex: false,
): Extract<ParsedProviderAuthority, { kind: "generic" }>;
function parseProviderAuthority(
  deps: CliDeps,
  options: ProviderIdentityOptions,
  allowTrustedCodex: true,
): ParsedProviderAuthority;
function parseProviderAuthority(
  deps: CliDeps,
  options: ProviderIdentityOptions,
  allowTrustedCodex: boolean,
): ParsedProviderAuthority {
  const provider = parseProvider(options.provider);
  const providerSessionId = (options.providerSessionId ?? "").trim();
  const suppliedHandle = options.attestationHandle;
  if (suppliedHandle !== undefined) {
    if (!allowTrustedCodex) {
      throw new Error("この経路では attestation handle を受理できません");
    }
    if (provider !== "codex") {
      throw new Error("attestation handle は --provider codex とだけ併用できます");
    }
    if (options.providerSessionId !== undefined) {
      throw new Error("Codex trusted 経路では caller supplied --provider-session-id を指定できません");
    }
    if (!/^[A-Za-z0-9_-]{32,512}$/.test(suppliedHandle)) {
      throw new Error("attestation handle の形式が不正です");
    }
    return { kind: "trusted-codex", attestationHandle: suppliedHandle };
  }
  if ((provider === "") !== (providerSessionId === "")) {
    throw new Error("provider と provider session ID は両方指定または両方省略してください");
  }
  if (provider === "codex") {
    const mode = deps.config.orchestrator?.codexSuccessorAttestation?.mode ??
      DEFAULT_CODEX_SUCCESSOR_ATTESTATION_MODE;
    if (mode === "enforce") {
      throw new Error("Codex successor attestation enforce mode では caller supplied provider session ID を受理できません");
    }
  }
  return { kind: "generic", provider, providerSessionId };
}

function assertGenericReplacementGate(deps: CliDeps, orchestratorId: string): void {
  const gate = deps.store.successorReplacementGate(orchestratorId);
  if (!gate.allowed) {
    throw new Error(`SUCCESSOR_REPLACEMENT_BLOCKED: blocking slot=${gate.blockingSlotId ?? "unknown"}`);
  }
}

function findTrustedSuccessorLaunch(
  deps: CliDeps,
  handle: string,
  operation: OrchestratorSuccessorLaunchKind,
): { launch: OrchestratorSuccessorLaunchRow; handleHash: string } {
  const handleHash = hashToken(handle);
  const matches = deps.store.listSuccessorLaunches().filter((launch) =>
    launch.targetProvider === "codex" && launch.kind === operation && launch.attestationHandleHash === handleHash
  );
  if (matches.length !== 1) {
    throw new Error("Codex successor attestation に対応する trusted slot を一意に確認できません");
  }
  return { launch: matches[0]!, handleHash };
}

function parseScope(value: string): OrchestratorWatchScope {
  if (!["task", "subtree", "worktree", "project"].includes(value)) {
    throw new Error(`scope は task / subtree / worktree / project のみです: ${value}`);
  }
  return value as OrchestratorWatchScope;
}

function parseRole(value: string): OrchestratorWatchRole {
  if (!["primary", "collaborator", "observer"].includes(value)) {
    throw new Error(`role は primary / collaborator / observer のみです: ${value}`);
  }
  return value as OrchestratorWatchRole;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface JsonOption {
  json?: boolean;
}

interface RuntimeCleanupInboxDelivery {
  requestId: string;
  leaseId: string;
  reason: string;
  requestStatus: RuntimeCleanupRequestRow["status"];
  expectedLeaseFence: number;
  ownerTaskId: string | null;
  humanAnswer: string;
}

interface RuntimeCleanupInboxStore {
  listRuntimeCleanupInboxDeliveries(
    orchestratorId: string,
    limit?: number,
    now?: number,
  ): RuntimeCleanupInboxDelivery[];
  getRuntimeCleanupRequest(requestId: string): RuntimeCleanupRequestRow | null;
  claimRuntimeCleanupRequest(input: {
    requestId: string;
    orchestratorId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    expectedLeaseFence: number;
    leaseUntil: number;
    now?: number;
  }): RuntimeCleanupRequestRow;
}

interface RuntimeCleanupAwaitCandidate {
  requestId: string;
  claimableAt: number;
  expectedLeaseFence: number;
  leaseId: string;
  reason: string;
  ownerTaskId: string | null;
  humanAnswer: string;
}

interface RuntimeCleanupAwaitStore extends RuntimeCleanupInboxStore {
  peekRuntimeCleanupAwaitCandidate(
    orchestratorId: string,
    now?: number,
  ): RuntimeCleanupAwaitCandidate | null;
}

function runtimeCleanupInboxStore(deps: CliDeps): RuntimeCleanupInboxStore | null {
  const candidate = deps.store as unknown as Partial<RuntimeCleanupInboxStore>;
  if (
    typeof candidate.listRuntimeCleanupInboxDeliveries !== "function" ||
    typeof candidate.getRuntimeCleanupRequest !== "function" ||
    typeof candidate.claimRuntimeCleanupRequest !== "function"
  ) {
    return null;
  }
  return candidate as RuntimeCleanupInboxStore;
}

function runtimeCleanupAwaitStore(deps: CliDeps): RuntimeCleanupAwaitStore | null {
  const inboxStore = runtimeCleanupInboxStore(deps);
  if (inboxStore === null) {
    return null;
  }
  const candidate = inboxStore as Partial<RuntimeCleanupAwaitStore>;
  if (typeof candidate.peekRuntimeCleanupAwaitCandidate !== "function") {
    throw new Error("runtime cleanup inbox capability に await candidate peek がありません");
  }
  return candidate as RuntimeCleanupAwaitStore;
}

function canonicalPath(path: string, label: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new Error(`${label} を実体パスへ解決できません: ${path}`);
  }
}

function discoverRepoCommonDir(cwd: string): string {
  try {
    return execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    throw new Error("--repo-common-dir 未指定時は --cwd が Git worktree である必要があります");
  }
}

function runRegister(
  deps: CliDeps,
  options: JsonOption & { label: string; project: string; cwd: string; repoCommonDir?: string; provider?: string; providerSessionId?: string },
): void {
  const authority = parseProviderAuthority(deps, options, false);
  const cwd = canonicalPath(options.cwd, "cwd");
  const discoveredRepoCommonDir = options.repoCommonDir ?? discoverRepoCommonDir(cwd);
  const repoCommonDir = canonicalPath(discoveredRepoCommonDir, "repo common dir");
  const orchestrator = deps.store.registerOrchestrator({
    label: options.label,
    project: options.project,
    repoCommonDir,
  });
  const existingSession = deps.store
    .listOrchestratorSessions(orchestrator.id)
    .find((candidate) => candidate.status === "active" || candidate.status === "handoff_pending");
  if (existingSession === undefined) {
    assertGenericReplacementGate(deps, orchestrator.id);
  }
  const session = existingSession ?? deps.store.startOrchestratorSession({
    orchestratorId: orchestrator.id,
    provider: authority.provider,
    providerSessionId: authority.providerSessionId,
  });
  const watch = deps.store.addOrchestratorWatch({
    orchestratorId: orchestrator.id,
    scope: "worktree",
    selector: cwd,
    role: "primary",
  });
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(orchestrator, { orchestrator, session, watch }),
    [
      `orchestrator を登録しました: ${orchestrator.id}`,
      `session=${session.id} generation=${session.generation}`,
      `watch=${watch.id} worktree=${watch.selector}`,
    ],
  );
}

function runOrchestratorList(deps: CliDeps, options: JsonOption): void {
  const orchestrators = deps.store.listOrchestrators();
  const rows = orchestrators.map((orchestrator) => ({
    orchestrator,
    liveSession: deps.store
      .listOrchestratorSessions(orchestrator.id)
      .find((session) => session.status === "active" || session.status === "handoff_pending") ?? null,
  }));
  const lines = rows.length === 0
    ? ["(orchestrator identity はありません)"]
    : rows.map(({ orchestrator, liveSession }) =>
        `${orchestrator.id} ${orchestrator.label} project=${orchestrator.project}` +
        ` session=${liveSession?.id ?? "-"} generation=${liveSession?.generation ?? "-"}`,
      );
  emit(deps, options.json === true, { orchestrators: rows }, lines);
}

function runSessionStart(
  deps: CliDeps,
  orchestratorId: string,
  options: JsonOption & { provider?: string; providerSessionId?: string },
): void {
  const authority = parseProviderAuthority(deps, options, false);
  assertGenericReplacementGate(deps, orchestratorId);
  const session = deps.store.startOrchestratorSession({
    orchestratorId,
    provider: authority.provider,
    providerSessionId: authority.providerSessionId,
  });
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(session, { session }),
    [`session を開始しました: ${session.id} generation=${session.generation}`],
  );
}

function runSessionStatus(deps: CliDeps, options: JsonOption & { orchestrator?: string }): void {
  const sessions = deps.store.listOrchestratorSessions(options.orchestrator);
  const text = sessions.length === 0
    ? ["(orchestrator session はありません)"]
    : sessions.map((session) => `${session.id} [${session.status}] orchestrator=${session.orchestratorId} generation=${session.generation} heartbeat=${session.heartbeatAt}`);
  emit(deps, options.json === true, { sessions }, text);
}

/** provider native session ID から live board session を一意に解決する読み取り専用経路。 */
function resolveLiveOrchestratorSession(deps: CliDeps, providerSessionIdInput: string): OrchestratorSessionRow {
  const providerSessionId = providerSessionIdInput.trim();
  if (providerSessionId === "") {
    throw new Error("provider session ID は空にできません");
  }
  const matches = deps.store.listOrchestratorSessions().filter((session) =>
    (session.status === "active" || session.status === "handoff_pending") &&
    session.providerSessionId === providerSessionId
  );
  if (matches.length !== 1) {
    throw new Error(
      `live orchestrator session を一意に解決できません: providerSessionId=${providerSessionId} matches=${matches.length}`,
    );
  }
  return matches[0]!;
}

/** provider native session ID から live board session を shell 代入形式で一意に解決する読み取り専用経路。 */
function runSessionResolve(deps: CliDeps, options: { providerSessionId: string }): void {
  const providerSessionId = options.providerSessionId.trim();
  const session = resolveLiveOrchestratorSession(deps, providerSessionId);
  emit(deps, false, { session }, [
    `SID=${shellQuote(session.id)}`,
    `GEN=${session.generation}`,
  ]);
}

async function resolveHeartbeatSessionWithRetry(
  deps: CliDeps,
  providerSessionId: string,
): Promise<OrchestratorSessionRow | null> {
  for (let attempt = 1; attempt <= SUCCESSOR_SESSION_RESOLVE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return resolveLiveOrchestratorSession(deps, providerSessionId);
    } catch {
      if (attempt < SUCCESSOR_SESSION_RESOLVE_MAX_ATTEMPTS) {
        await sleep(1_000);
      }
    }
  }
  return null;
}

interface BootstrapHeartbeatOptions extends JsonOption {
  providerSessionId: string;
  daemon?: boolean;
}

async function runBootstrapHeartbeat(deps: CliDeps, options: BootstrapHeartbeatOptions): Promise<void> {
  const providerSessionId = options.providerSessionId.trim();
  const lifecycle = deps.orchestratorHeartbeatLifecycle ?? DEFAULT_ORCHESTRATOR_HEARTBEAT_LIFECYCLE;
  if (options.daemon === true) {
    const daemonEnvironment = heartbeatDaemonEnvironment(deps.processEnv);
    const result = await lifecycle.runDaemon({
      home: deps.env.home,
      providerSessionId,
      sessionId: daemonEnvironment.sessionId,
      generation: daemonEnvironment.generation,
      ownerToken: daemonEnvironment.ownerToken,
      heartbeat: () => {
        deps.store.heartbeatOrchestratorSession(daemonEnvironment.sessionId, daemonEnvironment.generation);
      },
      onTransientError: (message) => {
        deps.stderr.write(`警告: heartbeat 一時エラーのため再試行します: ${message}\n`);
      },
    });
    if (result.reason === "superseded") {
      deps.stderr.write(`heartbeat loop を終了します: ${result.error}\n`);
    } else {
      deps.stdout.write("heartbeat loop を停止しました\n");
    }
    deps.exit(result.exitCode);
    return;
  }

  const session = await resolveHeartbeatSessionWithRetry(deps, providerSessionId);
  if (session === null) {
    deps.stderr.write(
      `警告: session 解決の上限に達したため heartbeat を開始しません: providerSessionId=${providerSessionId}\n`,
    );
    deps.exit(1);
    return;
  }
  const result = await lifecycle.bootstrap({
    home: deps.env.home,
    board: deps.env.board,
    providerSessionId,
    sessionId: session.id,
    generation: session.generation,
    processEnv: deps.processEnv,
  });
  emit(deps, options.json === true, { heartbeat: result }, [
    `heartbeat を開始しました: pid=${result.pid} processStartedAt=${result.processStartedAt}`,
    `pidfile=${result.pidfile}`,
    `logfile=${result.logfile}`,
  ]);
}

function heartbeatStopText(result: HeartbeatStopResult): string[] {
  if (result.status === "not-running") {
    return ["heartbeat は起動していません", `pidfile=${result.pidfile}`];
  }
  if (result.status === "stale-pidfile") {
    return [
      `heartbeat pidfile を回収しました: pid=${result.pid} pidReused=${result.pidReused}`,
      `disappearanceConfirmed=${result.disappearanceConfirmed}`,
    ];
  }
  return [
    `heartbeat を停止しました: pid=${result.pid} forced=${result.forced}`,
    `disappearanceConfirmed=${result.disappearanceConfirmed}`,
  ];
}

async function runStopHeartbeat(
  deps: CliDeps,
  options: JsonOption & { providerSessionId: string },
): Promise<void> {
  const lifecycle = deps.orchestratorHeartbeatLifecycle ?? DEFAULT_ORCHESTRATOR_HEARTBEAT_LIFECYCLE;
  const result = await lifecycle.stop({
    home: deps.env.home,
    providerSessionId: options.providerSessionId,
  });
  emit(deps, options.json === true, { heartbeat: result }, heartbeatStopText(result));
}

function runHeartbeat(deps: CliDeps, sessionId: string, options: JsonOption & { generation: number }): void {
  const session = deps.store.heartbeatOrchestratorSession(sessionId, options.generation);
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(session, { session }),
    [`heartbeat を更新しました: ${session.id}`],
  );
}

function runClose(deps: CliDeps, sessionId: string, options: JsonOption & { generation: number }): void {
  const session = deps.store.closeOrchestratorSession(sessionId, options.generation);
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(session, { session }),
    [`session を閉じました: ${session.id}`],
  );
}

function runHandoffPrepare(deps: CliDeps, sessionId: string, options: JsonOption & { generation: number }): void {
  const token = newNonce() + newNonce();
  const expiresAt = Math.floor(Date.now() / 1000) + HANDOFF_TTL_SEC;
  const session = deps.store.prepareOrchestratorHandoff(sessionId, options.generation, hashToken(token), expiresAt);
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(session, { session, handoffToken: token, expiresAt }),
    [
      `handoff を準備しました: session=${session.id}`,
      `handoffToken=${token}`,
      `expiresAt=${expiresAt}`,
    ],
  );
}

function runHandoffAccept(
  deps: CliDeps,
  oldSessionId: string,
  options: JsonOption & { token: string; provider?: string; providerSessionId?: string; attestationHandle?: string },
): void {
  const authority = parseProviderAuthority(deps, options, true);
  const tokenHash = hashToken(options.token);
  let session: OrchestratorSessionRow;
  if (authority.kind === "trusted-codex") {
    const trusted = findTrustedSuccessorLaunch(deps, authority.attestationHandle, "handoff");
    if (trusted.launch.sourceSessionId !== oldSessionId) {
      throw new Error("Codex successor attestation の source session が一致しません");
    }
    if (trusted.launch.handoffTokenFenceHash !== tokenHash) {
      throw new Error("Codex successor attestation の handoff token fence が一致しません");
    }
    const claimed = deps.store.claimSuccessorLaunchAccept({
      slotId: trusted.launch.id,
      expectedRevision: trusted.launch.revision,
      attestationHandleHash: trusted.handleHash,
      operation: "handoff",
    });
    session = deps.store.acceptOrchestratorHandoffWithSuccessorLaunch({
      slotId: trusted.launch.id,
      expectedRevision: claimed.launch.revision,
      acceptFenceHash: hashToken(claimed.acceptFence),
      attestationHandleHash: trusted.handleHash,
      handoffTokenHash: tokenHash,
    });
  } else {
    const old = deps.store.getOrchestratorSession(oldSessionId);
    if (old !== null) assertGenericReplacementGate(deps, old.orchestratorId);
    session = deps.store.acceptOrchestratorHandoff({
      oldSessionId,
      tokenHash,
      provider: authority.provider,
      providerSessionId: authority.providerSessionId,
    });
  }
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(session, { session }),
    [`handoff を受理しました: session=${session.id} generation=${session.generation}`],
  );
}

/**
 * 停止確認済みの後継が accept しないまま残した handoff_pending を active へ戻す。
 * token hash 一致は core の CAS 条件として維持し、停止確認の明示宣言も必須にする。
 */
function runHandoffCancel(
  deps: CliDeps,
  sessionId: string,
  options: JsonOption & { generation: number; tokenHash: string; confirmSuccessorStopped: boolean },
): void {
  if (!/^[0-9a-f]{64}$/.test(options.tokenHash)) {
    throw new Error("--token-hash は SHA-256 の64桁小文字16進で指定してください");
  }
  if (options.confirmSuccessorStopped !== true) {
    throw new Error("後継の exact tmux session / pane PID / process group の停止確認が必要です");
  }
  const session = deps.store.cancelOrchestratorHandoff(sessionId, options.generation, options.tokenHash);
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(session, { session }),
    [`handoff_pending を取り消しました: session=${session.id} status=${session.status}`],
  );
}

function runTakeover(
  deps: CliDeps,
  orchestratorId: string,
  options: JsonOption & { staleSec: number; provider?: string; providerSessionId?: string; attestationHandle?: string },
): void {
  const authority = parseProviderAuthority(deps, options, true);
  let session: OrchestratorSessionRow;
  if (authority.kind === "trusted-codex") {
    const trusted = findTrustedSuccessorLaunch(deps, authority.attestationHandle, "takeover");
    if (trusted.launch.orchestratorId !== orchestratorId) {
      throw new Error("Codex successor attestation の orchestrator identity が一致しません");
    }
    const claimed = deps.store.claimSuccessorLaunchAccept({
      slotId: trusted.launch.id,
      expectedRevision: trusted.launch.revision,
      attestationHandleHash: trusted.handleHash,
      operation: "takeover",
    });
    session = deps.store.takeoverStaleOrchestratorSessionWithSuccessorLaunch({
      slotId: trusted.launch.id,
      expectedRevision: claimed.launch.revision,
      acceptFenceHash: hashToken(claimed.acceptFence),
      attestationHandleHash: trusted.handleHash,
    });
  } else {
    assertGenericReplacementGate(deps, orchestratorId);
    const staleBefore = Math.floor(Date.now() / 1000) - options.staleSec;
    session = deps.store.takeoverStaleOrchestratorSession({
      orchestratorId,
      staleBefore,
      provider: authority.provider,
      providerSessionId: authority.providerSessionId,
    });
  }
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(session, { session }),
    [`stale session を takeover しました: ${session.id} generation=${session.generation}`],
  );
}

function runWatchAdd(
  deps: CliDeps,
  options: JsonOption & { orchestrator: string; scope: string; selector: string; role: string; priority?: number },
): void {
  const watch = deps.store.addOrchestratorWatch({
    orchestratorId: options.orchestrator,
    scope: parseScope(options.scope),
    selector: options.selector,
    role: parseRole(options.role),
    priority: options.priority ?? 0,
  });
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(watch, { watch }),
    [`watch を追加しました: ${watch.id}`],
  );
}

/** watch 一覧の並び順。scope tier は §69.3 の解決順（task → subtree → worktree → project）に合わせる */
const WATCH_SCOPE_ORDER: Record<OrchestratorWatchScope, number> = { task: 0, subtree: 1, worktree: 2, project: 3 };

/** subtree scope の watch は selector が task ID なので、対象タスクのタイトルを添えて読めるようにする */
function describeWatchSubject(deps: CliDeps, watch: OrchestratorWatchRow): string {
  if (watch.scope !== "subtree") {
    return "";
  }
  const task = deps.store.getTask(watch.selector);
  return ` title=${task === null ? "(不明)" : task.title}`;
}

function formatWatchLine(deps: CliDeps, watch: OrchestratorWatchRow): string {
  return `${watch.id} [${watch.active ? "active" : "inactive"}] ${watch.scope}:${watch.selector} role=${watch.role} orchestrator=${watch.orchestratorId}${describeWatchSubject(deps, watch)}`;
}

function runWatchList(deps: CliDeps, options: JsonOption & { orchestrator?: string; all?: boolean }): void {
  // 既定は active のみ。inactive まで見たいときだけ --all（listOrchestratorWatches の既定は全件のまま維持する）
  const includeInactive = options.all === true;
  const watches = deps.store
    .listOrchestratorWatches(options.orchestrator)
    .filter((watch) => includeInactive || watch.active)
    // Array#sort は安定なので、scope tier で並べ替えても tier 内の priority DESC, created_at 順は保たれる
    .sort((left, right) => WATCH_SCOPE_ORDER[left.scope] - WATCH_SCOPE_ORDER[right.scope]);
  const text = watches.length === 0
    ? ["(watch はありません)"]
    : watches.map((watch) => formatWatchLine(deps, watch));
  emit(deps, options.json === true, { watches }, text);
}

/**
 * realpath 失敗を stale 判定へ変換する（docs/contract.md §69.3 の follow-up）。
 * 「消えている」と確実に言える ENOENT / ENOTDIR だけを missing とし、
 * 権限エラー等は fail-closed で unknown（＝watch を残す）にする。
 */
export function classifyWatchSelectorError(error: unknown): "missing" | "unknown" {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
}

/** worktree scope watch の selector が実在ディレクトリを指しているかを realpath で判定する */
function probeWatchSelector(selector: string): "present" | "missing" | "unknown" {
  // 相対 selector は realpath が CLI の cwd 基準で解決され、無関係な場所を見て stale と誤判定する。
  // watch add は selector を trim するだけで絶対パスを強制しないため、ここで fail-closed に倒す
  if (!isAbsolute(selector)) {
    return "unknown";
  }
  try {
    // symlink 先が消えている場合も realpath が ENOENT で落ちるため、stat ではなく realpath を使う
    return statSync(realpathSync(selector)).isDirectory() ? "present" : "missing";
  } catch (error) {
    return classifyWatchSelectorError(error);
  }
}

interface PrunedWatch {
  id: string;
  selector: string;
  role: OrchestratorWatchRole;
}

/** prune が見送った watch。present（実在）と unknown（判定不能で fail-closed に残した）を区別する */
interface SkippedWatch extends PrunedWatch {
  reason: "present" | "unknown";
}

function runWatchPrune(
  deps: CliDeps,
  options: JsonOption & { orchestrator: string; apply?: boolean },
): void {
  const apply = options.apply === true;
  // 対象は指定 identity の active な worktree scope watch だけ。他 identity・他 scope・inactive へは触れない
  const candidates = deps.store
    .listOrchestratorWatches(options.orchestrator)
    .filter((watch) => watch.active && watch.scope === "worktree");
  const stale: PrunedWatch[] = [];
  const skipped: SkippedWatch[] = [];
  for (const watch of candidates) {
    const probe = probeWatchSelector(watch.selector);
    const entry: PrunedWatch = { id: watch.id, selector: watch.selector, role: watch.role };
    if (probe === "missing") {
      stale.push(entry);
      continue;
    }
    skipped.push({ ...entry, reason: probe });
  }
  if (apply) {
    for (const watch of stale) {
      // 削除はしない。active=0 にするだけ（監査のため行は残す）
      deps.store.setOrchestratorWatchActive(watch.id, false);
    }
  }
  const header = apply
    ? `stale watch を ${stale.length} 件 inactive 化しました（走査 ${candidates.length} 件）`
    : `stale watch 候補 ${stale.length} 件（走査 ${candidates.length} 件）。実行するには --apply を付けてください`;
  emit(
    deps,
    options.json === true,
    { dryRun: !apply, orchestrator: options.orchestrator, scanned: candidates.length, stale, skipped },
    [header, ...stale.map((watch) => `${watch.id} worktree:${watch.selector} role=${watch.role}`)],
  );
}

function runWatchToggle(deps: CliDeps, watchId: string, active: boolean, options: JsonOption): void {
  const watch = deps.store.setOrchestratorWatchActive(watchId, active);
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(watch, { watch }),
    [`watch を${active ? "有効" : "無効"}化しました: ${watch.id}`],
  );
}

function runBind(
  deps: CliDeps,
  taskId: string,
  options: JsonOption & { orchestrator: string; role: string },
): void {
  const binding = deps.store.bindTaskToOrchestrator(taskId, options.orchestrator, parseRole(options.role));
  emit(deps, options.json === true, { binding }, [`task binding を追加しました: ${taskId} -> ${options.orchestrator}`]);
}

type OrchestratorAwaitCandidate =
  | {
      kind: "orchestrator";
      id: string;
      claimableAt: number;
      request: OrchestratorRequestRow;
    }
  | {
      kind: "runtime_cleanup";
      id: string;
      claimableAt: number;
      request: RuntimeCleanupAwaitCandidate;
    }
  | {
      kind: "human_decision";
      id: string;
      claimableAt: number;
      request: HumanDecisionRequestRow;
    };

interface OrchestratorAwaitCandidateSummary {
  kind: OrchestratorAwaitCandidate["kind"];
  id: string;
  claimableAt: number;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareOrchestratorAwaitCandidates(
  left: OrchestratorAwaitCandidate,
  right: OrchestratorAwaitCandidate,
): number {
  if (left.claimableAt !== right.claimableAt) {
    return left.claimableAt - right.claimableAt;
  }
  const kindComparison = compareCodeUnits(left.kind, right.kind);
  return kindComparison !== 0 ? kindComparison : compareCodeUnits(left.id, right.id);
}

function summarizeOrchestratorAwaitCandidate(
  candidate: OrchestratorAwaitCandidate,
): OrchestratorAwaitCandidateSummary {
  return {
    kind: candidate.kind,
    id: candidate.id,
    claimableAt: candidate.claimableAt,
  };
}

function humanDecisionAwaitCandidate(
  responses: readonly HumanDecisionRequestRow[],
  now: number,
): OrchestratorAwaitCandidate | null {
  for (const response of responses) {
    if (response.answeredAt === null) {
      throw new Error(`human decision response の answeredAt がありません: ${response.id}`);
    }
    const claimable = response.status === "answered" ||
      (response.status === "claimed" &&
        response.claimLeaseUntil !== null && response.claimLeaseUntil <= now);
    if (claimable) {
      return {
        kind: "human_decision",
        id: response.id,
        claimableAt: response.answeredAt,
        request: response,
      };
    }
  }
  return null;
}

function compareHumanDecisionResponses(
  left: HumanDecisionRequestRow,
  right: HumanDecisionRequestRow,
): number {
  if (left.answeredAt === null || right.answeredAt === null) {
    throw new Error("human decision response の answeredAt がありません");
  }
  return left.answeredAt === right.answeredAt
    ? compareCodeUnits(left.id, right.id)
    : left.answeredAt - right.answeredAt;
}

function isHumanDecisionAwaitClaimConflict(error: unknown): boolean {
  return error instanceof HumanDecisionError && error.code === "CLAIM_CONFLICT";
}

function otherCandidateText(candidates: readonly OrchestratorAwaitCandidateSummary[]): string[] {
  return candidates.map((candidate) =>
    `otherCandidate=${candidate.kind} id=${candidate.id} claimableAt=${candidate.claimableAt}`
  );
}

function runInbox(deps: CliDeps, options: JsonOption & { orchestrator?: string }): void {
  if (options.orchestrator !== undefined) {
    deps.store.markOrchestratorDeliveriesDelivered(options.orchestrator);
  }
  const requests = deps.store.listOrchestratorRequests(options.orchestrator);
  const cleanupRequests = options.orchestrator === undefined
    ? []
    : runtimeCleanupInboxStore(deps)?.listRuntimeCleanupInboxDeliveries(options.orchestrator) ?? [];
  const view = createKanbanReadView(deps.env.dbPath);
  try {
    const humanResponses = (options.orchestrator === undefined
      ? view.listHumanDecisionRequests({ statuses: ["answered", "claimed"] })
      : view.listHumanDecisionResponses({ ownerOrchestratorId: options.orchestrator }))
      .sort(compareHumanDecisionResponses);
    const text = requests.length === 0 && cleanupRequests.length === 0 && humanResponses.length === 0
      ? ["(未処理 request はありません)"]
      : [
          ...requests.map((request) => `${request.id} [${request.status}] task=${request.taskId} question=${request.question}`),
          ...cleanupRequests.map((request) =>
            `${request.requestId} [${request.requestStatus}] cleanup lease=${request.leaseId} reason=${request.reason}`,
          ),
          ...humanResponses.map((request) =>
            `${request.id} [${request.status}] human_decision task=${request.taskId} question=${request.question}`,
          ),
        ];
    emit(deps, options.json === true, { requests, cleanupRequests, humanResponses }, text);
  } finally {
    view.close();
  }
}

async function runAwait(
  deps: CliDeps,
  options: JsonOption & { session: string; generation: number; interval: number; lease: number; maxWait?: number },
): Promise<void> {
  const startedAt = Date.now();
  let orchestratorId = "";
  const heartbeat = new OrchestratorAwaitHeartbeat({
    heartbeat: () => {
      orchestratorId = deps.store
        .heartbeatOrchestratorSession(options.session, options.generation)
        .orchestratorId;
    },
  });
  let view: ReturnType<typeof createKanbanReadView> | null = null;
  const signalViewCloseState: { failure: { error: unknown } | null } = { failure: null };
  const closeView = (): void => {
    const current = view;
    view = null;
    current?.close();
  };
  const removeSignalCleanup = installAwaitSignalCleanup(() => {
    try {
      closeView();
    } catch (error) {
      signalViewCloseState.failure = { error };
    } finally {
      heartbeat.stop();
    }
  });
  try {
    heartbeat.start();
    view = createKanbanReadView(deps.env.dbPath);
    while (true) {
      const now = Math.floor(Date.now() / 1000);
      deps.store.markOrchestratorDeliveriesDelivered(orchestratorId);
      const requests = deps.store.listOrchestratorRequests(orchestratorId);
      const orchestratorRequest = requests.find((request) =>
        request.status === "queued" ||
        request.status === "delivered" ||
        (request.status === "claimed" && request.leaseUntil !== null && request.leaseUntil < now),
      );
      const cleanupStore = runtimeCleanupAwaitStore(deps);
      const cleanupRequest = cleanupStore?.peekRuntimeCleanupAwaitCandidate(orchestratorId, now) ?? null;
      const humanRequest = humanDecisionAwaitCandidate(
        view.listHumanDecisionResponses({ ownerOrchestratorId: orchestratorId }),
        now,
      );
      const candidates: OrchestratorAwaitCandidate[] = [];
      if (orchestratorRequest !== undefined) {
        candidates.push({
          kind: "orchestrator",
          id: orchestratorRequest.id,
          claimableAt: orchestratorRequest.createdAt,
          request: orchestratorRequest,
        });
      }
      if (cleanupRequest !== null) {
        candidates.push({
          kind: "runtime_cleanup",
          id: cleanupRequest.requestId,
          claimableAt: cleanupRequest.claimableAt,
          request: cleanupRequest,
        });
      }
      if (humanRequest !== null) {
        candidates.push(humanRequest);
      }
      candidates.sort(compareOrchestratorAwaitCandidates);
      const candidate = candidates[0];
      const otherCandidates = candidates.slice(1, 3).map(summarizeOrchestratorAwaitCandidate);
      if (candidate?.kind === "orchestrator") {
        const claimToken = newNonce() + newNonce();
        try {
          const request = deps.store.claimOrchestratorRequest({
            requestId: candidate.id,
            sessionId: options.session,
            generation: options.generation,
            claimToken,
            leaseUntil: now + options.lease,
          });
          emit(
            deps,
            options.json === true,
            singularResourceEnvelope(request, { request, claimToken, otherCandidates }),
            [
              `request を claim しました: ${request.id}`,
              `task=${request.taskId}`,
              `claimToken=${claimToken}`,
              `question=${request.question}`,
              ...(request.humanAnswer.length > 0 ? [`humanAnswer=${request.humanAnswer}`] : []),
              ...otherCandidateText(otherCandidates),
            ],
          );
          return;
        } catch (error) {
          if (!isOrchestratorAwaitClaimConflict(error)) {
            throw error;
          }
        }
      }
      if (candidate?.kind === "runtime_cleanup" && cleanupStore !== null) {
        const pendingRequest = cleanupStore.getRuntimeCleanupRequest(candidate.request.requestId);
        if (pendingRequest === null) {
          throw new Error(`runtime cleanup request が見つかりません: ${candidate.request.requestId}`);
        }
        const claimToken = newNonce() + newNonce();
        const claimTokenPath = writeCleanupClaimToken(deps, pendingRequest, claimToken);
        let request: RuntimeCleanupRequestRow | null = null;
        try {
          request = cleanupStore.claimRuntimeCleanupRequest({
            requestId: candidate.request.requestId,
            orchestratorId,
            sessionId: options.session,
            generation: options.generation,
            claimToken,
            expectedLeaseFence: candidate.request.expectedLeaseFence,
            leaseUntil: now + options.lease,
            now,
          });
        } catch (error) {
          assertCleanupClaimTokenRemoved(removeCleanupClaimToken(deps, claimTokenPath));
          if (!isOrchestratorAwaitClaimConflict(error)) {
            throw error;
          }
        }
        if (request !== null) {
          emit(
            deps,
            options.json === true,
            singularResourceEnvelope(request, { kind: "runtime_cleanup", request, claimTokenPath, otherCandidates }),
            [
              `cleanup request を claim しました: ${request.id}`,
              `lease=${request.leaseId}`,
              `expectedLeaseFence=${request.expectedLeaseFence}`,
              `claimTokenPath=${claimTokenPath}`,
              `reason=${request.reason}`,
              ...(request.humanAnswer.length > 0 ? [`humanAnswer=${request.humanAnswer}`] : []),
              ...otherCandidateText(otherCandidates),
            ],
          );
          return;
        }
      }
      if (candidate?.kind === "human_decision") {
        const claimToken = newNonce() + newNonce();
        try {
          const request = deps.store.claimHumanDecisionResponse({
            requestId: candidate.id,
            expectedRevision: 1,
            claimToken,
            leaseUntil: now + options.lease,
            provenance: {
              kind: "orchestrator",
              actorId: orchestratorId,
              actorSessionId: options.session,
              actorGeneration: options.generation,
            },
            now,
          });
          emit(
            deps,
            options.json === true,
            singularResourceEnvelope(request, {
              kind: "human_decision",
              request,
              claimToken,
              otherCandidates,
            }),
            [
              `human decision response を claim しました: ${request.id}`,
              `task=${request.taskId}`,
              `question=${request.question}`,
              `answer=${JSON.stringify(request.answer)}`,
              `claimToken=${claimToken}`,
              ...otherCandidateText(otherCandidates),
            ],
          );
          return;
        } catch (error) {
          if (!isHumanDecisionAwaitClaimConflict(error)) {
            throw error;
          }
        }
      }
      const elapsedMs = Date.now() - startedAt;
      if (options.maxWait !== undefined && elapsedMs >= options.maxWait * 1000) {
        deps.exit(2);
        return;
      }
      const intervalMs = options.interval * 1000;
      const remainingMs = options.maxWait === undefined
        ? intervalMs
        : Math.max(0, options.maxWait * 1000 - elapsedMs);
      await heartbeat.wait(Math.min(intervalMs, remainingMs));
    }
  } finally {
    try {
      closeView();
      if (signalViewCloseState.failure !== null) {
        throw signalViewCloseState.failure.error;
      }
    } finally {
      removeSignalCleanup();
      heartbeat.stop();
    }
  }
}

function requireClaimedRequest(deps: CliDeps, requestId: string): OrchestratorRequestRow {
  const request = deps.store.getOrchestratorRequest(requestId);
  if (request === null) {
    throw new Error(`request が見つかりません: ${requestId}`);
  }
  return request;
}

function requireWorkerQuestionRequest(deps: CliDeps, requestId: string, operation: "answer" | "escalate"): OrchestratorRequestRow {
  const request = requireClaimedRequest(deps, requestId);
  if (request.kind !== "worker_question") {
    throw new Error(
      `orchestrator ${operation} は kind=worker_question 専用です: kind=${request.kind}。` +
        "run_stalled は orchestrator resolve を使用してください",
    );
  }
  return request;
}

function runAnswer(
  deps: CliDeps,
  requestId: string,
  answer: string,
  options: JsonOption & { session: string; generation: number; claim: string },
): void {
  const request = requireWorkerQuestionRequest(deps, requestId, "answer");
  const session = deps.store.getOrchestratorSession(options.session);
  if (session === null) {
    throw new Error(`orchestrator session が見つかりません: ${options.session}`);
  }
  const provenance = {
    kind: "orchestrator" as const,
    actorId: session.orchestratorId,
    actorSessionId: session.id,
    actorGeneration: options.generation,
  };
  const idempotencyKey = newNonce();
  const message: AgentMessageV1 = {
    schema: "agent.message.v1",
    from: { role: "orchestrator", provider: "", sessionId: options.session },
    to: { role: "worker", taskId: request.taskId },
    intent: "answer",
    payload: { answer: redactText(answer) },
    idempotencyKey,
    createdAt: Math.floor(Date.now() / 1000),
  };
  deps.store.transaction((): void => {
    deps.store.beginOrchestratorRequestAnswer({
      requestId,
      sessionId: options.session,
      generation: options.generation,
      claimToken: options.claim,
      answerKey: idempotencyKey,
    });
    deps.store.addComment(
      request.taskId,
      `orchestrator:${options.session}`,
      serializeAgentMessage(message),
      provenance,
    );
    deps.store.addEvent(
      request.taskId,
      "orchestrator_answer_enqueued",
      "orchestrator",
      { requestId, idempotencyKey },
      provenance,
    );
  });
  const updatedRequest = requireClaimedRequest(deps, requestId);
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(updatedRequest, { requestId, message }),
    [`orchestrator answer を送信しました: request=${requestId}`],
  );
}

function runEscalate(
  deps: CliDeps,
  requestId: string,
  question: string,
  options: JsonOption & { session: string; generation: number; claim: string },
): void {
  requireWorkerQuestionRequest(deps, requestId, "escalate");
  const request = deps.store.escalateOrchestratorRequest({
    requestId,
    sessionId: options.session,
    generation: options.generation,
    claimToken: options.claim,
    question: redactText(question),
  });
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(request, { request }),
    [`human へエスカレーションしました: request=${request.id}`],
  );
}

function runResolve(
  deps: CliDeps,
  requestId: string,
  resolution: string,
  reason: string,
  options: JsonOption & { session: string; generation: number; claim: string },
): void {
  if (resolution !== "handled" && resolution !== "false_positive") {
    throw new Error(`resolution は handled / false_positive のみです: ${resolution}`);
  }
  const redactedReason = redactText(reason);
  const request = resolveRunStalledOrchestratorRequest(deps.store, {
    requestId,
    sessionId: options.session,
    generation: options.generation,
    claimToken: options.claim,
    resolution,
    reason: redactedReason,
  });
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(request, { request, resolution, reason: redactedReason }),
    [`${request.kind} request を resolve しました: request=${request.id} resolution=${resolution}`],
  );
}

function runRelease(
  deps: CliDeps,
  requestId: string,
  options: JsonOption & { session: string; generation: number; claim: string },
): void {
  const request = deps.store.releaseOrchestratorRequest({
    requestId,
    sessionId: options.session,
    generation: options.generation,
    claimToken: options.claim,
  });
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(request, { request }),
    [`request を release しました: ${request.id}`],
  );
}

// =============================================================================
// orchestrator handover dry-run（M3: 後継セッション起動の事前検証）
// 副作用ゼロ。tmux を起動しない、token を発行しない、board を変更しない。
// =============================================================================

/** body 内の `cwd: <path>` 行からパスを抽出する */
function parseCwdFromBody(body: string): string | null {
  const match = body.match(/^cwd:\s*(\S+)\s*$/m);
  return match?.[1] ?? null;
}

/** tmux 事前検査のデフォルト実装（実機の tmux を使う） */
const defaultTmuxProbe: TmuxProbe = {
  available(): boolean {
    try {
      execFileSync("which", ["tmux"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
  listSessionNames(): string[] {
    try {
      const output = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return output.trim().split("\n").filter(Boolean);
    } catch (err) {
      // サーバー未起動は「セッション 0 件」。socket 権限・互換性などの異常まで空配列にすると
      // 名前衝突を検査できていないのに「衝突なし」と判定してしまうため、そちらは投げる。
      const stderr = typeof (err as { stderr?: unknown }).stderr === "string"
        ? (err as { stderr: string }).stderr
        : "";
      if (/no server running/i.test(stderr)) {
        return [];
      }
      throw err;
    }
  },
};

/** tmux セッション起動・生存確認のデフォルト実装（実機の tmux を使う） */
const SUCCESSOR_TMUX_FIELD_SEPARATOR = "\u001f";

interface SuccessorTmuxSnapshot {
  raw: string;
  tmuxSession: string | null;
  tmuxPane: string | null;
  panePid: number | null;
  cwd: string | null;
  ownerNonce: string | null;
}

function positiveIntegerOrNull(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function readSuccessorTmuxSnapshot(sessionName: string): SuccessorTmuxSnapshot {
  const output = execFileSync(
    "tmux",
    [
      "display-message", "-p", "-t", `${sessionName}:`, "-F",
      `#{session_name}${SUCCESSOR_TMUX_FIELD_SEPARATOR}#{pane_id}${SUCCESSOR_TMUX_FIELD_SEPARATOR}` +
        `#{pane_pid}${SUCCESSOR_TMUX_FIELD_SEPARATOR}#{pane_current_path}${SUCCESSOR_TMUX_FIELD_SEPARATOR}` +
        "#{@hachi_handoff_owner}",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const raw = output.endsWith("\r\n") ? output.slice(0, -2) :
    output.endsWith("\n") ? output.slice(0, -1) : output;
  const fields = raw.includes("\n") || raw.includes("\r") ? [] : raw.split(SUCCESSOR_TMUX_FIELD_SEPARATOR);
  const [observedSession = "", pane = "", rawPid = "", cwd = "", ownerNonce = ""] = fields;
  return {
    raw,
    tmuxSession: observedSession === "" ? null : observedSession,
    tmuxPane: /^%[0-9]+$/.test(pane) ? pane : null,
    panePid: positiveIntegerOrNull(rawPid),
    cwd: cwd === "" ? null : cwd,
    ownerNonce: ownerNonce === "" ? null : ownerNonce,
  };
}

function readDefaultSuccessorRuntime(sessionName: string): SuccessorLaunchRuntimeReadback {
  let before: SuccessorTmuxSnapshot;
  try {
    before = readSuccessorTmuxSnapshot(sessionName);
  } catch {
    return {
      stable: false,
      tmuxSession: null,
      tmuxPane: null,
      panePid: null,
      processGroupId: null,
      cwd: null,
      ownerNonce: null,
    };
  }
  let processGroupId: number | null = null;
  if (before.panePid !== null) {
    try {
      const output = execFileSync("ps", ["-o", "pgid=", "-p", String(before.panePid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      processGroupId = positiveIntegerOrNull(output.trim());
    } catch {
      processGroupId = null;
    }
  }
  let after = before;
  try {
    after = readSuccessorTmuxSnapshot(sessionName);
  } catch {
    return {
      stable: false,
      tmuxSession: before.tmuxSession,
      tmuxPane: before.tmuxPane,
      panePid: before.panePid,
      processGroupId,
      cwd: before.cwd,
      ownerNonce: before.ownerNonce,
    };
  }
  return {
    stable: before.raw === after.raw && before.panePid === after.panePid,
    tmuxSession: after.tmuxSession,
    tmuxPane: after.tmuxPane,
    panePid: after.panePid,
    processGroupId: before.panePid === after.panePid ? processGroupId : null,
    cwd: after.cwd,
    ownerNonce: after.ownerNonce,
  };
}

export const defaultTmuxLauncher: TmuxLauncher = {
  launch(args: string[]): { ok: true; pid: number } | { ok: false; reason: string } {
    // tmuxArgs を execFile へそのまま渡す（tmuxCommandLine を shell へ渡さない）
    const result = spawnSync("tmux", args, { stdio: "ignore" });
    if (result.status !== 0) {
      const reason = result.error !== undefined
        ? result.error.message
        : `tmux が exit code ${result.status ?? "unknown"} で終了しました`;
      return { ok: false, reason };
    }
    return { ok: true, pid: result.pid };
  },
  hasSession(name: string): boolean {
    const result = spawnSync("tmux", ["has-session", "-t", name], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (result.status === 0) return true;
    const stderr = (result.stderr ?? "").trim();
    if (result.status === 1 && /can't find session|no server running/i.test(stderr)) return false;
    throw result.error ?? new Error(`tmux has-session の結果を判定できません: ${stderr || result.status}`);
  },
  getPaneRootPid(name: string): number | null {
    try {
      const output = execFileSync("tmux", ["list-panes", "-t", name, "-F", "#{pane_pid}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pid = parseInt(output.trim().split("\n")[0] ?? "", 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  },
  killSession(sessionName: string): boolean {
    const result = spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
    return result.status === 0;
  },
  getProcessGroupId(pid: number): number | null {
    try {
      const out = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pgid = parseInt(out.trim(), 10);
      return Number.isNaN(pgid) ? null : pgid;
    } catch {
      return null;
    }
  },
  isProcessGroupAlive(pgid: number): boolean {
    const result = spawnSync("pgrep", ["-g", String(pgid)], { stdio: "ignore" });
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw result.error ?? new Error(`process group ${pgid} の生存を判定できません`);
  },
  setSessionOwnerNonce(name: string, nonce: string): boolean {
    const result = spawnSync("tmux", ["set-option", "-t", name, "@hachi_handoff_owner", nonce], { stdio: "ignore" });
    return result.status === 0;
  },
  getSessionOwnerNonce(name: string): string | null {
    const result = spawnSync("tmux", ["show-option", "-t", name, "-v", "@hachi_handoff_owner"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      return null;
    }
    const value = (result.stdout ?? "").trim();
    return value === "" ? null : value;
  },
  readSuccessorRuntime(sessionName: string): SuccessorLaunchRuntimeReadback {
    return readDefaultSuccessorRuntime(sessionName);
  },
  releaseSuccessorBarrier(barrier: string): boolean {
    const result = spawnSync("tmux", ["wait-for", "-S", barrier], { stdio: "ignore" });
    return result.status === 0;
  },
  isPaneProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  },
};

export interface HandoverPreflightResult {
  name: string;
  ok: boolean;
  reason?: string;
  cwdSource?: "mission-cwd" | "repo-root-fallback";
}

type PreflightResult = HandoverPreflightResult;

export interface HandoverPreflightInspection {
  resolution: HandoverResolution;
  preflight: HandoverPreflightResult[];
  blocked: boolean;
  blockReasons: string[];
  sessionId?: string;
  generation?: number;
  missionId?: string;
}

interface HandoverOptions extends JsonOption {
  session?: string;
  generation?: number;
  mission?: string;
  orchestrator?: string;
  apply?: boolean;
  maxAttempts?: number;
}

interface HandoverAttemptPlan {
  successorSessionId: string;
  tmuxSessionName: string;
  handoffToken: string;
  launchNonce: string;
  ownerNonce: string;
  barrier: string;
  startupPrompt: string;
  tmuxArgs: string[];
  tmuxCommandLine: string;
  tmuxCommandBytes: number;
}

interface ResolvedHandoverPreflight {
  preflight: HandoverPreflightResult[];
  blocked: boolean;
  blockReasons: string[];
  sessionId: string;
  generation: number;
  missionId: string;
  session: OrchestratorSessionRow | null;
  orchestratorId: string;
  resolvedCwd: string;
  missionTask: TaskRow | null;
  orchestratorRequestCount: number;
  runtimeCleanupClaimCount: number;
  descendantStatusCounts: Record<string, number>;
  descendantTotal: number;
  firstAttemptPlan: HandoverAttemptPlan;
  tmuxCommandBytes: number;
}

interface HandoverAttemptHistoryEntry {
  attempt: number;
  slotId: string;
  successorSessionId: string;
  slotStatus: OrchestratorSuccessorLaunchRow["status"];
  failureReason: string | null;
  durationMs: number;
}

interface UsedHandoverAttemptValues {
  handoffTokens: Set<string>;
  successorSessionIds: Set<string>;
  launchNonces: Set<string>;
}

/**
 * POSIX shell 用の quoting。安全な文字だけなら素のまま返し、それ以外は単一引用で包む。
 * 表示用コマンドラインをそのままコピー実行しても意図しない副作用が起きないようにするため。
 */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

type HandoverResolutionStatus = "resolved" | "ambiguous" | "none";

interface HandoverResolutionCandidate {
  orchestratorId: string;
  label: string;
  project: string;
  sessionId: string;
  generation: number;
  sessionStatus: OrchestratorSessionRow["status"];
  heartbeatAgeSec: number;
  missionTaskId?: string;
  missionTitle?: string;
  command: string;
}

interface HandoverResolution {
  status: HandoverResolutionStatus;
  reason: string;
  candidates: HandoverResolutionCandidate[];
}

interface ResolvedHandover {
  resolution: HandoverResolution;
  sessionId: string;
  generation: number;
  mission: string;
}

const LIVE_SESSION_STATUS = "active" as const;
const TAKEOVER_SESSION_STATUSES = new Set(["stale", "handoff_pending"]);

function buildHandoverCommand(
  sessionId: string,
  generation: number,
  mission: string | undefined,
  apply: boolean,
): string {
  const args = [
    "hachi",
    "orchestrator",
    "handover",
    "--session",
    sessionId,
    "--generation",
    String(generation),
  ];
  if (mission !== undefined) {
    args.push("--mission", mission);
  }
  if (apply) {
    args.push("--apply");
  }
  return args.map(shellQuote).join(" ");
}

function buildTakeoverCommand(orchestratorId: string): string {
  return [
    "hachi",
    "orchestrator",
    "session",
    "takeover",
    orchestratorId,
    "--stale-sec",
    String(DEFAULT_STALE_SEC),
  ].map(shellQuote).join(" ");
}

function getOrchestratorForSession(deps: CliDeps, session: OrchestratorSessionRow): OrchestratorRow | null {
  return deps.store.getOrchestrator(session.orchestratorId);
}

function heartbeatAgeSec(session: OrchestratorSessionRow): number {
  return Math.max(0, Math.floor(Date.now() / 1000) - session.heartbeatAt);
}

function handoverResolutionCandidate(
  session: OrchestratorSessionRow,
  orchestrator: OrchestratorRow | null,
  apply: boolean,
  missionTaskId?: string,
  missionTitle?: string,
): HandoverResolutionCandidate {
  return {
    orchestratorId: orchestrator?.id ?? session.orchestratorId,
    label: orchestrator?.label ?? "(不明)",
    project: orchestrator?.project ?? "(不明)",
    sessionId: session.id,
    generation: session.generation,
    sessionStatus: session.status,
    heartbeatAgeSec: heartbeatAgeSec(session),
    ...(missionTaskId === undefined ? {} : { missionTaskId, missionTitle: missionTitle ?? "(不明)" }),
    command: buildHandoverCommand(session.id, session.generation, missionTaskId, apply),
  };
}

function takeoverResolutionCandidate(
  session: OrchestratorSessionRow,
  orchestrator: OrchestratorRow,
): HandoverResolutionCandidate {
  return {
    orchestratorId: orchestrator.id,
    label: orchestrator.label,
    project: orchestrator.project,
    sessionId: session.id,
    generation: session.generation,
    sessionStatus: session.status,
    heartbeatAgeSec: heartbeatAgeSec(session),
    command: buildTakeoverCommand(orchestrator.id),
  };
}

function resolutionForResolved(
  deps: CliDeps,
  options: HandoverOptions,
  session: OrchestratorSessionRow,
  mission: string,
): ResolvedHandover {
  const orchestrator = getOrchestratorForSession(deps, session);
  const missionTask = deps.store.getTask(mission);
  return {
    resolution: {
      status: "resolved",
      reason: "handover の対象を一意に解決しました",
      candidates: [
        handoverResolutionCandidate(
          session,
          orchestrator,
          options.apply === true,
          mission,
          missionTask?.title,
        ),
      ],
    },
    sessionId: session.id,
    generation: session.generation,
    mission,
  };
}

function unresolvedResolution(
  status: Exclude<HandoverResolutionStatus, "resolved">,
  reason: string,
  candidates: HandoverResolutionCandidate[] = [],
): { resolution: HandoverResolution } {
  return { resolution: { status, reason, candidates } };
}

function isResolvedHandover(
  result: ResolvedHandover | { resolution: HandoverResolution },
): result is ResolvedHandover {
  return result.resolution.status === "resolved";
}

function explicitConflict(flag: string, requested: string | number, actual: string): { resolution: HandoverResolution } {
  return unresolvedResolution(
    "none",
    `${flag}=${requested} は候補の実値 ${actual} と一致しません。`,
  );
}

function latestTakeoverSession(sessions: OrchestratorSessionRow[]): OrchestratorSessionRow | null {
  return [...sessions].sort((left, right) =>
    right.generation - left.generation ||
    right.updatedAt - left.updatedAt ||
    left.id.localeCompare(right.id),
  )[0] ?? null;
}

function resolveHandover(deps: CliDeps, options: HandoverOptions): ResolvedHandover | { resolution: HandoverResolution } {
  const explicitMissionTask = options.mission === undefined ? null : deps.store.getTask(options.mission);
  if (options.mission !== undefined && explicitMissionTask === null) {
    return explicitConflict("--mission", options.mission, "(該当なし)");
  }

  let session: OrchestratorSessionRow | null;
  if (options.session !== undefined) {
    session = deps.store.getOrchestratorSession(options.session);
    if (session === null) {
      return explicitConflict("--session", options.session, "(該当なし)");
    }
    if (options.orchestrator !== undefined && session.orchestratorId !== options.orchestrator) {
      return explicitConflict("--orchestrator", options.orchestrator, session.orchestratorId);
    }
    if (options.generation !== undefined && session.generation !== options.generation) {
      return explicitConflict("--generation", options.generation, String(session.generation));
    }
  } else {
    // `--orchestrator` の絞り込みは live 件数の判定より先に適用する。
    const allIdentities = deps.store.listOrchestrators();
    const identities = allIdentities
      .filter((orchestrator) => options.orchestrator === undefined || orchestrator.id === options.orchestrator);
    if (options.orchestrator !== undefined && identities.length === 0) {
      return explicitConflict(
        "--orchestrator",
        options.orchestrator,
        allIdentities.map((orchestrator) => orchestrator.id).join(", ") || "(該当なし)",
      );
    }
    const unfilteredLiveSessions = identities.flatMap((orchestrator) =>
      deps.store
        .listOrchestratorSessions(orchestrator.id)
        .filter((candidate) => candidate.status === LIVE_SESSION_STATUS),
    );
    const liveSessions = unfilteredLiveSessions.filter((candidate) =>
      options.generation === undefined || candidate.generation === options.generation,
    );

    if (options.generation !== undefined && unfilteredLiveSessions.length > 0 && liveSessions.length === 0) {
      return explicitConflict(
        "--generation",
        options.generation,
        unfilteredLiveSessions.map((candidate) => String(candidate.generation)).join(", "),
      );
    }

    if (liveSessions.length === 0) {
      const takeoverSessions = identities.flatMap((orchestrator) => {
        const eligibleSessions = deps.store
          .listOrchestratorSessions(orchestrator.id)
          .filter((candidate) => TAKEOVER_SESSION_STATUSES.has(candidate.status))
          .filter((candidate) => options.generation === undefined || candidate.generation === options.generation);
        const latestSession = latestTakeoverSession(eligibleSessions);
        return latestSession === null ? [] : [{ orchestrator, session: latestSession }];
      });
      if (options.generation !== undefined && takeoverSessions.length === 0) {
        const actualGenerations = identities.flatMap((orchestrator) =>
          deps.store
            .listOrchestratorSessions(orchestrator.id)
            .filter((candidate) => TAKEOVER_SESSION_STATUSES.has(candidate.status))
            .map((candidate) => String(candidate.generation)),
        );
        if (actualGenerations.length > 0) {
          return explicitConflict("--generation", options.generation, actualGenerations.join(", "));
        }
      }
      const recoveryCandidates = takeoverSessions.map(({ orchestrator, session: candidate }) =>
        takeoverResolutionCandidate(candidate, orchestrator),
      );
      const scope = options.orchestrator === undefined
        ? "全 identity"
        : `orchestrator=${options.orchestrator}`;
      return unresolvedResolution(
        "none",
        `${scope} に live session がありません。stale / handoff_pending の候補から takeover を選択してください。`,
        recoveryCandidates,
      );
    }
    if (liveSessions.length > 1) {
      return unresolvedResolution(
        "ambiguous",
        "live session が複数あります。候補の command を選択してください。",
        liveSessions.map((candidate) => handoverResolutionCandidate(
          candidate,
          getOrchestratorForSession(deps, candidate),
          options.apply === true,
          options.mission,
          explicitMissionTask?.title,
        )),
      );
    }
    session = liveSessions[0] ?? null;
  }

  // ここまでで session は一意に確定し、明示された identity / generation と board 実値も一致している。
  if (session === null) {
    return unresolvedResolution("none", "handover 対象の session を解決できませんでした。");
  }
  if (options.mission !== undefined) {
    return resolutionForResolved(deps, options, session, options.mission);
  }

  const subtreeWatches = deps.store
    .listOrchestratorWatches(session.orchestratorId)
    .filter((watch) => watch.active && watch.scope === "subtree");
  if (subtreeWatches.length === 0) {
    const orchestrator = getOrchestratorForSession(deps, session);
    return unresolvedResolution(
      "none",
      `${orchestrator?.id ?? session.orchestratorId} に active な subtree watch がありません。--mission でミッション task を指定してください。`,
    );
  }
  if (subtreeWatches.length > 1) {
    const orchestrator = getOrchestratorForSession(deps, session);
    return unresolvedResolution(
      "ambiguous",
      "active な subtree watch が複数あります。候補の command を選択してください。",
      subtreeWatches.map((watch) => {
        const task = deps.store.getTask(watch.selector);
        return handoverResolutionCandidate(
          session,
          orchestrator,
          options.apply === true,
          watch.selector,
          task?.title,
        );
      }),
    );
  }

  const mission = subtreeWatches[0]!.selector;
  return resolutionForResolved(deps, options, session, mission);
}

function resolutionTextLines(resolution: HandoverResolution): string[] {
  const lines = [
    "=== orchestrator handover resolution ===",
    "",
    `解決できません: ${resolution.reason}`,
  ];
  if (resolution.candidates.length === 0) {
    return lines;
  }
  lines.push("", "候補:");
  resolution.candidates.forEach((candidate, index) => {
    lines.push(
      `  ${index + 1}. orchestrator=${candidate.orchestratorId} label=${candidate.label} project=${candidate.project}`,
      `     session=${candidate.sessionId} generation=${candidate.generation}` +
        ` status=${candidate.sessionStatus} heartbeatAgeSec=${candidate.heartbeatAgeSec}`,
      ...(candidate.missionTaskId === undefined
        ? []
        : [`     mission=${candidate.missionTaskId} title=${candidate.missionTitle ?? "(不明)"}`]),
      `     command: ${candidate.command}`,
    );
  });
  return lines;
}

/**
 * ミッションが当該 orchestrator の配送先（docs/contract.md §69.3）に含まれるかを検証する。
 * 判定は core の isOrchestratorScopedToTask（resolveOrchestratorDeliveryTargets の唯一の実装）を
 * そのまま通し、binding 優先・observer 除外・worktree/project scope を含む全条件を独自実装しない。
 */
function checkMissionOrchestratorIdentity(
  deps: CliDeps,
  missionTaskId: string,
  orchestratorId: string,
): PreflightResult {
  if (deps.store.isOrchestratorScopedToTask(orchestratorId, missionTaskId)) {
    return { name: "mission-identity", ok: true };
  }
  return {
    name: "mission-identity",
    ok: false,
    reason: `ミッション task は当該 orchestrator の担当範囲に含まれません: orchestrator=${orchestratorId} mission=${missionTaskId}`,
  };
}

/**
 * subtree 全体（root を除く全子孫）のステータスを一括集計する。
 * core 側の countSubtreeStatuses が単一クエリで集計するため、子孫ごとに getTask を呼ぶ
 * N+1 を避けられる（listSubtreeTaskIds と同じ再帰 CTE が循環リンクを畳んで停止させる）。
 */
function collectSubtreeStatusCounts(
  deps: CliDeps,
  rootTaskId: string,
): { counts: Record<string, number>; total: number } {
  return deps.store.countSubtreeStatuses(rootTaskId);
}

/** bounded polling（停止確認・送達確認）の interval/timeout 設定 */
interface PollConfig {
  intervalMs: number;
  timeoutMs: number;
}

/** transcript に nonce 一致 user 行と後続 assistant 行が揃うまで最大15秒待つ */
const DEFAULT_DELIVERY_POLL: PollConfig = { intervalMs: 300, timeoutMs: 15_000 };
/** handoff final 後の起動時間を大きく延ばさず、後継 heartbeat の初回進行を確認する */
const DEFAULT_SUCCESSOR_HEARTBEAT_POLL: PollConfig = { intervalMs: 250, timeoutMs: 3_000 };
/** delivery attest 後も後継の process と transcript が生き残るかを確認する */
const DEFAULT_SUCCESSOR_LIVENESS_POLL: PollConfig = { intervalMs: 1_000, timeoutMs: 60_000 };
const SUCCESSOR_HEARTBEAT_WARNING =
  `後継が heartbeat を張っていません。${ORCHESTRATOR_SESSION_STALE_SECONDS} 秒で stale 化します。`;
const SUCCESSOR_LIVENESS_WARNING =
  "後継の生存を確認できません。孤児 heartbeat が生きているうちに復旧コマンドを実行してください。" +
  "先に孤児を停止すると session-generation-match preflight が失敗します。";

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

/**
 * 送達確認の結果。unknown は「未送達」ではなく「token が消費された可能性がある」状態であり、
 * 同じ token を再送してはならない。
 */
export type HandoverDeliveryResult =
  | { status: "confirmed"; confirmedVia: "transcript" }
  | { status: "unknown"; reason: string };

interface SuccessorHeartbeatConfirmation {
  confirmed: boolean;
  baselineAt: number;
  observedAt: number | null;
  timeoutMs: number;
  warning?: string;
  recoveryCommand?: string;
}

interface SuccessorLivenessDetail {
  tmuxSession: boolean;
  process: boolean;
  transcriptGrew: boolean;
  boardSession: boolean;
  heartbeatAdvanced: boolean;
}

interface SuccessorLivenessResult {
  status: "confirmed" | "lost";
  checkedAt: string;
  detail: SuccessorLivenessDetail;
}

function successorHeartbeatRecoveryCommand(session: OrchestratorSessionRow): string {
  return `hachi orchestrator session bootstrap-heartbeat --provider-session-id ${shellQuote(session.providerSessionId)}`;
}

function unconfirmedSuccessorHeartbeat(
  session: OrchestratorSessionRow,
  config: PollConfig,
  observedAt: number | null,
): SuccessorHeartbeatConfirmation {
  return {
    confirmed: false,
    baselineAt: session.heartbeatAt,
    observedAt,
    timeoutMs: config.timeoutMs,
    warning: SUCCESSOR_HEARTBEAT_WARNING,
    recoveryCommand: successorHeartbeatRecoveryCommand(session),
  };
}

/** final transaction が作った heartbeat から後継自身の heartbeat が進むまで bounded polling する */
async function waitForSuccessorHeartbeat(
  deps: CliDeps,
  session: OrchestratorSessionRow,
  config: PollConfig,
): Promise<SuccessorHeartbeatConfirmation> {
  const clock = deps.successorLaunchClock ?? {
    nowMs: (): number => Date.now(),
    sleep,
  };
  const deadline = clock.nowMs() + config.timeoutMs;
  let observedAt: number | null = session.heartbeatAt;
  for (;;) {
    let current: OrchestratorSessionRow | null;
    try {
      current = deps.store.getOrchestratorSession(session.id);
    } catch {
      // handoff final は完了済みなので、確認 read の失敗で CLI 成功を反転させない。
      return unconfirmedSuccessorHeartbeat(session, config, null);
    }
    if (current !== null && current.generation === session.generation) {
      observedAt = current.heartbeatAt;
      if (current.heartbeatAt > session.heartbeatAt) {
        return {
          confirmed: true,
          baselineAt: session.heartbeatAt,
          observedAt: current.heartbeatAt,
          timeoutMs: config.timeoutMs,
        };
      }
    } else {
      observedAt = null;
    }
    if (clock.nowMs() >= deadline) break;
    await clock.sleep(Math.max(1, config.intervalMs));
  }

  return unconfirmedSuccessorHeartbeat(session, config, observedAt);
}

/** message.content の既知形式から launch nonce の照合対象テキストを取り出す。 */
function extractTranscriptMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") {
      parts.push(record["text"]);
    }
  }
  return parts.join("");
}

/** nonce 一致 user 行より後の assistant 行数を数える。読取り不能は null へ倒す。 */
async function countSuccessorAssistantLines(
  claudeProjectsRoot: string,
  successorSessionId: string,
  launchNonce: string,
): Promise<number | null> {
  const sessionDir = await findClaudeSessionDir(claudeProjectsRoot, successorSessionId);
  if (sessionDir === null) return null;

  let raw: string;
  try {
    raw = readFileSync(join(sessionDir, `${successorSessionId}.jsonl`), "utf8");
  } catch {
    return null;
  }

  let userNonceObserved = false;
  let assistantLines = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 追記途中の行は次の poll で再読する。
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    if (record["type"] === "assistant") {
      if (userNonceObserved) assistantLines += 1;
      continue;
    }
    if (record["type"] !== "user") continue;
    const message = record["message"];
    if (message === null || typeof message !== "object") continue;
    const content = (message as Record<string, unknown>)["content"];
    if (extractTranscriptMessageText(content).includes(launchNonce)) {
      userNonceObserved = true;
    }
  }
  return userNonceObserved ? assistantLines : null;
}

function successorTmuxSessionExists(launcher: TmuxLauncher, sessionName: string): boolean {
  try {
    return launcher.hasSession(sessionName);
  } catch {
    return false;
  }
}

function successorProcessExists(
  launcher: TmuxLauncher,
  panePid: number | null,
  processGroupId: number | null,
): boolean {
  if (panePid === null || processGroupId === null || launcher.isPaneProcessAlive === undefined) {
    return false;
  }
  try {
    return launcher.isPaneProcessAlive(panePid) && launcher.isProcessGroupAlive(processGroupId);
  } catch {
    return false;
  }
}

/** durable final 後に process 3点を bounded polling し、既存 heartbeat 結果と合わせる。 */
async function waitForSuccessorLiveness(
  deps: CliDeps,
  input: {
    launcher: TmuxLauncher;
    tmuxSessionName: string;
    panePid: number | null;
    processGroupId: number | null;
    claudeProjectsRoot: string;
    successorSessionId: string;
    launchNonce: string;
    assistantLineBaseline: number | null;
    successorHeartbeat: SuccessorHeartbeatConfirmation;
  },
): Promise<SuccessorLivenessResult> {
  const clock = deps.successorLaunchClock ?? {
    nowMs: (): number => Date.now(),
    sleep,
  };
  const config = DEFAULT_SUCCESSOR_LIVENESS_POLL;
  const deadline = clock.nowMs() + config.timeoutMs;
  let detail: SuccessorLivenessDetail = {
    tmuxSession: false,
    process: false,
    transcriptGrew: false,
    boardSession: input.successorHeartbeat.observedAt !== null,
    heartbeatAdvanced: input.successorHeartbeat.confirmed,
  };

  // delivery 時点の assistant 行数を取得できなければ「増加」を証明できない。
  if (input.assistantLineBaseline === null) {
    detail = {
      ...detail,
      tmuxSession: successorTmuxSessionExists(input.launcher, input.tmuxSessionName),
      process: successorProcessExists(input.launcher, input.panePid, input.processGroupId),
    };
    return { status: "lost", checkedAt: new Date(clock.nowMs()).toISOString(), detail };
  }

  for (;;) {
    const assistantLines = await countSuccessorAssistantLines(
      input.claudeProjectsRoot,
      input.successorSessionId,
      input.launchNonce,
    );
    detail = {
      ...detail,
      tmuxSession: successorTmuxSessionExists(input.launcher, input.tmuxSessionName),
      process: successorProcessExists(input.launcher, input.panePid, input.processGroupId),
      transcriptGrew:
        assistantLines !== null && assistantLines > input.assistantLineBaseline,
    };
    if (detail.tmuxSession && detail.process && detail.transcriptGrew) break;
    if (clock.nowMs() >= deadline) break;
    await clock.sleep(Math.max(1, config.intervalMs));
  }

  const confirmed = detail.tmuxSession && detail.process && detail.transcriptGrew && detail.boardSession;
  return {
    status: confirmed ? "confirmed" : "lost",
    checkedAt: new Date(clock.nowMs()).toISOString(),
    detail,
  };
}

/** transcript jsonl の内容を2段階で bounded polling する */
async function waitForDeliveryGate(
  probe: HandoverDeliveryGateProbe,
  params: { claudeProjectsRoot: string; successorSessionId: string; launchNonce: string },
  launcher: TmuxLauncher,
  sessionName: string,
  config: PollConfig,
): Promise<HandoverDeliveryResult> {
  const deadline = Date.now() + config.timeoutMs;
  for (;;) {
    try {
      if (!launcher.hasSession(sessionName)) {
        return { status: "unknown", reason: "送達確認中に tmux セッションが消滅しました" };
      }
    } catch {
      // tmux socket の一時的な読取り失敗だけでは未送達と断定せず、transcript probe を続ける。
    }

    let observation;
    try {
      observation = await probe(params);
    } catch (error) {
      return {
        status: "unknown",
        reason: `送達確認 probe が失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (observation.userNonceObserved && observation.assistantObserved) {
      return { status: "confirmed", confirmedVia: "transcript" };
    }
    if (Date.now() >= deadline) {
      return {
        status: "unknown",
        reason:
          `後継 transcript に nonce 一致 user 行と後続 assistant 行が ` +
          `${config.timeoutMs}ms 以内に揃いませんでした`,
      };
    }
    await sleep(config.intervalMs);
  }
}

/**
 * tmux new-session の argv を組み立てる。dry-run と --apply の両方が必ずこの関数を通す
 * （argv を組み立てるコードを他に書かないことで、食い違いを構造的に防ぐ）。
 * `--` の直後に launch prompt を1つの argv 要素として置く（`--add-dir` 等の variadic option が
 * 追加された瞬間に位置引数プロンプトを食う既知の危険を回避する）。
 */
export function buildTmuxArgs(
  sessionName: string,
  cwd: string,
  providerSessionId: string,
  barrier: string,
  launchPromptText: string,
): string[] {
  return [
    "new-session", "-d",
    "-s", sessionName,
    "-c", cwd,
    "/bin/sh", "-c",
    'tmux wait-for "$1" && exec claude --session-id "$2" -- "$3"',
    "hachi-successor",
    barrier,
    providerSessionId,
    launchPromptText,
  ];
}

/** execFile("tmux", argv) が渡す executable と各 argv の UTF-8 byte 数（NUL 区切り込み）を測る */
export function measureTmuxCommandBytes(args: readonly string[]): number {
  return ["tmux", ...args].reduce(
    (total, value) => total + Buffer.byteLength(value, "utf8") + 1,
    0,
  );
}

function createHandoverAttemptPlan(
  deps: CliDeps,
  input: {
    missionId: string;
    sessionId: string;
    orchestratorId: string;
    resolvedCwd: string;
    successorSessionId?: string;
  },
): HandoverAttemptPlan {
  const successorSessionId = input.successorSessionId ?? deps.newSessionId?.() ?? randomUUID();
  const tmuxSessionName = `hachi-orch-${input.orchestratorId.slice(0, 8)}-${successorSessionId}`;
  const generateHandoffToken = deps.newHandoffToken ?? (() => newNonce() + newNonce());
  const handoffToken = generateHandoffToken();
  const launchNonce = deps.newHandoffLaunchNonce?.() ?? randomUUID();
  const ownerNonce = deps.newSuccessorOwnerNonce?.() ?? randomUUID();
  const barrierNonce = deps.newSuccessorBarrierNonce?.() ?? randomUUID();
  const barrier = `hachi-successor-${hashToken(barrierNonce).slice(0, 32)}`;
  const startupPrompt = [
    `ミッション task ID: ${input.missionId}`,
    `provider session id: ${successorSessionId}`,
    `launch nonce: ${launchNonce}`,
    "Hachi が transcript delivery 確認後に durable handoff final を行う。generic handoff-accept は実行しないこと。",
    `最初のツール呼び出しで次の1行を実行し、inbox を消費しない純 heartbeat を${ORCHESTRATOR_AWAIT_HEARTBEAT_INTERVAL_SECONDS}秒間隔で開始する。非0終了時は警告を確認して後続へ進む。playbook を読むのはその後。`,
    `hachi orchestrator session bootstrap-heartbeat --provider-session-id ${shellQuote(successorSessionId)}`,
    "playbook §0.7.4 に従って立ち上げよ",
  ].join("\n");
  const tmuxArgs = buildTmuxArgs(
    tmuxSessionName,
    input.resolvedCwd,
    successorSessionId,
    barrier,
    startupPrompt,
  );
  return {
    successorSessionId,
    tmuxSessionName,
    handoffToken,
    launchNonce,
    ownerNonce,
    barrier,
    startupPrompt,
    tmuxArgs,
    tmuxCommandLine: `tmux ${tmuxArgs.map(shellQuote).join(" ")}`,
    tmuxCommandBytes: measureTmuxCommandBytes(tmuxArgs),
  };
}

function createUsedHandoverAttemptValues(first: HandoverAttemptPlan): UsedHandoverAttemptValues {
  return {
    handoffTokens: new Set([first.handoffToken]),
    successorSessionIds: new Set([first.successorSessionId]),
    launchNonces: new Set([first.launchNonce]),
  };
}

function rememberFreshHandoverAttemptPlan(
  used: UsedHandoverAttemptValues,
  next: HandoverAttemptPlan,
): string[] {
  const reusedFields: string[] = [];
  if (used.handoffTokens.has(next.handoffToken)) reusedFields.push("handoffToken");
  if (used.successorSessionIds.has(next.successorSessionId)) reusedFields.push("successorSessionId");
  if (used.launchNonces.has(next.launchNonce)) reusedFields.push("launchNonce");
  if (reusedFields.length > 0) return reusedFields;

  used.handoffTokens.add(next.handoffToken);
  used.successorSessionIds.add(next.successorSessionId);
  used.launchNonces.add(next.launchNonce);
  return [];
}

function hasCompleteHandoverRollback(
  deps: CliDeps,
  launch: OrchestratorSuccessorLaunchRow,
  sourceSessionId: string,
  sourceGeneration: number,
): boolean {
  const slot = deps.store.getSuccessorLaunch(launch.id);
  const source = deps.store.getOrchestratorSession(sourceSessionId);
  return slot?.status === "stopped" &&
    slot.sourceSessionId === sourceSessionId &&
    slot.sourceGeneration === sourceGeneration &&
    slot.stopEvidence.tmuxSessionAbsent === true &&
    slot.stopEvidence.panePidAbsent === true &&
    slot.stopEvidence.processGroupAbsent === true &&
    source?.status === "active" &&
    source.generation === sourceGeneration;
}

function deliveryFailureGuidance(rollbackComplete: boolean, attemptsExhausted: boolean): {
  retryInstruction: "rerun-with-new-token" | "retry-budget-exhausted" | "do-not-retry";
  retryGuidance: string;
} {
  if (!rollbackComplete) {
    return {
      retryInstruction: "do-not-retry",
      retryGuidance:
        "delivery=unknown は断続故障ですが、補償完了を確認できません。" +
        "二重稼働の危険があるため再試行してはいけません。",
    };
  }
  if (attemptsExhausted) {
    return {
      retryInstruction: "retry-budget-exhausted",
      retryGuidance:
        "自動再試行の上限に到達しました。後継 transcript に type:\"assistant\" 行があるか確認し、" +
        "無ければ handover をそのまま再実行せず、手動ブートストラップ" +
        "（旧 session close → 新セッションから session start）へ切り替えてください。",
    };
  }
  return {
    retryInstruction: "rerun-with-new-token",
    retryGuidance:
      "delivery=unknown は断続故障です。補償が完了して旧 session は active に戻っているため、" +
      "新しい token での再試行が正規手順です。この handover コマンドをそのまま再実行できます。",
  };
}

const DURABLE_CLAUDE_HANDOVER_RECOVERY_STATUSES = new Set([
  "armed",
  "runtime_bound",
  "attested",
  "accepting",
  "stop_pending",
  "uncertain",
]);

function durableClaudeHandoverCandidates(
  deps: CliDeps,
  options: HandoverOptions,
): OrchestratorSuccessorLaunchRow[] {
  // stable identity が明示された場合は Store 検索の入口で対象 slot を限定し、
  // 別 identity の blocking row へフォールバックしない。
  const launches = options.orchestrator === undefined
    ? deps.store.listSuccessorLaunches()
    : deps.store.listSuccessorLaunches(options.orchestrator);
  return launches.filter((launch) => {
    const recoverable = DURABLE_CLAUDE_HANDOVER_RECOVERY_STATUSES.has(launch.status) ||
      (options.session !== undefined && launch.status === "succeeded");
    return recoverable && launch.kind === "handoff" && launch.targetProvider === "claude" &&
      (options.session === undefined || launch.sourceSessionId === options.session) &&
      (options.generation === undefined || launch.sourceGeneration === options.generation) &&
      (options.orchestrator === undefined || launch.orchestratorId === options.orchestrator);
  });
}

function durableRecoveryResolution(
  deps: CliDeps,
  options: HandoverOptions,
  launch: OrchestratorSuccessorLaunchRow,
): HandoverResolution {
  const source = deps.store.getOrchestratorSession(launch.sourceSessionId);
  const orchestrator = deps.store.getOrchestrator(launch.orchestratorId);
  const candidate = source === null
    ? []
    : [handoverResolutionCandidate(
        source,
        orchestrator,
        options.apply === true,
        options.mission,
        options.mission === undefined ? undefined : deps.store.getTask(options.mission)?.title,
      )];
  return {
    status: "resolved",
    reason: `durable Claude handover slot ${launch.id} を一意に解決しました`,
    candidates: candidate,
  };
}

async function runDurableClaudeHandoverRecovery(
  deps: CliDeps,
  options: HandoverOptions,
  launch: OrchestratorSuccessorLaunchRow,
): Promise<void> {
  const resolution = durableRecoveryResolution(deps, options, launch);
  const providerLaunchable = { name: "provider-launchable", ok: true };
  const now = Math.floor(Date.now() / 1_000);
  const inFlight = launch.status === "armed"
    ? now <= launch.runtimeDeadlineAt
    : launch.status === "runtime_bound"
      ? now <= launch.attestationDeadlineAt
      : launch.status === "attested" || launch.status === "accepting"
        ? launch.attestationExpiresAt !== null && now <= launch.attestationExpiresAt
        : false;
  const basePayload = {
    resolution,
    successorSessionId: launch.providerSessionId || null,
    slotId: launch.id,
    slotStatus: launch.status,
    tmuxSessionName: launch.plannedTmuxSession,
    panePid: launch.panePid,
    processGroupId: launch.processGroupId,
    preflight: [providerLaunchable],
    blocked: inFlight,
    blockReasons: inFlight ? ["既存 durable launch は deadline 内で進行中です"] : [],
    recovery: true,
  };
  if (options.apply !== true || inFlight) {
    emit(deps, options.json === true, basePayload, [
      "=== orchestrator handover durable recovery ===",
      `slot=${launch.id} status=${launch.status}`,
      `exact tmux session=${launch.plannedTmuxSession}`,
      ...(inFlight ? ["既存 launch は deadline 内です。deadline 後に同じ handover を再実行してください。"] : []),
    ]);
    if (inFlight && options.apply === true) deps.exit(2);
    return;
  }

  const recovered = launch.status === "succeeded"
    ? launch
    : await recoverSuccessorLaunch(
        deps,
        defaultTmuxLauncher,
        launch,
        "handover caller 消失後の durable exact rollback",
      );
  if (recovered.status === "succeeded") {
    emit(deps, options.json === true, {
      ...basePayload,
      applied: true,
      blocked: false,
      blockReasons: [],
      slotStatus: recovered.status,
      successorSessionId: recovered.providerSessionId,
      boardSuccessorSessionId: recovered.successorSessionId,
      successorGeneration: recovered.successorGeneration,
      attachCommand: `tmux attach-session -t ${shellQuote(recovered.tmuxSession)}`,
    }, [
      "=== orchestrator handover durable recovery ===",
      `成功済み slot を再読込しました: ${recovered.id}`,
      `tmux attach-session -t ${shellQuote(recovered.tmuxSession)}`,
    ]);
    return;
  }

  const rolledBack = recovered.status === "stopped" || recovered.status === "rejected" ||
    recovered.status === "expired";
  emit(deps, options.json === true, {
    ...basePayload,
    applied: false,
    rolledBack,
    blocked: !rolledBack,
    blockReasons: rolledBack ? [] : [`durable slot は ${recovered.status} のため replacement を閉じています`],
    slotStatus: recovered.status,
    failReason: recovered.lastError || "durable exact rollback を完了できませんでした",
  }, [
    "=== orchestrator handover durable recovery ===",
    `slot=${recovered.id} status=${recovered.status}`,
    rolledBack
      ? "exact runtime の三点停止と source 復旧を durable transaction で完了しました。"
      : "exact runtime の停止証拠が揃わないため replacement gate を閉じたままです。",
  ]);
  deps.exit(rolledBack ? 1 : 2);
}

/**
 * 解決済み handover の dry-run preflight を組み立てる。
 * tmux/trust/store は read-only probe だけを使い、token の永続化、handoff-prepare、tmux 起動は行わない。
 */
function buildResolvedHandoverPreflight(
  deps: CliDeps,
  resolved: ResolvedHandover,
  firstSuccessorSessionId: string,
): ResolvedHandoverPreflight {
  const sessionId = resolved.sessionId;
  const generation = resolved.generation;
  const missionId = resolved.mission;
  const tmux = deps.tmuxProbe ?? defaultTmuxProbe;
  const preflight: PreflightResult[] = [];

  // 検査1: tmux が PATH にあるか
  const tmuxAvailable = tmux.available();
  preflight.push({
    name: "tmux-available",
    ok: tmuxAvailable,
    ...(tmuxAvailable ? {} : { reason: "tmux-not-found" }),
  });

  // セッション・オーケストレーター情報の取得
  const session = deps.store.getOrchestratorSession(sessionId);
  let orchestratorId = "";
  let orchestratorRepoCommonDir = "";
  if (session !== null) {
    orchestratorId = session.orchestratorId;
    const orch = deps.store.getOrchestrator(session.orchestratorId);
    if (orch !== null) {
      orchestratorRepoCommonDir = orch.repoCommonDir;
    }
  }

  // tmux セッション名の組み立て
  const orchPrefix = orchestratorId.slice(0, 8);
  // Claude の preassigned provider session ID 全体を exact planned session 名に含める。
  // crash 後も durable slot の planned target だけで識別でき、prefix 検索へ戻らない。
  const firstTmuxSessionName = `hachi-orch-${orchPrefix}-${firstSuccessorSessionId}`;

  // 検査2: 同名の tmux セッションが既に無いか
  // 一覧を取得できない場合は「衝突なし」ではなく「判定できない」として失敗させる。
  let existingSessions: string[] = [];
  let listFailure: string | null = null;
  if (tmuxAvailable) {
    try {
      existingSessions = tmux.listSessionNames();
    } catch (err) {
      listFailure = err instanceof Error ? err.message : String(err);
    }
  }
  const nameCollision = listFailure === null && existingSessions.includes(firstTmuxSessionName);
  preflight.push({
    name: "session-name-unique",
    ok: listFailure === null && !nameCollision,
    ...(listFailure !== null
      ? { reason: `tmux セッション一覧を取得できません: ${listFailure}` }
      : nameCollision
        ? { reason: `tmux session "${firstTmuxSessionName}" は既に存在します` }
        : {}),
  });

  // 検査3: ミッション task が存在し archived でないか
  const missionTask = deps.store.getTask(missionId);
  if (missionTask === null) {
    preflight.push({ name: "mission-valid", ok: false, reason: `ミッション task が見つかりません: ${missionId}` });
  } else if (missionTask.status === "archived") {
    preflight.push({ name: "mission-valid", ok: false, reason: `ミッション task は archived です: ${missionId}` });
  } else {
    preflight.push({ name: "mission-valid", ok: true });
  }

  // 検査4: session が active で generation が一致するか
  let sessionGenerationCheck: PreflightResult;
  if (session === null) {
    sessionGenerationCheck = {
      name: "session-generation-match",
      ok: false,
      reason: `session が見つかりません: ${sessionId}`,
    };
  } else if (session.status !== "active") {
    sessionGenerationCheck = {
      name: "session-generation-match",
      ok: false,
      reason: `session status が active ではありません: ${session.status}`,
    };
  } else if (session.generation !== generation) {
    sessionGenerationCheck = {
      name: "session-generation-match",
      ok: false,
      reason: `generation 不一致: 期待=${generation} 実際=${session.generation}`,
    };
  } else {
    sessionGenerationCheck = { name: "session-generation-match", ok: true };
  }
  preflight.push(sessionGenerationCheck);

  // --- cwd の解決 ---
  const isDirectory = deps.isDirectory ?? ((target: string): boolean => {
    try {
      return statSync(target).isDirectory();
    } catch {
      return false;
    }
  });
  const missionCwd = missionTask !== null ? parseCwdFromBody(missionTask.body) : null;
  const missionCwdIsUsable = missionCwd !== null && isAbsolute(missionCwd) && isDirectory(missionCwd);
  // 通常の Git repository では repoCommonDir が `<repo>/.git` なので、その親を起動 cwd にする。
  // bare repository 等、それ以外の形は既存値をそのまま fallback 候補として扱う。
  const repoFallbackCwd = orchestratorRepoCommonDir.endsWith("/.git")
    ? dirname(orchestratorRepoCommonDir)
    : orchestratorRepoCommonDir;
  const resolvedCwd = missionCwdIsUsable ? missionCwd : repoFallbackCwd;
  const cwdSource = missionCwdIsUsable ? "mission-cwd" : "repo-root-fallback";

  // 検査5: cwd が絶対パスの実在 directory か
  // tmux は -c に渡された cwd が無いと起動に失敗する。dry-run が「実行可能」と答える以上
  // ここで確かめないと、handoff-prepare 済みの状態で起動に失敗しロールバックへ入る。
  const cwdIsAbsolute = isAbsolute(resolvedCwd);
  const cwdIsDirectory = missionCwdIsUsable || (cwdIsAbsolute && isDirectory(resolvedCwd));
  if (!cwdIsAbsolute) {
    preflight.push({
      name: "cwd-usable",
      ok: false,
      reason: `cwd が絶対パスではありません: ${resolvedCwd}`,
      cwdSource,
    });
  } else if (!cwdIsDirectory) {
    preflight.push({
      name: "cwd-usable",
      ok: false,
      reason: `cwd が実在する directory ではありません: ${resolvedCwd}`,
      cwdSource,
    });
  } else {
    preflight.push({ name: "cwd-usable", ok: true, cwdSource });
  }

  // 検査6: 未信頼 cwd は Claude の trust dialog で止まり jsonl が生成されないため、起動前に弾く。
  if (cwdIsAbsolute && cwdIsDirectory) {
    const trustProbe = deps.claudeTrustProbe ?? defaultClaudeTrustProbe;
    let trusted = false;
    try {
      trusted = trustProbe.isTrusted(resolvedCwd);
    } catch {
      trusted = false;
    }
    preflight.push({
      name: "cwd-trusted",
      ok: trusted,
      ...(trusted
        ? {}
        : {
            reason:
              "cwd が Claude の trust dialog を承諾済みではありません。" +
              `当該 cwd で手動起動して trust を承諾してください: ${resolvedCwd}`,
          }),
    });
  }

  // 検査7: ミッションと orchestrator identity の対応（M3a レビュー積み残し #1）
  if (missionTask !== null && orchestratorId !== "") {
    preflight.push(checkMissionOrchestratorIdentity(deps, missionTask.id, orchestratorId));
  } else if (missionTask !== null && orchestratorId === "") {
    preflight.push({
      name: "mission-identity",
      ok: false,
      reason: "orchestrator が特定できないため identity 検証ができません",
    });
  }

  // --- handoff-prepare プレビュー（M3a レビュー積み残し #2）---
  // core の previewHandoffTransfers で実際の transfer predicate と同じ条件で集計する
  let orchestratorRequestCount = 0;
  let runtimeCleanupClaimCount = 0;
  if (session !== null) {
    const preview = deps.store.previewHandoffTransfers(sessionId, generation);
    orchestratorRequestCount = preview.orchestratorRequestCount;
    runtimeCleanupClaimCount = preview.runtimeCleanupClaimCount;
  }

  // --- 配下タスクの件数内訳（M3a レビュー積み残し #3）---
  // subtree 全体（孫以下含む）を一括集計する
  let descendantStatusCounts: Record<string, number> = {};
  let descendantTotal = 0;
  if (missionTask !== null) {
    const subtreeResult = collectSubtreeStatusCounts(deps, missionTask.id);
    descendantStatusCounts = subtreeResult.counts;
    descendantTotal = subtreeResult.total;
  }

  // --- 起動プロンプトと tmux コマンドライン ---
  // cwd は task body 由来の任意文字列なので、素の連結ではコピー実行可能な危険なコマンドを
  // 出力しうる。表示用は POSIX quoting し、実行側は tmuxArgs を execFile へ渡す。
  // dry-run の表示と --apply の実 launch は必ず同一の buildTmuxArgs から組み立てる（食い違いを構造的に防ぐ）。
  // 後継は対話セッションとして起動する（-p は使わない。単発応答で pane が終了してしまうため）。
  // 起動プロンプトは `--` の直後に1つの argv 要素として載せる（`--add-dir` 等の variadic option が
  // 追加されたときに位置引数プロンプトを食う既知の危険を回避する）。
  // 1試行目は dry-run と apply の双方で同じ plan を使う。再試行時は plan 全体を新規採番する。
  const firstAttemptPlan = createHandoverAttemptPlan(deps, {
    missionId,
    sessionId,
    orchestratorId,
    resolvedCwd,
    successorSessionId: firstSuccessorSessionId,
  });
  const tmuxCommandBytes = firstAttemptPlan.tmuxCommandBytes;
  preflight.push({
    name: "tmux-command-size",
    ok: tmuxCommandBytes <= TMUX_COMMAND_MAX_BYTES,
    ...(tmuxCommandBytes <= TMUX_COMMAND_MAX_BYTES
      ? {}
      : {
          reason:
            `tmux argv が上限を超えています: ${tmuxCommandBytes} > ` +
            `${TMUX_COMMAND_MAX_BYTES} bytes`,
        }),
  });

  // 検査9: この handover 経路は Claude CLI / tmux 専用。旧 session の provider が
  // Claude と確認できない限り、暗黙に Claude 後継へ変換せず fail-closed に止める。
  const providerLaunchable = session !== null && session.provider === "claude";
  const actualProvider = session === null ? "<session不明>" : JSON.stringify(session.provider);
  preflight.push({
    name: "provider-launchable",
    ok: providerLaunchable,
    ...(providerLaunchable
      ? {}
      : {
          reason:
            `provider-launchable: 実 provider=${actualProvider}。` +
            "この経路は claude 後継だけを起動する。" +
            "Codex は reference §0.7.5 の手動手順を使う。",
        }),
  });

  const blocked = preflight.some((check) => !check.ok);
  const blockReasons = preflight
    .filter((check) => !check.ok)
    .map((check) => check.reason ?? check.name);

  return {
    preflight,
    blocked,
    blockReasons,
    sessionId,
    generation,
    missionId,
    session,
    orchestratorId,
    resolvedCwd,
    missionTask,
    orchestratorRequestCount,
    runtimeCleanupClaimCount,
    descendantStatusCounts,
    descendantTotal,
    firstAttemptPlan,
    tmuxCommandBytes,
  };
}

/** doctor が live identity ごとに使う、副作用ゼロの handover dry-run preflight。 */
export function inspectOrchestratorHandoverPreflight(
  deps: CliDeps,
  orchestratorId: string,
): HandoverPreflightInspection {
  const resolved = resolveHandover(deps, { orchestrator: orchestratorId });
  if (!isResolvedHandover(resolved)) {
    const preflight: HandoverPreflightResult[] = [{
      name: "handover-resolution",
      ok: false,
      reason: resolved.resolution.reason,
    }];
    return {
      resolution: resolved.resolution,
      preflight,
      blocked: true,
      blockReasons: [resolved.resolution.reason],
    };
  }
  const firstSuccessorSessionId = deps.newSessionId?.() ?? randomUUID();
  const result = buildResolvedHandoverPreflight(deps, resolved, firstSuccessorSessionId);
  return {
    resolution: resolved.resolution,
    preflight: result.preflight,
    blocked: result.blocked,
    blockReasons: result.blockReasons,
    sessionId: result.sessionId,
    generation: result.generation,
    missionId: result.missionId,
  };
}

async function runHandover(deps: CliDeps, options: HandoverOptions): Promise<void> {
  const durableCandidates = durableClaudeHandoverCandidates(deps, options);
  if (durableCandidates.length > 1) {
    const candidates = durableCandidates.flatMap((launch) => {
      const source = deps.store.getOrchestratorSession(launch.sourceSessionId);
      if (source === null) return [];
      return [handoverResolutionCandidate(
        source,
        deps.store.getOrchestrator(launch.orchestratorId),
        options.apply === true,
        options.mission,
        options.mission === undefined ? undefined : deps.store.getTask(options.mission)?.title,
      )];
    });
    const resolution: HandoverResolution = {
      status: "ambiguous",
      reason: "durable Claude handover slot が複数あります。exact source session を指定してください。",
      candidates,
    };
    emit(deps, options.json === true, { resolution }, resolutionTextLines(resolution));
    deps.exit(2);
    return;
  }
  if (durableCandidates.length === 1) {
    await runDurableClaudeHandoverRecovery(deps, options, durableCandidates[0]!);
    return;
  }

  // board からの解決は preflight と token 採番より前に行う。不明確な候補を選ばせるだけで
  // tmux/board mutation を起こさず、handoff token も採番しない。
  const resolved = resolveHandover(deps, options);
  if (!isResolvedHandover(resolved)) {
    emit(deps, options.json === true, { resolution: resolved.resolution }, resolutionTextLines(resolved.resolution));
    deps.exit(2);
    return;
  }
  const firstSuccessorSessionId = deps.newSessionId?.() ?? randomUUID();
  const {
    preflight,
    blocked,
    blockReasons,
    sessionId,
    generation,
    missionId,
    orchestratorId,
    resolvedCwd,
    missionTask,
    orchestratorRequestCount,
    runtimeCleanupClaimCount,
    descendantStatusCounts,
    descendantTotal,
    firstAttemptPlan,
    tmuxCommandBytes,
  } = buildResolvedHandoverPreflight(deps, resolved, firstSuccessorSessionId);

  const jsonPayload = {
    successorSessionId: firstAttemptPlan.successorSessionId,
    startupPrompt: firstAttemptPlan.startupPrompt,
    tmuxArgs: firstAttemptPlan.tmuxArgs,
    tmuxCommandLine: firstAttemptPlan.tmuxCommandLine,
    tmuxCommandBytes,
    tmuxCommandMaxBytes: TMUX_COMMAND_MAX_BYTES,
    handoffPreparePreview: {
      sessionId,
      generation,
      orchestratorRequestCount,
      runtimeCleanupClaimCount,
    },
    missionState: {
      taskId: missionId,
      title: missionTask?.title ?? "(不明)",
      status: missionTask?.status ?? "(不明)",
      descendantStatusCounts,
      descendantTotal,
    },
    preflight,
    blocked,
    blockReasons,
    resolution: resolved.resolution,
    maxAttempts: options.maxAttempts ?? DEFAULT_HANDOVER_MAX_ATTEMPTS,
    attempts: [] as HandoverAttemptHistoryEntry[],
  };

  // --- dry-run 出力 ---
  if (options.apply !== true) {
    const statusSummary = Object.entries(descendantStatusCounts)
      .map(([status, count]) => `${status}=${count}`)
      .join(", ") || "なし";

    const textLines = [
      "=== orchestrator handover dry-run ===",
      "",
      `後継セッション ID: ${firstAttemptPlan.successorSessionId}`,
      "",
      "--- 起動プロンプト ---",
      firstAttemptPlan.startupPrompt,
      "---",
      "⚠ dry-run では durable slot を arm しません。実際に起動・移管するには --apply を実行してください。",
      "",
      "tmux コマンドライン:",
      `  ${firstAttemptPlan.tmuxCommandLine}`,
      "",
      "durable handoff final プレビュー（※移管は delivery attest 後の final transaction で実行）:",
      `  対象 session: ${sessionId}`,
      `  現行 generation: ${generation}`,
      `  orchestrator request claim: ${orchestratorRequestCount} 件`,
      `  runtime cleanup claim: ${runtimeCleanupClaimCount} 件`,
      "",
      "ミッション状態:",
      `  task: ${missionId} "${missionTask?.title ?? '(不明)'}"`,
      `  status: ${missionTask?.status ?? "(不明)"}`,
      `  配下タスク（subtree 全体）: ${statusSummary} (計${descendantTotal}件)`,
      "",
      "事前検査:",
      ...preflight.map(
        (check) => `  ${check.ok ? "✓" : "✗"} ${check.name}${check.reason !== undefined ? ` (${check.reason})` : ""}`,
      ),
      "",
      `実行可能: ${blocked ? "いいえ" : "はい"}`,
      ...(blockReasons.length > 0 ? [`ブロック理由: ${blockReasons.join(", ")}`] : []),
    ];

    emit(deps, options.json === true, jsonPayload, textLines);
    return;
  }

  // ===================================================================
  // --apply: 後継セッションを実際に起動する
  // ===================================================================

  // 手順1: 事前検査を再実行済み（上記 preflight）。1つでも不可なら何もせず終了する
  if (blocked) {
    const failPayload = {
      ...jsonPayload,
      applied: false,
      failReason: "事前検査に不合格があるため実行しません",
    };
    const failLines = [
      "=== orchestrator handover --apply ===",
      "",
      "事前検査に不合格があるため実行しません。",
      `ブロック理由: ${blockReasons.join(", ")}`,
      "",
      "事前検査:",
      ...preflight.map(
        (check) => `  ${check.ok ? "✓" : "✗"} ${check.name}${check.reason !== undefined ? ` (${check.reason})` : ""}`,
      ),
    ];
    emit(deps, options.json === true, failPayload, failLines);
    deps.exit(1);
    return;
  }

  // arm→spawn→exact readback/bind→barrier→delivery attest→claim/final は
  // migration v23 の durable slot だけを正本とする。旧 prepare/fence/cancel は併用しない。
  const launcher = deps.tmuxLauncher ?? defaultTmuxLauncher;
  const deliveryPollConfig = deps.handoverDeliveryPoll ?? DEFAULT_DELIVERY_POLL;
  const deliveryProbe = deps.handoverDeliveryGateProbe ?? defaultHandoverDeliveryGateProbe;
  const claudeProjectsRoot = deps.nativeUsageRoots?.claudeProjectsRoot ?? resolveClaudeProjectsRoot();
  const canonicalCwd = deps.canonicalizeSuccessorCwd(resolvedCwd);
  if (!isAbsolute(canonicalCwd)) throw new Error("canonical cwd を確認できません");
  const maxAttempts = options.maxAttempts ?? DEFAULT_HANDOVER_MAX_ATTEMPTS;
  const attempts: HandoverAttemptHistoryEntry[] = [];
  const nowMs = (): number => deps.successorLaunchClock?.nowMs() ?? Date.now();
  let attemptPlan = firstAttemptPlan;
  const usedAttemptValues = createUsedHandoverAttemptValues(firstAttemptPlan);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let delivery: HandoverDeliveryResult | undefined;
    let deliveryAssistantLineBaseline: number | null = null;
    const startedAtMs = nowMs();
    const result = await runClaudeHandoverSuccessorLaunch(deps, defaultTmuxLauncher, {
      sourceSessionId: sessionId,
      sourceGeneration: generation,
      orchestratorId,
      canonicalCwd,
      providerSessionId: attemptPlan.successorSessionId,
      plannedTmuxSession: attemptPlan.tmuxSessionName,
      handoffToken: attemptPlan.handoffToken,
      launchNonce: attemptPlan.launchNonce,
      ownerNonce: attemptPlan.ownerNonce,
      barrier: attemptPlan.barrier,
      tmuxArgs: attemptPlan.tmuxArgs,
      deliveryGate: async () => {
        delivery = await waitForDeliveryGate(
          deliveryProbe,
          {
            claudeProjectsRoot,
            successorSessionId: attemptPlan.successorSessionId,
            launchNonce: attemptPlan.launchNonce,
          },
          launcher,
          attemptPlan.tmuxSessionName,
          deliveryPollConfig,
        );
        if (delivery.status === "unknown") {
          throw new Error(`起動プロンプトの送達状態を確認できません: ${delivery.reason}`);
        }
        deliveryAssistantLineBaseline = await countSuccessorAssistantLines(
          claudeProjectsRoot,
          attemptPlan.successorSessionId,
          attemptPlan.launchNonce,
        );
      },
    });
    const durationMs = Math.max(0, nowMs() - startedAtMs);
    attempts.push({
      attempt,
      slotId: result.launch.id,
      successorSessionId: attemptPlan.successorSessionId,
      slotStatus: result.launch.status,
      failureReason: result.ok ? null : result.reason,
      durationMs,
    });

    // apply 後は raw launch nonce を含む prompt/argv を JSON・log へ再掲しない（contract §70.2）。
    const appliedJsonPayload = {
      ...jsonPayload,
      successorSessionId: attemptPlan.successorSessionId,
      startupPrompt: "[redacted after durable arm]",
      tmuxArgs: [] as string[],
      tmuxCommandLine: "[redacted after durable arm]",
      tmuxCommandBytes: attemptPlan.tmuxCommandBytes,
      maxAttempts,
      attempts: [...attempts],
    };

    if (!result.ok) {
      const rolledBack = ["stopped", "rejected", "expired"].includes(result.launch.status);
      const deliveryUnknown = delivery?.status === "unknown";
      const rollbackComplete = deliveryUnknown && hasCompleteHandoverRollback(
        deps,
        result.launch,
        sessionId,
        generation,
      );
      let retryPlanFailureReason: string | undefined;
      if (deliveryUnknown && rollbackComplete && attempt < maxAttempts) {
        const nextAttemptPlan = createHandoverAttemptPlan(deps, {
          missionId,
          sessionId,
          orchestratorId,
          resolvedCwd,
        });
        const reusedFields = rememberFreshHandoverAttemptPlan(usedAttemptValues, nextAttemptPlan);
        if (reusedFields.length === 0) {
          attemptPlan = nextAttemptPlan;
          continue;
        }
        retryPlanFailureReason =
          `handover 再試行 plan の採番が使用済み試行と重複しました: ${reusedFields.join(", ")}`;
      }

      // --max-attempts=1 は従来どおり手動再実行を案内する。自動再試行を実際に使い切った場合だけ
      // playbook §0.8.1 のエスカレーション梯子へ切り替える。
      const attemptsExhausted = deliveryUnknown && rollbackComplete && maxAttempts > 1 && attempt >= maxAttempts;
      const retryGuidance = deliveryUnknown
        ? deliveryFailureGuidance(rollbackComplete, attemptsExhausted)
        : undefined;
      const deliveryFailureFields = retryGuidance !== undefined
        ? {
            delivery,
            tokenDisposition: "possibly-consumed" as const,
            retryPolicy: "new-token-required" as const,
            attemptsExhausted,
            ...retryGuidance,
          }
        : {};
      const failureReason = retryPlanFailureReason ?? result.reason;
      const failurePayload = {
        ...appliedJsonPayload,
        ...deliveryFailureFields,
        applied: false,
        rolledBack,
        slotId: result.launch.id,
        slotStatus: result.launch.status,
        tmuxSessionName: result.launch.plannedTmuxSession,
        panePid: result.launch.panePid,
        processGroupId: result.launch.processGroupId,
        failReason: failureReason,
        ...(!rolledBack
          ? {
              recoveryCommand:
                `hachi orchestrator handover --session ${sessionId} --generation ${generation} --apply`,
            }
          : {}),
      };
      emit(deps, options.json === true, failurePayload, [
        "=== orchestrator handover --apply ===",
        "",
        failureReason,
        `durable slot: ${result.launch.id} status=${result.launch.status}`,
        `試行回数: ${attempt}/${maxAttempts}`,
        rolledBack
          ? "exact runtime の停止と source 復旧を durable transaction で完了しました。"
          : "停止証拠が揃わないため replacement gate を閉じたままです。",
        ...(retryGuidance === undefined ? [] : [retryGuidance.retryGuidance]),
      ]);
      deps.exit(rolledBack ? 1 : 2);
      return;
    }

    const successPayload = {
      ...appliedJsonPayload,
      applied: true,
      delivery: delivery ?? { status: "confirmed" as const, confirmedVia: "transcript" as const },
      slotId: result.launch.id,
      slotStatus: result.launch.status,
      boardSuccessorSessionId: result.successor.id,
      successorGeneration: result.successor.generation,
      tmuxSessionName: attemptPlan.tmuxSessionName,
      attachCommand: `tmux attach-session -t ${shellQuote(attemptPlan.tmuxSessionName)}`,
      panePid: result.launch.panePid,
      processGroupId: result.launch.processGroupId,
    };
    const successorHeartbeat = await waitForSuccessorHeartbeat(
      deps,
      result.successor,
      deps.handoverSuccessorHeartbeatPoll ?? DEFAULT_SUCCESSOR_HEARTBEAT_POLL,
    );
    const liveness = await waitForSuccessorLiveness(deps, {
      launcher,
      tmuxSessionName: attemptPlan.tmuxSessionName,
      panePid: result.launch.panePid,
      processGroupId: result.launch.processGroupId,
      claudeProjectsRoot,
      successorSessionId: attemptPlan.successorSessionId,
      launchNonce: attemptPlan.launchNonce,
      assistantLineBaseline: deliveryAssistantLineBaseline,
      successorHeartbeat,
    });
    const livenessRecoveryCommand =
      `hachi orchestrator handover --session ${shellQuote(result.successor.id)} ` +
      `--generation ${result.successor.generation} --apply`;
    const warnings = successorHeartbeat.warning === undefined ? [] : [successorHeartbeat.warning];
    const successLines = [
      "=== orchestrator handover --apply ===",
      "",
      "後継セッションを起動しました。",
      `  試行: ${attempt}/${maxAttempts}`,
      `  durable slot: ${result.launch.id}`,
      `  tmux session: ${attemptPlan.tmuxSessionName}`,
      `  pane PID: ${result.launch.panePid}`,
      `  board session: ${result.successor.id} generation=${result.successor.generation}`,
      `  liveness: ${liveness.status} ` +
        `(tmux=${liveness.detail.tmuxSession}, process=${liveness.detail.process}, ` +
        `transcript=${liveness.detail.transcriptGrew}, board=${liveness.detail.boardSession}, ` +
        `heartbeat=${liveness.detail.heartbeatAdvanced})`,
      ...(successorHeartbeat.confirmed
        ? [
            `  heartbeat 確認: ${successorHeartbeat.baselineAt} -> ${successorHeartbeat.observedAt}`,
          ]
        : [
            `⚠ ${SUCCESSOR_HEARTBEAT_WARNING}`,
            `復旧コマンド: ${successorHeartbeat.recoveryCommand}`,
          ]),
      ...(liveness.status === "lost"
        ? [
            `⚠ ${SUCCESSOR_LIVENESS_WARNING}`,
            `復旧コマンド: ${livenessRecoveryCommand}`,
          ]
        : []),
      "",
      "後継セッションに接続するには:",
      `  tmux attach-session -t ${shellQuote(attemptPlan.tmuxSessionName)}`,
      "",
      "※ transcript delivery attest と handoff final は durable slot transaction で完了済みです。",
    ];
    emit(deps, options.json === true, {
      ...successPayload,
      successorHeartbeat,
      liveness,
      warnings,
      ...(liveness.status === "lost"
        ? {
            recoveryCommand: livenessRecoveryCommand,
            recoveryGuidance: SUCCESSOR_LIVENESS_WARNING,
          }
        : {}),
    }, successLines);
    return;
  }

  throw new Error("orchestrator handover の再試行ループが結果なしで終了しました");
}

function addSessionOptions(command: Command): Command {
  return command
    .requiredOption("--session <id>", "orchestrator session ID")
    .requiredOption("--generation <n>", "session generation", parseGeneration)
    .requiredOption("--claim <token>", "request claim token");
}

export function registerOrchestratorCommand(program: Command, deps: CliDeps): void {
  const orchestrator = program.command("orchestrator").description("オーケストレーター session/watch/inbox（contract §55）");
  registerHumanDecisionAskCommand(orchestrator, deps);

  orchestrator.command("register")
    .requiredOption("--label <label>")
    .requiredOption("--project <project>")
    .requiredOption("--cwd <path>")
    .option("--repo-common-dir <path>")
    .option("--provider <provider>")
    .option("--provider-session-id <id>")
    .option("--json")
    .action(withErrorHandling(deps, (options) => runRegister(deps, options)));
  orchestrator.command("list").option("--json")
    .action(withErrorHandling(deps, (options) => runOrchestratorList(deps, options)));

  const session = orchestrator.command("session").description("session lifecycle");
  session.command("start").argument("<orchestrator-id>").option("--provider <provider>").option("--provider-session-id <id>").option("--json")
    .action(withErrorHandling(deps, (id, options) => runSessionStart(deps, id, options)));
  session.command("status").option("--orchestrator <id>").option("--json")
    .action(withErrorHandling(deps, (options) => runSessionStatus(deps, options)));
  session.command("resolve")
    .description("provider session ID から live board session を shell 代入形式で解決する")
    .requiredOption("--provider-session-id <id>")
    .action(withErrorHandling(deps, (options) => runSessionResolve(deps, options)));
  session.command("bootstrap-heartbeat")
    .description("provider session ID を解決して detached heartbeat を開始する")
    .requiredOption("--provider-session-id <id>")
    .option("--json")
    .addOption(new Option("--daemon").hideHelp())
    .action(withErrorHandling(deps, (options) => runBootstrapHeartbeat(deps, options)));
  session.command("stop-heartbeat")
    .description("provider session ID の pidfile を正本に heartbeat を停止する")
    .requiredOption("--provider-session-id <id>")
    .option("--json")
    .action(withErrorHandling(deps, (options) => runStopHeartbeat(deps, options)));
  session.command("heartbeat").argument("<session-id>").requiredOption("--generation <n>", "generation", parseGeneration).option("--json")
    .action(withErrorHandling(deps, (id, options) => runHeartbeat(deps, id, options)));
  session.command("close").argument("<session-id>").requiredOption("--generation <n>", "generation", parseGeneration).option("--json")
    .action(withErrorHandling(deps, (id, options) => runClose(deps, id, options)));
  session.command("handoff-prepare").argument("<session-id>").requiredOption("--generation <n>", "generation", parseGeneration).option("--json")
    .action(withErrorHandling(deps, (id, options) => runHandoffPrepare(deps, id, options)));
  session.command("handoff-accept").argument("<old-session-id>").requiredOption("--token <token>").option("--provider <provider>").option("--provider-session-id <id>").option("--attestation-handle <handle>").option("--json")
    .action(withErrorHandling(deps, (id, options) => runHandoffAccept(deps, id, options)));
  session.command("handoff-cancel")
    .description("停止確認済みの後継が残した handoff_pending を active へ戻す")
    .argument("<session-id>")
    .requiredOption("--generation <n>", "generation", parseGeneration)
    .requiredOption("--token-hash <hash>", "session status に表示される handoff token hash")
    .requiredOption("--confirm-successor-stopped", "exact tmux session / pane PID / process group の停止確認済み宣言")
    .option("--json")
    .action(withErrorHandling(deps, (id, options) => runHandoffCancel(deps, id, options)));
  session.command("takeover").argument("<orchestrator-id>").option("--stale-sec <n>", "stale 秒", (v) => parsePositiveInteger(v, "stale-sec"), DEFAULT_STALE_SEC).option("--provider <provider>").option("--provider-session-id <id>").option("--attestation-handle <handle>").option("--json")
    .action(withErrorHandling(deps, (id, options) => runTakeover(deps, id, options)));

  const successorLaunch = orchestrator.command("successor-launch")
    .description("durable successor launch helper（contract §70〜§73）");
  successorLaunch.command("attest")
    .description("Codex SessionStart hook の exact runtime attestation")
    .action(withErrorHandling(deps, () => runSuccessorLaunchAttest(deps)));
  successorLaunch.command("start")
    .description("Codex successor を durable arm と tmux barrier 経由で起動する")
    .requiredOption("--kind <kind>", "handoff / takeover")
    .requiredOption("--source-session <id>", "source orchestrator session ID")
    .requiredOption("--generation <n>", "source generation", parseGeneration)
    .requiredOption("--cwd <absolute>", "canonicalize 可能な absolute cwd")
    .option("--stale-sec <n>", "takeover stale 秒", (value) => parsePositiveInteger(value, "stale-sec"), DEFAULT_STALE_SEC)
    .option("--json")
    .action(withErrorHandling(deps, (options) => runSuccessorLaunchStart(deps, defaultTmuxLauncher, options)));
  successorLaunch.command("rollback-complete")
    .description("uncertain slot の row 固定 target を再観測する（既定 dry-run）")
    .requiredOption("--slot <id>", "successor launch slot ID")
    .requiredOption("--fence <fence>", "owner-only stop fence")
    .option("--apply", "三点停止証拠一致時だけ stopped CAS を適用する")
    .option("--json")
    .action(withErrorHandling(deps, (options) => runSuccessorLaunchRollbackComplete(
      deps,
      defaultTmuxLauncher,
      options,
    )));
  successorLaunch.command("close-uncertain")
    .description("uncertain slot を owning orchestrator session fence で閉じる（既定 dry-run）")
    .requiredOption("--slot <id>", "successor launch slot ID")
    .requiredOption("--orchestrator <id>", "slot を所有する stable orchestrator identity")
    .requiredOption("--session <id>", "owning orchestrator session ID")
    .requiredOption("--generation <n>", "owning session generation", parseGeneration)
    .option("--confirm", "全条件一致時だけ stopped CAS を適用する")
    .option("--json")
    .action(withErrorHandling(deps, (options) => runSuccessorLaunchFencedClose(
      deps,
      defaultTmuxLauncher,
      options,
    )));

  const watch = orchestrator.command("watch").description("watch subscription");
  watch.command("add").requiredOption("--orchestrator <id>").requiredOption("--scope <scope>").requiredOption("--selector <value>").option("--role <role>", "role", "primary").option("--priority <n>", "priority", (v) => parseNonNegativeInteger(v, "priority"), 0).option("--json")
    .action(withErrorHandling(deps, (options) => runWatchAdd(deps, options)));
  watch.command("list").option("--orchestrator <id>").option("--all", "inactive な watch も表示する").option("--json")
    .action(withErrorHandling(deps, (options) => runWatchList(deps, options)));
  watch.command("prune").description("selector のディレクトリが消えた worktree scope watch を inactive にする")
    .requiredOption("--orchestrator <id>").option("--apply", "既定の dry-run をやめて実際に inactive 化する").option("--json")
    .action(withErrorHandling(deps, (options) => runWatchPrune(deps, options)));
  watch.command("enable").argument("<watch-id>").option("--json")
    .action(withErrorHandling(deps, (id, options) => runWatchToggle(deps, id, true, options)));
  watch.command("disable").argument("<watch-id>").option("--json")
    .action(withErrorHandling(deps, (id, options) => runWatchToggle(deps, id, false, options)));

  orchestrator.command("handover")
    .description("後継セッション起動（既定は dry-run、--apply で実行）")
    .option("--session <id>", "orchestrator session ID")
    .option("--generation <n>", "session generation", parseGeneration)
    .option("--mission <task-id>", "ミッション task ID")
    .option("--orchestrator <id>", "live session の orchestrator identity を絞り込む")
    .option("--apply", "dry-run をやめて実際に後継セッションを起動する")
    .option(
      "--max-attempts <n>",
      `delivery=unknown の最大試行回数（1〜${HANDOVER_MAX_ATTEMPTS_LIMIT}）`,
      parseHandoverMaxAttempts,
      DEFAULT_HANDOVER_MAX_ATTEMPTS,
    )
    .option("--json")
    .action(withErrorHandling(deps, (options) => runHandover(deps, options)));

  registerOrchestratorUsageCommand(orchestrator, deps);
  registerOrchestratorUsageProfileCommand(orchestrator, deps);

  orchestrator.command("bind").argument("<task-id>").requiredOption("--orchestrator <id>").option("--role <role>", "role", "primary").option("--json")
    .action(withErrorHandling(deps, (id, options) => runBind(deps, id, options)));
  orchestrator.command("inbox").option("--orchestrator <id>").option("--json")
    .action(withErrorHandling(deps, (options) => runInbox(deps, options)));
  orchestrator.command("await").requiredOption("--session <id>").requiredOption("--generation <n>", "generation", parseGeneration).option("--interval <sec>", "poll 秒", (v) => parsePositiveInteger(v, "interval"), DEFAULT_INTERVAL_SEC).option("--lease <sec>", "claim lease 秒", (v) => parsePositiveInteger(v, "lease"), DEFAULT_LEASE_SEC).option("--max-wait <sec>", "最大待機秒", (v) => parsePositiveInteger(v, "max-wait")).option("--json")
    .action(withErrorHandling(deps, (options) => runAwait(deps, options)));

  addSessionOptions(orchestrator.command("answer").argument("<request-id>").argument("<answer>").option("--json"))
    .action(withErrorHandling(deps, (id, answer, options) => runAnswer(deps, id, answer, options)));
  addSessionOptions(orchestrator.command("escalate").argument("<request-id>").argument("<question>").option("--json"))
    .action(withErrorHandling(deps, (id, question, options) => runEscalate(deps, id, question, options)));
  addSessionOptions(
    orchestrator.command("resolve")
      .argument("<request-id>")
      .argument("<resolution>", "handled | false_positive")
      .argument("<reason>")
      .option("--json"),
  ).action(withErrorHandling(deps, (id, resolution, reason, options) =>
    runResolve(deps, id, resolution, reason, options)
  ));
  addSessionOptions(orchestrator.command("release").argument("<request-id>").option("--json"))
    .action(withErrorHandling(deps, (id, options) => runRelease(deps, id, options)));
}
