import type {
  BridgeConfig,
  ExactSessionStopInput,
  ExactSessionStopResult,
  Provider,
  SessionRef,
  SessionState,
  WorkerStopCapabilities,
} from "@hachi/core";
import { probeBridgeCapabilities } from "./http.js";

/** bridge が広告する exact-session stop protocol 名（contract §57.3）。 */
export const SESSION_STOP_V1_CAPABILITY = "session-stop-v1";

const UNSUPPORTED_STOP_CAPABILITIES: WorkerStopCapabilities = {
  protocol: "unsupported",
  exactSession: false,
  childProcessTree: false,
};

/** 外部 bridge 実装との接続点。HTTP endpoint 未確定のため facade から分離する。 */
export interface ExactSessionStopTransport {
  readonly exactSession: boolean;
  readonly childProcessTree: boolean;
  stopExact(request: ExactSessionStopTransportRequest): Promise<ExactSessionStopResult | undefined>;
}

/** transport へ渡す値は exact target と cancel fence に限定する。 */
export interface ExactSessionStopTransportRequest {
  provider: Provider;
  sessionId: string;
  requestNonce: string;
  expectedRunId: number;
}

/** capability probe の依存。テストで応答欠落・失敗を決定的に再現できる。 */
export interface SessionStopCapabilityProbeDeps {
  probeCapabilities?: typeof probeBridgeCapabilities;
}

/**
 * bridge 広告と transport の双方が exact-session を保証する場合だけ session-stop-v1 を返す。
 * probe 失敗、未広告、未知 protocol、transport 不在/不整合はすべて unsupported に倒す。
 */
export async function probeSessionStopCapability(
  bridge: BridgeConfig,
  transport?: ExactSessionStopTransport,
  deps: SessionStopCapabilityProbeDeps = {},
): Promise<WorkerStopCapabilities> {
  if (transport === undefined || !transport.exactSession) {
    return { ...UNSUPPORTED_STOP_CAPABILITIES };
  }

  const probe = deps.probeCapabilities ?? probeBridgeCapabilities;
  let result: Awaited<ReturnType<typeof probeBridgeCapabilities>>;
  try {
    result = await probe(bridge);
  } catch {
    return { ...UNSUPPORTED_STOP_CAPABILITIES };
  }
  if (!result.ok || !result.capabilities.includes(SESSION_STOP_V1_CAPABILITY)) {
    return { ...UNSUPPORTED_STOP_CAPABILITIES };
  }

  return {
    protocol: "session-stop-v1",
    exactSession: true,
    childProcessTree: transport.childProcessTree,
  };
}

function localResult(
  state: ExactSessionStopResult["state"],
  evidenceId: string,
  observedSessionState: SessionState = "unknown",
): ExactSessionStopResult {
  return {
    state,
    evidenceId,
    observedSessionState,
    childProcessTreeCovered: false,
  };
}

function validTransportResult(value: ExactSessionStopResult | undefined): value is ExactSessionStopResult {
  if (value === undefined || value.evidenceId.trim() === "") {
    return false;
  }
  return (
    value.state === "stopped" ||
    value.state === "already-stopped" ||
    value.state === "unsupported" ||
    value.state === "rejected" ||
    value.state === "unknown"
  );
}

/**
 * capability probe と exact target/fence 検証を一箇所に閉じ込める facade。
 * 失敗時に bridge restart や process kill へ fallback せず、構造化結果を返す。
 */
export class ExactSessionStopFacade {
  constructor(
    private readonly bridge: BridgeConfig,
    private readonly transport?: ExactSessionStopTransport,
    private readonly deps: SessionStopCapabilityProbeDeps = {},
  ) {}

  async capabilities(ref: SessionRef): Promise<WorkerStopCapabilities> {
    return probeSessionStopCapability(this.bridgeFor(ref), this.transport, this.deps);
  }

  async stopExact(ref: SessionRef, input: ExactSessionStopInput): Promise<ExactSessionStopResult> {
    if (ref.sessionId !== input.expectedSessionId) {
      return localResult("rejected", "adapter:session-mismatch");
    }
    if (!Number.isSafeInteger(input.expectedRunId) || input.expectedRunId <= 0) {
      return localResult("rejected", "adapter:invalid-run-fence");
    }
    if (input.requestNonce.trim() === "") {
      return localResult("rejected", "adapter:invalid-request-fence");
    }

    const capabilities = await this.capabilities(ref);
    if (capabilities.protocol !== "session-stop-v1" || !capabilities.exactSession) {
      return localResult("unsupported", "adapter:session-stop-unsupported");
    }

    const transport = this.transport;
    if (transport === undefined) {
      return localResult("unsupported", "adapter:session-stop-transport-missing");
    }

    try {
      const result = await transport.stopExact({
        provider: ref.provider,
        sessionId: ref.sessionId,
        requestNonce: input.requestNonce,
        expectedRunId: input.expectedRunId,
      });
      if (!validTransportResult(result)) {
        return localResult("unknown", "adapter:stop-response-missing");
      }
      if (result.childProcessTreeCovered && !capabilities.childProcessTree) {
        return localResult("unknown", "adapter:child-tree-evidence-mismatch", result.observedSessionState);
      }
      return result;
    } catch {
      return localResult("unknown", "adapter:stop-transport-failure");
    }
  }

  private bridgeFor(ref: SessionRef): BridgeConfig {
    return { ...this.bridge, url: ref.serverUrl };
  }
}

export type FakeSessionStopMode = "success" | "reject" | "timeout" | "missing-response";

export interface FakeSessionStopRegistration {
  provider: Provider;
  sessionId: string;
  runId: number;
  requestNonce: string;
  state?: "active" | "stopped";
}

interface FakeSessionStopRecord {
  provider: Provider;
  runId: number;
  requestNonce: string;
  state: "active" | "stopped";
}

/** adapter unit/E2E 用の in-memory exact-session transport。 */
export class FakeExactSessionStopTransport implements ExactSessionStopTransport {
  readonly exactSession = true;
  readonly requests: ExactSessionStopTransportRequest[] = [];

  private readonly records = new Map<string, FakeSessionStopRecord>();
  private mode: FakeSessionStopMode = "success";

  constructor(readonly childProcessTree = true) {}

  registerSession(registration: FakeSessionStopRegistration): void {
    this.records.set(registration.sessionId, {
      provider: registration.provider,
      runId: registration.runId,
      requestNonce: registration.requestNonce,
      state: registration.state ?? "active",
    });
  }

  setMode(mode: FakeSessionStopMode): void {
    this.mode = mode;
  }

  sessionState(sessionId: string): "active" | "stopped" | "missing" {
    return this.records.get(sessionId)?.state ?? "missing";
  }

  async stopExact(request: ExactSessionStopTransportRequest): Promise<ExactSessionStopResult | undefined> {
    this.requests.push({ ...request });
    if (this.mode === "timeout") {
      throw new DOMException("fake stop timeout", "TimeoutError");
    }
    if (this.mode === "missing-response") {
      return undefined;
    }
    if (this.mode === "reject") {
      return localResult("rejected", "fake:stop-rejected", this.observedState(request.sessionId));
    }

    const record = this.records.get(request.sessionId);
    if (
      record === undefined ||
      record.provider !== request.provider ||
      record.runId !== request.expectedRunId ||
      record.requestNonce !== request.requestNonce
    ) {
      return localResult("rejected", "fake:fence-mismatch", this.observedState(request.sessionId));
    }
    if (record.state === "stopped") {
      return {
        state: "already-stopped",
        evidenceId: `fake:already-stopped:${request.sessionId}`,
        observedSessionState: "ended",
        childProcessTreeCovered: this.childProcessTree,
      };
    }

    record.state = "stopped";
    return {
      state: "stopped",
      evidenceId: `fake:stopped:${request.sessionId}`,
      observedSessionState: "ended",
      childProcessTreeCovered: this.childProcessTree,
    };
  }

  private observedState(sessionId: string): SessionState {
    const state = this.records.get(sessionId)?.state;
    if (state === "active") {
      return "active";
    }
    if (state === "stopped") {
      return "ended";
    }
    return "unknown";
  }
}
