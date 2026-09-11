// =============================================================================
// contract §73.3 Gate 3: Codex successor の durable tmux launch。
// arm 前の静的 artifact probe、bind commit 前の one-shot barrier、15秒 attestation、
// exact owner/三点停止 rollback を一つの補償境界に閉じ込める。
// =============================================================================

import { createHash, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  newNonce,
  type MarkOrchestratorSuccessorStopPendingResult,
  type OrchestratorSessionRow,
  type OrchestratorSuccessorLaunchKind,
  type OrchestratorSuccessorLaunchRow,
  type OrchestratorSuccessorStopEvidence,
  type PartialOrchestratorSuccessorRuntimeEvidence,
} from "@hachi/core";
import type {
  CliDeps,
  SuccessorLaunchClock,
  SuccessorLaunchRuntimeReadback,
  SuccessorTmuxPaneReadback,
  SuccessorTmuxReadbackFailureReason,
  SuccessorTmuxReadbackResult,
  TmuxLauncher,
} from "../deps.js";
import { emit } from "../output.js";
import { successorServerLifetimeMismatchMessage } from "../successor-attestation.js";

const SUCCESSOR_RUNTIME_BIND_BUDGET_MS = 15_000;
const SUCCESSOR_ATTESTATION_ISSUANCE_BUDGET_MS = 15_000;
const SUCCESSOR_POLL_INTERVAL_MS = 250;
const SUCCESSOR_STOP_POLL = { intervalMs: 200, timeoutMs: 10_000 };
const HANDOFF_TTL_SEC = 600;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TMUX_PANE = /^%[0-9]+$/;
const TMUX_COMMAND_MAX_BYTES = 15_000;

const defaultClock: SuccessorLaunchClock = {
  nowMs: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }),
};

export interface SuccessorLaunchStartOptions {
  kind: string;
  sourceSession: string;
  generation: number;
  cwd: string;
  staleSec: number;
  json?: boolean;
}

export interface SuccessorLaunchRollbackOptions {
  slot: string;
  fence: string;
  apply?: boolean;
  json?: boolean;
}

export interface SuccessorLaunchFencedCloseOptions {
  slot: string;
  orchestrator: string;
  session: string;
  generation: number;
  confirm?: boolean;
  json?: boolean;
}

interface PostSpawnObservation {
  runtime: SuccessorLaunchRuntimeReadback;
  canonicalCwd: string | null;
  hostId: string | null;
  tmuxSocketPath: string | null;
  tmuxServerPid: number | null;
  tmuxServerStartTime: number | null;
  tmuxServerLifetimeHash: string | null;
  serverLifetimeFailure: SuccessorTmuxReadbackFailureReason | null;
  hookDefinitionHash: string | null;
  hookExecutableHash: string | null;
}

interface SuccessorArtifactHashes {
  hookDefinitionHash: string;
  hookExecutableHash: string;
}

interface BoundSuccessorRuntime {
  armed: OrchestratorSuccessorLaunchRow;
  bound: OrchestratorSuccessorLaunchRow;
  observation: PostSpawnObservation;
  launcher: TmuxLauncher;
  clock: SuccessorLaunchClock;
}

interface SuccessorRuntimePlan {
  targetProvider: "codex" | "claude";
  kind: OrchestratorSuccessorLaunchKind;
  sourceSessionId: string;
  sourceGeneration: number;
  orchestratorId: string;
  canonicalCwd: string;
  hostId: string;
  launchNonce: string;
  ownerNonce: string;
  plannedTmuxSession: string;
  checkPlannedSessionAbsent: boolean;
  artifactHashes: SuccessorArtifactHashes;
  readArtifactHashes: () => SuccessorArtifactHashes;
  buildTmuxArgs: (armed: OrchestratorSuccessorLaunchRow) => string[];
  barrier: string | null;
  handoffToken: string;
  staleBefore: number | null;
  secrets: readonly string[];
}

export interface ClaudeHandoverLaunchOptions {
  sourceSessionId: string;
  sourceGeneration: number;
  orchestratorId: string;
  canonicalCwd: string;
  providerSessionId: string;
  plannedTmuxSession: string;
  handoffToken: string;
  launchNonce: string;
  ownerNonce: string;
  barrier: string;
  tmuxArgs: string[];
  deliveryGate: () => Promise<void>;
}

export type ClaudeHandoverLaunchResult =
  | {
      ok: true;
      launch: OrchestratorSuccessorLaunchRow;
      successor: OrchestratorSessionRow;
    }
  | {
      ok: false;
      launch: OrchestratorSuccessorLaunchRow;
      reason: string;
    };

interface StopPointObservation {
  tmuxSessionAbsent: boolean | null;
  panePidAbsent: boolean | null;
  processGroupAbsent: boolean | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Claude は SessionStart hook を使わない。v23 の共通 exact-runtime 列には、
// transcript delivery protocol と固定 argv contract の provider-discriminated identity を保存する。
const CLAUDE_DELIVERY_ARTIFACT_HASHES: SuccessorArtifactHashes = {
  hookDefinitionHash: sha256("hachi-successor:claude-delivery-protocol:v1"),
  hookExecutableHash: sha256("hachi-successor:claude-session-id-argv:v1"),
};

function nowSeconds(clock: SuccessorLaunchClock): number {
  return Math.floor(clock.nowMs() / 1000);
}

function isPositiveInteger(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

function parseKind(value: string): OrchestratorSuccessorLaunchKind {
  if (value !== "handoff" && value !== "takeover") {
    throw new Error("--kind は handoff / takeover のみです");
  }
  return value;
}

function requireNonce(value: string, label: string): string {
  if (value === "" || value.includes("\0")) {
    throw new Error(`${label} の採番に失敗しました`);
  }
  return value;
}

function redactCapabilities(message: string, capabilities: readonly string[]): string {
  return capabilities.reduce(
    (current, capability) => capability === "" ? current : current.split(capability).join("[redacted]"),
    message,
  );
}

function measureTmuxCommandBytes(args: readonly string[]): number {
  return ["tmux", ...args].reduce(
    (total, value) => total + Buffer.byteLength(value, "utf8") + 1,
    0,
  );
}

/**
 * tmux の子 shell は barrier signal まで待ち、release 後に一度だけ interactive Codex へ exec する。
 * prompt と barrier は shell source へ連結せず positional argv で渡す。
 */
export function buildCodexSuccessorTmuxArgs(
  sessionName: string,
  cwd: string,
  barrier: string,
  startupPrompt: string,
): string[] {
  return [
    "new-session", "-d",
    "-s", sessionName,
    "-c", cwd,
    "/bin/sh", "-c",
    'tmux wait-for "$1" && exec codex -- "$2"',
    "hachi-successor",
    barrier,
    startupPrompt,
  ];
}

function buildStartupPrompt(
  kind: OrchestratorSuccessorLaunchKind,
  slotId: string,
  sourceSessionId: string,
  orchestratorId: string,
  handoffToken: string,
): string {
  const finalCommand = kind === "handoff"
    ? `hachi orchestrator session handoff-accept ${sourceSessionId} --token ${handoffToken} ` +
      "--provider codex --attestation-handle <additionalContextのhandle> --json"
    : `hachi orchestrator session takeover ${orchestratorId} ` +
      "--provider codex --attestation-handle <additionalContextのhandle> --json";
  return [
    `Hachi Codex successor slot: ${slotId}`,
    "SessionStart additionalContext に渡された exact attestation handle だけを使うこと。",
    "caller supplied provider session ID や transcript 探索を使わないこと。",
    "次の trusted final command の <additionalContextのhandle> を exact handle で置換し、一度だけ実行すること:",
    finalCommand,
  ].join("\n");
}

function safeHash(value: string | null): string | null {
  return value === null || value === "" ? null : sha256(value);
}

function emptyRuntimeReadback(): SuccessorLaunchRuntimeReadback {
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

function readPostSpawnObservation(
  deps: CliDeps,
  launcher: TmuxLauncher,
  sessionName: string,
  readArtifactHashes: () => SuccessorArtifactHashes,
): PostSpawnObservation {
  let runtime = emptyRuntimeReadback();
  try {
    runtime = launcher.readSuccessorRuntime?.(sessionName) ?? runtime;
  } catch {
    runtime = emptyRuntimeReadback();
  }

  let canonicalCwd: string | null = null;
  if (runtime.cwd !== null) {
    try {
      const candidate = deps.canonicalizeSuccessorCwd(runtime.cwd);
      if (isAbsolute(candidate)) canonicalCwd = candidate;
    } catch {
      canonicalCwd = null;
    }
  }

  let hostId: string | null = null;
  try {
    const observed = deps.currentHostId().trim();
    if (observed !== "") hostId = observed;
  } catch {
    hostId = null;
  }

  let hookDefinitionHash: string | null = null;
  let hookExecutableHash: string | null = null;
  try {
    const hashes = readArtifactHashes();
    hookDefinitionHash = SHA256_HEX.test(hashes.hookDefinitionHash) ? hashes.hookDefinitionHash : null;
    hookExecutableHash = SHA256_HEX.test(hashes.hookExecutableHash) ? hashes.hookExecutableHash : null;
  } catch {
    hookDefinitionHash = null;
    hookExecutableHash = null;
  }
  return {
    runtime,
    canonicalCwd,
    hostId,
    tmuxSocketPath: null,
    tmuxServerPid: null,
    tmuxServerStartTime: null,
    tmuxServerLifetimeHash: null,
    serverLifetimeFailure: null,
    hookDefinitionHash,
    hookExecutableHash,
  };
}

function observationFromExactReadback(
  deps: CliDeps,
  readback: SuccessorTmuxPaneReadback,
  readArtifactHashes: () => SuccessorArtifactHashes,
): PostSpawnObservation {
  let canonicalCwd: string | null = null;
  try {
    const candidate = deps.canonicalizeSuccessorCwd(readback.cwd);
    if (isAbsolute(candidate)) canonicalCwd = candidate;
  } catch {
    canonicalCwd = null;
  }
  let hostId: string | null = null;
  try {
    const observed = deps.currentHostId().trim();
    if (observed !== "") hostId = observed;
  } catch {
    hostId = null;
  }
  let hookDefinitionHash: string | null = null;
  let hookExecutableHash: string | null = null;
  try {
    const hashes = readArtifactHashes();
    hookDefinitionHash = SHA256_HEX.test(hashes.hookDefinitionHash) ? hashes.hookDefinitionHash : null;
    hookExecutableHash = SHA256_HEX.test(hashes.hookExecutableHash) ? hashes.hookExecutableHash : null;
  } catch {
    hookDefinitionHash = null;
    hookExecutableHash = null;
  }
  return {
    runtime: {
      stable: true,
      tmuxSession: readback.tmuxSession,
      tmuxPane: readback.tmuxPane,
      panePid: readback.panePid,
      processGroupId: readback.processGroupId,
      cwd: readback.cwd,
      ownerNonce: readback.ownerNonce,
    },
    canonicalCwd,
    hostId,
    tmuxSocketPath: readback.tmuxSocketPath,
    tmuxServerPid: readback.tmuxServerPid,
    tmuxServerStartTime: readback.tmuxServerStartTime,
    tmuxServerLifetimeHash: readback.tmuxServerLifetimeHash,
    serverLifetimeFailure: null,
    hookDefinitionHash,
    hookExecutableHash,
  };
}

function readBindObservation(
  deps: CliDeps,
  launcher: TmuxLauncher,
  sessionName: string,
  readArtifactHashes: () => SuccessorArtifactHashes,
): PostSpawnObservation {
  const locator = readPostSpawnObservation(deps, launcher, sessionName, readArtifactHashes);
  if (!locator.runtime.stable || locator.runtime.tmuxPane === null ||
      !TMUX_PANE.test(locator.runtime.tmuxPane)) {
    return locator;
  }
  const nonceCandidate = deps.newSuccessorServerLifetimeNonce?.() ?? randomBytes(32).toString("base64url");
  let result: SuccessorTmuxReadbackResult;
  try {
    result = deps.successorTmuxReadback.initializeServerLifetimeAndReadExactPane(
      locator.runtime.tmuxPane,
      nonceCandidate,
    );
  } catch {
    return { ...locator, serverLifetimeFailure: "unavailable" };
  }
  if (!result.ok) return { ...locator, serverLifetimeFailure: result.reason };
  return observationFromExactReadback(deps, result.value, readArtifactHashes);
}

function partialEvidence(observation: PostSpawnObservation): PartialOrchestratorSuccessorRuntimeEvidence {
  const runtime = observation.runtime;
  const stable = runtime.stable;
  return {
    observedCanonicalCwd: stable ? observation.canonicalCwd : null,
    observedHostId: observation.hostId,
    tmuxSession: stable && runtime.tmuxSession !== null && runtime.tmuxSession !== "" ? runtime.tmuxSession : null,
    tmuxPane: stable && runtime.tmuxPane !== null && TMUX_PANE.test(runtime.tmuxPane) ? runtime.tmuxPane : null,
    panePid: stable && isPositiveInteger(runtime.panePid) ? runtime.panePid : null,
    processGroupId: stable && isPositiveInteger(runtime.processGroupId) ? runtime.processGroupId : null,
    tmuxSocketPath: stable && observation.tmuxSocketPath !== null &&
      isAbsolute(observation.tmuxSocketPath) ? observation.tmuxSocketPath : null,
    tmuxServerPid: stable && isPositiveInteger(observation.tmuxServerPid)
      ? observation.tmuxServerPid
      : null,
    tmuxServerStartTime: stable && isPositiveInteger(observation.tmuxServerStartTime)
      ? observation.tmuxServerStartTime
      : null,
    tmuxServerLifetimeHash: stable && observation.tmuxServerLifetimeHash !== null &&
      SHA256_HEX.test(observation.tmuxServerLifetimeHash) ? observation.tmuxServerLifetimeHash : null,
    ownerNonceHash: stable ? safeHash(runtime.ownerNonce) : null,
    observedHookDefinitionHash: observation.hookDefinitionHash,
    observedHookExecutableHash: observation.hookExecutableHash,
  };
}

function exactObservationMatches(
  observation: PostSpawnObservation,
  expected: {
    canonicalCwd: string;
    hostId: string;
    plannedTmuxSession: string;
    ownerNonce: string;
    hookDefinitionHash: string;
    hookExecutableHash: string;
  },
): boolean {
  const runtime = observation.runtime;
  return runtime.stable &&
    runtime.tmuxSession === expected.plannedTmuxSession &&
    runtime.tmuxPane !== null && TMUX_PANE.test(runtime.tmuxPane) &&
    isPositiveInteger(runtime.panePid) &&
    isPositiveInteger(runtime.processGroupId) &&
    observation.tmuxSocketPath !== null && isAbsolute(observation.tmuxSocketPath) &&
    isPositiveInteger(observation.tmuxServerPid) &&
    isPositiveInteger(observation.tmuxServerStartTime) &&
    observation.tmuxServerLifetimeHash !== null && SHA256_HEX.test(observation.tmuxServerLifetimeHash) &&
    observation.canonicalCwd === expected.canonicalCwd &&
    observation.hostId === expected.hostId &&
    runtime.ownerNonce === expected.ownerNonce &&
    observation.hookDefinitionHash === expected.hookDefinitionHash &&
    observation.hookExecutableHash === expected.hookExecutableHash;
}

function emitSucceeded(
  deps: CliDeps,
  json: boolean,
  launch: OrchestratorSuccessorLaunchRow,
  idempotent: boolean,
): void {
  const result = {
    slotId: launch.id,
    status: launch.status,
    successorSessionId: launch.successorSessionId,
    successorGeneration: launch.successorGeneration,
    idempotent,
  };
  emit(
    deps,
    json,
    result,
    [
      `Codex successor launch が完了しました: slot=${launch.id}`,
      `successor session=${launch.successorSessionId} generation=${launch.successorGeneration ?? "unknown"}`,
      ...(idempotent ? ["既存 succeeded slot を再読込しました"] : []),
    ],
  );
}

function observeStopPoints(launcher: TmuxLauncher, launch: OrchestratorSuccessorLaunchRow): StopPointObservation {
  let tmuxSessionAbsent: boolean | null = null;
  let panePidAbsent: boolean | null = null;
  let processGroupAbsent: boolean | null = null;

  if (launch.tmuxSession !== "") {
    try {
      tmuxSessionAbsent = !launcher.hasSession(launch.tmuxSession);
    } catch {
      tmuxSessionAbsent = null;
    }
  }
  if (launch.panePid !== null) {
    try {
      panePidAbsent = launcher.isPaneProcessAlive === undefined
        ? null
        : !launcher.isPaneProcessAlive(launch.panePid);
    } catch {
      panePidAbsent = null;
    }
  }
  if (launch.processGroupId !== null) {
    try {
      processGroupAbsent = !launcher.isProcessGroupAlive(launch.processGroupId);
    } catch {
      processGroupAbsent = null;
    }
  }
  return { tmuxSessionAbsent, panePidAbsent, processGroupAbsent };
}

function allStopPointsAbsent(observation: StopPointObservation): boolean {
  return observation.tmuxSessionAbsent === true &&
    observation.panePidAbsent === true &&
    observation.processGroupAbsent === true;
}

async function pollStopPoints(
  deps: CliDeps,
  launcher: TmuxLauncher,
  launch: OrchestratorSuccessorLaunchRow,
  clock: SuccessorLaunchClock,
): Promise<StopPointObservation> {
  const config = deps.successorLaunchStopPoll ?? SUCCESSOR_STOP_POLL;
  const deadline = clock.nowMs() + config.timeoutMs;
  let observation = observeStopPoints(launcher, launch);
  while (!allStopPointsAbsent(observation) && clock.nowMs() < deadline) {
    await clock.sleep(config.intervalMs);
    observation = observeStopPoints(launcher, launch);
  }
  return observation;
}

async function exactRollback(
  deps: CliDeps,
  launcher: TmuxLauncher,
  claimed: MarkOrchestratorSuccessorStopPendingResult,
  clock: SuccessorLaunchClock,
  expectedOwnerNonceHash?: string,
  suppressKill = false,
): Promise<OrchestratorSuccessorLaunchRow> {
  const launch = claimed.launch;
  let ownerMatched: boolean | null = null;
  let ownerReadbackAt: number | null = null;
  let killOwnerReadbackHash = "";
  let killResult: OrchestratorSuccessorStopEvidence["killResult"] = "not-attempted";

  const completeRuntimeAuthority = launch.observedCanonicalCwd === launch.canonicalCwd &&
    launch.observedHostId === launch.hostId &&
    launch.tmuxSession !== "" && launch.tmuxSession === launch.plannedTmuxSession &&
    launch.tmuxPane !== "" && launch.panePid !== null && launch.processGroupId !== null &&
    isAbsolute(launch.tmuxSocketPath) && launch.tmuxServerPid !== null &&
    launch.tmuxServerStartTime !== null && SHA256_HEX.test(launch.tmuxServerLifetimeHash) &&
    launch.ownerNonceHash !== "" &&
    launch.observedHookDefinitionHash === launch.hookDefinitionHash &&
    launch.observedHookExecutableHash === launch.hookExecutableHash &&
    (expectedOwnerNonceHash === undefined || launch.ownerNonceHash === expectedOwnerNonceHash);

  let currentRuntimeMatched = false;
  if (completeRuntimeAuthority && !suppressKill) {
    try {
      const result = deps.successorTmuxReadback.readExactPane(launch.tmuxPane);
      if (result.ok) {
        const current = result.value;
        currentRuntimeMatched = current.tmuxSession === launch.tmuxSession &&
          current.tmuxPane === launch.tmuxPane && current.panePid === launch.panePid &&
          current.processGroupId === launch.processGroupId &&
          current.tmuxSocketPath === launch.tmuxSocketPath &&
          current.tmuxServerPid === launch.tmuxServerPid &&
          current.tmuxServerStartTime === launch.tmuxServerStartTime &&
          current.tmuxServerLifetimeHash === launch.tmuxServerLifetimeHash;
      }
    } catch {
      currentRuntimeMatched = false;
    }
  }

  // partial/mismatch/lifetime drift を owner authority に昇格させない。完全な row 固定 target だけを再読込する。
  if (currentRuntimeMatched) {
    try {
      const observedOwner = launcher.getSessionOwnerNonce(launch.tmuxSession);
      if (observedOwner !== null && observedOwner !== "") {
        killOwnerReadbackHash = sha256(observedOwner);
        ownerMatched = killOwnerReadbackHash === launch.ownerNonceHash && launch.ownerNonceHash !== "";
        ownerReadbackAt = nowSeconds(clock);
      }
    } catch {
      ownerMatched = null;
    }
  }

  if (ownerMatched === true) {
    try {
      killResult = launcher.killSession(launch.tmuxSession) ? "succeeded" : "failed";
    } catch {
      killResult = "unknown";
    }
  }

  const stopPoints = killResult === "succeeded"
    ? await pollStopPoints(deps, launcher, launch, clock)
    : observeStopPoints(launcher, launch);
  const observedAt = nowSeconds(clock);
  return deps.store.recordSuccessorLaunchStop({
    slotId: launch.id,
    expectedRevision: launch.revision,
    stopFenceHash: sha256(claimed.stopFence),
    killOwnerReadbackHash,
    evidence: {
      ownerMatched,
      ownerReadbackAt,
      killResult,
      ...stopPoints,
      observedAt,
    },
    now: observedAt,
  });
}

async function recoverUncertainStop(
  deps: CliDeps,
  launcher: TmuxLauncher,
  claimed: MarkOrchestratorSuccessorStopPendingResult,
  clock: SuccessorLaunchClock,
): Promise<OrchestratorSuccessorLaunchRow> {
  const launch = claimed.launch;
  if (launch.status !== "uncertain") {
    throw new Error(`successor uncertain recovery の状態が不正です: ${launch.status}`);
  }

  // kill 成功後に遅れて消える PID/PGID を回収する経路では、消滅済み tmux から owner を再読込しない。
  // owner/kill は uncertain row の保存済み証拠を正本とし、row 固定 target の三点だけを fresh 観測する。
  const stopPoints = await pollStopPoints(deps, launcher, launch, clock);
  const observedAt = nowSeconds(clock);
  return deps.store.recordSuccessorLaunchStop({
    slotId: launch.id,
    expectedRevision: launch.revision,
    stopFenceHash: sha256(claimed.stopFence),
    killOwnerReadbackHash: launch.killOwnerReadbackHash,
    evidence: {
      ownerMatched: launch.stopEvidence.ownerMatched,
      ownerReadbackAt: launch.stopEvidence.ownerReadbackAt,
      killResult: launch.stopEvidence.killResult,
      ...stopPoints,
      observedAt,
    },
    now: observedAt,
  });
}

async function stopSpawnedAttempt(
  deps: CliDeps,
  launcher: TmuxLauncher,
  armed: OrchestratorSuccessorLaunchRow,
  observation: PostSpawnObservation,
  error: string,
  secrets: readonly string[],
  expectedOwnerNonceHash: string,
  clock: SuccessorLaunchClock,
): Promise<never> {
  const safeError = redactCapabilities(error, secrets);
  let claimed: MarkOrchestratorSuccessorStopPendingResult;
  try {
    claimed = deps.store.markArmedSuccessorLaunchStopPending({
      slotId: armed.id,
      expectedRevision: armed.revision,
      error: safeError,
      ...partialEvidence(observation),
      now: nowSeconds(clock),
    });
  } catch (caught) {
    const current = deps.store.getSuccessorLaunch(armed.id);
    if (current === null || current.status !== "stop_pending") throw caught;
    claimed = claimStopPending(deps, current, safeError, nowSeconds(clock));
  }
  const stopped = await exactRollback(deps, launcher, claimed, clock, expectedOwnerNonceHash);
  throw new Error(`${safeError}: slot=${stopped.id} status=${stopped.status}`);
}

function claimStopPending(
  deps: CliDeps,
  launch: OrchestratorSuccessorLaunchRow,
  error: string,
  now: number,
): MarkOrchestratorSuccessorStopPendingResult {
  return deps.store.markSuccessorLaunchStopPending({
    slotId: launch.id,
    expectedRevision: launch.revision,
    expectedStatus: launch.status as "runtime_bound" | "attested" | "accepting" | "stop_pending" | "uncertain",
    error,
    ...(launch.kind === "handoff" && launch.status !== "stop_pending" && launch.status !== "uncertain"
      ? { replacementHandoffTokenHash: sha256(newNonce() + newNonce()) }
      : {}),
    now,
  });
}

async function rollbackBoundAttempt(
  deps: CliDeps,
  launcher: TmuxLauncher,
  launch: OrchestratorSuccessorLaunchRow,
  error: string,
  clock: SuccessorLaunchClock,
): Promise<OrchestratorSuccessorLaunchRow> {
  const suppressKill = error.startsWith("SUCCESSOR_SERVER_LIFETIME_MISMATCH:");
  let current = launch;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (current.status === "succeeded" || current.status === "stopped") {
      return current;
    }
    if (!(current.status === "runtime_bound" || current.status === "attested" ||
        current.status === "accepting" || current.status === "stop_pending" ||
        current.status === "uncertain")) {
      throw new Error(`successor rollback 対象の状態が不正です: ${current.status}`);
    }
    try {
      const claimed = claimStopPending(deps, current, error, nowSeconds(clock));
      return claimed.launch.status === "uncertain"
        ? await recoverUncertainStop(deps, launcher, claimed, clock)
        : await exactRollback(deps, launcher, claimed, clock, undefined, suppressKill);
    } catch (caught) {
      const reread = deps.store.getSuccessorLaunch(launch.id);
      if (reread === null || (reread.status === current.status && reread.revision === current.revision)) {
        throw caught;
      }
      current = reread;
    }
  }
  throw new Error("successor rollback の exact slot CAS が連続して競合しました");
}

async function armSpawnBindSuccessorRuntime(
  deps: CliDeps,
  fallbackLauncher: TmuxLauncher,
  plan: SuccessorRuntimePlan,
): Promise<BoundSuccessorRuntime> {
  const launcher = deps.tmuxLauncher ?? fallbackLauncher;
  if (plan.checkPlannedSessionAbsent && launcher.hasSession(plan.plannedTmuxSession)) {
    throw new Error(`planned tmux session は既に存在します: ${plan.plannedTmuxSession}`);
  }

  const clock = deps.successorLaunchClock ?? defaultClock;
  const now = nowSeconds(clock);
  const runtimeDeadlineAt = now + SUCCESSOR_RUNTIME_BIND_BUDGET_MS / 1_000;
  const attestationDeadlineAt = runtimeDeadlineAt + SUCCESSOR_ATTESTATION_ISSUANCE_BUDGET_MS / 1_000;
  const armCommon = {
    orchestratorId: plan.orchestratorId,
    targetProvider: plan.targetProvider,
    sourceSessionId: plan.sourceSessionId,
    sourceGeneration: plan.sourceGeneration,
    canonicalCwd: plan.canonicalCwd,
    hostId: plan.hostId,
    launchNonceHash: sha256(plan.launchNonce),
    plannedTmuxSession: plan.plannedTmuxSession,
    hookDefinitionHash: plan.artifactHashes.hookDefinitionHash,
    hookExecutableHash: plan.artifactHashes.hookExecutableHash,
    runtimeDeadlineAt,
    attestationDeadlineAt,
    now,
  } as const;
  const armed = plan.kind === "handoff"
    ? deps.store.armSuccessorLaunch({
        ...armCommon,
        kind: "handoff",
        handoffTokenFenceHash: sha256(plan.handoffToken),
        handoffExpiresAt: now + HANDOFF_TTL_SEC,
      })
    : deps.store.armSuccessorLaunch({
        ...armCommon,
        kind: "takeover",
        staleBefore: plan.staleBefore!,
      });

  const tmuxArgs = plan.buildTmuxArgs(armed);
  if (measureTmuxCommandBytes(tmuxArgs) > TMUX_COMMAND_MAX_BYTES) {
    deps.store.resolveUnboundSuccessorLaunch({
      slotId: armed.id,
      expectedRevision: armed.revision,
      to: "rejected",
      error: `${plan.targetProvider} successor tmux argv が上限を超えています`,
      now: nowSeconds(clock),
    });
    throw new Error(`${plan.targetProvider} successor tmux argv が上限を超えています`);
  }

  let launchResult: ReturnType<TmuxLauncher["launch"]>;
  try {
    launchResult = launcher.launch(tmuxArgs);
  } catch (error) {
    const observation = readPostSpawnObservation(
      deps,
      launcher,
      plan.plannedTmuxSession,
      plan.readArtifactHashes,
    );
    return await stopSpawnedAttempt(
      deps,
      launcher,
      armed,
      observation,
      `tmux spawn result を確認できません: ${error instanceof Error ? error.message : String(error)}`,
      plan.secrets,
      sha256(plan.ownerNonce),
      clock,
    );
  }
  if (!launchResult.ok) {
    const reason = redactCapabilities(launchResult.reason, plan.secrets);
    let definitelyUncreated = false;
    try {
      definitelyUncreated = !launcher.hasSession(plan.plannedTmuxSession);
    } catch {
      definitelyUncreated = false;
    }
    if (!definitelyUncreated) {
      const observation = readPostSpawnObservation(
        deps,
        launcher,
        plan.plannedTmuxSession,
        plan.readArtifactHashes,
      );
      return await stopSpawnedAttempt(
        deps,
        launcher,
        armed,
        observation,
        `tmux spawn failure 後にprocess未作成を証明できません: ${reason}`,
        plan.secrets,
        sha256(plan.ownerNonce),
        clock,
      );
    }
    const failedAt = nowSeconds(clock);
    deps.store.resolveUnboundSuccessorLaunch({
      slotId: armed.id,
      expectedRevision: armed.revision,
      to: failedAt > armed.runtimeDeadlineAt ? "expired" : "rejected",
      error: `tmux spawn 前に起動失敗を確認しました: ${reason}`,
      now: failedAt,
    });
    throw new Error(`tmux spawn 前に起動失敗を確認しました: ${reason}`);
  }

  let ownerSet = false;
  try {
    ownerSet = launcher.setSessionOwnerNonce(plan.plannedTmuxSession, plan.ownerNonce);
  } catch {
    ownerSet = false;
  }
  const observation = ownerSet
    ? readBindObservation(deps, launcher, plan.plannedTmuxSession, plan.readArtifactHashes)
    : readPostSpawnObservation(deps, launcher, plan.plannedTmuxSession, plan.readArtifactHashes);
  if (observation.serverLifetimeFailure !== null && observation.serverLifetimeFailure !== "unavailable") {
    await stopSpawnedAttempt(
      deps,
      launcher,
      armed,
      observation,
      successorServerLifetimeMismatchMessage(armed.id, observation.serverLifetimeFailure),
      plan.secrets,
      sha256(plan.ownerNonce),
      clock,
    );
  }
  if (!ownerSet || !exactObservationMatches(observation, {
    canonicalCwd: plan.canonicalCwd,
    hostId: plan.hostId,
    plannedTmuxSession: plan.plannedTmuxSession,
    ownerNonce: plan.ownerNonce,
    hookDefinitionHash: plan.artifactHashes.hookDefinitionHash,
    hookExecutableHash: plan.artifactHashes.hookExecutableHash,
  })) {
    await stopSpawnedAttempt(
      deps,
      launcher,
      armed,
      observation,
      "tmux spawn 後の exact runtime/owner/hash readback が一致しません",
      plan.secrets,
      sha256(plan.ownerNonce),
      clock,
    );
  }

  const runtime = observation.runtime;
  let bound: OrchestratorSuccessorLaunchRow;
  try {
    bound = deps.store.bindSuccessorLaunchRuntime({
      slotId: armed.id,
      expectedRevision: armed.revision,
      observedCanonicalCwd: observation.canonicalCwd!,
      observedHostId: observation.hostId!,
      tmuxSession: runtime.tmuxSession!,
      tmuxPane: runtime.tmuxPane!,
      panePid: runtime.panePid!,
      processGroupId: runtime.processGroupId!,
      tmuxSocketPath: observation.tmuxSocketPath!,
      tmuxServerPid: observation.tmuxServerPid!,
      tmuxServerStartTime: observation.tmuxServerStartTime!,
      tmuxServerLifetimeHash: observation.tmuxServerLifetimeHash!,
      ownerNonceHash: sha256(runtime.ownerNonce!),
      hookDefinitionHash: observation.hookDefinitionHash!,
      hookExecutableHash: observation.hookExecutableHash!,
      now: nowSeconds(clock),
    });
  } catch (error) {
    const safeError = redactCapabilities(
      `runtime bind commit を確認できません: ${error instanceof Error ? error.message : String(error)}`,
      plan.secrets,
    );
    const current = deps.store.getSuccessorLaunch(armed.id);
    if (current?.status === "runtime_bound") {
      const rolledBack = await rollbackBoundAttempt(deps, launcher, current, safeError, clock);
      throw new Error(`${safeError}: slot=${rolledBack.id} status=${rolledBack.status}`);
    }
    return await stopSpawnedAttempt(
      deps,
      launcher,
      armed,
      observation,
      safeError,
      plan.secrets,
      sha256(plan.ownerNonce),
      clock,
    );
  }

  if (plan.barrier !== null) {
    let released = false;
    try {
      // bind commit 済み row だけが exact one-shot barrier を一度 signal する。
      released = launcher.releaseSuccessorBarrier?.(plan.barrier) === true;
    } catch {
      released = false;
    }
    if (!released) {
      const rolledBack = await rollbackBoundAttempt(
        deps,
        launcher,
        bound,
        "runtime bind 後の one-shot barrier release を確認できません",
        clock,
      );
      throw new Error(
        `runtime bind 後の one-shot barrier release を確認できません: ` +
        `slot=${rolledBack.id} status=${rolledBack.status}`,
      );
    }
  }

  return { armed, bound, observation, launcher, clock };
}

function freshRuntimeIdentity(
  deps: CliDeps,
  launch: OrchestratorSuccessorLaunchRow,
  artifactHashes: SuccessorArtifactHashes,
): {
  canonicalCwd: string;
  hostId: string;
  tmuxSession: string;
  tmuxPane: string;
  panePid: number;
  processGroupId: number;
  tmuxSocketPath: string;
  tmuxServerPid: number;
  tmuxServerStartTime: number;
  tmuxServerLifetimeHash: string;
  ownerNonceHash: string;
  hookDefinitionHash: string;
  hookExecutableHash: string;
} {
  const result = deps.successorTmuxReadback.readExactPane(launch.tmuxPane);
  if (!result.ok) {
    if (result.reason !== "unavailable") {
      throw new Error(successorServerLifetimeMismatchMessage(launch.id, result.reason));
    }
    throw new Error(`successor final の exact runtime readback に失敗しました: slot=${launch.id}`);
  }
  const readback = result.value;
  let canonicalCwd = "";
  try {
    canonicalCwd = deps.canonicalizeSuccessorCwd(readback.cwd);
  } catch {
    throw new Error(`successor final の tmux cwd をcanonical化できません: slot=${launch.id}`);
  }
  const hostId = deps.currentHostId().trim();
  const identity = {
    canonicalCwd,
    hostId,
    tmuxSession: readback.tmuxSession,
    tmuxPane: readback.tmuxPane,
    panePid: readback.panePid,
    processGroupId: readback.processGroupId,
    tmuxSocketPath: readback.tmuxSocketPath,
    tmuxServerPid: readback.tmuxServerPid,
    tmuxServerStartTime: readback.tmuxServerStartTime,
    tmuxServerLifetimeHash: readback.tmuxServerLifetimeHash,
    ownerNonceHash: sha256(readback.ownerNonce),
    hookDefinitionHash: artifactHashes.hookDefinitionHash,
    hookExecutableHash: artifactHashes.hookExecutableHash,
  };
  if (launch.tmuxSocketPath !== identity.tmuxSocketPath ||
      launch.tmuxServerPid !== identity.tmuxServerPid ||
      launch.tmuxServerStartTime !== identity.tmuxServerStartTime ||
      launch.tmuxServerLifetimeHash !== identity.tmuxServerLifetimeHash) {
    throw new Error(successorServerLifetimeMismatchMessage(launch.id, "drift"));
  }
  const exact = launch.canonicalCwd === identity.canonicalCwd &&
    launch.observedCanonicalCwd === identity.canonicalCwd &&
    launch.hostId === identity.hostId && launch.observedHostId === identity.hostId &&
    launch.tmuxSession === identity.tmuxSession && launch.plannedTmuxSession === identity.tmuxSession &&
    launch.tmuxPane === identity.tmuxPane && launch.panePid === identity.panePid &&
    launch.processGroupId === identity.processGroupId && launch.ownerNonceHash === identity.ownerNonceHash &&
    launch.hookDefinitionHash === identity.hookDefinitionHash &&
    launch.observedHookDefinitionHash === identity.hookDefinitionHash &&
    launch.hookExecutableHash === identity.hookExecutableHash &&
    launch.observedHookExecutableHash === identity.hookExecutableHash;
  if (!exact) throw new Error(`successor final の exact runtime identity が一致しません: slot=${launch.id}`);
  return identity;
}

async function failClaudeHandoverLaunch(
  deps: CliDeps,
  runtime: BoundSuccessorRuntime,
  error: unknown,
  secrets: readonly string[],
): Promise<ClaudeHandoverLaunchResult> {
  const reason = redactCapabilities(
    error instanceof Error ? error.message : String(error),
    secrets,
  );
  const current = deps.store.getSuccessorLaunch(runtime.armed.id) ?? runtime.bound;
  if (current.status === "succeeded") {
    const successor = current.successorSessionId === ""
      ? null
      : deps.store.getOrchestratorSession(current.successorSessionId);
    if (successor !== null) return { ok: true, launch: current, successor };
  }
  let rolledBack = current;
  try {
    rolledBack = await rollbackBoundAttempt(
      deps,
      runtime.launcher,
      current,
      reason || "Claude successor launch に失敗しました",
      runtime.clock,
    );
  } catch {
    rolledBack = deps.store.getSuccessorLaunch(runtime.armed.id) ?? current;
  }
  const stopReason = rolledBack.status !== "uncertain"
    ? ""
    : rolledBack.stopEvidence.ownerMatched === false
      ? "exact runtime の所有権を確認できないため kill を実行していません"
      : rolledBack.stopEvidence.processGroupAbsent !== true
        ? "process group の停止を確認できませんでした"
        : rolledBack.stopEvidence.panePidAbsent !== true
          ? "pane PID の停止を確認できませんでした"
          : rolledBack.stopEvidence.tmuxSessionAbsent !== true
            ? "tmux session の停止を確認できませんでした"
            : "exact runtime の停止証拠が不完全です";
  return {
    ok: false,
    launch: rolledBack,
    reason: stopReason === "" ? reason : `${reason} — ${stopReason}`,
  };
}

/**
 * Claude handover の provider 固有 delivery gate を、共通 durable arm/bind/final 境界へ接続する。
 * provider session ID は Hachi が `claude --session-id` に固定した値だけを delivery 確認後に attest する。
 */
export async function runClaudeHandoverSuccessorLaunch(
  deps: CliDeps,
  fallbackLauncher: TmuxLauncher,
  options: ClaudeHandoverLaunchOptions,
): Promise<ClaudeHandoverLaunchResult> {
  const hostId = deps.currentHostId().trim();
  if (hostId === "") throw new Error("current host ID を確認できません");
  const secrets = [options.handoffToken, options.launchNonce, options.ownerNonce, options.barrier];
  let runtime: BoundSuccessorRuntime;
  try {
    runtime = await armSpawnBindSuccessorRuntime(deps, fallbackLauncher, {
      targetProvider: "claude",
      kind: "handoff",
      sourceSessionId: options.sourceSessionId,
      sourceGeneration: options.sourceGeneration,
      orchestratorId: options.orchestratorId,
      canonicalCwd: options.canonicalCwd,
      hostId,
      launchNonce: options.launchNonce,
      ownerNonce: options.ownerNonce,
      plannedTmuxSession: options.plannedTmuxSession,
      checkPlannedSessionAbsent: false,
      artifactHashes: CLAUDE_DELIVERY_ARTIFACT_HASHES,
      readArtifactHashes: () => CLAUDE_DELIVERY_ARTIFACT_HASHES,
      buildTmuxArgs: () => options.tmuxArgs,
      barrier: options.barrier,
      handoffToken: options.handoffToken,
      staleBefore: null,
      secrets,
    });
  } catch (error) {
    const matches = deps.store.listSuccessorLaunches(options.orchestratorId).filter((launch) =>
      launch.kind === "handoff" && launch.targetProvider === "claude" &&
      launch.sourceSessionId === options.sourceSessionId &&
      launch.sourceGeneration === options.sourceGeneration &&
      launch.plannedTmuxSession === options.plannedTmuxSession
    );
    if (matches.length === 1) {
      return {
        ok: false,
        launch: matches[0]!,
        reason: redactCapabilities(error instanceof Error ? error.message : String(error), secrets),
      };
    }
    throw error;
  }

  try {
    await options.deliveryGate();
    const attestationIdentity = freshRuntimeIdentity(
      deps,
      runtime.bound,
      CLAUDE_DELIVERY_ARTIFACT_HASHES,
    );
    const attested = deps.store.attestSuccessorLaunch({
      providerSessionId: options.providerSessionId,
      providerSessionSource: "claude-delivery",
      source: "delivery",
      ...attestationIdentity,
      now: nowSeconds(runtime.clock),
    });
    if (attested === null) throw new Error("Claude delivery attestation の exact slot CAS に失敗しました");
    const handleHash = sha256(attested.attestationHandle);
    // delivery attest 後も claim/final の直前に既存nonceをfresh readbackし、row転記をauthorityにしない。
    freshRuntimeIdentity(deps, attested.launch, CLAUDE_DELIVERY_ARTIFACT_HASHES);
    const claimed = deps.store.claimSuccessorLaunchAccept({
      slotId: attested.launch.id,
      expectedRevision: attested.launch.revision,
      attestationHandleHash: handleHash,
      operation: "handoff",
      now: nowSeconds(runtime.clock),
    });
    const successor = deps.store.acceptOrchestratorHandoffWithSuccessorLaunch({
      slotId: claimed.launch.id,
      expectedRevision: claimed.launch.revision,
      acceptFenceHash: sha256(claimed.acceptFence),
      attestationHandleHash: handleHash,
      handoffTokenHash: sha256(options.handoffToken),
      now: nowSeconds(runtime.clock),
    });
    const completed = deps.store.getSuccessorLaunch(runtime.armed.id);
    if (completed === null || completed.status !== "succeeded") {
      throw new Error("Claude successor final の succeeded readback を確認できません");
    }
    return { ok: true, launch: completed, successor };
  } catch (error) {
    return await failClaudeHandoverLaunch(deps, runtime, error, secrets);
  }
}

/** process crash 後も row 固定 target と owner-only stop fence だけで exact rollback を再開する。 */
export async function recoverSuccessorLaunch(
  deps: CliDeps,
  fallbackLauncher: TmuxLauncher,
  launch: OrchestratorSuccessorLaunchRow,
  error: string,
): Promise<OrchestratorSuccessorLaunchRow> {
  if (["succeeded", "stopped", "rejected", "expired"].includes(launch.status)) return launch;
  const launcher = deps.tmuxLauncher ?? fallbackLauncher;
  const clock = deps.successorLaunchClock ?? defaultClock;
  if (launch.status === "armed") {
    const hashes = launch.targetProvider === "claude"
      ? CLAUDE_DELIVERY_ARTIFACT_HASHES
      : deps.successorAttestationHashProbe.readInstalledHashes();
    const observation = readPostSpawnObservation(
      deps,
      launcher,
      launch.plannedTmuxSession,
      () => hashes,
    );
    const claimed = deps.store.markArmedSuccessorLaunchStopPending({
      slotId: launch.id,
      expectedRevision: launch.revision,
      error,
      ...partialEvidence(observation),
      now: nowSeconds(clock),
    });
    return await exactRollback(deps, launcher, claimed, clock);
  }
  return await rollbackBoundAttempt(deps, launcher, launch, error, clock);
}

function findSucceededRetry(
  deps: CliDeps,
  kind: OrchestratorSuccessorLaunchKind,
  sourceSessionId: string,
  sourceGeneration: number,
  canonicalCwd: string,
): OrchestratorSuccessorLaunchRow | null {
  const matches = deps.store.listSuccessorLaunches().filter((launch) =>
    launch.kind === kind && launch.targetProvider === "codex" &&
    launch.sourceSessionId === sourceSessionId && launch.sourceGeneration === sourceGeneration &&
    launch.canonicalCwd === canonicalCwd && launch.status === "succeeded"
  );
  return matches.length === 1 ? matches[0]! : null;
}

export async function runSuccessorLaunchStart(
  deps: CliDeps,
  fallbackLauncher: TmuxLauncher,
  options: SuccessorLaunchStartOptions,
): Promise<void> {
  const kind = parseKind(options.kind);
  if (!Number.isSafeInteger(options.generation) || options.generation <= 0) {
    throw new Error("--generation は1以上の整数が必須です");
  }
  if (!Number.isSafeInteger(options.staleSec) || options.staleSec <= 0) {
    throw new Error("--stale-sec は1以上の整数が必須です");
  }
  if (!isAbsolute(options.cwd)) throw new Error("--cwd は絶対パスが必須です");
  const canonicalCwd = deps.canonicalizeSuccessorCwd(options.cwd);
  if (!isAbsolute(canonicalCwd)) throw new Error("canonical cwd を確認できません");

  const source = deps.store.getOrchestratorSession(options.sourceSession);
  if (source === null || source.generation !== options.generation) {
    throw new Error("source session/generation を確認できません");
  }

  const succeededRetry = findSucceededRetry(
    deps,
    kind,
    source.id,
    source.generation,
    canonicalCwd,
  );
  if (succeededRetry !== null) {
    emitSucceeded(deps, options.json === true, succeededRetry, true);
    return;
  }

  const gate = deps.store.successorReplacementGate(source.orchestratorId);
  if (!gate.allowed) {
    throw new Error(`SUCCESSOR_REPLACEMENT_BLOCKED: blocking slot=${gate.blockingSlotId ?? "unknown"}`);
  }

  // Gate 4 publication 前の未構成 probe は、slot/外部 process を一切作る前にここで閉じる。
  const hashes = deps.successorAttestationHashProbe.readInstalledHashes();
  if (!SHA256_HEX.test(hashes.hookDefinitionHash) || !SHA256_HEX.test(hashes.hookExecutableHash)) {
    throw new Error("review 済み hook definition/helper hash を確認できません");
  }
  const hostId = deps.currentHostId().trim();
  if (hostId === "") throw new Error("current host ID を確認できません");

  const launchNonce = requireNonce(
    deps.newSuccessorLaunchNonce?.() ?? randomBytes(32).toString("base64url"),
    "successor launch nonce",
  );
  const ownerNonce = requireNonce(
    deps.newSuccessorOwnerNonce?.() ?? randomBytes(32).toString("base64url"),
    "successor owner nonce",
  );
  const barrierNonce = requireNonce(
    deps.newSuccessorBarrierNonce?.() ?? randomBytes(32).toString("base64url"),
    "successor barrier nonce",
  );
  const handoffToken = kind === "handoff"
    ? requireNonce(deps.newHandoffToken?.() ?? newNonce() + newNonce(), "handoff token")
    : "";
  const launchNonceHash = sha256(launchNonce);
  const plannedTmuxSession = `hachi-codex-${source.orchestratorId.slice(0, 10)}-${launchNonceHash.slice(0, 12)}`;
  const barrier = `hachi-successor-${sha256(barrierNonce).slice(0, 32)}`;
  const clock = deps.successorLaunchClock ?? defaultClock;
  const secrets = [launchNonce, ownerNonce, barrierNonce, barrier, handoffToken];
  const runtime = await armSpawnBindSuccessorRuntime(deps, fallbackLauncher, {
    targetProvider: "codex",
    kind,
    sourceSessionId: source.id,
    sourceGeneration: source.generation,
    orchestratorId: source.orchestratorId,
    canonicalCwd,
    hostId,
    launchNonce,
    ownerNonce,
    plannedTmuxSession,
    checkPlannedSessionAbsent: true,
    artifactHashes: hashes,
    readArtifactHashes: () => deps.successorAttestationHashProbe.readInstalledHashes(),
    buildTmuxArgs: (armed) => {
      const startupPrompt = buildStartupPrompt(
        kind,
        armed.id,
        source.id,
        source.orchestratorId,
        handoffToken,
      );
      return buildCodexSuccessorTmuxArgs(
        plannedTmuxSession,
        canonicalCwd,
        barrier,
        startupPrompt,
      );
    },
    barrier,
    handoffToken,
    staleBefore: nowSeconds(clock) - options.staleSec,
    secrets,
  });
  const armed = runtime.armed;
  const launcher = runtime.launcher;

  for (;;) {
    const current = deps.store.getSuccessorLaunch(armed.id);
    if (current === null) throw new Error("durable successor launch slot が消失しました");
    if (current.status === "succeeded") {
      emitSucceeded(deps, options.json === true, current, false);
      return;
    }
    if (current.status === "stop_pending") {
      const rolledBack = await rollbackBoundAttempt(
        deps,
        launcher,
        current,
        current.lastError || "successor final が失敗しました",
        clock,
      );
      if (rolledBack.status === "succeeded") {
        emitSucceeded(deps, options.json === true, rolledBack, true);
        return;
      }
      throw new Error(
        `${current.lastError || "successor final が失敗しました"}: ` +
        `slot=${rolledBack.id} status=${rolledBack.status}`,
      );
    }
    if (current.status === "uncertain" || current.status === "stopped" ||
        current.status === "rejected" || current.status === "expired") {
      throw new Error(`successor launch は terminal/rollback 状態です: slot=${current.id} status=${current.status}`);
    }
    if (nowSeconds(clock) > current.attestationDeadlineAt) {
      const rolledBack = await rollbackBoundAttempt(
        deps,
        launcher,
        current,
        "Codex SessionStart attestation/final が slot の attestation deadline までに succeeded しませんでした",
        clock,
      );
      if (rolledBack.status === "succeeded") {
        emitSucceeded(deps, options.json === true, rolledBack, true);
        return;
      }
      throw new Error(
        `Codex SessionStart attestation/final が slot の attestation deadline までに succeeded しませんでした: ` +
        `slot=${rolledBack.id} status=${rolledBack.status}`,
      );
    }
    await clock.sleep(SUCCESSOR_POLL_INTERVAL_MS);
  }
}

export function runSuccessorLaunchRollbackComplete(
  deps: CliDeps,
  fallbackLauncher: TmuxLauncher,
  options: SuccessorLaunchRollbackOptions,
): void {
  if (options.fence === "" || options.fence.includes("\0")) {
    throw new Error("--fence は非空 capability が必須です");
  }
  const launch = deps.store.getSuccessorLaunch(options.slot);
  if (launch === null) throw new Error(`successor launch slot が見つかりません: ${options.slot}`);
  const launcher = deps.tmuxLauncher ?? fallbackLauncher;
  const stopPoints = observeStopPoints(launcher, launch);

  // exact target が再出現している場合は owner を readback するが、kill は絶対に行わない。
  if (launch.tmuxSession !== "" && stopPoints.tmuxSessionAbsent !== true) {
    try {
      launcher.getSessionOwnerNonce(launch.tmuxSession);
    } catch {
      // readback unknown は incomplete evidence のまま Core CAS へ渡す。
    }
  }
  const clock = deps.successorLaunchClock ?? defaultClock;
  const evidence: OrchestratorSuccessorStopEvidence = {
    ownerMatched: launch.stopEvidence.ownerMatched,
    ownerReadbackAt: launch.stopEvidence.ownerReadbackAt,
    killResult: launch.stopEvidence.killResult,
    ...stopPoints,
    observedAt: nowSeconds(clock),
  };
  const result = deps.store.rollbackCompleteSuccessorLaunch({
    slotId: launch.id,
    expectedRevision: launch.revision,
    stopFenceHash: sha256(options.fence),
    evidence,
    apply: options.apply === true,
    now: nowSeconds(clock),
  });
  emit(
    deps,
    options.json === true,
    {
      slotId: result.launch.id,
      status: result.launch.status,
      applicable: result.applicable,
      applied: result.applied,
      reason: result.reason,
    },
    [
      `rollback-complete: slot=${result.launch.id} status=${result.launch.status}`,
      `applicable=${result.applicable} applied=${result.applied} reason=${result.reason}`,
    ],
  );
}

export function runSuccessorLaunchFencedClose(
  deps: CliDeps,
  fallbackLauncher: TmuxLauncher,
  options: SuccessorLaunchFencedCloseOptions,
): void {
  if (options.orchestrator.trim() === "" || options.session.trim() === "") {
    throw new Error("--orchestrator/--session は非空が必須です");
  }
  const launch = deps.store.getSuccessorLaunch(options.slot);
  if (launch === null) throw new Error(`successor launch slot が見つかりません: ${options.slot}`);
  const launcher = deps.tmuxLauncher ?? fallbackLauncher;
  const freshObservation = observeStopPoints(launcher, launch);
  const clock = deps.successorLaunchClock ?? defaultClock;
  const observedAt = nowSeconds(clock);
  const result = deps.store.closeUncertainSuccessorLaunchWithOrchestrator({
    slotId: launch.id,
    expectedRevision: launch.revision,
    provenance: {
      kind: "orchestrator",
      actorId: options.orchestrator,
      actorSessionId: options.session,
      actorGeneration: options.generation,
    },
    freshObservation: { ...freshObservation, observedAt },
    confirm: options.confirm === true,
    now: observedAt,
  });
  emit(
    deps,
    options.json === true,
    {
      slotId: result.launch.id,
      status: result.launch.status,
      applicable: result.applicable,
      applied: result.applied,
      conditions: result.conditions,
      freshObservation,
    },
    [
      `close-uncertain: slot=${result.launch.id} status=${result.launch.status}`,
      `applicable=${result.applicable} applied=${result.applied}`,
      ...Object.entries(result.conditions).map(([condition, met]) => `${condition}=${met}`),
    ],
  );
}
