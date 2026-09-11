import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireStewardStateLock, writeFileAtomic0600Durable } from "@hachi/core";
import { makeTempHome, type TempHome } from "@hachi/testing";
import {
  runUnderAutoDisableHalfOpenClaimFence,
  tryAcquireAutoDisableHalfOpenClaim,
  type AutoDisableHalfOpenClaimAcquireResult,
  type AutoDisableCircuitStateStore,
} from "./auto-disable-circuit-breaker.js";

interface TestCircuitState {
  consecutiveFailures: number;
  autoDisabled: boolean;
  autoDisabledReason: string;
  autoDisabledAt: number;
  claimGeneration: number;
}

describe("auto-disable half-open claim", () => {
  let tempHome: TempHome;
  let statePath: string;

  beforeEach(() => {
    tempHome = makeTempHome();
    const stateDir = join(tempHome.home, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    statePath = join(stateDir, "half-open-claim-test.json");
  });

  afterEach(() => {
    tempHome.cleanup();
  });

  function state(overrides: Partial<TestCircuitState> = {}): TestCircuitState {
    return {
      consecutiveFailures: 3,
      autoDisabled: true,
      autoDisabledReason: "連続3回失敗",
      autoDisabledAt: 0,
      claimGeneration: 0,
      ...overrides,
    };
  }

  function readState(): TestCircuitState {
    return JSON.parse(readFileSync(statePath, "utf8")) as TestCircuitState;
  }

  function writeState(nextState: TestCircuitState | Omit<TestCircuitState, "claimGeneration">): void {
    writeFileAtomic0600Durable(statePath, JSON.stringify(nextState));
  }

  function stateStore(beforeWrite?: () => void): AutoDisableCircuitStateStore<TestCircuitState> {
    return {
      home: tempHome.home,
      lockOwner: "supervisor-steward",
      readState,
      writeStateUnderLock: (nextState): void => {
        beforeWrite?.();
        writeState(nextState);
      },
    };
  }

  it("2つのclaim獲得が重なっても共有lockにより1つしか成功しない", () => {
    const nowSec = 10_000;
    writeState(state());
    let competingClaim: AutoDisableHalfOpenClaimAcquireResult | undefined;
    const competingStore = stateStore();
    const firstStore = stateStore(() => {
      competingClaim = tryAcquireAutoDisableHalfOpenClaim(competingStore, nowSec);
    });

    const firstClaim = tryAcquireAutoDisableHalfOpenClaim(firstStore, nowSec);
    const laterClaim = tryAcquireAutoDisableHalfOpenClaim(competingStore, nowSec);

    expect(firstClaim).toEqual({ status: "acquired", claimGeneration: 1 });
    expect(competingClaim).toEqual({ status: "lock-contended" });
    expect(laterClaim).toEqual({ status: "not-eligible" });
  });

  it("claim獲得時にgenerationを+1し時刻と同じ書き込みで永続化する", () => {
    const nowSec = 20_000;
    writeState(state({ claimGeneration: 7 }));

    const claim = tryAcquireAutoDisableHalfOpenClaim(stateStore(), nowSec);

    expect(claim).toEqual({ status: "acquired", claimGeneration: 8 });
    expect(readState()).toMatchObject({
      autoDisabledAt: nowSec,
      claimGeneration: 8,
    });
  });

  it("generationが進んだ後は古い獲得値のfenceを拒否する", () => {
    const firstNowSec = 30_000;
    writeState(state());
    const store = stateStore();
    const firstClaim = tryAcquireAutoDisableHalfOpenClaim(store, firstNowSec);
    const secondClaim = tryAcquireAutoDisableHalfOpenClaim(store, firstNowSec + 3_600);
    if (firstClaim.status !== "acquired" || secondClaim.status !== "acquired") {
      throw new Error("test setup でclaimを獲得できませんでした");
    }
    let firstExecuted = false;
    let secondExecuted = false;
    const firstFence = runUnderAutoDisableHalfOpenClaimFence(
      store,
      firstClaim.claimGeneration,
      () => {
        firstExecuted = true;
      },
    );
    const secondFence = runUnderAutoDisableHalfOpenClaimFence(
      store,
      secondClaim.claimGeneration,
      () => {
        secondExecuted = true;
      },
    );

    expect(firstClaim.claimGeneration).toBe(1);
    expect(secondClaim.claimGeneration).toBe(2);
    expect(firstFence).toEqual({ status: "claim-mismatch" });
    expect(firstExecuted).toBe(false);
    expect(secondFence).toEqual({ status: "executed", value: undefined });
    expect(secondExecuted).toBe(true);
  });

  it("fence一致時は共有lockを保持したまま処理とstate書き込みを行う", () => {
    writeState(state({ claimGeneration: 4 }));
    const store = stateStore();

    const result = runUnderAutoDisableHalfOpenClaimFence(store, 4, (current, writeUnderLock) => {
      const competingLock = acquireStewardStateLock(tempHome.home, "cli-steward-enable");
      expect(competingLock).toBeNull();
      writeUnderLock({ ...current, autoDisabledReason: "fenced transition" });
      return "applied";
    });

    expect(result).toEqual({ status: "executed", value: "applied" });
    expect(readState().autoDisabledReason).toBe("fenced transition");
  });

  it("asyncなfence callbackを拒否してlockを解放する", () => {
    writeState(state({ claimGeneration: 4 }));
    const store = stateStore();

    expect(() => runUnderAutoDisableHalfOpenClaimFence(
      store,
      4,
      // @ts-expect-error fence callbackは同期関数だけを受け付ける。
      async () => undefined,
    )).toThrow(/同期的に完了/);

    const lock = acquireStewardStateLock(tempHome.home, "cli-steward-enable");
    expect(lock).not.toBeNull();
    lock?.release();
  });

  it("fence scope外へ持ち出したwriterを拒否する", () => {
    writeState(state({ claimGeneration: 4 }));
    const store = stateStore();
    const escaped: { writer?: (nextState: TestCircuitState) => void } = {};

    const result = runUnderAutoDisableHalfOpenClaimFence(store, 4, (current, writeUnderLock) => {
      escaped.writer = writeUnderLock;
      return current;
    });
    if (result.status !== "executed" || escaped.writer === undefined) {
      throw new Error("test setup でwriterを取得できませんでした");
    }

    expect(() => escaped.writer?.({
      ...result.value,
      autoDisabledReason: "out of scope transition",
    })).toThrow(/scope外/);
    expect(readState().autoDisabledReason).toBe("連続3回失敗");
  });

  it("fence不一致とlock競合を戻り値で区別する", () => {
    writeState(state({ claimGeneration: 5 }));
    const store = stateStore();
    const mismatch = runUnderAutoDisableHalfOpenClaimFence(store, 4, () => undefined);
    const lock = acquireStewardStateLock(tempHome.home, "cli-steward-enable");
    if (lock === null) {
      throw new Error("test setup でlockを獲得できませんでした");
    }
    try {
      const contended = runUnderAutoDisableHalfOpenClaimFence(store, 5, () => undefined);
      expect(mismatch).toEqual({ status: "claim-mismatch" });
      expect(contended).toEqual({ status: "lock-contended" });
    } finally {
      lock.release();
    }
  });

  it("claimGenerationが欠落したstateは0として扱う", () => {
    const legacyState: Omit<TestCircuitState, "claimGeneration"> = {
      consecutiveFailures: 3,
      autoDisabled: true,
      autoDisabledReason: "legacy",
      autoDisabledAt: 0,
    };
    writeState(legacyState);

    const claim = tryAcquireAutoDisableHalfOpenClaim(stateStore(), 40_000);

    expect(claim).toEqual({ status: "acquired", claimGeneration: 1 });
    expect(readState().claimGeneration).toBe(1);
  });

  it("claimGenerationが上限到達済みならfail-closedで失敗する", () => {
    writeState(state({ claimGeneration: Number.MAX_SAFE_INTEGER }));

    expect(() => tryAcquireAutoDisableHalfOpenClaim(stateStore(), 50_000))
      .toThrow(/Number\.MAX_SAFE_INTEGER/);
    expect(readState()).toMatchObject({
      autoDisabledAt: 0,
      claimGeneration: Number.MAX_SAFE_INTEGER,
    });
  });
});
