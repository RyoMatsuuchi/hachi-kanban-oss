// task_runs.meta への統計書き込み（単一 writer、契約 §14.5 / 設計 §4.3）を固定する。
import { describe, expect, it, vi } from "vitest";
import type { Logger, RunRow, RunUsage, SessionRef, SessionStatus, WorkerAdapter } from "@hachi/core";
import { buildEndRunMeta, endStatsFromStatus, fetchEndRunStats } from "./end-run-meta.js";

function fakeRun(meta: string): RunRow {
  return {
    id: 1,
    taskId: "t_x",
    provider: "claude",
    sessionId: "direct-abc",
    startedAt: 0,
    endedAt: null,
    status: "running",
    meta,
  } as RunRow;
}

const USAGE: RunUsage = {
  costUsd: { state: "estimated", value: 0.42, basis: "price-table", priceTableRef: "litellm@abc(2026-08-20)" },
  inputTokens: { state: "measured", value: 10, provenance: "cli-native-session-log" },
  outputTokens: { state: "measured", value: 20, provenance: "cli-native-session-log" },
  cacheCreationTokens: { state: "measured", value: 30, provenance: "cli-native-session-log" },
  cacheReadTokens: { state: "measured", value: 144970, provenance: "cli-native-session-log" },
  turns: { state: "measured", value: 3, provenance: "cli-native-session-log" },
  durationMs: { state: "measured", value: 1000, provenance: "cli-native-session-log" },
  collectedBy: "direct-claude@native-log-v1",
};

describe("buildEndRunMeta", () => {
  it("usage を meta.usage へ書き、既存 meta と lastResult を壊さない", () => {
    const meta = buildEndRunMeta(fakeRun('{"serverUrl":"direct","model":"claude-opus-5"}'), {
      lastResult: { costUsd: 1.5, inputTokens: 2 },
      usage: USAGE,
    });

    expect(meta).toEqual({
      serverUrl: "direct",
      model: "claude-opus-5",
      lastResult: { costUsd: 1.5, inputTokens: 2 },
      usage: USAGE,
    });
  });

  it("lastResult が無くても usage だけで meta を書く（direct 経路は lastResult を持たない）", () => {
    const meta = buildEndRunMeta(fakeRun('{"serverUrl":"direct"}'), { usage: USAGE });
    expect(meta?.usage).toEqual(USAGE);
    expect(meta?.lastResult).toBeUndefined();
  });

  it("旧 lastResult を usage で上書きしない（別キーとして共存する）", () => {
    const meta = buildEndRunMeta(fakeRun('{"lastResult":{"costUsd":9}}'), { usage: USAGE });
    expect(meta?.lastResult).toEqual({ costUsd: 9 });
    expect(meta?.usage).toEqual(USAGE);
  });

  it("統計も extraMeta も無ければ undefined を返し既存 meta を保持させる", () => {
    expect(buildEndRunMeta(fakeRun('{"serverUrl":"direct"}'), {})).toBeUndefined();
  });

  it("meta が壊れた JSON でも fail-closed で空扱いにし、統計は書ける", () => {
    const meta = buildEndRunMeta(fakeRun("{壊れた"), { usage: USAGE });
    expect(meta).toEqual({ usage: USAGE });
  });
});

describe("fetchEndRunStats", () => {
  const ref = { sessionId: "direct-abc" } as SessionRef;
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

  it("adapter.status の lastResult と usage を両方取り出す", async () => {
    const status: SessionStatus = { state: "idle", lastActivityAt: null, usage: USAGE, lastResult: { turns: 1 } };
    const adapter = { status: async () => status } as unknown as WorkerAdapter;

    await expect(fetchEndRunStats(adapter, ref, logger, "t_x", "finalize")).resolves.toEqual({
      lastResult: { turns: 1 },
      usage: USAGE,
    });
  });

  it("status() が投げても endRun をブロックせず空統計を返す", async () => {
    const adapter = {
      status: async () => {
        throw new Error("bridge down");
      },
    } as unknown as WorkerAdapter;

    await expect(fetchEndRunStats(adapter, ref, logger, "t_x", "review")).resolves.toEqual({});
  });
});

describe("endStatsFromStatus", () => {
  it("未提供のキーは省略する（exactOptionalPropertyTypes 対応）", () => {
    expect(endStatsFromStatus({ })).toEqual({});
    expect(Object.keys(endStatsFromStatus({ usage: USAGE }))).toEqual(["usage"]);
  });
});
