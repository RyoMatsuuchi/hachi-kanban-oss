import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeIdentityFailure, BridgeIdentityResult } from "@hachi/adapters";
import { createLogger, SqliteKanbanStore } from "@hachi/core";
import type { Provider, StageDeps, WorkerAdapter } from "@hachi/core";
import { makeTempHome, taskInput, type TempHome } from "@hachi/testing";
import { DEFAULT_TEST_CONFIG, FakeAdapter } from "../test-support.js";
import { Supervisor } from "../supervisor.js";
import {
  createWebwatchStage,
  type BridgewatchAutohealNotifyFn,
  type BridgewatchNotifyFn,
  type BridgewatchProbeFn,
  type WebwatchKillPidFn,
  type WebwatchExecFn,
  type WebwatchFetchFn,
  type WebwatchListPortListenersFn,
  type WebwatchNowFn,
  type WebwatchPortListener,
} from "./webwatch.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface ExecCall {
  command: string;
  args: string[];
}

interface NotifyCall {
  provider: Provider;
  consecutiveFailures: number;
}

interface KillCall {
  pid: number;
  signal: "SIGTERM";
}

interface AutohealNotifyCall {
  provider: Provider;
  port: number;
  pid: number;
  command: string;
}

type FetchFactory = () => Response | Promise<Response>;

interface SubjectOptions {
  listPortListenersFn?: WebwatchListPortListenersFn;
  killPidFn?: WebwatchKillPidFn;
  autohealNotifyFn?: BridgewatchAutohealNotifyFn;
}

interface WebwatchSubject {
  stage: ReturnType<typeof createWebwatchStage>;
  fetchCalls: FetchCall[];
  execCalls: ExecCall[];
  notifyCalls: NotifyCall[];
  killCalls: KillCall[];
  autohealNotifyCalls: AutohealNotifyCall[];
}

interface LocalHarness {
  home: TempHome;
  store: SqliteKanbanStore;
  deps: StageDeps;
  cleanup: () => void;
}

function setupLocalHarness(): LocalHarness {
  const home = makeTempHome();
  const store = new SqliteKanbanStore(home.env.dbPath);
  const adapters: Record<Provider, WorkerAdapter> = {
    codex: new FakeAdapter("codex"),
    claude: new FakeAdapter("claude"),
  };
  const deps: StageDeps = {
    store,
    config: DEFAULT_TEST_CONFIG,
    env: home.env,
    adapters,
    logger: createLogger({ filePath: join(home.home, "test-supervisor.jsonl") }),
  };

  return {
    home,
    store,
    deps,
    cleanup: (): void => {
      store.close();
      home.cleanup();
    },
  };
}

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true, taskCount: 0 }), { status: 200 });
}

function statusResponse(status: number): Response {
  return new Response(JSON.stringify({ ok: false, taskCount: 0 }), { status });
}

function invalidBodyResponse(): Response {
  return new Response("not-json", { status: 200 });
}

function timeoutError(): Error {
  const error = new Error("timeout");
  error.name = "TimeoutError";
  return error;
}

function bridgeOk(): BridgeIdentityResult {
  return { ok: true, sessionCount: 0 };
}

function bridgeFailure(failure: BridgeIdentityFailure): BridgeIdentityResult {
  return { ok: false, failure };
}

function timeoutBridgeFailure(): BridgeIdentityResult {
  return bridgeFailure({
    kind: "timeout",
    detail: "identity request timed out",
    suspectPortHijack: false,
  });
}

function hardBridgeFailure(): BridgeIdentityResult {
  return bridgeFailure({
    kind: "http",
    detail: "status=404",
    status: 404,
    suspectPortHijack: true,
  });
}

function nonsuspectBridgeFailure(): BridgeIdentityResult {
  return bridgeFailure({
    kind: "http",
    detail: "status=500",
    status: 500,
    suspectPortHijack: false,
  });
}

function codexBridgeProbe(results: BridgeIdentityResult[]): BridgewatchProbeFn {
  let index = 0;
  return async (provider: Provider): Promise<BridgeIdentityResult> => {
    if (provider !== "codex") {
      return bridgeOk();
    }
    const result = results[index] ?? results[results.length - 1];
    index += 1;
    if (result === undefined) {
      throw new Error("bridge probe result が未設定です");
    }
    return result;
  };
}

function createSubject(
  factories: FetchFactory[],
  nowFn: WebwatchNowFn = () => 0,
  bridgeProbeFn: BridgewatchProbeFn = async () => ({ ok: true, sessionCount: 0 }),
  options: SubjectOptions = {},
): WebwatchSubject {
  const fetchCalls: FetchCall[] = [];
  const execCalls: ExecCall[] = [];
  const notifyCalls: NotifyCall[] = [];
  const killCalls: KillCall[] = [];
  const autohealNotifyCalls: AutohealNotifyCall[] = [];
  let fetchIndex = 0;

  const fetchFn: WebwatchFetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    fetchCalls.push({ url, init });
    const factory = factories[fetchIndex] ?? factories[factories.length - 1];
    fetchIndex += 1;
    if (factory === undefined) {
      throw new Error("fetch factory が未設定です");
    }
    return await factory();
  };

  const execFn: WebwatchExecFn = (command: string, args: readonly string[]) => {
    execCalls.push({ command, args: [...args] });
    return { status: 0 };
  };

  const notifyFn: BridgewatchNotifyFn = (deps, alert) => {
    void deps;
    notifyCalls.push({ provider: alert.provider, consecutiveFailures: alert.consecutiveFailures });
    return Promise.resolve({ attempted: true, sent: true });
  };

  const killPidFn: WebwatchKillPidFn = async (pid: number, signal: "SIGTERM"): Promise<void> => {
    killCalls.push({ pid, signal });
    await options.killPidFn?.(pid, signal);
  };

  const autohealNotifyFn: BridgewatchAutohealNotifyFn = (deps, alert) => {
    void deps;
    autohealNotifyCalls.push({
      provider: alert.provider,
      port: alert.port,
      pid: alert.pid,
      command: alert.command,
    });
    return options.autohealNotifyFn?.(deps, alert) ?? Promise.resolve({ attempted: true, sent: true });
  };

  return {
    stage: createWebwatchStage({
      fetchFn,
      execFn,
      nowFn,
      bridgeProbeFn,
      notifyFn,
      listPortListenersFn: options.listPortListenersFn ?? (() => []),
      killPidFn,
      autohealNotifyFn,
    }),
    fetchCalls,
    execCalls,
    notifyCalls,
    killCalls,
    autohealNotifyCalls,
  };
}

function hijackListeners(port: number, specificPid = 200): WebwatchPortListener[] {
  return [
    { pid: 100, command: "even-terminal", name: `TCP *:${port} (LISTEN)` },
    { pid: specificPid, command: "workerd --secret-token", name: `TCP 127.0.0.1:${port} (LISTEN)` },
  ];
}

function expectedLaunchdTarget(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("このテストには process.getuid が必要です");
  }
  return `gui/${uid}/com.hachi-kanban.web`;
}

describe("webwatchStage", () => {
  let harness: LocalHarness | null = null;

  beforeEach(() => {
    harness = setupLocalHarness();
  });

  afterEach(() => {
    harness?.cleanup();
    harness = null;
  });

  it("2 tick 連続失敗で launchctl kickstart を実行する", async () => {
    const subject = createSubject([() => statusResponse(503), () => statusResponse(503)]);

    const first = await subject.stage.tick(harness!.deps, true, 0);
    const second = await subject.stage.tick(harness!.deps, true, 0);

    expect(first.actions).toBe(0);
    expect(second.actions).toBe(1);
    expect(subject.fetchCalls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:9131/healthz",
      "http://127.0.0.1:9131/healthz",
    ]);
    expect(subject.execCalls).toEqual([
      {
        command: "launchctl",
        args: ["kickstart", "-k", expectedLaunchdTarget()],
      },
    ]);
    expect(second.notes?.some((note) => note.includes("non-2xx"))).toBe(true);
  });

  it("bridge identity のハード失敗が2 tick 連続すると通知し、外部プロセス kill はしない", async () => {
    const bridgeProbeFn = codexBridgeProbe([
      hardBridgeFailure(),
      hardBridgeFailure(),
      hardBridgeFailure(),
    ]);
    const subject = createSubject(
      [() => okResponse(), () => okResponse(), () => okResponse()],
      () => 0,
      bridgeProbeFn,
    );

    const first = await subject.stage.tick(harness!.deps, true, 0);
    const second = await subject.stage.tick(harness!.deps, true, 0);
    const third = await subject.stage.tick(harness!.deps, true, 0);

    expect(first.actions).toBe(0);
    expect(second.actions).toBe(1);
    expect(third.actions).toBe(0);
    expect(subject.execCalls).toHaveLength(0);
    expect(subject.killCalls).toHaveLength(0);
    expect(subject.notifyCalls).toEqual([{ provider: "codex", consecutiveFailures: 2 }]);
    expect(second.notes?.some((note) => note.includes("port-hijack-suspected"))).toBe(true);
  });

  it("乗っ取り signature では specific-bind PID だけ SIGTERM し、回復後に bridge_autoheal と通知を記録する", async () => {
    harness!.deps.env.bridges.codex.url = "http://127.0.0.1:3456";
    const task = harness!.store.createTask(taskInput({ status: "ready", title: "進行中" }), "tester");
    harness!.store.block(task.id, "codex-in-progress: sess-autoheal", "supervisor");
    const bridgeProbeFn = codexBridgeProbe([hardBridgeFailure(), hardBridgeFailure(), bridgeOk()]);
    const subject = createSubject([() => okResponse(), () => okResponse()], () => 0, bridgeProbeFn, {
      listPortListenersFn: (port) => hijackListeners(port),
    });

    const first = await subject.stage.tick(harness!.deps, true, 0);
    const second = await subject.stage.tick(harness!.deps, true, 0);

    expect(first.actions).toBe(0);
    expect(second.actions).toBe(1);
    expect(subject.killCalls).toEqual([{ pid: 200, signal: "SIGTERM" }]);
    expect(subject.autohealNotifyCalls).toEqual([{ provider: "codex", port: 3456, pid: 200, command: "workerd" }]);
    expect(subject.notifyCalls).toHaveLength(0);
    const events = harness!.store.listEvents(task.id, "bridge_autoheal");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({
      provider: "codex",
      port: 3456,
      killedPid: 200,
      command: "workerd",
    });
    expect(second.notes?.some((note) => note.includes("bridge autoheal recovered"))).toBe(true);
  });

  it("wildcard bind が無い場合は bridge 死亡扱いで auto-heal しない", async () => {
    harness!.deps.env.bridges.codex.url = "http://127.0.0.1:3456";
    const bridgeProbeFn = codexBridgeProbe([hardBridgeFailure(), hardBridgeFailure()]);
    const subject = createSubject([() => okResponse(), () => okResponse()], () => 0, bridgeProbeFn, {
      listPortListenersFn: () => [
        { pid: 200, command: "workerd", name: "TCP 127.0.0.1:3456 (LISTEN)" },
      ],
    });

    await subject.stage.tick(harness!.deps, true, 0);
    const result = await subject.stage.tick(harness!.deps, true, 0);

    expect(result.actions).toBe(1);
    expect(subject.killCalls).toHaveLength(0);
    expect(subject.notifyCalls).toEqual([{ provider: "codex", consecutiveFailures: 2 }]);
    expect(result.notes?.some((note) => note.includes("wildcard listener missing"))).toBe(true);
  });

  it("suspectPortHijack=false の identity 失敗では auto-heal しない", async () => {
    harness!.deps.env.bridges.codex.url = "http://127.0.0.1:3456";
    const bridgeProbeFn = codexBridgeProbe([nonsuspectBridgeFailure(), nonsuspectBridgeFailure()]);
    const subject = createSubject([() => okResponse(), () => okResponse()], () => 0, bridgeProbeFn, {
      listPortListenersFn: () => {
        throw new Error("listener lookup should not be called");
      },
    });

    await subject.stage.tick(harness!.deps, true, 0);
    await subject.stage.tick(harness!.deps, true, 0);

    expect(subject.killCalls).toHaveLength(0);
    expect(subject.notifyCalls).toEqual([{ provider: "codex", consecutiveFailures: 2 }]);
  });

  it("webwatch-autoheal.disabled がある場合は auto-heal しない", async () => {
    harness!.deps.env.bridges.codex.url = "http://127.0.0.1:3456";
    writeFileSync(join(harness!.home.home, "webwatch-autoheal.disabled"), "", { mode: 0o600 });
    const bridgeProbeFn = codexBridgeProbe([hardBridgeFailure(), hardBridgeFailure()]);
    const subject = createSubject([() => okResponse(), () => okResponse()], () => 0, bridgeProbeFn, {
      listPortListenersFn: () => {
        throw new Error("listener lookup should not be called");
      },
    });

    await subject.stage.tick(harness!.deps, true, 0);
    const result = await subject.stage.tick(harness!.deps, true, 0);

    expect(subject.killCalls).toHaveLength(0);
    expect(subject.notifyCalls).toEqual([{ provider: "codex", consecutiveFailures: 2 }]);
    expect(result.notes?.some((note) => note.includes("kill-switch"))).toBe(true);
  });

  it("同一 PID は再 kill しない", async () => {
    harness!.deps.env.bridges.codex.url = "http://127.0.0.1:3456";
    const bridgeProbeFn = codexBridgeProbe([
      hardBridgeFailure(),
      hardBridgeFailure(),
      hardBridgeFailure(),
      hardBridgeFailure(),
    ]);
    const subject = createSubject(
      [() => okResponse(), () => okResponse(), () => okResponse()],
      () => 0,
      bridgeProbeFn,
      {
        listPortListenersFn: (port) => hijackListeners(port),
      },
    );

    await subject.stage.tick(harness!.deps, true, 0);
    await subject.stage.tick(harness!.deps, true, 0);
    const third = await subject.stage.tick(harness!.deps, true, 0);

    expect(subject.killCalls).toEqual([{ pid: 200, signal: "SIGTERM" }]);
    expect(subject.notifyCalls).toEqual([{ provider: "codex", consecutiveFailures: 2 }]);
    expect(third.notes?.some((note) => note.includes("pid already killed"))).toBe(true);
  });

  it("kill しても回復しなければ通常の identity 警告へ倒す", async () => {
    harness!.deps.env.bridges.codex.url = "http://127.0.0.1:3456";
    const bridgeProbeFn = codexBridgeProbe([hardBridgeFailure(), hardBridgeFailure(), hardBridgeFailure()]);
    const subject = createSubject([() => okResponse(), () => okResponse()], () => 0, bridgeProbeFn, {
      listPortListenersFn: (port) => hijackListeners(port),
    });

    await subject.stage.tick(harness!.deps, true, 0);
    const result = await subject.stage.tick(harness!.deps, true, 0);

    expect(subject.killCalls).toEqual([{ pid: 200, signal: "SIGTERM" }]);
    expect(subject.autohealNotifyCalls).toHaveLength(0);
    expect(subject.notifyCalls).toEqual([{ provider: "codex", consecutiveFailures: 2 }]);
    expect(result.notes?.some((note) => note.includes("bridge autoheal unrecovered"))).toBe(true);
  });

  it("bridge identity の timeout は3 tick 連続失敗では通知しない", async () => {
    const bridgeProbeFn = codexBridgeProbe([
      timeoutBridgeFailure(),
      timeoutBridgeFailure(),
      timeoutBridgeFailure(),
    ]);
    const subject = createSubject(
      [() => okResponse(), () => okResponse(), () => okResponse()],
      () => 0,
      bridgeProbeFn,
    );

    const first = await subject.stage.tick(harness!.deps, true, 0);
    const second = await subject.stage.tick(harness!.deps, true, 0);
    const third = await subject.stage.tick(harness!.deps, true, 0);

    expect(first.actions).toBe(0);
    expect(second.actions).toBe(0);
    expect(third.actions).toBe(0);
    expect(subject.notifyCalls).toHaveLength(0);
  });

  it("bridge identity の timeout は4 tick 連続失敗で通知する", async () => {
    const bridgeProbeFn = codexBridgeProbe([
      timeoutBridgeFailure(),
      timeoutBridgeFailure(),
      timeoutBridgeFailure(),
      timeoutBridgeFailure(),
      timeoutBridgeFailure(),
    ]);
    const subject = createSubject(
      [
        () => okResponse(),
        () => okResponse(),
        () => okResponse(),
        () => okResponse(),
        () => okResponse(),
      ],
      () => 0,
      bridgeProbeFn,
    );

    const first = await subject.stage.tick(harness!.deps, true, 0);
    const second = await subject.stage.tick(harness!.deps, true, 0);
    const third = await subject.stage.tick(harness!.deps, true, 0);
    const fourth = await subject.stage.tick(harness!.deps, true, 0);
    const fifth = await subject.stage.tick(harness!.deps, true, 0);

    expect(first.actions).toBe(0);
    expect(second.actions).toBe(0);
    expect(third.actions).toBe(0);
    expect(fourth.actions).toBe(1);
    expect(fifth.actions).toBe(0);
    expect(subject.notifyCalls).toEqual([{ provider: "codex", consecutiveFailures: 4 }]);
  });

  it("bridge identity が回復すると timeout 失敗カウンタをリセットする", async () => {
    const bridgeProbeFn = codexBridgeProbe([
      timeoutBridgeFailure(),
      timeoutBridgeFailure(),
      timeoutBridgeFailure(),
      bridgeOk(),
      timeoutBridgeFailure(),
      timeoutBridgeFailure(),
      timeoutBridgeFailure(),
    ]);
    const subject = createSubject(
      [
        () => okResponse(),
        () => okResponse(),
        () => okResponse(),
        () => okResponse(),
        () => okResponse(),
        () => okResponse(),
        () => okResponse(),
      ],
      () => 0,
      bridgeProbeFn,
    );

    await subject.stage.tick(harness!.deps, true, 0);
    await subject.stage.tick(harness!.deps, true, 0);
    await subject.stage.tick(harness!.deps, true, 0);
    const recovered = await subject.stage.tick(harness!.deps, true, 0);
    const firstFailureAfterRecovery = await subject.stage.tick(harness!.deps, true, 0);
    const secondFailureAfterRecovery = await subject.stage.tick(harness!.deps, true, 0);
    const thirdFailureAfterRecovery = await subject.stage.tick(harness!.deps, true, 0);

    expect(recovered.notes?.some((note) => note.includes("bridge identity recovered"))).toBe(true);
    expect(firstFailureAfterRecovery.actions).toBe(0);
    expect(secondFailureAfterRecovery.actions).toBe(0);
    expect(thirdFailureAfterRecovery.actions).toBe(0);
    expect(subject.notifyCalls).toHaveLength(0);
  });

  it("bridge identity probe が throw しても webwatch stage は fail-open で継続する", async () => {
    const bridgeProbeFn: BridgewatchProbeFn = async () => {
      throw new Error("probe failed");
    };
    const subject = createSubject([() => okResponse()], () => 0, bridgeProbeFn);

    const result = await subject.stage.tick(harness!.deps, true, 0);

    expect(result.actions).toBe(0);
    expect(subject.execCalls).toHaveLength(0);
    expect(subject.notifyCalls).toHaveLength(0);
    expect(result.notes?.some((note) => note.includes("bridge identity failure"))).toBe(true);
  });

  it("apply=false では kickstart 予定を notes に記録し execFn は呼ばない", async () => {
    const subject = createSubject([
      () => {
        throw new Error("ECONNREFUSED");
      },
      () => {
        throw new Error("ECONNREFUSED");
      },
    ]);

    await subject.stage.tick(harness!.deps, false, 0);
    const result = await subject.stage.tick(harness!.deps, false, 0);

    expect(result.actions).toBe(0);
    expect(subject.execCalls).toHaveLength(0);
    expect(result.notes?.some((note) => note.includes("network error"))).toBe(true);
    expect(result.notes?.some((note) => note.includes("dry-run"))).toBe(true);
    expect(result.notes?.some((note) => note.includes("launchctl kickstart -k"))).toBe(true);
  });

  it("1回失敗だけでは kickstart しない", async () => {
    const subject = createSubject([() => invalidBodyResponse()]);

    const result = await subject.stage.tick(harness!.deps, true, 0);

    expect(result.actions).toBe(0);
    expect(subject.execCalls).toHaveLength(0);
    expect(result.notes?.some((note) => note.includes("invalid body"))).toBe(true);
  });

  it("kickstart 後5分のクールダウン中は再実行を抑制する", async () => {
    let currentMs = 0;
    const subject = createSubject(
      [
        () => {
          throw timeoutError();
        },
        () => {
          throw timeoutError();
        },
        () => {
          throw timeoutError();
        },
      ],
      () => currentMs,
    );

    await subject.stage.tick(harness!.deps, true, 0);
    await subject.stage.tick(harness!.deps, true, 0);
    currentMs = 4 * 60 * 1_000;
    const result = await subject.stage.tick(harness!.deps, true, 0);

    expect(result.actions).toBe(0);
    expect(subject.execCalls).toHaveLength(1);
    expect(result.notes?.some((note) => note.includes("timeout"))).toBe(true);
    expect(result.notes?.some((note) => note.includes("kickstart cooldown"))).toBe(true);
  });

  it("webwatch.disabled がある場合は supervisor の kill-switch で skip される", async () => {
    writeFileSync(join(harness!.home.home, "webwatch.disabled"), "", { mode: 0o600 });
    const supervisor = new Supervisor(harness!.deps, { apply: true });

    const results = await supervisor.runTick();
    const result = results.find((r) => r.name === "webwatch");

    expect(result).toEqual({ name: "webwatch", actions: 0, skipped: true });
  });

  it("healthz が復活すると失敗カウンタをリセットする", async () => {
    const subject = createSubject([
      () => statusResponse(503),
      () => okResponse(),
      () => statusResponse(503),
      () => statusResponse(503),
    ]);

    await subject.stage.tick(harness!.deps, true, 0);
    const recovered = await subject.stage.tick(harness!.deps, true, 0);
    const firstFailureAfterRecovery = await subject.stage.tick(harness!.deps, true, 0);
    const secondFailureAfterRecovery = await subject.stage.tick(harness!.deps, true, 0);

    expect(recovered.notes?.some((note) => note.includes("healthz recovered"))).toBe(true);
    expect(firstFailureAfterRecovery.actions).toBe(0);
    expect(secondFailureAfterRecovery.actions).toBe(1);
    expect(subject.execCalls).toHaveLength(1);
  });
});
