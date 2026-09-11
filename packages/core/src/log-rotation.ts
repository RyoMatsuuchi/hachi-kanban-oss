// =============================================================================
// ファイルベースロガー（supervisor.jsonl 等）向け size-based log rotation。
// 凍結契約（docs/contract.md / types.ts の HachiConfig）とは独立した config.json 読み取りであり、
// hachiConfigSchema を拡張しない（未知キーとして黙って無視される）。config.json の任意 `logging`
// セクションを直接読む独立ローダーを持つ。閾値・保持世代数は zod スキーマの `.default()` 一箇所に
// のみ持たせ（`logRotationConfigSchema` 参照）、モジュールレベル定数として別途二重管理しない。
// config.json / `logging` セクション未指定は「エラー」ではなく「スキーマ既定値」として受理する。
// =============================================================================

import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { Environment } from "./types.js";

/** size-based rotation の閾値・保持世代数。 */
export interface LogRotationConfig {
  /** このバイト数を超えたら rotate する */
  maxSizeBytes: number;
  /** 保持する世代数（現行ファイルを含まない。`<file>.1`..`<file>.<maxGenerations>`） */
  maxGenerations: number;
}

/**
 * `logging` セクションの検証スキーマ。**既定値の実体はここ（`.default()`）にのみ持つ**。
 * config.json に `logging` が無い、またはキーの一部だけが指定された場合でも、この1箇所の
 * `.default()` だけで実効値が決まる（コード側に既定値を再定義する場所を作らない）。
 */
const logRotationConfigSchema = z
  .object({
    maxSizeBytes: z.number().int().positive().default(50 * 1024 * 1024), // 50MB: tail/grep で扱える大きさに収める
    maxGenerations: z.number().int().positive().max(1_000).default(10), // 世代合計で最大 500MB 程度を保持する
  })
  .strict();

/**
 * config.json に `logging` セクションが無い場合の既定値。数値そのものは再定義せず、
 * `logRotationConfigSchema` の `.default()` から `parse({})` で導出する（唯一の既定値ソース）。
 */
export const DEFAULT_LOG_ROTATION_CONFIG: LogRotationConfig = logRotationConfigSchema.parse({});

/**
 * 実効設定の出所。`hachi doctor` で「なぜその値になっているか」を可視化するために使う
 * （R2: 値が焼き込みでなくなっても、設定不在に誰も気づけないままでは運用上の穴が残るため）。
 */
export type LogRotationConfigSource =
  /** config.json の `logging` セクションで明示指定された */
  | "config"
  /** config.json 自体が無い、または `logging` セクション未指定でスキーマ既定値が使われている */
  | "schema-default";

/** logging セクションの検証結果。ok=false は config.json の該当セクションが壊れていることを表す。 */
export type LogRotationConfigValidation =
  | { ok: true; config: LogRotationConfig; source: LogRotationConfigSource }
  | { ok: false; error: string };

/**
 * `$HACHI_KANBAN_HOME/config.json` の任意 `logging` セクションを読み込み、検証結果をそのまま返す。
 * hachiConfigSchema / loadConfig とは独立した読み取りであり、`logging` は HachiConfig の
 * 契約（types.ts）には含まれない（凍結契約を拡張せずに導入するための意図的な分離）。
 * ファイル/キー欠如は既定値で ok=true。JSON 構文エラー・root が object でない・schema 不一致は
 * ok=false で理由を返す（呼び出し元が fail-open にするか可視化するかを選べるようにする）。
 */
function readLogRotationConfigFile(env: Environment): LogRotationConfigValidation {
  const configPath = join(env.home, "config.json");
  if (!existsSync(configPath)) {
    return { ok: true, config: DEFAULT_LOG_ROTATION_CONFIG, source: "schema-default" };
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(configPath, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `config.json の読み込み/JSON解析に失敗しました: ${(err as Error).message}` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "config.json の root が object ではありません" };
  }

  const loggingRaw = (parsed as Record<string, unknown>)["logging"];
  if (loggingRaw === undefined) {
    return { ok: true, config: DEFAULT_LOG_ROTATION_CONFIG, source: "schema-default" };
  }

  const result = logRotationConfigSchema.safeParse(loggingRaw);
  if (!result.success) {
    return { ok: false, error: `config.json の logging セクションが不正です: ${result.error.message}` };
  }
  // schema の .default() が欠損キーを埋めるため、ここでの既定値との再合成（?? での merge）は不要。
  return { ok: true, config: result.data, source: "config" };
}

/**
 * ロガー向け: `logging` セクションを読み込む。JSON 構文エラーやスキーマ不一致があっても
 * ログ出力そのものを止めないため fail-open で既定値へフォールバックし、stderr に警告する
 * （config.json 全体の妥当性は loadConfig 側が別途 fail-closed で検証する前提）。
 * 壊れた設定自体を検知したい場合は `validateLogRotationConfig`（`hachi doctor` 用）を使う。
 */
export function loadLogRotationConfig(env: Environment): LogRotationConfig {
  const result = readLogRotationConfigFile(env);
  if (result.ok) {
    return result.config;
  }
  process.stderr.write(`${result.error}。既定値を使用します。\n`);
  return DEFAULT_LOG_ROTATION_CONFIG;
}

/**
 * doctor 向け: `logging` セクションの検証結果をそのまま返す（fail-open にせず可視化する）。
 * ロガー側は動作継続を優先して既定値へフォールバックするが、doctor は「壊れた設定」自体を
 * 検知することが目的のため、ここでは握りつぶさない。
 */
export function validateLogRotationConfig(env: Environment): LogRotationConfigValidation {
  return readLogRotationConfigFile(env);
}

/** `<filePath>.<N>` 形式の世代ファイル名（N は 1 始まり） */
function generationPath(filePath: string, generation: number): string {
  return `${filePath}.${generation}`;
}

/**
 * `threshold` 以上の世代番号を持つ既存世代ファイルをディレクトリ走査ですべて削除する。
 * `maxGenerations` を縮小した直後は、縮小前の設定で作られた上位世代（例: 旧設定で
 * `.4`〜`.10` が残っている状態で `maxGenerations=3` に縮小）が繰り下げループでは一切
 * 触れられず残留し続けるため（R1 の指摘）、rotate の度に「今回退避される1本」だけでなく
 * 現存する全世代を列挙して上限超過分を刈り込む。
 */
function pruneGenerationsAtOrAbove(filePath: string, threshold: number): void {
  const dir = dirname(filePath);
  const prefix = `${basename(filePath)}.`;
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const suffix = entry.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) {
      continue;
    }
    if (Number(suffix) >= threshold) {
      unlinkSync(join(dir, entry));
    }
  }
}

/**
 * 世代ファイルを 1 つずつ繰り下げ、`maxGenerations` 以上の既存世代（縮小前の残留分を含む）を
 * すべて削除してから現行ファイルを `.1` へ退避する。呼び出し元（logger の write 経路）が
 * 同期的に直列実行する前提であり、rotate 自体も同期 fs API のみを使う（Node はシングルスレッド
 * なので、書き込みの直前に同期的に rotate すれば tick ログを取りこぼさない。fd を open しっぱなし
 * にしないため、rotate 後の次回書き込みは新しい現行ファイルへ自然に再オープンされる）。
 */
function rotateLogFile(filePath: string, maxGenerations: number): void {
  pruneGenerationsAtOrAbove(filePath, maxGenerations);
  for (let generation = maxGenerations - 1; generation >= 1; generation -= 1) {
    const src = generationPath(filePath, generation);
    if (existsSync(src)) {
      renameSync(src, generationPath(filePath, generation + 1));
    }
  }
  if (existsSync(filePath)) {
    renameSync(filePath, generationPath(filePath, 1));
  }
}

/** 現行ファイルが閾値以上なら rotate する。閾値未満、またはファイルが未作成なら何もしない。 */
export function rotateLogFileIfNeeded(filePath: string, config: LogRotationConfig): void {
  if (!existsSync(filePath)) {
    return;
  }
  const { size } = statSync(filePath);
  if (size < config.maxSizeBytes) {
    return;
  }
  rotateLogFile(filePath, config.maxGenerations);
}

/** rotation 状態の観測結果（`hachi doctor` 等の診断向け）。 */
export interface LogRotationState {
  /** 現行ファイルのサイズ（バイト）。未作成なら 0 */
  currentSizeBytes: number;
  /** 世代ファイル（`.1`..）の合計サイズ（バイト） */
  rotatedSizeBytes: number;
  /** 実在する世代ファイル数 */
  generationCount: number;
}

/**
 * 現行ファイルと世代ファイル（`<filePath>.<数字>`）を走査し、サイズ・世代数を観測する。
 * maxGenerations を超えて残っている世代（rotate 実装のバグや手動コピーによる混入）も
 * 数字接尾辞であれば拾う。数字以外の接尾辞（`.bak` 等の無関係ファイル）は対象外。
 */
export function inspectLogRotationState(filePath: string): LogRotationState {
  const currentSizeBytes = existsSync(filePath) ? statSync(filePath).size : 0;

  const dir = dirname(filePath);
  const prefix = `${basename(filePath)}.`;
  let rotatedSizeBytes = 0;
  let generationCount = 0;
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith(prefix)) {
        continue;
      }
      const suffix = entry.slice(prefix.length);
      if (!/^\d+$/.test(suffix)) {
        continue;
      }
      rotatedSizeBytes += statSync(join(dir, entry)).size;
      generationCount += 1;
    }
  }

  return { currentSizeBytes, rotatedSizeBytes, generationCount };
}
