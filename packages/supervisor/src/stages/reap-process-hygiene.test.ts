import { describe, expect, it } from "vitest";
import type { ProcessEntry, StageDeps } from "@hachi/core";
import { reapBridgeProcessHygiene } from "./reap.js";

function proc(pid: number, ppid: number, etime: string, command: string, pgid = pid, startTime = `start-${pid}`): ProcessEntry {
  return { pid, ppid, pgid, etime, startTime, command };
}

function deps(): StageDeps {
  const logger: StageDeps["logger"] = {
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return {
    store: {} as StageDeps["store"],
    config: { resourceGuard: { maxRunSeconds: 7200 } } as StageDeps["config"],
    env: {} as StageDeps["env"],
    adapters: {} as StageDeps["adapters"],
    logger,
  };
}

describe("reapBridgeProcessHygiene", () => {
  it("SIGTERM 後に親だけ消えて子が reparent されてもスナップショット由来で子へ SIGKILL を送る", async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    let listCalls = 0;

    const result = await reapBridgeProcessHygiene(deps(), true, {
      listProcesses: async () => {
        listCalls += 1;
        if (listCalls === 1) {
          return [
            proc(10, 1, "01:00", "kanban-shared-app-server"),
            proc(20, 10, "01:00", "codex"),
            proc(30, 20, "03:00:01", "mcp-old-parent"),
            proc(31, 30, "03:00:01", "mcp-old-child"),
          ];
        }
        return [
          proc(10, 1, "01:00", "kanban-shared-app-server"),
          proc(20, 10, "01:00", "codex"),
          proc(31, 1, "03:00:11", "mcp-old-child"),
        ];
      },
      signalProcess: (pid, signal): void => {
        signals.push({ pid, signal });
      },
      delay: async () => {},
    });

    expect(result.actions).toBe(1);
    expect(listCalls).toBe(2);
    // §51.2 注記: スナップショット後に生まれた孫はこの tick では追わず、次 tick の走査に委ねる。
    expect(signals).toEqual([
      { pid: 31, signal: "SIGTERM" },
      { pid: 30, signal: "SIGTERM" },
      { pid: 31, signal: 0 },
      { pid: 31, signal: "SIGKILL" },
    ]);
  });

  it("PID が再利用され開始時刻が変わった場合は SIGKILL を送らない", async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    let listCalls = 0;

    const result = await reapBridgeProcessHygiene(deps(), true, {
      listProcesses: async () => {
        listCalls += 1;
        if (listCalls === 1) {
          return [
            proc(10, 1, "01:00", "kanban-shared-app-server"),
            proc(20, 10, "01:00", "codex"),
            proc(30, 20, "03:00:01", "mcp-old-parent"),
            proc(31, 30, "03:00:01", "mcp-old-child"),
          ];
        }
        return [
          proc(10, 1, "01:00", "kanban-shared-app-server"),
          proc(20, 10, "01:00", "codex"),
          proc(30, 1, "03:00:11", "unrelated-reused-pid", 30, "reused-30"),
          proc(31, 30, "03:00:11", "unrelated-child", 31, "reused-31"),
        ];
      },
      signalProcess: (pid, signal): void => {
        signals.push({ pid, signal });
      },
      delay: async () => {},
    });

    expect(result.actions).toBe(1);
    expect(listCalls).toBe(2);
    expect(signals).toEqual([
      { pid: 31, signal: "SIGTERM" },
      { pid: 30, signal: "SIGTERM" },
    ]);
  });
});
