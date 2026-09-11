// web UI の healthz を監視し、launchd on-demand 停止時に自己修復する stage（docs/contract.md §30）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { probeBridgeIdentity, type BridgeIdentityFailure, type BridgeIdentityResult } from "@hachi/adapters";
import { PROVIDERS, redactText } from "@hachi/core";
import type { Provider, Stage, StageDeps, StageResult } from "@hachi/core";
import { SUPERVISOR_ACTOR } from "../constants.js";
import { sendOperationalNotification } from "./notify.js";

const HEALTHZ_URL = "http://127.0.0.1:9131/healthz";
const HEALTHZ_TIMEOUT_MS = 3_000;
const KICKSTART_COOLDOWN_MS = 5 * 60 * 1_000;
const REQUIRED_CONSECUTIVE_FAILURES = 2;
const REQUIRED_BRIDGE_SOFT_FAILURES = 4;
const LAUNCHCTL_COMMAND = "launchctl";
const WEB_LAUNCHD_LABEL = "com.hachi-kanban.web";
const AUTOHEAL_KILL_SWITCH = "webwatch-autoheal.disabled";

export type WebwatchFailureKind = "network error" | "timeout" | "non-2xx" | "invalid body";

export type WebwatchFetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface WebwatchExecResult {
  status: number | null;
  error?: Error;
  stderr?: string | Buffer;
}

export type WebwatchExecFn = (
  command: string,
  args: readonly string[],
) => WebwatchExecResult | Promise<WebwatchExecResult>;

export type WebwatchNowFn = () => number;
export type BridgewatchProbeFn = (provider: Provider, deps: StageDeps) => Promise<BridgeIdentityResult>;

export interface BridgewatchAlert {
  provider: Provider;
  failure: BridgeIdentityFailure;
  consecutiveFailures: number;
}

export interface BridgewatchNotifyResult {
  attempted: boolean;
  sent: boolean;
}

export type BridgewatchNotifyFn = (
  deps: StageDeps,
  alert: BridgewatchAlert,
) => Promise<BridgewatchNotifyResult>;

export interface WebwatchPortListener {
  pid: number;
  command: string;
  name: string;
}

export type WebwatchListPortListenersFn = (port: number) => Promise<WebwatchPortListener[]> | WebwatchPortListener[];
export type WebwatchKillPidFn = (pid: number, signal: "SIGTERM") => Promise<void> | void;

export interface BridgewatchAutohealAlert {
  provider: Provider;
  port: number;
  pid: number;
  command: string;
}

export type BridgewatchAutohealNotifyFn = (
  deps: StageDeps,
  alert: BridgewatchAutohealAlert,
) => Promise<BridgewatchNotifyResult>;

export interface WebwatchStageOptions {
  fetchFn: WebwatchFetchFn;
  execFn: WebwatchExecFn;
  nowFn: WebwatchNowFn;
  bridgeProbeFn?: BridgewatchProbeFn;
  notifyFn?: BridgewatchNotifyFn;
  listPortListenersFn?: WebwatchListPortListenersFn;
  killPidFn?: WebwatchKillPidFn;
  autohealNotifyFn?: BridgewatchAutohealNotifyFn;
}

interface HealthFailure {
  kind: WebwatchFailureKind;
  detail: string;
}

type HealthResult = { ok: true } | { ok: false; failure: HealthFailure };

interface HealthzBody {
  ok: true;
  taskCount: number;
}

function defaultFetchFn(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

function defaultExecFn(command: string, args: readonly string[]): WebwatchExecResult {
  return spawnSync(command, [...args], { encoding: "utf8" });
}

function defaultNowFn(): number {
  return Date.now();
}

function describeBridgeFailure(provider: Provider, failure: BridgeIdentityFailure): string {
  const suspicion = failure.suspectPortHijack ? " port-hijack-suspected" : "";
  return `${provider} bridge identity failure: ${failure.kind} (${failure.detail})${suspicion}`;
}

function requiredBridgeFailures(failure: BridgeIdentityFailure): number {
  if (failure.kind === "timeout" || failure.kind === "network") {
    return REQUIRED_BRIDGE_SOFT_FAILURES;
  }
  return REQUIRED_CONSECUTIVE_FAILURES;
}

async function defaultBridgeProbeFn(provider: Provider, deps: StageDeps): Promise<BridgeIdentityResult> {
  return probeBridgeIdentity(deps.env.bridges[provider]);
}

function parseLsofFieldOutput(output: string): WebwatchPortListener[] {
  const listeners: WebwatchPortListener[] = [];
  let currentPid: number | null = null;
  let currentCommand = "";

  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.length < 2) {
      continue;
    }
    const field = rawLine.slice(0, 1);
    const value = rawLine.slice(1);
    if (field === "p") {
      const pid = Number.parseInt(value, 10);
      currentPid = Number.isSafeInteger(pid) && pid > 0 ? pid : null;
      currentCommand = "";
      continue;
    }
    if (field === "c") {
      currentCommand = value;
      continue;
    }
    if (field === "n" && currentPid !== null) {
      listeners.push({ pid: currentPid, command: currentCommand, name: value });
    }
  }

  return listeners;
}

function defaultListPortListenersFn(port: number): WebwatchPortListener[] {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pcn"], {
    encoding: "utf8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return [];
  }
  return parseLsofFieldOutput(result.stdout);
}

function defaultKillPidFn(pid: number, signal: "SIGTERM"): void {
  process.kill(pid, signal);
}

async function defaultNotifyFn(deps: StageDeps, alert: BridgewatchAlert): Promise<BridgewatchNotifyResult> {
  const body = [
    describeBridgeFailure(alert.provider, alert.failure),
    `consecutiveFailures=${alert.consecutiveFailures}`,
  ].join("\n");
  return sendOperationalNotification(deps, {
    id: `bridgewatch:${alert.provider}`,
    title: `${alert.provider} bridge identity warning`,
    body,
  });
}

async function defaultAutohealNotifyFn(
  deps: StageDeps,
  alert: BridgewatchAutohealAlert,
): Promise<BridgewatchNotifyResult> {
  const body = [
    `${alert.provider} bridge port hijack auto-healed`,
    `port=${alert.port}`,
    `killedPid=${alert.pid}`,
    `command=${alert.command}`,
  ].join("\n");
  return sendOperationalNotification(deps, {
    id: `bridge-hygiene:autoheal:${alert.provider}`,
    title: `${alert.provider} bridge autoheal`,
    body,
  });
}

function isHealthzBody(value: unknown): value is HealthzBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const fields = value as Record<string, unknown>;
  return fields["ok"] === true && typeof fields["taskCount"] === "number" && Number.isFinite(fields["taskCount"]);
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    return redactText(error.message);
  }
  return redactText(String(error));
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function bridgePort(provider: Provider, deps: StageDeps): number | null {
  try {
    const url = new URL(deps.env.bridges[provider].url);
    const port = Number.parseInt(url.port, 10);
    if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) {
      return port;
    }
  } catch {
    return null;
  }
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWildcardBind(listener: WebwatchPortListener, port: number): boolean {
  return new RegExp(`(^|[\\s:])\\*:${port}(\\s|$|\\()`).test(listener.name);
}

function isSpecificLoopbackBind(listener: WebwatchPortListener, port: number): boolean {
  const escapedPort = escapeRegex(String(port));
  return (
    new RegExp(`(^|\\s)127\\.0\\.0\\.1:${escapedPort}(\\s|$|\\()`).test(listener.name) ||
    new RegExp(`(^|\\s)\\[::1\\]:${escapedPort}(\\s|$|\\()`).test(listener.name)
  );
}

function commandHead(command: string): string {
  const trimmed = command.trim();
  if (trimmed === "") {
    return "unknown";
  }
  return redactText(trimmed.split(/\s+/)[0] ?? "unknown").slice(0, 80);
}

async function checkHealth(fetchFn: WebwatchFetchFn): Promise<HealthResult> {
  let response: Response;
  try {
    response = await fetchFn(HEALTHZ_URL, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      return { ok: false, failure: { kind: "timeout", detail: "healthz request timed out" } };
    }
    return { ok: false, failure: { kind: "network error", detail: errorDetail(error) } };
  }

  if (!response.ok) {
    return { ok: false, failure: { kind: "non-2xx", detail: `status=${response.status}` } };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, failure: { kind: "invalid body", detail: "JSON parse failed" } };
  }

  if (!isHealthzBody(body)) {
    return { ok: false, failure: { kind: "invalid body", detail: "schema mismatch" } };
  }

  return { ok: true };
}

function launchdTarget(): string | null {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return null;
  }
  return `gui/${uid}/${WEB_LAUNCHD_LABEL}`;
}

function warnKickstartFailure(deps: StageDeps, result: WebwatchExecResult): void {
  if (result.error === undefined && result.status === 0) {
    return;
  }

  const fields: Record<string, unknown> = { status: result.status };
  if (result.error !== undefined) {
    fields["error"] = redactText(result.error.message);
  }
  if (typeof result.stderr === "string" && result.stderr.trim() !== "") {
    fields["stderr"] = redactText(result.stderr).slice(0, 500);
  }
  deps.logger.warn("webwatch: launchctl kickstart に失敗しました", fields);
}

export function createWebwatchStage(options: WebwatchStageOptions): Stage {
  let consecutiveFailures = 0;
  let lastKickstartAtMs: number | null = null;
  const bridgeFailures: Record<Provider, number> = { codex: 0, claude: 0 };
  const bridgeAlerted: Record<Provider, boolean> = { codex: false, claude: false };
  const killedPids = new Set<number>();
  const bridgeProbeFn = options.bridgeProbeFn ?? defaultBridgeProbeFn;
  const notifyFn = options.notifyFn ?? defaultNotifyFn;
  const listPortListenersFn = options.listPortListenersFn ?? defaultListPortListenersFn;
  const killPidFn = options.killPidFn ?? defaultKillPidFn;
  const autohealNotifyFn = options.autohealNotifyFn ?? defaultAutohealNotifyFn;

  function recordAutohealEvent(deps: StageDeps, alert: BridgewatchAutohealAlert): void {
    const task = deps.store
      .listInProgress()
      .find((candidate) => candidate.blockReason.startsWith(`${alert.provider}-in-progress:`));
    if (task === undefined) {
      return;
    }
    deps.store.addEvent(task.id, "bridge_autoheal", SUPERVISOR_ACTOR, {
      provider: alert.provider,
      port: alert.port,
      killedPid: alert.pid,
      command: alert.command,
    });
  }

  async function probeBridgeAfterAutoheal(provider: Provider, deps: StageDeps): Promise<BridgeIdentityResult> {
    try {
      return await bridgeProbeFn(provider, deps);
    } catch (error) {
      return {
        ok: false,
        failure: {
          kind: "network",
          detail: errorDetail(error),
          suspectPortHijack: false,
        },
      };
    }
  }

  async function tryAutohealBridge(
    provider: Provider,
    deps: StageDeps,
    failure: BridgeIdentityFailure,
    notes: string[],
  ): Promise<{ healed: boolean; actions: number }> {
    if (!failure.suspectPortHijack) {
      return { healed: false, actions: 0 };
    }
    if (existsSync(join(deps.env.home, AUTOHEAL_KILL_SWITCH))) {
      notes.push(`${provider} bridge autoheal skipped: kill-switch`);
      return { healed: false, actions: 0 };
    }

    const port = bridgePort(provider, deps);
    if (port === null) {
      notes.push(`${provider} bridge autoheal skipped: bridge port unavailable`);
      return { healed: false, actions: 0 };
    }

    let listeners: WebwatchPortListener[];
    try {
      listeners = await listPortListenersFn(port);
    } catch (error) {
      deps.logger.warn("webwatch: bridge autoheal の listener 取得に失敗しました", {
        provider,
        port,
        error: errorDetail(error),
      });
      notes.push(`${provider} bridge autoheal skipped: listener lookup failed`);
      return { healed: false, actions: 0 };
    }

    const wildcardPids = new Set(listeners.filter((listener) => isWildcardBind(listener, port)).map((listener) => listener.pid));
    if (wildcardPids.size === 0) {
      notes.push(`${provider} bridge autoheal skipped: wildcard listener missing`);
      return { healed: false, actions: 0 };
    }

    const specificPids = [
      ...new Set(
        listeners
          .filter((listener) => isSpecificLoopbackBind(listener, port) && !wildcardPids.has(listener.pid))
          .map((listener) => listener.pid),
      ),
    ];
    if (specificPids.length !== 1) {
      notes.push(`${provider} bridge autoheal skipped: specific listener count=${specificPids.length}`);
      return { healed: false, actions: 0 };
    }

    const pid = specificPids[0];
    if (pid === undefined || killedPids.has(pid)) {
      notes.push(`${provider} bridge autoheal skipped: pid already killed`);
      return { healed: false, actions: 0 };
    }

    const listener = listeners.find((candidate) => candidate.pid === pid && isSpecificLoopbackBind(candidate, port));
    const command = commandHead(listener?.command ?? "");

    try {
      await killPidFn(pid, "SIGTERM");
      killedPids.add(pid);
      notes.push(`${provider} bridge autoheal SIGTERM pid=${pid} command=${command}`);
    } catch (error) {
      deps.logger.warn("webwatch: bridge autoheal の SIGTERM に失敗しました", {
        provider,
        port,
        pid,
        error: errorDetail(error),
      });
      notes.push(`${provider} bridge autoheal kill failed`);
      return { healed: false, actions: 0 };
    }

    const reprobe = await probeBridgeAfterAutoheal(provider, deps);
    if (!reprobe.ok) {
      notes.push(`${provider} bridge autoheal unrecovered: ${describeBridgeFailure(provider, reprobe.failure)}`);
      return { healed: false, actions: 1 };
    }

    const alert: BridgewatchAutohealAlert = { provider, port, pid, command };
    recordAutohealEvent(deps, alert);
    try {
      const notifyResult = await autohealNotifyFn(deps, alert);
      notes.push(`${provider} bridge autoheal notify: attempted=${notifyResult.attempted} sent=${notifyResult.sent}`);
    } catch (error) {
      deps.logger.warn("webwatch: bridge autoheal 通知に失敗しました", { provider, error: errorDetail(error) });
      notes.push(`${provider} bridge autoheal notify failed`);
    }
    bridgeFailures[provider] = 0;
    bridgeAlerted[provider] = false;
    notes.push(`${provider} bridge autoheal recovered`);
    return { healed: true, actions: 1 };
  }

  async function runBridgewatch(deps: StageDeps, apply: boolean, notes: string[]): Promise<number> {
    let actions = 0;

    for (const provider of PROVIDERS) {
      let identity: BridgeIdentityResult;
      try {
        identity = await bridgeProbeFn(provider, deps);
      } catch (error) {
        identity = {
          ok: false,
          failure: {
            kind: "network",
            detail: errorDetail(error),
            suspectPortHijack: false,
          },
        };
      }

      if (identity.ok) {
        if (bridgeFailures[provider] > 0) {
          notes.push(`${provider} bridge identity recovered: 失敗カウンタをリセットしました`);
        }
        bridgeFailures[provider] = 0;
        bridgeAlerted[provider] = false;
        continue;
      }

      bridgeFailures[provider] += 1;
      const failureText = describeBridgeFailure(provider, identity.failure);
      deps.logger.warn("webwatch: bridge identity に失敗しました", {
        provider,
        kind: identity.failure.kind,
        detail: identity.failure.detail,
        suspectPortHijack: identity.failure.suspectPortHijack,
        consecutiveFailures: bridgeFailures[provider],
      });
      notes.push(`${failureText} consecutive=${bridgeFailures[provider]}`);

      if (bridgeFailures[provider] < requiredBridgeFailures(identity.failure)) {
        continue;
      }

      if (apply) {
        const autoheal = await tryAutohealBridge(provider, deps, identity.failure, notes);
        actions += autoheal.actions;
        if (autoheal.healed) {
          continue;
        }
      }

      if (bridgeAlerted[provider]) {
        continue;
      }

      const alert: BridgewatchAlert = {
        provider,
        failure: identity.failure,
        consecutiveFailures: bridgeFailures[provider],
      };

      if (!apply) {
        notes.push(`dry-run: ${provider} bridge identity warning を通知予定`);
        continue;
      }

      try {
        const notifyResult = await notifyFn(deps, alert);
        if (notifyResult.attempted) {
          bridgeAlerted[provider] = true;
          actions += 1;
        }
        notes.push(
          `${provider} bridge identity warning notify: attempted=${notifyResult.attempted} sent=${notifyResult.sent}`,
        );
      } catch (error) {
        deps.logger.warn("webwatch: bridge identity warning 通知に失敗しました", {
          provider,
          error: errorDetail(error),
        });
        notes.push(`${provider} bridge identity warning notify failed`);
      }
    }

    return actions;
  }

  return {
    name: "webwatch",

    async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
      void now; // webwatch はテスト注入された nowFn をクールダウン判定に使う。
      const notes: string[] = [];
      let actions = 0;
      const health = await checkHealth(options.fetchFn);

      if (health.ok) {
        if (consecutiveFailures > 0) {
          notes.push("healthz recovered: 失敗カウンタをリセットしました");
        }
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        deps.logger.warn("webwatch: healthz に失敗しました", {
          kind: health.failure.kind,
          detail: health.failure.detail,
          consecutiveFailures,
        });
        notes.push(
          `healthz failure: ${health.failure.kind} (${health.failure.detail}) consecutive=${consecutiveFailures}`,
        );

        if (consecutiveFailures >= REQUIRED_CONSECUTIVE_FAILURES) {
          const currentMs = options.nowFn();
          let canKickstart = true;
          if (lastKickstartAtMs !== null) {
            const elapsedMs = currentMs - lastKickstartAtMs;
            if (elapsedMs < KICKSTART_COOLDOWN_MS) {
              const remainingSec = Math.ceil((KICKSTART_COOLDOWN_MS - elapsedMs) / 1_000);
              notes.push(`kickstart cooldown: 残り${remainingSec}秒のため抑制しました`);
              canKickstart = false;
            }
          }

          if (canKickstart) {
            const target = launchdTarget();
            if (target === null) {
              deps.logger.warn("webwatch: uid を取得できないため kickstart を実行できません");
              notes.push("kickstart skipped: uid unavailable");
            } else if (!apply) {
              notes.push(`dry-run: ${LAUNCHCTL_COMMAND} kickstart -k "${target}" を実行予定`);
            } else {
              lastKickstartAtMs = currentMs;
              notes.push(`kickstart executed: ${LAUNCHCTL_COMMAND} kickstart -k "${target}"`);
              try {
                const result = await options.execFn(LAUNCHCTL_COMMAND, ["kickstart", "-k", target]);
                warnKickstartFailure(deps, result);
              } catch (error) {
                deps.logger.warn("webwatch: launchctl kickstart に失敗しました", { error: errorDetail(error) });
              }
              actions += 1;
            }
          }
        }
      }

      actions += await runBridgewatch(deps, apply, notes);

      return { name: "webwatch", actions, skipped: false, notes };
    },
  };
}

export const webwatchStage: Stage = createWebwatchStage({
  fetchFn: defaultFetchFn,
  execFn: defaultExecFn,
  nowFn: defaultNowFn,
});
