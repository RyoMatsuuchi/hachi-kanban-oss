/** steward / brief が共有する auto-disable circuit breaker の判定と状態遷移。 */

import { acquireStewardStateLock } from "@hachi/core";
import type { StewardStateLockOwner } from "@hachi/core";

/** 連続失敗の auto-disable 閾値。 */
export const AUTO_DISABLE_THRESHOLD = 3;

/** auto-disable 後に half-open 再試行を許可するまでの秒数。 */
export const AUTO_DISABLE_RETRY_AFTER_SEC = 3_600;

export interface AutoDisableCircuitState {
  consecutiveFailures: number;
  autoDisabled: boolean;
  autoDisabledReason: string;
  autoDisabledAt: number;
  claimGeneration: number;
}

type AutoDisableLockOwner = Extract<
  StewardStateLockOwner,
  "supervisor-steward" | "supervisor-brief"
>;

export interface AutoDisableCircuitStateReader<State extends AutoDisableCircuitState> {
  home: string;
  lockOwner: AutoDisableLockOwner;
  /** 共有 state lock の保持中に最新 state を読み直す。 */
  readState(): State;
}

export interface AutoDisableCircuitStateStore<State extends AutoDisableCircuitState>
  extends AutoDisableCircuitStateReader<State> {
  /** 呼び出し元が既に共有 state lock を保持している前提で durable write する。 */
  writeStateUnderLock(state: State): void;
}

export type AutoDisableHalfOpenClaimAcquireResult =
  | { status: "acquired"; claimGeneration: number }
  | { status: "lock-contended" }
  | { status: "not-eligible" };

export type AutoDisableHalfOpenClaimFenceResult<Result> =
  | { status: "executed"; value: Result }
  | { status: "lock-contended" }
  | { status: "claim-mismatch" };

type SynchronousFenceResult<Result> = Result extends PromiseLike<unknown> ? never : Result;

export interface AutoDisableRunDecision {
  shouldRun: boolean;
  halfOpen: boolean;
  retryAfterSec: number;
}

export interface AutoDisableFailureDecision {
  nextState: AutoDisableCircuitState;
  transitionedToAutoDisabled: boolean;
}

export interface AutoDisableSuccessDecision {
  nextState: AutoDisableCircuitState;
  recoveredFromAutoDisabled: boolean;
}

function currentClaimGeneration(state: AutoDisableCircuitState): number {
  return state.claimGeneration ?? 0;
}

function nextClaimGeneration(state: AutoDisableCircuitState): number {
  const current = currentClaimGeneration(state);
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new Error(
      "claimGeneration は非負かつ Number.MAX_SAFE_INTEGER 未満の安全整数である必要があります",
    );
  }
  return current + 1;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }
  return typeof (value as { then?: unknown }).then === "function";
}

/**
 * 共有 state lock 下で half-open 可否を再判定し、eligible な1 claimantだけが世代を獲得する。
 * lock 競合と eligible でない場合は、呼び出し元が別々に扱える結果を返す。
 */
export function tryAcquireAutoDisableHalfOpenClaim<State extends AutoDisableCircuitState>(
  access: AutoDisableCircuitStateStore<State>,
  nowSec: number,
): AutoDisableHalfOpenClaimAcquireResult {
  const lock = acquireStewardStateLock(access.home, access.lockOwner);
  if (lock === null) {
    return { status: "lock-contended" };
  }
  try {
    const state = access.readState();
    const decision = decideAutoDisableRun(state, nowSec);
    if (!decision.halfOpen || !decision.shouldRun) {
      return { status: "not-eligible" };
    }
    const claimGeneration = nextClaimGeneration(state);
    access.writeStateUnderLock({
      ...state,
      autoDisabledAt: nowSec,
      claimGeneration,
    });
    return { status: "acquired", claimGeneration };
  } finally {
    lock.release();
  }
}

/**
 * 共有 state lock 下で獲得済み generation を再確認し、有効な場合だけ同じlock保持中に処理する。
 */
export function runUnderAutoDisableHalfOpenClaimFence<
  State extends AutoDisableCircuitState,
  Result,
>(
  access: AutoDisableCircuitStateStore<State>,
  claimGeneration: number,
  fn: (
    state: State,
    writeStateUnderLock: (state: State) => void,
  ) => SynchronousFenceResult<Result>,
): AutoDisableHalfOpenClaimFenceResult<Result> {
  const lock = acquireStewardStateLock(access.home, access.lockOwner);
  if (lock === null) {
    return { status: "lock-contended" };
  }
  let writerActive = true;
  const writeStateUnderLock = (state: State): void => {
    if (!writerActive) {
      throw new Error("fence scope外ではstateを書き込めません");
    }
    access.writeStateUnderLock(state);
  };
  try {
    const state = access.readState();
    const current = currentClaimGeneration(state);
    if (!Number.isSafeInteger(current) || current < 0 || current !== claimGeneration) {
      return { status: "claim-mismatch" };
    }
    const value = fn(state, writeStateUnderLock);
    if (isThenable(value)) {
      throw new TypeError("fence callbackは同期的に完了する必要があります");
    }
    return { status: "executed", value };
  } finally {
    writerActive = false;
    lock.release();
  }
}

/** auto-disable 中の通常 skip と、待機時間経過後の1回限りの half-open を判定する。 */
export function decideAutoDisableRun(
  state: AutoDisableCircuitState,
  nowSec: number,
): AutoDisableRunDecision {
  if (!state.autoDisabled) {
    return { shouldRun: true, halfOpen: false, retryAfterSec: 0 };
  }

  // legacy state の 0 は即座に half-open 可とする。
  if (state.autoDisabledAt === 0) {
    return { shouldRun: true, halfOpen: true, retryAfterSec: 0 };
  }

  const elapsedSec = Math.max(0, nowSec - state.autoDisabledAt);
  const retryAfterSec = Math.max(0, AUTO_DISABLE_RETRY_AFTER_SEC - elapsedSec);
  return {
    shouldRun: retryAfterSec === 0,
    halfOpen: retryAfterSec === 0,
    retryAfterSec,
  };
}

/**
 * 通常失敗は閾値まで数え、閾値到達時刻を記録する。
 * half-open 失敗は回数を増やさず、次回再試行の起点時刻だけを更新する。
 */
export function decideAutoDisableFailure(
  state: AutoDisableCircuitState,
  nowSec: number,
  reason: string,
): AutoDisableFailureDecision {
  if (state.autoDisabled) {
    return {
      nextState: { ...state, autoDisabledAt: nowSec },
      transitionedToAutoDisabled: false,
    };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;
  if (consecutiveFailures < AUTO_DISABLE_THRESHOLD) {
    return {
      nextState: { ...state, consecutiveFailures },
      transitionedToAutoDisabled: false,
    };
  }

  return {
    nextState: {
      ...state,
      consecutiveFailures,
      autoDisabled: true,
      autoDisabledReason: `連続${consecutiveFailures}回失敗: ${reason}`,
      autoDisabledAt: nowSec,
    },
    transitionedToAutoDisabled: true,
  };
}

/** 成功時は通常実行・half-open を問わず circuit の失敗状態を完全に解除する。 */
export function decideAutoDisableSuccess(
  state: AutoDisableCircuitState,
): AutoDisableSuccessDecision {
  return {
    nextState: {
      ...state,
      consecutiveFailures: 0,
      autoDisabled: false,
      autoDisabledReason: "",
      autoDisabledAt: 0,
    },
    recoveredFromAutoDisabled: state.autoDisabled,
  };
}
