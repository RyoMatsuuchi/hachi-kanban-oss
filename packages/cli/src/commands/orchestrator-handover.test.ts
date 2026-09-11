// =============================================================================
// orchestrator handover の focused tests。
// dry-run: 副作用ゼロ・UUID 一致・プロンプト最小限・事前検査独立報告を検証する。
// --apply: tmux 起動・ロールバック・生存確認を注入 fake で検証する。
//
// M3h（本ファイル書き換え）以降:
// - tmux argv に直接プロンプトを載せる新設計（paste-buffer / send-keys を廃止）。
//   dry-run と --apply の実 argv は「完全一致」する（末尾要素も含めた配列全体）。
// - M3i では transcript の nonce 一致送達ゲート、cwd trust、argv byte 上限、
//   handoff-cancel 回復経路を追加する。brief ファイル方式は使わない。
// =============================================================================

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  ORCHESTRATOR_SESSION_STALE_SECONDS,
  type OrchestratorRow,
  type OrchestratorSessionRow,
  type OrchestratorSuccessorLaunchRow,
} from "@hachi/core";
import type {
  SuccessorLaunchRuntimeReadback,
  SuccessorTmuxReadbackResult,
  TmuxLauncher,
} from "../deps.js";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";
import { TMUX_COMMAND_MAX_BYTES } from "./orchestrator.js";

let fakeRuntimeCwd = process.cwd();

interface RegisterOutput {
  id: string;
  orchestrator: OrchestratorRow;
  session: OrchestratorSessionRow;
}

interface ResolutionCandidate {
  orchestratorId: string;
  label: string;
  project: string;
  sessionId: string;
  generation: number;
  sessionStatus: OrchestratorSessionRow["status"];
  heartbeatAgeSec: number;
  missionTaskId?: string;
  missionTitle?: string;
  command: string;
}

interface HandoverResolutionOutput {
  status: "resolved" | "ambiguous" | "none";
  reason: string;
  candidates: ResolutionCandidate[];
}

interface HandoverJsonOutput {
  resolution: HandoverResolutionOutput;
  successorSessionId: string;
  startupPrompt: string;
  tmuxCommandLine: string;
  tmuxArgs: string[];
  tmuxCommandBytes: number;
  tmuxCommandMaxBytes: number;
  handoffPreparePreview: {
    sessionId: string;
    generation: number;
    orchestratorRequestCount: number;
    runtimeCleanupClaimCount: number;
  };
  missionState: {
    taskId: string;
    title: string;
    status: string;
    descendantStatusCounts: Record<string, number>;
    descendantTotal: number;
  };
  preflight: Array<{
    name: string;
    ok: boolean;
    reason?: string;
    cwdSource?: "mission-cwd" | "repo-root-fallback";
  }>;
  blocked: boolean;
  blockReasons: string[];
  // --apply 固有
  applied?: boolean;
  failReason?: string;
  rolledBack?: boolean;
  tmuxSessionName?: string;
  attachCommand?: string;
  panePid?: number | null;
  processGroupId?: number | null;
  slotId?: string;
  slotStatus?: string;
  boardSuccessorSessionId?: string;
  successorGeneration?: number;
  successorHeartbeat?: {
    confirmed: boolean;
    baselineAt: number;
    observedAt: number | null;
    timeoutMs: number;
    warning?: string;
    recoveryCommand?: string;
  };
  liveness?: {
    status: "confirmed" | "lost";
    checkedAt: string;
    detail: {
      tmuxSession: boolean;
      process: boolean;
      transcriptGrew: boolean;
      boardSession: boolean;
      heartbeatAdvanced: boolean;
    };
  };
  warnings?: string[];
  recovery?: boolean;
  launchError?: string;
  cancelError?: string;
  verifyError?: string;
  delivery?:
    | { status: "confirmed"; confirmedVia: "transcript" | "session-accepted" }
    | { status: "unknown"; reason: string };
  tokenDisposition?: "possibly-consumed";
  retryPolicy?: "new-token-required";
  recoveryCommand?: string;
  recoveryGuidance?: string;
  maxAttempts?: number;
  attemptsExhausted?: boolean;
  attempts?: Array<{
    attempt: number;
    slotId: string;
    successorSessionId: string;
    slotStatus: string;
    failureReason: string | null;
    durationMs: number;
  }>;
  retryInstruction?: "rerun-with-new-token" | "retry-budget-exhausted" | "do-not-retry";
  retryGuidance?: string;
}

interface LivenessScenarioOptions {
  tmuxSession: boolean;
  process: boolean;
  transcriptGrew: boolean;
  boardSession: boolean;
}

/** shellQuote が出力する POSIX argv を、実行せずにテスト用の argv へ戻す。 */
function parsePosixArgv(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (character === "\\" && index + 1 < command.length) {
        index += 1;
        current += command[index]!;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (character === "\\") {
      if (index + 1 >= command.length) {
        throw new Error("POSIX command の末尾に escape があります");
      }
      index += 1;
      current += command[index]!;
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
    } else {
      current += character;
      tokenStarted = true;
    }
  }

  if (quote !== null) {
    throw new Error("POSIX command に閉じていない quote があります");
  }
  if (tokenStarted) {
    args.push(current);
  }
  return args;
}

/**
 * 新設計（M3h）の共通デフォルト実装。TmuxLauncher から capturePane/sendKeys は削除されており、
 * fake はもっと薄い（launch → hasSession → getPaneRootPid までの起動確認 + 所有権 nonce の
 * 記憶のみ）。argv に直接プロンプトが載る前提のため、貼り付け系の fake は要らない。
 * - getProcessGroupId は 1、isProcessGroupAlive は false（＝停止確認は即座に完了する）
 * - setSessionOwnerNonce / getSessionOwnerNonce は直近に set された nonce を記憶して返す
 */
function createBaseLauncherFake(): Pick<
  TmuxLauncher,
  "getProcessGroupId" | "isProcessGroupAlive" | "setSessionOwnerNonce" | "getSessionOwnerNonce" |
  "readSuccessorRuntime" | "releaseSuccessorBarrier" | "isPaneProcessAlive"
> {
  let ownerNonce: string | null = null;
  return {
    getProcessGroupId: () => 1,
    isProcessGroupAlive: () => false,
    setSessionOwnerNonce: (_name: string, nonce: string) => {
      ownerNonce = nonce;
      return true;
    },
    getSessionOwnerNonce: () => ownerNonce,
    readSuccessorRuntime: (sessionName: string) => ({
      stable: true,
      tmuxSession: sessionName,
      tmuxPane: "%1",
      panePid: process.pid,
      processGroupId: 1,
      cwd: fakeRuntimeCwd,
      ownerNonce,
    }),
    releaseSuccessorBarrier: () => true,
    isPaneProcessAlive: () => false,
  };
}

/**
 * 成功する TmuxLauncher のスタブ（launch → session あり → PID 生存）。
 */
function createSuccessLauncher(): TmuxLauncher & {
  launchArgsCalls: string[][];
  killSessionCalls: string[];
} {
  const launchArgsCalls: string[][] = [];
  const killSessionCalls: string[] = [];
  return {
    ...createBaseLauncherFake(),
    launchArgsCalls,
    killSessionCalls,
    launch: (args: string[]) => {
      launchArgsCalls.push(args);
      return { ok: true, pid: 12345 };
    },
    hasSession: () => true,
    getPaneRootPid: () => 12345,
    killSession: (sessionName: string) => {
      killSessionCalls.push(sessionName);
      return true;
    },
  };
}

/**
 * delivery timeout 後の exact rollback と次の launch を、実 tmux なしで順に模擬する。
 * launch ごとに session/owner 状態を初期化し、kill 後は三点すべて消滅したと観測させる。
 */
function createRetryableDeliveryLauncher(): TmuxLauncher & {
  launchArgsCalls: string[][];
  killSessionCalls: string[];
} {
  const launchArgsCalls: string[][] = [];
  const killSessionCalls: string[] = [];
  const panePid = process.pid;
  const processGroupId = 1;
  let sessionName: string | null = null;
  let ownerNonce: string | null = null;
  let killed = false;
  return {
    launchArgsCalls,
    killSessionCalls,
    launch: (args: string[]) => {
      launchArgsCalls.push(args);
      const sessionFlag = args.indexOf("-s");
      sessionName = sessionFlag < 0 ? null : args[sessionFlag + 1] ?? null;
      ownerNonce = null;
      killed = false;
      return { ok: true, pid: panePid };
    },
    hasSession: (name: string) => !killed && sessionName === name,
    getPaneRootPid: () => panePid,
    killSession: (name: string) => {
      killSessionCalls.push(name);
      killed = true;
      return true;
    },
    getProcessGroupId: () => processGroupId,
    isProcessGroupAlive: (pgid: number) => !killed && pgid === processGroupId,
    setSessionOwnerNonce: (name: string, nonce: string) => {
      if (name !== sessionName) return false;
      ownerNonce = nonce;
      return true;
    },
    getSessionOwnerNonce: (name: string) => name === sessionName ? ownerNonce : null,
    readSuccessorRuntime: (name: string) => ({
      stable: name === sessionName,
      tmuxSession: name === sessionName ? name : null,
      tmuxPane: name === sessionName ? "%1" : null,
      panePid: name === sessionName ? panePid : null,
      processGroupId: name === sessionName ? processGroupId : null,
      cwd: name === sessionName ? fakeRuntimeCwd : null,
      ownerNonce: name === sessionName ? ownerNonce : null,
    }),
    releaseSuccessorBarrier: () => true,
    isPaneProcessAlive: (pid: number) => !killed && pid === panePid,
  };
}

/**
 * launch が失敗する TmuxLauncher のスタブ。
 * launch 自体が {ok:false} を返すため、新仕様では所有権 nonce を一切持たず kill も試みない。
 */
function createLaunchFailLauncher(reason: string): TmuxLauncher & { killSessionCalls: string[] } {
  const killSessionCalls: string[] = [];
  return {
    ...createBaseLauncherFake(),
    killSessionCalls,
    launch: () => ({ ok: false, reason }),
    hasSession: () => false,
    getPaneRootPid: () => null,
    killSession: (sessionName: string) => {
      killSessionCalls.push(sessionName);
      return true;
    },
  };
}

/** launch は成功するが session が存在しない TmuxLauncher のスタブ。kill 後は停止確認できる */
function createNoSessionLauncher(): TmuxLauncher {
  return {
    ...createBaseLauncherFake(),
    launch: () => ({ ok: true, pid: 12345 }),
    hasSession: () => false,
    getPaneRootPid: () => null,
    readSuccessorRuntime: () => ({
      stable: false,
      tmuxSession: null,
      tmuxPane: null,
      panePid: null,
      processGroupId: null,
      cwd: null,
      ownerNonce: null,
    }),
    killSession: () => true,
  };
}

/**
 * launch と session は成功するが PID が取得できない TmuxLauncher のスタブ。
 * hasSession は「起動確認時は true、kill 後は false」の状態遷移を模す。
 */
function createNoPidLauncher(): TmuxLauncher {
  let killed = false;
  return {
    ...createBaseLauncherFake(),
    launch: () => ({ ok: true, pid: 12345 }),
    hasSession: () => !killed,
    getPaneRootPid: () => null,
    readSuccessorRuntime: () => ({
      stable: false,
      tmuxSession: null,
      tmuxPane: null,
      panePid: null,
      processGroupId: null,
      cwd: null,
      ownerNonce: null,
    }),
    killSession: () => {
      killed = true;
      return true;
    },
  };
}

/**
 * launch は成功するが起動確認（PID 生存）で必ず失敗する TmuxLauncher のスタブ。
 * process group が「最初の stableAfterCalls-1 回は生存・以降は消滅」という遅延停止を模す。
 */
function createDelayedGroupStopLauncher(stableAfterCalls: number): TmuxLauncher & {
  killSessionCalls: string[];
  isProcessGroupAliveCallCount: number;
} {
  const killSessionCalls: string[] = [];
  let killed = false;
  const state = { isProcessGroupAliveCallCount: 0 };
  return {
    ...createBaseLauncherFake(),
    killSessionCalls,
    get isProcessGroupAliveCallCount(): number {
      return state.isProcessGroupAliveCallCount;
    },
    launch: () => ({ ok: true, pid: 12345 }),
    hasSession: () => !killed,
    // 実在しない PID を返し、起動確認（isProcessAlive）を確実に失敗させて補償フローへ入れる
    getPaneRootPid: () => 999_999_999,
    getProcessGroupId: () => 555,
    isProcessGroupAlive: () => {
      state.isProcessGroupAliveCallCount += 1;
      return state.isProcessGroupAliveCallCount < stableAfterCalls;
    },
    killSession: (sessionName: string) => {
      killed = true;
      killSessionCalls.push(sessionName);
      return true;
    },
  };
}

/**
 * launch は成功するが起動確認で必ず失敗し、process group が停止確認 timeout 以内に
 * 一切消滅しない TmuxLauncher のスタブ。
 */
function createNeverStoppingGroupLauncher(): TmuxLauncher & { killSessionCalls: string[] } {
  const killSessionCalls: string[] = [];
  return {
    ...createBaseLauncherFake(),
    killSessionCalls,
    launch: () => ({ ok: true, pid: 12345 }),
    hasSession: () => true,
    getPaneRootPid: () => 999_999_999,
    getProcessGroupId: () => 555,
    isProcessGroupAlive: () => true,
    killSession: (sessionName: string) => {
      killSessionCalls.push(sessionName);
      return true;
    },
  };
}

/**
 * launch・setSessionOwnerNonce は成功するが、getSessionOwnerNonce が常に別値を返す TmuxLauncher。
 * TOCTOU で別プロセスが同名 session を奪取した状況を模す。起動確認は失敗させて補償フローへ入れる。
 */
function createHijackedOwnershipLauncher(): TmuxLauncher & { killSessionCalls: string[] } {
  const killSessionCalls: string[] = [];
  let issuedOwnerNonce: string | null = null;
  return {
    getProcessGroupId: () => 1,
    isProcessGroupAlive: () => false,
    setSessionOwnerNonce: (_name: string, nonce: string) => {
      issuedOwnerNonce = nonce;
      return true;
    },
    getSessionOwnerNonce: () => "someone-elses-nonce",
    readSuccessorRuntime: (sessionName: string) => ({
      stable: true,
      tmuxSession: sessionName,
      tmuxPane: "%1",
      panePid: process.pid,
      processGroupId: 1,
      cwd: fakeRuntimeCwd,
      ownerNonce: issuedOwnerNonce,
    }),
    releaseSuccessorBarrier: () => true,
    isPaneProcessAlive: () => false,
    killSessionCalls,
    launch: () => ({ ok: true, pid: 12345 }),
    hasSession: () => true,
    getPaneRootPid: () => null,
    killSession: (sessionName: string) => {
      killSessionCalls.push(sessionName);
      return true;
    },
  };
}

describe("hachi orchestrator handover", () => {
  let ctx: TestDeps;
  let successorReadbackTransform: (
    call: number,
    result: SuccessorTmuxReadbackResult,
  ) => SuccessorTmuxReadbackResult = (_call, result) => result;
  // ミッション既定 cwd は実在するディレクトリでなければ cwd-usable preflight で落ちる。
  // テスト全体で使い回せる 1 つの実 tmp ディレクトリを用意しておく。
  const sharedTmpCwd = mkdtempSync(join(tmpdir(), "hachi-handover-mission-"));
  let livenessScenarioSequence = 0;

  afterEach(() => {
    vi.useRealTimers();
    ctx.cleanup();
    successorReadbackTransform = (_call, result) => result;
  });

  afterAll(() => {
    rmSync(sharedTmpCwd, { recursive: true, force: true });
  });

  /** ready 状態のタスクを指定ステータスまで段階的に遷移させる */
  function transitionTo(taskId: string, target: string): void {
    // ready → blocked → done → archived
    const paths: Record<string, string[]> = {
      blocked: ["blocked"],
      review: ["blocked", "review"],
      "needs-integration": ["blocked", "needs-integration"],
      done: ["blocked", "done"],
      archived: ["blocked", "done", "archived"],
    };
    const steps = paths[target];
    if (steps === undefined) {
      return;
    }
    for (const step of steps) {
      if (step === "blocked") {
        ctx.deps.store.transition({
          taskId,
          to: "blocked",
          reason: "needs-manual: テスト用 block",
          actor: "tester",
        });
      } else {
        ctx.deps.store.transition({ taskId, to: step as "done", actor: "tester" });
      }
    }
  }

  /** テスト用のオーケストレーターを登録し、session/identity を返す。
   *  cwd の実在判定は既定で真にする（実 fs へ触れない）。偽を試すテストは個別に上書きする。 */
  async function register(provider: OrchestratorSessionRow["provider"] = "claude"): Promise<RegisterOutput> {
    ctx.deps.isDirectory ??= () => true;
    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator", "register",
        "--label", "handover-test",
        "--project", "dev",
        "--cwd", process.cwd(),
        ...(provider === "" ? [] : [
          "--provider", provider,
          "--provider-session-id", `${provider}-handover-test-session`,
        ]),
        "--json",
      ],
      { from: "user" },
    );
    const output = JSON.parse(ctx.stdout.text()) as RegisterOutput;
    ctx.stdout.clear();
    return output;
  }

  /** ミッション task と配下タスクを作成する。cwd は実在する tmp ディレクトリを既定にする（cwd-usable preflight を通すため） */
  function createMissionWithChildren(
    orchestratorId: string,
    childStatuses: string[] = [],
  ): string {
    fakeRuntimeCwd = sharedTmpCwd;
    const mission = ctx.deps.store.createTask(
      { title: "ミッション M3", body: `cwd: ${sharedTmpCwd}\n\n本文`, tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(mission.id, orchestratorId, "primary");
    for (const status of childStatuses) {
      // createTask は triage/todo/ready のみ受け付けるため、ready で作成してから段階的に遷移させる
      const child = ctx.deps.store.createTask(
        { title: `子タスク (${status})`, body: "cwd: /tmp/child", tenant: "dev", status: "ready" },
        "tester",
      );
      if (status !== "ready") {
        transitionTo(child.id, status);
      }
      ctx.deps.store.link(mission.id, child.id);
    }
    return mission.id;
  }

  /** handover コマンドを --json で実行して結果を返す */
  async function runHandover(
    sessionId: string,
    generation: number,
    missionId: string,
    extraArgs: string[] = [],
  ): Promise<HandoverJsonOutput> {
    const launcher = ctx.deps.tmuxLauncher;
    if (launcher?.readSuccessorRuntime !== undefined) {
      const originalRead = launcher.readSuccessorRuntime.bind(launcher);
      let latest: SuccessorLaunchRuntimeReadback | null = null;
      let exactReadbackCalls = 0;
      launcher.readSuccessorRuntime = (sessionName: string): SuccessorLaunchRuntimeReadback => {
        latest = originalRead(sessionName);
        return latest;
      };
      const exactReadback = (): SuccessorTmuxReadbackResult => {
        exactReadbackCalls += 1;
        const runtime = latest;
        if (runtime === null || !runtime.stable || runtime.tmuxSession === null ||
            runtime.tmuxPane === null || runtime.panePid === null || runtime.processGroupId === null ||
            runtime.cwd === null || runtime.ownerNonce === null) {
          return successorReadbackTransform(
            exactReadbackCalls,
            { ok: false, reason: "unavailable" },
          );
        }
        return successorReadbackTransform(exactReadbackCalls, {
          ok: true,
          value: {
            tmuxSession: runtime.tmuxSession,
            tmuxPane: runtime.tmuxPane,
            panePid: runtime.panePid,
            processGroupId: runtime.processGroupId,
            cwd: runtime.cwd,
            ownerNonce: runtime.ownerNonce,
            tmuxSocketPath: "/tmp/tmux-handover/default",
            tmuxServerPid: 81_001,
            tmuxServerStartTime: 1_800_000_001,
            tmuxServerLifetimeHash: createHash("sha256").update("handover-server-lifetime").digest("hex"),
          },
        });
      };
      ctx.deps.successorTmuxReadback = {
        readExactPane: exactReadback,
        initializeServerLifetimeAndReadExactPane: exactReadback,
      };
    }
    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator", "handover",
        "--session", sessionId,
        "--generation", String(generation),
        "--mission", missionId,
        "--json",
        ...extraArgs,
      ],
      { from: "user" },
    );
    const output = ctx.stdout.text();
    if (output === "") throw new Error(ctx.stderr.text());
    return JSON.parse(output) as HandoverJsonOutput;
  }

  /** liveness 5点を実 tmux/process なしで個別に制御する fixture。 */
  async function prepareLivenessScenario(options: LivenessScenarioOptions): Promise<{
    reg: RegisterOutput;
    missionId: string;
  }> {
    livenessScenarioSequence += 1;
    const suffix = String(livenessScenarioSequence);
    const successorSessionId = `liveness-successor-${suffix}`;
    const launchNonce = `liveness-launch-${suffix}`;
    const projectsRoot = join(sharedTmpCwd, `liveness-projects-${suffix}`);
    const projectDir = join(projectsRoot, "project");
    const transcriptPath = join(projectDir, `${successorSessionId}.jsonl`);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: "user", message: { content: `launch nonce: ${launchNonce}` } }),
        JSON.stringify({ type: "assistant", message: { content: "delivery confirmed" } }),
      ].join("\n") + "\n",
      "utf8",
    );

    let deliveryObserved = false;
    let ownerNonce: string | null = null;
    let runtimeSessionName: string | null = null;
    const panePid = process.pid;
    const processGroupId = 1;
    const exactReadback = (): SuccessorTmuxReadbackResult => {
      if (ownerNonce === null || runtimeSessionName === null) {
        return { ok: false, reason: "unavailable" };
      }
      return {
        ok: true,
        value: {
          tmuxSession: runtimeSessionName,
          tmuxPane: "%1",
          panePid,
          processGroupId,
          cwd: fakeRuntimeCwd,
          ownerNonce,
          tmuxSocketPath: "/tmp/tmux-handover/default",
          tmuxServerPid: 81_001,
          tmuxServerStartTime: 1_800_000_001,
          tmuxServerLifetimeHash: createHash("sha256").update("handover-server-lifetime").digest("hex"),
        },
      };
    };
    const launcher: TmuxLauncher = {
      launch: () => ({ ok: true, pid: panePid }),
      hasSession: () => deliveryObserved ? options.tmuxSession : true,
      getPaneRootPid: () => panePid,
      killSession: () => true,
      getProcessGroupId: () => processGroupId,
      isProcessGroupAlive: () => options.process,
      setSessionOwnerNonce: (_name: string, nonce: string) => {
        ownerNonce = nonce;
        return true;
      },
      getSessionOwnerNonce: () => ownerNonce,
      readSuccessorRuntime: (sessionName: string) => {
        runtimeSessionName = sessionName;
        return {
          stable: true,
          tmuxSession: sessionName,
          tmuxPane: "%1",
          panePid,
          processGroupId,
          cwd: fakeRuntimeCwd,
          ownerNonce,
        };
      },
      releaseSuccessorBarrier: () => true,
      isPaneProcessAlive: () => options.process,
    };
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.tmuxLauncher = launcher;
    ctx.deps.newSessionId = () => successorSessionId;
    ctx.deps.newHandoffLaunchNonce = () => launchNonce;
    ctx.deps.nativeUsageRoots = { claudeProjectsRoot: projectsRoot };
    ctx.deps.handoverDeliveryGateProbe = async () => {
      deliveryObserved = true;
      return { userNonceObserved: true, assistantObserved: true };
    };
    ctx.deps.successorTmuxReadback = {
      readExactPane: exactReadback,
      initializeServerLifetimeAndReadExactPane: exactReadback,
    };
    let nowMs = 1_800_000_000_000;
    let transcriptAppended = false;
    ctx.deps.successorLaunchClock = {
      nowMs: () => nowMs,
      sleep: async () => {
        nowMs += 60_000;
        if (options.transcriptGrew && deliveryObserved && !transcriptAppended) {
          appendFileSync(
            transcriptPath,
            `${JSON.stringify({ type: "assistant", message: { content: "still alive" } })}\n`,
            "utf8",
          );
          transcriptAppended = true;
        }
      },
    };

    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);
    if (!options.boardSession) {
      const getSession = ctx.deps.store.getOrchestratorSession.bind(ctx.deps.store);
      vi.spyOn(ctx.deps.store, "getOrchestratorSession").mockImplementation((sessionId) =>
        sessionId === reg.session.id ? getSession(sessionId) : null,
      );
    }
    return { reg, missionId };
  }

  /** 引数を省略した handover を --json で実行して結果を返す */
  async function runAutoHandover(extraArgs: string[] = []): Promise<HandoverJsonOutput> {
    await buildProgram(ctx.deps).parseAsync(
      ["orchestrator", "handover", "--json", ...extraArgs],
      { from: "user" },
    );
    return JSON.parse(ctx.stdout.text()) as HandoverJsonOutput;
  }

  /** CLI を介さず、テスト用の別 identity/session を追加する */
  function registerIdentity(
    label: string,
    project: string,
    provider: OrchestratorSessionRow["provider"] = "claude",
    repoCommonDir: string = process.cwd(),
  ): RegisterOutput {
    const orchestrator = ctx.deps.store.registerOrchestrator({
      label,
      project,
      repoCommonDir,
    });
    const session = ctx.deps.store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider,
      providerSessionId: `${provider}-${label}-session`,
    });
    return { id: orchestrator.id, orchestrator, session };
  }

  function addSubtreeWatch(orchestratorId: string, taskId: string): void {
    ctx.deps.store.addOrchestratorWatch({
      orchestratorId,
      scope: "subtree",
      selector: taskId,
      role: "primary",
    });
  }

  /** runtime identity を取得できず uncertain になった handoff slot を作る。 */
  function createUncertainHandoverSlot(
    reg: RegisterOutput,
    suffix: string,
  ): OrchestratorSuccessorLaunchRow {
    const now = Math.floor(Date.now() / 1_000);
    const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
    const armed = ctx.deps.store.armSuccessorLaunch({
      orchestratorId: reg.orchestrator.id,
      targetProvider: "claude",
      sourceSessionId: reg.session.id,
      sourceGeneration: reg.session.generation,
      canonicalCwd: sharedTmpCwd,
      hostId: ctx.deps.currentHostId(),
      launchNonceHash: hash(`launch-${suffix}`),
      plannedTmuxSession: `tmux-${suffix}`,
      hookDefinitionHash: hash(`hook-definition-${suffix}`),
      hookExecutableHash: hash(`hook-executable-${suffix}`),
      runtimeDeadlineAt: now + 60,
      attestationDeadlineAt: now + 120,
      kind: "handoff",
      handoffTokenFenceHash: hash(`handoff-${suffix}`),
      handoffExpiresAt: now + 600,
      now,
    });
    const pending = ctx.deps.store.markArmedSuccessorLaunchStopPending({
      slotId: armed.id,
      expectedRevision: armed.revision,
      observedCanonicalCwd: null,
      observedHostId: null,
      tmuxSession: null,
      tmuxPane: null,
      panePid: null,
      processGroupId: null,
      tmuxSocketPath: null,
      tmuxServerPid: null,
      tmuxServerStartTime: null,
      tmuxServerLifetimeHash: null,
      ownerNonceHash: null,
      observedHookDefinitionHash: null,
      observedHookExecutableHash: null,
      error: "runtime identity unavailable",
      now: now + 1,
    });
    return ctx.deps.store.recordSuccessorLaunchStop({
      slotId: armed.id,
      expectedRevision: pending.launch.revision,
      stopFenceHash: hash(pending.stopFence),
      killOwnerReadbackHash: "",
      evidence: {
        ownerMatched: null,
        ownerReadbackAt: null,
        killResult: "unknown",
        tmuxSessionAbsent: null,
        panePidAbsent: null,
        processGroupAbsent: null,
        observedAt: now + 2,
      },
      now: now + 2,
    });
  }

  // ===================================================================
  // board resolution tests
  // ===================================================================

  it("live=0 の stale 候補は identity ごとに最新 session 1件だけを列挙する", async () => {
    ctx = createTestDeps();
    const first = registerIdentity("先頭だが対象外", "first-project");
    ctx.deps.store.closeOrchestratorSession(first.session.id, first.session.generation);
    const staleA = registerIdentity("夜間復旧 A", "project-a");
    const staleB = registerIdentity("夜間復旧 B", "project-b");
    const firstExpiry = Math.max(staleA.session.heartbeatAt, staleB.session.heartbeatAt) + 1;
    ctx.deps.store.expireStaleOrchestratorSessions(firstExpiry, firstExpiry);
    const latestA = ctx.deps.store.startOrchestratorSession({ orchestratorId: staleA.orchestrator.id });
    const secondExpiry = latestA.heartbeatAt + 1;
    ctx.deps.store.expireStaleOrchestratorSessions(secondExpiry, secondExpiry);
    ctx.deps.newHandoffToken = vi.fn(() => "must-not-be-generated");
    ctx.deps.tmuxProbe = {
      available: () => { throw new Error("preflight must not run"); },
      listSessionNames: () => { throw new Error("preflight must not run"); },
    };

    const output = await runAutoHandover();

    expect(output.resolution.status).toBe("none");
    expect(output.resolution.candidates).toHaveLength(2);
    expect(output.resolution.candidates.map((candidate) => candidate.orchestratorId)).toEqual(
      expect.arrayContaining([staleA.orchestrator.id, staleB.orchestrator.id]),
    );
    const candidateA = output.resolution.candidates.find(
      (candidate) => candidate.orchestratorId === staleA.orchestrator.id,
    );
    expect(candidateA).toMatchObject({
      sessionId: latestA.id,
      generation: latestA.generation,
      sessionStatus: "stale",
    });
    for (const candidate of output.resolution.candidates) {
      expect(candidate.label).toMatch(/^夜間復旧/);
      expect(candidate.project).toMatch(/^project-/);
      expect(candidate.heartbeatAgeSec).toBeGreaterThanOrEqual(0);
      expect(candidate.command).toBe(
        `hachi orchestrator session takeover ${candidate.orchestratorId} --stale-sec 90`,
      );
    }
    expect(ctx.deps.newHandoffToken).not.toHaveBeenCalled();
    expect(ctx.exitCodes).toEqual([2]);
  });

  it("live=2 は label/project/session/generation 付きの候補を全件返す", async () => {
    ctx = createTestDeps();
    const first = registerIdentity("担当 A", "project-a");
    const second = registerIdentity("担当 B", "project-b");
    ctx.deps.newHandoffToken = vi.fn(() => "must-not-be-generated");
    ctx.deps.tmuxProbe = {
      available: () => { throw new Error("preflight must not run"); },
      listSessionNames: () => { throw new Error("preflight must not run"); },
    };

    const output = await runAutoHandover(["--apply"]);

    expect(output.resolution.status).toBe("ambiguous");
    expect(output.resolution.candidates).toHaveLength(2);
    expect(output.resolution.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orchestratorId: first.orchestrator.id,
        label: "担当 A",
        project: "project-a",
        sessionId: first.session.id,
        generation: first.session.generation,
        command: `hachi orchestrator handover --session ${first.session.id} --generation ${first.session.generation} --apply`,
      }),
      expect.objectContaining({
        orchestratorId: second.orchestrator.id,
        label: "担当 B",
        project: "project-b",
        sessionId: second.session.id,
        generation: second.session.generation,
        command: `hachi orchestrator handover --session ${second.session.id} --generation ${second.session.generation} --apply`,
      }),
    ]));
    expect(ctx.deps.newHandoffToken).not.toHaveBeenCalled();
    expect(ctx.exitCodes).toEqual([2]);
  });

  it("live=2 でも --orchestrator で先に絞り込めば resolved になる", async () => {
    ctx = createTestDeps();
    ctx.deps.isDirectory = () => true;
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const selected = registerIdentity("選択対象", "selected-project");
    registerIdentity("別対象", "other-project");
    const missionId = createMissionWithChildren(selected.orchestrator.id);
    addSubtreeWatch(selected.orchestrator.id, missionId);

    const output = await runAutoHandover(["--orchestrator", selected.orchestrator.id]);

    expect(output.resolution.status).toBe("resolved");
    expect(output.resolution.candidates).toHaveLength(1);
    expect(output.resolution.candidates[0]).toMatchObject({
      orchestratorId: selected.orchestrator.id,
      label: "選択対象",
      project: "selected-project",
      sessionId: selected.session.id,
      generation: selected.session.generation,
      missionTaskId: missionId,
      missionTitle: "ミッション M3",
    });
    expect(output.missionState.taskId).toBe(missionId);
    expect(ctx.exitCodes).toEqual([]);
  });

  it("--orchestrator は durable slot 検索を指定 identity に限定し、別 identity の uncertain slot を引かない", async () => {
    ctx = createTestDeps();
    ctx.deps.isDirectory = () => true;
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const selected = registerIdentity("durable 検索対象", "selected-project");
    const other = registerIdentity("durable 対象外", "other-project");
    const missionId = createMissionWithChildren(selected.orchestrator.id);
    const otherSlot = createUncertainHandoverSlot(other, "other-uncertain");
    const listLaunches = vi.spyOn(ctx.deps.store, "listSuccessorLaunches");

    const output = await runAutoHandover([
      "--orchestrator", selected.orchestrator.id,
      "--mission", missionId,
    ]);

    expect(listLaunches.mock.calls[0]).toEqual([selected.orchestrator.id]);
    expect(output.recovery).not.toBe(true);
    expect(output.slotId).not.toBe(otherSlot.id);
    expect(output.resolution.status).toBe("resolved");
    expect(output.resolution.candidates[0]).toMatchObject({
      orchestratorId: selected.orchestrator.id,
      sessionId: selected.session.id,
      missionTaskId: missionId,
    });
    expect(ctx.exitCodes).toEqual([]);
  });

  it("--orchestrator の指定 identity に uncertain slot があればその slot を解決する", async () => {
    ctx = createTestDeps();
    const selected = registerIdentity("durable slot owner", "selected-project");
    const other = registerIdentity("other slot owner", "other-project");
    const missionId = createMissionWithChildren(selected.orchestrator.id);
    const otherSlot = createUncertainHandoverSlot(other, "other-existing");
    const selectedSlot = createUncertainHandoverSlot(selected, "selected-existing");

    const output = await runAutoHandover([
      "--orchestrator", selected.orchestrator.id,
      "--mission", missionId,
    ]);

    expect(output).toMatchObject({
      recovery: true,
      slotId: selectedSlot.id,
      slotStatus: "uncertain",
    });
    expect(output.slotId).not.toBe(otherSlot.id);
    expect(output.resolution.candidates[0]).toMatchObject({
      orchestratorId: selected.orchestrator.id,
      sessionId: selected.session.id,
    });
    expect(ctx.exitCodes).toEqual([]);
  });

  it("--session 指定時は従来どおり source session に対応する uncertain slot を解決する", async () => {
    ctx = createTestDeps();
    const selected = registerIdentity("session slot owner", "selected-project");
    const other = registerIdentity("other session owner", "other-project");
    const missionId = createMissionWithChildren(selected.orchestrator.id);
    createUncertainHandoverSlot(other, "session-other");
    const selectedSlot = createUncertainHandoverSlot(selected, "session-selected");

    const output = await runAutoHandover([
      "--session", selected.session.id,
      "--generation", String(selected.session.generation),
      "--mission", missionId,
    ]);

    expect(output).toMatchObject({
      recovery: true,
      slotId: selectedSlot.id,
      slotStatus: "uncertain",
    });
    expect(output.resolution.candidates[0]).toMatchObject({
      orchestratorId: selected.orchestrator.id,
      sessionId: selected.session.id,
    });
    expect(ctx.exitCodes).toEqual([]);
  });

  it("--mission 単独時は従来どおり全 identity の durable slot を検索する", async () => {
    ctx = createTestDeps();
    const missionOwner = registerIdentity("mission owner", "mission-project");
    const slotOwner = registerIdentity("global slot owner", "slot-project");
    const missionId = createMissionWithChildren(missionOwner.orchestrator.id);
    const slot = createUncertainHandoverSlot(slotOwner, "mission-only");
    const listLaunches = vi.spyOn(ctx.deps.store, "listSuccessorLaunches");

    const output = await runAutoHandover(["--mission", missionId]);

    expect(listLaunches.mock.calls[0]).toEqual([]);
    expect(output).toMatchObject({
      recovery: true,
      slotId: slot.id,
      slotStatus: "uncertain",
    });
    expect(output.resolution.candidates[0]).toMatchObject({
      orchestratorId: slotOwner.orchestrator.id,
      sessionId: slotOwner.session.id,
      missionTaskId: missionId,
    });
    expect(ctx.exitCodes).toEqual([]);
  });

  it("active subtree watch が2件なら mission 候補を title 付きで返す", async () => {
    ctx = createTestDeps();
    const reg = registerIdentity("mission owner", "mission-project");
    const firstMission = createMissionWithChildren(reg.orchestrator.id);
    const secondMission = createMissionWithChildren(reg.orchestrator.id);
    addSubtreeWatch(reg.orchestrator.id, firstMission);
    addSubtreeWatch(reg.orchestrator.id, secondMission);
    ctx.deps.newHandoffToken = vi.fn(() => "must-not-be-generated");
    ctx.deps.tmuxProbe = {
      available: () => { throw new Error("preflight must not run"); },
      listSessionNames: () => { throw new Error("preflight must not run"); },
    };

    const output = await runAutoHandover();

    expect(output.resolution.status).toBe("ambiguous");
    expect(output.resolution.candidates).toHaveLength(2);
    expect(output.resolution.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        missionTaskId: firstMission,
        missionTitle: "ミッション M3",
        command: expect.stringContaining(`--mission ${firstMission}`),
      }),
      expect.objectContaining({
        missionTaskId: secondMission,
        missionTitle: "ミッション M3",
        command: expect.stringContaining(`--mission ${secondMission}`),
      }),
    ]));
    expect(ctx.deps.newHandoffToken).not.toHaveBeenCalled();
    expect(ctx.exitCodes).toEqual([2]);
  });

  it("active subtree watch が1件なら mission を採用して resolved になる", async () => {
    ctx = createTestDeps();
    ctx.deps.isDirectory = () => true;
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = registerIdentity("single mission owner", "single-project");
    const missionId = createMissionWithChildren(reg.orchestrator.id);
    addSubtreeWatch(reg.orchestrator.id, missionId);

    const output = await runAutoHandover();

    expect(output.resolution.status).toBe("resolved");
    expect(output.resolution.candidates[0]).toMatchObject({
      missionTaskId: missionId,
      missionTitle: "ミッション M3",
      command: `hachi orchestrator handover --session ${reg.session.id} --generation ${reg.session.generation} --mission ${missionId}`,
    });
    expect(output.missionState.taskId).toBe(missionId);
    expect(ctx.exitCodes).toEqual([]);
  });

  it("active subtree watch が0件なら --mission を促して preflight/token を実行しない", async () => {
    ctx = createTestDeps();
    const reg = registerIdentity("without mission", "empty-project");
    ctx.deps.newHandoffToken = vi.fn(() => "must-not-be-generated");
    ctx.deps.tmuxProbe = {
      available: () => { throw new Error("preflight must not run"); },
      listSessionNames: () => { throw new Error("preflight must not run"); },
    };

    const output = await runAutoHandover();

    expect(output.resolution).toMatchObject({ status: "none", candidates: [] });
    expect(output.resolution.reason).toContain("--mission");
    expect(output.resolution.reason).toContain(reg.orchestrator.id);
    expect(ctx.deps.newHandoffToken).not.toHaveBeenCalled();
    expect(ctx.exitCodes).toEqual([2]);
  });

  it("空白・引用符・$ を含む resolved candidate の command も POSIX argv に戻して再実行できる", async () => {
    ctx = createTestDeps();
    ctx.deps.isDirectory = () => true;
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = registerIdentity("round-trip owner", "round-trip-project");
    const missionId = createMissionWithChildren(reg.orchestrator.id);
    addSubtreeWatch(reg.orchestrator.id, missionId);

    // 実 DB の routing ID 形式は安全文字だけなので、deps の store を差し替えて
    // コマンド候補に空白・$・単一引用を含む識別子を流し込む。
    const unsafeSessionId = "session with spaces $cash and 'quoted'";
    const unsafeSession = { ...reg.session, id: unsafeSessionId };
    const originalListSessions = ctx.deps.store.listOrchestratorSessions.bind(ctx.deps.store);
    vi.spyOn(ctx.deps.store, "listOrchestratorSessions").mockImplementation((orchestratorId) =>
      originalListSessions(orchestratorId).map((session) =>
        session.id === reg.session.id ? unsafeSession : session,
      ),
    );
    const originalGetSession = ctx.deps.store.getOrchestratorSession.bind(ctx.deps.store);
    vi.spyOn(ctx.deps.store, "getOrchestratorSession").mockImplementation((sessionId) =>
      sessionId === unsafeSessionId ? unsafeSession : originalGetSession(sessionId),
    );

    const first = await runAutoHandover();
    const command = first.resolution.candidates[0]!.command;
    expect(command).toContain(`--session '${unsafeSessionId.replace(/'/g, "'\\''")}'`);
    const argv = parsePosixArgv(command);
    expect(argv).toEqual([
      "hachi",
      "orchestrator",
      "handover",
      "--session",
      unsafeSessionId,
      "--generation",
      String(reg.session.generation),
      "--mission",
      missionId,
    ]);
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([...argv.slice(1), "--json"], { from: "user" });
    const second = JSON.parse(ctx.stdout.text()) as HandoverJsonOutput;

    expect(second.resolution.status).toBe("resolved");
    expect(second.resolution.candidates[0]?.command).toBe(command);
    expect(ctx.exitCodes).toEqual([]);
  });

  // ===================================================================
  // dry-run テスト
  // ===================================================================

  it("dry-run は副作用ゼロである（board / session / tmux を変更しない）", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    // 実行前のスナップショット
    const sessionsBefore = ctx.deps.store.listOrchestratorSessions(reg.orchestrator.id);
    const taskBefore = ctx.deps.store.getTask(missionId);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    // 実行後に変化がないことを確認
    const sessionsAfter = ctx.deps.store.listOrchestratorSessions(reg.orchestrator.id);
    const taskAfter = ctx.deps.store.getTask(missionId);
    expect(sessionsAfter).toEqual(sessionsBefore);
    expect(taskAfter).toEqual(taskBefore);
    expect(output.maxAttempts).toBe(3);
    // exit code が設定されていないことを確認
    expect(ctx.exitCodes).toEqual([]);
  });

  it("採番した UUID が起動プロンプトと tmux コマンドラインの両方に同じ値で現れる", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    // UUID が有効な形式であること
    expect(output.successorSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // 起動プロンプトと barrier shell argv に同じ provider session ID が含まれる。
    expect(output.startupPrompt).toContain(output.successorSessionId);
    expect(output.tmuxCommandLine).toContain(output.successorSessionId);
    expect(output.tmuxCommandLine).toContain('exec claude --session-id "$2"');
  });

  it("起動プロンプトに会話履歴や handoff token が含まれない", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    const lines = output.startupPrompt.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe(`ミッション task ID: ${missionId}`);
    expect(lines[1]).toBe(`provider session id: ${output.successorSessionId}`);
    expect(lines[2]).toMatch(/^launch nonce: [0-9a-f-]+$/);
    expect(lines[3]).toBe(
      "Hachi が transcript delivery 確認後に durable handoff final を行う。generic handoff-accept は実行しないこと。",
    );
    expect(lines[4]).toContain("最初のツール呼び出し");
    expect(lines[4]).toContain("playbook を読むのはその後");
    expect(lines[4]).toContain("inbox を消費しない純 heartbeat");
    expect(lines[5]).toBe(
      `hachi orchestrator session bootstrap-heartbeat --provider-session-id ${output.successorSessionId}`,
    );
    expect(lines[6]).toBe("playbook §0.7.4 に従って立ち上げよ");
    expect(Buffer.byteLength(lines.slice(4, 6).join("\n"), "utf8")).toBeLessThanOrEqual(1_000);
    expect(output.startupPrompt).not.toContain("os_");
    expect(output.startupPrompt).not.toContain("session heartbeat");
    expect(output.startupPrompt).not.toContain("handoff token:");
    expect(output.tmuxCommandBytes).toBeLessThanOrEqual(TMUX_COMMAND_MAX_BYTES);
    expect(output.preflight.find((check) => check.name === "tmux-command-size"))
      .toMatchObject({ ok: true });
  });

  it("provider session ID から live session を read-only な shell 代入形式で解決する", async () => {
    ctx = createTestDeps();
    const reg = await register();
    const sessionsBefore = ctx.deps.store.listOrchestratorSessions(reg.orchestrator.id);

    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator", "session", "resolve",
        "--provider-session-id", "claude-handover-test-session",
      ],
      { from: "user" },
    );

    expect(ctx.stdout.text()).toBe(`SID=${reg.session.id}\nGEN=${reg.session.generation}\n`);
    expect(ctx.deps.store.listOrchestratorSessions(reg.orchestrator.id)).toEqual(sessionsBefore);
    expect(ctx.exitCodes).toEqual([]);
  });

  it("bootstrap-heartbeat は live session を解決して detached lifecycle へ渡す", async () => {
    ctx = createTestDeps();
    const reg = await register();
    const bootstrap = vi.fn(async () => ({
      status: "started" as const,
      pid: 4_321,
      processStartedAt: "Sun Aug 31 15:00:00 2026",
      pidfile: "/tmp/heartbeat.pid.json",
      logfile: "/tmp/heartbeat.log",
    }));
    ctx.deps.orchestratorHeartbeatLifecycle = {
      bootstrap,
      stop: vi.fn(),
      runDaemon: vi.fn(),
    };

    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator", "session", "bootstrap-heartbeat",
        "--provider-session-id", reg.session.providerSessionId,
        "--json",
      ],
      { from: "user" },
    );

    expect(bootstrap).toHaveBeenCalledWith(expect.objectContaining({
      providerSessionId: reg.session.providerSessionId,
      sessionId: reg.session.id,
      generation: reg.session.generation,
    }));
    expect(JSON.parse(ctx.stdout.text())).toMatchObject({ heartbeat: { status: "started", pid: 4_321 } });
    expect(ctx.exitCodes).toEqual([]);
  });

  it("stop-heartbeat は provider session ID の lifecycle 停止結果を返す", async () => {
    ctx = createTestDeps();
    const reg = await register();
    const stop = vi.fn(async () => ({
      status: "stopped" as const,
      disappearanceConfirmed: true as const,
      pid: 4_321,
      forced: false,
      pidfile: "/tmp/heartbeat.pid.json",
    }));
    ctx.deps.orchestratorHeartbeatLifecycle = {
      bootstrap: vi.fn(),
      stop,
      runDaemon: vi.fn(),
    };

    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator", "session", "stop-heartbeat",
        "--provider-session-id", reg.session.providerSessionId,
        "--json",
      ],
      { from: "user" },
    );

    expect(stop).toHaveBeenCalledWith({
      home: ctx.deps.env.home,
      providerSessionId: reg.session.providerSessionId,
    });
    expect(JSON.parse(ctx.stdout.text())).toMatchObject({
      heartbeat: { status: "stopped", disappearanceConfirmed: true, pid: 4_321 },
    });
    expect(ctx.exitCodes).toEqual([]);
  });

  it("tmux セッション名が hachi-orch- 接頭辞を持ち worker 用名前空間と衝突しない", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    // tmux コマンドラインからセッション名を抽出
    const sessionNameMatch = output.tmuxCommandLine.match(/-s\s+(hachi-orch-\S+)\s/);
    expect(sessionNameMatch).not.toBeNull();
    const sessionName = sessionNameMatch![1]!;
    expect(sessionName).toMatch(/^hachi-orch-/);
    // orchestrator ID の先頭8文字と UUID の先頭8文字が含まれる
    expect(sessionName).toContain(reg.orchestrator.id.slice(0, 8));
    expect(sessionName).toContain(output.successorSessionId.slice(0, 8));
  });

  it("tmux 不在を独立に報告する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => false, listSessionNames: () => [] };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    const tmuxCheck = output.preflight.find((c) => c.name === "tmux-available");
    expect(tmuxCheck).toMatchObject({ ok: false, reason: "tmux-not-found" });
    expect(output.blocked).toBe(true);
    expect(output.blockReasons).toContain("tmux-not-found");
  });

  it("tmux セッション名衝突を検出して blocked にする", async () => {
    ctx = createTestDeps();
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    // 採番を固定するとセッション名が確定するため、衝突を確実に再現できる。
    const fixedUuid = "11111111-2222-3333-4444-555555555555";
    ctx.deps.newSessionId = () => fixedUuid;
    const collidingName = `hachi-orch-${reg.orchestrator.id.slice(0, 8)}-${fixedUuid}`;
    ctx.deps.tmuxProbe = {
      available: () => true,
      listSessionNames: () => [collidingName],
    };

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    expect(output.successorSessionId).toBe(fixedUuid);
    const nameCheck = output.preflight.find((c) => c.name === "session-name-unique");
    expect(nameCheck?.ok).toBe(false);
    expect(nameCheck?.reason).toContain(`tmux session "${collidingName}" は既に存在します`);
    expect(output.blocked).toBe(true);
    expect(output.blockReasons.join(" ")).toContain(collidingName);
  });

  it("無関係な tmux セッションが在っても衝突扱いにしない", async () => {
    ctx = createTestDeps();
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    ctx.deps.newSessionId = () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    ctx.deps.tmuxProbe = {
      available: () => true,
      // worker 用名前空間および別 orchestrator の名前は衝突しない
      listSessionNames: () => ["hachi-worker-aaaaaaaa", "hachi-orch-ffffffff-aaaaaaaa"],
    };

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    expect(output.preflight.find((c) => c.name === "session-name-unique")?.ok).toBe(true);
    expect(output.blocked).toBe(false);
  });

  it("mission cwd と repo root がどちらも実在しない場合を独立に報告して blocked にする", async () => {
    ctx = createTestDeps();
    ctx.deps.isDirectory = () => false;
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    const check = output.preflight.find((c) => c.name === "cwd-usable");
    expect(check?.ok).toBe(false);
    expect(check?.reason).toContain("実在する directory ではありません");
    expect(check?.cwdSource).toBe("repo-root-fallback");
    expect(output.blocked).toBe(true);
  });

  it("mission cwd が相対パスの場合は repo root へフォールバックする", async () => {
    ctx = createTestDeps();
    ctx.deps.isDirectory = () => true;
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const mission = ctx.deps.store.createTask(
      { title: "相対 cwd", body: "cwd: relative/path\n\n本文", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(mission.id, reg.orchestrator.id, "primary");

    const output = await runHandover(reg.session.id, reg.session.generation, mission.id);

    const check = output.preflight.find((c) => c.name === "cwd-usable");
    expect(check).toMatchObject({ ok: true, cwdSource: "repo-root-fallback" });
    expect(output.tmuxCommandLine).not.toContain("relative/path");
    expect(output.blocked).toBe(false);
  });

  it("cwd が Claude trust 未承諾なら起動前に blocked にする", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.claudeTrustProbe = { isTrusted: () => false };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.preflight.find((check) => check.name === "cwd-trusted")).toMatchObject({ ok: false });
    expect(output.blocked).toBe(true);
    expect(output.applied).toBe(false);
    expect(ctx.deps.store.getOrchestratorSession(reg.session.id)?.status).toBe("active");
  });

  it("tmux argv 全体が byte 上限を超える場合は preflight で blocked にし launch しない", async () => {
    expect(TMUX_COMMAND_MAX_BYTES).toBe(15_000);
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.isDirectory = () => true;
    const reg = await register();
    const longCwd = `/${"a".repeat(TMUX_COMMAND_MAX_BYTES + 1_000)}`;
    const mission = ctx.deps.store.createTask(
      { title: "長い cwd", body: `cwd: ${longCwd}\n`, tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(mission.id, reg.orchestrator.id, "primary");
    let launchCount = 0;
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      launch: () => { launchCount += 1; return { ok: true, pid: process.pid }; },
      hasSession: () => true,
      getPaneRootPid: () => process.pid,
      killSession: () => true,
    };

    const output = await runHandover(reg.session.id, reg.session.generation, mission.id, ["--apply"]);

    const sizeCheck = output.preflight.find((check) => check.name === "tmux-command-size");
    expect(sizeCheck).toMatchObject({ ok: false });
    expect(output.tmuxCommandBytes).toBeGreaterThan(TMUX_COMMAND_MAX_BYTES);
    expect(output.tmuxCommandMaxBytes).toBe(TMUX_COMMAND_MAX_BYTES);
    expect(output.blocked).toBe(true);
    expect(launchCount).toBe(0);
    expect(ctx.deps.store.getOrchestratorSession(reg.session.id)?.status).toBe("active");
  });

  it("tmux セッション一覧を取得できない場合は「衝突なし」と判定しない", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = {
      available: () => true,
      listSessionNames: () => { throw new Error("no permission to access tmux socket"); },
    };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    const check = output.preflight.find((c) => c.name === "session-name-unique");
    expect(check?.ok).toBe(false);
    expect(check?.reason).toContain("一覧を取得できません");
    expect(output.blocked).toBe(true);
  });

  it("cwd に空白や shell メタ文字が入っても表示用コマンドラインが安全に quoting される", async () => {
    ctx = createTestDeps();
    ctx.deps.isDirectory = () => true;
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const danger = "/tmp/x;id";
    const mission = ctx.deps.store.createTask(
      { title: "危険な cwd", body: `cwd: ${danger}\n\n本文`, tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(mission.id, reg.orchestrator.id, "primary");

    const output = await runHandover(reg.session.id, reg.session.generation, mission.id);

    expect(output.tmuxCommandLine).not.toContain("-c /tmp/x;id ");
    expect(output.tmuxCommandLine).toContain("'/tmp/x;id'");
    expect(output.tmuxArgs).toContain(danger);
  });

  it("明示 --mission が board に存在しない場合は候補なしとして報告する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();

    const output = await runHandover(reg.session.id, reg.session.generation, "t_nonexistent");

    expect(output.resolution).toMatchObject({ status: "none", candidates: [] });
    expect(output.resolution.reason).toContain("--mission=t_nonexistent");
    expect(output.resolution.reason).toContain("(該当なし)");
    expect(ctx.exitCodes).toEqual([2]);
  });

  it("ミッション task が archived の場合を独立に報告する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const task = ctx.deps.store.createTask(
      { title: "archived mission", body: "cwd: /tmp\n\nbody", tenant: "dev", status: "ready" },
      "tester",
    );
    transitionTo(task.id, "archived");

    const output = await runHandover(reg.session.id, reg.session.generation, task.id);

    const missionCheck = output.preflight.find((c) => c.name === "mission-valid");
    expect(missionCheck).toMatchObject({ ok: false });
    expect(missionCheck!.reason).toContain("archived");
    expect(output.blocked).toBe(true);
  });

  it("明示 --session が board に存在しない場合は候補なしとして報告する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover("nonexistent-session", 1, missionId);

    expect(output.resolution).toMatchObject({ status: "none", candidates: [] });
    expect(output.resolution.reason).toContain("--session=nonexistent-session");
    expect(output.resolution.reason).toContain("(該当なし)");
    expect(ctx.exitCodes).toEqual([2]);
  });

  it("session status が active でない場合を独立に報告する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);
    ctx.deps.store.closeOrchestratorSession(reg.session.id, reg.session.generation);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    const sessionCheck = output.preflight.find((c) => c.name === "session-generation-match");
    expect(sessionCheck).toMatchObject({ ok: false });
    expect(sessionCheck!.reason).toContain("active ではありません");
    expect(output.blocked).toBe(true);
  });

  it("明示 generation が board 実値と異なる場合は矛盾した候補 command を返さない", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, 99, missionId);

    expect(output.resolution).toMatchObject({ status: "none", candidates: [] });
    expect(output.resolution.reason).toContain("--generation=99");
    expect(output.resolution.reason).toContain(`実値 ${reg.session.generation}`);
    expect(ctx.exitCodes).toEqual([2]);
  });

  it("--json が機械可読で必要なフィールドをすべて含む", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id, ["ready", "ready", "done"]);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    // 全フィールドの存在確認
    expect(output).toHaveProperty("successorSessionId");
    expect(output).toHaveProperty("startupPrompt");
    expect(output).toHaveProperty("tmuxCommandLine");
    expect(output).toHaveProperty("handoffPreparePreview");
    expect(output).toHaveProperty("missionState");
    expect(output).toHaveProperty("preflight");
    expect(output).toHaveProperty("blocked");
    expect(output).toHaveProperty("blockReasons");
    expect(output.resolution).toMatchObject({
      status: "resolved",
      candidates: [expect.objectContaining({
        orchestratorId: reg.orchestrator.id,
        label: reg.orchestrator.label,
        project: reg.orchestrator.project,
        sessionId: reg.session.id,
        generation: reg.session.generation,
        missionTaskId: missionId,
        missionTitle: "ミッション M3",
      })],
    });

    // handoffPreparePreview の構造（previewHandoffTransfers API 経由）
    expect(output.handoffPreparePreview).toMatchObject({
      sessionId: reg.session.id,
      generation: reg.session.generation,
      orchestratorRequestCount: 0,
      runtimeCleanupClaimCount: 0,
    });

    // missionState の構造（subtree 全体を集計）
    expect(output.missionState).toMatchObject({
      taskId: missionId,
      title: "ミッション M3",
      status: "ready",
      descendantTotal: 3,
    });
    expect(output.missionState.descendantStatusCounts).toEqual({ ready: 2, done: 1 });

    // 既存8項目の末尾に provider-launchable が追加される。
    expect(output.preflight).toHaveLength(9);
    const checkNames = output.preflight.map((c) => c.name);
    expect(checkNames).toEqual([
      "tmux-available",
      "session-name-unique",
      "mission-valid",
      "session-generation-match",
      "cwd-usable",
      "cwd-trusted",
      "mission-identity",
      "tmux-command-size",
      "provider-launchable",
    ]);
    expect(output.preflight.at(-1)).toEqual({ name: "provider-launchable", ok: true });
    expect(output.tmuxCommandMaxBytes).toBe(TMUX_COMMAND_MAX_BYTES);
    expect(output.tmuxCommandBytes).toBeLessThanOrEqual(TMUX_COMMAND_MAX_BYTES);

    // 実行側が execFile へ渡せる argv も返る（-p は含まない）
    expect(output.tmuxArgs[0]).toBe("new-session");
    expect(output.tmuxArgs.slice(-4, -1)).toEqual([
      "hachi-successor",
      expect.stringMatching(/^hachi-successor-/),
      output.successorSessionId,
    ]);
    // 末尾要素は startupPrompt そのもの。
    expect(output.tmuxArgs[output.tmuxArgs.length - 1]!).toBe(output.startupPrompt);
    expect(output.tmuxArgs).not.toContain("-p");

    // 全検査が通っている
    expect(output.blocked).toBe(false);
    expect(output.blockReasons).toEqual([]);
  });

  it("provider=codex の dry-run は provider-launchable を末尾で fail-closed にする", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register("codex");
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    const providerCheck = output.preflight.at(-1);
    expect(providerCheck).toMatchObject({ name: "provider-launchable", ok: false });
    expect(providerCheck?.reason).toContain("provider-launchable:");
    expect(providerCheck?.reason).toContain("実 provider=\"codex\"");
    expect(providerCheck?.reason).toContain("reference §0.7.5 の手動手順");
    expect(output.blocked).toBe(true);
    expect(output.blockReasons).toContain(providerCheck?.reason);
  });

  it("provider が空文字の dry-run は provider-launchable を末尾で fail-closed にする", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register("");
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    const providerCheck = output.preflight.at(-1);
    expect(providerCheck).toMatchObject({ name: "provider-launchable", ok: false });
    expect(providerCheck?.reason).toContain("provider-launchable:");
    expect(providerCheck?.reason).toContain("実 provider=\"\"");
    expect(providerCheck?.reason).toContain("reference §0.7.5 の手動手順");
    expect(output.blocked).toBe(true);
    expect(output.blockReasons).toContain(providerCheck?.reason);
  });

  it("解決後に session が不明になった場合も provider-launchable を末尾で fail-closed にする", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register("claude");
    const missionId = createMissionWithChildren(reg.orchestrator.id);
    const getSession = ctx.deps.store.getOrchestratorSession.bind(ctx.deps.store);
    let matchingReads = 0;
    vi.spyOn(ctx.deps.store, "getOrchestratorSession").mockImplementation((sessionId) => {
      if (sessionId !== reg.session.id) {
        return getSession(sessionId);
      }
      matchingReads += 1;
      return matchingReads === 1 ? getSession(sessionId) : null;
    });

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    const providerCheck = output.preflight.at(-1);
    expect(providerCheck).toMatchObject({ name: "provider-launchable", ok: false });
    expect(providerCheck?.reason).toContain("実 provider=<session不明>");
    expect(providerCheck?.reason).toContain("reference §0.7.5 の手動手順");
    expect(output.blocked).toBe(true);
  });

  it("provider=claude は provider-launchable が通り既存 Claude argv を維持する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register("claude");
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    expect(output.preflight.at(-1)).toEqual({ name: "provider-launchable", ok: true });
    expect(output.blocked).toBe(false);
    expect(output.tmuxArgs.slice(-4, -1)).toEqual([
      "hachi-successor",
      expect.stringMatching(/^hachi-successor-/),
      output.successorSessionId,
    ]);
  });

  it("cwd は body の cwd: 行から取得する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    expect(output.tmuxCommandLine).toContain(`-c ${sharedTmpCwd}`);
    expect(output.preflight.find((check) => check.name === "cwd-usable")).toMatchObject({
      ok: true,
      cwdSource: "mission-cwd",
    });
  });

  it("mission cwd が実在しない場合は orchestrator の repo root へフォールバックする", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const repoRoot = "/repo/fallback-root";
    const staleMissionCwd = "/stale/removed-worktree";
    const reg = registerIdentity("stale-cwd", "dev", "claude", repoRoot);
    ctx.deps.isDirectory = (target) => target === repoRoot;
    const mission = ctx.deps.store.createTask(
      { title: "stale cwd", body: `cwd: ${staleMissionCwd}\n`, tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(mission.id, reg.orchestrator.id, "primary");

    const output = await runHandover(reg.session.id, reg.session.generation, mission.id);

    expect(output.tmuxArgs).toContain(repoRoot);
    expect(output.tmuxArgs).not.toContain(staleMissionCwd);
    expect(output.preflight.find((check) => check.name === "cwd-usable")).toMatchObject({
      ok: true,
      cwdSource: "repo-root-fallback",
    });
  });

  it("mission cwd が null の場合は orchestrator の repo root へフォールバックする", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const repoRoot = "/repo/no-mission-cwd";
    const reg = registerIdentity("no-mission-cwd", "dev", "claude", repoRoot);
    ctx.deps.isDirectory = (target) => target === repoRoot;
    const trustedCwds: string[] = [];
    ctx.deps.claudeTrustProbe = {
      isTrusted: (target) => {
        trustedCwds.push(target);
        return true;
      },
    };
    const mission = ctx.deps.store.createTask(
      { title: "no cwd", body: "本文のみ", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(mission.id, reg.orchestrator.id, "primary");

    const output = await runHandover(reg.session.id, reg.session.generation, mission.id);

    expect(output.tmuxArgs).toContain(repoRoot);
    expect(output.preflight.find((check) => check.name === "cwd-usable")).toMatchObject({
      ok: true,
      cwdSource: "repo-root-fallback",
    });
    expect(trustedCwds).toEqual([repoRoot]);
  });

  it("repoCommonDir が /.git で終わる場合は親 directory へフォールバックする", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const repoRoot = "/repo/dot-git-parent";
    const reg = registerIdentity("dot-git", "dev", "claude", `${repoRoot}/.git`);
    ctx.deps.isDirectory = (target) => target === repoRoot;
    const mission = ctx.deps.store.createTask(
      { title: "no cwd", body: "本文のみ", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(mission.id, reg.orchestrator.id, "primary");

    const output = await runHandover(reg.session.id, reg.session.generation, mission.id);

    expect(output.tmuxArgs).toContain(repoRoot);
    expect(output.tmuxArgs).not.toContain(`${repoRoot}/.git`);
    expect(output.preflight.find((check) => check.name === "cwd-usable")).toMatchObject({
      ok: true,
      cwdSource: "repo-root-fallback",
    });
  });

  it("テキスト出力モードでも正しく出力される", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id, ["ready"]);

    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator", "handover",
        "--session", reg.session.id,
        "--generation", String(reg.session.generation),
        "--mission", missionId,
      ],
      { from: "user" },
    );
    const text = ctx.stdout.text();

    expect(text).toContain("orchestrator handover dry-run");
    expect(text).toContain("起動プロンプト");
    expect(text).toContain("tmux コマンドライン");
    expect(text).toContain("durable handoff final プレビュー");
    expect(text).toContain("ミッション状態");
    expect(text).toContain("事前検査");
    expect(text).toContain("実行可能: はい");
  });

  // ===================================================================
  // M3a レビュー積み残し #1: ミッションと orchestrator identity の対応検証
  // ===================================================================

  it("別 orchestrator が primary binding を持つミッションを拒否する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    // 別の orchestrator を登録
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator", "register",
        "--label", "other-orch",
        "--project", "dev",
        "--cwd", process.cwd(),
        "--json",
      ],
      { from: "user" },
    );
    const otherReg = JSON.parse(ctx.stdout.text()) as RegisterOutput;
    ctx.stdout.clear();

    // 別 orchestrator が primary binding を持つミッションを作成
    const mission = ctx.deps.store.createTask(
      { title: "他の担当", body: "cwd: /tmp\n\nbody", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(mission.id, otherReg.orchestrator.id, "primary");

    const output = await runHandover(reg.session.id, reg.session.generation, mission.id);

    const identityCheck = output.preflight.find((c) => c.name === "mission-identity");
    expect(identityCheck?.ok).toBe(false);
    expect(identityCheck?.reason).toContain("担当範囲に含まれません");
    expect(output.blocked).toBe(true);
  });

  it("binding がなくても subtree watch でミッションをカバーしていれば通過する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();

    // 親タスクを作成し、subtree watch を設定
    const parent = ctx.deps.store.createTask(
      { title: "親", body: "cwd: /tmp\n\nbody", tenant: "dev", status: "ready" },
      "tester",
    );
    const mission = ctx.deps.store.createTask(
      { title: "子ミッション", body: "cwd: /tmp\n\nbody", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.link(parent.id, mission.id);
    // parent に subtree watch を設定
    ctx.deps.store.addOrchestratorWatch({
      orchestratorId: reg.orchestrator.id,
      scope: "subtree",
      selector: parent.id,
      role: "primary",
    });

    const output = await runHandover(reg.session.id, reg.session.generation, mission.id);

    const identityCheck = output.preflight.find((c) => c.name === "mission-identity");
    expect(identityCheck?.ok).toBe(true);
  });

  it("observer role のみの binding では通過しない", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();

    const mission = ctx.deps.store.createTask(
      { title: "observer binding のみ", body: "cwd: /tmp\n\nbody", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(mission.id, reg.orchestrator.id, "observer");

    const output = await runHandover(reg.session.id, reg.session.generation, mission.id);

    const identityCheck = output.preflight.find((c) => c.name === "mission-identity");
    expect(identityCheck?.ok).toBe(false);
    expect(identityCheck?.reason).toContain("担当範囲に含まれません");
    expect(output.blocked).toBe(true);
  });

  it("observer role のみの watch では通過しない", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();

    const mission = ctx.deps.store.createTask(
      { title: "observer watch のみ", body: "cwd: /tmp\n\nbody", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.addOrchestratorWatch({
      orchestratorId: reg.orchestrator.id,
      scope: "task",
      selector: mission.id,
      role: "observer",
    });

    const output = await runHandover(reg.session.id, reg.session.generation, mission.id);

    const identityCheck = output.preflight.find((c) => c.name === "mission-identity");
    expect(identityCheck?.ok).toBe(false);
  });

  it("他 identity の primary binding が存在する場合、current identity の subtree watch があっても binding 優先で拒否する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator", "register",
        "--label", "other-orch-2",
        "--project", "dev",
        "--cwd", process.cwd(),
        "--json",
      ],
      { from: "user" },
    );
    const otherReg = JSON.parse(ctx.stdout.text()) as RegisterOutput;
    ctx.stdout.clear();

    // 親タスクを作成し、current identity に subtree watch を設定する
    const parent = ctx.deps.store.createTask(
      { title: "親", body: "cwd: /tmp\n\nbody", tenant: "dev", status: "ready" },
      "tester",
    );
    const mission = ctx.deps.store.createTask(
      { title: "他 identity の binding あり", body: "cwd: /tmp\n\nbody", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.link(parent.id, mission.id);
    ctx.deps.store.addOrchestratorWatch({
      orchestratorId: reg.orchestrator.id,
      scope: "subtree",
      selector: parent.id,
      role: "primary",
    });
    // 他 identity が primary binding を持つ（binding が1件でもあれば watch は候補に混ぜない）
    ctx.deps.store.bindTaskToOrchestrator(mission.id, otherReg.orchestrator.id, "primary");

    const output = await runHandover(reg.session.id, reg.session.generation, mission.id);

    const identityCheck = output.preflight.find((c) => c.name === "mission-identity");
    expect(identityCheck?.ok).toBe(false);
    expect(output.blocked).toBe(true);
  });

  it("binding がなくても worktree scope watch でミッションをカバーしていれば通過する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();

    const worktree = "/tmp/handover-worktree-scope";
    const mission = ctx.deps.store.createTask(
      { title: "worktree watch 対象", body: `cwd: ${worktree}\n\nbody`, tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.addOrchestratorWatch({
      orchestratorId: reg.orchestrator.id,
      scope: "worktree",
      selector: worktree,
      role: "primary",
    });

    const output = await runHandover(reg.session.id, reg.session.generation, mission.id);

    const identityCheck = output.preflight.find((c) => c.name === "mission-identity");
    expect(identityCheck?.ok).toBe(true);
  });

  it("binding がなくても project scope watch でミッションをカバーしていれば通過する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();

    const mission = ctx.deps.store.createTask(
      { title: "project watch 対象", body: "cwd: /tmp\n\nbody", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.addOrchestratorWatch({
      orchestratorId: reg.orchestrator.id,
      scope: "project",
      selector: "dev",
      role: "primary",
    });

    const output = await runHandover(reg.session.id, reg.session.generation, mission.id);

    const identityCheck = output.preflight.find((c) => c.name === "mission-identity");
    expect(identityCheck?.ok).toBe(true);
  });

  // ===================================================================
  // M3a レビュー積み残し #2: handoff-prepare の claim プレビュー
  // ===================================================================

  it("handoff プレビューが orchestrator request と runtime cleanup claim を別々に集計する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId);

    // 初期状態ではどちらも 0
    expect(output.handoffPreparePreview.orchestratorRequestCount).toBe(0);
    expect(output.handoffPreparePreview.runtimeCleanupClaimCount).toBe(0);
  });

  // ===================================================================
  // M3a レビュー積み残し #3: ミッション状態を subtree 全体で集計する
  // ===================================================================

  it("孫以下も含めた subtree 全体を集計する（直下の子だけではない）", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();

    // ミッション → 子 → 孫 の3階層を作成
    const mission = ctx.deps.store.createTask(
      { title: "ミッション", body: "cwd: /tmp\n\nbody", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(mission.id, reg.orchestrator.id, "primary");
    const child = ctx.deps.store.createTask(
      { title: "子", body: "cwd: /tmp", tenant: "dev", status: "ready" },
      "tester",
    );
    const grandchild1 = ctx.deps.store.createTask(
      { title: "孫1", body: "cwd: /tmp", tenant: "dev", status: "ready" },
      "tester",
    );
    transitionTo(grandchild1.id, "done");
    const grandchild2 = ctx.deps.store.createTask(
      { title: "孫2", body: "cwd: /tmp", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.link(mission.id, child.id);
    ctx.deps.store.link(child.id, grandchild1.id);
    ctx.deps.store.link(child.id, grandchild2.id);

    const output = await runHandover(reg.session.id, reg.session.generation, mission.id);

    // 子1 + 孫2 = 3件（root 除外）
    expect(output.missionState.descendantTotal).toBe(3);
    expect(output.missionState.descendantStatusCounts).toEqual({ ready: 2, done: 1 });
  });

  it("循環リンクがあっても subtree 集計が停止する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();

    // A → B → C → A（循環）を作成
    const a = ctx.deps.store.createTask(
      { title: "A", body: "cwd: /tmp\n\nbody", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(a.id, reg.orchestrator.id, "primary");
    const b = ctx.deps.store.createTask(
      { title: "B", body: "cwd: /tmp", tenant: "dev", status: "ready" },
      "tester",
    );
    const c = ctx.deps.store.createTask(
      { title: "C", body: "cwd: /tmp", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.link(a.id, b.id);
    ctx.deps.store.link(b.id, c.id);
    ctx.deps.store.link(c.id, a.id);

    const output = await runHandover(reg.session.id, reg.session.generation, a.id);

    // 循環でも停止する（A=root 除外で B,C の 2件）
    expect(output.missionState.descendantTotal).toBe(2);
    expect(output.missionState.descendantStatusCounts).toEqual({ ready: 2 });
  });

  // ===================================================================
  // --apply テスト
  // ===================================================================

  it("--apply 無しなら従来どおり dry-run で副作用ゼロ", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const sessionsBefore = ctx.deps.store.listOrchestratorSessions(reg.orchestrator.id);
    await runHandover(reg.session.id, reg.session.generation, missionId);
    const sessionsAfter = ctx.deps.store.listOrchestratorSessions(reg.orchestrator.id);

    expect(sessionsAfter).toEqual(sessionsBefore);
    expect(ctx.exitCodes).toEqual([]);
  });

  it("事前検査が1つでも不可なら --apply でも何も実行しない", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => false, listSessionNames: () => [] };
    const launcher = createSuccessLauncher();
    ctx.deps.tmuxLauncher = launcher;
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const sessionsBefore = ctx.deps.store.listOrchestratorSessions(reg.orchestrator.id);
    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);
    const sessionsAfter = ctx.deps.store.listOrchestratorSessions(reg.orchestrator.id);

    expect(output.applied).toBe(false);
    expect(output.blocked).toBe(true);
    expect(output.attempts).toEqual([]);
    expect(launcher.launchArgsCalls).toEqual([]);
    expect(sessionsAfter).toEqual(sessionsBefore);
    expect(ctx.exitCodes).toContain(1);
  });

  it("provider=codex の --apply は launch も handoff prepare mutation も実行しない", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const launch = vi.fn(() => ({ ok: true as const, pid: process.pid }));
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      launch,
      hasSession: () => true,
      getPaneRootPid: () => process.pid,
      killSession: () => true,
    };
    const prepare = vi.spyOn(ctx.deps.store, "prepareOrchestratorHandoff");
    const reg = await register("codex");
    const missionId = createMissionWithChildren(reg.orchestrator.id);
    const sessionBefore = ctx.deps.store.getOrchestratorSession(reg.session.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.preflight.at(-1)).toMatchObject({ name: "provider-launchable", ok: false });
    expect(output.blocked).toBe(true);
    expect(output.applied).toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(ctx.deps.store.getOrchestratorSession(reg.session.id)).toEqual(sessionBefore);
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("launch が {ok:false} を返した場合、kill を試みずに handoff-prepare を取り消す（何も所有していないため）", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const launcher = createLaunchFailLauncher("tmux server crashed");
    ctx.deps.tmuxLauncher = launcher;
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);
    const heartbeatBefore = ctx.deps.store.getOrchestratorSession(reg.session.id)!.heartbeatAt;

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(false);
    expect(output.rolledBack).toBe(true);
    // 補償境界（新仕様）: launch 自体が失敗した場合は何も作られていないため所有権 nonce を持たず、
    // kill は一切試みない。それでも何も存在しないので停止確認は即座に通り、DB はロールバックされる。
    expect(launcher.killSessionCalls.length).toBe(0);
    // session は active に戻っているはず
    const session = ctx.deps.store.getOrchestratorSession(reg.session.id)!;
    expect(session.status).toBe("active");
    // handoffTokenHash は非null契約（string）のため、キャンセル後は既定値の空文字に戻る
    expect(session.handoffTokenHash).toBe("");
    // heartbeat_at も更新される（ロールバック直後に stale 判定されないようにするため）
    expect(session.heartbeatAt).toBeGreaterThanOrEqual(heartbeatBefore);
    expect(ctx.exitCodes).toContain(1);
  });

  it("spawn 後に session identity を観測できない場合は durable uncertain に固定する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.tmuxLauncher = createNoSessionLauncher();
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(false);
    expect(output.rolledBack).toBe(false);
    expect(output.slotStatus).toBe("uncertain");
    const session = ctx.deps.store.getOrchestratorSession(reg.session.id)!;
    expect(session.status).toBe("handoff_pending");
    expect(ctx.exitCodes).toContain(2);
  });

  it("spawn 後に PID を観測できない場合は durable uncertain に固定する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.tmuxLauncher = createNoPidLauncher();
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(false);
    expect(output.rolledBack).toBe(false);
    expect(output.slotStatus).toBe("uncertain");
    const session = ctx.deps.store.getOrchestratorSession(reg.session.id)!;
    expect(session.status).toBe("handoff_pending");
    expect(ctx.exitCodes).toContain(2);
  });

  it("dry-run と apply の barrier argv は一致し、handoff token は argv へ露出せず slot fence にだけ残る", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const fixedUuid = "33333333-4444-5555-6666-777777777777";
    const fixedLaunchNonce = "handover-launch-nonce";
    // dry-run と --apply で完全同一の token を再現するため DI 穴で固定する。
    // sha256 hex の64桁と同形にして自然な test fixture にする（handoff_token_hash 列自体に長さ制約はない）。
    const fixedToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd01";
    ctx.deps.newSessionId = () => fixedUuid;
    ctx.deps.newHandoffToken = () => fixedToken;
    ctx.deps.newHandoffLaunchNonce = () => fixedLaunchNonce;
    ctx.deps.newSuccessorBarrierNonce = () => "fixed-claude-barrier";
    ctx.deps.newSuccessorOwnerNonce = () => "fixed-claude-owner";
    const deliveryProbe = vi.fn(async () => ({ userNonceObserved: true, assistantObserved: true }));
    ctx.deps.handoverDeliveryGateProbe = deliveryProbe;
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    // dry-run が返す tmuxArgs と apply の実 argv は同じ builder を通る。
    const dryRunOutput = await runHandover(reg.session.id, reg.session.generation, missionId);
    ctx.stdout.clear();

    // 同じ採番で --apply を実行し、実際に launch へ渡された argv を捕捉する
    let capturedLaunchArgs: string[] | null = null;
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      launch: (args: string[]) => {
        capturedLaunchArgs = args;
        return { ok: true, pid: process.pid };
      },
      hasSession: () => true,
      getPaneRootPid: () => process.pid,
      killSession: () => true,
    };
    const applyOutput = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(applyOutput.applied).toBe(true);
    expect(capturedLaunchArgs).not.toBeNull();
    // 末尾要素も含めた配列全体が完全一致する（buildTmuxArgs を dry-run と apply で共通利用しているため）
    expect(capturedLaunchArgs).toEqual(dryRunOutput.tmuxArgs);
    // どちらにも -p は含まれない
    expect(dryRunOutput.tmuxArgs).not.toContain("-p");
    expect(capturedLaunchArgs).not.toContain("-p");
    expect(dryRunOutput.tmuxArgs.some((a) => a.includes(fixedToken))).toBe(false);
    expect(capturedLaunchArgs!.some((a) => a.includes(fixedToken))).toBe(false);
    expect(capturedLaunchArgs!.some((a) => a.includes(`launch nonce: ${fixedLaunchNonce}`))).toBe(true);
    expect(deliveryProbe).toHaveBeenCalledWith(expect.objectContaining({
      successorSessionId: fixedUuid,
      launchNonce: fixedLaunchNonce,
    }));
    expect(capturedLaunchArgs!.some((value) => value.includes('exec claude --session-id "$2" -- "$3"'))).toBe(true);
    // 末尾要素は startupPrompt そのもの
    expect(dryRunOutput.tmuxArgs[dryRunOutput.tmuxArgs.length - 1]!).toBe(dryRunOutput.startupPrompt);
    expect(capturedLaunchArgs![capturedLaunchArgs!.length - 1]!).toBe(dryRunOutput.startupPrompt);
    // paste-buffer / send-keys を呼ぶコード自体が存在しないことは、TmuxLauncher の型から
    // capturePane / sendKeys が削除されている（deps.ts）ことで構造的に保証されている。
    // source は atomic final 済みで、token fence は terminal slot にだけ残る。
    const session = ctx.deps.store.getOrchestratorSession(reg.session.id)!;
    expect(session.status).toBe("superseded");
    const expectedHash = createHash("sha256").update(fixedToken).digest("hex");
    expect(ctx.deps.store.listSuccessorLaunches()).toEqual([
      expect.objectContaining({
        status: "succeeded",
        targetProvider: "claude",
        providerSessionSource: "claude-delivery",
        handoffTokenFenceHash: expectedHash,
      }),
    ]);
  });

  it("spawn result が例外で部分観測になった場合は kill を推測せず uncertain に固定する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    let killSessionCalled = false;
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      launch: () => {
        throw new Error("spawnSync が例外を投げました");
      },
      // launch が例外を投げた時点で所有権 nonce は一切設定されていないため、kill は呼ばれないはず
      hasSession: () => false,
      getPaneRootPid: () => null,
      killSession: () => {
        killSessionCalled = true;
        return true;
      },
    };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(killSessionCalled).toBe(false);
    expect(output.applied).toBe(false);
    expect(output.rolledBack).toBe(false);
    expect(output.slotStatus).toBe("uncertain");
    expect(output.failReason).toContain("spawn result");
    const session = ctx.deps.store.getOrchestratorSession(reg.session.id)!;
    expect(session.status).toBe("handoff_pending");
    expect(ctx.exitCodes).toContain(2);
  });

  it("exact readSuccessorRuntime が揃えば legacy hasSession/getPaneRootPid の一時例外へ依存しない", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    // 1回目（起動確認）は例外、2回目以降（ロールバック確認）は「存在しない」を返す
    let hasSessionCallCount = 0;
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      launch: () => ({ ok: true, pid: process.pid }),
      hasSession: () => {
        hasSessionCallCount += 1;
        if (hasSessionCallCount === 1) {
          throw new Error("tmux ソケットに接続できません");
        }
        return false;
      },
      getPaneRootPid: () => process.pid,
      killSession: () => true,
    };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(true);
    const session = ctx.deps.store.getOrchestratorSession(reg.session.id)!;
    expect(session.status).toBe("superseded");
    expect(ctx.exitCodes).toEqual([]);
  });

  it("launch 失敗時に hasSession が true のまま（何らかの session が残っている）場合、所有権が無いので kill せず手動対応を促す", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const cancelSpy = vi.spyOn(ctx.deps.store, "cancelOrchestratorHandoff");
    let killSessionCalled = false;
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      // launch 自体は {ok:false} として補償フローに入る → 所有権 nonce は一切設定されない
      launch: () => ({ ok: false, reason: "spawn 失敗" }),
      // 別の何か（自分が作ったものではない）が居座り続けている想定
      hasSession: () => true,
      getPaneRootPid: () => null,
      killSession: () => {
        killSessionCalled = true;
        return false;
      },
    };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    // 所有権を証明できないため kill は一切試みない（新仕様）
    expect(killSessionCalled).toBe(false);
    // 停止を確認できないため rolledBack:true には絶対にしない
    expect(output.applied).toBe(false);
    expect(output.rolledBack).toBe(false);
    expect(output.failReason).toContain("process未作成を証明できません");
    expect(output.slotStatus).toBe("uncertain");
    // cancelOrchestratorHandoff は呼ばれていない（DB 操作の spy で未呼び出しを確認）
    expect(cancelSpy).not.toHaveBeenCalled();
    // DB は handoff_pending のまま
    const session = ctx.deps.store.getOrchestratorSession(reg.session.id)!;
    expect(session.status).toBe("handoff_pending");
    expect(ctx.exitCodes).toContain(2);
  });

  it("正常系は旧 prepare/fence/cancel state machine を呼ばない", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const callOrder: string[] = [];
    let killed = false;
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      launch: () => ({ ok: true, pid: process.pid }),
      hasSession: () => !killed,
      getPaneRootPid: () => null,
      killSession: () => {
        callOrder.push("kill");
        killed = true;
        return true;
      },
    };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);
    const prepareSpy = vi.spyOn(ctx.deps.store, "prepareOrchestratorHandoff");
    const fenceSpy = vi.spyOn(ctx.deps.store, "fenceOrchestratorHandoffToken");
    const cancelSpy = vi.spyOn(ctx.deps.store, "cancelOrchestratorHandoff");

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(true);
    expect(callOrder).toEqual([]);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(fenceSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(ctx.deps.store.getOrchestratorSession(reg.session.id)?.status).toBe("superseded");
  });

  it("名前衝突時は起動せず終了する（既存セッションを kill しない）", async () => {
    ctx = createTestDeps();
    const fixedUuid = "22222222-3333-4444-5555-666666666666";
    ctx.deps.newSessionId = () => fixedUuid;
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const collidingName = `hachi-orch-${reg.orchestrator.id.slice(0, 8)}-${fixedUuid}`;
    ctx.deps.tmuxProbe = {
      available: () => true,
      listSessionNames: () => [collidingName],
    };
    let launchCalled = false;
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      launch: () => { launchCalled = true; return { ok: true, pid: 1 }; },
      hasSession: () => true,
      getPaneRootPid: () => 1,
      killSession: () => true,
    };

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    // 名前衝突で blocked → launch は呼ばれない
    expect(output.blocked).toBe(true);
    expect(launchCalled).toBe(false);
    // session は変化していない（handoff-prepare されていない）
    const session = ctx.deps.store.getOrchestratorSession(reg.session.id)!;
    expect(session.status).toBe("active");
  });

  it("tmux が PATH に無い環境では起動せず理由を明示して終える（fail-closed）", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => false, listSessionNames: () => [] };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(false);
    expect(output.blocked).toBe(true);
    const tmuxCheck = output.preflight.find((c) => c.name === "tmux-available");
    expect(tmuxCheck?.ok).toBe(false);
    expect(tmuxCheck?.reason).toBe("tmux-not-found");
    expect(ctx.exitCodes).toContain(1);
  });

  it("authority は legacy PID probe ではなく一回の stable exact runtime readback に固定する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    // session は存在するが、PID が非存在のプロセス（kill(pid, 0) が false を返す）。
    // hasSession は「起動確認時は true、kill 後は false」という実 tmux の挙動を模す。
    let killed = false;
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      launch: () => ({ ok: true, pid: 99999 }),
      hasSession: () => !killed,
      getPaneRootPid: () => 99999999, // 存在しない PID
      killSession: () => { killed = true; return true; },
    };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(true);
    expect(output.slotStatus).toBe("succeeded");
    expect(ctx.exitCodes).toEqual([]);
  });

  it("--apply 成功時に attach コマンドが提示される（argv 直渡し方式）", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    // isProcessAlive は process.kill(pid, 0) なので、自プロセスの PID を使えば生存判定が true になる
    const selfPid = process.pid;
    const launchArgsCalls: string[][] = [];
    const killSessionCalls: string[] = [];
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      launch: (args: string[]) => {
        launchArgsCalls.push(args);
        return { ok: true, pid: selfPid };
      },
      hasSession: () => true,
      getPaneRootPid: () => selfPid,
      killSession: (sessionName: string) => {
        killSessionCalls.push(sessionName);
        return true;
      },
    };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(true);
    expect(output.attachCommand).toContain("tmux attach-session");
    expect(output.tmuxSessionName).toMatch(/^hachi-orch-/);
    expect(output.panePid).toBe(selfPid);
    expect(output.delivery).toEqual({ status: "confirmed", confirmedVia: "transcript" });
    // launch が1回だけ呼ばれ、その argv には -p は含まれない
    expect(launchArgsCalls).toHaveLength(1);
    const launchArgs = launchArgsCalls[0]!;
    expect(launchArgs).not.toContain("-p");
    // launch argv には prompt が渡るが、apply JSON では raw launch nonce ごと redacted される。
    const lastArg = launchArgs[launchArgs.length - 1]!;
    expect(lastArg).toContain(`ミッション task ID: ${missionId}`);
    expect(output.startupPrompt).toBe("[redacted after durable arm]");
    expect(output.tmuxArgs).toEqual([]);
    expect(launchArgs.some((a) => a.includes("handoff token:"))).toBe(false);
    // 成功パスでは killSession は呼ばれない
    expect(killSessionCalls).toEqual([]);
    // delivery attest と atomic final まで親 CLI が完了する。
    const session = ctx.deps.store.getOrchestratorSession(reg.session.id)!;
    expect(session.status).toBe("superseded");
    const successor = ctx.deps.store.listOrchestratorSessions(reg.orchestrator.id)
      .find((candidate) => candidate.status === "active");
    expect(successor).toMatchObject({
      provider: "claude",
      providerSessionSource: "claude-delivery",
      generation: reg.session.generation + 1,
    });
    expect(ctx.exitCodes).toEqual([]);
  });

  it("handoff final 後に後継 heartbeat が進むと JSON に確認結果を載せる", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      launch: () => ({ ok: true, pid: process.pid }),
      hasSession: () => true,
      getPaneRootPid: () => process.pid,
      killSession: () => true,
    };
    let nowMs = 1_800_000_000_000;
    let orchestratorId = "";
    let sourceSessionId = "";
    ctx.deps.successorLaunchClock = {
      nowMs: () => nowMs,
      sleep: async () => {
        nowMs += 1_000;
        const successor = ctx.deps.store.listOrchestratorSessions(orchestratorId)
          .find((candidate) => candidate.status === "active" && candidate.id !== sourceSessionId);
        if (successor !== undefined) {
          ctx.deps.store.heartbeatOrchestratorSession(
            successor.id,
            successor.generation,
            Math.floor(nowMs / 1_000),
          );
        }
      },
    };
    ctx.deps.handoverSuccessorHeartbeatPoll = { intervalMs: 1, timeoutMs: 2_000 };
    const reg = await register();
    orchestratorId = reg.orchestrator.id;
    sourceSessionId = reg.session.id;
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(true);
    expect(output.successorHeartbeat).toEqual({
      confirmed: true,
      baselineAt: 1_800_000_000,
      observedAt: 1_800_000_001,
      timeoutMs: 2_000,
    });
    expect(output.warnings).toEqual([]);
    expect(ctx.exitCodes).toEqual([]);
  });

  it("後継 heartbeat が進まなくても applied=true のまま JSON に警告と復旧コマンドを載せる", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      launch: () => ({ ok: true, pid: process.pid }),
      hasSession: () => true,
      getPaneRootPid: () => process.pid,
      killSession: () => true,
    };
    ctx.deps.handoverSuccessorHeartbeatPoll = { intervalMs: 1, timeoutMs: 0 };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(true);
    expect(output.successorHeartbeat).toMatchObject({
      confirmed: false,
      warning:
        `後継が heartbeat を張っていません。${ORCHESTRATOR_SESSION_STALE_SECONDS} 秒で stale 化します。`,
      recoveryCommand: expect.stringContaining("hachi orchestrator session bootstrap-heartbeat"),
    });
    expect(output.successorHeartbeat?.recoveryCommand).toContain(output.successorSessionId);
    expect(output.successorHeartbeat?.recoveryCommand).not.toContain("session heartbeat");
    expect(output.warnings).toEqual([
      `後継が heartbeat を張っていません。${ORCHESTRATOR_SESSION_STALE_SECONDS} 秒で stale 化します。`,
    ]);
    expect(ctx.deps.store.getOrchestratorSession(reg.session.id)?.status).toBe("superseded");
    expect(ctx.exitCodes).toEqual([]);
  });

  it("handoff final 後の heartbeat 確認 read が例外でも applied=true の警告へ縮退する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      launch: () => ({ ok: true, pid: process.pid }),
      hasSession: () => true,
      getPaneRootPid: () => process.pid,
      killSession: () => true,
    };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);
    const getSession = ctx.deps.store.getOrchestratorSession.bind(ctx.deps.store);
    vi.spyOn(ctx.deps.store, "getOrchestratorSession").mockImplementation((sessionId) => {
      if (sessionId !== reg.session.id) {
        throw new Error("heartbeat read failed");
      }
      return getSession(sessionId);
    });

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(true);
    expect(output.successorHeartbeat).toMatchObject({
      confirmed: false,
      observedAt: null,
      warning:
        `後継が heartbeat を張っていません。${ORCHESTRATOR_SESSION_STALE_SECONDS} 秒で stale 化します。`,
      recoveryCommand: expect.stringContaining("hachi orchestrator session bootstrap-heartbeat"),
    });
    expect(output.warnings).toEqual([
      `後継が heartbeat を張っていません。${ORCHESTRATOR_SESSION_STALE_SECONDS} 秒で stale 化します。`,
    ]);
    expect(ctx.exitCodes).toEqual([]);
  });

  it.each([
    ["tmuxSession", { tmuxSession: false, process: true, transcriptGrew: true, boardSession: true }],
    ["process", { tmuxSession: true, process: false, transcriptGrew: true, boardSession: true }],
    ["transcriptGrew", { tmuxSession: true, process: true, transcriptGrew: false, boardSession: true }],
    ["boardSession", { tmuxSession: true, process: true, transcriptGrew: true, boardSession: false }],
  ] as const)("liveness の %s が欠けると applied=true のまま lost を返す", async (_missing, expected) => {
    ctx = createTestDeps();
    const { reg, missionId } = await prepareLivenessScenario(expected);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(true);
    expect(output.liveness).toEqual({
      status: "lost",
      checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      detail: {
        ...expected,
        heartbeatAdvanced: false,
      },
    });
    expect(output.recoveryCommand).toBe(
      `hachi orchestrator handover --session ${output.boardSuccessorSessionId} ` +
      `--generation ${output.successorGeneration} --apply`,
    );
    expect(output.recoveryGuidance).toContain("孤児 heartbeat が生きているうちに");
    expect(ctx.exitCodes).toEqual([]);
  });

  it("heartbeatAdvanced=false でも判定対象4点が揃えば confirmed を返す", async () => {
    ctx = createTestDeps();
    const expected = {
      tmuxSession: true,
      process: true,
      transcriptGrew: true,
      boardSession: true,
    };
    const { reg, missionId } = await prepareLivenessScenario(expected);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(true);
    expect(output.liveness).toEqual({
      status: "confirmed",
      checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      detail: {
        ...expected,
        heartbeatAdvanced: false,
      },
    });
    expect(output.recoveryCommand).toBeUndefined();
    expect(ctx.exitCodes).toEqual([]);
  });

  it("lost の人間向け出力は後継 session/generation の復旧コマンドと孤児 heartbeat の順序を示す", async () => {
    ctx = createTestDeps();
    const { reg, missionId } = await prepareLivenessScenario({
      tmuxSession: true,
      process: true,
      transcriptGrew: true,
      boardSession: false,
    });

    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator", "handover",
        "--session", reg.session.id,
        "--generation", String(reg.session.generation),
        "--mission", missionId,
        "--apply",
      ],
      { from: "user" },
    );

    const successor = ctx.deps.store.listOrchestratorSessions(reg.orchestrator.id)
      .find((candidate) => candidate.status === "active");
    expect(successor).toBeDefined();
    const recoveryCommand =
      `hachi orchestrator handover --session ${successor!.id} ` +
      `--generation ${successor!.generation} --apply`;
    expect(ctx.stdout.text()).toContain("liveness: lost");
    expect(ctx.stdout.text()).toContain("孤児 heartbeat が生きているうちに");
    expect(ctx.stdout.text()).toContain(recoveryCommand);
    expect(ctx.exitCodes).toEqual([]);
  });

  it.each(["missing", "malformed", "drift"] as const)(
    "Claude delivery attest前のserver lifetime %sはattest/claim/final mutation 0でexact rollbackする",
    async (reason) => {
      ctx = createTestDeps();
      ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
      let killed = false;
      ctx.deps.tmuxLauncher = {
        ...createBaseLauncherFake(),
        launch: () => ({ ok: true, pid: process.pid }),
        hasSession: () => !killed,
        getPaneRootPid: () => process.pid,
        killSession: () => { killed = true; return true; },
      };
      const reg = await register();
      const missionId = createMissionWithChildren(reg.orchestrator.id);
      successorReadbackTransform = (call, result) =>
        call === 2 ? { ok: false, reason } : result;
      const attest = vi.spyOn(ctx.deps.store, "attestSuccessorLaunch");
      const claim = vi.spyOn(ctx.deps.store, "claimSuccessorLaunchAccept");
      const final = vi.spyOn(ctx.deps.store, "acceptOrchestratorHandoffWithSuccessorLaunch");

      const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

      const launch = ctx.deps.store.listSuccessorLaunches(reg.orchestrator.id)[0]!;
      expect(output).toMatchObject({ applied: false, rolledBack: false, slotStatus: "uncertain" });
      expect(output.failReason).toContain(
        `SUCCESSOR_SERVER_LIFETIME_MISMATCH: slot=${launch.id} expected=known observed=${reason}; ` +
        "attestation/final authority=0; exact rollback required",
      );
      expect(attest).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(final).not.toHaveBeenCalled();
      expect(launch.providerSessionId).toBe("");
      expect(killed).toBe(false);
      expect(ctx.deps.store.getOrchestratorSession(reg.session.id)?.status).toBe("handoff_pending");
      expect(ctx.deps.store.listOrchestratorSessions(reg.orchestrator.id)).toHaveLength(1);
    },
  );

  it("Claude final直前のserver restartはclaim/final mutation 0でexact rollbackする", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    let killed = false;
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      launch: () => ({ ok: true, pid: process.pid }),
      hasSession: () => !killed,
      getPaneRootPid: () => process.pid,
      killSession: () => { killed = true; return true; },
    };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);
    successorReadbackTransform = (call, result) => {
      if (call !== 3 || !result.ok) return result;
      return {
        ok: true,
        value: {
          ...result.value,
          tmuxServerPid: result.value.tmuxServerPid + 1,
          tmuxServerStartTime: result.value.tmuxServerStartTime + 1,
          tmuxServerLifetimeHash: createHash("sha256").update("restarted-lifetime").digest("hex"),
        },
      };
    };
    const claim = vi.spyOn(ctx.deps.store, "claimSuccessorLaunchAccept");
    const final = vi.spyOn(ctx.deps.store, "acceptOrchestratorHandoffWithSuccessorLaunch");

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    const launch = ctx.deps.store.listSuccessorLaunches(reg.orchestrator.id)[0]!;
    expect(output).toMatchObject({ applied: false, rolledBack: false, slotStatus: "uncertain" });
    expect(output.failReason).toContain(
      `SUCCESSOR_SERVER_LIFETIME_MISMATCH: slot=${launch.id} expected=known observed=drift`,
    );
    expect(claim).not.toHaveBeenCalled();
    expect(final).not.toHaveBeenCalled();
    expect(killed).toBe(false);
    expect(ctx.deps.store.getOrchestratorSession(reg.session.id)?.status).toBe("handoff_pending");
    expect(ctx.deps.store.listOrchestratorSessions(reg.orchestrator.id)).toHaveLength(1);
  });

  it("1回目の delivery 失敗を完全補償したら新規 token/nonce/session で2回目を成功させる", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    const deliveryObservations = [
      { userNonceObserved: false, assistantObserved: false },
      { userNonceObserved: true, assistantObserved: true },
    ];
    const deliveryProbe = vi.fn(async () => deliveryObservations.shift()!);
    ctx.deps.handoverDeliveryGateProbe = deliveryProbe;
    ctx.deps.handoverDeliveryPoll = { intervalMs: 1, timeoutMs: 0 };
    const sessionIds = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
    ];
    const launchNonces = ["delivery-retry-launch-1", "delivery-retry-launch-2"];
    const tokens = ["delivery-retry-token-1", "delivery-retry-token-2"];
    ctx.deps.newSessionId = vi.fn(() => sessionIds.shift()!);
    ctx.deps.newHandoffLaunchNonce = vi.fn(() => launchNonces.shift()!);
    const tokenFactory = vi.fn(() => tokens.shift()!);
    ctx.deps.newHandoffToken = tokenFactory;
    const launcher = createRetryableDeliveryLauncher();
    ctx.deps.tmuxLauncher = launcher;
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);
    const armSpy = vi.spyOn(ctx.deps.store, "armSuccessorLaunch");

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(true);
    expect(output.attempts).toHaveLength(2);
    expect(output.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        successorSessionId: "10000000-0000-4000-8000-000000000001",
        slotStatus: "stopped",
        failureReason: expect.stringContaining("送達状態を確認できません"),
      }),
      expect.objectContaining({
        attempt: 2,
        successorSessionId: "10000000-0000-4000-8000-000000000002",
        slotStatus: "succeeded",
        failureReason: null,
      }),
    ]);
    expect(output.successorSessionId).toBe("10000000-0000-4000-8000-000000000002");
    expect(launcher.launchArgsCalls).toHaveLength(2);
    expect(launcher.killSessionCalls).toHaveLength(1);
    expect(tokenFactory).toHaveBeenCalledTimes(2);
    expect(deliveryProbe).toHaveBeenNthCalledWith(1, expect.objectContaining({
      successorSessionId: "10000000-0000-4000-8000-000000000001",
      launchNonce: "delivery-retry-launch-1",
    }));
    expect(deliveryProbe).toHaveBeenNthCalledWith(2, expect.objectContaining({
      successorSessionId: "10000000-0000-4000-8000-000000000002",
      launchNonce: "delivery-retry-launch-2",
    }));
    const tokenHashes = ["delivery-retry-token-1", "delivery-retry-token-2"]
      .map((token) => createHash("sha256").update(token).digest("hex"));
    expect(armSpy.mock.calls.map(([input]) =>
      input.kind === "handoff" ? input.handoffTokenFenceHash : "unexpected-takeover"
    )).toEqual(tokenHashes);
  });

  it("delivery が3回とも失敗したら上限到達を明示して手動ブートストラップを案内する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.handoverDeliveryGateProbe = async () => ({
      userNonceObserved: false,
      assistantObserved: false,
    });
    ctx.deps.handoverDeliveryPoll = { intervalMs: 1, timeoutMs: 0 };
    const sessionIds = [1, 2, 3].map((attempt) =>
      `20000000-0000-4000-8000-${String(attempt).padStart(12, "0")}`
    );
    const tokens = [1, 2, 3].map((attempt) => `delivery-exhausted-token-${attempt}`);
    const launchNonces = [1, 2, 3].map((attempt) => `delivery-exhausted-launch-${attempt}`);
    ctx.deps.newSessionId = vi.fn(() => sessionIds.shift()!);
    const tokenFactory = vi.fn(() => tokens.shift()!);
    ctx.deps.newHandoffToken = tokenFactory;
    ctx.deps.newHandoffLaunchNonce = vi.fn(() => launchNonces.shift()!);
    ctx.deps.tmuxLauncher = createRetryableDeliveryLauncher();
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);
    const armSpy = vi.spyOn(ctx.deps.store, "armSuccessorLaunch");

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output).toMatchObject({
      applied: false,
      rolledBack: true,
      retryPolicy: "new-token-required",
      retryInstruction: "retry-budget-exhausted",
      attemptsExhausted: true,
    });
    expect(output.tokenDisposition).toBe("possibly-consumed");
    expect(output.retryGuidance).toContain('type:"assistant"');
    expect(output.retryGuidance).toContain("手動ブートストラップ");
    expect(output.retryGuidance).not.toContain("そのまま再実行できます");
    expect(output.attempts).toHaveLength(3);
    expect(output.attempts?.map((attempt) => attempt.attempt)).toEqual([1, 2, 3]);
    expect(output.attempts?.every((attempt) => attempt.slotStatus === "stopped")).toBe(true);
    expect(output.attempts?.every((attempt) => attempt.failureReason !== null)).toBe(true);
    expect(tokenFactory).toHaveBeenCalledTimes(3);
    const expectedTokenHashes = [1, 2, 3]
      .map((attempt) => createHash("sha256").update(`delivery-exhausted-token-${attempt}`).digest("hex"));
    expect(armSpy.mock.calls.map(([input]) =>
      input.kind === "handoff" ? input.handoffTokenFenceHash : "unexpected-takeover"
    )).toEqual(expectedTokenHashes);
    expect(ctx.deps.store.getOrchestratorSession(reg.session.id)?.status).toBe("active");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("--max-attempts 1 は delivery unknown を1回だけ補償して再実行案内を返す", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.handoverDeliveryGateProbe = async () => ({
      userNonceObserved: false,
      assistantObserved: false,
    });
    ctx.deps.handoverDeliveryPoll = { intervalMs: 1, timeoutMs: 0 };
    const tokenFactory = vi.fn(() => "single-use-timeout-token");
    ctx.deps.newHandoffToken = tokenFactory;
    const launcher = createRetryableDeliveryLauncher();
    ctx.deps.tmuxLauncher = launcher;
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(
      reg.session.id,
      reg.session.generation,
      missionId,
      ["--apply", "--max-attempts", "1"],
    );

    expect(output.applied).toBe(false);
    expect(output.rolledBack).toBe(true);
    expect(output.delivery?.status).toBe("unknown");
    expect(output.tokenDisposition).toBe("possibly-consumed");
    expect(output.retryPolicy).toBe("new-token-required");
    expect(output.retryInstruction).toBe("rerun-with-new-token");
    expect(output.retryGuidance).toContain("再試行が正規手順");
    expect(output.attemptsExhausted).toBe(false);
    expect(output.attempts).toHaveLength(1);
    expect(launcher.launchArgsCalls).toHaveLength(1);
    expect(tokenFactory).toHaveBeenCalledTimes(1);
    expect(ctx.deps.store.getOrchestratorSession(reg.session.id)?.status).toBe("active");
  });

  it.each([
    {
      reusedField: "handoffToken",
      sessionIds: [
        "30000000-0000-4000-8000-000000000001",
        "30000000-0000-4000-8000-000000000002",
      ],
      tokens: ["same-token", "same-token"],
      launchNonces: ["launch-1", "launch-2"],
    },
    {
      reusedField: "successorSessionId",
      sessionIds: [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000001",
      ],
      tokens: ["token-1", "token-2"],
      launchNonces: ["launch-1", "launch-2"],
    },
    {
      reusedField: "launchNonce",
      sessionIds: [
        "50000000-0000-4000-8000-000000000001",
        "50000000-0000-4000-8000-000000000002",
      ],
      tokens: ["token-1", "token-2"],
      launchNonces: ["same-launch", "same-launch"],
    },
  ])("再試行 plan の $reusedField が前試行と同じなら構造化失敗を返して2回目を起動しない", async ({
    reusedField,
    sessionIds,
    tokens,
    launchNonces,
  }) => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.handoverDeliveryGateProbe = async () => ({
      userNonceObserved: false,
      assistantObserved: false,
    });
    ctx.deps.handoverDeliveryPoll = { intervalMs: 1, timeoutMs: 0 };
    ctx.deps.newSessionId = vi.fn(() => sessionIds.shift()!);
    ctx.deps.newHandoffToken = vi.fn(() => tokens.shift()!);
    ctx.deps.newHandoffLaunchNonce = vi.fn(() => launchNonces.shift()!);
    const launcher = createRetryableDeliveryLauncher();
    ctx.deps.tmuxLauncher = launcher;
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(
      reg.session.id,
      reg.session.generation,
      missionId,
      ["--apply"],
    );

    expect(output).toMatchObject({
      applied: false,
      rolledBack: true,
      retryInstruction: "rerun-with-new-token",
      attemptsExhausted: false,
      slotStatus: "stopped",
    });
    expect(output.failReason).toContain(reusedField);
    expect(output.retryGuidance).toContain("新しい token");
    expect(output.attempts).toHaveLength(1);
    expect(launcher.launchArgsCalls).toHaveLength(1);
    expect(ctx.deps.store.listSuccessorLaunches(reg.orchestrator.id)).toHaveLength(1);
    expect(ctx.deps.store.getOrchestratorSession(reg.session.id)?.status).toBe("active");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it.each([
    {
      reusedField: "handoffToken",
      sessionIds: [
        "60000000-0000-4000-8000-000000000001",
        "60000000-0000-4000-8000-000000000002",
        "60000000-0000-4000-8000-000000000003",
      ],
      tokens: ["cycle-token-a", "cycle-token-b", "cycle-token-a"],
      launchNonces: ["cycle-launch-1", "cycle-launch-2", "cycle-launch-3"],
    },
    {
      reusedField: "successorSessionId",
      sessionIds: [
        "70000000-0000-4000-8000-000000000001",
        "70000000-0000-4000-8000-000000000002",
        "70000000-0000-4000-8000-000000000001",
      ],
      tokens: ["cycle-token-1", "cycle-token-2", "cycle-token-3"],
      launchNonces: ["cycle-launch-1", "cycle-launch-2", "cycle-launch-3"],
    },
    {
      reusedField: "launchNonce",
      sessionIds: [
        "80000000-0000-4000-8000-000000000001",
        "80000000-0000-4000-8000-000000000002",
        "80000000-0000-4000-8000-000000000003",
      ],
      tokens: ["cycle-token-1", "cycle-token-2", "cycle-token-3"],
      launchNonces: ["cycle-launch-a", "cycle-launch-b", "cycle-launch-a"],
    },
  ])("再試行 plan の $reusedField が A → B → A と循環したら3回目を起動しない", async ({
    reusedField,
    sessionIds,
    tokens,
    launchNonces,
  }) => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.handoverDeliveryGateProbe = async () => ({
      userNonceObserved: false,
      assistantObserved: false,
    });
    ctx.deps.handoverDeliveryPoll = { intervalMs: 1, timeoutMs: 0 };
    ctx.deps.newSessionId = vi.fn(() => sessionIds.shift()!);
    ctx.deps.newHandoffToken = vi.fn(() => tokens.shift()!);
    ctx.deps.newHandoffLaunchNonce = vi.fn(() => launchNonces.shift()!);
    const launcher = createRetryableDeliveryLauncher();
    ctx.deps.tmuxLauncher = launcher;
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(
      reg.session.id,
      reg.session.generation,
      missionId,
      ["--apply"],
    );

    expect(output).toMatchObject({
      applied: false,
      rolledBack: true,
      retryPolicy: "new-token-required",
      retryInstruction: "rerun-with-new-token",
      attemptsExhausted: false,
      slotStatus: "stopped",
    });
    expect(output.failReason).toContain(reusedField);
    expect(output.retryGuidance).toContain("新しい token");
    expect(output.attempts).toHaveLength(2);
    expect(output.attempts?.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(launcher.launchArgsCalls).toHaveLength(2);
    expect(ctx.deps.store.listSuccessorLaunches(reg.orchestrator.id)).toHaveLength(2);
    expect(ctx.deps.store.getOrchestratorSession(reg.session.id)?.status).toBe("active");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("pane PID が残っている間は再試行せず fail-closed に停止する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.handoverDeliveryGateProbe = async () => ({
      userNonceObserved: false,
      assistantObserved: false,
    });
    ctx.deps.handoverDeliveryPoll = { intervalMs: 1, timeoutMs: 0 };
    ctx.deps.successorLaunchStopPoll = { intervalMs: 1, timeoutMs: 3 };
    const launcher = createRetryableDeliveryLauncher();
    launcher.isPaneProcessAlive = (pid: number) => pid === process.pid;
    ctx.deps.tmuxLauncher = launcher;
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output).toMatchObject({
      applied: false,
      rolledBack: false,
      slotStatus: "uncertain",
      retryInstruction: "do-not-retry",
      attemptsExhausted: false,
    });
    expect(output.failReason).toContain("pane PID");
    expect(output.attempts).toHaveLength(1);
    expect(launcher.launchArgsCalls).toHaveLength(1);
    expect(ctx.deps.store.getOrchestratorSession(reg.session.id)?.status).toBe("handoff_pending");
    expect(ctx.exitCodes).toEqual([2]);
  });

  it.each(["0", "6", "not-a-number"])("--max-attempts %s は拒否する", async (value) => {
    ctx = createTestDeps();

    await expect(buildProgram(ctx.deps).parseAsync(
      ["orchestrator", "handover", "--max-attempts", value],
      { from: "user" },
    )).rejects.toThrow();
  });

  it("delivery attest 後の final conflict は stop_pending を経て exact rollback する", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    let killed = false;
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      launch: () => ({ ok: true, pid: process.pid }),
      hasSession: () => !killed,
      getPaneRootPid: () => process.pid,
      killSession: () => {
        killed = true;
        return true;
      },
    };
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);
    vi.spyOn(ctx.deps.store, "acceptOrchestratorHandoffWithSuccessorLaunch")
      .mockImplementation(() => {
        throw new Error("accept済み競合");
      });

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(false);
    expect(output.rolledBack).toBe(true);
    expect(output.slotStatus).toBe("stopped");
    expect(output.failReason).toContain("accept済み競合");
    expect(ctx.deps.store.getOrchestratorSession(reg.session.id)?.status).toBe("active");
    expect(ctx.exitCodes).toContain(1);
  });

  it("caller消失後のattested slotはattestation expiry境界まで進行中としてterminal化しない", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    ctx = createTestDeps();
    const launcher = createSuccessLauncher();
    ctx.deps.tmuxLauncher = launcher;
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);
    const armedAt = Math.floor(Date.now() / 1_000);
    const plannedTmuxSession = `hachi-orch-${reg.orchestrator.id.slice(0, 8)}-attested-crash`;
    const ownerNonceHash = createHash("sha256").update("attested-crash-owner").digest("hex");
    const hookDefinitionHash = createHash("sha256")
      .update("hachi-successor:claude-delivery-protocol:v1").digest("hex");
    const hookExecutableHash = createHash("sha256")
      .update("hachi-successor:claude-session-id-argv:v1").digest("hex");
    const tmuxServerLifetimeHash = createHash("sha256")
      .update("attested-crash-lifetime").digest("hex");
    const armed = ctx.deps.store.armSuccessorLaunch({
      orchestratorId: reg.orchestrator.id,
      targetProvider: "claude",
      sourceSessionId: reg.session.id,
      sourceGeneration: reg.session.generation,
      canonicalCwd: sharedTmpCwd,
      hostId: ctx.deps.currentHostId(),
      launchNonceHash: createHash("sha256").update("attested-crash-launch").digest("hex"),
      plannedTmuxSession,
      hookDefinitionHash,
      hookExecutableHash,
      runtimeDeadlineAt: armedAt + 15,
      attestationDeadlineAt: armedAt + 30,
      kind: "handoff",
      handoffTokenFenceHash: createHash("sha256").update("attested-crash-token").digest("hex"),
      handoffExpiresAt: armedAt + 600,
      now: armedAt,
    });
    const bound = ctx.deps.store.bindSuccessorLaunchRuntime({
      slotId: armed.id,
      expectedRevision: armed.revision,
      observedCanonicalCwd: sharedTmpCwd,
      observedHostId: ctx.deps.currentHostId(),
      tmuxSession: plannedTmuxSession,
      tmuxPane: "%78",
      panePid: process.pid,
      processGroupId: 778,
      tmuxSocketPath: "/tmp/tmux-attested-crash/default",
      tmuxServerPid: 779,
      tmuxServerStartTime: 1_800_000_002,
      tmuxServerLifetimeHash,
      ownerNonceHash,
      hookDefinitionHash,
      hookExecutableHash,
      now: armedAt + 1,
    });
    const issuedAt = bound.attestationDeadlineAt;
    const attested = ctx.deps.store.attestSuccessorLaunch({
      providerSessionId: "claude-attested-crash-successor",
      providerSessionSource: "claude-delivery",
      source: "delivery",
      canonicalCwd: sharedTmpCwd,
      hostId: ctx.deps.currentHostId(),
      tmuxSession: plannedTmuxSession,
      tmuxPane: "%78",
      panePid: process.pid,
      processGroupId: 778,
      tmuxSocketPath: "/tmp/tmux-attested-crash/default",
      tmuxServerPid: 779,
      tmuxServerStartTime: 1_800_000_002,
      tmuxServerLifetimeHash,
      ownerNonceHash,
      hookDefinitionHash,
      hookExecutableHash,
      now: issuedAt,
    });
    if (attested === null) throw new Error("test attestation に失敗しました");
    if (attested.launch.attestationExpiresAt === null) {
      throw new Error("test attestation expiry が保存されませんでした");
    }
    vi.setSystemTime(attested.launch.attestationExpiresAt * 1_000);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output).toMatchObject({
      recovery: true,
      blocked: true,
      slotStatus: "attested",
    });
    expect(ctx.deps.store.getSuccessorLaunch(attested.launch.id)?.status).toBe("attested");
    expect(launcher.killSessionCalls).toEqual([]);
    expect(ctx.exitCodes).toEqual([2]);
  });

  it("kill成功後にPGIDだけ残ったuncertain rowは再起動時に保存済み証拠とfresh三点だけで回復する", async () => {
    ctx = createTestDeps();
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);
    const now = Math.floor(Date.now() / 1_000) - 100;
    const plannedTmuxSession = `hachi-orch-${reg.orchestrator.id.slice(0, 8)}-durable-recovery`;
    const ownerNonce = "durable-recovery-owner";
    const ownerNonceHash = createHash("sha256").update(ownerNonce).digest("hex");
    const hookDefinitionHash = createHash("sha256")
      .update("hachi-successor:claude-delivery-protocol:v1").digest("hex");
    const hookExecutableHash = createHash("sha256")
      .update("hachi-successor:claude-session-id-argv:v1").digest("hex");
    const armed = ctx.deps.store.armSuccessorLaunch({
      orchestratorId: reg.orchestrator.id,
      targetProvider: "claude",
      sourceSessionId: reg.session.id,
      sourceGeneration: reg.session.generation,
      canonicalCwd: sharedTmpCwd,
      hostId: ctx.deps.currentHostId(),
      launchNonceHash: createHash("sha256").update("durable-recovery-launch").digest("hex"),
      plannedTmuxSession,
      hookDefinitionHash,
      hookExecutableHash,
      runtimeDeadlineAt: now + 15,
      attestationDeadlineAt: now + 30,
      kind: "handoff",
      handoffTokenFenceHash: createHash("sha256").update("durable-recovery-token").digest("hex"),
      handoffExpiresAt: now + 600,
      now,
    });
    const bound = ctx.deps.store.bindSuccessorLaunchRuntime({
      slotId: armed.id,
      expectedRevision: armed.revision,
      observedCanonicalCwd: sharedTmpCwd,
      observedHostId: ctx.deps.currentHostId(),
      tmuxSession: plannedTmuxSession,
      tmuxPane: "%77",
      panePid: process.pid,
      processGroupId: 777,
      tmuxSocketPath: "/tmp/tmux-durable-recovery/default",
      tmuxServerPid: 778,
      tmuxServerStartTime: 1_800_000_001,
      tmuxServerLifetimeHash: createHash("sha256").update("durable-recovery-lifetime").digest("hex"),
      ownerNonceHash,
      hookDefinitionHash,
      hookExecutableHash,
      now: now + 1,
    });
    const pending = ctx.deps.store.markSuccessorLaunchStopPending({
      slotId: bound.id,
      expectedRevision: bound.revision,
      expectedStatus: "runtime_bound",
      error: "previous caller crashed",
      replacementHandoffTokenHash: createHash("sha256").update("replacement-token").digest("hex"),
      now: now + 2,
    });
    const uncertain = ctx.deps.store.recordSuccessorLaunchStop({
      slotId: pending.launch.id,
      expectedRevision: pending.launch.revision,
      stopFenceHash: createHash("sha256").update(pending.stopFence).digest("hex"),
      killOwnerReadbackHash: ownerNonceHash,
      evidence: {
        ownerMatched: true,
        ownerReadbackAt: now + 3,
        killResult: "succeeded",
        tmuxSessionAbsent: true,
        panePidAbsent: true,
        processGroupAbsent: false,
        observedAt: now + 3,
      },
      now: now + 3,
    });
    expect(uncertain.status).toBe("uncertain");

    let launchCalled = false;
    let ownerReadbackCalled = false;
    let killCalled = false;
    ctx.deps.tmuxLauncher = {
      ...createBaseLauncherFake(),
      launch: () => {
        launchCalled = true;
        return { ok: true, pid: process.pid };
      },
      hasSession: () => false,
      getPaneRootPid: () => process.pid,
      getSessionOwnerNonce: () => {
        ownerReadbackCalled = true;
        return null;
      },
      killSession: () => {
        killCalled = true;
        return false;
      },
      isPaneProcessAlive: () => false,
      isProcessGroupAlive: () => false,
    };

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.recovery).toBe(true);
    expect(output.rolledBack).toBe(true);
    expect(output.slotStatus).toBe("stopped");
    expect(launchCalled).toBe(false);
    expect(ownerReadbackCalled).toBe(false);
    expect(killCalled).toBe(false);
    expect(ctx.deps.store.getSuccessorLaunch(armed.id)).toMatchObject({
      status: "stopped",
      killOwnerReadbackHash: ownerNonceHash,
      stopEvidence: {
        ownerMatched: true,
        ownerReadbackAt: now + 3,
        killResult: "succeeded",
        tmuxSessionAbsent: true,
        panePidAbsent: true,
        processGroupAbsent: true,
      },
    });
    expect(ctx.deps.store.getOrchestratorSession(reg.session.id)?.status).toBe("active");
  });

  it("handoff-cancel は停止確認宣言と token hash CAS 付きで宙吊り session を active へ戻す", async () => {
    ctx = createTestDeps();
    const reg = await register();
    const tokenHash = "a".repeat(64);
    ctx.deps.store.prepareOrchestratorHandoff(
      reg.session.id,
      reg.session.generation,
      tokenHash,
      Math.floor(Date.now() / 1_000) + 600,
    );

    await buildProgram(ctx.deps).parseAsync(
      [
        "orchestrator", "session", "handoff-cancel", reg.session.id,
        "--generation", String(reg.session.generation),
        "--token-hash", tokenHash,
        "--confirm-successor-stopped",
        "--json",
      ],
      { from: "user" },
    );

    const session = ctx.deps.store.getOrchestratorSession(reg.session.id);
    expect(session?.status).toBe("active");
    expect(session?.handoffTokenHash).toBe("");
    expect(ctx.exitCodes).toEqual([]);
  });

  // ===================================================================
  // 要件2: ロールバックは process-tree の停止を確認してから完了する（session 消滅だけでは不十分）
  // ===================================================================

  it("process group が数回の poll 後に消滅した場合のみ停止確認が完了しロールバックする", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.handoverDeliveryGateProbe = async () => ({
      userNonceObserved: false,
      assistantObserved: false,
    });
    ctx.deps.handoverDeliveryPoll = { intervalMs: 1, timeoutMs: 0 };
    const launcher = createDelayedGroupStopLauncher(4);
    ctx.deps.tmuxLauncher = launcher;
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(
      reg.session.id,
      reg.session.generation,
      missionId,
      ["--apply", "--max-attempts", "1"],
    );

    expect(output.applied).toBe(false);
    expect(output.rolledBack).toBe(true);
    expect(launcher.killSessionCalls.length).toBe(1);
    // isProcessGroupAlive が複数回 poll されてから停止確認が完了している（即座に true 判定していない証拠）
    expect(launcher.isProcessGroupAliveCallCount).toBeGreaterThanOrEqual(4);
    const session = ctx.deps.store.getOrchestratorSession(reg.session.id)!;
    expect(session.status).toBe("active");
    expect(ctx.exitCodes).toContain(1);
  });

  it("process group が停止確認 timeout 以内に消滅しない場合、DB は handoff_pending のまま手動対応を促す", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.handoverDeliveryGateProbe = async () => ({
      userNonceObserved: false,
      assistantObserved: false,
    });
    ctx.deps.handoverDeliveryPoll = { intervalMs: 1, timeoutMs: 0 };
    ctx.deps.successorLaunchStopPoll = { intervalMs: 1, timeoutMs: 3 };
    const cancelSpy = vi.spyOn(ctx.deps.store, "cancelOrchestratorHandoff");
    const launcher = createNeverStoppingGroupLauncher();
    ctx.deps.tmuxLauncher = launcher;
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(false);
    // 停止を確認できない場合は rolledBack:true には絶対にしない
    expect(output.rolledBack).toBe(false);
    expect(output.slotStatus).toBe("uncertain");
    expect(output.failReason).toContain("process group");
    expect(output.attempts).toHaveLength(1);
    expect(output.attempts?.[0]?.slotStatus).toBe("uncertain");
    expect(output.retryInstruction).toBe("do-not-retry");
    expect(output.retryGuidance).toContain("再試行してはいけません");
    // 所有権は確認できているため kill は試みる（が、process group が残り続けているため停止確認は完了しない）
    expect(launcher.killSessionCalls.length).toBe(1);
    expect(cancelSpy).not.toHaveBeenCalled();
    const session = ctx.deps.store.getOrchestratorSession(reg.session.id)!;
    expect(session.status).toBe("handoff_pending");
    expect(ctx.exitCodes).toContain(2);
  });

  // ===================================================================
  // 要件4: 所有権 nonce が一致しない場合は kill を一切試みない（TOCTOU 対策）
  // ===================================================================

  it("所有権 nonce が一致しない場合、kill を試みずロールバックせず手動対応を促す（TOCTOU 対策）", async () => {
    ctx = createTestDeps();
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.handoverDeliveryGateProbe = async () => ({
      userNonceObserved: false,
      assistantObserved: false,
    });
    ctx.deps.handoverDeliveryPoll = { intervalMs: 1, timeoutMs: 0 };
    const cancelSpy = vi.spyOn(ctx.deps.store, "cancelOrchestratorHandoff");
    const launcher = createHijackedOwnershipLauncher();
    ctx.deps.tmuxLauncher = launcher;
    const reg = await register();
    const missionId = createMissionWithChildren(reg.orchestrator.id);

    const output = await runHandover(reg.session.id, reg.session.generation, missionId, ["--apply"]);

    expect(output.applied).toBe(false);
    expect(output.rolledBack).toBe(false);
    expect(output.failReason).toContain("所有権を確認できない");
    // 所有権を証明できないため kill は一切試みない
    expect(launcher.killSessionCalls.length).toBe(0);
    expect(cancelSpy).not.toHaveBeenCalled();
    const session = ctx.deps.store.getOrchestratorSession(reg.session.id)!;
    expect(session.status).toBe("handoff_pending");
    expect(ctx.exitCodes).toContain(2);
  });
});
