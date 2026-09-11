// DirectCodexAdapter: `codex exec` を detached プロセスで直接起動する WorkerAdapter 実装（契約 §17.2）。
// bridge は model を運べない（modelDelivery=none）ため、model を実配信する代替トランスポート。
// トレードオフとして G2（even-terminal）には表示されない（旧システムの direct reroute と同じ割り切り）。
// プロセス機構（prompt/out/exit ファイル・state JSON・status 3分岐・fetchTranscript・healthCheck・stop）は
// direct-process.ts へ共通化し、DirectClaudeAdapter（契約 §22.1）と共用する。
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildRunUsage, newNonce } from "@hachi/core";
import type {
  EffortDelivery,
  EffortLevel,
  ExecutionSpeed,
  LaunchOptions,
  RunUsage,
  SessionRef,
  SessionStatus,
  SpeedDelivery,
  StopResult,
  TaskRow,
  WorkerAdapter,
} from "@hachi/core";
import { collectCodexNativeUsage, parseCodexSessionId } from "./native-usage.js";
import {
  cleanupProcessGroup,
  directHealthCheck,
  directRunEnded,
  fetchDirectTranscript,
  readDirectOutHead,
  readDirectSessionState,
  resolveDirectStatus,
  shellSingleQuote,
  spawnDetachedScript,
  stopDirectSession,
  writeDirectSessionState,
  type DirectSessionState,
} from "./direct-process.js";

/** DirectCodexAdapter のコンストラクタ引数（契約 §17.2, §34.2） */
export interface DirectCodexAdapterOptions {
  /** セッション状態・out/exit/prompt ファイルの置き場（$home/state/direct-sessions。呼び出し側が作成する） */
  stateDir: string;
  /** artifacts ディレクトリ（契約シグネチャ上受け取るが、out/exit は stateDir 配下へ集約する。§17.2） */
  artifactsDir: string;
  /** codex CLI の実行ファイル（既定 "codex"） */
  codexBin?: string;
  /** stop() の生存確認ポーリング間隔ms（既定100。テストでの短縮用途、契約 §34.2） */
  stopPollIntervalMs?: number;
  /** stop() で SIGKILL へ切り替えるまでの最大待機ms（既定5000。テストでの短縮用途、契約 §34.2） */
  stopMaxWaitMs?: number;
  /** spawn後state永続化失敗の回収テスト用DI。productionはwriteDirectSessionState固定。 */
  stateWriter?: (stateDir: string, sessionId: string, state: DirectSessionState) => void;
  /** codex の rollout 置き場（既定 $CODEX_HOME/sessions または ~/.codex/sessions） */
  codexSessionsRoot?: string;
}

/** codex が rollout を書くルートを決める（子プロセスは env を継承するため親と同じ規則で解決する）。 */
export function resolveCodexSessionsRoot(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  if (codexHome !== undefined && codexHome.length > 0) {
    return join(codexHome, "sessions");
  }
  return join(homedir(), ".codex", "sessions");
}

/** RunUsage.collectedBy に記録する collector 識別子（回帰調査用）。 */
const COLLECTED_BY = "direct-codex@native-log-v1";

/**
 * `codex exec` の起動スクリプトを組み立てる（契約 §17.2, §35.3）。
 * prompt はファイル経由（`< promptFile`）で渡しシェルエスケープを回避する。stdout/stderr は outFile へ、
 * 終了コードは exitFile へ書き出す。model/cwd/各パス/codexBin/effort/speed はすべて single-quote で包み
 * reject 検証する。effort 指定時は既存の model 注入と同じ流儀で `-c model_reasoning_effort=<effort>` を
 * 追加する（契約 §35.3。EffortLevel は zod 検証済みの閉じた enum のため quoting は防御的な二重対策）。
 */
function buildLaunchScript(
  codexBin: string,
  model: string,
  cwd: string,
  promptFile: string,
  outFile: string,
  exitFile: string,
  effort: EffortLevel | undefined,
  speed: ExecutionSpeed | undefined,
  isolatedSteward: boolean,
): string {
  const binQ = shellSingleQuote(codexBin, "codexBin");
  const modelQ = shellSingleQuote(`model=${model}`, "model");
  const cwdQ = shellSingleQuote(cwd, "cwd");
  const promptQ = shellSingleQuote(promptFile, "promptFile");
  const outQ = shellSingleQuote(outFile, "outFile");
  const exitQ = shellSingleQuote(exitFile, "exitFile");
  const effortFlag =
    effort !== undefined
      ? ` -c ${shellSingleQuote(`model_reasoning_effort=${effort}`, "effort")}`
      : "";
  // speed 未指定は従来どおり user config/runtime 既定へ委譲する。明示指定時だけ process-local に固定し、
  // standard は user config の fast 設定を打ち消す（contract §67）。
  const speedFlags = speed === "fast"
    ? ` -c ${shellSingleQuote('service_tier="fast"', "speed")} --enable fast_mode`
    : speed === "standard"
      ? ` -c ${shellSingleQuote('service_tier="default"', "speed")} --disable fast_mode`
      : "";
  const isolationFlags = isolatedSteward
    ? ` --sandbox read-only --ephemeral --ignore-user-config --ignore-rules -c ${shellSingleQuote("shell_environment_policy.inherit=none", "shellEnvironmentPolicy")}`
    : "";
  // exec は使わない（codex 終了後の `echo $? > exitFile` を実行させるため sh を生かし続ける）。
  return `${binQ} exec -c ${modelQ}${effortFlag}${speedFlags}${isolationFlags} --cd ${cwdQ} - < ${promptQ} > ${outQ} 2>&1; echo $? > ${exitQ}`;
}

/** 通常タスクでは生成不能な reserved virtual Steward identity だけを厳密に識別する。 */
function isVirtualStewardTask(task: TaskRow): boolean {
  return task.id === "steward"
    && task.tenant === "system"
    && task.profile === "steward"
    && task.status === "blocked";
}

/**
 * `codex exec` を detached 起動する WorkerAdapter（契約 §17.2）。
 * SessionRef は serverUrl="direct" / modelDelivery="native" を持ち、supervisor 側の adapter 選択
 * （session-ref.ts の pickAdapter）が serverUrl==="direct" を印にこの adapter へルーティングする。
 */
export class DirectCodexAdapter implements WorkerAdapter {
  readonly provider = "codex" as const;

  private readonly stateDir: string;
  private readonly codexBin: string;
  private readonly stopPollIntervalMs: number;
  private readonly stopMaxWaitMs: number;
  private readonly stateWriter: (stateDir: string, sessionId: string, state: DirectSessionState) => void;
  private readonly codexSessionsRoot: string;

  constructor(opts: DirectCodexAdapterOptions) {
    this.stateDir = opts.stateDir;
    this.codexBin = opts.codexBin ?? "codex";
    this.stopPollIntervalMs = opts.stopPollIntervalMs ?? 100;
    this.stopMaxWaitMs = opts.stopMaxWaitMs ?? 5000;
    this.stateWriter = opts.stateWriter ?? writeDirectSessionState;
    this.codexSessionsRoot = opts.codexSessionsRoot ?? resolveCodexSessionsRoot();
    // opts.artifactsDir は契約シグネチャ上受け取るが、out/exit/state は stateDir 配下へ集約する（§17.2）。
  }

  async launch(task: TaskRow, options: LaunchOptions): Promise<SessionRef> {
    const sessionId = `direct-${newNonce()}`;
    // 呼び出し側が作る想定だが、直接呼び出しテスト等に備え防御的に mkdir する（冪等）。
    mkdirSync(this.stateDir, { recursive: true });

    const promptFile = join(this.stateDir, `${sessionId}.prompt`);
    const outFile = join(this.stateDir, `${sessionId}.out`);
    const exitFile = join(this.stateDir, `${sessionId}.exit`);

    // prompt はファイル経由で渡す（シェルエスケープ回避、契約 §17.2）。
    writeFileSync(promptFile, options.promptText, "utf8");

    // --ephemeral（isolated steward）は設計上 rollout を書かないため、usage は not-provided になる。
    const isolatedSteward = isVirtualStewardTask(task);
    const script = buildLaunchScript(
      this.codexBin,
      options.model,
      options.cwd,
      promptFile,
      outFile,
      exitFile,
      options.effort,
      options.speed,
      isolatedSteward,
    );

    const pid = spawnDetachedScript(script);

    const startedAt = Math.floor(Date.now() / 1000);
    try {
      this.stateWriter(this.stateDir, sessionId, {
        pid,
        taskId: task.id,
        outFile,
        exitFile,
        model: options.model,
        startedAt,
        ...(isolatedSteward ? { nativeLogsDisabled: true } : {}),
      });
    } catch (err) {
      try {
        await cleanupProcessGroup(pid, {
          pollIntervalMs: this.stopPollIntervalMs,
          maxWaitMs: this.stopMaxWaitMs,
        });
      } catch {
        // 元の永続化失敗を保持する。回収不能でも追跡stateを成功扱いしてはならない。
      }
      throw err;
    }

    // direct は実配信できるため effort 指定時は "native" を記録する。未指定時はキー自体を省略する
    // （exactOptionalPropertyTypes、契約 §35.3）。
    const effortDelivery: EffortDelivery | undefined = options.effort !== undefined ? "native" : undefined;
    const speedDelivery: SpeedDelivery | undefined = options.speed !== undefined ? "native" : undefined;

    return {
      provider: this.provider,
      sessionId,
      serverUrl: "direct",
      model: options.model,
      modelDelivery: "native",
      ...(effortDelivery !== undefined ? { effortDelivery } : {}),
      ...(speedDelivery !== undefined ? { speedDelivery } : {}),
      startedAt,
    };
  }

  async status(ref: SessionRef): Promise<SessionStatus> {
    const state = readDirectSessionState(this.stateDir, ref.sessionId);
    const exitFile = state?.exitFile ?? join(this.stateDir, `${ref.sessionId}.exit`);
    const outFile = state?.outFile ?? join(this.stateDir, `${ref.sessionId}.out`);
    const status = resolveDirectStatus(state, exitFile);
    // 走行中に読むと不完全なログを実測として確定させてしまう。exit ファイルが出た後だけ収集する。
    if (!directRunEnded(exitFile)) {
      return status;
    }
    return { ...status, usage: await this.collectUsage(state, outFile) };
  }

  /**
   * rollout から usage を集計する（設計 R3）。
   * codex exec は `--session-id` を持たないが、`.out` 冒頭のヘッダへ自分の `session id: <uuid>` を
   * 出力する。この uuid を rollout ファイル名と**完全一致**させることで、時刻ウィンドウ推測を使わずに
   * run とログを 1:1 で結びつける。`.out` の書式は一切変えていない（fence 抽出は非回帰）。
   */
  private async collectUsage(state: DirectSessionState | null, outFile: string): Promise<RunUsage> {
    const options = { collectedBy: COLLECTED_BY, provenance: "cli-native-session-log" as const };
    if (state?.nativeLogsDisabled === true) {
      return buildRunUsage({ observed: false, reason: "log-not-persisted" }, options);
    }
    const sessionId = parseCodexSessionId(readDirectOutHead(outFile));
    if (sessionId === null) {
      return buildRunUsage({ observed: false, reason: "session-id-unknown" }, options);
    }
    try {
      const observation = await collectCodexNativeUsage({
        sessionsRoot: this.codexSessionsRoot,
        sessionId,
      });
      return buildRunUsage(observation, options);
    } catch {
      // 収集の失敗で status() 自体を壊さない（usage はベストエフォート、契約 §14.5）。
      return buildRunUsage({ observed: false, reason: "log-unreadable" }, options);
    }
  }

  async fetchTranscript(ref: SessionRef): Promise<string> {
    const state = readDirectSessionState(this.stateDir, ref.sessionId);
    const outFile = state?.outFile ?? join(this.stateDir, `${ref.sessionId}.out`);
    return fetchDirectTranscript(outFile);
  }

  async inject(ref: SessionRef, message: string): Promise<void> {
    // steer は bridge 経路のみ。direct は既存プロセスへ注入する手段が無い（契約 §17.2）。
    void ref;
    void message;
    throw new Error("direct transport は steer 非対応です");
  }

  async healthCheck(): Promise<boolean> {
    // codex CLI が PATH 上（または指定パス）に存在するかを which で確認する（契約 §17.2）。
    return directHealthCheck(this.codexBin);
  }

  async stop(ref: SessionRef): Promise<StopResult> {
    // state ファイルの pid へ SIGTERM→(最大5秒待機)→SIGKILL（契約 §34.2）。実装は direct-process.ts に共通化。
    return stopDirectSession(this.stateDir, ref.sessionId, {
      pollIntervalMs: this.stopPollIntervalMs,
      maxWaitMs: this.stopMaxWaitMs,
    });
  }
}
