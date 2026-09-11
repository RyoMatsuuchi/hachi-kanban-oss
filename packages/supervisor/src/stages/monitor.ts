// 進行中セッションの状態把握ステージ（docs/contract.md §10）
import { execFile, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import {
  findClaudeSessionDir,
  findCodexRollout,
  isProcessAlive,
  isProcessGroupAlive,
  parseCodexSessionId,
  readDirectOutHead,
  readDirectSessionState,
  resolveClaudeProjectsRoot,
  resolveCodexSessionsRoot,
} from "@hachi/adapters";
import type {
  DirectSessionState,
  WorkerApiErrorObservationEntry,
  WorkerApiErrorObservationInvalidReason,
  WorkerApiErrorObservationParseResult,
} from "@hachi/adapters";
import { redactText } from "@hachi/core";
import type {
  HachiConfig,
  KanbanStore,
  Logger,
  Provider,
  RunRow,
  SessionRef,
  Stage,
  StageDeps,
  StageResult,
  Transport,
} from "@hachi/core";
import { SUPERVISOR_ACTOR } from "../constants.js";
import {
  extractEventSessionId,
  extractSessionEndSnapshot,
  extractSessionEndedResultWatermark,
  pickAdapter,
  reconstructSessionRef,
  sessionStatusLastResultId,
  sessionStatusLastEntryId,
  sessionStatusResultWatermark,
} from "../session-ref.js";
import { applySteerObservations } from "../steer-observation.js";
import { sendOperationalNotification, type CreateNotifyStageOptions } from "./notify.js";
import { ensureSupervisorCancelRequest } from "./cancel.js";

/** 1 run の最大実行秒数の既定値（config の resourceGuard.maxRunSeconds 省略時。契約 §34.3） */
const DEFAULT_MAX_RUN_SECONDS = 7200;
const DIRECT_MONITOR_STATE_FILE = "monitor-direct.json";
const BRIDGE_END_QUIESCENCE_SECONDS = 60;
const CWD_LINE_REGEX = /^cwd:\s*(\S+)\s*$/m;
const GIT_EVIDENCE_TIMEOUT_MS = 5_000;
const GIT_EVIDENCE_MAX_BUFFER_BYTES = 256 * 1024;
const MAX_GIT_EVIDENCE_PATHS = 20;

/** direct stall 判定の 2 軸の閾値（契約 §50.2） */
interface DirectStallLimits {
  /** `.out` の無成長がこの秒数続き、かつプロセスツリーが不在なら死亡と判定する */
  outputStallSeconds: number;
  /** プロセスが生存していてもこの秒数を超えた run は stall 扱いにする */
  maxRuntimeSeconds: number;
}

/**
 * provider 別の direct stall 既定値。
 * codex direct は逐次 stdout へ書くため無成長 15 分で異常とみなせるが、`claude -p` は完了まで
 * stdout へ何も書かないため、無成長だけを根拠にすると正常稼働中の run を誤って停止してしまう。
 * claude 側は閾値を広く取り、実際の死亡判定はプロセスツリーの生存と組み合わせて行う。
 */
const DEFAULT_DIRECT_STALL_LIMITS: Record<Provider, DirectStallLimits> = {
  // codex 側は既存の resourceGuard.maxRunSeconds（既定7200秒）と揃え、現行の打ち切り時間を変えない。
  codex: { outputStallSeconds: 15 * 60, maxRuntimeSeconds: 120 * 60 },
  claude: { outputStallSeconds: 45 * 60, maxRuntimeSeconds: 180 * 60 },
};

/** run_stalled の理由。「無出力で死んだ」と「生きているが長すぎる」を区別する（契約 §50.2） */
type DirectStallReason = "output-stall" | "max-runtime";

interface DirectMonitorEntry {
  size: number;
  lastGrowthAt: number;
  /** `.out` 未観測の native-log-only entry だけ false。欠落は旧形式との互換で true。 */
  outputObserved?: boolean;
  /** 出力無成長 stall を宣言済みか */
  stalled: boolean;
  /** 上限時間超過 stall を宣言済みか（旧 state ファイルには存在しないため optional） */
  maxRuntimeStalled?: boolean;
  /** provider native log の exact path と成長時計。 */
  nativeLogPath?: string;
  nativeLogSize?: number;
  nativeLogLastGrowthAt?: number;
  /** 生存中 stall の警告を宣言済みか。run_stalled とは別 taxonomy で同一 run に共存できる。 */
  stallSuspected?: boolean;
}

interface DirectMonitorState {
  runs: Record<string, DirectMonitorEntry>;
}

interface DirectOutputStat {
  path: string;
  size: number;
}

export interface DirectStallWorktreeEvidence {
  statusHash: string | null;
  changedPaths: string[];
  changedPathsTruncated: boolean;
  ownershipMatches: boolean | null;
  unavailableReason?: string;
}

type DirectNativeLogPathResolver = (
  provider: Provider,
  session: DirectSessionState,
  output: DirectOutputStat | null,
) => Promise<string | null>;

type DirectStallWorktreeEvidenceCapture = (
  run: RunRow,
  worktree: string,
) => Promise<DirectStallWorktreeEvidence>;

function directMonitorStatePath(deps: StageDeps): string {
  return join(deps.env.home, "state", DIRECT_MONITOR_STATE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readDirectMonitorState(deps: StageDeps): DirectMonitorState {
  const path = directMonitorStatePath(deps);
  if (!existsSync(path)) {
    return { runs: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed["runs"])) {
      return { runs: {} };
    }
    const runs: Record<string, DirectMonitorEntry> = {};
    for (const [sessionId, value] of Object.entries(parsed["runs"])) {
      if (!isRecord(value)) {
        continue;
      }
      const size = value["size"];
      const lastGrowthAt = value["lastGrowthAt"];
      const stalled = value["stalled"];
      if (typeof size === "number" && typeof lastGrowthAt === "number" && typeof stalled === "boolean") {
        // 後から追加したフィールドはすべて optional。旧 state ファイル（3 フィールドのみ）を
        // そのまま読む。native log の3項目は1つでも不正ならまとめて落とし、それ以外は個別に扱う。
        const nativeLogPath = value["nativeLogPath"];
        const nativeLogSize = value["nativeLogSize"];
        const nativeLogLastGrowthAt = value["nativeLogLastGrowthAt"];
        const nativeLogState =
          typeof nativeLogPath === "string" &&
          isAbsolute(nativeLogPath) &&
          typeof nativeLogSize === "number" &&
          nativeLogSize >= 0 &&
          typeof nativeLogLastGrowthAt === "number"
            ? { nativeLogPath, nativeLogSize, nativeLogLastGrowthAt }
            : {};
        const entry: DirectMonitorEntry = {
          size,
          lastGrowthAt,
          stalled,
          ...(value["outputObserved"] === false ? { outputObserved: false } : {}),
          ...(value["maxRuntimeStalled"] === true ? { maxRuntimeStalled: true } : {}),
          ...nativeLogState,
          ...(value["stallSuspected"] === true ? { stallSuspected: true } : {}),
        };
        runs[sessionId] = entry;
      }
    }
    return { runs };
  } catch {
    return { runs: {} };
  }
}

function writeDirectMonitorState(deps: StageDeps, state: DirectMonitorState): void {
  const stateDir = join(deps.env.home, "state");
  mkdirSync(stateDir, { recursive: true });
  const path = directMonitorStatePath(deps);
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmpPath, path);
}

function parseRunMetaRecord(run: RunRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(run.meta) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isDirectRun(run: RunRow): boolean {
  return parseRunMetaRecord(run)["transport"] === "direct";
}

/** direct adapter が session state / 実行中出力を置くディレクトリ */
function directSessionsDir(deps: StageDeps): string {
  return join(deps.env.home, "state", "direct-sessions");
}

/** provider 別既定に config の direct.stall 上書きを重ねて閾値を決める（契約 §50.2） */
function resolveDirectStallLimits(config: HachiConfig, provider: Provider): DirectStallLimits {
  const defaults = DEFAULT_DIRECT_STALL_LIMITS[provider];
  const override = config.direct?.stall?.[provider];
  return {
    outputStallSeconds: override?.outputStallSeconds ?? defaults.outputStallSeconds,
    maxRuntimeSeconds: override?.maxRuntimeSeconds ?? defaults.maxRuntimeSeconds,
  };
}

function statDirectOutput(deps: StageDeps, sessionId: string): DirectOutputStat | null {
  const path = join(directSessionsDir(deps), `${sessionId}.out`);
  return statProgressFile(path);
}

function statProgressFile(path: string): DirectOutputStat | null {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      return null;
    }
    return { path, size: stats.size };
  } catch {
    return null;
  }
}

async function resolveDirectNativeLogPath(
  provider: Provider,
  session: DirectSessionState,
  output: DirectOutputStat | null,
): Promise<string | null> {
  if (session.nativeLogsDisabled === true) {
    return null;
  }
  if (provider === "claude") {
    if (session.nativeSessionId === undefined) {
      return null;
    }
    const dir = await findClaudeSessionDir(resolveClaudeProjectsRoot(), session.nativeSessionId);
    return dir === null ? null : join(dir, `${session.nativeSessionId}.jsonl`);
  }
  const nativeSessionId = session.nativeSessionId
    ?? (output === null ? null : parseCodexSessionId(readDirectOutHead(output.path)));
  return nativeSessionId === null || nativeSessionId === undefined
    ? null
    : findCodexRollout(resolveCodexSessionsRoot(), nativeSessionId);
}

interface GitCommandResult {
  ok: boolean;
  stdout: string;
  reason?: string;
}

function runGitEvidenceCommand(cwd: string, args: readonly string[]): Promise<GitCommandResult> {
  return new Promise<GitCommandResult>((resolveResult) => {
    execFile(
      "git",
      ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
      {
        encoding: "utf8",
        timeout: GIT_EVIDENCE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: GIT_EVIDENCE_MAX_BUFFER_BYTES,
        shell: false,
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: string): void => {
        if (error === null) {
          resolveResult({ ok: true, stdout });
          return;
        }
        const code = typeof error.code === "string" ? error.code : "";
        resolveResult({
          ok: false,
          stdout: "",
          reason:
            error.killed || code === "ETIMEDOUT"
              ? "timeout"
              : code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                ? "output-limit"
                : "probe-failed",
        });
      },
    );
  });
}

function canonicalPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function parseGitStatusPaths(stdout: string): { paths: string[]; truncated: boolean } | null {
  const records = stdout.split("\0").filter((record) => record !== "");
  const paths: string[] = [];
  for (const record of records) {
    if (record.length < 4 || record[2] !== " ") {
      return null;
    }
    const withoutControls = record.slice(3).replace(/[\u0000-\u001f\u007f]/g, "");
    const normalized = posix.normalize(withoutControls.replaceAll("\\", "/"));
    if (
      normalized === "" ||
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      posix.isAbsolute(normalized)
    ) {
      return null;
    }
    if (paths.length < MAX_GIT_EVIDENCE_PATHS) {
      paths.push(redactText(normalized).slice(0, 240));
    }
  }
  return { paths, truncated: records.length > paths.length };
}

function launchGitOwnership(run: RunRow): { canonicalWorktree: string; repoCommonDir: string } | null {
  const snapshot = parseRunMetaRecord(run)["handoffGitLaunchSnapshot"];
  if (!isRecord(snapshot) || snapshot["state"] !== "available") {
    return null;
  }
  const canonicalWorktree = snapshot["canonicalWorktree"];
  const repoCommonDir = snapshot["repoCommonDir"];
  if (
    typeof canonicalWorktree !== "string" ||
    typeof repoCommonDir !== "string" ||
    !isAbsolute(canonicalWorktree) ||
    !isAbsolute(repoCommonDir)
  ) {
    return null;
  }
  return { canonicalWorktree, repoCommonDir };
}

/** worktree の内容は読まず、git status fingerprint・変更 path・launch ownership 一致だけを採る。 */
async function captureDirectStallWorktreeEvidence(
  run: RunRow,
  worktree: string,
): Promise<DirectStallWorktreeEvidence> {
  const identity = await runGitEvidenceCommand(worktree, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
  ]);
  if (!identity.ok) {
    return {
      statusHash: null,
      changedPaths: [],
      changedPathsTruncated: false,
      ownershipMatches: null,
      unavailableReason: identity.reason ?? "probe-failed",
    };
  }
  const identityLines = identity.stdout.trim().split(/\r?\n/);
  const canonicalWorktree = identityLines[0] === undefined ? null : canonicalPath(identityLines[0]);
  const repoCommonDir = identityLines[1] === undefined ? null : canonicalPath(identityLines[1]);
  if (identityLines.length !== 2 || canonicalWorktree === null || repoCommonDir === null) {
    return {
      statusHash: null,
      changedPaths: [],
      changedPathsTruncated: false,
      ownershipMatches: null,
      unavailableReason: "invalid-output",
    };
  }

  const launch = launchGitOwnership(run);
  const ownershipMatches = launch === null
    ? null
    : launch.canonicalWorktree === canonicalWorktree && launch.repoCommonDir === repoCommonDir;
  const status = await runGitEvidenceCommand(canonicalWorktree, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ]);
  if (!status.ok) {
    return {
      statusHash: null,
      changedPaths: [],
      changedPathsTruncated: false,
      ownershipMatches,
      unavailableReason: status.reason ?? "probe-failed",
    };
  }
  const parsed = parseGitStatusPaths(status.stdout);
  if (parsed === null) {
    return {
      statusHash: null,
      changedPaths: [],
      changedPathsTruncated: false,
      ownershipMatches,
      unavailableReason: "invalid-output",
    };
  }
  return {
    statusHash: createHash("sha256").update(status.stdout).digest("hex"),
    changedPaths: parsed.paths,
    changedPathsTruncated: parsed.truncated,
    ownershipMatches,
  };
}

function hasRunStalledEvent(store: KanbanStore, taskId: string, sessionId: string): boolean {
  return store.listEvents(taskId, "run_stalled").some((event) => extractEventSessionId(event.payload) === sessionId);
}

function hasRunStallSuspectedEvent(store: KanbanStore, taskId: string, sessionId: string): boolean {
  return store
    .listEvents(taskId, "run_stall_suspected")
    .some((event) => extractEventSessionId(event.payload) === sessionId);
}

function hasDirectSessionStateUnreadableEvent(store: KanbanStore, taskId: string, sessionId: string): boolean {
  return store
    .listEvents(taskId, "direct-session-state-unreadable")
    .some((event) => extractEventSessionId(event.payload) === sessionId);
}

async function notifyDirectStall(
  deps: StageDeps,
  run: RunRow,
  reason: DirectStallReason,
  detail: string[],
): Promise<void> {
  await sendOperationalNotification(deps, {
    id: `run-stalled:${run.sessionId}`,
    title: "direct run stalled",
    body: [`direct run stalled (${reason}): task=${run.taskId}`, `sessionId=${run.sessionId}`, ...detail].join("\n"),
  });
}

async function notifyDirectStallSuspected(
  deps: StageDeps,
  run: RunRow,
  stalledSeconds: number,
): Promise<void> {
  await sendOperationalNotification(deps, {
    id: `run-stall-suspected:${run.sessionId}`,
    title: "direct run stall suspected",
    body: [
      `direct run stall suspected: task=${run.taskId}`,
      `sessionId=${run.sessionId}`,
      `provider=${run.provider}`,
      `stalledSeconds=${stalledSeconds}`,
      "warningOnly=true",
    ].join("\n"),
  });
}

async function notifyDirectSessionStateUnreadable(deps: StageDeps, run: RunRow): Promise<void> {
  await sendOperationalNotification(deps, {
    id: `direct-session-state-unreadable:${run.sessionId}`,
    title: "direct session state unreadable",
    body: [
      `direct session state unreadable: task=${run.taskId}`,
      `sessionId=${run.sessionId}`,
      `provider=${run.provider}`,
      "providerSpecificChecksSkipped=true",
    ].join("\n"),
  });
}

/** run_stalled の event・cancel・orchestrator request を同一 transaction に固定する。 */
function recordDirectRunStalled(
  deps: StageDeps,
  run: RunRow,
  reason: DirectStallReason,
  eventPayload: Record<string, unknown>,
  cancelReasonKey: string,
  cancelReason: string,
  now: number,
): void {
  const task = deps.store.getTask(run.taskId);
  if (task === null) {
    throw new Error(`run_stalled 対象 task が見つかりません: ${run.taskId}`);
  }
  const worktree = task.body.match(CWD_LINE_REGEX)?.[1] ?? "";
  deps.store.transaction((): void => {
    deps.store.addEvent(run.taskId, "run_stalled", SUPERVISOR_ACTOR, eventPayload);
    ensureSupervisorCancelRequest(deps.store, run, cancelReasonKey, cancelReason, now);
    deps.store.createOrGetOrchestratorRequest({
      taskId: run.taskId,
      questionId: `run-stalled:${run.id}:${run.sessionId}`,
      question: `direct run stalled (${reason}): 停止状況と replacement gate を確認してください。`,
      context: `runId=${run.id} sessionId=${run.sessionId} provider=${run.provider} reason=${reason}`,
      worktree,
      project: task.tenant,
    });
  });
}

/** 生存中 stall の event と durable request を同一 transaction に固定する。cancel は作らない。 */
function recordDirectRunStallSuspected(
  deps: StageDeps,
  run: RunRow,
  eventPayload: Record<string, unknown>,
): void {
  const task = deps.store.getTask(run.taskId);
  if (task === null) {
    throw new Error(`run_stall_suspected 対象 task が見つかりません: ${run.taskId}`);
  }
  const worktree = task.body.match(CWD_LINE_REGEX)?.[1] ?? "";
  deps.store.transaction((): void => {
    deps.store.addEvent(run.taskId, "run_stall_suspected", SUPERVISOR_ACTOR, eventPayload);
    deps.store.createOrGetOrchestratorRequest({
      taskId: run.taskId,
      questionId: `run-stall-suspected:${run.id}:${run.sessionId}`,
      question: "direct run の生存中 stall が疑われます。exact-session の状態を確認してください。",
      context: JSON.stringify(eventPayload),
      worktree,
      project: task.tenant,
    });
  });
}

function directMonitorEntry(
  previous: DirectMonitorEntry | undefined,
  output: DirectOutputStat | null,
  now: number,
): DirectMonitorEntry {
  if (previous !== undefined) {
    return previous;
  }
  return output === null
    ? { size: 0, lastGrowthAt: now, outputObserved: false, stalled: false }
    : { size: output.size, lastGrowthAt: now, stalled: false };
}

/**
 * 上限時間超過を記録した entry を作る。出力が一度も観測できていない run でも「宣言済み」を
 * 永続化できるよう、欠けている値は現在値で埋める。
 */
function markMaxRuntimeStalled(
  previous: DirectMonitorEntry | undefined,
  output: DirectOutputStat | null,
  now: number,
): DirectMonitorEntry {
  return {
    ...previous,
    size: previous?.size ?? output?.size ?? 0,
    lastGrowthAt: previous?.lastGrowthAt ?? now,
    stalled: previous?.stalled ?? false,
    ...(previous === undefined && output === null ? { outputObserved: false } : {}),
    maxRuntimeStalled: true,
  };
}

/**
 * direct run を confirmed crash / suspected live stall / max runtime の3経路で判定する。
 *
 * - confirmed crash: state が読め、`.out` 無成長かつ process tree 不在。run_stalled → cancel。
 * - suspected live stall: process tree 生存中の provider 別 progress 無成長。警告とrequestのみ。
 * - max runtime: state.startedAt から provider 別上限超過。従来どおり run_stalled → cancel。
 *
 * state が読めない場合は destructive な provider 別判定をすべて skip し、読取不能警告だけを一度出す。
 * 共有 resource guard はこの関数の外で維持される。
 */
async function monitorDirectStalls(
  deps: StageDeps,
  apply: boolean,
  now: number,
  notes: string[],
  isDirectSessionAlive: (state: DirectSessionState) => boolean,
  nativeLogPathResolver: DirectNativeLogPathResolver,
  worktreeEvidenceCapture: DirectStallWorktreeEvidenceCapture,
): Promise<number> {
  const state = readDirectMonitorState(deps);
  const sessionsDir = directSessionsDir(deps);
  let changed = false;
  let actions = 0;

  for (const run of deps.store.listOpenRuns()) {
    if (!isDirectRun(run)) {
      continue;
    }

    const session = readDirectSessionState(sessionsDir, run.sessionId);
    const output = statDirectOutput(deps, run.sessionId);
    const previous = state.runs[run.sessionId];

    if (session === null) {
      if (hasDirectSessionStateUnreadableEvent(deps.store, run.taskId, run.sessionId)) {
        continue;
      }
      actions += 1;
      notes.push(`${run.taskId}: direct session state を読めないため provider 別 stall 判定を省略しました`);
      if (apply) {
        deps.store.addEvent(run.taskId, "direct-session-state-unreadable", SUPERVISOR_ACTOR, {
          sessionId: run.sessionId,
          provider: run.provider,
          statePath: join(sessionsDir, `${run.sessionId}.json`),
          providerSpecificChecksSkipped: true,
        });
        await notifyDirectSessionStateUnreadable(deps, run);
      }
      continue;
    }

    const limits = resolveDirectStallLimits(deps.config, run.provider);

    // ---- 軸2: 上限時間超過 ----
    // 出力の有無・成長に依存しない。出力が全く生まれない run こそ上限で打ち切る必要があるため、
    // `.out` の fail-open スキップより前に判定する。
    if (session !== null && now - session.startedAt >= limits.maxRuntimeSeconds) {
      if (previous?.maxRuntimeStalled === true) {
        continue;
      }
      if (hasRunStalledEvent(deps.store, run.taskId, run.sessionId)) {
        state.runs[run.sessionId] = markMaxRuntimeStalled(previous, output, now);
        changed = true;
        continue;
      }

      const elapsedSeconds = now - session.startedAt;
      actions += 1;
      notes.push(
        `${run.taskId}: direct run の上限時間超過を検知しました ` +
          `(sessionId=${run.sessionId}, ${elapsedSeconds}s > ${limits.maxRuntimeSeconds}s)`,
      );
      if (apply) {
        recordDirectRunStalled(
          deps,
          run,
          "max-runtime",
          {
            sessionId: run.sessionId,
            reason: "max-runtime",
            startedAt: session.startedAt,
            elapsedSeconds,
            maxRuntimeSeconds: limits.maxRuntimeSeconds,
            ...(output === null ? {} : { outputPath: output.path, size: output.size }),
          },
          "direct-max-runtime",
          `direct max runtime exceeded (${elapsedSeconds}s > ${limits.maxRuntimeSeconds}s)`,
          now,
        );
        state.runs[run.sessionId] = markMaxRuntimeStalled(previous, output, now);
        changed = true;
        await notifyDirectStall(deps, run, "max-runtime", [
          `elapsed=${elapsedSeconds}s`,
          `maxRuntimeSeconds=${limits.maxRuntimeSeconds}`,
        ]);
      }
      continue;
    }

    let current = previous;
    if (
      output !== null &&
      (current === undefined || current.outputObserved === false || output.size !== current.size)
    ) {
      current = { ...directMonitorEntry(current, output, now), size: output.size, lastGrowthAt: now, stalled: false };
      delete current.outputObserved;
      state.runs[run.sessionId] = current;
      changed = true;
    }

    const alive = isDirectSessionAlive(session);

    // ---- confirmed crash: `.out` 無成長 かつ process tree 不在 ----
    if (!alive) {
      if (
        output === null ||
        current === undefined ||
        current.outputObserved === false ||
        current.stalled ||
        now - current.lastGrowthAt < limits.outputStallSeconds
      ) {
        continue;
      }

      if (hasRunStalledEvent(deps.store, run.taskId, run.sessionId)) {
        state.runs[run.sessionId] = { ...current, stalled: true };
        changed = true;
        continue;
      }

      const stalledSeconds = now - current.lastGrowthAt;
      actions += 1;
      notes.push(`${run.taskId}: direct output stall を検知しました (sessionId=${run.sessionId})`);
      if (apply) {
        recordDirectRunStalled(
          deps,
          run,
          "output-stall",
          {
            sessionId: run.sessionId,
            reason: "output-stall",
            outputPath: output.path,
            size: output.size,
            stalledSeconds,
            processTreeAlive: false,
          },
          "direct-output-stall",
          `direct output stall (${stalledSeconds}s)`,
          now,
        );
        state.runs[run.sessionId] = { ...current, stalled: true };
        changed = true;
        await notifyDirectStall(deps, run, "output-stall", [
          `output=${output.path}`,
          `size=${output.size}`,
          `stalledSeconds=${stalledSeconds}`,
        ]);
      }
      continue;
    }

    // ---- suspected live stall: provider 別 progress 無成長、警告専用 ----
    let nativeLog = current?.nativeLogPath === undefined ? null : statProgressFile(current.nativeLogPath);
    if (nativeLog === null) {
      const resolvedPath = await nativeLogPathResolver(run.provider, session, output);
      nativeLog = resolvedPath === null ? null : statProgressFile(resolvedPath);
    }
    if (
      nativeLog !== null &&
      (current?.nativeLogPath !== nativeLog.path || current.nativeLogSize !== nativeLog.size)
    ) {
      current = {
        ...directMonitorEntry(current, output, now),
        nativeLogPath: nativeLog.path,
        nativeLogSize: nativeLog.size,
        nativeLogLastGrowthAt: now,
      };
      state.runs[run.sessionId] = current;
      changed = true;
    }

    const progressTimes: number[] = [];
    const progressSources: string[] = [];
    if (
      run.provider === "codex" &&
      output !== null &&
      current !== undefined &&
      current.outputObserved !== false
    ) {
      progressTimes.push(current.lastGrowthAt);
      progressSources.push("direct-output");
    }
    if (nativeLog !== null && current?.nativeLogLastGrowthAt !== undefined) {
      progressTimes.push(current.nativeLogLastGrowthAt);
      progressSources.push("native-log");
    }
    if (progressTimes.length === 0 || current === undefined || current.stallSuspected === true) {
      continue;
    }
    const lastProgressAt = Math.max(...progressTimes);
    if (now - lastProgressAt < limits.outputStallSeconds) {
      continue;
    }
    if (hasRunStallSuspectedEvent(deps.store, run.taskId, run.sessionId)) {
      state.runs[run.sessionId] = { ...current, stallSuspected: true };
      changed = true;
      continue;
    }

    const stalledSeconds = now - lastProgressAt;
    actions += 1;
    notes.push(`${run.taskId}: direct run の生存中 stall を警告します (sessionId=${run.sessionId})`);
    if (apply) {
      const task = deps.store.getTask(run.taskId);
      const worktree = task?.body.match(CWD_LINE_REGEX)?.[1] ?? "";
      let worktreeEvidence: DirectStallWorktreeEvidence | undefined;
      if (worktree !== "") {
        try {
          worktreeEvidence = await worktreeEvidenceCapture(run, worktree);
        } catch {
          worktreeEvidence = {
            statusHash: null,
            changedPaths: [],
            changedPathsTruncated: false,
            ownershipMatches: null,
            unavailableReason: "probe-failed",
          };
        }
      }
      const eventPayload = {
        sessionId: run.sessionId,
        reason: "live-progress-stall",
        provider: run.provider,
        processTreeAlive: true,
        warningOnly: true,
        progressSources,
        lastProgressAt,
        stalledSeconds,
        thresholdSeconds: limits.outputStallSeconds,
        ...(run.provider === "codex" && output !== null
          ? { outputPath: output.path, outputSize: output.size, outputLastGrowthAt: current.lastGrowthAt }
          : {}),
        ...(nativeLog === null
          ? {}
          : {
              nativeLogPath: nativeLog.path,
              nativeLogSize: nativeLog.size,
              nativeLogLastGrowthAt: current.nativeLogLastGrowthAt,
            }),
        ...(worktreeEvidence === undefined ? {} : { worktreeEvidence }),
      };
      recordDirectRunStallSuspected(deps, run, eventPayload);
      state.runs[run.sessionId] = { ...current, stallSuspected: true };
      changed = true;
      await notifyDirectStallSuspected(deps, run, stalledSeconds);
    }
  }

  if (apply && changed) {
    try {
      writeDirectMonitorState(deps, state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.warn("monitor: direct stall state の保存に失敗しました", { error: redactText(message) });
    }
  }

  return actions;
}

/** stale_max_runtime_skip イベントを Tx 外で記録し warn ログを出す */
function recordStaleMaxRuntimeSkip(store: KanbanStore, logger: Logger, taskId: string, sessionId: string): void {
  store.addEvent(taskId, "stale_max_runtime_skip", SUPERVISOR_ACTOR, { taskId, sessionId });
  logger.warn("monitor: タスクが再起動されたため max-runtime 回収の適用を中断しました", { taskId, sessionId });
}

interface WorkerApiErrorGap {
  fromSequence: number;
  toSequence: number;
  count: number;
}

interface WorkerApiErrorValidBundle {
  kind: "valid";
  taskId: string;
  sessionId: string;
  provider: Provider;
  transport: Transport;
  streamId: string;
  watermark: number;
  observedAt: number;
  errors: readonly WorkerApiErrorObservationEntry[];
  gap: WorkerApiErrorGap | null;
}

interface WorkerApiErrorInvalidBundle {
  kind: "invalid";
  taskId: string;
  sessionId: string;
  provider: Provider;
  transport: Transport;
  resultWatermark: number;
  lastEntryId: number;
  reason: WorkerApiErrorObservationInvalidReason;
  observedAt: number;
}

type WorkerApiErrorBundle = WorkerApiErrorValidBundle | WorkerApiErrorInvalidBundle;

interface WorkerApiErrorDurableState {
  seenSequences: Set<number>;
  coveredThrough: number;
}

const WORKER_API_ERROR_INVALID_REASONS = new Set<WorkerApiErrorObservationInvalidReason>([
  "schema-version",
  "stream-id",
  "watermark",
  "recent-shape",
  "sequence",
  "category",
  "consistency",
]);

function parseEventPayload(payload: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(payload) as unknown;
    return isRecord(value) && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function safePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function workerApiErrorTransport(ref: SessionRef): Transport {
  return ref.serverUrl === "direct" ? "direct" : "bridge";
}

/** adapter-local extension を frozen core SessionStatus から局所的に取り出す。 */
function workerApiErrorObservation(status: unknown): WorkerApiErrorObservationParseResult | null {
  if (!isRecord(status)) {
    return null;
  }
  const candidate = status["apiErrorObservation"];
  if (!isRecord(candidate)) {
    return null;
  }
  if (candidate["kind"] === "absent") {
    return { kind: "absent" };
  }
  if (
    candidate["kind"] === "malformed" &&
    WORKER_API_ERROR_INVALID_REASONS.has(candidate["reason"] as WorkerApiErrorObservationInvalidReason)
  ) {
    return {
      kind: "malformed",
      reason: candidate["reason"] as WorkerApiErrorObservationInvalidReason,
    };
  }
  if (candidate["kind"] === "valid" && isRecord(candidate["value"])) {
    // value の厳密検証は adapter の責務。consumer は検証済み projection だけを受け取る。
    return candidate as unknown as WorkerApiErrorObservationParseResult;
  }
  return null;
}

function readWorkerApiErrorDurableState(
  store: KanbanStore,
  taskId: string,
  sessionId: string,
  streamId: string,
): WorkerApiErrorDurableState {
  const seenSequences = new Set<number>();
  let coveredThrough = 0;

  for (const event of store.listEvents(taskId, "worker_api_error")) {
    const payload = parseEventPayload(event.payload);
    if (payload?.["sessionId"] !== sessionId || payload["streamId"] !== streamId) {
      continue;
    }
    const sequence = safePositiveInteger(payload["sequence"]);
    if (sequence === null) {
      continue;
    }
    seenSequences.add(sequence);
    coveredThrough = Math.max(coveredThrough, sequence);
  }

  for (const event of store.listEvents(taskId, "worker_api_error_gap")) {
    const payload = parseEventPayload(event.payload);
    if (payload?.["sessionId"] !== sessionId || payload["streamId"] !== streamId) {
      continue;
    }
    const toSequence = safePositiveInteger(payload["toSequence"]);
    if (toSequence !== null) {
      coveredThrough = Math.max(coveredThrough, toSequence);
    }
  }

  return { seenSequences, coveredThrough };
}

function hasWorkerApiErrorInvalidEvent(
  store: KanbanStore,
  taskId: string,
  sessionId: string,
  resultWatermark: number,
  lastEntryId: number,
  reason: WorkerApiErrorObservationInvalidReason,
): boolean {
  return store.listEvents(taskId, "worker_api_error_observation_invalid").some((event) => {
    const payload = parseEventPayload(event.payload);
    return payload?.["sessionId"] === sessionId &&
      payload["resultWatermark"] === resultWatermark &&
      payload["lastEntryId"] === lastEntryId &&
      payload["reason"] === reason;
  });
}

function workerApiErrorBundleFields(bundle: WorkerApiErrorBundle): Record<string, unknown> {
  const common = {
    taskId: bundle.taskId,
    sessionId: bundle.sessionId,
    provider: bundle.provider,
    transport: bundle.transport,
    observedAt: bundle.observedAt,
  };
  if (bundle.kind === "invalid") {
    return {
      ...common,
      resultWatermark: bundle.resultWatermark,
      lastEntryId: bundle.lastEntryId,
      reason: bundle.reason,
    };
  }
  return {
    ...common,
    streamId: bundle.streamId,
    watermark: bundle.watermark,
    errors: bundle.errors.map((entry) => ({ sequence: entry.sequence, category: entry.category })),
    ...(bundle.gap === null ? {} : { gap: bundle.gap }),
  };
}

function workerApiErrorNotificationBody(bundle: WorkerApiErrorBundle): string {
  const lines = [
    `taskId=${bundle.taskId}`,
    `sessionId=${bundle.sessionId}`,
    `provider=${bundle.provider}`,
    `transport=${bundle.transport}`,
  ];
  if (bundle.kind === "invalid") {
    lines.push(
      "observation=invalid",
      `reason=${bundle.reason}`,
      `resultWatermark=${bundle.resultWatermark}`,
      `lastEntryId=${bundle.lastEntryId}`,
    );
    return lines.join("\n");
  }

  lines.push(`streamId=${bundle.streamId}`, `watermark=${bundle.watermark}`);
  if (bundle.gap !== null) {
    lines.push(`gap=${bundle.gap.fromSequence}-${bundle.gap.toSequence} (count=${bundle.gap.count})`);
  }
  if (bundle.errors.length > 0) {
    lines.push(`errors=${bundle.errors.map((entry) => `${entry.sequence}:${entry.category}`).join(",")}`);
  }
  return lines.join("\n");
}

async function notifyWorkerApiErrorBundle(
  deps: StageDeps,
  bundle: WorkerApiErrorBundle,
  options: CreateNotifyStageOptions,
): Promise<void> {
  const id = bundle.kind === "invalid"
    ? `worker-api-error-invalid:${bundle.taskId}:${bundle.sessionId}:${bundle.resultWatermark}:${bundle.lastEntryId}:${bundle.reason}`
    : `worker-api-error:${bundle.taskId}:${bundle.sessionId}:${bundle.streamId}:${bundle.watermark}`;
  try {
    await sendOperationalNotification(deps, {
      id,
      title: bundle.kind === "invalid" ? "worker API error observation invalid" : "worker API error observed",
      body: workerApiErrorNotificationBody(bundle),
      fullMacosBody: true,
    }, options);
  } catch {
    // best-effort 通知自体の例外は観測eventやtask処理を巻き戻さない。例外本文は安全性のため出さない。
    deps.logger.warn("monitor: worker API error operational notification に失敗しました", {
      ...workerApiErrorBundleFields(bundle),
      notificationAttempted: true,
    });
  }
}

async function monitorWorkerApiErrorObservation(
  deps: StageDeps,
  taskId: string,
  ref: SessionRef,
  status: unknown,
  apply: boolean,
  now: number,
  notes: string[],
  notificationOptions: CreateNotifyStageOptions,
): Promise<number> {
  const observation = workerApiErrorObservation(status);
  if (observation === null || observation.kind === "absent") {
    return 0;
  }

  const transport = workerApiErrorTransport(ref);
  if (observation.kind === "malformed") {
    const resultWatermark = sessionStatusResultWatermark(status as Record<string, unknown>);
    const lastEntryId = sessionStatusLastEntryId(status as Record<string, unknown>);
    if (hasWorkerApiErrorInvalidEvent(
      deps.store,
      taskId,
      ref.sessionId,
      resultWatermark,
      lastEntryId,
      observation.reason,
    )) {
      return 0;
    }

    if (!apply) {
      return 1;
    }
    deps.store.addEvent(taskId, "worker_api_error_observation_invalid", SUPERVISOR_ACTOR, {
      sessionId: ref.sessionId,
      provider: ref.provider,
      transport,
      resultWatermark,
      lastEntryId,
      reason: observation.reason,
      observedAt: now,
    });
    const bundle: WorkerApiErrorInvalidBundle = {
      kind: "invalid",
      taskId,
      sessionId: ref.sessionId,
      provider: ref.provider,
      transport,
      resultWatermark,
      lastEntryId,
      reason: observation.reason,
      observedAt: now,
    };
    deps.logger.warn("monitor: worker API error observation を記録しました", workerApiErrorBundleFields(bundle));
    notes.push(`${taskId}: malformed worker API error observation を記録しました`);
    await notifyWorkerApiErrorBundle(deps, bundle, notificationOptions);
    return 1;
  }

  const durable = readWorkerApiErrorDurableState(
    deps.store,
    taskId,
    ref.sessionId,
    observation.value.streamId,
  );
  const errors = observation.value.recent.filter((entry) => !durable.seenSequences.has(entry.sequence));
  const firstRecentSequence = observation.value.recent[0]?.sequence;
  const gap = firstRecentSequence !== undefined && firstRecentSequence > durable.coveredThrough + 1
    ? {
        fromSequence: durable.coveredThrough + 1,
        toSequence: firstRecentSequence - 1,
        count: firstRecentSequence - durable.coveredThrough - 1,
      }
    : null;
  const actions = errors.length + (gap === null ? 0 : 1);
  if (actions === 0 || !apply) {
    return actions;
  }

  if (gap !== null) {
    deps.store.addEvent(taskId, "worker_api_error_gap", SUPERVISOR_ACTOR, {
      sessionId: ref.sessionId,
      streamId: observation.value.streamId,
      fromSequence: gap.fromSequence,
      toSequence: gap.toSequence,
      count: gap.count,
      provider: ref.provider,
      transport,
      observedAt: now,
    });
  }
  for (const entry of errors) {
    deps.store.addEvent(taskId, "worker_api_error", SUPERVISOR_ACTOR, {
      sessionId: ref.sessionId,
      streamId: observation.value.streamId,
      sequence: entry.sequence,
      category: entry.category,
      provider: ref.provider,
      transport,
      observedAt: now,
    });
  }

  const bundle: WorkerApiErrorValidBundle = {
    kind: "valid",
    taskId,
    sessionId: ref.sessionId,
    provider: ref.provider,
    transport,
    streamId: observation.value.streamId,
    watermark: observation.value.watermark,
    observedAt: now,
    errors,
    gap,
  };
  deps.logger.warn("monitor: worker API error observation を記録しました", workerApiErrorBundleFields(bundle));
  notes.push(`${taskId}: worker API error observation を${actions}件記録しました`);
  await notifyWorkerApiErrorBundle(deps, bundle, notificationOptions);
  return actions;
}

/** monitorStage の差し替え可能な依存（テストからプロセス生存判定を注入するための seam） */
export interface MonitorStageOptions {
  /**
   * direct session のプロセスツリー生存判定。
   * 既定は signal 0 による生存確認（direct stop capability と同じ根拠。契約 §34.2 / §50.2）。
   */
  isDirectSessionAlive?: (state: DirectSessionState) => boolean;
  /** provider native log の exact path 解決をテストから差し替える seam。 */
  directNativeLogPathResolver?: DirectNativeLogPathResolver;
  /** 警告時の worktree git status 補助証拠をテストから差し替える seam。 */
  directStallWorktreeEvidenceCapture?: DirectStallWorktreeEvidenceCapture;
  /** worker API error の既存operational notification transportをテストから差し替えるためのseam。 */
  workerApiErrorNotificationOptions?: CreateNotifyStageOptions;
}

/**
 * direct session の既定の生存判定。
 * stop 経路（cleanupProcessGroup）と同じく process group への signal 0 を主根拠にしつつ、
 * leader 単体の生存も生存として扱う。spawnDetachedScript は detached:true で起動するため
 * 実 session では pid が group leader（pgid === pid）であり group 判定が leader 判定を包含する。
 * つまり本番挙動は変わらないが、pid が group leader でない場合に `-pid` が ESRCH となって
 * 生きているプロセスを死亡と誤判定する余地を塞ぐ。stall 宣言は run を停止させる副作用を持つため、
 * 生存の証拠が 1 つでもあれば宣言しない fail-safe 方向へ倒す。
 */
function isDirectSessionProcessAlive(state: DirectSessionState): boolean {
  return isProcessAlive(state.pid) || isProcessGroupAlive(state.pid);
}

export function createMonitorStage(options: MonitorStageOptions = {}): Stage {
  const isDirectSessionAlive = options.isDirectSessionAlive ?? isDirectSessionProcessAlive;
  const nativeLogPathResolver = options.directNativeLogPathResolver ?? resolveDirectNativeLogPath;
  const worktreeEvidenceCapture =
    options.directStallWorktreeEvidenceCapture ?? captureDirectStallWorktreeEvidence;
  const workerApiErrorNotificationOptions = options.workerApiErrorNotificationOptions ?? {};

  return {
    name: "monitor",

    async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
      const { store, logger, config } = deps;
      const notes: string[] = [];
      let actions = 0;
      const maxRunSeconds = config.resourceGuard.maxRunSeconds ?? DEFAULT_MAX_RUN_SECONDS;

      actions += await monitorDirectStalls(
        deps,
        apply,
        now,
        notes,
        isDirectSessionAlive,
        nativeLogPathResolver,
        worktreeEvidenceCapture,
      );

      for (const task of store.listInProgress()) {
        const ref = reconstructSessionRef(store, task.id);
        if (ref === null) {
          // 契約 §12.11-2: in-progress reason（block_reason）なのに task_runs に open run が無いのは
          // 恒久的な不整合（resource guard の inFlight 枠がリークし続ける）。needs-manual へ reason 付替
          // することで自己修復する。付替後は block_reason が in-progress prefix でなくなり listInProgress
          // から自然に外れるため、次 tick 以降は再検知されず冪等になる。
          actions += 1;
          logger.warn("monitor: in-progress reason なのに open run がありません。needs-manual へ付替します", {
            taskId: task.id,
          });
          notes.push(`${task.id}: in-progress 不整合を検知しました（open run なし）。自己修復します`);
          if (apply) {
            store.updateBlockReason(
              task.id,
              "needs-manual: in-progress 不整合 (open run なし)",
              SUPERVISOR_ACTOR,
              "human",
            );
          }
          continue;
        }

        // 契約 §57.4: max-runtime は run を直接解放せず durable cancel intent を作る。
        // stop 証拠の再照合と run close は cancel stage だけが行う。
        const elapsedSec = now - ref.startedAt;
        if (elapsedSec > maxRunSeconds) {
          actions += 1;
          notes.push(`${task.id}: max-runtime 超過を検知しました (${elapsedSec}s > ${maxRunSeconds}s)`);

          if (apply) {
            try {
              const openRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
              if (openRun === null) {
                recordStaleMaxRuntimeSkip(store, logger, task.id, ref.sessionId);
                continue;
              }
              ensureSupervisorCancelRequest(
                store,
                openRun,
                "max-runtime",
                `max-runtime exceeded (${elapsedSec}s > ${maxRunSeconds}s)`,
                now,
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              logger.warn("monitor: max-runtime cancel request 作成に失敗しました", {
                taskId: task.id,
                error: redactText(message),
              });
              notes.push(`${task.id}: max-runtime cancel request 作成に失敗しました`);
            }
          }

          continue;
        }

        let status;
        try {
          // 契約 §17.3: ref.serverUrl==="direct" の run は direct adapter へルーティングする。
          status = await pickAdapter(deps, ref).status(ref);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("monitor: status取得に失敗しました", { taskId: task.id, error: redactText(message) });
          notes.push(`${task.id}: status取得エラー`);
          continue;
        }

        try {
          const observed = applySteerObservations(store, ref.provider, status, SUPERVISOR_ACTOR);
          if (observed > 0) {
            actions += observed;
            notes.push(`${task.id}: steer観測ackを${observed}件記録しました`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("monitor: steer観測ackをfence不一致で拒否しました", {
            taskId: task.id,
            sessionId: ref.sessionId,
            error: redactText(message),
          });
          notes.push(`${task.id}: steer観測ackを拒否しました`);
        }

        actions += await monitorWorkerApiErrorObservation(
          deps,
          task.id,
          ref,
          status,
          apply,
          now,
          notes,
          workerApiErrorNotificationOptions,
        );

        // direct は process exit を真正終端として即時確定する。bridge の idle+result は途中 result の
        // 可能性があるため、同一 snapshot の静穏を確認してから確定する（docs/contract.md §13.4）。
        const resultCount = status.resultCount ?? 0;
        const resultWatermark = sessionStatusResultWatermark(status);
        const isDirect = ref.serverUrl === "direct";
        if (status.state !== "idle" || resultWatermark < 1) {
          if (!isDirect) {
            const candidates = store
              .listEvents(task.id, "session_end_candidate")
              .filter((event) => extractEventSessionId(event.payload) === ref.sessionId);
            const invalidations = store
              .listEvents(task.id, "session_end_candidate_invalidated")
              .filter((event) => extractEventSessionId(event.payload) === ref.sessionId);
            const latestCandidate = candidates.at(-1);
            const latestInvalidation = invalidations.at(-1);
            if (latestCandidate !== undefined && (latestInvalidation === undefined || latestInvalidation.id < latestCandidate.id)) {
              actions += 1;
              notes.push(`${task.id}: session終端候補を無効化します (sessionId=${ref.sessionId})`);
              if (apply) {
                store.addEvent(task.id, "session_end_candidate_invalidated", SUPERVISOR_ACTOR, {
                  sessionId: ref.sessionId,
                  observedAt: now,
                  reason: status.state === "idle" ? "result_missing" : "not_idle",
                });
              }
            }
          }
          continue;
        }
        const lastResultId = sessionStatusLastResultId(status);
        const lastEntryId = sessionStatusLastEntryId(status);

        const recordedMaxResultWatermark = store
          .listEvents(task.id, "session_ended")
          .filter((event) => extractEventSessionId(event.payload) === ref.sessionId)
          .reduce(
            (maxResultWatermark, event) =>
              Math.max(maxResultWatermark, extractSessionEndedResultWatermark(event.payload)),
            0,
          );
        if (isDirect && recordedMaxResultWatermark >= resultWatermark) {
          continue;
        }

        if (!isDirect) {
          const alreadyConfirmed = store
            .listEvents(task.id, "session_ended")
            .filter((event) => extractEventSessionId(event.payload) === ref.sessionId)
            .some((event) => {
              const snapshot = extractSessionEndSnapshot(event.payload);
              return snapshot?.resultWatermark === resultWatermark && snapshot.lastEntryId === lastEntryId;
            });
          if (alreadyConfirmed) {
            continue;
          }
          const candidates = store
            .listEvents(task.id, "session_end_candidate")
            .filter((event) => extractEventSessionId(event.payload) === ref.sessionId);
          const invalidations = store
            .listEvents(task.id, "session_end_candidate_invalidated")
            .filter((event) => extractEventSessionId(event.payload) === ref.sessionId);
          const latestInvalidationId = invalidations.at(-1)?.id ?? 0;
          const candidate = candidates
            .filter((event) => event.id > latestInvalidationId)
            .findLast((event) => {
              const snapshot = extractSessionEndSnapshot(event.payload);
              return snapshot?.resultWatermark === resultWatermark && snapshot.lastEntryId === lastEntryId;
            });

          if (candidate === undefined) {
            actions += 1;
            notes.push(`${task.id}: session終端候補を記録します (sessionId=${ref.sessionId})`);
            if (apply) {
              store.addEvent(task.id, "session_end_candidate", SUPERVISOR_ACTOR, {
                sessionId: ref.sessionId,
                provider: ref.provider,
                resultCount,
                lastResultId,
                resultWatermark,
                lastEntryId,
                observedAt: now,
              });
            }
            continue;
          }

          const snapshot = extractSessionEndSnapshot(candidate.payload);
          if (snapshot === null || now - snapshot.observedAt < BRIDGE_END_QUIESCENCE_SECONDS) {
            continue;
          }
        }

        actions += 1;
        notes.push(
          `${task.id}: session終了を検知しました (sessionId=${ref.sessionId}, resultWatermark=${resultWatermark})`,
        );
        if (apply) {
          store.addEvent(task.id, "session_ended", SUPERVISOR_ACTOR, {
            sessionId: ref.sessionId,
            provider: ref.provider,
            resultCount,
            lastResultId,
            resultWatermark,
            lastEntryId,
            observedAt: now,
          });
        }
      }

      return { name: "monitor", actions, skipped: false, notes };
    },
  };
}

export const monitorStage: Stage = createMonitorStage();
