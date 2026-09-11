// supervisor 内のテスト（*.test.ts）が共用するセットアップヘルパー。
// @hachi/testing の makeTempHome / MockBridgeServer を組み合わせ、実ネットワークに
// 触れずに StageDeps 一式（:memory: store + モック bridge x2 + tmp home）を構築する。
// このファイル自体はテストではないため *.test.ts 命名にしない（index.ts からは export しない）。
import { join } from "node:path";
import {
  CLAUDE_BRIDGE_MAX_TURNS,
  ClaudeAdapter,
  CodexAdapter,
  type BridgeLaunchSessionRef,
} from "@hachi/adapters";
import { SqliteKanbanStore, createLogger } from "@hachi/core";
import type {
  ExecutionCapabilitySnapshot,
  HachiConfig,
  ExactSessionStopInput,
  ExactSessionStopResult,
  LaunchOptions,
  NativeCommunicationAdapter,
  NativeCommunicationDeliveryRequest,
  NativeCommunicationDeliveryResult,
  NativeCommunicationProbeResult,
  Provider,
  SessionRef,
  SessionStatus,
  StageDeps,
  StopResult,
  TaskRow,
  WorkerAdapter,
  WorkerStopCapabilities,
  Transport,
} from "@hachi/core";
import { MockBridgeServer, makeTempHome } from "@hachi/testing";
import type { TempHome } from "@hachi/testing";
import type { ResultWatermarkSessionStatus } from "./session-ref.js";
import type { StewardArchiveIntegrationProbe } from "./stages/steward-archive-integration-probe.js";

/**
 * FakeAdapter のコンストラクタオプション。
 * supportsStop=false にすると stop プロパティ自体が undefined のままになり、
 * WorkerAdapter.stop? が未実装のアダプタ（契約 §34.2/§34.3 の「stop が無い」ケース）を模擬できる。
 */
export interface FakeAdapterOptions {
  supportsStop?: boolean;
}

export type TestSessionStatus = SessionStatus & ResultWatermarkSessionStatus;

/**
 * WorkerAdapter のテスト用フェイク実装。
 * MockBridgeServer（実 bridge 忠実モック）は completeSession() 経由でしか状態を idle+result に
 * 遷移できないため、resultCount/state の任意の組み合わせをピンポイントで制御したい monitor/finalize/
 * messages(steer) のテストではこちらを使う（docs/contract.md §13.4）。
 */
export class FakeAdapter implements WorkerAdapter {
  readonly provider: Provider;

  readonly launchCalls: Array<{ task: TaskRow; options: LaunchOptions }> = [];
  readonly statusCalls: SessionRef[] = [];
  readonly injectCalls: Array<{ ref: SessionRef; message: string }> = [];
  readonly transcriptCalls: SessionRef[] = [];
  readonly stopCalls: SessionRef[] = [];
  readonly stopExactCalls: Array<{ ref: SessionRef; input: ExactSessionStopInput }> = [];

  /** 既定は「進行中（未終了）」を表す active/resultCount未設定。turn 完了を模擬する場合は
   * { state: "idle", resultCount: 1 } を設定する（docs/contract.md §13.4） */
  statusResponse: TestSessionStatus = { state: "active", lastActivityAt: null };
  transcriptResponse = "";
  launchResponse: SessionRef | null = null;
  launchError: Error | null = null;
  statusError: Error | null = null;
  transcriptError: Error | null = null;
  injectError: Error | null = null;
  /** stop() の既定応答（成功して停止できたケース）。bridge 系を模擬する場合は
   * { stopped: false, reason: "unsupported" } に上書きする（契約 §34.2）。 */
  stopResponse: StopResult = { stopped: true, reason: "terminated" };
  stopError: Error | null = null;
  stopCapabilitiesResponse: WorkerStopCapabilities = {
    protocol: "unsupported",
    exactSession: false,
    childProcessTree: false,
  };
  stopExactResponse: ExactSessionStopResult = {
    state: "stopped",
    evidenceId: "fake:stopped",
    observedSessionState: "ended",
    childProcessTreeCovered: true,
  };
  stopExactHook: (() => void) | null = null;
  /**
   * launch() 呼び出し中に副作用を模擬するためのフック。
   * dispatch の「launch 成功後の Tx 内 claim 再検証」（docs/contract.md §12.8-3）を検証するため、
   * launch() 実行中（起動後Txより前）に別 writer がタスクを書き換えるケースをテストから再現する。
   */
  launchHook: (() => void) | null = null;
  /**
   * fetchTranscript() 呼び出し中に副作用を模擬するためのフック。
   * finalize の「Tx 冒頭の最終再検証」（docs/contract.md §12.12-1）を検証するため、
   * transcript 取得中（Tx より前）に別 writer がタスクを再起動するケースをテストから再現する。
   */
  transcriptHook: (() => void) | null = null;
  /**
   * stop() 呼び出し中に副作用を模擬するためのフック。
   * monitor の「max-runtime 強制回収 Tx 冒頭の再検証」（契約 §12.12-1 相当）を検証するため、
   * stop() 実行中（Tx より前）に別 writer がタスクを再起動するケースをテストから再現する。
   */
  stopHook: (() => void) | null = null;
  /**
   * inject() 呼び出し中に副作用を模擬するためのフック。
   * live answer の「inject 成功後、mark 前に open run が閉じる」競合を再現する。
   */
  injectHook: (() => void) | null = null;

  /**
   * WorkerAdapter.stop?（契約 §34.2）。宣言のみ（初期化子なし）にしておき、
   * コンストラクタで supportsStop=true（既定）の場合のみ実装を代入する。
   * supportsStop=false のインスタンスは stop が undefined のままとなり、
   * 「stop 未実装」のアダプタ（契約 §34.3 の強制回収ロジックが分岐すべきケース）を模擬できる。
   */
  stop?: (ref: SessionRef) => Promise<StopResult>;

  constructor(provider: Provider, options: FakeAdapterOptions = {}) {
    this.provider = provider;
    if (options.supportsStop ?? true) {
      this.stop = async (ref: SessionRef): Promise<StopResult> => {
        this.stopCalls.push(ref);
        if (this.stopHook !== null) {
          this.stopHook();
        }
        if (this.stopError !== null) {
          throw this.stopError;
        }
        return this.stopResponse;
      };
    }
  }

  async launch(task: TaskRow, options: LaunchOptions): Promise<SessionRef> {
    this.launchCalls.push({ task, options });
    if (this.launchHook !== null) {
      this.launchHook();
    }
    if (this.launchError !== null) {
      throw this.launchError;
    }
    if (this.launchResponse === null) {
      throw new Error("FakeAdapter: launchResponse が未設定です");
    }
    // bridge fixture は指定をnative配送し、要求値を applied として返すruntimeを既定とする。
    // direct/native adapter は applied 値を返さないため、serverUrl="direct" では補完しない。
    // 欠落を試すテストは delivery="none" を明示し、暗黙の成功fixtureと区別する。
    const response = this.launchResponse as BridgeLaunchSessionRef;
    const isBridgeFixture = response.serverUrl !== "direct";
    return {
      ...response,
      ...(isBridgeFixture && response.modelDelivery === "native" && response.appliedModel === undefined
        ? { appliedModel: options.model }
        : {}),
      ...(options.effort !== undefined && response.effortDelivery === undefined
        ? { effortDelivery: "native" as const }
        : {}),
      ...(isBridgeFixture && options.effort !== undefined &&
        response.effortDelivery !== "none" && response.appliedEffort === undefined
        ? { appliedEffort: options.effort }
        : {}),
      ...(options.speed !== undefined && response.speedDelivery === undefined
        ? { speedDelivery: "native" as const }
        : {}),
      ...(isBridgeFixture && options.speed !== undefined &&
        response.speedDelivery !== "none" && response.appliedSpeed === undefined
        ? { appliedSpeed: options.speed }
        : {}),
      ...(this.provider === "claude" && isBridgeFixture
        ? {
            requestedMaxTurns: response.requestedMaxTurns ?? CLAUDE_BRIDGE_MAX_TURNS,
            maxTurnsDelivery: response.maxTurnsDelivery ?? "native" as const,
            ...(response.maxTurnsDelivery !== "none"
              ? { appliedMaxTurns: response.appliedMaxTurns ?? CLAUDE_BRIDGE_MAX_TURNS }
              : {}),
          }
        : {}),
    } satisfies BridgeLaunchSessionRef;
  }

  async status(ref: SessionRef): Promise<SessionStatus> {
    this.statusCalls.push(ref);
    if (this.statusError !== null) {
      throw this.statusError;
    }
    return this.statusResponse;
  }

  async inject(ref: SessionRef, message: string): Promise<void> {
    this.injectCalls.push({ ref, message });
    if (this.injectHook !== null) {
      this.injectHook();
    }
    if (this.injectError !== null) {
      throw this.injectError;
    }
  }

  async fetchTranscript(ref: SessionRef): Promise<string> {
    this.transcriptCalls.push(ref);
    if (this.transcriptHook !== null) {
      this.transcriptHook();
    }
    if (this.transcriptError !== null) {
      throw this.transcriptError;
    }
    return this.transcriptResponse;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async stopCapabilities(ref: SessionRef): Promise<WorkerStopCapabilities> {
    void ref;
    return this.stopCapabilitiesResponse;
  }

  async stopExact(ref: SessionRef, input: ExactSessionStopInput): Promise<ExactSessionStopResult> {
    this.stopExactCalls.push({ ref, input });
    if (this.stopExactHook !== null) {
      this.stopExactHook();
    }
    return this.stopExactResponse;
  }
}

/**
 * provider-native communication の probe/deliver を制御する fake。
 * lifecycle（claim/begin/receipt）は supervisor/Core fake store 側で検証し、ここでは
 * accepted/observed/ack/reject/uncertain と probe drift/restart を決定的に返せるようにする。
 */
export class FakeNativeCommunicationAdapter implements NativeCommunicationAdapter {
  readonly provider: Provider;
  readonly route: "codex-app-server" | "claude-cross-session";
  readonly probeCalls: Array<{ ref: SessionRef; now: number }> = [];
  readonly deliverCalls: NativeCommunicationDeliveryRequest[] = [];
  probeResponse: NativeCommunicationProbeResult = { state: "unknown", detail: "fake probe未設定" };
  deliverResponse: NativeCommunicationDeliveryResult = {
    outcome: "uncertain",
    detail: "fake delivery未設定",
  };
  probeError: Error | null = null;
  deliverError: Error | null = null;

  constructor(provider: Provider) {
    this.provider = provider;
    this.route = provider === "codex" ? "codex-app-server" : "claude-cross-session";
  }

  async probe(ref: SessionRef, now: number): Promise<NativeCommunicationProbeResult> {
    this.probeCalls.push({ ref, now });
    if (this.probeError !== null) {
      throw this.probeError;
    }
    return this.probeResponse;
  }

  async deliver(input: NativeCommunicationDeliveryRequest): Promise<NativeCommunicationDeliveryResult> {
    this.deliverCalls.push(input);
    if (this.deliverError !== null) {
      throw this.deliverError;
    }
    return this.deliverResponse;
  }
}

/** docs/contract.md §7 の既定 profile matrix と同等のテスト用設定 */
export const DEFAULT_TEST_CONFIG: HachiConfig = {
  profiles: {
    plan: { provider: "claude", model: "claude-opus-4-6" },
    review: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
    implement: { provider: "codex", model: "gpt-5.6-terra", effort: "xhigh" },
    docs: { provider: "codex", model: "gpt-5.6-luna", effort: "high" },
  },
  allowlist: {
    codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
    claude: ["claude-opus-4-6", "claude-sonnet-5"],
  },
  modelTransportPolicies: [
    {
      id: "codex-direct-test",
      provider: "codex",
      model: "gpt-5.6-sol",
      transport: "direct",
      minimumRuntimeVersion: "0.144.1",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      supportedSpeeds: ["standard"],
    },
    {
      id: "codex-direct-terra-test",
      provider: "codex",
      model: "gpt-5.6-terra",
      transport: "direct",
      minimumRuntimeVersion: "0.144.1",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      supportedSpeeds: ["standard", "fast"],
    },
    {
      id: "codex-direct-luna-test",
      provider: "codex",
      model: "gpt-5.6-luna",
      transport: "direct",
      minimumRuntimeVersion: "0.144.1",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      supportedSpeeds: ["standard", "fast"],
    },
    {
      id: "claude-direct-test",
      provider: "claude",
      model: "claude-sonnet-5",
      transport: "direct",
      minimumRuntimeVersion: "2.1.207",
      supportedEfforts: ["low", "medium", "high", "xhigh"],
    },
  ],
  resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
  defaultProfile: "implement",
};

export interface TestHarness {
  home: TempHome;
  store: SqliteKanbanStore;
  codexBridge: MockBridgeServer;
  claudeBridge: MockBridgeServer;
  deps: StageDeps;
  cleanup: () => Promise<void>;
}

interface TestStageDeps extends StageDeps {
  modelTransportPreflight: {
    probe(provider: Provider, transport: Transport): Promise<{ ok: true; snapshot: ExecutionCapabilitySnapshot }>;
  };
  /**
   * §74 archive integration gate の probe。既定では実 git を一切叩かず常に allow
   * （repo-root・clean 相当）を返す fake にしておく。これにより cwd: 行を持たない既存の
   * archive×done テスト群が §74 配線後も無変更で通る。§74 固有の gate 挙動を検証するテストだけが
   * `{ ...harness.deps, stewardArchiveIntegrationProbe: <fake> }` のように個別に上書きすればよい。
   */
  stewardArchiveIntegrationProbe: StewardArchiveIntegrationProbe;
}

/** :memory: 相当の tmp DB + モック bridge x2 を起動し、StageDeps を組み立てて返す */
function cloneDefaultConfig(): HachiConfig {
  return {
    profiles: { ...DEFAULT_TEST_CONFIG.profiles },
    allowlist: {
      codex: [...DEFAULT_TEST_CONFIG.allowlist.codex],
      claude: [...DEFAULT_TEST_CONFIG.allowlist.claude],
    },
    modelTransportPolicies: DEFAULT_TEST_CONFIG.modelTransportPolicies!.map((policy) => ({ ...policy })),
    resourceGuard: { ...DEFAULT_TEST_CONFIG.resourceGuard },
    defaultProfile: DEFAULT_TEST_CONFIG.defaultProfile,
  };
}

export async function setupHarness(configOverrides: Partial<HachiConfig> = {}): Promise<TestHarness> {
  const home = makeTempHome();
  const store = new SqliteKanbanStore(home.env.dbPath);

  const codexBridge = new MockBridgeServer({
    token: "mock-codex-token",
    provider: "codex",
    passthroughMode: "native",
  });
  const claudeBridge = new MockBridgeServer({
    token: "mock-claude-token",
    provider: "claude",
    capabilities: ["max-turns-passthrough-v1"],
    passthroughMode: "native",
  });
  await codexBridge.start();
  await claudeBridge.start();

  const env = {
    ...home.env,
    bridges: {
      codex: { url: codexBridge.url, tokenFile: home.env.bridges.codex.tokenFile },
      claude: { url: claudeBridge.url, tokenFile: home.env.bridges.claude.tokenFile },
    },
  };

  const adapters: Record<Provider, WorkerAdapter> = {
    codex: new CodexAdapter(env.bridges.codex),
    claude: new ClaudeAdapter(env.bridges.claude),
  };

  const baseConfig = cloneDefaultConfig();
  const config: HachiConfig = {
    ...baseConfig,
    ...configOverrides,
    profiles: configOverrides.profiles ?? baseConfig.profiles,
    allowlist: configOverrides.allowlist ?? baseConfig.allowlist,
    modelTransportPolicies: configOverrides.modelTransportPolicies ?? baseConfig.modelTransportPolicies!,
    resourceGuard: configOverrides.resourceGuard ?? baseConfig.resourceGuard,
  };
  const logger = createLogger({ filePath: join(home.home, "test-supervisor.jsonl") });

  // 既存 dispatch テストは互換性以外の境界を対象にするため、allowlist を明示広告する trusted fixture を使う。
  // unsupported/unknown は dispatch.test.ts でテストごとに probe を差し替えて検証する。
  const deps: TestStageDeps = {
    store,
    config,
    env,
    adapters,
    logger,
    modelTransportPreflight: {
      probe: async (provider, transport): Promise<{ ok: true; snapshot: ExecutionCapabilitySnapshot }> => ({
        ok: true,
        snapshot: {
          schemaVersion: "execution-capability.v1",
          provider,
          transport,
          runtime: { name: `${provider}-test-runtime`, version: "1.0.0", source: "advertised" },
          capabilities: provider === "claude" && transport === "bridge"
            ? ["max-turns-passthrough-v1"]
            : [],
          modelCatalog: { knowledge: "known", models: config.allowlist[provider], source: "advertised" },
          delivery: { model: "native", effort: "native", speed: "native" },
          observedAt: Date.now(),
        },
      }),
    },
    stewardArchiveIntegrationProbe: {
      observe: async () => ({ cwd: { kind: "repo-root", dirty: false }, drift: false }),
    },
  };

  return {
    home,
    store,
    codexBridge,
    claudeBridge,
    deps,
    cleanup: async (): Promise<void> => {
      store.close();
      await codexBridge.close();
      await claudeBridge.close();
      home.cleanup();
    },
  };
}
