import { chmodSync, mkdirSync, mkdtempSync, rmSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LaunchOptions, SessionRef, TaskRow } from "@hachi/core";
import { DirectClaudeAdapter } from "./direct-claude.js";
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

function launchOptions(cwd: string): LaunchOptions {
  return { model: "claude-sonnet-5", cwd, promptText: "OK とだけ出力して終了してください" };
}

/** 実行可能な偽 claude シェルスクリプト（fixture）を書き出し、その絶対パスを返す */
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

describe("DirectClaudeAdapter", () => {
  let tempRoot: string;
  let stateDir: string;
  let artifactsDir: string;
  let cwd: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-direct-claude-"));
    stateDir = join(tempRoot, "state", "direct-sessions");
    artifactsDir = join(tempRoot, "artifacts");
    cwd = join(tempRoot, "cwd");
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("provider は 'claude'", () => {
    const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir });
    expect(adapter.provider).toBe("claude");
  });

  it("spawn後のstate永続化失敗ではprocess groupを回収してからthrowする", async () => {
    const fixture = writeFixture(
      tempRoot,
      "fake-claude-state-fail.sh",
      "#!/bin/sh\nsleep 30\n",
    );
    let spawnedPid = 0;
    const adapter = new DirectClaudeAdapter({
      stateDir,
      artifactsDir,
      claudeBin: fixture,
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

  it("launch→active→(完了後)idle+resultCount=1→fetchTranscript の全行程（偽 claudeBin fixture）", async () => {
    // 少しスリープしてから出力する fixture。launch 直後は active、完了後は idle+resultCount=1 になる。
    const fixture = writeFixture(
      tempRoot,
      "fake-claude-sleep.sh",
      "#!/bin/sh\nsleep 0.4\necho '直接実行 OK'\nexit 0\n",
    );
    const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir, claudeBin: fixture });

    const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
    expect(ref.provider).toBe("claude");
    expect(ref.sessionId.startsWith("direct-")).toBe(true);
    expect(ref.serverUrl).toBe("direct");
    expect(ref.modelDelivery).toBe("native");
    expect(ref.model).toBe("claude-sonnet-5");

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

  it("exit ファイル無し + pid 消失（クラッシュ相当）でも idle+resultCount=1 になる（契約 §17.2 / §22.1）", async () => {
    const fixture = writeFixture(tempRoot, "fake-claude-fast.sh", "#!/bin/sh\necho done\nexit 0\n");
    const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir, claudeBin: fixture });

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
    const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir });
    const ref: SessionRef = {
      provider: "claude",
      sessionId: "direct-deadbeefdeadbeef",
      serverUrl: "direct",
      model: "claude-sonnet-5",
      modelDelivery: "native",
      startedAt: 0,
    };
    const transcript = await adapter.fetchTranscript(ref);
    expect(transcript).toBe("(出力ファイルなし)");
  });

  it("inject は steer 非対応として throw する（契約 §17.2 / §22.1）", async () => {
    const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir });
    const ref: SessionRef = {
      provider: "claude",
      sessionId: "direct-0011223344556677",
      serverUrl: "direct",
      model: "claude-sonnet-5",
      modelDelivery: "native",
      startedAt: 0,
    };
    await expect(adapter.inject(ref, "続けて")).rejects.toThrow(/steer 非対応/);
  });

  it("healthCheck は claudeBin が PATH にあれば true", async () => {
    const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir, claudeBin: "sh" });
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it("healthCheck は claudeBin が存在しなければ false", async () => {
    const adapter = new DirectClaudeAdapter({
      stateDir,
      artifactsDir,
      claudeBin: "definitely-not-a-real-binary-xyz-hachi",
    });
    await expect(adapter.healthCheck()).resolves.toBe(false);
  });

  it("model にシングルクォートを含む場合は launch を reject する（コマンドインジェクション防止）", async () => {
    const fixture = writeFixture(tempRoot, "fake-claude-x.sh", "#!/bin/sh\necho x\n");
    const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir, claudeBin: fixture });
    const options: LaunchOptions = { model: "evil'model", cwd, promptText: "hi" };
    await expect(adapter.launch(fakeTask(), options)).rejects.toThrow(/シングルクォート/);
  });

  it("env スクラビング: ANTHROPIC_API_KEY 等の API 課金系変数を除去して spawn する（契約 §22.1）", async () => {
    // env を out へ echo する fixture（未設定変数は <unset> とマークする）
    const fixture = writeFixture(
      tempRoot,
      "fake-claude-env.sh",
      [
        "#!/bin/sh",
        'echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-<unset>}"',
        'echo "CLAUDE_API_KEY=${CLAUDE_API_KEY:-<unset>}"',
        'echo "ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN:-<unset>}"',
        'echo "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-<unset>}"',
        'echo "HACHI_SAFE_VAR=${HACHI_SAFE_VAR:-<unset>}"',
        "exit 0",
        "",
      ].join("\n"),
    );

    const scrubbedKeys = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
    const savedEnv: Record<string, string | undefined> = {};
    for (const key of scrubbedKeys) {
      savedEnv[key] = process.env[key];
    }
    const savedSafeVar = process.env.HACHI_SAFE_VAR;

    process.env.ANTHROPIC_API_KEY = "secret-api-key";
    process.env.CLAUDE_API_KEY = "secret-claude-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "secret-auth-token";
    process.env.ANTHROPIC_BASE_URL = "https://example.invalid";
    process.env.HACHI_SAFE_VAR = "kept-value";

    try {
      const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir, claudeBin: fixture });
      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));

      const exitFile = join(stateDir, `${ref.sessionId}.exit`);
      expect(await waitUntil(() => existsSync(exitFile))).toBe(true);

      const transcript = await adapter.fetchTranscript(ref);
      // API 課金系変数は除去され spawn 先に渡っていないこと
      expect(transcript).toContain("ANTHROPIC_API_KEY=<unset>");
      expect(transcript).toContain("CLAUDE_API_KEY=<unset>");
      expect(transcript).toContain("ANTHROPIC_AUTH_TOKEN=<unset>");
      expect(transcript).toContain("ANTHROPIC_BASE_URL=<unset>");
      expect(transcript).not.toContain("secret-api-key");
      expect(transcript).not.toContain("secret-claude-key");
      expect(transcript).not.toContain("secret-auth-token");
      // それ以外の環境変数は継承されること
      expect(transcript).toContain("HACHI_SAFE_VAR=kept-value");
    } finally {
      for (const key of scrubbedKeys) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
      if (savedSafeVar === undefined) {
        delete process.env.HACHI_SAFE_VAR;
      } else {
        process.env.HACHI_SAFE_VAR = savedSafeVar;
      }
    }
  });

  describe("stop（契約 §34.2）", () => {
    it("長時間 sleep するプロセスを SIGTERM で回収する（terminated）", async () => {
      // sleep 完了後に echo する fixture。stop が本当にプロセスツリーを止めているなら、
      // sleep の残り時間を待っても echo は実行されないはず。
      const fixture = writeFixture(
        tempRoot,
        "fake-claude-longsleep.sh",
        "#!/bin/sh\nsleep 5\necho SHOULD_NOT_APPEAR\nexit 0\n",
      );
      const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir, claudeBin: fixture });
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
      const fixture = writeFixture(tempRoot, "fake-claude-already-done.sh", "#!/bin/sh\necho done\nexit 0\n");
      const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir, claudeBin: fixture });
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
    it("effort 指定時は --effort <effort> を起動スクリプトへ付与し、effortDelivery='native' を記録する", async () => {
      // 自身への argv をそのまま stdout（= outFile）へ echo する fixture
      const fixture = writeFixture(tempRoot, "fake-claude-argv.sh", '#!/bin/sh\necho "$@"\nexit 0\n');
      const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir, claudeBin: fixture });
      const options: LaunchOptions = { model: "claude-sonnet-5", cwd, promptText: "hi", effort: "xhigh" };

      const ref = await adapter.launch(fakeTask(), options);
      expect(ref.effortDelivery).toBe("native");

      const exitFile = join(stateDir, `${ref.sessionId}.exit`);
      expect(await waitUntil(() => existsSync(exitFile))).toBe(true);
      const transcript = await adapter.fetchTranscript(ref);
      expect(transcript).toContain("--effort xhigh");
    });

    it("effort 未指定時は effortDelivery キー自体を省略し、起動スクリプトにも --effort を付与しない", async () => {
      const fixture = writeFixture(tempRoot, "fake-claude-noeffort.sh", '#!/bin/sh\necho "$@"\nexit 0\n');
      const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir, claudeBin: fixture });
      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
      expect("effortDelivery" in ref).toBe(false);

      const exitFile = join(stateDir, `${ref.sessionId}.exit`);
      expect(await waitUntil(() => existsSync(exitFile))).toBe(true);
      const transcript = await adapter.fetchTranscript(ref);
      expect(transcript).not.toContain("--effort");
    });
  });

  describe("usage 計測（設計 R1〜R4 / 契約 §14.5）", () => {
    const NATIVE_SESSION_ID = "11111111-2222-3333-4444-555555555555";

    /** claude が副作用として書くネイティブ transcript を模した fixture を置く */
    function writeNativeLog(projectsRoot: string, relPath: string, rows: readonly unknown[]): void {
      const path = join(projectsRoot, relPath);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    }

    function assistantRow(id: string, model: string, usage: Record<string, number>): Record<string, unknown> {
      return {
        type: "assistant",
        uuid: `uuid-${id}`,
        requestId: `req-${id}`,
        timestamp: "2026-08-20T01:00:00.000Z",
        message: { id: `msg-${id}`, model, usage },
      };
    }

    it("--session-id を起動スクリプトへ付与し、その uuid を state へ保存する（時刻推測をやめる、R3）", async () => {
      const fixture = writeFixture(tempRoot, "fake-claude-sid.sh", '#!/bin/sh\necho "$@"\nexit 0\n');
      const adapter = new DirectClaudeAdapter({
        stateDir,
        artifactsDir,
        claudeBin: fixture,
        nativeSessionIdFactory: () => NATIVE_SESSION_ID,
      });

      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
      expect(await waitUntil(() => existsSync(join(stateDir, `${ref.sessionId}.exit`)))).toBe(true);

      expect(await adapter.fetchTranscript(ref)).toContain(`--session-id ${NATIVE_SESSION_ID}`);
      expect(readDirectSessionState(stateDir, ref.sessionId)?.nativeSessionId).toBe(NATIVE_SESSION_ID);
    });

    it("launch のたびに新しい uuid を採番する（retry で session id 衝突を起こさない）", async () => {
      // claude CLI は既存 session id を渡すと `Session ID ... is already in use.` で exit 1 になる。
      // LaunchOptions は session id を運ばず、採番は launch() 内で毎回行うため retry でも衝突しない。
      const fixture = writeFixture(tempRoot, "fake-claude-uniq.sh", "#!/bin/sh\necho ok\nexit 0\n");
      const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir, claudeBin: fixture });

      const first = await adapter.launch(fakeTask(), launchOptions(cwd));
      const second = await adapter.launch(fakeTask(), launchOptions(cwd));

      const firstId = readDirectSessionState(stateDir, first.sessionId)?.nativeSessionId;
      const secondId = readDirectSessionState(stateDir, second.sessionId)?.nativeSessionId;
      expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
      expect(secondId).not.toBe(firstId);
    });

    it("`.out` を JSON 化しない（--output-format を付けない）ので handoff fence がそのまま残る（非回帰）", async () => {
      const handoff = [
        "作業しました。",
        "```hachi-handoff-v1",
        '{"taskId": "t_direct01", "outcome": "review", "summary": "ok"}',
        "```",
      ].join("\n");
      const fixture = writeFixture(
        tempRoot,
        "fake-claude-handoff.sh",
        `#!/bin/sh\ncat <<'EOF'\n${handoff}\nEOF\nexit 0\n`,
      );
      const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir, claudeBin: fixture });

      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
      expect(await waitUntil(() => existsSync(join(stateDir, `${ref.sessionId}.exit`)))).toBe(true);

      const transcript = await adapter.fetchTranscript(ref);
      // 生テキストのまま（JSON 文字列へエスケープされていない）。
      expect(transcript).toContain("```hachi-handoff-v1");
      expect(transcript).toContain('{"taskId": "t_direct01", "outcome": "review", "summary": "ok"}');
      expect(transcript).not.toContain("\\n");
    });

    it("終了後の status() が親＋サブエージェントを合算した usage を返す（cache read を落とさない）", async () => {
      const projectsRoot = join(tempRoot, "claude-projects");
      const projectDir = "-Users-someone-worktrees-example";
      writeNativeLog(projectsRoot, `${projectDir}/${NATIVE_SESSION_ID}.jsonl`, [
        assistantRow("parent", "claude-opus-5", {
          input_tokens: 2,
          cache_creation_input_tokens: 1895,
          cache_read_input_tokens: 144970,
          output_tokens: 7588,
        }),
      ]);
      writeNativeLog(projectsRoot, `${projectDir}/${NATIVE_SESSION_ID}/subagents/agent-aaa.jsonl`, [
        assistantRow("sub", "claude-sonnet-5", {
          input_tokens: 1,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 100,
          output_tokens: 20,
        }),
      ]);

      const fixture = writeFixture(tempRoot, "fake-claude-usage.sh", "#!/bin/sh\necho ok\nexit 0\n");
      const adapter = new DirectClaudeAdapter({
        stateDir,
        artifactsDir,
        claudeBin: fixture,
        claudeProjectsRoot: projectsRoot,
        nativeSessionIdFactory: () => NATIVE_SESSION_ID,
      });

      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
      expect(await waitUntil(() => existsSync(join(stateDir, `${ref.sessionId}.exit`)))).toBe(true);

      const usage = (await adapter.status(ref)).usage;
      expect(usage?.collectedBy).toBe("direct-claude@native-log-v1");
      expect(usage?.inputTokens).toEqual({ state: "measured", value: 3, provenance: "cli-native-session-log" });
      expect(usage?.outputTokens).toEqual({ state: "measured", value: 7608, provenance: "cli-native-session-log" });
      expect(usage?.cacheCreationTokens).toEqual({
        state: "measured",
        value: 1905,
        provenance: "cli-native-session-log",
      });
      expect(usage?.cacheReadTokens).toEqual({
        state: "measured",
        value: 145070,
        provenance: "cli-native-session-log",
      });
      // launch 時の model は claude-sonnet-5 だが、実際には opus も消費している。
      expect(usage?.models).toEqual(["claude-opus-5", "claude-sonnet-5"]);
      expect(usage?.costUsd.state).toBe("estimated");
    });

    it("走行中（exit ファイル前）は usage を付けない（不完全なログを実測にしない）", async () => {
      const fixture = writeFixture(tempRoot, "fake-claude-slow.sh", "#!/bin/sh\nsleep 1.5\nexit 0\n");
      const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir, claudeBin: fixture });

      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
      const status = await adapter.status(ref);

      expect(status.state).toBe("active");
      expect(status.usage).toBeUndefined();
      await adapter.stop(ref);
    });

    it("ネイティブログが無い（失敗 run 等）ときのゼロは measured にならず unknown になる", async () => {
      const fixture = writeFixture(tempRoot, "fake-claude-fail.sh", "#!/bin/sh\nexit 1\n");
      const adapter = new DirectClaudeAdapter({
        stateDir,
        artifactsDir,
        claudeBin: fixture,
        claudeProjectsRoot: join(tempRoot, "empty-projects"),
        nativeSessionIdFactory: () => NATIVE_SESSION_ID,
      });

      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));
      expect(await waitUntil(() => existsSync(join(stateDir, `${ref.sessionId}.exit`)))).toBe(true);

      const usage = (await adapter.status(ref)).usage;
      expect(usage?.inputTokens).toEqual({ state: "unknown" });
      expect(usage?.costUsd).toEqual({ state: "unknown" });
    });

    it("--session-id 導入前の state（nativeSessionId 無し）は unknown を書き、時刻で推測しない", async () => {
      const sessionId = "direct-legacy01";
      const outFile = join(stateDir, `${sessionId}.out`);
      const exitFile = join(stateDir, `${sessionId}.exit`);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(outFile, "ok", "utf8");
      writeFileSync(exitFile, "0", "utf8");
      writeFileSync(
        join(stateDir, `${sessionId}.json`),
        JSON.stringify({
          pid: process.pid,
          taskId: "t_direct01",
          outFile,
          exitFile,
          model: "claude-sonnet-5",
          startedAt: 0,
        }),
        "utf8",
      );
      const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir });
      const ref: SessionRef = {
        provider: "claude",
        sessionId,
        serverUrl: "direct",
        model: "claude-sonnet-5",
        modelDelivery: "native",
        startedAt: 0,
      };

      const usage = (await adapter.status(ref)).usage;
      expect(usage?.inputTokens).toEqual({ state: "unknown" });
      // 旧 state でも stop 経路は壊れない（optional フィールドの後方互換）。
      expect(readDirectSessionState(stateDir, sessionId)).not.toBeNull();
    });
  });

  describe("speed 伝搬（契約 §67）", () => {
    it("fast は session-local settings を配送し、max effort と併用できる", async () => {
      const fixture = writeFixture(tempRoot, "fake-claude-fast-argv.sh", '#!/bin/sh\necho "$@"\nexit 0\n');
      const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir, claudeBin: fixture });
      const ref = await adapter.launch(fakeTask(), {
        model: "claude-opus-5",
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
      expect(transcript).toContain("--effort max");
      expect(transcript).toContain('--settings {"fastMode":true}');
    });

    it("standard は user settings の fastMode を明示的に無効化する", async () => {
      const fixture = writeFixture(tempRoot, "fake-claude-standard-argv.sh", '#!/bin/sh\necho "$@"\nexit 0\n');
      const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir, claudeBin: fixture });
      const ref = await adapter.launch(fakeTask(), {
        model: "claude-opus-5", cwd, promptText: "hi", speed: "standard",
      });

      expect(ref.speedDelivery).toBe("native");
      const exitFile = join(stateDir, `${ref.sessionId}.exit`);
      expect(await waitUntil(() => existsSync(exitFile))).toBe(true);
      const transcript = await adapter.fetchTranscript(ref);
      expect(transcript).toContain('--settings {"fastMode":false}');
    });

    it("speed 未指定は従来互換で --settings を追加しない", async () => {
      const fixture = writeFixture(tempRoot, "fake-claude-nospeed.sh", '#!/bin/sh\necho "$@"\nexit 0\n');
      const adapter = new DirectClaudeAdapter({ stateDir, artifactsDir, claudeBin: fixture });
      const ref = await adapter.launch(fakeTask(), launchOptions(cwd));

      expect("speedDelivery" in ref).toBe(false);
      const exitFile = join(stateDir, `${ref.sessionId}.exit`);
      expect(await waitUntil(() => existsSync(exitFile))).toBe(true);
      expect(await adapter.fetchTranscript(ref)).not.toContain("--settings");
    });
  });
});
