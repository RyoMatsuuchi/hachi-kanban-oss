// =============================================================================
// テスト専用の CliDeps 組み立てヘルパー。
// temp home + :memory: store + ダミー adapter を注入し、実ネットワークに一切出ない状態を作る。
// このファイル自体は *.test.ts ではないため vitest には実行されないが、各コマンドのテストから import する。
// =============================================================================

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteKanbanStore, ensureEnvironmentDirs, resolveEnvironment, type Provider, type WorkerAdapter } from "@hachi/core";
import type { SessionRef, SessionStatus } from "@hachi/core";
import { writeTokenFile } from "@hachi/testing";
import { ORCHESTRATOR_HELPER_SPECS } from "./commands/doctor.js";
import type { CliDeps, CliWriteCallback, CliWriter } from "./deps.js";

/** このファイル自身の位置から repo root を算出する（packages/cli/src から3階層上）。 */
const TEST_SUPPORT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** 標準出力/標準エラー出力を文字列バッファへ溜め込む CliWriter 実装 */
export interface BufferWriter extends CliWriter {
  text(): string;
  /** 同一テスト内で複数コマンドを実行する際、直前の出力を読み捨てるためにバッファをクリアする */
  clear(): void;
}

export function createBufferWriter(): BufferWriter {
  let chunks: string[] = [];
  return {
    write(text: string, callback?: CliWriteCallback): void {
      chunks.push(text);
      callback?.();
    },
    text(): string {
      return chunks.join("");
    },
    clear(): void {
      chunks = [];
    },
  };
}

/**
 * WorkerAdapter のダミー実装。
 * healthCheck の戻り値/挙動を差し替え可能にし、doctor の --offline 検証で
 * 「呼ばれないこと」自体を assert できるようにする（呼ばれたら throw する）。
 */
export class DummyAdapter implements WorkerAdapter {
  readonly provider: Provider;
  healthCheckCalls = 0;
  private healthy: boolean;

  constructor(provider: Provider, healthy = true) {
    this.provider = provider;
    this.healthy = healthy;
  }

  /** テストから healthCheck() の戻り値を差し替える */
  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  launch(): Promise<SessionRef> {
    return Promise.reject(new Error("DummyAdapter.launch はテストでは呼ばれない想定です"));
  }

  status(): Promise<SessionStatus> {
    return Promise.reject(new Error("DummyAdapter.status はテストでは呼ばれない想定です"));
  }

  inject(): Promise<void> {
    return Promise.reject(new Error("DummyAdapter.inject はテストでは呼ばれない想定です"));
  }

  fetchTranscript(): Promise<string> {
    return Promise.reject(new Error("DummyAdapter.fetchTranscript はテストでは呼ばれない想定です"));
  }

  healthCheck(): Promise<boolean> {
    this.healthCheckCalls += 1;
    return Promise.resolve(this.healthy);
  }
}

/** createTestDeps() の戻り値 */
export interface TestDeps {
  deps: CliDeps;
  stdout: BufferWriter;
  stderr: BufferWriter;
  exitCodes: number[];
  codexAdapter: DummyAdapter;
  claudeAdapter: DummyAdapter;
  cleanup: () => void;
}

/** テスト用の CliDeps 一式を組み立てる。DB/home はともに一時ディレクトリを使う。 */
export function createTestDeps(overrides: { debug?: boolean } = {}): TestDeps {
  const home = `${process.env["TMPDIR"] ?? "/tmp"}/hachi-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  // token ファイルは doctor の bridge チェックが読みに行く可能性があるため用意しておく
  const codexTokenFile = writeTokenFile(`${home}/bridges/codex`, "dummy-codex-token");
  const claudeTokenFile = writeTokenFile(`${home}/bridges/claude`, "dummy-claude-token");
  const env = resolveEnvironment({
    HACHI_KANBAN_HOME: home,
    HACHI_KANBAN_BOARD: "dev",
    HACHI_CODEX_BRIDGE_TOKEN_FILE: codexTokenFile,
    HACHI_CLAUDE_BRIDGE_TOKEN_FILE: claudeTokenFile,
  });

  ensureEnvironmentDirs(env);

  // doctor の「orchestrator helpers」検査が実 host の ~/.local/bin を触らずに済むよう、
  // 一時 home 配下に実 repo（この checkout）を指す exec シムを用意する（t_eac0371a7a1a368e）。
  // 個別テストで欠落/不正形式ケースを検証する際は ctx.deps.orchestratorHelperBinDir を上書きする。
  const orchestratorHelperBinDir = join(home, "local-bin");
  mkdirSync(orchestratorHelperBinDir, { recursive: true });
  for (const helper of ORCHESTRATOR_HELPER_SPECS) {
    const source = join(TEST_SUPPORT_REPO_ROOT, helper.repoRelativeSource);
    writeFileSync(
      join(orchestratorHelperBinDir, helper.name),
      `#!/bin/sh\nexec "${source}" "$@"\n`,
      { mode: 0o755 },
    );
  }

  const store = new SqliteKanbanStore(env.dbPath);
  const stdout = createBufferWriter();
  const stderr = createBufferWriter();
  const exitCodes: number[] = [];
  const codexAdapter = new DummyAdapter("codex");
  const claudeAdapter = new DummyAdapter("claude");

  const deps: CliDeps = {
    store,
    config: {
      profiles: {
        plan: { provider: "claude", model: "claude-opus-4-6" },
        review: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
        implement: { provider: "codex", model: "gpt-5.6-terra", effort: "xhigh" },
        docs: { provider: "codex", model: "gpt-5.6-luna", effort: "high" },
      },
      allowlist: {
        codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
        claude: ["claude-opus-5", "claude-opus-4-6", "claude-sonnet-5"],
      },
      resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
      defaultProfile: "implement",
    },
    env,
    hermesHome: join(home, "hermes"),
    adapters: { codex: codexAdapter, claude: claudeAdapter },
    bridgeIdentityProbe: async () => ({ ok: true, sessionCount: 0 }),
    bridgeListenerProbe: async () => ({ status: "listening", pid: 4_242 }),
    // handover の focused test 以外が実機の Claude 設定・transcript を読まないための既定 fake。
    claudeTrustProbe: { isTrusted: () => true },
    handoverDeliveryGateProbe: async () => ({ userNonceObserved: true, assistantObserved: true }),
    modelTransportProbe: async (provider, transport) => ({
      ok: true,
      snapshot: {
        schemaVersion: "execution-capability.v1",
        provider,
        transport,
        runtime: {
          name: provider === "codex" ? "codex-cli" : "claude-cli",
          version: provider === "codex" ? "0.144.1" : "2.1.207",
          source: transport === "bridge" ? "advertised" : "local-probe",
        },
        capabilities: [],
        modelCatalog: {
          knowledge: "known",
          models: provider === "codex"
            ? ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"]
            : ["claude-opus-5", "claude-opus-4-6", "claude-sonnet-5"],
          source: "advertised",
        },
        delivery: { model: "native", effort: "native", speed: "native" },
        observedAt: 1_700_000_000,
      },
    }),
    processListProvider: async () => [],
    orchestratorHelperBinDir,
    orchestratorHelperRepoRoot: TEST_SUPPORT_REPO_ROOT,
    // orchestrator handover --apply の poll は既定で real timer を待つ（本番デフォルトは秒単位）。
    // テストを遅くしないよう、ここでは十分小さい値にしておく。個別テストで timeout 挙動を検証したい
    // 場合はテスト内で ctx.deps.handoverStopPoll を上書きする。
    handoverStopPoll: { intervalMs: 1, timeoutMs: 30 },
    // 後継 heartbeat を明示的に進める focused test 以外は、final 後の警告を即時判定する。
    handoverSuccessorHeartbeatPoll: { intervalMs: 1, timeoutMs: 0 },
    stdin: { read: async () => "" },
    processEnv: {},
    successorTmuxReadback: {
      readExactPane: () => ({ ok: false, reason: "unavailable" }),
      initializeServerLifetimeAndReadExactPane: () => ({ ok: false, reason: "unavailable" }),
    },
    currentHostId: () => "host-cli-test",
    canonicalizeSuccessorCwd: (path: string) => path,
    successorAttestationHashProbe: {
      readInstalledHashes: () => ({
        hookDefinitionHash: "a".repeat(64),
        hookExecutableHash: "b".repeat(64),
      }),
    },
    stdout,
    stderr,
    debug: overrides.debug ?? false,
    exit: (code: number): void => {
      exitCodes.push(code);
    },
  };

  return {
    deps,
    stdout,
    stderr,
    exitCodes,
    codexAdapter,
    claudeAdapter,
    cleanup: (): void => {
      store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
