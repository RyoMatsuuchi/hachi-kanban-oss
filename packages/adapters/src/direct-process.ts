// direct transport（codex/claude 共通）のプロセス機構（契約 §17.2, §22.1, §34.2）。
// spawn/state JSON 永続化/status 3分岐/transcript 取得/シェルインジェクション防御/stop（強制停止）を
// DirectCodexAdapter・DirectClaudeAdapter の双方から共用する。
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStatus, StopResult } from "@hachi/core";

/** direct セッションの永続状態（`<stateDir>/<sessionId>.json`）。パスはすべて絶対パスで記録する。 */
export interface DirectSessionState {
  pid: number;
  taskId: string;
  outFile: string;
  exitFile: string;
  model: string;
  startedAt: number;
  /**
   * provider のネイティブセッションログを exact に引くための session id（契約 §14.5 / 設計 R3）。
   * claude は launch 時に `--session-id` で渡した uuid。codex は起動前に確定できないため未設定で、
   * 終了後に `.out` ヘッダから読む。**optional 必須**: 既存の in-flight session の state JSON には
   * このキーが無く、必須化すると readDirectSessionState が null を返して stop 経路が壊れる。
   */
  nativeSessionId?: string;
  /** 設計上ネイティブログが書かれない起動（codex --ephemeral 等）。usage は not-provided になる */
  nativeLogsDisabled?: boolean;
}

/**
 * シェルへ埋め込む値を single-quote で安全に包む。
 * single-quote 内は `'` 以外すべてリテラルとして扱われるため、空白・$・バッククォート等は無害化される。
 * 値自体に `'` を含む場合のみコマンドインジェクションを構成しうるため fail-closed で reject する
 * （契約 §17.2 セキュリティ要件。model は charset 検証済みだが防御的に同経路で包む）。
 */
export function shellSingleQuote(value: string, label: string): string {
  if (value.includes("'")) {
    throw new Error(`direct transport: ${label} にシングルクォートを含むためシェル起動を拒否しました: ${value}`);
  }
  return `'${value}'`;
}

/** `<stateDir>/<sessionId>.json` を読み最小限のスキーマ検証を行う。読めない/不正なら null。 */
export function readDirectSessionState(stateDir: string, sessionId: string): DirectSessionState | null {
  const path = join(stateDir, `${sessionId}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
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
  if (
    typeof record.pid !== "number" ||
    // pid 0/負数/非整数は不正な state として拒否する（fail-closed）。stopDirectSession は
    // ここで読めた pid をそのまま process.kill(-pid) へ渡すため、壊れた state JSON の
    // pid をそのまま信用すると無関係なプロセスグループ（0 や 1 等）へ誤って signal を
    // 送りかねない（契約 §34.2）。
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 1 ||
    typeof record.taskId !== "string" ||
    typeof record.outFile !== "string" ||
    typeof record.exitFile !== "string" ||
    typeof record.model !== "string" ||
    typeof record.startedAt !== "number"
  ) {
    return null;
  }
  // 追加フィールドは optional。型が合わないときはキーごと落とし、state 全体を無効化しない
  // （無効化すると stop 経路が already-exited を返してプロセスが取り残される）。
  const nativeSessionId = typeof record.nativeSessionId === "string" ? record.nativeSessionId : undefined;
  const nativeLogsDisabled = record.nativeLogsDisabled === true ? true : undefined;
  return {
    pid: record.pid,
    taskId: record.taskId,
    outFile: record.outFile,
    exitFile: record.exitFile,
    model: record.model,
    startedAt: record.startedAt,
    ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
    ...(nativeLogsDisabled !== undefined ? { nativeLogsDisabled } : {}),
  };
}

/** セッション状態を `<stateDir>/<sessionId>.json` へ書き出す。 */
export function writeDirectSessionState(stateDir: string, sessionId: string, state: DirectSessionState): void {
  writeFileSync(join(stateDir, `${sessionId}.json`), JSON.stringify(state), "utf8");
}

/**
 * signal 送出/観測エラーの3分類（契約 §34.2.1）。`isProcessGroupAlive` と `killProcessGroup` が
 * 共有する単一の classifier。片方が「生存」と判定し、もう片方が throw する状態を防ぐ
 * （2026-08-21〜25 の direct テスト flake `Error: kill EPERM` の原因）。
 * - `gone`: ESRCH（対象が存在しない＝消滅を確認できた）
 * - `unsignalable`: EPERM（観測も送信もできない。生死は不明）
 * - `fatal`: それ以外の真の異常
 */
function classifySignalError(err: unknown): "gone" | "unsignalable" | "fatal" {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ESRCH") {
    return "gone";
  }
  if (code === "EPERM") {
    return "unsignalable";
  }
  return "fatal";
}

/**
 * pid・process group の tri-state 生存観測（契約 §34.2.1）。
 * - `alive`: signal 0 が成功した（生存を確認できた）
 * - `gone`: ESRCH（不在を確認できた）
 * - `unobservable`: EPERM で観測できなかった（生死不明。観測不能を「生存」と決め打ちしない）
 * 導入範囲は本ファイル内部と DI 注入面（`StopWaitOptions`）まで（契約 §34.2.1）。
 * 公開 API の改名・他パッケージ（`monitor.ts` 等）の移行は §34.2.2 で扱う。
 * **`fatal`（ESRCH/EPERM 以外の真の異常）はここに含めない。** `classifySignalError` は
 * `isProcessGroupAlive` と `killProcessGroup` が共有する単一の分類器であり（契約 §34.2.1）、
 * `killProcessGroup` は `fatal` を throw する。観測側だけ `fatal` を `unobservable` に潰すと
 * 両関数の解釈が再びズレる（片方は例外・片方は「観測不能」という異なる意味論になる）ため、
 * 観測側も `fatal` は throw して呼び出し元へ伝える。
 */
export type ProcessGroupObservation = "alive" | "gone" | "unobservable";

/** `killProcessGroup` の送出結果（契約 §34.2.1）。`fatal` は throw するため戻り値には現れない。 */
export type SignalSendResult = "sent" | "gone" | "unsignalable";

function observeProcess(pid: number): ProcessGroupObservation {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    const kind = classifySignalError(err);
    if (kind === "fatal") {
      throw err;
    }
    return kind === "gone" ? "gone" : "unobservable";
  }
}

function observeProcessGroup(pgid: number): ProcessGroupObservation {
  try {
    process.kill(-pgid, 0);
    return "alive";
  } catch (err) {
    const kind = classifySignalError(err);
    if (kind === "fatal") {
      throw err;
    }
    return kind === "gone" ? "gone" : "unobservable";
  }
}

/**
 * pid が生存しているかを signal 0 で判定する（契約 §34.2.1 の boolean 互換アダプタ）。
 * tri-state 観測のうち `gone` のみ false、`alive` と `unobservable` は true に写す。
 * **`unobservable`（EPERM）を false に写してはならない**。呼び出し元（`monitor.ts` 等）は
 * false を「process tree 不在」と解釈するため、観測不能を不在と取り違えると誤った stall/cancel を招く
 * （契約 §34.2.1）。
 */
export function isProcessAlive(pid: number): boolean {
  return observeProcess(pid) !== "gone";
}

/** process group が残っているかを signal 0 で判定する（boolean 互換規則は `isProcessAlive` と同じ、契約 §34.2.1）。 */
export function isProcessGroupAlive(pgid: number): boolean {
  return observeProcessGroup(pgid) !== "gone";
}

/** spawnDetachedScript の追加オプション（env/cwd とも未指定なら node のデフォルト＝親プロセス継承）。 */
export interface SpawnDetachedOptions {
  /** 子プロセスの環境変数（未指定なら親を継承。DirectClaudeAdapter の env スクラビングに使う） */
  env?: NodeJS.ProcessEnv;
  /** 子プロセスの作業ディレクトリ（未指定なら親の cwd。claude CLI は --cd 相当を持たないためここで指定する） */
  cwd?: string;
}

/**
 * `sh -c <script>` を detached で spawn し pid を返す（取得できなければ throw）。
 */
export function spawnDetachedScript(script: string, opts: SpawnDetachedOptions = {}): number {
  const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore", env: opts.env, cwd: opts.cwd });
  child.unref();

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("direct transport: 子プロセスの pid を取得できませんでした（spawn 失敗）");
  }
  return pid;
}

/**
 * status() の共通 3 分岐ロジック（契約 §17.2 / §22.1）。
 * (1) exit ファイルあり → 終了済み。idle + resultCount=1
 * (2) exit なし + pid 生存 → 実行中。active
 * (3) exit なし + pid 消失（クラッシュ等）→ 終了扱い。idle + resultCount=1（恒久リーク防止）
 */
export function resolveDirectStatus(state: DirectSessionState | null, exitFile: string): SessionStatus {
  if (existsSync(exitFile)) {
    return { state: "idle", lastActivityAt: null, resultCount: 1 };
  }
  if (state !== null && isProcessAlive(state.pid)) {
    return { state: "active", lastActivityAt: null };
  }
  return { state: "idle", lastActivityAt: null, resultCount: 1 };
}

/** direct run が終了しているか（exit ファイルの有無）。usage 収集は終了後にのみ行う。 */
export function directRunEnded(exitFile: string): boolean {
  return existsSync(exitFile);
}

/** out ファイル全文を返す。出力ファイル未生成でも空文字は返さず、finalize が扱える固定文言を返す。 */
export function fetchDirectTranscript(outFile: string): string {
  try {
    return readFileSync(outFile, "utf8");
  } catch {
    return "(出力ファイルなし)";
  }
}

/**
 * out ファイルの先頭だけを読む。codex の `session id:` ヘッダ抽出用で、
 * 長時間 run の `.out`（数十MB になりうる）を丸ごとメモリへ載せないための入口。
 */
export function readDirectOutHead(outFile: string, maxBytes = 8192): string {
  let fd: number | undefined;
  try {
    fd = openSync(outFile, "r");
    const buffer = Buffer.alloc(maxBytes);
    const read = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/** bin が PATH 上（または指定パス）に存在するかを which で確認する。 */
export function directHealthCheck(bin: string): boolean {
  const result = spawnSync("which", [bin], { stdio: "ignore" });
  return result.status === 0;
}

// ========== stop（強制停止、契約 §34.2 / §34.2.1） ==========

/** stop() の待機設定。既定は 100ms 間隔で最大5秒（契約 §34.2）。テスト時の短縮・tri-state 差し替え用に注入可能にする。 */
export interface StopWaitOptions {
  /** 生存確認のポーリング間隔ms（既定100） */
  pollIntervalMs?: number;
  /** SIGKILL へ切り替えるまでの最大待機ms（既定5000） */
  maxWaitMs?: number;
  /** テスト用の pid tri-state 生存判定差し替え（契約 §34.2.1）。未指定時は内部の observeProcess を使う */
  isProcessAlive?: (pid: number) => ProcessGroupObservation;
  /** テスト用の process group tri-state 生存判定差し替え（契約 §34.2.1）。未指定時は内部の observeProcessGroup を使う */
  isProcessGroupAlive?: (pgid: number) => ProcessGroupObservation;
  /**
   * テスト用の process group signal 送出差し替え（契約 §34.2.1）。未指定時は killProcessGroup を使う。
   * `fatal` 分類のみ throw させ、`gone` / `unsignalable` は戻り値で表すこと。
   */
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => SignalSendResult;
  /** テスト用の待機差し替え。未指定時は setTimeout を使う */
  delay?: (ms: number) => Promise<void>;
}

const DEFAULT_STOP_POLL_INTERVAL_MS = 100;
const DEFAULT_STOP_MAX_WAIT_MS = 5000;

/**
 * pid が属するプロセスグループ全体へシグナルを送る（契約 §34.2.1）。
 * spawnDetachedScript は detached:true で起動しており、Unix では起動直後の子プロセスが
 * 新しいプロセスグループのリーダー（pgid === pid）になる。`sh -c '<bin> ...; echo $?>exit'` の
 * 実ワーカー本体（<bin>）は sh の子として同じグループに属するため、単一 pid ではなく
 * プロセスグループ（`-pid`）へ送ることで sh だけでなく実ワーカーまで確実に終了させる。
 * **「送れた」ことは「停止した」ことの証拠ではない**（契約 §34.2.1）。呼び出し元が
 * `sent` / `gone` / `unsignalable` を区別できるよう、戻り値で表す。
 * `unsignalable`（EPERM）で throw してはならない（`isProcessGroupAlive` と解釈を一致させる）。
 * `fatal`（ESRCH/EPERM 以外の真の異常）のみ throw する。
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): SignalSendResult {
  try {
    process.kill(-pid, signal);
    return "sent";
  } catch (err) {
    const kind = classifySignalError(err);
    if (kind === "fatal") {
      throw err;
    }
    return kind;
  }
}

/** ms だけ待機する（stop のポーリング専用。テストでは pollIntervalMs を短縮して実時間待機を避ける）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** poll フェーズの結果。`gone` を観測できたか、期限までに一度でも `alive` を観測したか（契約 §34.2.1）。 */
interface PollOutcome {
  gone: boolean;
  everAlive: boolean;
}

/**
 * observe() を pollIntervalMs 間隔で期限（maxWaitMs）まで繰り返す（契約 §34.2.1 の poll 規律）。
 * `gone` を観測した時点で即座に終了する（消滅の観測を優先する）。
 * `unobservable` は終端にせず、期限まで poll を継続する。
 * 期限到達時は「一度でも `alive` を観測したか」を呼び出し元へ返し、優先順位判定に使わせる
 * （`alive` を一度でも観測していれば「生存していた」を優先する）。
 */
async function pollUntilDeadline(
  observe: () => ProcessGroupObservation,
  pollIntervalMs: number,
  maxWaitMs: number,
  wait: (ms: number) => Promise<void>,
): Promise<PollOutcome> {
  const deadline = Date.now() + maxWaitMs;
  let everAlive = false;
  for (;;) {
    const observation = observe();
    if (observation === "gone") {
      return { gone: true, everAlive };
    }
    if (observation === "alive") {
      everAlive = true;
    }
    if (Date.now() >= deadline) {
      return { gone: false, everAlive };
    }
    await wait(pollIntervalMs);
  }
}

/**
 * 契約 §34.2.1「観測状態の遷移表」（20行）そのものを実装する共通シーケンス。
 * pid 単体（stopProcess）・process group（cleanupProcessGroup）のどちらからも、
 * 対応する observe/send を渡して呼び出す。1箇所に閉じ込めることで二重実装によるズレを防ぐ。
 */
async function runStopSequence(
  observe: () => ProcessGroupObservation,
  send: (signal: NodeJS.Signals) => SignalSendResult,
  pollIntervalMs: number,
  maxWaitMs: number,
  wait: (ms: number) => Promise<void>,
): Promise<StopResult> {
  // 開始前
  const initial = observe();
  if (initial === "gone") {
    return { stopped: false, reason: "already-exited" };
  }
  if (initial === "unobservable") {
    return { stopped: false, reason: "unsignalable" };
  }

  // SIGTERM 送信（fatal は send() が throw し、ここでは捕捉せず呼び出し元まで素通しする）
  const termSend = send("SIGTERM");
  if (termSend === "gone") {
    return { stopped: false, reason: "already-exited" };
  }
  if (termSend === "unsignalable") {
    return { stopped: false, reason: "unsignalable" };
  }

  // TERM 後 poll
  const termPoll = await pollUntilDeadline(observe, pollIntervalMs, maxWaitMs, wait);
  if (termPoll.gone) {
    return { stopped: true, reason: "terminated" };
  }
  if (!termPoll.everAlive) {
    // alive を一度も観測できず unobservable のみだった＝送る先を観測できない
    return { stopped: false, reason: "unsignalable" };
  }

  // SIGKILL 送信
  const killSend = send("SIGKILL");
  if (killSend === "gone") {
    return { stopped: false, reason: "already-exited" };
  }
  if (killSend === "unsignalable") {
    return { stopped: false, reason: "unsignalable" };
  }

  // KILL 後 poll（送信を停止の証拠にしない。消滅を観測できたときだけ killed）
  const killPoll = await pollUntilDeadline(observe, pollIntervalMs, maxWaitMs, wait);
  if (killPoll.gone) {
    return { stopped: true, reason: "killed" };
  }
  if (killPoll.everAlive) {
    return { stopped: false, reason: "kill-unconfirmed" };
  }
  return { stopped: false, reason: "unsignalable" };
}

/**
 * pid へ SIGTERM を送り、最大 maxWaitMs を pollIntervalMs 間隔でポーリングして終了を待つ。
 * 生存していれば SIGKILL を送る（契約 §34.2 / §34.2.1）。遷移の詳細は runStopSequence を参照。
 */
export async function stopProcess(pid: number, opts: StopWaitOptions = {}): Promise<StopResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_STOP_POLL_INTERVAL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_STOP_MAX_WAIT_MS;
  const observeFn = opts.isProcessAlive ?? observeProcess;
  const sendFn = opts.killProcessGroup ?? killProcessGroup;
  const wait = opts.delay ?? delay;

  return runStopSequence(
    () => observeFn(pid),
    (signal) => sendFn(pid, signal),
    pollIntervalMs,
    maxWaitMs,
    wait,
  );
}

/**
 * process group 全体を対象に停止を試みる（docs/contract.md §51.1 / §34.2.1）。
 * リーダー pid が終了済みでも、同じ pgid の孫プロセスだけが残ることがあるため group へ signal する。
 * 遷移の詳細は runStopSequence を参照。
 */
export async function cleanupProcessGroup(pid: number, opts: StopWaitOptions = {}): Promise<StopResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_STOP_POLL_INTERVAL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_STOP_MAX_WAIT_MS;
  const observeFn = opts.isProcessGroupAlive ?? observeProcessGroup;
  const sendFn = opts.killProcessGroup ?? killProcessGroup;
  const wait = opts.delay ?? delay;

  return runStopSequence(
    () => observeFn(pid),
    (signal) => sendFn(pid, signal),
    pollIntervalMs,
    maxWaitMs,
    wait,
  );
}

/**
 * `<stateDir>/<sessionId>.json` から state を読み、記録された pid を停止する（契約 §34.2 / §34.2.1）。
 * state ファイル自体が読めない（存在しない・不正）場合は `already-exited` として扱う
 * （state が無い = 追跡できるプロセスが無い。ただしこの reason は §34.2.2 完了までは多義。契約参照）。
 */
export async function stopDirectSession(
  stateDir: string,
  sessionId: string,
  opts: StopWaitOptions = {},
): Promise<StopResult> {
  const state = readDirectSessionState(stateDir, sessionId);
  if (state === null) {
    return { stopped: false, reason: "already-exited" };
  }
  // exit ファイルが無いまま leader pid だけ消えた場合でも、同じ process group に孫プロセスだけが
  // 残ることがある。§51.1 に従い、exit ファイル有無や leader 生存に依存せず group 全体へ
  // best-effort cleanup を行う。
  return cleanupProcessGroup(state.pid, opts);
}
