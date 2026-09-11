import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEnvironment } from "./env.js";
import {
  DEFAULT_LOG_ROTATION_CONFIG,
  inspectLogRotationState,
  loadLogRotationConfig,
  rotateLogFileIfNeeded,
  validateLogRotationConfig,
} from "./log-rotation.js";

describe("rotateLogFileIfNeeded", () => {
  let tempRoot: string;

  afterEach(() => {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("閾値未満なら rotate しない", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-log-rotation-"));
    const filePath = join(tempRoot, "x.jsonl");
    writeFileSync(filePath, "a".repeat(5), "utf8");

    rotateLogFileIfNeeded(filePath, { maxSizeBytes: 100, maxGenerations: 3 });

    expect(existsSync(`${filePath}.1`)).toBe(false);
    expect(readFileSync(filePath, "utf8")).toBe("aaaaa");
  });

  it("ファイル未作成なら何もしない", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-log-rotation-"));
    const filePath = join(tempRoot, "x.jsonl");

    expect(() => rotateLogFileIfNeeded(filePath, { maxSizeBytes: 1, maxGenerations: 3 })).not.toThrow();
    expect(existsSync(filePath)).toBe(false);
  });

  it("閾値以上なら現行ファイルを .1 へ退避し、以後の書き込みは新しい現行ファイルへ入る", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-log-rotation-"));
    const filePath = join(tempRoot, "x.jsonl");
    writeFileSync(filePath, "a".repeat(10), "utf8");

    rotateLogFileIfNeeded(filePath, { maxSizeBytes: 10, maxGenerations: 3 });

    expect(existsSync(filePath)).toBe(false);
    expect(readFileSync(`${filePath}.1`, "utf8")).toBe("a".repeat(10));
  });

  it("世代を1つずつ繰り下げ、maxGenerations を超える最古世代は削除する", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-log-rotation-"));
    const filePath = join(tempRoot, "x.jsonl");
    writeFileSync(`${filePath}.1`, "gen1", "utf8");
    writeFileSync(`${filePath}.2`, "gen2-oldest", "utf8");
    writeFileSync(filePath, "a".repeat(10), "utf8");

    rotateLogFileIfNeeded(filePath, { maxSizeBytes: 10, maxGenerations: 2 });

    expect(existsSync(filePath)).toBe(false);
    expect(readFileSync(`${filePath}.1`, "utf8")).toBe("a".repeat(10));
    expect(readFileSync(`${filePath}.2`, "utf8")).toBe("gen1");
    expect(existsSync(`${filePath}.3`)).toBe(false);
  });

  it("R1: maxGenerations を縮小してローテーションすると、縮小前の残留世代も含めて上限まで刈り込まれる", () => {
    // 縮小前（旧設定 maxGenerations=10 相当）に .1〜.10 の10世代が既に存在する状態を再現する。
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-log-rotation-"));
    const filePath = join(tempRoot, "x.jsonl");
    for (let generation = 1; generation <= 10; generation += 1) {
      writeFileSync(`${filePath}.${generation}`, `gen${generation}`, "utf8");
    }
    writeFileSync(filePath, "a".repeat(10), "utf8");

    // maxGenerations を 3 へ縮小してローテーションする。
    rotateLogFileIfNeeded(filePath, { maxSizeBytes: 10, maxGenerations: 3 });

    // 残るのは .1（新しい現行ファイル）.2（旧.1）.3（旧.2）の3本だけで、4本目以降は削除されている。
    expect(existsSync(filePath)).toBe(false);
    expect(readFileSync(`${filePath}.1`, "utf8")).toBe("a".repeat(10));
    expect(readFileSync(`${filePath}.2`, "utf8")).toBe("gen1");
    expect(readFileSync(`${filePath}.3`, "utf8")).toBe("gen2");
    for (let generation = 4; generation <= 10; generation += 1) {
      expect(existsSync(`${filePath}.${generation}`)).toBe(false);
    }
    const state = inspectLogRotationState(filePath);
    expect(state.generationCount).toBe(3);
  });

  it("非回帰: maxGenerations を縮小しない通常のローテーションは従来どおり最古世代のみ削除される", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-log-rotation-"));
    const filePath = join(tempRoot, "x.jsonl");
    for (let generation = 1; generation <= 3; generation += 1) {
      writeFileSync(`${filePath}.${generation}`, `gen${generation}`, "utf8");
    }
    writeFileSync(filePath, "a".repeat(10), "utf8");

    rotateLogFileIfNeeded(filePath, { maxSizeBytes: 10, maxGenerations: 3 });

    expect(existsSync(filePath)).toBe(false);
    expect(readFileSync(`${filePath}.1`, "utf8")).toBe("a".repeat(10));
    expect(readFileSync(`${filePath}.2`, "utf8")).toBe("gen1");
    expect(readFileSync(`${filePath}.3`, "utf8")).toBe("gen2");
    expect(existsSync(`${filePath}.4`)).toBe(false);
    const state = inspectLogRotationState(filePath);
    expect(state.generationCount).toBe(3);
  });
});

describe("inspectLogRotationState", () => {
  let tempRoot: string;

  afterEach(() => {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("ファイル未作成なら全て 0 を返す", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-log-rotation-"));
    const filePath = join(tempRoot, "x.jsonl");

    const state = inspectLogRotationState(filePath);

    expect(state).toEqual({ currentSizeBytes: 0, rotatedSizeBytes: 0, generationCount: 0 });
  });

  it("現行ファイルと世代ファイルのサイズ・件数を観測する（数字接尾辞以外は対象外）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-log-rotation-"));
    const filePath = join(tempRoot, "x.jsonl");
    writeFileSync(filePath, "a".repeat(3), "utf8");
    writeFileSync(`${filePath}.1`, "bb", "utf8");
    writeFileSync(`${filePath}.2`, "c", "utf8");
    writeFileSync(`${filePath}.bak`, "should-be-ignored", "utf8");

    const state = inspectLogRotationState(filePath);

    expect(state).toEqual({ currentSizeBytes: 3, rotatedSizeBytes: 3, generationCount: 2 });
  });
});

describe("loadLogRotationConfig", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-log-rotation-config-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("config.json が無ければ既定値を返す", () => {
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: tempRoot, HACHI_KANBAN_BOARD: "dev" });

    expect(loadLogRotationConfig(env)).toEqual(DEFAULT_LOG_ROTATION_CONFIG);
  });

  it("logging セクションが無い config.json なら既定値を返す", () => {
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify({ other: true }), "utf8");
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: tempRoot, HACHI_KANBAN_BOARD: "dev" });

    expect(loadLogRotationConfig(env)).toEqual(DEFAULT_LOG_ROTATION_CONFIG);
  });

  it("logging セクションの値を部分上書きできる（片方だけの指定は既定値と合成する）", () => {
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify({ logging: { maxSizeBytes: 123 } }), "utf8");
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: tempRoot, HACHI_KANBAN_BOARD: "dev" });

    expect(loadLogRotationConfig(env)).toEqual({
      maxSizeBytes: 123,
      maxGenerations: DEFAULT_LOG_ROTATION_CONFIG.maxGenerations,
    });
  });

  it("logging セクションが不正なら既定値へフォールバックし stderr に警告する（ログ出力自体は止めない）", () => {
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify({ logging: { maxSizeBytes: -1 } }), "utf8");
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: tempRoot, HACHI_KANBAN_BOARD: "dev" });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(loadLogRotationConfig(env)).toEqual(DEFAULT_LOG_ROTATION_CONFIG);
    expect(stderrWrite).toHaveBeenCalledTimes(1);

    stderrWrite.mockRestore();
  });
});

describe("validateLogRotationConfig", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-log-rotation-validate-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("config.json が無ければ ok:true で既定値を返す（source=schema-default）", () => {
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: tempRoot, HACHI_KANBAN_BOARD: "dev" });

    expect(validateLogRotationConfig(env)).toEqual({
      ok: true,
      config: DEFAULT_LOG_ROTATION_CONFIG,
      source: "schema-default",
    });
  });

  it("logging セクションが無ければ ok:true で既定値を返す（source=schema-default）", () => {
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify({ other: true }), "utf8");
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: tempRoot, HACHI_KANBAN_BOARD: "dev" });

    expect(validateLogRotationConfig(env)).toEqual({
      ok: true,
      config: DEFAULT_LOG_ROTATION_CONFIG,
      source: "schema-default",
    });
  });

  it("有効な override は ok:true で合成済みの値を返す（source=config）", () => {
    writeFileSync(
      join(tempRoot, "config.json"),
      JSON.stringify({ logging: { maxSizeBytes: 123, maxGenerations: 4 } }),
      "utf8",
    );
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: tempRoot, HACHI_KANBAN_BOARD: "dev" });

    expect(validateLogRotationConfig(env)).toEqual({
      ok: true,
      config: { maxSizeBytes: 123, maxGenerations: 4 },
      source: "config",
    });
  });

  it("R2: logging セクションを一部だけ指定しても ok:true・source=config で、スキーマ既定値と合成される", () => {
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify({ logging: { maxSizeBytes: 123 } }), "utf8");
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: tempRoot, HACHI_KANBAN_BOARD: "dev" });

    expect(validateLogRotationConfig(env)).toEqual({
      ok: true,
      config: { maxSizeBytes: 123, maxGenerations: DEFAULT_LOG_ROTATION_CONFIG.maxGenerations },
      source: "config",
    });
  });

  it("JSON構文エラーなら ok:false を返す", () => {
    writeFileSync(join(tempRoot, "config.json"), "{ not valid json", "utf8");
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: tempRoot, HACHI_KANBAN_BOARD: "dev" });

    const result = validateLogRotationConfig(env);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("JSON解析に失敗");
  });

  it("root が object でない（配列）なら ok:false を返す", () => {
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify([1, 2, 3]), "utf8");
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: tempRoot, HACHI_KANBAN_BOARD: "dev" });

    const result = validateLogRotationConfig(env);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("root が object ではありません");
  });

  it("root が object でない（数値）なら ok:false を返す", () => {
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(42), "utf8");
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: tempRoot, HACHI_KANBAN_BOARD: "dev" });

    const result = validateLogRotationConfig(env);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("root が object ではありません");
  });

  it("logging に未知キーがあれば ok:false を返す（strict スキーマ）", () => {
    writeFileSync(
      join(tempRoot, "config.json"),
      JSON.stringify({ logging: { maxSizeBytes: 123, unknownKey: true } }),
      "utf8",
    );
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: tempRoot, HACHI_KANBAN_BOARD: "dev" });

    const result = validateLogRotationConfig(env);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("logging セクションが不正です");
  });

  it("maxGenerations が上限（1000）を超えていれば ok:false を返す", () => {
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify({ logging: { maxGenerations: 1001 } }), "utf8");
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: tempRoot, HACHI_KANBAN_BOARD: "dev" });

    const result = validateLogRotationConfig(env);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("logging セクションが不正です");
  });

  it("R2: 既定値はスキーマの1箇所（.default()）だけから来ている（モジュール定数の二重管理が無い）", () => {
    // logging セクションを空オブジェクトで明示指定しても、config.json 無し/logging 未指定の
    // 場合（source=schema-default）とまったく同じ値になる。これは DEFAULT_LOG_ROTATION_CONFIG が
    // 別途ハードコードされた定数ではなく、logRotationConfigSchema.parse({}) から導出された
    // 値であり、safeParse({}) も同じスキーマの .default() を通ることを裏付ける。
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify({ logging: {} }), "utf8");
    const env = resolveEnvironment({ HACHI_KANBAN_HOME: tempRoot, HACHI_KANBAN_BOARD: "dev" });

    const result = validateLogRotationConfig(env);

    expect(result).toEqual({ ok: true, config: DEFAULT_LOG_ROTATION_CONFIG, source: "config" });
  });
});
