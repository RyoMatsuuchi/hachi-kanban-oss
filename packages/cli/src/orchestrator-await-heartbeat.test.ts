import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCleanupClaimTokenRemoved,
  installAwaitSignalCleanup,
  isOrchestratorAwaitClaimConflict,
  OrchestratorAwaitHeartbeat,
  type AwaitSignal,
  type AwaitSignalTarget,
} from "./orchestrator-await-heartbeat.js";

class FakeSignalTarget extends EventEmitter implements AwaitSignalTarget {
  readonly pid = 123;
  readonly kills: Array<{ pid: number; signal: AwaitSignal }> = [];

  kill(pid: number, signal: AwaitSignal): void {
    this.kills.push({ pid, signal });
  }
}

describe("OrchestratorAwaitHeartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("poll待機より短い独立間隔でheartbeatを維持し、stop後は更新しない", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn();
    const lease = new OrchestratorAwaitHeartbeat({ heartbeat, heartbeatIntervalSeconds: 3, staleSeconds: 10 });
    lease.start();
    const waiting = lease.wait(20_000);

    await vi.advanceTimersByTimeAsync(9_100);
    expect(heartbeat).toHaveBeenCalledTimes(4);

    const stopped = expect(waiting).rejects.toThrow("停止しました");
    lease.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(heartbeat).toHaveBeenCalledTimes(4);
    await stopped;
  });

  it("handoff等で旧generation heartbeatが拒否されると待機を即座に失敗させtimerを止める", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("SESSION_SUPERSEDED: active generation と一致しません");
      });
    const lease = new OrchestratorAwaitHeartbeat({ heartbeat, heartbeatIntervalSeconds: 3, staleSeconds: 10 });
    lease.start();
    const waiting = lease.wait(60_000);

    const assertion = expect(waiting).rejects.toThrow("SESSION_SUPERSEDED");
    await vi.advanceTimersByTimeAsync(3_100);
    await assertion;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeat).toHaveBeenCalledTimes(2);
  });

  it("複数await相当のheartbeatは独立かつ冪等に更新できる", async () => {
    vi.useFakeTimers();
    let durableHeartbeat = 0;
    const update = (): void => {
      durableHeartbeat += 1;
    };
    const first = new OrchestratorAwaitHeartbeat({ heartbeat: update, heartbeatIntervalSeconds: 3, staleSeconds: 10 });
    const second = new OrchestratorAwaitHeartbeat({ heartbeat: update, heartbeatIntervalSeconds: 3, staleSeconds: 10 });
    first.start();
    second.start();

    await vi.advanceTimersByTimeAsync(6_100);
    expect(durableHeartbeat).toBe(6);
    first.stop();
    second.stop();
  });

  it("SIGINT/SIGTERMはcleanup後にsignalを再送しlistenerを残さない", () => {
    const target = new FakeSignalTarget();
    const stop = vi.fn();
    installAwaitSignalCleanup(stop, target);

    target.emit("SIGTERM");

    expect(stop).toHaveBeenCalledOnce();
    expect(target.kills).toEqual([{ pid: 123, signal: "SIGTERM" }]);
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("SIGTERM")).toBe(0);
  });

  it.each([
    "request は他の session が claim 済みです",
    "runtime cleanup request は既に claim 済みです",
  ])("既知CAS競合だけを再poll対象として識別する: %s", (message) => {
    expect(isOrchestratorAwaitClaimConflict(new Error(message))).toBe(true);
  });

  it.each([
    new Error("SESSION_SUPERSEDED: active generation と一致しません"),
    new Error("この session は request の配送対象ではありません"),
    new Error("予期しないDBエラー"),
    "request は他の session が claim 済みです",
  ])("fence・権限・予期しないerrorは競合扱いしない", (error) => {
    expect(isOrchestratorAwaitClaimConflict(error)).toBe(false);
  });

  it("cleanup token削除失敗時はawait継続をfail-closedで拒否する", () => {
    expect(() => assertCleanupClaimTokenRemoved(false)).toThrow("await を継続できません");
    expect(() => assertCleanupClaimTokenRemoved(true)).not.toThrow();
  });
});
