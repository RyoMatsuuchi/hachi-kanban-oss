import {
  assertOrchestratorSessionHeartbeatPolicy,
  ORCHESTRATOR_AWAIT_HEARTBEAT_INTERVAL_SECONDS,
  ORCHESTRATOR_SESSION_STALE_SECONDS,
} from "@hachi/core";

type TimerHandle = ReturnType<typeof setTimeout>;

export interface AwaitHeartbeatOptions {
  heartbeat: () => void;
  heartbeatIntervalSeconds?: number;
  staleSeconds?: number;
}

const ORCHESTRATOR_REQUEST_CLAIM_CONFLICT = "request は他の session が claim 済みです";
const RUNTIME_CLEANUP_CLAIM_CONFLICT = "runtime cleanup request は既に claim 済みです";

/** 同一generationの複数await間で起き得る既知CAS競合だけを再poll対象とする。 */
export function isOrchestratorAwaitClaimConflict(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message === ORCHESTRATOR_REQUEST_CLAIM_CONFLICT ||
    error.message === RUNTIME_CLEANUP_CLAIM_CONFLICT;
}

/** CAS競合後のsecret残骸を許さず、削除不能なら待機継続を拒否する。 */
export function assertCleanupClaimTokenRemoved(removed: boolean): void {
  if (!removed) {
    throw new Error("cleanup claim token file を削除できないため await を継続できません");
  }
}

/**
 * inbox poll と独立してsession heartbeatを維持する。
 * heartbeatがgeneration fenceで拒否された場合は待機中sleepも即座にrejectする。
 */
export class OrchestratorAwaitHeartbeat {
  private readonly heartbeat: () => void;
  private readonly heartbeatIntervalMs: number;
  private heartbeatTimer: TimerHandle | null = null;
  private waitTimer: TimerHandle | null = null;
  private waitReject: ((error: Error) => void) | null = null;
  private failure: Error | null = null;
  private stopped = true;

  constructor(options: AwaitHeartbeatOptions) {
    const heartbeatIntervalSeconds = options.heartbeatIntervalSeconds ?? ORCHESTRATOR_AWAIT_HEARTBEAT_INTERVAL_SECONDS;
    const staleSeconds = options.staleSeconds ?? ORCHESTRATOR_SESSION_STALE_SECONDS;
    assertOrchestratorSessionHeartbeatPolicy(staleSeconds, heartbeatIntervalSeconds);
    this.heartbeat = options.heartbeat;
    this.heartbeatIntervalMs = heartbeatIntervalSeconds * 1000;
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.failure = null;
    try {
      this.heartbeat();
    } catch (error) {
      this.stopped = true;
      throw error;
    }
    this.scheduleHeartbeat();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.waitTimer !== null) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    const reject = this.waitReject;
    this.waitReject = null;
    reject?.(new Error("orchestrator await heartbeat は停止しました"));
  }

  wait(milliseconds: number): Promise<void> {
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    if (this.stopped) {
      return Promise.reject(new Error("orchestrator await heartbeat は停止済みです"));
    }
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      return Promise.reject(new Error(`待機時間は0以上が必須です: ${milliseconds}`));
    }
    return new Promise<void>((resolve, reject) => {
      this.waitReject = reject;
      this.waitTimer = setTimeout(() => {
        this.waitTimer = null;
        this.waitReject = null;
        resolve();
      }, milliseconds);
    });
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.stopped) {
        return;
      }
      try {
        this.heartbeat();
      } catch (error) {
        this.fail(error);
        return;
      }
      this.scheduleHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private fail(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.stopped = true;
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.waitTimer !== null) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    const reject = this.waitReject;
    this.waitReject = null;
    reject?.(this.failure);
  }
}

export type AwaitSignal = "SIGINT" | "SIGTERM";

export interface AwaitSignalTarget {
  pid: number;
  once(signal: AwaitSignal, listener: () => void): unknown;
  off(signal: AwaitSignal, listener: () => void): unknown;
  kill(pid: number, signal: AwaitSignal): unknown;
}

/** signal時にtimerを同期cleanupしてから既定のsignal終了を再送する。 */
export function installAwaitSignalCleanup(
  stop: () => void,
  target: AwaitSignalTarget = process,
): () => void {
  let active = true;
  const remove = (): void => {
    if (!active) {
      return;
    }
    active = false;
    target.off("SIGINT", onSigint);
    target.off("SIGTERM", onSigterm);
  };
  const handle = (signal: AwaitSignal): void => {
    stop();
    remove();
    target.kill(target.pid, signal);
  };
  const onSigint = (): void => handle("SIGINT");
  const onSigterm = (): void => handle("SIGTERM");
  target.once("SIGINT", onSigint);
  target.once("SIGTERM", onSigterm);
  return remove;
}
