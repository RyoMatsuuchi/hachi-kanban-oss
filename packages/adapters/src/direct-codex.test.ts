import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { measuredValue } from "@hachi/core";
import type { LaunchOptions, SessionRef, TaskRow } from "@hachi/core";
import { DirectCodexAdapter } from "./direct-codex.js";
import { isProcessAlive, isProcessGroupAlive, readDirectSessionState } from "./direct-process.js";

/** テスト用 TaskRow を組み立てる */
function fakeTask(): TaskRow {
  return {
    id: "t_direct01",
    title: "direct テストタスク",
    body: "",
    status: "ready",
    priority: 0,
    tenant: "",
    assignee: "",
    provider: "",
    profile: "",
    modelOverride: "",
    effortOverride: "",
    speedOverride: "",
    reviewProfileOverride: "",
    reviewProviderOverride: "",
    reviewModelOverride: "",
    reviewEffortOverride: "",
    reviewSpeedOverride: "",
    blockReason: "",
    claimLock: "",
    watched: false,
    consecutiveFailures: 0,
    lastFailureError: "",
    lastHeartbeatAt: null,
    maxRetries: 3,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
  };
}

/** production Steward stageだけが生成する reserved virtual task。 */
function virtualStewardTask(): TaskRow {
  return {
    ...fakeTask(),
    id: "steward",
    tenant: "system",
    profile: "steward",
    status: "blocked",
  };
}

function launchOptions(cwd: string): LaunchOptions {
  return { model: "gpt-5.4", cwd, promptText: "OK とだけ出力して終了してください" };
}

/** 実行可能な偽 codex シェルスクリプト（fixture）を書き出し、その絶対パスを返す */
function writeFixture(dir: string, name: string, script: string): string {
  const path = join(dir, name);
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/** 条件が真になるまで最大 timeoutMs だけポーリングする（detached プロセスの完了待ち） */
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

describe("DirectCodexAdapter", () => {
  let tempRoot: string;
  let stateDir: string;
  let artifactsDir: string;
  let cwd: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-direct-"));
    stateDir = join(tempRoot, "state", "direct-sessions");
    artifactsDir = join(tempRoot, "artifacts");
    cwd = tempRoot;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("provider は 'codex'", () => {
    const adapter = new DirectCodexAdapter({ stateDir, artifactsDir });
    expect(adapter.provider).toBe("codex");
  });

  it("launch→active→(完了後)idle+resultCount=1→fetchTranscript の全行程（偽 codexBin fixture）", async () => {
    // 少しスリープしてから出力する fixture。launch 直後は active、完了後は idle+resultCount=1 になる。
    const fixture = writeFixture(
      tempRoot,
      "fake-codex-sleep.sh",
      "#!/bin/sh\nsleep 0.4\necho '直接実行 OK'\nexit 0\n",
    );
    const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture });

    const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
    expect(ref.provider).toBe("codex");
    expect(ref.sessionId.startsWith("direct-")).toBe(true);
    expect(ref.serverUrl).toBe("direct");
    expect(ref.modelDelivery).toBe("native");
    expect(ref.model).toBe("gpt-5.4");

    // 起動直後（sleep 中）は active
    const running = await adapter.status(ref);
    expect(running.state).toBe("active");

    // exit ファイルが生成されるまで待つ → idle + resultCount=1
    const exitFile = join(stateDir, `${ref.sessionId}.exit`);
    expect(await waitUntil(() => existsSync(exitFile))).toBe(true);

    const done = await adapter.status(ref);
    expect(done.state).toBe("idle");
    expect(done.resultCount).toBe(1);

    // fetchTranscript は out ファイル全文を返す
    const transcript = await adapter.fetchTranscript(ref);
    expect(transcript).toContain("直接実行 OK");
  });

  it("exit ファイル無し + pid 消失（クラッシュ相当）でも idle+resultCount=1 になる（契約 §17.2）", async () => {
    // 即座に終了する fixture。完了後に exit ファイルを削除して「exit 無し + pid 死」状態を作る。
    const fixture = writeFixture(tempRoot, "fake-codex-fast.sh", "#!/bin/sh\necho done\nexit 0\n");
    const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture });

    const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
    const exitFile = join(stateDir, `${ref.sessionId}.exit`);
    expect(await waitUntil(() => existsSync(exitFile))).toBe(true);
    const state = readDirectSessionState(stateDir, ref.sessionId);
    if (state === null) {
      throw new Error("direct session state を読めませんでした");
    }
    expect(await waitUntil(() => !isProcessAlive(state.pid))).toBe(true);

    // exit ファイルを消すと第1分岐は外れる。pid 消失を確認済みのため第3分岐（idle）へ倒れる。
    unlinkSync(exitFile);
    const status = await adapter.status(ref);
    expect(status.state).toBe("idle");
    expect(status.resultCount).toBe(1);
  });

  it("fetchTranscript は out ファイルが無ければ '(出力ファイルなし)' を返す", async () => {
    const adapter = new DirectCodexAdapter({ stateDir, artifactsDir });
    const ref: SessionRef = {
      provider: "codex",
      sessionId: "direct-deadbeefdeadbeef",
      serverUrl: "direct",
      model: "gpt-5.4",
      modelDelivery: "native",
      startedAt: 0,
    };
    const transcript = await adapter.fetchTranscript(ref);
    expect(transcript).toBe("(出力ファイルなし)");
  });

  it("inject は steer 非対応として throw する（契約 §17.2）", async () => {
    const adapter = new DirectCodexAdapter({ stateDir, artifactsDir });
    const ref: SessionRef = {
      provider: "codex",
      sessionId: "direct-0011223344556677",
      serverUrl: "direct",
      model: "gpt-5.4",
      modelDelivery: "native",
      startedAt: 0,
    };
    await expect(adapter.inject(ref, "続けて")).rejects.toThrow(/steer 非対応/);
  });

  it("healthCheck は codexBin が PATH にあれば true", async () => {
    const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: "sh" });
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it("healthCheck は codexBin が存在しなければ false", async () => {
    const adapter = new DirectCodexAdapter({
      stateDir,
      artifactsDir,
      codexBin: "definitely-not-a-real-binary-xyz-hachi",
    });
    await expect(adapter.healthCheck()).resolves.toBe(false);
  });

  it("cwd にシングルクォートを含む場合は launch を reject する（コマンドインジェクション防止）", async () => {
    const fixture = writeFixture(tempRoot, "fake-codex-x.sh", "#!/bin/sh\necho x\n");
    const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture });
    await expect(adapter.launch(fakeTask(), launchOptions("/tmp/eb'il"))).rejects.toThrow(/シングルクォート/);
  });

  it("reserved virtual Stewardだけをread-only/ephemeral/env非継承で起動する", async () => {
    const argsFile = join(tempRoot, "steward-args.txt");
    const fixture = writeFixture(
      tempRoot,
      "fake-codex-args.sh",
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho done\n`,
    );
    const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture });

    const ref = await adapter.launch(virtualStewardTask(), launchOptions(cwd));
    const exitFile = join(stateDir, `${ref.sessionId}.exit`);
    expect(await waitUntil(() => existsSync(exitFile))).toBe(true);
    const args = readFileSync(argsFile, "utf8").split("\n");

    expect(args).toContain("read-only");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("shell_environment_policy.inherit=none");
    expect(args).not.toContain("--skip-git-repo-check");
  });

  it("通常taskにはSteward隔離flagを付けない", async () => {
    const argsFile = join(tempRoot, "worker-args.txt");
    const fixture = writeFixture(
      tempRoot,
      "fake-codex-worker-args.sh",
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho done\n`,
    );
    const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture });

    const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
    const exitFile = join(stateDir, `${ref.sessionId}.exit`);
    expect(await waitUntil(() => existsSync(exitFile))).toBe(true);
    const args = readFileSync(argsFile, "utf8");

    expect(args).not.toContain("read-only");
    expect(args).not.toContain("--ephemeral");
    expect(args).not.toContain("--ignore-user-config");
    expect(args).not.toContain("--ignore-rules");
    expect(args).not.toContain("shell_environment_policy.inherit=none");
    expect(args).not.toContain("--skip-git-repo-check");
  });

  it("spawn後のstate永続化失敗ではprocess groupを回収してからthrowする", async () => {
    const fixture = writeFixture(
      tempRoot,
      "fake-codex-state-fail.sh",
      "#!/bin/sh\nsleep 30\n",
    );
    let spawnedPid = 0;
    const adapter = new DirectCodexAdapter({
      stateDir,
      artifactsDir,
      codexBin: fixture,
      stopPollIntervalMs: 10,
      stopMaxWaitMs: 100,
      stateWriter: (_dir, _sessionId, state) => {
        spawnedPid = state.pid;
        throw new Error("state write failed");
      },
    });

    await expect(adapter.launch(fakeTask(), launchOptions(cwd))).rejects.toThrow("state write failed");
    expect(spawnedPid).toBeGreaterThan(0);
    expect(await waitUntil(() => !isProcessGroupAlive(spawnedPid))).toBe(true);
  });

  it.each([
    ["id", { id: "t_steward-near" }],
    ["tenant", { tenant: "hachi-kanban" }],
    ["profile", { profile: "implement" }],
    ["status", { status: "ready" as const }],
  ])("reserved identityの%sだけが違うnear-matchには隔離flagを付けない", async (field, override) => {
    const argsFile = join(tempRoot, `near-${field}-args.txt`);
    const fixture = writeFixture(
      tempRoot,
      `fake-codex-near-${field}.sh`,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho done\n`,
    );
    const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture });
    const task = { ...virtualStewardTask(), ...override };

    const ref = await adapter.launch(task, launchOptions(cwd));
    const exitFile = join(stateDir, `${ref.sessionId}.exit`);
    expect(await waitUntil(() => existsSync(exitFile))).toBe(true);
    const args = readFileSync(argsFile, "utf8");

    expect(args).not.toContain("read-only");
    expect(args).not.toContain("--ephemeral");
    expect(args).not.toContain("shell_environment_policy.inherit=none");
  });

  describe("stop（契約 §34.2）", () => {
    it("長時間 sleep するプロセスを SIGTERM で回収する（terminated）", async () => {
      // sleep 完了後に echo する fixture。stop が本当にプロセスツリーを止めているなら、
      // sleep の残り時間を待っても echo は実行されないはず。
      const fixture = writeFixture(
        tempRoot,
        "fake-codex-longsleep.sh",
        "#!/bin/sh\nsleep 5\necho SHOULD_NOT_APPEAR\nexit 0\n",
      );
      const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture });
      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));

      const running = await adapter.status(ref);
      expect(running.state).toBe("active");

      const result = await adapter.stop(ref);
      expect(result).toEqual({ stopped: true, reason: "terminated" });

      // sleep の残り時間内に確認しても echo が実行されていないこと（プロセスグループごと停止した証拠）
      await new Promise((resolve) => setTimeout(resolve, 300));
      const transcript = await adapter.fetchTranscript(ref);
      expect(transcript).not.toContain("SHOULD_NOT_APPEAR");

      const after = await adapter.status(ref);
      expect(after.state).toBe("idle");
    });

    it("既にプロセスが終了している場合は stopped:false を返す（already-exited、稀に unsignalable）", async () => {
      const fixture = writeFixture(tempRoot, "fake-codex-already-done.sh", "#!/bin/sh\necho done\nexit 0\n");
      const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture });
      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
      const exitFile = join(stateDir, `${ref.sessionId}.exit`);
      expect(await waitUntil(() => existsSync(exitFile))).toBe(true);

      const result = await adapter.stop(ref);
      // 実プロセス・実 pid を使うテストのため、契約 §34.2.1 が明示する pid 再利用レースを
      // 排除できない: leader 終了後に OS が同じ pid/pgid を無関係な（別 uid 所有等の）
      // プロセスへ再割当てすると、observeProcessGroup/killProcessGroup が本物の EPERM を
      // 受け取り unsignalable になる（2026-08-25 実測: 高並列実行下で
      // `packages/adapters` を6回連続実行し1回再現、target pid は本テストと無関係な
      // 実在プロセス）。どちらの reason でも「この呼び出しは停止させていない」
      // （stopped:false）という契約上の意味は変わらないため、両方を許容する。
      // 決定論的な reason の作り分けは direct-process.test.ts の表駆動テスト（scripted DI）が正本。
      expect(result.stopped).toBe(false);
      expect(["already-exited", "unsignalable"]).toContain(result.reason);
    });
  });

  describe("effort 伝搬（契約 §35.3）", () => {
    it("effort 指定時は -c model_reasoning_effort=<effort> を起動スクリプトへ付与し、effortDelivery='native' を記録する", async () => {
      // 自身への argv をそのまま stdout（= outFile）へ echo する fixture
      const fixture = writeFixture(tempRoot, "fake-codex-argv.sh", '#!/bin/sh\necho "$@"\nexit 0\n');
      const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture });
      const options: LaunchOptions = { model: "gpt-5.4", cwd, promptText: "hi", effort: "high" };

      const ref = await adapter.launch(fakeTask(), options);
      expect(ref.effortDelivery).toBe("native");

      const exitFile = join(stateDir, `${ref.sessionId}.exit`);
      expect(await waitUntil(() => existsSync(exitFile))).toBe(true);
      const transcript = await adapter.fetchTranscript(ref);
      expect(transcript).toContain("model_reasoning_effort=high");
    });

    it("effort 未指定時は effortDelivery キー自体を省略し、起動スクリプトにも effort フラグを付与しない", async () => {
      const fixture = writeFixture(tempRoot, "fake-codex-noeffort.sh", '#!/bin/sh\necho "$@"\nexit 0\n');
      const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture });
      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
      expect("effortDelivery" in ref).toBe(false);

      const exitFile = join(stateDir, `${ref.sessionId}.exit`);
      expect(await waitUntil(() => existsSync(exitFile))).toBe(true);
      const transcript = await adapter.fetchTranscript(ref);
      expect(transcript).not.toContain("model_reasoning_effort");
    });
  });

  describe("speed 伝搬（契約 §67）", () => {
    it("fast は process-local fast 設定を配送し、max effort と併用できる", async () => {
      const fixture = writeFixture(tempRoot, "fake-codex-fast-argv.sh", '#!/bin/sh\necho "$@"\nexit 0\n');
      const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture });
      const ref = await adapter.launch(fakeTask(), {
        model: "gpt-5.6-sol",
        cwd,
        promptText: "hi",
        effort: "max",
        speed: "fast",
      });

      expect(ref.effortDelivery).toBe("native");
      expect(ref.speedDelivery).toBe("native");
      const exitFile = join(stateDir, `${ref.sessionId}.exit`);
      expect(await waitUntil(() => existsSync(exitFile))).toBe(true);
      const transcript = await adapter.fetchTranscript(ref);
      expect(transcript).toContain("model_reasoning_effort=max");
      expect(transcript).toContain('service_tier="fast"');
      expect(transcript).toContain("--enable fast_mode");
    });

    it("standard は user config の fast を明示的に無効化する", async () => {
      const fixture = writeFixture(tempRoot, "fake-codex-standard-argv.sh", '#!/bin/sh\necho "$@"\nexit 0\n');
      const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture });
      const ref = await adapter.launch(fakeTask(), {
        model: "gpt-5.6-sol", cwd, promptText: "hi", speed: "standard",
      });

      expect(ref.speedDelivery).toBe("native");
      const exitFile = join(stateDir, `${ref.sessionId}.exit`);
      expect(await waitUntil(() => existsSync(exitFile))).toBe(true);
      const transcript = await adapter.fetchTranscript(ref);
      expect(transcript).toContain('service_tier="default"');
      expect(transcript).toContain("--disable fast_mode");
    });

    it("speed 未指定は従来互換で speed 設定を一切追加しない", async () => {
      const fixture = writeFixture(tempRoot, "fake-codex-nospeed.sh", '#!/bin/sh\necho "$@"\nexit 0\n');
      const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture });
      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));

      expect("speedDelivery" in ref).toBe(false);
      const exitFile = join(stateDir, `${ref.sessionId}.exit`);
      expect(await waitUntil(() => existsSync(exitFile))).toBe(true);
      const transcript = await adapter.fetchTranscript(ref);
      expect(transcript).not.toContain("service_tier");
      expect(transcript).not.toContain("fast_mode");
    });
  });
  describe("usage 計測（設計 R1〜R4 / 契約 §14.5）", () => {
    const CODEX_SESSION_ID = "019fca67-dea1-79c0-98af-ce4b3f029264";

    /** codex exec の実ヘッダ（`session id:` 行を含む）を stdout へ出す fixture */
    function codexHeaderScript(sessionId: string, body = "完了しました"): string {
      return [
        "#!/bin/sh",
        "cat <<'EOF'",
        "OpenAI Codex v0.144.1",
        "--------",
        "workdir: /tmp/example",
        "model: gpt-5.6-sol",
        "provider: openai",
        "approval: never",
        "sandbox: read-only",
        "reasoning effort: high",
        "reasoning summaries: none",
        `session id: ${sessionId}`,
        "--------",
        body,
        "EOF",
        "exit 0",
        "",
      ].join("\n");
    }

    /** rollout（token_count イベント付き）を fixture として書く */
    function writeRollout(sessionsRoot: string, sessionId: string, rows: readonly unknown[]): void {
      const dir = join(sessionsRoot, "2026", "08", "20");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `rollout-2026-08-20T10-33-52-${sessionId}.jsonl`),
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
        "utf8",
      );
    }

    function tokenCount(timestamp: string, totals: Record<string, number>): Record<string, unknown> {
      return {
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: totals },
          rate_limits: { plan_type: "pro", credits: { balance: "0" } },
        },
      };
    }

    it("`.out` ヘッダの session id で rollout を exact 特定し、4系統を measured で記録する", async () => {
      const sessionsRoot = join(tempRoot, "codex-sessions");
      writeRollout(sessionsRoot, CODEX_SESSION_ID, [
        { timestamp: "2026-08-20T01:00:00.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
        tokenCount("2026-08-20T01:00:10.000Z", {
          input_tokens: 28_093,
          cached_input_tokens: 1_792,
          cache_write_input_tokens: 100,
          output_tokens: 713,
          reasoning_output_tokens: 435,
          total_tokens: 28_806,
        }),
      ]);
      const fixture = writeFixture(tempRoot, "fake-codex-usage.sh", codexHeaderScript(CODEX_SESSION_ID));
      const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture, codexSessionsRoot: sessionsRoot });

      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
      expect(await waitUntil(() => existsSync(join(stateDir, `${ref.sessionId}.exit`)))).toBe(true);

      const usage = (await adapter.status(ref)).usage;
      expect(usage?.collectedBy).toBe("direct-codex@native-log-v1");
      // cached は input の内数なので純 input は 28,093 - 1,792。
      expect(usage?.inputTokens).toEqual({ state: "measured", value: 26_301, provenance: "cli-native-session-log" });
      expect(usage?.cacheReadTokens).toEqual({ state: "measured", value: 1_792, provenance: "cli-native-session-log" });
      expect(usage?.cacheCreationTokens).toEqual({ state: "measured", value: 100, provenance: "cli-native-session-log" });
      // reasoning(435) は output(713) の内数なので加算しない。
      expect(usage?.outputTokens).toEqual({ state: "measured", value: 713, provenance: "cli-native-session-log" });
      expect(usage?.models).toEqual(["gpt-5.6-sol"]);
    });

    it("cost は estimated（価格表由来）で、measured とは別 state になり合算されない", async () => {
      const sessionsRoot = join(tempRoot, "codex-sessions-cost");
      writeRollout(sessionsRoot, CODEX_SESSION_ID, [
        { timestamp: "2026-08-20T01:00:00.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
        tokenCount("2026-08-20T01:00:10.000Z", {
          input_tokens: 1_000,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 100,
          reasoning_output_tokens: 0,
          total_tokens: 1_100,
        }),
      ]);
      const fixture = writeFixture(tempRoot, "fake-codex-cost.sh", codexHeaderScript(CODEX_SESSION_ID));
      const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture, codexSessionsRoot: sessionsRoot });

      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
      expect(await waitUntil(() => existsSync(join(stateDir, `${ref.sessionId}.exit`)))).toBe(true);

      const usage = (await adapter.status(ref)).usage;
      if (usage?.costUsd.state !== "estimated") {
        throw new Error(`estimated であること: ${JSON.stringify(usage?.costUsd)}`);
      }
      expect(usage.costUsd.basis).toBe("price-table");
      expect(usage.costUsd.priceTableRef).toMatch(/^litellm@[0-9a-f]{40}\(/);
      expect(usage.costUsd.value).toBeGreaterThan(0);
      // measured を読む既定集計は推定値を拾わない。
      expect(measuredValue(usage.costUsd)).toBeNull();
      expect(measuredValue(usage.inputTokens)).toBe(1_000);
    });

    it("価格表に無いモデルは costUsd=unavailable-by-design になり 0 が入らない（トークンは measured のまま）", async () => {
      const sessionsRoot = join(tempRoot, "codex-sessions-unpriced");
      writeRollout(sessionsRoot, CODEX_SESSION_ID, [
        { timestamp: "2026-08-20T01:00:00.000Z", type: "turn_context", payload: { model: "gpt-9.9-unreleased" } },
        tokenCount("2026-08-20T01:00:10.000Z", {
          input_tokens: 500,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 50,
          reasoning_output_tokens: 0,
          total_tokens: 550,
        }),
      ]);
      const fixture = writeFixture(tempRoot, "fake-codex-unpriced.sh", codexHeaderScript(CODEX_SESSION_ID));
      const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture, codexSessionsRoot: sessionsRoot });

      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
      expect(await waitUntil(() => existsSync(join(stateDir, `${ref.sessionId}.exit`)))).toBe(true);

      const usage = (await adapter.status(ref)).usage;
      expect(usage?.costUsd).toEqual({ state: "unavailable-by-design" });
      expect(usage?.unpricedModels).toEqual(["gpt-9.9-unreleased"]);
      expect(usage?.inputTokens).toEqual({ state: "measured", value: 500, provenance: "cli-native-session-log" });
    });

    it("`.out` を JSON 化しない（--json を付けない）ので handoff fence がそのまま残る（非回帰）", async () => {
      const fixture = writeFixture(
        tempRoot,
        "fake-codex-handoff.sh",
        codexHeaderScript(
          CODEX_SESSION_ID,
          ['```hachi-handoff-v1', '{"taskId": "t_direct01", "outcome": "review", "summary": "ok"}', '```'].join("\n"),
        ),
      );
      const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture });

      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
      expect(await waitUntil(() => existsSync(join(stateDir, `${ref.sessionId}.exit`)))).toBe(true);

      const transcript = await adapter.fetchTranscript(ref);
      expect(transcript).toContain("```hachi-handoff-v1");
      expect(transcript).toContain('{"taskId": "t_direct01", "outcome": "review", "summary": "ok"}');
      expect(transcript).not.toContain("\\n");
      // 起動スクリプトが --json を持たないことは `.out` が人間可読のままであることで担保される。
      expect(transcript).toContain("OpenAI Codex v0.144.1");
    });

    it("session id ヘッダが無い（起動前に落ちた等）ときは時刻で推測せず unknown を書く", async () => {
      const sessionsRoot = join(tempRoot, "codex-sessions-noheader");
      // 時間的に「近い」別 session の rollout をあえて置く。時刻ウィンドウ推測をしていれば拾ってしまう。
      writeRollout(sessionsRoot, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", [
        { timestamp: "2026-08-20T01:00:00.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
        tokenCount("2026-08-20T01:00:10.000Z", {
          input_tokens: 999_999,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 999,
          reasoning_output_tokens: 0,
          total_tokens: 1_000_998,
        }),
      ]);
      const fixture = writeFixture(tempRoot, "fake-codex-noheader.sh", "#!/bin/sh\necho 'エラーで終了'\nexit 1\n");
      const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture, codexSessionsRoot: sessionsRoot });

      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
      expect(await waitUntil(() => existsSync(join(stateDir, `${ref.sessionId}.exit`)))).toBe(true);

      const usage = (await adapter.status(ref)).usage;
      expect(usage?.inputTokens).toEqual({ state: "unknown" });
      expect(usage?.costUsd).toEqual({ state: "unknown" });
    });

    it("--ephemeral（isolated steward）は rollout を書かない設計なので not-provided になる", async () => {
      const fixture = writeFixture(tempRoot, "fake-codex-steward.sh", codexHeaderScript(CODEX_SESSION_ID));
      const adapter = new DirectCodexAdapter({
        stateDir,
        artifactsDir,
        codexBin: fixture,
        codexSessionsRoot: join(tempRoot, "codex-sessions-empty"),
      });

      const ref = await adapter.launch(virtualStewardTask(), launchOptions(cwd));
      expect(readDirectSessionState(stateDir, ref.sessionId)?.nativeLogsDisabled).toBe(true);
      expect(await waitUntil(() => existsSync(join(stateDir, `${ref.sessionId}.exit`)))).toBe(true);

      const usage = (await adapter.status(ref)).usage;
      expect(usage?.inputTokens).toEqual({ state: "not-provided" });
      expect(usage?.costUsd).toEqual({ state: "not-provided" });
    });

    it("走行中（exit ファイル前）は usage を付けない", async () => {
      const fixture = writeFixture(tempRoot, "fake-codex-slow-usage.sh", "#!/bin/sh\nsleep 1.5\nexit 0\n");
      const adapter = new DirectCodexAdapter({ stateDir, artifactsDir, codexBin: fixture });

      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
      const status = await adapter.status(ref);

      expect(status.state).toBe("active");
      expect(status.usage).toBeUndefined();
      await adapter.stop(ref);
    });
  });
});
