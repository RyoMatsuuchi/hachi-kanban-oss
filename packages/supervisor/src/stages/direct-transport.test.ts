// direct transport の統合テスト（契約 §17.3）:
// 偽 codexBin fixture を使い、dispatch→(direct 起動)→monitor→finalize が pickAdapter 経由で
// direct adapter にルーティングされ、handoff 付き out ファイルで done まで到達することを検証する。
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskInput } from "@hachi/testing";
import { DirectCodexAdapter } from "@hachi/adapters";
import type { HachiConfig } from "@hachi/core";
import { setupHarness, type TestHarness } from "../test-support.js";
import { dispatchStage } from "./dispatch.js";
import { monitorStage } from "./monitor.js";
import { finalizeStage } from "./finalize.js";

/** direct-impl profile を含む config（profiles はシャローマージで丸ごと置換されるため全 profile を列挙） */
const DIRECT_PROFILES: HachiConfig["profiles"] = {
  plan: { provider: "claude", model: "claude-opus-4-6" },
  review: { provider: "codex", model: "gpt-5.5" },
  implement: { provider: "codex", model: "gpt-5.4" },
  docs: { provider: "claude", model: "claude-sonnet-5" },
  "direct-impl": { provider: "codex", model: "gpt-5.4", transport: "direct" },
};

/** 実行可能な偽 codex fixture を書き出す。指定 taskId の hachi-handoff-v1(done) を stdout に出す。 */
function writeHandoffFixture(dir: string, taskId: string): string {
  const path = join(dir, "fake-codex-handoff.sh");
  const script = [
    "#!/bin/sh",
    "echo '直接実行で作業を完了しました。'",
    "echo '```hachi-handoff-v1'",
    `echo '{"taskId": "${taskId}", "outcome": "done", "summary": "direct 統合テスト完了"}'`,
    "echo '```'",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
  return path;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe("direct transport 統合（dispatch→monitor→finalize, 契約 §17.3）", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await setupHarness({ profiles: DIRECT_PROFILES });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("direct 起動→monitor(session_ended)→finalize(done) を偽 codexBin で完走する", async () => {
    const home = harness.home.home;
    const stateDir = join(home, "state", "direct-sessions");
    // cwd は絶対パスであればよい（fixture は --cd を無視する）
    const cwd = home;

    const task = harness.store.createTask(
      // worker の done 申告で done へ直行させる（§76 既定 required の review 遷移を避ける）
      taskInput({
        status: "ready",
        profile: "direct-impl",
        title: "direct 統合",
        body: `cwd: ${cwd}\nreview-policy: worker-outcome`,
      }),
      "tester",
    );

    // fixture は task.id を埋めた handoff を出力する
    const fixture = writeHandoffFixture(home, task.id);
    harness.deps.directAdapters = {
      codex: new DirectCodexAdapter({ stateDir, artifactsDir: harness.home.env.artifactsDir, codexBin: fixture }),
    };

    // 1) dispatch: direct 起動 → blocked(in-progress) + serverUrl=direct の run
    const dispatchResult = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(dispatchResult.actions).toBe(1);

    const run = harness.store.getLatestOpenRun(task.id);
    expect(run).not.toBeNull();
    const meta = JSON.parse(run!.meta) as Record<string, unknown>;
    expect(meta.serverUrl).toBe("direct");
    expect(meta.transport).toBe("direct");

    // 2) 偽 codex の完了（exit ファイル生成）を待つ
    const sessionId = run!.sessionId;
    const exitFile = join(stateDir, `${sessionId}.exit`);
    expect(await waitUntil(() => existsSync(exitFile))).toBe(true);

    // 3) monitor: idle+resultCount=1 を検知して session_ended を記録（pickAdapter が direct へルーティング）
    const monitorResult = await monitorStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(monitorResult.actions).toBe(1);
    expect(harness.store.listEvents(task.id, "session_ended")).toHaveLength(1);

    // 4) finalize: out ファイルの handoff を検証して done へ遷移
    const finalizeResult = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(finalizeResult.actions).toBe(1);

    const done = harness.store.getTask(task.id);
    expect(done?.status).toBe("done");

    // open run は done で close されている
    expect(harness.store.listOpenRuns()).toHaveLength(0);

    // ワーカー完了報告コメントが記録されている
    const hasReport = harness.store
      .listComments(task.id)
      .some((c) => c.body.includes("direct 統合テスト完了"));
    expect(hasReport).toBe(true);
  });
});
