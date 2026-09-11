// DirectClaudeAdapter: `claude -p` を detached プロセスで直接起動する WorkerAdapter 実装（契約 §22.1）。
// bridge は model を運べない（modelDelivery=none）ため、model を実配信する代替トランスポート
// （§17 の codex 版と同じ割り切り。トレードオフとして G2（even-terminal）には表示されない）。
// プロセス機構（prompt/out/exit ファイル・state JSON・status 3分岐・fetchTranscript・healthCheck・stop）は
// direct-process.ts へ共通化し、DirectCodexAdapter（契約 §17.2）と共用する。
import { randomUUID } from "node:crypto";
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
import { collectClaudeNativeUsage } from "./native-usage.js";
import {
  cleanupProcessGroup,
  directHealthCheck,
  directRunEnded,
  fetchDirectTranscript,
  readDirectSessionState,
  resolveDirectStatus,
  shellSingleQuote,
  spawnDetachedScript,
  stopDirectSession,
  writeDirectSessionState,
  type DirectSessionState,
} from "./direct-process.js";

/** DirectClaudeAdapter のコンストラクタ引数（契約 §22.1, §34.2） */
export interface DirectClaudeAdapterOptions {
  /** セッション状態・out/exit/prompt ファイルの置き場（$home/state/direct-sessions。呼び出し側が作成する） */
  stateDir: string;
  /** artifacts ディレクトリ（契約シグネチャ上受け取るが、out/exit は stateDir 配下へ集約する。§17.2 と同じ割り切り） */
  artifactsDir: string;
  /** claude CLI の実行ファイル（既定 "claude"） */
  claudeBin?: string;
  /** stop() の生存確認ポーリング間隔ms（既定100。テストでの短縮用途、契約 §34.2） */
  stopPollIntervalMs?: number;
  /** stop() で SIGKILL へ切り替えるまでの最大待機ms（既定5000。テストでの短縮用途、契約 §34.2） */
  stopMaxWaitMs?: number;
  /** spawn後state永続化失敗の回収テスト用DI。productionはwriteDirectSessionState固定。 */
  stateWriter?: (stateDir: string, sessionId: string, state: DirectSessionState) => void;
  /** claude のネイティブ transcript 置き場（既定 $CLAUDE_CONFIG_DIR/projects または ~/.claude/projects） */
  claudeProjectsRoot?: string;
  /** テスト用の native session id 採番差し替え。production は randomUUID 固定 */
  nativeSessionIdFactory?: () => string;
}

/**
 * claude が transcript を書くルートを決める。
 * 子プロセスは env をそのまま継承する（scrub 対象は API キーのみ）ため、親と同じ規則で解決すれば
 * 子が実際に書く場所と一致する。
 */
export function resolveClaudeProjectsRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim();
  if (configDir !== undefined && configDir.length > 0) {
    return join(configDir, "projects");
  }
  return join(homedir(), ".claude", "projects");
}

/**
 * 子プロセスへ渡す環境変数から API 課金系のトークンを除去する（subscription-only、契約 §22.1）。
 * claude CLI がサブスクリプション認証ではなく API キー課金経路を使ってしまわないよう、
 * ANTHROPIC_API_KEY / CLAUDE_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL のみ除去し、
 * それ以外（PATH 等）はそのまま継承する。
 */
const SCRUBBED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

function buildScrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

/**
 * `claude -p` の起動スクリプトを組み立てる（契約 §22.1, §35.3）。
 * prompt はファイル経由（`< promptFile`）で渡しシェルエスケープを回避する。stdout/stderr は outFile へ、
 * 終了コードは exitFile へ書き出す。cwd は spawn の cwd オプションで指定するためスクリプトへは埋め込まない。
 * model/各パス/claudeBin/effort/speed はすべて single-quote で包み reject 検証する。effort 指定時は
 * `--effort <effort>` を付与する（契約 §35.3。EffortLevel は zod 検証済みの閉じた enum のため
 * quoting は防御的な二重対策）。
 * `--session-id` は run と 1:1 の uuid を渡し、ネイティブ transcript のファイル名を run 識別子そのものに
 * する（設計 R3）。これにより終了後の usage 収集が時刻ウィンドウ推測なしに exact になる。
 * `--output-format` は**付けない**。付けると `.out` が JSON 化され handoff fence 抽出が壊れる（設計 §5.3）。
 */
function buildLaunchScript(
  claudeBin: string,
  model: string,
  promptFile: string,
  outFile: string,
  exitFile: string,
  effort: EffortLevel | undefined,
  speed: ExecutionSpeed | undefined,
  nativeSessionId: string,
): string {
  const binQ = shellSingleQuote(claudeBin, "claudeBin");
  const modelQ = shellSingleQuote(model, "model");
  const sessionIdQ = shellSingleQuote(nativeSessionId, "nativeSessionId");
  const promptQ = shellSingleQuote(promptFile, "promptFile");
  const outQ = shellSingleQuote(outFile, "outFile");
  const exitQ = shellSingleQuote(exitFile, "exitFile");
  const effortFlag = effort !== undefined ? ` --effort ${shellSingleQuote(effort, "effort")}` : "";
  // --settings は session-local な追加設定。standard でも false を明示して user setting の fastMode を
  // 確実に打ち消し、未指定時だけ既存設定へ委譲する（contract §67）。
  const speedFlag = speed !== undefined
    ? ` --settings ${shellSingleQuote(JSON.stringify({ fastMode: speed === "fast" }), "speed")}`
    : "";
  // exec は使わない（claude 終了後の `echo $? > exitFile` を実行させるため sh を生かし続ける）。
  return `${binQ} -p --model ${modelQ}${effortFlag}${speedFlag} --session-id ${sessionIdQ} --dangerously-skip-permissions < ${promptQ} > ${outQ} 2>&1; echo $? > ${exitQ}`;
}

/** RunUsage.collectedBy に記録する collector 識別子（回帰調査用）。 */
const COLLECTED_BY = "direct-claude@native-log-v1";

/**
 * `claude -p` を detached 起動する WorkerAdapter（契約 §22.1）。
 * SessionRef は serverUrl="direct" / modelDelivery="native" を持ち、supervisor 側の adapter 選択
 * （session-ref.ts の pickAdapter）が serverUrl==="direct" を印にこの adapter へルーティングする。
 */
export class DirectClaudeAdapter implements WorkerAdapter {
  readonly provider = "claude" as const;

  private readonly stateDir: string;
  private readonly claudeBin: string;
  private readonly stopPollIntervalMs: number;
  private readonly stopMaxWaitMs: number;
  private readonly stateWriter: (stateDir: string, sessionId: string, state: DirectSessionState) => void;
  private readonly claudeProjectsRoot: string;
  private readonly nativeSessionIdFactory: () => string;

  constructor(opts: DirectClaudeAdapterOptions) {
    this.stateDir = opts.stateDir;
    this.claudeBin = opts.claudeBin ?? "claude";
    this.stopPollIntervalMs = opts.stopPollIntervalMs ?? 100;
    this.stopMaxWaitMs = opts.stopMaxWaitMs ?? 5000;
    this.stateWriter = opts.stateWriter ?? writeDirectSessionState;
    this.claudeProjectsRoot = opts.claudeProjectsRoot ?? resolveClaudeProjectsRoot();
    this.nativeSessionIdFactory = opts.nativeSessionIdFactory ?? randomUUID;
    // opts.artifactsDir は契約シグネチャ上受け取るが、out/exit/state は stateDir 配下へ集約する（§17.2 準拠）。
  }

  async launch(task: TaskRow, options: LaunchOptions): Promise<SessionRef> {
    const sessionId = `direct-${newNonce()}`;
    // 呼び出し側が作る想定だが、直接呼び出しテスト等に備え防御的に mkdir する（冪等）。
    mkdirSync(this.stateDir, { recursive: true });

    const promptFile = join(this.stateDir, `${sessionId}.prompt`);
    const outFile = join(this.stateDir, `${sessionId}.out`);
    const exitFile = join(this.stateDir, `${sessionId}.exit`);
    // run と 1:1 の uuid。これがそのままネイティブ transcript のファイル名になる（設計 R3）。
    const nativeSessionId = this.nativeSessionIdFactory();

    // prompt はファイル経由で渡す（シェルエスケープ回避、契約 §22.1）。
    writeFileSync(promptFile, options.promptText, "utf8");

    const script = buildLaunchScript(
      this.claudeBin,
      options.model,
      promptFile,
      outFile,
      exitFile,
      options.effort,
      options.speed,
      nativeSessionId,
    );

    // task cwd で実行する（claude CLI に --cd 相当のフラグは無いため spawn の cwd オプションを使う）。
    // env は subscription-only guard によりスクラビング済みのものを渡す（契約 §22.1）。
    const pid = spawnDetachedScript(script, { cwd: options.cwd, env: buildScrubbedEnv() });

    const startedAt = Math.floor(Date.now() / 1000);
    try {
      this.stateWriter(this.stateDir, sessionId, {
        pid,
        taskId: task.id,
        outFile,
        exitFile,
        model: options.model,
        startedAt,
        nativeSessionId,
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
    const status = resolveDirectStatus(state, exitFile);
    // 走行中に読むと不完全なログを実測として確定させてしまう。exit ファイルが出た後だけ収集する
    // （exit ファイルは claude 終了後に sh が書くため、その時点でログは書き切られている）。
    if (!directRunEnded(exitFile)) {
      return status;
    }
    return { ...status, usage: await this.collectUsage(state) };
  }

  /** ネイティブ transcript（親＋サブエージェント）から usage を集計する（設計 R2/R3）。 */
  private async collectUsage(state: DirectSessionState | null): Promise<RunUsage> {
    const options = { collectedBy: COLLECTED_BY, provenance: "cli-native-session-log" as const };
    const nativeSessionId = state?.nativeSessionId;
    if (nativeSessionId === undefined) {
      // `--session-id` 導入前に起動した in-flight session。時刻で推測せず正直に unknown を書く。
      return buildRunUsage({ observed: false, reason: "session-id-unknown" }, options);
    }
    try {
      const observation = await collectClaudeNativeUsage({
        projectsRoot: this.claudeProjectsRoot,
        sessionId: nativeSessionId,
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
    // steer は bridge 経路のみ。direct は既存プロセスへ注入する手段が無い（契約 §17.2 / §22.1）。
    void ref;
    void message;
    throw new Error("direct transport は steer 非対応です");
  }

  async healthCheck(): Promise<boolean> {
    // claude CLI が PATH 上（または指定パス）に存在するかを which で確認する（契約 §22.1）。
    return directHealthCheck(this.claudeBin);
  }

  async stop(ref: SessionRef): Promise<StopResult> {
    // state ファイルの pid へ SIGTERM→(最大5秒待機)→SIGKILL（契約 §34.2）。実装は direct-process.ts に共通化。
    return stopDirectSession(this.stateDir, ref.sessionId, {
      pollIntervalMs: this.stopPollIntervalMs,
      maxWaitMs: this.stopMaxWaitMs,
    });
  }
}
