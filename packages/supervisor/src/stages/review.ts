// review ステージ（docs/contract.md §15）
// worker handoff outcome="review" で `review` 状態になったタスクを、レビュアーセッション
// （two-party gate の第2審）で自動レビューする。前半（起動）でレビュアーを起動し、
// 後半（verdict 検証）で hachi-verdict-v1 を抽出・検証して遷移させる。
import { execFile, spawn } from "node:child_process";
import type { ChildProcess, ExecFileException } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { join } from "node:path";
import {
  classifyRuntimeGenerationInterruption,
  extractVerifyDirective,
  isExternalRuntimeGenerationStore,
  newNonce,
  redactText,
  resolveExecution,
  sha256Hex,
} from "@hachi/core";
import type {
  HachiConfig,
  KanbanStore,
  LessonCreateInput,
  Logger,
  RuntimeResourcesConfig,
  RunRow,
  RuntimeGenerationInterruptionCorrelationV1,
  SessionRef,
  SessionStatus,
  Stage,
  StageDeps,
  StageResult,
  TaskRow,
  Transport,
  WorkerAdapter,
} from "@hachi/core";
import { buildInProgressReason, probeBridgeExecutionCapabilities } from "@hachi/adapters";
import type { BridgeLaunchOptions, BridgeLaunchSessionRef } from "@hachi/adapters";
import {
  saveReviewPromptArtifact,
  saveReviewTranscriptArtifact,
  saveReworkPromptArtifact,
} from "../artifacts.js";
import {
  CONFIG_FILE_SNAPSHOT_META_KEY,
  reloadDispatchConfig,
  tryReadConfigFileSnapshot,
  type ConfigFileSnapshot,
} from "../config-protection.js";
import { SUPERVISOR_ACTOR } from "../constants.js";
import {
  buildEndRunMeta,
  endStatsFromStatus,
  fetchEndRunStats,
  hasNoEndStats,
  type RunEndStats,
} from "./end-run-meta.js";
import {
  bridgeNativeDeliveryRequirements,
  executionOverrideRequirements,
  hasRequiredNativeDelivery,
  probeExecutionCompatibility,
  resolveExecutionTransport,
  type ExecutionCompatibilityDecision,
  type ExecutionOverrideRequirements,
  type ExecutionTransportDecision,
  type StageDepsWithExecutionPreflight,
} from "../execution-preflight.js";
import {
  cancellationForRun,
  cancelledOpenRunForTaskOrWorktree,
  ensureSupervisorCancelRequest,
  rejectLateResultOnce,
} from "./cancel.js";
import {
  classifyExecutionFailure,
  extractAssistantFence,
  hasSuccessfulStructuredAssistantResult,
  isFenceForTask,
  isVerdictSchema,
  type ClassifiedExecutionFailure,
  type FenceFailureReason,
} from "../fence-extraction.js";
import { buildReviewPrompt, buildReworkPrompt } from "../prompt.js";
import type {
  ExternalRuntimeGenerationReader,
  ExternalRuntimeGenerationReadResult,
} from "../external-runtime-generation-reader.js";
import { readRuntimeResourcePromptContext } from "../runtime-resource-prompt-context.js";
import { loadRuntimeResourcesConfig } from "../runtime-resource-config.js";
import { synchronizeRuntimeResourceManifestFence } from "../runtime-resource-manifest.js";
import {
  evaluateRuntimeResourceReworkGate,
  validateRuntimeResourceBindings,
  type RuntimeResourceBinding,
  type RuntimeResourceStore,
} from "../runtime-resource-dispatch.js";
import {
  buildRuntimePath,
  isDirectory,
  type RuntimePath,
  VERIFY_RUNTIME_PATH_SOURCE,
} from "../runtime-path.js";
import {
  extractEventSessionId,
  parseRunMeta,
  pickAdapter,
  pickLaunchAdapter,
  sessionStatusLastResultId,
  sessionStatusResultWatermark,
} from "../session-ref.js";
import { nativeLaunchSelected, persistNativeTargetBinding, pickNativeWorkerAdapter } from "../native-delivery.js";
import {
  isIndeterminateLaunchFailure,
  LAUNCH_INDETERMINATE_PREFIX,
  probeIndeterminateLaunch,
} from "./launch-outcome.js";

interface StageDepsWithExternalRuntimeGenerationReader extends StageDeps {
  externalRuntimeGenerationReader?: ExternalRuntimeGenerationReader;
}

/** task.body 中の `cwd: <path>` 行を検出する（dispatch.ts と同じ正規表現。契約 §12.1） */
const CWD_LINE_REGEX = /^cwd:\s*(\S+)\s*$/m;

/** task.body から作業ディレクトリを抽出する。行が無い場合は null */
function extractCwd(body: string): string | null {
  const match = body.match(CWD_LINE_REGEX);
  const value = match?.[1];
  return value !== undefined && value !== "" ? value : null;
}

/** reworkの各launch fenceでcurrent host runtime profile設定を読み直す。 */
function currentRuntimeResources(deps: StageDeps): RuntimeResourcesConfig | undefined {
  try {
    return loadRuntimeResourcesConfig(join(deps.env.home, "config.json"));
  } catch (error) {
    deps.logger.warn("review: current runtime resource config を解決できません", {
      error: redactText(error instanceof Error ? error.message : String(error)),
    });
    return undefined;
  }
}

interface LessonWritableStore {
  recordLesson(input: LessonCreateInput, actor?: string): unknown;
}

function hasLessonWriter(store: KanbanStore): store is KanbanStore & LessonWritableStore {
  return "recordLesson" in store && typeof store.recordLesson === "function";
}

function buildReviewFailureLessonBody(
  source: "verdict" | "verify",
  redactedSummary: string,
  redactedIssues: readonly string[],
): string {
  const label = source === "verify" ? "verify fail" : "review fail";
  const summary = redactedSummary.trim().length > 0 ? redactedSummary.trim() : "要約なし";
  const issues = redactedIssues.map((issue) => issue.trim()).filter((issue) => issue.length > 0);
  return issues.length > 0 ? `${label}: ${summary}。指摘: ${issues.join(" / ")}` : `${label}: ${summary}`;
}

function recordReviewFailureLesson(
  store: KanbanStore,
  task: TaskRow,
  source: "verdict" | "verify",
  redactedSummary: string,
  redactedIssues: readonly string[],
): void {
  if (!hasLessonWriter(store)) {
    return;
  }
  store.recordLesson(
    {
      trigger: "rework",
      tenant: task.tenant,
      cwd: extractCwd(task.body) ?? "",
      profile: task.profile,
      body: buildReviewFailureLessonBody(source, redactedSummary, redactedIssues),
      sourceTaskId: task.id,
    },
    SUPERVISOR_ACTOR,
  );
}

/** verify コマンドのタイムアウト（契約 §39.1: 15分） */
const VERIFY_TIMEOUT_MS = 15 * 60 * 1000;

/** task_runs.meta.verify.outputTail に残す最大文字数（契約 §39.2: 8KB 上限） */
const VERIFY_OUTPUT_TAIL_LIMIT = 8 * 1024;

/** child_process から保持する生出力の上限。redact 前でも無制限にメモリ保持しないための内部制限。 */
const VERIFY_RAW_OUTPUT_TAIL_LIMIT = 32 * 1024;

/** verify 実行オプション。テストでは VerifyExecutor を差し替え、実コマンドを呼ばない。 */
export interface VerifyCommandOptions {
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

/** verify 実行結果。stdout/stderr は呼び出し側で redact してから永続化する。 */
export interface VerifyCommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** verify コマンド実行の DI 境界。既定実装のみ child_process を使う。 */
export interface VerifyExecutor {
  run(command: string, options: VerifyCommandOptions): Promise<VerifyCommandResult>;
}

interface VerifyConfig {
  tenants: Record<string, string>;
}

interface ConfigWithVerify {
  verify?: VerifyConfig;
}

interface ConfigWithReview {
  review?: {
    /** rework の最大起動回数（省略時 1。契約 §21.1） */
    maxReworkLaunches?: number;
  };
}

interface StageDepsWithVerifyExecutor extends StageDeps {
  verifyExecutor?: VerifyExecutor;
  runtimePathBuilder?: RuntimePathBuilder;
}

export interface RuntimePathBuilder {
  build(): RuntimePath;
}

export interface GitOverviewCommandOptions {
  timeoutMs: number;
  maxBuffer: number;
}

export interface GitOverviewCommandResult {
  stdout: string;
  stderr: string;
  truncated?: boolean;
}

/** git overview 生成の DI 境界。テストでは fake を注入し、実 git には触れない。 */
export interface GitOverviewExecutor {
  run(args: readonly string[], options: GitOverviewCommandOptions): Promise<GitOverviewCommandResult>;
}

interface StageDepsWithGitOverviewExecutor extends StageDeps {
  gitOverviewExecutor?: GitOverviewExecutor;
}

class GitOverviewCommandError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly maxBufferExceeded: boolean;

  constructor(message: string, stdout: string, stderr: string, maxBufferExceeded = false) {
    super(message);
    this.name = "GitOverviewCommandError";
    this.stdout = stdout;
    this.stderr = stderr;
    this.maxBufferExceeded = maxBufferExceeded;
  }
}

function execOutputToString(value: string | Buffer | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

function isExecFileMaxBufferError(error: ExecFileException): boolean {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return true;
  }
  return error.message.includes("maxBuffer");
}

class NodeGitOverviewExecutor implements GitOverviewExecutor {
  run(args: readonly string[], options: GitOverviewCommandOptions): Promise<GitOverviewCommandResult> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        [...args],
        { timeout: options.timeoutMs, maxBuffer: options.maxBuffer, windowsHide: true },
        (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
          const stdoutText = execOutputToString(stdout);
          const stderrText = execOutputToString(stderr);
          if (error !== null) {
            reject(
              new GitOverviewCommandError(error.message, stdoutText, stderrText, isExecFileMaxBufferError(error)),
            );
            return;
          }
          resolve({ stdout: stdoutText, stderr: stderrText });
        },
      );
    });
  }
}

export interface VerifyEvidence {
  status: "passed" | "failed" | "verify_environment_failed";
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  timeoutMs: number;
  command: string;
  cwd: string;
  outputTail: string;
  runtimePathSource?: typeof VERIFY_RUNTIME_PATH_SOURCE;
}

interface VerifySkippedMeta {
  skipped: "no-command" | "verify-none" | "disabled";
}

export type VerifyMeta = VerifyEvidence | VerifySkippedMeta;

export type VerifyPlan =
  | {
      kind: "run";
      command: string;
      commandSource: "task" | "tenant";
      cwd: string;
      note: string;
    }
  | {
      kind: "skip";
      meta: VerifySkippedMeta;
      note: string;
    }
  | {
      kind: "failed";
      meta: VerifyEvidence;
      note: string;
    };

function takeTail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(-limit);
}

function appendTail(current: string, chunk: string | Buffer): string {
  return takeTail(current + chunk.toString(), VERIFY_RAW_OUTPUT_TAIL_LIMIT);
}

function redactRuntimePathValues(text: string, sensitiveValues: readonly string[]): string {
  let redacted = text;
  const uniqueValues = [...new Set(sensitiveValues)]
    .filter((value) => value !== "")
    .sort((left, right) => right.length - left.length);
  for (const value of uniqueValues) {
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted;
}

function hasShellCommandNotFoundDiagnostic(output: string): boolean {
  return output.split(/\r?\n/).some((line) => {
    const shellDiagnostic =
      /^(?:\/bin\/)?(?:ba|da|z)?sh:\s*(?:(?:line\s+)?\d+:\s*)?[^:\s]+:\s*command not found\s*$/i;
    const scriptDiagnostic =
      /^[^:\r\n]*\/[^:\r\n]+:\s*line\s+\d+:\s*[^:\s]+:\s*command not found\s*$/i;
    const zshDiagnostic =
      /^(?:(?:\/bin\/)?zsh(?::\d+)?|[^:\r\n]*\/[^:\r\n]+:\d+):\s*command not found:\s*[^:\s]+\s*$/i;
    return shellDiagnostic.test(line) || scriptDiagnostic.test(line) || zshDiagnostic.test(line);
  });
}

function signalVerifyProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      // detached した shell を process group leader とし、配下のコマンド全体へ signal を送る。
      process.kill(-child.pid, signal);
      return;
    } catch {
      // 終了済みなどで process group へ送れない場合は shell 単体への送信にフォールバックする。
    }
  }

  try {
    child.kill(signal);
  } catch {
    // 既に終了済みなら close/error ハンドラ側の解決に任せる。
  }
}

const DEFAULT_VERIFY_EXECUTOR: VerifyExecutor = {
  async run(command: string, options: VerifyCommandOptions): Promise<VerifyCommandResult> {
    return new Promise<VerifyCommandResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let killTimer: NodeJS.Timeout | null = null;
      const child = spawn(command, {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: options.env,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        signalVerifyProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => {
          signalVerifyProcessTree(child, "SIGKILL");
        }, 5000);
      }, options.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string | Buffer) => {
        stdout = appendTail(stdout, chunk);
      });
      child.stderr.on("data", (chunk: string | Buffer) => {
        stderr = appendTail(stderr, chunk);
      });

      child.once("error", (err: Error) => {
        clearTimeout(timeoutTimer);
        if (killTimer !== null) {
          clearTimeout(killTimer);
        }
        reject(err);
      });

      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timeoutTimer);
        if (killTimer !== null) {
          clearTimeout(killTimer);
        }
        resolve({ exitCode: code, signal, stdout, stderr, timedOut });
      });
    });
  },
};

function verifyExecutorFromDeps(deps: StageDeps): VerifyExecutor {
  return (deps as StageDepsWithVerifyExecutor).verifyExecutor ?? DEFAULT_VERIFY_EXECUTOR;
}

function runtimePathBuilderFromDeps(deps: StageDeps): RuntimePathBuilder {
  return (
    (deps as StageDepsWithVerifyExecutor).runtimePathBuilder ?? {
      build: (): RuntimePath =>
        buildRuntimePath({
          home: process.env.HOME,
          basePath: process.env.PATH,
          directoryExists: isDirectory,
        }),
    }
  );
}

function verifyTenantsFromConfig(config: StageDeps["config"]): Record<string, string> {
  const verify = (config as StageDeps["config"] & ConfigWithVerify).verify;
  return verify?.tenants ?? {};
}

function isVerifyDisabled(deps: StageDeps): boolean {
  return existsSync(join(deps.env.home, "verify.disabled"));
}

function buildVerifyEvidence(
  status: VerifyEvidence["status"],
  command: string,
  cwd: string,
  result: Pick<VerifyCommandResult, "exitCode" | "signal" | "timedOut">,
  output: string,
  runtimePathSource?: typeof VERIFY_RUNTIME_PATH_SOURCE,
  sensitiveValues: readonly string[] = [],
): VerifyEvidence {
  return {
    status,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    timeoutMs: VERIFY_TIMEOUT_MS,
    command: redactText(command),
    cwd,
    outputTail: takeTail(redactText(redactRuntimePathValues(output, sensitiveValues)), VERIFY_OUTPUT_TAIL_LIMIT),
    ...(runtimePathSource === undefined ? {} : { runtimePathSource }),
  };
}

export function resolveVerifyPlan(deps: StageDeps, task: TaskRow): VerifyPlan {
  if (isVerifyDisabled(deps)) {
    return { kind: "skip", meta: { skipped: "disabled" }, note: `${task.id}: verify.disabled のため verify をスキップ` };
  }

  const bodyVerify = extractVerifyDirective(task.body);
  if (bodyVerify !== null) {
    if (bodyVerify.toLowerCase() === "none") {
      return { kind: "skip", meta: { skipped: "verify-none" }, note: `${task.id}: verify:none により verify を免除` };
    }
    if (bodyVerify === "") {
      const cwd = extractCwd(task.body) ?? "";
      return {
        kind: "failed",
        meta: buildVerifyEvidence(
          "failed",
          "",
          cwd,
          { exitCode: null, signal: null, timedOut: false },
          "verify 行が空です",
        ),
        note: `${task.id}: verify 行が空のため失敗扱い`,
      };
    }
    const cwd = extractCwd(task.body);
    if (cwd === null || !isAbsolute(cwd)) {
      const message =
        cwd === null ? "verify 実行不能 (cwd 無し)" : `verify 実行不能 (cwd が絶対パスではありません: ${cwd})`;
      return {
        kind: "failed",
        meta: buildVerifyEvidence(
          "failed",
          bodyVerify,
          cwd ?? "",
          { exitCode: null, signal: null, timedOut: false },
          message,
        ),
        note: `${task.id}: ${message}`,
      };
    }
    return {
      kind: "run",
      command: bodyVerify,
      commandSource: "task",
      cwd,
      note: `${task.id}: task body の verify コマンドを実行予定`,
    };
  }

  const tenantCommandRaw = verifyTenantsFromConfig(deps.config)[task.tenant];
  if (tenantCommandRaw === undefined) {
    return { kind: "skip", meta: { skipped: "no-command" }, note: `${task.id}: verify 未定義のため監査のみ` };
  }
  const tenantCommand = tenantCommandRaw.trim();
  if (tenantCommand === "") {
    const cwd = extractCwd(task.body) ?? "";
    return {
      kind: "failed",
      meta: buildVerifyEvidence(
        "failed",
        "",
        cwd,
        { exitCode: null, signal: null, timedOut: false },
        "tenant verify コマンドが空です",
      ),
      note: `${task.id}: tenant verify コマンドが空のため失敗扱い`,
    };
  }

  const cwd = extractCwd(task.body);
  if (cwd === null || !isAbsolute(cwd)) {
    const message =
      cwd === null ? "verify 実行不能 (cwd 無し)" : `verify 実行不能 (cwd が絶対パスではありません: ${cwd})`;
    return {
      kind: "failed",
      meta: buildVerifyEvidence(
        "failed",
        tenantCommand,
        cwd ?? "",
        { exitCode: null, signal: null, timedOut: false },
        message,
      ),
      note: `${task.id}: ${message}`,
    };
  }

  return {
    kind: "run",
    command: tenantCommand,
    commandSource: "tenant",
    cwd,
    note: `${task.id}: tenant verify コマンドを実行予定`,
  };
}

export async function executeVerifyPlan(deps: StageDeps, plan: VerifyPlan): Promise<VerifyMeta> {
  if (plan.kind !== "run") {
    return plan.meta;
  }

  let runtimePath: RuntimePath | null = null;
  try {
    runtimePath = runtimePathBuilderFromDeps(deps).build();
    const result = await verifyExecutorFromDeps(deps).run(plan.command, {
      cwd: plan.cwd,
      timeoutMs: VERIFY_TIMEOUT_MS,
      env: { ...process.env, PATH: runtimePath.path },
    });
    const output = [result.stdout, result.stderr].filter((part) => part !== "").join("\n");
    const environmentFailed =
      !result.timedOut &&
      (result.exitCode === 127 ||
        (result.exitCode !== null && result.exitCode !== 0 && hasShellCommandNotFoundDiagnostic(output)));
    const status: VerifyEvidence["status"] =
      !result.timedOut && result.exitCode === 0
        ? "passed"
        : environmentFailed
          ? "verify_environment_failed"
          : "failed";
    return buildVerifyEvidence(
      status,
      plan.command,
      plan.cwd,
      result,
      output,
      runtimePath.source,
      runtimePath.sensitiveValues,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return buildVerifyEvidence(
      "failed",
      plan.command,
      plan.cwd,
      { exitCode: null, signal: null, timedOut: false },
      message,
      runtimePath?.source,
      runtimePath?.sensitiveValues,
    );
  }
}

export function isVerifyFailure(meta: VerifyMeta): meta is VerifyEvidence {
  return !("skipped" in meta) && meta.status !== "passed";
}

export function isVerifyEnvironmentFailure(meta: VerifyMeta): meta is VerifyEvidence {
  return !("skipped" in meta) && meta.status === "verify_environment_failed";
}

export function verifyResultLabel(meta: VerifyEvidence): string {
  if (meta.timedOut) {
    return "timeout";
  }
  if (meta.exitCode !== null) {
    return `exit ${meta.exitCode}`;
  }
  return `signal ${meta.signal ?? "unknown"}`;
}

export function buildVerifyFailureSummary(meta: VerifyEvidence): string {
  const output = meta.outputTail === "" ? "出力なし" : meta.outputTail;
  return `verify 失敗 (${verifyResultLabel(meta)}): ${output}`;
}

function buildVerifyFailureIssues(meta: VerifyEvidence): string[] {
  return [
    `verify command: ${meta.command}`,
    `verify result: ${verifyResultLabel(meta)}`,
    meta.outputTail === "" ? "verify output: 出力なし" : `verify output:\n${meta.outputTail}`,
  ];
}

// ---------------------------------------------------------------------------
// verify 失敗の flake 判定（環境ゆらぎ再現）— 失敗したテストだけを再実行し、
// 通れば worker 帰責にしない（environment_evidence）。判定不能・再現失敗は
// 既存どおり worker_local へ倒す（fail-closed。契約 §39.2 の自動 rework 経路を維持）。
// ---------------------------------------------------------------------------

/** 失敗テストのみの再実行タイムアウト（本 verify より短い。全体 timeout は契約 §39.1 の15分）。 */
const VERIFY_RETRY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * vitest等のANSI装飾（色・カーソル制御）を除去し、テキスト照合を安定させる。
 * パラメータ部は数字（; 区切り）のみに限定し、終端は英字1文字だけを消費する。
 * 英数字を無制限に許すと ESC[31mFAIL のように直後の平文が地続きになった場合、
 * パラメータ部が "31mFAIL" まで食い込み "FAIL" ごと消してしまう（実測で確認済みの不具合）。
 */
const ANSI_ESCAPE_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[a-zA-Z]/g;

function stripAnsiEscapes(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

/**
 * vitest の失敗テスト行（"FAIL  <file> > <suite> > <test>"）からファイルパスとテスト識別子を
 * 抽出する。行頭アンカーのため `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` のような "FAIL" を含む
 * だけの無関係な行（pnpm -r のエラーバナー等）とは衝突しない（実出力で確認済み）。
 * 事前に {@link parsePnpmPrefixedLine} で package prefix を分離した後の {@link ParsedOutputLine.text}
 * に対して適用する前提（pnpm の prefix を剥がした残りの行に対して適用する）。
 */
const VITEST_FAIL_LINE_PATTERN = /^\s*FAIL\s+(\S+)\s*(.*)$/;

/**
 * pnpm -r（並列実行時）の出力行に付与される "<package> <script>: " 形式のプレフィックスを
 * 検出する（`pnpm help run` の "Stream output from child processes immediately, prefixed with the
 * originating package directory" 仕様どおり。実測（`pnpm -r test` を並列実行、複数packageが同時に
 * 失敗する状態）で確認済み）。group1 が package識別子（package.json のあるディレクトリの
 * repoRoot 相対パス。例: "packages/cli"）そのものであり、**失敗テストの帰属先 package を特定する
 * 一次情報として保持する**（本関数の呼び出し側は group1 を捨てずに持ち回ること。捨てると、
 * 複数 package に同じ相対テストパスが存在するケースを区別できなくなる — 本タスクの起票理由）。
 * ANSI除去後の行に対して適用する前提（色コードがプレフィックスの語を分断しているため、
 * 除去前だと "packages/core" と "test" の間に ESC シーケンスが挟まり一致しない）。
 * vitest 自身が出す行（"FAIL"始まりや字下げ済みの行、"AssertionError: ..." 等）は行頭が
 * 空白か単一トークン+コロン直後（空白を挟まない）にしかならず、
 * 「非空白トークン + 空白 + 非空白トークン + ": " + 空白」の形には一致しない
 * （手動検証で確認済み。false positive を避けるため厳密な形にしている）。
 */
const PNPM_STREAM_PREFIX_PATTERN = /^([\w@./-]+)\s+([\w.-]+):\s(.*)$/;

/**
 * ANSI除去済みの1行と、そこから分離した pnpm package prefix（無ければ null）。
 * `packagePrefix` は {@link PNPM_STREAM_PREFIX_PATTERN} の group1（例: "packages/cli"）そのもので、
 * 失敗テストの package 帰属を判定する一次情報として最後まで保持する（{@link FailingTestRef.package}）。
 */
interface ParsedOutputLine {
  packagePrefix: string | null;
  text: string;
}

function parsePnpmPrefixedLine(line: string): ParsedOutputLine {
  const match = line.match(PNPM_STREAM_PREFIX_PATTERN);
  return match ? { packagePrefix: match[1] ?? null, text: match[3] ?? "" } : { packagePrefix: null, text: line };
}

/**
 * vitest tree-view のファイル見出し行（例: "❯ <file> (29 tests | 1 failed) 12ms"）。
 * スタックトレース中の "❯ <file>:<line>:<col>" 参照（括弧を伴わない）とは区別するため、
 * ファイルトークンの直後に "(" が続く行だけを見出しとして扱う。
 */
const VITEST_TREE_HEADER_PATTERN = /^\s*❯\s+(\S+)\s*\(/;

/**
 * vitest tree-view の失敗テスト行（例: "     × <test> 12ms"）。この行単体にはファイルパスが
 * 現れないため、直前に見た見出し行（{@link VITEST_TREE_HEADER_PATTERN}）のファイルへ紐付ける。
 */
const VITEST_TREE_FAIL_LEAF_PATTERN = /^\s*×\s+(.*)$/;

/** tree-view の "× " 行末尾に付く実行時間表記（"12ms" 等）を取り除き、FAIL行のテスト名と揃える。 */
function stripTrailingDuration(text: string): string {
  return text.replace(/\s+\d+(?:\.\d+)?m?s$/, "").trim();
}

/**
 * 再実行対象として安全に扱えるテストファイルパスの許可文字集合。絶対パス・`..` を含む
 * パス traversal を拒否し、retry コマンドへ渡す前に構文的な安全性を保証する。
 */
const SAFE_TEST_FILE_PATTERN = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * verify 出力から特定した失敗テスト1件（package識別子＋ファイルパス＋テスト識別子）。
 * 判定根拠として event payload へ残す。
 *
 * `package` は失敗テストの同一性を構成する一次情報である。相対パス（`file`）だけでは
 * 複数 package に同名の相対テストパスが存在するケース（実測: 本リポジトリの
 * packages/cli/src/argv.test.ts と packages/supervisor/src/argv.test.ts）を区別できない。
 * pnpm prefix（{@link parsePnpmPrefixedLine}）から package を取れた行では prefix の値
 * （例: "packages/cli"）を、prefix の無い出力（単一package相当の verify コマンド等）では
 * null を持つ。
 */
export interface FailingTestRef {
  /** pnpm prefix から得た package 識別子（例: "packages/cli"）。prefix が無ければ null。 */
  package: string | null;
  file: string;
  /** "<suite> > <test>" 部分。抽出できない行では空文字（ファイルパスの特定自体は有効）。 */
  test: string;
}

/** vitest 失敗行の残余部分（"> suite > test"）から先頭の "> " を取り除く。 */
function stripLeadingSeparator(text: string): string {
  return text.replace(/^>\s*/, "").trim();
}

/**
 * verify 出力を判定用に正規化した行配列にする（ANSI除去 → pnpm prefix 分離）。
 * 失敗テスト特定（{@link identifyFailingTests}）と trailer 集計
 * （{@link sumReportedFailingCountsByPackage}）の両方がこの同じ行配列を参照する
 * （正規化の二重実装によるズレを防ぐ）。pnpm prefix は捨てずに {@link ParsedOutputLine.packagePrefix}
 * として保持する（package identity を後段まで持ち回るため）。
 */
function normalizeVerifyOutputLines(output: string): ParsedOutputLine[] {
  return stripAnsiEscapes(output)
    .split(/\r?\n/)
    .map((line) => parsePnpmPrefixedLine(line));
}

/** (package, file, test) の組から重複除去・グルーピング用のキーを作る。package 無しは "" 扱い。 */
function failingTestKey(pkg: string | null, file: string, test: string): string {
  return `${pkg ?? ""} ${file} ${test}`;
}

/** (package, file) の組から、ファイル単位の集計・抑制用キーを作る。 */
function failingFileKey(pkg: string | null, file: string): string {
  return `${pkg ?? ""} ${file}`;
}

/**
 * verify 出力の正規化済み行から失敗テスト（package＋ファイルパス＋テスト識別子、重複除去・出現順）を
 * 特定する。特定できなければ空配列。同一ファイル内で複数テストが失敗していれば複数件返す
 * （再実行はファイル単位でまとめるが、判定根拠としてテスト名も個別に保持する）。
 * 同じ相対パスでも package が異なれば別の失敗として扱う（package を捨てない。本タスクの起票理由）。
 *
 * 主判定は自己完結した "FAIL <file> > ... > <test>" 行（{@link VITEST_FAIL_LINE_PATTERN}）。
 * それに加えて、(package, file) の組として FAIL行が見つからなかった行に限り、tree-view の
 * "❯ <file> (...)" 見出し＋ "× <test>" 行からも補完する（FAIL行が既にある (package, file) は
 * 二重カウントを避けるため無視する）。tree-view の見出し追跡は package ごとに独立させる
 * （複数 package の出力が行単位で interleave しても、それぞれ自分の prefix を持つ行だけを
 * 参照するため取り違えない）。
 */
function identifyFailingTests(lines: readonly ParsedOutputLine[]): FailingTestRef[] {
  const seen = new Set<string>();
  const refs: FailingTestRef[] = [];
  const filesWithFailLine = new Set<string>();

  for (const line of lines) {
    const match = line.text.match(VITEST_FAIL_LINE_PATTERN);
    const file = match?.[1];
    if (file === undefined || !SAFE_TEST_FILE_PATTERN.test(file)) {
      continue;
    }
    filesWithFailLine.add(failingFileKey(line.packagePrefix, file));
    const test = stripLeadingSeparator(match?.[2] ?? "");
    const key = failingTestKey(line.packagePrefix, file, test);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push({ package: line.packagePrefix, file, test });
  }

  const currentTreeFileByPackage = new Map<string | null, string | null>();
  for (const line of lines) {
    const header = line.text.match(VITEST_TREE_HEADER_PATTERN);
    if (header) {
      const headerFile = header[1];
      const isFailingHeader = /\bfailed\b/.test(line.text);
      const resolvedFile =
        isFailingHeader && headerFile !== undefined && SAFE_TEST_FILE_PATTERN.test(headerFile)
          ? headerFile
          : null;
      currentTreeFileByPackage.set(line.packagePrefix, resolvedFile);
      continue;
    }
    const currentTreeFile = currentTreeFileByPackage.get(line.packagePrefix) ?? null;
    if (currentTreeFile === null || filesWithFailLine.has(failingFileKey(line.packagePrefix, currentTreeFile))) {
      continue;
    }
    const leaf = line.text.match(VITEST_TREE_FAIL_LEAF_PATTERN);
    if (!leaf) {
      continue;
    }
    const test = stripTrailingDuration(leaf[1] ?? "");
    const key = failingTestKey(line.packagePrefix, currentTreeFile, test);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push({ package: line.packagePrefix, file: currentTreeFile, test });
  }

  return refs;
}

/**
 * 失敗テストの一意な (package, file) 組から得たファイルパス一覧（出現順）。
 * 情報提供目的の一覧であり、同じ相対パスが複数 package にまたがる場合は文字列としては
 * 重複しうる（一意性は {@link FailingTestRef.package} を含めた `failingTests` 側で担保する）。
 */
function uniqueFailingTestFiles(refs: readonly FailingTestRef[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const ref of refs) {
    const key = failingFileKey(ref.package, ref.file);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    files.push(ref.file);
  }
  return files;
}

/**
 * vitest の "Tests  N failed | M passed (T)" trailer 行（vitest自身が申告する失敗数の集計行）。
 * 先頭が同じ "Test Files  N failed | M passed (T)" 行（ファイル数の集計。個々の失敗テスト数とは
 * 一致しない）とは区別するため、"Tests" の直後に空白のみが続くことを要求する
 * （"Test Files" は "Test" の直後が半角スペース+"Files" になるため一致しない）。
 * pnpm -r 実行では package ごとに1行ずつ出るため、複数ある場合は呼び出し側で合算する。
 */
const VITEST_TESTS_TRAILER_PATTERN = /^\s*Tests\s+(\d+)\s+failed\b/;

/**
 * 正規化済み行から vitest 自己申告の失敗テスト総数を package ごとに合算する。
 * 突合（{@link classifyVerifyFailure}）は package ごとに独立して行うため、trailer 自体を
 * package 単位（prefix の無い出力では単一の null キー）で集計する（§ Fix B の一般化）。
 * pnpm --workspace-concurrency=1（sequential/grouped 実行）等でどこかの package の最終summaryが
 * bail により出力されない場合もあるため、trailer が存在しない package はこのMapに現れず、
 * 呼び出し側はそのpackageについて突合をスキップする（trailerが元々存在しない既存ケースを
 * 新たに worker_local へ倒さないため）。
 */
function sumReportedFailingCountsByPackage(lines: readonly ParsedOutputLine[]): Map<string | null, number> {
  const totals = new Map<string | null, number>();
  for (const line of lines) {
    const match = line.text.match(VITEST_TESTS_TRAILER_PATTERN);
    if (match?.[1] === undefined) {
      continue;
    }
    const key = line.packagePrefix;
    totals.set(key, (totals.get(key) ?? 0) + Number(match[1]));
  }
  return totals;
}

/** pnpm workspace（`packages/*`）配下のパッケージディレクトリ一覧。存在しなければ空配列。 */
function listWorkspacePackageDirs(repoRoot: string): string[] {
  const packagesRoot = join(repoRoot, "packages");
  if (!existsSync(packagesRoot)) {
    return [];
  }
  try {
    return readdirSync(packagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(packagesRoot, entry.name));
  } catch {
    return [];
  }
}

/**
 * 失敗テストファイル1件が実在する、一意なディレクトリ（repoRoot 自身か、いずれかの workspace
 * パッケージ）を解決する。該当ディレクトリが存在しない、または複数ディレクトリが該当する
 * （同名の相対テストパスが複数パッケージに存在する等）場合は null とし、呼び出し側は
 * このファイルの再実行を試みず worker_local へ倒す。候補が複数あるまま先頭を採用すると、
 * 無関係なパッケージの同名テストがたまたま通っただけで flake と誤判定し得るため、
 * 一意解決できない限り進めない。
 *
 * pnpm prefix から package を特定できなかった行（{@link FailingTestRef.package} が null）に対する
 * フォールバックとしてのみ使う。prefix から package が判明している場合は
 * {@link resolveFailingTestDir} が repoRoot からの相対パスとして決定的に解決するため、
 * この「実在ディレクトリを総当たりで探す」あいまいな解決には頼らない。
 */
function resolveTestFileDir(repoRoot: string, file: string): string | null {
  const candidates = [repoRoot, ...listWorkspacePackageDirs(repoRoot)];
  const matches = candidates.filter((dir) => existsSync(join(dir, file)));
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * package prefix として許容する文字集合（走査 `..` と絶対パスを拒否する）。
 * {@link PNPM_STREAM_PREFIX_PATTERN} の group1 は `[\w@./-]+` を許すため、構文的に安全な範囲へ
 * さらに絞り込む（retry のディレクトリ解決へ渡す前の防御）。
 */
const SAFE_PACKAGE_PREFIX_PATTERN = /^(?!\/)(?!.*\.\.)[\w@./-]+$/;

/**
 * 失敗テスト1件（{@link FailingTestRef}）の再実行先ディレクトリを解決する。
 *
 * - `package`（pnpm prefix から得た識別子）がある場合は、`packages/*` の既知 workspace package と
 *   照合して **決定的に**解決する。同名の相対パスが複数 package に存在しても、prefix で一意に
 *   決まるためあいまいさは生じない。package directory の実在だけを確認し、対象 test file の
 *   host-side 存在確認は行わない。prefix で package identity を解決済みなら retry を実行し、
 *   relative path が実際に不正な場合は command の失敗を worker_local evidence として残す。
 * - `package` が無い場合（prefix の無い出力＝単一 package 相当）のみ、従来どおり
 *   {@link resolveTestFileDir} で実在ディレクトリを総当たりして一意解決を試みる。
 */
function resolveFailingTestDir(repoRoot: string, ref: FailingTestRef): string | null {
  if (ref.package === null) {
    return resolveTestFileDir(repoRoot, ref.file);
  }
  if (!SAFE_PACKAGE_PREFIX_PATTERN.test(ref.package)) {
    return null;
  }
  const dir = join(repoRoot, ref.package);
  const workspacePackageDirs = listWorkspacePackageDirs(repoRoot);
  return workspacePackageDirs.includes(dir) ? dir : null;
}

/**
 * 失敗テストを再実行先ディレクトリ単位でグループ化する（出現順を保つ）。
 * 複数 package に跨っていても、個々の ref がそれぞれ一意に解決できる限りグループごとに
 * 再実行する（§ Fix C）。同じ相対パスが複数 package にまたがっていても、package ごとに
 * ディレクトリが異なる（= 別グループ）ため、それぞれ別の失敗として個別に再実行される
 * （§ Fix A — 本タスクの起票理由。package を解決に使わずファイル名だけで一致判定すると、
 * この衝突ケースを区別できなかった）。
 * 1件でも解決できない ref があれば、全体を再実行せず null を返す。
 */
function groupFailingTestsByDir(repoRoot: string, refs: readonly FailingTestRef[]): Map<string, string[]> | null {
  const groups = new Map<string, string[]>();
  const filesByGroup = new Map<string, Set<string>>();
  for (const ref of refs) {
    const dir = resolveFailingTestDir(repoRoot, ref);
    if (dir === null) {
      return null;
    }
    let files = filesByGroup.get(dir);
    if (files === undefined) {
      files = new Set<string>();
      filesByGroup.set(dir, files);
      groups.set(dir, []);
    }
    if (!files.has(ref.file)) {
      files.add(ref.file);
      groups.get(dir)!.push(ref.file);
    }
  }
  return groups;
}

/**
 * 失敗テストファイルだけを対象にした再実行コマンド。`pnpm <script> -- <args>` は pnpm が
 * 区切りの "--" をスクリプトへそのまま転送するため、script が `vitest run` でも
 * 実際には `vitest run -- <file>` が起動し、Vitest は "--" 以降をファイルフィルタとして
 * 解釈できず package 全体を実行してしまう（実測で確認済みの不具合。フェイク executor を
 * 使う単体テストでは検知できないため、実 pnpm/vitest で個別に確認した）。
 * `pnpm exec vitest run <file>` は script 定義を経由せず直接 Vitest を起動するためこの問題を
 * 避けられ、対象ファイルだけへ確実に絞り込める（実測で確認済み）。
 */
function buildVerifyRetryCommand(testFiles: readonly string[]): string {
  const args = testFiles.map((file) => `'${file}'`).join(" ");
  return `pnpm exec vitest run ${args}`;
}

export type VerifyRetryOutcome = "passed" | "failed" | "not-attempted";

/** verify 失敗の再現性判定に使った証跡。verdict_failed / handoff_verify_failed event へ載せる。 */
export interface VerifyRetryEvidence {
  attempted: boolean;
  outcome: VerifyRetryOutcome;
  reason: string;
  /** 特定した失敗テスト（ファイル名・テスト名）。オーケストレーターが event だけで切り分けられるようにする。 */
  failingTests: FailingTestRef[];
  /** failingTests から一意抽出したファイルパス一覧（再実行コマンドの対象そのもの）。 */
  failingTestFiles: string[];
  command: string | null;
}

function notAttempted(
  reason: string,
  failingTests: readonly FailingTestRef[] = [],
  command: string | null = null,
): VerifyRetryEvidence {
  return {
    attempted: command !== null,
    outcome: "not-attempted",
    reason,
    failingTests: [...failingTests],
    failingTestFiles: uniqueFailingTestFiles(failingTests),
    command,
  };
}

export interface VerifyRetryClassification {
  failureCause: "worker_local" | "environment_evidence";
  verifyRetry: VerifyRetryEvidence;
}

/**
 * verify 失敗（verify_environment_failed を除く）の帰責を判定する。失敗テストを特定できた場合、
 * それだけを再実行し、通れば flake（environment_evidence）、再現すれば worker_local と確定する。
 * 特定不能・再実行不能・timeout はいずれも worker_local へ倒す（fail-closed。既存動作を変えない）。
 */
export async function classifyVerifyFailure(
  deps: StageDeps,
  evidence: VerifyEvidence,
): Promise<VerifyRetryClassification> {
  // outputTail は前方切り詰め（tail-keeping）で最大 VERIFY_OUTPUT_TAIL_LIMIT バイトに制限されている
  // （buildVerifyEvidence）。上限に達している＝冒頭が欠落している可能性があり、失敗テストを
  // 網羅的に特定できた保証がない。部分出力からの再実行成功を flake の証拠として扱わない
  // （fail-closed。§ Fix B）。
  if (evidence.outputTail.length >= VERIFY_OUTPUT_TAIL_LIMIT) {
    return { failureCause: "worker_local", verifyRetry: notAttempted("output_truncated") };
  }

  const lines = normalizeVerifyOutputLines(evidence.outputTail);
  const failingTests = identifyFailingTests(lines);
  if (failingTests.length === 0) {
    return { failureCause: "worker_local", verifyRetry: notAttempted("failing_tests_not_identified") };
  }

  // vitest 自身が申告する失敗テスト総数（"Tests N failed" trailer）と、抽出できた失敗テスト数を
  // package ごとに突合する。trailer が実在する package で一致しない場合、その package の出力の
  // どこかが欠落／混入している疑いがあり、全ての失敗を再実行対象にできた保証がない
  // （fail-closed。§ Fix B）。trailer 自体が無い package（断片的な出力等、既存の想定ケース。
  // pnpm --workspace-concurrency=1 で先行 package が bail した場合を含む）では突合しない。
  const reportedCountsByPackage = sumReportedFailingCountsByPackage(lines);
  if (reportedCountsByPackage.size > 0) {
    const extractedCountsByPackage = new Map<string | null, number>();
    for (const ref of failingTests) {
      extractedCountsByPackage.set(ref.package, (extractedCountsByPackage.get(ref.package) ?? 0) + 1);
    }
    for (const [pkg, reportedCount] of reportedCountsByPackage) {
      if (reportedCount !== (extractedCountsByPackage.get(pkg) ?? 0)) {
        return {
          failureCause: "worker_local",
          verifyRetry: notAttempted("failing_test_count_mismatch", failingTests),
        };
      }
    }
  }

  const failingTestFiles = uniqueFailingTestFiles(failingTests);
  const groups = groupFailingTestsByDir(evidence.cwd, failingTests);
  if (groups === null) {
    return { failureCause: "worker_local", verifyRetry: notAttempted("failing_test_path_unresolved", failingTests) };
  }

  // package を跨る場合、グループ（解決先ディレクトリ）ごとに1回ずつ再実行する。
  // 「特定した失敗ごとに厳密1回」を保つため、再実行ループやfull-verifyの再実行は行わない。
  const runtimePath = runtimePathBuilderFromDeps(deps).build();
  const executor = verifyExecutorFromDeps(deps);
  const executedCommands: string[] = [];

  for (const [dir, files] of groups) {
    const retryCommand = buildVerifyRetryCommand(files);
    executedCommands.push(retryCommand);
    const command = redactText(executedCommands.join("; "));
    try {
      const result = await executor.run(retryCommand, {
        cwd: dir,
        timeoutMs: VERIFY_RETRY_TIMEOUT_MS,
        env: { ...process.env, PATH: runtimePath.path },
      });
      if (result.timedOut) {
        return { failureCause: "worker_local", verifyRetry: notAttempted("retry_timed_out", failingTests, command) };
      }
      if (result.exitCode !== 0) {
        return {
          failureCause: "worker_local",
          verifyRetry: { attempted: true, outcome: "failed", reason: "retry_failed", failingTests, failingTestFiles, command },
        };
      }
      // このグループは再現しなかった。他のグループも全て再現しなければ flake と判定する。
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        failureCause: "worker_local",
        verifyRetry: notAttempted(`retry_error: ${message}`, failingTests, command),
      };
    }
  }

  return {
    failureCause: "environment_evidence",
    verifyRetry: {
      attempted: true,
      outcome: "passed",
      reason: "retry_passed",
      failingTests,
      failingTestFiles,
      command: redactText(executedCommands.join("; ")),
    },
  };
}

/** レビュアーへ渡す change overview の git コマンドタイムアウト（docs/contract.md §15.1） */
const GIT_OVERVIEW_TIMEOUT_MS = 5000;

/** git コマンド単体の出力上限。overview はセクションごとに本文 cap する。 */
const GIT_OVERVIEW_MAX_BUFFER = 64 * 1024;

/** レビュアーへ渡す change overview の合計上限（docs/contract.md §15.1: 約24KB）。 */
const GIT_OVERVIEW_TOTAL_LIMIT = 24 * 1024;

/** 見出し・区切り・truncated 表記ぶんの概算予約。 */
const GIT_OVERVIEW_FORMAT_OVERHEAD_RESERVE = 1024;

const GIT_OVERVIEW_SECTION_BODY_LIMITS = {
  base: 2 * 1024,
  diffStat:
    GIT_OVERVIEW_TOTAL_LIMIT -
    2 * 1024 -
    5 * 1024 -
    4 * 1024 -
    GIT_OVERVIEW_FORMAT_OVERHEAD_RESERVE,
  status: 5 * 1024,
  untracked: 4 * 1024,
} as const;

const GIT_OVERVIEW_UNAVAILABLE = "(git overview 取得不可)";

/** transcript 取得失敗の許容回数（契約 §15.2, §12.16-1 と同型） */
const TRANSCRIPT_FETCH_FAILURE_THRESHOLD = 3;

/** verdict fence 再出力を待つ grace（契約 §15.2.1: 10分）。 */
const VERDICT_NUDGE_GRACE_SECONDS = 10 * 60;

/** レビュー判断そのものを再実行させず、既存判断の protocol 化だけを求める。 */
const VERDICT_NUDGE_MESSAGE = [
  "新たなレビュー、tool実行、verify、diffの読み直しは行わないでください。",
  "直前に確定した verdict / confidence / summary / issues / failureCause を、同じ taskId の hachi-verdict-v1 fence で直ちに再出力してください。fail の failureCause は必須です。",
].join("\n");

/** 同じ routing の自動 rework は最大1回（configはlegacy互換で省略または1のみ。契約 §21.1）。 */
const DEFAULT_REWORK_MAX_LAUNCHES = 1;

/** worker 完了報告コメントの本文プレフィックス（finalize.ts が書き込む書式と一致させる） */
const WORKER_REPORT_PREFIX = "ワーカー完了報告: ";

interface GitBaseResolution {
  base: string | null;
  source: "origin/main" | "main" | null;
  failures: string[];
}

function firstOutputLine(stdout: string): string | null {
  const first = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  return first ?? null;
}

function gitFailureSummary(err: unknown): string {
  if (err instanceof GitOverviewCommandError) {
    const details = [err.stderr, err.stdout, err.message].map((text) => text.trim()).find((text) => text !== "");
    return redactText(details ?? err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return redactText(message);
}

function stringField(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

function recoverMaxBufferGitOverviewResult(err: unknown): GitOverviewCommandResult | null {
  if (typeof err !== "object" || err === null) {
    return null;
  }
  const record = err as Record<string, unknown>;
  const message = err instanceof Error ? err.message : "";
  const maxBufferExceeded =
    record.maxBufferExceeded === true ||
    record.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    message.includes("maxBuffer");
  if (!maxBufferExceeded) {
    return null;
  }

  return {
    stdout: stringField(record.stdout),
    stderr: stringField(record.stderr),
    truncated: true,
  };
}

async function runGitOverviewCommand(
  executor: GitOverviewExecutor,
  cwd: string,
  args: readonly string[],
): Promise<GitOverviewCommandResult> {
  try {
    return await executor.run(["-C", cwd, ...args], {
      timeoutMs: GIT_OVERVIEW_TIMEOUT_MS,
      maxBuffer: GIT_OVERVIEW_MAX_BUFFER,
    });
  } catch (err) {
    const recovered = recoverMaxBufferGitOverviewResult(err);
    if (recovered !== null) {
      return recovered;
    }
    throw err;
  }
}

async function resolveGitOverviewBase(executor: GitOverviewExecutor, cwd: string): Promise<GitBaseResolution> {
  const failures: string[] = [];

  try {
    const origin = await runGitOverviewCommand(executor, cwd, ["merge-base", "HEAD", "origin/main"]);
    const base = firstOutputLine(origin.stdout);
    if (base !== null) {
      return { base, source: "origin/main", failures };
    }
    failures.push("origin/main: merge-base 出力が空です");
  } catch (err) {
    failures.push(`origin/main: ${gitFailureSummary(err)}`);
  }

  try {
    const main = await runGitOverviewCommand(executor, cwd, ["merge-base", "HEAD", "main"]);
    const base = firstOutputLine(main.stdout);
    if (base !== null) {
      return { base, source: "main", failures };
    }
    failures.push("main: merge-base 出力が空です");
  } catch (err) {
    failures.push(`main: ${gitFailureSummary(err)}`);
  }

  return { base: null, source: null, failures };
}

type GitOverviewSectionKey = keyof typeof GIT_OVERVIEW_SECTION_BODY_LIMITS;

function capGitOverviewSectionBody(title: string, body: string, limit: number, truncated = false): string {
  const trimmed = body.trimEnd();
  const source = trimmed === "" ? "(出力なし)" : trimmed;
  if (!truncated && trimmed === "") {
    return "(出力なし)";
  }
  if (!truncated && source.length <= limit) {
    return source;
  }

  const note = truncated
    ? `\n[hachi] ${title} は git コマンド出力が maxBuffer を超えたため途中までの出力です (truncated)。`
    : `\n[hachi] ${title} は ${limit} 文字を超えたため末尾を省略しました (truncated)。`;
  return `${source.slice(0, Math.max(0, limit - note.length))}${note}`;
}

function formatGitOverviewSection(title: string, key: GitOverviewSectionKey, body: string, truncated = false): string {
  const cappedBody = capGitOverviewSectionBody(title, body, GIT_OVERVIEW_SECTION_BODY_LIMITS[key], truncated);
  return [`## ${title}`, cappedBody].join("\n");
}

/**
 * reviewer 起動前に host 側で worktree の変更俯瞰を生成する（docs/contract.md §15.1）。
 * git/cwd の致命的失敗は fail-open で固定文言へ倒し、レビュー起動自体は継続させる。
 */
export async function buildGitChangeOverview(
  cwd: string,
  executor: GitOverviewExecutor = new NodeGitOverviewExecutor(),
): Promise<string> {
  if (cwd.trim() === "" || !existsSync(cwd)) {
    return GIT_OVERVIEW_UNAVAILABLE;
  }

  try {
    const base = await resolveGitOverviewBase(executor, cwd);
    const sections: string[] = [];
    sections.push(
      formatGitOverviewSection(
        "BASE",
        "base",
        base.base === null
          ? ["(committed 範囲取得不可)", ...base.failures.map((failure) => `- ${failure}`)].join("\n")
          : `${base.base} (${base.source})`,
      ),
    );

    if (base.base !== null) {
      const diffStat = await runGitOverviewCommand(executor, cwd, ["--no-pager", "diff", "--stat", base.base, "--"]);
      sections.push(
        formatGitOverviewSection(
          "tracked diff --stat",
          "diffStat",
          redactText(diffStat.stdout),
          diffStat.truncated === true,
        ),
      );
    } else {
      sections.push(formatGitOverviewSection("tracked diff --stat", "diffStat", "(BASE 未解決のため取得不可)"));
    }

    const status = await runGitOverviewCommand(executor, cwd, ["status", "--porcelain=v1", "-uall"]);
    sections.push(
      formatGitOverviewSection(
        "status --porcelain=v1 -uall",
        "status",
        redactText(status.stdout),
        status.truncated === true,
      ),
    );

    const untracked = await runGitOverviewCommand(executor, cwd, ["ls-files", "--others", "--exclude-standard"]);
    sections.push(
      formatGitOverviewSection(
        "untracked files",
        "untracked",
        redactText(untracked.stdout),
        untracked.truncated === true,
      ),
    );

    return sections.join("\n\n");
  } catch {
    return GIT_OVERVIEW_UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// reviewer run（task_runs, meta.role='reviewer'）のローカル判別・再構築ヘルパー
// ---------------------------------------------------------------------------
// getLatestOpenRun / reconstructSessionRef（session-ref.ts）は worker run と reviewer run が
// 混在する task_runs から「最新の open run」を無差別に選ぶため、review ステージでは使えない
// （契約 §15 注記）。ここでは meta.role='reviewer' でフィルタした専用ロジックを実装する。

/** run.meta の role が 'reviewer' かどうかを判定する（契約 §15: task_runs.meta.role='reviewer'） */
function isReviewerRun(run: RunRow): boolean {
  try {
    const meta = JSON.parse(run.meta) as unknown;
    return typeof meta === "object" && meta !== null && (meta as Record<string, unknown>).role === "reviewer";
  } catch {
    return false;
  }
}

/** 全 open run（task_runs.status='running'）から reviewer run のみを抽出する */
function listOpenReviewerRuns(store: KanbanStore): RunRow[] {
  return store.listOpenRuns().filter(isReviewerRun);
}

/**
 * dispatch の resource guard（maxInFlight 判定）に reviewer run 数を加算するための公開ヘルパー
 * （docs/contract.md §15.1）。dispatch.ts はこれを呼ぶだけに留める。
 */
export function countOpenReviewerRuns(store: KanbanStore): number {
  return listOpenReviewerRuns(store).length;
}

/** タスクの最新 open reviewer run を1件返す（getLatestOpenRun と同様のポリシー: 最新→id最大） */
function getLatestOpenReviewerRun(store: KanbanStore, taskId: string): RunRow | null {
  const runs = listOpenReviewerRuns(store).filter((run) => run.taskId === taskId);
  if (runs.length === 0) {
    return null;
  }
  return runs.reduce((latest, run) => {
    if (run.startedAt > latest.startedAt) {
      return run;
    }
    if (run.startedAt === latest.startedAt && run.id > latest.id) {
      return run;
    }
    return latest;
  });
}

/**
 * reviewer run（task_runs、正本）から SessionRef を再構築する（block_reason は一切参照しない。
 * review 状態のタスクは block_reason を持たないため session-ref.ts の reconstructSessionRef は使えない）。
 */
function reconstructReviewerSessionRef(store: KanbanStore, taskId: string): SessionRef | null {
  const latest = getLatestOpenReviewerRun(store, taskId);
  if (latest === null) {
    return null;
  }
  const { serverUrl, model, modelDelivery, nativeCommunication } = parseRunMeta(latest.meta);
  return {
    provider: latest.provider,
    sessionId: latest.sessionId,
    serverUrl,
    model,
    modelDelivery,
    ...(nativeCommunication === undefined ? {} : { nativeCommunication }),
    startedAt: latest.startedAt,
  };
}

// ---------------------------------------------------------------------------
// stale 検知（finalize.ts の assertStillTargetSession と同型, 契約 §12.12-1）
// ---------------------------------------------------------------------------

/** review Tx 冒頭の再検証に失敗したことを示す内部シグナル */
class StaleReviewAbort extends Error {}

/**
 * Tx 冒頭でタスクと最新 open reviewer run を再読込し、この review 処理がまだ対象とすべき状態かを
 * 検証する（契約 §15.2, §12.12-1 と同型）。status='review' かつ最新 open reviewer run の
 * sessionId が一致しない場合は StaleReviewAbort を throw し、呼び出し元の Tx を丸ごとロールバックさせる。
 */
function assertStillTargetReviewerSession(store: KanbanStore, taskId: string, sessionId: string): void {
  const currentTask = store.getTask(taskId);
  const latestRun = getLatestOpenReviewerRun(store, taskId);
  const stillValid =
    currentTask !== null && currentTask.status === "review" && latestRun !== null && latestRun.sessionId === sessionId &&
    cancellationForRun(store, latestRun.id) === null;
  if (!stillValid) {
    throw new StaleReviewAbort();
  }
}

/** stale_review_skipped イベントを Tx 外で記録し warn ログを出す（finalize の stale_finalize_skipped と対をなす） */
function recordStaleReviewSkipped(
  store: KanbanStore,
  logger: Logger,
  taskId: string,
  sessionId: string,
  phase: string,
): void {
  const run = store.getOpenRunByTaskSession(taskId, sessionId);
  if (run !== null && cancellationForRun(store, run.id) !== null) {
    rejectLateResultOnce(store, run, sessionId);
    logger.warn("review: cancel fence 後の late mutation を拒否しました", { taskId, sessionId, phase });
    return;
  }
  store.addEvent(taskId, "stale_review_skipped", SUPERVISOR_ACTOR, { sessionId, phase });
  logger.warn("review: タスクが再遷移したため stale verdict の適用を中断しました", { taskId, sessionId, phase });
}

/**
 * direct adapter の stop() を呼び出し、StopResult を検査する（契約 §34.2.1）。
 * stop() は例外を投げなくても stopped:false（already-exited/unsupported/unsignalable/
 * kill-unconfirmed）を返しうる。**戻り値の reason は stopped の値に関わらず必ず証拠として
 * 記録する**（契約 §34.2.1「戻り値を検査し、reason を証拠へ残すこと」）。
 * `unsignalable`/`kill-unconfirmed`（＝この呼び出しで停止を確認できなかった）は warn、
 * `already-exited`/`unsupported`（＝ベストエフォート cleanup の想定内の結果）は info で残し、
 * ログレベルだけを分ける。context には呼び出し元の状況を表す短い日本語ラベルを渡す。
 */
async function stopDirectSessionAndWarn(
  adapter: WorkerAdapter,
  ref: SessionRef,
  logger: Logger,
  taskId: string,
  context: string,
): Promise<void> {
  if (adapter.stop === undefined) {
    return;
  }
  try {
    const result = await adapter.stop(ref);
    const fields = { taskId, sessionId: redactText(ref.sessionId), reason: result.reason };
    if (!result.stopped) {
      if (result.reason === "unsignalable" || result.reason === "kill-unconfirmed") {
        logger.warn(`review: ${context}の停止を確認できませんでした`, fields);
      } else {
        logger.info(`review: ${context}は停止呼び出し不要でした（想定内）`, fields);
      }
    } else {
      // 契約 §34.2.1: 成功2値（terminated/killed）も stopped:false の4値と同じく reason を
      // 証拠として記録する。stopped:false のときだけ記録すると成功経路の reason が欠落する。
      logger.info(`review: ${context}が完了しました`, fields);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`review: ${context}に失敗しました`, {
      taskId,
      sessionId: redactText(ref.sessionId),
      error: redactText(message),
    });
  }
}

async function cleanupDirectReviewerProcessGroup(
  adapter: WorkerAdapter,
  ref: SessionRef,
  logger: Logger,
  taskId: string,
): Promise<void> {
  if (ref.serverUrl !== "direct") {
    return;
  }
  await stopDirectSessionAndWarn(adapter, ref, logger, taskId, "direct reviewer run の process group cleanup");
}

// ---------------------------------------------------------------------------
// worker handoff summary の取得（契約 §15.1）
// ---------------------------------------------------------------------------

/**
 * worker の handoff summary を取得する（直近の finalized イベント payload を優先し、
 * 実装上そこに含まれない場合は supervisor コメントの "ワーカー完了報告:" prefix から取得する。
 * 契約 §15.1: 「直近の finalized イベント payload または supervisor コメントから」）。
 */
function extractWorkerHandoffSummary(store: KanbanStore, taskId: string): string {
  const finalizedEvents = store.listEvents(taskId, "finalized");
  for (let i = finalizedEvents.length - 1; i >= 0; i -= 1) {
    const event = finalizedEvents[i];
    if (event === undefined) {
      continue;
    }
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      if (payload.outcome === "review" && typeof payload.summary === "string" && payload.summary !== "") {
        return payload.summary;
      }
    } catch {
      // 無視して次の情報源を試す
    }
  }

  const comments = store.listComments(taskId);
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i];
    if (comment === undefined) {
      continue;
    }
    if (comment.author === SUPERVISOR_ACTOR && comment.body.startsWith(WORKER_REPORT_PREFIX)) {
      const rest = comment.body.slice(WORKER_REPORT_PREFIX.length);
      return (rest.split("\n")[0] ?? rest).trim();
    }
  }

  return "(worker handoff summary 取得不可)";
}

// ---------------------------------------------------------------------------
// verdict 抽出・検証（finalize.ts の handoff 抽出と同型, 契約 §15.1/§15.2）
// ---------------------------------------------------------------------------

export const REVIEW_FAILURE_CAUSES = [
  "worker_local",
  "worker_major",
  "spec_ambiguity",
  "environment_evidence",
  "late_requirement_change",
] as const;

export type ReportedReviewFailureCause = (typeof REVIEW_FAILURE_CAUSES)[number];
export type ReviewFailureCause = ReportedReviewFailureCause | "unknown";
export type ReviewFailureCauseSource = "reported" | "missing" | "unrecognized" | "verify" | "not-applicable";

export interface VerdictPayload {
  taskId: string;
  verdict: "pass" | "fail";
  confidence: "high" | "medium" | "low";
  summary: string;
  issues: string[];
  failureCause: ReviewFailureCause | null;
  failureCauseSource: ReviewFailureCauseSource;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function parseReportedFailureCause(value: unknown): {
  cause: ReviewFailureCause;
  source: ReviewFailureCauseSource;
} {
  if (value === undefined) {
    return { cause: "unknown", source: "missing" };
  }
  if (typeof value === "string" && (REVIEW_FAILURE_CAUSES as readonly string[]).includes(value)) {
    return { cause: value as ReportedReviewFailureCause, source: "reported" };
  }
  return { cause: "unknown", source: "unrecognized" };
}

/**
 * verdict JSON を手動検証する。taskId・基本列挙値の不正は null。
 * legacy fail の failureCause 欠落と未知値は verdict 自体を捨てず unknown へ正規化し、
 * 自動 rework へ流さない（後方互換かつ fail-closed）。
 */
export function parseVerdict(raw: string, expectedTaskId: string): VerdictPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;

  const taskId = record.taskId;
  if (typeof taskId !== "string" || taskId !== expectedTaskId) {
    return null;
  }

  const verdict = record.verdict;
  if (verdict !== "pass" && verdict !== "fail") {
    return null;
  }

  const confidence = record.confidence;
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
    return null;
  }

  const summary = record.summary;
  if (typeof summary !== "string") {
    return null;
  }

  if (verdict === "pass") {
    return {
      taskId,
      verdict,
      confidence,
      summary,
      issues: asStringArray(record.issues),
      failureCause: null,
      failureCauseSource: "not-applicable",
    };
  }

  const classification = parseReportedFailureCause(record.failureCause);
  return {
    taskId,
    verdict,
    confidence,
    summary,
    issues: asStringArray(record.issues),
    failureCause: classification.cause,
    failureCauseSource: classification.source,
  };
}

interface VerdictNudgePayload {
  sessionId: string;
  ts: number;
  baselineResultWatermark: number;
  baselineLastResultId: number;
  baselineResultCount: number;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** verdict_nudge_sent の比較 fence を fail-closed に復元する。 */
function parseVerdictNudgePayload(payload: string): VerdictNudgePayload | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const sessionId = typeof record.sessionId === "string" && record.sessionId !== "" ? record.sessionId : null;
    const ts = nonNegativeInteger(record.ts);
    const baselineResultWatermark = nonNegativeInteger(record.baselineResultWatermark);
    const baselineLastResultId = nonNegativeInteger(record.baselineLastResultId);
    const baselineResultCount = nonNegativeInteger(record.baselineResultCount);
    if (
      sessionId === null ||
      ts === null ||
      baselineResultWatermark === null ||
      baselineLastResultId === null ||
      baselineResultCount === null
    ) {
      return null;
    }
    return { sessionId, ts, baselineResultWatermark, baselineLastResultId, baselineResultCount };
  } catch {
    return null;
  }
}

interface VerdictNudgeState {
  recorded: boolean;
  payload: VerdictNudgePayload | null;
}

function latestVerdictNudgeState(store: KanbanStore, taskId: string, sessionId: string): VerdictNudgeState {
  const events = store
    .listEvents(taskId, "verdict_nudge_sent")
    .filter((event) => extractEventSessionId(event.payload) === sessionId);
  const latest = events.at(-1);
  return latest === undefined
    ? { recorded: false, payload: null }
    : { recorded: true, payload: parseVerdictNudgePayload(latest.payload) };
}

type VerdictMissingCause = "model_output_missing" | "parse_invalid";

/** verdict 救済の終端失敗を一か所で処理し、run 枠を必ず解放する。 */
async function finalizeMissingVerdict(
  deps: StageDeps,
  task: TaskRow,
  ref: SessionRef,
  adapter: WorkerAdapter,
  observedStatus: SessionStatus,
  options: {
    cause: VerdictMissingCause;
    transcript?: string;
    terminalEvent?: "verdict_nudge_expired" | "verdict_nudge_failed";
    diagnostic?: string;
  },
): Promise<"applied" | "stale"> {
  const { store, env, logger } = deps;
  let transcriptPath: string | null = null;
  let saveErrorMessage: string | null = null;
  if (options.transcript !== undefined) {
    try {
      transcriptPath = saveReviewTranscriptArtifact(env, task.id, ref.sessionId, options.transcript);
    } catch (err) {
      saveErrorMessage = err instanceof Error ? err.message : String(err);
      logger.warn("review: verdict 終端失敗の transcript 保存に失敗しました", {
        taskId: task.id,
        sessionId: ref.sessionId,
        error: redactText(saveErrorMessage),
      });
    }
  }

  const observedStats = endStatsFromStatus(observedStatus);
  const endStats: RunEndStats = hasNoEndStats(observedStats)
    ? await fetchEndRunStats(adapter, ref, logger, task.id, "review")
    : observedStats;
  try {
    store.transaction(() => {
      assertStillTargetReviewerSession(store, task.id, ref.sessionId);
      if (options.terminalEvent !== undefined) {
        store.addEvent(task.id, options.terminalEvent, SUPERVISOR_ACTOR, {
          sessionId: ref.sessionId,
          ...(options.diagnostic === undefined ? {} : { diagnostic: redactText(options.diagnostic) }),
        });
      }
      store.addEvent(task.id, "verdict_missing", SUPERVISOR_ACTOR, {
        sessionId: ref.sessionId,
        cause: options.cause,
      });

      const artifactNote =
        options.transcript === undefined
          ? ""
          : transcriptPath !== null
            ? ` (transcript: ${transcriptPath})`
            : ` transcript の保存に失敗しました（${redactText(saveErrorMessage ?? "unknown")}）`;
      store.addComment(
        task.id,
        SUPERVISOR_ACTOR,
        redactText(`レビュー出力から有効な hachi-verdict-v1 を回収できませんでした。人間の確認をお願いします。${artifactNote}`),
      );

      const openRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
      if (openRun !== null) {
        store.endRun(openRun.id, "failed", buildEndRunMeta(openRun, endStats));
      }
      store.block(
        task.id,
        `needs-manual: レビュー verdict 欠落 (session=${ref.sessionId})`,
        SUPERVISOR_ACTOR,
        "human",
      );
    });
  } catch (err) {
    if (err instanceof StaleReviewAbort) {
      recordStaleReviewSkipped(store, logger, task.id, ref.sessionId, options.terminalEvent ?? "verdict_missing");
      return "stale";
    }
    throw err;
  }
  await cleanupDirectReviewerProcessGroup(adapter, ref, logger, task.id);
  return "applied";
}

interface ClassifiedReviewOutputFailure {
  reason: FenceFailureReason;
  diagnostic: string;
}

function reviewOutputFailureMeta(
  failure: ClassifiedReviewOutputFailure,
  correlation: RuntimeGenerationInterruptionCorrelationV1 | null,
): Record<string, unknown> {
  return {
    outputFailure: {
      reason: correlation?.reason ?? failure.reason,
      diagnostic: redactText(failure.diagnostic),
    },
    ...(failure.reason === "worker_output_missing"
      ? {
          infraCorrelation: correlation === null
            ? { version: 1, state: "unconfirmed" }
            : { ...correlation, state: "confirmed" },
        }
      : {}),
  };
}

/** provider/CLI/抽出失敗を verdict missing や自動 rework へ流さず終端化する。 */
async function finalizeClassifiedReviewOutputFailure(
  deps: StageDeps,
  task: TaskRow,
  ref: SessionRef,
  adapter: WorkerAdapter,
  transcript: string,
  failure: ClassifiedReviewOutputFailure,
  observedStatus: SessionStatus,
): Promise<"applied" | "stale"> {
  const { store, env, logger } = deps;
  const redactedDiagnostic = redactText(failure.diagnostic);
  let transcriptPath: string | null = null;
  let saveErrorMessage: string | null = null;
  try {
    transcriptPath = saveReviewTranscriptArtifact(env, task.id, ref.sessionId, transcript);
  } catch (err) {
    saveErrorMessage = err instanceof Error ? err.message : String(err);
    logger.warn("review: 分類済み失敗の transcript 保存に失敗しました", {
      taskId: task.id,
      sessionId: ref.sessionId,
      error: redactText(saveErrorMessage),
    });
  }

  const observedStats = endStatsFromStatus(observedStatus);
  const endStats: RunEndStats = hasNoEndStats(observedStats)
    ? await fetchEndRunStats(adapter, ref, logger, task.id, "review")
    : observedStats;
  let externalGenerationRead: ExternalRuntimeGenerationReadResult | null = null;
  const externalGenerationReader = (deps as StageDepsWithExternalRuntimeGenerationReader)
    .externalRuntimeGenerationReader;
  const terminalObservedAt = Date.now();
  if (
    failure.reason === "worker_output_missing" && externalGenerationReader !== undefined &&
    isExternalRuntimeGenerationStore(store)
  ) {
    try {
      externalGenerationRead = await externalGenerationReader.read(ref.provider, terminalObservedAt);
    } catch {
      externalGenerationRead = { state: "unknown", code: "read_failed" };
    }
  }
  try {
    store.transaction(() => {
      assertStillTargetReviewerSession(store, task.id, ref.sessionId);
      const openRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
      let correlation: RuntimeGenerationInterruptionCorrelationV1 | null = null;
      if (
        failure.reason === "worker_output_missing" && openRun !== null &&
        externalGenerationRead?.state === "valid" && isExternalRuntimeGenerationStore(store)
      ) {
        const acceptance = store.acceptExternalRuntimeGenerationStatus(
          externalGenerationRead.sample,
          terminalObservedAt,
        );
        if (acceptance === "accepted" || acceptance === "idempotent") {
          const binding = store.getExternalRuntimeGenerationBinding(openRun.id);
          const status = store.getExternalRuntimeGenerationStatus(ref.provider);
          if (binding !== null && status !== null) {
            correlation = classifyRuntimeGenerationInterruption({
              binding,
              status,
              runStartedAt: openRun.startedAt * 1_000,
              terminalObservedAt,
              nowMs: terminalObservedAt,
              diagnosticCode: "worker_output_missing",
            });
          }
        }
      }
      const classifiedReason = correlation?.reason ?? failure.reason;
      store.addEvent(task.id, classifiedReason, SUPERVISOR_ACTOR, correlation === null
        ? {
            sessionId: ref.sessionId,
            diagnostic: redactedDiagnostic,
            ...(failure.reason === "worker_output_missing"
              ? { infraCorrelation: { version: 1, state: "unconfirmed" } }
              : {}),
          }
        : { ...correlation, infraCorrelation: { version: 1, state: "confirmed" } });
      const artifactNote =
        transcriptPath !== null
          ? ` (transcript: ${transcriptPath})`
          : ` transcript の保存に失敗しました（${redactText(saveErrorMessage ?? "unknown")}）`;
      store.addComment(
        task.id,
        SUPERVISOR_ACTOR,
        `レビュアー実行を ${classifiedReason} と分類しました。${redactedDiagnostic}${artifactNote}`,
      );

      if (openRun !== null) {
        store.endRun(
          openRun.id,
          "failed",
          buildEndRunMeta(openRun, endStats, reviewOutputFailureMeta(failure, correlation)),
        );
      }
      store.block(
        task.id,
        `needs-manual: レビュー実行失敗 ${classifiedReason} (session=${ref.sessionId})`,
        SUPERVISOR_ACTOR,
        "human",
      );
    });
  } catch (err) {
    if (err instanceof StaleReviewAbort) {
      recordStaleReviewSkipped(store, logger, task.id, ref.sessionId, failure.reason);
      return "stale";
    }
    throw err;
  }
  await cleanupDirectReviewerProcessGroup(adapter, ref, logger, task.id);
  return "applied";
}

interface RecordedReviewFailure {
  summaryHash: string;
  failureCause: ReviewFailureCause;
}

/** legacy/破損イベントは worker 起因と推測せず unknown へ倒す。 */
function parseRecordedReviewFailure(payload: string): RecordedReviewFailure | null {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    if (typeof parsed.summaryHash !== "string") {
      return null;
    }
    const classification = parseReportedFailureCause(parsed.failureCause);
    return { summaryHash: parsed.summaryHash, failureCause: classification.cause };
  } catch {
    return null;
  }
}

type ReworkDecision =
  | "rework"
  | "no-progress"
  | "replacement-required"
  | "orchestrator-review-required";

type ReviewFailureRoutingAction =
  | "automatic_rework"
  | "orchestrator_sol_xhigh_replacement"
  | "orchestrator_review_required";

function routingActionForDecision(decision: ReworkDecision): ReviewFailureRoutingAction {
  if (decision === "rework") {
    return "automatic_rework";
  }
  if (decision === "replacement-required") {
    return "orchestrator_sol_xhigh_replacement";
  }
  return "orchestrator_review_required";
}

function reviewRequiredReason(
  cause: ReviewFailureCause,
  decision: Exclude<ReworkDecision, "rework">,
  redactedSummary: string,
): string {
  const label =
    decision === "replacement-required"
      ? `${cause}: Sol/xhigh replacement required`
      : decision === "no-progress"
        ? `${cause}: no-progress`
        : cause === "unknown"
          ? "failure_cause_unknown: classification required"
          : `${cause}: orchestrator handling required`;
  const boundedSummary = (redactedSummary.trim() === "" ? "summary unavailable" : redactedSummary).slice(0, 120);
  return `review-required: ${label}: ${boundedSummary}`;
}

// ---------------------------------------------------------------------------
// 前半: レビュアーの起動（docs/contract.md §15.1）
// ---------------------------------------------------------------------------

function effectiveProfileName(task: TaskRow, config: HachiConfig, role: "worker" | "reviewer"): string {
  if (role === "reviewer") {
    return task.reviewProfileOverride !== "" ? task.reviewProfileOverride : "review";
  }
  return task.profile !== "" ? task.profile : config.defaultProfile;
}

/** setting mutation と launch の競合を検出するsecret-free fingerprint。 */
function executionSettingsFingerprint(
  task: TaskRow,
  config: HachiConfig,
  role: "worker" | "reviewer",
): string {
  const profile = effectiveProfileName(task, config, role);
  return sha256Hex(JSON.stringify({
    role,
    status: task.status,
    title: task.title,
    bodyHash: sha256Hex(task.body),
    tenant: task.tenant,
    profile,
    profileEntry: config.profiles[profile] ?? null,
    configHash: sha256Hex(JSON.stringify(config)),
    provider: role === "reviewer" ? task.reviewProviderOverride : task.provider,
    model: role === "reviewer" ? task.reviewModelOverride : task.modelOverride,
    effort: role === "reviewer" ? task.reviewEffortOverride : task.effortOverride,
    speed: role === "reviewer" ? task.reviewSpeedOverride : task.speedOverride,
  }));
}

function sameConfigSnapshot(left: ConfigFileSnapshot | null, right: ConfigFileSnapshot | null): boolean {
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

function compatibilityBlockReason(decision: Exclude<ExecutionCompatibilityDecision, { status: "supported" }>): string {
  const detail = redactText(decision.detail).slice(0, 300);
  return decision.status === "unsupported"
    ? `needs-manual: incompatible_model_transport (${decision.reason}: ${detail})`
    : `needs-manual: model_transport_compatibility_unknown (${decision.reason}: ${detail})`;
}

function compatibilityEventType(
  decision: Exclude<ExecutionCompatibilityDecision, { status: "supported" }>,
): "incompatible_model_transport" | "model_transport_compatibility_unknown" {
  return decision.status === "unsupported"
    ? "incompatible_model_transport"
    : "model_transport_compatibility_unknown";
}

function compatibilityEventPayload(
  role: "worker" | "reviewer",
  resolution: Extract<ReturnType<typeof resolveExecution>, { ok: true }>,
  transport: Transport,
  decision: ExecutionCompatibilityDecision,
): Record<string, unknown> {
  return {
    role,
    provider: resolution.provider,
    model: resolution.model,
    transport,
    status: decision.status,
    ...(decision.status === "supported"
      ? { evidence: decision.evidence }
      : { reason: decision.reason, detail: redactText(decision.detail) }),
    expectation: decision.expectation,
    observed: decision.observed,
  };
}

/** 現行 Claude bridge adapter の固定 maxTurns 要求を、実際の launch 経路にだけ付ける。 */
function bridgeLaunchRequirements(
  resolution: Extract<ReturnType<typeof resolveExecution>, { ok: true }>,
  requirements: ExecutionOverrideRequirements,
  useNativeLaunch: boolean,
): ExecutionOverrideRequirements {
  return {
    ...requirements,
    ...(resolution.provider === "claude" && resolution.transport === "bridge" && !useNativeLaunch
      ? { maxTurns: true }
      : {}),
  };
}

/** maxTurns capability は POST 前に確認し、非広告・不明なら direct を選ぶ。 */
async function resolveReviewLaunchTransport(
  deps: StageDeps,
  resolution: Extract<ReturnType<typeof resolveExecution>, { ok: true }>,
  requirements: ExecutionOverrideRequirements,
): Promise<ExecutionTransportDecision> {
  if (requirements.maxTurns !== true) {
    return { transport: resolution.transport, reason: "configured" };
  }
  const probe = await probeBridgeExecutionCapabilities(
    deps.env.bridges[resolution.provider],
    resolution.provider,
  );
  const capabilities = probe.ok
    ? { status: "known" as const, capabilities: probe.snapshot.capabilities }
    : {
        status: "unknown" as const,
        detail: `${probe.failure.kind}${probe.failure.status !== undefined ? `:${probe.failure.status}` : ""}`,
      };
  if (capabilities.status === "unknown") {
    deps.logger.warn("review: maxTurns capability probe が不明のため direct transport を選択します", {
      provider: resolution.provider,
      detail: capabilities.detail,
    });
  }
  return resolveExecutionTransport(resolution, capabilities, requirements);
}

async function launchReviewers(deps: StageDeps, apply: boolean): Promise<{ actions: number; notes: string[] }> {
  const { store, env, logger } = deps;
  const notes: string[] = [];
  let actions = 0;
  const config = reloadDispatchConfig(deps, notes);

  for (const listedTask of store.listByStatus("review")) {
    const task = store.getTask(listedTask.id);
    if (task === null || task.status !== "review") {
      continue;
    }
    if (getLatestOpenReviewerRun(store, task.id) !== null) {
      continue; // 既にレビュアーが起動済み（後半の verdict 検証対象）
    }
    if (store.listEvents(task.id, "verdict_finalized").length > 0) {
      continue; // 契約 §15.1: verdict_finalized 済みタスクは対象外（防御的な冪等チェック）
    }

    const cwd = extractCwd(task.body);
    if (cwd === null || !isAbsolute(cwd)) {
      actions += 1;
      const reason =
        cwd === null
          ? "needs-manual: レビュー起動不能 (cwd 無し)"
          : `needs-manual: レビュー起動不能 (cwd が絶対パスではありません: ${cwd})`;
      notes.push(`${task.id}: ${reason}`);
      if (apply) {
        store.block(task.id, reason, SUPERVISOR_ACTOR, "human");
      }
      continue;
    }
    const existingCancelGate = cancelledOpenRunForTaskOrWorktree(store, task.id, cwd);
    if (existingCancelGate !== null) {
      notes.push(
        `${task.id}: cancel stop 証拠待ち run#${existingCancelGate.id} のため reviewer 起動を拒否しました`,
      );
      continue;
    }

    // cwd 検証を通過した最初の1件のみ起動し、この tick のレビュー起動枠を使い切る（契約 §15.1: 1 tick 最大1）
    actions += 1;

    const resolution = resolveExecution(task, config, "reviewer");
    if (!resolution.ok) {
      const reason = `user-decision: reviewer モデル解決に失敗 (${resolution.reason}: ${resolution.detail})`;
      notes.push(`${task.id}: ${reason}`);
      if (apply) {
        store.block(task.id, reason, SUPERVISOR_ACTOR, "human");
      }
      continue;
    }

    const settingsFingerprint = executionSettingsFingerprint(task, config, "reviewer");
    const configSnapshot = tryReadConfigFileSnapshot(env, logger, { stage: "review", taskId: task.id });
    const useNativeReviewerLaunch = nativeLaunchSelected(config, resolution.provider, task.id);
    const requirements = bridgeLaunchRequirements(
      resolution,
      executionOverrideRequirements(task, "reviewer"),
      useNativeReviewerLaunch,
    );
    const transportDecision = await resolveReviewLaunchTransport(deps, resolution, requirements);
    const reviewTransport = transportDecision.transport;
    const requireBridgeAppliedValues = reviewTransport === "bridge" && !useNativeReviewerLaunch;
    const deliveryRequirements = bridgeNativeDeliveryRequirements(resolution);
    const compatibility = await probeExecutionCompatibility(
      deps as StageDepsWithExecutionPreflight,
      config,
      resolution,
      reviewTransport,
      {
        ...requirements,
        model: true,
        maxTurns: reviewTransport === "bridge" && requirements.maxTurns === true,
      },
    );
    if (compatibility.status !== "supported") {
      const reason = compatibilityBlockReason(compatibility);
      if (!apply) {
        notes.push(`${task.id}: reviewer ${reason}`);
      } else {
        const blocked = store.transaction((): boolean => {
          const current = store.getTask(task.id);
          const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
            stage: "review",
            taskId: task.id,
          });
          if (
            current === null || current.status !== "review" ||
            executionSettingsFingerprint(current, config, "reviewer") !== settingsFingerprint ||
            !sameConfigSnapshot(configSnapshot, currentConfigSnapshot)
          ) {
            return false;
          }
          store.block(task.id, reason, SUPERVISOR_ACTOR, "human");
          store.addEvent(
            task.id,
            compatibilityEventType(compatibility),
            SUPERVISOR_ACTOR,
            compatibilityEventPayload("reviewer", resolution, reviewTransport, compatibility),
          );
          return true;
        });
        notes.push(
          blocked
            ? `${task.id}: reviewer ${reason}`
            : `${task.id}: reviewer設定/configがpreflight中に変更されたため古い互換性判定を破棄しました`,
        );
      }
      continue;
    }

    if (!apply) {
      notes.push(
        `dry-run: ${task.id} をレビュー起動予定 (provider=${resolution.provider} model=${resolution.model})`,
      );
      break;
    }

    const compatibilityRecorded = store.transaction((): boolean => {
      const current = store.getTask(task.id);
      const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
        stage: "review",
        taskId: task.id,
      });
      if (
        current === null || current.status !== "review" ||
        executionSettingsFingerprint(current, config, "reviewer") !== settingsFingerprint ||
        !sameConfigSnapshot(configSnapshot, currentConfigSnapshot)
      ) {
        return false;
      }
      store.addEvent(
        task.id,
        "model_transport_compatibility_checked",
        SUPERVISOR_ACTOR,
        compatibilityEventPayload("reviewer", resolution, reviewTransport, compatibility),
      );
      return true;
    });
    if (!compatibilityRecorded) {
      notes.push(`${task.id}: reviewer設定がpreflight中に変更されたため起動をスキップしました`);
      continue;
    }

    const workerSummary = extractWorkerHandoffSummary(store, task.id);
    const gitOverviewExecutor = (deps as StageDepsWithGitOverviewExecutor).gitOverviewExecutor;
    const changeOverview = await buildGitChangeOverview(cwd, gitOverviewExecutor);
    const promptText = buildReviewPrompt(task, resolution.model, workerSummary, changeOverview);

    // prompt artifact は launch 前に保存する（dispatch.ts と同じ原子性方針, 契約 §12.6-3）。
    // review ステージは claim を取らないため（契約 §15.1 に claim/CAS の言及無し）、保存失敗時は
    // 単にこの tick の起動を諦める（タスクは review のまま残り、次 tick で再試行される）。
    const nonce = newNonce();
    try {
      saveReviewPromptArtifact(env, task.id, nonce, promptText);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("review: prompt artifact 保存に失敗しました。起動をスキップします", {
        taskId: task.id,
        error: redactText(message),
      });
      notes.push(`${task.id}: review prompt artifact 保存失敗のため起動スキップ (${redactText(message)})`);
      break;
    }

    // 契約 §17.3/§67: reviewer roleの解決transportを尊重する（既定 bridge）。
    // pickLaunchAdapter は direct 指定で adapter 未構成なら throw し、下の catch で auto-launch-failed に倒れる。
    let ref: BridgeLaunchSessionRef;
    let reviewerAdapter: WorkerAdapter;
    let attemptedAt = new Date().toISOString();
    try {
      const prelaunchCancelGate = cancelledOpenRunForTaskOrWorktree(store, task.id, cwd);
      if (prelaunchCancelGate !== null) {
        notes.push(
          `${task.id}: launch 直前に cancel stop 証拠待ち run#${prelaunchCancelGate.id} を検知したため reviewer 起動を拒否しました`,
        );
        continue;
      }
      const prelaunchTask = store.getTask(task.id);
      const prelaunchConfigSnapshot = tryReadConfigFileSnapshot(env, logger, { stage: "review", taskId: task.id });
      if (
        prelaunchTask === null || prelaunchTask.status !== "review" ||
        executionSettingsFingerprint(prelaunchTask, config, "reviewer") !== settingsFingerprint ||
        !sameConfigSnapshot(configSnapshot, prelaunchConfigSnapshot)
      ) {
        notes.push(`${task.id}: reviewer設定/configがlaunch直前に変更されたため起動をスキップしました`);
        continue;
      }
      const nativeReviewerAdapter = pickNativeWorkerAdapter(deps, resolution.provider, useNativeReviewerLaunch);
      if (useNativeReviewerLaunch && nativeReviewerAdapter === null) {
        throw new Error("native communication adapter 未構成");
      }
      reviewerAdapter = nativeReviewerAdapter ?? pickLaunchAdapter(deps, resolution.provider, reviewTransport);
      attemptedAt = new Date().toISOString();
      ref = await reviewerAdapter.launch(prelaunchTask, {
        model: resolution.model,
        cwd,
        promptText,
        ...(resolution.effort !== undefined ? { effort: resolution.effort } : {}),
        ...(resolution.speed !== undefined ? { speed: resolution.speed } : {}),
        ...(reviewTransport === "bridge"
          ? {
              bridgePassthrough: {
                ...(requirements.model ? { model: true } : {}),
                ...(resolution.effort !== undefined ? { effort: true } : {}),
                ...(resolution.speed !== undefined ? { speed: true } : {}),
              },
            }
          : {}),
      } satisfies BridgeLaunchOptions) as BridgeLaunchSessionRef;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const redactedMessage = redactText(message);
      const indeterminate = isIndeterminateLaunchFailure(err);
      const probePayload = indeterminate
        ? await probeIndeterminateLaunch(deps, cwd, resolution.provider, attemptedAt)
        : null;
      const reason = indeterminate
        ? `${LAUNCH_INDETERMINATE_PREFIX}レビュー起動 (${redactedMessage})`
        : `auto-launch-failed: レビュー起動に失敗しました (${redactedMessage})`;
      const stale = store.transaction((): boolean => {
        const current = store.getTask(task.id);
        const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
          stage: "review-launch-failure",
          taskId: task.id,
        });
        if (
          current === null || current.status !== "review" ||
          executionSettingsFingerprint(current, config, "reviewer") !== settingsFingerprint ||
          !sameConfigSnapshot(configSnapshot, currentConfigSnapshot)
        ) {
          if (current !== null) {
            store.addEvent(task.id, "stale_launch_failure", SUPERVISOR_ACTOR, {
              role: "reviewer",
              error: redactedMessage,
            });
          }
          return true;
        }
        store.block(task.id, reason, SUPERVISOR_ACTOR, "human");
        store.addEvent(
          task.id,
          indeterminate ? "reviewer_launch_indeterminate" : "reviewer_launch_failed",
          SUPERVISOR_ACTOR,
          { error: redactedMessage, ...(probePayload ?? {}) },
        );
        return false;
      });
      logger.warn(stale ? "review: stale reviewer launch failureを検知しました" : "review: レビュー起動に失敗しました", {
        taskId: task.id,
        error: redactedMessage,
      });
      notes.push(
        stale
          ? `${task.id}: reviewer設定/config変更後のstale launch failureを記録しました`
          : `${task.id}: レビュー起動失敗 (${redactedMessage})`,
      );
      break;
    }

    const nativeMissing = !hasRequiredNativeDelivery(ref, deliveryRequirements, requireBridgeAppliedValues);
    let externalGenerationRead: ExternalRuntimeGenerationReadResult | null = null;
    const externalGenerationReader = (deps as StageDepsWithExternalRuntimeGenerationReader)
      .externalRuntimeGenerationReader;
    if (
      !nativeMissing && reviewTransport === "bridge" && !useNativeReviewerLaunch &&
      externalGenerationReader !== undefined && ref.runtimeGenerationAttestation !== undefined
    ) {
      try {
        externalGenerationRead = await externalGenerationReader.read(
          resolution.provider,
          Date.now(),
          ref.runtimeGenerationAttestation,
        );
      } catch {
        externalGenerationRead = { state: "unknown", code: "read_failed" };
      }
      if (externalGenerationRead.state === "unknown") {
        logger.warn("review: external runtime generation reviewer attestation をbindできません", {
          taskId: task.id,
          code: externalGenerationRead.code,
        });
      }
    }

    // launch 成功後、adapter.launch() の await 中に別 writer がタスクを遷移させていないかを
    // Tx 内で再検証する（dispatch.ts の起動後 orphan 検証と同型, 契約 §12.8-3）。
    let orphaned = false;
    store.transaction(() => {
      const current = store.getTask(task.id);
      const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, { stage: "review", taskId: task.id });
      if (
        current === null || current.status !== "review" ||
        executionSettingsFingerprint(current, config, "reviewer") !== settingsFingerprint ||
        !sameConfigSnapshot(configSnapshot, currentConfigSnapshot)
      ) {
        orphaned = true;
        store.addEvent(task.id, "orphan_session", SUPERVISOR_ACTOR, {
          sessionId: ref.sessionId,
          serverUrl: ref.serverUrl,
          role: "reviewer",
        });
        if (current !== null) {
          store.addComment(
            task.id,
            SUPERVISOR_ACTOR,
            redactText(
              `起動済みレビューセッションが孤児化しました: session=${ref.sessionId} server=${ref.serverUrl}（手動確認要）`,
            ),
          );
        }
        return;
      }
      const commitCancelGate = cancelledOpenRunForTaskOrWorktree(store, task.id, cwd);
      if (commitCancelGate !== null) {
        orphaned = true;
        store.addEvent(task.id, "orphan_session", SUPERVISOR_ACTOR, {
          sessionId: ref.sessionId,
          serverUrl: ref.serverUrl,
          role: "reviewer",
          reason: "cancel-fence-race",
          cancelledRunId: commitCancelGate.id,
        });
        return;
      }
      // capability preflightに加えて、実launch echoがnative deliveryを証明した場合だけrunへbindする。
      if (nativeMissing) {
        store.block(
          task.id,
          `needs-manual: reviewer native delivery 確認欠落 (session=${ref.sessionId})`,
          SUPERVISOR_ACTOR,
          "human",
        );
        store.addEvent(task.id, "execution_native_delivery_missing", SUPERVISOR_ACTOR, {
          role: "reviewer",
          sessionId: ref.sessionId,
          requirements: deliveryRequirements,
          modelDelivery: ref.modelDelivery,
          effortDelivery: ref.effortDelivery ?? "none",
          speedDelivery: ref.speedDelivery ?? "none",
          ...(ref.requestedMaxTurns !== undefined ? { requestedMaxTurns: ref.requestedMaxTurns } : {}),
          maxTurnsDelivery: ref.maxTurnsDelivery ?? "none",
          ...(ref.appliedModel !== undefined ? { appliedModel: ref.appliedModel } : {}),
          ...(ref.appliedEffort !== undefined ? { appliedEffort: ref.appliedEffort } : {}),
          ...(ref.appliedSpeed !== undefined ? { appliedSpeed: ref.appliedSpeed } : {}),
          ...(ref.appliedMaxTurns !== undefined ? { appliedMaxTurns: ref.appliedMaxTurns } : {}),
        });
        return;
      }
      const reviewerRun = store.startRun(task.id, resolution.provider, ref.sessionId, {
        role: "reviewer",
        profile: effectiveProfileName(task, config, "reviewer"),
        source: resolution.source,
        serverUrl: ref.serverUrl,
        model: resolution.model,
        modelDelivery: ref.modelDelivery,
        ...(resolution.effort !== undefined ? { effort: resolution.effort } : {}),
        ...(ref.effortDelivery !== undefined ? { effortDelivery: ref.effortDelivery } : {}),
        ...(resolution.speed !== undefined ? { speed: resolution.speed } : {}),
        ...(ref.speedDelivery !== undefined ? { speedDelivery: ref.speedDelivery } : {}),
        ...(ref.requestedMaxTurns !== undefined ? { requestedMaxTurns: ref.requestedMaxTurns } : {}),
        ...(ref.maxTurnsDelivery !== undefined ? { maxTurnsDelivery: ref.maxTurnsDelivery } : {}),
        ...(ref.appliedModel !== undefined ? { appliedModel: ref.appliedModel } : {}),
        ...(ref.appliedEffort !== undefined ? { appliedEffort: ref.appliedEffort } : {}),
        ...(ref.appliedSpeed !== undefined ? { appliedSpeed: ref.appliedSpeed } : {}),
        ...(ref.appliedMaxTurns !== undefined ? { appliedMaxTurns: ref.appliedMaxTurns } : {}),
        ...(ref.nativeCommunication === undefined ? {} : { nativeCommunication: ref.nativeCommunication }),
        ...(configSnapshot !== null ? { [CONFIG_FILE_SNAPSHOT_META_KEY]: configSnapshot } : {}),
        // 契約 §17.3: transport を run meta に記録する（後半 checkVerdicts の adapter 再選択の裏付け）。
        transport: reviewTransport,
      });
      if (
        externalGenerationRead?.state === "valid" &&
        externalGenerationRead.launchAttestation !== undefined &&
        isExternalRuntimeGenerationStore(store)
      ) {
        const boundAt = Date.now();
        const acceptance = store.acceptExternalRuntimeGenerationStatus(externalGenerationRead.sample, boundAt);
        if (acceptance === "accepted" || acceptance === "idempotent") {
          store.bindExternalRuntimeGenerationLaunch({
            taskId: task.id,
            runId: reviewerRun.id,
            sessionId: ref.sessionId,
            role: "reviewer",
            provider: resolution.provider,
            transport: reviewTransport,
            attestation: externalGenerationRead.launchAttestation,
            statusRevision: externalGenerationRead.sample.status.revision,
            statusDigest: externalGenerationRead.sample.canonicalDigest,
            boundAt,
          });
        }
      }
      if (useNativeReviewerLaunch) {
        const nativeBinding = persistNativeTargetBinding(store, {
          task,
          run: reviewerRun,
          ref,
          role: "reviewer",
          expectedCancelFence: 0,
          now: Math.floor(Date.now() / 1000),
        });
        if (nativeBinding.binding === null) {
          throw new Error(`reviewer native target bindingをrunへbindできません: ${nativeBinding.reason ?? "unknown"}`);
        }
      }
      store.addEvent(task.id, "reviewer_launched", SUPERVISOR_ACTOR, { sessionId: ref.sessionId });
    });

    if (orphaned) {
      if (ref.serverUrl === "direct") {
        await stopDirectSessionAndWarn(
          reviewerAdapter,
          ref,
          logger,
          task.id,
          "cancel fence 競合で孤児化した direct reviewer の exact stop",
        );
      } else {
        try {
          await reviewerAdapter.inject(ref, "【supervisor】reviewer起動後に設定/fence競合を検知したため直ちに終了してください。");
        } catch (error) {
          logger.warn("review: 孤児化したbridge reviewerへの中断注入に失敗しました", {
            taskId: task.id,
            sessionId: redactText(ref.sessionId),
            error: redactText(error instanceof Error ? error.message : String(error)),
          });
        }
      }
      logger.warn("review: レビューセッション起動後にタスクの状態が不整合でした（孤児化）", {
        taskId: task.id,
        sessionId: redactText(ref.sessionId),
      });
      notes.push(`${task.id}: レビューセッションが孤児化しました (sessionId=${redactText(ref.sessionId)})`);
      break;
    }

    if (nativeMissing) {
      if (ref.serverUrl === "direct") {
        await stopDirectSessionAndWarn(reviewerAdapter, ref, logger, task.id, "native delivery欠落sessionの中断（direct stop）");
      } else {
        try {
          await reviewerAdapter.inject(
            ref,
            "【supervisor】要求したmodel/effort/speedのnative deliveryを確認できないため、このreviewを中止してください。",
          );
        } catch (error) {
          logger.warn("review: native delivery欠落sessionの中断に失敗しました", {
            taskId: task.id,
            sessionId: redactText(ref.sessionId),
            error: redactText(error instanceof Error ? error.message : String(error)),
          });
        }
      }
      notes.push(`${task.id}: reviewer native delivery確認欠落のためfail-closedしました`);
      break;
    }

    notes.push(`${task.id}: レビューを起動しました (sessionId=${ref.sessionId})`);
    break;
  }

  return { actions, notes };
}

// ---------------------------------------------------------------------------
// rework（自動再作業）の起動（docs/contract.md §21.2）
// ---------------------------------------------------------------------------

/**
 * verdict fail の Tx（verdict_failed 記録 + reviewer run close）成功後、Tx 外で rework worker を起動する
 * （契約 §21.2）。resolveModel は worker と同じ解決（transport も尊重）を使う点が launchReviewers
 * （profiles['review'] 固定）と異なる。dispatch.ts / launchReviewers と同型の起動パターン
 * （プロンプト生成 → artifact 保存 → launch → 起動後 Tx で再検証しつつ状態遷移）を踏襲するが、
 * review ステージは claim を取らない文脈のため blockClaimedTask は使わない。
 */
async function launchRework(
  deps: StageDeps,
  initialTask: TaskRow,
  attempt: number,
  previousSummaryHash: string,
  redactedSummary: string,
  redactedIssues: string[],
): Promise<string> {
  const { store, env, logger } = deps;
  const reloadNotes: string[] = [];
  const config = reloadDispatchConfig(deps, reloadNotes);
  for (const note of reloadNotes) {
    logger.warn("review: rework config reload note", { taskId: initialTask.id, note });
  }
  const task = store.getTask(initialTask.id);
  if (task === null || task.status !== "review") {
    return `${initialTask.id}: rework対象がreview状態ではないため起動をスキップしました`;
  }

  // 契約 §21.2: worker と同じモデル解決（resolveModel(task, config)）。transport も同様に尊重する。
  const resolution = resolveExecution(task, config, "worker");
  if (!resolution.ok) {
    const reason = `user-decision: モデル解決に失敗 (${resolution.reason}: ${resolution.detail})`;
    store.block(task.id, reason, SUPERVISOR_ACTOR, "human");
    logger.warn("review: rework のモデル解決に失敗しました", { taskId: task.id, reason: resolution.reason });
    return `${task.id}: ${reason}`;
  }
  const cwd = extractCwd(task.body);
  if (cwd === null || !isAbsolute(cwd)) {
    const reason =
      cwd === null
        ? "needs-manual: rework 起動不能 (cwd 無し)"
        : `needs-manual: rework 起動不能 (cwd が絶対パスではありません: ${cwd})`;
    store.block(task.id, reason, SUPERVISOR_ACTOR, "human");
    return `${task.id}: ${reason}`;
  }
  const existingCancelGate = cancelledOpenRunForTaskOrWorktree(store, task.id, cwd);
  if (existingCancelGate !== null) {
    return `${task.id}: cancel stop 証拠待ち run#${existingCancelGate.id} のため rework 起動を拒否しました`;
  }

  const settingsFingerprint = executionSettingsFingerprint(task, config, "worker");
  const configSnapshot = tryReadConfigFileSnapshot(env, logger, { stage: "rework", taskId: task.id });
  const useNativeReworkLaunch = nativeLaunchSelected(config, resolution.provider, task.id);
  const requirements = bridgeLaunchRequirements(
    resolution,
    executionOverrideRequirements(task, "worker"),
    useNativeReworkLaunch,
  );
  const transportDecision = await resolveReviewLaunchTransport(deps, resolution, requirements);
  const reworkTransport = transportDecision.transport;
  const compatibility = await probeExecutionCompatibility(
    deps as StageDepsWithExecutionPreflight,
    config,
    resolution,
    reworkTransport,
    {
      ...requirements,
      model: true,
      maxTurns: reworkTransport === "bridge" && requirements.maxTurns === true,
    },
  );
  if (compatibility.status !== "supported") {
    const reason = compatibilityBlockReason(compatibility);
    const blocked = store.transaction((): boolean => {
      const current = store.getTask(task.id);
      const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
        stage: "rework",
        taskId: task.id,
      });
      if (
        current === null || current.status !== "review" ||
        executionSettingsFingerprint(current, config, "worker") !== settingsFingerprint ||
        !sameConfigSnapshot(configSnapshot, currentConfigSnapshot)
      ) {
        return false;
      }
      store.block(task.id, reason, SUPERVISOR_ACTOR, "human");
      store.addEvent(
        task.id,
        compatibilityEventType(compatibility),
        SUPERVISOR_ACTOR,
        compatibilityEventPayload("worker", resolution, reworkTransport, compatibility),
      );
      return true;
    });
    return blocked
      ? `${task.id}: rework ${reason}`
      : `${task.id}: rework設定/configがpreflight中に変更されたため古い互換性判定を破棄しました`;
  }
  const compatibilityRecorded = store.transaction((): boolean => {
    const current = store.getTask(task.id);
    const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
      stage: "rework",
      taskId: task.id,
    });
    if (
      current === null || current.status !== "review" ||
      executionSettingsFingerprint(current, config, "worker") !== settingsFingerprint ||
      !sameConfigSnapshot(configSnapshot, currentConfigSnapshot)
    ) {
      return false;
    }
    store.addEvent(
      task.id,
      "model_transport_compatibility_checked",
      SUPERVISOR_ACTOR,
      compatibilityEventPayload("worker", resolution, reworkTransport, compatibility),
    );
    return true;
  });
  if (!compatibilityRecorded) {
    return `${task.id}: rework設定がpreflight中に変更されたため起動をスキップしました`;
  }

  const runtimeStore = store as RuntimeResourceStore;
  const resourceGate = evaluateRuntimeResourceReworkGate(
    env.dbPath,
    task.id,
    cwd,
    Math.floor(Date.now() / 1000),
    currentRuntimeResources(deps),
  );
  if (resourceGate.status === "waiting" || resourceGate.status === "failed") {
    const reason = resourceGate.status === "failed"
      ? resourceGate.reason
      : `needs-manual: rework runtime resource 割当が成立していません (${resourceGate.reason})`;
    store.block(task.id, reason, SUPERVISOR_ACTOR, "human");
    return `${task.id}: ${reason}`;
  }
  const runtimeBindings: RuntimeResourceBinding[] = resourceGate.status === "ready" ? resourceGate.bindings : [];
  if (!validateRuntimeResourceBindings(
    runtimeStore,
    task.id,
    runtimeBindings,
    Math.floor(Date.now() / 1000),
    true,
    currentRuntimeResources(deps),
  )) {
    const reason = "needs-manual: rework runtime resource の fresh ownership/fence 検証に失敗しました";
    store.block(task.id, reason, SUPERVISOR_ACTOR, "human");
    return `${task.id}: ${reason}`;
  }

  let runtimeResources;
  try {
    runtimeResources = readRuntimeResourcePromptContext(env.dbPath, env.home, task, cwd, runtimeBindings);
  } catch {
    const reason = "needs-manual: rework runtime resource manifest/secret reference の検証に失敗しました";
    store.block(task.id, reason, SUPERVISOR_ACTOR, "human");
    return `${task.id}: ${reason}`;
  }
  const promptText = buildReworkPrompt(task, resolution.model, redactedSummary, redactedIssues, attempt, {
    transport: reworkTransport,
    ...(runtimeResources === undefined ? {} : { runtimeResources }),
  });

  // prompt artifact は launch 前に保存する（dispatch.ts / launchReviewers と同じ原子性方針, 契約 §12.6-3）。
  const nonce = newNonce();
  try {
    saveReworkPromptArtifact(env, task.id, attempt, nonce, promptText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("review: rework prompt artifact 保存に失敗しました。起動をスキップします", {
      taskId: task.id,
      error: redactText(message),
    });
    return `${task.id}: rework prompt artifact 保存失敗のため起動スキップ (${redactText(message)})`;
  }

  let ref: BridgeLaunchSessionRef;
  let launchAdapter: WorkerAdapter;
  let attemptedAt = new Date().toISOString();
  if (!validateRuntimeResourceBindings(
    runtimeStore,
    task.id,
    runtimeBindings,
    Math.floor(Date.now() / 1000),
    true,
    currentRuntimeResources(deps),
  )) {
    const reason = "needs-manual: rework launch 直前の runtime resource ownership/fence 検証に失敗しました";
    store.block(task.id, reason, SUPERVISOR_ACTOR, "human");
    return `${task.id}: ${reason}`;
  }
  try {
    const prelaunchCancelGate = cancelledOpenRunForTaskOrWorktree(store, task.id, cwd);
    if (prelaunchCancelGate !== null) {
      return `${task.id}: launch 直前に cancel stop 証拠待ち run#${prelaunchCancelGate.id} を検知したため rework 起動を拒否しました`;
    }
    const prelaunchTask = store.getTask(task.id);
    const prelaunchConfigSnapshot = tryReadConfigFileSnapshot(env, logger, { stage: "rework", taskId: task.id });
    if (
      prelaunchTask === null || prelaunchTask.status !== "review" ||
      executionSettingsFingerprint(prelaunchTask, config, "worker") !== settingsFingerprint ||
      !sameConfigSnapshot(configSnapshot, prelaunchConfigSnapshot)
    ) {
      return `${task.id}: rework設定/configがlaunch直前に変更されたため起動をスキップしました`;
    }
    const nativeReworkAdapter = pickNativeWorkerAdapter(deps, resolution.provider, useNativeReworkLaunch);
    if (useNativeReworkLaunch && nativeReworkAdapter === null) {
      throw new Error("native communication adapter 未構成");
    }
    launchAdapter = nativeReworkAdapter ?? pickLaunchAdapter(deps, resolution.provider, reworkTransport);
    attemptedAt = new Date().toISOString();
    ref = await launchAdapter.launch(prelaunchTask, {
      model: resolution.model,
      cwd,
      promptText,
      ...(resolution.effort !== undefined ? { effort: resolution.effort } : {}),
      ...(resolution.speed !== undefined ? { speed: resolution.speed } : {}),
      ...(reworkTransport === "bridge"
        ? {
            bridgePassthrough: {
              ...(requirements.model ? { model: true } : {}),
              ...(resolution.effort !== undefined ? { effort: true } : {}),
              ...(resolution.speed !== undefined ? { speed: true } : {}),
            },
          }
        : {}),
    } satisfies BridgeLaunchOptions) as BridgeLaunchSessionRef;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const redactedMessage = redactText(message);
    const indeterminate = isIndeterminateLaunchFailure(err);
    const probePayload = indeterminate
      ? await probeIndeterminateLaunch(deps, cwd, resolution.provider, attemptedAt)
      : null;
    const reason = indeterminate
      ? `${LAUNCH_INDETERMINATE_PREFIX}rework 起動 (${redactedMessage})`
      : `auto-launch-failed: rework 起動に失敗しました (${redactedMessage})`;
    // review ステージは claim を取らない文脈のため blockClaimedTask は使わず、launchReviewers 既存の
    // 起動失敗パターン（Tx 内で block + イベント記録）に合わせる。
    const stale = store.transaction((): boolean => {
      const current = store.getTask(task.id);
      const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
        stage: "rework-launch-failure",
        taskId: task.id,
      });
      if (
        current === null || current.status !== "review" ||
        executionSettingsFingerprint(current, config, "worker") !== settingsFingerprint ||
        !sameConfigSnapshot(configSnapshot, currentConfigSnapshot)
      ) {
        if (current !== null) {
          store.addEvent(task.id, "stale_launch_failure", SUPERVISOR_ACTOR, {
            role: "rework",
            attempt,
            error: redactedMessage,
          });
        }
        return true;
      }
      store.block(task.id, reason, SUPERVISOR_ACTOR, "human");
      store.addEvent(
        task.id,
        indeterminate ? "rework_launch_indeterminate" : "rework_launch_failed",
        SUPERVISOR_ACTOR,
        { error: redactedMessage, attempt, ...(probePayload ?? {}) },
      );
      return false;
    });
    logger.warn(stale ? "review: stale rework launch failureを検知しました" : "review: rework 起動に失敗しました", {
      taskId: task.id,
      error: redactedMessage,
    });
    return stale
      ? `${task.id}: rework設定/config変更後のstale launch failureを記録しました`
      : `${task.id}: rework 起動失敗 (${redactedMessage})`;
  }

  const requireBridgeAppliedValues = reworkTransport === "bridge" && !useNativeReworkLaunch;
  const deliveryRequirements = bridgeNativeDeliveryRequirements(resolution);
  const nativeMissing = !hasRequiredNativeDelivery(ref, deliveryRequirements, requireBridgeAppliedValues);
  let externalGenerationRead: ExternalRuntimeGenerationReadResult | null = null;
  const externalGenerationReader = (deps as StageDepsWithExternalRuntimeGenerationReader)
    .externalRuntimeGenerationReader;
  if (
    !nativeMissing && reworkTransport === "bridge" && !useNativeReworkLaunch &&
    externalGenerationReader !== undefined && ref.runtimeGenerationAttestation !== undefined
  ) {
    try {
      externalGenerationRead = await externalGenerationReader.read(
        resolution.provider,
        Date.now(),
        ref.runtimeGenerationAttestation,
      );
    } catch {
      externalGenerationRead = { state: "unknown", code: "read_failed" };
    }
    if (externalGenerationRead.state === "unknown") {
      logger.warn("review: external runtime generation rework attestation をbindできません", {
        taskId: task.id,
        code: externalGenerationRead.code,
      });
    }
  }

  // launch 成功後、adapter.launch() の await 中に別 writer がタスクを遷移させていないかを
  // Tx 内で再検証する（契約 §21.2: status='review' と reviewer run の close を再検証してから遷移する）。
  let orphaned = false;
  let bindFailure: string | null = null;
  try {
    store.transaction(() => {
      const current = store.getTask(task.id);
      const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, { stage: "rework", taskId: task.id });
      const stillReworkable =
        current !== null && current.status === "review" &&
        executionSettingsFingerprint(current, config, "worker") === settingsFingerprint &&
        sameConfigSnapshot(configSnapshot, currentConfigSnapshot) &&
        getLatestOpenReviewerRun(store, task.id) === null;
      if (!stillReworkable) {
        orphaned = true;
        store.addEvent(task.id, "orphan_session", SUPERVISOR_ACTOR, {
          sessionId: ref.sessionId,
          serverUrl: ref.serverUrl,
          role: "rework",
        });
        if (current !== null) {
          store.addComment(
            task.id,
            SUPERVISOR_ACTOR,
            redactText(
              `起動済み rework セッションが孤児化しました: session=${ref.sessionId} server=${ref.serverUrl}（手動確認要）`,
            ),
          );
        }
        return;
      }
      const commitCancelGate = cancelledOpenRunForTaskOrWorktree(store, task.id, cwd);
      if (commitCancelGate !== null) {
        orphaned = true;
        store.addEvent(task.id, "orphan_session", SUPERVISOR_ACTOR, {
          sessionId: ref.sessionId,
          serverUrl: ref.serverUrl,
          role: "rework",
          reason: "cancel-fence-race",
          cancelledRunId: commitCancelGate.id,
        });
        return;
      }

      // 実launch echoが要求値のnative deliveryを証明できないsessionは、旧worker resourceを
      // rebindせず手動確認へ隔離する。
      if (nativeMissing) {
        store.block(
          task.id,
          `needs-manual: rework native delivery 確認欠落 (session=${ref.sessionId})`,
          SUPERVISOR_ACTOR,
          "human",
        );
        store.addEvent(task.id, "execution_native_delivery_missing", SUPERVISOR_ACTOR, {
          role: "rework",
          sessionId: ref.sessionId,
          requirements: deliveryRequirements,
          modelDelivery: ref.modelDelivery,
          effortDelivery: ref.effortDelivery ?? "none",
          speedDelivery: ref.speedDelivery ?? "none",
          ...(ref.requestedMaxTurns !== undefined ? { requestedMaxTurns: ref.requestedMaxTurns } : {}),
          maxTurnsDelivery: ref.maxTurnsDelivery ?? "none",
          ...(ref.appliedModel !== undefined ? { appliedModel: ref.appliedModel } : {}),
          ...(ref.appliedEffort !== undefined ? { appliedEffort: ref.appliedEffort } : {}),
          ...(ref.appliedSpeed !== undefined ? { appliedSpeed: ref.appliedSpeed } : {}),
          ...(ref.appliedMaxTurns !== undefined ? { appliedMaxTurns: ref.appliedMaxTurns } : {}),
        });
        return;
      }

      if (!validateRuntimeResourceBindings(
        runtimeStore,
        task.id,
        runtimeBindings,
        Math.floor(Date.now() / 1000),
        true,
        currentRuntimeResources(deps),
      )) {
        throw new Error("rework run bind transaction の runtime resource 再検証に失敗しました");
      }
      const run = store.startRun(task.id, resolution.provider, ref.sessionId, {
        role: "rework",
        profile: effectiveProfileName(task, config, "worker"),
        source: resolution.source,
        serverUrl: ref.serverUrl,
        model: resolution.model,
        modelDelivery: ref.modelDelivery,
        transport: reworkTransport,
        reworkAttempt: attempt,
        ...(resolution.effort !== undefined ? { effort: resolution.effort } : {}),
        ...(ref.effortDelivery !== undefined ? { effortDelivery: ref.effortDelivery } : {}),
        ...(resolution.speed !== undefined ? { speed: resolution.speed } : {}),
        ...(ref.speedDelivery !== undefined ? { speedDelivery: ref.speedDelivery } : {}),
        ...(ref.requestedMaxTurns !== undefined ? { requestedMaxTurns: ref.requestedMaxTurns } : {}),
        ...(ref.maxTurnsDelivery !== undefined ? { maxTurnsDelivery: ref.maxTurnsDelivery } : {}),
        ...(ref.appliedModel !== undefined ? { appliedModel: ref.appliedModel } : {}),
        ...(ref.appliedEffort !== undefined ? { appliedEffort: ref.appliedEffort } : {}),
        ...(ref.appliedSpeed !== undefined ? { appliedSpeed: ref.appliedSpeed } : {}),
        ...(ref.appliedMaxTurns !== undefined ? { appliedMaxTurns: ref.appliedMaxTurns } : {}),
        ...(ref.nativeCommunication === undefined ? {} : { nativeCommunication: ref.nativeCommunication }),
        ...(configSnapshot !== null ? { [CONFIG_FILE_SNAPSHOT_META_KEY]: configSnapshot } : {}),
      });
      if (
        externalGenerationRead?.state === "valid" &&
        externalGenerationRead.launchAttestation !== undefined &&
        isExternalRuntimeGenerationStore(store)
      ) {
        const boundAt = Date.now();
        const acceptance = store.acceptExternalRuntimeGenerationStatus(externalGenerationRead.sample, boundAt);
        if (acceptance === "accepted" || acceptance === "idempotent") {
          store.bindExternalRuntimeGenerationLaunch({
            taskId: task.id,
            runId: run.id,
            sessionId: ref.sessionId,
            role: "worker",
            provider: resolution.provider,
            transport: reworkTransport,
            attestation: externalGenerationRead.launchAttestation,
            statusRevision: externalGenerationRead.sample.status.revision,
            statusDigest: externalGenerationRead.sample.canonicalDigest,
            boundAt,
          });
        }
      }
      if (useNativeReworkLaunch) {
        const nativeBinding = persistNativeTargetBinding(store, {
          task,
          run,
          ref,
          role: "worker",
          expectedCancelFence: 0,
          now: Math.floor(Date.now() / 1000),
        });
        if (nativeBinding.binding === null) {
          throw new Error(`rework native target bindingをrunへbindできません: ${nativeBinding.reason ?? "unknown"}`);
        }
      }
      for (const binding of runtimeBindings) {
        const reboundLease = runtimeStore.rebindRuntimeResourceLeaseRun({
          leaseId: binding.leaseId,
          expectedFence: binding.fence,
          expectedOwnerRunId: binding.ownerRunId,
          runId: run.id,
          actor: SUPERVISOR_ACTOR,
        });
        if (!synchronizeRuntimeResourceManifestFence(env.home, reboundLease)) {
          throw new Error("runtime resource rebind後の manifest fence 同期に失敗しました");
        }
      }
      // review → blocked（in-progress reason、通常の worker と同書式。契約 §21.2）
      store.transition({
        taskId: task.id,
        to: "blocked",
        reason: buildInProgressReason(ref, task.title),
        actor: SUPERVISOR_ACTOR,
        eventType: "rework_launched",
        payload: { sessionId: ref.sessionId, attempt, previousSummaryHash },
      });
    });
  } catch (error) {
    bindFailure = redactText(error instanceof Error ? error.message : String(error));
    store.transaction(() => {
      store.addEvent(task.id, "orphan_session", SUPERVISOR_ACTOR, {
        sessionId: ref.sessionId,
        serverUrl: ref.serverUrl,
        role: "rework",
        reason: bindFailure,
      });
      const current = store.getTask(task.id);
      if (current?.status === "review") {
        store.block(
          task.id,
          `needs-manual: rework runtime resource bind に失敗しました (${bindFailure})`,
          SUPERVISOR_ACTOR,
          "human",
        );
      }
    });
  }

  if (bindFailure !== null) {
    logger.warn("review: rework resource bind 失敗によりセッションが孤児化しました", {
      taskId: task.id,
      sessionId: redactText(ref.sessionId),
      error: bindFailure,
    });
    return `${task.id}: rework runtime resource bind 失敗でセッションが孤児化しました (sessionId=${redactText(ref.sessionId)})`;
  }

  if (nativeMissing && !orphaned) {
    if (ref.serverUrl === "direct") {
      await stopDirectSessionAndWarn(launchAdapter, ref, logger, task.id, "rework native delivery欠落sessionの中断（direct stop）");
    } else {
      try {
        await launchAdapter.inject(
          ref,
          "【supervisor】要求したmodel/effort/speedのnative deliveryを確認できないため、このreworkを中止してください。",
        );
      } catch (error) {
        logger.warn("review: rework native delivery欠落sessionの中断に失敗しました", {
          taskId: task.id,
          sessionId: redactText(ref.sessionId),
          error: redactText(error instanceof Error ? error.message : String(error)),
        });
      }
    }
    return `${task.id}: rework native delivery確認欠落のためfail-closedしました`;
  }

  if (orphaned) {
    if (ref.serverUrl === "direct") {
      await stopDirectSessionAndWarn(
        launchAdapter,
        ref,
        logger,
        task.id,
        "cancel fence 競合で孤児化した direct rework の exact stop",
      );
    } else {
      try {
        await launchAdapter.inject(ref, "【supervisor】rework起動後に設定/fence競合を検知したため直ちに終了してください。");
      } catch (error) {
        logger.warn("review: 孤児化したbridge reworkへの中断注入に失敗しました", {
          taskId: task.id,
          sessionId: redactText(ref.sessionId),
          error: redactText(error instanceof Error ? error.message : String(error)),
        });
      }
    }
    logger.warn("review: rework セッション起動後にタスクの状態が不整合でした（孤児化）", {
      taskId: task.id,
      sessionId: redactText(ref.sessionId),
    });
    return `${task.id}: rework セッションが孤児化しました (sessionId=${redactText(ref.sessionId)})`;
  }

  return `${task.id}: rework を起動しました (attempt=${attempt}, sessionId=${ref.sessionId})`;
}

// ---------------------------------------------------------------------------
// 後半: verdict の検証遷移（docs/contract.md §15.2）
// ---------------------------------------------------------------------------

async function checkVerdicts(deps: StageDeps, apply: boolean, now: number): Promise<{ actions: number; notes: string[] }> {
  const { store, config, env, logger } = deps;
  const configuredReworkLaunches =
    (config as StageDeps["config"] & ConfigWithReview).review?.maxReworkLaunches ?? DEFAULT_REWORK_MAX_LAUNCHES;
  const maxReworkLaunches = Math.min(configuredReworkLaunches, DEFAULT_REWORK_MAX_LAUNCHES);
  const notes: string[] = [];
  let actions = 0;

  for (const task of store.listByStatus("review")) {
    const ref = reconstructReviewerSessionRef(store, task.id);
    if (ref === null) {
      continue; // まだレビュアーが起動していない（前半の対象）
    }
    const cancelRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
    if (cancelRun !== null && cancellationForRun(store, cancelRun.id) !== null) {
      notes.push(`${task.id}: cancel fence 後の review mutation を拒否しました`);
      continue;
    }

    // 契約 §17.3: ref.serverUrl==="direct" の reviewer run は direct adapter へルーティングする。
    let adapter: WorkerAdapter;
    try {
      adapter = pickAdapter(deps, ref);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("review: adapter 選択に失敗しました", { taskId: task.id, error: redactText(message) });
      notes.push(`${task.id}: レビュー adapter選択エラー`);
      continue;
    }

    let status: SessionStatus;
    try {
      status = await adapter.status(ref);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("review: レビューセッションの status 取得に失敗しました", {
        taskId: task.id,
        error: redactText(message),
      });
      notes.push(`${task.id}: レビュー status 取得エラー`);
      continue;
    }

    const observedResultWatermark = sessionStatusResultWatermark(status);
    const nudgeState = latestVerdictNudgeState(store, task.id, ref.sessionId);
    const nudgePayload = nudgeState.payload;
    if (nudgeState.recorded && nudgePayload === null) {
      actions += 1;
      notes.push(`${task.id}: verdict_nudge_sent payload 不正`);
      if (apply) {
        await finalizeMissingVerdict(deps, task, ref, adapter, status, { cause: "parse_invalid" });
      }
      continue;
    }
    if (nudgePayload !== null && observedResultWatermark <= nudgePayload.baselineResultWatermark) {
      const elapsedSeconds = now - nudgePayload.ts;
      if (elapsedSeconds < VERDICT_NUDGE_GRACE_SECONDS) {
        notes.push(`${task.id}: verdict nudge の新result待機中`);
        continue;
      }

      actions += 1;
      notes.push(`${task.id}: verdict nudge grace 超過`);
      if (apply) {
        await finalizeMissingVerdict(deps, task, ref, adapter, status, {
          cause: "model_output_missing",
          terminalEvent: "verdict_nudge_expired",
        });
      }
      continue;
    }

    // 実 bridge の /api/status には終端状態が無いため、「idle かつ type:"result" イベントが
    // 1件以上存在する」を turn 完了とみなす（docs/contract.md §13.4）。ただし nudge の grace は
    // turn 完了状態に関係なく上で評価し、active/0-result のまま停止した session も回収する。
    if (status.state !== "idle" || (status.resultCount ?? 0) < 1) {
      continue; // まだレビュー完了していない
    }

    let transcript: string;
    try {
      transcript = await adapter.fetchTranscript(ref);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("review: transcript取得に失敗しました", { taskId: task.id, error: redactText(message) });
      notes.push(`${task.id}: レビュー transcript取得エラー`);

      // 有界リトライ（契約 §15.2, §12.16-1 と同型）: 同一 sessionId の transcript_fetch_failed が
      // 閾値に達したら open run を failed で close し needs-manual へ強制退避する。
      const priorFailures = store
        .listEvents(task.id, "transcript_fetch_failed")
        .filter((event) => extractEventSessionId(event.payload) === ref.sessionId);
      const alreadyReported = priorFailures.length > 0;
      const failureCountAfterThisTick = priorFailures.length + 1;
      const thresholdReached = failureCountAfterThisTick >= TRANSCRIPT_FETCH_FAILURE_THRESHOLD;

      actions += 1;

      if (apply) {
        if (thresholdReached) {
          const endStats = await fetchEndRunStats(adapter, ref, logger, task.id, "review");
          try {
            store.transaction(() => {
              assertStillTargetReviewerSession(store, task.id, ref.sessionId);

              store.addEvent(task.id, "transcript_fetch_failed", SUPERVISOR_ACTOR, { sessionId: ref.sessionId });

              const openRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
              if (openRun !== null) {
                store.endRun(openRun.id, "failed", buildEndRunMeta(openRun, endStats));
              }

              store.block(
                task.id,
                `needs-manual: レビュー transcript 取得不能 (session=${ref.sessionId})`,
                SUPERVISOR_ACTOR,
                "human",
              );
            });
          } catch (txErr) {
            if (txErr instanceof StaleReviewAbort) {
              recordStaleReviewSkipped(store, logger, task.id, ref.sessionId, "transcript_fetch_exhausted");
              continue;
            }
            throw txErr;
          }
          await cleanupDirectReviewerProcessGroup(adapter, ref, logger, task.id);
        } else {
          try {
            store.transaction(() => {
              assertStillTargetReviewerSession(store, task.id, ref.sessionId);

              store.addEvent(task.id, "transcript_fetch_failed", SUPERVISOR_ACTOR, { sessionId: ref.sessionId });
              if (!alreadyReported) {
                store.addComment(
                  task.id,
                  SUPERVISOR_ACTOR,
                  redactText(`レビュー完了確認中に transcript の取得に失敗しました: ${message}`),
                );
              }
            });
          } catch (txErr) {
            if (txErr instanceof StaleReviewAbort) {
              recordStaleReviewSkipped(store, logger, task.id, ref.sessionId, "transcript_fetch_retry");
              continue;
            }
            throw txErr;
          }
        }
      } else {
        if (thresholdReached) {
          notes.push(
            `dry-run: ${task.id} transcript_fetch_failed 記録予定 (session=${ref.sessionId}) + needs-manual 付替予定`,
          );
        } else {
          notes.push(
            `dry-run: ${task.id} transcript_fetch_failed 記録予定 (session=${ref.sessionId})${
              alreadyReported ? "" : " + コメント記録予定"
            }`,
          );
        }
      }
      continue;
    }

    const extraction = extractAssistantFence({
      transcript,
      ...(status.raw !== undefined ? { structuredStatusRaw: status.raw } : {}),
      ...(ref.serverUrl === "direct" ? { assistantOnlyOutput: true } : {}),
      spec: { label: "hachi-verdict-v1", isSchemaValid: isVerdictSchema },
    });
    const hasValidStructuredResult =
      extraction.kind === "candidate" &&
      extraction.source === "structured_result" &&
      extraction.structuredSuccess === true;
    const earlyFailure: ClassifiedExecutionFailure | null =
      hasValidStructuredResult || isFenceForTask(extraction, task.id)
      ? null
      : classifyExecutionFailure(
          status,
          transcript,
          ref.serverUrl === "direct"
            ? "direct_assistant_output"
            : ref.serverUrl.trim() !== ""
              ? "bridge_transcript"
              : "unknown",
        );
    if (earlyFailure !== null) {
      actions += 1;
      notes.push(`${task.id}: ${earlyFailure.reason} として分類`);
      if (apply) {
        await finalizeClassifiedReviewOutputFailure(
          deps,
          task,
          ref,
          adapter,
          transcript,
          earlyFailure,
          status,
        );
      }
      continue;
    }

    const recoverableStructuredParseFailure =
      extraction.kind === "failure" &&
      extraction.reason === "parse_invalid" &&
      ref.serverUrl !== "direct" &&
      hasSuccessfulStructuredAssistantResult(status.raw);
    if (extraction.kind === "failure" && !recoverableStructuredParseFailure) {
      actions += 1;
      notes.push(`${task.id}: ${extraction.reason} として分類`);
      if (apply) {
        await finalizeClassifiedReviewOutputFailure(
          deps,
          task,
          ref,
          adapter,
          transcript,
          extraction,
          status,
        );
      }
      continue;
    }

    const verdict = extraction.kind === "candidate" ? parseVerdict(extraction.raw, task.id) : null;

    actions += 1;

    if (verdict === null) {
      logger.warn("review: hachi-verdict-v1 ブロックが検出できません/不正です", { taskId: task.id });
      notes.push(`${task.id}: verdict欠如/不正`);
      const cause: VerdictMissingCause = extraction.kind === "missing" ? "model_output_missing" : "parse_invalid";

      if (!nudgeState.recorded && ref.serverUrl !== "direct" && hasSuccessfulStructuredAssistantResult(status.raw)) {
        if (!apply) {
          notes.push(`dry-run: ${task.id} verdict_nudge_sent 記録予定 (session=${ref.sessionId})`);
          continue;
        }

        try {
          // 外部副作用の直前に task/run/session fence を再検証する。
          assertStillTargetReviewerSession(store, task.id, ref.sessionId);
          await adapter.inject(ref, VERDICT_NUDGE_MESSAGE);
        } catch (err) {
          if (err instanceof StaleReviewAbort) {
            recordStaleReviewSkipped(store, logger, task.id, ref.sessionId, "verdict_nudge_preflight");
            continue;
          }
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("review: verdict nudge 注入に失敗しました", {
            taskId: task.id,
            sessionId: ref.sessionId,
            error: redactText(message),
          });
          notes.push(`${task.id}: verdict nudge 注入失敗`);
          await finalizeMissingVerdict(deps, task, ref, adapter, status, {
            cause,
            transcript,
            terminalEvent: "verdict_nudge_failed",
            diagnostic: message,
          });
          continue;
        }

        try {
          store.transaction(() => {
            assertStillTargetReviewerSession(store, task.id, ref.sessionId);
            store.addEvent(task.id, "verdict_nudge_sent", SUPERVISOR_ACTOR, {
              sessionId: ref.sessionId,
              ts: now,
              baselineResultWatermark: observedResultWatermark,
              baselineLastResultId: sessionStatusLastResultId(status),
              baselineResultCount: status.resultCount ?? 0,
            });
          });
        } catch (err) {
          if (err instanceof StaleReviewAbort) {
            recordStaleReviewSkipped(store, logger, task.id, ref.sessionId, "verdict_nudge_sent");
            continue;
          }
          throw err;
        }
        notes.push(`${task.id}: verdict fence 再出力を注入`);
        continue;
      }

      if (apply) {
        await finalizeMissingVerdict(deps, task, ref, adapter, status, { cause, transcript });
      }
      continue;
    }

    // transcript は best-effort で保存する（契約 §15.2）。保存失敗が verdict 適用を妨げない。
    try {
      saveReviewTranscriptArtifact(env, task.id, ref.sessionId, transcript);
    } catch (err) {
      const saveErrorMessage = err instanceof Error ? err.message : String(err);
      logger.warn("review: transcript の artifact 保存に失敗しました", {
        taskId: task.id,
        error: redactText(saveErrorMessage),
      });
    }

    notes.push(`${task.id}: verdict検証OK (verdict=${verdict.verdict} confidence=${verdict.confidence})`);

    if (!apply) {
      if (verdict.verdict === "pass" && verdict.confidence === "high") {
        notes.push(`dry-run: ${resolveVerifyPlan(deps, task).note}`);
      }
      continue;
    }

    const endStats = await fetchEndRunStats(adapter, ref, logger, task.id, "review");
    const redactedSummary = redactText(verdict.summary);
    let verifyMeta: VerifyMeta | null = null;
    let failureSource: "verdict" | "verify" | null = null;
    let failureSummary = "";
    let failureRedactedSummary = "";
    let failureIssues: string[] = [];
    let failureRedactedIssues: string[] = [];
    let failureSummaryHash = "";
    let failureCause: ReviewFailureCause | null = null;
    let failureCauseSource: ReviewFailureCauseSource | null = null;
    let verifyEnvironmentFailure: VerifyEvidence | null = null;
    let verifyRetryEvidence: VerifyRetryEvidence | null = null;

    if (verdict.verdict === "pass" && verdict.confidence === "high") {
      try {
        // verify は外部コマンド実行を伴うため、実行直前にも対象 reviewer run を再検証する。
        assertStillTargetReviewerSession(store, task.id, ref.sessionId);
      } catch (err) {
        if (err instanceof StaleReviewAbort) {
          recordStaleReviewSkipped(store, logger, task.id, ref.sessionId, "verify_preflight");
          continue;
        }
        throw err;
      }
      const verifyPlan = resolveVerifyPlan(deps, task);
      notes.push(verifyPlan.note);
      verifyMeta = await executeVerifyPlan(deps, verifyPlan);
      if (isVerifyEnvironmentFailure(verifyMeta)) {
        verifyEnvironmentFailure = verifyMeta;
      } else if (isVerifyFailure(verifyMeta)) {
        const evidence = verifyMeta;
        failureSource = "verify";
        failureSummary = buildVerifyFailureSummary(evidence);
        failureRedactedSummary = redactText(failureSummary);
        failureIssues = buildVerifyFailureIssues(evidence);
        failureRedactedIssues = failureIssues.map((issue) => redactText(issue));
        failureSummaryHash = sha256Hex(failureSummary).slice(0, 8);
        // 失敗テストだけを再実行し、flake（environment_evidence）か再現（worker_local）かを判定する
        // （このタスクの要求。契約 §39.2 の既存 worker_local 経路自体は変更しない）。
        const retryClassification = await classifyVerifyFailure(deps, evidence);
        failureCause = retryClassification.failureCause;
        verifyRetryEvidence = retryClassification.verifyRetry;
        failureCauseSource = "verify";
      }
    } else if (verdict.verdict === "fail") {
      failureSource = "verdict";
      failureSummary = verdict.summary;
      failureRedactedSummary = redactedSummary;
      failureIssues = verdict.issues;
      failureRedactedIssues = verdict.issues.map((issue) => redactText(issue));
      // 契約 §21.1: summaryHash は redaction 前の生 summary から算出する（no-progress 判定の精度を
      // redaction による衝突で落とさないため。ハッシュ自体は8hexのみで生値を復元できない）。
      failureSummaryHash = sha256Hex(verdict.summary).slice(0, 8);
      failureCause = verdict.failureCause ?? "unknown";
      failureCauseSource = verdict.failureCauseSource;
    }

    let reworkDecision: ReworkDecision | null = null;
    let reworkAttempt = 0;

    try {
      store.transaction(() => {
        // Tx 冒頭の最終再検証（契約 §15.2, §12.12-1 と同型）。fetchTranscript / verify を待つ間にタスクが
        // 再遷移していた場合、stale verdict を誤適用しない。
        assertStillTargetReviewerSession(store, task.id, ref.sessionId);

        const openRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
        const passingFinalization =
          verdict.verdict === "pass" &&
          verdict.confidence === "high" &&
          failureSource === null &&
          verifyEnvironmentFailure === null;
        const extraMeta: Record<string, unknown> = verifyMeta === null ? {} : { verify: verifyMeta };

        // §63.2: F3は completedAt >= reviewer endedAt を要求する。pass確定では同一Tx内でrunを先に
        // closeし、その後taskをdoneへ遷移することで、nowSecondsの秒境界を跨いでも順序を保証する。
        // 後続transitionが失敗した場合はtransaction全体がrollbackされる。
        if (passingFinalization && openRun !== null) {
          store.endRun(openRun.id, "done", buildEndRunMeta(openRun, endStats, extraMeta));
        }

        if (passingFinalization) {
          store.addComment(task.id, SUPERVISOR_ACTOR, `レビュー結果: pass (confidence=high)\n${redactedSummary}`);
          store.transition({
            taskId: task.id,
            to: "done",
            actor: SUPERVISOR_ACTOR,
            eventType: "verdict_finalized",
            payload: { sessionId: ref.sessionId, verdict: verdict.verdict, confidence: verdict.confidence },
          });
        } else if (verdict.verdict === "pass" && verdict.confidence !== "high") {
          store.block(
            task.id,
            `user-decision: レビュー pass (confidence=${verdict.confidence}) 人間確認要`,
            SUPERVISOR_ACTOR,
            "human",
          );
        } else if (verifyEnvironmentFailure !== null) {
          // 契約 §39.2: toolchain 解決失敗はコード品質指摘と分離し、同じ worker を rework しない。
          store.addEvent(task.id, "verify_environment_failed", SUPERVISOR_ACTOR, {
            sessionId: ref.sessionId,
            exitCode: verifyEnvironmentFailure.exitCode,
            runtimePathSource: verifyEnvironmentFailure.runtimePathSource ?? VERIFY_RUNTIME_PATH_SOURCE,
          });
          store.block(
            task.id,
            `review-required: verify_environment_failed (${verifyResultLabel(verifyEnvironmentFailure)})`,
            SUPERVISOR_ACTOR,
            "human",
          );
        } else if (failureSource !== null && failureCause !== null && failureCauseSource !== null) {
          // 契約 §21.1 / §39.2: 同じ worker を自動 rework できるのは worker_local の1回だけ。
          // legacy/未知・非worker・重大workerは同じroutingを起動せず、orchestrator回収へ倒す。
          const priorReworkCount = store.listEvents(task.id, "rework_launched").length;
          const priorLocalFailures = store.listEvents(task.id, "verdict_failed")
            .map((event) => parseRecordedReviewFailure(event.payload))
            .filter((event): event is RecordedReviewFailure => event?.failureCause === "worker_local");
          const lastLocalSummaryHash = priorLocalFailures.at(-1)?.summaryHash ?? null;

          if (failureCause === "worker_major") {
            reworkDecision = "replacement-required";
          } else if (failureCause !== "worker_local") {
            reworkDecision = "orchestrator-review-required";
          } else if (priorReworkCount >= maxReworkLaunches) {
            reworkDecision = "replacement-required";
          } else if (lastLocalSummaryHash !== null && lastLocalSummaryHash === failureSummaryHash) {
            reworkDecision = "no-progress";
          } else {
            reworkDecision = "rework";
            reworkAttempt = priorReworkCount + 1;
          }

          store.addEvent(task.id, "verdict_failed", SUPERVISOR_ACTOR, {
            sessionId: ref.sessionId,
            summaryHash: failureSummaryHash,
            issueCount: failureIssues.length,
            source: failureSource,
            failureCause,
            failureCauseSource,
            modelFailureCounted: failureCause === "worker_local" || failureCause === "worker_major",
            routingAction: routingActionForDecision(reworkDecision),
            ...(verifyRetryEvidence === null ? {} : { verifyRetry: verifyRetryEvidence }),
          });
          if (failureCause === "worker_local" || failureCause === "worker_major") {
            recordReviewFailureLesson(
              store,
              task,
              failureSource,
              failureRedactedSummary,
              failureRedactedIssues,
            );
          }

          if (reworkDecision === "no-progress") {
            store.addEvent(task.id, "rework_no_progress", SUPERVISOR_ACTOR, {
              sessionId: ref.sessionId,
              summaryHash: failureSummaryHash,
              failureCause,
              routingAction: routingActionForDecision(reworkDecision),
            });
          }

          if (reworkDecision !== "rework") {
            store.block(
              task.id,
              reviewRequiredReason(failureCause, reworkDecision, failureRedactedSummary),
              SUPERVISOR_ACTOR,
              "human",
            );
          }
          // reworkDecision === "rework" の場合は status='review' のまま残す。adapter.launch() は
          // 非同期のため Tx 内では起動できず、Tx 成功後（下の launchRework 呼び出し）で起動する。
        }

        // いずれの分岐でも reviewer run は done で close する（契約 §15.2: レビュアー自身は
        // 正常完了しているため。人間確認待ちになるのはタスクの状態であり run ではない）。
        if (!passingFinalization && openRun !== null) {
          store.endRun(openRun.id, "done", buildEndRunMeta(openRun, endStats, extraMeta));
        }
      });
    } catch (err) {
      if (err instanceof StaleReviewAbort) {
        recordStaleReviewSkipped(store, logger, task.id, ref.sessionId, "verdict_finalized");
        continue;
      }
      throw err;
    }

    await cleanupDirectReviewerProcessGroup(adapter, ref, logger, task.id);

    if (reworkDecision === "rework") {
      const reworkNote = await launchRework(
        deps,
        task,
        reworkAttempt,
        failureSummaryHash,
        failureRedactedSummary,
        failureRedactedIssues,
      );
      notes.push(reworkNote);
    }
  }

  return { actions, notes };
}

// ---------------------------------------------------------------------------
// reviewer run の max 実行時間強制回収（docs/contract.md §34.3）
// ---------------------------------------------------------------------------
// worker run 側は monitor.ts が同一契約条項を担う。session-ref.ts 経由の共有はせず、review.ts
// 既存の finalize.ts 複製スタイル（parseExistingRunMeta 等）に倣いローカルに実装する。

/** 1 run の最大実行秒数の既定値（config 省略時。契約 §34.3） */
const DEFAULT_MAX_RUN_SECONDS = 7200;

/**
 * open reviewer run の経過時間（now - startedAt）が resourceGuard.maxRunSeconds（既定7200秒）を
 * 超えた場合に durable cancel request を作る。停止再照合と run close は cancel stage に委譲する。
 */
async function checkReviewerMaxRuntime(
  deps: StageDeps,
  apply: boolean,
  now: number,
): Promise<{ actions: number; notes: string[] }> {
  const { store, logger } = deps;
  const notes: string[] = [];
  let actions = 0;
  const maxRunSeconds = deps.config.resourceGuard.maxRunSeconds ?? DEFAULT_MAX_RUN_SECONDS;

  for (const task of store.listByStatus("review")) {
    const ref = reconstructReviewerSessionRef(store, task.id);
    if (ref === null) {
      continue; // まだレビュアー未起動（前半 launchReviewers の対象）
    }

    const elapsedSec = now - ref.startedAt;
    if (elapsedSec <= maxRunSeconds) {
      continue;
    }

    actions += 1;
    notes.push(`${task.id}: レビュアー max-runtime 超過を検知しました (${elapsedSec}s > ${maxRunSeconds}s)`);

    if (!apply) {
      continue;
    }

    try {
      const openRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
      if (openRun === null) {
        recordStaleReviewSkipped(store, logger, task.id, ref.sessionId, "max_runtime_exceeded");
        continue;
      }
      ensureSupervisorCancelRequest(
        store,
        openRun,
        "reviewer-max-runtime",
        `reviewer max-runtime exceeded (${elapsedSec}s > ${maxRunSeconds}s)`,
        now,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("review: reviewer max-runtime cancel request 作成に失敗しました", {
        taskId: task.id,
        error: redactText(message),
      });
    }
  }

  return { actions, notes };
}

export const reviewStage: Stage = {
  name: "review",

  async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
    // 契約 §34.3: 時間切れの reviewer run は他の2フェーズより先に強制回収する
    // （後続フェーズでの二重処理を避けるため。時間切れタスクは block 済みになり listByStatus("review") から外れる）。
    const maxRuntimeResult = await checkReviewerMaxRuntime(deps, apply, now);
    const launchResult = await launchReviewers(deps, apply);
    const verdictResult = await checkVerdicts(deps, apply, now);

    return {
      name: "review",
      actions: maxRuntimeResult.actions + launchResult.actions + verdictResult.actions,
      skipped: false,
      notes: [...maxRuntimeResult.notes, ...launchResult.notes, ...verdictResult.notes],
    };
  },
};
