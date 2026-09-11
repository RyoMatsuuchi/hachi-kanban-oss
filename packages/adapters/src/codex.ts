// CodexAdapter: session.ts の共通実装に provider='codex' を束縛する薄いクラス
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

export interface CodexAdapterOptions {
  sessionStopTransport?: ExactSessionStopTransport;
}

/** even-terminal bridge（Codex 用）経由で Codex ワーカーを起動・監視する WorkerAdapter 実装 */
export class CodexAdapter implements WorkerAdapter {
  readonly provider = "codex" as const;
  private readonly sessionStop: ExactSessionStopFacade;

  constructor(private readonly bridge: BridgeConfig, options: CodexAdapterOptions = {}) {
    this.sessionStop = new ExactSessionStopFacade(bridge, options.sessionStopTransport);
  }

  async launch(_task: TaskRow, options: LaunchOptions): Promise<SessionRef> {
    // model/effort を明示的に配送する。渡さないと even-terminal 側の既定モデルで走ってしまい、
    // profile で選んだモデルが無視される（配送有無は応答の delivery で記録される）。
    return launchSession(this.bridge, this.provider, options, {
      passthrough: { model: true, effort: true },
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
