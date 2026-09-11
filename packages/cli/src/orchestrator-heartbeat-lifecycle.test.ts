import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapHeartbeatProcess,
  ORCHESTRATOR_HEARTBEAT_SUPERSEDED_EXIT_CODE,
  resolveHeartbeatLifecyclePaths,
  runHeartbeatDaemon,
  runHeartbeatLoop,
  stopHeartbeatProcess,
  type HeartbeatLifecycleRuntime,
  type HeartbeatPidfileRecord,
} from "./orchestrator-heartbeat-lifecycle.js";

const PROVIDER_SESSION_ID = "provider-session-heartbeat-test";
const CLI_PID = 9_000;
const DAEMON_PID = 9_100;
const CLI_STARTED_AT = "Sun Aug 31 15:00:00 2026";
const DAEMON_STARTED_AT = "Sun Aug 31 15:00:01 2026";

interface FakeRuntimeControl {
  runtime: HeartbeatLifecycleRuntime;
  processStartTimes: Map<number, string>;
  signals: Array<{ pid: number; signal: NodeJS.Signals }>;
  advance(ms: number): void;
}

function createFakeRuntime(
  spawnDaemon: HeartbeatLifecycleRuntime["spawnDaemon"] = () => {
    throw new Error("spawnDaemon は呼ばれない想定です");
  },
): FakeRuntimeControl {
  let nowMs = 1_800_000_000_000;
  const processStartTimes = new Map<number, string>([[CLI_PID, CLI_STARTED_AT]]);
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  return {
    processStartTimes,
    signals,
    advance: (ms: number): void => {
      nowMs += ms;
    },
    runtime: {
      currentPid: () => CLI_PID,
      nowMs: () => nowMs,
      randomToken: () => "a".repeat(32),
      getProcessStartTime: (pid) => processStartTimes.get(pid) ?? null,
      spawnDaemon,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
      },
      sleep: async (ms) => {
        nowMs += ms;
      },
    },
  };
}

function writePidfile(home: string, record: HeartbeatPidfileRecord): string {
  const paths = resolveHeartbeatLifecyclePaths(home, PROVIDER_SESSION_ID);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  writeFileSync(paths.pidfile, JSON.stringify(record), { mode: 0o600 });
  return paths.pidfile;
}

describe("orchestrator heartbeat lifecycle", () => {
  const tempHomes: string[] = [];

  function createHome(): string {
    const home = mkdtempSync(join(tmpdir(), "hachi-heartbeat-lifecycle-"));
    tempHomes.push(home);
    return home;
  }

  afterEach(() => {
    for (const home of tempHomes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("SESSION_SUPERSEDED は専用exit codeでloopを終了する", async () => {
    const wait = vi.fn(async () => undefined);

    const result = await runHeartbeatLoop({
      heartbeat: () => {
        throw new Error("SESSION_SUPERSEDED: active generation と一致しません");
      },
      shouldStop: () => false,
      wait,
      onTransientError: vi.fn(),
    });

    expect(result).toEqual({
      reason: "superseded",
      exitCode: ORCHESTRATOR_HEARTBEAT_SUPERSEDED_EXIT_CODE,
      error: "SESSION_SUPERSEDED: active generation と一致しません",
    });
    expect(wait).not.toHaveBeenCalled();
  });

  it("database is locked 相当の一時エラーでは終了せず次のheartbeatを試す", async () => {
    let heartbeatCalls = 0;
    let stopped = false;
    const transientErrors: string[] = [];

    const result = await runHeartbeatLoop({
      heartbeat: () => {
        heartbeatCalls += 1;
        if (heartbeatCalls === 1) {
          throw new Error("database is locked");
        }
        stopped = true;
      },
      shouldStop: () => stopped,
      wait: async () => undefined,
      onTransientError: (message) => transientErrors.push(message),
      intervalMs: 1,
    });

    expect(result).toEqual({ reason: "stopped", exitCode: 0 });
    expect(heartbeatCalls).toBe(2);
    expect(transientErrors).toEqual(["database is locked"]);
  });

  it("daemon pidfile はPIDとprocess起動時刻を0600で保存し、supersede時に自己回収する", async () => {
    const home = createHome();
    const paths = resolveHeartbeatLifecyclePaths(home, PROVIDER_SESSION_ID);
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    writeFileSync(paths.lockfile, JSON.stringify({
      version: 1,
      ownerToken: "b".repeat(32),
      pid: 8_900,
      processStartedAt: "Sun Aug 31 14:59:59 2026",
      createdAt: 1_800_000_000_000,
    }), { mode: 0o600 });
    const control = createFakeRuntime();
    control.processStartTimes.delete(CLI_PID);
    control.processStartTimes.set(DAEMON_PID, DAEMON_STARTED_AT);
    control.runtime.currentPid = () => DAEMON_PID;
    let observedRecord: HeartbeatPidfileRecord | null = null;
    let observedMode = 0;

    const result = await runHeartbeatDaemon({
      home,
      providerSessionId: PROVIDER_SESSION_ID,
      sessionId: "board-session-hidden-from-argv",
      generation: 7,
      ownerToken: "b".repeat(32),
      heartbeat: () => {
        observedRecord = JSON.parse(readFileSync(paths.pidfile, "utf8")) as HeartbeatPidfileRecord;
        observedMode = statSync(paths.pidfile).mode & 0o777;
        throw new Error("SESSION_SUPERSEDED: active generation と一致しません");
      },
      onTransientError: vi.fn(),
    }, control.runtime);

    expect(result.reason).toBe("superseded");
    expect(observedRecord).toMatchObject({
      version: 1,
      pid: DAEMON_PID,
      processStartedAt: DAEMON_STARTED_AT,
    });
    expect(observedMode).toBe(0o600);
    expect(existsSync(paths.pidfile)).toBe(false);
  });

  it("同じprovider sessionの生存pidfileがある二重bootstrapを拒否する", async () => {
    const home = createHome();
    const pidfile = writePidfile(home, {
      version: 1,
      pid: DAEMON_PID,
      processStartedAt: DAEMON_STARTED_AT,
      createdAt: 1_800_000_000_000,
    });
    const contentBefore = readFileSync(pidfile, "utf8");
    const mtimeBefore = statSync(pidfile, { bigint: true }).mtimeNs;
    const control = createFakeRuntime();
    control.processStartTimes.set(DAEMON_PID, DAEMON_STARTED_AT);
    const signalProcess = vi.spyOn(control.runtime, "signalProcess").mockImplementation((pid) => {
      control.processStartTimes.delete(pid);
    });

    await expect(bootstrapHeartbeatProcess({
      home,
      board: "dev",
      providerSessionId: PROVIDER_SESSION_ID,
      sessionId: "board-session-hidden-from-argv",
      generation: 7,
      processEnv: {},
    }, control.runtime)).rejects.toThrow("heartbeat already");

    expect(control.processStartTimes.get(DAEMON_PID)).toBe(DAEMON_STARTED_AT);
    expect(signalProcess).not.toHaveBeenCalled();
    expect(readFileSync(pidfile, "utf8")).toBe(contentBefore);
    expect(statSync(pidfile, { bigint: true }).mtimeNs).toBe(mtimeBefore);
  });

  it("CLI wrapper と daemon のPIDが異なってもdaemon pidfileの生存確認で起動成功にする", async () => {
    const home = createHome();
    const paths = resolveHeartbeatLifecyclePaths(home, PROVIDER_SESSION_ID);
    const wrapperPid = 9_050;
    let runtimeControl: FakeRuntimeControl | null = null;
    runtimeControl = createFakeRuntime(() => {
      runtimeControl!.processStartTimes.set(wrapperPid, "Sun Aug 31 15:00:00 2026");
      runtimeControl!.processStartTimes.set(DAEMON_PID, DAEMON_STARTED_AT);
      writeFileSync(paths.pidfile, JSON.stringify({
        version: 1,
        pid: DAEMON_PID,
        processStartedAt: DAEMON_STARTED_AT,
        createdAt: 1_800_000_000_000,
      }), { mode: 0o600 });
      return { pid: wrapperPid };
    });

    const result = await bootstrapHeartbeatProcess({
      home,
      board: "dev",
      providerSessionId: PROVIDER_SESSION_ID,
      sessionId: "board-session-hidden-from-argv",
      generation: 7,
      processEnv: {},
    }, runtimeControl.runtime);

    expect(result).toMatchObject({
      status: "started",
      pid: DAEMON_PID,
      processStartedAt: DAEMON_STARTED_AT,
    });
  });

  it("stop-heartbeat は同一processの消滅を観測してから成功する", async () => {
    const home = createHome();
    const pidfile = writePidfile(home, {
      version: 1,
      pid: DAEMON_PID,
      processStartedAt: DAEMON_STARTED_AT,
      createdAt: 1_800_000_000_000,
    });
    const control = createFakeRuntime();
    control.processStartTimes.set(DAEMON_PID, DAEMON_STARTED_AT);
    control.runtime.sleep = async (ms) => {
      control.advance(ms);
      control.processStartTimes.delete(DAEMON_PID);
    };

    const result = await stopHeartbeatProcess({
      home,
      providerSessionId: PROVIDER_SESSION_ID,
      stopTimeoutMs: 100,
      pollIntervalMs: 1,
    }, control.runtime);

    expect(result).toMatchObject({
      status: "stopped",
      disappearanceConfirmed: true,
      pid: DAEMON_PID,
      forced: false,
    });
    expect(control.signals).toEqual([{ pid: DAEMON_PID, signal: "SIGTERM" }]);
    expect(existsSync(pidfile)).toBe(false);
  });

  it("pidfileのPIDが別processへ再利用されていたらsignalを送らず起動時刻で弾く", async () => {
    const home = createHome();
    const pidfile = writePidfile(home, {
      version: 1,
      pid: DAEMON_PID,
      processStartedAt: DAEMON_STARTED_AT,
      createdAt: 1_800_000_000_000,
    });
    const control = createFakeRuntime();
    control.processStartTimes.set(DAEMON_PID, "Sun Aug 31 16:00:00 2026");

    const result = await stopHeartbeatProcess({
      home,
      providerSessionId: PROVIDER_SESSION_ID,
    }, control.runtime);

    expect(result).toEqual({
      status: "stale-pidfile",
      disappearanceConfirmed: true,
      pid: DAEMON_PID,
      pidReused: true,
      pidfile,
    });
    expect(control.signals).toEqual([]);
    expect(existsSync(pidfile)).toBe(false);
  });
});
