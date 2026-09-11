// =============================================================================
// packages/web/src/supervisor-status.ts の単体テスト（docs/contract.md §23.1）。
// readStages/readLastTick は実ファイルシステム上の一時ディレクトリで検証する。
// readLaunchd は「未ロードラベルでの degrade」を実 launchctl で、
// パース成功パスは spawnSync をモックして決定的に検証する（実機の launchd 常駐状態に依存しないため）。
// =============================================================================

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock は import 文より先に静的ホイストされるため、後方参照用の mock 関数は
// vi.hoisted で先出しする（Vitest 公式の推奨パターン）。
const spawnSyncMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>());
vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

// vi.mock 呼び出しはこの import より前にホイストされるため、以下は自動的にモック後の状態で解決される
import { STAGE_NAMES, isStageName, readLastTick, readLaunchd, readStages } from "./supervisor-status.js";

/** spawnSync の戻り値を最小限のフィールドだけ指定して組み立てる（SpawnSyncReturns<string> 準拠） */
function fakeSpawnResult(overrides: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  };
}

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "hachi-web-supervisor-status-"));
  spawnSyncMock.mockReset();
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

// ---------- STAGE_NAMES / isStageName ----------

describe("isStageName", () => {
  it("許可リストの全ステージ名を true と判定する", () => {
    for (const name of STAGE_NAMES) {
      expect(isStageName(name)).toBe(true);
    }
  });

  it("許可リスト外・パストラバーサル系文字列を false と判定する", () => {
    expect(isStageName("not-a-stage")).toBe(false);
    expect(isStageName("../dispatch")).toBe(false);
    expect(isStageName("")).toBe(false);
  });
});

// ---------- readStages ----------

describe("readStages", () => {
  it("kill-switch ファイルが無ければ全ステージ disabled:false を STAGE_NAMES の順で返す", () => {
    const result = readStages(tempHome);
    expect(result.map((s) => s.name)).toEqual([...STAGE_NAMES]);
    expect(result.every((s) => s.disabled === false)).toBe(true);
  });

  it("<home>/<stage>.disabled が存在するステージのみ disabled:true になる", () => {
    writeFileSync(join(tempHome, "dispatch.disabled"), "", { mode: 0o600 });
    writeFileSync(join(tempHome, "supervisor.disabled"), "", { mode: 0o600 });

    const result = readStages(tempHome);
    const disabled = result.filter((s) => s.disabled).map((s) => s.name);
    expect(disabled.sort()).toEqual(["dispatch", "supervisor"]);
  });
});

// ---------- readLaunchd ----------

// 「実在しないラベルで degrade する」実 launchctl 経路は app.test.ts（GET /api/supervisor）側で
// 実際の buildApp 経由で検証する（このファイルは spawnSync をモックしパース処理のみを対象にする）。
describe("readLaunchd", () => {
  it("spawnSync が非0終了なら null を返す（degrade）", () => {
    spawnSyncMock.mockReturnValue(fakeSpawnResult({ status: 113, stdout: "", stderr: "Bad request." }));
    expect(readLaunchd("com.hachi-kanban.supervisor")).toBeNull();
  });

  it("spawnSync が error を返したら null を返す（degrade。launchctl 不在等）", () => {
    spawnSyncMock.mockReturnValue(fakeSpawnResult({ status: null, error: new Error("ENOENT") }));
    expect(readLaunchd("com.hachi-kanban.supervisor")).toBeNull();
  });

  it("state=running かつ pid ありの出力を正しくパースする", () => {
    const stdout = [
      "gui/501/com.hachi-kanban.supervisor = {",
      "\tstate = running",
      "",
      "\tpid = 60710",
      "\tlast exit code = 0",
      "}",
    ].join("\n");
    spawnSyncMock.mockReturnValue(fakeSpawnResult({ status: 0, stdout }));

    const result = readLaunchd("com.hachi-kanban.supervisor");
    expect(result).toEqual({
      label: "com.hachi-kanban.supervisor",
      loaded: true,
      pid: 60710,
      lastExitCode: 0,
    });
  });

  it("pid 行が無い（未起動）出力は pid:null になる", () => {
    const stdout = ["gui/501/com.hachi-kanban.supervisor = {", "\tstate = not running", "}"].join("\n");
    spawnSyncMock.mockReturnValue(fakeSpawnResult({ status: 0, stdout }));

    const result = readLaunchd("com.hachi-kanban.supervisor");
    expect(result).toEqual({
      label: "com.hachi-kanban.supervisor",
      loaded: true,
      pid: null,
      lastExitCode: null,
    });
  });
});

// ---------- readLastTick ----------

/** supervisor.jsonl へ1行 JSON を追記するテストヘルパー */
function appendLogLine(filePath: string, entry: Record<string, unknown>): void {
  appendFileSync(filePath, logLine(entry), "utf8");
}

function logLine(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

function writeLogLines(filePath: string, entries: readonly Record<string, unknown>[]): void {
  writeFileSync(filePath, entries.map((entry) => logLine(entry)).join(""), "utf8");
}

describe("readLastTick", () => {
  function logPath(): string {
    return join(tempHome, "logs", "supervisor.jsonl");
  }

  it("ログファイルが無ければ null を返す", () => {
    expect(readLastTick(tempHome)).toBeNull();
  });

  it("--once モード（単一集約ログ行）から直近 tick を復元する", () => {
    mkdirSync(join(tempHome, "logs"), { recursive: true });
    const path = logPath();
    // 個別ステージ行 → 集約行、の順（packages/supervisor/src/main.ts の実際の出力順）
    appendLogLine(path, { ts: "2026-07-03T00:00:00.000Z", level: "info", msg: "stage completed", stage: "dispatch", actions: 1, notes: [] });
    appendLogLine(path, { ts: "2026-07-03T00:00:00.010Z", level: "info", msg: "stage completed", stage: "monitor", actions: 0, notes: [] });
    appendLogLine(path, {
      ts: "2026-07-03T00:00:00.020Z",
      level: "info",
      msg: "single tick完了",
      results: [
        { name: "dispatch", actions: 1, skipped: false },
        { name: "monitor", actions: 0, skipped: false },
      ],
    });

    const result = readLastTick(tempHome);
    expect(result).toEqual({
      at: "2026-07-03T00:00:00.020Z",
      stages: [
        { name: "dispatch", actions: 1, skipped: false },
        { name: "monitor", actions: 0, skipped: false },
      ],
    });
  });

  it("常駐ループ（個別ステージ行のみ）から直近 tick を末尾の連続run分だけ復元する", () => {
    mkdirSync(join(tempHome, "logs"), { recursive: true });
    const path = logPath();
    appendLogLine(path, { ts: "t0", level: "info", msg: "supervisor start", intervalSec: 30 });
    // 1つ目の tick（古い。復元対象外）
    appendLogLine(path, { ts: "t1", level: "info", msg: "stage completed", stage: "dispatch", actions: 5, notes: [] });
    appendLogLine(path, { ts: "t2", level: "info", msg: "stage completed", stage: "monitor", actions: 5, notes: [] });
    // 2つ目の tick（直近。これが復元対象）
    appendLogLine(path, { ts: "t3", level: "info", msg: "stage completed", stage: "dispatch", actions: 0, notes: [] });
    appendLogLine(path, { ts: "t4", level: "info", msg: "stage skipped (kill-switch)", stage: "monitor" });
    appendLogLine(path, { ts: "t5", level: "error", msg: "stage failed", stage: "finalize", error: "boom" });

    const result = readLastTick(tempHome);
    expect(result).toEqual({
      at: "t5",
      stages: [
        { name: "dispatch", actions: 0, skipped: false },
        { name: "monitor", actions: 0, skipped: true },
        { name: "finalize", actions: 0, skipped: false },
      ],
    });
  });

  it("webwatch の warn が stage completed の直前に挟まっても直近 tick 全体を復元する", () => {
    mkdirSync(join(tempHome, "logs"), { recursive: true });
    const path = logPath();
    const cycle = [
      "scheduler",
      "dispatch",
      "monitor",
      "finalize",
      "review",
      "messages",
      "reap",
      "notify",
      "webwatch",
    ] as const;

    for (const stage of cycle) {
      appendLogLine(path, {
        ts: `old-${stage}`,
        level: "info",
        msg: "stage completed",
        stage,
        actions: 0,
        notes: [],
      });
    }
    for (const [index, stage] of cycle.slice(0, -1).entries()) {
      appendLogLine(path, {
        ts: `current-${stage}`,
        level: "info",
        msg: "stage completed",
        stage,
        actions: index + 1,
        notes: [],
      });
    }
    appendLogLine(path, {
      ts: "current-webwatch-warn",
      level: "warn",
      msg: "webwatch: healthz に失敗しました",
      kind: "non-2xx",
      detail: "status=503",
      consecutiveFailures: 1,
    });
    appendLogLine(path, {
      ts: "current-webwatch",
      level: "info",
      msg: "stage completed",
      stage: "webwatch",
      actions: 9,
      notes: ["healthz failure: non-2xx (status=503) consecutive=1"],
    });

    const result = readLastTick(tempHome);
    expect(result).toEqual({
      at: "current-webwatch",
      stages: cycle.map((stage, index) => ({ name: stage, actions: index + 1, skipped: false })),
    });
  });

  it("末尾が非ステージ行（shutdown 等）なら null を返す", () => {
    mkdirSync(join(tempHome, "logs"), { recursive: true });
    const path = logPath();
    appendLogLine(path, { ts: "t1", level: "info", msg: "stage completed", stage: "dispatch", actions: 0, notes: [] });
    appendLogLine(path, { ts: "t2", level: "info", msg: "supervisor shutdown", signal: "SIGTERM" });

    expect(readLastTick(tempHome)).toBeNull();
  });

  it("ファイルが TAIL_BYTES を大きく超えていても末尾 tail 読みだけで直近 tick を正しく復元する", () => {
    mkdirSync(join(tempHome, "logs"), { recursive: true });
    const path = logPath();
    // 実際の tick 形状（9ステージを1回ずつ、実行順で）を模したパディング tick を大量に書き込み、
    // 32KB(TAIL_BYTES) を大きく超えさせる（全読み禁止の検証: tail 読みでも壊れないこと）
    const cycle = [
      "scheduler",
      "dispatch",
      "monitor",
      "finalize",
      "review",
      "messages",
      "reap",
      "notify",
      "webwatch",
    ] as const;
    const entries: Record<string, unknown>[] = [];
    for (let tick = 0; tick < 200; tick += 1) {
      for (const stage of cycle) {
        entries.push({
          ts: `pad-${tick}-${stage}`,
          level: "info",
          msg: "stage completed",
          stage,
          actions: 0,
          notes: [],
        });
      }
    }
    // 直近1 tick（全9ステージ、actions を変えて識別可能にする）
    for (const [index, stage] of cycle.entries()) {
      entries.push({
        ts: `final-${stage}`,
        level: "info",
        msg: "stage completed",
        stage,
        actions: index + 1,
        notes: [],
      });
    }
    writeLogLines(path, entries);

    const result = readLastTick(tempHome);
    expect(result).toEqual({
      at: "final-webwatch",
      stages: cycle.map((stage, index) => ({ name: stage, actions: index + 1, skipped: false })),
    });
  });
});
