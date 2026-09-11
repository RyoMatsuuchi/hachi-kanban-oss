// =============================================================================
// supervisor / launchd / kill-switch の状態を読み取る純粋関数群（docs/contract.md §23.1）。
// fs・child_process への直接アクセスはこのモジュールに閉じ込め、app.ts はここの関数のみを呼ぶ。
// readonly 設計の唯一の例外（kill-switch touch/rm）は app.ts 側の POST ルートが担当し、
// このモジュールは読み取りのみを提供する。
// =============================================================================

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * kill-switch / API で扱う許可ステージ名（docs/contract.md §23.2）。
 * "supervisor" は全ステージ停止の全体スイッチ、残りは supervisor の stage 実行順
 * （scheduler → dispatch → monitor → finalize → review → messages → reap → notify → webwatch → steward）と一致させる。
 * API のバリデーションと UI 双方から共用する（fail-closed の許可リスト）。
 */
export const STAGE_NAMES = [
  "supervisor",
  "scheduler",
  "dispatch",
  "monitor",
  "finalize",
  "review",
  "messages",
  "reap",
  "notify",
  "webwatch",
  "steward",
] as const;

export type StageName = (typeof STAGE_NAMES)[number];

/** value が許可ステージ名か判定する型ガード（POST の fail-closed 検証に使う） */
export function isStageName(value: string): value is StageName {
  return (STAGE_NAMES as readonly string[]).includes(value);
}

export interface StageDisabledState {
  name: StageName;
  disabled: boolean;
}

/** 許可ステージそれぞれについて `<home>/<name>.disabled` の有無を確認する（docs/contract.md §23.1） */
export function readStages(home: string): StageDisabledState[] {
  return STAGE_NAMES.map((name) => ({
    name,
    disabled: existsSync(join(home, `${name}.disabled`)),
  }));
}

export interface LaunchdState {
  label: string;
  loaded: boolean;
  pid: number | null;
  lastExitCode: number | null;
}

/** 正規表現で1グループのみ抽出し、数値へ変換する（未一致・NaN は null。noUncheckedIndexedAccess 対応） */
function parseIntField(pattern: RegExp, text: string): number | null {
  const raw = pattern.exec(text)?.[1];
  if (raw === undefined) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * `launchctl print gui/<uid>/<label>` を実行し、state/pid/last exit code を最小限パースする。
 * ラベル未ロード・launchctl 不在等の失敗時は null を返し degrade する（docs/contract.md §23.1）。
 */
export function readLaunchd(label: string): LaunchdState | null {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return null;
  }
  const result = spawnSync("launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  const stdout = result.stdout;
  return {
    label,
    loaded: true,
    // state = running のときのみ "pid = <n>" 行が出る。無ければ未起動として null
    pid: parseIntField(/^\s*pid = (\d+)\s*$/m, stdout),
    lastExitCode: parseIntField(/^\s*last exit code = (-?\d+)\s*$/m, stdout),
  };
}

export interface LastTickStageResult {
  name: string;
  actions: number;
  skipped: boolean;
}

export interface LastTick {
  at: string;
  stages: LastTickStageResult[];
}

/** tail 読みの最大バイト数。1 tick は最大9ステージ分の短い JSON 行なので十分な余裕を持たせる */
const TAIL_BYTES = 32_768;

/** runTick が出す個別ステージログの msg 一覧（packages/supervisor/src/supervisor.ts と一致させる） */
const STAGE_LOG_MESSAGES = new Set(["stage completed", "stage skipped (kill-switch)", "stage failed"]);

/** createLogger（packages/core/src/logger.ts）が出す JSONL 1行分の緩い型 */
interface LogEntry {
  ts?: unknown;
  level?: unknown;
  msg?: unknown;
  stage?: unknown;
  actions?: unknown;
  results?: unknown;
}

/**
 * ファイル末尾 TAIL_BYTES バイトのみを読み、改行区切りの行配列として返す（全読み禁止。docs/contract.md §23.1）。
 * ファイルが無ければ空配列を返す。先頭行は途中から始まっている可能性があるため、
 * 末尾切り出しが発生した場合（start > 0）は先頭の不完全行を破棄する。
 */
function tailLines(filePath: string): string[] {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) {
      return [];
    }
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) {
      // 末尾切り出しにより先頭行が途中からのゴミ行になっているので破棄する
      lines.shift();
    }
    return lines.filter((line) => line.trim() !== "");
  } finally {
    closeSync(fd);
  }
}

/** JSONL の1行を安全にパースする。壊れた行は null（無視） */
function parseLogLine(line: string): LogEntry | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? (parsed as LogEntry) : null;
  } catch {
    return null;
  }
}

/** runTick が出すステージ結果ログか判定する */
function isStageResultLog(entry: LogEntry | undefined): entry is LogEntry & { msg: string; stage: string } {
  return (
    entry !== undefined &&
    typeof entry.msg === "string" &&
    STAGE_LOG_MESSAGES.has(entry.msg) &&
    typeof entry.stage === "string"
  );
}

/**
 * stage.tick() 内で出る診断ログか判定する。
 * webwatch は fail-open のため healthz/kickstart 失敗を warn するが、その直後に supervisor が
 * "stage completed" を出す。tick 復元ではこの診断行を境界扱いせず、前の stage 結果まで遡る。
 */
function isInterleavedStageDiagnosticLog(entry: LogEntry | undefined): boolean {
  return (
    entry !== undefined &&
    entry.level === "warn" &&
    typeof entry.msg === "string" &&
    entry.msg.startsWith("webwatch:")
  );
}

/**
 * supervisor.jsonl の末尾から直近1 tick 分のステージ結果を復元する（tail 読みのみ。全読み禁止）。
 *
 * 2つのログ形状に対応する（packages/supervisor/src/main.ts）:
 * - `--once` 実行: 全ステージのログの直後に "single tick完了"（fields.results に StageResult[] 全体）
 *   が1行出るので、末尾がこの行であれば最優先でそこから復元する。
 * - 常駐ループ実行: 集約ログが無く、tick ごとに "stage completed" / "stage skipped (kill-switch)" /
 *   "stage failed" が1ステージ1行ずつ出るだけなので、ファイル末尾から当該メッセージ群を
 *   直近1 tick 分として遡って収集する。末尾が非ステージ行なら lastTick 不明として null を返すが、
 *   stage 内の診断 warn は同一 tick の途中に挟まるため読み飛ばす。
 */
export function readLastTick(home: string): LastTick | null {
  const filePath = join(home, "logs", "supervisor.jsonl");
  const lines = tailLines(filePath);
  if (lines.length === 0) {
    return null;
  }
  const entries = lines.map(parseLogLine).filter((entry): entry is LogEntry => entry !== null);
  if (entries.length === 0) {
    return null;
  }

  const last = entries[entries.length - 1];
  if (last !== undefined && last.msg === "single tick完了" && Array.isArray(last.results)) {
    const stages: LastTickStageResult[] = last.results
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((r) => ({
        name: typeof r.name === "string" ? r.name : "",
        actions: typeof r.actions === "number" ? r.actions : 0,
        skipped: typeof r.skipped === "boolean" ? r.skipped : false,
      }))
      .filter((r) => r.name !== "");
    if (stages.length === 0) {
      return null;
    }
    return { at: typeof last.ts === "string" ? last.ts : "", stages };
  }

  const lastStageEntry = entries[entries.length - 1];
  if (!isStageResultLog(lastStageEntry)) {
    return null;
  }

  const collected: LastTickStageResult[] = [];
  // 常駐ループの tick 間には区切りログが無いため（毎 tick 同じ9ステージ名が繰り返されるだけ）、
  // 「同じステージ名の再出現」を1つ前の tick に遡った合図とみなして打ち切る。
  // 実際の tick は必ず9ステージ全てが重複無く1回ずつ出現するため、この判定で常に正確な境界になる。
  const seenNames = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!isStageResultLog(entry)) {
      if (isInterleavedStageDiagnosticLog(entry)) {
        continue;
      }
      break;
    }
    if (seenNames.has(entry.stage)) {
      break;
    }
    seenNames.add(entry.stage);
    collected.unshift({
      name: entry.stage,
      actions: typeof entry.actions === "number" ? entry.actions : 0,
      skipped: entry.msg === "stage skipped (kill-switch)",
    });
  }
  if (collected.length === 0) {
    return null;
  }
  const lastEntry = entries[entries.length - 1];
  const at = lastEntry !== undefined && typeof lastEntry.ts === "string" ? lastEntry.ts : "";
  return { at, stages: collected };
}
