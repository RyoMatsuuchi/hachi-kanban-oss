// ClaudeAdapter: session.ts の共通実装に provider='claude' を束縛する薄いクラス
import type {
  BridgeConfig,
  ExactSessionStopInput,
  ExactSessionStopResult,
  LaunchOptions,
  SessionRef,
  StopResult,
  TaskRow,
  WorkerAdapter,
  WorkerStopCapabilities,
} from "@hachi/core";
import { bridgeHealthCheck } from "./http.js";
import {
  fetchSessionTranscript,
  getSessionStatus,
  injectSession,
  launchSession,
  stopUnsupported,
  type BridgeSessionStatus,
} from "./session.js";
import { ExactSessionStopFacade, type ExactSessionStopTransport } from "./session-stop.js";

export interface ClaudeAdapterOptions {
  sessionStopTransport?: ExactSessionStopTransport;
}

/** Claude 起動は even-terminal 側で数十秒かかることがあるため、launch のみ 120 秒待つ。 */
export const CLAUDE_PROMPT_TIMEOUT_MS = 120_000;

/**
 * bridge 経路のターン上限。even-terminal の既定 50 は G2 の対話用途向けで、
 * 自律ワーカーは handoff を書く前に打ち切られる。ターン数で切るのではなく supervisor の
 * 監視（heartbeat / cancel / resource lease）で終端させたいので十分に高く取る。
 * runtime 側は 1〜2000 の整数のみ受理する。
 * 注: monitor の outputStall / maxRuntime は direct 経路専用のガードであり bridge には効かない。
 */
export const CLAUDE_BRIDGE_MAX_TURNS = 1000;

/** even-terminal bridge（Claude 用）経由で Claude ワーカーを起動・監視する WorkerAdapter 実装 */
export class ClaudeAdapter implements WorkerAdapter {
  readonly provider = "claude" as const;
  private readonly sessionStop: ExactSessionStopFacade;

  constructor(private readonly bridge: BridgeConfig, options: ClaudeAdapterOptions = {}) {
    this.sessionStop = new ExactSessionStopFacade(bridge, options.sessionStopTransport);
  }

  async launch(_task: TaskRow, options: LaunchOptions): Promise<SessionRef> {
    // model/effort を明示的に配送する。渡さないと even-terminal 側の既定モデルで走ってしまい、
    // profile で選んだモデルが無視される（配送有無は応答の delivery で記録される）。
    return launchSession(this.bridge, this.provider, options, {
      timeoutMs: CLAUDE_PROMPT_TIMEOUT_MS,
      passthrough: { model: true, effort: true },
      maxTurns: CLAUDE_BRIDGE_MAX_TURNS,
    });
  }

  async status(ref: SessionRef): Promise<BridgeSessionStatus> {
    return getSessionStatus(this.bridge, ref);
  }

  async inject(ref: SessionRef, message: string): Promise<void> {
    await injectSession(this.bridge, ref, message);
  }

  async fetchTranscript(ref: SessionRef): Promise<string> {
    return fetchSessionTranscript(this.bridge, ref);
  }

  async healthCheck(): Promise<boolean> {
    return bridgeHealthCheck(this.bridge);
  }

  async stop(ref: SessionRef): Promise<StopResult> {
    // bridge API に停止経路が無いため unsupported を返す（throw しない、契約 §34.2）。
    void ref;
    return stopUnsupported();
  }

  async stopCapabilities(ref: SessionRef): Promise<WorkerStopCapabilities> {
    return this.sessionStop.capabilities(ref);
  }

  async stopExact(ref: SessionRef, input: ExactSessionStopInput): Promise<ExactSessionStopResult> {
    return this.sessionStop.stopExact(ref, input);
  }
}
